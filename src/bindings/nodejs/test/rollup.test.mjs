import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';

const require = createRequire(import.meta.url);
// The exact `require('rollup')` instance `lib/rollup-plugin.js` itself resolves to (both are CJS
// requires from this package, so they share Node's module cache) — nothing here is mocked except
// this one spy, which proves `rollup.watch` (the observation-only API this package's factory must
// never call) is never even touched.
const rollupModule = require('rollup');
const { tempDir, cleanupTempDirs, waitFor, waitForQuiet, writeFile } = require('./helpers/tmp.js');

const { createRetriggerRollupWatcher } = require('../lib/rollup-plugin.js');

/** A minimal but real ES module entry point on disk. */
function fixture() {
  const dir = tempDir('retrigger-rollup-');
  const src = path.join(dir, 'src');
  const entry = path.join(src, 'index.js');
  writeFile(entry, 'export const value = 1;\n');
  return { dir, src, entry, outFile: path.join(dir, 'dist', 'bundle.js') };
}

function watcherFor(project, extra = {}) {
  return createRetriggerRollupWatcher({
    input: { input: project.entry },
    output: { file: project.outFile, format: 'es' },
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

describe('rollup manual-rebuild watcher', () => {
  it('never touches rollup.watch — the observation-only API this package must not rely on', async () => {
    const original = rollupModule.watch;
    let called = false;
    // A real, callable spy rather than a throwing one: `rollup` freezes/consults its own module
    // namespace in ways a throw could destabilise, and a boolean flag proves the same thing.
    Object.defineProperty(rollupModule, 'watch', {
      configurable: true,
      value: (...args) => {
        called = true;
        return original(...args);
      },
    });
    live.add(async () => {
      Object.defineProperty(rollupModule, 'watch', { configurable: true, value: original });
    });

    const project = fixture();
    const watcher = watcherFor(project);
    live.add(() => watcher.close());
    await watcher.start();
    writeFile(project.entry, 'export const value = 2;\n');
    await waitFor(() => watcher.buildCount >= 2, { message: 'rebuild after real edit' });

    expect(called, 'createRetriggerRollupWatcher must never call rollup.watch()').toBe(false);
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

    // The tracker's digest cache has no entry for a path until this session's watcher has seen an
    // event for it — the very first post-start write to any path is therefore always a genuine
    // "first sighting" and correctly triggers a build. This establishes that baseline before the
    // assertion under test, exactly as `webpack.test.mjs`'s equivalent case does.
    const baseline = 'export const value = 100;\n';
    writeFile(project.entry, baseline);
    await waitFor(() => watcher.buildCount >= 2, { message: 'baseline rebuild' });
    const before = watcher.buildCount;

    writeFile(project.entry, baseline);
    await waitFor(() => watcher.driver.getStats().eventsUnchanged > 0, {
      timeout: 10000,
      message: 'the no-op write was seen and classified',
    });
    // Only after the watcher demonstrably saw the write: a bare timer would pass just as happily
    // if no event had arrived at all.
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

    // Settling for a moment must not produce a second, spurious rebuild.
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

    // The whole point of coalescing: five edits inside one window cost far fewer than five builds,
    // and the final bundle reflects the last edit, not an intermediate one.
    expect(watcher.buildCount - before).toBeLessThan(5);
    expect(readBundle(project)).toContain('value = 6');
  });

  it('a rebuild error is surfaced and watching continues', async () => {
    const project = fixture();
    const errors = [];
    const watcher = watcherFor(project, { onError: (err) => errors.push(err) });
    live.add(() => watcher.close());
    await watcher.start();
    const before = watcher.buildCount;

    // A real Rollup failure: a syntax error the parser rejects, not a mocked throw.
    writeFile(project.entry, 'export const value = ;\n');
    await waitFor(() => errors.length > 0, {
      timeout: 10000,
      message: 'the broken build was reported',
    });
    expect(errors[0]).toBeInstanceOf(Error);
    expect(watcher.driver.getStats().rebuildCount).toBe(before - 1);

    // The watch must still be alive: fixing the file rebuilds successfully.
    writeFile(project.entry, 'export const value = 99;\n');
    await waitFor(() => watcher.buildCount === before + 1, {
      timeout: 10000,
      message: 'a subsequent good edit still rebuilds after a prior failure',
    });
    expect(readBundle(project)).toContain('value = 99');
  });

  it('close() awaits an in-flight rebuild and leaks no watcher handles', async () => {
    const project = fixture();
    const watcher = watcherFor(project);
    await watcher.start();

    writeFile(project.entry, 'export const value = 7;\n');
    await waitFor(() => watcher.buildCount >= 2, { message: 'rebuild before teardown' });

    await watcher.close();
    expect(watcher.getStats().closed).toBe(true);
    expect(watcher.driver.watcher.isRunning).toBe(false);
    // Calling close() again must be safe and must not double-run anything.
    await expect(watcher.close()).resolves.toBeUndefined();
  });

  it('rejects construction without watchPaths, input, or output', () => {
    const project = fixture();
    expect(() =>
      createRetriggerRollupWatcher({
        output: { file: project.outFile, format: 'es' },
        watchPaths: [project.src],
      })
    ).toThrow(/input/);
    expect(() =>
      createRetriggerRollupWatcher({ input: { input: project.entry }, watchPaths: [project.src] })
    ).toThrow(/output/);
    expect(() =>
      createRetriggerRollupWatcher({
        input: { input: project.entry },
        output: { file: project.outFile, format: 'es' },
      })
    ).toThrow(/watchPaths/);
  });
});
