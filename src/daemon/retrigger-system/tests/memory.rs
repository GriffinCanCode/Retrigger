//! Memory behaviour under the workloads that actually break file watchers.
//!
//! The rest of the suite asks whether events are correct. This one asks what the process is holding
//! afterwards, because the failure mode here is not a wrong answer — it is a dev server that has
//! been running for six hours and is now using two gigabytes.
//!
//! Four shapes, each chosen because it defeats a plausible bounding strategy:
//!
//! 1. **One file rewritten forever.** An agent or a formatter saving on a loop. Defeats any policy
//!    that keys memory to event *count* rather than distinct paths.
//! 2. **A whole tree changing at once.** `git checkout`, `npm install`, a code generator. Defeats
//!    age-based pruning: nothing is old enough to discard, so a cutoff frees nothing exactly when
//!    relief is needed.
//! 3. **A tree being deleted.** `rm -rf` on `node_modules`. Every cached entry becomes garbage at
//!    once, and the events describing it arrive after the paths are already gone.
//! 4. **Start/stop cycles.** A watcher restarted repeatedly must not accumulate anything per cycle.
//!
//! Assertions are on the accounting the crate exposes ([`ProcessorStats::entries`],
//! [`ProcessorStats::cache_bytes`], [`WatcherStats::queue_pending`]) rather than on process RSS.
//! RSS is the number a user ultimately cares about, but an allocator is free to hold freed pages,
//! so asserting on it produces a test that fails for reasons unrelated to this crate. What is
//! asserted instead is that the structures whose growth *would* drive RSS are bounded — and, for
//! the burst cases, that the bound holds while the workload is still running rather than only after
//! it has finished.

mod common;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::{arm, drain_for, wait_for, Tree, DEADLINE};
use retrigger_system::{
    EventKind, FileEvent, FileEventProcessor, Fnv1aHasher, ProcessorConfig, Watcher, WatcherConfig,
};

/// Rewrites of a single file. Large enough that a per-event leak would be unmistakable.
const HAMMER_WRITES: usize = 20_000;

/// Files in the simulated checkout. Large enough to overflow any sane queue.
const TREE_FILES: usize = 2_000;

/// An event as the watcher would report it, for feeding the processor directly.
///
/// Built by hand rather than by watching a tree: these tests are about what the processor retains
/// per event, so driving it with a known number of events beats depending on how many the kernel
/// chooses to coalesce.
fn event(path: &std::path::Path, kind: EventKind, is_directory: bool) -> FileEvent {
    FileEvent {
        path: path.to_path_buf(),
        kind,
        timestamp_ns: 0,
        size: 0,
        is_directory,
        cookie: None,
    }
}

fn modified(path: &std::path::Path) -> FileEvent {
    event(path, EventKind::Modified, false)
}

#[test]
fn an_agent_rewriting_one_file_holds_one_cache_entry() {
    // The single most likely workload to break this crate, per its own design notes: a file written
    // continuously. Memory must track the number of distinct *paths*, not the number of events, so
    // twenty thousand rewrites of one file must cost exactly what one file costs.
    let tree = Tree::new();
    let path = tree.write("src/app.ts", b"initial");
    let processor = FileEventProcessor::new();

    for i in 0..HAMMER_WRITES {
        std::fs::write(&path, format!("revision {i}").as_bytes()).expect("rewrite");
        let processed = processor.process(modified(&path));
        assert!(
            processed.content_changed,
            "each rewrite changed the bytes, so each must be reported at rewrite {i}"
        );
    }

    let stats = processor.stats();
    assert_eq!(
        stats.entries, 1,
        "{HAMMER_WRITES} rewrites of one file left {} cache entries",
        stats.entries
    );
    assert!(
        stats.cache_bytes < 4096,
        "one cached path should not cost {} bytes",
        stats.cache_bytes
    );
    assert_eq!(stats.files_hashed, HAMMER_WRITES as u64);
}

#[test]
fn identical_rewrites_are_absorbed_without_growth() {
    // The formatter-on-save case: the bytes never change, so nothing downstream should wake, and the
    // cache should not grow a second entry for a path it already knows.
    let tree = Tree::new();
    let path = tree.write("src/app.ts", b"stable");
    let processor = FileEventProcessor::new();

    assert!(processor.process(modified(&path)).content_changed);
    for _ in 0..HAMMER_WRITES {
        std::fs::write(&path, b"stable").expect("rewrite");
        assert!(!processor.process(modified(&path)).content_changed);
    }
    assert_eq!(processor.stats().entries, 1);
}

#[test]
fn a_checkout_sized_tree_cannot_grow_the_cache_past_its_ceiling() {
    // Age-based pruning fails here: every entry is seconds old, so a cutoff would free nothing while
    // the map grew to the size of the tree. The bound is checked *during* the flood, not just at the
    // end, because a policy that overshoots and then recovers still has to allocate the overshoot.
    const CEILING: usize = 256;
    let tree = Tree::new();
    let processor = FileEventProcessor::with_config(
        Fnv1aHasher,
        ProcessorConfig {
            max_entries: CEILING,
            ttl: Duration::from_secs(3600),
        },
    );

    for i in 0..TREE_FILES {
        let path = tree.write(
            format!("packages/pkg{}/src/module{i}.ts", i % 40),
            format!("export const value = {i};").as_bytes(),
        );
        let _ = processor.process(modified(&path));

        let stats = processor.stats();
        assert!(
            stats.entries <= CEILING,
            "cache held {} entries against a ceiling of {CEILING} at file {i}",
            stats.entries
        );
    }

    let stats = processor.stats();
    assert_eq!(stats.files_hashed, TREE_FILES as u64);
    // Every entry is a path from this tree, so the ceiling times a generous per-path allowance is a
    // real bound on the bytes and not merely on the count.
    let allowance = CEILING * (tree.root.as_os_str().len() + 256);
    assert!(
        stats.cache_bytes <= allowance,
        "cache held {} bytes for {} entries, expected at most {allowance}",
        stats.cache_bytes,
        stats.entries
    );
}

#[test]
fn the_file_under_active_editing_survives_a_concurrent_checkout() {
    // The two workloads at once, which is the realistic case: an agent editing one file while a
    // build tool rewrites everything else. The hot file must stay cached throughout — if churn can
    // evict it, the one path whose caching actually matters is the one that loses it.
    const CEILING: usize = 64;
    let tree = Tree::new();
    let hot = tree.write("src/being-edited.ts", b"v0");
    let processor = FileEventProcessor::with_config(
        Fnv1aHasher,
        ProcessorConfig {
            max_entries: CEILING,
            ttl: Duration::from_secs(3600),
        },
    );
    let _ = processor.process(modified(&hot));

    for i in 0..500 {
        let cold = tree.write(format!("vendor/dep{i}/index.js"), b"cold");
        let _ = processor.process(modified(&cold));

        // Unchanged bytes, so a cache hit is the only way this can report "no change".
        let processed = processor.process(modified(&hot));
        assert!(
            !processed.content_changed,
            "the hot file was evicted after {i} unrelated files and had to be re-hashed"
        );
        assert!(processed.cache_hit);
        assert!(processor.stats().entries <= CEILING);
    }
}

#[test]
fn deleting_a_tree_releases_everything_cached_beneath_it() {
    // `rm -rf node_modules`: one directory event has to invalidate everything under it, and it
    // arrives when the paths are already gone, so nothing may depend on being able to stat them.
    let tree = Tree::new();
    let processor = FileEventProcessor::new();
    let doomed = tree.mkdir("node_modules");

    for i in 0..500 {
        let path = tree.write(format!("node_modules/dep{i}/index.js"), b"x");
        let _ = processor.process(modified(&path));
    }
    let kept = tree.write("src/app.ts", b"keep");
    let _ = processor.process(modified(&kept));
    assert_eq!(processor.stats().entries, 501);

    std::fs::remove_dir_all(&doomed).expect("rm -rf");
    let processed = processor.process(event(&doomed, EventKind::Deleted, true));
    assert!(processed.content_changed);

    let stats = processor.stats();
    assert_eq!(
        stats.entries, 1,
        "only the untouched file outside the deleted tree should remain"
    );
    assert!(
        stats.cache_bytes > 0,
        "the surviving entry still costs bytes"
    );

    // Late child events for paths that no longer exist must not resurrect anything or panic.
    for i in 0..500 {
        let orphan = tree.path(format!("node_modules/dep{i}/index.js"));
        assert!(processor.process(modified(&orphan)).content_changed);
    }
    assert_eq!(
        processor.stats().entries,
        1,
        "unreadable paths must not be cached"
    );
}

#[test]
fn the_cache_is_reusable_after_being_cleared() {
    // A rescan drops everything and starts again. Capacity is released, and the structure still
    // works afterwards rather than being left in a degenerate state.
    let tree = Tree::new();
    let processor = FileEventProcessor::new();
    for i in 0..500 {
        let path = tree.write(format!("f{i}.ts"), b"x");
        let _ = processor.process(modified(&path));
    }
    assert!(processor.stats().cache_bytes > 0);

    processor.clear();
    let stats = processor.stats();
    assert_eq!(stats.entries, 0);
    assert_eq!(stats.cache_bytes, 0);

    let path = tree.write("after.ts", b"y");
    assert!(processor.process(modified(&path)).content_changed);
    assert!(!processor.process(modified(&path)).content_changed);
    assert_eq!(processor.stats().entries, 1);
}

#[test]
fn a_tree_wide_burst_overflows_the_queue_without_unbounded_growth() {
    // The watcher's own bound, through the public API. A deliberately small queue against a
    // checkout-sized burst: events must be dropped rather than buffered, the pending count must stay
    // inside the documented bound while the burst is in flight, and the loss must be reported.
    const CAPACITY: usize = 64;
    let tree = Tree::new();
    let watcher = Watcher::new(WatcherConfig {
        capacity: CAPACITY,
        debounce: Duration::ZERO,
        ..Default::default()
    })
    .expect("construct watcher");
    watcher.watch(&tree.root, true).expect("watch root");
    watcher.start().expect("start watcher");
    arm(&watcher, &tree);

    for i in 0..TREE_FILES {
        tree.write(format!("pkg{}/src/f{i}.ts", i % 20), b"burst");
        let pending = watcher.stats().queue_pending;
        assert!(
            pending <= CAPACITY + 1,
            "queue held {pending} events against a capacity of {CAPACITY} at file {i}"
        );
    }

    let seen = drain_for(&watcher, Duration::from_millis(750));
    let stats = watcher.stats();
    common::assert_stats_invariant(&stats);
    assert!(
        stats.events_dropped > 0,
        "a {TREE_FILES}-file burst through a {CAPACITY}-event queue must drop events; \
         saw queued={} delivered={} dropped={}",
        stats.events_queued,
        stats.events_delivered,
        stats.events_dropped
    );
    assert!(
        seen.iter().any(FileEvent::is_rescan),
        "dropping events must tell the consumer its view is no longer authoritative"
    );

    // Recovery: having overflowed, the watcher must still be a working watcher.
    let after = tree.write("src/after-the-storm.ts", b"hello");
    assert!(
        wait_for(&watcher, DEADLINE, |event| event.path == after).is_some(),
        "the watcher stopped delivering after an overflow episode"
    );
}

#[test]
fn draining_concurrently_with_a_burst_keeps_the_queue_near_empty() {
    // The healthy shape of the same workload: a consumer that keeps up. Nothing should accumulate,
    // and the counters must stay mutually consistent while both threads are running — the state
    // where a snapshot assembled from independent atomics would disagree with itself.
    let tree = Tree::new();
    let watcher = Arc::new(
        Watcher::new(WatcherConfig {
            capacity: 4096,
            debounce: Duration::ZERO,
            ..Default::default()
        })
        .expect("construct watcher"),
    );
    watcher.watch(&tree.root, true).expect("watch root");
    watcher.start().expect("start watcher");
    arm(&watcher, &tree);

    let stop = Arc::new(AtomicBool::new(false));
    let consumer = {
        let watcher = Arc::clone(&watcher);
        let stop = Arc::clone(&stop);
        std::thread::spawn(move || {
            let mut drained = 0usize;
            while !stop.load(Ordering::Relaxed) {
                if watcher.recv_timeout(Duration::from_millis(10)).is_some() {
                    drained += 1;
                }
                common::assert_stats_invariant(&watcher.stats());
            }
            drained
        })
    };

    for i in 0..TREE_FILES {
        tree.write(format!("pkg{}/f{i}.ts", i % 20), b"x");
    }
    // Give the consumer a bounded chance to catch up before asking whether it did.
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline && watcher.stats().queue_pending > 0 {
        std::thread::sleep(Duration::from_millis(10));
    }
    stop.store(true, Ordering::Relaxed);
    let drained = consumer.join().expect("consumer thread");

    let stats = watcher.stats();
    common::assert_stats_invariant(&stats);
    assert!(drained > 0, "the consumer received nothing at all");
    assert!(
        stats.queue_pending < stats.queue_capacity,
        "a keeping-up consumer left {} of {} slots occupied",
        stats.queue_pending,
        stats.queue_capacity
    );
}

#[test]
fn repeated_start_and_stop_cycles_accumulate_nothing() {
    // Restarts are a normal part of a dev server's life. Each cycle installs kernel watches, spawns
    // a backend thread, and tears both down; anything retained per cycle would be a slow leak that
    // only shows up after hours.
    let tree = Tree::new();
    let watcher = Watcher::new(WatcherConfig {
        capacity: 256,
        debounce: Duration::ZERO,
        ..Default::default()
    })
    .expect("construct watcher");
    watcher.watch(&tree.root, true).expect("watch root");

    for cycle in 0..12 {
        watcher.start().expect("start watcher");
        assert!(watcher.is_running());
        tree.write(format!("cycle{cycle}.ts"), b"x");
        let _ = drain_for(&watcher, Duration::from_millis(50));
        watcher.stop().expect("stop watcher");
        assert!(!watcher.is_running());

        let stats = watcher.stats();
        common::assert_stats_invariant(&stats);
        assert_eq!(
            stats.watched_paths, 1,
            "a restart re-registered the same path instead of reusing it, in cycle {cycle}"
        );
        assert!(
            stats.queue_pending <= stats.queue_capacity + 1,
            "cycle {cycle} left {} events pending",
            stats.queue_pending
        );
    }

    // Still functional after all that.
    watcher.start().expect("restart watcher");
    arm(&watcher, &tree);
    let path = tree.write("final.ts", b"x");
    assert!(wait_for(&watcher, DEADLINE, |event| event.path == path).is_some());
}

#[test]
fn a_subscriber_that_stops_reading_cannot_stall_the_watcher() {
    // Broadcast is lossy on purpose: a subscriber that falls behind must be the one that suffers.
    // If back-pressure reached the watcher instead, an abandoned receiver would pin every event it
    // never read — an unbounded hold created by a consumer that has stopped caring.
    let tree = Tree::new();
    let watcher = Watcher::new(WatcherConfig {
        capacity: 512,
        debounce: Duration::ZERO,
        ..Default::default()
    })
    .expect("construct watcher");
    watcher.watch(&tree.root, true).expect("watch root");
    let _abandoned = watcher.subscribe();
    watcher.start().expect("start watcher");
    arm(&watcher, &tree);

    for i in 0..TREE_FILES {
        tree.write(format!("f{i}.ts"), b"x");
    }

    // Drain the burst's backlog before introducing the sentinel. The queue is bounded and drops the
    // incoming event when it is full, so a sentinel born while the backlog still occupies every slot
    // would be dropped *by design* — that is the bound working, not the subscriber blocking, and the
    // difference is the whole point of this test. Bounded by `DEADLINE`, and each pass returns as
    // soon as a window passes with nothing in it.
    let settled = Instant::now() + DEADLINE;
    while Instant::now() < settled && !drain_for(&watcher, Duration::from_millis(100)).is_empty() {}

    let path = tree.write("still-alive.ts", b"x");
    assert!(
        wait_for(&watcher, DEADLINE, |event| event.path == path).is_some(),
        "an abandoned subscriber blocked delivery to the polling consumer"
    );
    common::assert_stats_invariant(&watcher.stats());
}
