//! [`WatcherConfig::atomic_write_normalization`] against a real temp-write-then-rename-over-target
//! save, the shape `normalize_atomic_write`'s own unit test (in `watcher.rs`) only ever exercises
//! synthetically. This is the real-filesystem companion: it proves the flag actually changes what
//! a genuine editor-style atomic save delivers, not merely what the pure function returns.

mod common;

use std::time::Duration;

use common::{arm, collect_until, expect_event, has_event, render, Tree, DEADLINE};
use retrigger_system::{EventKind, Watcher, WatcherConfig};

fn watcher_with(tree: &Tree, atomic_write_normalization: bool) -> Watcher {
    let watcher = Watcher::new(WatcherConfig {
        debounce: Duration::ZERO,
        atomic_write_normalization,
        ..Default::default()
    })
    .expect("create watcher");
    watcher.watch(&tree.root, true).expect("watch root");
    watcher.start().expect("start");
    arm(&watcher, tree);
    watcher
}

/// Write a sibling temp file and rename it over `target`, the editor/`fsync`-then-`rename` save
/// this flag exists for.
fn atomic_save_over(tree: &Tree, target_name: &str) {
    let tmp_name = format!("{target_name}.tmp");
    tree.write(&tmp_name, b"{\"v\":2}");
    tree.rename(&tmp_name, target_name);
}

#[test]
fn atomic_write_normalization_folds_a_real_atomic_save_into_one_modified() {
    let tree = Tree::new();
    let watcher = watcher_with(&tree, true);
    // Created (not merely present on disk before the watcher started) so the path is already
    // "announced" by the time the atomic save's `RenamedTo` arrives -- an unannounced path's
    // `RenamedTo` is a genuine arrival regardless of the flag, by design (see
    // `normalize_atomic_write`'s doc comment).
    let target = tree.write("config.json", b"{\"v\":1}");
    let created = collect_until(&watcher, DEADLINE, |seen| {
        has_event(seen, &target, EventKind::Created)
    });
    expect_event(&created, &target, EventKind::Created);

    atomic_save_over(&tree, "config.json");

    let events = collect_until(&watcher, DEADLINE, |seen| {
        has_event(seen, &target, EventKind::Modified)
    });
    expect_event(&events, &target, EventKind::Modified);

    let modifications = events
        .iter()
        .filter(|e| e.path == target && e.kind == EventKind::Modified)
        .count();
    assert_eq!(
        modifications,
        1,
        "expected exactly one Modified for a normalized atomic save, saw:\n{}",
        render(&events)
    );
    assert!(
        !has_event(&events, &target, EventKind::RenamedTo),
        "atomic_write_normalization: true must fold RenamedTo away entirely, saw:\n{}",
        render(&events)
    );
}

#[test]
fn atomic_write_normalization_off_by_default_still_delivers_the_unfolded_rename() {
    let tree = Tree::new();
    let target = tree.write("config.json", b"{\"v\":1}");
    // `..Default::default()` here, not an explicit `false` -- the point is that the crate's
    // documented default (`atomic_write_normalization: false`) is what leaves this un-normalized,
    // proving the companion test above is the flag's doing and not a coincidence of the scenario.
    let watcher = watcher_with(&tree, WatcherConfig::default().atomic_write_normalization);

    atomic_save_over(&tree, "config.json");

    let events = collect_until(&watcher, DEADLINE, |seen| {
        has_event(seen, &target, EventKind::RenamedTo)
    });
    expect_event(&events, &target, EventKind::RenamedTo);
    assert!(
        !has_event(&events, &target, EventKind::Modified),
        "an un-normalized atomic save should not also report Modified for the same rename:\n{}",
        render(&events)
    );
}
