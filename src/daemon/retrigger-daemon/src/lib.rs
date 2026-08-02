//! The Retrigger daemon: one file watcher, shared by several processes.
//!
//! # Why this exists
//!
//! It is optional. `@retrigger/core` watches in-process and needs nothing from here; a single
//! bundler with a single watcher should not run a daemon at all. What a daemon buys is *sharing*:
//! when a bundler, a test runner, and a type checker all watch the same tree, they otherwise
//! install three sets of kernel watches and hash every changed file three times. This process
//! installs one set, hashes once, and fans the result out over HTTP.
//!
//! That framing bounds the machinery. There is no cluster mode, no authentication, no plugin
//! system, and no custom wire protocol — just a watcher, a content hasher, and an HTTP server
//! that any language can talk to.
//!
//! # Shape
//!
//! - [`config`] — the TOML file, its defaults, and its validation.
//! - [`hasher`] — the [`ContentHasher`](retrigger_system::ContentHasher) bridge onto the XXH3-64
//!   engine in `retrigger-core`.
//! - [`daemon`] — the watcher, the processor, and the thread that pumps one into the other.
//! - [`api`] — the HTTP surface, including the server-sent event stream.
//! - [`client`] — the small HTTP client the `status` and `stop` subcommands use to talk to a
//!   running daemon.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod api;
pub mod client;
pub mod config;
pub mod daemon;
pub mod hasher;

pub use config::DaemonConfig;
pub use daemon::{Daemon, DaemonStats};
pub use hasher::Xxh3Hasher;
