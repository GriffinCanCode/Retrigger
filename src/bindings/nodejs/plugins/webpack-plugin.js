'use strict';

/**
 * Retrigger webpack 5 plugin.
 *
 * Replaces webpack's `watchFileSystem` (Watchpack) with a Retrigger-backed
 * implementation of the same contract:
 *
 *   watch(files, directories, missing, startTime, options, callback, callbackUndelayed)
 *   callback(err, fileTimeInfoEntries, contextTimeInfoEntries, changedFiles, removedFiles)
 *   callbackUndelayed(filePath, changeTime)
 *
 * Degradation rules, in priority order:
 *   1. Nothing in this file may throw out of a webpack hook.
 *   2. If the native engine is missing, the JavaScript engine is used instead.
 *   3. If watching cannot be established at all, every call is delegated to
 *      webpack's original `watchFileSystem`, so the build still works.
 */

const path = require('path');
const fsp = require('fs/promises');

const { Metrics } = require('../lib/metrics');
const { createRetrigger } = require('../lib/retrigger');
const { getEngineInfo } = require('../lib/engine');

const PLUGIN = 'RetriggerWebpackPlugin';

/**
 * Directory subtrees that are never recursed into. node_modules is excluded by
 * default for the same reason every dev-server watcher excludes it: recursing
 * it costs thousands of watch descriptors. The consequence is explicit — edits
 * inside node_modules will not trigger a rebuild. Override with `exclude: []`.
 */
const DEFAULT_EXCLUDE = ['**/node_modules/**', '**/.git/**'];

/**
 * Timestamp entries retained per map.
 *
 * These maps are handed to webpack as `fileTimeInfoEntries` / `contextTimeInfoEntries`, and webpack
 * treats a path it cannot find in them as one whose timestamp it does not know — which costs it a
 * `stat` and nothing else. An eviction is therefore a slower answer, never a wrong one. Without a
 * ceiling the maps record every path the watcher ever reported, including files webpack has no
 * dependency on, and a long session across branch switches and generated output grows them without
 * any bound but the disk.
 */
const TIME_INFO_LIMIT = 32768;

/**
 * Paths held over per set while webpack is busy compiling.
 *
 * A compilation of a large project takes seconds, and a `git checkout` landing inside one produces
 * far more paths than webpack will ask about. Past this many the sets stop enumerating and the next
 * session is told to invalidate its whole dependency set instead — over-reporting, which webpack
 * answers with a rebuild, rather than discarding an edit.
 */
const PENDING_LIMIT = 16384;

class RetriggerWebpackPlugin {
  /**
   * @param {{watchPaths?: string[], verbose?: boolean, debounceMs?: number,
   *   include?: string[], exclude?: string[], engine?: 'auto'|'native'|'javascript',
   *   replaceWatcher?: boolean, aggregateTimeout?: number, capacity?: number,
   *   pollIntervalMs?: number, contentHashing?: boolean}} [options]
   */
  constructor(options = {}) {
    const legacy = options.watchOptions || {};
    this.options = {
      watchPaths: options.watchPaths || [],
      verbose: options.verbose === true,
      debounceMs: options.debounceMs ?? 0,
      include: options.include || legacy.include_patterns || [],
      exclude: options.exclude || legacy.exclude_patterns || DEFAULT_EXCLUDE,
      engine: options.engine || 'auto',
      replaceWatcher: options.replaceWatcher !== false,
      aggregateTimeout: options.aggregateTimeout ?? 20,
      capacity: options.capacity ?? 16384,
      pollIntervalMs: options.pollIntervalMs ?? 5,
      contentHashing: options.contentHashing !== false,
    };

    this.compiler = null;
    this.watcher = null;
    this.metrics = new Metrics();
    this.degraded = false;
    this.degradedReason = null;

    /** @type {Map<string, {safeTime: number, timestamp: number}>} */
    this.fileTimeInfo = new Map();
    /** @type {Map<string, {safeTime: number, timestamp: number}>} */
    this.contextTimeInfo = new Map();
    /** Changes observed while webpack was busy compiling. */
    this.pendingChanges = new Set();
    this.pendingRemovals = new Set();
    /** Whether either pending set hit {@link PENDING_LIMIT} and is now incomplete. */
    this.pendingOverflow = false;
    /** @type {Set<object>} live watch sessions */
    this.sessions = new Set();
    /** @type {Map<string, boolean>} directories handed to the engine */
    this.registered = new Map();
    this._firstSession = true;
  }

  /**
   * @param {import('webpack').Compiler} compiler
   */
  apply(compiler) {
    if (!compiler || !compiler.hooks) {
      this._warn('invalid webpack compiler; plugin disabled');
      return;
    }
    this.compiler = compiler;

    compiler.hooks.watchRun.tapAsync(PLUGIN, (_compiler, callback) => {
      // Never let plugin failure block the build: report and continue.
      try {
        this._ensureWatcher();
      } catch (err) {
        this._degrade(err);
      }
      callback();
    });

    compiler.hooks.watchClose.tap(PLUGIN, () => {
      try {
        this.stop();
      } catch (err) {
        this._warn(`error during shutdown: ${err.message}`);
      }
    });

    if (!this.options.replaceWatcher) return;

    const install = () => {
      const original = compiler.watchFileSystem;
      if (!original || original instanceof RetriggerWatchFileSystem) return;
      compiler.watchFileSystem = new RetriggerWatchFileSystem(original, this);
    };
    install();
    compiler.hooks.afterEnvironment.tap(PLUGIN, install);
  }

  /** @returns {boolean} whether a Retrigger-backed watch can be attempted */
  isUsable() {
    return !this.degraded;
  }

  /**
   * The project root, as webpack resolves module paths against it.
   * @returns {string}
   */
  root() {
    const context = this.compiler && this.compiler.context;
    return path.resolve(typeof context === 'string' && context ? context : process.cwd());
  }

  /** Lazily create and start the shared watcher. */
  _ensureWatcher() {
    if (this.watcher || this.degraded) return this.watcher;
    const watcher = createRetrigger({
      include: this.options.include,
      exclude: this.options.exclude,
      debounceMs: this.options.debounceMs,
      capacity: this.options.capacity,
      pollIntervalMs: this.options.pollIntervalMs,
      engine: this.options.engine,
      contentHashing: this.options.contentHashing,
    });
    watcher.on('error', (err) => {
      this.metrics.recordError();
      this._warn(`watcher error: ${err.message}`);
    });
    watcher.on('all', (event) => this._onEvent(event));
    watcher.on('rescan', () => {
      // The queue overflowed; the safest reaction is a full invalidation.
      for (const session of this.sessions) session.forceAggregate();
    });

    for (const target of this.options.watchPaths) {
      this._register(path.resolve(target), true, watcher);
    }
    watcher.start();
    this.watcher = watcher;
    this.metrics.markStarted();
    if (this.options.verbose) {
      const info = getEngineInfo();
      this._log(`engine=${info.engine} backend=${info.backend} hash=${info.hashAlgorithm}`);
    }
    return watcher;
  }

  /**
   * @param {string} dir
   * @param {boolean} recursive
   */
  _register(dir, recursive, watcher = this.watcher) {
    if (!watcher) return;
    const existing = this.registered.get(dir);
    if (existing === true || (existing === false && !recursive)) return;
    try {
      watcher.add(dir, recursive);
      this.registered.set(dir, recursive);
    } catch (err) {
      // A directory that vanished between resolution and registration is
      // normal during a rebuild; only surface it in verbose mode.
      if (this.options.verbose) this._log(`cannot watch ${dir}: ${err.message}`);
    }
  }

  _onEvent(event) {
    if (event.kind === 'rescanRequired') return;
    this.metrics.recordEvent(event.kind);
    // A write that did not change the bytes is not reported to webpack at all: no timestamp is
    // advanced, no session is notified, and nothing is held over for the next one. Leaving the
    // recorded timestamp where it was is the truthful answer — the contents webpack compiled are
    // still the contents on disk — and webpack re-stats anything it was not told about, so the
    // worst case of being wrong here is a slower answer rather than a stale build.
    if (event.contentChanged === false) {
      this.metrics.recordUnchanged();
      return;
    }
    const target = event.path;
    const time = Date.now();

    if (event.kind === 'deleted') {
      this.fileTimeInfo.delete(target);
      this.contextTimeInfo.delete(target);
    } else {
      const entry = { safeTime: time + 1, timestamp: time };
      this._track(event.isDirectory ? this.contextTimeInfo : this.fileTimeInfo, target, entry);
    }

    // An event a live session already accepted must not also be left pending:
    // the next session would adopt it and webpack would rebuild twice for one
    // edit. Only events nobody was listening for are held over.
    let accepted = false;
    for (const session of this.sessions) {
      if (session.handle(target, event, time)) accepted = true;
    }
    if (accepted) {
      this.pendingChanges.delete(target);
      this.pendingRemovals.delete(target);
      return;
    }

    // Only a WatchSession ever reads the held-over sets, and one exists only when this plugin owns
    // webpack's watchFileSystem. Filling them anyway would grow two sets for the life of the
    // process with nothing that could ever drain them.
    if (!this.options.replaceWatcher) return;

    const [pending, opposite] =
      event.kind === 'deleted'
        ? [this.pendingRemovals, this.pendingChanges]
        : [this.pendingChanges, this.pendingRemovals];
    opposite.delete(target);
    if (pending.size >= PENDING_LIMIT && !pending.has(target)) {
      this.pendingOverflow = true;
      return;
    }
    pending.add(target);
  }

  /**
   * Record `entry` for `target`, evicting the coldest entries past the ceiling.
   *
   * Re-inserting a key that is already present — delete, then set — makes the Map's insertion order
   * an exact least-recently-touched order, so eviction is taking keys off the front of its iterator.
   * That is O(1) per event with no sort and no second copy of the map, which a
   * scan-and-drop-the-oldest strategy would need on every eviction.
   *
   * @param {Map<string, {safeTime: number, timestamp: number}>} map
   * @param {string} target
   * @param {{safeTime: number, timestamp: number}} entry
   */
  _track(map, target, entry) {
    map.delete(target);
    map.set(target, entry);
    for (const key of map.keys()) {
      if (map.size <= TIME_INFO_LIMIT) break;
      map.delete(key);
    }
  }

  /** Stop watching and release everything. Idempotent. */
  stop() {
    for (const session of [...this.sessions]) session.close();
    this.sessions.clear();
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.registered.clear();
    // These describe a watch that is over. webpack is either using its own watcher now (the
    // degraded path) or not watching at all, and re-stats whatever it is not given, so keeping a
    // session's worth of timestamps and held-over paths would be retention with no reader.
    this.fileTimeInfo.clear();
    this.contextTimeInfo.clear();
    this.pendingChanges.clear();
    this.pendingRemovals.clear();
    this.pendingOverflow = false;
    this.metrics.markStopped();
  }

  /**
   * @returns {object|null} measured statistics, or null before the first watch
   */
  getStats() {
    if (!this.watcher) return null;
    return {
      ...this.watcher.getStats(),
      plugin: this.metrics.snapshot(),
      degraded: this.degraded,
      degradedReason: this.degradedReason,
      watchedDirectories: this.registered.size,
    };
  }

  /** Back-compat alias for the name the README used. */
  async getPerformanceStats() {
    return this.getStats();
  }

  _degrade(err) {
    if (this.degraded) return;
    this.degraded = true;
    this.degradedReason = err && err.message ? err.message : String(err);
    this._warn(`falling back to webpack's default watcher (${this.degradedReason})`);
    try {
      this.stop();
    } catch {
      /* already torn down */
    }
  }

  _log(message) {
    console.log(`[retrigger:webpack] ${message}`);
  }

  _warn(message) {
    if (process.env.RETRIGGER_SILENT === '1') return;
    console.warn(`[retrigger:webpack] ${message}`);
  }
}

/**
 * Implements webpack's WatchFileSystem interface on top of the plugin's shared
 * Retrigger instance, delegating wholesale to the original implementation
 * whenever Retrigger cannot serve the request.
 */
class RetriggerWatchFileSystem {
  /**
   * @param {object} original webpack's NodeWatchFileSystem
   * @param {RetriggerWebpackPlugin} plugin
   */
  constructor(original, plugin) {
    this.original = original;
    this.plugin = plugin;
    // webpack reads this property directly in some code paths.
    this.inputFileSystem = original && original.inputFileSystem;
    this.watcherOptions = original && original.watcherOptions;
  }

  watch(files, directories, missing, startTime, options, callback, callbackUndelayed) {
    validate(files, directories, missing, startTime, options, callback, callbackUndelayed);

    if (!this.plugin.isUsable()) return this._delegate(arguments);

    let watcher;
    try {
      watcher = this.plugin._ensureWatcher();
    } catch (err) {
      this.plugin._degrade(err);
      return this._delegate(arguments);
    }
    if (!watcher) return this._delegate(arguments);

    try {
      const session = new WatchSession({
        plugin: this.plugin,
        files: toSet(files),
        directories: toSet(directories),
        missing: toSet(missing),
        startTime,
        options: options || {},
        callback,
        callbackUndelayed,
      });
      this.plugin.sessions.add(session);
      session.begin();
      return session.handleForWebpack();
    } catch (err) {
      this.plugin._degrade(err);
      return this._delegate(arguments);
    }
  }

  _delegate(args) {
    return this.original.watch(...args);
  }
}

/**
 * One webpack watch cycle. webpack calls `watch()` again after every rebuild,
 * so a session fires its callback at most once and is then discarded.
 */
class WatchSession {
  constructor(config) {
    this.plugin = config.plugin;
    this.files = config.files;
    this.directories = config.directories;
    this.missing = config.missing;
    this.startTime = config.startTime;
    this.options = config.options;
    this.callback = config.callback;
    this.callbackUndelayed = config.callbackUndelayed;

    this.changed = new Set();
    this.removed = new Set();
    this.closed = false;
    this.paused = false;
    this.fired = false;
    this.undelayedSent = false;
    this.timer = null;
    this.aggregateTimeout = numberOr(
      this.options.aggregateTimeout,
      this.plugin.options.aggregateTimeout
    );
  }

  begin() {
    this._registerDirectories();
    this._adoptPending();
    if (this.plugin._firstSession) {
      this.plugin._firstSession = false;
      // Only the first cycle can miss edits made before the watcher existed.
      this._scanForStartTimeGap().catch(() => {
        /* best effort; webpack re-stats anything we do not report */
      });
    }
  }

  /**
   * Directory coverage: every context dependency recursively, plus the parent
   * of every file and missing entry non-recursively. This mirrors what
   * Watchpack covers while keeping the descriptor count bounded by webpack's
   * own dependency set.
   *
   * With one exception. `missing` is mostly the trail of Node's resolver, which probes for
   * `package.json` and `node_modules` in every directory from the importer up to the filesystem
   * root — so registering the parent of each one puts a watch on `/`, on the home directory, and
   * on `/tmp`. Those are among the busiest directories on any machine, and watching them means a
   * dev server that nobody is editing still wakes up all day. Every one of them is a strict
   * ancestor of the project root, and none of them can hold a source file, so they are skipped.
   */
  _registerDirectories() {
    for (const dir of this.directories) this.plugin._register(dir, true);
    const parents = new Set();
    for (const file of this.files) parents.add(path.dirname(file));
    for (const file of this.missing) parents.add(path.dirname(file));
    const root = this.plugin.root();
    for (const parent of parents) {
      if (this._coveredByDirectory(parent) || isAboveRoot(parent, root)) continue;
      this.plugin._register(parent, false);
    }
  }

  _coveredByDirectory(target) {
    for (const dir of this.directories) {
      if (target === dir || target.startsWith(dir + path.sep)) return true;
    }
    return false;
  }

  /** Replay anything that changed while webpack was compiling. */
  _adoptPending() {
    let found = false;
    for (const target of this.plugin.pendingChanges) {
      if (!this._isRelevant(target)) continue;
      this.changed.add(target);
      found = true;
    }
    for (const target of this.plugin.pendingRemovals) {
      if (!this._isRelevant(target)) continue;
      this.removed.add(target);
      found = true;
    }
    this.plugin.pendingChanges.clear();
    this.plugin.pendingRemovals.clear();

    // The sets stopped enumerating at their ceiling, so they are known to be missing paths and
    // there is no way to tell which. Naming every file webpack depends on turns an unidentifiable
    // loss into a rebuild: webpack re-stats what it is handed, so an unchanged file costs a stat
    // and a changed one is no longer missed.
    if (this.plugin.pendingOverflow) {
      this.plugin.pendingOverflow = false;
      for (const target of this.files) this.changed.add(target);
      if (this.changed.size > 0) found = true;
    }
    if (found) this._schedule(0);
  }

  /**
   * Stat everything webpack listed and report anything already newer than the
   * compilation's start time. Without this, an edit landing between webpack
   * reading a file and the watcher attaching would be lost until the next one.
   */
  async _scanForStartTimeGap() {
    const targets = [...this.files];
    const limit = 64;
    let index = 0;
    let missed = false;

    const worker = async () => {
      while (index < targets.length) {
        const target = targets[index++];
        try {
          const stat = await fsp.stat(target);
          const timestamp = Math.floor(stat.mtimeMs);
          this.plugin._track(this.plugin.fileTimeInfo, target, {
            safeTime: timestamp + 1,
            timestamp,
          });
          if (typeof this.startTime === 'number' && timestamp > this.startTime) {
            this.changed.add(target);
            missed = true;
          }
        } catch {
          /* removed underneath us; webpack will notice via `missing` */
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(limit, targets.length) }, worker));
    if (missed && !this.closed && !this.fired) this._schedule(0);
  }

  /**
   * @param {string} target
   * @param {object} event
   * @param {number} time
   * @returns {boolean} whether this session took responsibility for the event
   */
  handle(target, event, time) {
    if (this.closed || this.paused || this.fired) return false;
    if (!this._isRelevant(target)) return false;

    if (event.kind === 'deleted') {
      this.removed.add(target);
      this.changed.delete(target);
    } else {
      this.changed.add(target);
      this.removed.delete(target);
    }

    if (!this.undelayedSent && this.callbackUndelayed) {
      this.undelayedSent = true;
      try {
        this.callbackUndelayed(target, time);
      } catch (err) {
        this.plugin._warn(`undelayed callback threw: ${err.message}`);
      }
    }

    this._schedule(this.aggregateTimeout);
    return true;
  }

  /** Used when the event queue overflowed and state must be re-read. */
  forceAggregate() {
    if (this.closed || this.fired) return;
    this._schedule(0);
  }

  /**
   * A directory is watched so that events for the files webpack named inside it are seen; it is
   * not a licence to report everything else that happens there. Treating any sibling of a
   * dependency as relevant made an unrelated write next door — a lockfile, an editor's swap file,
   * a temp file — indistinguishable from an edit, and rebuilt the project for it.
   *
   * A newly created file still gets through the two ways it can matter: as a `missing` entry, when
   * something already imports the path and the resolver came up empty, and as a member of a
   * context dependency, which is watched recursively.
   */
  _isRelevant(target) {
    if (this.files.has(target) || this.missing.has(target)) return true;
    for (const dir of this.directories) {
      if (target === dir || target.startsWith(dir + path.sep)) return true;
    }
    return false;
  }

  _schedule(delay) {
    if (this.closed || this.fired) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this._fire(), Math.max(0, delay));
  }

  _fire() {
    this.timer = null;
    if (this.closed || this.fired) return;
    if (this.changed.size === 0 && this.removed.size === 0) return;
    this.fired = true;

    const changed = this.changed;
    const removed = this.removed;
    this.changed = new Set();
    this.removed = new Set();

    // webpack's own NodeWatchFileSystem purges its input cache here; skipping
    // it would serve stale file contents to the next compilation.
    const fs = this.plugin.compiler && this.plugin.compiler.inputFileSystem;
    if (fs && typeof fs.purge === 'function') {
      for (const item of changed) fs.purge(item);
      for (const item of removed) fs.purge(item);
    }

    const started = Date.now();
    try {
      this.callback(null, this.plugin.fileTimeInfo, this.plugin.contextTimeInfo, changed, removed);
      this.plugin.metrics.recordTrigger(Date.now() - started);
    } catch (err) {
      // webpack owns this callback; if it throws, the build is already in
      // trouble and re-throwing here would only lose the reason.
      this.plugin._warn(`webpack watch callback threw: ${err.message}`);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.plugin.sessions.delete(this);
  }

  pause() {
    this.paused = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** @returns {object} the object webpack expects back from `watch()` */
  handleForWebpack() {
    return {
      close: () => this.close(),
      pause: () => this.pause(),
      getAggregatedChanges: () => this.changed,
      getAggregatedRemovals: () => this.removed,
      getFileTimeInfoEntries: () => this.plugin.fileTimeInfo,
      getContextTimeInfoEntries: () => this.plugin.contextTimeInfo,
      getInfo: () => ({
        changes: this.changed,
        removals: this.removed,
        fileTimeInfoEntries: this.plugin.fileTimeInfo,
        contextTimeInfoEntries: this.plugin.contextTimeInfo,
      }),
    };
  }
}

/** Mirrors webpack's own argument validation so misuse fails the same way. */
function validate(files, directories, missing, startTime, options, callback, callbackUndelayed) {
  if (!files || typeof files[Symbol.iterator] !== 'function') {
    throw new Error("Invalid arguments: 'files'");
  }
  if (!directories || typeof directories[Symbol.iterator] !== 'function') {
    throw new Error("Invalid arguments: 'directories'");
  }
  if (!missing || typeof missing[Symbol.iterator] !== 'function') {
    throw new Error("Invalid arguments: 'missing'");
  }
  if (typeof callback !== 'function') {
    throw new Error("Invalid arguments: 'callback'");
  }
  if (typeof startTime !== 'number' && startTime) {
    throw new Error("Invalid arguments: 'startTime'");
  }
  if (typeof options !== 'object') {
    throw new Error("Invalid arguments: 'options'");
  }
  if (typeof callbackUndelayed !== 'function' && callbackUndelayed) {
    throw new Error("Invalid arguments: 'callbackUndelayed'");
  }
}

/**
 * @param {string} dir
 * @param {string} root
 * @returns {boolean} whether `dir` strictly contains `root`
 */
function isAboveRoot(dir, root) {
  return Boolean(root) && dir !== root && root.startsWith(dir + path.sep);
}

function toSet(iterable) {
  const set = new Set();
  for (const item of iterable) set.add(path.resolve(item));
  return set;
}

function numberOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

module.exports = RetriggerWebpackPlugin;
module.exports.RetriggerWebpackPlugin = RetriggerWebpackPlugin;
module.exports.RetriggerWatchFileSystem = RetriggerWatchFileSystem;
module.exports.DEFAULT_EXCLUDE = DEFAULT_EXCLUDE;
