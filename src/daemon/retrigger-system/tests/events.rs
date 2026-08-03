//! End-to-end tests against the real file system.
//!
//! These are the tests that decide whether this crate works on someone else's machine: they make
//! actual file system changes and assert on what the kernel reports back.

mod common;

use std::time::Duration;

use common::{
    arm, collect_until, expect_event, has_event, mentions, render, wait_for, Tree, DEADLINE, GRACE,
};
use retrigger_system::{EventKind, Watcher, WatcherConfig};

/// A watcher with coalescing disabled, so tests see the raw event shape.
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

#[test]
fn creating_a_file_is_reported() {
    let tree = Tree::new();
    let watcher = watcher_for(&tree, true);

    let path = tree.write("created.txt", b"hello");
    let events = collect_until(&watcher, DEADLINE, |seen| {
        has_event(seen, &path, EventKind::Created)
    });

    let event = expect_event(&events, &path, EventKind::Created);
    assert!(!event.is_directory);
    assert!(
        event.timestamp_ns > 1_577_836_800_000_000_000,
        "timestamp should be nanoseconds since the epoch, got {}",
        event.timestamp_ns
    );
}

#[test]
fn creating_a_file_reports_its_size() {
    let tree = Tree::new();
    let watcher = watcher_for(&tree, true);

    let path = tree.write("sized.txt", b"0123456789");
    let events = collect_until(&watcher, DEADLINE, |seen| {
        seen.iter()
            .any(|event| event.path == path && event.size == 10)
    });
    assert!(
        events
            .iter()
            .any(|event| event.path == path && event.size == 10),
        // The size is stat'd when the event is processed, so a create observed before the write
        // completes legitimately reports 0; some event for this path must see the final size.
        "no event reported the final size of {}\nsaw:\n{}",
        path.display(),
        render(&events)
    );
}

#[test]
fn modifying_a_file_is_reported() {
    let tree = Tree::new();
    // Created before the watcher starts, so the only event under test is the modification.
    tree.write("existing.txt", b"before");
    let watcher = watcher_for(&tree, true);

    let path = tree.write("existing.txt", b"after!");
    let events = collect_until(&watcher, DEADLINE, |seen| {
        has_event(seen, &path, EventKind::Modified)
    });
    expect_event(&events, &path, EventKind::Modified);
}

#[test]
fn deleting_a_file_is_reported() {
    let tree = Tree::new();
    tree.write("doomed.txt", b"x");
    let watcher = watcher_for(&tree, true);

    let path = tree.remove("doomed.txt");
    let events = collect_until(&watcher, DEADLINE, |seen| {
        has_event(seen, &path, EventKind::Deleted)
    });
    let event = expect_event(&events, &path, EventKind::Deleted);
    assert_eq!(event.size, 0, "a deleted file has no size to report");
}

#[test]
fn renaming_a_file_reports_both_sides() {
    let tree = Tree::new();
    tree.write("old.txt", b"x");
    let watcher = watcher_for(&tree, true);

    let (from, to) = tree.rename("old.txt", "new.txt");
    let events = collect_until(&watcher, DEADLINE, |seen| {
        has_event(seen, &from, EventKind::RenamedFrom) && has_event(seen, &to, EventKind::RenamedTo)
    });

    let source = expect_event(&events, &from, EventKind::RenamedFrom);
    let target = expect_event(&events, &to, EventKind::RenamedTo);

    #[cfg(target_os = "linux")]
    {
        // inotify carries a rename cookie, so the two sides are genuinely correlated.
        assert!(
            source.cookie.is_some() && source.cookie == target.cookie,
            "inotify should correlate the rename pair: {:?} vs {:?}",
            source.cookie,
            target.cookie
        );
    }
    #[cfg(target_os = "macos")]
    {
        // FSEvents provides no correlation identifier for renames — notify's own backend says so
        // in as many words ("FSEvents provides no mechanism to associate the old and new sides of
        // a rename"). This crate therefore reports `cookie: None` on macOS and infers which side
        // a path is from whether it still exists. Asserted rather than wished away.
        assert_eq!(source.cookie, None, "FSEvents cannot correlate renames");
        assert_eq!(target.cookie, None, "FSEvents cannot correlate renames");
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = (&source, &target);
    }
}

#[test]
fn directory_creation_and_removal_are_flagged_as_directories() {
    let tree = Tree::new();
    let watcher = watcher_for(&tree, true);

    let dir = tree.mkdir("subdir");
    let created = collect_until(&watcher, DEADLINE, |seen| {
        has_event(seen, &dir, EventKind::Created)
    });
    assert!(
        expect_event(&created, &dir, EventKind::Created).is_directory,
        "a created directory must be flagged as one"
    );

    std::fs::remove_dir(&dir).expect("remove dir");
    let removed = collect_until(&watcher, DEADLINE, |seen| {
        has_event(seen, &dir, EventKind::Deleted)
    });
    let deleted = expect_event(&removed, &dir, EventKind::Deleted);

    // The removal is always reported; whether it is known to have been a directory depends on the
    // backend, because the path is gone by the time anyone could stat it.
    #[cfg(not(windows))]
    assert!(
        deleted.is_directory,
        "a removed directory can no longer be stat'd, so the backend hint must be used"
    );
    #[cfg(windows)]
    {
        // ReadDirectoryChangesW reports FILE_ACTION_REMOVED with no indication of what was
        // removed, so notify yields RemoveKind::Any and this crate has no hint to carry. Asserted
        // rather than skipped: the flag must be a truthful `false`, not a guess that happens to
        // be right on the other platforms.
        assert!(
            !deleted.is_directory,
            "Windows cannot know the type of a removed entry, so it must not claim to"
        );
    }
}

#[test]
fn recursive_watching_reports_nested_changes() {
    let tree = Tree::new();
    tree.mkdir("a/b/c");
    let watcher = watcher_for(&tree, true);

    let path = tree.write("a/b/c/deep.txt", b"deep");
    let events = collect_until(&watcher, DEADLINE, |seen| {
        has_event(seen, &path, EventKind::Created)
    });
    expect_event(&events, &path, EventKind::Created);
}

#[test]
fn directories_created_after_the_watch_started_are_also_watched() {
    let tree = Tree::new();
    let watcher = watcher_for(&tree, true);

    // The classic inotify gap: a watch descriptor exists per directory, so a directory created
    // after the watch was installed needs one adding, and a file written into it before that
    // happens is invisible. Waiting for the directory's own event and then retrying the nested
    // write asserts what actually matters — that new subdirectories *do* become watched.
    let dir = tree.mkdir("late");
    let created = collect_until(&watcher, DEADLINE, |seen| {
        has_event(seen, &dir, EventKind::Created)
    });
    expect_event(&created, &dir, EventKind::Created);

    let deadline = std::time::Instant::now() + DEADLINE;
    let mut attempt = 0;
    let observed = loop {
        assert!(
            std::time::Instant::now() < deadline,
            "a directory created after the watch started never became watched"
        );
        let path = tree.write(format!("late/nested-{attempt}.txt"), b"x");
        if let Some(event) = wait_for(&watcher, Duration::from_millis(500), |event| {
            event.path == path
        }) {
            break event;
        }
        attempt += 1;
    };
    assert!(observed.path.starts_with(&dir));
}

#[test]
fn non_recursive_watching_ignores_nested_changes() {
    let tree = Tree::new();
    let subdir = tree.mkdir("sub");
    let watcher = watcher_for(&tree, false);

    let nested = tree.write("sub/hidden.txt", b"x");
    let direct = tree.write("visible.txt", b"x");

    let events = collect_until(&watcher, DEADLINE, |seen| {
        has_event(seen, &direct, EventKind::Created)
    });
    expect_event(&events, &direct, EventKind::Created);

    // The nested write cannot be proven absent without a window; the direct event above already
    // proves the pipeline was live throughout it.
    let mut all = events;
    all.extend(common::drain_for(&watcher, GRACE));
    assert!(
        !mentions(&all, &nested),
        "a non-recursive watch must not report {}\nsaw:\n{}",
        nested.display(),
        render(&all)
    );
    // The subdirectory is a direct child, so events about the directory *itself* are in scope and
    // are not asserted against here.
    assert!(all.iter().all(|event| event.path != nested));
    let _ = subdir;
}

#[test]
fn watching_a_single_file_reports_only_that_file() {
    let tree = Tree::new();
    let watched = tree.write("watched.txt", b"x");
    let ignored = tree.write("ignored.txt", b"x");

    let watcher = Watcher::new(WatcherConfig {
        debounce: Duration::ZERO,
        ..Default::default()
    })
    .expect("create watcher");
    watcher.watch(&watched, false).expect("watch file");
    watcher.start().expect("start");

    // Cannot use the shared `arm` helper: only one file is in scope, so the sentinel must be that
    // file. Retry until its own modification is observed.
    let deadline = std::time::Instant::now() + DEADLINE;
    loop {
        assert!(
            std::time::Instant::now() < deadline,
            "single-file watch never became live"
        );
        std::fs::write(&watched, b"arming").expect("write");
        if wait_for(&watcher, Duration::from_millis(500), |event| {
            event.path == watched
        })
        .is_some()
        {
            break;
        }
    }

    std::fs::write(&ignored, b"changed").expect("write");
    std::fs::write(&watched, b"changed too").expect("write");
    let events = collect_until(&watcher, DEADLINE, |seen| {
        seen.iter()
            .any(|event| event.path == watched && event.kind == EventKind::Modified)
    });

    let mut all = events;
    all.extend(common::drain_for(&watcher, GRACE));
    assert!(
        !mentions(&all, &ignored),
        "watching one file must not report its siblings\nsaw:\n{}",
        render(&all)
    );
}

#[test]
fn non_ascii_paths_are_reported_intact() {
    let tree = Tree::new();
    let watcher = watcher_for(&tree, true);

    // Only characters with no combining-mark decomposition: macOS file systems may normalize
    // precomposed Latin accents, which would change the bytes and make a path comparison a test
    // of Unicode normalization rather than of the watcher.
    let path = tree.write("テスト ファイル 🚀.txt", b"unicode");
    let events = collect_until(&watcher, DEADLINE, |seen| {
        has_event(seen, &path, EventKind::Created)
    });
    expect_event(&events, &path, EventKind::Created);
}

#[test]
fn awkward_but_legal_filenames_are_reported() {
    let tree = Tree::new();
    let watcher = watcher_for(&tree, true);

    let mut names = vec![
        "with spaces.txt",
        "we [ird] (name) {here}.txt",
        "dash-heavy--name.txt",
        "..dotted..txt",
    ];
    // Legal on Unix, unrepresentable on Windows: the Win32 namespace reserves these outright, so
    // there is no file here to report and the test would be measuring `create` rather than the
    // watcher. Kept as a Unix case instead of dropped, because a glob-shaped name reaching a
    // filter unescaped is a real bug on the platforms that allow one.
    if cfg!(unix) {
        names.extend(["star*name.txt", "question?name.txt", "pipe|name.txt"]);
    }

    for name in names {
        let path = tree.write(name, b"x");
        let events = collect_until(&watcher, DEADLINE, |seen| {
            has_event(seen, &path, EventKind::Created)
        });
        expect_event(&events, &path, EventKind::Created);
    }
}

#[test]
fn very_long_paths_are_reported() {
    let tree = Tree::new();
    let watcher = watcher_for(&tree, true);

    // Each component stays under the 255-byte per-component limit while the whole path comfortably
    // exceeds what a fixed-size buffer would hold.
    let component = "l".repeat(200);
    let relative = format!("{component}/{component}/{component}");
    tree.mkdir(&relative);
    let path = tree.write(format!("{relative}/deep.txt"), b"x");
    assert!(path.as_os_str().len() > 600, "path was not long enough");

    let events = collect_until(&watcher, DEADLINE, |seen| {
        has_event(seen, &path, EventKind::Created)
    });
    expect_event(&events, &path, EventKind::Created);
}

#[cfg(unix)]
#[test]
fn filenames_containing_a_newline_are_reported() {
    let tree = Tree::new();
    let watcher = watcher_for(&tree, true);

    let path = tree.write("line\nbreak.txt", b"x");
    let events = collect_until(&watcher, DEADLINE, |seen| {
        has_event(seen, &path, EventKind::Created)
    });
    expect_event(&events, &path, EventKind::Created);
}

#[test]
fn rapid_churn_either_reports_everything_or_asks_for_a_rescan() {
    const FILES: usize = 400;

    let tree = Tree::new();
    let watcher = Watcher::new(WatcherConfig {
        capacity: 16_384,
        debounce: Duration::ZERO,
        ..Default::default()
    })
    .expect("create watcher");
    watcher.watch(&tree.root, true).expect("watch");
    watcher.start().expect("start");
    arm(&watcher, &tree);

    let mut expected = Vec::with_capacity(FILES);
    for i in 0..FILES {
        expected.push(tree.write(format!("churn/f{i}.txt"), b"x"));
    }

    let mut seen = collect_until(&watcher, DEADLINE, |seen| {
        seen.iter().any(FileEventExt::is_rescan_event)
            || expected
                .iter()
                .all(|path| seen.iter().any(|event| &event.path == path))
    });
    seen.extend(common::drain_for(&watcher, GRACE));

    let rescan_requested = seen.iter().any(FileEventExt::is_rescan_event);
    let missing: Vec<_> = expected
        .iter()
        .filter(|path| !seen.iter().any(|event| &event.path == *path))
        .collect();

    assert!(
        rescan_requested || missing.is_empty(),
        "{} of {FILES} files produced no event and no rescan was requested; \
         silent loss is the one outcome that is not allowed. missing (first 5): {:?}",
        missing.len(),
        missing.iter().take(5).collect::<Vec<_>>()
    );

    let stats = watcher.stats();
    common::assert_stats_invariant(&stats);
    assert!(
        stats.queue_pending <= stats.queue_capacity + 1,
        "queue grew past its bound: {stats:?}"
    );

    // Deleting the same files must not lose anything either.
    for path in &expected {
        std::fs::remove_file(path).expect("remove");
    }
    let deletes = collect_until(&watcher, DEADLINE, |seen| {
        seen.iter().any(FileEventExt::is_rescan_event)
            || seen
                .iter()
                .filter(|event| event.kind == EventKind::Deleted)
                .count()
                >= FILES
    });
    assert!(
        deletes.iter().any(FileEventExt::is_rescan_event)
            || deletes
                .iter()
                .filter(|event| event.kind == EventKind::Deleted)
                .count()
                >= FILES,
        "saw {} deletes of {FILES} and no rescan request",
        deletes
            .iter()
            .filter(|event| event.kind == EventKind::Deleted)
            .count()
    );
}

/// Small extension trait so predicates read cleanly.
trait FileEventExt {
    fn is_rescan_event(&self) -> bool;
}

impl FileEventExt for retrigger_system::FileEvent {
    fn is_rescan_event(&self) -> bool {
        self.kind == EventKind::RescanRequired
    }
}

#[tokio::test]
async fn subscribers_receive_events_too() {
    let tree = Tree::new();
    let watcher = Watcher::new(WatcherConfig {
        debounce: Duration::ZERO,
        ..Default::default()
    })
    .expect("create watcher");
    watcher.watch(&tree.root, true).expect("watch");
    watcher.start().expect("start");
    arm(&watcher, &tree);

    let mut subscriber = watcher.subscribe();
    let path = tree.write("broadcast.txt", b"x");

    let received = tokio::time::timeout(DEADLINE, async {
        loop {
            match subscriber.recv().await {
                Ok(event) if event.path == path => return event,
                Ok(_) => {}
                Err(err) => panic!("subscriber failed: {err}"),
            }
        }
    })
    .await
    .expect("subscriber received the event before the deadline");

    assert_eq!(received.path, path);
    assert!(
        watcher.poll().is_some(),
        "broadcasting must not consume the queue: both paths get every event"
    );
}
