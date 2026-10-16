//! WebRTC Gomoku signaling server (Rust rewrite, M3 v2.0).
//!
//! The server has exactly two responsibilities:
//!   1. Host the static single-page client.
//!   2. Relay WebRTC signaling (offer/answer/ice) by room. Game data never
//!      touches the server (it flows over the peer-to-peer DataChannel).
//!
//! ## Module dependency direction (strictly acyclic)
//!
//! ```text
//! protocol ◄─ rooms ◄─ transport ◄─ http ◄─ main
//! config   ◄─ (read-only leaf, referenced everywhere)
//! metrics  ◄─ (write-only leaf, referenced everywhere)
//! relay    ◄─ transport (transport publishes via relay; relay delivers back
//!              through the `rooms::LocalDelivery` trait, i.e. dependency
//!              inversion — no concrete transport type is referenced).
//! ```

pub mod admin;
pub mod config;
pub mod http;
pub mod metrics;
pub mod protocol;
pub mod relay;
pub mod rooms;
pub mod state;
pub mod transport;
