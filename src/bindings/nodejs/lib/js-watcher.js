'use strict';

/**
 * Pure-JavaScript watcher implementing the native addon's `Watcher` contract.
 *
 * Honest differences from the native engine, none of them faked:
 *   - `fs.watch` is only recursive on macOS and Windows, so the tree is walked
 *     and every directory is watched individually on all platforms. This keeps
 *     semantics identical everywhere at the cost of one file descriptor per
 *     directory (and an `EMFILE` risk on very large trees, surfaced as an
 *     error event rather than a crash).
 *   - `fs.watch` cannot correlate the two halves of a rename, so a rename is
 *     reported as `deleted` for the old path and `created` for the new one.
 *     `renamedFrom` / `renamedTo` are never emitted and `cookie` is always
 *     `null`.
 *   - Symlinked directories are not traversed.
 *   - `backend()` reports `"polling"`, the contract's label for any
 *     non-kernel-native backend.
 *   - On macOS `fs.watch` brings its FSEvents stream up on another thread, so
 *     a write landing within a few milliseconds of `start()` can be missed
 *     outright rather than merely delayed. There is no readiness signal to
 *     wait on; a caller that must not miss the very first change should read
 *     the tree once after `start()` rather than trusting the event stream for
 *     that instant.
 */

const fs = require('fs');
const path = require('path');

const { Matcher } = require('./matcher');
const { BoundedSet } = require('./bounded');

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
 * Delivered slots tolerated at the front of the queue before it is compacted.
 *
 * The queue is drained from a moving cursor rather than with `shift`, which on a full 8192-event
 * backlog would move every remaining element on every single `poll` — quadratic cost to drain exactly
 * when the queue is most backed up. The cursor makes `poll` O(1); this bounds the dead space it
 * leaves behind.
 */
const QUEUE_COMPACT_THRESHOLD = 1024;

class JsWatcher {
  /**
   * @param {{capacity?: number, debounceMs?: number, include?: string[], exclude?: string[]}} [options]
   */
  constructor(options = {}) {
    const capacity = Number(options.capacity);
    this.capacity =
      Number.isFinite(capacity) && capacity > 0 ? Math.floor(capacity) : DEFAULT_CAPACITY;
    const debounce = Number(options.debounceMs);
    this.debounceMs = Number.isFinite(debounce) && debounce > 0 ? Math.floor(debounce) : 0;
    this.matcher = new Matcher({ include: options.include, exclude: options.exclude });

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
    /** @type {Array<Error>} */
    this._errors = [];
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
    this._pending.clear();
    // Replaced rather than truncated so a burst-sized queue is not retained across a restart.
    this._queue = [];
    this._head = 0;
    this._known.clear();
    this._knownDirs.clear();
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
    this._walk(root, info.recursive, (entryPath, isDirectory) => {
      if (isDirectory) this._watchDirectory(entryPath);
      else this._known.add(entryPath);
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

  _watchDirectory(dir) {
    if (this._dirWatchers.has(dir)) return;
    if (!this.matcher.allowsDirectory(dir)) return;
    let watcher;
    try {
      watcher = fs.watch(dir, { persistent: true, recursive: false });
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
    });
    this._dirWatchers.set(dir, watcher);
    this._knownDirs.add(dir);
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
   */
  _adoptNewDirectory(dir) {
    const root = this._findRoot(dir);
    if (!root || !root.recursive) return;
    this._watchDirectory(dir);
    this._walk(dir, true, (entryPath, isDirectory) => {
      if (isDirectory) {
        if (entryPath !== dir) this._watchDirectory(entryPath);
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
    if (this.debounceMs > 0) this._enqueueDebounced(target, kind, isDirectory, size);
    else this._enqueue(this._makeEvent(target, kind, isDirectory, size));
  }

  /**
   * Hold `target` for its debounce window, merging with anything already waiting for it.
   *
   * Entries are kept in deadline order, which a `Map` gives for free as long as a refreshed entry is
   * re-inserted at the back — every window is the same length, so insertion order *is* deadline
   * order. That is what lets one timer serve every pending path: the sweep only has to look at the
   * front of the map.
   */
  _enqueueDebounced(target, kind, isDirectory, size) {
    const existing = this._pending.get(target);
    if (existing) {
      this._pending.delete(target);
      this._pending.set(target, {
        kind: mergeKind(existing.kind, kind),
        isDirectory,
        size,
        due: Date.now() + this.debounceMs,
      });
      return;
    }
    if (this._pending.size >= PENDING_LIMIT) {
      // Past the ceiling the window is abandoned rather than buffered: emitting sooner than asked is
      // a fidelity cost, holding an unbounded number of paths is a memory fault. See PENDING_LIMIT.
      this._enqueue(this._makeEvent(target, kind, isDirectory, size));
      return;
    }
    this._pending.set(target, {
      kind,
      isDirectory,
      size,
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
   * Emit every pending path whose window has expired, then re-arm for the rest.
   */
  _flushDue() {
    const now = Date.now();
    for (const [target, entry] of this._pending) {
      // Deadline order, so the first entry that is still waiting ends the sweep.
      if (entry.due > now) break;
      this._pending.delete(target);
      this._enqueue(this._makeEvent(target, entry.kind, entry.isDirectory, entry.size));
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
 * Coalescing rule for debounced events on the same path. A create followed by
 * writes is still a create; anything followed by a delete is a delete.
 */
function mergeKind(previous, next) {
  if (next === 'deleted') return 'deleted';
  if (previous === 'created' && next === 'modified') return 'created';
  if (previous === 'deleted' && next === 'created') return 'modified';
  return next;
}

module.exports = { EVENT_KINDS, JsWatcher, mergeKind };
