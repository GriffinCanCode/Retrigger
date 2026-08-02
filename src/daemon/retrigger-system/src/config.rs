//! Configuration, backend identification, and statistics.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::filter::EventFilter;

/// Default bounded-queue capacity.
///
/// Large enough to absorb a `git checkout` of a mid-sized tree, small enough that a runaway
/// producer costs kilobytes rather than gigabytes.
pub const DEFAULT_CAPACITY: usize = 4096;

/// Default coalescing window.
///
/// One editor save typically produces write + metadata + close in well under a millisecond;
/// 50 ms collapses that into a single wake-up while staying far below human perception.
pub const DEFAULT_DEBOUNCE: Duration = Duration::from_millis(50);

/// The kernel facility doing the actual watching.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Backend {
    /// Linux `inotify`.
    Inotify,
    /// macOS `FSEvents`.
    FsEvents,
    /// Windows `ReadDirectoryChangesW`.
    ReadDirectoryChangesW,
    /// BSD `kqueue`.
    KQueue,
    /// Portable fallback that periodically re-scans the tree.
    Polling,
}

/// Watcher configuration.
///
/// Construct with `..Default::default()` and override what you care about:
///
/// ```
/// use retrigger_system::{EventFilter, WatcherConfig};
/// use std::time::Duration;
///
/// let config = WatcherConfig {
///     capacity: 1024,
///     debounce: Duration::ZERO,
///     filter: EventFilter::dev_defaults()?,
///     ..Default::default()
/// };
/// # Ok::<(), retrigger_system::WatchError>(())
/// ```
#[derive(Debug, Clone)]
pub struct WatcherConfig {
    /// Bounded queue size, in events.
    ///
    /// When the queue is full, incoming events are dropped and a single
    /// [`EventKind::RescanRequired`](crate::EventKind::RescanRequired) is raised so the consumer
    /// can recover correctness. Clamped to at least `1`.
    pub capacity: usize,
    /// Window within which repeated coalescable events for the same path collapse into one.
    ///
    /// Coalescing is leading-edge: the first event is delivered at once and repeat noise behind it
    /// is dropped. [`Duration::ZERO`] disables it entirely.
    ///
    /// Deletes and renames are never coalesced, and neither is any event that follows a change in
    /// the path's existence, so a window can never hide a file disappearing or coming back.
    pub debounce: Duration,
    /// Whether the backend follows symbolic links when recursing.
    ///
    /// Honoured by inotify, kqueue, and the polling backend. macOS `FSEvents` does not expose the
    /// choice and always reports the resolved path.
    pub follow_symlinks: bool,
    /// Include/exclude filtering, applied before events are queued.
    ///
    /// Defaults to [`EventFilter::new`] — no filtering at all.
    pub filter: EventFilter,
}

impl Default for WatcherConfig {
    fn default() -> Self {
        Self {
            capacity: DEFAULT_CAPACITY,
            debounce: DEFAULT_DEBOUNCE,
            follow_symlinks: true,
            filter: EventFilter::new(),
        }
    }
}

/// A point-in-time snapshot of watcher counters.
///
/// `events_queued`, `events_delivered`, `events_dropped`, and `queue_pending` are read under a
/// single lock, so they are mutually consistent and satisfy
///
/// ```text
/// events_queued == events_delivered + queue_pending
/// ```
///
/// at all times, with `events_dropped` counting events that were never queued at all.
/// `watched_paths`, `events_synthesized`, and `is_running` are read from separate state and are
/// therefore *not* part of that snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WatcherStats {
    /// Events accepted into the queue since creation, after filtering and coalescing.
    ///
    /// Includes raised rescan signals, each of which counts as one queued event.
    pub events_queued: u64,
    /// Events discarded because the queue was full.
    ///
    /// Filtered and coalesced events are *not* counted here: they were never queue candidates.
    pub events_dropped: u64,
    /// Events handed to a consumer through [`poll`](crate::Watcher::poll) or
    /// [`recv_timeout`](crate::Watcher::recv_timeout).
    ///
    /// Broadcast subscribers do not affect this counter.
    pub events_delivered: u64,
    /// Events this crate produced itself, by reading a directory that had just appeared inside a
    /// recursive watch.
    ///
    /// A backend that watches per directory (inotify) cannot report a file written into a directory
    /// during the moment between the directory appearing and its watch being installed. Those
    /// entries are found by reading the directory and reported as
    /// [`Created`](crate::EventKind::Created); this counter is how many such reports were made. A
    /// subset of `events_queued`, and normally zero on a quiet tree.
    ///
    /// A steadily climbing value under load is expected during installs and checkouts; it is
    /// evidence the gap is being closed, not that something is wrong.
    pub events_synthesized: u64,
    /// Number of paths currently registered through [`watch`](crate::Watcher::watch).
    pub watched_paths: usize,
    /// Events awaiting delivery, including a raised-but-undelivered rescan signal.
    ///
    /// Because the rescan signal is held outside the ring, this can briefly be
    /// `queue_capacity + 1`.
    pub queue_pending: usize,
    /// Configured queue capacity.
    pub queue_capacity: usize,
    /// Whether the backend is currently running.
    pub is_running: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_sensible() {
        let config = WatcherConfig::default();
        assert_eq!(config.capacity, DEFAULT_CAPACITY);
        assert!(config.capacity >= 1000, "capacity should absorb a burst");
        assert_eq!(config.debounce, DEFAULT_DEBOUNCE);
        assert!(config.debounce < Duration::from_millis(250), "stay snappy");
        assert!(config.follow_symlinks);
        assert!(
            config.filter.is_empty(),
            "the default filter must not silently swallow paths"
        );
    }

    #[test]
    fn config_supports_struct_update_syntax() {
        let config = WatcherConfig {
            capacity: 7,
            ..Default::default()
        };
        assert_eq!(config.capacity, 7);
        assert_eq!(config.debounce, DEFAULT_DEBOUNCE);
    }

    #[test]
    fn stats_serialize_round_trip() {
        let stats = WatcherStats {
            events_queued: 3,
            events_dropped: 1,
            events_delivered: 2,
            events_synthesized: 1,
            watched_paths: 1,
            queue_pending: 1,
            queue_capacity: 8,
            is_running: true,
        };
        let json = serde_json::to_string(&stats).expect("serialize");
        let back: WatcherStats = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(stats, back);
    }
}
