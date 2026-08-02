//! Benchmarks for event delivery latency, throughput, and the hot CPU paths.
//!
//! The file system benchmarks measure the whole path a real change takes — `write(2)`, the kernel
//! notification mechanism, translation, filtering, coalescing, the queue, and delivery to the
//! consumer. That means they include kernel and file system latency, which dominates: the point is
//! to detect regressions in end-to-end behaviour, not to publish a figure for this crate's own
//! overhead in isolation. The CPU-only benchmarks below isolate the parts this crate controls.
//!
//! Run with `cargo bench -p retrigger-system`.

use std::hint::black_box;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use criterion::{criterion_group, criterion_main, BatchSize, Criterion, Throughput};
use retrigger_system::{
    ContentHasher, EventFilter, EventKind, FileEvent, FileEventProcessor, Fnv1aHasher, Watcher,
    WatcherConfig,
};
use tempfile::TempDir;

/// Anything slower than this is a hang, not a measurement.
const DEADLINE: Duration = Duration::from_secs(10);

struct Fixture {
    _dir: TempDir,
    root: PathBuf,
    watcher: Watcher,
}

impl Fixture {
    fn new(config: WatcherConfig) -> Self {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path().canonicalize().expect("canonicalize");
        let watcher = Watcher::new(config).expect("create watcher");
        watcher.watch(&root, true).expect("watch");
        watcher.start().expect("start");

        let fixture = Self {
            _dir: dir,
            root,
            watcher,
        };
        fixture.arm();
        fixture
    }

    /// Wait until the backend is demonstrably delivering, so the first measured iteration is not
    /// paying for stream startup.
    fn arm(&self) {
        let deadline = Instant::now() + DEADLINE;
        let mut attempt = 0;
        while Instant::now() < deadline {
            let path = self.root.join(format!("arm-{attempt}.txt"));
            std::fs::write(&path, b"arm").expect("write");
            if self.wait_for(&path, Duration::from_millis(250)) {
                self.drain();
                return;
            }
            attempt += 1;
        }
        panic!("watcher never became live");
    }

    fn wait_for(&self, path: &Path, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if let Some(event) = self.watcher.recv_timeout(Duration::from_millis(5)) {
                if event.path == path {
                    return true;
                }
            }
        }
        false
    }

    fn drain(&self) {
        while self.watcher.poll().is_some() {}
    }
}

/// Time from `write(2)` returning to the consumer holding the event.
fn event_latency(c: &mut Criterion) {
    let fixture = Fixture::new(WatcherConfig {
        debounce: Duration::ZERO,
        ..Default::default()
    });
    let mut counter = 0_u64;

    let mut group = c.benchmark_group("delivery");
    // File system benchmarks are orders of magnitude slower than CPU ones; a smaller sample keeps
    // the run bounded without making the estimate meaningless.
    group
        .sample_size(50)
        .measurement_time(Duration::from_secs(20));
    group.bench_function("single_event_latency", |b| {
        b.iter(|| {
            counter += 1;
            let path = fixture.root.join(format!("latency-{counter}.txt"));
            std::fs::write(&path, b"payload").expect("write");
            assert!(
                fixture.wait_for(&path, DEADLINE),
                "event for {} never arrived",
                path.display()
            );
            fixture.drain();
        });
    });
    group.finish();
}

/// Events per second through the whole pipeline for a burst of creations.
fn event_throughput(c: &mut Criterion) {
    const BURST: usize = 200;

    let fixture = Fixture::new(WatcherConfig {
        capacity: 16_384,
        debounce: Duration::ZERO,
        ..Default::default()
    });
    let mut round = 0_u64;

    let mut group = c.benchmark_group("delivery");
    group
        .sample_size(20)
        .measurement_time(Duration::from_secs(20));
    group.throughput(Throughput::Elements(BURST as u64));
    group.bench_function("burst_of_200_creations", |b| {
        b.iter(|| {
            round += 1;
            let dir = fixture.root.join(format!("burst-{round}"));
            std::fs::create_dir_all(&dir).expect("mkdir");
            for i in 0..BURST {
                std::fs::write(dir.join(format!("f{i}.txt")), b"x").expect("write");
            }
            // Count deliveries for this round's files only; the run is bounded so a lost event
            // fails the benchmark instead of hanging it.
            let deadline = Instant::now() + DEADLINE;
            let mut delivered = 0;
            while delivered < BURST && Instant::now() < deadline {
                match fixture.watcher.recv_timeout(Duration::from_millis(5)) {
                    Some(event) if event.path.starts_with(&dir) => {
                        if event.kind == EventKind::Created {
                            delivered += 1;
                        }
                    }
                    Some(_) => {}
                    None => {}
                }
            }
            assert_eq!(
                delivered, BURST,
                "only {delivered} of {BURST} events arrived"
            );
        });
    });
    group.finish();
}

/// A watcher over a subdirectory, with room beside it to stage a tree on the same file system.
struct MoveFixture {
    _dir: TempDir,
    staging: PathBuf,
    watched: PathBuf,
    watcher: Watcher,
}

impl MoveFixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path().canonicalize().expect("canonicalize");
        let staging = root.join("staging");
        let watched = root.join("watched");
        std::fs::create_dir_all(&staging).expect("mkdir");
        std::fs::create_dir_all(&watched).expect("mkdir");

        let watcher = Watcher::new(WatcherConfig {
            capacity: 65_536,
            debounce: Duration::ZERO,
            ..Default::default()
        })
        .expect("create watcher");
        watcher.watch(&watched, true).expect("watch");
        watcher.start().expect("start");

        let fixture = Self {
            _dir: dir,
            staging,
            watched,
            watcher,
        };
        // Arm inside the watched directory, since that is the only thing being observed.
        let deadline = Instant::now() + DEADLINE;
        let mut attempt = 0;
        while Instant::now() < deadline {
            let path = fixture.watched.join(format!("arm-{attempt}.txt"));
            std::fs::write(&path, b"arm").expect("write");
            let armed = Instant::now() + Duration::from_millis(250);
            while Instant::now() < armed {
                if fixture
                    .watcher
                    .recv_timeout(Duration::from_millis(5))
                    .is_some_and(|event| event.path == path)
                {
                    while fixture.watcher.poll().is_some() {}
                    return fixture;
                }
            }
            attempt += 1;
        }
        panic!("watcher never became live");
    }

    /// Stage `files` files under a nested layout, outside the watched directory.
    fn stage(&self, round: u64, files: usize) -> PathBuf {
        let source = self.staging.join(format!("pkg-{round}"));
        // Twenty files per directory, which is roughly what a package tree looks like and makes the
        // measurement include the per-directory descent rather than one enormous `readdir`.
        for i in 0..files {
            let dir = source.join(format!("d{}", i / 20));
            std::fs::create_dir_all(&dir).expect("mkdir");
            std::fs::write(dir.join(format!("f{i}.js")), b"x").expect("write");
        }
        source
    }
}

/// Wholesale tree move: the case where no kernel event describes the contents at all, so every one
/// of them has to be found by reading the directory.
fn tree_moved_into_root(c: &mut Criterion) {
    const FILES: usize = 2_000;

    let fixture = MoveFixture::new();
    let mut round = 0_u64;

    let mut group = c.benchmark_group("reconcile");
    group
        .sample_size(10)
        .measurement_time(Duration::from_secs(30));
    group.throughput(Throughput::Elements(FILES as u64));
    group.bench_function("tree_of_2000_files_moved_in", |b| {
        b.iter_batched(
            || {
                round += 1;
                (round, fixture.stage(round, FILES))
            },
            |(round, source)| {
                let destination = fixture.watched.join(format!("pkg-{round}"));
                std::fs::rename(&source, &destination).expect("rename into the watch root");

                let deadline = Instant::now() + DEADLINE;
                let mut delivered = 0;
                while delivered < FILES && Instant::now() < deadline {
                    match fixture.watcher.recv_timeout(Duration::from_millis(1)) {
                        Some(event)
                            if event.kind == EventKind::Created
                                && !event.is_directory
                                && event.path.starts_with(&destination) =>
                        {
                            delivered += 1;
                        }
                        _ => {}
                    }
                }
                assert_eq!(
                    delivered, FILES,
                    "only {delivered} of {FILES} files were reported"
                );
            },
            BatchSize::PerIteration,
        );
    });
    group.finish();
}

/// The same move, one order of magnitude past the scan bound, where the honest answer is a rescan.
fn tree_moved_into_root_past_the_bound(c: &mut Criterion) {
    const FILES: usize = 20_000;

    let fixture = MoveFixture::new();
    let mut round = 0_u64;

    let mut group = c.benchmark_group("reconcile");
    group
        .sample_size(10)
        .measurement_time(Duration::from_secs(30));
    group.bench_function("tree_of_20000_files_moved_in_rescans", |b| {
        b.iter_batched(
            || {
                round += 1;
                (round, fixture.stage(round, FILES))
            },
            |(round, source)| {
                let destination = fixture.watched.join(format!("pkg-{round}"));
                std::fs::rename(&source, &destination).expect("rename into the watch root");

                let deadline = Instant::now() + DEADLINE;
                let mut rescanned = false;
                while !rescanned && Instant::now() < deadline {
                    rescanned = fixture
                        .watcher
                        .recv_timeout(Duration::from_millis(1))
                        .is_some_and(|event| event.kind == EventKind::RescanRequired);
                }
                assert!(
                    rescanned,
                    "a tree past the scan bound must ask for a rescan"
                );
                while fixture.watcher.poll().is_some() {}
            },
            BatchSize::PerIteration,
        );
    });
    group.finish();
}

/// Cost of the filter, which runs on every event before anything else.
fn filter_matching(c: &mut Criterion) {
    let filter = EventFilter::dev_defaults()
        .expect("built-in patterns")
        .include_glob("**/*.{rs,js,ts,tsx}")
        .expect("valid glob");
    let allowed = Path::new("/workspace/project/src/components/Button.tsx");
    let excluded = Path::new("/workspace/project/node_modules/react/index.js");

    let mut group = c.benchmark_group("filter");
    group.bench_function("allowed_path", |b| {
        b.iter(|| black_box(filter.matches(black_box(allowed))));
    });
    group.bench_function("excluded_path", |b| {
        b.iter(|| black_box(filter.matches(black_box(excluded))));
    });
    group.finish();
}

/// Content hashing, the other per-event cost when the processor is in use.
fn content_hashing(c: &mut Criterion) {
    let dir = tempfile::tempdir().expect("temp dir");
    let mut group = c.benchmark_group("hash");
    for size in [1_024_usize, 64 * 1024, 1024 * 1024] {
        let path = dir.path().join(format!("{size}.bin"));
        let contents: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
        std::fs::write(&path, &contents).expect("write");

        group.throughput(Throughput::Bytes(size as u64));
        group.bench_function(format!("fnv1a_file_{size}B"), |b| {
            b.iter(|| black_box(Fnv1aHasher.hash_file(black_box(&path)).expect("hash")));
        });
    }
    group.finish();
}

/// The processor's decision path, with and without a usable cache entry.
fn content_change_detection(c: &mut Criterion) {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("module.ts");
    std::fs::write(&path, vec![b'x'; 16 * 1024]).expect("write");
    let event = |kind| FileEvent {
        path: path.clone(),
        kind,
        timestamp_ns: 0,
        size: 16 * 1024,
        is_directory: false,
        cookie: None,
    };

    let mut group = c.benchmark_group("processor");
    group.bench_function("cache_hit_unchanged_file", |b| {
        let processor = FileEventProcessor::new();
        let _ = processor.process(event(EventKind::Created));
        b.iter(|| black_box(processor.process(black_box(event(EventKind::Modified)))));
    });
    group.bench_function("cold_cache", |b| {
        b.iter_batched(
            FileEventProcessor::new,
            |processor| black_box(processor.process(event(EventKind::Created))),
            BatchSize::SmallInput,
        );
    });
    group.finish();
}

criterion_group!(
    benches,
    event_latency,
    event_throughput,
    tree_moved_into_root,
    tree_moved_into_root_past_the_bound,
    filter_matching,
    content_hashing,
    content_change_detection
);
criterion_main!(benches);
