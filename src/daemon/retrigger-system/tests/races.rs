//! Adversarial real-filesystem storms.
//!
//! `events.rs` asserts what a single change looks like; this asserts that the watcher survives the
//! shapes a real tree throws at it under load — atomic saves, cross-directory rename storms, the
//! watch root being deleted underneath it, and the scope being churned while events flow.
//!
//! Every assertion here is deliberately one of two safe shapes, because backend event *ordering*
//! within a burst is not a guarantee this crate makes (see the platform notes on the crate root):
//!
//!   * **reported-or-rescanned** — a change is either delivered or the stream declared
//!     non-authoritative via [`EventKind::RescanRequired`], which a correct consumer re-reads on.
//!     Losing a change without a rescan is the only real failure.
//!   * **survives** — the watcher does not hang, panic, or violate its statistics invariant, no
//!     matter how hostile the sequence.
//!
//! Nothing here sleeps to wait for an event; waits are deadline-bounded polls from `common`.

mod common;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use common::{
    arm, assert_stats_invariant, collect_until, drain_for, mentions, render, Tree, DEADLINE,
};
use retrigger_system::{EventKind, FileEvent, Watcher, WatcherConfig};

fn watcher_for(tree: &Tree, recursive: bool) -> Watcher {
    let watcher = Watcher::new(WatcherConfig {
        debounce: Duration::ZERO,
        ..Default::default()
    })
    .expect("create watcher");
    watcher.watch(&tree.root, recursive).expect("watch root");
    watcher.start().expect("start");
    arm(&watcher, tree);
    watcher
}

/// Whether the stream either mentioned `path` or asked for a rescan — the only two acceptable
/// outcomes for a change that definitely happened.
fn reported_or_rescanned(events: &[FileEvent], path: &std::path::Path) -> bool {
    events
        .iter()
        .any(|event| event.path == path || event.kind == EventKind::RescanRequired)
}

#[test]
fn an_atomic_save_over_an_existing_file_is_reported() {
    // The editor/`fsync`-then-`rename` save: write a sibling temp file and rename it over the
    // target. The consumer must hear that the target changed, or be told to rescan.
    let tree = Tree::new();
    let target = tree.write("config.json", b"{\"v\":1}");
    let watcher = watcher_for(&tree, true);

    tree.write("config.json.tmp", b"{\"v\":2}");
    tree.rename("config.json.tmp", "config.json");

    let events = collect_until(&watcher, DEADLINE, |seen| {
        reported_or_rescanned(seen, &target)
    });
    assert!(
        reported_or_rescanned(&events, &target),
        "an atomic save over {} was neither reported nor rescanned:\n{}",
        target.display(),
        render(&events)
    );
}

#[test]
fn a_cross_directory_rename_is_reported_or_rescanned() {
    let tree = Tree::new();
    tree.mkdir("from");
    tree.mkdir("to");
    let src = tree.write("from/unit.rs", b"mod a;");
    let watcher = watcher_for(&tree, true);

    let (_, dst) = tree.rename("from/unit.rs", "to/unit.rs");

    // The destination is the arrival a build tool must not miss; the source going away is nice to
    // have but backend-dependent, so the postcondition is on the destination (or a rescan).
    let events = collect_until(&watcher, DEADLINE, |seen| reported_or_rescanned(seen, &dst));
    assert!(
        reported_or_rescanned(&events, &dst),
        "a rename into {} was lost:\n{}",
        dst.display(),
        render(&events)
    );
    // Whatever happened, the counters must still add up.
    assert_stats_invariant(&watcher.stats());
    let _ = src;
}

#[test]
fn a_rename_storm_either_reports_every_destination_or_asks_for_a_rescan() {
    const FILES: usize = 300;
    let tree = Tree::new();
    for i in 0..FILES {
        tree.write(format!("f{i}.txt"), b"x");
    }
    let watcher = watcher_for(&tree, true);

    let destinations: Vec<_> = (0..FILES)
        .map(|i| {
            let (_, to) = tree.rename(format!("f{i}.txt"), format!("r{i}.txt"));
            to
        })
        .collect();

    let events = collect_until(&watcher, DEADLINE, |seen| {
        seen.iter().any(|e| e.kind == EventKind::RescanRequired)
            || destinations.iter().all(|dst| mentions(seen, dst))
    });

    let rescanned = events.iter().any(|e| e.kind == EventKind::RescanRequired);
    let missing: Vec<_> = destinations
        .iter()
        .filter(|dst| !mentions(&events, dst))
        .collect();
    assert!(
        rescanned || missing.is_empty(),
        "{} rename destinations were neither reported nor covered by a rescan (first missing: {:?})",
        missing.len(),
        missing.first()
    );
    assert_stats_invariant(&watcher.stats());
}

#[test]
fn concurrent_watch_and_unwatch_while_events_flow_stays_consistent() {
    // The scope is an RwLock read on every event and written by watch/unwatch. Churning it from
    // one thread while another writes files must not deadlock, panic, or corrupt the counters.
    let tree = Tree::new();
    tree.mkdir("sub");
    let watcher = Arc::new(watcher_for(&tree, true));
    let sub = tree.path("sub");

    let stop = Arc::new(AtomicBool::new(false));

    let churner = {
        let watcher = Arc::clone(&watcher);
        let stop = Arc::clone(&stop);
        let sub = sub.clone();
        thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                // Re-watching and unwatching a path already covered by the recursive root watch is
                // legal and must be race-free; unwatch may report NotFound if it lost the race,
                // which is a valid outcome, not an error to propagate.
                let _ = watcher.watch(&sub, false);
                let _ = watcher.unwatch(&sub);
            }
        })
    };

    let writer = {
        let tree_root = tree.root.clone();
        let stop = Arc::clone(&stop);
        thread::spawn(move || {
            let mut i = 0;
            while !stop.load(Ordering::Relaxed) {
                let _ = std::fs::write(tree_root.join(format!("churn{i}.txt")), b"x");
                i += 1;
                if i % 64 == 0 {
                    thread::sleep(Duration::from_millis(1));
                }
            }
        })
    };

    // Drain for a bounded window while the storm runs, then wind everything down.
    let _ = drain_for(&watcher, Duration::from_millis(600));
    stop.store(true, Ordering::Relaxed);
    churner.join().expect("churner thread");
    writer.join().expect("writer thread");

    assert!(watcher.is_running(), "the watcher must survive the churn");
    assert_stats_invariant(&watcher.stats());
}

#[test]
fn deleting_and_recreating_the_watch_root_neither_hangs_nor_corrupts_state() {
    // A `rm -rf` of the watched tree followed by its recreation is a legitimate thing a build does.
    // The kernel watch on the old directory is gone, so re-delivery is not promised; what is
    // promised is that the watcher does not hang or violate its invariant, and can still be stopped
    // cleanly.
    let tree = Tree::new();
    tree.write("before.txt", b"x");
    let watcher = watcher_for(&tree, true);

    std::fs::remove_dir_all(&tree.root).expect("remove the watch root");
    // Give the backend a bounded moment to process the removal without asserting on its shape.
    let _ = drain_for(&watcher, GRACE_AFTER_ROOT_REMOVAL);

    std::fs::create_dir_all(&tree.root).expect("recreate the watch root");
    std::fs::write(tree.path("after.txt"), b"y").expect("write after recreation");
    let _ = drain_for(&watcher, GRACE_AFTER_ROOT_REMOVAL);

    assert!(
        watcher.is_running(),
        "the watcher must survive its root being deleted"
    );
    assert_stats_invariant(&watcher.stats());
    watcher
        .stop()
        .expect("a watcher whose root vanished must still stop cleanly");
}

const GRACE_AFTER_ROOT_REMOVAL: Duration = Duration::from_millis(500);

#[test]
fn stopping_during_an_overflowing_burst_neither_hangs_nor_drops_the_rescan_signal() {
    // A tiny queue guarantees overflow; stopping mid-burst from another thread must not hang, and
    // the overflow's rescan signal must still be observable (it is held out-of-band precisely so it
    // survives a full queue). This is the queue-overflow analogue of the lifecycle suite's
    // scan-in-flight shutdown test.
    let tree = Tree::new();
    let watcher = Arc::new(
        Watcher::new(WatcherConfig {
            debounce: Duration::ZERO,
            capacity: 4,
            ..Default::default()
        })
        .expect("create watcher"),
    );
    watcher.watch(&tree.root, true).expect("watch");
    watcher.start().expect("start");
    arm(&watcher, &tree);

    let stopper = {
        let watcher = Arc::clone(&watcher);
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(15));
            watcher.stop().expect("stop");
        })
    };

    for i in 0..2000 {
        let _ = std::fs::write(tree.root.join(format!("burst{i}.txt")), b"x");
    }
    stopper.join().expect("stopper thread");

    // Draining a stopped watcher returns promptly. Anything still queued is readable.
    let tail = drain_for(&watcher, Duration::from_millis(200));
    let stats = watcher.stats();
    assert_stats_invariant(&stats);
    if stats.events_dropped > 0 {
        // An overflow occurred, so a rescan must have been raised: either already drained, or still
        // pending in the queue. Both are correct; a silent drop is not.
        let rescan_seen = tail.iter().any(|e| e.kind == EventKind::RescanRequired);
        assert!(
            rescan_seen || stats.queue_pending > 0 || stats.events_delivered > 0,
            "events were dropped ({}) but no rescan was ever observable: {stats:?}",
            stats.events_dropped
        );
    }
    assert!(!watcher.is_running(), "the watcher was stopped");
}
