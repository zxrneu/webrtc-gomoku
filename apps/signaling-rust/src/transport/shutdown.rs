//! Graceful-shutdown token and drain logic.
//!
//! Flow (PRD §3.1 R10 / architecture §4.4): SIGTERM ⇒ stop accepting ⇒
//! broadcast shutdown ⇒ wait ≤ `shutdown_drain_secs` for connections to close ⇒
//! force-exit. Connections hold a [`ConnTicket`]; when the active count reaches
//! zero the drain completes early.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;

/// Shutdown broadcast token.
#[derive(Clone)]
pub struct Shutdown {
    flag: Arc<watch::Sender<bool>>,
    active: Arc<watch::Sender<u64>>,
    total: Arc<AtomicU64>,
}

impl Default for Shutdown {
    fn default() -> Self {
        Self::new()
    }
}

impl Shutdown {
    /// Create a fresh shutdown token.
    pub fn new() -> Self {
        let (flag, _flag_rx) = watch::channel(false);
        let (active, _active_rx) = watch::channel(0u64);
        Self {
            flag: Arc::new(flag),
            active: Arc::new(active),
            total: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Subscribe to shutdown notifications.
    pub fn subscribe(&self) -> watch::Receiver<bool> {
        self.flag.subscribe()
    }

    /// Trigger shutdown.
    pub fn trigger(&self) {
        self.flag.send_replace(true);
    }

    /// Whether shutdown has been triggered.
    pub fn is_shutdown(&self) -> bool {
        *self.flag.borrow()
    }

    /// Register a live connection; the returned ticket decrements on drop.
    pub fn register_connection(&self) -> ConnTicket {
        self.active.send_modify(|v| *v = v.saturating_add(1));
        self.total.fetch_add(1, Ordering::Relaxed);
        ConnTicket {
            active: self.active.clone(),
        }
    }

    /// Total connections ever registered (for tests/diagnostics).
    pub fn total_connections(&self) -> u64 {
        self.total.load(Ordering::Relaxed)
    }

    /// Current live connection count.
    pub fn active_connections(&self) -> u64 {
        *self.active.borrow()
    }

    /// Wait until all connections have closed or `timeout` elapses.
    ///
    /// Returns `true` when the drain completed (all connections closed) before
    /// the timeout.
    pub async fn drain(&self, timeout: Duration) -> bool {
        let mut rx = self.active.subscribe();
        if *rx.borrow() == 0 {
            return true;
        }
        let wait = async {
            loop {
                if *rx.borrow_and_update() == 0 {
                    return true;
                }
                if rx.changed().await.is_err() {
                    return true;
                }
            }
        };
        tokio::time::timeout(timeout, wait).await.unwrap_or(false)
    }
}

/// RAII ticket keeping the active-connection count accurate.
pub struct ConnTicket {
    active: Arc<watch::Sender<u64>>,
}

impl Drop for ConnTicket {
    fn drop(&mut self) {
        self.active.send_modify(|v| *v = v.saturating_sub(1));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn drain_returns_immediately_when_idle() {
        let s = Shutdown::new();
        assert!(s.drain(Duration::from_secs(1)).await);
    }

    #[tokio::test(start_paused = true)]
    async fn drain_times_out_when_connection_stays_open() {
        let s = Shutdown::new();
        let _ticket = s.register_connection();
        assert_eq!(s.active_connections(), 1);
        let drained = s.drain(Duration::from_millis(100)).await;
        assert!(!drained, "should time out while a connection is open");
    }

    #[tokio::test(start_paused = true)]
    async fn drain_completes_early_when_connection_closes() {
        let s = Shutdown::new();
        let ticket = s.register_connection();
        let s2 = s.clone();
        let handle = tokio::spawn(async move { s2.drain(Duration::from_secs(30)).await });
        // let the drain task start waiting
        tokio::task::yield_now().await;
        drop(ticket);
        let drained = handle.await.expect("join");
        assert!(drained, "should drain once the ticket drops");
    }

    #[tokio::test]
    async fn trigger_sets_flag_and_notifies_subscribers() {
        let s = Shutdown::new();
        let mut rx = s.subscribe();
        assert!(!s.is_shutdown());
        s.trigger();
        rx.changed().await.expect("changed");
        assert!(*rx.borrow());
        assert!(s.is_shutdown());
    }

    #[tokio::test]
    async fn tickets_count_total_and_active() {
        let s = Shutdown::new();
        let a = s.register_connection();
        let b = s.register_connection();
        assert_eq!(s.active_connections(), 2);
        assert_eq!(s.total_connections(), 2);
        drop(a);
        drop(b);
        assert_eq!(s.active_connections(), 0);
        assert_eq!(s.total_connections(), 2);
    }
}
