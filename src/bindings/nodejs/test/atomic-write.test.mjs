import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { Retrigger } from '../lib/retrigger.js';
import {
  cleanupTempDirs,
  JS_WATCHER_SUPPORTED,
  sleep,
  tempDir,
  waitFor,
  waitForQuiet,
  waitUntilLive,
  writeFile,
} from './helpers/tmp.js';

afterAll(cleanupTempDirs);

/**
 * `atomicWriteNormalization` on the JavaScript engine, which is a best-effort heuristic rather
 * than the native engine's exact `RenamedTo` fold -- see `lib/js-watcher.js`'s class doc comment.
 *
 * A literal editor save (write a sibling temp file, `rename` it over the target) does not
 * actually reach this engine as a `deleted`/`created` pair on a same-filesystem rename: the
 * rename is atomic at the kernel level, so by the time `fs.watch`'s own delivery latency lets the
 * watcher re-`stat` the path, it already finds the new content and reports `modified` directly,
 * with or without this option. What this heuristic exists for is the case that genuinely does
 * pass through an observable gap -- a tool that unlinks the old file and only then writes the new
 * one, or a rename whose two kernel notifications this engine's callback happens to observe on
 * either side of the gap -- which is what these tests reproduce directly, rather than via a
 * same-filesystem `rename()` that this platform's `fs.watch` never lets fall through as a pair.
 */
describe.skipIf(!JS_WATCHER_SUPPORTED)('atomicWriteNormalization (JavaScript engine)', () => {
  /** @type {Retrigger[]} */
  const open = [];
  afterEach(() => {
    while (open.length) open.pop().close();
  });

  async function start(dir, options = {}) {
    const events = [];
    const watcher = new Retrigger({ paths: dir, engine: 'javascript', ...options });
    // The public, chokidar-style names this test asserts on -- not `all`'s contract-kind events,
    // which is what `fs-events.test.mjs` uses instead (`created`/`modified`/`deleted`).
    for (const name of ['add', 'change', 'unlink']) {
      watcher.on(name, (p) => events.push({ kind: name, path: p }));
    }
    // `waitUntilLive`'s directory sentinel is never emitted as `add` (directories are `all`-only
    // unless `emitDirectories` is set), so liveness has to be judged off `all` regardless of what
    // this test itself listens for.
    const liveness = [];
    watcher.on('all', (e) => liveness.push(e));
    watcher.start();
    open.push(watcher);
    await waitUntilLive(dir, liveness);
    return { events, watcher };
  }

  /**
   * Delete `target`, then recreate it a short moment later -- long enough for the deletion to be
   * observed on its own (proven separately in the "off" test below), short enough to land well
   * inside the heuristic's fold window.
   */
  async function deleteThenRecreate(target, contents) {
    fs.rmSync(target);
    await sleep(30);
    writeFile(target, contents);
  }

  it('folds a delete immediately followed by a recreate into one change event when enabled', async () => {
    const dir = tempDir();
    const target = path.join(dir, 'config.json');
    writeFile(target, '{"v":1}');
    const { events } = await start(dir, { atomicWriteNormalization: true });
    // `start()`'s own liveness probe (directory creations elsewhere in `dir`) can trigger a stray
    // notification against an unrelated pre-existing path on this platform's `fs.watch` -- a
    // known coalescing quirk, not something either engine claims to avoid. Cleared here so only
    // the operation under test is on record.
    events.length = 0;

    await deleteThenRecreate(target, '{"v":2}');

    await waitFor(() => events.some((e) => e.path === target && e.kind === 'change'), {
      timeout: 8000,
      message: 'folded change event never arrived',
    });
    await waitForQuiet(() => events.length);

    const forTarget = events.filter((e) => e.path === target);
    expect(forTarget.map((e) => e.kind)).toEqual(['change']);
  });

  it('still delivers separate unlink and add events when the option is off (default)', async () => {
    const dir = tempDir();
    const target = path.join(dir, 'config.json');
    writeFile(target, '{"v":1}');
    // No `atomicWriteNormalization` -- the default, exercised explicitly rather than merely by
    // omission, so this test fails loudly if the default itself ever changes.
    const { events } = await start(dir, { atomicWriteNormalization: false });
    // See the sibling test above for why this is cleared before the real operation.
    events.length = 0;

    await deleteThenRecreate(target, '{"v":2}');

    await waitFor(() => events.some((e) => e.path === target && e.kind === 'add'), {
      timeout: 8000,
      message: 'recreate was never reported as a separate add',
    });
    await waitForQuiet(() => events.length);

    const forTarget = events.filter((e) => e.path === target);
    expect(forTarget.map((e) => e.kind)).toEqual(['unlink', 'add']);
  });
});
