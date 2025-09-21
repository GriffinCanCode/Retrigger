//! Retrigger Daemon Library
//! 
//! High-performance file system watching daemon with gRPC API

pub mod config;
pub mod daemon;
pub mod grpc;
pub mod metrics;
pub mod ipc;     // Zero-copy IPC module
pub mod api;     // Zero-copy public APIs

pub use daemon::{Daemon, DaemonStats};
pub use config::{ConfigManager, DaemonConfig};
pub use ipc::{ZeroCopyRing, ZeroCopyConfig, RingStats};
