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

/**
 * Whether Astro can actually be imported here. Astro's compiler is a native addon
 * (`@astrojs/compiler-binding-*`) with no build for every platform this package targets -- FreeBSD,
 * for one, has no `@astrojs/compiler-binding-freebsd-x64`. Where the addon is missing, importing
 * `astro` throws "Cannot find native binding", which is a fact about Astro's platform matrix, not a
 * defect in this plugin. Probed once, so the suite skips (not fails) exactly as the Node-version
 * gate above does -- the same "green on every environment this package itself supports" contract.
 */
async function astroCanLoad() {
  if (!astroSupportsThisNode()) return false;
  try {
    await import('astro');
    return true;
  } catch {
    return false;
  }
}

const ASTRO_AVAILABLE = await astroCanLoad();

/**
 * Prove the watcher is delivering before an assertion that depends on it. `fs.watch` is not armed
 * synchronously -- its event thread starts a beat after `dev()` resolves -- so a lone edit can land
 * in the arming gap and never arrive, which on the slower CI runners (Windows) times the wait out.
 * Re-write with distinct bytes until one edit is seen, then return the bytes now on disk so a
 * follow-up byte-identical test can rewrite exactly them.
 *
 * @param {string} page the `.astro` file to edit
 * @param {string[]} changes paths the suite is collecting `server.watcher` change events into
 * @returns {Promise<string>} the file contents left on disk once an edit was observed
 */
async function primeUntilDelivered(page, changes, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let payload = '';
  for (let attempt = 0; Date.now() < deadline; attempt += 1) {
    payload = `---\nconst msg = "primed-${attempt}";\n---\n<html><body>{msg}</body></html>\n`;
    writeFile(page, payload);
    const until = Date.now() + 500;
    while (Date.now() < until) {
      if (changes.includes(normalizePath(page))) return payload;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error('the priming edit never reached server.watcher');
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

describe.skipIf(!ASTRO_AVAILABLE)('astro dev server', () => {
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

    await primeUntilDelivered(project.page, changes);
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

    const contents = await primeUntilDelivered(project.page, changes);
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
