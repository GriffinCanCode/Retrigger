//! Retrigger Daemon Library
//!
//! High-performance file system watching daemon with gRPC API

pub mod api;
pub mod config;
pub mod daemon;
pub mod grpc;
pub mod ipc; // Zero-copy IPC module
pub mod metrics; // Zero-copy public APIs

pub use config::{ConfigManager, DaemonConfig};
pub use daemon::{Daemon, DaemonStats};
pub use ipc::{RingStats, ZeroCopyConfig, ZeroCopyRing};
