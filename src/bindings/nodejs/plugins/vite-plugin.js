'use strict';

/**
 * Retrigger Vite plugin (Vite 5, 6, and 7 — see `vitest.config.mjs` and the `vite7` project in
 * this package's config for why the default suite still runs against 6).
 *
 * DESIGN (rewritten; see git history for the superseded `server.watcher.emit` wrap): Retrigger is
 * the SOLE file-system event source for Vite's dev server, not a second one racing chokidar. The
 * `config()` hook below sets `server.watch = null` on the config object every `config()` hook
 * receives (mutated in place, not returned: Vite's `mergeConfig` skips any override that is
 * `== null`, so `return { server: { watch: null } }` would be silently dropped), which Vite
 * documents as disabling its own chokidar watcher. `server.watcher` then becomes Vite's own
 * `NoopWatcher` — still a real `EventEmitter`, whose `.add()`/`.unwatch()` just do nothing.
 * `configureServer` injects
 * Retrigger-detected changes onto that *same* emitter with plain `.emit('add'|'change'|'unlink',
 * file)` calls: ordinary EventEmitter usage, not a method override. `server.watcher` therefore
 * keeps its identity and its own prototype for the life of the server, and every other plugin's
 * `server.watcher.on(...)` — registered before or after this one runs — keeps working exactly as
 * it would against a real chokidar instance. Vite's module-graph invalidation, `handleHotUpdate` /
 * `hotUpdate` hooks and reload-vs-patch decisions all stay Vite's, unchanged, because they read
 * `server.watcher`'s events, not this plugin's opinion of them.
 *
 * Content hashing is the only gate an event passes through, and it is applied once, by Retrigger's
 * own pipeline before `dispatch()` ever runs (see `start()` below) — there is no second watcher
 * left whose events would need re-gating, which is what made the old design's `.emit` override
 * necessary in the first place.
 *
 * FAIL-OPEN: disabling Vite's own watcher trades away the safety net the previous design leaned
 * on, so this one rebuilds an equivalent one on demand. If the Retrigger engine cannot start, or
 * degrades mid-session (repeated engine errors, or `api.degrade()` called directly — an operator's
 * own health check, or a test proving this works), a minimal, dependency-free watcher built on
 * Node's own `fs.watch` is constructed over the same roots and its raw events are relayed onto
 * `server.watcher` the same way Retrigger's own are. HMR keeps working; the losses are the
 * content-hash suppression this package exists to provide, and the `add`/`unlink` distinction
 * (the fallback reports every touched path that still exists as `change`, which is enough for
 * Vite's module graph to invalidate a file it already knows and costs nothing for one it does
 * not). `vite`'s own `.d.ts` declares a public `FSWatcher` class, which would have been the
 * obvious choice here, but it is not actually re-exported as a value from the package's runtime
 * entry point in either 6.4.3 or 7.x — `require('vite').FSWatcher` and the dynamic-import
 * equivalent are both `undefined` — so it cannot be constructed from outside Vite itself.
 * `chokidar` is deliberately not used either: it is a devDependency of this package for tests
 * only, and pulling it into this file would make it a runtime dependency, which
 * `test/api-contract.test.mjs` holds this package to having none of.
 *
 * ESCAPE HATCH: `legacyWatcher: true` restores the pre-rewrite design instead — Vite's own
 * chokidar is left running (no `server.watch: null`), and this plugin gates its `.emit` so a
 * byte-identical write chokidar itself observed does not also reach the module graph. It exists
 * for a plugin-ordering or composability edge this rewrite has not hit: `enforce: 'pre'` makes
 * this plugin's `config()` hook run first, but a later plugin's own `config()` hook returning a
 * non-null `server.watch` would still win the merge and leave Vite's chokidar running unnoticed by
 * this plugin. `legacyWatcher` sidesteps that by never depending on `server.watch` at all. Its
 * cost is exactly what motivated the rewrite: two live watchers, and one method on an object this
 * plugin does not own overridden for as long as it is installed.
 *
 * Teardown uses `buildEnd` + `closeBundle` (Vite calls both on server close) plus an `httpServer`
 * close listener. The Rollup `closeWatcher` hook the previous implementation used is not called by
 * Vite's dev server.
 */

const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

const { Metrics } = require('../lib/metrics');
const { createRetrigger } = require('../lib/retrigger');
const { getEngineInfo } = require('../lib/engine');

const DEFAULT_EXCLUDE = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/.vite/**'];

/**
 * `legacyWatcher` only: emitter events the content gate applies to. A removal always counts as a
 * change, and every other event on this emitter belongs to Vite rather than to the file system.
 */
const GATED_EVENTS = new Set(['add', 'change']);

/** Consecutive engine errors, with no successful event between them, that count as degradation. */
const ERROR_STREAK_LIMIT = 5;

/**
 * The last-resort watcher engaged only once Retrigger itself cannot be trusted. Deliberately
 * minimal and dependency-free — see the FAIL-OPEN section of the module doc comment above for why
 * neither `vite`'s own `FSWatcher` nor `chokidar` are usable here.
 *
 * `fs.watch(dir, { recursive: true })` is natively supported on macOS and Windows, and by Node
 * itself on Linux since v20.13; where a root does not support it, or has vanished, that one root
 * is silently left uncovered rather than throwing — this watcher's whole purpose is to never be
 * the reason a dev server hook throws.
 */
class FailOpenWatcher extends EventEmitter {
  constructor(roots) {
    super();
    /** @type {import('fs').FSWatcher[]} */
    this._handles = [];
    for (const root of roots) this._attach(root);
  }

  _attach(root) {
    try {
      const handle = fs.watch(root, { persistent: false, recursive: true }, (_type, filename) => {
        if (filename) this._report(path.join(root, filename.toString()));
      });
      handle.on('error', () => {
        /* one root's handle failing must not take the others down */
      });
      this._handles.push(handle);
    } catch {
      /* recursive fs.watch unsupported here, or the root disappeared before this could attach */
    }
  }

  /** Neither a size nor a rename direction is available from a raw `fs.watch` event, so a path
   * that still exists is reported as `change` (harmless for one Vite does not know about, and
   * enough to invalidate one it does) and a path that does not is reported as `unlink`. */
  _report(target) {
    fs.stat(target, (err, stat) => {
      if (err) {
        this.emit('unlink', target);
      } else if (!stat.isDirectory()) {
        this.emit('change', target);
      }
    });
  }

  add(roots) {
    for (const root of roots) this._attach(root);
    return this;
  }

  async close() {
    for (const handle of this._handles) {
      try {
        handle.close();
      } catch {
        /* already closed */
      }
    }
    this._handles = [];
  }
}

/**
 * Vite normalises every module-graph key with `path.posix.normalize` over a
 * forward-slashed absolute path. Reimplemented here so the plugin has no
 * runtime dependency on Vite itself.
 * @param {string} target
 * @returns {string}
 */
function normalizePath(target) {
  return path.posix.normalize(target.replace(/\\/g, '/'));
}

/**
 * @param {{watchPaths?: string[], include?: string[], exclude?: string[],
 *   verbose?: boolean, debounceMs?: number, engine?: 'auto'|'native'|'javascript',
 *   capacity?: number, pollIntervalMs?: number, stats?: boolean,
 *   contentHashing?: boolean, legacyWatcher?: boolean}} [options]
 * @returns {import('vite').Plugin}
 */
function createRetriggerVitePlugin(options = {}) {
  const legacy = options.watchOptions || {};
  const config = {
    watchPaths: options.watchPaths || [],
    include: options.include || legacy.include_patterns || [],
    exclude: options.exclude || legacy.exclude_patterns || DEFAULT_EXCLUDE,
    verbose: options.verbose === true,
    debounceMs: options.debounceMs ?? 0,
    engine: options.engine || 'auto',
    capacity: options.capacity ?? 8192,
    pollIntervalMs: options.pollIntervalMs ?? 5,
    stats: options.stats !== false,
    contentHashing: options.contentHashing !== false,
    // Escape hatch documented in the header comment above: restores the pre-rewrite design.
    legacyWatcher: options.legacyWatcher === true,
  };

  /** @type {import('vite').ViteDevServer|null} */
  let server = null;
  let watcher = null;
  /** Real `FSWatcher`, engaged only via {@link startFallback} while degraded and not legacy. */
  let fallback = null;
  let closeListener = null;
  const metrics = new Metrics();
  let degraded = false;
  /** Undoes the `legacyWatcher` `server.watcher.emit` gate, or null when none is installed. */
  let removeGate = null;
  /** True while this plugin is replaying its own event, which must not be re-gated. */
  let replaying = false;
  /** @type {string[]} resolved roots, cached: the gate and the fallback both consult them. */
  let activeRoots = [];
  /** Consecutive engine errors since the last successful event; drives fail-open mid-session. */
  let errorStreak = 0;

  function log(message) {
    if (config.verbose) console.log(`[retrigger:vite] ${message}`);
  }

  function warn(message) {
    if (process.env.RETRIGGER_SILENT === '1') return;
    console.warn(`[retrigger:vite] ${message}`);
  }

  function watchRoots() {
    const roots = new Set(config.watchPaths.map((p) => path.resolve(p)));
    if (roots.size === 0 && server) roots.add(path.resolve(server.config.root));
    if (roots.size === 0) roots.add(process.cwd());
    return [...roots];
  }

  /**
   * Replay a Retrigger event onto Vite. Returns the channel actually used so
   * tests can assert the real path rather than a mock.
   * @returns {'watcher'|'fallback'|'skipped'}
   */
  function dispatch(event) {
    if (!server) return 'skipped';
    const file = normalizePath(event.path);
    const started = Date.now();

    const viteWatcher = server.watcher;
    if (viteWatcher && typeof viteWatcher.emit === 'function') {
      const viteEvent =
        event.kind === 'created' ? 'add' : event.kind === 'deleted' ? 'unlink' : 'change';
      // This event already carries the tracker's verdict; putting it back through the legacy gate
      // would only ask the same question of a digest we just recorded, and answer "unchanged".
      replaying = true;
      try {
        viteWatcher.emit(viteEvent, file);
      } finally {
        replaying = false;
      }
      metrics.recordTrigger(Date.now() - started);
      log(`${viteEvent} -> ${file}`);
      return 'watcher';
    }

    // No usable watcher emitter: invalidate directly and ask for a reload.
    const hot = server.hot || server.ws;
    const modules = server.moduleGraph && server.moduleGraph.getModulesByFile(file);
    if (modules && modules.size > 0) {
      for (const mod of modules) server.moduleGraph.invalidateModule(mod);
    }
    if (hot && typeof hot.send === 'function') hot.send({ type: 'full-reload', path: '*' });
    metrics.recordTrigger(Date.now() - started);
    return 'fallback';
  }

  // ----------------------------------------------------------- legacyWatcher

  /** @returns {boolean} whether `target` lies inside a root Retrigger was given */
  function withinRoots(target) {
    for (const root of activeRoots) {
      if (target === root || target.startsWith(root + path.sep)) return true;
    }
    return false;
  }

  /**
   * The gate. Answers whether an event chokidar raised should reach Vite. Only reachable with
   * `legacyWatcher: true`; the default design never leaves a second watcher running to gate.
   * @returns {boolean}
   */
  function forwards(viteEvent, file) {
    if (!watcher || !watcher.isRunning) return true;
    const target = path.resolve(file);
    if (!withinRoots(target)) return true;
    try {
      return watcher.hasContentChanged(target, viteEvent === 'add' ? 'created' : 'modified');
    } catch {
      // Never be the reason an update is lost.
      return true;
    }
  }

  function installLegacyGate() {
    const emitter = server && server.watcher;
    if (removeGate || !config.legacyWatcher || !config.contentHashing) return;
    if (!emitter || typeof emitter.emit !== 'function') return;

    const original = emitter.emit;
    const gated = function (viteEvent, ...args) {
      if (replaying || !GATED_EVENTS.has(viteEvent) || typeof args[0] !== 'string') {
        return original.call(this, viteEvent, ...args);
      }
      if (!forwards(viteEvent, args[0])) {
        metrics.recordUnchanged();
        log(`unchanged (vite) -> ${args[0]}`);
        return false;
      }
      return original.call(this, viteEvent, ...args);
    };

    emitter.emit = gated;
    removeGate = () => {
      // Only unwind our own layer: another plugin may have wrapped it since.
      if (emitter.emit === gated) emitter.emit = original;
      removeGate = null;
    };
  }

  // ---------------------------------------------------------------- fail-open

  /**
   * Engage a real, chokidar-backed watcher and relay its events onto `server.watcher`, the same
   * way Retrigger's own events are relayed. A no-op with `legacyWatcher: true`, which never
   * disabled Vite's own watcher and so already has a live one.
   */
  function startFallback() {
    if (fallback || config.legacyWatcher || !server) return;
    try {
      const instance = new FailOpenWatcher(activeRoots.length > 0 ? activeRoots : watchRoots());
      const relay = (viteEvent) => (file) => {
        const emitter = server && server.watcher;
        if (emitter) emitter.emit(viteEvent, normalizePath(file));
      };
      instance.on('change', relay('change'));
      instance.on('unlink', relay('unlink'));
      fallback = instance;
      log('fail-open: a real watcher now feeds server.watcher because Retrigger cannot');
    } catch (err) {
      warn(`no fail-open watcher available: ${err.message}`);
    }
  }

  function stopFallback() {
    if (!fallback) return;
    const closing = fallback;
    fallback = null;
    Promise.resolve()
      .then(() => closing.close())
      .catch(() => {
        /* best effort */
      });
  }

  /**
   * Stop trusting the current Retrigger engine and switch to the fail-open path. Idempotent, and
   * safe to call directly (exposed as `api.degrade`) — an operator forcing the safety net, or a
   * test proving it exists — as well as from the engine's own error stream.
   */
  function degrade(err) {
    if (degraded) return;
    degraded = true;
    warn(`falling back to a real watcher (${err && err.message ? err.message : err})`);
    teardownEngine();
    startFallback();
  }

  function start() {
    if (watcher || degraded || !server) return;
    let instance = null;
    try {
      instance = createRetrigger({
        include: config.include,
        exclude: config.exclude,
        debounceMs: config.debounceMs,
        capacity: config.capacity,
        pollIntervalMs: config.pollIntervalMs,
        engine: config.engine,
        contentHashing: config.contentHashing,
      });
      instance.on('error', (err) => {
        metrics.recordError();
        warn(`watcher error: ${err.message}`);
        errorStreak += 1;
        if (errorStreak >= ERROR_STREAK_LIMIT) degrade(err);
      });
      instance.on('all', (event) => {
        errorStreak = 0;
        if (event.kind === 'rescanRequired') {
          metrics.recordEvent(event.kind);
          const hot = server && (server.hot || server.ws);
          if (hot && typeof hot.send === 'function') hot.send({ type: 'full-reload', path: '*' });
          return;
        }
        metrics.recordEvent(event.kind);
        // Vite's watcher is told about files; a directory event is one this plugin declined to
        // pass on, which is not the same as one it never saw.
        if (event.isDirectory) {
          metrics.recordFiltered();
          return;
        }
        // The file was written with the bytes it already had — a formatter on save, a generator
        // that reran, a branch switch that restored what was there. Vite is not told, so the
        // module graph is not invalidated and the browser is not reloaded.
        if (event.contentChanged === false) {
          metrics.recordUnchanged();
          log(`unchanged -> ${event.path}`);
          return;
        }
        try {
          dispatch(event);
        } catch (err) {
          metrics.recordError();
          warn(`failed to dispatch ${event.path}: ${err.message}`);
        }
      });

      // One unwatchable root — a typo, a package nobody checked out, a directory removed since the
      // config was written — must not cost the other roots their watcher. The webpack plugin
      // already skips and carries on per directory; only having nothing left to watch is fatal.
      activeRoots = [];
      for (const root of watchRoots()) {
        try {
          instance.add(root, true);
          activeRoots.push(root);
        } catch (err) {
          warn(`not watching ${root}: ${err.message}`);
        }
      }
      if (activeRoots.length === 0)
        throw new Error('none of the configured paths could be watched');
      instance.start();
      watcher = instance;
      metrics.markStarted();
      installLegacyGate();

      const info = engineReport();
      log(`engine=${info.engine} backend=${info.backend} hash=${info.hashAlgorithm}`);
    } catch (err) {
      // The instance may hold an engine handle even though it never started.
      if (instance && instance !== watcher) {
        try {
          instance.close();
        } catch {
          /* nothing started, nothing to release */
        }
      }
      degrade(err);
    }
  }

  /** Stop the Retrigger engine only; leaves a fail-open fallback (if any) running. */
  function teardownEngine() {
    if (removeGate) removeGate();
    if (watcher) {
      try {
        watcher.close();
      } catch {
        /* already closed */
      }
      watcher = null;
    }
  }

  function teardown() {
    teardownEngine();
    stopFallback();
    if (server && closeListener && server.httpServer) {
      server.httpServer.removeListener('close', closeListener);
    }
    closeListener = null;
    metrics.markStopped();
  }

  /**
   * `getEngineInfo()` describes the process default. Once a watcher exists it
   * is the authority: `engine: 'javascript'` in the plugin options must not be
   * reported as `native` merely because a native addon is installed.
   */
  function engineReport() {
    const info = getEngineInfo();
    if (!watcher) return info;
    return {
      ...info,
      engine: watcher.engine.name,
      backend: watcher.getStats().backend,
      reason: watcher.engine.reason,
      hashAlgorithm: watcher.engine.hashAlgorithm,
      simd: watcher.getSimdLevel(),
    };
  }

  function snapshot() {
    return {
      plugin: 'retrigger-vite',
      engine: engineReport(),
      watching: Boolean(watcher),
      degraded,
      fallback: Boolean(fallback),
      // What is being watched, which is not always what was asked for: a root that could not be
      // watched is reported by its absence rather than as though it had been.
      roots: watcher ? activeRoots : watchRoots(),
      watcher: watcher ? watcher.getStats() : null,
      metrics: metrics.snapshot(),
    };
  }

  return {
    name: 'retrigger',
    // Dev-server only: there is nothing to watch during a production build.
    apply: 'serve',
    // Runs this plugin's `config()` hook before other plugins', so `server.watch: null` is the
    // baseline a later plugin's own config would have to deliberately override. See the
    // `legacyWatcher` doc above for the residual case where one does.
    enforce: 'pre',

    config(conf) {
      if (config.legacyWatcher || !conf) return;
      // Returning `{ server: { watch: null } }` here would not stick: `runConfigHook` folds a
      // `config()` hook's return value in with `mergeConfig`, and `mergeConfigRecursively` skips
      // any override that is `== null` outright, so an explicit `null` is indistinguishable from
      // "did not set this" and silently dropped. Mutating the config object every `config()` hook
      // receives is what actually reaches `resolveConfig` — and it is nothing the merge can undo,
      // since it is not going through the merge at all.
      conf.server = conf.server && typeof conf.server === 'object' ? conf.server : {};
      conf.server.watch = null;
    },

    configureServer(devServer) {
      server = devServer;
      degraded = false;
      errorStreak = 0;

      if (config.stats) {
        devServer.middlewares.use('/__retrigger_stats', (req, res, next) => {
          if (req.method !== 'GET') return next();
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(snapshot(), null, 2));
        });
      }

      closeListener = () => teardown();
      if (devServer.httpServer) devServer.httpServer.once('close', closeListener);

      // Post hook: runs after Vite's internal middlewares are installed.
      return () => start();
    },

    buildStart() {
      // Middleware-mode servers never call the configureServer post hook.
      if (server) start();
    },

    buildEnd() {
      teardown();
    },

    closeBundle() {
      teardown();
    },

    // Exposed for tests and for programmatic access from user code.
    api: {
      getStats: snapshot,
      isWatching: () => Boolean(watcher),
      dispatch: (event) => dispatch(event),
      /**
       * Force fail-open: stop trusting the Retrigger engine and switch to a real watcher, exactly
       * as a repeated engine error would. Idempotent.
       * @param {Error|string} [reason]
       */
      degrade: (reason) => degrade(reason instanceof Error ? reason : new Error(String(reason))),
    },
  };
}

module.exports = { DEFAULT_EXCLUDE, createRetriggerVitePlugin, normalizePath };
module.exports.default = createRetriggerVitePlugin;
