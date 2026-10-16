//! Prometheus registry and metric handles.
//!
//! All hot-path updates are lock-free (the `prometheus` crate uses atomics
//! internally); there is no logging or IO here.

pub mod middleware;
pub mod names;

use prometheus::{Counter, Encoder, Gauge, Histogram, HistogramOpts, Opts, Registry, TextEncoder};

/// Latency histogram buckets (seconds), tuned for the ≤10 ms / ≤50 ms targets.
const LATENCY_BUCKETS: &[f64] = &[
    0.0005, 0.001, 0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0,
];

/// The metrics registry plus typed handles.
pub struct Metrics {
    registry: Registry,
    ws_connections: Gauge,
    rooms: Gauge,
    messages_total: prometheus::CounterVec,
    errors_total: prometheus::CounterVec,
    signal_latency: Histogram,
    redis_connected: Gauge,
    http_requests: Counter,
}

impl Metrics {
    /// Build the registry with every metric registered.
    pub fn new() -> Self {
        let registry = Registry::new();

        let ws_connections = Gauge::new(names::WS_CONNECTIONS, "当前 WS 连接数").expect("gauge");
        let rooms = Gauge::new(names::ROOMS, "当前房间数").expect("gauge");
        let messages_total = prometheus::CounterVec::new(
            Opts::new(names::MESSAGES_TOTAL, "按消息类型计数"),
            &[names::LABEL_TYPE],
        )
        .expect("counter vec");
        let errors_total = prometheus::CounterVec::new(
            Opts::new(names::ERRORS_TOTAL, "按错误类型计数"),
            &[names::LABEL_KIND],
        )
        .expect("counter vec");
        let signal_latency = Histogram::with_opts(
            HistogramOpts::new(names::SIGNAL_LATENCY_SECONDS, "信令转发延迟分布")
                .buckets(LATENCY_BUCKETS.to_vec()),
        )
        .expect("histogram");
        let redis_connected =
            Gauge::new(names::REDIS_CONNECTED, "Redis 连通状态 0/1").expect("gauge");
        let http_requests =
            Counter::new(names::HTTP_REQUESTS_TOTAL, "HTTP 请求总数").expect("counter");

        registry
            .register(Box::new(ws_connections.clone()))
            .expect("register");
        registry
            .register(Box::new(rooms.clone()))
            .expect("register");
        registry
            .register(Box::new(messages_total.clone()))
            .expect("register");
        registry
            .register(Box::new(errors_total.clone()))
            .expect("register");
        registry
            .register(Box::new(signal_latency.clone()))
            .expect("register");
        registry
            .register(Box::new(redis_connected.clone()))
            .expect("register");
        registry
            .register(Box::new(http_requests.clone()))
            .expect("register");

        // Pre-register every known label value at 0 so a cold, traffic-free
        // instance still exposes all six metric families (PRD §6.2 / DoD10).
        // `CounterVec` children are created lazily on first use; touching each
        // label combination here forces them to appear immediately.
        for kind in names::msg_type::ALL {
            messages_total.with_label_values(&[kind]);
        }
        for kind in names::err_kind::ALL {
            errors_total.with_label_values(&[kind]);
        }

        Self {
            registry,
            ws_connections,
            rooms,
            messages_total,
            errors_total,
            signal_latency,
            redis_connected,
            http_requests,
        }
    }

    /// Set the WS connection gauge.
    pub fn set_ws_connections(&self, value: u64) {
        self.ws_connections.set(value as f64);
    }

    /// Set the room gauge.
    pub fn set_rooms(&self, value: u64) {
        self.rooms.set(value as f64);
    }

    /// Set the Redis connectivity gauge.
    pub fn set_redis_connected(&self, connected: bool) {
        self.redis_connected.set(if connected { 1.0 } else { 0.0 });
    }

    /// Increment the message counter for `kind`.
    pub fn inc_message(&self, kind: &str) {
        self.messages_total.with_label_values(&[kind]).inc();
    }

    /// Increment the error counter for `kind`.
    pub fn inc_error(&self, kind: &str) {
        self.errors_total.with_label_values(&[kind]).inc();
    }

    /// Observe a signaling latency sample (seconds).
    pub fn observe_signal_latency(&self, seconds: f64) {
        self.signal_latency.observe(seconds);
    }

    /// Count one handled HTTP request.
    pub fn inc_http_request(&self) {
        self.http_requests.inc();
    }

    /// Render the Prometheus text exposition format.
    pub fn render(&self) -> String {
        let families = self.registry.gather();
        let mut buffer = Vec::new();
        let encoder = TextEncoder::new();
        if encoder.encode(&families, &mut buffer).is_err() {
            return String::new();
        }
        String::from_utf8(buffer).unwrap_or_default()
    }
}

impl Default for Metrics {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_contains_all_metrics() {
        let m = Metrics::new();
        m.set_ws_connections(3);
        m.set_rooms(2);
        m.set_redis_connected(true);
        m.inc_message(names::msg_type::CREATE);
        m.inc_error(names::err_kind::ROOM_FULL);
        m.observe_signal_latency(0.002);
        let text = m.render();
        assert!(text.contains("gomoku_ws_connections 3"));
        assert!(text.contains("gomoku_rooms 2"));
        assert!(text.contains("gomoku_redis_connected 1"));
        assert!(text.contains("gomoku_messages_total"));
        assert!(text.contains("gomoku_errors_total"));
        assert!(text.contains("gomoku_signal_latency_seconds"));
    }

    #[test]
    fn redis_gauge_reflects_disconnect() {
        let m = Metrics::new();
        m.set_redis_connected(false);
        assert!(m.render().contains("gomoku_redis_connected 0"));
    }

    #[test]
    fn names_are_prefixed() {
        for name in [
            names::WS_CONNECTIONS,
            names::ROOMS,
            names::MESSAGES_TOTAL,
            names::ERRORS_TOTAL,
            names::SIGNAL_LATENCY_SECONDS,
            names::REDIS_CONNECTED,
        ] {
            assert!(name.starts_with("gomoku_"), "{name}");
        }
    }

    #[test]
    fn cold_start_exposes_all_six_metric_families() {
        // A brand-new instance with zero traffic must already expose all six
        // families (PRD §6.2 / DoD10) — including the labelled counter vectors,
        // whose children are pre-registered at 0.
        let text = Metrics::new().render();
        for name in [
            names::WS_CONNECTIONS,
            names::ROOMS,
            names::MESSAGES_TOTAL,
            names::ERRORS_TOTAL,
            names::SIGNAL_LATENCY_SECONDS,
            names::REDIS_CONNECTED,
        ] {
            assert!(text.contains(name), "cold start missing {name}");
        }
    }

    #[test]
    fn cold_start_pre_registers_every_label_value() {
        let text = Metrics::new().render();
        for kind in names::msg_type::ALL {
            assert!(
                text.contains(&format!("gomoku_messages_total{{type=\"{kind}\"}} 0")),
                "missing pre-registered message type {kind}"
            );
        }
        for kind in names::err_kind::ALL {
            assert!(
                text.contains(&format!("gomoku_errors_total{{kind=\"{kind}\"}} 0")),
                "missing pre-registered error kind {kind}"
            );
        }
    }
}
