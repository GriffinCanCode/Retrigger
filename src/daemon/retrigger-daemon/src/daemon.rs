//! The daemon itself: a watcher, a content hasher, and the thread that joins them.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use retrigger_core::SimdLevel;
use retrigger_system::{
    Backend, EventKind, FileEventProcessor, ProcessedEvent, ProcessorStats, WatchError, Watcher,
    WatcherStats,
};
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, watch};
use tracing::{debug, info, warn};

use crate::config::DaemonConfig;
use crate::hasher::Xxh3Hasher;

/// The version reported by `--version`, `GET /health`, and `GET /status`.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// How long the pump waits for an event before checking whether it has been asked to stop.
///
/// This is the upper bound on how long [`Daemon::stop`] takes to join the pump when the tree is
/// quiet, so it trades a negligible amount of idle wake-up against shutdown latency.
const PUMP_TICK: Duration = Duration::from_millis(100);

/// Upper bound on the fan-out ring, independent of the queue.
///
/// The broadcast channel preallocates its ring, so a 100k-event queue must not imply 100k
/// preallocated slots per subscriber generation. A subscriber that falls this far behind is told
/// it lagged, which it must treat exactly like a rescan signal.
const BROADCAST_LIMIT: usize = 1024;

/// A watcher shared by every process that connects.
///
/// # Lifecycle
///
/// [`new`](Self::new) builds the watcher and registers the configured paths, so a path that
/// cannot be watched fails here rather than after the socket is open. [`start`](Self::start)
/// attaches the backend and spawns the pump; [`stop`](Self::stop) reverses it. Both are
/// idempotent, and [`Drop`] stops the daemon so no thread outlives the value.
pub struct Daemon {
    config: DaemonConfig,
    watcher: Arc<Watcher>,
    processor: Arc<FileEventProcessor<Xxh3Hasher>>,
    events: broadcast::Sender<ProcessedEvent>,
    counters: Arc<Counters>,
    started: Instant,
    /// The address actually bound, which is only known after the listener exists — `port = 0`
    /// means the OS picks it.
    address: Mutex<Option<SocketAddr>>,
    pumping: Arc<AtomicBool>,
    pump: Mutex<Option<JoinHandle<()>>>,
    shutdown: watch::Sender<bool>,
}

impl Daemon {
    /// Build a daemon and register every configured watch path.
    ///
    /// # Errors
    ///
    /// If a glob in `[patterns]` does not compile, or a configured path does not exist, cannot
    /// be inspected, or exhausts the kernel's watch descriptors.
    pub fn new(config: DaemonConfig) -> Result<Self> {
        let watcher = Watcher::new(config.watcher_config()?)
            .context("could not create the file system watcher")?;

        for entry in &config.watcher.paths {
            watcher
                .watch(&entry.path, entry.recursive)
                .with_context(|| format!("could not watch {}", entry.path.display()))?;
        }

        let processor = FileEventProcessor::with_config(Xxh3Hasher, config.processor_config());
        let (events, _) =
            broadcast::channel(config.watcher.queue_capacity.clamp(1, BROADCAST_LIMIT));
        let (shutdown, _) = watch::channel(false);

        Ok(Self {
            config,
            watcher: Arc::new(watcher),
            processor: Arc::new(processor),
            events,
            counters: Arc::new(Counters::default()),
            started: Instant::now(),
            address: Mutex::new(None),
            pumping: Arc::new(AtomicBool::new(false)),
            pump: Mutex::new(None),
            shutdown,
        })
    }

    /// Attach the backend and start turning file events into content-change decisions.
    ///
    /// Idempotent: starting a running daemon is a no-op that returns `Ok`.
    ///
    /// # Errors
    ///
    /// If the backend cannot be attached, a registered path has disappeared since it was
    /// registered, or the pump thread cannot be spawned.
    pub fn start(&self) -> Result<()> {
        if self.pumping.swap(true, Ordering::AcqRel) {
            return Ok(());
        }

        if let Err(err) = self.watcher.start() {
            self.pumping.store(false, Ordering::Release);
            return Err(err).context("could not start the file system watcher");
        }

        let watcher = Arc::clone(&self.watcher);
        let processor = Arc::clone(&self.processor);
        let events = self.events.clone();
        let counters = Arc::clone(&self.counters);
        let pumping = Arc::clone(&self.pumping);

        // A dedicated OS thread rather than `spawn_blocking` per event, for two reasons the
        // processor's own documentation implies: hashing is blocking, so it must not sit on a
        // runtime worker; and one thread preserves the order events were observed in, which a
        // pool of blocking tasks would not.
        let handle = std::thread::Builder::new()
            .name("retrigger-pump".to_owned())
            .spawn(move || pump(&watcher, &processor, &events, &counters, &pumping));

        match handle {
            Ok(handle) => {
                *lock(&self.pump) = Some(handle);
                info!(
                    backend = ?self.watcher.backend(),
                    simd = %retrigger_core::active_level(),
                    paths = self.watcher.watched().len(),
                    "watching"
                );
                Ok(())
            }
            Err(err) => {
                self.pumping.store(false, Ordering::Release);
                let _ = self.watcher.stop();
                Err(err).context("could not spawn the event pump thread")
            }
        }
    }

    /// Stop the pump and detach the backend, joining both threads.
    ///
    /// Idempotent, and safe to call from any thread.
    pub fn stop(&self) {
        // Order matters: closing the pump's gate before the watcher stops means the pump always
        // exits on its own timeout rather than spinning on a stopped watcher's empty queue.
        let was_running = self.pumping.swap(false, Ordering::AcqRel);
        if let Some(handle) = lock(&self.pump).take() {
            // A pump that panicked has already stopped, which is all this needs; it must never
            // turn into a hang.
            if handle.join().is_err() {
                warn!("the event pump thread panicked; events are no longer being processed");
            }
        }
        if let Err(err) = self.watcher.stop() {
            warn!(error = %err, "error while stopping the file system watcher");
        }
        if was_running {
            info!("stopped watching");
        }
    }

    /// Ask the daemon to shut down. Returns immediately; the HTTP server winds down on its own.
    pub fn request_shutdown(&self) {
        // `send_replace` rather than `send`: the latter refuses to update the value when no
        // receiver happens to exist yet, which would lose a shutdown requested before the
        // server started waiting for one.
        self.shutdown.send_replace(true);
    }

    /// Resolves once [`request_shutdown`](Self::request_shutdown) has been called.
    ///
    /// Used both as the HTTP server's graceful-shutdown signal and as the terminator for
    /// server-sent event streams, so that an open stream cannot hold shutdown open forever.
    pub async fn shutdown_requested(&self) {
        let mut receiver = self.shutdown.subscribe();
        if *receiver.borrow() {
            return;
        }
        // An error means the sender is gone, which cannot happen while `&self` is alive; treating
        // it as "shut down" is the safe reading either way.
        let _ = receiver.wait_for(|requested| *requested).await;
    }

    /// Subscribe to processed events.
    ///
    /// Lossy by design: a subscriber more than the ring's capacity behind is told it lagged
    /// rather than being allowed to stall the pump.
    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<ProcessedEvent> {
        self.events.subscribe()
    }

    /// Count a connected event subscriber for as long as the returned guard lives.
    #[must_use]
    pub fn track_subscriber(&self) -> SubscriberGuard {
        self.counters.subscribers.fetch_add(1, Ordering::Relaxed);
        SubscriberGuard {
            counters: Arc::clone(&self.counters),
        }
    }

    /// Add a watch at runtime.
    ///
    /// # Errors
    ///
    /// If the path does not exist, cannot be inspected, or the kernel refuses another watch.
    pub fn watch(&self, path: &Path, recursive: bool) -> Result<(), WatchError> {
        self.watcher.watch(path, recursive)?;
        info!(path = %path.display(), recursive, "added watch");
        Ok(())
    }

    /// Remove a watch at runtime.
    ///
    /// # Errors
    ///
    /// [`WatchError::NotFound`] if the path was never registered.
    pub fn unwatch(&self, path: &Path) -> Result<(), WatchError> {
        self.watcher.unwatch(path)?;
        // Fingerprints for a tree nobody watches are memory spent on nothing, and would be stale
        // if the path is watched again later.
        self.processor.invalidate_tree(path);
        info!(path = %path.display(), "removed watch");
        Ok(())
    }

    /// Record the address the HTTP server actually bound.
    pub fn set_address(&self, address: SocketAddr) {
        *lock(&self.address) = Some(address);
    }

    /// The configuration this daemon was built from.
    #[must_use]
    pub fn config(&self) -> &DaemonConfig {
        &self.config
    }

    /// A point-in-time snapshot of everything the daemon knows about itself.
    #[must_use]
    pub fn stats(&self) -> DaemonStats {
        DaemonStats {
            version: VERSION.to_owned(),
            pid: std::process::id(),
            uptime_seconds: self.started.elapsed().as_secs(),
            address: lock(&self.address).map(|address| address.to_string()),
            backend: self.watcher.backend(),
            simd_level: retrigger_core::active_level(),
            running: self.watcher.is_running() && self.pumping.load(Ordering::Acquire),
            watched: self
                .watcher
                .watched()
                .into_iter()
                .map(|(path, recursive)| WatchedPath { path, recursive })
                .collect(),
            subscribers: self.counters.subscribers.load(Ordering::Relaxed),
            events_processed: self.counters.events_processed.load(Ordering::Relaxed),
            changes_detected: self.counters.changes_detected.load(Ordering::Relaxed),
            rescans: self.counters.rescans.load(Ordering::Relaxed),
            watcher: self.watcher.stats(),
            processor: self.processor.stats(),
        }
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        self.stop();
    }
}

impl std::fmt::Debug for Daemon {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Daemon")
            .field("address", &*lock(&self.address))
            .field("running", &self.pumping.load(Ordering::Acquire))
            .field("watcher", &self.watcher)
            // The pump handle is a thread and the channels have no useful representation;
            // `running` already says what a reader wants to know.
            .finish_non_exhaustive()
    }
}

/// Read events, decide whether their contents changed, and fan the answer out.
fn pump(
    watcher: &Watcher,
    processor: &FileEventProcessor<Xxh3Hasher>,
    events: &broadcast::Sender<ProcessedEvent>,
    counters: &Counters,
    pumping: &AtomicBool,
) {
    while pumping.load(Ordering::Acquire) {
        let Some(event) = watcher.recv_timeout(PUMP_TICK) else {
            continue;
        };

        let rescan = event.kind == EventKind::RescanRequired;
        let processed = processor.process(event);

        counters.events_processed.fetch_add(1, Ordering::Relaxed);
        if processed.content_changed {
            counters.changes_detected.fetch_add(1, Ordering::Relaxed);
        }
        if rescan {
            counters.rescans.fetch_add(1, Ordering::Relaxed);
            warn!("events were lost; subscribers must re-scan the tree");
        } else {
            debug!(
                path = %processed.event.path.display(),
                kind = ?processed.event.kind,
                changed = processed.content_changed,
                "processed"
            );
        }

        // No subscribers is not an error. A daemon nobody is listening to is still warming the
        // fingerprint cache for whoever connects next.
        let _ = events.send(processed);
    }
}

/// Counters the daemon keeps that the watcher and processor do not.
#[derive(Debug, Default)]
struct Counters {
    events_processed: AtomicU64,
    changes_detected: AtomicU64,
    rescans: AtomicU64,
    subscribers: AtomicU64,
}

/// Decrements the connected-subscriber count when dropped.
///
/// "How many processes are sharing this watcher" is the one number that says whether running a
/// daemon was worth it, so it has to be right even when a client disappears mid-stream.
#[derive(Debug)]
pub struct SubscriberGuard {
    counters: Arc<Counters>,
}

impl Drop for SubscriberGuard {
    fn drop(&mut self) {
        // Saturating rather than wrapping: an underflow here would report billions of
        // subscribers, which is a worse lie than an undercount.
        let _ = self
            .counters
            .subscribers
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
                Some(n.saturating_sub(1))
            });
    }
}

/// A path the daemon is watching.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WatchedPath {
    /// The registered path.
    pub path: PathBuf,
    /// Whether the whole subtree is watched.
    pub recursive: bool,
}

/// Everything `GET /status` reports.
///
/// Deserializable as well as serializable, because the `status` subcommand is a client of this
/// API like any other: it renders the same struct the server produced rather than picking
/// fields out of untyped JSON, so a field that changes shape breaks the build instead of the
/// output.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaemonStats {
    /// Daemon version.
    pub version: String,
    /// Process id, so a supervisor can find this process without a PID file.
    pub pid: u32,
    /// Seconds since the daemon was constructed.
    pub uptime_seconds: u64,
    /// The address the HTTP API is bound to, once it is bound.
    pub address: Option<String>,
    /// The kernel facility doing the watching.
    pub backend: Backend,
    /// The hash kernel currently dispatching.
    pub simd_level: SimdLevel,
    /// Whether the backend is attached and the pump is running.
    pub running: bool,
    /// Registered watch roots.
    pub watched: Vec<WatchedPath>,
    /// Event streams currently connected.
    pub subscribers: u64,
    /// Events the pump has processed.
    pub events_processed: u64,
    /// Of those, how many were real content changes.
    pub changes_detected: u64,
    /// Rescan signals seen, each meaning events were lost somewhere below.
    pub rescans: u64,
    /// The watcher's own counters.
    pub watcher: WatcherStats,
    /// The content-fingerprint cache's counters.
    pub processor: ProcessorStats,
}

/// Lock without inheriting poisoning: every mutex here guards a plain value, so a panic
/// elsewhere makes the data no less valid, and refusing to serve `/status` because some other
/// thread died is the opposite of useful in a long-running service.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::WatchPath;

    fn config_for(dir: &Path) -> DaemonConfig {
        let mut config = DaemonConfig::default();
        config.server.port = 0;
        config.watcher.debounce_ms = 0;
        config.watcher.paths = vec![WatchPath {
            path: dir.to_path_buf(),
            recursive: true,
        }];
        config
    }

    #[test]
    fn a_configured_path_that_does_not_exist_fails_construction() {
        let mut config = DaemonConfig::default();
        config.watcher.paths = vec![WatchPath {
            path: PathBuf::from("/definitely/not/here"),
            recursive: true,
        }];

        let err = Daemon::new(config).expect_err("an unwatchable path must fail loudly");
        let rendered = format!("{err:#}");
        assert!(
            rendered.contains("/definitely/not/here"),
            "the error must name the path, got: {rendered}"
        );
    }

    #[test]
    fn start_and_stop_are_idempotent() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let daemon = Daemon::new(config_for(dir.path()))?;

        assert!(!daemon.stats().running);
        daemon.start()?;
        daemon.start()?;
        assert!(daemon.stats().running);

        daemon.stop();
        daemon.stop();
        assert!(!daemon.stats().running);

        // And it must come back up: stop cannot leave the watcher in an unusable state.
        daemon.start()?;
        assert!(daemon.stats().running);
        Ok(())
    }

    #[test]
    fn watch_and_unwatch_change_the_reported_set() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let daemon = Daemon::new(config_for(dir.path()))?;
        let extra = dir.path().join("extra");
        std::fs::create_dir(&extra)?;

        daemon.watch(&extra, false)?;
        assert_eq!(daemon.stats().watched.len(), 2);

        daemon.unwatch(&extra)?;
        assert_eq!(daemon.stats().watched.len(), 1);

        assert!(
            matches!(
                daemon.unwatch(&extra),
                Err(WatchError::NotFound(path)) if path == extra
            ),
            "unwatching twice must report that it was not registered"
        );
        Ok(())
    }

    #[test]
    fn watching_a_path_that_does_not_exist_is_an_error_not_a_panic() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let daemon = Daemon::new(config_for(dir.path()))?;
        assert!(matches!(
            daemon.watch(Path::new("/definitely/not/here"), true),
            Err(WatchError::NotFound(_))
        ));
        Ok(())
    }

    #[test]
    fn stats_report_the_engine_that_is_actually_wired_in() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let daemon = Daemon::new(config_for(dir.path()))?;
        let stats = daemon.stats();

        assert_eq!(stats.version, VERSION);
        assert_eq!(stats.pid, std::process::id());
        assert_eq!(stats.watched.len(), 1);
        assert_eq!(
            stats.processor.capacity,
            daemon.config().watcher.hash_cache_size
        );
        assert!(retrigger_core::available_levels().contains(&stats.simd_level));
        Ok(())
    }

    #[test]
    fn the_subscriber_count_returns_to_zero_when_a_client_goes_away() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let daemon = Daemon::new(config_for(dir.path()))?;
        assert_eq!(daemon.stats().subscribers, 0);

        let first = daemon.track_subscriber();
        let second = daemon.track_subscriber();
        assert_eq!(daemon.stats().subscribers, 2);

        drop(first);
        assert_eq!(daemon.stats().subscribers, 1);
        drop(second);
        assert_eq!(daemon.stats().subscribers, 0);
        Ok(())
    }

    #[tokio::test]
    async fn shutdown_is_observable_before_and_after_it_is_requested() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let daemon = Daemon::new(config_for(dir.path()))?;

        assert!(
            tokio::time::timeout(Duration::from_millis(50), daemon.shutdown_requested())
                .await
                .is_err(),
            "shutdown must not resolve before it is asked for"
        );

        daemon.request_shutdown();
        tokio::time::timeout(Duration::from_secs(5), daemon.shutdown_requested())
            .await
            .context("shutdown signal was not observed")?;

        // A second observer arriving after the fact must still see it, or a late-connecting
        // stream would hang shutdown open.
        tokio::time::timeout(Duration::from_secs(5), daemon.shutdown_requested())
            .await
            .context("a late observer missed the shutdown signal")?;
        Ok(())
    }
}
