/**
 * The Watchman engine.
 *
 * `detectWatchman()` decides everything here: when it finds neither the `fb-watchman` client nor
 * the `watchman` binary, the degradation suite below is what actually runs in CI, and the
 * behavioural corpus (`runEngineSuite`) is skipped rather than failed -- this file must be green
 * on a machine with no Watchman installed at all, which is the common case for a contributor's
 * laptop and for CI.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { WatchmanWatcher, detectWatchman, resetWatchmanCache } from '../lib/watchman-watcher.js';
import { getEngine, getEngineInfo, resetEngineCache } from '../lib/engine.js';
import { Retrigger } from '../lib/retrigger.js';
import { cleanupTempDirs, tempDir, waitFor, writeFile } from './helpers/tmp.js';
import { runEngineSuite } from './shared/engine-suite.mjs';

afterAll(cleanupTempDirs);

const PROBE = detectWatchman();
const AVAILABLE = Boolean(PROBE.kind);

describe('detectWatchman', () => {
  it('never throws, and reports a kind or a reason', () => {
    const probe = detectWatchman({ fresh: true });
    expect([null, 'fb-watchman', 'cli']).toContain(probe.kind);
    expect(typeof probe.reason).toBe('string');
    expect(probe.reason.length).toBeGreaterThan(0);
  });

  it('honours RETRIGGER_NO_WATCHMAN unconditionally', () => {
    const probe = detectWatchman({ env: { RETRIGGER_NO_WATCHMAN: '1' }, fresh: true });
    expect(probe.kind).toBeNull();
    expect(probe.reason).toContain('RETRIGGER_NO_WATCHMAN');
  });

  it('memoises until reset', () => {
    resetWatchmanCache();
    const first = detectWatchman();
    const second = detectWatchman();
    expect(second).toBe(first);
    resetWatchmanCache();
    const third = detectWatchman();
    expect(third).not.toBe(first);
    expect(third).toEqual(first);
  });
});

describe('engine selection: prefer "watchman"', () => {
  it('is never auto-selected', () => {
    resetEngineCache();
    const engine = getEngine({ fresh: true });
    expect(engine.name).not.toBe('watchman');
  });

  it('reports availability unconditionally through getEngineInfo()', () => {
    const info = getEngineInfo();
    expect(typeof info.watchman.available).toBe('boolean');
    expect(info.watchman.available).toBe(AVAILABLE);
    expect(info.watchman.reason).toBe(PROBE.reason);
  });

  it.skipIf(AVAILABLE)('degrades cleanly to native/JavaScript when unavailable', () => {
    // The header case for a machine with no Watchman: asking for it by name must behave exactly
    // like asking for 'auto' -- same resolved engine, same absence of a throw -- with one
    // documented warning line rather than silence or a crash.
    resetEngineCache();
    const engine = getEngine({ prefer: 'watchman', fresh: true, env: { RETRIGGER_SILENT: '1' } });
    expect(['native', 'javascript']).toContain(engine.name);
    const auto = getEngine({ fresh: true, env: { RETRIGGER_SILENT: '1' } });
    expect(engine.name).toBe(auto.name);
  });

  it.skipIf(AVAILABLE)(
    'a Retrigger built with engine: "watchman" still watches, via the fallback',
    async () => {
      const dir = tempDir();
      const previous = process.env.RETRIGGER_SILENT;
      process.env.RETRIGGER_SILENT = '1';
      const watcher = new Retrigger({ paths: dir, engine: 'watchman', debounceMs: 0 });
      try {
        expect(watcher.engine.name).not.toBe('watchman');
        const events = [];
        watcher.on('all', (e) => events.push(e));
        watcher.start();
        const target = path.join(dir, 'fallback.js');
        writeFile(target, 'x');
        await waitFor(() => events.some((e) => e.path === target), {
          message: 'fallback engine never delivered an event',
        });
      } finally {
        watcher.close();
        if (previous === undefined) delete process.env.RETRIGGER_SILENT;
        else process.env.RETRIGGER_SILENT = previous;
      }
    }
  );
});

describe.skipIf(!AVAILABLE)('Watchman engine (real service detected)', () => {
  it('is genuinely selected when explicitly requested', () => {
    resetEngineCache();
    const engine = getEngine({ prefer: 'watchman', fresh: true });
    expect(engine.name).toBe('watchman');
    expect(engine.hashAlgorithm).toBe('xxh3-64');
  });

  it('watches through the "watchman" backend label', () => {
    const watcher = new WatchmanWatcher({}, PROBE);
    expect(watcher.backend()).toBe('watchman');
    watcher.stop();
  });

  it('provides a genuine Watchman-backed change-since query', async () => {
    const dir = tempDir();
    const watcher = new WatchmanWatcher({}, PROBE);
    try {
      watcher.watch(dir, true);
      watcher.start();
      await new Promise((resolve) => setTimeout(resolve, 200)); // let the initial clock settle
      const before = await watcher.changesSince(dir);
      const target = path.join(dir, 'since.js');
      writeFile(target, 'x');
      await waitFor(
        async () => {
          const since = await watcher.changesSince(dir, before.clock);
          return since.entries.some((e) => e.path === target && e.isNew);
        },
        { message: 'changesSince never reported the new file' }
      );
    } finally {
      watcher.stop();
    }
  });

  it('crawls a directory via snapshot()', async () => {
    const dir = tempDir();
    writeFile(path.join(dir, 'a.txt'), 'x');
    fs.mkdirSync(path.join(dir, 'sub'));
    writeFile(path.join(dir, 'sub', 'b.txt'), 'y');
    const watcher = new WatchmanWatcher({}, PROBE);
    try {
      const snap = await watcher.snapshot(dir);
      expect(snap.algorithm).toBe('xxh3-64');
      const paths = snap.entries.map((e) => e.path);
      expect(paths).toContain(path.join(dir, 'a.txt'));
      expect(paths).toContain(path.join(dir, 'sub', 'b.txt'));
    } finally {
      watcher.stop();
    }
  });

  // The full behavioural corpus, exactly as the native and JavaScript engines are held to it.
  runEngineSuite('watchman (real service)', (options = {}) => {
    return new Retrigger({ ...options, engine: 'watchman' });
  });
});
