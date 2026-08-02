//! Queue bounding, filtering, coalescing, and concurrency.

mod common;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

use common::{
    arm, arm_with, collect_until, expect_event, has_event, render, wait_for, wait_for_stats, Tree,
    DEADLINE, GRACE,
};
use retrigger_system::{EventFilter, EventKind, Watcher, WatcherConfig};

fn watcher_with(tree: &Tree, config: WatcherConfig) -> Watcher {
    let watcher = Watcher::new(config).expect("create watcher");
    watcher.watch(&tree.root, true).expect("watch root");
    watcher.start().expect("start");
    watcher
}

#[test]
fn a_full_queue_drops_events_and_asks_for_a_rescan() {
    let tree = Tree::new();
    let watcher = watcher_with(
        &tree,
        WatcherConfig {
            capacity: 4,
            debounce: Duration::ZERO,
            ..Default::default()
        },
    );
    arm(&watcher, &tree);
    let _ = common::drain_for(&watcher, Duration::from_millis(100));

    // Deliberately never poll while producing: the queue must bound itself.
    for i in 0..200 {
        tree.write(format!("flood-{i}.txt"), b"x");
    }

    let stats = wait_for_stats(&watcher, DEADLINE, |stats| stats.events_dropped > 0);
    assert!(
        stats.events_dropped > 0,
        "a 4-slot queue fed 200 creations must drop something: {stats:?}"
    );
    assert!(
        stats.queue_pending <= stats.queue_capacity + 1,
        "queue exceeded its bound: {stats:?}"
    );
    common::assert_stats_invariant(&stats);

    // Detach the backend so nothing refills the queue mid-assertion; what remains is exactly what
    // the bound allowed to accumulate.
    watcher.stop().expect("stop");
    let quiesced = watcher.stats();
    assert!(
        quiesced.queue_pending <= quiesced.queue_capacity + 1,
        "queue exceeded its bound: {quiesced:?}"
    );

    // The rescan signal is the consumer's route back to correctness, and it is delivered ahead of
    // the stale events still sitting in the ring.
    let first = watcher.poll().expect("something is queued");
    assert_eq!(
        first.kind,
        EventKind::RescanRequired,
        "the overflow signal must be delivered first, not buried behind stale events"
    );
    assert!(first.path.as_os_str().is_empty());

    let drained = common::drain_for(&watcher, Duration::from_millis(100));
    assert_eq!(
        drained.len() + 1,
        quiesced.queue_pending,
        "draining a stopped watcher must yield exactly what was pending\n{}",
        render(&drained)
    );
    let after = watcher.stats();
    assert_eq!(after.queue_pending, 0);
    common::assert_stats_invariant(&after);
}

#[test]
fn overflow_is_reported_to_subscribers_as_well() {
    let tree = Tree::new();
    let watcher = watcher_with(
        &tree,
        WatcherConfig {
            capacity: 2,
            debounce: Duration::ZERO,
            ..Default::default()
        },
    );
    arm(&watcher, &tree);
    let _ = common::drain_for(&watcher, Duration::from_millis(100));

    let mut subscriber = watcher.subscribe();
    for i in 0..100 {
        tree.write(format!("flood-{i}.txt"), b"x");
    }
    wait_for_stats(&watcher, DEADLINE, |stats| stats.events_dropped > 0);

    let deadline = Instant::now() + DEADLINE;
    let mut saw_rescan = false;
    while Instant::now() < deadline && !saw_rescan {
        match subscriber.try_recv() {
            Ok(event) => saw_rescan = event.kind == EventKind::RescanRequired,
            // Lagging is itself the broadcast channel's loss signal, and is documented as
            // equivalent to a rescan request for subscribers.
            Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_)) => saw_rescan = true,
            Err(tokio::sync::broadcast::error::TryRecvError::Empty) => {
                thread::sleep(Duration::from_millis(5));
            }
            Err(tokio::sync::broadcast::error::TryRecvError::Closed) => break,
        }
    }
    assert!(
        saw_rescan,
        "subscribers must learn about loss, either through a rescan event or a lag error"
    );
}

#[test]
fn a_rescan_signal_is_not_repeated_until_it_has_been_consumed() {
    let tree = Tree::new();
    let watcher = watcher_with(
        &tree,
        WatcherConfig {
            capacity: 2,
            debounce: Duration::ZERO,
            ..Default::default()
        },
    );
    arm(&watcher, &tree);
    let _ = common::drain_for(&watcher, Duration::from_millis(100));

    for i in 0..100 {
        tree.write(format!("flood-{i}.txt"), b"x");
    }
    let flooded = wait_for_stats(&watcher, DEADLINE, |stats| stats.events_dropped > 5);
    assert!(flooded.events_dropped > 5, "{flooded:?}");

    // Stop first: with production ongoing, a rescan consumed by the drain can legitimately be
    // raised again, and the invariant under test is per *episode*.
    watcher.stop().expect("stop");
    let drained = common::drain_for(&watcher, Duration::from_millis(100));
    let rescans = drained
        .iter()
        .filter(|event| event.kind == EventKind::RescanRequired)
        .count();
    assert_eq!(
        rescans,
        1,
        "one overflow episode must produce exactly one rescan request, not one per dropped \
         event ({} were dropped)\n{}",
        flooded.events_dropped,
        render(&drained)
    );
}

#[test]
fn excluded_paths_never_reach_the_queue() {
    let tree = Tree::new();
    let watcher = watcher_with(
        &tree,
        WatcherConfig {
            debounce: Duration::ZERO,
            filter: EventFilter::new()
                .exclude_glob("**/*.log")
                .expect("valid glob"),
            ..Default::default()
        },
    );
    arm(&watcher, &tree);
    let _ = common::drain_for(&watcher, Duration::from_millis(100));
    let baseline = common::baseline(&watcher);

    // Both writes land in the same directory, so the backend reports them in order: seeing the
    // second proves the first was already processed and dropped.
    let excluded = tree.write("noisy.log", b"x");
    let allowed = tree.write("wanted.txt", b"x");

    let mut seen = collect_until(&watcher, DEADLINE, |seen| {
        has_event(seen, &allowed, EventKind::Created)
    });
    expect_event(&seen, &allowed, EventKind::Created);
    seen.extend(common::drain_for(&watcher, GRACE));

    assert!(
        !common::mentions(&seen, &excluded),
        "an excluded path must never be delivered\n{}",
        render(&seen)
    );
    let (queued, _delivered, dropped) = common::delta(&watcher, baseline);
    assert_eq!(
        queued,
        seen.len() as u64,
        "filtered events must not occupy queue capacity: {queued} queued but {} delivered\n{}",
        seen.len(),
        render(&seen)
    );
    assert_eq!(dropped, 0);
}

#[test]
fn node_modules_style_excludes_work_on_real_paths() {
    let tree = Tree::new();
    tree.mkdir("node_modules/react");
    let watcher = watcher_with(
        &tree,
        WatcherConfig {
            debounce: Duration::ZERO,
            filter: EventFilter::dev_defaults().expect("built-in patterns compile"),
            ..Default::default()
        },
    );
    arm_with(&watcher, &tree, |attempt| format!("arm-{attempt}.js"));
    let _ = common::drain_for(&watcher, Duration::from_millis(100));
    let baseline = common::baseline(&watcher);

    let vendored = tree.write("node_modules/react/index.js", b"x");
    let source = tree.write("app.js", b"x");

    let mut seen = collect_until(&watcher, DEADLINE, |seen| {
        has_event(seen, &source, EventKind::Created)
    });
    seen.extend(common::drain_for(&watcher, GRACE));

    expect_event(&seen, &source, EventKind::Created);
    assert!(
        !common::mentions(&seen, &vendored),
        "node_modules must be excluded\n{}",
        render(&seen)
    );
    let (queued, _, _) = common::delta(&watcher, baseline);
    assert_eq!(queued, seen.len() as u64);
}

#[test]
fn include_globs_reject_everything_else() {
    let tree = Tree::new();
    let watcher = watcher_with(
        &tree,
        WatcherConfig {
            debounce: Duration::ZERO,
            filter: EventFilter::new()
                .include_glob("**/*.rs")
                .expect("valid glob"),
            ..Default::default()
        },
    );
    // The sentinel has to satisfy the filter under test, or arming could never succeed.
    arm_with(&watcher, &tree, |attempt| format!("arm-{attempt}.rs"));
    let _ = common::drain_for(&watcher, Duration::from_millis(100));
    let baseline = common::baseline(&watcher);

    let ignored = tree.write("notes.md", b"x");
    let included = tree.write("lib.rs", b"x");

    let mut seen = collect_until(&watcher, DEADLINE, |seen| {
        has_event(seen, &included, EventKind::Created)
    });
    seen.extend(common::drain_for(&watcher, GRACE));

    expect_event(&seen, &included, EventKind::Created);
    assert!(
        !common::mentions(&seen, &ignored),
        "only included paths may be delivered\n{}",
        render(&seen)
    );
    let (queued, _, _) = common::delta(&watcher, baseline);
    assert_eq!(queued, seen.len() as u64);
}

#[test]
fn rapid_writes_to_one_path_collapse_within_the_window() {
    const WRITES: usize = 12;
    let tree = Tree::new();
    let watcher = watcher_with(
        &tree,
        WatcherConfig {
            debounce: Duration::from_secs(2),
            ..Default::default()
        },
    );
    arm(&watcher, &tree);
    let _ = common::drain_for(&watcher, Duration::from_millis(100));
    let baseline = common::baseline(&watcher);

    let path = tree.path("saved.txt");
    for i in 0..WRITES {
        std::fs::write(&path, format!("revision {i}")).expect("write");
    }

    // Wait for the first event, then let the window run its course.
    let first = wait_for(&watcher, DEADLINE, |event| event.path == path)
        .expect("the first write must be delivered immediately");
    assert!(matches!(
        first.kind,
        EventKind::Created | EventKind::Modified
    ));
    let extra = common::drain_for(&watcher, GRACE);

    let (queued, _, dropped) = common::delta(&watcher, baseline);
    assert_eq!(dropped, 0, "nothing was dropped; these were coalesced");
    // At most two: the leading event, and the trailing correction that restates the final state of
    // the file once the window closes. What must not happen is one event per write.
    assert!(
        queued <= 2,
        "{WRITES} writes inside the window produced {queued} events; coalescing did not \
         happen\n{}",
        render(&extra)
    );
}

#[test]
fn the_write_a_window_swallowed_is_corrected_rather_than_lost() {
    // This failure is silent by construction. Leading-edge coalescing wakes the consumer on the
    // *first* event of a burst, so a burst that ends inside the window leaves it holding whatever
    // the file said mid-write, and nothing further ever arrives to correct that. One large save is
    // the ordinary shape of it: the backend fires on the first chunk and the write that finishes
    // the file lands milliseconds later, inside the window.
    //
    // So the correction has to carry the file's *final* size, not its intermediate one.
    const FINAL: &[u8] = b"the whole file, written after the consumer had already been woken";

    let tree = Tree::new();
    let window = Duration::from_millis(300);
    let watcher = watcher_with(
        &tree,
        WatcherConfig {
            debounce: window,
            ..Default::default()
        },
    );
    arm(&watcher, &tree);
    let _ = common::drain_for(&watcher, Duration::from_millis(150));

    let path = tree.path("partial.txt");
    std::fs::write(&path, b"x").expect("first write");
    let leading = wait_for(&watcher, DEADLINE, |event| event.path == path)
        .expect("the first write must be delivered immediately");

    // Inside the window, so coalescing drops it: without a trailing correction this is the write
    // the consumer would never hear about.
    std::fs::write(&path, FINAL).expect("completing write");

    let correction = wait_for(&watcher, DEADLINE, |event| {
        event.path == path && event.size == FINAL.len() as u64
    })
    .expect("the swallowed write must be restated once the window closes");

    assert_eq!(correction.kind, EventKind::Modified);
    assert!(
        leading.size < correction.size,
        "the correction carried {} bytes and the leading event {}; it must describe the finished \
         file, not the partial one",
        correction.size,
        leading.size
    );
}

#[test]
fn writes_outside_the_window_are_delivered_separately() {
    let tree = Tree::new();
    let window = Duration::from_millis(100);
    let watcher = watcher_with(
        &tree,
        WatcherConfig {
            debounce: window,
            ..Default::default()
        },
    );
    arm(&watcher, &tree);
    let _ = common::drain_for(&watcher, Duration::from_millis(150));

    let path = tree.path("periodic.txt");
    std::fs::write(&path, b"first").expect("write");
    wait_for(&watcher, DEADLINE, |event| event.path == path).expect("first write delivered");

    // Sleeping is the point here: the window is the thing under test, and sleeping *longer* than
    // it fails safe.
    thread::sleep(window * 3);

    std::fs::write(&path, b"second").expect("write");
    let second = wait_for(&watcher, DEADLINE, |event| event.path == path);
    assert!(
        second.is_some(),
        "a write after the window elapsed must not be coalesced away"
    );
}

#[test]
fn coalescing_never_swallows_a_delete() {
    let tree = Tree::new();
    // Created before the watcher starts, so the first event this path ever produces is the write
    // below rather than a create that would itself open the window.
    let path = tree.write("transient.txt", b"x");
    let watcher = watcher_with(
        &tree,
        WatcherConfig {
            // Far longer than the test takes, so a delete that survives can only have survived
            // because deletes are exempt.
            debounce: Duration::from_secs(30),
            ..Default::default()
        },
    );
    arm(&watcher, &tree);
    let _ = common::drain_for(&watcher, Duration::from_millis(100));

    std::fs::write(&path, b"touched").expect("write");
    // The window must be open for this path before the delete, and it is open either way: the write
    // is delivered and opens it, or the write is itself coalesced against an earlier event for the
    // same path — on macOS a file created immediately before the stream started can still turn up in
    // its first batch — which means it was already open. Asserting *which* of the two happened would
    // be asserting FSEvents' batching, not this crate's behaviour. What must hold is below.
    let _ = wait_for(&watcher, GRACE, |event| event.path == path);
    std::fs::remove_file(&path).expect("remove");

    let seen = collect_until(&watcher, DEADLINE, |seen| {
        has_event(seen, &path, EventKind::Deleted)
    });
    expect_event(&seen, &path, EventKind::Deleted);
}

#[test]
fn coalescing_never_swallows_a_rename() {
    let tree = Tree::new();
    let path = tree.write("movable.txt", b"x");
    let watcher = watcher_with(
        &tree,
        WatcherConfig {
            debounce: Duration::from_secs(30),
            ..Default::default()
        },
    );
    arm(&watcher, &tree);
    let _ = common::drain_for(&watcher, Duration::from_millis(100));

    std::fs::write(&path, b"touched").expect("write");
    // Open the window; see `coalescing_never_swallows_a_delete` for why the outcome of this wait is
    // not itself the assertion.
    let _ = wait_for(&watcher, GRACE, |event| event.path == path);

    let (from, to) = tree.rename("movable.txt", "moved.txt");
    let seen = collect_until(&watcher, DEADLINE, |seen| {
        has_event(seen, &from, EventKind::RenamedFrom) && has_event(seen, &to, EventKind::RenamedTo)
    });
    expect_event(&seen, &from, EventKind::RenamedFrom);
    expect_event(&seen, &to, EventKind::RenamedTo);
}

#[test]
fn recreating_a_deleted_path_inside_the_window_is_delivered() {
    let tree = Tree::new();
    let path = tree.write("phoenix.txt", b"x");
    let watcher = watcher_with(
        &tree,
        WatcherConfig {
            debounce: Duration::from_secs(30),
            ..Default::default()
        },
    );
    arm(&watcher, &tree);
    let _ = common::drain_for(&watcher, Duration::from_millis(100));

    std::fs::remove_file(&path).expect("remove");
    let deleted = collect_until(&watcher, DEADLINE, |seen| {
        has_event(seen, &path, EventKind::Deleted)
    });
    expect_event(&deleted, &path, EventKind::Deleted);

    // Well inside the 30 second window, but the file's existence changed: suppressing this would
    // leave the consumer believing the file is still gone.
    //
    // What is asserted is that the path is reported again — not the kind, not the order, and not the
    // size. macOS delivers the flags of a coalesced batch in a fixed order rather than a
    // chronological one, and with coalescing on, the create can be the event that is delivered while
    // the modify behind it is collapsed into it; if `stat` then lands between the writer's `open` and
    // its `write`, the delivered event honestly carries size 0. Requiring a size here would be
    // requiring this crate to win a race against the process doing the writing, which is not
    // something it can promise. `creating_a_file_reports_its_size` covers sizes where coalescing is
    // off and the event can be picked out of the stream.
    std::fs::write(&path, b"back again").expect("write");
    let recreated = collect_until(&watcher, DEADLINE, |seen| {
        seen.iter().any(|event| event.path == path)
    });
    // Only events collected after the re-creation count: the delete's own batch was drained above,
    // and letting it satisfy this would let a stale event stand in for the report being tested.
    assert!(
        recreated.iter().any(|event| event.path == path
            && matches!(
                event.kind,
                EventKind::Created | EventKind::Modified | EventKind::Metadata
            )),
        "a path recreated after deletion must be reported again, even inside the coalescing \
         window\nbefore:\n{}after:\n{}",
        render(&deleted),
        render(&recreated)
    );
}

#[test]
fn coalescing_is_per_path_not_global() {
    let tree = Tree::new();
    let watcher = watcher_with(
        &tree,
        WatcherConfig {
            debounce: Duration::from_secs(30),
            ..Default::default()
        },
    );
    arm(&watcher, &tree);
    let _ = common::drain_for(&watcher, Duration::from_millis(100));

    let first = tree.write("a.txt", b"x");
    let second = tree.write("b.txt", b"x");
    let seen = collect_until(&watcher, DEADLINE, |seen| {
        common::mentions(seen, &first) && common::mentions(seen, &second)
    });
    assert!(
        common::mentions(&seen, &first) && common::mentions(&seen, &second),
        "one path's window must not suppress another's\n{}",
        render(&seen)
    );
}

#[test]
fn many_readers_and_writers_stay_consistent() {
    const READERS: usize = 4;
    const WRITERS: usize = 2;
    const RUN: Duration = Duration::from_secs(2);
    /// Bound on the whole exercise; exceeding it means a deadlock, and a failure beats a hang.
    const BOUND: Duration = Duration::from_secs(30);

    let tree = Tree::new();
    let watcher = Arc::new(watcher_with(
        &tree,
        WatcherConfig {
            capacity: 256,
            debounce: Duration::ZERO,
            ..Default::default()
        },
    ));
    arm(&watcher, &tree);
    let baseline = common::baseline(&watcher);

    let stop = Arc::new(AtomicBool::new(false));
    let received = Arc::new(AtomicU64::new(0));
    let (done_tx, done_rx) = mpsc::channel();
    let mut handles = Vec::new();

    for _ in 0..READERS {
        let watcher = Arc::clone(&watcher);
        let stop = Arc::clone(&stop);
        let received = Arc::clone(&received);
        let done_tx = done_tx.clone();
        handles.push(thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                // Mix both consumer APIs so neither is exercised in isolation.
                if watcher.recv_timeout(Duration::from_millis(5)).is_some() {
                    received.fetch_add(1, Ordering::Relaxed);
                }
                while watcher.poll().is_some() {
                    received.fetch_add(1, Ordering::Relaxed);
                }
                // Reading statistics concurrently must not deadlock against delivery.
                let stats = watcher.stats();
                assert_eq!(
                    stats.events_queued,
                    stats.events_delivered + stats.queue_pending as u64,
                    "statistics snapshot was inconsistent: {stats:?}"
                );
            }
            let _ = done_tx.send(());
        }));
    }

    for writer in 0..WRITERS {
        let tree_root = tree.root.clone();
        let stop = Arc::clone(&stop);
        let done_tx = done_tx.clone();
        handles.push(thread::spawn(move || {
            let mut i = 0_u64;
            while !stop.load(Ordering::Relaxed) {
                let path = tree_root.join(format!("w{writer}-{i}.txt"));
                let _ = std::fs::write(&path, b"churn");
                if i.is_multiple_of(3) {
                    let _ = std::fs::remove_file(&path);
                }
                i += 1;
            }
            let _ = done_tx.send(());
        }));
    }
    drop(done_tx);

    thread::sleep(RUN);
    stop.store(true, Ordering::Relaxed);

    let deadline = Instant::now() + BOUND;
    for worker in 0..(READERS + WRITERS) {
        let remaining = deadline.saturating_duration_since(Instant::now());
        done_rx.recv_timeout(remaining).unwrap_or_else(|_| {
            panic!("worker {worker} did not finish within {BOUND:?}: probable deadlock")
        });
    }
    for handle in handles {
        handle.join().expect("no worker may panic");
    }

    let stats = watcher.stats();
    common::assert_stats_invariant(&stats);
    let (queued, delivered, _dropped) = common::delta(&watcher, baseline);
    assert!(queued > 0, "the writers produced no events at all");
    assert_eq!(
        delivered,
        received.load(Ordering::Relaxed),
        "every delivered event must have been handed to exactly one reader"
    );
    assert!(
        delivered <= queued,
        "more events were delivered than were ever queued: {stats:?}"
    );
}

#[test]
fn two_watchers_on_the_same_tree_are_independent() {
    let tree = Tree::new();
    let first = watcher_with(
        &tree,
        WatcherConfig {
            debounce: Duration::ZERO,
            ..Default::default()
        },
    );
    let second = watcher_with(
        &tree,
        WatcherConfig {
            debounce: Duration::ZERO,
            ..Default::default()
        },
    );
    arm(&first, &tree);
    arm(&second, &tree);

    let path = tree.write("shared.txt", b"x");
    for (name, watcher) in [("first", &first), ("second", &second)] {
        let seen = collect_until(watcher, DEADLINE, |seen| {
            has_event(seen, &path, EventKind::Created)
        });
        assert!(
            has_event(&seen, &path, EventKind::Created),
            "{name} watcher missed the event\n{}",
            render(&seen)
        );
    }

    first.stop().expect("stop first");
    let path = tree.write("after-first-stopped.txt", b"x");
    let seen = collect_until(&second, DEADLINE, |seen| {
        has_event(seen, &path, EventKind::Created)
    });
    assert!(
        has_event(&seen, &path, EventKind::Created),
        "stopping one watcher must not disturb another"
    );
}
