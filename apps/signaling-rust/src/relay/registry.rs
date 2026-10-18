//! Redis room registry (global uniqueness + cross-node capacity) via Lua.
//!
//! Keys (with `channel_prefix`, default `gomoku:signal`):
//! * `{prefix}:room:{CODE}`         — string, holder node id, `SET NX EX`
//! * `{prefix}:room:{CODE}:members` — set of `{node_id}:{peer_id}`
//! * `{prefix}:room:{CODE}`         — pub/sub channel (same name by design)

use std::sync::Arc;

use crate::relay::{RedisPool, RelayError};
use crate::rooms::RoomCode;

/// `create`: SET NX EX + SADD + EXPIRE. Returns `1` (created) or `0` (exists).
pub const CREATE_LUA: &str = r"
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[3]) then
  redis.call('SADD', KEYS[2], ARGV[2]); redis.call('EXPIRE', KEYS[2], ARGV[3]); return 1
else return 0 end
";

/// `join`: EXISTS + SCARD<2 + SADD. Returns `1`, `-1` (not found), `-2` (full).
pub const JOIN_LUA: &str = r"
if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
if redis.call('SCARD', KEYS[2]) >= 2 then return -2 end
redis.call('SADD', KEYS[2], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[2]); redis.call('EXPIRE', KEYS[2], ARGV[2]); return 1
";

/// `leave`: SREM + delete-if-empty. Returns `0` (room deleted) or `1`.
pub const LEAVE_LUA: &str = r"
redis.call('SREM', KEYS[2], ARGV[1])
if redis.call('SCARD', KEYS[2]) == 0 then redis.call('DEL', KEYS[1], KEYS[2]); return 0 end
return 1
";

/// `refresh`: EXPIRE both keys *only when they still exist*. Returns the
/// number of keys that were refreshed (0..=2).
///
/// Background keep-alive (F4): a room that lives longer than `room_ttl_secs`
/// used to expire mid-game because only `create` / `join` touched the TTL and
/// the per-message hot path deliberately adds no Redis RTT. The periodic
/// refresher (period = `room_ttl / 3`) keeps live rooms alive instead.
pub const REFRESH_LUA: &str = r"
local n = 0
if redis.call('EXPIRE', KEYS[1], ARGV[1]) == 1 then n = n + 1 end
if redis.call('EXPIRE', KEYS[2], ARGV[1]) == 1 then n = n + 1 end
return n
";

/// `{prefix}:room:{CODE}` — room holder key.
pub fn room_key(prefix: &str, code: &RoomCode) -> String {
    format!("{prefix}:room:{code}")
}

/// `{prefix}:room:{CODE}:members` — member set key.
pub fn members_key(prefix: &str, code: &RoomCode) -> String {
    format!("{prefix}:room:{code}:members")
}

/// `{prefix}:room:{CODE}` — pub/sub channel name.
pub fn room_channel(prefix: &str, code: &RoomCode) -> String {
    format!("{prefix}:room:{code}")
}

/// `{prefix}:room:{CODE}:seat:{PEER}` — global seat holder key.
pub fn seat_key(prefix: &str, code: &RoomCode, peer: &crate::rooms::PeerId) -> String {
    format!("{prefix}:room:{code}:seat:{peer}")
}

/// `issue_seat`: HSET + EXPIRE
pub const ISSUE_SEAT_LUA: &str = r"
redis.call('HSET', KEYS[1], 'room', ARGV[1], 'peer_id', ARGV[2], 'token', ARGV[3], 'name', ARGV[4], 'role', ARGV[5], 'node_id', ARGV[6], 'offline_since', 0, 'expires_at', 0)
redis.call('EXPIRE', KEYS[1], ARGV[7])
return 1
";

/// `seat_offline`: HSET offline_since + expires_at + EXPIRE
pub const SEAT_OFFLINE_LUA: &str = r"
if redis.call('EXISTS', KEYS[1]) == 1 then
  local off = tonumber(redis.call('HGET', KEYS[1], 'offline_since') or '0')
  if off == 0 then
    redis.call('HSET', KEYS[1], 'offline_since', ARGV[1], 'expires_at', ARGV[2])
    redis.call('EXPIRE', KEYS[1], ARGV[3])
    return 1
  end
end
return 0
";

/// `resume_seat`: atomic verify, token rotate, node_id update, member set update
pub const RESUME_SEAT_LUA: &str = r"
if redis.call('EXISTS', KEYS[1]) == 0 then return {-1, '', '', ''} end
local room = redis.call('HGET', KEYS[1], 'room')
if room ~= ARGV[1] then return {-2, '', '', ''} end
local cur_token = redis.call('HGET', KEYS[1], 'token')
if cur_token ~= ARGV[2] then return {-2, '', '', ''} end
local expires_at = tonumber(redis.call('HGET', KEYS[1], 'expires_at') or '0')
local now_ms = tonumber(ARGV[5])
if expires_at > 0 and now_ms >= expires_at then return {-3, '', '', ''} end
local old_node = redis.call('HGET', KEYS[1], 'node_id') or ''
local name = redis.call('HGET', KEYS[1], 'name') or ''
local role = redis.call('HGET', KEYS[1], 'role') or 'guest'
local peer_id = redis.call('HGET', KEYS[1], 'peer_id') or ''
redis.call('HSET', KEYS[1], 'token', ARGV[3], 'node_id', ARGV[4], 'offline_since', 0, 'expires_at', 0)
redis.call('EXPIRE', KEYS[1], ARGV[6])
if old_node ~= '' and old_node ~= ARGV[4] and peer_id ~= '' then
  redis.call('SREM', KEYS[2], old_node .. ':' .. peer_id)
  redis.call('SADD', KEYS[2], ARGV[4] .. ':' .. peer_id)
  redis.call('EXPIRE', KEYS[2], ARGV[6])
end
return {1, old_node, name, role}
";

/// Outcome of a registry `join`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JoinStatus {
    /// The member was added.
    Joined,
    /// The room does not exist.
    NotFound,
    /// The room already holds two members.
    Full,
}

/// Outcome of a registry `leave`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeaveStatus {
    /// The member was removed but the room survives.
    Removed,
    /// The room had no members left and was deleted.
    RoomDeleted,
}

/// Redis-backed room registry.
pub struct RedisRoomRegistry {
    pool: Arc<RedisPool>,
    prefix: String,
}

impl RedisRoomRegistry {
    /// Build a registry over the given connection pool.
    pub fn new(pool: Arc<RedisPool>, prefix: impl Into<String>) -> Self {
        Self {
            pool,
            prefix: prefix.into(),
        }
    }

    /// The channel/key prefix.
    pub fn prefix(&self) -> &str {
        &self.prefix
    }

    /// Atomically create a globally-unique room.
    pub async fn create(
        &self,
        code: &RoomCode,
        node_id: &str,
        member: &str,
        ttl_secs: u64,
    ) -> Result<bool, RelayError> {
        let mut conn = self.pool.get()?;
        let result: i64 = redis::Script::new(CREATE_LUA)
            .key(room_key(&self.prefix, code))
            .key(members_key(&self.prefix, code))
            .arg(node_id)
            .arg(member)
            .arg(ttl_secs)
            .invoke_async(&mut conn)
            .await
            .map_err(|e| RelayError::Command(e.to_string()))?;
        Ok(result == 1)
    }

    /// Atomically join a room if it exists and has capacity.
    pub async fn join(
        &self,
        code: &RoomCode,
        member: &str,
        ttl_secs: u64,
    ) -> Result<JoinStatus, RelayError> {
        let mut conn = self.pool.get()?;
        let result: i64 = redis::Script::new(JOIN_LUA)
            .key(room_key(&self.prefix, code))
            .key(members_key(&self.prefix, code))
            .arg(member)
            .arg(ttl_secs)
            .invoke_async(&mut conn)
            .await
            .map_err(|e| RelayError::Command(e.to_string()))?;
        match result {
            1 => Ok(JoinStatus::Joined),
            -1 => Ok(JoinStatus::NotFound),
            -2 => Ok(JoinStatus::Full),
            other => Err(RelayError::Command(format!("join.lua 返回未知值 {other}"))),
        }
    }

    /// Atomically leave a room, deleting it when the last member leaves.
    pub async fn leave(&self, code: &RoomCode, member: &str) -> Result<LeaveStatus, RelayError> {
        let mut conn = self.pool.get()?;
        let result: i64 = redis::Script::new(LEAVE_LUA)
            .key(room_key(&self.prefix, code))
            .key(members_key(&self.prefix, code))
            .arg(member)
            .invoke_async(&mut conn)
            .await
            .map_err(|e| RelayError::Command(e.to_string()))?;
        match result {
            0 => Ok(LeaveStatus::RoomDeleted),
            1 => Ok(LeaveStatus::Removed),
            other => Err(RelayError::Command(format!("leave.lua 返回未知值 {other}"))),
        }
    }

    /// Refresh the TTL of a live room's keys (F4 background keep-alive).
    ///
    /// EXPIREs both the room key and the members key when they still exist;
    /// returns how many keys were refreshed (0..=2). Idempotent and safe to
    /// call on rooms that just expired (0 keys refreshed).
    pub async fn refresh(&self, code: &RoomCode, ttl_secs: u64) -> Result<u8, RelayError> {
        let mut conn = self.pool.get()?;
        let result: i64 = redis::Script::new(REFRESH_LUA)
            .key(room_key(&self.prefix, code))
            .key(members_key(&self.prefix, code))
            .arg(ttl_secs)
            .invoke_async(&mut conn)
            .await
            .map_err(|e| RelayError::Command(e.to_string()))?;
        Ok(result.clamp(0, 2) as u8)
    }

    /// Globally issue/update a seat in Redis.
    #[allow(clippy::too_many_arguments)]
    pub async fn issue_seat(
        &self,
        code: &RoomCode,
        peer: &crate::rooms::PeerId,
        token: &str,
        name: &str,
        role: &str,
        node_id: &str,
        ttl_secs: u64,
    ) -> Result<(), RelayError> {
        let mut conn = self.pool.get()?;
        let _: i64 = redis::Script::new(ISSUE_SEAT_LUA)
            .key(seat_key(&self.prefix, code, peer))
            .arg(code.as_str())
            .arg(peer.as_str())
            .arg(token)
            .arg(name)
            .arg(role)
            .arg(node_id)
            .arg(ttl_secs)
            .invoke_async(&mut conn)
            .await
            .map_err(|e| RelayError::Command(e.to_string()))?;
        Ok(())
    }

    /// Mark a seat as offline in Redis.
    pub async fn seat_offline(
        &self,
        code: &RoomCode,
        peer: &crate::rooms::PeerId,
        now_ms: u64,
        expires_at_ms: u64,
        ttl_secs: u64,
    ) -> Result<(), RelayError> {
        let mut conn = self.pool.get()?;
        let _: i64 = redis::Script::new(SEAT_OFFLINE_LUA)
            .key(seat_key(&self.prefix, code, peer))
            .arg(now_ms)
            .arg(expires_at_ms)
            .arg(ttl_secs)
            .invoke_async(&mut conn)
            .await
            .map_err(|e| RelayError::Command(e.to_string()))?;
        Ok(())
    }

    /// Delete a seat from Redis.
    pub async fn leave_seat(
        &self,
        code: &RoomCode,
        peer: &crate::rooms::PeerId,
    ) -> Result<(), RelayError> {
        let mut conn = self.pool.get()?;
        let _: i64 = redis::cmd("DEL")
            .arg(seat_key(&self.prefix, code, peer))
            .query_async(&mut conn)
            .await
            .map_err(|e| RelayError::Command(e.to_string()))?;
        Ok(())
    }

    /// Atomically resume a seat in Redis across nodes (Issue 3).
    #[allow(clippy::too_many_arguments)]
    pub async fn resume_seat(
        &self,
        code: &RoomCode,
        peer: &crate::rooms::PeerId,
        token: &str,
        new_token: &str,
        node_id: &str,
        now_ms: u64,
        ttl_secs: u64,
    ) -> Result<crate::relay::ResumeGrant, crate::transport::seat::ResumeError> {
        let mut conn = match self.pool.get() {
            Ok(c) => c,
            Err(_) => return Err(crate::transport::seat::ResumeError::Unknown),
        };
        let result: Result<(i64, String, String, String), redis::RedisError> =
            redis::Script::new(RESUME_SEAT_LUA)
                .key(seat_key(&self.prefix, code, peer))
                .key(members_key(&self.prefix, code))
                .arg(code.as_str())
                .arg(token)
                .arg(new_token)
                .arg(node_id)
                .arg(now_ms)
                .arg(ttl_secs)
                .invoke_async(&mut conn)
                .await;
        match result {
            Ok((1, old_node, name, role)) => Ok(crate::relay::ResumeGrant {
                old_node,
                name,
                role,
            }),
            Ok((-2, _, _, _)) => Err(crate::transport::seat::ResumeError::Invalid),
            Ok((-3, _, _, _)) => Err(crate::transport::seat::ResumeError::Expired),
            _ => Err(crate::transport::seat::ResumeError::Unknown),
        }
    }

    /// Query global member set for a room (Issue 2).
    pub async fn room_members(&self, code: &RoomCode) -> Result<Vec<String>, RelayError> {
        let mut conn = self.pool.get()?;
        let members: Vec<String> = redis::cmd("SMEMBERS")
            .arg(members_key(&self.prefix, code))
            .query_async(&mut conn)
            .await
            .map_err(|e| RelayError::Command(e.to_string()))?;
        Ok(members)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code(s: &str) -> RoomCode {
        RoomCode::new(s).expect("code")
    }

    #[test]
    fn key_layout_matches_design() {
        let c = code("ABCD");
        assert_eq!(room_key("gomoku:signal", &c), "gomoku:signal:room:ABCD");
        assert_eq!(
            members_key("gomoku:signal", &c),
            "gomoku:signal:room:ABCD:members"
        );
        assert_eq!(room_channel("gomoku:signal", &c), "gomoku:signal:room:ABCD");
    }

    #[test]
    fn create_script_uses_set_nx_and_ttl() {
        assert!(CREATE_LUA.contains("'NX'"));
        assert!(CREATE_LUA.contains("'EX'"));
        assert!(CREATE_LUA.contains("SADD"));
        assert!(CREATE_LUA.contains("EXPIRE"));
    }

    #[test]
    fn join_script_guards_capacity() {
        assert!(JOIN_LUA.contains("EXISTS"));
        assert!(JOIN_LUA.contains("SCARD"));
        assert!(JOIN_LUA.contains(">= 2"));
    }

    #[test]
    fn leave_script_deletes_empty_room() {
        assert!(LEAVE_LUA.contains("SREM"));
        assert!(LEAVE_LUA.contains("DEL"));
    }

    /// F4: the refresh script must EXPIRE *both* the room key and the members
    /// key (a live room's TTL must never lapse while the game is running).
    #[test]
    fn refresh_script_expires_both_keys() {
        assert!(REFRESH_LUA.contains("EXPIRE"), "REFRESH_LUA 必须刷新 TTL");
        assert_eq!(
            REFRESH_LUA.matches("EXPIRE").count(),
            2,
            "room key 与 members key 都要 EXPIRE，实际: {REFRESH_LUA}"
        );
    }
}
