//! Cross-platform file system watching for Retrigger.
//!
//! A thin, safe layer over the [`notify`] crate that adds the properties a dev-server watcher
//! actually needs: a **bounded** queue that reports its own losses, per-path coalescing that
//! never swallows a delete, uniform non-recursive semantics across backends, include/exclude
//! filtering applied before anything is queued, and a lifecycle that joins its threads.
//!
//! There is no FFI, no `unsafe`, and no silent failure mode: [`forbid(unsafe_code)`] is enforced
//! at the crate root.
//!
//! # Quick start
//!
//! ```no_run
//! use retrigger_system::{EventKind, Watcher, WatcherConfig};
//! use std::path::Path;
//! use std::time::Duration;
//!
//! let watcher = Watcher::new(WatcherConfig::default())?;
//! watcher.watch(Path::new("src"), true)?;
//! watcher.start()?;
//!
//! while let Some(event) = watcher.recv_timeout(Duration::from_secs(5)) {
//!     match event.kind {
//!         // Events were lost; re-read the tree instead of trusting the stream.
//!         EventKind::RescanRequired => rebuild_everything(),
//!         _ => rebuild(&event.path),
//!     }
//! }
//!
//! watcher.stop()?;
//! # fn rebuild_everything() {}
//! # fn rebuild(_: &Path) {}
//! # Ok::<(), retrigger_system::WatchError>(())
//! ```
//!
//! # Loss is reported, never silent
//!
//! Every mechanism that can lose an event surfaces it:
//!
//! - the bounded queue overflowing raises [`EventKind::RescanRequired`] and increments
//!   [`WatcherStats::events_dropped`];
//! - a kernel-reported overflow (`IN_Q_OVERFLOW`, `kFSEventStreamEventFlagMustScanSubDirs`)
//!   raises the same signal;
//! - a watch that could not be installed because the kernel limit was reached raises it too, and
//!   [`WatchError::WatchLimitExceeded`] carries the remediation;
//! - a [`subscribe`](Watcher::subscribe) receiver that falls behind gets
//!   [`RecvError::Lagged`](tokio::sync::broadcast::error::RecvError::Lagged).
//!
//! A consumer that treats [`EventKind::RescanRequired`] as "re-read everything" is always
//! correct, no matter how hard the file system is hammered.
//!
//! # New directories
//!
//! `mkdir -p dist && write dist/bundle.js` is the most common shape of change a build tool makes,
//! and on inotify it is the one shape a naive watcher loses: watches are per directory, so `dist`
//! is unobserved until its own creation event has been processed, and the write lands inside that
//! window.
//!
//! When a directory appears inside a recursive watch, this crate therefore *reads* it and reports
//! what is already there as [`Created`](EventKind::Created), descending into subdirectories it
//! finds the same way. Those events are counted in
//! [`WatcherStats::events_synthesized`] and are otherwise indistinguishable from real ones, which
//! is the point: an entry either produced a kernel event or gets a synthesized one. A tree too
//! large to describe this way raises [`EventKind::RescanRequired`] instead of emitting tens of
//! thousands of events. The mechanism, its bounds, and what it does *not* guarantee are documented
//! on the `scan` module — read it before changing any of it.
//!
//! # Debouncing
//!
//! [`WatcherConfig::debounce`] coalesces on the **leading** edge: the first event for a path is
//! delivered immediately and further [coalescable](EventKind::is_coalescable) events for the same
//! path within the window are dropped. Deletes and renames are never coalesced, and neither is an
//! event that follows a change in whether the path exists — collapsing either would change what
//! the stream means rather than how often it fires.
//!
//! [`notify-debouncer-full`] was evaluated and deliberately not used: it debounces on the
//! trailing edge, which taxes *every* change with the full window before the consumer hears about
//! it, and it re-derives its own rename/delete model on top of the backend's, which is precisely
//! the layer of guesswork this crate is meant to remove. It is also, at the time of writing, only
//! published as a release candidate.
//!
//! # Platform notes
//!
//! | | Linux | macOS | Windows |
//! |---|---|---|---|
//! | backend | `inotify` | `FSEvents` | `ReadDirectoryChangesW` |
//! | rename [`cookie`](FileEvent::cookie) | yes | no | no |
//! | rename sides | reported by the kernel | inferred from whether the path exists | reported by the kernel |
//! | new subdirectories under a recursive watch | watched automatically by `notify` | inherently recursive | inherently recursive |
//! | non-recursive watches | native | narrowed by this crate | native |
//! | event paths | as given | fully resolved (`/private/var/...`) | as given |
//! | event ordering | chronological per watch | *not* chronological within a coalesced batch | chronological per watch |
//! | [`EventKind`] | as the kernel reported it | re-derived from the path | as the kernel reported it |
//!
//! The macOS rows are two halves of one fact: `FSEvents` reports the union of flags that occurred
//! for a path in a batch rather than a sequence of operations, and `notify` expands that union in a
//! fixed order. One rewrite of an existing file therefore arrives as `Created` + `Metadata` +
//! `Modified`, and a single `rm` as `Created` + `Deleted` + `Metadata`.
//!
//! Apple's guidance is that the flags are advisory and the file system is the authority, so this
//! crate asks it. Every macOS event is checked against the path it names *before* it is queued,
//! using the `stat` the watcher already performs for [`FileEvent::size`], and:
//!
//! - a `Created` for a path whose birth time predates the watch is delivered as `Modified`;
//! - a kind the path outright contradicts — an arrival or a metadata change for something that is
//!   not there — is dropped rather than forwarded, so a consumer is not told that a file it has
//!   just been told to forget is back;
//! - `Deleted` and `RenamedFrom` are kept apart, because absence corroborates both.
//!
//! What no layer above the kernel can reconstruct is the *order* inside a batch, since it was never
//! recorded. Consumers that need ground truth for a path should still stat it (or hash it — see
//! [`FileEventProcessor`]) rather than replaying event order.
//!
//! [`forbid(unsafe_code)`]: https://doc.rust-lang.org/reference/attributes/diagnostics.html
//! [`notify-debouncer-full`]: https://docs.rs/notify-debouncer-full

#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![warn(clippy::pedantic)]
#![allow(clippy::module_name_repetitions)]

mod bounded;
mod config;
mod error;
mod event;
mod filter;
mod hash;
mod processor;
mod queue;
mod scan;
mod watcher;

pub use config::{Backend, WatcherConfig, WatcherStats, DEFAULT_CAPACITY, DEFAULT_DEBOUNCE};
pub use error::WatchError;
pub use event::{EventKind, FileEvent};
pub use filter::EventFilter;
pub use hash::{fnv1a_64, ContentHasher, Fnv1aHasher};
pub use processor::{FileEventProcessor, ProcessedEvent, ProcessorConfig, ProcessorStats};
pub use watcher::Watcher;
