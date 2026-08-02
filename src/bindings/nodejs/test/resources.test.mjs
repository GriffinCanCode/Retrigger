import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { Retrigger } from '../lib/retrigger.js';
import { JsWatcher } from '../lib/js-watcher.js';
import { cleanupTempDirs, tempDir, waitFor, writeFile } from './helpers/tmp.js';

afterAll(cleanupTempDirs);

/**
 * Handle accounting. `process.getActiveResourcesInfo()` lists libuv resources
 * by type, which is exactly what leaks show up in: `FSEventWrap`/`StatWatcher`
 * for watchers and `Timeout` for the drain interval.
 */
function activeCounts() {
  const counts = new Map();
  for (const kind of process.getActiveResourcesInfo()) {
    counts.set(kind, (counts.get(kind) || 0) + 1);
  }
  return counts;
}

function countOf(kind) {
  return activeCounts().get(kind) || 0;
}

/** Every resource type a watcher can plausibly create. */
const WATCHED_KINDS = ['FSEventWrap', 'StatWatcher', 'FSReqCallback', 'Timeout'];

function watcherResourceTotal() {
  const counts = activeCounts();
  return WATCHED_KINDS.reduce((sum, kind) => sum + (counts.get(kind) || 0), 0);
}

/** Let libuv actually retire closed handles before counting. */
async function settle() {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 30));
}

describe('resource hygiene', () => {
  it('releases every watcher handle and timer after stop()', async () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
    await settle();
    const baseline = watcherResourceTotal();

    const watcher = new Retrigger({ paths: dir, engine: 'javascript' });
    watcher.start();
    writeFile(path.join(dir, 'a', 'b', 'f.js'), 'x');
    await waitFor(() => watcher.getStats().eventsDelivered > 0, {
      timeout: 15000,
      message: 'no events before the leak check',
    });
    expect(watcherResourceTotal()).toBeGreaterThan(baseline);

    watcher.stop();
    await settle();
    expect(watcherResourceTotal()).toBe(baseline);
  });

  it('does not accumulate handles across repeated start/stop cycles', async () => {
    const dir = tempDir();
    for (let i = 0; i < 6; i += 1) {
      fs.mkdirSync(path.join(dir, `d${i}`), { recursive: true });
    }
    const watcher = new Retrigger({ paths: dir, engine: 'javascript' });

    watcher.start();
    await settle();
    watcher.stop();
    await settle();
    const afterFirstCycle = watcherResourceTotal();

    for (let i = 0; i < 10; i += 1) {
      watcher.start();
      writeFile(path.join(dir, `cycle-${i}.js`), String(i));
      await settle();
      watcher.stop();
      await settle();
    }
    expect(watcherResourceTotal()).toBe(afterFirstCycle);
    watcher.close();
  });

  it('closes every directory watcher the engine opened', async () => {
    const dir = tempDir();
    for (let i = 0; i < 12; i += 1) {
      fs.mkdirSync(path.join(dir, `nested-${i}`, 'inner'), { recursive: true });
    }
    const engine = new JsWatcher({});
    engine.watch(dir, true);
    engine.start();
    // 1 root + 12 nested + 12 inner
    expect(engine.openDirectoryCount).toBe(25);
    engine.stop();
    expect(engine.openDirectoryCount).toBe(0);
  });

  it('leaves no drain timer behind after close()', async () => {
    await settle();
    const before = countOf('Timeout');
    const watcher = new Retrigger({ paths: tempDir(), engine: 'javascript' });
    watcher.start();
    // Sampled with no await in between, so the delta is unambiguously ours.
    expect(countOf('Timeout')).toBe(before + 1);

    watcher.close();
    expect(watcher._timer).toBeNull();
    // The count is process-global and the runner owns timers of its own, so
    // converge on it rather than sampling once and blaming the watcher.
    await waitFor(() => countOf('Timeout') <= before, {
      timeout: 2000,
      message: `drain timer still active (before=${before})`,
    });
  });

  it('clears pending debounce timers on stop instead of firing them later', async () => {
    const dir = tempDir();
    const events = [];
    const watcher = new Retrigger({ paths: dir, engine: 'javascript', debounceMs: 400 });
    watcher.on('all', (e) => events.push(e));
    watcher.start();
    writeFile(path.join(dir, 'pending.js'), 'x');
    await new Promise((resolve) => setTimeout(resolve, 50));
    watcher.stop();
    await settle();
    const timersAfterStop = countOf('Timeout');
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(events).toHaveLength(0);
    expect(countOf('Timeout')).toBeLessThanOrEqual(timersAfterStop);
    watcher.close();
  });

  it('tolerates stop() before start() and double close()', () => {
    const watcher = new Retrigger({ engine: 'javascript' });
    expect(() => watcher.stop()).not.toThrow();
    expect(() => watcher.close()).not.toThrow();
    expect(() => watcher.close()).not.toThrow();
    expect(watcher.isRunning).toBe(false);
  });

  it('unrefs its drain timer when asked, so it cannot hold the process open', () => {
    const watcher = new Retrigger({ paths: tempDir(), engine: 'javascript', unref: true });
    watcher.start();
    expect(watcher._timer.hasRef()).toBe(false);
    watcher.close();
  });
});
