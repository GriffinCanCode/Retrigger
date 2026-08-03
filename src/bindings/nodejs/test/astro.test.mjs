import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { tempDir, cleanupTempDirs, waitFor, waitForQuiet, writeFile } = require('./helpers/tmp.js');
const { createRetriggerVitePlugin, normalizePath } = require('../plugins/vite-plugin.js');

/**
 * Astro's dev server resolves its own runtime (`astro/app`, the virtual `astro:server-app`
 * module, ...) the same way Node resolves any bare specifier: by walking up from the project
 * `root`. A fixture under `os.tmpdir()` has no `node_modules` of its own, so it is given one --
 * a symlink to this package's, which is where the `astro` this suite imports actually lives.
 */
function fixture() {
  const dir = fs.realpathSync(tempDir('retrigger-astro-'));
  fs.mkdirSync(path.join(dir, 'src', 'pages'), { recursive: true });
  writeFile(
    path.join(dir, 'src', 'pages', 'index.astro'),
    '---\nconst msg = "hello";\n---\n<html><body>{msg}</body></html>\n'
  );
  fs.symlinkSync(path.join(HERE, '..', 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  return { dir, page: path.join(dir, 'src', 'pages', 'index.astro') };
}

/**
 * Astro requires Node >=22.12.0 (`node_modules/astro/package.json#engines`); this suite reads
 * that requirement rather than hard-coding it, so a future Astro major raising or lowering the
 * floor changes what gets skipped without an edit here. Skipped, not failed, so `npm test` stays
 * green on every Node version this package itself supports (18.17.0+).
 */
function astroSupportsThisNode() {
  const engines = require('astro/package.json').engines || {};
  const required = /^>=\s*(\d+)\.(\d+)/.exec(engines.node || '');
  if (!required) return true;
  const [, major, minor] = required.map(Number);
  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
  return nodeMajor > major || (nodeMajor === major && nodeMinor >= minor);
}

const live = new Set();

afterEach(async () => {
  for (const server of [...live]) {
    live.delete(server);
    try {
      await server.stop();
    } catch {
      /* already stopped */
    }
  }
});

afterAll(() => cleanupTempDirs());

describe.skipIf(!astroSupportsThisNode())('astro dev server', () => {
  it('watches through Astro\u2019s Vite layer and detects a real edit', async () => {
    const { dev } = await import('astro');
    const project = fixture();
    const plugin = createRetriggerVitePlugin({ engine: 'javascript', debounceMs: 0 });

    const server = await dev({
      root: project.dir,
      configFile: false,
      logLevel: 'silent',
      server: { port: 0, host: '127.0.0.1' },
      vite: { plugins: [plugin] },
    });
    live.add(server);

    await waitFor(() => plugin.api.isWatching(), { message: 'watcher started under Astro' });
    // Astro's own config disables its inline chokidar the same way a plain Vite project's does.
    expect(server.watcher.constructor.name).toBe('NoopWatcher');

    const changes = [];
    server.watcher.on('change', (file) => changes.push(file));

    writeFile(project.page, '---\nconst msg = "changed";\n---\n<html><body>{msg}</body></html>\n');
    await waitFor(() => changes.includes(normalizePath(project.page)), {
      timeout: 15000,
      message: 'Retrigger-driven change reached server.watcher through Astro',
    });
  });

  it('suppresses a byte-identical rewrite the same way the plain Vite plugin does', async () => {
    const { dev } = await import('astro');
    const project = fixture();
    const plugin = createRetriggerVitePlugin({ engine: 'javascript', debounceMs: 0 });

    const server = await dev({
      root: project.dir,
      configFile: false,
      logLevel: 'silent',
      server: { port: 0, host: '127.0.0.1' },
      vite: { plugins: [plugin] },
    });
    live.add(server);
    await waitFor(() => plugin.api.isWatching(), { message: 'watcher started under Astro' });

    const changes = [];
    server.watcher.on('change', (file) => changes.push(file));

    const contents = '---\nconst msg = "primed";\n---\n<html><body>{msg}</body></html>\n';
    writeFile(project.page, contents);
    await waitFor(() => changes.includes(normalizePath(project.page)), {
      timeout: 15000,
      message: 'the priming edit reached server.watcher',
    });
    const hashed = () => plugin.api.getStats().watcher.content.filesHashed;
    await waitForQuiet(hashed, { quietMs: 300, timeout: 3000 });

    const before = changes.length;
    writeFile(project.page, contents);
    await waitFor(() => plugin.api.getStats().metrics.eventsUnchanged > 0, {
      timeout: 10000,
      message: 'the no-op write was observed and classified',
    });
    const after = await waitForQuiet(() => changes.length, { quietMs: 300, timeout: 3000 });
    expect(after, 'an identical-byte rewrite must not reach server.watcher').toBe(before);
  });

  it('tears down cleanly when Astro stops its dev server', async () => {
    const { dev } = await import('astro');
    const project = fixture();
    const plugin = createRetriggerVitePlugin({ engine: 'javascript', debounceMs: 0 });

    const server = await dev({
      root: project.dir,
      configFile: false,
      logLevel: 'silent',
      server: { port: 0, host: '127.0.0.1' },
      vite: { plugins: [plugin] },
    });
    live.add(server);
    await waitFor(() => plugin.api.isWatching(), { message: 'watcher started under Astro' });

    await server.stop();
    live.delete(server);
    expect(plugin.api.isWatching()).toBe(false);
  });
});
