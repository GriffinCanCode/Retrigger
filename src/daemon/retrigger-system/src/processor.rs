//! Content-change detection on top of the raw event stream.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tracing::debug;

use crate::bounded::BoundedMap;
use crate::error::WatchError;
use crate::event::{EventKind, FileEvent};
use crate::hash::{ContentHasher, Fnv1aHasher};

/// Cache tuning.
#[derive(Debug, Clone, Copy)]
pub struct ProcessorConfig {
    /// Upper bound on cached fingerprints.
    ///
    /// A hard ceiling, not a target to drift above: the cache retires a whole generation when the
    /// current one fills, so the count never exceeds this. The `bounded` module explains why that is
    /// preferred over evicting by age; it is internal, so this is a pointer for readers of the source
    /// rather than a link.
    pub max_entries: usize,
    /// How long a cached fingerprint is trusted. An older entry is treated as absent.
    pub ttl: Duration,
}

impl Default for ProcessorConfig {
    fn default() -> Self {
        Self {
            max_entries: 100_000,
            ttl: Duration::from_secs(3600),
        }
    }
}

/// An event enriched with content-change information.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessedEvent {
    /// The event as delivered by the watcher.
    pub event: FileEvent,
    /// Content fingerprint, when one was computed. `None` for directories, removals, rescan
    /// signals, and files that could not be read.
    pub hash: Option<u64>,
    /// Whether the consumer should treat this as a real change.
    ///
    /// | event | `content_changed` |
    /// |---|---|
    /// | file created/modified/metadata/rename-target, fingerprint differs from cache | `true` |
    /// | ditto, fingerprint matches cache | `false` |
    /// | file could not be read | `true` — unknown is treated as changed, because rebuilding is cheaper than missing a change |
    /// | file deleted or renamed away | `true` |
    /// | directory created/deleted/renamed | `true` |
    /// | directory modified/metadata | `false` — directory mtime churn is not a content change |
    /// | rescan signal | `true` |
    pub content_changed: bool,
    /// Wall time spent processing this event, including hashing.
    pub processing_time_ns: u64,
    /// Whether a fresh cached fingerprint was found for this path.
    pub cache_hit: bool,
}

/// Cache and hashing counters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessorStats {
    /// Fingerprints currently cached. Never exceeds `capacity`.
    pub entries: usize,
    /// Configured hard cap on cached fingerprints.
    pub capacity: usize,
    /// Approximate heap bytes held by the cache, dominated by the cached paths themselves.
    ///
    /// Worth watching separately from `entries` because path length is not bounded by anything this
    /// crate controls: a deep monorepo can hold a cap's worth of entries in far more memory than a
    /// flat directory can. Approximate — a hash table's real overhead depends on a load factor that
    /// is not observable — so read it as a trend, not an audit.
    pub cache_bytes: usize,
    /// Lookups that found a fresh cached fingerprint.
    pub cache_hits: u64,
    /// Lookups that found nothing, or something expired.
    pub cache_misses: u64,
    /// Files read and fingerprinted.
    pub files_hashed: u64,
    /// Files that could not be read.
    pub hash_errors: u64,
    /// Events processed.
    pub events_processed: u64,
}

#[derive(Debug, Clone, Copy)]
struct CacheEntry {
    hash: u64,
    refreshed: Instant,
}

/// Turns raw file events into content-change decisions.
///
/// A watcher reports that a file was written; a bundler wants to know whether the bytes actually
/// differ, because editors, formatters, and build tools rewrite files with identical contents
/// constantly. This keeps a fingerprint per path and answers that question.
///
/// # Blocking
///
/// [`process`](Self::process) reads files, so it blocks. Call it from a dedicated thread, or use
/// [`process_async`](Self::process_async), which moves the work to
/// [`tokio::task::spawn_blocking`]. Never call `process` directly from an async task: it would
/// occupy a runtime worker thread for the duration of a file read.
///
/// # Example
///
/// ```
/// use retrigger_system::{EventKind, FileEvent, FileEventProcessor};
///
/// let processor = FileEventProcessor::new();
/// # let dir = tempfile::tempdir()?;
/// # let path = dir.path().join("a.txt");
/// # std::fs::write(&path, b"hello")?;
/// let event = |kind| FileEvent {
///     path: path.clone(),
///     kind,
///     timestamp_ns: 0,
///     size: 5,
///     is_directory: false,
///     cookie: None,
/// };
///
/// let first = processor.process(event(EventKind::Created));
/// assert!(first.content_changed);
///
/// // Same bytes rewritten: the bundler does not need to wake up.
/// let second = processor.process(event(EventKind::Modified));
/// assert!(!second.content_changed);
/// # Ok::<(), std::io::Error>(())
/// ```
pub struct FileEventProcessor<H: ContentHasher = Fnv1aHasher> {
    hasher: H,
    /// Held only for the map operation itself, never across a file read — see [`crate::bounded`]
    /// for why an exclusive lock is what makes `max_entries` a real ceiling.
    cache: Mutex<BoundedMap<CacheEntry>>,
    config: ProcessorConfig,
    cache_hits: AtomicU64,
    cache_misses: AtomicU64,
    files_hashed: AtomicU64,
    hash_errors: AtomicU64,
    events_processed: AtomicU64,
}

impl FileEventProcessor<Fnv1aHasher> {
    /// Build a processor using the default [`Fnv1aHasher`].
    #[must_use]
    pub fn new() -> Self {
        Self::with_hasher(Fnv1aHasher)
    }
}

impl Default for FileEventProcessor<Fnv1aHasher> {
    fn default() -> Self {
        Self::new()
    }
}

impl<H: ContentHasher> FileEventProcessor<H> {
    /// Build a processor around a specific [`ContentHasher`].
    #[must_use]
    pub fn with_hasher(hasher: H) -> Self {
        Self::with_config(hasher, ProcessorConfig::default())
    }

    /// Build a processor around a specific hasher and cache configuration.
    #[must_use]
    pub fn with_config(hasher: H, config: ProcessorConfig) -> Self {
        Self {
            hasher,
            cache: Mutex::new(BoundedMap::new(config.max_entries)),
            config,
            cache_hits: AtomicU64::new(0),
            cache_misses: AtomicU64::new(0),
            files_hashed: AtomicU64::new(0),
            hash_errors: AtomicU64::new(0),
            events_processed: AtomicU64::new(0),
        }
    }

    /// Decide whether `event` represents a content change. Blocks on file I/O.
    #[must_use]
    pub fn process(&self, event: FileEvent) -> ProcessedEvent {
        let started = Instant::now();
        self.events_processed.fetch_add(1, Ordering::Relaxed);

        let (hash, content_changed, cache_hit) = if event.kind == EventKind::RescanRequired {
            (None, true, false)
        } else if event.is_directory {
            if event.kind.is_removal() {
                self.invalidate_tree(&event.path);
            }
            let structural = matches!(
                event.kind,
                EventKind::Created
                    | EventKind::Deleted
                    | EventKind::RenamedFrom
                    | EventKind::RenamedTo
            );
            (None, structural, false)
        } else if event.kind.is_removal() {
            self.invalidate(&event.path);
            (None, true, false)
        } else {
            self.fingerprint(&event.path)
        };

        ProcessedEvent {
            event,
            hash,
            content_changed,
            processing_time_ns: u64::try_from(started.elapsed().as_nanos()).unwrap_or(u64::MAX),
            cache_hit,
        }
    }

    /// `(hash, content_changed, cache_hit)` for a file that should exist.
    fn fingerprint(&self, path: &Path) -> (Option<u64>, bool, bool) {
        let hash = match self.hasher.hash_file(path) {
            Ok(hash) => {
                self.files_hashed.fetch_add(1, Ordering::Relaxed);
                hash
            }
            Err(err) => {
                // Unknown is not the same as unchanged: a file we cannot read may well have
                // changed, and a spurious rebuild is cheaper than a missed one.
                self.hash_errors.fetch_add(1, Ordering::Relaxed);
                debug!(path = %path.display(), error = %err, "could not hash file");
                return (None, true, false);
            }
        };

        let previous = self.cached(path);
        self.store(path, hash);
        (Some(hash), previous != Some(hash), previous.is_some())
    }

    /// Fresh cached fingerprint for `path`, if any. Updates hit/miss counters.
    fn cached(&self, path: &Path) -> Option<u64> {
        match self.cache.lock().get(path).copied() {
            Some(entry) if entry.refreshed.elapsed() < self.config.ttl => {
                self.cache_hits.fetch_add(1, Ordering::Relaxed);
                Some(entry.hash)
            }
            _ => {
                self.cache_misses.fetch_add(1, Ordering::Relaxed);
                None
            }
        }
    }

    /// Cache a fingerprint.
    ///
    /// There is no eviction pass to run: the cache retires a generation when one fills, which is
    /// what keeps `max_entries` a ceiling instead of a suggestion. A path that keeps changing is
    /// re-stored on every event and so stays in the newest generation; a path that stops changing
    /// ages out, and being wrong about it costs one re-hash.
    fn store(&self, path: &Path, hash: u64) {
        self.cache.lock().insert(
            path,
            CacheEntry {
                hash,
                refreshed: Instant::now(),
            },
        );
    }

    /// Forget the fingerprint for one path.
    pub fn invalidate(&self, path: &Path) {
        self.cache.lock().remove(path);
    }

    /// Forget fingerprints for `directory` and everything beneath it.
    pub fn invalidate_tree(&self, directory: &Path) {
        self.cache
            .lock()
            .retain_keys(|path| !path.starts_with(directory));
    }

    /// Forget everything.
    pub fn clear(&self) {
        self.cache.lock().clear();
    }

    /// Read the counters.
    #[must_use]
    pub fn stats(&self) -> ProcessorStats {
        let cache = self.cache.lock();
        ProcessorStats {
            entries: cache.len(),
            cache_bytes: cache.bytes(),
            capacity: self.config.max_entries,
            cache_hits: self.cache_hits.load(Ordering::Relaxed),
            cache_misses: self.cache_misses.load(Ordering::Relaxed),
            files_hashed: self.files_hashed.load(Ordering::Relaxed),
            hash_errors: self.hash_errors.load(Ordering::Relaxed),
            events_processed: self.events_processed.load(Ordering::Relaxed),
        }
    }
}

impl<H: ContentHasher + 'static> FileEventProcessor<H> {
    /// [`process`](Self::process), moved off the async runtime's worker threads.
    ///
    /// # Errors
    ///
    /// [`WatchError::Io`] if the blocking task could not run to completion (runtime shutting
    /// down, or the task panicked — which this crate's own code never does).
    pub async fn process_async(
        self: Arc<Self>,
        event: FileEvent,
    ) -> Result<ProcessedEvent, WatchError> {
        tokio::task::spawn_blocking(move || self.process(event))
            .await
            .map_err(|err| {
                WatchError::Io(std::io::Error::other(format!(
                    "content hashing task did not complete: {err}"
                )))
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;
    use std::path::PathBuf;

    fn file_event(path: PathBuf, kind: EventKind) -> FileEvent {
        FileEvent::new(path, kind, 0, false)
    }

    struct Harness {
        _dir: tempfile::TempDir,
        root: PathBuf,
    }

    impl Harness {
        fn new() -> io::Result<Self> {
            let dir = tempfile::tempdir()?;
            let root = dir.path().to_path_buf();
            Ok(Self { _dir: dir, root })
        }

        fn write(&self, name: &str, contents: &[u8]) -> io::Result<PathBuf> {
            let path = self.root.join(name);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&path, contents)?;
            Ok(path)
        }
    }

    #[test]
    fn first_sight_of_a_file_is_a_change() -> io::Result<()> {
        let harness = Harness::new()?;
        let path = harness.write("a.txt", b"hello")?;
        let processor = FileEventProcessor::new();

        let processed = processor.process(file_event(path, EventKind::Created));
        assert!(processed.content_changed);
        assert!(!processed.cache_hit);
        assert_eq!(processed.hash, Some(crate::hash::fnv1a_64(b"hello")));
        Ok(())
    }

    #[test]
    fn rewriting_identical_bytes_is_not_a_change() -> io::Result<()> {
        let harness = Harness::new()?;
        let path = harness.write("a.txt", b"hello")?;
        let processor = FileEventProcessor::new();

        let _ = processor.process(file_event(path.clone(), EventKind::Created));
        harness.write("a.txt", b"hello")?;
        let processed = processor.process(file_event(path, EventKind::Modified));

        assert!(
            !processed.content_changed,
            "a formatter that rewrites a file byte-for-byte must not wake the bundler"
        );
        assert!(processed.cache_hit);
        Ok(())
    }

    #[test]
    fn changed_bytes_are_a_change() -> io::Result<()> {
        let harness = Harness::new()?;
        let path = harness.write("a.txt", b"hello")?;
        let processor = FileEventProcessor::new();

        let _ = processor.process(file_event(path.clone(), EventKind::Created));
        harness.write("a.txt", b"hello!")?;
        let processed = processor.process(file_event(path, EventKind::Modified));

        assert!(processed.content_changed);
        assert!(processed.cache_hit, "the stale entry was still consulted");
        assert_eq!(processed.hash, Some(crate::hash::fnv1a_64(b"hello!")));
        Ok(())
    }

    #[test]
    fn metadata_events_still_verify_contents() -> io::Result<()> {
        let harness = Harness::new()?;
        let path = harness.write("a.txt", b"x")?;
        let processor = FileEventProcessor::new();

        let _ = processor.process(file_event(path.clone(), EventKind::Created));
        let processed = processor.process(file_event(path, EventKind::Metadata));
        assert!(!processed.content_changed);
        assert_eq!(processor.stats().files_hashed, 2);
        Ok(())
    }

    #[test]
    fn deletion_is_a_change_and_evicts_the_entry() -> io::Result<()> {
        let harness = Harness::new()?;
        let path = harness.write("a.txt", b"x")?;
        let processor = FileEventProcessor::new();

        let _ = processor.process(file_event(path.clone(), EventKind::Created));
        assert_eq!(processor.stats().entries, 1);

        let processed = processor.process(file_event(path, EventKind::Deleted));
        assert!(processed.content_changed);
        assert_eq!(processed.hash, None);
        assert_eq!(processor.stats().entries, 0);
        Ok(())
    }

    #[test]
    fn rename_source_evicts_and_rename_target_hashes() -> io::Result<()> {
        let harness = Harness::new()?;
        let from = harness.write("a.txt", b"x")?;
        let processor = FileEventProcessor::new();
        let _ = processor.process(file_event(from.clone(), EventKind::Created));

        std::fs::rename(&from, harness.root.join("b.txt"))?;
        let source = processor.process(file_event(from, EventKind::RenamedFrom));
        assert!(source.content_changed);
        assert_eq!(source.hash, None);

        let target =
            processor.process(file_event(harness.root.join("b.txt"), EventKind::RenamedTo));
        assert!(target.content_changed);
        assert_eq!(target.hash, Some(crate::hash::fnv1a_64(b"x")));
        Ok(())
    }

    #[test]
    fn unreadable_file_is_treated_as_changed() {
        let processor = FileEventProcessor::new();
        let processed = processor.process(file_event(
            PathBuf::from("/definitely/not/here.txt"),
            EventKind::Modified,
        ));
        assert!(
            processed.content_changed,
            "unknown must fail towards rebuilding, never towards silence"
        );
        assert_eq!(processed.hash, None);
        assert_eq!(processor.stats().hash_errors, 1);
    }

    #[test]
    fn directory_events_are_structural_only() -> io::Result<()> {
        let harness = Harness::new()?;
        let processor = FileEventProcessor::new();
        let dir = harness.root.join("sub");
        std::fs::create_dir_all(&dir)?;

        let mut event = file_event(dir.clone(), EventKind::Created);
        event.is_directory = true;
        let created = processor.process(event);
        assert!(created.content_changed);
        assert_eq!(created.hash, None);

        let mut event = file_event(dir, EventKind::Modified);
        event.is_directory = true;
        let modified = processor.process(event);
        assert!(
            !modified.content_changed,
            "directory mtime churn is not a content change"
        );
        assert_eq!(processor.stats().files_hashed, 0);
        Ok(())
    }

    #[test]
    fn deleting_a_directory_invalidates_its_subtree() -> io::Result<()> {
        let harness = Harness::new()?;
        let processor = FileEventProcessor::new();
        let inside = harness.write("sub/deep/a.txt", b"x")?;
        let outside = harness.write("other.txt", b"y")?;
        let _ = processor.process(file_event(inside, EventKind::Created));
        let _ = processor.process(file_event(outside, EventKind::Created));
        assert_eq!(processor.stats().entries, 2);

        let mut event = file_event(harness.root.join("sub"), EventKind::Deleted);
        event.is_directory = true;
        let _ = processor.process(event);

        assert_eq!(
            processor.stats().entries,
            1,
            "only the subtree under the deleted directory should be forgotten"
        );
        Ok(())
    }

    #[test]
    fn rescan_signal_is_a_change_and_touches_no_file() {
        let processor = FileEventProcessor::new();
        let processed = processor.process(FileEvent {
            path: PathBuf::new(),
            kind: EventKind::RescanRequired,
            timestamp_ns: 0,
            size: 0,
            is_directory: false,
            cookie: None,
        });
        assert!(processed.content_changed);
        assert_eq!(processed.hash, None);
        assert_eq!(processor.stats().files_hashed, 0);
        assert_eq!(processor.stats().hash_errors, 0);
    }

    #[test]
    fn expired_entries_are_treated_as_absent() -> io::Result<()> {
        let harness = Harness::new()?;
        let path = harness.write("a.txt", b"x")?;
        let processor = FileEventProcessor::with_config(
            Fnv1aHasher,
            ProcessorConfig {
                max_entries: 16,
                ttl: Duration::ZERO,
            },
        );

        let _ = processor.process(file_event(path.clone(), EventKind::Created));
        let processed = processor.process(file_event(path, EventKind::Modified));
        assert!(
            processed.content_changed,
            "a fingerprint older than the TTL must not be trusted"
        );
        assert!(!processed.cache_hit);
        assert_eq!(processor.stats().cache_hits, 0);
        assert_eq!(processor.stats().cache_misses, 2);
        Ok(())
    }

    #[test]
    fn cache_stays_bounded_under_pressure() -> io::Result<()> {
        let harness = Harness::new()?;
        let processor = FileEventProcessor::with_config(
            Fnv1aHasher,
            ProcessorConfig {
                max_entries: 32,
                ttl: Duration::from_secs(60),
            },
        );
        for i in 0..500 {
            let path = harness.write(&format!("f{i}.txt"), format!("body {i}").as_bytes())?;
            let _ = processor.process(file_event(path, EventKind::Created));
        }
        let stats = processor.stats();
        assert!(
            stats.entries <= 32,
            "cache grew to {} with a cap of 32",
            stats.entries
        );
        assert!(
            stats.cache_bytes > 0,
            "a populated cache reporting zero bytes is not accounting for anything"
        );
        assert_eq!(stats.files_hashed, 500);
        Ok(())
    }

    #[test]
    fn a_directory_deletion_that_races_its_children_still_forgets_them() -> io::Result<()> {
        // The ordering the kernel is free to hand us: children reported after the parent's removal.
        // Whatever arrives late is re-cached, but nothing from the deleted subtree may be trusted
        // *after* the deletion is processed, or a rebuild would be skipped for a file that is gone.
        let harness = Harness::new()?;
        let processor = FileEventProcessor::new();
        let inside = harness.write("sub/a.txt", b"x")?;
        let _ = processor.process(file_event(inside.clone(), EventKind::Created));

        let mut event = file_event(harness.root.join("sub"), EventKind::Deleted);
        event.is_directory = true;
        let _ = processor.process(event);

        assert_eq!(processor.stats().entries, 0);
        std::fs::remove_file(&inside)?;
        let orphan = processor.process(file_event(inside, EventKind::Deleted));
        assert!(orphan.content_changed);
        assert_eq!(processor.stats().entries, 0);
        Ok(())
    }

    #[test]
    fn invalidate_and_clear_do_what_they_say() -> io::Result<()> {
        let harness = Harness::new()?;
        let processor = FileEventProcessor::new();
        let a = harness.write("a.txt", b"a")?;
        let b = harness.write("b.txt", b"b")?;
        let _ = processor.process(file_event(a.clone(), EventKind::Created));
        let _ = processor.process(file_event(b, EventKind::Created));

        processor.invalidate(&a);
        assert_eq!(processor.stats().entries, 1);
        processor.clear();
        assert_eq!(processor.stats().entries, 0);
        Ok(())
    }

    #[test]
    fn stats_are_internally_consistent() -> io::Result<()> {
        let harness = Harness::new()?;
        let processor = FileEventProcessor::new();
        let path = harness.write("a.txt", b"a")?;
        for _ in 0..5 {
            let _ = processor.process(file_event(path.clone(), EventKind::Modified));
        }
        let stats = processor.stats();
        assert_eq!(stats.events_processed, 5);
        assert_eq!(stats.files_hashed, 5);
        assert_eq!(stats.cache_hits + stats.cache_misses, 5);
        assert_eq!(stats.cache_misses, 1, "only the first look-up can miss");
        assert_eq!(stats.entries, 1);
        Ok(())
    }

    #[test]
    fn a_custom_hasher_can_be_substituted() -> io::Result<()> {
        /// Stands in for the production engine the orchestrator will wire in.
        struct AlwaysSeven;
        impl ContentHasher for AlwaysSeven {
            fn hash_file(&self, _path: &Path) -> io::Result<u64> {
                Ok(7)
            }
        }

        let harness = Harness::new()?;
        let path = harness.write("a.txt", b"whatever")?;
        let processor = FileEventProcessor::with_hasher(AlwaysSeven);
        assert_eq!(
            processor.process(file_event(path, EventKind::Created)).hash,
            Some(7)
        );
        Ok(())
    }

    #[tokio::test]
    async fn process_async_runs_off_the_runtime_worker() -> io::Result<()> {
        let harness = Harness::new()?;
        let path = harness.write("a.txt", b"hello")?;
        let processor = Arc::new(FileEventProcessor::new());

        let processed = Arc::clone(&processor)
            .process_async(file_event(path.clone(), EventKind::Created))
            .await
            .expect("blocking task completes");
        assert_eq!(processed.hash, Some(crate::hash::fnv1a_64(b"hello")));

        let again = processor
            .process_async(file_event(path, EventKind::Modified))
            .await
            .expect("blocking task completes");
        assert!(!again.content_changed);
        Ok(())
    }

    #[test]
    fn processor_is_send_and_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<FileEventProcessor>();
        assert_send_sync::<ProcessedEvent>();
    }

    #[test]
    fn concurrent_processing_keeps_counters_consistent() -> io::Result<()> {
        let harness = Harness::new()?;
        let processor = Arc::new(FileEventProcessor::new());
        let mut paths = Vec::new();
        for i in 0..20 {
            paths.push(harness.write(&format!("f{i}.txt"), format!("{i}").as_bytes())?);
        }

        let mut handles = Vec::new();
        for _ in 0..4 {
            let processor = Arc::clone(&processor);
            let paths = paths.clone();
            handles.push(std::thread::spawn(move || {
                for path in paths {
                    let _ = processor.process(file_event(path, EventKind::Modified));
                }
            }));
        }
        for handle in handles {
            handle.join().expect("worker thread");
        }

        let stats = processor.stats();
        assert_eq!(stats.events_processed, 80);
        assert_eq!(stats.files_hashed, 80);
        assert_eq!(stats.cache_hits + stats.cache_misses, 80);
        assert_eq!(stats.entries, 20);
        Ok(())
    }
}
