//! Write stabilization ("await write finish"): coalesce a chunked write into one final event.
//!
//! # The gap this closes
//!
//! An editor or build tool that writes a large file in chunks produces one backend event per
//! chunk (or, inside a [`debounce`](crate::WatcherConfig::debounce) window, one plus a trailing
//! correction — see [`crate::flush`]). Both are still *timing*-based: they say "something changed
//! recently", not "the write is finished". A consumer that reads or hashes the file on the first
//! event risks doing it mid-write regardless of how the window is tuned, because no fixed window
//! is guaranteed to outlast every write.
//!
//! [`WatcherConfig::await_write_finish`](crate::WatcherConfig::await_write_finish) answers a
//! different question: not "how recently did this change" but "has it *stopped* changing". A
//! coalescable, non-directory event enters stabilization instead of being delivered, and this
//! module re-`stat`s it on an interval until its size and modification time have held steady for
//! the configured threshold — at which point exactly one [`Modified`](EventKind::Modified) is
//! delivered.
//!
//! # What is never held
//!
//! A removal or rename always cancels stabilization for its path and is delivered immediately,
//! through the ordinary path in [`crate::watcher`]. This is not a special case bolted on for
//! safety; it falls out of only *coalescable* events being diverted here at all
//! ([`EventKind::is_coalescable`] is false for exactly `Deleted`, `RenamedFrom`, and `RenamedTo`).
//! A consumer can therefore never be left waiting on a file that no longer exists under that name.
//!
//! # What it costs, and what it does not promise
//!
//! Structurally the same shape as [`crate::flush`]: a bounded work list
//! ([`MAX_PENDING`]) shared with a dedicated thread, so a saturated list degrades to immediate
//! delivery for new paths rather than growing without bound or raising a rescan for what is, at
//! worst, ordinary heavy write traffic.
//!
//! This module does not itself decide *what* counts as settled beyond size and modification time;
//! a file rewritten with different bytes at the same size and in the same tick as a previous write
//! is not something a `stat`-based scheme can see. Callers who need that guarantee should hash the
//! delivered event's content, exactly as they would for [`crate::flush`]'s correction.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, UNIX_EPOCH};

use parking_lot::{Condvar, Mutex};
use tracing::trace;

use crate::watcher::Core;

/// Hard ceiling on paths being stabilized at once.
///
/// Matches [`crate::flush::MAX_PENDING`] and [`crate::scan::MAX_PENDING_DIRS`]'s reasoning: past
/// this point every new path is delivered immediately rather than tracked, which degrades to the
/// pre-stabilization behaviour for the overflow rather than growing without bound.
const MAX_PENDING: usize = 8192;

/// Longest the stabilizer thread sleeps with nothing tracked.
///
/// Only bounds how long [`Stabilizer::stop`] waits in the worst case; work is picked up by its own
/// `next_poll` deadline, not by this idle tick.
const IDLE_WAIT: Duration = Duration::from_millis(250);

/// A `(size, modification time)` pair cheap enough to compare on every poll.
///
/// Modification time is nanoseconds since the Unix epoch rather than [`std::time::SystemTime`] so
/// two snapshots compare with `==` instead of a fallible [`SystemTime::duration_since`]. `None`
/// when the file system keeps no modification time, which — like [`crate::watcher::Probe`]'s birth
/// time — happens even on volumes this crate otherwise supports; a path with no mtime is judged on
/// size alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Snapshot {
    size: u64,
    mtime_ns: Option<u128>,
}

/// A path currently being watched for stability.
#[derive(Debug, Clone)]
struct Tracked {
    /// What the last poll saw, or `None` before the first one.
    last: Option<Snapshot>,
    /// When `last` was last seen to change.
    stable_since: Instant,
    next_poll: Instant,
}

#[derive(Default)]
struct State {
    tracked: HashMap<PathBuf, Tracked>,
    stopping: bool,
}

/// Work list shared between the backend handler and the stabilizer thread.
#[derive(Default)]
pub(crate) struct Stabilizer {
    state: Mutex<State>,
    wake: Condvar,
}

impl Stabilizer {
    /// Begin (or continue) tracking `path` for write stabilization.
    ///
    /// Returns `false` when the work list is full and a new path could not be admitted; the
    /// caller falls back to delivering the event immediately rather than losing it. An already-
    /// tracked path always succeeds and costs no new slot: the periodic poll observes whatever
    /// changed since the last one without needing to be told again.
    pub(crate) fn track(&self, path: &Path, poll_interval: Duration) -> bool {
        let mut state = self.state.lock();
        if state.stopping {
            return false;
        }
        if state.tracked.contains_key(path) {
            return true;
        }
        if state.tracked.len() >= MAX_PENDING {
            trace!(path = %path.display(), "stabilization list full; delivering immediately");
            return false;
        }
        let now = Instant::now();
        let was_idle = state.tracked.is_empty();
        state.tracked.insert(
            path.to_path_buf(),
            Tracked {
                last: None,
                stable_since: now,
                next_poll: now + poll_interval,
            },
        );
        drop(state);
        if was_idle {
            self.wake.notify_all();
        }
        true
    }

    /// Cancel stabilization for `path`, if it was being tracked.
    ///
    /// Called for a removal or rename, which are delivered through the ordinary path and must
    /// never wait behind — or be followed by — a stale `Modified` for a path that no longer
    /// exists under that name.
    pub(crate) fn cancel(&self, path: &Path) {
        self.state.lock().tracked.remove(path);
    }

    /// Ask the stabilizer thread to finish, abandoning anything tracked.
    ///
    /// Nothing owed here is ever delivered late: a stopped watcher has no consumer to tell, same
    /// as [`crate::flush::Flusher::stop`].
    pub(crate) fn stop(&self) {
        let mut state = self.state.lock();
        state.stopping = true;
        state.tracked.clear();
        drop(state);
        self.wake.notify_all();
    }

    /// Allow work to be accepted again after a [`stop`](Self::stop), for a restarted watcher.
    pub(crate) fn resume(&self) {
        let mut state = self.state.lock();
        state.stopping = false;
        state.tracked.clear();
    }

    /// Number of paths currently being tracked, for tests and diagnostics.
    #[cfg(test)]
    pub(crate) fn pending_len(&self) -> usize {
        self.state.lock().tracked.len()
    }

    /// Take the next path whose poll is due, waiting until one is.
    ///
    /// Returns `None` once [`stop`](Self::stop) has been called.
    fn take_due(&self) -> Option<(PathBuf, Tracked)> {
        let mut state = self.state.lock();
        loop {
            if state.stopping {
                return None;
            }
            let now = Instant::now();
            match earliest(&state.tracked) {
                Some((path, due)) if due <= now => {
                    let tracked = state.tracked.remove(&path)?;
                    return Some((path, tracked));
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

    /// Re-arm `path` for its next poll, unless [`stop`](Self::stop) ran in the meantime.
    fn reinsert(&self, path: PathBuf, tracked: Tracked) {
        let mut state = self.state.lock();
        if state.stopping {
            return;
        }
        state.tracked.insert(path, tracked);
    }
}

/// The path whose next poll is due soonest.
fn earliest(tracked: &HashMap<PathBuf, Tracked>) -> Option<(PathBuf, Instant)> {
    tracked
        .iter()
        .min_by_key(|(_, entry)| entry.next_poll)
        .map(|(path, entry)| (path.clone(), entry.next_poll))
}

/// `stat` the path the same way [`Core`] would, reduced to what stability judges.
fn snapshot(core: &Core, path: &Path) -> Option<Snapshot> {
    let metadata = core.metadata(path).ok()?;
    Some(Snapshot {
        size: metadata.len(),
        mtime_ns: metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|since| since.as_nanos()),
    })
}

/// Body of the stabilizer thread. Returns when [`Stabilizer::stop`] is called.
pub(crate) fn run(core: &Core) {
    while let Some((path, mut tracked)) = core.stabilizer().take_due() {
        if !core.is_running() {
            continue;
        }
        // The config that armed this path may have been read moments ago on a different thread;
        // re-reading it rather than caching it at `track` time means a config that never changes
        // after `start()` costs nothing extra to trust.
        let Some(config) = core.config().await_write_finish else {
            continue;
        };

        match snapshot(core, &path) {
            Some(current) if Some(current) == tracked.last => {
                if tracked.stable_since.elapsed() >= config.stability_threshold {
                    core.emit_stabilized(&path);
                } else {
                    tracked.next_poll = Instant::now() + config.poll_interval;
                    core.stabilizer().reinsert(path, tracked);
                }
            }
            Some(current) => {
                tracked.last = Some(current);
                tracked.stable_since = Instant::now();
                tracked.next_poll = Instant::now() + config.poll_interval;
                core.stabilizer().reinsert(path, tracked);
            }
            None => {
                // Gone without an explicit removal event ever reaching us -- a race this module
                // cannot close, since the whole point of tracking is that no event is expected
                // until stability is reached. Nothing to deliver, and holding it further would
                // wait forever.
                trace!(path = %path.display(), "path vanished during stabilization");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn in_ms(millis: u64) -> Instant {
        Instant::now() + Duration::from_millis(millis)
    }

    #[test]
    fn tracking_a_new_path_costs_one_slot() {
        let stabilizer = Stabilizer::default();
        assert!(stabilizer.track(Path::new("/x/a.txt"), Duration::from_millis(10)));
        assert_eq!(stabilizer.pending_len(), 1);
    }

    #[test]
    fn re_tracking_an_already_tracked_path_costs_nothing_new() {
        let stabilizer = Stabilizer::default();
        let path = Path::new("/x/a.txt");
        assert!(stabilizer.track(path, Duration::from_millis(10)));
        assert!(stabilizer.track(path, Duration::from_millis(10)));
        assert_eq!(stabilizer.pending_len(), 1);
    }

    #[test]
    fn cancelling_an_untracked_path_is_a_no_op() {
        let stabilizer = Stabilizer::default();
        stabilizer.cancel(Path::new("/x/never.txt"));
        assert_eq!(stabilizer.pending_len(), 0);
    }

    #[test]
    fn cancelling_removes_it_from_the_work_list() {
        let stabilizer = Stabilizer::default();
        let path = Path::new("/x/a.txt");
        stabilizer.track(path, Duration::from_millis(10));
        stabilizer.cancel(path);
        assert_eq!(stabilizer.pending_len(), 0);
    }

    #[test]
    fn the_work_list_is_bounded() {
        let stabilizer = Stabilizer::default();
        for i in 0..MAX_PENDING + 100 {
            stabilizer.track(
                &PathBuf::from(format!("/x/{i}.txt")),
                Duration::from_secs(60),
            );
        }
        assert_eq!(stabilizer.pending_len(), MAX_PENDING);
    }

    #[test]
    fn a_full_list_still_accepts_a_path_it_already_holds() {
        let stabilizer = Stabilizer::default();
        for i in 0..MAX_PENDING {
            stabilizer.track(
                &PathBuf::from(format!("/x/{i}.txt")),
                Duration::from_secs(60),
            );
        }
        let known = PathBuf::from(format!("/x/{}.txt", MAX_PENDING - 1));
        assert!(stabilizer.track(&known, Duration::from_secs(60)));
        assert_eq!(stabilizer.pending_len(), MAX_PENDING);
    }

    #[test]
    fn the_soonest_poll_is_taken_first() {
        let stabilizer = Stabilizer::default();
        stabilizer.track(Path::new("/x/late.txt"), Duration::from_secs(60));
        stabilizer.track(Path::new("/x/early.txt"), Duration::ZERO);
        let (taken, _) = stabilizer.take_due().expect("earliest is due");
        assert_eq!(taken, Path::new("/x/early.txt"));
    }

    #[test]
    fn a_taken_path_is_removed_until_reinserted() {
        let stabilizer = Stabilizer::default();
        let path = Path::new("/x/a.txt");
        stabilizer.track(path, Duration::ZERO);
        let (taken, tracked) = stabilizer.take_due().expect("due immediately");
        assert_eq!(stabilizer.pending_len(), 0);
        stabilizer.reinsert(taken, tracked);
        assert_eq!(stabilizer.pending_len(), 1);
    }

    #[test]
    fn stopping_abandons_the_work_list_and_ends_the_thread() {
        let stabilizer = Stabilizer::default();
        stabilizer.track(Path::new("/x/a.txt"), Duration::ZERO);
        stabilizer.stop();
        assert_eq!(stabilizer.pending_len(), 0);
        assert!(stabilizer.take_due().is_none());
    }

    #[test]
    fn a_stopped_stabilizer_accepts_nothing_until_it_resumes() {
        let stabilizer = Stabilizer::default();
        stabilizer.stop();
        assert!(!stabilizer.track(Path::new("/x/a.txt"), Duration::ZERO));
        assert_eq!(stabilizer.pending_len(), 0);

        stabilizer.resume();
        assert!(stabilizer.track(Path::new("/x/a.txt"), Duration::ZERO));
        assert_eq!(stabilizer.pending_len(), 1);
    }

    #[test]
    fn reinsert_after_stop_is_dropped_rather_than_resurrected() {
        let stabilizer = Stabilizer::default();
        let path = Path::new("/x/a.txt");
        stabilizer.track(path, Duration::ZERO);
        let (taken, tracked) = stabilizer.take_due().expect("due immediately");
        stabilizer.stop();
        stabilizer.reinsert(taken, tracked);
        assert_eq!(stabilizer.pending_len(), 0);
    }

    /// Sanity on the `due` ordering helper itself, independent of the lock/thread plumbing above.
    #[test]
    fn earliest_picks_the_smallest_deadline() {
        let mut tracked = HashMap::new();
        tracked.insert(
            PathBuf::from("/late"),
            Tracked {
                last: None,
                stable_since: Instant::now(),
                next_poll: in_ms(1000),
            },
        );
        tracked.insert(
            PathBuf::from("/early"),
            Tracked {
                last: None,
                stable_since: Instant::now(),
                next_poll: in_ms(1),
            },
        );
        let (path, _) = earliest(&tracked).expect("non-empty");
        assert_eq!(path, PathBuf::from("/early"));
    }
}
