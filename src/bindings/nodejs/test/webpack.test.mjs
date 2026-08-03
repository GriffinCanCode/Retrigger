import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
// A real `import`, not `require('webpack')`: this is what lets `vitest.rspack.config.mjs` retarget
// this exact suite at `@rspack/core` (see `test:rspack`) via a resolve alias -- Vite's resolver
// only rewrites the ESM import graph it controls, and a `createRequire`d `require()` call bypasses
// that graph entirely and would always hit the real `webpack` package regardless of any alias.
import webpack from 'webpack';

const require = createRequire(import.meta.url);
const {
  tempDir,
  cleanupTempDirs,
  waitFor,
  waitForQuiet,
  writeFile,
  sleep,
} = require('./helpers/tmp.js');

const RetriggerWebpackPlugin = require('../plugins/webpack-plugin.js');
const { RetriggerWatchFileSystem } = RetriggerWebpackPlugin;

/**
 * A minimal but real webpack project on disk. Nothing is stubbed: webpack
 * resolves, reads and bundles these files for real.
 */
function fixture() {
  const dir = tempDir('retrigger-webpack-');
  const src = path.join(dir, 'src');
  writeFile(path.join(src, 'entry.js'), "import { value } from './dep.js';\nconsole.log(value);\n");
  writeFile(path.join(src, 'dep.js'), 'export const value = 1;\n');
  return { dir, src, entry: path.join(src, 'entry.js'), dep: path.join(src, 'dep.js') };
}

function compilerFor(project, plugin, extra = {}) {
  return webpack({
    mode: 'development',
    devtool: false,
    context: project.dir,
    entry: project.entry,
    output: { path: path.join(project.dir, 'dist'), filename: 'bundle.js' },
    plugins: plugin ? [plugin] : [],
    infrastructureLogging: { level: 'error' },
    stats: 'errors-only',
    ...extra,
  });
}

/** Close a watching compiler and wait for webpack to release its handles. */
function closeWatching(watching, compiler) {
  return new Promise((resolve) => {
    watching.close(() => compiler.close(() => resolve()));
  });
}

const live = new Set();

afterEach(async () => {
  for (const teardown of [...live]) {
    live.delete(teardown);
    await teardown();
  }
});

afterAll(() => cleanupTempDirs());

describe('webpack 5 integration', () => {
  it('installs itself as watchFileSystem without disturbing a plain build', async () => {
    const project = fixture();
    const plugin = new RetriggerWebpackPlugin({ watchPaths: [project.src] });
    const compiler = compilerFor(project, plugin);

    expect(compiler.watchFileSystem).toBeInstanceOf(RetriggerWatchFileSystem);

    const stats = await new Promise((resolve, reject) => {
      compiler.run((err, result) => (err ? reject(err) : resolve(result)));
    });
    await new Promise((resolve) => compiler.close(resolve));

    expect(stats.hasErrors()).toBe(false);
    expect(fs.existsSync(path.join(project.dir, 'dist', 'bundle.js'))).toBe(true);
  });

  it('rebuilds when a watched source file changes', async () => {
    const project = fixture();
    const plugin = new RetriggerWebpackPlugin({
      watchPaths: [project.src],
      aggregateTimeout: 10,
    });
    const compiler = compilerFor(project, plugin);

    /** @type {object[]} */
    const builds = [];
    const errors = [];
    const watching = compiler.watch({ aggregateTimeout: 10, poll: false }, (err, stats) => {
      if (err) errors.push(err);
      else builds.push(stats);
    });
    live.add(() => closeWatching(watching, compiler));

    await waitFor(() => builds.length >= 1, { message: 'initial build' });
    expect(errors).toEqual([]);

    // The watcher is attached during the first build, but on macOS its FSEvents stream goes live on
    // another thread some time after that, and a write landing before it does is lost outright
    // rather than delayed. Prove the watch is delivering — with a sentinel whose contents differ on
    // every attempt, so it is always a real change — before making the edit the assertion rests on.
    const sentinel = path.join(project.src, 'live.probe');
    await waitFor(
      () => {
        writeFile(sentinel, `probe ${Date.now()}`);
        return plugin.fileTimeInfo.has(sentinel);
      },
      { timeout: 15000, interval: 50, message: 'watcher delivering events' }
    );

    writeFile(project.dep, 'export const value = 2;\n');

    // Assert on the emitted output, not just on a build counter: a rebuild
    // that reused a stale cached read would satisfy the counter and still be
    // wrong. webpack writes the asset before invoking the watch callback, so
    // both conditions are waited on together.
    await waitFor(
      () => {
        const out = path.join(project.dir, 'dist', 'bundle.js');
        if (builds.length < 2) return false;
        return fs.existsSync(out) && fs.readFileSync(out, 'utf8').includes('value = 2');
      },
      { timeout: 20000, message: 'rebuild emits the edited source' }
    );
    expect(errors).toEqual([]);
  });

  it('does not rebuild for unrelated activity beside a dependency', async () => {
    // Node's resolver probes for `package.json` in every directory from the importer up to the
    // filesystem root, and each miss lands in webpack's `missing` set. Watching the parent of each
    // one puts a watch on `/`, on the home directory and on `/tmp` — and if any sibling in a
    // watched directory counts as a dependency, an idle dev server rebuilds all day for other
    // people's temp files.
    const project = fixture();
    const plugin = new RetriggerWebpackPlugin({
      watchPaths: [project.src],
      aggregateTimeout: 10,
    });
    const compiler = compilerFor(project, plugin);

    const builds = [];
    // What webpack was told changed, which is the claim under test. Counting rebuilds instead would
    // also count one provoked by any other path, and the fallback engine forwards a first sighting
    // of a path it has no digest for on trust — a question this test is not about.
    const blamed = [];
    compiler.hooks.watchRun.tap('retrigger-test', (c) => {
      for (const file of c.modifiedFiles || []) blamed.push(file);
      for (const file of c.removedFiles || []) blamed.push(file);
    });
    const watching = compiler.watch({ aggregateTimeout: 10, poll: false }, (err, stats) => {
      if (!err) builds.push(stats);
    });
    live.add(() => closeWatching(watching, compiler));
    await waitFor(() => builds.length >= 1, { message: 'initial build' });

    const registered = [...plugin.registered.keys()];
    const root = path.resolve(project.dir);
    const above = registered.filter((dir) => dir !== root && root.startsWith(dir + path.sep));
    expect(above, 'no directory above the project root may be watched').toEqual([]);

    // A file webpack has never heard of, in a directory it does depend on.
    const sentinel = path.join(project.src, 'live.probe');
    await waitFor(
      () => {
        writeFile(sentinel, `probe ${Date.now()}`);
        return plugin.fileTimeInfo.has(sentinel);
      },
      { timeout: 15000, interval: 50, message: 'watcher delivering events' }
    );
    const unrelated = path.join(project.dir, 'unrelated.log');
    writeFile(unrelated, `noise ${Date.now()}`);
    await waitForQuiet(() => builds.length, { quietMs: 400, timeout: 4000 });
    expect(blamed, 'a write webpack does not depend on must not be reported to it').not.toContain(
      unrelated
    );
    expect(blamed, 'nor may the probe beside its sources').not.toContain(sentinel);
  });

  it('still builds when the native engine is unavailable', async () => {
    // The whole point of the fallback: no addon, no behavioural difference.
    const project = fixture();
    const plugin = new RetriggerWebpackPlugin({
      watchPaths: [project.src],
      engine: 'javascript',
      aggregateTimeout: 10,
    });
    const compiler = compilerFor(project, plugin);

    const builds = [];
    const errors = [];
    const watching = compiler.watch({ aggregateTimeout: 10 }, (err, stats) => {
      if (err) errors.push(err);
      else builds.push(stats);
    });
    live.add(() => closeWatching(watching, compiler));

    await waitFor(() => builds.length >= 1, { message: 'initial build with js engine' });
    expect(builds[0].hasErrors()).toBe(false);

    const stats = plugin.getStats();
    expect(stats).not.toBeNull();
    expect(stats.engine).toBe('javascript');
    expect(stats.backend).toBe('polling');

    writeFile(project.dep, 'export const value = 3;\n');
    await waitFor(() => builds.length >= 2, { timeout: 15000, message: 'js-engine rebuild' });
    expect(errors).toEqual([]);
  });

  it('delegates to webpack\u2019s own watcher when the engine cannot start', async () => {
    const project = fixture();
    const plugin = new RetriggerWebpackPlugin({
      watchPaths: [project.src],
      aggregateTimeout: 10,
    });
    const compiler = compilerFor(project, plugin);
    const original = compiler.watchFileSystem.original;
    let delegated = 0;
    const originalWatch = original.watch.bind(original);
    original.watch = (...args) => {
      delegated += 1;
      return originalWatch(...args);
    };

    // Force every attempt to create a Retrigger watcher to blow up.
    plugin._ensureWatcher = () => {
      throw new Error('synthetic engine failure');
    };

    const builds = [];
    const errors = [];
    const watching = compiler.watch({ aggregateTimeout: 10 }, (err, stats) => {
      if (err) errors.push(err);
      else builds.push(stats);
    });
    live.add(() => closeWatching(watching, compiler));

    await waitFor(() => builds.length >= 1, { message: 'build after degradation' });
    expect(errors).toEqual([]);
    expect(delegated).toBeGreaterThan(0);
    expect(plugin.degraded).toBe(true);
    expect(plugin.degradedReason).toContain('synthetic engine failure');

    // Degraded means webpack's own watcher: a change must still rebuild.
    writeFile(project.dep, 'export const value = 4;\n');
    await waitFor(() => builds.length >= 2, {
      timeout: 20000,
      message: 'rebuild via delegated watcher',
    });
  });

  it('never propagates a plugin failure out of a webpack hook', async () => {
    const project = fixture();
    const plugin = new RetriggerWebpackPlugin({ watchPaths: [project.src] });
    plugin._ensureWatcher = () => {
      throw new Error('hook-level explosion');
    };
    const compiler = compilerFor(project, plugin);

    // watchRun is the hook that used to re-throw. Drive it directly so the
    // assertion is about the hook contract, not about webpack's scheduling.
    await expect(
      new Promise((resolve, reject) => {
        compiler.hooks.watchRun.callAsync(compiler, (err) => (err ? reject(err) : resolve('ok')));
      })
    ).resolves.toBe('ok');

    expect(plugin.degraded).toBe(true);
    await new Promise((resolve) => compiler.close(resolve));
  });

  it('survives a watchFileSystem callback that throws', async () => {
    const project = fixture();
    const plugin = new RetriggerWebpackPlugin({ aggregateTimeout: 0 });
    const compiler = compilerFor(project, plugin);
    const wfs = compiler.watchFileSystem;

    let thrown = 0;
    const handle = wfs.watch(
      new Set([project.dep]),
      new Set([project.src]),
      new Set(),
      Date.now() - 1000,
      {},
      () => {
        thrown += 1;
        throw new Error('consumer callback failure');
      },
      () => {}
    );
    live.add(async () => {
      handle.close();
      plugin.stop();
      await new Promise((resolve) => compiler.close(resolve));
    });

    writeFile(project.dep, 'export const value = 5;\n');
    await waitFor(() => thrown >= 1, { timeout: 10000, message: 'callback invoked' });

    // The throw was swallowed by the plugin; the process is still healthy and
    // the plugin is still answering.
    expect(plugin.getStats()).not.toBeNull();
  });

  it('reports removals and changes separately to webpack', async () => {
    const project = fixture();
    const extra = path.join(project.src, 'extra.js');
    writeFile(extra, 'export const extra = 1;\n');

    const plugin = new RetriggerWebpackPlugin({ aggregateTimeout: 0 });
    const compiler = compilerFor(project, plugin);
    const wfs = compiler.watchFileSystem;

    /** @type {{changed: Set<string>, removed: Set<string>}[]} */
    const reports = [];
    let handle = null;

    // A session fires once and is then spent, exactly as webpack's own
    // watcher behaves; webpack re-arms it after every rebuild, so the test
    // has to as well.
    const arm = () => {
      handle = wfs.watch(
        new Set([project.dep, extra]),
        new Set([project.src]),
        new Set(),
        Date.now() + 1000,
        {},
        (err, _f, _c, changed, removed) => {
          reports.push({ changed: new Set(changed), removed: new Set(removed) });
          setImmediate(arm);
        },
        () => {}
      );
    };
    arm();
    live.add(async () => {
      if (handle) handle.close();
      plugin.stop();
      await new Promise((resolve) => compiler.close(resolve));
    });

    writeFile(project.dep, 'export const value = 6;\n');
    await waitFor(() => reports.some((r) => r.changed.has(project.dep)), {
      timeout: 10000,
      message: 'change reported',
    });

    fs.rmSync(extra);
    const removal = await waitFor(() => reports.find((r) => r.removed.has(extra)), {
      timeout: 10000,
      message: 'removal reported',
    });
    // The two sets are disjoint: webpack must never be told a file both
    // changed and was removed in the same cycle.
    expect(removal.changed.has(extra)).toBe(false);
  });

  it('does not report a file rewritten with identical bytes', async () => {
    // The reason the package exists, at the level webpack actually experiences it: a formatter on
    // save, a generator that reran, a branch switch that put the same bytes back. Watchpack reports
    // every one of those as a change and webpack rebuilds; this must not.
    const project = fixture();
    const plugin = new RetriggerWebpackPlugin({ aggregateTimeout: 0 });
    const compiler = compilerFor(project, plugin);
    const wfs = compiler.watchFileSystem;

    /** @type {Set<string>[]} */
    const reports = [];
    let handle = null;
    const arm = () => {
      handle = wfs.watch(
        new Set([project.dep]),
        new Set([project.src]),
        new Set(),
        Date.now() + 1000,
        {},
        (err, _f, _c, changed) => {
          reports.push(new Set(changed));
          setImmediate(arm);
        },
        () => {}
      );
    };
    arm();
    live.add(async () => {
      if (handle) handle.close();
      plugin.stop();
      await new Promise((resolve) => compiler.close(resolve));
    });

    const contents = 'export const value = 42;\n';
    writeFile(project.dep, contents);
    await waitFor(() => reports.some((changed) => changed.has(project.dep)), {
      timeout: 10000,
      message: 'the real edit was reported',
    });

    const before = reports.length;
    writeFile(project.dep, contents);
    await waitFor(() => plugin.metrics.eventsUnchanged > 0, {
      timeout: 10000,
      message: 'the no-op write was seen and classified',
    });
    // Only after the watcher has demonstrably seen the write: waiting on a timer instead would pass
    // just as happily if no event had arrived at all.
    const total = await waitForQuiet(() => reports.length, { quietMs: 300, timeout: 3000 });
    expect(total, 'a rewrite with identical bytes must not reach webpack as a change').toBe(before);
  });

  it('advances no timestamp and holds nothing over for an unchanged write', () => {
    // `_onEvent` directly, because the branches worth pinning here are about what the plugin
    // records rather than about how the bytes got there.
    const plugin = new RetriggerWebpackPlugin({ engine: 'javascript' });
    const event = (extra) => ({
      path: '/repo/src/a.ts',
      kind: 'modified',
      isDirectory: false,
      size: 1,
      ...extra,
    });

    plugin._onEvent(event({ contentChanged: true }));
    const stamped = plugin.fileTimeInfo.get('/repo/src/a.ts');
    expect(stamped).toBeDefined();

    plugin._onEvent(event({ contentChanged: false }));
    expect(
      plugin.fileTimeInfo.get('/repo/src/a.ts'),
      'the recorded timestamp still describes the bytes webpack compiled'
    ).toBe(stamped);
    expect(plugin.pendingChanges.size).toBe(1);
    expect(plugin.metrics.eventsUnchanged).toBe(1);
    expect(plugin.metrics.eventsReceived).toBe(2);
  });

  it('tolerates stop() before start and repeated stop()', () => {
    const plugin = new RetriggerWebpackPlugin();
    expect(() => plugin.stop()).not.toThrow();
    expect(() => plugin.stop()).not.toThrow();
    expect(plugin.getStats()).toBeNull();
  });

  it('does not double-install its watchFileSystem wrapper', async () => {
    const project = fixture();
    const plugin = new RetriggerWebpackPlugin();
    const compiler = compilerFor(project, plugin);
    const first = compiler.watchFileSystem;
    compiler.hooks.afterEnvironment.call();
    expect(compiler.watchFileSystem).toBe(first);
    await new Promise((resolve) => compiler.close(resolve));
  });

  it('rejects malformed watch() arguments exactly like webpack does', async () => {
    const project = fixture();
    const plugin = new RetriggerWebpackPlugin();
    const compiler = compilerFor(project, plugin);
    const wfs = compiler.watchFileSystem;
    expect(() =>
      wfs.watch(
        null,
        new Set(),
        new Set(),
        0,
        {},
        () => {},
        () => {}
      )
    ).toThrow(/Invalid arguments/);
    expect(() => wfs.watch(new Set(), new Set(), new Set(), 0, {}, null, () => {})).toThrow(
      /Invalid arguments/
    );
    await new Promise((resolve) => compiler.close(resolve));
  });

  it('releases watcher handles when the compiler stops watching', async () => {
    const project = fixture();
    const plugin = new RetriggerWebpackPlugin({ watchPaths: [project.src] });
    const compiler = compilerFor(project, plugin);
    const builds = [];
    const watching = compiler.watch({ aggregateTimeout: 10 }, (err, stats) => {
      if (!err) builds.push(stats);
    });
    await waitFor(() => builds.length >= 1, { message: 'initial build' });
    expect(plugin.watcher).not.toBeNull();

    await closeWatching(watching, compiler);
    await sleep(50);

    expect(plugin.watcher).toBeNull();
    expect(plugin.sessions.size).toBe(0);
  });
});
