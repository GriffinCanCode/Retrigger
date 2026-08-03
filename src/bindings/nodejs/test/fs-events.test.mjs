import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { Retrigger } from '../lib/retrigger.js';
import {
  cleanupTempDirs,
  tempDir,
  waitFor,
  waitForQuiet,
  waitUntilLive,
  writeFile,
} from './helpers/tmp.js';

afterAll(cleanupTempDirs);

/**
 * Real filesystem behaviour of the JavaScript engine, including the cases that
 * are awkward rather than convenient: unicode names, spaces, deep nesting,
 * directory churn and several hundred files at once.
 */
describe('JavaScript engine against a real filesystem', () => {
  /** @type {Retrigger[]} */
  const open = [];
  afterEach(() => {
    while (open.length) open.pop().close();
  });

  async function start(dir, options = {}) {
    const events = [];
    const watcher = new Retrigger({ paths: dir, engine: 'javascript', ...options });
    watcher.on('all', (e) => events.push(e));
    watcher.start();
    open.push(watcher);
    await waitUntilLive(dir, events);
    return { events, watcher };
  }

  const pathsOf = (events, kind) =>
    events.filter((e) => e.kind === kind && !e.isDirectory).map((e) => e.path);

  it('handles filenames with spaces, unicode and punctuation', async () => {
    const dir = tempDir();
    const { events } = await start(dir);
    const names = [
      'a file with spaces.js',
      'ünïcödé-ñame.ts',
      '世界.tsx',
      'emoji-🎉-file.css',
      "quote's and (parens).json",
      'dots.in.the.name.mjs',
    ];
    for (const name of names) writeFile(path.join(dir, name), 'x');
    await waitFor(
      () => names.every((n) => pathsOf(events, 'created').includes(path.join(dir, n))),
      {
        timeout: 8000,
        message: `missing: ${names
          .filter((n) => !pathsOf(events, 'created').includes(path.join(dir, n)))
          .join(', ')}`,
      }
    );
  });

  it('reports every file in a rapid churn of several hundred files', async () => {
    const dir = tempDir();
    const { events, watcher } = await start(dir, { capacity: 65536 });
    const count = 400;
    for (let i = 0; i < count; i += 1) {
      fs.writeFileSync(path.join(dir, `churn-${i}.js`), `export const i = ${i};`);
      // Yielded periodically, because the watcher collects its notifications on this same event
      // loop. A churn of this size in the real world comes from another process -- a checkout, an
      // install, a build writing its output -- and leaves the loop free to keep up. A synchronous
      // 400-write loop instead starves the reader for the whole burst, and where the OS holds
      // pending notifications in a fixed buffer rather than a kernel queue, the ones that arrive
      // with nobody to collect them are discarded. That measures the loop, not the watcher.
      if (i % 25 === 24) await new Promise((resolve) => setImmediate(resolve));
    }
    await waitFor(() => new Set(pathsOf(events, 'created')).size >= count, {
      timeout: 20000,
      message: () => `only saw ${new Set(pathsOf(events, 'created')).size}/${count}`,
    });
    expect(watcher.getStats().eventsDropped).toBe(0);
  });

  it('follows directories created several levels deep after start', async () => {
    const dir = tempDir();
    const { events } = await start(dir);
    const deep = path.join(dir, 'l1', 'l2', 'l3', 'l4');
    fs.mkdirSync(deep, { recursive: true });
    const target = path.join(deep, 'buried.js');
    writeFile(target, 'buried');
    await waitFor(() => pathsOf(events, 'created').includes(target), {
      timeout: 8000,
      message: 'deeply nested late file missed',
    });
  });

  it('recovers files written into a directory before the watch attaches', async () => {
    const dir = tempDir();
    const { events } = await start(dir);
    const sub = path.join(dir, 'prefilled');
    // Build the tree elsewhere, then move it in as one atomic operation, so the
    // directory already has contents the instant it becomes visible.
    const staging = path.join(tempDir(), 'staging');
    fs.mkdirSync(staging, { recursive: true });
    for (let i = 0; i < 5; i += 1) writeFile(path.join(staging, `pre-${i}.js`), String(i));
    fs.renameSync(staging, sub);

    await waitFor(
      () => {
        const created = new Set(pathsOf(events, 'created'));
        return [0, 1, 2, 3, 4].every((i) => created.has(path.join(sub, `pre-${i}.js`)));
      },
      { timeout: 8000, message: 'files moved in with their directory were missed' }
    );
  });

  it('stops reporting a subtree once its directory is deleted', async () => {
    const dir = tempDir();
    const sub = path.join(dir, 'temporary');
    fs.mkdirSync(sub);
    writeFile(path.join(sub, 'inside.js'), 'x');
    const { events } = await start(dir);

    fs.rmSync(sub, { recursive: true, force: true });
    await waitFor(() => events.some((e) => e.path === sub && e.kind === 'deleted'), {
      timeout: 8000,
      message: 'directory deletion not reported',
    });
    await waitForQuiet(() => events.length);

    const before = events.length;
    fs.mkdirSync(sub);
    writeFile(path.join(sub, 'reborn.js'), 'y');
    await waitFor(() => events.length > before, {
      timeout: 8000,
      message: 'recreated directory not picked back up',
    });
  });

  it('watches a single file without reporting its siblings', async () => {
    const dir = tempDir();
    const target = path.join(dir, 'only-this.js');
    const sibling = path.join(dir, 'not-this.js');
    writeFile(target, 'v1');
    writeFile(sibling, 'v1');

    const events = [];
    const watcher = new Retrigger({ engine: 'javascript' });
    watcher.on('all', (e) => events.push(e));
    watcher.add(target);
    watcher.start();
    open.push(watcher);

    // A single-file root cannot be probed with a sentinel file, so the target
    // itself is written until the watcher proves it is delivering.
    await waitFor(
      () => {
        if (events.some((e) => e.path === target)) return true;
        writeFile(target, `warmup-${Date.now()}`);
        return false;
      },
      { timeout: 8000, interval: 50, message: 'single-file watch never came live' }
    );
    events.length = 0;

    writeFile(sibling, 'changed-sibling');
    writeFile(target, 'changed-target');
    await waitFor(() => events.some((e) => e.path === target), {
      timeout: 8000,
      message: 'single-file watch missed its own file',
    });
    await waitForQuiet(() => events.length);
    expect(events.map((e) => e.path)).not.toContain(sibling);
  });

  it('keeps working when a watched directory is removed underneath it', async () => {
    const dir = tempDir();
    const a = path.join(dir, 'a');
    const b = path.join(dir, 'b');
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    const { events, watcher } = await start(dir);

    fs.rmSync(a, { recursive: true, force: true });
    const target = path.join(b, 'survivor.js');
    writeFile(target, 'still here');
    await waitFor(() => pathsOf(events, 'created').includes(target), {
      timeout: 8000,
      message: 'watcher stopped after a sibling directory vanished',
    });
    expect(watcher.isRunning).toBe(true);
  });

  it('emits directory events only when asked', async () => {
    const dir = tempDir();
    const { events } = await start(dir, { emitDirectories: true });
    const sub = path.join(dir, 'visible-dir');
    fs.mkdirSync(sub);
    await waitFor(() => events.some((e) => e.path === sub && e.isDirectory), {
      timeout: 8000,
      message: 'directory event missing',
    });

    const changes = [];
    const seen = [];
    const watcher = new Retrigger({ paths: dir, engine: 'javascript' });
    watcher.on('add', (p) => changes.push(p));
    watcher.on('all', (e) => seen.push(e));
    watcher.start();
    open.push(watcher);
    await waitUntilLive(dir, seen);
    changes.length = 0;

    const sub2 = path.join(dir, 'hidden-dir');
    fs.mkdirSync(sub2);
    // The directory must reach the watcher — it just must not surface as 'add'.
    await waitFor(() => seen.some((e) => e.path === sub2), {
      timeout: 8000,
      message: 'directory never observed by the second watcher',
    });
    await waitForQuiet(() => changes.length);
    expect(changes).not.toContain(sub2);
  });

  it('carries a monotonic timestamp and a real size on file events', async () => {
    const dir = tempDir();
    const { events } = await start(dir);
    const target = path.join(dir, 'sized.js');
    const body = 'x'.repeat(1234);
    writeFile(target, body);
    const event = await waitFor(() => events.find((e) => e.path === target), {
      timeout: 8000,
      message: 'no event for sized file',
    });
    expect(typeof event.timestampNs).toBe('bigint');
    expect(event.timestampNs > 0n).toBe(true);
    expect(event.size).toBe(body.length);
    expect(event.cookie).toBeNull();
    expect(event.isDirectory).toBe(false);
  });
});
