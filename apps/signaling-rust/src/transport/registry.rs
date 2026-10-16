//! Connection registry: global + per-IP admission control.
//!
//! Admission happens **before** the WS upgrade so that rejected connections
//! allocate no resources. The per-IP counter uses a sharded `DashMap` (no
//! global lock); the global counter is a single `AtomicU64`.

use std::net::IpAddr;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;

use dashmap::DashMap;

/// Result of an admission attempt.
pub enum AdmitResult {
    /// Admitted; the ticket decrements the counters on drop.
    Admitted(ConnAdmission),
    /// Rejected because the global cap was reached.
    RejectedGlobal,
    /// Rejected because the per-IP cap was reached.
    RejectedPerIp,
}

/// RAII admission ticket. Dropping it releases both counters (no leak, even on
/// panic — `Drop` always runs).
pub struct ConnAdmission {
    global: Arc<AtomicU64>,
    per_ip: Arc<DashMap<IpAddr, AtomicU32>>,
    ip: IpAddr,
}

impl Drop for ConnAdmission {
    fn drop(&mut self) {
        self.global.fetch_sub(1, Ordering::AcqRel);
        let became_zero = match self.per_ip.get(&self.ip) {
            Some(entry) => entry.fetch_sub(1, Ordering::AcqRel) == 1,
            None => false,
        };
        if became_zero {
            // Best-effort cleanup so a flood of distinct IPs cannot leak memory.
            self.per_ip
                .remove_if(&self.ip, |_, v| v.load(Ordering::Relaxed) == 0);
        }
    }
}

/// Global + per-IP connection accounting.
pub struct ConnectionRegistry {
    global: Arc<AtomicU64>,
    per_ip: Arc<DashMap<IpAddr, AtomicU32>>,
    max_global: AtomicU64,
    max_per_ip: AtomicU32,
}

impl ConnectionRegistry {
    /// Build a registry with the given caps.
    pub fn new(max_global: u64, max_per_ip: u32) -> Self {
        Self {
            global: Arc::new(AtomicU64::new(0)),
            per_ip: Arc::new(DashMap::new()),
            max_global: AtomicU64::new(max_global),
            max_per_ip: AtomicU32::new(max_per_ip),
        }
    }

    /// Update caps (used by hot reload).
    pub fn set_limits(&self, max_global: u64, max_per_ip: u32) {
        self.max_global.store(max_global, Ordering::Relaxed);
        self.max_per_ip.store(max_per_ip, Ordering::Relaxed);
    }

    /// Atomically admit a connection from `ip`.
    pub fn admit(&self, ip: IpAddr) -> AdmitResult {
        // 1) Global cap via CAS loop.
        let max_global = self.max_global.load(Ordering::Relaxed);
        let mut current = self.global.load(Ordering::Acquire);
        loop {
            if current >= max_global {
                return AdmitResult::RejectedGlobal;
            }
            match self.global.compare_exchange_weak(
                current,
                current + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => break,
                Err(observed) => current = observed,
            }
        }

        // 2) Per-IP cap.
        let max_per_ip = self.max_per_ip.load(Ordering::Relaxed);
        let entry = self.per_ip.entry(ip).or_insert_with(|| AtomicU32::new(0));
        let mut ip_count = entry.load(Ordering::Acquire);
        loop {
            if ip_count >= max_per_ip {
                drop(entry);
                self.global.fetch_sub(1, Ordering::AcqRel);
                return AdmitResult::RejectedPerIp;
            }
            match entry.compare_exchange_weak(
                ip_count,
                ip_count + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => break,
                Err(observed) => ip_count = observed,
            }
        }
        drop(entry);

        AdmitResult::Admitted(ConnAdmission {
            global: self.global.clone(),
            per_ip: self.per_ip.clone(),
            ip,
        })
    }

    /// Current global connection count.
    pub fn current(&self) -> u64 {
        self.global.load(Ordering::Relaxed)
    }

    /// Current count for a single IP.
    pub fn current_for(&self, ip: IpAddr) -> u32 {
        self.per_ip
            .get(&ip)
            .map(|e| e.load(Ordering::Relaxed))
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(n: u8) -> IpAddr {
        IpAddr::from([10, 0, 0, n])
    }

    #[test]
    fn admits_until_global_cap() {
        let reg = ConnectionRegistry::new(2, 10);
        let a = reg.admit(ip(1));
        let b = reg.admit(ip(2));
        assert!(matches!(a, AdmitResult::Admitted(_)));
        assert!(matches!(b, AdmitResult::Admitted(_)));
        assert!(matches!(reg.admit(ip(3)), AdmitResult::RejectedGlobal));
        assert_eq!(reg.current(), 2);
    }

    #[test]
    fn admits_until_per_ip_cap() {
        let reg = ConnectionRegistry::new(100, 2);
        let a = reg.admit(ip(1));
        let b = reg.admit(ip(1));
        assert!(matches!(a, AdmitResult::Admitted(_)));
        assert!(matches!(b, AdmitResult::Admitted(_)));
        assert!(matches!(reg.admit(ip(1)), AdmitResult::RejectedPerIp));
        // A different IP is still allowed.
        assert!(matches!(reg.admit(ip(2)), AdmitResult::Admitted(_)));
    }

    #[test]
    fn rejection_does_not_leak_counts() {
        let reg = ConnectionRegistry::new(100, 1);
        let held = reg.admit(ip(1));
        assert!(matches!(held, AdmitResult::Admitted(_)));
        // per-IP reject must not bump the global counter
        assert!(matches!(reg.admit(ip(1)), AdmitResult::RejectedPerIp));
        assert_eq!(reg.current(), 1);
    }

    #[test]
    fn drop_decrements_both_counters() {
        let reg = ConnectionRegistry::new(100, 5);
        {
            let _a = reg.admit(ip(1));
            let _b = reg.admit(ip(1));
            assert_eq!(reg.current(), 2);
            assert_eq!(reg.current_for(ip(1)), 2);
        }
        assert_eq!(reg.current(), 0);
        assert_eq!(reg.current_for(ip(1)), 0);
    }

    #[test]
    fn global_reject_then_free_allows_again() {
        let reg = ConnectionRegistry::new(1, 5);
        {
            let _a = reg.admit(ip(1));
            assert!(matches!(reg.admit(ip(2)), AdmitResult::RejectedGlobal));
        }
        assert!(matches!(reg.admit(ip(2)), AdmitResult::Admitted(_)));
    }
}
