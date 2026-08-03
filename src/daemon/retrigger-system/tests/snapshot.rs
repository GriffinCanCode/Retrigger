//! `Watcher::snapshot`, `Watcher::watch_with_snapshot`, and `diff_snapshots`.

mod common;

use std::fs;
use std::time::Duration;

use common::Tree;
use retrigger_system::{diff_snapshots, EventKind, SnapshotEntry, Watcher, WatcherConfig};

fn watcher() -> Watcher {
    Watcher::new(WatcherConfig {
        debounce: Duration::ZERO,
        ..Default::default()
    })
    .expect("create watcher")
}

fn find<'a>(entries: &'a [SnapshotEntry], path: &std::path::Path) -> Option<&'a SnapshotEntry> {
    entries.iter().find(|e| e.path == path)
}

#[test]
fn a_flat_directory_is_inventoried_entry_by_entry() {
    let tree = Tree::new();
    for name in ["a.txt", "b.txt", "c.txt"] {
        tree.write(name, b"hello");
    }

    let watcher = watcher();
    let entries = watcher.snapshot(&tree.root).expect("snapshot");
    let mut paths: Vec<_> = entries.iter().map(|e| e.path.clone()).collect();
    paths.sort();
    assert_eq!(
        paths,
        vec![tree.path("a.txt"), tree.path("b.txt"), tree.path("c.txt"),]
    );
    for entry in &entries {
        assert!(!entry.is_directory);
        assert_eq!(entry.size, 5);
        assert!(entry.modified_ns.is_some());
    }
}

#[test]
fn nested_directories_are_included() {
    let tree = Tree::new();
    tree.mkdir("a/b/c");
    tree.write("a/b/c/deep.txt", b"x");

    let watcher = watcher();
    let entries = watcher.snapshot(&tree.root).expect("snapshot");

    let deep = find(&entries, &tree.path("a/b/c/deep.txt")).expect("deep file present");
    assert!(!deep.is_directory);
    assert_eq!(deep.size, 1);

    let dir = find(&entries, &tree.path("a")).expect("directory present");
    assert!(dir.is_directory);
    assert_eq!(dir.size, 0);
}

#[test]
fn the_root_itself_is_not_one_of_the_entries() {
    let tree = Tree::new();
    tree.write("a.txt", b"x");
    let watcher = watcher();
    let entries = watcher.snapshot(&tree.root).expect("snapshot");
    assert!(find(&entries, &tree.root).is_none());
}

#[cfg(unix)]
#[test]
fn a_symlinked_directory_is_reported_but_not_descended_into() {
    let tree = Tree::new();
    tree.mkdir("real");
    tree.write("real/inside.txt", b"x");
    std::os::unix::fs::symlink(&tree.root, tree.path("loop")).expect("symlink");

    let watcher = watcher();
    let entries = watcher.snapshot(&tree.root).expect("snapshot");

    let link = tree.path("loop");
    assert!(find(&entries, &link).is_some(), "the link itself is news");
    assert!(
        !entries
            .iter()
            .any(|entry| entry.path != link && entry.path.starts_with(&link)),
        "nothing may be reported through it: {:?}",
        entries.iter().map(|e| &e.path).collect::<Vec<_>>()
    );
}

#[test]
fn a_missing_path_is_not_found_rather_than_an_empty_snapshot() {
    let tree = Tree::new();
    let watcher = watcher();
    assert!(matches!(
        watcher.snapshot(&tree.path("gone")),
        Err(retrigger_system::WatchError::NotFound(_))
    ));
}

#[test]
fn watch_with_snapshot_registers_the_watch_and_returns_an_inventory() {
    let tree = Tree::new();
    tree.write("a.txt", b"present before the watch");

    let watcher = watcher();
    let entries = watcher
        .watch_with_snapshot(&tree.root, true)
        .expect("watch_with_snapshot");

    assert!(find(&entries, &tree.path("a.txt")).is_some());
    assert!(
        watcher.watched().iter().any(|(path, _)| path == &tree.root),
        "the path must be registered, not merely crawled"
    );
}

#[test]
fn watch_with_snapshot_reports_the_same_not_found_error_as_watch() {
    let tree = Tree::new();
    let watcher = watcher();
    assert!(matches!(
        watcher.watch_with_snapshot(&tree.path("gone"), true),
        Err(retrigger_system::WatchError::NotFound(_))
    ));
}

// --------------------------------------------------------------- diff_snapshots

#[test]
fn diff_of_identical_snapshots_is_empty() {
    let tree = Tree::new();
    tree.write("a.txt", b"hello");
    tree.mkdir("dir");
    let watcher = watcher();
    let snap = watcher.snapshot(&tree.root).expect("snapshot");
    assert!(diff_snapshots(&snap, &snap.clone()).is_empty());
}

#[test]
fn diff_reports_exactly_one_event_per_real_difference() {
    let tree = Tree::new();
    tree.write("unchanged.txt", b"same");
    tree.write("will_change.txt", b"before");
    tree.write("will_be_deleted.txt", b"gone soon");

    let watcher = watcher();
    let before = watcher.snapshot(&tree.root).expect("snapshot before");

    // Give the file system a modification-time tick coarser than some volumes' resolution.
    std::thread::sleep(Duration::from_millis(20));
    fs::write(tree.path("will_change.txt"), b"after, and longer").expect("rewrite");
    fs::remove_file(tree.path("will_be_deleted.txt")).expect("remove");
    tree.write("will_be_created.txt", b"new");

    let after = watcher.snapshot(&tree.root).expect("snapshot after");
    let mut events = diff_snapshots(&before, &after);
    events.sort_by(|a, b| a.path.cmp(&b.path));

    assert_eq!(
        events.len(),
        3,
        "exactly one event per real difference: {events:?}"
    );

    let created = find_event(&events, &tree.path("will_be_created.txt"));
    assert_eq!(created.kind, EventKind::Created);

    let deleted = find_event(&events, &tree.path("will_be_deleted.txt"));
    assert_eq!(deleted.kind, EventKind::Deleted);

    let modified = find_event(&events, &tree.path("will_change.txt"));
    assert_eq!(modified.kind, EventKind::Modified);
    assert_eq!(modified.size, "after, and longer".len() as u64);

    assert!(
        !events.iter().any(|e| e.path == tree.path("unchanged.txt")),
        "an untouched path must not appear in the diff"
    );
}

fn find_event<'a>(
    events: &'a [retrigger_system::FileEvent],
    path: &std::path::Path,
) -> &'a retrigger_system::FileEvent {
    events
        .iter()
        .find(|e| e.path == path)
        .unwrap_or_else(|| panic!("expected an event for {}", path.display()))
}

mod properties {
    use super::*;
    use proptest::prelude::*;
    use retrigger_system::SnapshotEntry;
    use std::path::PathBuf;

    /// Distinct paths a generated pair of snapshots may mention. Small and fixed, mirroring
    /// `processor.rs`'s own change-decision property: the model stays exact without a cache
    /// ceiling to reason about.
    const PATHS: usize = 6;

    fn path_for(idx: usize) -> PathBuf {
        PathBuf::from(format!("/snap/f{idx}"))
    }

    /// `(size, mtime)` if the path exists in a given snapshot, `None` if it does not.
    type EntryState = Option<(u64, u64)>;

    /// An entry that may or may not be present, with a size/mtime pair drawn from a tiny domain so
    /// that equal draws are common and the "unchanged" case is actually exercised.
    fn maybe_entry() -> impl Strategy<Value = EntryState> {
        prop_oneof![Just(None), (0u64..4, 0u64..4).prop_map(Some)]
    }

    fn snapshot_pair() -> impl Strategy<Value = (Vec<EntryState>, Vec<EntryState>)> {
        (
            prop::collection::vec(maybe_entry(), PATHS),
            prop::collection::vec(maybe_entry(), PATHS),
        )
    }

    fn build(states: &[EntryState]) -> Vec<SnapshotEntry> {
        states
            .iter()
            .enumerate()
            .filter_map(|(idx, state)| {
                state.map(|(size, mtime)| SnapshotEntry {
                    path: path_for(idx),
                    is_directory: false,
                    size,
                    modified_ns: Some(mtime),
                })
            })
            .collect()
    }

    proptest! {
        #![proptest_config(ProptestConfig { cases: 128, ..ProptestConfig::default() })]

        /// Whatever two independent before/after states a tree could be in, `diff_snapshots` must
        /// report exactly the paths whose presence or (size, mtime) actually changed — a created
        /// event for anything that appeared, a deleted event for anything that vanished, a modified
        /// event for anything present in both whose fingerprint moved, and silence for everything
        /// that did not change at all. Mirrors `processor.rs`'s `change_decisions_track_the_bytes_on_disk`.
        #[test]
        fn diff_matches_the_independent_reference_model(
            (before_states, after_states) in snapshot_pair()
        ) {
            let before = build(&before_states);
            let after = build(&after_states);
            let events = diff_snapshots(&before, &after);

            for idx in 0..PATHS {
                let path = path_for(idx);
                let was = before_states[idx];
                let is = after_states[idx];
                let event = events.iter().find(|e| e.path == path);

                match (was, is) {
                    (None, None) => prop_assert!(event.is_none(), "never existed: {path:?}"),
                    (None, Some(_)) => {
                        prop_assert_eq!(event.map(|e| e.kind), Some(EventKind::Created));
                    }
                    (Some(_), None) => {
                        prop_assert_eq!(event.map(|e| e.kind), Some(EventKind::Deleted));
                    }
                    (Some(before_state), Some(after_state)) => {
                        if before_state == after_state {
                            prop_assert!(event.is_none(), "unchanged fingerprint must be silent: {path:?}");
                        } else {
                            prop_assert_eq!(event.map(|e| e.kind), Some(EventKind::Modified));
                        }
                    }
                }
            }

            // No event may exist for a path outside the ones just checked, and no path may produce
            // more than one event.
            prop_assert!(events.len() <= PATHS);
            let mut seen = std::collections::HashSet::new();
            for event in &events {
                prop_assert!(seen.insert(event.path.clone()), "duplicate event for {:?}", event.path);
            }
        }
    }
}
