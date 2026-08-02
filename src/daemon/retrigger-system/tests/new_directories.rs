//! The create-then-write race, which is the single most common shape of real-world change.
//!
//! `mkdir -p dist && write dist/bundle.js` is what every build step, package installer and archive
//! extraction does. On a backend that watches per directory (inotify) the write lands before the new
//! directory has a watch descriptor, so the kernel reports it to nobody — see the `scan` module.
//!
//! These tests do the two operations back to back with **no wait in between**, which is what makes
//! them a probe of the race rather than a demonstration that watching works. Each one repeats,
//! because a race that is lost one time in ten is still a bug and a single pass would hide it.
//!
//! What is asserted is that the entry is **reported**, not which kind reports it, and that is a
//! deliberate statement of the contract rather than a hedge. A file created inside the window can
//! have its `IN_CREATE` fall on the unwatched side and its `IN_MODIFY` on the watched side, in which
//! case the kernel's own first word about the file is `Modified`; the synthesized `Created` behind it
//! is then a restatement and is de-duplicated away. Measured on Linux, that happens in roughly one
//! round in a hundred. A consumer is told the file changed either way, which is the guarantee that
//! matters; the tests that pin an exact kind are the ones where the platform makes it deterministic.

mod common;

use std::fs;
use std::time::Duration;

use common::{
    arm, arm_with, collect_until, expect_event, has_event, mentions, render, Tree, DEADLINE, GRACE,
};
use retrigger_system::{EventFilter, EventKind, Watcher, WatcherConfig};

/// Coalescing off, so nothing here can pass by accident of a suppressed duplicate.
fn watcher_for(tree: &Tree, recursive: bool) -> Watcher {
    let watcher = Watcher::new(WatcherConfig {
        capacity: 16_384,
        debounce: Duration::ZERO,
        ..Default::default()
    })
    .expect("create watcher");
    watcher.watch(&tree.root, recursive).expect("watch root");
    watcher.start().expect("start");
    arm(&watcher, tree);
    watcher
}

/// How many times a race is retried before it is believed.
const ROUNDS: usize = 20;

#[test]
fn a_file_written_into_a_directory_created_in_the_same_breath_is_reported() {
    let tree = Tree::new();
    let watcher = watcher_for(&tree, true);

    for round in 0..ROUNDS {
        // One `Tree::write` call: `create_dir_all` immediately followed by `write`, with nothing in
        // between for a watch descriptor to be installed in.
        let path = tree.write(format!("fresh-{round}/bundle.js"), b"x");
        let events = collect_until(&watcher, DEADLINE, |seen| mentions(seen, &path));
        assert!(
            mentions(&events, &path),
            "round {round}: a file written into a directory as it was created was never reported\n{}",
            render(&events)
        );
    }
}

#[test]
fn a_file_written_into_a_deeply_nested_new_directory_is_reported() {
    let tree = Tree::new();
    let watcher = watcher_for(&tree, true);

    for round in 0..ROUNDS {
        // `mkdir -p a/b/c` produces one creation event, for `a`. Everything below it appears
        // without any event at all, so reaching the file means the scan descended.
        let path = tree.write(format!("deep-{round}/a/b/c/module.ts"), b"x");
        let events = collect_until(&watcher, DEADLINE, |seen| mentions(seen, &path));
        assert!(
            mentions(&events, &path),
            "round {round}: {} was never reported\n{}",
            path.display(),
            render(&events)
        );
    }
}

#[test]
fn every_file_of_a_burst_into_a_new_directory_is_reported() {
    const FILES: usize = 100;

    let tree = Tree::new();
    let watcher = watcher_for(&tree, true);

    for round in 0..3 {
        let mut expected = Vec::with_capacity(FILES);
        for i in 0..FILES {
            expected.push(tree.write(format!("burst-{round}/f{i}.txt"), b"x"));
        }

        let mut seen = collect_until(&watcher, DEADLINE, |seen| {
            seen.iter()
                .any(|event| event.kind == EventKind::RescanRequired)
                || expected
                    .iter()
                    .all(|path| seen.iter().any(|event| &event.path == path))
        });
        seen.extend(common::drain_for(&watcher, GRACE));

        let missing: Vec<_> = expected
            .iter()
            .filter(|path| !seen.iter().any(|event| &event.path == *path))
            .collect();
        assert!(
            seen.iter()
                .any(|event| event.kind == EventKind::RescanRequired)
                || missing.is_empty(),
            "round {round}: {} of {FILES} files written into a brand-new directory were lost \
             silently. missing (first 5): {:?}",
            missing.len(),
            &missing.iter().take(5).collect::<Vec<_>>()
        );
    }
}

#[test]
fn a_tree_moved_into_the_watch_root_reports_its_contents() {
    let tree = Tree::new();
    // Staged outside the watched directory so nothing about building it is observed, then moved in
    // as a single rename — the shape of `npm install` publishing a package and of `git worktree`.
    let staging = tree.mkdir("staging");
    let watched = tree.mkdir("watched");

    let watcher = Watcher::new(WatcherConfig {
        capacity: 16_384,
        debounce: Duration::ZERO,
        ..Default::default()
    })
    .expect("create watcher");
    watcher.watch(&watched, true).expect("watch");
    watcher.start().expect("start");
    arm_with(&watcher, &tree, |attempt| {
        format!("watched/retrigger-arm-{attempt}.armed")
    });

    let source = staging.join("package");
    fs::create_dir_all(source.join("lib/nested")).expect("mkdir");
    let mut expected = Vec::new();
    for name in ["index.js", "lib/util.js", "lib/nested/deep.js"] {
        let path = source.join(name);
        fs::write(&path, b"x").expect("write");
        expected.push(path);
    }

    let destination = watched.join("package");
    fs::rename(&source, &destination).expect("rename into the watch root");
    let expected: Vec<_> = expected
        .iter()
        .map(|path| {
            destination.join(
                path.strip_prefix(&source)
                    .expect("staged paths are under the staging root"),
            )
        })
        .collect();

    let mut seen = collect_until(&watcher, DEADLINE, |seen| {
        expected
            .iter()
            .all(|path| seen.iter().any(|event| &event.path == path))
    });
    seen.extend(common::drain_for(&watcher, GRACE));

    // Here the kind *is* deterministic: nothing inside a renamed directory changes, so no backend
    // reports its contents at all and every one of these events can only have come from the scan.
    for path in &expected {
        assert!(
            has_event(&seen, path, EventKind::Created),
            "a tree moved into the watch root must report {} as created\n{}",
            path.display(),
            render(&seen)
        );
    }
    assert!(
        watcher.stats().events_synthesized > 0,
        "the contents of a moved-in tree can only be known by reading it, so the scan must be \
         visible in the statistics: {:?}",
        watcher.stats()
    );
}

#[test]
fn a_new_directory_is_not_reported_over_and_over() {
    let tree = Tree::new();
    let watcher = watcher_for(&tree, true);

    // The directory is read several times to outlast the backend arming its watch. Each pass
    // restates the same entries, so without the delivery ledger the consumer would see one event
    // per pass for every file.
    let path = tree.write("once/only.txt", b"x");
    let mut seen = collect_until(&watcher, DEADLINE, |seen| {
        has_event(seen, &path, EventKind::Created)
    });
    // Outlast the whole reconciliation tail before counting.
    seen.extend(common::drain_for(&watcher, Duration::from_millis(900)));

    // Only creations are counted: a synthesized event is always a `Created`, so repeat passes would
    // show up here and nowhere else. The trailing metadata/modify events of an ordinary write are
    // real, and coalescing is off for this watcher, so they are expected.
    let creations = seen
        .iter()
        .filter(|event| event.path == path && event.kind == EventKind::Created)
        .count();
    assert!(
        (1..=2).contains(&creations),
        "expected one creation for the file (two if a real event raced the scan), saw \
         {creations} across the whole reconciliation tail\n{}",
        render(&seen)
    );
}

#[test]
fn a_non_recursive_watch_does_not_scan_new_directories() {
    let tree = Tree::new();
    let watcher = watcher_for(&tree, false);

    // The directory itself is a direct child and so in scope; its contents are exactly what a
    // non-recursive watch promises not to report, and a scan must not smuggle them in.
    let nested = tree.write("sub/hidden.txt", b"x");
    let direct = tree.write("visible.txt", b"x");

    let mut seen = collect_until(&watcher, DEADLINE, |seen| {
        has_event(seen, &direct, EventKind::Created)
    });
    expect_event(&seen, &direct, EventKind::Created);
    seen.extend(common::drain_for(&watcher, GRACE));

    assert!(
        !common::mentions(&seen, &nested),
        "a non-recursive watch must not report {}\n{}",
        nested.display(),
        render(&seen)
    );
}

#[test]
fn an_excluded_subtree_is_not_scanned_into() {
    let tree = Tree::new();
    let watcher = Watcher::new(WatcherConfig {
        debounce: Duration::ZERO,
        filter: EventFilter::dev_defaults().expect("built-in patterns compile"),
        ..Default::default()
    })
    .expect("create watcher");
    watcher.watch(&tree.root, true).expect("watch root");
    watcher.start().expect("start");
    arm_with(&watcher, &tree, |attempt| format!("arm-{attempt}.js"));

    let vendored = tree.write("node_modules/react/index.js", b"x");
    let source = tree.write("app.js", b"x");

    let mut seen = collect_until(&watcher, DEADLINE, |seen| {
        has_event(seen, &source, EventKind::Created)
    });
    seen.extend(common::drain_for(&watcher, GRACE));

    expect_event(&seen, &source, EventKind::Created);
    assert!(
        !common::mentions(&seen, &vendored),
        "the scan must honour excludes; it is not a way around them\n{}",
        render(&seen)
    );
}

#[test]
fn nothing_is_synthesized_when_no_directory_appears() {
    let tree = Tree::new();
    let watcher = watcher_for(&tree, true);

    let path = tree.write("plain.txt", b"x");
    let seen = collect_until(&watcher, DEADLINE, |seen| {
        has_event(seen, &path, EventKind::Created)
    });
    expect_event(&seen, &path, EventKind::Created);

    let stats = watcher.stats();
    assert_eq!(
        stats.events_synthesized, 0,
        "writing into a directory that was already watched needs no scan: {stats:?}"
    );
    common::assert_stats_invariant(&stats);
}

#[test]
fn reconciliation_survives_the_directory_being_deleted_underneath_it() {
    let tree = Tree::new();
    let watcher = watcher_for(&tree, true);

    // A directory created and destroyed while its scan is still scheduled must not panic, hang, or
    // leave the watcher unable to report the next thing that happens.
    for round in 0..ROUNDS {
        let dir = tree.path(format!("doomed-{round}"));
        fs::create_dir_all(dir.join("inner")).expect("mkdir");
        fs::write(dir.join("inner/f.txt"), b"x").expect("write");
        fs::remove_dir_all(&dir).expect("remove");
    }

    let survivor = tree.write("survivor.txt", b"x");
    let seen = collect_until(&watcher, DEADLINE, |seen| {
        has_event(seen, &survivor, EventKind::Created)
    });
    expect_event(&seen, &survivor, EventKind::Created);
    common::assert_stats_invariant(&watcher.stats());
}
