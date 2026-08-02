'use strict';

/**
 * Retrigger Vite plugin (Vite 5 and 6).
 *
 * Design: Retrigger is an additional, faster *event source* for Vite's own HMR
 * pipeline. Detected changes are replayed onto `server.watcher` — the exact
 * emitter Vite subscribes to in `createServer` — so module-graph invalidation,
 * `handleHotUpdate` / `hotUpdate` plugin hooks, CSS vs JS update selection and
 * full-reload decisions all stay with Vite. The plugin never hand-rolls an
 * HMR payload when Vite can do it correctly.
 *
 * Vite's own chokidar watcher is deliberately left running. Whichever watcher
 * observes the write first wins the race; the other one is a no-op or a
 * redundant (idempotent) update. That redundancy is the price of never being
 * the reason a dev server stops reloading.
 *
 * Teardown uses `buildEnd` + `closeBundle` (Vite calls both on server close)
 * plus an `httpServer` close listener. The Rollup `closeWatcher` hook that the
 * previous implementation used is not called by Vite's dev server.
 */

const path = require('path');

const { Metrics } = require('../lib/metrics');
const { createRetrigger } = require('../lib/retrigger');
const { getEngineInfo } = require('../lib/engine');

const DEFAULT_EXCLUDE = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/.vite/**'];

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
 *   contentHashing?: boolean}} [options]
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
  };

  /** @type {import('vite').ViteDevServer|null} */
  let server = null;
  let watcher = null;
  let closeListener = null;
  const metrics = new Metrics();
  let degraded = false;

  function log(message) {
    if (config.verbose) console.log(`[retrigger:vite] ${message}`);
  }

  function warn(message) {
    if (process.env.RETRIGGER_SILENT === '1') return;
    console.warn(`[retrigger:vite] ${message}`);
  }

  function degrade(err) {
    if (degraded) return;
    degraded = true;
    warn(`falling back to Vite's own watcher (${err && err.message ? err.message : err})`);
    teardown();
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
      viteWatcher.emit(viteEvent, file);
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

  function start() {
    if (watcher || degraded || !server) return;
    try {
      const instance = createRetrigger({
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
      });
      instance.on('all', (event) => {
        if (event.kind === 'rescanRequired') {
          metrics.recordEvent(event.kind);
          const hot = server && (server.hot || server.ws);
          if (hot && typeof hot.send === 'function') hot.send({ type: 'full-reload', path: '*' });
          return;
        }
        if (event.isDirectory) return;
        metrics.recordEvent(event.kind);
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

      for (const root of watchRoots()) instance.add(root, true);
      instance.start();
      watcher = instance;
      metrics.markStarted();

      const info = engineReport();
      log(`engine=${info.engine} backend=${info.backend} hash=${info.hashAlgorithm}`);
    } catch (err) {
      degrade(err);
    }
  }

  function teardown() {
    if (watcher) {
      try {
        watcher.close();
      } catch {
        /* already closed */
      }
      watcher = null;
    }
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
      roots: watchRoots(),
      watcher: watcher ? watcher.getStats() : null,
      metrics: metrics.snapshot(),
    };
  }

  return {
    name: 'retrigger',
    // Dev-server only: there is nothing to watch during a production build.
    apply: 'serve',

    configureServer(devServer) {
      server = devServer;
      degraded = false;

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
    },
  };
}

module.exports = { DEFAULT_EXCLUDE, createRetriggerVitePlugin, normalizePath };
module.exports.default = createRetriggerVitePlugin;
