#![forbid(unsafe_code)]

pub mod book;
pub mod cache;
pub mod certificate;
mod dependency;
pub mod opening_import;
pub mod ordering;
mod position_codec;
pub mod proof;
mod proof_graph;
pub mod rules;
mod scout;
pub mod search;
pub use search::dfpn;
pub mod strategy;
pub mod symmetry;
pub mod tactics;
mod threats;
pub mod worklist;
