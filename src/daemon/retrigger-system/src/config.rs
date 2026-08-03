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

/// Which backend implementation drives event delivery.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum BackendMode {
    /// Whatever `notify` recommends for the current platform: `inotify` on Linux, `FSEvents` on
    /// macOS, `ReadDirectoryChangesW` on Windows.
    #[default]
    Auto,
    /// Force `notify`'s portable polling backend, which re-`stat`s watched paths on an interval
    /// instead of asking the kernel.
    ///
    /// The one honest way to watch a network file system (NFS, SMB, and similar): kernel watch
    /// events are unreliable or entirely absent over them, whereas polling degrades gracefully to
    /// however fast the mount answers `stat`. It costs real CPU and I/O in proportion to tree size
    /// and `interval`, which is why it is never chosen automatically.
    Poll {
        /// How often to re-scan watched paths.
        interval: Duration,
        /// Whether to also hash file contents to detect changes size and modification time miss —
        /// significant extra cost, since every watched file is read on every interval.
        compare_contents: bool,
    },
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
    ///
    /// What the window *did* swallow is restated once it closes, so a burst wakes the consumer
    /// twice — immediately, and again with the file's final state — rather than leaving it holding
    /// a file it was woken for mid-write. Raising this therefore trades freshness for fewer
    /// wake-ups in both directions.
    pub debounce: Duration,
    /// Whether symbolic links are followed, for two distinct questions this one flag answers.
    ///
    /// 1. **Descent.** Whether the backend walks *through* a symlinked directory when recursing,
    ///    rather than reporting the link itself and stopping. Honoured by inotify, kqueue, and
    ///    the polling backend; macOS `FSEvents` does not expose the choice and always resolves.
    ///    This crate's own directory reconciliation (see [`crate::scan`]) never follows a
    ///    symlinked directory regardless of this setting — loop safety is structural, not
    ///    configurable, because a link back into its own ancestry would otherwise recurse forever.
    /// 2. **Inspection.** Whether [`Watcher::watch`](crate::Watcher::watch) and the per-event
    ///    `stat` that fills in [`FileEvent::size`](crate::FileEvent::size) resolve a symlinked
    ///    *event path* (`stat`, following the link) or report the link itself (`lstat`, `false`).
    ///    This is the sense in which a caller who watches a symlink and sets this to `false` sees
    ///    the link's own size and existence rather than its target's.
    ///
    /// Both default to `true` — the historical, link-transparent behaviour.
    pub follow_symlinks: bool,
    /// Include/exclude filtering, applied before events are queued.
    ///
    /// Defaults to [`EventFilter::new`] — no filtering at all.
    pub filter: EventFilter,
    /// Which backend drives event delivery.
    ///
    /// Defaults to [`BackendMode::Auto`], which preserves this crate's original behaviour
    /// exactly. [`BackendMode::Poll`] is for network file systems and similar mounts where kernel
    /// watch events cannot be trusted; see its documentation for the cost.
    pub backend: BackendMode,
    /// Hold a changed file until it stops growing before reporting it ("await write finish").
    ///
    /// `None` (the default) preserves this crate's original behaviour: an event is reported as
    /// soon as the backend sees it, which for a large file being written in chunks means the
    /// first chunk. When set, a [coalescable](crate::EventKind::is_coalescable) event for a
    /// non-directory path is held and re-`stat`d on [`poll_interval`](AwaitWriteFinishConfig::poll_interval);
    /// once its size and modification time have been unchanged for
    /// [`stability_threshold`](AwaitWriteFinishConfig::stability_threshold), exactly one
    /// [`Modified`](crate::EventKind::Modified) is delivered. A removal or rename for a path being
    /// held cancels the hold and is delivered immediately — this can never delay or hide a delete.
    pub await_write_finish: Option<AwaitWriteFinishConfig>,
    /// Fold an atomic-save `RenamedTo` for a path the consumer has already seen arrive into
    /// [`Modified`](crate::EventKind::Modified).
    ///
    /// Off by default, which preserves this crate's original behaviour: editors and build tools
    /// that save atomically (write a temp file, `rename` it over the target) produce a
    /// `RenamedTo` for a path that already exists, and a consumer that only reacts to `Modified`
    /// would otherwise miss it. A `RenamedTo` for a path that has never been announced is a
    /// genuine arrival and is never folded, flag or no flag.
    pub atomic_write_normalization: bool,
}

impl Default for WatcherConfig {
    fn default() -> Self {
        Self {
            capacity: DEFAULT_CAPACITY,
            debounce: DEFAULT_DEBOUNCE,
            follow_symlinks: true,
            filter: EventFilter::new(),
            backend: BackendMode::Auto,
            await_write_finish: None,
            atomic_write_normalization: false,
        }
    }
}

/// [`WatcherConfig::await_write_finish`] thresholds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AwaitWriteFinishConfig {
    /// How often to re-`stat` a path while waiting for it to settle.
    pub poll_interval: Duration,
    /// How long a path's size and modification time must be unchanged before it is reported.
    pub stability_threshold: Duration,
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
        assert_eq!(config.backend, BackendMode::Auto);
        assert_eq!(config.await_write_finish, None);
        assert!(!config.atomic_write_normalization);
    }

    #[test]
    fn backend_mode_defaults_to_auto() {
        assert_eq!(BackendMode::default(), BackendMode::Auto);
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
