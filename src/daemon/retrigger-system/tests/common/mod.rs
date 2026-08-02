//! Shared test scaffolding.
//!
//! Two rules the whole suite obeys:
//!
//! 1. **No hardcoded paths.** Every test gets its own [`Tree`] under [`tempfile`], so tests can
//!    run in parallel without colliding.
//! 2. **No sleeping to wait for events.** File systems are asynchronous and their latency varies
//!    by orders of magnitude between a warm laptop and a loaded CI container, so every wait is a
//!    deadline-bounded poll ([`wait_for`], [`collect_until`]). The only sleeps in the suite are
//!    where a *time window* is the thing under test (debounce expiry) or where the assertion is
//!    about absence, which cannot be proven without bounding it.

#![allow(dead_code)]

use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use retrigger_system::{EventKind, FileEvent, Watcher, WatcherStats};
use tempfile::TempDir;

/// Upper bound on how long any single expected event may take to show up.
///
/// Deliberately generous: exceeding it means something is broken, not slow. Tests finish as soon
/// as the event arrives, so a large bound costs nothing when things work.
pub const DEADLINE: Duration = Duration::from_secs(10);

/// How long to keep listening when asserting that something did *not* happen.
///
/// An absence claim cannot be proven without a window. Kept short because every such assertion is
/// paired with a positive event that has already arrived through the same code path.
pub const GRACE: Duration = Duration::from_millis(400);

/// An isolated directory tree.
pub struct Tree {
    dir: TempDir,
    /// Canonicalized root.
    ///
    /// Canonical because macOS reports fully-resolved paths (`/private/var/folders/...`) while
    /// `TempDir` hands out the symlinked form (`/var/folders/...`). Building every expectation
    /// from the resolved root removes that entire class of false failure.
    pub root: PathBuf,
}

impl Tree {
    /// Create an empty tree.
    pub fn new() -> Self {
        let dir = tempfile::tempdir().expect("create temp dir");
        let root = dir.path().canonicalize().expect("canonicalize temp dir");
        Self { dir, root }
    }

    /// Absolute path of `relative` inside the tree.
    pub fn path(&self, relative: impl AsRef<Path>) -> PathBuf {
        self.root.join(relative)
    }

    /// Write a file, creating parent directories as needed.
    pub fn write(&self, relative: impl AsRef<Path>, contents: &[u8]) -> PathBuf {
        let path = self.path(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent directories");
        }
        fs::write(&path, contents).unwrap_or_else(|e| panic!("write {}: {e}", path.display()));
        path
    }

    /// Create a directory (and any missing parents).
    pub fn mkdir(&self, relative: impl AsRef<Path>) -> PathBuf {
        let path = self.path(relative);
        fs::create_dir_all(&path).unwrap_or_else(|e| panic!("mkdir {}: {e}", path.display()));
        path
    }

    /// Delete a file.
    pub fn remove(&self, relative: impl AsRef<Path>) -> PathBuf {
        let path = self.path(relative);
        fs::remove_file(&path).unwrap_or_else(|e| panic!("remove {}: {e}", path.display()));
        path
    }

    /// Rename within the tree, returning `(from, to)`.
    pub fn rename(&self, from: impl AsRef<Path>, to: impl AsRef<Path>) -> (PathBuf, PathBuf) {
        let from = self.path(from);
        let to = self.path(to);
        fs::rename(&from, &to).unwrap_or_else(|e| panic!("rename {}: {e}", from.display()));
        (from, to)
    }

    /// The unresolved temp path, for tests that care about symlinked roots.
    pub fn unresolved_root(&self) -> &Path {
        self.dir.path()
    }
}

impl Default for Tree {
    fn default() -> Self {
        Self::new()
    }
}

/// Wait until an event satisfying `predicate` arrives, or `timeout` elapses.
pub fn wait_for(
    watcher: &Watcher,
    timeout: Duration,
    predicate: impl Fn(&FileEvent) -> bool,
) -> Option<FileEvent> {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return None;
        }
        match watcher.recv_timeout(remaining.min(Duration::from_millis(25))) {
            Some(event) if predicate(&event) => return Some(event),
            Some(_) => {}
            None if !watcher.is_running() => std::thread::sleep(Duration::from_millis(5)),
            None => {}
        }
    }
}

/// Collect events until `done` is satisfied by everything seen so far, or `timeout` elapses.
///
/// Returns everything collected either way, so a failing assertion can show the whole stream.
pub fn collect_until(
    watcher: &Watcher,
    timeout: Duration,
    done: impl Fn(&[FileEvent]) -> bool,
) -> Vec<FileEvent> {
    let deadline = Instant::now() + timeout;
    let mut seen = Vec::new();
    while !done(&seen) {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match watcher.recv_timeout(remaining.min(Duration::from_millis(25))) {
            Some(event) => seen.push(event),
            None if !watcher.is_running() => std::thread::sleep(Duration::from_millis(5)),
            None => {}
        }
    }
    seen
}

/// Drain everything currently queued, plus anything that arrives within `window`.
pub fn drain_for(watcher: &Watcher, window: Duration) -> Vec<FileEvent> {
    let deadline = Instant::now() + window;
    let mut seen = Vec::new();
    while Instant::now() < deadline {
        match watcher.recv_timeout(Duration::from_millis(20)) {
            Some(event) => seen.push(event),
            None if !watcher.is_running() => break,
            None => {}
        }
    }
    seen
}

/// Prove the watcher is delivering events before the test relies on it.
///
/// Installing a watch is not the same as the backend being live: FSEvents starts a run loop and
/// only reports changes from that point on, and inotify has a comparable window. Rather than
/// sleeping a guessed amount, write a sentinel and retry until its event comes back — then the
/// backend is demonstrably live.
///
/// `sentinel` receives an attempt number so callers can choose a name their own filter accepts.
pub fn arm_with(watcher: &Watcher, tree: &Tree, sentinel: impl Fn(usize) -> String) {
    let deadline = Instant::now() + DEADLINE;
    let mut attempt = 0;
    while Instant::now() < deadline {
        let path = tree.write(sentinel(attempt), b"arm");
        if wait_for(watcher, Duration::from_millis(250), |event| {
            event.path == path
        })
        .is_some()
        {
            // Let the rest of the sentinel's own events (a trailing modify, say) land and be
            // discarded, so the caller starts from a quiet queue. The sentinel file is left in
            // place on purpose: deleting it would emit yet another event.
            drain_for(watcher, Duration::from_millis(150));
            return;
        }
        attempt += 1;
    }
    panic!("watcher never delivered a sentinel event within {DEADLINE:?}");
}

/// [`arm_with`] using a sentinel name unlikely to collide with any filter under test.
pub fn arm(watcher: &Watcher, tree: &Tree) {
    arm_with(watcher, tree, |attempt| {
        format!("retrigger-arm-{attempt}.armed")
    });
}

/// Counter values to measure deltas against.
#[derive(Debug, Clone, Copy)]
pub struct Baseline {
    pub queued: u64,
    pub delivered: u64,
    pub dropped: u64,
}

/// Snapshot the counters.
pub fn baseline(watcher: &Watcher) -> Baseline {
    let stats = watcher.stats();
    Baseline {
        queued: stats.events_queued,
        delivered: stats.events_delivered,
        dropped: stats.events_dropped,
    }
}

/// Counter movement since `baseline`, as `(queued, delivered, dropped)`.
pub fn delta(watcher: &Watcher, baseline: Baseline) -> (u64, u64, u64) {
    let stats = watcher.stats();
    (
        stats.events_queued - baseline.queued,
        stats.events_delivered - baseline.delivered,
        stats.events_dropped - baseline.dropped,
    )
}

/// Wait until `predicate` holds for the watcher's statistics, or `timeout` elapses.
pub fn wait_for_stats(
    watcher: &Watcher,
    timeout: Duration,
    predicate: impl Fn(&WatcherStats) -> bool,
) -> WatcherStats {
    let deadline = Instant::now() + timeout;
    loop {
        let stats = watcher.stats();
        if predicate(&stats) || Instant::now() >= deadline {
            return stats;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// Assert that `events` contains `kind` for `path`, returning the matching event.
#[track_caller]
pub fn expect_event(events: &[FileEvent], path: &Path, kind: EventKind) -> FileEvent {
    events
        .iter()
        .find(|event| event.path == path && event.kind == kind)
        .cloned()
        .unwrap_or_else(|| {
            panic!(
                "expected {kind:?} for {}\nsaw:\n{}",
                path.display(),
                render(events)
            )
        })
}

/// Whether `events` contains `kind` for `path`.
pub fn has_event(events: &[FileEvent], path: &Path, kind: EventKind) -> bool {
    events
        .iter()
        .any(|event| event.path == path && event.kind == kind)
}

/// Whether `events` mentions `path` at all.
pub fn mentions(events: &[FileEvent], path: &Path) -> bool {
    events.iter().any(|event| event.path == path)
}

/// A readable dump of an event stream, for assertion messages.
pub fn render(events: &[FileEvent]) -> String {
    if events.is_empty() {
        return "  <no events>".to_string();
    }
    events.iter().fold(String::new(), |mut out, event| {
        let _ = writeln!(
            out,
            "  {:?} {} (size={}, dir={}, cookie={:?})",
            event.kind,
            event.path.display(),
            event.size,
            event.is_directory,
            event.cookie
        );
        out
    })
}

/// Assert the documented statistics invariant.
#[track_caller]
pub fn assert_stats_invariant(stats: &WatcherStats) {
    assert_eq!(
        stats.events_queued,
        stats.events_delivered + stats.queue_pending as u64,
        "queued must equal delivered + pending: {stats:?}"
    );
}
