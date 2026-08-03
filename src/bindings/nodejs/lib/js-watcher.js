'use strict';

/**
 * Pure-JavaScript watcher implementing the native addon's `Watcher` contract.
 *
 * Honest differences from the native engine, none of them faked:
 *   - The tree is walked and every directory watched individually, which keeps
 *     semantics identical across platforms at the cost of one file descriptor
 *     per directory (and an `EMFILE` risk on very large trees, surfaced as an
 *     error event rather than a crash). Windows is the exception: there a
 *     per-directory handle is re-issued after each batch it reports and drops
 *     everything that lands in the gap, so a single recursive watch covers the
 *     tree instead. Only the handles differ — the walk, the tracking sets and
 *     the events are the same.
 *   - `fs.watch` cannot correlate the two halves of a rename, so a rename is
 *     reported as `deleted` for the old path and `created` for the new one.
 *     `renamedFrom` / `renamedTo` are never emitted and `cookie` is always
 *     `null`.
 *   - Symlinked directories are not traversed, and — unlike the native engine, which reports the
 *     link itself as a non-directory entry — `snapshot()`/`watchWithSnapshot()` omit it
 *     altogether: both are built on `_walk`, which already drops a symlink for the same reason
 *     `watch()` does (see `_walk`). For the same reason, `snapshot()` here also prunes excluded
 *     subtrees, where the native engine's `Watcher::snapshot` deliberately does not: `_walk` is
 *     the one traversal this engine has, and it already knows how to skip what `watch()` would.
 *   - `backend()` reports `"polling"`, the contract's label for any
 *     non-kernel-native backend.
 *   - On macOS `fs.watch` brings its FSEvents stream up on another thread, so
 *     a write landing within a few milliseconds of `start()` can be missed
 *     outright rather than merely delayed. There is no readiness signal to
 *     wait on; a caller that must not miss the very first change should read
 *     the tree once after `start()` rather than trusting the event stream for
 *     that instant.
 *   - `backend`, `pollCompareContents`, and `atomicWriteNormalization` are
 *     accepted and ignored: this engine has exactly one backend (`fs.watch`),
 *     so there is nothing for a backend selection to choose between, and it
 *     never emits `renamedTo` in the first place (see above), so there is
 *     nothing for atomic-write normalization to fold. `awaitWriteFinish` is
 *     the one option here honestly implemented, on the same single-timer
 *     machinery as `debounceMs`'s trailing correction.
 */

const fs = require('fs');
const path = require('path');

const { Matcher } = require('./matcher');
const { BoundedSet } = require('./bounded');

/**
 * Algorithm named by a snapshot envelope's `algorithm` field.
 *
 * Matches `retrigger_system::SNAPSHOT_ALGORITHM` and the native addon's `JsSnapshotEnvelope`, so a
 * snapshot persisted by one engine is self-describing to a reader that used the other. No entry
 * here carries a digest today; the field is forward-looking, exactly as it is on the Rust side.
 */
const SNAPSHOT_ALGORITHM = 'xxh3-64';

/** Matches `retrigger_system::SNAPSHOT_ENVELOPE_VERSION`. */
const SNAPSHOT_ENVELOPE_VERSION = 1;

/** @type {readonly string[]} */
const EVENT_KINDS = Object.freeze([
  'created',
  'modified',
  'deleted',
  'renamedFrom',
  'renamedTo',
  'metadata',
  'rescanRequired',
]);

/**
 * Kinds a debounce window may absorb.
 *
 * Everything else — a delete, either half of a rename — either changes whether the path exists or
 * says something the next event cannot restate, so it ends the window and is delivered on its own.
 * Collapsing one would change what the stream means rather than how often it fires, and is how a
 * dev server ends up serving a file the user deleted.
 */
const COALESCABLE = new Set(['created', 'modified', 'metadata']);

const DEFAULT_CAPACITY = 8192;

/**
 * Hard ceiling on remembered file paths.
 *
 * The set exists only to tell `created` from `modified`, so its ceiling buys memory safety at the
 * cost of occasionally calling a write to a long-untouched file `created`. Generous enough that a
 * normal project never reaches it, and structurally enforced so that an abnormal one — an agent
 * emitting uniquely-named scratch files for hours — cannot grow it without limit. See
 * {@link BoundedSet}.
 */
const KNOWN_PATH_LIMIT = 100_000;

/**
 * Ceiling on paths held in the debounce buffer.
 *
 * Each pending path holds an event's worth of state until its window expires. A tree-wide burst can
 * put every changed path in here at once, so past this point the window is abandoned for new paths
 * and their events are emitted immediately: earlier than asked for, which is the harmless direction,
 * whereas buffering an unbounded number of them is not.
 */
const PENDING_LIMIT = 4096;

/**
 * Ceiling on paths held for {@link JsWatcher#awaitWriteFinish}. Matches {@link PENDING_LIMIT}'s
 * reasoning: past this point a new path is delivered immediately as `modified` rather than
 * tracked, which degrades to "as if the option were unset" for the overflow instead of growing
 * without bound.
 */
const STABILIZE_LIMIT = 4096;

/** `awaitWriteFinish.pollIntervalMs` when configured but not given one. */
const DEFAULT_STABILIZE_POLL_MS = 100;

/** `awaitWriteFinish.stabilityThresholdMs` when configured but not given one. */
const DEFAULT_STABILIZE_THRESHOLD_MS = 2000;

/**
 * Delivered slots tolerated at the front of the queue before it is compacted.
 *
 * The queue is drained from a moving cursor rather than with `shift`, which on a full 8192-event
 * backlog would move every remaining element on every single `poll` — quadratic cost to drain exactly
 * when the queue is most backed up. The cursor makes `poll` O(1); this bounds the dead space it
 * leaves behind.
 */
const QUEUE_COMPACT_THRESHOLD = 1024;

/**
 * Consecutive failures a single directory's watch may be re-armed through.
 *
 * Small on purpose: this exists to ride out transient faults, and a directory that raises an error
 * every time it is watched is reporting a condition retrying cannot fix.
 */
const REARM_LIMIT = 5;

/**
 * Whether one watch can stand in for a watch on every directory beneath it.
 *
 * Windows only, deliberately, though macOS supports recursive watches too. Watching each
 * directory separately is what keeps this engine's semantics identical everywhere, and it holds
 * up everywhere except here: behind `fs.watch` on Windows each directory handle is re-issued
 * after every batch it reports, and changes landing in that gap are not queued anywhere — a few
 * hundred writes into one directory arrive as two or three events, with no error raised and
 * nothing to distinguish the loss from quiet. One recursive watch over the tree is drained
 * continuously by libuv and does not shed the burst, so on Windows fidelity wins over uniformity.
 *
 * `RETRIGGER_JS_RECURSIVE` forces the choice either way on the platforms that serve both, which is
 * how the recursive path is exercised somewhere other than Windows CI. A real choice rather than a
 * test fixture: macOS supports both strategies natively.
 */
const RECURSIVE_CAPABLE = process.platform === 'win32' || process.platform === 'darwin';
const RECURSIVE_OVERRIDE = process.env.RETRIGGER_JS_RECURSIVE;
const RECURSIVE_WATCH =
  RECURSIVE_OVERRIDE === '0'
    ? false
    : RECURSIVE_CAPABLE && (RECURSIVE_OVERRIDE === '1' || process.platform === 'win32');

class JsWatcher {
  /**
   * @param {{capacity?: number, debounceMs?: number, include?: string[], exclude?: string[],
   *   awaitWriteFinish?: {pollIntervalMs?: number, stabilityThresholdMs?: number},
   *   backend?: string, pollCompareContents?: boolean,
   *   atomicWriteNormalization?: boolean}} [options]
   */
  constructor(options = {}) {
    const capacity = Number(options.capacity);
    this.capacity =
      Number.isFinite(capacity) && capacity > 0 ? Math.floor(capacity) : DEFAULT_CAPACITY;
    const debounce = Number(options.debounceMs);
    this.debounceMs = Number.isFinite(debounce) && debounce > 0 ? Math.floor(debounce) : 0;
    this.matcher = new Matcher({ include: options.include, exclude: options.exclude });
    /** @type {{pollIntervalMs: number, stabilityThresholdMs: number}|null} */
    this.awaitWriteFinish = normaliseAwaitWriteFinish(options.awaitWriteFinish);

    /** @type {Map<string, {recursive: boolean}>} registered roots */
    this._roots = new Map();
    /** @type {Map<string, fs.FSWatcher>} directory watchers, keyed by directory */
    this._dirWatchers = new Map();
    /**
     * Files seen at least once, used to tell created from modified.
     *
     * Bounded, and deliberately not load-bearing for whether an event is emitted — only for what it
     * is named — so that forgetting an entry can never turn into a lost event.
     * @type {BoundedSet}
     */
    this._known = new BoundedSet(KNOWN_PATH_LIMIT);
    /**
     * Directories seen at least once (watched or not).
     *
     * Unbounded, unlike `_known`, and intentionally so: this one *is* load-bearing — it decides
     * whether a vanished path is reported as a directory — and it is already bounded in practice by
     * the one file descriptor per directory that this watcher holds.
     * @type {Set<string>}
     */
    this._knownDirs = new Set();
    /** @type {Array<object|undefined>} bounded event queue, drained from `_head` */
    this._queue = [];
    /** Index of the next event to deliver; see {@link QUEUE_COMPACT_THRESHOLD}. */
    this._head = 0;
    /** @type {Map<string, {kind: string, isDirectory: boolean, size: number, due: number}>} */
    this._pending = new Map();
    /**
     * The single timer servicing every pending path.
     *
     * One timer, not one per path: a burst across a large tree would otherwise allocate a timer and a
     * closure per changed path, and Node has to hold each of them until it fires.
     * @type {NodeJS.Timeout|null}
     */
    this._sweep = null;
    /**
     * Paths held for {@link JsWatcher#awaitWriteFinish}, `null` until first used.
     * @type {Map<string, {last: {size: number, mtimeMs: number}|null, stableSince: number, nextPoll: number}>}
     */
    this._stabilizing = new Map();
    /** The single timer servicing every path in {@link JsWatcher#_stabilizing}. */
    this._stabilizeTimer = null;
    /** @type {Array<Error>} */
    this._errors = [];
    /** @type {Map<string, number>} consecutive failed watch attempts, keyed by directory */
    this._rearms = new Map();
    this._notifier = null;
    this._running = false;
    this._overflowed = false;

    this._counters = { queued: 0, dropped: 0, delivered: 0 };
  }

  // ---------------------------------------------------------------- contract

  /**
   * Register a path to watch. Safe to call before or after `start()`.
   * @param {string} target
   * @param {boolean} [recursive=true]
   */
  watch(target, recursive = true) {
    if (typeof target !== 'string' || target.length === 0) {
      throw new TypeError('watch(path) requires a non-empty string path');
    }
    const abs = path.resolve(target);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch (err) {
      const error = new Error(`cannot watch ${abs}: ${err.message}`);
      error.code = err.code || 'ENOENT';
      throw error;
    }
    this._roots.set(abs, { recursive: recursive !== false, isDirectory: stat.isDirectory() });
    if (this._running) this._attachRoot(abs);
  }

  /**
   * @param {string} target
   */
  unwatch(target) {
    if (typeof target !== 'string' || target.length === 0) {
      throw new TypeError('unwatch(path) requires a non-empty string path');
    }
    const abs = path.resolve(target);
    this._roots.delete(abs);
    for (const dir of [...this._dirWatchers.keys()]) {
      if (dir === abs || dir.startsWith(abs + path.sep)) this._closeDir(dir);
    }
  }

  start() {
    if (this._running) return;
    this._running = true;
    for (const root of this._roots.keys()) this._attachRoot(root);
  }

  stop() {
    this._running = false;
    for (const dir of [...this._dirWatchers.keys()]) this._closeDir(dir);
    if (this._sweep) {
      clearTimeout(this._sweep);
      this._sweep = null;
    }
    if (this._stabilizeTimer) {
      clearTimeout(this._stabilizeTimer);
      this._stabilizeTimer = null;
    }
    this._pending.clear();
    // Nothing owed here is ever delivered late: a stopped watcher has no consumer to tell, same as
    // the debounce window above.
    this._stabilizing.clear();
    // Replaced rather than truncated so a burst-sized queue is not retained across a restart.
    this._queue = [];
    this._head = 0;
    this._known.clear();
    this._knownDirs.clear();
    this._rearms.clear();
    this._overflowed = false;
  }

  /**
   * @returns {object|null}
   */
  poll() {
    if (this._head >= this._queue.length) return null;
    const event = this._queue[this._head];
    // Release the reference as it is handed over, or a delivered event stays reachable from the
    // array until the next compaction and the queue becomes a retainer for everything it ever held.
    this._queue[this._head] = undefined;
    this._head += 1;
    if (this._head >= this._queue.length) {
      this._queue.length = 0;
      this._head = 0;
    } else if (this._head >= QUEUE_COMPACT_THRESHOLD) {
      this._queue = this._queue.slice(this._head);
      this._head = 0;
    }
    if (event.kind === 'rescanRequired') this._overflowed = false;
    this._counters.delivered += 1;
    return event;
  }

  /** @returns {number} events awaiting delivery */
  get _queued() {
    return this._queue.length - this._head;
  }

  /**
   * @returns {{eventsQueued: number, eventsDropped: number, eventsDelivered: number,
   *   watchedPaths: number, queuePending: number, queueCapacity: number, isRunning: boolean}}
   */
  stats() {
    return {
      eventsQueued: this._counters.queued,
      eventsDropped: this._counters.dropped,
      eventsDelivered: this._counters.delivered,
      watchedPaths: this._roots.size,
      queuePending: this._queued,
      queueCapacity: this.capacity,
      isRunning: this._running,
    };
  }

  /** @returns {string} */
  backend() {
    return 'polling';
  }

  /**
   * Crawl `target`'s current contents into a snapshot envelope, without registering a watch on it.
   *
   * Built on {@link JsWatcher#_walk}, so it agrees with what `watch()` itself would see: whatever
   * the include/exclude filter excludes, or a symlinked directory `_walk` does not descend into,
   * is likewise absent here. `async` only for interface parity with the native engine's
   * pool-thread task — the crawl itself is synchronous, exactly like `watch()`'s own initial walk.
   *
   * `_walk` also records every directory it visits into `_knownDirs`, which is otherwise this
   * engine's bookkeeping for telling a live watch's freshly-created directory from one it already
   * knew about. A snapshot of a path this instance never ends up watching leaves harmless,
   * unreferenced entries there; only a directory later deleted and recreated under a watch that
   * was never told about the earlier snapshot could have its `created` event suppressed by them —
   * a narrow enough race that forking `_walk` to skip the side effect was not worth the
   * duplication.
   * @param {string} target
   * @returns {Promise<{algorithm: string, version: number, entries: Array<{path: string,
   *   isDirectory: boolean, size: number, modifiedNs: bigint|null}>}>}
   */
  async snapshot(target) {
    if (typeof target !== 'string' || target.length === 0) {
      throw new TypeError('snapshot(path) requires a non-empty string path');
    }
    const abs = path.resolve(target);
    try {
      fs.statSync(abs);
    } catch (err) {
      const error = new Error(`cannot snapshot ${abs}: ${err.message}`);
      error.code = err.code || 'ENOENT';
      throw error;
    }
    const entries = [];
    // `_walk` visits the root itself first; `abs` is excluded below to match the native engine's
    // `Watcher::snapshot`, which never reports the crawled path as one of its own entries.
    this._walk(abs, true, (entryPath, isDirectory) => {
      if (entryPath === abs) return;
      let stat;
      try {
        stat = fs.statSync(entryPath);
      } catch {
        return; // raced with a delete between the walk and this stat
      }
      entries.push({
        path: entryPath,
        isDirectory,
        size: isDirectory ? 0 : stat.size,
        modifiedNs: Number.isFinite(stat.mtimeMs) ? BigInt(Math.round(stat.mtimeMs * 1e6)) : null,
      });
    });
    return { algorithm: SNAPSHOT_ALGORITHM, version: SNAPSHOT_ENVELOPE_VERSION, entries };
  }

  /**
   * `watch(target, recursive)` followed by `snapshot(target)`, with the watch registered before
   * the crawl begins so nothing created during the crawl is lost — mirroring the native engine's
   * `watchWithSnapshot` and `retrigger_system::Watcher::watch_with_snapshot`.
   * @param {string} target
   * @param {boolean} [recursive=true]
   * @returns {Promise<{algorithm: string, version: number, entries: Array}>}
   */
  async watchWithSnapshot(target, recursive = true) {
    this.watch(target, recursive);
    return this.snapshot(target);
  }

  // -------------------------------------------------------------- extensions

  /**
   * Optional low-latency hook. The native addon has no equivalent; consumers
   * always poll, and this only shortens the delay before the next drain.
   * @param {((...args: any[]) => void)|null} fn
   */
  setNotifier(fn) {
    this._notifier = typeof fn === 'function' ? fn : null;
  }

  /** @returns {Error[]} errors observed since the last drain */
  drainErrors() {
    const errors = this._errors;
    this._errors = [];
    return errors;
  }

  /** @returns {number} directories currently held open */
  get openDirectoryCount() {
    return this._dirWatchers.size;
  }

  // ----------------------------------------------------------------- private

  _attachRoot(root) {
    const info = this._roots.get(root);
    if (!info) return;
    if (!info.isDirectory) {
      // Watching a single file: watch its parent and filter by name.
      this._known.add(root);
      this._watchDirectory(path.dirname(root));
      return;
    }
    // The walk still runs when one watch covers the tree: it is what populates the tracking sets
    // that tell a created file from a modified one and a removed directory from a removed file.
    // Only the per-directory handles it would otherwise open are redundant.
    const covered = RECURSIVE_WATCH && info.recursive;
    if (covered) this._watchDirectory(root, true);
    this._walk(root, info.recursive, (entryPath, isDirectory) => {
      if (isDirectory) {
        if (!covered) this._watchDirectory(entryPath);
      } else this._known.add(entryPath);
    });
  }

  /**
   * Depth-first walk that never follows symlinks and never throws.
   * @param {string} dir
   * @param {boolean} recursive
   * @param {(p: string, isDir: boolean) => void} visit
   */
  _walk(dir, recursive, visit) {
    if (!this.matcher.allowsDirectory(dir)) return;
    this._knownDirs.add(dir);
    visit(dir, true);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      this._recordError(err);
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive) this._walk(full, recursive, visit);
      } else if (entry.isFile()) {
        visit(full, false);
      }
    }
  }

  /**
   * @param {string} dir
   * @param {boolean} [recursive=false] whether this one watch covers the whole subtree
   */
  _watchDirectory(dir, recursive = false) {
    if (this._dirWatchers.has(dir)) return;
    if (!this.matcher.allowsDirectory(dir)) return;
    let watcher;
    try {
      watcher = fs.watch(dir, { persistent: true, recursive });
    } catch (err) {
      this._recordError(err);
      return;
    }
    watcher.on('change', (eventType, filename) => {
      this._onRawEvent(dir, eventType, filename);
    });
    watcher.on('error', (err) => {
      this._recordError(err);
      this._closeDir(dir);
      this._rearmAfterError(dir);
    });
    this._dirWatchers.set(dir, watcher);
    this._knownDirs.add(dir);
  }

  /**
   * Re-attach a directory whose watch reported an error, and declare the gap.
   *
   * Abandoning it is what the code did before, and on Windows that is the difference between a
   * momentary fault and a watcher that is still running, still reports itself healthy, and never
   * speaks again: the directory handle raises a one-shot error for conditions that pass — a churn
   * large enough to overrun the notification buffer, a sharing violation from an indexer — and
   * every change after it went unseen. Bounded, so a directory that fails every time is not
   * retried forever.
   * @param {string} dir
   */
  _rearmAfterError(dir) {
    if (!this._running) return;
    const attempts = (this._rearms.get(dir) || 0) + 1;
    if (attempts > REARM_LIMIT) return;
    this._rearms.set(dir, attempts);
    if (!fs.existsSync(dir)) return;
    // Re-attached with the reach it had. Only a root is ever watched recursively, so a lookup in
    // the root table is the whole question -- and getting it wrong would silently narrow a
    // tree-wide watch to its top directory.
    const root = this._roots.get(dir);
    this._watchDirectory(dir, RECURSIVE_WATCH && root !== undefined && root.recursive);
    if (!this._dirWatchers.has(dir)) return;
    // Whatever happened while the directory was unwatched was not observed, and cannot be
    // enumerated after the fact, so the gap is declared rather than passed off as quiet.
    this._enqueue(this._makeEvent('', 'rescanRequired', false, 0));
  }

  _closeDir(dir) {
    const watcher = this._dirWatchers.get(dir);
    if (!watcher) return;
    this._dirWatchers.delete(dir);
    try {
      watcher.close();
    } catch {
      /* already closed */
    }
  }

  /**
   * Translate one raw `fs.watch` notification into a contract event.
   * @param {string} dir
   * @param {string} eventType 'rename' | 'change'
   * @param {string|Buffer|null} filename
   */
  _onRawEvent(dir, eventType, filename) {
    if (!this._running) return;
    // A directory that is delivering again has spent its failures; the ceiling is on consecutive
    // faults, not on how many a long-lived watch may survive in total.
    if (this._rearms.size) this._rearms.delete(dir);
    if (!filename) {
      // Some platforms omit the filename; the directory itself changed.
      this._enqueueDebounced(dir, 'modified', true, 0);
      return;
    }
    const name = Buffer.isBuffer(filename) ? filename.toString('utf8') : String(filename);
    const full = path.join(dir, name);
    // A parent directory is watched when a single file is registered, so
    // sibling activity has to be filtered out here.
    if (!this._findRoot(full)) return;

    let stat = null;
    try {
      stat = fs.statSync(full);
    } catch {
      stat = null;
    }

    if (!stat) {
      // A watched directory can disappear underneath us. macOS reports that
      // through the directory's *own* watcher and only unreliably through its
      // parent's, so the removal is detected here rather than being left to a
      // parent notification that may never arrive.
      if (!fs.existsSync(dir)) {
        this._reportDirectoryGone(dir);
        return;
      }
      const wasDirectory = this._knownDirs.has(full);
      // The miss is what suppresses events for paths this watcher never reported — sibling noise in
      // the parent directory of a single watched file, say. That reasoning only holds while the
      // tracking set is exact: once it has dropped entries to stay within its ceiling, a miss may
      // mean "forgotten", and suppressing on it would turn a memory bound into a lost deletion. So
      // past that point a vanished path is reported, accepting the occasional redundant `deleted` for
      // something the consumer never knew about.
      if (!wasDirectory && !this._known.has(full) && !this._known.forgotten) return;
      this._known.delete(full);
      if (wasDirectory) this._forgetSubtree(full);
      this._emitIfMatched(full, 'deleted', wasDirectory, 0);
      return;
    }

    if (stat.isDirectory()) {
      if (this._knownDirs.has(full)) return;
      this._knownDirs.add(full);
      // Attach before emitting: a directory can be populated between the
      // mkdir and our watch call, and the walk below recovers those files.
      this._adoptNewDirectory(full);
      this._emitIfMatched(full, 'created', true, 0);
      return;
    }

    if (!stat.isFile()) return;

    const isNew = !this._known.has(full);
    this._known.add(full);
    this._emitIfMatched(full, isNew ? 'created' : 'modified', false, stat.size);
  }

  /**
   * Watch a directory that appeared after `start()`, and replay anything that
   * already landed inside it.
   *
   * The replay is needed on every platform, including the ones where the covering watch already
   * reports the new directory's contents: files written between the `mkdir` and this call are
   * inside the tree but were never announced, and the walk is the only thing that finds them.
   */
  _adoptNewDirectory(dir) {
    const root = this._findRoot(dir);
    if (!root || !root.recursive) return;
    if (!RECURSIVE_WATCH) this._watchDirectory(dir);
    this._walk(dir, true, (entryPath, isDirectory) => {
      if (isDirectory) {
        if (!RECURSIVE_WATCH && entryPath !== dir) this._watchDirectory(entryPath);
        return;
      }
      if (this._known.has(entryPath)) return;
      this._known.add(entryPath);
      let size = 0;
      try {
        size = fs.statSync(entryPath).size;
      } catch {
        /* raced with a delete */
      }
      this._emitIfMatched(entryPath, 'created', false, size);
    });
  }

  /**
   * Emit the deletion of a directory exactly once, no matter whether its own
   * watcher or its parent's noticed first.
   * @param {string} dir
   */
  _reportDirectoryGone(dir) {
    if (!this._knownDirs.has(dir)) return;
    if (!this._findRoot(dir)) return;
    this._known.delete(dir);
    this._forgetSubtree(dir);
    this._emitIfMatched(dir, 'deleted', true, 0);
  }

  _findRoot(target) {
    for (const [root, info] of this._roots) {
      if (target === root || target.startsWith(root + path.sep)) return info;
    }
    return null;
  }

  /**
   * Forget everything recorded beneath `dir`, and close its watchers.
   *
   * `rm -rf` on a large directory produces one of these per directory in the tree. Copying the
   * tracking sets first — which is what a `[...set]` spread does — made the total cost the product of
   * the two, and allocated an array the size of the whole tree each time. Deleting during iteration
   * is well defined for both `Set` and `Map`, so nothing needs to be copied.
   */
  _forgetSubtree(dir) {
    const prefix = dir + path.sep;
    this._known.deleteMatching((known) => known.startsWith(prefix));
    for (const known of this._knownDirs) {
      if (known === dir || known.startsWith(prefix)) this._knownDirs.delete(known);
    }
    for (const watched of this._dirWatchers.keys()) {
      if (watched === dir || watched.startsWith(prefix)) this._closeDir(watched);
    }
  }

  _emitIfMatched(target, kind, isDirectory, size) {
    if (!isDirectory && !this.matcher.matches(target)) return;
    if (isDirectory && !this.matcher.allowsDirectory(target)) return;
    if (this.awaitWriteFinish) {
      if (kind === 'deleted') {
        // Never held behind a write that will not finish under a name that no longer exists.
        this._stabilizing.delete(target);
      } else if (!isDirectory && COALESCABLE.has(kind)) {
        this._trackStabilization(target);
        return;
      }
    }
    if (this.debounceMs > 0) this._enqueueDebounced(target, kind, isDirectory, size);
    else this._enqueue(this._makeEvent(target, kind, isDirectory, size));
  }

  /**
   * Begin (or continue) holding `target` for {@link JsWatcher#awaitWriteFinish} instead of
   * delivering its event immediately.
   *
   * Mirrors `retrigger-system::stabilize`: re-`stat` on `pollIntervalMs` until size and
   * modification time have held for `stabilityThresholdMs`, then deliver exactly one `modified`.
   */
  _trackStabilization(target) {
    if (this._stabilizing.has(target)) return;
    if (this._stabilizing.size >= STABILIZE_LIMIT) {
      // The work list is full: fall back to delivering immediately rather than losing the event
      // or growing without bound.
      this._enqueue(this._makeEvent(target, 'modified', false, this._sizeOf(target)));
      return;
    }
    const now = Date.now();
    this._stabilizing.set(target, {
      last: null,
      stableSince: now,
      nextPoll: now + this.awaitWriteFinish.pollIntervalMs,
    });
    this._scheduleStabilizeSweep();
  }

  /** @returns {number} */
  _sizeOf(target) {
    try {
      return fs.statSync(target).size;
    } catch {
      return 0;
    }
  }

  /** Arm the single stabilization timer for the earliest poll due, if not already armed. */
  _scheduleStabilizeSweep() {
    if (this._stabilizeTimer || this._stabilizing.size === 0) return;
    let earliest = Infinity;
    for (const entry of this._stabilizing.values()) earliest = Math.min(earliest, entry.nextPoll);
    const delay = Math.max(0, earliest - Date.now());
    this._stabilizeTimer = setTimeout(() => {
      this._stabilizeTimer = null;
      this._stabilizeSweep();
    }, delay);
    if (typeof this._stabilizeTimer.unref === 'function') this._stabilizeTimer.unref();
  }

  /** Re-`stat` every path whose poll is due, deliver settled ones, and re-arm the rest. */
  _stabilizeSweep() {
    const now = Date.now();
    for (const [target, entry] of this._stabilizing) {
      if (entry.nextPoll > now) continue;
      let stat;
      try {
        stat = fs.statSync(target);
      } catch {
        // Gone without an explicit removal event ever reaching this module -- a race this method
        // cannot close. Nothing to deliver, and holding it further would wait forever.
        this._stabilizing.delete(target);
        continue;
      }
      const snapshot = { size: stat.size, mtimeMs: stat.mtimeMs };
      const unchanged =
        entry.last && entry.last.size === snapshot.size && entry.last.mtimeMs === snapshot.mtimeMs;
      if (unchanged) {
        if (now - entry.stableSince >= this.awaitWriteFinish.stabilityThresholdMs) {
          this._stabilizing.delete(target);
          this._enqueue(this._makeEvent(target, 'modified', false, snapshot.size));
          continue;
        }
      } else {
        entry.last = snapshot;
        entry.stableSince = now;
      }
      entry.nextPoll = now + this.awaitWriteFinish.pollIntervalMs;
    }
    this._scheduleStabilizeSweep();
  }

  /**
   * Deliver the first event for `target` at once, then absorb repeats behind it for one window.
   *
   * Leading edge, matching the native engine: waiting out the window before saying anything would
   * tax every save with the full delay, which is the cost this package exists to remove. What the
   * window absorbs is not discarded — the entry left behind owes a correction, emitted by
   * {@link JsWatcher#_flushDue} once the window closes, carrying the path's final size. Without it
   * a burst that *ends* inside the window would leave the consumer holding whatever the file said
   * when it was first woken, which for a large save is a partially written file.
   *
   * Entries are kept in deadline order, which a `Map` gives for free: the deadline runs from the
   * event that was *delivered* and is never extended, so insertion order is deadline order. That is
   * what lets one timer serve every pending path — the sweep only looks at the front of the map.
   * Not extending it is also what keeps a continuously written file being corrected once per
   * window, rather than going silent until the writing stops.
   */
  _enqueueDebounced(target, kind, isDirectory, size) {
    const existing = this._pending.get(target);
    if (existing) {
      // A change of existence ends the window rather than being absorbed by it: collapsing a
      // delete, or the arrival that follows one, would change what the stream means rather than
      // how often it fires. The native engine draws the line in the same place.
      if (!COALESCABLE.has(kind) || !COALESCABLE.has(existing.kind)) {
        this._pending.delete(target);
        this._enqueue(this._makeEvent(target, kind, isDirectory, size));
        return;
      }
      existing.owed = true;
      existing.kind = kind;
      existing.isDirectory = isDirectory;
      existing.size = size;
      return;
    }

    this._enqueue(this._makeEvent(target, kind, isDirectory, size));
    if (this._pending.size >= PENDING_LIMIT) {
      // Past the ceiling no window is opened, so this path simply gets no correction. The event
      // above was still delivered; see PENDING_LIMIT.
      return;
    }
    this._pending.set(target, {
      kind,
      isDirectory,
      size,
      owed: false,
      due: Date.now() + this.debounceMs,
    });
    this._scheduleSweep();
  }

  /**
   * Arm the single sweep timer for the earliest deadline, if it is not already armed.
   */
  _scheduleSweep() {
    if (this._sweep || this._pending.size === 0) return;
    const first = this._pending.values().next().value;
    const delay = Math.max(0, first.due - Date.now());
    this._sweep = setTimeout(() => {
      this._sweep = null;
      this._flushDue();
    }, delay);
    // Never hold the event loop open for a debounce window; the watchers themselves are what keep
    // the process alive while it is running.
    if (typeof this._sweep.unref === 'function') this._sweep.unref();
  }

  /**
   * Close every window that has expired, emitting a correction for each one that absorbed
   * something, then re-arm for the rest.
   *
   * A window that absorbed nothing closes silently: its one event was already delivered on the
   * leading edge, so there is nothing left to restate.
   */
  _flushDue() {
    const now = Date.now();
    for (const [target, entry] of this._pending) {
      // Deadline order, so the first entry that is still waiting ends the sweep.
      if (entry.due > now) break;
      this._pending.delete(target);
      // Always a `modified`, exactly as the native engine reports it: the path exists and its
      // content moved after the consumer was last told about it, which is the whole of what this
      // event claims. It stands for repeat noise around one logical change, so it has no useful
      // opinion about which of those events it replaces.
      if (entry.owed) {
        this._enqueue(this._makeEvent(target, 'modified', entry.isDirectory, entry.size));
      }
    }
    this._scheduleSweep();
  }

  _makeEvent(target, kind, isDirectory, size) {
    return {
      path: target,
      kind,
      timestampNs: process.hrtime.bigint(),
      size: Number(size) || 0,
      isDirectory: Boolean(isDirectory),
      cookie: null,
    };
  }

  /**
   * Bounded enqueue with kernel-style overflow: once the queue is full the
   * backlog is discarded and replaced by a single `rescanRequired` marker, so
   * a consumer can never silently act on a partial event stream.
   * @returns {boolean} whether the event was queued
   */
  _enqueue(event) {
    if (this._queued >= this.capacity) {
      if (!this._overflowed) {
        this._counters.dropped += this._queued;
        // A fresh array rather than a truncation: the discarded backlog is released outright instead
        // of leaving a full-capacity array behind for the rest of the process's life.
        this._queue = [];
        this._head = 0;
        this._overflowed = true;
        this._queue.push(this._makeEvent('', 'rescanRequired', false, 0));
        this._counters.queued += 1;
      }
      this._counters.dropped += 1;
      this._notify();
      return false;
    }
    this._queue.push(event);
    this._counters.queued += 1;
    this._notify();
    return true;
  }

  _notify() {
    if (this._notifier) {
      try {
        this._notifier();
      } catch {
        /* a broken consumer must not break the watcher */
      }
    }
  }

  _recordError(err) {
    this._errors.push(err instanceof Error ? err : new Error(String(err)));
    if (this._errors.length > 64) this._errors.shift();
  }
}

/**
 * @param {unknown} value
 * @returns {{pollIntervalMs: number, stabilityThresholdMs: number}|null}
 */
function normaliseAwaitWriteFinish(value) {
  if (!value || typeof value !== 'object') return null;
  const pollIntervalMs = Number(value.pollIntervalMs);
  const stabilityThresholdMs = Number(value.stabilityThresholdMs);
  return {
    pollIntervalMs:
      Number.isFinite(pollIntervalMs) && pollIntervalMs > 0
        ? Math.floor(pollIntervalMs)
        : DEFAULT_STABILIZE_POLL_MS,
    stabilityThresholdMs:
      Number.isFinite(stabilityThresholdMs) && stabilityThresholdMs > 0
        ? Math.floor(stabilityThresholdMs)
        : DEFAULT_STABILIZE_THRESHOLD_MS,
  };
}

module.exports = { COALESCABLE, EVENT_KINDS, JsWatcher, RECURSIVE_WATCH };
