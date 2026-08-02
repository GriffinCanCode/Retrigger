'use strict';

const { EventEmitter } = require('events');
const { statSync } = require('fs');
const path = require('path');

const { ContentTracker } = require('./content');
const { getEngine, getEngineInfo } = require('./engine');
const { Metrics } = require('./metrics');

const DEFAULT_POLL_INTERVAL_MS = 5;
const DEFAULT_CAPACITY = 8192;

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
 */
class Retrigger extends EventEmitter {
  /**
   * @param {{paths?: string|string[], recursive?: boolean, include?: string[],
   *   exclude?: string[], debounceMs?: number, capacity?: number,
   *   pollIntervalMs?: number, engine?: 'auto'|'native'|'javascript',
   *   emitDirectories?: boolean, unref?: boolean, contentHashing?: boolean,
   *   maxHashBytes?: number}} [options]
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
    });

    this._timer = null;
    this._draining = false;
    this._drainQueued = false;
    this._started = false;

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

  /** @returns {this} */
  start() {
    if (this._started) return this;
    this._watcher.start();
    this._started = true;
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
    if (this._content) {
      this._content.annotate(event);
      if (event.contentChanged === false) this.metrics.recordUnchanged();
    }

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
 * @param {object} [options]
 * @returns {Retrigger}
 */
function createRetrigger(options) {
  return new Retrigger(options);
}

module.exports = { KIND_TO_EVENT, Retrigger, createRetrigger, normaliseStats };
