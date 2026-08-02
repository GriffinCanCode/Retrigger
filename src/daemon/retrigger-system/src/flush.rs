//! The trailing correction that leading-edge coalescing needs.
//!
//! # The gap this closes
//!
//! [Coalescing](crate::watcher) delivers the first event for a path immediately and drops the
//! repeats behind it. That is the right trade for latency and the wrong one for truth, and the
//! difference shows up whenever a burst *ends* inside the window: the consumer was told the file
//! changed, but the last thing that happened to it was never reported, and nothing further arrives
//! to correct that.
//!
//! An ordinary large save is enough to hit it. The backend fires as soon as the first chunk lands,
//! the consumer is woken and reads — or hashes — a file that is still being written, and the write
//! that completes it arrives a few milliseconds later, inside the window, and is swallowed. The
//! consumer keeps the partial content until something else happens to that path, which for a file
//! saved once may be never.
//!
//! # The fix
//!
//! A path whose window swallowed at least one event owes a [`Modified`](EventKind::Modified),
//! delivered once that window closes. A burst therefore costs two wake-ups instead of one, and the
//! second carries the final state of the file rather than a snapshot of the middle of it.
//!
//! This is *not* trailing-edge debouncing, which the crate root rejects and this module does not
//! reintroduce: the first event is still delivered at once and no change waits on the window to be
//! reported. The window is only ever added to a correction, never to news.
//!
//! The correction is deliberately cheap to ignore. It names a path that the consumer has already
//! been woken for, so a consumer that hashes content — [`FileEventProcessor`](crate::processor),
//! or the Node package's content tracking — drops it for free when the bytes turn out not to have
//! moved since it last looked, and acts on it precisely when they did.
//!
//! # What it costs, and what it does not promise
//!
//! Suppression is what schedules a flush, so a zero [`debounce`](crate::WatcherConfig::debounce)
//! suppresses nothing and this module stays inert.
//!
//! The work list is bounded by [`MAX_PENDING`]. Past that the correction is dropped rather than a
//! rescan raised: saturation means thousands of distinct paths were written in bursts at once —
//! a checkout — and every one of those paths already produced a leading event naming it. Raising
//! [`RescanRequired`](EventKind::RescanRequired) here would turn the most ordinary heavy workload
//! into a full re-read, which is a worse answer than the partial-content window this module exists
//! to narrow. Dropping degrades that path to the behaviour it had before this module existed.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex};
use tracing::trace;

use crate::watcher::Core;

/// Hard ceiling on paths awaiting a correction.
///
/// Matches the delivery ledger's ceiling, because the two fill from the same events: a path can
/// only owe a flush if it is in the ledger.
const MAX_PENDING: usize = 8192;

/// Longest the flusher sleeps with nothing owed.
///
/// Bounds how long [`Flusher::stop`] waits in the worst case. It does not bound flush latency,
/// which comes from each entry's own deadline.
const IDLE_WAIT: Duration = Duration::from_millis(250);

#[derive(Default)]
struct State {
    /// Path to the instant its window closes, which is when the correction is due.
    owed: HashMap<PathBuf, Instant>,
    stopping: bool,
}

/// Work list shared between the backend handler and the flusher thread.
#[derive(Default)]
pub(crate) struct Flusher {
    state: Mutex<State>,
    wake: Condvar,
}

impl Flusher {
    /// Record that `path` had an event suppressed, and that its window closes at `due`.
    ///
    /// Re-owing an already-owed path keeps the earlier deadline: the correction is owed from the
    /// event that was *delivered*, so a file written continuously is corrected once per window
    /// rather than having its correction pushed forever into the future.
    pub(crate) fn owe(&self, path: &Path, due: Instant) {
        let mut state = self.state.lock();
        if state.stopping {
            return;
        }
        let idle = state.owed.is_empty();
        // Looked up rather than `entry`-ed so that the repeat case — the same path suppressed over
        // and over through one burst, which is the common one — costs no `PathBuf` allocation.
        if let Some(existing) = state.owed.get_mut(path) {
            *existing = (*existing).min(due);
        } else if state.owed.len() >= MAX_PENDING {
            trace!(path = %path.display(), "flush list full; correction dropped");
            return;
        } else {
            state.owed.insert(path.to_path_buf(), due);
        }
        drop(state);

        // Only the transition out of idle is worth a wake-up. While the flusher is already sleeping
        // on a deadline, a burst can add thousands of entries per second and waking for each would
        // spend more time scheduling than flushing. The cost is bounded and small: an entry added
        // behind a later deadline waits for it, so a correction can be late by at most one window
        // -- never lost, and still far inside the interval a human would notice.
        if idle {
            self.wake.notify_all();
        }
    }

    /// Ask the flusher thread to finish, abandoning anything owed.
    ///
    /// Corrections are dropped rather than delivered: a stopped watcher has no consumer to tell,
    /// and events queued before the stop stay readable exactly as they were.
    pub(crate) fn stop(&self) {
        let mut state = self.state.lock();
        state.stopping = true;
        state.owed.clear();
        drop(state);
        self.wake.notify_all();
    }

    /// Allow work to be accepted again after a [`stop`](Self::stop), for a restarted watcher.
    pub(crate) fn resume(&self) {
        let mut state = self.state.lock();
        state.stopping = false;
        state.owed.clear();
    }

    /// Number of paths awaiting a correction, for tests and diagnostics.
    #[cfg(test)]
    pub(crate) fn pending_len(&self) -> usize {
        self.state.lock().owed.len()
    }

    /// Take the next path whose window has closed, waiting until one has.
    ///
    /// Returns `None` once [`stop`](Self::stop) has been called.
    fn take_due(&self) -> Option<PathBuf> {
        let mut state = self.state.lock();
        loop {
            if state.stopping {
                return None;
            }
            let now = Instant::now();
            match earliest(&state.owed) {
                Some((path, due)) if due <= now => {
                    state.owed.remove(&path);
                    return Some(path);
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
}

/// The path whose window closes soonest.
fn earliest(owed: &HashMap<PathBuf, Instant>) -> Option<(PathBuf, Instant)> {
    owed.iter()
        .min_by_key(|(_, due)| **due)
        .map(|(path, due)| (path.clone(), *due))
}

/// Body of the flusher thread. Returns when [`Flusher::stop`] is called.
pub(crate) fn run(core: &Core) {
    while let Some(path) = core.flusher().take_due() {
        if !core.is_running() {
            continue;
        }
        core.emit_trailing(&path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn in_ms(millis: u64) -> Instant {
        Instant::now() + Duration::from_millis(millis)
    }

    #[test]
    fn a_path_owed_nothing_yet_is_not_due() {
        let flusher = Flusher::default();
        flusher.owe(Path::new("/x/a.txt"), in_ms(50));
        assert_eq!(flusher.pending_len(), 1);
    }

    #[test]
    fn re_owing_keeps_the_earlier_deadline() {
        // The window runs from the delivered event, so a file written continuously must still be
        // corrected once per window rather than having its deadline pushed out by every write.
        let flusher = Flusher::default();
        let path = Path::new("/x/a.txt");
        let soon = in_ms(10);
        flusher.owe(path, soon);
        flusher.owe(path, in_ms(10_000));
        assert_eq!(flusher.pending_len(), 1);
        assert_eq!(flusher.state.lock().owed[path], soon);
    }

    #[test]
    fn a_due_path_comes_back_once_and_is_then_forgotten() {
        let flusher = Flusher::default();
        let path = Path::new("/x/a.txt");
        flusher.owe(path, Instant::now());
        assert_eq!(flusher.take_due().as_deref(), Some(path));
        assert_eq!(flusher.pending_len(), 0, "taking a path clears the debt");
    }

    #[test]
    fn the_soonest_deadline_is_taken_first() {
        let flusher = Flusher::default();
        let base = Instant::now();
        flusher.owe(Path::new("/x/late.txt"), base + Duration::from_secs(60));
        flusher.owe(Path::new("/x/early.txt"), base);
        assert_eq!(
            flusher.take_due().as_deref(),
            Some(Path::new("/x/early.txt"))
        );
    }

    #[test]
    fn the_work_list_is_bounded() {
        let flusher = Flusher::default();
        let due = Instant::now() + Duration::from_secs(60);
        for i in 0..MAX_PENDING + 100 {
            flusher.owe(Path::new(&format!("/x/{i}.txt")), due);
        }
        assert_eq!(flusher.pending_len(), MAX_PENDING);
    }

    #[test]
    fn a_full_list_still_accepts_a_path_it_already_holds() {
        // Saturation must not strand a path that is still being written; only *new* paths are
        // turned away.
        let flusher = Flusher::default();
        let due = Instant::now() + Duration::from_secs(60);
        for i in 0..MAX_PENDING {
            flusher.owe(Path::new(&format!("/x/{i}.txt")), due);
        }
        let known = format!("/x/{}.txt", MAX_PENDING - 1);
        flusher.owe(Path::new(&known), Instant::now());
        assert_eq!(flusher.pending_len(), MAX_PENDING);
        assert_eq!(flusher.take_due().as_deref(), Some(Path::new(&known)));
    }

    #[test]
    fn stopping_abandons_the_work_list_and_ends_the_thread() {
        let flusher = Flusher::default();
        flusher.owe(Path::new("/x/a.txt"), Instant::now());
        flusher.stop();
        assert_eq!(flusher.pending_len(), 0);
        assert!(flusher.take_due().is_none());
    }

    #[test]
    fn a_stopped_flusher_accepts_nothing_until_it_resumes() {
        let flusher = Flusher::default();
        flusher.stop();
        flusher.owe(Path::new("/x/a.txt"), Instant::now());
        assert_eq!(flusher.pending_len(), 0);

        flusher.resume();
        flusher.owe(Path::new("/x/a.txt"), Instant::now());
        assert_eq!(flusher.pending_len(), 1);
    }
}
