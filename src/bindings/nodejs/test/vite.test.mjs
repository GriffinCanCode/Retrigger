import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const {
  tempDir,
  cleanupTempDirs,
  waitFor,
  waitForQuiet,
  writeFile,
  sleep,
} = require('./helpers/tmp.js');
const { createRetriggerVitePlugin, normalizePath } = require('../plugins/vite-plugin.js');

/** A real (tiny) Vite project on disk. */
function fixture() {
  // Resolved to its real form before Vite sees it as a root. On Windows os.tmpdir() hands back
  // the 8.3 short path (C:\Users\RUNNER~1\...) while the files Vite goes on to resolve carry the
  // long one, so the server judges its own root to be outside the allowed filesystem roots and
  // answers 403. Elsewhere this only settles symlinks such as macOS's /var -> /private/var,
  // which is the form the watcher reports anyway.
  const dir = fs.realpathSync.native(tempDir('retrigger-vite-'));
  writeFile(
    path.join(dir, 'index.html'),
    '<html><body><script type="module" src="/main.js"></script></body></html>\n'
  );
  writeFile(path.join(dir, 'main.js'), "import { n } from './mod.js';\nconsole.log(n);\n");
  writeFile(path.join(dir, 'mod.js'), 'export const n = 1;\n');
  return { dir, main: path.join(dir, 'main.js'), mod: path.join(dir, 'mod.js') };
}

/**
 * Start a real dev server on an ephemeral port (port 0 lets the OS pick, so
 * concurrent runs cannot collide).
 */
async function startServer(dir, plugins, extra = {}) {
  const server = await createServer({
    root: dir,
    configFile: false,
    logLevel: 'silent',
    server: { port: 0, host: '127.0.0.1', hmr: { port: 0 }, ...extra },
    plugins,
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  await server.listen();
  return server;
}

const live = new Set();

afterEach(async () => {
  for (const server of [...live]) {
    live.delete(server);
    try {
      await server.close();
    } catch {
      /* already closed */
    }
  }
});

afterAll(() => cleanupTempDirs());

describe('vite plugin', () => {
  it('exposes the shape Vite expects from a plugin object', () => {
    const plugin = createRetriggerVitePlugin();
    expect(plugin.name).toBe('retrigger');
    expect(plugin.apply).toBe('serve');
    for (const hook of ['configureServer', 'buildStart', 'buildEnd', 'closeBundle']) {
      expect(typeof plugin[hook]).toBe('function');
    }
    expect(typeof plugin.api.getStats).toBe('function');
    expect(typeof plugin.api.isWatching).toBe('function');
  });

  it('normalises paths the way Vite keys its module graph', () => {
    expect(normalizePath('/a/b/../c/d.js')).toBe('/a/c/d.js');
    expect(normalizePath('C:\\proj\\src\\a.js')).toBe('C:/proj/src/a.js');
  });

  it('starts watching once the dev server is listening', async () => {
    const project = fixture();
    const plugin = createRetriggerVitePlugin({ engine: 'javascript', debounceMs: 0 });
    const server = await startServer(project.dir, [plugin]);
    live.add(server);

    await waitFor(() => plugin.api.isWatching(), { message: 'watcher started' });
    const stats = plugin.api.getStats();
    expect(stats.watching).toBe(true);
    expect(stats.degraded).toBe(false);
    expect(stats.roots).toContain(project.dir);
    expect(stats.watcher.backend).toBe('polling');
    expect(server.httpServer.address().port).toBeGreaterThan(0);
  });

  it('replays a file change onto the watcher Vite subscribes to', async () => {
    const project = fixture();
    const plugin = createRetriggerVitePlugin({ engine: 'javascript', debounceMs: 0 });
    const server = await startServer(project.dir, [plugin]);
    live.add(server);
    await waitFor(() => plugin.api.isWatching(), { message: 'watcher started' });

    /** @type {string[]} */
    const changes = [];
    server.watcher.on('change', (file) => changes.push(file));

    // Load the module first so it is actually in the graph.
    await server.transformRequest('/mod.js');

    writeFile(project.mod, 'export const n = 2;\n');
    await waitFor(() => changes.includes(normalizePath(project.mod)), {
      timeout: 10000,
      message: 'change replayed onto server.watcher',
    });

    const stats = plugin.api.getStats();
    expect(stats.metrics.triggers).toBeGreaterThan(0);
  });

  it('drives Vite\u2019s HMR pipeline, producing a real update payload', async () => {
    const project = fixture();
    const plugin = createRetriggerVitePlugin({ engine: 'javascript', debounceMs: 0 });
    /** @type {string[]} */
    const hotUpdates = [];
    const spy = {
      name: 'spy',
      handleHotUpdate(ctx) {
        hotUpdates.push(ctx.file);
      },
    };
    const server = await startServer(project.dir, [plugin, spy]);
    live.add(server);
    await waitFor(() => plugin.api.isWatching(), { message: 'watcher started' });

    // Prime the module graph; without a known importer Vite has nothing to
    // invalidate and correctly stays silent.
    await server.transformRequest('/main.js');
    await server.transformRequest('/mod.js');

    const sent = spyOnHotChannels(server);
    writeFile(project.mod, 'export const n = 3;\n');

    // The plugin's job is to make Vite run its own HMR pipeline; the proof is
    // that Vite's hook fired for the file Retrigger reported.
    await waitFor(() => hotUpdates.includes(normalizePath(project.mod)), {
      timeout: 10000,
      message: 'Vite handleHotUpdate ran for the changed file',
    });
    // Nothing in this fixture accepts HMR, so Vite's correct answer is a
    // reload rather than a patch; either is a genuine HMR payload.
    await waitFor(() => sent.some((m) => m && (m.type === 'update' || m.type === 'full-reload')), {
      timeout: 10000,
      message: 'hmr payload produced by Vite',
    });
  });

  it('does not trigger HMR for a file rewritten with identical bytes', async () => {
    const project = fixture();
    const plugin = createRetriggerVitePlugin({ engine: 'javascript', debounceMs: 0 });
    const server = await startServer(project.dir, [plugin]);
    live.add(server);
    await waitFor(() => plugin.api.isWatching(), { message: 'watcher started' });
    await server.transformRequest('/mod.js');

    const hashed = () => plugin.api.getStats().watcher.content.filesHashed;
    const contents = 'export const n = 7;\n';
    writeFile(project.mod, contents);
    await waitFor(() => plugin.api.getStats().metrics.triggers > 0, {
      timeout: 10000,
      message: 'the real edit reached Vite',
    });
    // Let the real edit finish being observed before writing again. Two writes inside one
    // observation window are legitimately reported as one event, and the second one would then
    // never be classified at all — which is a property of this test's timing, not of the plugin.
    await waitForQuiet(hashed, { quietMs: 300, timeout: 3000 });

    // Vite's own chokidar does not run at all (`server.watch: null`): Retrigger is the only
    // possible source of an event on `server.watcher`, so this is also proof that nothing else
    // is quietly feeding it.
    const emitted = [];
    for (const name of ['add', 'change', 'unlink']) {
      server.watcher.on(name, (file) => emitted.push(`${name} ${file}`));
    }
    const before = plugin.api.getStats().metrics.triggers;
    const hashesBefore = hashed();

    writeFile(project.mod, contents);

    // The write was observed by somebody — otherwise the assertions below hold vacuously.
    await waitFor(() => hashed() > hashesBefore, {
      timeout: 10000,
      message: 'the no-op write was observed',
    });
    const after = await waitForQuiet(() => plugin.api.getStats().metrics.triggers, {
      quietMs: 300,
      timeout: 3000,
    });
    expect(after, 'a rewrite with identical bytes must not reach Vite').toBe(before);
    expect(emitted, 'no watcher event may escape to Vite for a no-op write').toEqual([]);
    expect(plugin.api.getStats().metrics.eventsUnchanged).toBeGreaterThan(0);
  });

  it('reports one edit once, however many watchers observed it', async () => {
    const project = fixture();
    const plugin = createRetriggerVitePlugin({ engine: 'javascript', debounceMs: 0 });
    const server = await startServer(project.dir, [plugin]);
    live.add(server);
    await waitFor(() => plugin.api.isWatching(), { message: 'watcher started' });
    await server.transformRequest('/mod.js');

    const hashed = () => plugin.api.getStats().watcher.content.filesHashed;
    // Historically two watchers saw this write — Retrigger's and Vite's own chokidar — and both
    // reached the module graph, so every save cost two invalidations and two HMR payloads. Vite's
    // own chokidar no longer runs, but the guarantee this pins down (one write, one invalidation)
    // still matters on its own terms.
    const edited = normalizePath(project.mod);
    const emitted = [];
    server.watcher.on('change', (file) => emitted.push(file));
    writeFile(project.mod, 'export const n = 11;\n');

    await waitFor(() => emitted.includes(edited), {
      timeout: 10000,
      message: 'the edit reached Vite',
    });
    await waitForQuiet(hashed, { quietMs: 400, timeout: 5000 });
    // Counted for the edited path rather than asserted over the whole stream. What is being pinned
    // down is that one write is reported once; whether some *other* path is mentioned is a question
    // about the operating system's attribution, which the fallback engine takes on trust and which
    // this plugin answers separately by hashing.
    const times = emitted.filter((file) => file === edited).length;
    expect(times, 'one write, one invalidation').toBe(1);
  });

  it('keeps watching the roots that exist when one of them does not', async () => {
    // A typo, or a package nobody checked out. Losing every root over one of them means the whole
    // feature silently turns itself off for a mistake the message already explains.
    const project = fixture();
    const plugin = createRetriggerVitePlugin({
      engine: 'javascript',
      watchPaths: [project.dir, path.join(project.dir, 'no-such-directory')],
    });
    const server = await startServer(project.dir, [plugin]);
    live.add(server);

    await waitFor(() => plugin.api.isWatching(), { message: 'watcher started despite a bad root' });
    const stats = plugin.api.getStats();
    expect(stats.degraded).toBe(false);
    expect(stats.roots).toEqual([project.dir]);

    const seen = [];
    server.watcher.on('change', (file) => seen.push(file));
    writeFile(project.mod, 'export const n = 5;\n');
    await waitFor(() => seen.length > 0, {
      timeout: 10000,
      message: 'the good root still delivers',
    });
  });

  it('routes a dispatched event through the watcher channel, not a hand-rolled payload', async () => {
    const project = fixture();
    const plugin = createRetriggerVitePlugin({ engine: 'javascript' });
    const server = await startServer(project.dir, [plugin]);
    live.add(server);
    await waitFor(() => plugin.api.isWatching(), { message: 'watcher started' });

    const emitted = [];
    server.watcher.on('change', (f) => emitted.push(f));
    const channel = plugin.api.dispatch({
      path: project.mod,
      kind: 'modified',
      isDirectory: false,
      size: 1,
      timestampNs: 0n,
      cookie: null,
    });
    expect(channel).toBe('watcher');
    await waitFor(() => emitted.includes(normalizePath(project.mod)), {
      message: 'direct dispatch reached the watcher',
    });
  });

  it('serves measured statistics over the debug endpoint', async () => {
    const project = fixture();
    const plugin = createRetriggerVitePlugin({ engine: 'javascript' });
    const server = await startServer(project.dir, [plugin]);
    live.add(server);
    await waitFor(() => plugin.api.isWatching(), { message: 'watcher started' });

    const { port } = server.httpServer.address();
    const response = await fetch(`http://127.0.0.1:${port}/__retrigger_stats`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.plugin).toBe('retrigger-vite');
    expect(body.engine.engine).toBe('javascript');
    expect(body.watching).toBe(true);
  });

  it('tears down cleanly on server close, leaving no watcher behind', async () => {
    const project = fixture();
    const plugin = createRetriggerVitePlugin({ engine: 'javascript' });
    const server = await startServer(project.dir, [plugin]);
    live.add(server);
    await waitFor(() => plugin.api.isWatching(), { message: 'watcher started' });

    const before = countHandles();
    await server.close();
    live.delete(server);
    await sleep(100);

    expect(plugin.api.isWatching()).toBe(false);
    const after = countHandles();
    // Vite's own teardown is asynchronous; assert we did not *grow* the set.
    expect(after).toBeLessThanOrEqual(before);
  });

  it('emits nothing after teardown', async () => {
    const project = fixture();
    const plugin = createRetriggerVitePlugin({ engine: 'javascript', debounceMs: 0 });
    const server = await startServer(project.dir, [plugin]);
    live.add(server);
    await waitFor(() => plugin.api.isWatching(), { message: 'watcher started' });

    let dispatched = 0;
    server.watcher.on('change', () => (dispatched += 1));
    plugin.buildEnd();
    expect(plugin.api.isWatching()).toBe(false);

    const baseline = plugin.api.getStats().metrics.triggers;
    writeFile(project.mod, 'export const n = 9;\n');
    // `server.watcher` is Vite's inert `NoopWatcher`; nothing but this plugin ever emits on it, so
    // after teardown the edit above must produce silence on both counters, not just the plugin's.
    await waitForQuiet(() => dispatched, { quietMs: 200, timeout: 2000 });
    expect(dispatched).toBe(0);
    expect(plugin.api.getStats().metrics.triggers).toBe(baseline);
  });

  it('degrades instead of throwing when the engine cannot start', async () => {
    const project = fixture();
    // `native` with no addon present is a hard failure inside start().
    const plugin = createRetriggerVitePlugin({ engine: 'native' });
    const previous = process.env.RETRIGGER_SILENT;
    process.env.RETRIGGER_SILENT = '1';
    try {
      const server = await startServer(project.dir, [plugin]);
      live.add(server);
      // The dev server came up regardless of the engine failure.
      expect(server.httpServer.address().port).toBeGreaterThan(0);
      const stats = plugin.api.getStats();
      if (stats.engine.engine !== 'native') {
        expect(stats.degraded).toBe(true);
        expect(stats.watching).toBe(false);
      }
      // Vite still serves; its own watcher is untouched.
      const { port } = server.httpServer.address();
      const response = await fetch(`http://127.0.0.1:${port}/main.js`);
      expect(response.status).toBe(200);
    } finally {
      if (previous === undefined) delete process.env.RETRIGGER_SILENT;
      else process.env.RETRIGGER_SILENT = previous;
    }
  });

  it('lets a plugin whose configureServer runs later still receive events via server.watcher', async () => {
    // enforce: 'pre' makes retrigger's own configureServer run first regardless of array order;
    // the claim under test is that server.watcher's identity survives that -- a listener attached
    // by a plugin configured strictly after it still sees every event.
    const project = fixture();
    const plugin = createRetriggerVitePlugin({ engine: 'javascript', debounceMs: 0 });
    const laterEvents = [];
    const laterPlugin = {
      name: 'independently-authored',
      configureServer(devServer) {
        devServer.watcher.on('change', (file) => laterEvents.push(file));
      },
    };
    const server = await startServer(project.dir, [plugin, laterPlugin]);
    live.add(server);
    await waitFor(() => plugin.api.isWatching(), { message: 'watcher started' });

    writeFile(project.mod, 'export const n = 21;\n');
    await waitFor(() => laterEvents.includes(normalizePath(project.mod)), {
      timeout: 10000,
      message: 'a plugin configured after retrigger still saw the change',
    });
  });

  it('emits exactly once per real edit regardless of how many listeners are attached', async () => {
    const project = fixture();
    const plugin = createRetriggerVitePlugin({ engine: 'javascript', debounceMs: 0 });
    const server = await startServer(project.dir, [plugin]);
    live.add(server);
    await waitFor(() => plugin.api.isWatching(), { message: 'watcher started' });
    await server.transformRequest('/mod.js');

    const edited = normalizePath(project.mod);
    let emitCalls = 0;
    const originalEmit = server.watcher.emit.bind(server.watcher);
    // Instrumentation only, not an override left installed: proves dispatch() calls `.emit()`
    // exactly once for this edit, independent of how many listeners are subscribed to it.
    server.watcher.emit = (name, ...args) => {
      if (name === 'change' && args[0] === edited) emitCalls += 1;
      return originalEmit(name, ...args);
    };
    const listenerA = [];
    const listenerB = [];
    server.watcher.on('change', (f) => listenerA.push(f));
    server.watcher.on('change', (f) => listenerB.push(f));

    writeFile(project.mod, 'export const n = 31;\n');
    await waitFor(() => listenerA.includes(edited) && listenerB.includes(edited), {
      timeout: 10000,
      message: 'both listeners saw the edit',
    });
    await waitForQuiet(() => emitCalls, { quietMs: 300, timeout: 3000 });
    expect(emitCalls, 'server.watcher.emit called exactly once for the edit').toBe(1);
  });

  it('suppresses HMR for an identical-byte rewrite but not for a real edit', async () => {
    const project = fixture();
    const plugin = createRetriggerVitePlugin({ engine: 'javascript', debounceMs: 0 });
    /** @type {string[]} */
    const hotUpdates = [];
    const spy = {
      name: 'spy',
      handleHotUpdate(ctx) {
        hotUpdates.push(ctx.file);
      },
    };
    const server = await startServer(project.dir, [plugin, spy]);
    live.add(server);
    await waitFor(() => plugin.api.isWatching(), { message: 'watcher started' });
    await server.transformRequest('/main.js');
    await server.transformRequest('/mod.js');

    // Prime with a real edit first -- the fixture's own initial bytes are not a fair "before" to
    // rewrite identically, since every fixture starts unread by the module graph.
    const contents = 'export const n = 61;\n';
    writeFile(project.mod, contents);
    await waitFor(() => hotUpdates.includes(normalizePath(project.mod)), {
      timeout: 10000,
      message: 'priming edit reached handleHotUpdate',
    });
    await waitForQuiet(() => plugin.api.getStats().watcher.content.filesHashed, {
      quietMs: 300,
      timeout: 3000,
    });
    hotUpdates.length = 0;
    const sent = spyOnHotChannels(server);

    writeFile(project.mod, contents);
    await waitFor(() => plugin.api.getStats().metrics.eventsUnchanged > 0, {
      timeout: 10000,
      message: 'the no-op write was observed and classified',
    });
    await waitForQuiet(() => hotUpdates.length, { quietMs: 300, timeout: 2000 });
    expect(hotUpdates, 'an identical-byte rewrite must not reach handleHotUpdate').toEqual([]);
    expect(sent, 'and must not produce an HMR payload').toEqual([]);

    writeFile(project.mod, 'export const n = 62;\n');
    await waitFor(() => hotUpdates.includes(normalizePath(project.mod)), {
      timeout: 10000,
      message: 'a real edit still reaches handleHotUpdate',
    });
    await waitFor(() => sent.some((m) => m && (m.type === 'update' || m.type === 'full-reload')), {
      timeout: 10000,
      message: 'and produces an HMR payload',
    });
  });

  it('keeps delivering events through a fallback watcher after mid-session degradation', async () => {
    const project = fixture();
    const plugin = createRetriggerVitePlugin({ engine: 'javascript', debounceMs: 0 });
    const server = await startServer(project.dir, [plugin]);
    live.add(server);
    await waitFor(() => plugin.api.isWatching(), { message: 'watcher started' });

    const changes = [];
    server.watcher.on('change', (file) => changes.push(file));

    // Forces the same path a run of engine errors would: stop trusting Retrigger and engage a
    // real watcher, without depending on an OS-specific way to make the engine itself misbehave.
    plugin.api.degrade('synthetic mid-session failure');
    expect(plugin.api.isWatching()).toBe(false);
    const stats = plugin.api.getStats();
    expect(stats.degraded).toBe(true);
    expect(stats.fallback).toBe(true);

    // The dev server itself must never notice.
    const { port } = server.httpServer.address();
    const response = await fetch(`http://127.0.0.1:${port}/main.js`);
    expect(response.status).toBe(200);

    writeFile(project.mod, 'export const n = 71;\n');
    await waitFor(() => changes.includes(normalizePath(project.mod)), {
      timeout: 15000,
      message: 'the fallback watcher delivered the edit onto server.watcher',
    });
  });

  it('tears down the fail-open fallback watcher cleanly too', async () => {
    const project = fixture();
    const plugin = createRetriggerVitePlugin({ engine: 'javascript', debounceMs: 0 });
    const server = await startServer(project.dir, [plugin]);
    live.add(server);
    await waitFor(() => plugin.api.isWatching(), { message: 'watcher started' });

    plugin.api.degrade('synthetic failure for the teardown test');
    await waitFor(() => plugin.api.getStats().fallback === true, { message: 'fallback engaged' });

    const before = countHandles();
    await server.close();
    live.delete(server);
    await sleep(150);

    expect(plugin.api.getStats().fallback).toBe(false);
    const after = countHandles();
    expect(after).toBeLessThanOrEqual(before);
  });

  it('restores the pre-rewrite shared-watcher design with legacyWatcher: true', async () => {
    const project = fixture();
    const plugin = createRetriggerVitePlugin({
      engine: 'javascript',
      debounceMs: 0,
      legacyWatcher: true,
    });
    const server = await startServer(project.dir, [plugin]);
    live.add(server);
    await waitFor(() => plugin.api.isWatching(), { message: 'watcher started' });

    // Vite's own chokidar is left running, unlike the default design.
    expect(server.config.server.watch).not.toBe(null);
    expect(server.watcher.constructor.name).not.toBe('NoopWatcher');

    const changes = [];
    server.watcher.on('change', (file) => changes.push(file));
    writeFile(project.mod, 'export const n = 81;\n');
    await waitFor(() => changes.includes(normalizePath(project.mod)), {
      timeout: 10000,
      message: 'the edit still reaches Vite in legacy mode',
    });
  });

  it('tolerates hooks called out of order or twice', () => {
    const plugin = createRetriggerVitePlugin({ engine: 'javascript' });
    expect(() => plugin.buildStart()).not.toThrow();
    expect(() => plugin.buildEnd()).not.toThrow();
    expect(() => plugin.buildEnd()).not.toThrow();
    expect(() => plugin.closeBundle()).not.toThrow();
    expect(plugin.api.isWatching()).toBe(false);
    expect(plugin.api.dispatch({ path: '/tmp/x', kind: 'modified' })).toBe('skipped');
  });
});

/**
 * Vite has moved the HMR channel around between majors (`server.ws`,
 * `server.hot`, per-environment `hot`). Wrap every one that exists so the
 * assertion is about the payload, not about which property held it.
 * @returns {object[]} messages, appended as they are sent
 */
function spyOnHotChannels(server) {
  const sent = [];
  const channels = [server.ws, server.hot];
  const environments = server.environments || {};
  for (const env of Object.values(environments)) if (env && env.hot) channels.push(env.hot);
  const seen = new Set();
  for (const channel of channels) {
    if (!channel || typeof channel.send !== 'function' || seen.has(channel)) continue;
    seen.add(channel);
    const original = channel.send.bind(channel);
    channel.send = (...args) => {
      sent.push(args[0]);
      return original(...args);
    };
  }
  return sent;
}

function countHandles() {
  if (typeof process.getActiveResourcesInfo !== 'function') return 0;
  return process.getActiveResourcesInfo().filter((r) => /FSEvent|StatWatcher|FSReqCallback/.test(r))
    .length;
}
