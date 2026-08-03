import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
// Deliberately `import ... from 'webpack'`, exactly like `webpack.test.mjs`: this file only ever
// runs under `vitest.rspack.config.mjs`, whose alias retargets this same specifier at
// `@rspack/core`. There is no scenario where this file is exercised against real webpack, so
// there is nothing gated here beyond what `npm run test:rspack` already gates before it starts.
import webpack from 'webpack';

const require = createRequire(import.meta.url);
const { tempDir, cleanupTempDirs, waitFor, writeFile } = require('./helpers/tmp.js');
const RetriggerWebpackPlugin = require('../plugins/webpack-plugin.js');

function fixture() {
  const dir = tempDir('retrigger-rspack-');
  const src = path.join(dir, 'src');
  writeFile(path.join(src, 'entry.js'), "import { value } from './dep.js';\nconsole.log(value);\n");
  writeFile(path.join(src, 'dep.js'), 'export const value = 1;\n');
  return { dir, src, entry: path.join(src, 'entry.js'), dep: path.join(src, 'dep.js') };
}

function closeWatching(watching, compiler) {
  return new Promise((resolve) => watching.close(() => compiler.close(() => resolve())));
}

const live = new Set();
afterEach(async () => {
  for (const teardown of [...live]) {
    live.delete(teardown);
    await teardown();
  }
});
afterAll(() => cleanupTempDirs());

describe('Rspack-specific: persistent cache', () => {
  it('rebuilds with the edited source, not a stale cache entry, across a cache-eligible restart', async () => {
    // Rspack's persistent cache reuses the previous compilation's module graph for anything its
    // own snapshot machinery considers unchanged, and folds `compiler.modifiedFiles` /
    // `compiler.removedFiles` (the sets this plugin's `watchFileSystem.watch()` callback
    // populates every cycle -- see `webpack-plugin.js`) into that snapshot invalidation. If this
    // plugin ever reported a changed file late, dropped it, or reported it under the wrong path,
    // Rspack's cache would judge the module unchanged and emit last build's bytes: a stale build
    // that a plain rebuild-count assertion cannot distinguish from a correct one.
    const project = fixture();
    const cacheDir = path.join(project.dir, '.rspack-cache');
    const plugin = new RetriggerWebpackPlugin({ watchPaths: [project.src], aggregateTimeout: 10 });
    const compiler = webpack({
      mode: 'development',
      devtool: false,
      context: project.dir,
      entry: project.entry,
      output: { path: path.join(project.dir, 'dist'), filename: 'bundle.js' },
      plugins: [plugin],
      infrastructureLogging: { level: 'error' },
      stats: 'errors-only',
      cache: { type: 'persistent', storage: { type: 'filesystem', directory: cacheDir } },
    });

    const builds = [];
    const errors = [];
    const watching = compiler.watch({ aggregateTimeout: 10 }, (err, stats) => {
      if (err) errors.push(err);
      else builds.push(stats);
    });
    live.add(() => closeWatching(watching, compiler));

    await waitFor(() => builds.length >= 1, { message: 'initial cached build' });
    expect(errors).toEqual([]);
    const out = path.join(project.dir, 'dist', 'bundle.js');
    expect(fs.readFileSync(out, 'utf8')).toContain('value = 1');

    // Prove the watch is live before the edit the assertion rests on (same discipline as
    // `webpack.test.mjs`'s sentinel writes) so a silent failure to attach can't masquerade as "no
    // change happened yet".
    const sentinel = path.join(project.src, 'live.probe');
    await waitFor(
      () => {
        writeFile(sentinel, `probe ${Date.now()}`);
        return plugin.fileTimeInfo.has(sentinel);
      },
      { timeout: 15000, interval: 50, message: 'watcher delivering events' }
    );

    writeFile(project.dep, 'export const value = 2;\n');
    await waitFor(
      () => {
        if (builds.length < 2) return false;
        return fs.existsSync(out) && fs.readFileSync(out, 'utf8').includes('value = 2');
      },
      {
        timeout: 20000,
        message: 'persistent-cache rebuild emits the edited source, not a cache hit',
      }
    );
    expect(errors).toEqual([]);
    expect(
      fs.readFileSync(out, 'utf8'),
      'the stale value must not survive in the cached rebuild'
    ).not.toContain('value = 1');
  });
});
