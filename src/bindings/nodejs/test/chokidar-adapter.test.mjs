import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { cleanupTempDirs, tempDir, waitFor, waitForQuiet, writeFile } from './helpers/tmp.js';
import { watch, FSWatcher } from '../lib/chokidar-adapter.js';

afterAll(cleanupTempDirs);

const open = [];
afterEach(async () => {
  while (open.length) {
    try {
      await open.pop().close();
    } catch {
      /* already closed */
    }
  }
});

function makeWatcher(paths, options = {}) {
  const w = watch(paths, { engine: 'javascript', ...options });
  open.push(w);
  return w;
}

describe('chokidar adapter: basic shape', () => {
  it('exports a watch() factory and an FSWatcher class', () => {
    expect(typeof watch).toBe('function');
    expect(typeof FSWatcher).toBe('function');
  });

  it('is already watching once watch() returns -- no separate start()', async () => {
    const dir = tempDir();
    const w = makeWatcher(dir);
    open.push(w);
    const target = path.join(dir, 'auto.js');
    writeFile(target, 'x');
    const seen = [];
    w.on('add', (p) => seen.push(p));
    await waitFor(() => seen.includes(target), {
      message: 'no add event without an explicit start()',
    });
  });

  it('fires ready after the initial scan', async () => {
    const dir = tempDir();
    writeFile(path.join(dir, 'pre-existing.js'), 'x');
    const w = makeWatcher(dir);
    let ready = false;
    w.on('ready', () => (ready = true));
    await waitFor(() => ready, { message: 'ready never fired' });
  });

  it('emits add for a file that existed before the watch began', async () => {
    const dir = tempDir();
    const pre = path.join(dir, 'already-here.js');
    writeFile(pre, 'x');
    const w = makeWatcher(dir);
    const added = [];
    w.on('add', (p) => added.push(p));
    await waitFor(() => added.includes(pre), { message: 'initial scan never reported the file' });
  });

  it('emits addDir for a pre-existing directory', async () => {
    const dir = tempDir();
    const sub = path.join(dir, 'nested');
    fs.mkdirSync(sub);
    const w = makeWatcher(dir);
    const dirs = [];
    w.on('addDir', (p) => dirs.push(p));
    await waitFor(() => dirs.includes(sub), {
      message: 'initial scan never reported the directory',
    });
  });

  it('reports nothing from the initial scan when ignoreInitial is set', async () => {
    const dir = tempDir();
    writeFile(path.join(dir, 'quiet.js'), 'x');
    const w = makeWatcher(dir, { ignoreInitial: true });
    let ready = false;
    w.on('ready', () => (ready = true));
    const added = [];
    w.on('add', (p) => added.push(p));
    await waitFor(() => ready, { message: 'ready never fired' });
    await waitForQuiet(() => added.length, { quietMs: 150 });
    expect(added).toEqual([]);
  });

  it('reports a live add/change/unlink cycle', async () => {
    const dir = tempDir();
    const w = makeWatcher(dir, { ignoreInitial: true });
    const events = [];
    w.on('all', (name, p) => events.push(`${name}:${path.basename(p)}`));
    const target = path.join(dir, 'cycle.js');
    writeFile(target, 'v1');
    await waitFor(() => events.includes('add:cycle.js'), { message: 'no add' });
    writeFile(target, 'v2-longer');
    await waitFor(() => events.includes('change:cycle.js'), { message: 'no change' });
    fs.unlinkSync(target);
    await waitFor(() => events.includes('unlink:cycle.js'), { message: 'no unlink' });
  });
});

describe('chokidar adapter: options', () => {
  it('respects a glob in ignored', async () => {
    const dir = tempDir();
    const w = makeWatcher(dir, { ignored: '**/*.log', ignoreInitial: true });
    const added = [];
    w.on('add', (p) => added.push(p));
    const dropped = path.join(dir, 'drop.log');
    const kept = path.join(dir, 'keep.js');
    writeFile(dropped, 'x');
    writeFile(kept, 'y');
    await waitFor(() => added.includes(kept), { message: 'kept file missed' });
    await waitForQuiet(() => added.length);
    expect(added).not.toContain(dropped);
  });

  it('respects a predicate in ignored', async () => {
    const dir = tempDir();
    const w = makeWatcher(dir, { ignored: (p) => p.endsWith('secret.js'), ignoreInitial: true });
    const added = [];
    w.on('add', (p) => added.push(p));
    const dropped = path.join(dir, 'secret.js');
    const kept = path.join(dir, 'public.js');
    writeFile(dropped, 'x');
    writeFile(kept, 'y');
    await waitFor(() => added.includes(kept), { message: 'kept file missed' });
    await waitForQuiet(() => added.length);
    expect(added).not.toContain(dropped);
  });

  it('resolves relative add() paths against cwd', async () => {
    const dir = tempDir();
    const w = makeWatcher([], { cwd: dir, ignoreInitial: true });
    w.add('.');
    const target = path.join(dir, 'rel.js');
    const added = [];
    w.on('add', (p) => added.push(p));
    writeFile(target, 'x');
    await waitFor(() => added.includes(target), { message: 'relative root never resolved' });
  });

  it('suppresses change for a rewrite with identical bytes (contentHashing)', async () => {
    const dir = tempDir();
    const target = path.join(dir, 'formatted.js');
    writeFile(target, 'v1');
    const w = makeWatcher(dir, { ignoreInitial: true });
    const changes = [];
    w.on('change', (p) => changes.push(p));

    writeFile(target, 'v2');
    await waitFor(() => changes.includes(target), { message: 'first edit missed' });
    await waitForQuiet(() => changes.length, { quietMs: 150 });

    const before = changes.length;
    writeFile(target, 'v2'); // byte-identical rewrite
    await waitForQuiet(() => changes.length, { quietMs: 300 });
    expect(changes.length, 'a no-op rewrite must not fire change').toBe(before);
  });

  it('still fires change for a no-op rewrite when contentHashing is off', async () => {
    const dir = tempDir();
    const target = path.join(dir, 'raw.js');
    writeFile(target, 'v1');
    const w = makeWatcher(dir, { ignoreInitial: true, contentHashing: false });
    const changes = [];
    w.on('change', (p) => changes.push(p));

    writeFile(target, 'v2');
    await waitFor(() => changes.includes(target), { message: 'first edit missed' });
    await waitForQuiet(() => changes.length, { quietMs: 150 });

    const before = changes.length;
    writeFile(target, 'v2');
    await waitFor(() => changes.length > before, { message: 'no-op rewrite should still fire' });
  });

  it('folds an atomic write-temp-then-rename save into one change (default atomic: true)', async () => {
    const dir = tempDir();
    const target = path.join(dir, 'atomic.js');
    writeFile(target, 'v1');
    const w = makeWatcher(dir, { ignoreInitial: true });
    const seen = [];
    w.on('all', (name, p) => seen.push(`${name}:${path.basename(p)}`));

    const tmp = path.join(dir, '.atomic.js.tmp');
    writeFile(tmp, 'v2');
    fs.renameSync(tmp, target);
    await waitFor(() => seen.some((e) => e.endsWith(':atomic.js')), {
      message: 'no event for the atomic save',
    });
    await waitForQuiet(() => seen.length, { quietMs: 200 });
    expect(seen.filter((e) => e.endsWith(':atomic.js'))).toEqual(['change:atomic.js']);
  });

  it('maps awaitWriteFinish to the Lane 1 stabilizer', async () => {
    const dir = tempDir();
    const target = path.join(dir, 'burst.js');
    const w = makeWatcher(dir, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 20 },
    });
    const changes = [];
    w.on('add', (p) => changes.push(`add:${p}`));
    w.on('change', (p) => changes.push(`change:${p}`));
    writeFile(target, 'v0');
    for (let i = 1; i <= 4; i += 1) {
      await new Promise((r) => setTimeout(r, 15));
      writeFile(target, `v${i}`.padEnd(i + 4, 'x'));
    }
    await waitFor(() => changes.length > 0, {
      message: 'no event after stabilization',
      timeout: 3000,
    });
    await waitForQuiet(() => changes.length, { quietMs: 250 });
    expect(changes.length, `expected one settled event, got ${JSON.stringify(changes)}`).toBe(1);
  });
});

describe('chokidar adapter: add()/unwatch()/getWatched()', () => {
  it('accepts an array of paths in add()', async () => {
    const a = tempDir();
    const b = tempDir();
    const w = makeWatcher([], { ignoreInitial: true });
    w.add([a, b]);
    const added = [];
    w.on('add', (p) => added.push(p));
    writeFile(path.join(a, 'x.js'), '1');
    writeFile(path.join(b, 'y.js'), '2');
    await waitFor(() => added.length >= 2, { message: 'both roots should report' });
  });

  it('stops reporting a root after unwatch(), accepting an array', async () => {
    const a = tempDir();
    const b = tempDir();
    const w = makeWatcher([a, b], { ignoreInitial: true });
    await waitFor(() => Object.keys(w.getWatched()).length > 0, { message: 'watch never settled' });
    w.unwatch([a]);
    const added = [];
    w.on('add', (p) => added.push(p));
    writeFile(path.join(a, 'gone.js'), 'x');
    writeFile(path.join(b, 'kept.js'), 'y');
    await waitFor(() => added.includes(path.join(b, 'kept.js')), {
      message: 'surviving root missed',
    });
    await waitForQuiet(() => added.length);
    expect(added).not.toContain(path.join(a, 'gone.js'));
  });

  it('builds getWatched() from known paths, directory -> child basenames', async () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'sub'));
    writeFile(path.join(dir, 'sub', 'inner.js'), 'x');
    writeFile(path.join(dir, 'top.js'), 'y');
    const w = makeWatcher(dir);
    await waitFor(
      () => {
        const watched = w.getWatched();
        return (watched[dir] || []).includes('sub') && (watched[dir] || []).includes('top.js');
      },
      { message: 'getWatched() incomplete' }
    );
    const watched = w.getWatched();
    expect(watched[path.join(dir, 'sub')]).toContain('inner.js');
  });

  it('emits an error, not a throw, for a path that does not exist', async () => {
    const w = makeWatcher([], {});
    const errors = [];
    w.on('error', (err) => errors.push(err));
    w.add(path.join(tempDir(), 'nope'));
    await waitFor(() => errors.length > 0, { message: 'missing path should error, not hang' });
    expect(errors[0].code).toBe('ENOENT');
  });

  it('close() tears down cleanly and stops emitting', async () => {
    const dir = tempDir();
    const w = makeWatcher(dir, { ignoreInitial: true });
    await w.close();
    let emitted = false;
    w.on('all', () => (emitted = true));
    writeFile(path.join(dir, 'after-close.js'), 'x');
    await waitForQuiet(() => (emitted ? 1 : 0), { quietMs: 200 });
    expect(emitted).toBe(false);
  });
});

// ---------------------------------------------------------------- conformance

/**
 * When `chokidar` itself is present as a devDependency, compare a few core event shapes against
 * the real thing. Skipped, not failed, when it is not installed -- this package never depends on
 * chokidar, so a clean checkout without it (or on a Node below chokidar 5's own v20.19 floor,
 * below this package's own v18.17 floor) must still pass everything else in this file.
 *
 * chokidar 5 is ESM-only (no CommonJS export at all), so this is a dynamic `import()` rather
 * than `require()` -- a static `require('chokidar')` throws `ERR_REQUIRE_ESM` even when the
 * package is installed, which is not the same failure as "not installed" and must not be
 * confused with it.
 */
let realChokidar = null;
try {
  const mod = await import('chokidar');
  realChokidar = typeof mod.watch === 'function' ? mod : mod.default;
} catch {
  realChokidar = null;
}

describe.skipIf(!realChokidar)('conformance against the real chokidar package', () => {
  it('both report add/change/unlink for the same file lifecycle', async () => {
    const dirOurs = tempDir();
    const dirTheirs = tempDir();
    const ours = makeWatcher(dirOurs, { ignoreInitial: true });
    const theirs = realChokidar.watch(dirTheirs, { ignoreInitial: true, persistent: true });
    open.push({ close: () => theirs.close() });

    const oursSeen = [];
    const theirsSeen = [];
    ours.on('all', (name) => oursSeen.push(name));
    theirs.on('all', (name) => theirsSeen.push(name));

    await new Promise((resolve) => theirs.once('ready', resolve));

    const fileOurs = path.join(dirOurs, 'x.js');
    const fileTheirs = path.join(dirTheirs, 'x.js');
    writeFile(fileOurs, 'v1');
    writeFile(fileTheirs, 'v1');
    await waitFor(() => oursSeen.includes('add') && theirsSeen.includes('add'), {
      message: 'both should report add',
    });

    writeFile(fileOurs, 'v2-longer');
    writeFile(fileTheirs, 'v2-longer');
    await waitFor(() => oursSeen.includes('change') && theirsSeen.includes('change'), {
      message: 'both should report change',
    });

    fs.unlinkSync(fileOurs);
    fs.unlinkSync(fileTheirs);
    await waitFor(() => oursSeen.includes('unlink') && theirsSeen.includes('unlink'), {
      message: 'both should report unlink',
    });
  });
});
