//! The watcher itself: backend lifecycle, event translation, scope, coalescing.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant, UNIX_EPOCH};

use notify::event::{CreateKind, ModifyKind, RemoveKind, RenameMode};
use notify::{RecommendedWatcher, RecursiveMode, Watcher as NotifyWatcher, WatcherKind};
use parking_lot::{Mutex, RwLock};
use tokio::sync::broadcast;
use tracing::{debug, trace, warn};

use crate::bounded::BoundedMap;
use crate::config::{Backend, WatcherConfig, WatcherStats};
use crate::error::WatchError;
use crate::event::{now_ns, EventKind, FileEvent};
use crate::queue::{EventQueue, Push};
use crate::scan::{self, Reconciler};

/// Hard ceiling on paths tracked by the delivery ledger.
///
/// Enforced structurally by [`BoundedMap`]'s generation rotation rather than by scanning for stale
/// entries, so it holds however many distinct paths change inside one window — the case a
/// time-based prune cannot bound, because nothing is old enough to discard. See [`crate::bounded`].
const COALESCE_MAP_LIMIT: usize = 8192;

/// How long a delivered path stays in the ledger for the benefit of *synthesized* events.
///
/// A synthesized event is suppressed when the same path was already reported inside this window,
/// which is how repeat reconciliation passes stay silent. It is independent of
/// [`WatcherConfig::debounce`] because reconciliation has to work with coalescing switched off —
/// that is precisely the configuration a consumer picks when it wants every event.
const SYNTH_DEDUPE_WINDOW: Duration = Duration::from_secs(3);

/// Upper bound on the preallocated broadcast ring, independent of queue capacity.
const BROADCAST_CAPACITY_LIMIT: usize = 1024;

/// Which backend `notify` will select here. Fixed at compile time, so it is knowable before a
/// watcher starts and cheap enough to ask repeatedly.
fn detect_backend() -> Backend {
    match <RecommendedWatcher as NotifyWatcher>::kind() {
        WatcherKind::Inotify => Backend::Inotify,
        WatcherKind::Fsevent => Backend::FsEvents,
        WatcherKind::Kqueue => Backend::KQueue,
        WatcherKind::ReadDirectoryChangesWatcher => Backend::ReadDirectoryChangesW,
        // `PollWatcher` is the portable fallback; `NullWatcher` never occurs for
        // `RecommendedWatcher` on any platform this crate builds for, and re-scanning is the
        // only honest description of a watcher that reports nothing.
        _ => Backend::Polling,
    }
}

/// A path registered by the caller, together with its resolved form.
///
/// Both forms are kept because backends disagree: macOS `FSEvents` reports fully resolved paths
/// (`/private/var/...`), while inotify reports paths built from the string it was given. Scope
/// checks accept either, so a caller who watches `/var/tmp/x` still sees its events.
#[derive(Debug, Clone)]
struct WatchEntry {
    path: PathBuf,
    canonical: Option<PathBuf>,
    recursive: bool,
}

impl WatchEntry {
    /// Whether `path` is inside this entry's scope.
    fn covers(&self, path: &Path) -> bool {
        [Some(self.path.as_path()), self.canonical.as_deref()]
            .into_iter()
            .flatten()
            .any(|root| {
                if path == root {
                    return true;
                }
                if !path.starts_with(root) {
                    return false;
                }
                // A non-recursive watch covers only direct children. Enforcing this here rather
                // than trusting each backend makes the semantics identical on every platform:
                // FSEvents is recursive in the kernel and can only be narrowed after the fact.
                self.recursive || path.parent() == Some(root)
            })
    }
}

/// What was last delivered for a path, for coalescing and de-duplication decisions.
#[derive(Debug, Clone, Copy)]
struct LastDelivered {
    at: Instant,
    kind: EventKind,
    /// Whether the path existed when that event was delivered. Coalescing compares this so a
    /// window can never span a state change.
    exists: bool,
    /// Whether the consumer has been told this path arrived, by any route, since it last went away.
    ///
    /// Sticky across subsequent non-removal events, because a write does not un-announce a
    /// creation: without that, every reconciliation pass that followed a write would restate the
    /// arrival and a busy new directory would report itself over and over.
    announced: bool,
}

/// Where an event came from, which decides how aggressively it may be suppressed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Origin {
    /// Reported by the platform backend. Suppressed only by the configured coalescing window.
    Backend,
    /// Produced by [reconciling](crate::scan) a newly-watched directory. Suppressed whenever the
    /// path was reported recently by any route, because it is a restatement of the present rather
    /// than news of a change.
    Synthesized,
}

/// What inspecting a path at event time revealed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Probe {
    size: u64,
    is_directory: bool,
    exists: bool,
    /// Birth time in nanoseconds since the Unix epoch, when the file system reports one. Read from
    /// the same `stat` as the rest of this, so it costs nothing extra. `None` on a volume that does
    /// not keep one — which happens even on macOS.
    created_ns: Option<u64>,
}

/// Re-derive an event's kind from what the path turned out to be.
///
/// Only used on a [flag-union backend](Core::derives_kinds). Returns `None` for an event the file
/// system contradicts outright — a creation or a metadata change reported for something that is
/// not there. Those are not rare: a single `rm` arrives as `created` + `deleted` + `metadata`, and
/// forwarding the survivors would tell a consumer that a file it has just been told to forget is
/// back.
///
/// This costs no syscall of its own: [`Core::probe`] has already looked at the path.
fn derived_kind(
    claimed: EventKind,
    probe: &Probe,
    started_ns: u64,
    announced: bool,
) -> Option<EventKind> {
    if claimed == EventKind::RescanRequired {
        return Some(claimed);
    }
    if !probe.exists {
        // The path is gone. Only a claim that it went away survives contact with that. Which of
        // the two such claims it is stands: absence corroborates both equally, and a consumer that
        // pairs rename halves by cookie would be the poorer for flattening them.
        return match claimed {
            EventKind::Deleted | EventKind::RenamedFrom => Some(claimed),
            _ => None,
        };
    }
    Some(match claimed {
        EventKind::Metadata => EventKind::Metadata,
        // A rename gives the destination a new name but not a new birth time, so the clock below
        // would call it a rewrite. It is an arrival, and the claim is the only evidence of that.
        EventKind::RenamedTo => EventKind::RenamedTo,
        // A path can only arrive once. Birth time alone would say "created" for every write a file
        // ever receives, since a file born after the watch attached stays born after the watch
        // attached; the ledger is what distinguishes the arrival from the writes that follow it.
        _ if !announced && born_under_observation(probe.created_ns, started_ns, claimed) => {
            EventKind::Created
        }
        _ => EventKind::Modified,
    })
}

/// Whether a path came into existence at or after `started_ns`, which is the only way to tell a
/// creation from a rewrite once the two have been merged into one flag set.
///
/// Falls back to the backend's own claim when the file system will not say — a birth time is not
/// universal even on macOS, and guessing "modified" there would silently downgrade every creation
/// on such a volume.
fn born_under_observation(created_ns: Option<u64>, started_ns: u64, claimed: EventKind) -> bool {
    created_ns.map_or(
        matches!(claimed, EventKind::Created | EventKind::RenamedTo),
        |born_ns| born_ns >= started_ns,
    )
}

/// State shared with the backend thread.
///
/// Deliberately does *not* contain the backend handle, so the event handler closure can hold an
/// `Arc<Core>` without creating a reference cycle that would keep the watcher alive forever.
pub(crate) struct Core {
    queue: EventQueue,
    events: broadcast::Sender<FileEvent>,
    config: WatcherConfig,
    /// What was last reported per path. Serves both coalescing and synthesized-event
    /// de-duplication; see [`Core::suppressed`].
    ///
    /// Bounded structurally, so no code path here has to think about how large it might get.
    coalesce: Mutex<BoundedMap<LastDelivered>>,
    /// When the backend last attached, in nanoseconds since the Unix epoch. A path whose birth
    /// time is at or after this was created under observation. See [`born_under_observation`].
    started_ns: AtomicU64,
    /// Whether this backend reports a *union of flags* rather than discrete operations, and so
    /// needs its event kinds re-derived from the file system.
    ///
    /// True only on `FSEvents`. macOS reports everything that has happened to a path since it was
    /// last mentioned, merged into one flag set, which `notify` then expands into several events:
    /// one rewrite of an existing file arrives as `created` + `metadata` + `modified`, and a single
    /// `rm` arrives as `created` + `deleted` + `metadata`. Apple's guidance is that the flags are
    /// advisory and the file system is the authority. `inotify` and `ReadDirectoryChangesW`
    /// describe discrete operations, are believed as given, and pay nothing for this.
    derives_kinds: bool,
    scope: RwLock<Vec<WatchEntry>>,
    running: AtomicBool,
    reconciler: Reconciler,
    events_synthesized: AtomicU64,
}

impl Core {
    /// The configuration this watcher was built with.
    pub(crate) fn config(&self) -> &WatcherConfig {
        &self.config
    }

    /// Whether events may currently be delivered.
    pub(crate) fn is_running(&self) -> bool {
        self.running.load(Ordering::Acquire)
    }

    /// The work list of directories awaiting reconciliation.
    pub(crate) fn reconciler(&self) -> &Reconciler {
        &self.reconciler
    }

    /// Handle one item from the backend.
    fn ingest(&self, result: notify::Result<notify::Event>) {
        // Events observed before `start()` finished installing watches, or after `stop()`, are
        // not part of any consumer's stream.
        if !self.is_running() {
            return;
        }

        let event = match result {
            Ok(event) => event,
            Err(err) => {
                // A watch that could not be installed means a subtree is unobserved; that is a
                // correctness gap, so ask for a re-scan. Other backend errors do not by
                // themselves imply lost events.
                if matches!(err.kind, notify::ErrorKind::MaxFilesWatch) {
                    warn!(error = %err, "watch limit reached; requesting rescan");
                    self.signal_rescan();
                } else {
                    warn!(error = %err, "watcher backend error");
                }
                return;
            }
        };

        if event.need_rescan() {
            debug!("backend reported dropped events; requesting rescan");
            self.signal_rescan();
            return;
        }

        trace!(?event, "backend event");
        let cookie = event.tracker().map(|tracker| tracker as u64);
        for translated in translate(&event) {
            self.emit(translated, cookie);
        }
    }

    fn emit(&self, translated: Translated, cookie: Option<u64>) {
        let Translated {
            path,
            kind,
            directory_hint,
        } = translated;

        if !self.in_scope(&path) {
            trace!(path = %path.display(), "event outside watch scope");
            return;
        }
        if !self.config.filter.matches(&path) {
            trace!(path = %path.display(), "event filtered");
            return;
        }

        let probe = self.probe(&path, kind, directory_hint);

        // Correct the kind before anything reads it, rather than at the far end of the queue. Both
        // decisions below depend on it: a rewrite that arrived labelled `created` would otherwise
        // be queued for a directory scan it does not need, and would enter the delivery ledger as
        // an arrival, telling the reconciler this path had already been announced when it had not.
        let kind = if self.derives_kinds {
            let Some(derived) = derived_kind(
                kind,
                &probe,
                self.started_ns.load(Ordering::Relaxed),
                self.announced(&path),
            ) else {
                trace!(path = %path.display(), ?kind, "event contradicted by the file system");
                return;
            };
            derived
        } else {
            kind
        };

        // A directory that has just appeared inside a recursive watch is not yet watched on every
        // backend, so anything already inside it may never be reported. Queue it for
        // reconciliation *before* the coalescing check, because whether the consumer needs one
        // wake-up or two says nothing about whether the subtree was observed. See `crate::scan`.
        if probe.is_directory
            && matches!(kind, EventKind::Created | EventKind::RenamedTo)
            && self.in_recursive_scope(&path)
            && !self.reconciler.note(&path)
        {
            warn!(
                path = %path.display(),
                "too many unreconciled directories; requesting rescan"
            );
            self.signal_rescan();
        }

        if self.suppressed(&path, kind, probe.exists, Origin::Backend) {
            trace!(path = %path.display(), ?kind, "event coalesced");
            return;
        }

        self.deliver(
            FileEvent::new(path, kind, probe.size, probe.is_directory).with_cookie(cookie),
        );
    }

    /// Report an entry found by [reconciling](crate::scan) a newly-watched directory.
    ///
    /// Synthesized events are indistinguishable from real ones to the consumer by design — the
    /// point is that a file either produced a kernel event or gets this one — and are counted
    /// separately in [`WatcherStats::events_synthesized`] so the behaviour stays observable.
    pub(crate) fn emit_synthesized(
        &self,
        path: &Path,
        kind: EventKind,
        size: u64,
        is_directory: bool,
    ) {
        if !self.is_running() || !self.in_scope(path) || !self.config.filter.matches(path) {
            return;
        }
        if self.suppressed(path, kind, true, Origin::Synthesized) {
            trace!(path = %path.display(), "already reported; not synthesizing");
            return;
        }
        debug!(path = %path.display(), ?kind, "synthesized from directory scan");
        self.events_synthesized.fetch_add(1, Ordering::Relaxed);
        self.deliver(FileEvent::new(path.to_path_buf(), kind, size, is_directory));
    }

    /// Queue an event and fan it out, honouring the bound.
    fn deliver(&self, event: FileEvent) {
        // Each event owns a `PathBuf`, so the copy the fan-out stream needs is a heap allocation.
        // Taking it only when someone is actually subscribed matters because `poll` is the primary
        // interface: without this check, the common configuration pays an allocation per event
        // purely to drop it, and it pays it hardest during the checkout-sized bursts where it can
        // least be afforded.
        //
        // Racing a `subscribe` here can cost that subscriber this one event, which is within what
        // the fan-out already promises: a receiver observes what was sent after it subscribed, and
        // `send` discards the event anyway when the count is zero.
        let fanout = (self.events.receiver_count() > 0).then(|| event.clone());
        match self.queue.push(event) {
            Push::Accepted => {
                if let Some(event) = fanout {
                    // A send failure only means the last subscriber left in the meantime.
                    let _ = self.events.send(event);
                }
            }
            Push::Overflow { rescan_raised } => {
                if rescan_raised {
                    warn!("event queue full; events are being dropped and a rescan was requested");
                    let _ = self.events.send(FileEvent::rescan());
                }
            }
        }
    }

    pub(crate) fn signal_rescan(&self) {
        if self.queue.raise_rescan() {
            let _ = self.events.send(FileEvent::rescan());
        }
    }

    fn in_scope(&self, path: &Path) -> bool {
        self.scope.read().iter().any(|entry| entry.covers(path))
    }

    /// Whether `path` is inside a watch that was registered as recursive.
    ///
    /// Distinct from [`in_scope`](Self::in_scope): a subdirectory of a *non*-recursive watch is a
    /// direct child and so in scope, but its contents are deliberately not this watcher's
    /// business, and reconciling it would report exactly what the caller asked not to see.
    fn in_recursive_scope(&self, path: &Path) -> bool {
        self.scope
            .read()
            .iter()
            .any(|entry| entry.recursive && entry.covers(path))
    }

    /// Decide whether an event is redundant, and record it in the delivery ledger either way.
    ///
    /// Two different questions share one ledger, because both are answered by "what did we last
    /// tell the consumer about this path, and when".
    ///
    /// **Backend events — leading-edge coalescing.** The first event for a path is delivered
    /// immediately and further repeat noise within [`WatcherConfig::debounce`] is suppressed.
    /// Leading edge rather than trailing edge because latency is the product here — delaying every
    /// event by the window to see whether more arrive would tax every save. Suppression requires
    /// all four of:
    ///
    /// 1. the incoming event is [coalescable](EventKind::is_coalescable);
    /// 2. so was the last one delivered for this path;
    /// 3. the path's existence is unchanged since then;
    /// 4. it is still inside the window.
    ///
    /// Conditions 2 and 3 are what keep a window from spanning a state change. Kind alone is not
    /// enough: a metadata event trailing a removal is coalescable but says nothing about
    /// existence, and without the existence check it would open a window that swallowed the
    /// subsequent re-creation — which is exactly how a bundler ends up serving a file the user
    /// deleted.
    ///
    /// **Synthesized events — de-duplication.** A reconciliation pass restates what is on disk, so
    /// it is redundant once the path's *arrival* has been announced within
    /// [`SYNTH_DEDUPE_WINDOW`]. This must work with coalescing switched off, so unlike the rule
    /// above it does not consult `debounce`. It is one-directional: a *real* event is never
    /// suppressed because a synthesized one preceded it, since a real event means something
    /// actually changed.
    ///
    /// Arrival rather than "reported at all", because the two are not the same when a write beats
    /// the scan. A file created inside a directory that is still being watched loses its
    /// `IN_CREATE` — the watch did not exist yet — but its write lands once the watch is armed, so
    /// the consumer's first and only word on a brand-new file would be `Modified`. Suppressing on
    /// any prior report downgraded exactly those creations to modifications, silently, in about one
    /// full-workspace run in three.
    fn suppressed(&self, path: &Path, kind: EventKind, exists: bool, origin: Origin) -> bool {
        let now = Instant::now();
        let window = self.config.debounce;
        let mut seen = self.coalesce.lock();

        let previous = seen.get(path).copied();
        let redundant = match (origin, previous) {
            (_, None) => false,
            (Origin::Synthesized, Some(last)) => {
                last.announced && now.duration_since(last.at) < SYNTH_DEDUPE_WINDOW
            }
            (Origin::Backend, Some(last)) => {
                !window.is_zero()
                    && kind.is_coalescable()
                    && last.kind.is_coalescable()
                    && last.exists == exists
                    && now.duration_since(last.at) < window
            }
        };

        // The ledger is capped rather than allowed to track every path a busy tree ever produced,
        // and the cap is structural: the map retires its older generation once the newer one fills,
        // which needs no scan and cannot be defeated by every entry being recent. Forgetting an
        // entry can only cost a duplicate event, never a missing one.
        //
        // Which makes *which* entry gets forgotten a question of wasted work, and the answer has to
        // be "not the file being actively rewritten" — the one workload guaranteed to be
        // accompanied by churn elsewhere. So a suppressed event re-records the entry it matched,
        // unchanged, purely to move it into the live generation. Its timestamp is deliberately not
        // advanced: the window runs from the event that was *delivered*, or a file written faster
        // than the debounce interval would be suppressed forever.
        seen.insert(
            path,
            match previous {
                Some(last) if redundant => last,
                // A removal resets the announcement: the next arrival is news again.
                _ => LastDelivered {
                    at: now,
                    kind,
                    exists,
                    announced: kind.is_arrival()
                        || previous.is_some_and(|last| last.announced && !kind.is_removal()),
                },
            },
        );
        redundant
    }

    /// Inspect a path at event time.
    ///
    /// The backend's directory hint wins when it has one, because it was accurate when the event
    /// was generated; `stat` only reflects the present.
    ///
    /// Removals are normally not stat'd: the name may already have been reused, and reporting the
    /// *successor's* size for a delete would be worse than reporting nothing. That reasoning holds
    /// where a removal is a discrete fact the kernel reported. It does not hold on a
    /// [flag-union backend](Self::derives_kinds), where "deleted" is one bit in a summary of
    /// everything that happened to the path and may sit beside "created" in the same summary; there
    /// the only way to find out whether the path is gone is to look.
    fn probe(&self, path: &Path, kind: EventKind, directory_hint: Option<bool>) -> Probe {
        if kind.is_removal() && !self.derives_kinds {
            return Probe {
                size: 0,
                is_directory: directory_hint.unwrap_or(false),
                exists: false,
                created_ns: None,
            };
        }
        let metadata = self.metadata(path).ok();
        let is_directory = match (directory_hint, &metadata) {
            (Some(is_directory), _) => is_directory,
            (None, Some(metadata)) => metadata.is_dir(),
            (None, None) => false,
        };
        Probe {
            size: match &metadata {
                Some(metadata) if !is_directory => metadata.len(),
                _ => 0,
            },
            is_directory,
            exists: metadata.is_some(),
            created_ns: metadata.as_ref().and_then(|metadata| {
                metadata
                    .created()
                    .ok()
                    .and_then(|born| born.duration_since(UNIX_EPOCH).ok())
                    .map(|since| u64::try_from(since.as_nanos()).unwrap_or(u64::MAX))
            }),
        }
    }

    /// Whether the consumer has already been told that this path arrived.
    ///
    /// A peek at the same ledger [`suppressed`](Self::suppressed) maintains, taken before it is
    /// updated. Forgetting an entry — the ledger is bounded — can only cost a path a second
    /// `Created`, which is the cost the ledger already documents for eviction.
    fn announced(&self, path: &Path) -> bool {
        self.coalesce
            .lock()
            .get(path)
            .is_some_and(|last| last.announced)
    }

    /// [`suppressed`](Self::suppressed) for a backend event, which is what coalescing tests mean.
    #[cfg(test)]
    fn coalesced(&self, path: &Path, kind: EventKind, exists: bool) -> bool {
        self.suppressed(path, kind, exists, Origin::Backend)
    }

    fn metadata(&self, path: &Path) -> std::io::Result<std::fs::Metadata> {
        if self.config.follow_symlinks {
            std::fs::metadata(path)
        } else {
            std::fs::symlink_metadata(path)
        }
    }
}

/// A cross-platform file system watcher.
///
/// # Lifecycle
///
/// [`new`](Self::new) allocates state but touches no kernel resource. Paths may be registered
/// with [`watch`](Self::watch) before or after [`start`](Self::start). `start` installs the
/// watches and attaches the backend thread; `stop` detaches and joins it. Both are idempotent
/// and may be called from any thread. [`Drop`] stops the watcher, so no thread outlives the
/// value.
///
/// Events observed between the first `watch` call and `start` returning are not delivered:
/// delivery begins once `start` has installed every registered watch.
///
/// # Event mapping
///
/// | `notify` event | [`EventKind`] |
/// |---|---|
/// | `Create(_)` | [`Created`](EventKind::Created) |
/// | `Modify(Data(_))`, `Modify(Any)`, `Modify(Other)`, `Any`, `Other` | [`Modified`](EventKind::Modified) |
/// | `Modify(Metadata(_))` | [`Metadata`](EventKind::Metadata) |
/// | `Modify(Name(From))` | [`RenamedFrom`](EventKind::RenamedFrom) |
/// | `Modify(Name(To))` | [`RenamedTo`](EventKind::RenamedTo) |
/// | `Modify(Name(Any \| Other))` | [`RenamedTo`](EventKind::RenamedTo) if the path exists, else [`RenamedFrom`](EventKind::RenamedFrom) |
/// | `Modify(Name(Both))` | *dropped* — the backend that produces it also emits the `From`/`To` pair |
/// | `Remove(_)` | [`Deleted`](EventKind::Deleted) |
/// | `Access(_)` | *dropped* — reads and closes are not changes; a write already surfaced as `Modify` |
/// | anything flagged `Rescan` | [`RescanRequired`](EventKind::RescanRequired) |
///
/// # Example
///
/// ```no_run
/// use retrigger_system::{Watcher, WatcherConfig};
/// use std::time::Duration;
///
/// let watcher = Watcher::new(WatcherConfig::default())?;
/// watcher.watch(std::path::Path::new("src"), true)?;
/// watcher.start()?;
/// while let Some(event) = watcher.recv_timeout(Duration::from_secs(1)) {
///     println!("{:?} {}", event.kind, event.path.display());
/// }
/// watcher.stop()?;
/// # Ok::<(), retrigger_system::WatchError>(())
/// ```
pub struct Watcher {
    core: Arc<Core>,
    /// The backend handle. Dropping it joins the backend thread, which is how `stop` joins.
    /// Never locked from the event handler, so the handler can never deadlock against `stop`.
    backend: Mutex<Option<RecommendedWatcher>>,
    /// The reconciler thread (see [`crate::scan`]). Joined by `stop` before the backend is
    /// dropped, so no scan can outlive the watcher.
    reconciler: Mutex<Option<JoinHandle<()>>>,
}

impl Watcher {
    /// Create a watcher. No kernel resources are acquired until [`start`](Self::start).
    ///
    /// # Errors
    ///
    /// Currently infallible, but returns `Result` because acquiring backend resources here is a
    /// plausible future change and callers should not have to be rewritten for it.
    pub fn new(config: WatcherConfig) -> Result<Self, WatchError> {
        let capacity = config.capacity.max(1);
        // tokio's broadcast ring is allocated up front, so it is capped independently of the
        // poll queue: a 100k-capacity queue should not cost 100k preallocated slots per
        // subscriber generation. Subscribers may therefore lag before the queue overflows.
        let (events, _) = broadcast::channel(capacity.min(BROADCAST_CAPACITY_LIMIT));
        Ok(Self {
            core: Arc::new(Core {
                queue: EventQueue::new(capacity),
                events,
                config,
                coalesce: Mutex::new(BoundedMap::new(COALESCE_MAP_LIMIT)),
                started_ns: AtomicU64::new(now_ns()),
                derives_kinds: detect_backend() == Backend::FsEvents,
                scope: RwLock::new(Vec::new()),
                running: AtomicBool::new(false),
                reconciler: Reconciler::default(),
                events_synthesized: AtomicU64::new(0),
            }),
            backend: Mutex::new(None),
            reconciler: Mutex::new(None),
        })
    }

    /// Register `path`.
    ///
    /// `recursive` watches the whole subtree, including directories created *after* this call.
    /// A non-recursive watch reports only the directory itself and its direct children. Watching
    /// a file rather than a directory is allowed and reports only that file.
    ///
    /// Re-watching a path replaces its recursion mode. Safe to call before or after
    /// [`start`](Self::start).
    ///
    /// # Errors
    ///
    /// - [`WatchError::NotFound`] if the path does not exist.
    /// - [`WatchError::PermissionDenied`] if it cannot be inspected.
    /// - [`WatchError::WatchLimitExceeded`] if the kernel is out of watch descriptors.
    pub fn watch(&self, path: &Path, recursive: bool) -> Result<(), WatchError> {
        // Checked here so the error is identical whether or not the watcher is running; the
        // backend would otherwise only notice at `start` time.
        self.core
            .metadata(path)
            .map_err(|err| WatchError::from_io(path, err))?;

        let entry = WatchEntry {
            path: path.to_path_buf(),
            canonical: std::fs::canonicalize(path).ok(),
            recursive,
        };

        let mut backend = self.backend.lock();
        if let Some(backend) = backend.as_mut() {
            backend
                .watch(path, mode(recursive))
                .map_err(|e| WatchError::from_notify(path, e))?;
        }
        let mut scope = self.core.scope.write();
        scope.retain(|existing| existing.path != entry.path);
        scope.push(entry);
        Ok(())
    }

    /// Stop watching `path`.
    ///
    /// # Errors
    ///
    /// [`WatchError::NotFound`] if the path was never registered.
    pub fn unwatch(&self, path: &Path) -> Result<(), WatchError> {
        let mut backend = self.backend.lock();
        {
            let mut scope = self.core.scope.write();
            let before = scope.len();
            scope.retain(|existing| existing.path != path);
            if scope.len() == before {
                return Err(WatchError::NotFound(path.to_path_buf()));
            }
        }
        if let Some(backend) = backend.as_mut() {
            backend
                .unwatch(path)
                .map_err(|e| WatchError::from_notify(path, e))?;
        }
        Ok(())
    }

    /// Attach the backend and begin delivering events.
    ///
    /// Idempotent: calling it on a running watcher is a no-op that returns `Ok`.
    ///
    /// # Errors
    ///
    /// - [`WatchError::NotFound`] if a registered path disappeared since it was registered.
    /// - [`WatchError::WatchLimitExceeded`] if the kernel is out of watch descriptors.
    /// - [`WatchError::Backend`] if the backend could not be created.
    pub fn start(&self) -> Result<(), WatchError> {
        let mut backend = self.backend.lock();
        if backend.is_some() {
            return Ok(());
        }

        // Read before attaching, never after: a file created during the gap must count as created
        // under observation, and the other rounding would report it as a modification of something
        // that was never seen to arrive.
        self.core.started_ns.store(now_ns(), Ordering::Relaxed);

        let core = Arc::clone(&self.core);
        let notify_config = notify::Config::default()
            .with_follow_symlinks(self.core.config.follow_symlinks)
            .with_poll_interval(Duration::from_secs(1));
        let mut watcher = RecommendedWatcher::new(move |res| core.ingest(res), notify_config)
            .map_err(WatchError::Backend)?;

        for entry in self.core.scope.read().iter() {
            watcher
                .watch(&entry.path, mode(entry.recursive))
                .map_err(|e| WatchError::from_notify(&entry.path, e))?;
        }

        // Only now is the watch set complete, so only now may events be delivered. Anything the
        // backend produced while watches were being installed is dropped by the `running` gate,
        // which keeps "events arrive after start() returns" true rather than approximately true.
        self.core.running.store(true, Ordering::Release);
        self.core.queue.set_active(true);
        *backend = Some(watcher);

        self.core.reconciler.resume();
        let core = Arc::clone(&self.core);
        // A failed spawn is not fatal: the watcher still reports everything the backend reports,
        // it just cannot close the newly-created-directory gap. Saying so is better than refusing
        // to start, and better than pretending.
        match std::thread::Builder::new()
            .name("retrigger-reconcile".to_owned())
            .spawn(move || scan::run(&core))
        {
            Ok(handle) => *self.reconciler.lock() = Some(handle),
            Err(err) => warn!(
                error = %err,
                "could not start the directory reconciler; \
                 files written into a directory as it is created may be missed"
            ),
        }
        Ok(())
    }

    /// Detach the backend, joining its thread.
    ///
    /// Idempotent, and safe to call from a different thread than [`start`](Self::start)
    /// or concurrently with [`poll`](Self::poll). Events already queued remain readable after
    /// stopping; blocked [`recv_timeout`](Self::recv_timeout) callers wake immediately once the
    /// queue is drained.
    ///
    /// # Errors
    ///
    /// Currently infallible; returns `Result` so callers need not change if detaching becomes
    /// fallible.
    pub fn stop(&self) -> Result<(), WatchError> {
        self.shutdown();
        Ok(())
    }

    fn shutdown(&self) {
        // Close the gate first so the handler stops enqueueing while the backend winds down.
        self.core.running.store(false, Ordering::Release);

        // Join the reconciler before taking the backend lock. It never touches the backend, so the
        // only ordering requirement is that nothing waits on a lock the other side is holding —
        // joining first keeps that trivially true, and a scan in flight finishes within one
        // bounded directory read.
        self.core.reconciler.stop();
        if let Some(handle) = self.reconciler.lock().take() {
            // A reconciler that panicked (it does not, but a panic must not become a hang) has
            // already stopped, which is all this needs.
            let _ = handle.join();
        }

        let handle = self.backend.lock().take();
        // Dropping the backend joins its thread. Done outside the handler's lock set, and the
        // handler never touches `self.backend`, so this cannot deadlock.
        drop(handle);
        self.core.queue.set_active(false);
        self.core.coalesce.lock().clear();
    }

    /// Take the next event without blocking.
    ///
    /// Returns `None` when nothing is pending, including before [`start`](Self::start).
    #[must_use]
    pub fn poll(&self) -> Option<FileEvent> {
        self.core.queue.pop()
    }

    /// Take the next event, waiting up to `timeout`.
    ///
    /// Returns `None` on timeout, and immediately when the watcher is not running and the queue
    /// is empty.
    #[must_use]
    pub fn recv_timeout(&self, timeout: Duration) -> Option<FileEvent> {
        self.core.queue.pop_wait(timeout)
    }

    /// Subscribe to the fan-out stream.
    ///
    /// Independent of [`poll`](Self::poll): every accepted event goes to both. Broadcast is
    /// lossy by design — a subscriber that falls more than `capacity` events behind receives
    /// [`RecvError::Lagged`](tokio::sync::broadcast::error::RecvError::Lagged) rather than
    /// stalling the watcher, and should treat that like
    /// [`EventKind::RescanRequired`](crate::EventKind::RescanRequired).
    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<FileEvent> {
        self.core.events.subscribe()
    }

    /// Read the counters. See [`WatcherStats`] for the invariant they satisfy.
    #[must_use]
    pub fn stats(&self) -> WatcherStats {
        let (events_queued, events_dropped, events_delivered, queue_pending) =
            self.core.queue.snapshot();
        WatcherStats {
            events_queued,
            events_dropped,
            events_delivered,
            events_synthesized: self.core.events_synthesized.load(Ordering::Relaxed),
            watched_paths: self.core.scope.read().len(),
            queue_pending,
            queue_capacity: self.core.queue.capacity(),
            is_running: self.core.is_running(),
        }
    }

    /// Which kernel facility this build will use.
    ///
    /// Known before [`start`](Self::start), because the backend is selected at compile time.
    #[must_use]
    pub fn backend(&self) -> Backend {
        detect_backend()
    }

    /// Whether the backend is attached.
    #[must_use]
    pub fn is_running(&self) -> bool {
        self.core.is_running()
    }

    /// The shared state, for tests that exercise it without a live backend.
    #[cfg(test)]
    pub(crate) fn core_for_test(&self) -> &Core {
        &self.core
    }

    /// Open the delivery gate without attaching a backend, so a test can drive the scan path
    /// directly and read what it produced.
    #[cfg(test)]
    pub(crate) fn force_running_for_test(&self) {
        self.core.running.store(true, Ordering::Release);
    }

    /// The paths currently registered, with their recursion mode.
    #[must_use]
    pub fn watched(&self) -> Vec<(PathBuf, bool)> {
        self.core
            .scope
            .read()
            .iter()
            .map(|entry| (entry.path.clone(), entry.recursive))
            .collect()
    }
}

impl Drop for Watcher {
    fn drop(&mut self) {
        self.shutdown();
    }
}

impl std::fmt::Debug for Watcher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The occupancy figures are here because "the watcher's memory is bounded" is a promise this
        // crate makes, and a promise nobody can read is one nobody can check. Both walk their
        // structure, which is why they are computed when a human asks and never on the event path.
        let ledger = self.core.coalesce.lock();
        f.debug_struct("Watcher")
            .field("backend", &self.backend())
            .field("running", &self.is_running())
            .field("watched_paths", &self.core.scope.read().len())
            .field("ledger_entries", &ledger.len())
            .field("ledger_bytes", &ledger.bytes())
            .field("queue_bytes", &self.core.queue.retained_bytes())
            // The backend and reconciler handles are threads; `running` already says whether they
            // are attached, and neither has a representation worth printing.
            .finish_non_exhaustive()
    }
}

fn mode(recursive: bool) -> RecursiveMode {
    if recursive {
        RecursiveMode::Recursive
    } else {
        RecursiveMode::NonRecursive
    }
}

/// One backend event, resolved onto this crate's vocabulary.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Translated {
    path: PathBuf,
    kind: EventKind,
    /// What the backend said about directory-ness, when it said anything. Authoritative for
    /// removals, where the path can no longer be inspected.
    directory_hint: Option<bool>,
}

/// Map one backend event onto zero or more translated events.
///
/// See the table on [`Watcher`] for the full mapping.
// Arms that drop an event share a body but not a reason; merging them would merge the comments
// that record which backend emits what, which is the only reason this function is auditable.
#[allow(clippy::match_same_arms)]
fn translate(event: &notify::Event) -> Vec<Translated> {
    use notify::EventKind as Nk;

    let (kind, directory_hint) = match event.kind {
        Nk::Create(create) => (
            EventKind::Created,
            match create {
                CreateKind::Folder => Some(true),
                CreateKind::File => Some(false),
                _ => None,
            },
        ),
        Nk::Remove(remove) => (
            EventKind::Deleted,
            match remove {
                RemoveKind::Folder => Some(true),
                RemoveKind::File => Some(false),
                _ => None,
            },
        ),
        Nk::Modify(ModifyKind::Metadata(_)) => (EventKind::Metadata, None),
        Nk::Modify(ModifyKind::Name(RenameMode::From)) => (EventKind::RenamedFrom, None),
        Nk::Modify(ModifyKind::Name(RenameMode::To)) => (EventKind::RenamedTo, None),
        // inotify emits `Both` *in addition to* the `From`/`To` pair for a rename whose two
        // sides are both watched, so honouring it would duplicate every rename. No other
        // backend produces it.
        Nk::Modify(ModifyKind::Name(RenameMode::Both)) => return Vec::new(),
        // FSEvents cannot say which side of a rename a path is (see `notify`'s fsevent backend:
        // "FSEvents provides no mechanism to associate the old and new sides of a rename"), so
        // existence is the only available discriminator.
        Nk::Modify(ModifyKind::Name(RenameMode::Any | RenameMode::Other)) => {
            return event
                .paths
                .iter()
                .map(|path| Translated {
                    path: path.clone(),
                    kind: match path.symlink_metadata() {
                        Ok(_) => EventKind::RenamedTo,
                        Err(_) => EventKind::RenamedFrom,
                    },
                    directory_hint: None,
                })
                .collect();
        }
        Nk::Modify(_) | Nk::Any | Nk::Other => (EventKind::Modified, None),
        // Reads, opens and closes are not changes. A write that mattered already arrived as a
        // `Modify`, so forwarding `Access` would only multiply wake-ups.
        Nk::Access(_) => return Vec::new(),
    };

    event
        .paths
        .iter()
        .map(|path| Translated {
            path: path.clone(),
            kind,
            directory_hint,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{DataChange, MetadataKind};
    use notify::EventKind as Nk;

    fn notify_event(kind: Nk, paths: &[&str]) -> notify::Event {
        notify::Event {
            kind,
            paths: paths.iter().map(PathBuf::from).collect(),
            attrs: notify::event::EventAttributes::new(),
        }
    }

    /// `(path, kind, directory_hint)` triples, for terse assertions.
    fn mapped(event: &notify::Event) -> Vec<(PathBuf, EventKind, Option<bool>)> {
        translate(event)
            .into_iter()
            .map(|t| (t.path, t.kind, t.directory_hint))
            .collect()
    }

    #[test]
    fn create_maps_to_created_and_carries_the_file_hint() {
        let event = notify_event(Nk::Create(CreateKind::File), &["/a/b.txt"]);
        assert_eq!(
            mapped(&event),
            vec![(PathBuf::from("/a/b.txt"), EventKind::Created, Some(false))]
        );
    }

    #[test]
    fn folder_hints_survive_translation() {
        let created = notify_event(Nk::Create(CreateKind::Folder), &["/a/dir"]);
        assert_eq!(
            mapped(&created),
            vec![(PathBuf::from("/a/dir"), EventKind::Created, Some(true))]
        );
        // The hint matters most here: a deleted directory can no longer be stat'd, so without
        // it `is_directory` would be wrong for every directory removal.
        let removed = notify_event(Nk::Remove(RemoveKind::Folder), &["/a/dir"]);
        assert_eq!(
            mapped(&removed),
            vec![(PathBuf::from("/a/dir"), EventKind::Deleted, Some(true))]
        );
    }

    #[test]
    fn unspecified_create_and_remove_have_no_hint() {
        let created = notify_event(Nk::Create(CreateKind::Any), &["/a/x"]);
        assert_eq!(mapped(&created)[0].2, None);
        let removed = notify_event(Nk::Remove(RemoveKind::Any), &["/a/x"]);
        assert_eq!(mapped(&removed)[0].2, None);
    }

    #[test]
    fn data_change_maps_to_modified() {
        let event = notify_event(
            Nk::Modify(ModifyKind::Data(DataChange::Content)),
            &["/a/b.txt"],
        );
        assert_eq!(
            mapped(&event),
            vec![(PathBuf::from("/a/b.txt"), EventKind::Modified, None)]
        );
    }

    #[test]
    fn metadata_change_is_distinct_from_content_change() {
        let event = notify_event(
            Nk::Modify(ModifyKind::Metadata(MetadataKind::Permissions)),
            &["/a/b.txt"],
        );
        assert_eq!(
            mapped(&event),
            vec![(PathBuf::from("/a/b.txt"), EventKind::Metadata, None)]
        );
    }

    #[test]
    fn remove_maps_to_deleted() {
        let event = notify_event(Nk::Remove(RemoveKind::File), &["/a/b.txt"]);
        assert_eq!(
            mapped(&event),
            vec![(PathBuf::from("/a/b.txt"), EventKind::Deleted, Some(false))]
        );
    }

    #[test]
    fn rename_from_and_to_are_distinguished() {
        let from = notify_event(Nk::Modify(ModifyKind::Name(RenameMode::From)), &["/a/old"]);
        assert_eq!(
            mapped(&from),
            vec![(PathBuf::from("/a/old"), EventKind::RenamedFrom, None)]
        );
        let to = notify_event(Nk::Modify(ModifyKind::Name(RenameMode::To)), &["/a/new"]);
        assert_eq!(
            mapped(&to),
            vec![(PathBuf::from("/a/new"), EventKind::RenamedTo, None)]
        );
    }

    #[test]
    fn rename_both_is_dropped_as_redundant() {
        let event = notify_event(
            Nk::Modify(ModifyKind::Name(RenameMode::Both)),
            &["/a/old", "/a/new"],
        );
        assert!(translate(&event).is_empty());
    }

    #[test]
    fn ambiguous_rename_is_resolved_by_existence() {
        let dir = tempfile::tempdir().expect("tempdir");
        let existing = dir.path().join("exists.txt");
        std::fs::write(&existing, b"x").expect("write");
        let missing = dir.path().join("gone.txt");

        let event = notify_event(
            Nk::Modify(ModifyKind::Name(RenameMode::Any)),
            &[
                existing.to_str().expect("utf8"),
                missing.to_str().expect("utf8"),
            ],
        );
        assert_eq!(
            mapped(&event),
            vec![
                (existing, EventKind::RenamedTo, None),
                (missing, EventKind::RenamedFrom, None),
            ]
        );
    }

    #[test]
    fn access_events_are_dropped() {
        use notify::event::{AccessKind, AccessMode};
        let event = notify_event(
            Nk::Access(AccessKind::Close(AccessMode::Write)),
            &["/a/b.txt"],
        );
        assert!(translate(&event).is_empty());
    }

    #[test]
    fn unknown_kinds_degrade_to_modified() {
        for kind in [Nk::Any, Nk::Other, Nk::Modify(ModifyKind::Other)] {
            let event = notify_event(kind, &["/a/b.txt"]);
            assert_eq!(
                mapped(&event),
                vec![(PathBuf::from("/a/b.txt"), EventKind::Modified, None)],
                "{kind:?} should degrade to Modified rather than vanish"
            );
        }
    }

    #[test]
    fn multi_path_events_translate_every_path() {
        let event = notify_event(Nk::Create(CreateKind::File), &["/a", "/b"]);
        assert_eq!(
            mapped(&event),
            vec![
                (PathBuf::from("/a"), EventKind::Created, Some(false)),
                (PathBuf::from("/b"), EventKind::Created, Some(false)),
            ]
        );
    }

    #[test]
    fn recursive_entry_covers_whole_subtree() {
        let entry = WatchEntry {
            path: PathBuf::from("/root"),
            canonical: None,
            recursive: true,
        };
        assert!(entry.covers(Path::new("/root")));
        assert!(entry.covers(Path::new("/root/a.txt")));
        assert!(entry.covers(Path::new("/root/a/b/c.txt")));
        assert!(!entry.covers(Path::new("/elsewhere/a.txt")));
        assert!(!entry.covers(Path::new("/rootbeer/a.txt")));
    }

    #[test]
    fn non_recursive_entry_covers_only_direct_children() {
        let entry = WatchEntry {
            path: PathBuf::from("/root"),
            canonical: None,
            recursive: false,
        };
        assert!(entry.covers(Path::new("/root")));
        assert!(entry.covers(Path::new("/root/a.txt")));
        assert!(!entry.covers(Path::new("/root/sub/a.txt")));
    }

    #[test]
    fn canonical_root_also_covers() {
        let entry = WatchEntry {
            path: PathBuf::from("/var/x"),
            canonical: Some(PathBuf::from("/private/var/x")),
            recursive: true,
        };
        assert!(entry.covers(Path::new("/var/x/a.txt")));
        assert!(
            entry.covers(Path::new("/private/var/x/a.txt")),
            "macOS reports resolved paths; the resolved root must also be in scope"
        );
    }

    #[test]
    fn watching_a_file_covers_exactly_that_file() {
        let entry = WatchEntry {
            path: PathBuf::from("/root/only.txt"),
            canonical: None,
            recursive: false,
        };
        assert!(entry.covers(Path::new("/root/only.txt")));
        assert!(!entry.covers(Path::new("/root/other.txt")));
    }

    #[test]
    fn backend_is_known_before_start() {
        let watcher = Watcher::new(WatcherConfig::default()).expect("new");
        let backend = watcher.backend();
        assert!(!watcher.is_running());
        #[cfg(target_os = "macos")]
        assert_eq!(backend, Backend::FsEvents);
        #[cfg(target_os = "linux")]
        assert_eq!(backend, Backend::Inotify);
        #[cfg(target_os = "windows")]
        assert_eq!(backend, Backend::ReadDirectoryChangesW);
        #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
        let _ = backend;
    }

    #[test]
    fn watcher_is_send_and_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<Watcher>();
        assert_send_sync::<FileEvent>();
        assert_send_sync::<WatchError>();
    }

    #[test]
    fn coalescing_suppresses_repeat_modifies_but_never_deletes() {
        let config = WatcherConfig {
            debounce: Duration::from_secs(60),
            ..Default::default()
        };
        let core = core_for(config);
        let path = Path::new("/x/a.txt");

        assert!(
            !core.coalesced(path, EventKind::Modified, true),
            "first passes"
        );
        assert!(
            core.coalesced(path, EventKind::Modified, true),
            "second collapses"
        );
        assert!(
            core.coalesced(path, EventKind::Metadata, true),
            "metadata too"
        );
        assert!(
            core.coalesced(path, EventKind::Created, true),
            "macOS re-reports ITEM_CREATED for successive writes; that is the same class of noise"
        );
        assert!(
            !core.coalesced(path, EventKind::Deleted, false),
            "a delete changes meaning and must never be swallowed"
        );
        assert!(!core.coalesced(path, EventKind::RenamedFrom, false));
        assert!(!core.coalesced(path, EventKind::RenamedTo, true));
    }

    #[test]
    fn a_create_after_a_delete_is_never_suppressed() {
        let core = core_for(WatcherConfig {
            debounce: Duration::from_secs(60),
            ..Default::default()
        });
        let path = Path::new("/x/a.txt");

        assert!(!core.coalesced(path, EventKind::Modified, true));
        assert!(!core.coalesced(path, EventKind::Deleted, false));
        assert!(
            !core.coalesced(path, EventKind::Created, true),
            "recreating a deleted path is a state change, not repeat noise, even inside the window"
        );
        assert!(
            core.coalesced(path, EventKind::Modified, true),
            "and the window resumes from the new create"
        );
    }

    #[test]
    fn a_metadata_event_on_a_vanished_path_cannot_mask_its_return() {
        // The macOS case that this rule exists for: removing a file yields
        // `Remove` followed by `Modify(Metadata)` for the same path, and the metadata event must
        // not open a window that swallows the file coming back.
        let core = core_for(WatcherConfig {
            debounce: Duration::from_secs(60),
            ..Default::default()
        });
        let path = Path::new("/x/a.txt");

        assert!(!core.coalesced(path, EventKind::Deleted, false));
        assert!(!core.coalesced(path, EventKind::Metadata, false));
        assert!(
            !core.coalesced(path, EventKind::Created, true),
            "existence changed since the last delivery, so this is not repeat noise"
        );
    }

    #[test]
    fn a_create_after_a_rename_away_is_never_suppressed() {
        let core = core_for(WatcherConfig {
            debounce: Duration::from_secs(60),
            ..Default::default()
        });
        let path = Path::new("/x/a.txt");
        assert!(!core.coalesced(path, EventKind::Created, true));
        assert!(!core.coalesced(path, EventKind::RenamedFrom, false));
        assert!(!core.coalesced(path, EventKind::Created, true));
    }

    #[test]
    fn coalescing_is_per_path() {
        let config = WatcherConfig {
            debounce: Duration::from_secs(60),
            ..Default::default()
        };
        let core = core_for(config);
        assert!(!core.coalesced(Path::new("/x/a"), EventKind::Modified, true));
        assert!(
            !core.coalesced(Path::new("/x/b"), EventKind::Modified, true),
            "a different path has its own window"
        );
    }

    #[test]
    fn zero_debounce_disables_coalescing() {
        let core = core_for(WatcherConfig {
            debounce: Duration::ZERO,
            ..Default::default()
        });
        let path = Path::new("/x/a.txt");
        for _ in 0..5 {
            assert!(!core.coalesced(path, EventKind::Modified, true));
        }
        // The ledger is still written: with coalescing off it exists purely so that a
        // reconciliation pass can tell "already announced" from "never announced". Nothing is
        // suppressed by it, which is what the loop above asserts.
        assert!(
            !core.suppressed(path, EventKind::Created, true, Origin::Synthesized),
            "writes never said the file was new, so the restatement is not redundant"
        );
        assert!(
            core.suppressed(path, EventKind::Created, true, Origin::Synthesized),
            "having announced it once, the restatement is redundant"
        );
    }

    /// The inotify race this exists for: a file created inside a directory that is still being
    /// armed loses its `IN_CREATE` outright, because the watch did not exist yet. Its write lands
    /// once the watch is up, so the backend's first and only word on a brand-new file is
    /// `Modified`, and reconciliation is the one thing that will ever call it new. Suppressing on
    /// "reported at all" downgraded those creations to modifications in roughly one full-workspace
    /// run in three.
    #[test]
    fn a_write_that_beat_the_scan_does_not_swallow_the_creation() {
        let core = core_for(WatcherConfig {
            debounce: Duration::ZERO,
            ..Default::default()
        });
        let path = Path::new("/x/fresh/only.txt");

        assert!(!core.coalesced(path, EventKind::Modified, true));
        assert!(
            !core.suppressed(path, EventKind::Created, true, Origin::Synthesized),
            "the consumer was told the file changed, never that it arrived"
        );

        // Having said it once, further passes must stay quiet however much the file is written --
        // the arrival is sticky, so writes cannot re-open the announcement.
        for _ in 0..3 {
            assert!(!core.coalesced(path, EventKind::Modified, true));
            assert!(
                core.suppressed(path, EventKind::Created, true, Origin::Synthesized),
                "a new directory being written to must not report itself over and over"
            );
        }
    }

    #[test]
    fn a_removal_makes_the_next_arrival_news_again() {
        let core = core_for(WatcherConfig {
            debounce: Duration::ZERO,
            ..Default::default()
        });
        let path = Path::new("/x/fresh/gone.txt");

        assert!(!core.coalesced(path, EventKind::Created, true));
        assert!(core.suppressed(path, EventKind::Created, true, Origin::Synthesized));

        assert!(!core.coalesced(path, EventKind::Deleted, false));
        assert!(
            !core.suppressed(path, EventKind::Created, true, Origin::Synthesized),
            "a path that came back is new again, not a restatement of the old one"
        );
    }

    #[test]
    fn a_create_opens_the_window_so_the_following_write_collapses() {
        let core = core_for(WatcherConfig {
            debounce: Duration::from_secs(60),
            ..Default::default()
        });
        let path = Path::new("/x/a.txt");
        assert!(!core.coalesced(path, EventKind::Created, true));
        assert!(
            core.coalesced(path, EventKind::Modified, true),
            "create+write+close from one save should wake the consumer once"
        );
    }

    #[test]
    fn events_outside_the_window_are_not_coalesced() {
        let core = core_for(WatcherConfig {
            debounce: Duration::from_millis(10),
            ..Default::default()
        });
        let path = Path::new("/x/a.txt");
        assert!(!core.coalesced(path, EventKind::Modified, true));
        std::thread::sleep(Duration::from_millis(30));
        assert!(!core.coalesced(path, EventKind::Modified, true));
    }

    /// Randomised event streams against the suppression rules.
    ///
    /// Coalescing is the one place in this crate that deliberately discards events, so it is the one
    /// place where a memory bound could turn into a *correctness* bug: the ledger backing it now
    /// forgets entries by design, and these properties are what must survive that. They are all
    /// one-sided in the safe direction — extra events are permitted, missing ones are not.
    mod suppression_properties {
        use super::*;
        use proptest::prelude::*;

        fn kind() -> impl Strategy<Value = EventKind> {
            prop_oneof![
                Just(EventKind::Created),
                Just(EventKind::Modified),
                Just(EventKind::Metadata),
                Just(EventKind::Deleted),
                Just(EventKind::RenamedFrom),
                Just(EventKind::RenamedTo),
            ]
        }

        /// A handful of paths, so streams collide on the same ledger entries.
        fn path() -> impl Strategy<Value = PathBuf> {
            (0u8..6).prop_map(|n| PathBuf::from(format!("/x/f{n}.ts")))
        }

        proptest! {
            #[test]
            fn a_removal_is_never_suppressed(
                debounce_ms in 0u64..1000,
                stream in prop::collection::vec((path(), kind(), any::<bool>()), 1..200),
            ) {
                // Losing a delete is unrecoverable for a consumer: it would go on believing a file
                // exists. No window, and no eviction from the ledger, may ever swallow one.
                let core = core_for(WatcherConfig {
                    debounce: Duration::from_millis(debounce_ms),
                    ..Default::default()
                });
                for (path, kind, exists) in stream {
                    let suppressed = core.coalesced(&path, kind, exists);
                    if kind.is_removal() {
                        prop_assert!(
                            !suppressed,
                            "{:?} for {} was suppressed",
                            kind,
                            path.display()
                        );
                    }
                }
            }

            #[test]
            fn a_change_of_existence_is_never_suppressed(
                debounce_ms in 0u64..1000,
                stream in prop::collection::vec((path(), kind(), any::<bool>()), 1..200),
            ) {
                // A window must never span a file disappearing or coming back, or the consumer's
                // model of what is on disk silently diverges from disk.
                let core = core_for(WatcherConfig {
                    debounce: Duration::from_millis(debounce_ms),
                    ..Default::default()
                });
                let mut last: std::collections::HashMap<PathBuf, bool> =
                    std::collections::HashMap::new();
                for (path, kind, exists) in stream {
                    let previous = last.get(&path).copied();
                    let suppressed = core.coalesced(&path, kind, exists);
                    if previous.is_some_and(|was| was != exists) {
                        prop_assert!(
                            !suppressed,
                            "existence went {:?} -> {} for {} yet the event was suppressed",
                            previous,
                            exists,
                            path.display()
                        );
                    }
                    if !suppressed {
                        last.insert(path, exists);
                    }
                }
            }

            #[test]
            fn the_first_event_for_a_path_is_never_suppressed(
                debounce_ms in 0u64..1000,
                stream in prop::collection::vec((path(), kind(), any::<bool>()), 1..200),
            ) {
                let core = core_for(WatcherConfig {
                    debounce: Duration::from_millis(debounce_ms),
                    ..Default::default()
                });
                let mut seen: std::collections::HashSet<PathBuf> =
                    std::collections::HashSet::new();
                for (path, kind, exists) in stream {
                    let first = seen.insert(path.clone());
                    let suppressed = core.coalesced(&path, kind, exists);
                    if first {
                        prop_assert!(
                            !suppressed,
                            "the first sight of {} was suppressed",
                            path.display()
                        );
                    }
                }
            }

            #[test]
            fn zero_debounce_suppresses_no_backend_event(
                stream in prop::collection::vec((path(), kind(), any::<bool>()), 1..300),
            ) {
                // The configuration a consumer picks when it wants everything. The ledger is still
                // maintained (reconciliation needs it), so this proves maintaining it cannot leak
                // into the delivery decision.
                let core = core_for(WatcherConfig {
                    debounce: Duration::ZERO,
                    ..Default::default()
                });
                for (path, kind, exists) in stream {
                    prop_assert!(!core.coalesced(&path, kind, exists));
                }
            }
        }
    }

    #[test]
    fn delivery_reaches_the_queue_whether_or_not_anyone_is_subscribed() {
        // The fan-out copy is now conditional, so the poll queue must be proven unaffected by it in
        // both directions: skipping the clone must not skip the event.
        let core = core_for(WatcherConfig::default());
        let event = FileEvent::new("/x/a.txt".into(), EventKind::Modified, 0, false);

        core.deliver(event.clone());
        assert_eq!(
            core.queue.pop().map(|e| e.path),
            Some("/x/a.txt".into()),
            "an event was lost when nothing was subscribed to the fan-out"
        );

        let mut subscriber = core.events.subscribe();
        core.deliver(event);
        assert_eq!(core.queue.pop().map(|e| e.path), Some("/x/a.txt".into()));
        assert_eq!(
            subscriber.try_recv().map(|e| e.path).ok(),
            Some("/x/a.txt".into()),
            "a subscriber missed an event it was present for"
        );
    }

    #[test]
    fn a_file_written_faster_than_the_window_is_still_delivered_when_it_expires() {
        // The starvation this design has to avoid: a suppressed event refreshes the ledger entry's
        // *residency* but never its timestamp, so the window keeps running from the last delivery.
        // An agent saving every few milliseconds must still see its change reach the consumer.
        let core = core_for(WatcherConfig {
            debounce: Duration::from_millis(20),
            ..Default::default()
        });
        let path = Path::new("/x/a.txt");
        assert!(!core.coalesced(path, EventKind::Modified, true));

        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if core.coalesced(path, EventKind::Modified, true) {
                std::thread::sleep(Duration::from_millis(2));
                continue;
            }
            return;
        }
        panic!("continuous writes never surfaced: the debounce window was repeatedly extended");
    }

    #[test]
    fn the_ledger_holds_its_cap_when_nothing_is_old_enough_to_discard() {
        // The case an age-based prune cannot bound: a long debounce window means every entry is
        // recent, so a scan for stale entries would free nothing and the ledger would grow with the
        // tree. Structural rotation does not care how recent the entries are.
        let core = core_for(WatcherConfig {
            debounce: Duration::from_secs(600),
            ..Default::default()
        });
        for i in 0..(COALESCE_MAP_LIMIT * 4) {
            let path = PathBuf::from(format!("/repo/packages/pkg{i}/src/index.ts"));
            assert!(!core.coalesced(&path, EventKind::Modified, true));
            let held = core.coalesce.lock().len();
            assert!(held <= COALESCE_MAP_LIMIT, "ledger grew to {held} at {i}");
        }
    }

    #[test]
    fn the_ledger_holds_its_cap_with_coalescing_switched_off() {
        // Coalescing off is the configuration a consumer picks when it wants every event; the ledger
        // then exists only to de-duplicate reconciliation passes, and must never be the thing that
        // runs the process out of memory.
        let core = core_for(WatcherConfig {
            debounce: Duration::ZERO,
            ..Default::default()
        });
        for i in 0..(COALESCE_MAP_LIMIT * 2) {
            let path = PathBuf::from(format!("/x/{i}"));
            assert!(!core.coalesced(&path, EventKind::Modified, true));
        }
        assert!(
            core.coalesce.lock().len() <= COALESCE_MAP_LIMIT,
            "the ledger must not grow without bound"
        );
    }

    #[test]
    fn an_agent_rewriting_one_file_stays_coalesced_through_unrelated_churn() {
        // The workload most likely to break this: one file rewritten continuously while a build
        // tool churns through thousands of others. The hot file's ledger entry is refreshed on every
        // event, so it must stay in the live generation no matter how much cold traffic rotates
        // past it — otherwise the one file under active editing is the one that loses its
        // suppression and floods the consumer.
        let core = core_for(WatcherConfig {
            debounce: Duration::from_secs(600),
            ..Default::default()
        });
        let hot = Path::new("/repo/src/app.tsx");
        assert!(!core.coalesced(hot, EventKind::Modified, true));

        for i in 0..(COALESCE_MAP_LIMIT * 4) {
            core.coalesced(
                &PathBuf::from(format!("/repo/node_modules/dep{i}/index.js")),
                EventKind::Modified,
                true,
            );
            assert!(
                core.coalesced(hot, EventKind::Modified, true),
                "the actively rewritten file lost its suppression after {i} unrelated events"
            );
        }
    }

    #[test]
    fn a_synthesized_event_is_redundant_once_the_path_has_been_reported() {
        // With coalescing off, so this cannot be mistaken for the debounce window doing the work.
        let core = core_for(WatcherConfig {
            debounce: Duration::ZERO,
            ..Default::default()
        });
        let path = Path::new("/x/a.txt");

        assert!(
            !core.suppressed(path, EventKind::Created, true, Origin::Synthesized),
            "the first sighting of a path is news however it was found"
        );
        assert!(
            core.suppressed(path, EventKind::Created, true, Origin::Synthesized),
            "a later pass restating the same entry is not"
        );
        assert!(
            !core.suppressed(path, EventKind::Modified, true, Origin::Backend),
            "a real change is never suppressed by a scan having mentioned the path"
        );
        assert!(
            core.suppressed(path, EventKind::Created, true, Origin::Synthesized),
            "and any recent report makes a restatement redundant, whatever its kind was"
        );
    }

    #[test]
    fn a_synthesized_event_for_an_unmentioned_path_is_delivered() {
        let core = core_for(WatcherConfig::default());
        assert!(!core.suppressed(
            Path::new("/x/a"),
            EventKind::Created,
            true,
            Origin::Synthesized
        ));
        assert!(
            !core.suppressed(
                Path::new("/x/b"),
                EventKind::Created,
                true,
                Origin::Synthesized
            ),
            "de-duplication is per path"
        );
    }

    #[test]
    fn a_new_directory_inside_a_recursive_watch_is_queued_for_reconciliation() {
        let core = core_for(WatcherConfig {
            debounce: Duration::ZERO,
            ..Default::default()
        });
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().to_path_buf();
        core.scope.write().push(WatchEntry {
            path: root.clone(),
            canonical: None,
            recursive: true,
        });

        let created = root.join("fresh");
        std::fs::create_dir(&created).expect("mkdir");
        core.emit(
            Translated {
                path: created.clone(),
                kind: EventKind::Created,
                directory_hint: Some(true),
            },
            None,
        );
        assert_eq!(core.reconciler.pending_len(), 1);

        // A file is not a subtree, and neither is a delete.
        let file = root.join("plain.txt");
        std::fs::write(&file, b"x").expect("write");
        core.emit(
            Translated {
                path: file,
                kind: EventKind::Created,
                directory_hint: Some(false),
            },
            None,
        );
        core.emit(
            Translated {
                path: created,
                kind: EventKind::Deleted,
                directory_hint: Some(true),
            },
            None,
        );
        assert_eq!(core.reconciler.pending_len(), 1);
    }

    #[test]
    fn a_new_directory_inside_a_non_recursive_watch_is_left_alone() {
        let core = core_for(WatcherConfig::default());
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().to_path_buf();
        core.scope.write().push(WatchEntry {
            path: root.clone(),
            canonical: None,
            recursive: false,
        });

        let created = root.join("fresh");
        std::fs::create_dir(&created).expect("mkdir");
        core.emit(
            Translated {
                path: created,
                kind: EventKind::Created,
                directory_hint: Some(true),
            },
            None,
        );
        assert_eq!(
            core.reconciler.pending_len(),
            0,
            "reconciling would report exactly what a non-recursive watch promises not to"
        );
    }

    #[test]
    fn a_directory_moved_into_a_recursive_watch_is_queued_too() {
        // The wholesale-move case: the entries inside it never produced a creation event anywhere.
        let core = core_for(WatcherConfig::default());
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().to_path_buf();
        core.scope.write().push(WatchEntry {
            path: root.clone(),
            canonical: None,
            recursive: true,
        });

        let moved = root.join("arrived");
        std::fs::create_dir(&moved).expect("mkdir");
        core.emit(
            Translated {
                path: moved,
                kind: EventKind::RenamedTo,
                directory_hint: None,
            },
            None,
        );
        assert_eq!(core.reconciler.pending_len(), 1);
    }

    #[test]
    fn synthesized_events_are_counted_and_scoped() {
        let core = core_for(WatcherConfig {
            debounce: Duration::ZERO,
            ..Default::default()
        });
        let root = PathBuf::from("/x/watched");
        core.scope.write().push(WatchEntry {
            path: root.clone(),
            canonical: None,
            recursive: true,
        });

        core.emit_synthesized(&root.join("a.txt"), EventKind::Created, 3, false);
        core.emit_synthesized(
            &PathBuf::from("/elsewhere/b.txt"),
            EventKind::Created,
            3,
            false,
        );
        assert_eq!(
            core.events_synthesized.load(Ordering::Relaxed),
            1,
            "only in-scope entries are reported, and each report is counted once"
        );

        let event = core.queue.pop().expect("the in-scope entry was queued");
        assert_eq!(event.path, root.join("a.txt"));
        assert_eq!(event.kind, EventKind::Created);
        assert_eq!(event.size, 3);
        assert!(core.queue.pop().is_none());
    }

    #[test]
    fn a_stopped_watcher_synthesizes_nothing() {
        let core = core_for(WatcherConfig::default());
        core.scope.write().push(WatchEntry {
            path: PathBuf::from("/x"),
            canonical: None,
            recursive: true,
        });
        core.running.store(false, Ordering::Release);

        core.emit_synthesized(Path::new("/x/a.txt"), EventKind::Created, 1, false);
        assert_eq!(core.events_synthesized.load(Ordering::Relaxed), 0);
        assert!(core.queue.pop().is_none());
    }

    /// `(size, is_directory, exists)`. Birth time is deliberately excluded: whether a file system
    /// reports one is a property of the volume, not of this code.
    fn shape(probe: &Probe) -> (u64, bool, bool) {
        (probe.size, probe.is_directory, probe.exists)
    }

    #[test]
    fn probe_reports_file_size_and_directory_flag() {
        let core = core_for(WatcherConfig::default());
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("a.txt");
        std::fs::write(&file, b"0123456789").expect("write");

        assert_eq!(
            shape(&core.probe(&file, EventKind::Created, None)),
            (10, false, true)
        );
        assert_eq!(
            shape(&core.probe(dir.path(), EventKind::Created, None)),
            (0, true, true)
        );
    }

    #[test]
    fn probe_never_stats_a_removal_and_trusts_the_hint() {
        let core = core_for(WatcherConfig::default());
        let dir = tempfile::tempdir().expect("tempdir");
        let reused = dir.path().join("reused.txt");
        std::fs::write(&reused, b"successor contents").expect("write");

        // The name exists again, but the delete refers to the file that is gone; reporting the
        // successor's size would be a lie.
        assert_eq!(
            shape(&core.probe(&reused, EventKind::Deleted, None)),
            (0, false, false)
        );
        assert_eq!(
            shape(&core.probe(&reused, EventKind::Deleted, Some(true))),
            (0, true, false),
            "the backend hint is the only source of truth for a removed directory"
        );
    }

    /// The exception to the rule above, and the reason it is stated as one: where "deleted" is a
    /// bit in a summary rather than a reported operation, believing it without looking would drop
    /// a path that is plainly still there.
    #[test]
    fn probe_does_stat_a_removal_on_a_flag_union_backend() {
        let core = core_deriving(WatcherConfig::default());
        let dir = tempfile::tempdir().expect("tempdir");
        let present = dir.path().join("present.txt");
        std::fs::write(&present, b"0123456789").expect("write");

        assert_eq!(
            shape(&core.probe(&present, EventKind::Deleted, None)),
            (10, false, true)
        );
        assert_eq!(
            shape(&core.probe(&dir.path().join("gone.txt"), EventKind::Deleted, None)),
            (0, false, false)
        );
    }

    #[test]
    fn probe_reports_zeroes_for_a_vanished_path() {
        let core = core_for(WatcherConfig::default());
        assert_eq!(
            shape(&core.probe(Path::new("/definitely/not/here"), EventKind::Modified, None)),
            (0, false, false)
        );
    }

    /// A probe of a path that is there, born at `created_ns`.
    fn present(created_ns: Option<u64>) -> Probe {
        Probe {
            size: 1,
            is_directory: false,
            exists: true,
            created_ns,
        }
    }

    const GONE: Probe = Probe {
        size: 0,
        is_directory: false,
        exists: false,
        created_ns: None,
    };

    /// The whole point of the exercise: `FSEvents` says `created` for a file that was merely
    /// rewritten, because the flag set is a union of everything since it last spoke.
    #[test]
    fn a_creation_claimed_for_a_file_older_than_the_watch_is_a_rewrite() {
        let probe = present(Some(1_000));
        assert_eq!(
            derived_kind(EventKind::Created, &probe, 2_000, false),
            Some(EventKind::Modified)
        );
        assert_eq!(
            derived_kind(EventKind::Created, &present(Some(3_000)), 2_000, false),
            Some(EventKind::Created),
            "born after the watch attached, so the claim holds"
        );
    }

    #[test]
    fn a_kind_the_file_system_contradicts_is_dropped() {
        // `rm` arrives as created + deleted + metadata; forwarding the survivors would tell a
        // consumer that a file it was just told to forget is back.
        for claimed in [
            EventKind::Created,
            EventKind::Modified,
            EventKind::Metadata,
            EventKind::RenamedTo,
        ] {
            assert_eq!(derived_kind(claimed, &GONE, 0, false), None, "{claimed:?}");
        }
        for claimed in [EventKind::Deleted, EventKind::RenamedFrom] {
            assert_eq!(
                derived_kind(claimed, &GONE, 0, false),
                Some(claimed),
                "absence corroborates {claimed:?} and does not flatten it"
            );
        }
    }

    #[test]
    fn a_removal_claimed_for_a_path_that_is_there_is_not_a_removal() {
        assert_eq!(
            derived_kind(EventKind::Deleted, &present(Some(1_000)), 2_000, false),
            Some(EventKind::Modified)
        );
    }

    #[test]
    fn a_rename_destination_is_an_arrival_however_old_its_contents() {
        // A rename gives the destination a new name but not a new birth time, so the clock would
        // call this a rewrite; the claim is the only evidence there is.
        assert_eq!(
            derived_kind(EventKind::RenamedTo, &present(Some(1)), u64::MAX, false),
            Some(EventKind::RenamedTo)
        );
        assert!(EventKind::RenamedTo.is_arrival(), "so the ledger agrees");
    }

    /// A file born after the watch attached stays born after the watch attached, so the birth clock
    /// alone would call every write it ever receives a creation. Whether the arrival has already
    /// been announced is what separates the one from the many.
    #[test]
    fn a_file_arrives_once_however_young_it_stays() {
        let young = present(Some(3_000));
        assert_eq!(
            derived_kind(EventKind::Created, &young, 2_000, false),
            Some(EventKind::Created)
        );
        for claimed in [EventKind::Created, EventKind::Modified] {
            assert_eq!(
                derived_kind(claimed, &young, 2_000, true),
                Some(EventKind::Modified),
                "{claimed:?} after the arrival was announced is a write, not a second birth"
            );
        }
    }

    #[test]
    fn a_rename_source_that_is_still_there_is_not_a_rename() {
        assert_eq!(
            derived_kind(EventKind::RenamedFrom, &present(Some(1_000)), 2_000, false),
            Some(EventKind::Modified)
        );
    }

    #[test]
    fn without_a_birth_time_the_backend_is_believed() {
        // Volumes that keep no birth time exist even on macOS. Guessing "modified" there would
        // silently downgrade every creation on such a volume.
        assert_eq!(
            derived_kind(EventKind::Created, &present(None), u64::MAX, false),
            Some(EventKind::Created)
        );
        assert_eq!(
            derived_kind(EventKind::Modified, &present(None), 0, false),
            Some(EventKind::Modified)
        );
    }

    #[test]
    fn a_metadata_change_and_a_rescan_are_passed_through() {
        assert_eq!(
            derived_kind(EventKind::Metadata, &present(Some(u64::MAX)), 0, false),
            Some(EventKind::Metadata),
            "a chmod is not a creation, whatever the birth time says"
        );
        assert_eq!(
            derived_kind(EventKind::RescanRequired, &GONE, 0, false),
            Some(EventKind::RescanRequired),
            "a rescan names no path, so the file system cannot contradict it"
        );
    }

    /// A core that believes its backend, which is every backend but `FSEvents`.
    ///
    /// Pinned rather than detected so that these tests describe one behaviour on every platform:
    /// the flag-union path is exercised by [`core_deriving`] and is just as testable on Linux.
    fn core_for(config: WatcherConfig) -> Core {
        core_with(config, false)
    }

    /// A core that re-derives event kinds from the file system, as it does on `FSEvents`.
    fn core_deriving(config: WatcherConfig) -> Core {
        core_with(config, true)
    }

    fn core_with(config: WatcherConfig, derives_kinds: bool) -> Core {
        let (events, _) = broadcast::channel(16);
        Core {
            queue: EventQueue::new(config.capacity.max(1)),
            events,
            config,
            coalesce: Mutex::new(BoundedMap::new(COALESCE_MAP_LIMIT)),
            started_ns: AtomicU64::new(now_ns()),
            derives_kinds,
            scope: RwLock::new(Vec::new()),
            running: AtomicBool::new(true),
            reconciler: Reconciler::default(),
            events_synthesized: AtomicU64::new(0),
        }
    }
}
