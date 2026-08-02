//! Reconciliation of directories that appear inside a recursive watch.
//!
//! # The gap this closes
//!
//! inotify watches a *directory*, not a tree. A recursive watch is therefore a set of per-directory
//! descriptors, and a directory that appears after the watch was installed only joins that set once
//! the backend has seen and processed the `IN_CREATE` for it. Anything written inside it before
//! that happens is reported to nobody: the kernel had no descriptor to report it against.
//!
//! The window is not theoretical and it is not narrow in the ways that matter. `notify` dispatches
//! a batch of events to the handler *first* and installs the deferred watches only once the batch
//! has drained ([`notify::inotify`], `handle_inotify`), so the window spans at least one full batch.
//! `mkdir -p dist && write dist/bundle.js` — an ordinary build step, `npm install`, `git checkout`,
//! any archive extraction — writes squarely inside it.
//!
//! # The fix
//!
//! When a directory is created (or moved) into a recursive watch, it is registered here. A
//! dedicated thread then *reads* it and synthesizes [`Created`](EventKind::Created) events for
//! entries that already exist, descending into subdirectories it finds the same way — they have the
//! identical problem one level down. An entry therefore either produced a real kernel event or gets
//! a synthesized one.
//!
//! Scanning happens on this thread rather than inline in the backend handler so that a large
//! directory cannot stall event dispatch — a stalled handler is how an inotify queue overflows,
//! which would trade one loss for another.
//!
//! # Why more than one pass
//!
//! A single pass cannot be sufficient, and it is worth being precise about why. Let `t_arm` be the
//! moment the backend installs the descriptor. Entries created before `t_arm` are visible to any
//! read after they were created; entries created after it produce real events. A pass that runs
//! before `t_arm` therefore cannot see writes that land between the pass and `t_arm`. `t_arm` is
//! not observable from outside `notify`, so this module reads the directory several times over a
//! short, bounded tail ([`PASS_SCHEDULE`]) instead of guessing once. Repeat passes are cheap — one
//! `readdir` — and the delivery ledger makes them silent.
//!
//! This is a bound, not a proof. A backend that took longer than the tail to install a descriptor
//! would still lose an entry created in the remainder. The honest alternative would be to force the
//! descriptor open ourselves by re-watching the directory, which does yield a proof — and is not
//! done here because on `FSEvents` it would open a second recursive stream over the same subtree
//! and duplicate every subsequent event in it.
//!
//! # Bounds
//!
//! Unbounded work is its own outage. A tree moved wholesale into the watch root can be enormous,
//! so a scan is capped at [`MAX_SCAN_ENTRIES`] entries and [`MAX_SCAN_DEPTH`] levels, and at most
//! [`MAX_PENDING_DIRS`] directories are tracked at once. Exceeding any of them raises
//! [`RescanRequired`](EventKind::RescanRequired) — the one situation where a rescan is the honest
//! answer rather than a shrug, because the alternative is synthesizing tens of thousands of events
//! the consumer would rather satisfy with one directory walk of its own.
//!
//! [`notify::inotify`]: https://docs.rs/notify/latest/notify/struct.INotifyWatcher.html

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex};
use tracing::{debug, trace, warn};

use crate::event::EventKind;
use crate::watcher::Core;

/// Entries a single reconciliation may report before it gives up and asks for a rescan.
///
/// Sized so an ordinary `npm install` package directory or build output directory is covered
/// outright, while a wholesale tree move is recognised as the rescan-shaped event it is.
pub(crate) const MAX_SCAN_ENTRIES: usize = 4096;

/// Directory levels a single reconciliation may descend.
///
/// Guards against pathological depth; symbolic links are never followed, so this is not the loop
/// defence — that is structural.
pub(crate) const MAX_SCAN_DEPTH: usize = 32;

/// Directories that may be awaiting reconciliation at once.
pub(crate) const MAX_PENDING_DIRS: usize = 1024;

/// Delays, measured from the directory's creation event, at which it is read.
///
/// The first pass is immediate: a file already sitting in the directory should reach the consumer
/// without waiting on a timer. The later passes exist only to outlast the backend installing its
/// descriptor, and are silent unless they find something the earlier passes did not.
pub(crate) const PASS_SCHEDULE: &[Duration] = &[
    Duration::ZERO,
    Duration::from_millis(40),
    Duration::from_millis(160),
    Duration::from_millis(480),
];

/// How long the reconciler sleeps when nothing is pending.
///
/// Only bounds how long `stop` waits in the worst case; work arrives by notification, not by poll.
const IDLE_WAIT: Duration = Duration::from_millis(250);

/// A directory awaiting its next read.
#[derive(Debug, Clone, Copy)]
struct Pending {
    due: Instant,
    /// Index into [`PASS_SCHEDULE`] of the pass that is due.
    pass: usize,
}

#[derive(Default)]
struct State {
    pending: HashMap<PathBuf, Pending>,
    stopping: bool,
}

/// Work list shared between the backend handler and the reconciler thread.
#[derive(Default)]
pub(crate) struct Reconciler {
    state: Mutex<State>,
    wake: Condvar,
}

impl Reconciler {
    /// Register a directory that has just joined a recursive watch.
    ///
    /// Returns `false` when the work list is full, which the caller turns into a rescan: too many
    /// unreconciled directories means the tree is changing faster than it can be described.
    pub(crate) fn note(&self, directory: &Path) -> bool {
        let mut state = self.state.lock();
        if state.stopping {
            return true;
        }
        if !state.pending.contains_key(directory) && state.pending.len() >= MAX_PENDING_DIRS {
            return false;
        }
        // Re-noting an already-pending directory restarts its schedule rather than adding a second
        // entry, so a directory touched repeatedly costs one slot.
        state.pending.insert(
            directory.to_path_buf(),
            Pending {
                due: Instant::now(),
                pass: 0,
            },
        );
        drop(state);
        self.wake.notify_all();
        true
    }

    /// Ask the reconciler thread to finish.
    pub(crate) fn stop(&self) {
        let mut state = self.state.lock();
        state.stopping = true;
        state.pending.clear();
        drop(state);
        self.wake.notify_all();
    }

    /// Allow work to be accepted again after a [`stop`](Self::stop), for a restarted watcher.
    pub(crate) fn resume(&self) {
        let mut state = self.state.lock();
        state.stopping = false;
        state.pending.clear();
    }

    /// Number of directories awaiting reconciliation, for tests and diagnostics.
    #[cfg(test)]
    pub(crate) fn pending_len(&self) -> usize {
        self.state.lock().pending.len()
    }

    /// Take the next directory whose pass is due, waiting until one is.
    ///
    /// Returns `None` once [`stop`](Self::stop) has been called.
    fn take_due(&self) -> Option<(PathBuf, Pending)> {
        let mut state = self.state.lock();
        loop {
            if state.stopping {
                return None;
            }
            let now = Instant::now();
            match earliest(&state.pending) {
                Some((path, due)) if due <= now => {
                    let pending = state.pending.remove(&path)?;
                    return Some((path, pending));
                }
                Some((_, due)) => {
                    self.wake
                        .wait_for(&mut state, due.saturating_duration_since(now));
                }
                None => {
                    self.wake.wait_for(&mut state, IDLE_WAIT);
                }
            }
        }
    }

    /// Schedule the next pass for a directory, if it has one left.
    fn reschedule(&self, directory: PathBuf, pass: usize) {
        let Some(delay) = PASS_SCHEDULE.get(pass) else {
            return;
        };
        let mut state = self.state.lock();
        if state.stopping {
            return;
        }
        // A directory already in the list was re-noted by a fresh event while this pass ran; that
        // schedule is newer, so leave it alone.
        state.pending.entry(directory).or_insert(Pending {
            due: Instant::now() + *delay,
            pass,
        });
        drop(state);
        self.wake.notify_all();
    }
}

/// The directory whose pass is due soonest.
fn earliest(pending: &HashMap<PathBuf, Pending>) -> Option<(PathBuf, Instant)> {
    pending
        .iter()
        .min_by_key(|(_, entry)| entry.due)
        .map(|(path, entry)| (path.clone(), entry.due))
}

/// Body of the reconciler thread. Returns when [`Reconciler::stop`] is called.
pub(crate) fn run(core: &Core) {
    while let Some((directory, pending)) = core.reconciler().take_due() {
        // A watcher that is stopping has no consumer to tell, and a directory that no longer
        // exists has nothing to report.
        if !core.is_running() {
            continue;
        }
        match reconcile(core, &directory, MAX_SCAN_ENTRIES) {
            Outcome::Complete => core
                .reconciler()
                .reschedule(directory, pending.pass.saturating_add(1)),
            Outcome::Abandoned { seen } => {
                warn!(
                    directory = %directory.display(),
                    entries = seen,
                    "directory too large to reconcile; requesting rescan"
                );
                core.signal_rescan();
            }
            Outcome::Vanished => {
                trace!(directory = %directory.display(), "directory gone before reconciliation");
            }
        }
    }
}

/// How a single reconciliation ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Outcome {
    /// The whole subtree was read within budget.
    Complete,
    /// The budget ran out; the consumer needs to re-read the tree itself.
    Abandoned { seen: usize },
    /// The directory no longer exists, or could not be read at all.
    Vanished,
}

/// Read `directory` and synthesize events for what is already in it.
///
/// `budget` caps the number of entries examined across the whole descent. Symbolic links are
/// reported but never descended into: a link cannot be distinguished from the tree it points at
/// without risking a cycle, and the backend will report changes through the real path anyway.
pub(crate) fn reconcile(core: &Core, directory: &Path, budget: usize) -> Outcome {
    let mut stack = vec![(directory.to_path_buf(), 0_usize)];
    let mut seen = 0_usize;
    let mut read_anything = false;

    while let Some((dir, depth)) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(err) => {
                // A directory that vanished mid-scan is normal during churn; anything else is
                // worth a line, but neither is fatal to the rest of the walk.
                trace!(directory = %dir.display(), error = %err, "cannot read directory");
                continue;
            }
        };
        read_anything = true;

        for entry in entries {
            let Ok(entry) = entry else { continue };
            seen += 1;
            if seen > budget {
                return Outcome::Abandoned { seen };
            }

            let path = entry.path();
            // `file_type` comes from the directory entry where the platform provides it, so this
            // is usually free, and it never follows a link.
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let is_directory = file_type.is_dir();

            let size = if is_directory {
                0
            } else {
                entry.metadata().map_or(0, |metadata| metadata.len())
            };
            core.emit_synthesized(&path, EventKind::Created, size, is_directory);

            if is_directory && !file_type.is_symlink() {
                if depth + 1 > MAX_SCAN_DEPTH {
                    debug!(
                        directory = %path.display(),
                        "reconciliation depth limit reached; requesting rescan"
                    );
                    return Outcome::Abandoned { seen };
                }
                if subtree_excluded(&core.config().filter, &path) {
                    trace!(directory = %path.display(), "excluded subtree not reconciled");
                    continue;
                }
                stack.push((path, depth + 1));
            }
        }
    }

    if read_anything {
        Outcome::Complete
    } else {
        Outcome::Vanished
    }
}

/// Whether descending into `directory` could produce anything the filter would let through.
///
/// The obvious test — is the directory itself excluded — is not the useful one. `**/node_modules/**`
/// deliberately does not match `node_modules` itself, only what is inside it, so asking about the
/// directory says "descend", and a vendor tree the caller explicitly disowned gets read in full to
/// emit nothing — spending the entry budget and then raising a rescan for it.
///
/// So the question asked is the one actually being decided: *is everything directly inside this
/// excluded?* It is answered by probing two names chosen to be dissimilar, because a pattern that
/// excludes both is broad enough to mean the subtree, while one that happens to match a single
/// shape (`**/?`, say) is not. Two probes rather than one is what keeps a narrow pattern from
/// pruning a subtree it never described.
///
/// Being wrong in the conservative direction — descend, then filter each entry individually — costs
/// a wasted directory read and nothing else, which is why a heuristic is acceptable here at all.
fn subtree_excluded(filter: &crate::filter::EventFilter, directory: &Path) -> bool {
    if filter.excludes(directory) {
        return true;
    }
    // Neither probe carries an extension, so a common `**/*.tmp`-style rule cannot make one of
    // them agree by accident.
    ["x", "retrigger-probe"]
        .iter()
        .all(|probe| filter.excludes(&directory.join(probe)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::WatcherConfig;
    use crate::filter::EventFilter;
    use crate::watcher::Watcher;

    /// A watcher whose queue is readable but whose backend is never started, so the only events in
    /// it are the ones a scan puts there.
    fn harness(config: WatcherConfig) -> Watcher {
        let watcher = Watcher::new(config).expect("create watcher");
        watcher.force_running_for_test();
        watcher
    }

    fn config() -> WatcherConfig {
        WatcherConfig {
            debounce: Duration::ZERO,
            capacity: 8192,
            ..Default::default()
        }
    }

    fn paths(watcher: &Watcher) -> Vec<PathBuf> {
        let mut out = Vec::new();
        while let Some(event) = watcher.poll() {
            out.push(event.path);
        }
        out.sort();
        out
    }

    #[test]
    fn a_flat_directory_is_reported_entry_by_entry() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path().canonicalize().expect("canonicalize");
        for name in ["a.txt", "b.txt", "c.txt"] {
            fs::write(root.join(name), b"x").expect("write");
        }

        let watcher = harness(config());
        watcher.watch(&root, true).expect("watch");
        assert_eq!(
            reconcile(watcher.core_for_test(), &root, 64),
            Outcome::Complete
        );

        assert_eq!(
            paths(&watcher),
            vec![root.join("a.txt"), root.join("b.txt"), root.join("c.txt")]
        );
    }

    #[test]
    fn nested_directories_are_descended_into() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path().canonicalize().expect("canonicalize");
        fs::create_dir_all(root.join("a/b/c")).expect("mkdir");
        fs::write(root.join("a/b/c/deep.txt"), b"x").expect("write");

        let watcher = harness(config());
        watcher.watch(&root, true).expect("watch");
        assert_eq!(
            reconcile(watcher.core_for_test(), &root, 64),
            Outcome::Complete
        );

        let seen = paths(&watcher);
        assert!(
            seen.contains(&root.join("a/b/c/deep.txt")),
            "the deepest file must be reported: {seen:?}"
        );
        assert!(seen.contains(&root.join("a")), "and so must each directory");
    }

    #[test]
    fn the_entry_budget_abandons_rather_than_grinding() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path().canonicalize().expect("canonicalize");
        for i in 0..50 {
            fs::write(root.join(format!("f{i}.txt")), b"x").expect("write");
        }

        let watcher = harness(config());
        watcher.watch(&root, true).expect("watch");
        match reconcile(watcher.core_for_test(), &root, 10) {
            Outcome::Abandoned { seen } => assert!(seen > 10, "budget overrun should be reported"),
            other => panic!("expected the budget to abandon the scan, got {other:?}"),
        }
        assert!(
            paths(&watcher).len() <= 11,
            "an abandoned scan must stop emitting"
        );
    }

    #[test]
    fn an_excluded_subtree_is_not_descended_into() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path().canonicalize().expect("canonicalize");
        fs::create_dir_all(root.join("node_modules/react")).expect("mkdir");
        fs::write(root.join("node_modules/react/index.js"), b"x").expect("write");
        fs::write(root.join("app.js"), b"x").expect("write");

        let watcher = harness(WatcherConfig {
            filter: EventFilter::dev_defaults().expect("built-in patterns"),
            ..config()
        });
        watcher.watch(&root, true).expect("watch");
        assert_eq!(
            reconcile(watcher.core_for_test(), &root, 64),
            Outcome::Complete
        );

        let seen = paths(&watcher);
        assert!(seen.contains(&root.join("app.js")));
        assert!(
            !seen.contains(&root.join("node_modules/react/index.js")),
            "nothing inside an excluded subtree may be reported: {seen:?}"
        );
        // `**/node_modules/**` does not name `node_modules` itself, so the directory is legitimately
        // reportable; what must not happen is the walk going inside it.
        assert!(
            !seen.contains(&root.join("node_modules/react")),
            "the excluded subtree must not be descended into: {seen:?}"
        );
    }

    #[test]
    fn subtree_pruning_needs_a_pattern_that_means_the_subtree() {
        let dir = Path::new("/p/node_modules");

        let vendor = EventFilter::new()
            .exclude_glob("**/node_modules/**")
            .expect("valid glob");
        assert!(
            subtree_excluded(&vendor, dir),
            "a rule covering everything inside is a rule about the subtree"
        );

        let named = EventFilter::new()
            .exclude_glob("**/node_modules")
            .expect("valid glob");
        assert!(
            subtree_excluded(&named, dir),
            "naming it directly counts too"
        );

        let by_extension = EventFilter::new()
            .exclude_glob("**/*.log")
            .expect("valid glob");
        assert!(
            !subtree_excluded(&by_extension, dir),
            "a rule about some files must not hide a whole directory"
        );

        let single_character = EventFilter::new().exclude_glob("**/?").expect("valid glob");
        assert!(
            !subtree_excluded(&single_character, dir),
            "a rule that happens to match one probe shape is not a rule about the subtree"
        );

        assert!(
            !subtree_excluded(&EventFilter::new(), dir),
            "an empty filter excludes nothing"
        );
    }

    #[test]
    fn include_globs_do_not_prune_directories() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path().canonicalize().expect("canonicalize");
        fs::create_dir_all(root.join("src/deep")).expect("mkdir");
        fs::write(root.join("src/deep/lib.rs"), b"x").expect("write");
        fs::write(root.join("src/deep/notes.md"), b"x").expect("write");

        let watcher = harness(WatcherConfig {
            filter: EventFilter::new()
                .include_glob("**/*.rs")
                .expect("valid glob"),
            ..config()
        });
        watcher.watch(&root, true).expect("watch");
        assert_eq!(
            reconcile(watcher.core_for_test(), &root, 64),
            Outcome::Complete
        );

        let seen = paths(&watcher);
        assert_eq!(
            seen,
            vec![root.join("src/deep/lib.rs")],
            "includes select files without hiding the directories holding them"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_directory_is_reported_but_not_followed() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path().canonicalize().expect("canonicalize");
        fs::create_dir_all(root.join("real")).expect("mkdir");
        fs::write(root.join("real/inside.txt"), b"x").expect("write");
        // A link back to the root would be an infinite descent if links were followed.
        std::os::unix::fs::symlink(&root, root.join("loop")).expect("symlink");

        let watcher = harness(config());
        watcher.watch(&root, true).expect("watch");
        assert_eq!(
            reconcile(watcher.core_for_test(), &root, 4096),
            Outcome::Complete
        );

        let seen = paths(&watcher);
        let link = root.join("loop");
        assert!(seen.contains(&link), "the link itself is news");
        assert!(
            !seen
                .iter()
                .any(|path| *path != link && path.starts_with(&link)),
            "but nothing may be reported through it: {seen:?}"
        );
    }

    #[test]
    fn a_missing_directory_is_not_an_error() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path().canonicalize().expect("canonicalize");
        let watcher = harness(config());
        watcher.watch(&root, true).expect("watch");

        assert_eq!(
            reconcile(watcher.core_for_test(), &root.join("gone"), 64),
            Outcome::Vanished
        );
        assert!(paths(&watcher).is_empty());
    }

    #[test]
    fn out_of_scope_entries_are_not_reported() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path().canonicalize().expect("canonicalize");
        fs::create_dir_all(root.join("watched")).expect("mkdir");
        fs::write(root.join("watched/in.txt"), b"x").expect("write");
        fs::write(root.join("out.txt"), b"x").expect("write");

        let in_scope = root.join("watched");
        let watcher = harness(config());
        watcher.watch(&in_scope, true).expect("watch");
        assert_eq!(
            reconcile(watcher.core_for_test(), &root, 64),
            Outcome::Complete
        );

        let seen = paths(&watcher);
        assert!(seen.contains(&in_scope.join("in.txt")));
        assert!(
            !seen.contains(&root.join("out.txt")),
            "a scan may not smuggle in paths nobody asked to watch: {seen:?}"
        );
    }

    #[test]
    fn the_work_list_is_bounded() {
        let reconciler = Reconciler::default();
        for i in 0..MAX_PENDING_DIRS {
            assert!(reconciler.note(Path::new(&format!("/nowhere/{i}"))));
        }
        assert_eq!(reconciler.pending_len(), MAX_PENDING_DIRS);
        assert!(
            !reconciler.note(Path::new("/nowhere/one-too-many")),
            "the work list must refuse work rather than grow without limit"
        );
        // An already-tracked directory is still accepted: it costs no new slot.
        assert!(reconciler.note(Path::new("/nowhere/0")));
        assert_eq!(reconciler.pending_len(), MAX_PENDING_DIRS);
    }

    #[test]
    fn stopping_clears_the_work_list_and_resume_reopens_it() {
        let reconciler = Reconciler::default();
        assert!(reconciler.note(Path::new("/nowhere/a")));
        reconciler.stop();
        assert_eq!(reconciler.pending_len(), 0);
        // Notes after `stop` are accepted-but-discarded, so a racing handler never sees a failure
        // it would translate into a spurious rescan.
        assert!(reconciler.note(Path::new("/nowhere/b")));
        assert_eq!(reconciler.pending_len(), 0);
        reconciler.resume();
        assert!(reconciler.note(Path::new("/nowhere/c")));
        assert_eq!(reconciler.pending_len(), 1);
    }

    #[test]
    fn passes_are_scheduled_in_order_and_then_retired() {
        let reconciler = Reconciler::default();
        let path = Path::new("/nowhere/scheduled");
        assert!(reconciler.note(path));

        let (taken, pending) = reconciler
            .take_due()
            .expect("first pass is immediately due");
        assert_eq!(taken, path);
        assert_eq!(pending.pass, 0);

        for pass in 1..PASS_SCHEDULE.len() {
            reconciler.reschedule(path.to_path_buf(), pass);
            assert_eq!(reconciler.pending_len(), 1, "pass {pass} should be pending");
            let (_, pending) = reconciler.take_due().expect("scheduled pass");
            assert_eq!(pending.pass, pass);
        }

        reconciler.reschedule(path.to_path_buf(), PASS_SCHEDULE.len());
        assert_eq!(
            reconciler.pending_len(),
            0,
            "the tail is finite: a directory must eventually be retired"
        );
    }

    #[test]
    fn take_due_returns_none_once_stopped() {
        let reconciler = Reconciler::default();
        reconciler.stop();
        assert!(reconciler.take_due().is_none());
    }
}
