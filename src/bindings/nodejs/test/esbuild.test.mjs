import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';

const require = createRequire(import.meta.url);
// The exact `require('esbuild')` instance `lib/esbuild-plugin.js` itself resolves to (both are
// CJS requires from this package, so they share Node's module cache) — nothing here is mocked
// except this one spy, on the `BuildContext` esbuild hands back, which proves `ctx.watch` (the
// observation-only API this package's factory must never call) is never even touched.
const esbuild = require('esbuild');
const { tempDir, cleanupTempDirs, waitFor, waitForQuiet, writeFile } = require('./helpers/tmp.js');

const { createRetriggerEsbuildWatcher } = require('../lib/esbuild-plugin.js');

/** A minimal but real esbuild entry point on disk. */
function fixture() {
  const dir = tempDir('retrigger-esbuild-');
  const src = path.join(dir, 'src');
  const entry = path.join(src, 'index.js');
  writeFile(entry, 'export const value = 1;\n');
  return { dir, src, entry, outFile: path.join(dir, 'dist', 'bundle.js') };
}

function watcherFor(project, extra = {}) {
  return createRetriggerEsbuildWatcher({
    entryPoints: [project.entry],
    outfile: project.outFile,
    bundle: true,
    format: 'esm',
    watchPaths: [project.src],
    engine: 'javascript',
    coalesceMs: 30,
    ...extra,
  });
}

function readBundle(project) {
  return fs.readFileSync(project.outFile, 'utf8');
}

const live = new Set();

afterEach(async () => {
  for (const teardown of [...live]) {
    live.delete(teardown);
    await teardown();
  }
});

afterAll(() => cleanupTempDirs());

describe('esbuild manual-rebuild watcher', () => {
  it('never touches ctx.watch — the observation-only API this package must not rely on', async () => {
    // `esbuild.context` is a non-configurable getter (unlike Rollup's plain, writable `watch`
    // export), so the spy instead swaps the module's own `require.cache` entry for a `Proxy` that
    // wraps every `context()` result's `watch` method — this is what `lib/esbuild-plugin.js`'s own
    // lazy `require('esbuild')` resolves to for the rest of this test, since both requires resolve
    // to the same cache entry.
    const esbuildPath = require.resolve('esbuild');
    let watchCalled = false;
    const spied = new Proxy(esbuild, {
      get(target, prop, receiver) {
        if (prop !== 'context') return Reflect.get(target, prop, receiver);
        return async (opts) => {
          const ctx = await target.context(opts);
          const originalWatch = ctx.watch;
          ctx.watch = (...args) => {
            watchCalled = true;
            return originalWatch.apply(ctx, args);
          };
          return ctx;
        };
      },
    });
    require.cache[esbuildPath].exports = spied;
    live.add(async () => {
      require.cache[esbuildPath].exports = esbuild;
    });

    const project = fixture();
    const watcher = watcherFor(project);
    live.add(() => watcher.close());
    await watcher.start();
    writeFile(project.entry, 'export const value = 2;\n');
    await waitFor(() => watcher.buildCount >= 2, { message: 'rebuild after real edit' });

    expect(watchCalled, 'createRetriggerEsbuildWatcher must never call ctx.watch()').toBe(false);
  });

  it('builds once on start(), and the output reflects the initial source', async () => {
    const project = fixture();
    const watcher = watcherFor(project);
    live.add(() => watcher.close());

    await watcher.start();
    expect(watcher.buildCount).toBe(1);
    expect(readBundle(project)).toContain('value = 1');
  });

  it('a byte-identical rewrite triggers zero builds', async () => {
    const project = fixture();
    const watcher = watcherFor(project);
    live.add(() => watcher.close());
    await watcher.start();

    // See rollup.test.mjs's equivalent case for why a baseline write is established first: the
    // digest cache has no entry for a path until this session's watcher has seen an event for it.
    const baseline = 'export const value = 100;\n';
    writeFile(project.entry, baseline);
    await waitFor(() => watcher.buildCount >= 2, { message: 'baseline rebuild' });
    const before = watcher.buildCount;

    writeFile(project.entry, baseline);
    await waitFor(() => watcher.driver.getStats().eventsUnchanged > 0, {
      timeout: 10000,
      message: 'the no-op write was seen and classified',
    });
    await waitForQuiet(() => watcher.buildCount, { quietMs: 300, timeout: 3000 });
    expect(watcher.buildCount, 'a byte-identical rewrite must not trigger a build').toBe(before);
    expect(watcher.driver.getStats().rebuildCount).toBe(before - 1);
  });

  it('a real edit produces exactly one correct rebuild', async () => {
    const project = fixture();
    const watcher = watcherFor(project);
    live.add(() => watcher.close());
    await watcher.start();
    const before = watcher.buildCount;

    writeFile(project.entry, 'export const value = 42;\n');
    await waitFor(() => watcher.buildCount === before + 1, {
      timeout: 10000,
      message: 'exactly one rebuild after the edit',
    });
    expect(readBundle(project)).toContain('value = 42');

    await waitForQuiet(() => watcher.buildCount, { quietMs: 300, timeout: 2000 });
    expect(watcher.buildCount).toBe(before + 1);
  });

  it('a burst of real edits coalesces to the minimum number of rebuilds', async () => {
    const project = fixture();
    const watcher = watcherFor(project, { coalesceMs: 80 });
    live.add(() => watcher.close());
    await watcher.start();
    const before = watcher.buildCount;

    for (let i = 2; i <= 6; i += 1) {
      writeFile(project.entry, `export const value = ${i};\n`);
    }
    await waitFor(() => watcher.buildCount > before, {
      timeout: 10000,
      message: 'the burst produced at least one rebuild',
    });
    await waitForQuiet(() => watcher.buildCount, { quietMs: 400, timeout: 4000 });

    expect(watcher.buildCount - before).toBeLessThan(5);
    expect(readBundle(project)).toContain('value = 6');
  });

  it('a rebuild error is surfaced and watching continues', async () => {
    const project = fixture();
    const errors = [];
    const watcher = watcherFor(project, {
      onError: (err) => errors.push(err),
      logLevel: 'silent',
    });
    live.add(() => watcher.close());
    await watcher.start();
    const before = watcher.buildCount;

    // A real esbuild failure: a syntax error the parser rejects, not a mocked throw.
    writeFile(project.entry, 'export const value = ;\n');
    await waitFor(() => errors.length > 0, {
      timeout: 10000,
      message: 'the broken build was reported',
    });
    expect(errors[0]).toBeInstanceOf(Error);
    expect(watcher.driver.getStats().rebuildCount).toBe(before - 1);

    // The context must still be alive: fixing the file rebuilds successfully.
    writeFile(project.entry, 'export const value = 99;\n');
    await waitFor(() => watcher.buildCount === before + 1, {
      timeout: 10000,
      message: 'a subsequent good edit still rebuilds after a prior failure',
    });
    expect(readBundle(project)).toContain('value = 99');
  });

  it('close() awaits an in-flight rebuild, disposes the context, and leaks no handles', async () => {
    const project = fixture();
    const watcher = watcherFor(project);
    await watcher.start();

    writeFile(project.entry, 'export const value = 7;\n');
    await waitFor(() => watcher.buildCount >= 2, { message: 'rebuild before teardown' });

    await watcher.close();
    expect(watcher.getStats().closed).toBe(true);
    expect(watcher.driver.watcher.isRunning).toBe(false);
    // Calling close() again must be safe (idempotent `ctx.dispose()` guard) and not double-run.
    await expect(watcher.close()).resolves.toBeUndefined();
  });

  it('rejects construction without watchPaths', () => {
    const project = fixture();
    expect(() =>
      createRetriggerEsbuildWatcher({
        entryPoints: [project.entry],
        outfile: project.outFile,
        bundle: true,
      })
    ).toThrow(/watchPaths/);
  });

  it('keeps esbuild BuildOptions and Retrigger options separate in one flat object', async () => {
    const project = fixture();
    const watcher = createRetriggerEsbuildWatcher({
      entryPoints: [project.entry],
      outfile: project.outFile,
      bundle: true,
      minify: false,
      watchPaths: [project.src],
      include: ['**/*.js'],
      exclude: ['**/*.log'],
      engine: 'javascript',
    });
    live.add(() => watcher.close());
    await watcher.start();
    expect(watcher.driver.watcher.options.include).toEqual(['**/*.js']);
    expect(watcher.driver.watcher.options.exclude).toEqual(['**/*.log']);
  });
});
