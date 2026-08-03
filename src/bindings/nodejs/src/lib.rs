//! Node.js addon for Retrigger.
//!
//! This crate is glue and nothing else. Everything it exposes is computed by
//! one of two crates that stand on their own:
//!
//! - [`retrigger_core`] — XXH3-64 over a C engine with runtime SIMD dispatch,
//!   behind `hashAlgorithm`, `hashBytesSync`, `hashFileSync`, `hashFile`,
//!   `benchmarkHash`, and the three SIMD accessors.
//! - [`retrigger_system`] — the `notify`-backed watcher, behind the `Watcher`
//!   class.
//!
//! # The surface is a contract, not a preference
//!
//! The JavaScript half of this package was written against
//! `test/helpers/mock-native.js`, which is an executable specification of this
//! addon: class name, method names, event object shape, return shapes. Anything
//! here that disagrees with that file is a bug here. `lib/native.js` refuses to
//! load a binary that is missing `getSimdSupport`, `hashBytesSync`,
//! `hashFileSync` or `Watcher`, so a partial implementation degrades to the
//! JavaScript fallback rather than half-working.
//!
//! # Nothing crosses the boundary as a panic
//!
//! Every fallible entry point returns [`napi::Result`], and errors that a
//! caller is expected to branch on are thrown with the same `err.code` the
//! JavaScript engines use (`ENOENT` for a path that does not exist). There is
//! no `unwrap` or `expect` outside `#[cfg(test)]`, and no arithmetic that can
//! trap: every `u64`/`usize` counter is narrowed with a saturating conversion
//! before it becomes a JS number.
//!
//! # Where filtering happens, and why it is split
//!
//! Include and exclude are one question for files and a *different* question
//! for directories: `include: ['**/*.ts']` must not stop `src/` from being
//! reported or descended into, or a caller filtering by extension would never
//! see a subtree appear. The JavaScript engines encode that as two methods
//! (`matches` for files, `allowsDirectory` for directories);
//! [`retrigger_system`] has a single filter that it applies uniformly. So the
//! excludes go to the watcher — where they also prune scans and never occupy
//! queue capacity — and the include set is applied here, in [`Watcher::poll`],
//! only to non-directory events. The visible consequence is that with an
//! `include` list configured, `stats()` counts events that `poll` then drops;
//! excludes are accounted exactly.
//!
//! # FSEvents reports flags, not facts
//!
//! macOS delivers a *union* of everything that has happened to a path since it
//! was last reported, so one rewrite of an existing file arrives as `created` +
//! `metadata` + `modified`. Correcting that is `retrigger-system`'s job, not
//! this crate's: it happens where the event is first seen, so the daemon — with
//! exactly the same exposure — gets the same answer, and so it costs no `stat`
//! beyond the one the watcher already makes. This addon receives kinds the file
//! system has already agreed to.

use std::path::PathBuf;
use std::sync::Arc;

use napi::bindgen_prelude::{AsyncTask, BigInt, BufferSlice, Either, JsObjectValue, Unknown};
use napi::{Env, Error, JsValue, Result, Status, Task, ValueType};
use napi_derive::napi;

use retrigger_core as hashing;
use retrigger_system::{
    AwaitWriteFinishConfig, Backend, BackendMode, EventFilter, EventKind, FileEvent,
    SnapshotEnvelope, WatchError, Watcher as SystemWatcher, WatcherConfig,
};

/// The one algorithm every hash entry point here uses.
///
/// Exposed so `getEngineInfo().hashAlgorithm` reports what actually ran rather
/// than a constant the JavaScript side hard-coded and hoped was still true.
const HASH_ALGORITHM: &str = "xxh3-64";

/// Queue capacity when the caller does not ask for one, matching
/// `lib/js-watcher.js` and the mock so the default is one number, not three.
const DEFAULT_CAPACITY: u32 = 8192;

/// `backend: "poll"` re-scan interval when the caller does not name one.
/// Matches `lib/retrigger.js`'s own normalization so the native and
/// JavaScript engines agree on what "unspecified" means.
const DEFAULT_POLL_INTERVAL_MS: u32 = 1000;

/// `awaitWriteFinish.pollIntervalMs` when the caller enables the feature but
/// does not name one.
const DEFAULT_AWAIT_WRITE_FINISH_POLL_MS: u32 = 100;

/// `awaitWriteFinish.stabilityThresholdMs` when the caller enables the
/// feature but does not name one. Matches the convention chokidar's
/// `awaitWriteFinish.stabilityThreshold` made familiar.
const DEFAULT_AWAIT_WRITE_FINISH_STABILITY_MS: u32 = 2000;

// --------------------------------------------------------------------- hash

/// A file's digest and the number of bytes that produced it.
#[napi(object)]
pub struct HashedFile {
    /// 16 lowercase hex characters, the form both engines exchange.
    pub hash: String,
    /// Size in bytes.
    pub size: i64,
}

/// A measured throughput result. No fabricated baselines: these come from the
/// C engine having just hashed the bytes.
#[napi(object)]
pub struct BenchmarkResult {
    /// Throughput in mebibytes per second.
    pub throughput_mbps: f64,
    /// Nanoseconds per input byte.
    pub ns_per_byte: f64,
    /// The SIMD kernel that was exercised.
    pub level: String,
}

/// The algorithm this addon hashes with.
#[napi]
pub fn hash_algorithm() -> &'static str {
    HASH_ALGORITHM
}

/// The SIMD kernel currently dispatching.
#[napi]
pub fn get_simd_support() -> String {
    hashing::active_level().name().to_owned()
}

/// The best SIMD kernel this CPU supports, which differs from
/// [`get_simd_support`] only if dispatch has been pinned.
#[napi]
pub fn get_cpu_level() -> String {
    hashing::cpu_level().name().to_owned()
}

/// Every SIMD kernel usable on this machine, lowest first. All of them compute
/// identical digests.
#[napi]
pub fn get_available_levels() -> Vec<String> {
    hashing::available_levels()
        .into_iter()
        .map(|level| level.name().to_owned())
        .collect()
}

/// XXH3-64 of `data`, as 16 lowercase hex characters.
///
/// A `Buffer` or any `Uint8Array` is hashed byte for byte; a string is hashed
/// as its UTF-8 encoding, which is what the JavaScript engine does too.
#[napi]
pub fn hash_bytes_sync(
    data: Either<BufferSlice, String>,
    seed: Option<Either<BigInt, f64>>,
) -> Result<String> {
    let bytes: &[u8] = match &data {
        Either::A(buffer) => buffer.as_ref(),
        Either::B(text) => text.as_bytes(),
    };
    let digest = match seed_value(seed)? {
        Some(seed) => hashing::hash_with_seed(bytes, seed),
        None => hashing::hash(bytes),
    };
    Ok(hashing::to_hex(digest))
}

/// XXH3-64 of a file, streamed in bounded chunks so peak memory does not scale
/// with file size.
#[napi]
pub fn hash_file_sync(env: Env, path: String) -> Result<HashedFile> {
    hashing::hash_file(&path)
        .map(hashed)
        .map_err(|err| coded(&env, io_code(&err), format!("cannot hash {path}: {err}")))
}

/// [`hash_file_sync`] on the libuv thread pool, so a large file does not block
/// the event loop.
#[napi(ts_return_type = "Promise<{ hash: string, size: number }>")]
pub fn hash_file(path: String) -> AsyncTask<HashFileTask> {
    AsyncTask::new(HashFileTask { path, code: None })
}

/// Measure hashing throughput over `size` bytes for `iterations` passes.
#[napi(ts_return_type = "Promise<{ throughputMbps: number, nsPerByte: number, level: string }>")]
pub fn benchmark_hash(size: f64, iterations: f64) -> AsyncTask<BenchmarkTask> {
    AsyncTask::new(BenchmarkTask {
        // Clamped rather than rejected, so a degenerate request measures
        // something tiny instead of dividing by zero.
        size: count(size, 1) as usize,
        iterations: count(iterations, 1),
    })
}

/// Off-thread body of [`hash_file`].
pub struct HashFileTask {
    path: String,
    /// Carried from the pool thread, where no `Env` exists, to [`Task::reject`]
    /// on the JS thread, where the coded error can actually be built.
    code: Option<&'static str>,
}

impl Task for HashFileTask {
    type Output = hashing::FileHash;
    type JsValue = HashedFile;

    fn compute(&mut self) -> Result<Self::Output> {
        hashing::hash_file(&self.path).map_err(|err| {
            self.code = Some(io_code(&err));
            Error::new(
                Status::GenericFailure,
                format!("cannot hash {}: {err}", self.path),
            )
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(hashed(output))
    }

    fn reject(&mut self, env: Env, err: Error) -> Result<Self::JsValue> {
        Err(match self.code.take() {
            Some(code) => coded(&env, code, err.reason),
            None => err,
        })
    }
}

/// Off-thread body of [`benchmark_hash`].
pub struct BenchmarkTask {
    size: usize,
    iterations: u32,
}

impl Task for BenchmarkTask {
    type Output = hashing::Benchmark;
    type JsValue = BenchmarkResult;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(hashing::benchmark(self.size, self.iterations))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(BenchmarkResult {
            throughput_mbps: output.throughput_mbps,
            ns_per_byte: output.ns_per_byte,
            level: output.level.name().to_owned(),
        })
    }
}

fn hashed(file: hashing::FileHash) -> HashedFile {
    HashedFile {
        hash: hashing::to_hex(file.hash),
        size: as_i64(file.size),
    }
}

/// The `err.code` a JavaScript caller would get from `fs` for the same failure.
fn io_code(err: &hashing::HashError) -> &'static str {
    match err {
        hashing::HashError::Io { source, .. } => match source.kind() {
            std::io::ErrorKind::NotFound => "ENOENT",
            std::io::ErrorKind::PermissionDenied => "EACCES",
            _ => "ERR_RETRIGGER_HASH",
        },
        _ => "ERR_RETRIGGER_HASH",
    }
}

/// Accept the seed in either form the JavaScript signature allows.
fn seed_value(seed: Option<Either<BigInt, f64>>) -> Result<Option<u64>> {
    match seed {
        None => Ok(None),
        Some(Either::A(big)) => {
            let (negative, value, lossless) = big.get_u64();
            if negative || !lossless {
                return Err(Error::new(
                    Status::InvalidArg,
                    "seed must fit in an unsigned 64-bit integer".to_owned(),
                ));
            }
            Ok(Some(value))
        }
        Some(Either::B(number)) => {
            if !number.is_finite() || number < 0.0 || number > u64::MAX as f64 {
                return Err(Error::new(
                    Status::InvalidArg,
                    "seed must be a non-negative finite number".to_owned(),
                ));
            }
            Ok(Some(number as u64))
        }
    }
}

// ------------------------------------------------------------------ watcher

/// Constructor options, named exactly as the JavaScript engines name them.
#[napi(object)]
pub struct WatcherOptions {
    /// Bounded queue size. Non-positive or absent means the default.
    pub capacity: Option<f64>,
    /// Coalescing window in milliseconds. Non-positive or absent disables it.
    pub debounce_ms: Option<f64>,
    /// Globs a file path must match to be reported. Empty means "everything".
    pub include: Option<Vec<String>>,
    /// Globs that reject a path. Excludes always beat includes.
    pub exclude: Option<Vec<String>>,
    /// `"auto"` (the default) picks the platform-native backend; `"poll"`
    /// forces the portable, interval-driven fallback for network/remote file
    /// systems where kernel watch events cannot be trusted. Anything else is a
    /// `TypeError`.
    pub backend: Option<String>,
    /// Re-scan interval in milliseconds when `backend: "poll"`. Ignored
    /// otherwise. Non-positive or absent means `notify`'s own default.
    pub poll_interval_ms: Option<f64>,
    /// Whether the `"poll"` backend also hashes file contents to catch a
    /// same-size, same-mtime rewrite that a `stat`-only poll would miss.
    /// Ignored for `"auto"`. Defaults to `false`.
    pub poll_compare_contents: Option<bool>,
    /// Hold a changed file until it stops growing before reporting it.
    /// Absent (the default) reports as soon as the backend sees a change.
    pub await_write_finish: Option<AwaitWriteFinishOptions>,
    /// Fold an atomic-save `renamedTo` for a path already seen to arrive into
    /// `modified`. Defaults to `false`.
    pub atomic_write_normalization: Option<bool>,
}

/// [`WatcherOptions::await_write_finish`] thresholds, both in milliseconds.
#[napi(object)]
pub struct AwaitWriteFinishOptions {
    /// How often to re-`stat` a path while waiting for it to settle.
    /// Non-positive or absent means `retrigger_system`'s own default.
    pub poll_interval_ms: Option<f64>,
    /// How long size and modification time must be unchanged before the path
    /// is reported. Non-positive or absent means `retrigger_system`'s own
    /// default.
    pub stability_threshold_ms: Option<f64>,
}

/// One file system change, in the shape `lib/retrigger.js` dispatches on.
#[napi(object)]
pub struct JsFileEvent {
    /// Absolute path. Empty for `rescanRequired`, which refers to the whole
    /// watch set rather than one path.
    pub path: String,
    /// `created` | `modified` | `deleted` | `renamedFrom` | `renamedTo` |
    /// `metadata` | `rescanRequired`.
    pub kind: String,
    /// When this crate observed the event, in nanoseconds since the Unix epoch.
    pub timestamp_ns: BigInt,
    /// Size in bytes; `0` for directories and for paths that no longer exist.
    pub size: i64,
    /// Whether the path is (or, for a removal, was) a directory.
    pub is_directory: bool,
    /// Correlates the two halves of a rename. Linux only; `null` elsewhere.
    pub cookie: Option<i64>,
}

/// Queue counters. `eventsQueued == eventsDelivered + queuePending` always.
#[napi(object)]
pub struct JsWatcherStats {
    /// Events accepted into the queue since creation.
    pub events_queued: i64,
    /// Events discarded because the queue was full.
    pub events_dropped: i64,
    /// Events handed to a consumer through `poll()`.
    pub events_delivered: i64,
    /// Events produced by reading a directory that had just appeared. A subset
    /// of `eventsQueued`; the JavaScript engines have no equivalent and the
    /// public `getStats()` drops it, so it is here for diagnosis only.
    pub events_synthesized: i64,
    /// Paths currently registered through `watch()`.
    pub watched_paths: u32,
    /// Events awaiting delivery.
    pub queue_pending: u32,
    /// Configured queue capacity.
    pub queue_capacity: u32,
    /// Whether the backend is attached.
    pub is_running: bool,
}

/// The poll-based watcher `lib/engine.js` drives.
#[napi]
pub struct Watcher {
    /// `Arc`, not an owned value, so [`Watcher::snapshot`] and
    /// [`Watcher::watch_with_snapshot`] can hand a background pool thread a handle that outlives
    /// this call without either cloning [`SystemWatcher`] itself (it is not [`Clone`] — it owns
    /// live thread handles) or risking a JS-side drop racing the crawl.
    inner: Arc<SystemWatcher>,
    /// Includes and excludes together: the question to ask about a *file*.
    files: EventFilter,
    /// Excludes only, plus the directory form of every `prefix/**` pattern:
    /// the question to ask about a *directory*, which must stay reachable even
    /// when it matches no include. Mirrors `Matcher#allowsDirectory`.
    directories: EventFilter,
}

#[napi]
impl Watcher {
    /// Build a watcher. No kernel resources are acquired until `start()`.
    #[napi(constructor)]
    pub fn new(env: Env, options: Option<WatcherOptions>) -> Result<Self> {
        let options = options.unwrap_or(WatcherOptions {
            capacity: None,
            debounce_ms: None,
            include: None,
            exclude: None,
            backend: None,
            poll_interval_ms: None,
            poll_compare_contents: None,
            await_write_finish: None,
            atomic_write_normalization: None,
        });
        let include = patterns(options.include);
        let exclude = patterns(options.exclude);

        let pattern_error = |err: WatchError| coded(&env, "ERR_INVALID_PATTERN", err.to_string());
        let files = EventFilter::from_globs(&include, &exclude).map_err(pattern_error)?;
        let directories = EventFilter::from_globs::<[&str; 0], _>([], directory_forms(&exclude))
            .map_err(pattern_error)?;
        // Excludes go to the watcher itself so an excluded subtree is never
        // walked, never queued and never counted. Includes cannot: see the
        // module docs.
        let source =
            EventFilter::from_globs::<[&str; 0], _>([], &exclude).map_err(pattern_error)?;

        let backend = backend_mode(
            &env,
            options.backend.as_deref(),
            options.poll_interval_ms,
            options.poll_compare_contents,
        )?;
        let await_write_finish = options
            .await_write_finish
            .map(|awf| AwaitWriteFinishConfig {
                poll_interval: std::time::Duration::from_millis(u64::from(count(
                    awf.poll_interval_ms.unwrap_or(0.0),
                    DEFAULT_AWAIT_WRITE_FINISH_POLL_MS,
                ))),
                stability_threshold: std::time::Duration::from_millis(u64::from(count(
                    awf.stability_threshold_ms.unwrap_or(0.0),
                    DEFAULT_AWAIT_WRITE_FINISH_STABILITY_MS,
                ))),
            });

        let capacity = count(options.capacity.unwrap_or(0.0), DEFAULT_CAPACITY);
        let config = WatcherConfig {
            capacity: capacity as usize,
            debounce: std::time::Duration::from_millis(u64::from(count(
                options.debounce_ms.unwrap_or(0.0),
                0,
            ))),
            filter: source,
            backend,
            await_write_finish,
            atomic_write_normalization: options.atomic_write_normalization.unwrap_or(false),
            ..WatcherConfig::default()
        };

        let inner = SystemWatcher::new(config)
            .map_err(|err| watch_failure(&env, "cannot create a watcher".to_owned(), &err))?;
        Ok(Self {
            inner: Arc::new(inner),
            files,
            directories,
        })
    }

    /// Register a path. Safe before or after `start()`; re-watching a path
    /// replaces its recursion mode.
    #[napi]
    pub fn watch(&self, env: Env, target: Unknown, recursive: Option<bool>) -> Result<()> {
        let path = path_arg(&env, target, "watch")?;
        self.inner
            .watch(&path, recursive.unwrap_or(true))
            .map_err(|err| watch_failure(&env, format!("cannot watch {}", path.display()), &err))
    }

    /// Stop watching a path. Unregistering something that was never registered
    /// is a no-op, as it is on both JavaScript engines.
    #[napi]
    pub fn unwatch(&self, env: Env, target: Unknown) -> Result<()> {
        let path = path_arg(&env, target, "unwatch")?;
        match self.inner.unwatch(&path) {
            Ok(()) | Err(WatchError::NotFound(_)) => Ok(()),
            Err(err) => Err(watch_failure(
                &env,
                format!("cannot unwatch {}", path.display()),
                &err,
            )),
        }
    }

    /// Attach the backend and begin delivering events. Idempotent.
    #[napi]
    pub fn start(&self, env: Env) -> Result<()> {
        self.inner
            .start()
            .map_err(|err| watch_failure(&env, "cannot start the watcher".to_owned(), &err))
    }

    /// Detach the backend, joining its threads. Idempotent.
    #[napi]
    pub fn stop(&self) -> Result<()> {
        self.inner
            .stop()
            .map_err(|err| Error::new(Status::GenericFailure, err.to_string()))
    }

    /// Take the next event, or `null` when nothing is pending.
    ///
    /// Never blocks: the queue is drained by the consumer's own interval, so
    /// this is a lock-and-pop and the event loop is free between calls. The
    /// loop skips events the include set rejects rather than returning `null`
    /// for them, which would stall a drain that stops at the first `null`.
    #[napi]
    pub fn poll(&self) -> Option<JsFileEvent> {
        while let Some(event) = self.inner.poll() {
            if self.deliverable(&event) {
                return Some(convert(event));
            }
        }
        None
    }

    /// Read the queue counters.
    #[napi]
    pub fn stats(&self) -> JsWatcherStats {
        let stats = self.inner.stats();
        JsWatcherStats {
            events_queued: as_i64(stats.events_queued),
            events_dropped: as_i64(stats.events_dropped),
            events_delivered: as_i64(stats.events_delivered),
            events_synthesized: as_i64(stats.events_synthesized),
            watched_paths: as_u32(stats.watched_paths),
            queue_pending: as_u32(stats.queue_pending),
            queue_capacity: as_u32(stats.queue_capacity),
            is_running: stats.is_running,
        }
    }

    /// The kernel facility doing the watching. Known before `start()`, because
    /// the backend is selected at compile time.
    #[napi]
    pub fn backend(&self) -> &'static str {
        match self.inner.backend() {
            Backend::Inotify => "inotify",
            Backend::FsEvents => "fsevents",
            Backend::ReadDirectoryChangesW => "rdcw",
            Backend::KQueue => "kqueue",
            Backend::Polling => "polling",
        }
    }

    /// Crawl `target`'s current contents, without registering a watch on it.
    ///
    /// Runs on libuv's thread pool, like [`hash_file`], because a snapshot of a large tree is a
    /// blocking directory walk. Rejects `target` synchronously if it is not a non-empty string, so
    /// a caller sees a `TypeError` immediately rather than from a rejected promise.
    #[napi(ts_return_type = "Promise<SnapshotEnvelope>")]
    pub fn snapshot(&self, env: Env, target: Unknown) -> Result<AsyncTask<SnapshotTask>> {
        let path = path_arg(&env, target, "snapshot")?;
        Ok(AsyncTask::new(SnapshotTask {
            watcher: Arc::clone(&self.inner),
            path,
            register: false,
            recursive: false,
            code: None,
        }))
    }

    /// [`watch`](Self::watch) `target`, then [`snapshot`](Self::snapshot) it, with the watch
    /// registered before the crawl begins — see
    /// [`retrigger_system::Watcher::watch_with_snapshot`] for why the ordering matters.
    #[napi(ts_return_type = "Promise<SnapshotEnvelope>")]
    pub fn watch_with_snapshot(
        &self,
        env: Env,
        target: Unknown,
        recursive: Option<bool>,
    ) -> Result<AsyncTask<SnapshotTask>> {
        let path = path_arg(&env, target, "watchWithSnapshot")?;
        Ok(AsyncTask::new(SnapshotTask {
            watcher: Arc::clone(&self.inner),
            path,
            register: true,
            recursive: recursive.unwrap_or(true),
            code: None,
        }))
    }

    /// A directory is judged by the excludes alone, a file by the whole filter.
    fn deliverable(&self, event: &FileEvent) -> bool {
        match event.kind {
            EventKind::RescanRequired => true,
            _ if event.is_directory => !self.directories.excludes(&event.path),
            _ => self.files.matches(&event.path),
        }
    }
}

/// One entry of a [`JsSnapshotEnvelope`], in the shape [`snapshot`](Watcher::snapshot) and
/// [`watch_with_snapshot`](Watcher::watch_with_snapshot) resolve with.
#[napi(object)]
pub struct JsSnapshotEntry {
    /// Absolute path.
    pub path: String,
    pub is_directory: bool,
    /// Always `0` for a directory.
    pub size: i64,
    /// Nanoseconds since the Unix epoch, `null` when the file system reports none. A `BigInt`,
    /// like [`JsFileEvent::timestamp_ns`], because nanosecond timestamps exceed
    /// `Number.MAX_SAFE_INTEGER`.
    pub modified_ns: Option<BigInt>,
}

/// A self-describing, portable snapshot — see [`SnapshotEnvelope`].
#[napi(object)]
pub struct JsSnapshotEnvelope {
    /// The digest algorithm this envelope's format is defined in terms of; see
    /// [`retrigger_system::SNAPSHOT_ALGORITHM`].
    pub algorithm: String,
    /// Schema version; see [`retrigger_system::SNAPSHOT_ENVELOPE_VERSION`].
    pub version: u32,
    pub entries: Vec<JsSnapshotEntry>,
}

impl From<SnapshotEnvelope> for JsSnapshotEnvelope {
    fn from(envelope: SnapshotEnvelope) -> Self {
        Self {
            algorithm: envelope.algorithm,
            version: envelope.version,
            entries: envelope
                .entries
                .into_iter()
                .map(|entry| JsSnapshotEntry {
                    path: entry.path.to_string_lossy().into_owned(),
                    is_directory: entry.is_directory,
                    size: as_i64(entry.size),
                    modified_ns: entry.modified_ns.map(BigInt::from),
                })
                .collect(),
        }
    }
}

/// Off-thread body of [`Watcher::snapshot`] and [`Watcher::watch_with_snapshot`]; `register`
/// selects between them so the two async entry points can share one [`Task`] rather than
/// duplicating the pool-thread and error-mapping logic.
pub struct SnapshotTask {
    watcher: Arc<SystemWatcher>,
    path: PathBuf,
    /// Whether to [`watch`](SystemWatcher::watch) `path` before crawling it (`watchWithSnapshot`)
    /// or only crawl it (`snapshot`).
    register: bool,
    /// Ignored unless `register` is set.
    recursive: bool,
    /// Carried from the pool thread to [`Task::reject`], mirroring [`HashFileTask::code`].
    code: Option<&'static str>,
}

impl Task for SnapshotTask {
    type Output = Vec<retrigger_system::SnapshotEntry>;
    type JsValue = JsSnapshotEnvelope;

    fn compute(&mut self) -> Result<Self::Output> {
        let result = if self.register {
            self.watcher.watch_with_snapshot(&self.path, self.recursive)
        } else {
            self.watcher.snapshot(&self.path)
        };
        result.map_err(|err| {
            self.code = Some(match &err {
                WatchError::NotFound(_) => "ENOENT",
                WatchError::PermissionDenied(_) => "EACCES",
                _ => "ERR_RETRIGGER_WATCH",
            });
            Error::new(
                Status::GenericFailure,
                format!("cannot snapshot {}: {err}", self.path.display()),
            )
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(JsSnapshotEnvelope::from(SnapshotEnvelope::new(output)))
    }

    fn reject(&mut self, env: Env, err: Error) -> Result<Self::JsValue> {
        Err(match self.code.take() {
            Some(code) => coded(&env, code, err.reason),
            None => err,
        })
    }
}

/// Parse [`WatcherOptions::backend`] into a [`BackendMode`], or throw a `TypeError` for anything
/// but `"auto"`, `"poll"`, or absent (which is `"auto"`).
fn backend_mode(
    env: &Env,
    backend: Option<&str>,
    poll_interval_ms: Option<f64>,
    compare_contents: Option<bool>,
) -> Result<BackendMode> {
    match backend {
        None | Some("auto") => Ok(BackendMode::Auto),
        Some("poll") => Ok(BackendMode::Poll {
            interval: std::time::Duration::from_millis(u64::from(count(
                poll_interval_ms.unwrap_or(0.0),
                DEFAULT_POLL_INTERVAL_MS,
            ))),
            compare_contents: compare_contents.unwrap_or(false),
        }),
        Some(other) => throw_type(
            env,
            format!("backend must be \"auto\" or \"poll\", got {other:?}"),
        ),
    }
}

fn convert(event: FileEvent) -> JsFileEvent {
    JsFileEvent {
        path: event.path.to_string_lossy().into_owned(),
        kind: match event.kind {
            EventKind::Created => "created",
            EventKind::Modified => "modified",
            EventKind::Deleted => "deleted",
            EventKind::RenamedFrom => "renamedFrom",
            EventKind::RenamedTo => "renamedTo",
            EventKind::Metadata => "metadata",
            EventKind::RescanRequired => "rescanRequired",
        }
        .to_owned(),
        timestamp_ns: BigInt::from(event.timestamp_ns),
        size: as_i64(event.size),
        is_directory: event.is_directory,
        cookie: event.cookie.map(as_i64),
    }
}

/// Read a path argument the way both JavaScript engines do: a non-empty string
/// or a `TypeError`.
fn path_arg(env: &Env, value: Unknown, method: &str) -> Result<PathBuf> {
    if value.get_type()? != ValueType::String {
        return throw_type(
            env,
            format!("{method}(path) requires a non-empty string path"),
        );
    }
    let text = value.coerce_to_string()?.into_utf8()?.into_owned()?;
    if text.is_empty() {
        return throw_type(
            env,
            format!("{method}(path) requires a non-empty string path"),
        );
    }
    Ok(PathBuf::from(text))
}

fn watch_failure(env: &Env, context: String, err: &WatchError) -> Error {
    let code = match err {
        WatchError::NotFound(_) => "ENOENT",
        WatchError::PermissionDenied(_) => "EACCES",
        // The kernel is out of watch descriptors; `ENOSPC` is what inotify
        // itself reports for it, and the message carries the remediation.
        WatchError::WatchLimitExceeded(_) => "ENOSPC",
        WatchError::InvalidPattern(_) => "ERR_INVALID_PATTERN",
        _ => "ERR_RETRIGGER_WATCH",
    };
    coded(env, code, format!("{context}: {err}"))
}

/// Build a JS `Error` carrying `code`.
///
/// `err.code` is how a caller tells a missing path from a permission problem
/// without matching on message text, and it is what both JavaScript engines
/// set. napi derives `code` from its own `Status` enum, which has no room for
/// an OS error name, so the error object is built here and handed back: napi
/// throws — or rejects with — the object it was given rather than making one.
fn coded(env: &Env, code: &str, message: String) -> Error {
    env.create_error(Error::new(Status::GenericFailure, message.clone()))
        .and_then(|mut error| {
            error.set_named_property("code", env.create_string(code)?)?;
            Ok(Error::from(error.to_unknown()))
        })
        // Only reachable if the JS engine could not allocate the object, in
        // which case an uncoded error still beats no error.
        .unwrap_or_else(|_| Error::new(Status::GenericFailure, message))
}

/// A `TypeError`, which is what both JavaScript engines raise for an argument
/// of the wrong type. napi has no constructor for one, so it is thrown here
/// and the returned status tells napi an exception is already pending.
fn throw_type<T>(env: &Env, message: String) -> Result<T> {
    match env.throw_type_error(&message, None) {
        Ok(()) => Err(Error::new(Status::PendingException, message)),
        Err(_) => Err(Error::new(Status::InvalidArg, message)),
    }
}

// ------------------------------------------------------------------ helpers

fn patterns(list: Option<Vec<String>>) -> Vec<String> {
    list.unwrap_or_default()
        .into_iter()
        .filter(|pattern| !pattern.is_empty())
        .flat_map(|pattern| {
            // The JavaScript matcher treats a separator-free pattern as a
            // basename match, so `*.log` excludes `a/b/c.log`. `globset` needs
            // that spelled out, and keeping both forms costs one extra glob.
            let bare = !pattern.contains('/') && !pattern.contains('\\');
            let basename = bare.then(|| format!("**/{pattern}"));
            std::iter::once(pattern).chain(basename)
        })
        .collect()
}

/// `prefix/**` should also prune `prefix` itself, which is what
/// `Matcher#allowsDirectory` does and what `globset` does not.
fn directory_forms(exclude: &[String]) -> Vec<String> {
    exclude
        .iter()
        .flat_map(|pattern| {
            let prefix = pattern
                .strip_suffix("/**")
                .filter(|prefix| !prefix.is_empty())
                .map(str::to_owned);
            std::iter::once(pattern.clone()).chain(prefix)
        })
        .collect()
}

/// A positive whole count from a JavaScript number, or `default` when the
/// caller passed nothing usable. Mirrors `JsWatcher`'s constructor exactly, so
/// `capacity: -1` means the same thing on both engines.
fn count(value: f64, default: u32) -> u32 {
    if value.is_finite() && value > 0.0 {
        value.floor().min(f64::from(u32::MAX)) as u32
    } else {
        default
    }
}

/// Saturating, because a counter that overflowed into a negative JS number
/// would be worse than one that stopped climbing.
fn as_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn as_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    #[test]
    fn counts_fall_back_on_anything_not_positive() {
        assert_eq!(count(4096.0, 8192), 4096);
        assert_eq!(count(4096.9, 8192), 4096);
        assert_eq!(count(0.0, 8192), 8192);
        assert_eq!(count(-1.0, 8192), 8192);
        assert_eq!(count(f64::NAN, 8192), 8192);
        assert_eq!(count(f64::INFINITY, 8192), 8192);
        assert_eq!(count(1e30, 8192), u32::MAX);
    }

    #[test]
    fn saturating_conversions_never_wrap() {
        assert_eq!(as_i64(7), 7);
        assert_eq!(as_i64(u64::MAX), i64::MAX);
        assert_eq!(as_u32(usize::MAX), u32::MAX);
    }

    #[test]
    fn bare_patterns_also_match_by_basename() {
        let expanded = patterns(Some(vec!["*.log".to_owned(), "**/dist/**".to_owned()]));
        assert_eq!(expanded, ["*.log", "**/*.log", "**/dist/**"]);
    }

    #[test]
    fn empty_patterns_are_dropped_rather_than_matching_everything() {
        assert!(patterns(Some(vec![String::new()])).is_empty());
        assert!(patterns(None).is_empty());
    }

    #[test]
    fn directory_forms_prune_the_prefix_of_a_recursive_exclude() {
        let forms = directory_forms(&["**/node_modules/**".to_owned(), "**/*.log".to_owned()]);
        assert_eq!(forms, ["**/node_modules/**", "**/node_modules", "**/*.log"]);
    }

    /// The two filters must answer the two different questions the JavaScript
    /// matcher answers, or a directory that matches no include is pruned and
    /// its whole subtree goes unreported.
    #[test]
    fn an_include_set_does_not_hide_directories(
    ) -> std::result::Result<(), Box<dyn std::error::Error>> {
        let files = EventFilter::from_globs(["**/*.ts"], ["**/node_modules/**"])?;
        let directories = EventFilter::from_globs::<[&str; 0], _>(
            [],
            directory_forms(&["**/node_modules/**".to_owned()]),
        )?;

        assert!(files.matches(Path::new("/p/a.ts")));
        assert!(!files.matches(Path::new("/p/a.js")));
        assert!(!files.matches(Path::new("/p/node_modules/a.ts")));

        assert!(!directories.excludes(Path::new("/p/src")));
        assert!(directories.excludes(Path::new("/p/node_modules")));
        assert!(directories.excludes(Path::new("/p/node_modules/react")));
        Ok(())
    }

    #[test]
    fn every_hash_entry_point_agrees_with_the_core_crate() {
        let digest = hash_bytes_sync(Either::B("retrigger".to_owned()), None)
            .expect("hashing a string cannot fail");
        assert_eq!(digest, hashing::to_hex(hashing::hash(b"retrigger")));
        assert_eq!(digest.len(), 16);
        assert!(digest
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()));
    }

    #[test]
    fn a_zero_seed_is_the_unseeded_case() {
        assert_eq!(seed_value(None).expect("no seed"), None);
        assert_eq!(
            seed_value(Some(Either::B(0.0))).expect("zero seed"),
            Some(0)
        );
        assert_eq!(seed_value(Some(Either::B(7.0))).expect("seed"), Some(7));
        assert!(seed_value(Some(Either::B(-1.0))).is_err());
        assert!(seed_value(Some(Either::B(f64::NAN))).is_err());
    }
}
