//! [`BackendMode::Poll`] on real files.
//!
//! A genuine network mount (NFS, SMB) cannot be provisioned in this suite, so this is not a claim
//! that network-fs behaviour is verified end to end — only that the portable polling backend
//! itself, which is what a network mount is configured to fall back on, behaves correctly against
//! a subset of the scenarios `races.rs` and `lifecycle.rs` already prove for the native backend.
//! Treat this as "the fallback works", not "the network case is covered".

mod common;

use std::time::Duration;

use common::{arm, collect_until, drain_for, mentions, render, wait_for, Tree, DEADLINE};
use retrigger_system::{Backend, BackendMode, EventKind, FileEvent, Watcher, WatcherConfig};

/// Short enough to keep the suite fast, long enough not to starve the scan thread on a loaded
/// machine.
const POLL_INTERVAL: Duration = Duration::from_millis(50);

fn poll_watcher_for(tree: &Tree, recursive: bool) -> Watcher {
    poll_watcher_with(tree, recursive, false)
}

/// `compare_contents: true` is needed by any scenario that rewrites a path to the same size
/// within one mtime tick — an atomic rename-over-existing being the canonical example — since
/// otherwise a size+mtime-only poll has nothing to distinguish the rewrite from a no-op.
fn poll_watcher_with(tree: &Tree, recursive: bool, compare_contents: bool) -> Watcher {
    let watcher = Watcher::new(WatcherConfig {
        debounce: Duration::ZERO,
        backend: BackendMode::Poll {
            interval: POLL_INTERVAL,
            compare_contents,
        },
        ..Default::default()
    })
    .expect("create watcher");
    assert_eq!(watcher.backend(), Backend::Polling);
    watcher.watch(&tree.root, recursive).expect("watch root");
    watcher.start().expect("start");
    arm(&watcher, tree);
    watcher
}

fn reported_or_rescanned(events: &[FileEvent], path: &std::path::Path) -> bool {
    events
        .iter()
        .any(|event| event.path == path || event.kind == EventKind::RescanRequired)
}

#[test]
fn an_atomic_save_over_an_existing_file_is_reported_under_poll() {
    let tree = Tree::new();
    let target = tree.write("config.json", b"{\"v\":1}");
    // Same size, so only content comparison (not size/mtime alone) can promise this is caught
    // regardless of the file system's mtime resolution.
    let watcher = poll_watcher_with(&tree, true, true);

    tree.write("config.json.tmp", b"{\"v\":2}");
    tree.rename("config.json.tmp", "config.json");

    let events = collect_until(&watcher, DEADLINE, |seen| {
        reported_or_rescanned(seen, &target)
    });
    assert!(
        reported_or_rescanned(&events, &target),
        "an atomic save over {} was neither reported nor rescanned under Poll:\n{}",
        target.display(),
        render(&events)
    );
}

#[test]
fn a_rename_storm_either_reports_every_destination_or_asks_for_a_rescan_under_poll() {
    const FILES: usize = 50;
    let tree = Tree::new();
    for i in 0..FILES {
        tree.write(format!("f{i}.txt"), b"x");
    }
    let watcher = poll_watcher_for(&tree, true);

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
        "{} rename destinations were neither reported nor covered by a rescan under Poll \
         (first missing: {:?})",
        missing.len(),
        missing.first()
    );
}

#[test]
fn a_symlinked_root_reports_events_under_poll() {
    let tree = Tree::new();
    let target = tree.mkdir("real");
    let link = tree.path("link");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&target, &link).expect("symlink");
    #[cfg(windows)]
    std::os::windows::fs::symlink_dir(&target, &link).expect("symlink");

    let watcher = poll_watcher_for(&tree, true);

    let path = target.join("through-link.txt");
    std::fs::write(&path, b"x").expect("write");

    let event = wait_for(&watcher, DEADLINE, |event| {
        event.path.file_name() == path.file_name()
    })
    .expect("a write through a symlinked Poll root was never reported");
    assert!(
        event.path.starts_with(&target) || event.path.starts_with(&link),
        "unexpected path {} for roots {} / {}",
        event.path.display(),
        target.display(),
        link.display()
    );
}

#[test]
fn a_chunked_write_is_reported_under_poll() {
    let tree = Tree::new();
    let path = tree.path("growing.bin");
    let watcher = poll_watcher_for(&tree, true);

    for chunk in 0..4 {
        std::fs::write(&path, vec![chunk as u8; 4096 * (chunk + 1)]).expect("write chunk");
        std::thread::sleep(POLL_INTERVAL * 2);
    }

    let events = collect_until(&watcher, DEADLINE, |seen| mentions(seen, &path));
    assert!(
        mentions(&events, &path),
        "a chunked write under Poll was never reported:\n{}",
        render(&events)
    );
    let _ = drain_for(&watcher, Duration::from_millis(50));
}
