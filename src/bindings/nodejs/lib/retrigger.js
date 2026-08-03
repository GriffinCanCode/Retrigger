'use strict';

const { EventEmitter } = require('events');
const { statSync } = require('fs');
const path = require('path');

const { ContentTracker } = require('./content');
const { getEngine, getEngineInfo } = require('./engine');
const { Metrics } = require('./metrics');

const DEFAULT_POLL_INTERVAL_MS = 5;
const DEFAULT_CAPACITY = 8192;
// A handful of large files land on the async hash path at once far more often than dozens do, so
// this bounds memory (each in-flight hash holds one open file descriptor and one WASM/native
// buffer) without meaningfully limiting throughput on the common case.
const DEFAULT_MAX_CONCURRENT_HASHES = 4;
// Matches the native addon's own fallbacks (`src/bindings/nodejs/src/lib.rs`), so a caller who
// specifies one engine's option and gets the other on a given platform sees the same number.
const DEFAULT_BACKEND_POLL_INTERVAL_MS = 1000;
const DEFAULT_AWAIT_WRITE_FINISH_POLL_MS = 100;
const DEFAULT_AWAIT_WRITE_FINISH_STABILITY_MS = 2000;

/** Contract event kind -> public event name. */
const KIND_TO_EVENT = {
  created: 'add',
  modified: 'change',
  deleted: 'unlink',
  renamedFrom: 'unlink',
  renamedTo: 'add',
  metadata: 'change',
};

/**
 * The public watcher. Wraps an engine (native or JavaScript) that exposes the
 * poll-based addon contract and turns it into an EventEmitter.
 *
 * Emits:
 *   'add'     (path, event)  file created (or the target half of a rename)
 *   'change'  (path, event)  file modified or metadata changed
 *   'unlink'  (path, event)  file deleted (or the source half of a rename)
 *   'all'     (event)        every event, including directory and rescan events
 *   'rescan'  (event)        the queue overflowed; re-read state from disk
 *   'error'   (error)        engine or listener failure; never thrown
 *   'ready'   ()             emitted once after a successful start()
 *
 * Every event carries `contentChanged` — whether the bytes actually differ from the last time this
 * watcher saw that path — unless `contentHashing: false` was requested. Events are *annotated*, not
 * withheld: a watcher that silently dropped events would be unable to report a file being touched,
 * which some consumers do want. Deciding what to do with a no-op write belongs to the consumer, and
 * both bundler plugins in this package decide to skip it.
 *
 * A file past `maxHashBytes` is hashed on the async path (`ContentTracker#annotateAsync`, chunked
 * and I/O-driven on both engines) rather than the drain loop's own tick, so a burst of large
 * artifacts cannot stall delivery of every other event the same tick would otherwise carry. Those
 * events reach listeners once their hash resolves, out of order with respect to whatever else the
 * drain loop already emitted — the price of not blocking on them — bounded to
 * `maxConcurrentHashes` in flight at once, and abandoned without emitting if `stop()`/`close()`
 * runs before they resolve.
 */
class Retrigger extends EventEmitter {
  /**
   * @param {{paths?: string|string[], recursive?: boolean, include?: string[],
   *   exclude?: string[], debounceMs?: number, capacity?: number,
   *   pollIntervalMs?: number, engine?: 'auto'|'native'|'javascript',
   *   emitDirectories?: boolean, unref?: boolean, contentHashing?: boolean,
   *   maxHashBytes?: number, maxConcurrentHashes?: number, backend?: {mode?: 'auto'|'poll',
   *   pollIntervalMs?: number, compareContents?: boolean}, awaitWriteFinish?: {pollIntervalMs?:
   *   number, stabilityThresholdMs?: number}, atomicWriteNormalization?: boolean}} [options]
   */
  constructor(options = {}) {
    super();
    this.options = {
      recursive: options.recursive !== false,
      include: patterns(options.include),
      exclude: patterns(options.exclude),
      debounceMs: atLeast(options.debounceMs, 0),
      // Both engines already read a non-positive capacity as "unspecified" and size their queue at
      // the default. This has to agree with them: the drain loop is bounded by the value kept here,
      // and a literal 0 would bound it to zero iterations — a watcher that runs, reports itself
      // healthy, and delivers nothing.
      capacity: positiveOr(options.capacity, DEFAULT_CAPACITY),
      pollIntervalMs: positiveOr(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS),
      emitDirectories: options.emitDirectories === true,
      unref: options.unref === true,
      contentHashing: options.contentHashing !== false,
      maxHashBytes: options.maxHashBytes,
      maxConcurrentHashes: positiveOr(options.maxConcurrentHashes, DEFAULT_MAX_CONCURRENT_HASHES),
      backend: normaliseBackend(options.backend),
      awaitWriteFinish: normaliseAwaitWriteFinish(options.awaitWriteFinish),
      atomicWriteNormalization: options.atomicWriteNormalization === true,
    };

    this.engine = getEngine({ prefer: options.engine || 'auto' });
    this.metrics = new Metrics();
    this._content = this.options.contentHashing
      ? new ContentTracker(this.engine, { maxBytes: this.options.maxHashBytes })
      : null;

    this._watcher = this.engine.createWatcher({
      capacity: this.options.capacity,
      debounceMs: this.options.debounceMs,
      include: this.options.include,
      exclude: this.options.exclude,
      backend: this.options.backend.mode,
      pollIntervalMs: this.options.backend.pollIntervalMs,
      pollCompareContents: this.options.backend.compareContents,
      // `?? undefined`, not the `null` this.options carries for "off": napi-rs's generated
      // constructor accepts an absent nested `#[napi(object)]` field but rejects an explicit
      // `null` for one, unlike its handling of `null` for scalar `Option<T>` fields.
      awaitWriteFinish: this.options.awaitWriteFinish ?? undefined,
      atomicWriteNormalization: this.options.atomicWriteNormalization,
    });

    this._timer = null;
    this._draining = false;
    this._drainQueued = false;
    this._started = false;
    // The async hash path's own queue and concurrency limiter -- see the class doc comment above.
    // `_sessionAbort` is `null` outside of a start()/stop() bracket, and is exactly what makes an
    // async hash from a since-stopped session recognisable as abandoned: it is a fresh object each
    // start(), so a closure holding the previous one always finds it aborted after stop().
    this._asyncQueue = [];
    this._asyncInFlight = 0;
    this._sessionAbort = null;

    // The JavaScript engine can nudge us the moment an event lands; the native
    // engine has no such hook and is served by the interval alone.
    if (typeof this._watcher.setNotifier === 'function') {
      this._watcher.setNotifier(() => this._scheduleDrain());
    }

    const initial = options.paths ?? options.path;
    if (initial) {
      for (const p of Array.isArray(initial) ? initial : [initial]) {
        this.add(p, this.options.recursive);
      }
    }
  }

  /** @returns {boolean} */
  get isRunning() {
    return this._started;
  }

  /**
   * Register a path. Throws only for genuinely invalid input (bad type, or a
   * path that does not exist) — the same failure the native engine reports.
   * @param {string} target
   * @param {boolean} [recursive]
   * @returns {this}
   */
  add(target, recursive = this.options.recursive) {
    this._watcher.watch(path.resolve(target), recursive !== false);
    return this;
  }

  /** Alias kept because both bundler plugins and the README use `watch()`. */
  watch(target, recursive) {
    return this.add(target, recursive);
  }

  /**
   * @param {string} target
   * @returns {this}
   */
  unwatch(target) {
    this._watcher.unwatch(path.resolve(target));
    return this;
  }

  /**
   * Crawl `target`'s current contents, without registering a watch on it.
   *
   * The result is a self-describing envelope — `{ algorithm, version, entries }` — so it can be
   * persisted (to disk, to a database) and loaded back later without guessing which crate version
   * or digest algorithm produced it. Comparing two of them to recover what changed between them is
   * `retrigger_system::diff_snapshots`'s job on the Rust side; this package does not duplicate it.
   * @param {string} target
   * @returns {Promise<{algorithm: string, version: number, entries: Array<{path: string,
   *   isDirectory: boolean, size: number, modifiedNs: bigint|null}>}>}
   */
  snapshot(target) {
    return this._watcher.snapshot(path.resolve(target));
  }

  /**
   * {@link Retrigger#add} `target`, then {@link Retrigger#snapshot} it, with the watch registered
   * before the crawl begins so nothing created during the crawl is lost.
   * @param {string} target
   * @param {boolean} [recursive]
   * @returns {Promise<{algorithm: string, version: number, entries: Array}>}
   */
  watchWithSnapshot(target, recursive = this.options.recursive) {
    return this._watcher.watchWithSnapshot(path.resolve(target), recursive !== false);
  }

  /** @returns {this} */
  start() {
    if (this._started) return this;
    this._watcher.start();
    this._started = true;
    this._sessionAbort = new AbortController();
    this.metrics.markStarted();
    this._timer = setInterval(() => this._drain(), this.options.pollIntervalMs);
    if (this.options.unref && typeof this._timer.unref === 'function') this._timer.unref();
    queueMicrotask(() => {
      if (this._started) this.emit('ready');
    });
    return this;
  }

  /**
   * Stop watching and release every handle and timer this instance owns.
   * Safe to call repeatedly and safe to call before `start()`.
   * @returns {this}
   */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this._started) {
      try {
        this._watcher.stop();
      } catch (err) {
        this._fail(err);
      }
    }
    this._started = false;
    // Abandon every async hash this session started: `_runAsyncHash` sees its own captured
    // controller as aborted and drops the result instead of emitting into a watcher that is now
    // stopped. Queued-but-not-yet-started ones are simply discarded, having cost nothing yet.
    if (this._sessionAbort) {
      this._sessionAbort.abort();
      this._sessionAbort = null;
    }
    this._asyncQueue.length = 0;
    // The digests describe a watch that is over, and the next start() must treat every path as new
    // anyway: the file system was free to change while nothing was watching it.
    if (this._content) this._content.clear();
    this.metrics.markStopped();
    return this;
  }

  /** Stop and drop all listeners. */
  close() {
    this.stop();
    this.removeAllListeners();
    return this;
  }

  /**
   * @returns {object} engine queue statistics merged with measured metrics
   */
  getStats() {
    const engineStats = this._watcher.stats();
    return {
      engine: this.engine.name,
      backend: this._watcher.backend(),
      ...normaliseStats(engineStats),
      content: this._content ? this._content.stats() : null,
      metrics: this.metrics.snapshot(),
      asyncHashesInFlight: this._asyncInFlight,
      asyncHashesQueued: this._asyncQueue.length,
    };
  }

  /**
   * Ask this watcher's content oracle whether a path *another* watcher just reported has really
   * changed, against the same digest cache this watcher's own events are judged by.
   *
   * A dev server usually runs a second watcher that cannot be turned off — Vite's chokidar is the
   * case this exists for. Its events reach the bundler whether or not the bytes changed, so
   * hashing here decides nothing unless the other source is held to the same question. Sharing
   * one cache is also what makes two sources idempotent rather than merely redundant: whichever
   * observes a write first reports it and records the digest, and the second then finds that
   * digest already current and is dropped.
   *
   * Answers `true` whenever it cannot tell, and `true` unconditionally when content hashing is
   * off, because an unnecessary rebuild is the cheaper mistake.
   *
   * @param {string} target
   * @param {string} [kind] contract event kind; anything but a removal is fingerprinted
   * @returns {boolean}
   */
  hasContentChanged(target, kind = 'modified') {
    if (!this._content) return true;
    const resolved = path.resolve(target);
    // The engine hands its own events a size, which is what keeps the tracker from reading a file
    // too large to be worth hashing. An event from elsewhere arrives without one, so it is stat'd
    // here rather than losing that ceiling and blocking the server on a large artifact.
    const stat = statSync(resolved, { throwIfNoEntry: false });
    const event = { path: resolved, kind, isDirectory: false, size: stat ? stat.size : undefined };
    this._content.annotate(event);
    if (event.contentChanged === false) this.metrics.recordUnchanged();
    return event.contentChanged !== false;
  }

  /** @returns {object} */
  getEngineInfo() {
    return getEngineInfo();
  }

  /** @returns {string} */
  getSimdLevel() {
    return this.engine.getSimdSupport();
  }

  // ----------------------------------------------------------------- private

  /**
   * Ask for a drain on the next microtask, with at most one ever outstanding.
   *
   * The JavaScript engine notifies once per enqueued event, so a burst across a
   * large tree would otherwise put one closure per event onto the microtask
   * queue — which has no bound — for all but the first to wake up and find the
   * queue already drained. One drain empties the queue regardless of how many
   * events prompted it, because nothing can enqueue while it runs.
   */
  _scheduleDrain() {
    if (!this._started || this._draining || this._drainQueued) return;
    this._drainQueued = true;
    queueMicrotask(() => {
      this._drainQueued = false;
      this._drain();
    });
  }

  _drain() {
    if (this._draining || !this._started) return;
    this._draining = true;
    try {
      if (typeof this._watcher.drainErrors === 'function') {
        for (const err of this._watcher.drainErrors()) this._fail(err);
      }
      // Bounded per tick so a flood cannot starve the event loop.
      for (let i = 0; i < this.options.capacity; i += 1) {
        const event = this._watcher.poll();
        if (!event) break;
        this._dispatch(event);
      }
    } catch (err) {
      this._fail(err);
    } finally {
      this._draining = false;
    }
  }

  _dispatch(event) {
    this.metrics.recordEvent(event.kind);
    if (this._content && this._content.needsFingerprint(event) && this._isOversized(event)) {
      this._asyncQueue.push(event);
      this._pumpAsyncQueue();
      return;
    }
    if (this._content) {
      this._content.annotate(event);
      if (event.contentChanged === false) this.metrics.recordUnchanged();
    }
    this._emitDispatched(event);
  }

  /**
   * Whether `event` is large enough that hashing it belongs on the async path rather than this
   * tick of the drain loop. `event.size` unknown is treated as "not oversized": a size the engine
   * could not determine is no reason to prefer a queue and a `Promise` over just reading it.
   * @param {{size?: number}} event
   * @returns {boolean}
   */
  _isOversized(event) {
    return Number.isFinite(event.size) && event.size > this._content.maxBytes;
  }

  /**
   * Start async hashes for queued events up to `maxConcurrentHashes`, in the order they were
   * queued. Called both when a new oversized event arrives and when an in-flight hash finishes
   * and frees its slot.
   */
  _pumpAsyncQueue() {
    while (
      this._started &&
      this._asyncInFlight < this.options.maxConcurrentHashes &&
      this._asyncQueue.length > 0
    ) {
      const event = this._asyncQueue.shift();
      this._asyncInFlight += 1;
      this._runAsyncHash(event, this._sessionAbort);
    }
  }

  /**
   * Fingerprint one event off the drain loop's own tick, then emit it exactly as
   * {@link _dispatch} would have, unless `controller` was aborted first (`stop()`/`close()` ran
   * while this hash was in flight) — in which case the event is dropped, never delivered into a
   * watcher its own caller was told had stopped.
   * @param {object} event
   * @param {AbortController} controller the session this event was queued under
   */
  async _runAsyncHash(event, controller) {
    try {
      await this._content.annotateAsync(event, { signal: controller.signal });
      if (!controller.signal.aborted) {
        if (event.contentChanged === false) this.metrics.recordUnchanged();
        this._emitDispatched(event);
      }
    } catch (err) {
      if (!controller.signal.aborted) this._fail(err);
    } finally {
      this._asyncInFlight -= 1;
      this._pumpAsyncQueue();
    }
  }

  _emitDispatched(event) {
    if (event.kind === 'rescanRequired') {
      this._safeEmit('rescan', event);
      this._safeEmit('all', event);
      return;
    }

    if (event.isDirectory && !this.options.emitDirectories) {
      this.metrics.recordFiltered();
      this._safeEmit('all', event);
      return;
    }

    const name = KIND_TO_EVENT[event.kind];
    if (name) {
      this.metrics.recordEmitted();
      this._safeEmit(name, event.path, event);
    }
    this._safeEmit('all', event);
  }

  /**
   * A throwing listener must not take down the watcher, and must not recurse
   * into 'error' if it was the 'error' listener that threw.
   */
  _safeEmit(name, ...args) {
    try {
      this.emit(name, ...args);
    } catch (err) {
      if (name === 'error') return;
      this._fail(err);
    }
  }

  _fail(err) {
    this.metrics.recordError();
    const error = err instanceof Error ? err : new Error(String(err));
    if (this.listenerCount('error') > 0) {
      try {
        this.emit('error', error);
      } catch {
        /* listener threw while handling an error; nothing left to do */
      }
    }
  }
}

/**
 * Engines are allowed to return extra keys; the seven contract keys are
 * normalised so callers see one shape regardless of engine.
 */
function normaliseStats(stats = {}) {
  return {
    eventsQueued: numberOr(stats.eventsQueued, 0),
    eventsDropped: numberOr(stats.eventsDropped, 0),
    eventsDelivered: numberOr(stats.eventsDelivered, 0),
    watchedPaths: numberOr(stats.watchedPaths, 0),
    queuePending: numberOr(stats.queuePending, 0),
    queueCapacity: numberOr(stats.queueCapacity, 0),
    isRunning: Boolean(stats.isRunning),
  };
}

function numberOr(value, fallback) {
  const n = typeof value === 'bigint' ? Number(value) : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Glob lists arrive from user configuration, where an unset variable is `undefined` and a disabled
 * entry is `null`. Neither expresses a pattern, and neither is worth losing a watcher over: the
 * native engine rejects the whole list if one member is not a string, which turns a stray comma
 * into a silent fallback to the bundler's own watcher.
 * @param {unknown} value
 * @returns {string[]}
 */
function patterns(value) {
  if (typeof value === 'string') return value ? [value] : [];
  if (!Array.isArray(value)) return [];
  return value.filter((p) => typeof p === 'string' && p.length > 0);
}

/**
 * A duration where zero is a meaningful answer: clamped up, never replaced.
 * @param {unknown} value
 * @param {number} floor
 * @returns {number}
 */
function atLeast(value, floor) {
  const n = Number(value);
  return Number.isFinite(n) && n > floor ? n : floor;
}

/**
 * A size where zero means nothing at all, and is therefore read as "not specified".
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function positiveOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Normalise `backend`, the same tolerant way every other option here is read: an unrecognised
 * `mode` costs the caller a working watcher never, falling back to `'auto'` rather than throwing,
 * because a config file typo must not be worse than not setting the option at all. The native
 * engine still validates its own `'auto'`/`'poll'` strings, so a genuinely malformed value thrown
 * from elsewhere is not silently swallowed — only a value that never reaches it is.
 * @param {unknown} value
 * @returns {{mode: 'auto'|'poll', pollIntervalMs: number, compareContents: boolean}}
 */
function normaliseBackend(value) {
  const raw = value && typeof value === 'object' ? value : {};
  const mode = raw.mode === 'poll' ? 'poll' : 'auto';
  return {
    mode,
    pollIntervalMs: positiveOr(raw.pollIntervalMs, DEFAULT_BACKEND_POLL_INTERVAL_MS),
    compareContents: raw.compareContents === true,
  };
}

/**
 * Normalise `awaitWriteFinish`. `undefined`/`false`/anything not an object means "off", matching
 * both engines' default of reporting a change as soon as it is seen.
 * @param {unknown} value
 * @returns {{pollIntervalMs: number, stabilityThresholdMs: number}|null}
 */
function normaliseAwaitWriteFinish(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    pollIntervalMs: positiveOr(value.pollIntervalMs, DEFAULT_AWAIT_WRITE_FINISH_POLL_MS),
    stabilityThresholdMs: positiveOr(
      value.stabilityThresholdMs,
      DEFAULT_AWAIT_WRITE_FINISH_STABILITY_MS
    ),
  };
}

/**
 * @param {object} [options]
 * @returns {Retrigger}
 */
function createRetrigger(options) {
  return new Retrigger(options);
}

module.exports = { KIND_TO_EVENT, Retrigger, createRetrigger, normaliseStats };
