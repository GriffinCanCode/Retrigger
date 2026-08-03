//! [`WatcherConfig::await_write_finish`] against real files.

mod common;

use std::time::Duration;

use common::{arm, collect_until, drain_for, render, Tree, DEADLINE};
use retrigger_system::{AwaitWriteFinishConfig, EventKind, Watcher, WatcherConfig};

const POLL_INTERVAL: Duration = Duration::from_millis(30);
const STABILITY_THRESHOLD: Duration = Duration::from_millis(150);

fn stabilizing_watcher_for(tree: &Tree) -> Watcher {
    let watcher = Watcher::new(WatcherConfig {
        debounce: Duration::ZERO,
        await_write_finish: Some(AwaitWriteFinishConfig {
            poll_interval: POLL_INTERVAL,
            stability_threshold: STABILITY_THRESHOLD,
        }),
        ..Default::default()
    })
    .expect("create watcher");
    watcher.watch(&tree.root, true).expect("watch root");
    watcher.start().expect("start");
    arm(&watcher, tree);
    watcher
}

#[test]
fn a_chunked_write_yields_exactly_one_modified_once_it_stops() {
    let tree = Tree::new();
    let watcher = stabilizing_watcher_for(&tree);
    let path = tree.path("growing.bin");

    // Each chunk lands well inside `STABILITY_THRESHOLD` of the last, so the whole write must
    // coalesce into the single `Modified` that fires only once the file goes quiet.
    for chunk in 0..5u8 {
        std::fs::write(&path, vec![chunk; 4096 * usize::from(chunk + 1)]).expect("write chunk");
        std::thread::sleep(STABILITY_THRESHOLD / 3);
    }

    let events = collect_until(&watcher, DEADLINE, |seen| {
        seen.iter()
            .any(|e| e.path == path && e.kind == EventKind::Modified)
    });
    let modifications: Vec<_> = events
        .iter()
        .filter(|e| e.path == path && e.kind == EventKind::Modified)
        .collect();
    assert_eq!(
        modifications.len(),
        1,
        "expected exactly one Modified for a chunked write, saw:\n{}",
        render(&events)
    );

    // Nothing further arrives once the file has settled and stayed settled.
    let extra = drain_for(&watcher, STABILITY_THRESHOLD * 2);
    assert!(
        extra
            .iter()
            .all(|e| e.path != path || e.kind != EventKind::Modified),
        "a settled file kept reporting Modified after its one stabilized event:\n{}",
        render(&extra)
    );
}

#[test]
fn a_delete_during_stabilization_is_delivered_promptly_and_cancels_it() {
    let tree = Tree::new();
    let watcher = stabilizing_watcher_for(&tree);
    let path = tree.write("doomed.bin", b"first chunk");

    // Enter stabilization, then remove the path before it would ever settle on its own.
    std::fs::write(&path, b"second chunk, still growing").expect("second chunk");
    std::thread::sleep(POLL_INTERVAL);
    std::fs::remove_file(&path).expect("remove");

    let events = collect_until(&watcher, DEADLINE, |seen| {
        seen.iter()
            .any(|e| e.path == path && e.kind == EventKind::Deleted)
    });
    assert!(
        events
            .iter()
            .any(|e| e.path == path && e.kind == EventKind::Deleted),
        "a delete during stabilization was never delivered:\n{}",
        render(&events)
    );
    // The hold must not outlive the deletion: no stale Modified for a path that is now gone.
    let extra = drain_for(&watcher, STABILITY_THRESHOLD * 2);
    assert!(
        extra
            .iter()
            .all(|e| e.path != path || e.kind != EventKind::Modified),
        "a canceled stabilization still delivered a stale Modified:\n{}",
        render(&extra)
    );
}
