//! Connection-level bounded outbound queue.
//!
//! Every outbound frame goes through a **bounded** `mpsc` channel; a full queue
//! marks the client slow (the writer then closes it). Unbounded buffering is a
//! compile-time review red line (OOM protection).

use tokio::sync::mpsc;

use crate::protocol::ServerMsg;

pub use crate::rooms::outbound_channel as bounded;

/// Outcome of a non-blocking enqueue.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Enqueue {
    /// Enqueued successfully.
    Accepted,
    /// The queue is full (client is slow).
    Full,
    /// The receiver is gone (connection already closed).
    Closed,
}

/// Non-blocking enqueue used by the connection writer / router.
pub fn try_enqueue(tx: &mpsc::Sender<ServerMsg>, msg: ServerMsg) -> Enqueue {
    match tx.try_send(msg) {
        Ok(()) => Enqueue::Accepted,
        Err(mpsc::error::TrySendError::Full(_)) => Enqueue::Full,
        Err(mpsc::error::TrySendError::Closed(_)) => Enqueue::Closed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_queue_reports_full() {
        let (tx, _rx) = bounded(1);
        assert_eq!(
            try_enqueue(&tx, ServerMsg::PeerLeft { role: None }),
            Enqueue::Accepted
        );
        assert_eq!(
            try_enqueue(&tx, ServerMsg::PeerLeft { role: None }),
            Enqueue::Full
        );
    }

    #[test]
    fn closed_queue_reports_closed() {
        let (tx, rx) = bounded(1);
        drop(rx);
        assert_eq!(
            try_enqueue(&tx, ServerMsg::PeerLeft { role: None }),
            Enqueue::Closed
        );
    }

    #[test]
    fn capacity_is_at_least_one() {
        let (tx, _rx) = bounded(0);
        assert_eq!(
            try_enqueue(&tx, ServerMsg::PeerLeft { role: None }),
            Enqueue::Accepted
        );
    }
}
