'use strict';

/**
 * chokidar v5-compatible adapter over `Retrigger`.
 *
 * `watch(paths, options)` returns an already-running `FSWatcher`-shaped `EventEmitter` — no
 * separate `.start()`, matching chokidar's own API. `add()`/`unwatch()` accept a path or an array
 * of paths, and every event chokidar users already handle — `add`/`change`/`unlink`/`addDir`/
 * `unlinkDir`/`ready`/`error`/`all` — is synthesised from the single `Retrigger` `'all'` stream,
 * using the `isDirectory` flag every engine already puts on its events plus, for a path that
 * existed before the watch began, Lane 2's `watchWithSnapshot()` (chokidar itself always emits
 * `add`/`addDir` for the initial scan unless `ignoreInitial` is set; a plain `Retrigger` never
 * does, so the adapter runs that scan itself, ordered so nothing created during it is lost).
 *
 * Divergences from real chokidar, stated plainly rather than papered over:
 *   - A path passed to `add()`/`watch()` must already exist. Real chokidar can watch a path that
 *     does not exist yet and pick it up once created (it watches the nearest existing ancestor
 *     and waits); every engine this package ships requires the target to exist at `watch()` time,
 *     the same restriction `js-watcher.js` and the native engine both have. A missing path is
 *     reported through `error`, not silently deferred.
 *   - `add()` does not accept a glob as a path to expand. Retrigger watches real filesystem
 *     entries; a glob belongs in `ignored`, exactly as `include`/`exclude` work everywhere else
 *     in this package.
 *   - No `raw` event. chokidar's `raw` mirrors the backend-native low-level notification
 *     underneath its own normalisation; this package's engines do not expose one in that shape —
 *     `fs.watch`'s `eventType` and the native engine's `EventKind` are already the contract event
 *     `raw` would otherwise relay, so there is no lower layer left to surface.
 *   - `depth` is not supported. Use `recursive: false` for one level, or an `ignored` glob for
 *     anything finer.
 *   - `ignored` accepts a glob string, a predicate `(path, stats) => boolean`, or an array mixing
 *     either — not a `RegExp` and not chokidar's `anymatch` array-of-mixed-primitive-and-RegExp
 *     shorthand. A predicate receives `stats: undefined` for a live event (no engine here hands
 *     its own events a `Stats` object, and re-`stat`-ing every changed path on the chance an
 *     `ignored` predicate wants one would cost a syscall per event for a filter most callers
 *     write in terms of the path string alone); the initial scan does provide real `Stats`.
 *   - `followSymlinks` is accepted but inert: the JavaScript engine never traverses a symlinked
 *     directory regardless of this option (see `js-watcher.js`), and the native engine follows
 *     one per OS default; neither engine's contract has a toggle for this adapter to forward to.
 *   - Content-hash gating — suppressing `change` for a rewrite with identical bytes — is
 *     available here as `contentHashing` (on by default), an *extension* real chokidar has no
 *     equivalent of. Set it to `false` for byte-for-byte chokidar behaviour.
 *   - `atomic` defaults to `true` here (folding an editor's write-temp-then-rename save into one
 *     `change`), matching chokidar's own long-standing default; `Retrigger`'s own bare default
 *     is `false`, because a standalone watcher has no chokidar convention to match.
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const { Retrigger } = require('./retrigger');
const { Matcher } = require('./matcher');

const KIND_TO_FILE_EVENT = {
  created: 'add',
  modified: 'change',
  deleted: 'unlink',
  renamedFrom: 'unlink',
  renamedTo: 'add',
  metadata: 'change',
};

const KIND_TO_DIR_EVENT = {
  created: 'addDir',
  deleted: 'unlinkDir',
  renamedFrom: 'unlinkDir',
  renamedTo: 'addDir',
};

/**
 * @param {unknown} ignored chokidar's `ignored` option
 * @returns {(target: string, stats?: import('fs').Stats) => boolean}
 */
function compileIgnored(ignored) {
  const list = ignored == null ? [] : Array.isArray(ignored) ? ignored : [ignored];
  const globs = list.filter((entry) => typeof entry === 'string');
  const fns = list.filter((entry) => typeof entry === 'function');
  const matcher = globs.length ? new Matcher({ exclude: globs }) : null;
  return (target, stats) => {
    if (matcher && !matcher.matches(target)) return true;
    for (const fn of fns) {
      try {
        if (fn(target, stats)) return true;
      } catch {
        /* a throwing predicate ignores nothing, rather than taking the watcher down */
      }
    }
    return false;
  };
}

/**
 * chokidar's `{stabilityThreshold, pollInterval}` -> Lane 1's `{stabilityThresholdMs,
 * pollIntervalMs}`. `true` requests the defaults of whichever engine is selected.
 * @param {unknown} value
 * @returns {object|undefined}
 */
function translateAwaitWriteFinish(value) {
  if (value === true) return {};
  if (!value || typeof value !== 'object') return undefined;
  const out = {};
  if (Number.isFinite(value.stabilityThreshold))
    out.stabilityThresholdMs = value.stabilityThreshold;
  if (Number.isFinite(value.pollInterval)) out.pollIntervalMs = value.pollInterval;
  return out;
}

/** @returns {string|string[]} */
function toPathList(paths) {
  return Array.isArray(paths) ? paths : [paths];
}

class FSWatcher extends EventEmitter {
  /**
   * @param {{cwd?: string, ignored?: unknown, ignoreInitial?: boolean, recursive?: boolean,
   *   depth?: number, awaitWriteFinish?: unknown, atomic?: boolean|number, followSymlinks?: boolean,
   *   contentHashing?: boolean, engine?: 'auto'|'native'|'javascript'|'watchman',
   *   include?: string[], exclude?: string[], capacity?: number, debounceMs?: number,
   *   pollIntervalMs?: number}} [options]
   */
  constructor(options = {}) {
    super();
    this.options = options;
    this._cwd = options.cwd ? path.resolve(options.cwd) : null;
    this._ignored = compileIgnored(options.ignored);
    this._ignoreInitial = options.ignoreInitial === true;
    /** @type {Set<string>} every root ever handed to add()/the constructor, still watched */
    this._roots = new Set();
    /** @type {Map<string, 'file'|'directory'>} everything `getWatched()` is built from */
    this._known = new Map();
    this._closed = false;
    this._pendingScans = 0;
    this._everReady = false;

    this._retrigger = new Retrigger({
      recursive: options.depth === undefined ? options.recursive !== false : options.depth > 0,
      debounceMs: options.debounceMs,
      capacity: options.capacity,
      pollIntervalMs: options.pollIntervalMs,
      include: options.include,
      exclude: options.exclude,
      contentHashing: options.contentHashing !== false,
      engine: options.engine,
      emitDirectories: true,
      awaitWriteFinish: translateAwaitWriteFinish(options.awaitWriteFinish),
      atomicWriteNormalization: options.atomic !== false,
    });
    this._retrigger.on('all', (event) => this._onEvent(event));
    this._retrigger.on('error', (err) => this._safeEmit('error', err));
    // chokidar is "watching" from the moment `watch()` returns; nothing here waits for the
    // caller to call a `.start()` that does not exist on this adapter's surface.
    this._retrigger.start();
  }

  /**
   * @param {string|string[]} paths
   * @returns {this}
   */
  add(paths) {
    const list = toPathList(paths).map((p) => this._resolve(p));
    this._pendingScans += 1;
    Promise.all(list.map((p) => this._addRoot(p))).finally(() => {
      this._pendingScans -= 1;
      if (this._pendingScans === 0) this._fireReady();
    });
    return this;
  }

  /**
   * @param {string|string[]} paths
   * @returns {this}
   */
  unwatch(paths) {
    for (const raw of toPathList(paths)) {
      const abs = this._resolve(raw);
      this._roots.delete(abs);
      try {
        this._retrigger.unwatch(abs);
      } catch {
        /* never watched, or already gone */
      }
      this._forgetTree(abs);
    }
    return this;
  }

  /** @returns {Record<string, string[]>} directory -> immediate child basenames, chokidar-shaped */
  getWatched() {
    /** @type {Map<string, Set<string>>} */
    const dirs = new Map();
    const ensure = (dir) => {
      let set = dirs.get(dir);
      if (!set) {
        set = new Set();
        dirs.set(dir, set);
      }
      return set;
    };
    for (const root of this._roots) ensure(root);
    for (const [entryPath, kind] of this._known) {
      ensure(path.dirname(entryPath)).add(path.basename(entryPath));
      if (kind === 'directory') ensure(entryPath);
    }
    const out = {};
    for (const [dir, children] of dirs) {
      const key = this._cwd ? path.relative(this._cwd, dir) || '.' : dir;
      out[key] = [...children].sort();
    }
    return out;
  }

  /** @returns {Promise<void>} */
  async close() {
    if (this._closed) return;
    this._closed = true;
    this._retrigger.close();
    this._roots.clear();
    this._known.clear();
  }

  // ----------------------------------------------------------------- private

  _resolve(target) {
    return path.resolve(this._cwd || process.cwd(), target);
  }

  async _addRoot(abs) {
    let entry;
    try {
      entry = fs.statSync(abs);
    } catch (err) {
      this._safeEmit('error', wrapMissing(abs, err));
      return;
    }
    this._roots.add(abs);
    try {
      // Watched before crawled, per Lane 2's own guarantee, so nothing created during the scan
      // is lost between the two steps.
      const snap = await this._retrigger.watchWithSnapshot(abs);
      this._recordKnown(abs, entry.isDirectory());
      if (!this._ignoreInitial && !this._ignored(abs, entry)) {
        this._safeEmit(entry.isDirectory() ? 'addDir' : 'add', abs, entry);
        this._safeEmit('all', entry.isDirectory() ? 'addDir' : 'add', abs, entry);
      }
      for (const item of snap.entries) {
        this._recordKnown(item.path, item.isDirectory);
        if (this._ignoreInitial) continue;
        if (this._ignored(item.path)) continue;
        const stats = statsFromEntry(item);
        const name = item.isDirectory ? 'addDir' : 'add';
        this._safeEmit(name, item.path, stats);
        this._safeEmit('all', name, item.path, stats);
      }
    } catch (err) {
      this._safeEmit('error', err);
    }
  }

  _recordKnown(target, isDirectory) {
    this._known.set(target, isDirectory ? 'directory' : 'file');
  }

  _forgetTree(root) {
    const prefix = root + path.sep;
    for (const key of this._known.keys()) {
      if (key === root || key.startsWith(prefix)) this._known.delete(key);
    }
  }

  _fireReady() {
    this._everReady = true;
    this._safeEmit('ready');
  }

  _onEvent(event) {
    if (this._closed) return;
    if (event.kind === 'rescanRequired') {
      this._safeEmit('error', new Error('retrigger: event queue overflowed; re-scan recommended'));
      return;
    }
    const target = event.path;
    if (this._ignored(target)) return;

    if (event.isDirectory) {
      const name = KIND_TO_DIR_EVENT[event.kind];
      if (!name) return; // a directory metadata event has no chokidar equivalent
      if (name === 'addDir') this._recordKnown(target, true);
      else this._known.delete(target);
      this._safeEmit(name, target);
      this._safeEmit('all', name, target);
      return;
    }

    if (event.contentChanged === false) return; // the reason `contentHashing` exists
    const name = KIND_TO_FILE_EVENT[event.kind];
    if (!name) return;
    if (name === 'add') this._recordKnown(target, false);
    else if (name === 'unlink') this._known.delete(target);
    const stats = statsFor(target, event);
    this._safeEmit(name, target, stats);
    this._safeEmit('all', name, target, stats);
  }

  _safeEmit(name, ...args) {
    try {
      this.emit(name, ...args);
    } catch (err) {
      if (name === 'error') return;
      try {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      } catch {
        /* a throwing error listener has nowhere further to report to */
      }
    }
  }
}

function statsFromEntry(entry) {
  return {
    isDirectory: () => entry.isDirectory,
    isFile: () => !entry.isDirectory,
    size: entry.size,
    mtimeMs: entry.modifiedNs === null ? undefined : Number(entry.modifiedNs) / 1e6,
  };
}

function statsFor(target, event) {
  if (event.kind === 'deleted' || event.kind === 'renamedFrom') return undefined;
  try {
    return fs.statSync(target);
  } catch {
    return undefined;
  }
}

function wrapMissing(target, err) {
  const error = new Error(`cannot watch ${target}: ${err.message}`);
  error.code = err.code || 'ENOENT';
  return error;
}

/**
 * @param {string|string[]} paths
 * @param {object} [options]
 * @returns {FSWatcher}
 */
function watch(paths, options) {
  const watcher = new FSWatcher(options);
  watcher.add(paths);
  return watcher;
}

module.exports = { FSWatcher, watch };
module.exports.default = { watch, FSWatcher };
