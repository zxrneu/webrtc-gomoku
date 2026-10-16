//! Redis pub/sub subscriber task: dynamic SUBSCRIBE/UNSUBSCRIBE + exponential
//! backoff reconnect (1s → 30s). While disconnected the node keeps working for
//! local rooms; only cross-node delivery pauses (graceful degradation).

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use tokio::sync::mpsc;
use tokio::sync::watch;

use crate::metrics::{names, Metrics};
use crate::protocol::messages;
use crate::relay::message::{CrossKind, CrossNodeMsg};
use crate::relay::registry::room_channel;
use crate::relay::RelayError;
use crate::rooms::{LocalDelivery, PeerId, RoomCode};

/// Initial reconnect delay.
pub const BACKOFF_START: Duration = Duration::from_secs(1);
/// Maximum reconnect delay.
pub const BACKOFF_MAX: Duration = Duration::from_secs(30);

/// Commands sent to the subscriber task to change its subscription set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubCommand {
    /// Subscribe to the room channel.
    Subscribe(RoomCode),
    /// Unsubscribe from the room channel.
    Unsubscribe(RoomCode),
}

/// Everything the subscriber task needs.
pub struct SubscriberDeps {
    /// Redis URL.
    pub url: String,
    /// Connect timeout (ms).
    pub connect_timeout_ms: u64,
    /// Channel/key prefix.
    pub prefix: String,
    /// This node's id (used to ignore our own publishes).
    pub node_id: Arc<str>,
    /// Local delivery callback (dependency inversion).
    pub delivery: Arc<dyn LocalDelivery>,
    /// Metrics registry.
    pub metrics: Arc<Metrics>,
}

/// Run the subscriber loop until shutdown is triggered.
pub async fn run(
    deps: SubscriberDeps,
    mut control: mpsc::Receiver<SubCommand>,
    mut shutdown: watch::Receiver<bool>,
) {
    let mut subscribed: HashSet<RoomCode> = HashSet::new();
    let mut backoff = BACKOFF_START;

    loop {
        if *shutdown.borrow() {
            break;
        }

        let mut pubsub = match connect(&deps.url, deps.connect_timeout_ms).await {
            Ok(pubsub) => {
                deps.metrics.set_redis_connected(true);
                backoff = BACKOFF_START;
                Some(pubsub)
            }
            Err(err) => {
                tracing::warn!(error = %err, node_id = %deps.node_id, "Redis 订阅连接失败，退避重连");
                deps.metrics.set_redis_connected(false);
                None
            }
        };

        if let Some(pubsub) = pubsub.as_mut() {
            // Re-subscribe everything we still care about after a (re)connect.
            for code in &subscribed {
                let _ = pubsub.subscribe(room_channel(&deps.prefix, code)).await;
            }

            loop {
                let mut pending: Option<SubCommand> = None;
                tokio::select! {
                    biased;
                    _ = shutdown.changed() => {
                        if *shutdown.borrow() {
                            deps.metrics.set_redis_connected(false);
                            return;
                        }
                    }
                    cmd = control.recv() => {
                        pending = cmd;
                    }
                    incoming = async {
                        let mut stream = pubsub.on_message();
                        stream.next().await
                    } => {
                        match incoming {
                            Some(msg) => {
                                let payload: String = msg.get_payload().unwrap_or_default();
                                dispatch(&payload, &*deps.delivery, &deps.node_id, &deps.metrics);
                            }
                            None => break,
                        }
                    }
                }

                if let Some(cmd) = pending {
                    if !apply_command(cmd, pubsub, &mut subscribed, &deps.prefix).await {
                        break;
                    }
                }
            }
            deps.metrics.set_redis_connected(false);
        }

        if *shutdown.borrow() {
            break;
        }
        tokio::select! {
            _ = shutdown.changed() => {
                if *shutdown.borrow() {
                    break;
                }
            }
            _ = tokio::time::sleep(backoff) => {}
        }
        backoff = (backoff * 2).min(BACKOFF_MAX);
    }
}

/// Open a dedicated pub/sub connection (plain `redis://` TCP).
async fn connect(url: &str, timeout_ms: u64) -> Result<redis::aio::PubSub, RelayError> {
    let client =
        redis::Client::open(url).map_err(|err| RelayError::Unavailable(err.to_string()))?;
    let info = client.get_connection_info().clone();
    let attempt = async move {
        let stream = open_stream(&info.addr).await?;
        redis::aio::PubSub::new(&info.redis, stream)
            .await
            .map_err(|err| RelayError::Unavailable(err.to_string()))
    };
    tokio::time::timeout(Duration::from_millis(timeout_ms), attempt)
        .await
        .map_err(|_| RelayError::Unavailable("订阅连接超时".into()))?
}

async fn open_stream(addr: &redis::ConnectionAddr) -> Result<tokio::net::TcpStream, RelayError> {
    match addr {
        redis::ConnectionAddr::Tcp(host, port) => {
            tokio::net::TcpStream::connect((host.as_str(), *port))
                .await
                .map_err(|err| RelayError::Unavailable(err.to_string()))
        }
        other => Err(RelayError::Unavailable(format!(
            "订阅仅支持 redis:// TCP 地址，收到 {other:?}（rediss:// / unix:// 暂不支持）"
        ))),
    }
}

async fn apply_command(
    cmd: SubCommand,
    pubsub: &mut redis::aio::PubSub,
    subscribed: &mut HashSet<RoomCode>,
    prefix: &str,
) -> bool {
    match cmd {
        SubCommand::Subscribe(code) => {
            if subscribed.insert(code.clone()) {
                let channel = room_channel(prefix, &code);
                return pubsub.subscribe(channel).await.is_ok();
            }
            true
        }
        SubCommand::Unsubscribe(code) => {
            if subscribed.remove(&code) {
                let channel = room_channel(prefix, &code);
                return pubsub.unsubscribe(channel).await.is_ok();
            }
            true
        }
    }
}

/// Decode a cross-node payload and deliver it to local members.
///
/// Messages published by this node are ignored (the publisher already delivered
/// them locally), which prevents double delivery when both peers are local.
fn dispatch(payload: &str, delivery: &dyn LocalDelivery, node_id: &str, metrics: &Metrics) {
    let msg = match CrossNodeMsg::decode(payload) {
        Ok(msg) => msg,
        Err(_) => return,
    };
    if msg.from_node == node_id {
        return;
    }
    let code = match RoomCode::new(&msg.room) {
        Ok(code) => code,
        Err(_) => return,
    };
    let from_peer = match PeerId::new(&msg.from_peer) {
        Ok(peer) => peer,
        Err(_) => return,
    };
    let target = msg.target.as_deref().and_then(|t| PeerId::new(t).ok());

    let server_msg = match msg.kind {
        CrossKind::PeerJoined => {
            messages::peer_joined(from_peer.as_str(), msg.name.as_deref().unwrap_or_default())
        }
        CrossKind::PeerLeft => messages::peer_left(),
        CrossKind::Signal => {
            let data = msg.payload.clone().unwrap_or(serde_json::Value::Null);
            if crate::protocol::is_falsy(&data) {
                return;
            }
            messages::signal(data)
        }
    };

    match target {
        Some(target) => delivery.deliver(&code, &target, server_msg),
        None => delivery.deliver_others(&code, Some(&from_peer), server_msg),
    }
    if msg.kind == CrossKind::Signal {
        metrics.inc_message(names::msg_type::SIGNAL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_bounds_are_one_to_thirty_seconds() {
        assert_eq!(BACKOFF_START, Duration::from_secs(1));
        assert_eq!(BACKOFF_MAX, Duration::from_secs(30));
    }
}
