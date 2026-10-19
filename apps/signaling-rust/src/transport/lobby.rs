//! Node-local discovery and pairing. Admission always uses the existing router,
//! RoomTable, Redis registry and SeatRegistry; game data never enters this module.
use super::{ConnCtx, ConnDeps, Router};
use crate::protocol::ServerMsg;
use crate::rooms::{PeerId, RoomCode};
use serde_json::{json, Value};
mod codec;
use codec::{notice, Command};
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

#[derive(Clone)]
struct Person {
    ctx: ConnCtx,
    id: String,
    name: String,
    browser: String,
    tab: String,
    ready: bool,
    query: String,
    available: bool,
    offset: usize,
    last_invite: Option<u64>,
    last_room: Option<u64>,
    window: u64,
    requests: u32,
}
#[derive(Clone)]
struct Invite {
    id: String,
    from: PeerId,
    to: PeerId,
    expires: u64,
}
struct RoomInfo {
    host: PeerId,
    name: String,
    public: bool,
    created: u64,
}
struct ListedUser {
    value: Value,
    folded_name: String,
    is_available: bool,
}
struct PublicProjection {
    users: Vec<ListedUser>,
    rooms: Vec<Value>,
    waiting: usize,
    total_rooms: usize,
    now: u64,
}
/// Serialized node-local lobby coordinator; time and identifiers are injectable.
pub struct Lobby {
    people: HashMap<PeerId, Person>,
    invites: HashMap<String, Invite>,
    queue: BTreeMap<(u64, u64), PeerId>,
    rooms: HashMap<RoomCode, RoomInfo>,
    cooldown: HashMap<(PeerId, PeerId), u64>,
    projection: Option<PublicProjection>,
    dirty: bool,
    revision: u64,
    sequence: u64,
    clock: Arc<dyn Fn() -> u64 + Send + Sync>,
    id: Arc<dyn Fn() -> String + Send + Sync>,
}
impl Default for Lobby {
    fn default() -> Self {
        Self::with_sources(
            Arc::new(super::heartbeat::now_ms),
            Arc::new(super::seat::new_token),
        )
    }
}
impl Lobby {
    /// Deterministic sources keep expiry and retry tests independent of wall time.
    pub fn with_sources(
        clock: Arc<dyn Fn() -> u64 + Send + Sync>,
        id: Arc<dyn Fn() -> String + Send + Sync>,
    ) -> Self {
        Self {
            people: HashMap::new(),
            invites: HashMap::new(),
            queue: BTreeMap::new(),
            rooms: HashMap::new(),
            cooldown: HashMap::new(),
            projection: None,
            dirty: false,
            revision: 0,
            sequence: 0,
            clock,
            id,
        }
    }
    fn now(&self) -> u64 {
        (self.clock)()
    }
    pub(super) fn invalidate(&mut self) {
        self.projection = None;
        self.dirty = true;
    }
    fn allow_request(&mut self, ctx: &ConnCtx) -> bool {
        let now = self.now();
        let Some(p) = self.people.get_mut(&ctx.peer_id()) else {
            return true;
        };
        if now.saturating_sub(p.window) >= 1000 {
            p.window = now;
            p.requests = 0;
        }
        p.requests = p.requests.saturating_add(1);
        if p.requests > 30 {
            notice(ctx, "RATE_LIMITED", "操作太快了，休息一下");
            return false;
        }
        true
    }
    fn unique_name(&self, wanted: &str, own: &PeerId) -> String {
        let taken = |name: &str| {
            self.people
                .iter()
                .any(|(id, p)| id != own && p.name == name)
        };
        if !taken(wanted) {
            return wanted.into();
        }
        for n in 2..=2002 {
            let suffix = n.to_string();
            let name = format!(
                "{}{}",
                wanted.chars().take(12 - suffix.len()).collect::<String>(),
                suffix
            );
            if !taken(&name) {
                return name;
            }
        }
        "棋友2003".into()
    }
    fn enter(&mut self, ctx: &ConnCtx, identity: (String, String, String)) {
        let (name, browser, tab) = identity;
        let peer = ctx.peer_id();
        if self.people.contains_key(&peer) {
            return;
        }
        // A refreshed tab may arrive before its old socket's close callback.
        let previous = self
            .people
            .iter()
            .find(|(_, p)| p.browser == browser && p.tab == tab)
            .map(|(id, _)| id.clone());
        if let Some(id) = previous {
            self.interrupt(&id);
            self.people.remove(&id);
        }
        if self
            .people
            .values()
            .filter(|p| p.browser == browser)
            .count()
            >= 2
        {
            notice(ctx, "SESSION_LIMIT", "同一浏览器最多 2 桌");
            return;
        }
        if self.people.len() >= 2000 {
            notice(ctx, "LIMIT", "大厅已满，稍后再试");
            return;
        }
        let name = self.unique_name(&name, &peer);
        self.people.insert(
            peer,
            Person {
                ctx: ctx.clone(),
                id: (self.id)(),
                name,
                browser,
                tab,
                ready: false,
                query: String::new(),
                available: false,
                offset: 0,
                last_invite: None,
                last_room: None,
                window: self.now(),
                requests: 0,
            },
        );
    }
    fn pending(&self, id: &PeerId) -> Option<Invite> {
        self.invites
            .values()
            .find(|i| &i.from == id || &i.to == id)
            .cloned()
    }
    fn matching(&self, id: &PeerId) -> bool {
        self.queue.values().any(|p| p == id)
    }
    fn status(&self, id: &PeerId, deps: &ConnDeps) -> &'static str {
        if let Some(seat) = deps.seats.peek(id) {
            if deps.rooms.len_of(&seat.room) < 2 {
                return "waiting";
            }
            let targets = deps.rooms.signal_targets(&seat.room, id);
            if self.people.get(id).map(|p| p.ready).unwrap_or(false)
                && targets.iter().all(|t| {
                    self.people
                        .get(&t.peer_id)
                        .map(|p| p.ready)
                        .unwrap_or(false)
                })
            {
                return "playing";
            }
            return "connecting";
        }
        if self.people.get(id).map(|p| p.ready).unwrap_or(false) {
            return "playing";
        }
        if self.matching(id) {
            return "matching";
        }
        if self.pending(id).is_some() {
            return "inviting";
        }
        "idle"
    }
    fn pair_key(a: &PeerId, b: &PeerId) -> (PeerId, PeerId) {
        if a.as_str() < b.as_str() {
            (a.clone(), b.clone())
        } else {
            (b.clone(), a.clone())
        }
    }
    fn end_invite(&mut self, i: &Invite, code: &str, message: &str) {
        self.invalidate();
        self.invites.remove(&i.id);
        if code == "DECLINED" || code == "EXPIRED" {
            self.cooldown
                .insert(Self::pair_key(&i.from, &i.to), self.now() + 60000);
        }
        for id in [&i.from, &i.to] {
            if let Some(p) = self.people.get(id) {
                notice(&p.ctx, code, message)
            }
        }
    }
    fn interrupt(&mut self, id: &PeerId) {
        self.queue.retain(|_, p| p != id);
        if let Some(i) = self.pending(id) {
            self.end_invite(&i, "CANCELLED", "邀请已结束")
        }
    }
    fn invite(&mut self, from: &PeerId, target: &str, deps: &ConnDeps) {
        let Some(to) = self
            .people
            .iter()
            .find(|(_, p)| p.id == target)
            .map(|(id, _)| id.clone())
        else {
            if let Some(p) = self.people.get(from) {
                notice(&p.ctx, "TARGET_OFFLINE", "对方已离线或无法邀请")
            };
            return;
        };
        let Some(p) = self.people.get(from) else {
            return;
        };
        if from == &to {
            notice(&p.ctx, "TARGET_OFFLINE", "无法邀请自己");
            return;
        }
        if self
            .pending(from)
            .map(|i| i.from == to || i.to == to)
            .unwrap_or(false)
        {
            return;
        }
        if self.status(from, deps) != "idle" || self.status(&to, deps) != "idle" {
            notice(&p.ctx, "BUSY", "对方当前忙碌，暂时无法接受邀请");
            return;
        }
        let now = self.now();
        if !self.can_invite(p, &to) {
            return;
        }
        if let Some(p) = self.people.get_mut(from) {
            p.last_invite = Some(now)
        }
        let id = (self.id)();
        self.invites.insert(
            id.clone(),
            Invite {
                id,
                from: from.clone(),
                to,
                expires: now + 30000,
            },
        );
    }
    fn can_invite(&self, p: &Person, to: &PeerId) -> bool {
        let now = self.now();
        let recent = p
            .last_invite
            .map(|t| now.saturating_sub(t) < 3000)
            .unwrap_or(false);
        let cooling = self
            .cooldown
            .get(&Self::pair_key(&p.ctx.peer_id(), to))
            .map(|t| *t > now)
            .unwrap_or(false);
        if recent || cooling {
            notice(&p.ctx, "RATE_LIMITED", "操作太快了，休息一下");
            return false;
        }
        true
    }
    async fn respond(&mut self, p: &Person, response: (&str, bool), deps: &ConnDeps) {
        let (id, accept) = response;
        let Some(i) = self.invites.get(id).cloned() else {
            return;
        };
        if i.to != p.ctx.peer_id() {
            return;
        }
        if !accept {
            self.end_invite(&i, "DECLINED", "对方暂时不方便");
            return;
        }
        let Some(from) = self.people.get(&i.from).cloned() else {
            self.end_invite(&i, "BUSY", "对方已离线");
            return;
        };
        if deps.seats.contains(&i.from) || deps.seats.contains(&i.to) || from.ready || p.ready {
            self.end_invite(&i, "BUSY", "对方当前忙碌，暂时无法接受邀请");
            return;
        }
        self.invites.remove(id);
        self.pair(&from, p, deps).await;
    }
    async fn pair(&mut self, host: &Person, guest: &Person, deps: &ConnDeps) {
        if deps.rooms.len() >= 1000 {
            for p in [host, guest] {
                notice(&p.ctx, "LIMIT", "大厅已满，稍后再试");
            }
            return;
        }
        let router = Router::new(deps.clone());
        let Some(room) = router.lobby_create(&host.ctx, &host.name).await else {
            for p in [host, guest] {
                notice(&p.ctx, "LIMIT", "大厅已满，稍后再试")
            }
            return;
        };
        if !router.lobby_join(&guest.ctx, &room, &guest.name).await {
            router.lobby_leave(&host.ctx).await;
            notice(&host.ctx, "BUSY", "组房失败，请重试");
            return;
        }
        self.emit_seat(host, deps);
        self.emit_seat(guest, deps);
        self.notify_join(guest, &room, deps);
        self.rooms.insert(
            room,
            RoomInfo {
                host: host.ctx.peer_id(),
                name: host.name.clone(),
                public: false,
                created: self.now(),
            },
        );
        for p in [host, guest] {
            let id = p.ctx.peer_id();
            self.queue.retain(|_, peer| peer != &id);
            if let Some(p) = self.people.get_mut(&id) {
                p.ready = false
            }
        }
    }
    fn emit_seat(&self, p: &Person, deps: &ConnDeps) {
        if let Some(seat) = deps.seats.peek(&p.ctx.peer_id()) {
            p.ctx.send(ServerMsg::LobbySeat {
                room: seat.room.as_str().into(),
                role: if seat.role == super::SeatRole::Host {
                    "host"
                } else {
                    "guest"
                }
                .into(),
                peer_id: seat.peer_id.as_str().into(),
                token: seat.token,
            });
        }
    }
    fn notify_join(&self, p: &Person, room: &RoomCode, deps: &ConnDeps) {
        for target in deps.rooms.signal_targets(room, &p.ctx.peer_id()) {
            target.send(crate::protocol::messages::peer_joined(
                p.ctx.peer_id().as_str(),
                &p.name,
            ));
        }
    }
    fn can_enter(&mut self, p: &Person, deps: &ConnDeps) -> bool {
        let id = p.ctx.peer_id();
        if deps.seats.contains(&id)
            || p.ready
            || self.matching(&id)
            || self.pending(&id).map(|i| i.from == id).unwrap_or(false)
        {
            notice(&p.ctx, "BUSY", "请先退出当前房间、匹配或邀请");
            return false;
        }
        let now = self.now();
        if p.last_room
            .map(|t| now.saturating_sub(t) < 3000)
            .unwrap_or(false)
        {
            notice(&p.ctx, "RATE_LIMITED", "操作太快了，休息一下");
            return false;
        }
        if let Some(current) = self.people.get_mut(&id) {
            current.last_room = Some(now)
        }
        true
    }
    async fn create(&mut self, p: &Person, public: bool, deps: &ConnDeps) {
        if !self.can_enter(p, deps) {
            return;
        }
        if deps.rooms.len() >= 1000 {
            notice(&p.ctx, "LIMIT", "大厅已满，稍后再试");
            return;
        }
        let Some(room) = Router::new(deps.clone())
            .lobby_create(&p.ctx, &p.name)
            .await
        else {
            notice(&p.ctx, "LIMIT", "大厅已满，稍后再试");
            return;
        };
        self.interrupt(&p.ctx.peer_id());
        self.emit_seat(p, deps);
        self.rooms.insert(
            room,
            RoomInfo {
                host: p.ctx.peer_id(),
                name: p.name.clone(),
                public,
                created: self.now(),
            },
        );
    }
    async fn join(&mut self, p: &Person, room: &str, deps: &ConnDeps) {
        if !self.can_enter(p, deps) {
            return;
        }
        let Ok(code) = RoomCode::new(room) else {
            return;
        };
        let Some(info) = self.rooms.get(&code) else {
            notice(&p.ctx, "ROOM_NOT_FOUND", "房间不存在或房主已离线");
            return;
        };
        if !info.public || !self.people.contains_key(&info.host) {
            notice(&p.ctx, "ROOM_NOT_FOUND", "房间不存在或房主已离线");
            return;
        }
        if deps.rooms.len_of(&code) >= 2 {
            notice(&p.ctx, "ROOM_FULL", "房间已满");
            return;
        }
        if Router::new(deps.clone())
            .lobby_join(&p.ctx, &code, &p.name)
            .await
        {
            self.interrupt(&p.ctx.peer_id());
            self.emit_seat(p, deps);
            self.notify_join(p, &code, deps)
        }
    }
    async fn match_player(&mut self, p: &Person, action: &str, deps: &ConnDeps) {
        let id = p.ctx.peer_id();
        if action == "leave" {
            self.queue.retain(|_, peer| peer != &id);
            return;
        }
        if self.matching(&id) {
            return;
        }
        if deps.seats.contains(&id)
            || p.ready
            || self.pending(&id).map(|i| i.from == id).unwrap_or(false)
        {
            notice(&p.ctx, "BUSY", "请先退出当前房间或邀请");
            return;
        }
        self.interrupt(&id);
        let next = self.queue.iter().next().map(|(k, v)| (*k, v.clone()));
        if let Some((key, peer)) = next {
            self.queue.remove(&key);
            if let Some(other) = self.people.get(&peer).cloned() {
                self.pair(&other, p, deps).await;
                return;
            }
        }
        self.sequence += 1;
        self.queue.insert((self.now(), self.sequence), id);
    }
    fn rename(&mut self, id: &PeerId, name: &str, deps: &ConnDeps) {
        let name = self.unique_name(name, id);
        if let Some(p) = self.people.get_mut(id) {
            p.name = name.clone();
        }
        if let Some(seat) = deps.seats.peek(id) {
            if let Some(info) = self.rooms.get_mut(&seat.room).filter(|r| &r.host == id) {
                info.name = name;
            }
        }
    }
    fn visibility(&mut self, id: &PeerId, public: bool, deps: &ConnDeps) {
        if let Some(seat) = deps.seats.peek(id) {
            if let Some(info) = self.rooms.get_mut(&seat.room).filter(|r| &r.host == id) {
                info.public = public;
            }
        }
    }
    fn cancel(&mut self, p: &Person, id: &str) {
        if let Some(i) = self
            .invites
            .get(id)
            .filter(|i| i.from == p.ctx.peer_id())
            .cloned()
        {
            self.end_invite(&i, "CANCELLED", "邀请已取消");
        }
    }
    fn ready(&mut self, id: &PeerId, ready: bool, deps: &ConnDeps) {
        if let Some(p) = self.people.get_mut(id) {
            p.ready = ready;
        }
        if ready && !deps.seats.contains(id) {
            self.interrupt(id);
        }
    }
    async fn act(&mut self, p: &Person, msg: Command, deps: &ConnDeps) {
        let id = p.ctx.peer_id();
        match msg {
            Command::List {
                query,
                only_available,
                offset,
            } => {
                if let Some(p) = self.people.get_mut(&id) {
                    p.query = query;
                    p.available = only_available;
                    p.offset = offset;
                }
            }
            Command::Name { name } => self.rename(&id, &name, deps),
            Command::Invite { target } => self.invite(&id, &target, deps),
            Command::Respond { id, accept } => self.respond(p, (&id, accept), deps).await,
            Command::Cancel { id } => self.cancel(p, &id),
            Command::Match { action } => self.match_player(p, &action, deps).await,
            Command::Create { public } => self.create(p, public, deps).await,
            Command::Join { room } => self.join(p, &room, deps).await,
            Command::Visibility { public } => self.visibility(&id, public, deps),
            Command::Ready { ready } => self.ready(&id, ready, deps),
            Command::Enter { .. } => {}
        }
    }
    /// Update discovery metadata after legacy room operations.
    pub(super) fn sync(&mut self, ctx: &ConnCtx, deps: &ConnDeps) {
        self.invalidate();
        let id = ctx.peer_id();
        let Some(seat) = deps.seats.peek(&id) else {
            return;
        };
        self.interrupt(&id);
        if seat.role == super::SeatRole::Host && !self.rooms.contains_key(&seat.room) {
            let name = self
                .people
                .get(&id)
                .map(|p| p.name.clone())
                .unwrap_or_else(|| "棋友".into());
            self.rooms.insert(
                seat.room,
                RoomInfo {
                    host: id,
                    name,
                    public: false,
                    created: self.now(),
                },
            );
        }
    }
    /// Transfer the new tab's presence to the authenticated restored identity.
    pub(super) fn rebind(&mut self, previous: &PeerId, ctx: &ConnCtx) {
        let restored = ctx.peer_id();
        if previous == &restored {
            return;
        }
        if let Some(mut p) = self.people.remove(previous) {
            self.invalidate();
            self.interrupt(&restored);
            self.people.remove(&restored);
            p.ctx = ctx.clone();
            self.people.insert(restored, p);
        }
    }
    /// Remove only the physical socket that still owns this presence.
    pub(super) fn disconnect(&mut self, ctx: &ConnCtx) {
        let id = ctx.peer_id();
        if self
            .people
            .get(&id)
            .map(|p| p.ctx.conn_id == ctx.conn_id)
            .unwrap_or(false)
        {
            self.invalidate();
            self.interrupt(&id);
            self.people.remove(&id);
        }
    }
    fn expire(&mut self, deps: &ConnDeps) {
        let now = self.now();
        let queue_len = self.queue.len();
        let room_len = self.rooms.len();
        let expired: Vec<_> = self
            .invites
            .values()
            .filter(|i| now >= i.expires)
            .cloned()
            .collect();
        for i in expired {
            self.end_invite(&i, "EXPIRED", "邀请已过期")
        }
        let expired: Vec<_> = self
            .queue
            .iter()
            .filter(|((since, _), _)| now.saturating_sub(*since) >= 60000)
            .map(|(k, id)| (*k, id.clone()))
            .collect();
        for (key, id) in expired {
            self.queue.remove(&key);
            if let Some(p) = self.people.get(&id) {
                notice(&p.ctx, "MATCH_TIMEOUT", "暂时没找到对手，试试自己开一桌？")
            }
        }
        self.cooldown.retain(|_, until| *until > now);
        self.rooms.retain(|code, _| deps.rooms.contains(code));
        if self.queue.len() != queue_len || self.rooms.len() != room_len {
            self.invalidate();
        }
    }
    fn project_users(&self, deps: &ConnDeps) -> Vec<ListedUser> {
        let mut users: Vec<_> = self
            .people
            .iter()
            .map(|(id, p)| {
                let status = self.status(id, deps);
                ListedUser {
                    value: json!({"id":p.id,"name":p.name,"status":status}),
                    folded_name: p.name.to_lowercase(),
                    is_available: status == "idle",
                }
            })
            .collect();
        users.sort_by(|a, b| {
            b.is_available
                .cmp(&a.is_available)
                .then_with(|| a.value["id"].as_str().cmp(&b.value["id"].as_str()))
        });
        users
    }
    fn listed_users(p: &Person, projection: &PublicProjection) -> (usize, Vec<Value>) {
        if p.query.is_empty() && !p.available {
            let page = projection
                .users
                .iter()
                .skip(p.offset)
                .take(20)
                .map(|user| user.value.clone())
                .collect();
            return (projection.users.len(), page);
        }
        let query = p.query.to_lowercase();
        let matches: Vec<_> = projection
            .users
            .iter()
            .filter(|user| user.folded_name.contains(&query) && (!p.available || user.is_available))
            .collect();
        let total = matches.len();
        let page = matches
            .into_iter()
            .skip(p.offset)
            .take(20)
            .map(|user| user.value.clone())
            .collect();
        (total, page)
    }
    fn public_rooms(&self, deps: &ConnDeps) -> Vec<Value> {
        let mut rooms:Vec<_>=self.rooms.iter().filter(|(_,r)|r.public&&deps.seats.contains(&r.host)).map(|(code,info)|{
            let status=if self.people.contains_key(&info.host){self.status(&info.host,deps)}else{"offline"};
            json!({"code":code.as_str(),"name":info.name,"count":deps.rooms.len_of(code),"status":status,"createdAt":info.created})
        }).collect();
        rooms.sort_by(|a, b| {
            (b["status"] == "waiting")
                .cmp(&(a["status"] == "waiting"))
                .then_with(|| a["createdAt"].as_u64().cmp(&b["createdAt"].as_u64()))
                .then_with(|| a["code"].as_str().cmp(&b["code"].as_str()))
        });
        rooms
    }
    fn own_room(&self, id: &PeerId, deps: &ConnDeps) -> Option<Value> {
        let seat = deps.seats.peek(id)?;
        Some(json!({
            "code":seat.room.as_str(),
            "public":self.rooms.get(&seat.room).map(|r|r.public).unwrap_or(false),
            "role":if seat.role==super::SeatRole::Host{"host"}else{"guest"},
        }))
    }
    fn own_invite(&self, id: &PeerId) -> Option<Value> {
        let i = self.pending(id)?;
        let from = self.people.get(&i.from)?;
        let to = self.people.get(&i.to)?;
        Some(
            json!({"id":i.id,"from":{"id":from.id,"name":from.name},"to":{"id":to.id,"name":to.name},"expiresAt":i.expires}),
        )
    }
    fn build_projection(&self, deps: &ConnDeps) -> PublicProjection {
        let users = self.project_users(deps);
        let mut rooms = self.public_rooms(deps);
        let waiting = rooms
            .iter()
            .filter(|room| room["status"] == "waiting")
            .count();
        let total_rooms = rooms.len();
        rooms.truncate(100);
        PublicProjection {
            users,
            rooms,
            waiting,
            total_rooms,
            now: self.now(),
        }
    }
    fn ensure_projection(&mut self, deps: &ConnDeps) {
        if self.projection.is_none() {
            self.projection = Some(self.build_projection(deps));
        }
    }
    fn snapshot(&self, id: &PeerId, deps: &ConnDeps) -> Option<ServerMsg> {
        let p = self.people.get(id)?;
        let projection = self.projection.as_ref()?;
        let (total_users, users) = Self::listed_users(p, projection);
        let matching = self
            .queue
            .iter()
            .find(|(_, peer)| *peer == id)
            .map(|((since, _), _)| json!({"since":since,"expiresAt":since+60000}));
        let state = json!({
            "selfId":p.id,"name":p.name,"online":self.people.len(),"waiting":projection.waiting,
            "totalUsers":total_users,"users":users,"rooms":projection.rooms,
            "totalRooms":projection.total_rooms,"room":self.own_room(id,deps),
            "invite":self.own_invite(id),"match":matching,
            "serverNow":projection.now,"revision":self.revision,
        });
        state
            .as_object()
            .cloned()
            .map(|state| ServerMsg::LobbyState { state })
    }
    /// Publish accumulated changes once per cycle; idle cycles only expire timers.
    pub fn flush(&mut self, deps: &ConnDeps) {
        self.expire(deps);
        if !self.dirty {
            return;
        }
        self.dirty = false;
        self.projection = Some(self.build_projection(deps));
        self.revision = self.revision.saturating_add(1);
        for (id, p) in &self.people {
            if let Some(msg) = self.snapshot(id, deps) {
                p.ctx.send(msg);
            }
        }
    }
}
/// Classify and validate the additive lobby protocol before any state change.
pub async fn handle(deps: &ConnDeps, ctx: &ConnCtx, raw: &str) {
    let msg = match serde_json::from_str::<Command>(raw) {
        Ok(msg) if msg.valid() => msg,
        _ => {
            notice(ctx, "INVALID_INPUT", "昵称需 2–12 个字符，参数格式无效");
            return;
        }
    };
    let mut lobby = deps.lobby.lock().await;
    lobby.expire(deps);
    if !lobby.allow_request(ctx) {
        return;
    }
    if !matches!(msg, Command::List { .. }) {
        lobby.invalidate();
    }
    if let Command::Enter {
        name,
        browser_id,
        tab_id,
    } = msg
    {
        lobby.enter(ctx, (name, browser_id, tab_id))
    } else {
        let Some(p) = lobby
            .people
            .get(&ctx.peer_id())
            .filter(|p| p.ctx.conn_id == ctx.conn_id)
            .cloned()
        else {
            notice(ctx, "NOT_ENTERED", "请先进入大厅");
            return;
        };
        lobby.act(&p, msg, deps).await;
    }
    lobby.ensure_projection(deps);
    lobby.revision = lobby.revision.saturating_add(1);
    if let Some(msg) = lobby.snapshot(&ctx.peer_id(), deps) {
        ctx.send(msg);
    }
}
/// Coalesce discovery changes and expire invitations and queue tickets each second.
pub fn spawn_sweeper(
    deps: ConnDeps,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));
        loop {
            tokio::select! {
                _=shutdown.changed()=>{if *shutdown.borrow(){break}},
                _=interval.tick()=>{deps.lobby.lock().await.flush(&deps)}
            }
        }
    })
}
