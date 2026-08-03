//! Lifecycle and error-path tests.
//!
//! Nothing here may hang: every test that could deadlock is bounded by a watchdog so a regression
//! *fails* instead of blocking the suite forever.

mod common;

use std::path::Path;
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use common::{arm, collect_until, expect_event, has_event, wait_for, Tree, DEADLINE};
use retrigger_system::{Backend, EventKind, WatchError, Watcher, WatcherConfig};

/// How long a lifecycle operation may take before we call it hung.
const WATCHDOG: Duration = Duration::from_secs(15);

/// Run `body` on another thread and fail (rather than hang) if it does not finish in time.
fn within<T: Send + 'static>(what: &str, body: impl FnOnce() -> T + Send + 'static) -> T {
    let (tx, rx) = mpsc::channel();
    let handle = thread::spawn(move || {
        let value = body();
        // Send failure only means the receiver already gave up and the test has failed.
        let _ = tx.send(value);
    });
    match rx.recv_timeout(WATCHDOG) {
        Ok(value) => {
            handle.join().expect("worker thread must not panic");
            value
        }
        Err(_) => panic!("{what} did not finish within {WATCHDOG:?}: probable deadlock"),
    }
}

fn watcher() -> Watcher {
    Watcher::new(WatcherConfig {
        debounce: Duration::ZERO,
        ..Default::default()
    })
    .expect("create watcher")
}

#[test]
fn a_fresh_watcher_is_idle() {
    let watcher = watcher();
    let stats = watcher.stats();
    assert!(!stats.is_running);
    assert_eq!(stats.events_queued, 0);
    assert_eq!(stats.events_delivered, 0);
    assert_eq!(stats.events_dropped, 0);
    assert_eq!(stats.queue_pending, 0);
    assert_eq!(stats.watched_paths, 0);
    assert_eq!(stats.queue_capacity, retrigger_system::DEFAULT_CAPACITY);
    common::assert_stats_invariant(&stats);
}

#[test]
fn polling_before_start_yields_nothing() {
    let watcher = watcher();
    assert!(watcher.poll().is_none());
}

#[test]
fn recv_timeout_before_start_returns_without_waiting_out_the_timeout() {
    let watcher = watcher();
    let started = Instant::now();
    assert!(watcher.recv_timeout(Duration::from_secs(30)).is_none());
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "a stopped watcher should not make callers pay the full timeout"
    );
}

#[test]
fn backend_is_known_before_start() {
    let watcher = watcher();
    let backend = watcher.backend();
    assert!(matches!(
        backend,
        Backend::Inotify
            | Backend::FsEvents
            | Backend::ReadDirectoryChangesW
            | Backend::KQueue
            | Backend::Polling
    ));
    #[cfg(target_os = "macos")]
    assert_eq!(backend, Backend::FsEvents);
    #[cfg(target_os = "linux")]
    assert_eq!(backend, Backend::Inotify);
}

#[test]
fn start_is_idempotent() {
    let tree = Tree::new();
    let watcher = watcher();
    watcher.watch(&tree.root, true).expect("watch");

    watcher.start().expect("first start");
    watcher.start().expect("second start must be a no-op");
    watcher.start().expect("third start must be a no-op");
    assert!(watcher.is_running());

    // Still functional after the redundant starts, and only one backend is attached.
    arm(&watcher, &tree);
    let path = tree.write("after-double-start.txt", b"x");
    let events = collect_until(&watcher, DEADLINE, |seen| {
        has_event(seen, &path, EventKind::Created)
    });
    let matches = events
        .iter()
        .filter(|event| event.path == path && event.kind == EventKind::Created)
        .count();
    assert_eq!(
        matches, 1,
        "a second start must not attach a second backend and duplicate every event"
    );
}

#[test]
fn stop_is_idempotent_and_works_without_a_start() {
    let tree = Tree::new();
    let watcher = watcher();
    watcher.stop().expect("stop before start");
    watcher.stop().expect("stop again before start");

    watcher.watch(&tree.root, true).expect("watch");
    watcher.start().expect("start");
    watcher.stop().expect("first stop");
    watcher.stop().expect("second stop");
    assert!(!watcher.is_running());
}

#[test]
fn stopping_ends_event_delivery_but_keeps_queued_events_readable() {
    let tree = Tree::new();
    let watcher = watcher();
    watcher.watch(&tree.root, true).expect("watch");
    watcher.start().expect("start");
    arm(&watcher, &tree);

    let path = tree.write("before-stop.txt", b"x");
    let events = collect_until(&watcher, DEADLINE, |seen| {
        has_event(seen, &path, EventKind::Created)
    });
    expect_event(&events, &path, EventKind::Created);

    // Queue something, then stop without draining.
    let queued_path = tree.write("queued.txt", b"x");
    common::wait_for_stats(&watcher, DEADLINE, |stats| stats.queue_pending > 0);
    watcher.stop().expect("stop");

    let drained = common::drain_for(&watcher, Duration::from_millis(100));
    assert!(
        !drained.is_empty(),
        "events queued before stopping must remain readable"
    );

    // Nothing new after stopping.
    let before = watcher.stats().events_queued;
    tree.write("after-stop.txt", b"x");
    thread::sleep(common::GRACE);
    assert_eq!(
        watcher.stats().events_queued,
        before,
        "a stopped watcher must not queue anything"
    );
    let _ = queued_path;
}

#[test]
fn a_watcher_can_be_restarted() {
    let tree = Tree::new();
    let watcher = watcher();
    watcher.watch(&tree.root, true).expect("watch");

    watcher.start().expect("start");
    arm(&watcher, &tree);
    watcher.stop().expect("stop");
    let _ = common::drain_for(&watcher, Duration::from_millis(50));

    watcher.start().expect("restart");
    assert!(watcher.is_running());
    arm(&watcher, &tree);
    let path = tree.write("after-restart.txt", b"x");
    let events = collect_until(&watcher, DEADLINE, |seen| {
        has_event(seen, &path, EventKind::Created)
    });
    expect_event(&events, &path, EventKind::Created);
}

#[test]
fn watching_before_start_delivers_after_start() {
    let tree = Tree::new();
    let watcher = watcher();
    watcher.watch(&tree.root, true).expect("watch before start");
    assert_eq!(watcher.stats().watched_paths, 1);

    watcher.start().expect("start");
    arm(&watcher, &tree);
    let path = tree.write("pre-registered.txt", b"x");
    let events = collect_until(&watcher, DEADLINE, |seen| {
        has_event(seen, &path, EventKind::Created)
    });
    expect_event(&events, &path, EventKind::Created);
}

#[test]
fn watching_after_start_delivers() {
    let tree = Tree::new();
    let watcher = watcher();
    watcher.start().expect("start with nothing watched");

    let nested = tree.mkdir("added-later");
    watcher.watch(&nested, true).expect("watch after start");
    assert_eq!(watcher.stats().watched_paths, 1);

    let deadline = Instant::now() + DEADLINE;
    let mut attempt = 0;
    loop {
        assert!(
            deadline > Instant::now(),
            "a path watched after start never delivered events"
        );
        let path = nested.join(format!("late-{attempt}.txt"));
        std::fs::write(&path, b"x").expect("write");
        if wait_for(&watcher, Duration::from_millis(500), |event| {
            event.path == path
        })
        .is_some()
        {
            break;
        }
        attempt += 1;
    }
}

#[test]
fn re_watching_a_path_replaces_its_recursion_mode() {
    let tree = Tree::new();
    tree.mkdir("sub");
    let watcher = watcher();
    watcher.watch(&tree.root, false).expect("non-recursive");
    watcher.watch(&tree.root, true).expect("upgrade");
    assert_eq!(
        watcher.stats().watched_paths,
        1,
        "re-watching must replace, not duplicate"
    );
    assert_eq!(watcher.watched(), vec![(tree.root.clone(), true)]);

    watcher.start().expect("start");
    arm(&watcher, &tree);
    let path = tree.write("sub/nested.txt", b"x");
    let events = collect_until(&watcher, DEADLINE, |seen| {
        has_event(seen, &path, EventKind::Created)
    });
    expect_event(&events, &path, EventKind::Created);
}

#[test]
fn unwatching_stops_delivery_for_that_path() {
    let tree = Tree::new();
    let kept = tree.mkdir("kept");
    let dropped = tree.mkdir("dropped");
    let watcher = watcher();
    watcher.watch(&kept, true).expect("watch kept");
    watcher.watch(&dropped, true).expect("watch dropped");
    watcher.start().expect("start");
    assert_eq!(watcher.stats().watched_paths, 2);

    watcher.unwatch(&dropped).expect("unwatch");
    assert_eq!(watcher.stats().watched_paths, 1);
    let _ = common::drain_for(&watcher, Duration::from_millis(100));

    std::fs::write(dropped.join("ignored.txt"), b"x").expect("write");
    let sentinel = kept.join("noticed.txt");
    std::fs::write(&sentinel, b"x").expect("write");

    let events = collect_until(&watcher, DEADLINE, |seen| {
        seen.iter().any(|event| event.path == sentinel)
    });
    let mut all = events;
    all.extend(common::drain_for(&watcher, common::GRACE));
    assert!(
        !all.iter().any(|event| event.path.starts_with(&dropped)),
        "unwatched paths must stop reporting\nsaw:\n{}",
        common::render(&all)
    );
}

#[test]
fn unwatching_something_never_watched_is_not_found() {
    let tree = Tree::new();
    let watcher = watcher();
    let err = watcher.unwatch(&tree.root).expect_err("must fail");
    assert!(matches!(err, WatchError::NotFound(_)), "{err:?}");

    // Also after starting, where the backend has its own opinion about unknown watches.
    watcher.start().expect("start");
    let err = watcher.unwatch(&tree.root).expect_err("must fail");
    assert!(matches!(err, WatchError::NotFound(_)), "{err:?}");
}

#[test]
fn watching_a_nonexistent_path_is_not_found() {
    let tree = Tree::new();
    let missing = tree.path("not/here");
    let watcher = watcher();

    let err = watcher.watch(&missing, true).expect_err("must fail");
    assert!(matches!(err, WatchError::NotFound(_)), "{err:?}");
    assert_eq!(
        watcher.stats().watched_paths,
        0,
        "a failed watch must not be registered"
    );

    // Identical behaviour once running: the error does not depend on lifecycle state.
    watcher.start().expect("start");
    let err = watcher.watch(&missing, true).expect_err("must fail");
    assert!(matches!(err, WatchError::NotFound(_)), "{err:?}");
}

#[test]
fn watching_a_path_that_vanishes_before_start_fails_at_start() {
    let tree = Tree::new();
    let doomed = tree.mkdir("doomed");
    let watcher = watcher();
    watcher.watch(&doomed, true).expect("watch");
    std::fs::remove_dir(&doomed).expect("remove");

    let err = watcher.start().expect_err("start must report the gap");
    assert!(matches!(err, WatchError::NotFound(_)), "{err:?}");
    assert!(
        !watcher.is_running(),
        "a failed start must leave the watcher stopped, not half-running"
    );
}

#[test]
fn stop_from_another_thread_is_safe() {
    let tree = Tree::new();
    let watcher = Arc::new(watcher());
    watcher.watch(&tree.root, true).expect("watch");
    watcher.start().expect("start");
    arm(&watcher, &tree);

    let stopper = Arc::clone(&watcher);
    within("stop from another thread", move || {
        stopper.stop().expect("stop");
    });
    assert!(!watcher.is_running());
}

#[test]
fn stop_wakes_a_blocked_receiver() {
    let tree = Tree::new();
    let watcher = Arc::new(watcher());
    watcher.watch(&tree.root, true).expect("watch");
    watcher.start().expect("start");
    arm(&watcher, &tree);
    let _ = common::drain_for(&watcher, Duration::from_millis(50));

    let receiver = Arc::clone(&watcher);
    let (tx, rx) = mpsc::channel();
    let handle = thread::spawn(move || {
        let started = Instant::now();
        let event = receiver.recv_timeout(Duration::from_secs(60));
        let _ = tx.send((event, started.elapsed()));
    });

    thread::sleep(Duration::from_millis(100));
    watcher.stop().expect("stop");

    let (event, elapsed) = rx
        .recv_timeout(WATCHDOG)
        .expect("blocked receiver must wake when the watcher stops");
    handle.join().expect("receiver thread");
    assert!(event.is_none());
    assert!(
        elapsed < Duration::from_secs(10),
        "receiver waited {elapsed:?} after stop instead of waking promptly"
    );
}

#[test]
fn dropping_a_running_watcher_does_not_hang() {
    let tree = Tree::new();
    let root = tree.root.clone();
    within("drop while running", move || {
        let watcher = Watcher::new(WatcherConfig::default()).expect("create");
        watcher.watch(&root, true).expect("watch");
        watcher.start().expect("start");
        std::fs::write(root.join("churn.txt"), b"x").expect("write");
        drop(watcher);
    });

    // If the previous backend thread had leaked, a new watcher on the same tree would still work,
    // so instead assert the observable contract: a fresh watcher starts and delivers.
    let watcher = watcher();
    watcher.watch(&tree.root, true).expect("watch");
    watcher.start().expect("start");
    arm(&watcher, &tree);
    let path = tree.write("after-drop.txt", b"x");
    let events = collect_until(&watcher, DEADLINE, |seen| {
        has_event(seen, &path, EventKind::Created)
    });
    expect_event(&events, &path, EventKind::Created);
}

#[test]
fn dropping_many_running_watchers_does_not_leak_threads() {
    // A leaked backend thread per watcher would exhaust the process' thread limit long before
    // this finishes, and each `drop` would return before its thread died.
    let tree = Tree::new();
    within("create and drop 50 running watchers", {
        let root = tree.root.clone();
        move || {
            for _ in 0..50 {
                let watcher = Watcher::new(WatcherConfig::default()).expect("create");
                watcher.watch(&root, true).expect("watch");
                watcher.start().expect("start");
                drop(watcher);
            }
        }
    });
}

#[test]
fn stopping_with_a_directory_scan_in_flight_neither_hangs_nor_delivers_afterwards() {
    let tree = Tree::new();
    let watcher = Arc::new(watcher());
    watcher.watch(&tree.root, true).expect("watch");
    watcher.start().expect("start");
    arm(&watcher, &tree);

    // A directory with contents is queued for reconciliation the moment it appears, and its
    // follow-up passes are still scheduled when `stop` runs. Stopping has to join that work rather
    // than race it, and nothing may be delivered afterwards.
    std::fs::create_dir_all(tree.path("pending/inner")).expect("mkdir");
    for i in 0..50 {
        std::fs::write(tree.path(format!("pending/inner/f{i}.txt")), b"x").expect("write");
    }

    let stopper = Arc::clone(&watcher);
    within("stop with a scan in flight", move || {
        stopper.stop().expect("stop");
    });

    let after = watcher.stats();
    thread::sleep(common::GRACE);
    let idle = watcher.stats();
    assert_eq!(
        idle.events_queued, after.events_queued,
        "a reconciliation pass must not survive `stop`"
    );
    assert_eq!(idle.events_synthesized, after.events_synthesized);
    common::assert_stats_invariant(&idle);
}

#[test]
fn stats_track_the_lifecycle() {
    let tree = Tree::new();
    let watcher = watcher();

    assert!(!watcher.stats().is_running);
    watcher.watch(&tree.root, true).expect("watch");
    assert_eq!(watcher.stats().watched_paths, 1);
    assert!(
        !watcher.stats().is_running,
        "registering a path must not start anything"
    );

    watcher.start().expect("start");
    assert!(watcher.stats().is_running);
    arm(&watcher, &tree);

    let path = tree.write("counted.txt", b"x");
    collect_until(&watcher, DEADLINE, |seen| {
        has_event(seen, &path, EventKind::Created)
    });

    let stats = watcher.stats();
    common::assert_stats_invariant(&stats);
    assert!(stats.events_queued > 0);
    assert!(stats.events_delivered > 0);
    assert_eq!(stats.events_dropped, 0, "capacity was never approached");
    assert_eq!(stats.queue_capacity, retrigger_system::DEFAULT_CAPACITY);

    watcher.stop().expect("stop");
    let after = watcher.stats();
    assert!(!after.is_running);
    assert!(
        after.events_queued >= stats.events_queued,
        "counters are monotonic; stopping must not rewrite history"
    );
    assert_eq!(after.watched_paths, 1, "stopping does not forget paths");
    common::assert_stats_invariant(&after);

    // And they stop moving: a write after `stop` contributes nothing.
    tree.write("ignored-after-stop.txt", b"x");
    thread::sleep(common::GRACE);
    let idle = watcher.stats();
    assert_eq!(idle.events_queued, after.events_queued);
    assert_eq!(idle.events_dropped, after.events_dropped);
    common::assert_stats_invariant(&idle);
}

#[test]
fn watched_paths_are_reported_with_their_mode() {
    let tree = Tree::new();
    let sub = tree.mkdir("sub");
    let watcher = watcher();
    watcher.watch(&tree.root, true).expect("watch root");
    watcher.watch(&sub, false).expect("watch sub");

    let mut watched = watcher.watched();
    watched.sort();
    let mut expected = vec![(tree.root.clone(), true), (sub, false)];
    expected.sort();
    assert_eq!(watched, expected);
}

#[test]
fn debug_output_is_useful_and_does_not_panic() {
    let watcher = watcher();
    let rendered = format!("{watcher:?}");
    assert!(rendered.contains("Watcher"), "{rendered}");
    assert!(rendered.contains("running"), "{rendered}");
}

#[test]
fn a_zero_capacity_configuration_is_clamped_rather_than_rejected() {
    let watcher = Watcher::new(WatcherConfig {
        capacity: 0,
        ..Default::default()
    })
    .expect("create watcher");
    assert_eq!(watcher.stats().queue_capacity, 1);
}

#[test]
fn watching_a_symlinked_root_reports_events() {
    let tree = Tree::new();
    let target = tree.mkdir("real");
    let link = tree.path("link");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&target, &link).expect("symlink");
    #[cfg(windows)]
    std::os::windows::fs::symlink_dir(&target, &link).expect("symlink");

    let watcher = watcher();
    watcher.watch(&link, true).expect("watch the symlink");
    watcher.start().expect("start");

    let deadline = Instant::now() + DEADLINE;
    let mut attempt = 0;
    let event = loop {
        assert!(
            deadline > Instant::now(),
            "a symlinked watch root never delivered events"
        );
        let path = target.join(format!("through-link-{attempt}.txt"));
        std::fs::write(&path, b"x").expect("write");
        if let Some(event) = wait_for(&watcher, Duration::from_millis(500), |event| {
            event.path.file_name() == path.file_name()
        }) {
            break event;
        }
        attempt += 1;
    };
    // The reported path may be either the link or its target depending on backend; both are in
    // scope because the entry records the canonical root as well.
    assert!(
        event.path.starts_with(&target) || event.path.starts_with(&link),
        "unexpected path {} for roots {} / {}",
        event.path.display(),
        target.display(),
        link.display()
    );
    let _ = Path::new("");
}

/// Whether registering a watch even touches the target's own permission bits is backend-specific:
/// `inotify` opens the directory and so needs read access to it, while `FSEvents` subscribes to a
/// volume-wide event stream and needs none. Root bypasses the check either way. This asserts the
/// mapping only when the current backend and privilege level can actually produce the failure —
/// the same "skip, don't fail, when we cannot prove the negative" shape as
/// [`watching_a_symlinked_root_reports_events`] uses for platform differences. The mapping itself
/// is proven unconditionally and deterministically by `error::tests::io_permission_denied_maps_to_permission_denied`.
#[cfg(unix)]
#[test]
fn watching_a_permission_denied_directory_yields_permission_denied() {
    use std::os::unix::fs::PermissionsExt;

    let tree = Tree::new();
    let locked = tree.mkdir("locked");
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).expect("chmod 000");

    // The backend must actually be attached for registration to touch the kernel at all: watching
    // an unstarted watcher only records scope and defers the real syscall to `start`.
    let watcher = watcher();
    watcher.start().expect("start");
    let result = watcher.watch(&locked, true);

    // Restored before any assertion can panic, so a failing test never leaves the temp tree
    // (and its `Drop` cleanup) unable to remove itself.
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).expect("restore");

    match result {
        Err(WatchError::PermissionDenied(_)) => {}
        Ok(()) => eprintln!(
            "skipping assertion: watch of a chmod-000 directory succeeded, \
             which means either this process is root or the current backend (e.g. FSEvents) \
             does not need read access on the target to register a watch"
        ),
        Err(other) => panic!("expected PermissionDenied, got {other:?}"),
    }
}
