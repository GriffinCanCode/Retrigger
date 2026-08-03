'use strict';

/**
 * Optional Watchman-backed engine, implementing the same contract as `js-watcher.js`
 * (`watch`/`unwatch`/`start`/`stop`/`poll`/`stats`/`backend`, plus the Lane-2 snapshot methods).
 *
 * Never a hard dependency, in either direction Watchman can be reached:
 *   1. the `fb-watchman` client, if the *consuming* application installed it (this package
 *      never declares it, so `npm install @retrigger/core` alone can never pull it in) —
 *      genuine BSER framing over Watchman's own unix socket / named pipe, with a `subscribe`
 *      driving real push notifications rather than a poll loop.
 *   2. the `watchman` binary on `PATH`, invoked in its JSON (`-j`) mode, when the npm client
 *      is not installed but the service is. The CLI has no persistent subscribe stream in this
 *      mode, so this path re-issues a `since` query on `backend.pollIntervalMs` (default below)
 *      instead — lower fidelity than (1), but still Watchman's own file-change journal, not a
 *      walk this package invented.
 * `detectWatchman()` is the single place either is attempted, and every failure — a missing
 * module, a missing binary, a binary that answers something that is not Watchman's JSON — comes
 * back as `{ kind: null, reason }` rather than a throw. `engine.js` reads that to decide whether
 * `prefer: 'watchman'` can be honoured or must fall back.
 *
 * Divergences from `js-watcher.js`, stated plainly:
 *   - `created` vs `modified` is Watchman's own `new` field, not a locally-tracked seen-set —
 *     Watchman already answers the question `BoundedSet` exists to approximate, so there is
 *     nothing here for it to get wrong once forgotten.
 *   - `renamedFrom`/`renamedTo` are never produced, the same as the JS engine: Watchman's file
 *     list has no rename correlation either, and reports the two halves as a delete and a create.
 *   - `recursive: false` is enforced by dropping any changed path whose name (relative to the
 *     watched directory) contains a separator — Watchman always watches a whole project at the
 *     kernel level; there is no per-directory handle to simply not open, the way the JS engine
 *     has one.
 *   - Symlinked directories follow Watchman's own crawler, which does not traverse them either.
 *   - `backend()` reports `"watchman"`.
 */

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const { Matcher } = require('./matcher');
const { COALESCABLE } = require('./js-watcher');

const SNAPSHOT_ALGORITHM = 'xxh3-64';
const SNAPSHOT_ENVELOPE_VERSION = 1;

const DEFAULT_CAPACITY = 8192;
const QUEUE_COMPACT_THRESHOLD = 1024;
/** How often a CLI-mode root re-issues its `since` query. Irrelevant to the `fb-watchman` path,
 * which is pushed to instead. */
const DEFAULT_CLI_POLL_MS = 300;
const DEFAULT_STABILIZE_POLL_MS = 100;
const DEFAULT_STABILIZE_THRESHOLD_MS = 2000;
/** Fields asked of every Watchman query. `new`/`exists` are what let a query answer
 * created/modified/deleted without this module keeping a seen-set of its own. */
const WATCHMAN_FIELDS = ['name', 'exists', 'new', 'type', 'size', 'mtime_ms'];

// ------------------------------------------------------------------- detection

let cachedProbe = null;

function errText(err) {
  if (!err) return 'unknown error';
  const msg = typeof err === 'string' ? err : err.message || String(err);
  return msg.split('\n')[0].slice(0, 300);
}

/**
 * Attempt to reach a Watchman service. Never throws.
 * @param {{env?: object, fresh?: boolean}} [options]
 * @returns {{kind: 'fb-watchman'|'cli'|null, reason: string, binary: string|null, module: object|null}}
 */
function detectWatchman(options = {}) {
  if (!options.fresh && cachedProbe) return cachedProbe;
  const env = options.env || process.env;
  let result;

  if (env.RETRIGGER_NO_WATCHMAN === '1') {
    result = {
      kind: null,
      reason: 'disabled by RETRIGGER_NO_WATCHMAN',
      binary: null,
      module: null,
    };
  } else {
    let client = null;
    try {
      // Optional by construction: never in this package's own dependency graph, so this
      // resolves only when the consuming application installed it itself.
      client = require('fb-watchman'); // eslint-disable-line global-require
    } catch {
      client = null;
    }
    if (client) {
      result = {
        kind: 'fb-watchman',
        reason: 'fb-watchman client is installed',
        binary: null,
        module: client,
      };
    } else {
      const binary = env.RETRIGGER_WATCHMAN_PATH || 'watchman';
      try {
        const out = execFileSync(binary, ['version', '-j'], {
          encoding: 'utf8',
          timeout: 2000,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        JSON.parse(out); // sanity: is this really Watchman's JSON reply
        result = { kind: 'cli', reason: `watchman binary found (${binary})`, binary, module: null };
      } catch (err) {
        result = {
          kind: null,
          reason: `watchman unavailable (no fb-watchman client; ${errText(err)})`,
          binary: null,
          module: null,
        };
      }
    }
  }

  if (!options.fresh) cachedProbe = result;
  return result;
}

/** Testing seam: forget the memoised probe. */
function resetWatchmanCache() {
  cachedProbe = null;
}

// ---------------------------------------------------------------------- client

/**
 * One transport, two implementations behind it: a persistent BSER connection when
 * `fb-watchman` is available, or a one-shot JSON round trip through the CLI otherwise. Callers
 * never see which; they only see `command()` and, when it exists, pushed subscription payloads.
 */
class WatchmanTransport {
  /** @param {{kind: string, binary: string|null, module: object|null}} probe */
  constructor(probe) {
    this.kind = probe.kind;
    this.binary = probe.binary;
    this._onSubscription = null;
    this._wm = probe.kind === 'fb-watchman' ? new probe.module.Client() : null;
    if (this._wm) {
      this._wm.on('subscription', (resp) => {
        if (this._onSubscription) this._onSubscription(resp);
      });
      // Command-level failures already reject their own promise; a transport-level error here
      // would otherwise be an unhandled 'error' event on the client and crash the process.
      this._wm.on('error', () => {});
    }
  }

  /** @param {(resp: object) => void} fn */
  onSubscription(fn) {
    this._onSubscription = fn;
  }

  /**
   * @param {Array<unknown>} args a Watchman command, e.g. `['watch-project', dir]`
   * @returns {Promise<object>}
   */
  command(args) {
    if (this._wm) {
      return new Promise((resolve, reject) => {
        this._wm.command(args, (err, resp) => (err ? reject(err) : resolve(resp)));
      });
    }
    return this._runCli(args);
  }

  _runCli(args) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(this.binary, ['-j', '--no-pretty'], { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err) {
        reject(err);
        return;
      }
      let out = '';
      let errOut = '';
      child.stdout.on('data', (chunk) => (out += chunk));
      child.stderr.on('data', (chunk) => (errOut += chunk));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(errOut.trim() || `watchman exited ${code}`));
          return;
        }
        try {
          const parsed = JSON.parse(out);
          if (parsed && parsed.error) reject(new Error(parsed.error));
          else resolve(parsed);
        } catch (err) {
          reject(err);
        }
      });
      child.stdin.write(JSON.stringify(args));
      child.stdin.end();
    });
  }

  close() {
    if (this._wm) {
      try {
        this._wm.end();
      } catch {
        /* already closed */
      }
    }
  }
}

// --------------------------------------------------------------------- watcher

class WatchmanWatcher {
  /**
   * @param {{capacity?: number, debounceMs?: number, include?: string[], exclude?: string[],
   *   awaitWriteFinish?: {pollIntervalMs?: number, stabilityThresholdMs?: number},
   *   backend?: string, pollIntervalMs?: number, pollCompareContents?: boolean,
   *   atomicWriteNormalization?: boolean}} [options]
   * @param {{kind: string, reason: string, binary: string|null, module: object|null}} [probe]
   *   result of {@link detectWatchman}; re-probed if omitted, so this class is still usable
   *   standalone rather than only through `engine.js`.
   */
  constructor(options = {}, probe) {
    const capacity = Number(options.capacity);
    this.capacity =
      Number.isFinite(capacity) && capacity > 0 ? Math.floor(capacity) : DEFAULT_CAPACITY;
    const debounce = Number(options.debounceMs);
    this.debounceMs = Number.isFinite(debounce) && debounce > 0 ? Math.floor(debounce) : 0;
    this.matcher = new Matcher({ include: options.include, exclude: options.exclude });
    this.awaitWriteFinish = normaliseAwaitWriteFinish(options.awaitWriteFinish);
    const pollIntervalMs = Number(options.pollIntervalMs);
    /** CLI-mode `since` polling interval; unused on the `fb-watchman` (pushed) path. */
    this._pollIntervalMs =
      Number.isFinite(pollIntervalMs) && pollIntervalMs > 0
        ? Math.floor(pollIntervalMs)
        : DEFAULT_CLI_POLL_MS;

    this._probe = probe || detectWatchman();
    /** @type {WatchmanTransport|null} created lazily, torn down by `stop()`. */
    this._transport = null;
    this._subCounter = 0;
    /** @type {Map<string, string>} subscription name -> registered root, `fb-watchman` only */
    this._subsByName = new Map();

    /** @type {Map<string, {recursive: boolean, isDirectory: boolean, watchRoot?: string,
     *   relativePath?: string, clock?: string, subscriptionName?: string,
     *   pollTimer?: NodeJS.Timeout, attached?: boolean}>} */
    this._roots = new Map();
    this._queue = [];
    this._head = 0;
    /** @type {Map<string, {kind: string, isDirectory: boolean, size: number, owed: boolean, due: number}>} */
    this._pending = new Map();
    this._sweep = null;
    /** @type {Map<string, {last: {size: number, mtimeMs: number}|null, stableSince: number, nextPoll: number}>} */
    this._stabilizing = new Map();
    this._stabilizeTimer = null;
    this._errors = [];
    this._notifier = null;
    this._running = false;
    this._overflowed = false;
    this._counters = { queued: 0, dropped: 0, delivered: 0 };
  }

  // ---------------------------------------------------------------- contract

  /**
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

  /** @param {string} target */
  unwatch(target) {
    if (typeof target !== 'string' || target.length === 0) {
      throw new TypeError('unwatch(path) requires a non-empty string path');
    }
    const abs = path.resolve(target);
    const info = this._roots.get(abs);
    this._roots.delete(abs);
    if (info) this._detachRoot(abs, info);
  }

  start() {
    if (this._running) return;
    this._running = true;
    if (!this._transport) this._transport = this._makeTransport();
    for (const root of this._roots.keys()) this._attachRoot(root);
  }

  stop() {
    this._running = false;
    for (const [abs, info] of this._roots) this._detachRoot(abs, info, { keepRegistration: true });
    if (this._transport) {
      this._transport.close();
      this._transport = null;
    }
    if (this._sweep) {
      clearTimeout(this._sweep);
      this._sweep = null;
    }
    if (this._stabilizeTimer) {
      clearTimeout(this._stabilizeTimer);
      this._stabilizeTimer = null;
    }
    this._pending.clear();
    this._stabilizing.clear();
    this._subsByName.clear();
    this._queue = [];
    this._head = 0;
    this._overflowed = false;
  }

  /** @returns {object|null} */
  poll() {
    if (this._head >= this._queue.length) return null;
    const event = this._queue[this._head];
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

  get _queued() {
    return this._queue.length - this._head;
  }

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
    return 'watchman';
  }

  /**
   * Crawl `target`'s current contents via a Watchman `query`, without registering a live watch.
   * @param {string} target
   * @returns {Promise<{algorithm: string, version: number, entries: Array}>}
   */
  async snapshot(target) {
    if (typeof target !== 'string' || target.length === 0) {
      throw new TypeError('snapshot(path) requires a non-empty string path');
    }
    const abs = path.resolve(target);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch (err) {
      const error = new Error(`cannot snapshot ${abs}: ${err.message}`);
      error.code = err.code || 'ENOENT';
      throw error;
    }
    const watchDir = stat.isDirectory() ? abs : path.dirname(abs);
    const transport = this._transport || this._makeTransport();
    const { root, relativePath } = await this._watchProject(transport, watchDir);
    const query = { expression: ['true'], fields: WATCHMAN_FIELDS };
    if (relativePath) query.relative_root = relativePath;
    const resp = await transport.command(['query', root, query]);
    if (!this._transport) transport.close();

    const entries = [];
    for (const file of resp.files || []) {
      if (file.exists === false) continue;
      const entryPath = path.join(watchDir, file.name);
      if (entryPath === abs) continue;
      const isDirectory = file.type === 'd';
      if (
        isDirectory ? !this.matcher.allowsDirectory(entryPath) : !this.matcher.matches(entryPath)
      ) {
        continue;
      }
      entries.push({
        path: entryPath,
        isDirectory,
        size: isDirectory ? 0 : Number(file.size) || 0,
        modifiedNs: Number.isFinite(file.mtime_ms) ? BigInt(Math.round(file.mtime_ms * 1e6)) : null,
      });
    }
    return { algorithm: SNAPSHOT_ALGORITHM, version: SNAPSHOT_ENVELOPE_VERSION, entries };
  }

  /**
   * @param {string} target
   * @param {boolean} [recursive=true]
   * @returns {Promise<{algorithm: string, version: number, entries: Array}>}
   */
  async watchWithSnapshot(target, recursive = true) {
    this.watch(target, recursive);
    return this.snapshot(target);
  }

  // ---------------------------------------------------------- watchman extras

  /**
   * Watchman-only: ask Watchman's own change journal what moved since `clock`, rather than
   * re-walking the tree. Complementary to {@link WatchmanWatcher#snapshot} and the Rust daemon's
   * walk-based `diff_snapshots` — this is a genuine `since` query against whichever clock
   * Watchman itself last handed out, not a diff this package computed by re-crawling.
   *
   * @param {string} target a path already passed to {@link WatchmanWatcher#watch}, or any
   *   existing path — an unwatched one is registered with Watchman for this call alone.
   * @param {string} [clock] a clockspec returned by a previous call, or by `watch()`'s own
   *   initial `clock` command; omitted means "everything since the watch began".
   * @returns {Promise<{clock: string, isFreshInstance: boolean, entries: Array<{path: string,
   *   isDirectory: boolean, exists: boolean, isNew: boolean, size: number,
   *   modifiedNs: bigint|null}>}>}
   */
  async changesSince(target, clock) {
    const abs = path.resolve(target);
    const transport = this._transport || this._makeTransport();
    const info = this._roots.get(abs);
    let root;
    let relativePath;
    let sinceClock = clock;

    if (info && info.watchRoot) {
      root = info.watchRoot;
      relativePath = info.relativePath;
      if (!sinceClock) sinceClock = info.clock;
    } else {
      let stat;
      try {
        stat = fs.statSync(abs);
      } catch (err) {
        const error = new Error(`cannot query ${abs}: ${err.message}`);
        error.code = err.code || 'ENOENT';
        throw error;
      }
      const watchDir = stat.isDirectory() ? abs : path.dirname(abs);
      const watched = await this._watchProject(transport, watchDir);
      root = watched.root;
      relativePath = watched.relativePath;
      if (!sinceClock) {
        const clockResp = await transport.command(['clock', root]);
        sinceClock = clockResp.clock;
      }
    }

    const query = { since: sinceClock, fields: WATCHMAN_FIELDS };
    if (relativePath) query.relative_root = relativePath;
    const resp = await transport.command(['query', root, query]);
    if (!this._transport) transport.close();

    const watchDir = relativePath ? path.join(root, relativePath) : root;
    const entries = (resp.files || []).map((file) => ({
      path: path.join(watchDir, file.name),
      isDirectory: file.type === 'd',
      exists: file.exists !== false,
      isNew: Boolean(file.new),
      size: file.exists === false ? 0 : Number(file.size) || 0,
      modifiedNs: Number.isFinite(file.mtime_ms) ? BigInt(Math.round(file.mtime_ms * 1e6)) : null,
    }));
    return { clock: resp.clock, isFreshInstance: Boolean(resp.is_fresh_instance), entries };
  }

  // -------------------------------------------------------------- extensions

  /** @param {((...args: any[]) => void)|null} fn */
  setNotifier(fn) {
    this._notifier = typeof fn === 'function' ? fn : null;
  }

  /** @returns {Error[]} errors observed since the last drain */
  drainErrors() {
    const errors = this._errors;
    this._errors = [];
    return errors;
  }

  // ----------------------------------------------------------------- private

  _makeTransport() {
    return new WatchmanTransport(this._probe);
  }

  async _watchProject(transport, dir) {
    const resp = await transport.command(['watch-project', dir]);
    return { root: resp.watch, relativePath: resp.relative_path || '' };
  }

  async _attachRoot(abs) {
    const info = this._roots.get(abs);
    if (!info || info.attached) return;
    const watchDir = info.isDirectory ? abs : path.dirname(abs);
    try {
      const transport = this._transport || (this._transport = this._makeTransport());
      const { root, relativePath } = await this._watchProject(transport, watchDir);
      if (!this._roots.has(abs) || !this._running) return; // unwatched/stopped while awaiting
      info.watchRoot = root;
      info.relativePath = relativePath;
      const clockResp = await transport.command(['clock', root]);
      if (!this._roots.has(abs) || !this._running) return;
      info.clock = clockResp.clock;
      info.attached = true;
      if (transport.kind === 'fb-watchman') this._subscribe(abs, info, transport);
      else this._schedulePoll(abs, info, transport);
    } catch (err) {
      this._recordError(err);
    }
  }

  _detachRoot(abs, info, { keepRegistration = false } = {}) {
    if (info.pollTimer) {
      clearTimeout(info.pollTimer);
      info.pollTimer = undefined;
    }
    if (info.subscriptionName) {
      this._subsByName.delete(info.subscriptionName);
      if (this._transport && info.watchRoot) {
        this._transport
          .command(['unsubscribe', info.watchRoot, info.subscriptionName])
          .catch(() => {
            /* best effort: the connection may already be gone */
          });
      }
      info.subscriptionName = undefined;
    }
    if (!keepRegistration) info.attached = false;
  }

  _subscribe(abs, info, transport) {
    const name = `retrigger-${this._subCounter++}`;
    info.subscriptionName = name;
    const sub = { expression: ['true'], fields: WATCHMAN_FIELDS, since: info.clock };
    if (info.relativePath) sub.relative_root = info.relativePath;
    transport.onSubscription((resp) => {
      const rootAbs = this._subsByName.get(resp.subscription);
      if (!rootAbs) return;
      const rootInfo = this._roots.get(rootAbs);
      if (!rootInfo) return;
      if (resp.clock) rootInfo.clock = resp.clock;
      this._handleFiles(rootAbs, rootInfo, resp.files || []);
    });
    transport.command(['subscribe', info.watchRoot, name, sub]).then(
      () => this._subsByName.set(name, abs),
      (err) => this._recordError(err)
    );
  }

  _schedulePoll(abs, info, transport) {
    if (!this._running || !this._roots.has(abs)) return;
    info.pollTimer = setTimeout(async () => {
      info.pollTimer = undefined;
      if (!this._running || !this._roots.has(abs)) return;
      try {
        const query = { since: info.clock, fields: WATCHMAN_FIELDS };
        if (info.relativePath) query.relative_root = info.relativePath;
        const resp = await transport.command(['query', info.watchRoot, query]);
        if (resp.clock) info.clock = resp.clock;
        this._handleFiles(abs, info, resp.files || []);
      } catch (err) {
        this._recordError(err);
      }
      this._schedulePoll(abs, info, transport);
    }, this._pollIntervalMs);
    if (typeof info.pollTimer.unref === 'function') info.pollTimer.unref();
  }

  /**
   * Translate one batch of Watchman file entries into contract events for `root`.
   * @param {string} rootAbs
   * @param {object} info
   * @param {Array<object>} files
   */
  _handleFiles(rootAbs, info, files) {
    const watchDir = info.isDirectory ? rootAbs : path.dirname(rootAbs);
    for (const file of files) {
      const name = String(file.name || '').replace(/\\/g, '/');
      if (!info.recursive && name.includes('/')) continue;
      if (!info.isDirectory && name !== path.basename(rootAbs)) continue;

      const entryPath = path.join(watchDir, file.name);
      const isDirectory = file.type === 'd';
      const exists = file.exists !== false;
      let kind;
      if (!exists) kind = 'deleted';
      else if (file.new) kind = 'created';
      else kind = isDirectory ? 'metadata' : 'modified';

      this._emitIfMatched(entryPath, kind, isDirectory, exists ? Number(file.size) || 0 : 0);
    }
  }

  _emitIfMatched(target, kind, isDirectory, size) {
    if (!isDirectory && !this.matcher.matches(target)) return;
    if (isDirectory && !this.matcher.allowsDirectory(target)) return;
    if (this.awaitWriteFinish) {
      if (kind === 'deleted') {
        this._stabilizing.delete(target);
      } else if (!isDirectory && COALESCABLE.has(kind)) {
        this._trackStabilization(target);
        return;
      }
    }
    if (this.debounceMs > 0) this._enqueueDebounced(target, kind, isDirectory, size);
    else this._enqueue(this._makeEvent(target, kind, isDirectory, size));
  }

  _trackStabilization(target) {
    if (this._stabilizing.has(target)) return;
    const now = Date.now();
    this._stabilizing.set(target, {
      last: null,
      stableSince: now,
      nextPoll: now + this.awaitWriteFinish.pollIntervalMs,
    });
    this._scheduleStabilizeSweep();
  }

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

  _stabilizeSweep() {
    const now = Date.now();
    for (const [target, entry] of this._stabilizing) {
      if (entry.nextPoll > now) continue;
      let stat;
      try {
        stat = fs.statSync(target);
      } catch {
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

  _enqueueDebounced(target, kind, isDirectory, size) {
    const existing = this._pending.get(target);
    if (existing) {
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
    this._pending.set(target, {
      kind,
      isDirectory,
      size,
      owed: false,
      due: Date.now() + this.debounceMs,
    });
    this._scheduleSweep();
  }

  _scheduleSweep() {
    if (this._sweep || this._pending.size === 0) return;
    const first = this._pending.values().next().value;
    const delay = Math.max(0, first.due - Date.now());
    this._sweep = setTimeout(() => {
      this._sweep = null;
      this._flushDue();
    }, delay);
    if (typeof this._sweep.unref === 'function') this._sweep.unref();
  }

  _flushDue() {
    const now = Date.now();
    for (const [target, entry] of this._pending) {
      if (entry.due > now) break;
      this._pending.delete(target);
      if (entry.owed)
        this._enqueue(this._makeEvent(target, 'modified', entry.isDirectory, entry.size));
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

  _enqueue(event) {
    if (this._queued >= this.capacity) {
      if (!this._overflowed) {
        this._counters.dropped += this._queued;
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

module.exports = {
  DEFAULT_CLI_POLL_MS,
  WatchmanTransport,
  WatchmanWatcher,
  detectWatchman,
  resetWatchmanCache,
};
