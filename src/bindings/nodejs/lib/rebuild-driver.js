'use strict';

/**
 * Shared manual-rebuild scheduler for bundlers with no public veto seam.
 *
 * Neither Rollup's `RollupWatcher` (`watchChange`) nor esbuild's `context(...).watch()` lets a
 * caller stop a rebuild the tool already decided to run — both are observation-only. Skipping a
 * byte-identical rebuild for either tool is therefore not a matter of gating an event inside the
 * bundler's own watch loop (as `plugins/vite-plugin.js` gates `server.watcher.emit`, and as
 * `plugins/webpack-plugin.js` withholds a changed path from webpack's callback): it means
 * Retrigger owns the watch instead, and the bundler is invoked exactly once per real change,
 * as a plain one-shot build. This class is the scheduler both `lib/rollup-plugin.js` and
 * `lib/esbuild-plugin.js` drive that one-shot build through; neither of them calls a bundler's
 * own watch API.
 *
 * What it owns:
 *   - a `Retrigger` watcher, filtered to events `contentChanged !== false` (the same gate
 *     `content.js` answers for every other consumer in this package);
 *   - a trailing coalescing window (`coalesceMs`), reset on every new change, so a burst of saves
 *     collapses into one rebuild instead of one per file — the same shape as
 *     `WatchSession._schedule` in `plugins/webpack-plugin.js`;
 *   - exactly one rebuild in flight at a time, with at most one more queued behind it: a change
 *     that lands while a rebuild is running is *not* dropped, but it is also not allowed to start
 *     a second concurrent rebuild — it re-arms the coalescing window so it fires the moment the
 *     current one settles, and further changes arriving before then still only add to that single
 *     follow-up's path set;
 *   - clean, awaitable shutdown: `close()` clears every timer, stops the watcher, and waits for an
 *     in-flight `rebuild()` to settle (after signalling its `AbortSignal`) before returning.
 *
 * A `rebuild()` that throws or rejects is reported through `metrics.errors` and the `'error'`
 * event, never re-thrown into the watcher's own call stack — the same fail-open discipline every
 * other driver callback in this package holds to.
 */

const { EventEmitter } = require('events');

const { createRetrigger } = require('./retrigger');
const { Metrics } = require('./metrics');

const DEFAULT_COALESCE_MS = 20;

class RebuildDriver extends EventEmitter {
  /**
   * @param {{rebuild: (changedPaths: string[], context: {signal: AbortSignal}) => unknown,
   *   watchPaths?: string|string[], retriggerOptions?: object, coalesceMs?: number,
   *   onError?: (error: Error) => void}} options
   */
  constructor(options = {}) {
    super();
    if (typeof options.rebuild !== 'function') {
      throw new TypeError('RebuildDriver requires a `rebuild(changedPaths)` function');
    }
    this._rebuild = options.rebuild;
    this._coalesceMs = positiveOr(options.coalesceMs, DEFAULT_COALESCE_MS);
    if (typeof options.onError === 'function') this.on('error', options.onError);

    const retriggerOptions = options.retriggerOptions || {};
    this._watcher = createRetrigger({
      ...retriggerOptions,
      paths: options.watchPaths ?? retriggerOptions.paths,
    });
    this._watcher.on('error', (err) => this._fail(err));
    this._watcher.on('all', (event) => this._onEvent(event));

    this.metrics = new Metrics();
    /** @type {Set<string>} paths changed since the last rebuild started */
    this._pending = new Set();
    /** True once a `rescanRequired` landed and no specific path list can describe it. */
    this._forceRebuild = false;
    this._timer = null;
    this._inFlight = false;
    /** @type {Promise<void>|null} settles when the in-flight rebuild (if any) is done */
    this._inFlightPromise = null;
    /** @type {AbortController|null} the in-flight rebuild's own controller, for `close()` */
    this._abort = null;
    this._started = false;
    this._closed = false;
  }

  /** @returns {import('./retrigger').Retrigger} the watcher this driver owns */
  get watcher() {
    return this._watcher;
  }

  /** @returns {boolean} */
  get isRunning() {
    return this._started && !this._closed;
  }

  /**
   * Start watching. Idempotent, and safe to call again after {@link close}.
   * @returns {this}
   */
  start() {
    if (this._started) return this;
    this._started = true;
    this._closed = false;
    this._watcher.start();
    this.metrics.markStarted();
    return this;
  }

  /**
   * Stop watching and settle. Clears the coalescing timer, aborts the in-flight rebuild's signal
   * (a hint, not a kill — {@link RebuildDriver} still awaits it), then stops the watcher.
   * Idempotent, and safe to call before {@link start}.
   * @returns {Promise<void>}
   */
  async close() {
    this._closed = true;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._abort) this._abort.abort();
    if (this._inFlightPromise) {
      try {
        await this._inFlightPromise;
      } catch {
        /* already reported through 'error' by _runRebuild */
      }
    }
    if (this._started) {
      this._watcher.stop();
      this._started = false;
    }
    this._pending.clear();
    this._forceRebuild = false;
    this.metrics.markStopped();
  }

  /**
   * @returns {{rebuildCount: number, errorCount: number, eventsChanged: number,
   *   eventsUnchanged: number, inFlight: boolean, pendingPaths: number, metrics: object,
   *   watcher: object}}
   */
  getStats() {
    return {
      rebuildCount: this.metrics.triggers,
      errorCount: this.metrics.errors,
      eventsChanged: this.metrics.eventsEmitted,
      eventsUnchanged: this.metrics.eventsUnchanged,
      inFlight: this._inFlight,
      pendingPaths: this._pending.size,
      metrics: this.metrics.snapshot(),
      watcher: this._watcher.getStats(),
    };
  }

  // ----------------------------------------------------------------- private

  _onEvent(event) {
    this.metrics.recordEvent(event.kind);
    if (event.kind === 'rescanRequired') {
      this._forceRebuild = true;
      this._queue();
      return;
    }
    if (event.isDirectory) return; // a bundle is built from files, never from a directory event
    if (event.contentChanged === false) {
      this.metrics.recordUnchanged();
      return;
    }
    this.metrics.recordEmitted();
    this._pending.add(event.path);
    this._queue();
  }

  /**
   * Arm (or re-arm) the coalescing window. While a rebuild is in flight this only records that
   * one more run is owed once it settles — {@link _afterRebuild} arms the real timer then — so a
   * burst arriving mid-rebuild still coalesces into exactly one follow-up instead of firing the
   * instant the current run finishes.
   */
  _queue() {
    if (this._closed || this._inFlight) return;
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      this._trigger();
    }, this._coalesceMs);
  }

  _trigger() {
    if (this._closed || this._inFlight) return;
    if (this._pending.size === 0 && !this._forceRebuild) return;
    const paths = [...this._pending];
    this._pending.clear();
    this._forceRebuild = false;
    this._runRebuild(paths);
  }

  /** @param {string[]} paths */
  _runRebuild(paths) {
    this._inFlight = true;
    const controller = new AbortController();
    this._abort = controller;
    const started = Date.now();

    const promise = Promise.resolve()
      .then(() => this._rebuild(paths, { signal: controller.signal }))
      .then(
        () => {
          this.metrics.recordTrigger(Date.now() - started);
          this._safeEmit('rebuild', paths);
        },
        (err) => {
          if (!controller.signal.aborted) this._fail(err);
        }
      )
      .finally(() => {
        this._inFlight = false;
        this._abort = null;
        this._afterRebuild();
      });

    this._inFlightPromise = promise;
  }

  /** Exactly one follow-up rebuild, coalescing whatever landed while the last one ran. */
  _afterRebuild() {
    this._inFlightPromise = null;
    if (this._closed) return;
    if (this._pending.size > 0 || this._forceRebuild) this._queue();
  }

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

function positiveOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

module.exports = { RebuildDriver, DEFAULT_COALESCE_MS };
