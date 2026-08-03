import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
process.env.RETRIGGER_NATIVE_PATH = path.join(HERE, 'helpers', 'mock-native.js');
process.env.RETRIGGER_SILENT = '1';

import { BoundedSet } from '../lib/bounded.js';
import { hashBytesSync, hashFile, hashFileSync } from '../lib/hash-js.js';
import { JsWatcher, RECURSIVE_WATCH } from '../lib/js-watcher.js';
import { Retrigger } from '../lib/retrigger.js';
import RetriggerWebpackPlugin from '../plugins/webpack-plugin.js';
import { cleanupTempDirs, tempDir, waitFor } from './helpers/tmp.js';

afterAll(cleanupTempDirs);

/**
 * What the watcher retains, rather than what it reports.
 *
 * A dev server runs for hours. The failure this suite is looking for is not a wrong event, it is a
 * process that has quietly grown to a gigabyte because something kept every path it ever saw, or one
 * timer per changed file, or a delivered event that the queue never let go of.
 *
 * These are white-box tests by necessity — the assertions are about internal structures, and there is
 * no public API that reports "how many timers are live". They follow the convention the queue suite
 * already sets: reach inside when the alternative is an assertion that depends on how fast the
 * operating system happens to deliver notifications.
 */

/** Enough distinct paths that a per-path leak is unmistakable. */
const FLOOD = 50_000;

const syntheticEvent = (i) => ({
  path: `/synthetic/module${i}/index.ts`,
  kind: 'modified',
  timestampNs: 0n,
  size: 0,
  isDirectory: false,
  cookie: null,
});

describe('BoundedSet', () => {
  it('holds a hard ceiling however many distinct keys arrive', () => {
    const set = new BoundedSet(512);
    for (let i = 0; i < FLOOD; i += 1) {
      set.add(`/repo/packages/pkg${i}/src/index.ts`);
      expect(set.size).toBeLessThanOrEqual(512);
    }
  });

  it('never forgets a key that is re-added on every pass', () => {
    // The agent-editing-one-file shape: the entry that matters is the one being touched, and it must
    // survive any amount of unrelated churn.
    const set = new BoundedSet(64);
    const hot = '/repo/src/being-edited.ts';
    for (let i = 0; i < 20_000; i += 1) {
      set.add(`/repo/cold/file${i}.ts`);
      set.add(hot);
      expect(set.has(hot)).toBe(true);
    }
  });

  it('reports itself exact until it actually drops something', () => {
    // The distinction the watcher relies on to avoid turning a memory bound into a lost deletion.
    const set = new BoundedSet(64);
    for (let i = 0; i < 31; i += 1) set.add(`/a/${i}`);
    expect(set.forgotten).toBe(false);
    for (let i = 0; i < 500; i += 1) set.add(`/b/${i}`);
    expect(set.forgotten).toBe(true);
    set.clear();
    expect(set.forgotten).toBe(false);
    expect(set.size).toBe(0);
  });

  it('remembers and forgets individual keys', () => {
    const set = new BoundedSet(64);
    set.add('/a/one');
    expect(set.has('/a/one')).toBe(true);
    expect(set.delete('/a/one')).toBe(true);
    expect(set.has('/a/one')).toBe(false);
    expect(set.delete('/a/one')).toBe(false);
  });

  it('drops a whole subtree without copying itself', () => {
    const set = new BoundedSet(100_000);
    for (let i = 0; i < 5_000; i += 1) set.add(`/root/node_modules/dep${i}/index.js`);
    set.add('/root/src/app.ts');

    set.deleteMatching((key) => key.startsWith('/root/node_modules/'));
    expect(set.size).toBe(1);
    expect(set.has('/root/src/app.ts')).toBe(true);
  });

  it('still functions with a degenerate ceiling', () => {
    for (const ceiling of [0, 1, 2, 3, NaN, undefined]) {
      const set = new BoundedSet(ceiling);
      for (let i = 0; i < 100; i += 1) set.add(`/x/${i}`);
      expect(set.size).toBeLessThanOrEqual(2);
      expect(set.has('/x/99')).toBe(true);
    }
  });
});

describe('event queue memory', () => {
  it('releases every delivered event and collapses when drained', () => {
    // `poll` used to `shift`, which both moved the whole backlog on every call and left the array
    // holding references to events that had already been handed over.
    const watcher = new JsWatcher({ capacity: 4096 });
    for (let i = 0; i < 3_000; i += 1) watcher._enqueue(syntheticEvent(i));
    expect(watcher.stats().queuePending).toBe(3_000);

    let delivered = 0;
    while (watcher.poll()) delivered += 1;
    expect(delivered).toBe(3_000);
    expect(watcher.stats().queuePending).toBe(0);
    expect(watcher._queue.length).toBe(0);
    expect(watcher._head).toBe(0);
  });

  it('holds no reference to an event that has been polled', () => {
    const watcher = new JsWatcher({ capacity: 16 });
    for (let i = 0; i < 4; i += 1) watcher._enqueue(syntheticEvent(i));
    const first = watcher.poll();
    expect(first.path).toBe('/synthetic/module0/index.ts');
    expect(watcher._queue.includes(first)).toBe(false);
  });

  it('keeps its backing array bounded while draining alongside a producer', () => {
    // The steady state of a dev server: events arriving while the consumer keeps up. The array must
    // not grow without limit just because the cursor keeps advancing through it.
    const watcher = new JsWatcher({ capacity: 512 });
    for (let round = 0; round < 200; round += 1) {
      for (let i = 0; i < 50; i += 1) watcher._enqueue(syntheticEvent(round * 50 + i));
      for (let i = 0; i < 50; i += 1) watcher.poll();
      expect(watcher._queue.length).toBeLessThanOrEqual(512 + 1024);
    }
    expect(watcher.stats().queuePending).toBe(0);
  });

  it('releases the discarded backlog on overflow', () => {
    // Overflow discards the backlog and replaces it with a single marker. The array that held it must
    // be released along with it, rather than truncated and kept at full capacity for the rest of the
    // process's life — a `length = 0` leaves the allocation behind.
    const watcher = new JsWatcher({ capacity: 64 });
    for (let i = 0; i < 64; i += 1) watcher._enqueue(syntheticEvent(i));
    const backlog = watcher._queue;
    expect(backlog.length).toBe(64);

    watcher._enqueue(syntheticEvent(64));
    expect(watcher._queue).not.toBe(backlog);
    expect(watcher._queue.length).toBe(1);
    expect(watcher._queue[0].kind).toBe('rescanRequired');
  });

  it('never exceeds capacity however long the overflow lasts', () => {
    // The backlog refills behind the marker once the queue has room again, so the bound has to hold
    // for the whole episode rather than only at the moment of overflow.
    const watcher = new JsWatcher({ capacity: 64 });
    for (let i = 0; i < 5_000; i += 1) {
      watcher._enqueue(syntheticEvent(i));
      expect(watcher.stats().queuePending).toBeLessThanOrEqual(64);
    }
    expect(watcher.poll().kind).toBe('rescanRequired');
  });
});

describe('debounce buffer memory', () => {
  it('services every pending path with a single timer', async () => {
    // One timer per path meant a tree-wide burst allocated a timer and a closure per changed file,
    // each of which Node holds until it fires.
    const watcher = new JsWatcher({ capacity: 100_000, debounceMs: 20 });
    watcher._running = true;
    for (let i = 0; i < 2_000; i += 1) {
      watcher._enqueueDebounced(`/synthetic/f${i}.ts`, 'modified', false, 0);
    }
    expect(watcher._pending.size).toBeGreaterThan(0);
    expect(watcher._sweep).not.toBeNull();

    await waitFor(() => watcher._pending.size === 0, { timeout: 5_000 });
    expect(watcher._sweep).toBeNull();
    expect(watcher.stats().queuePending).toBeGreaterThan(0);
  });

  it('bounds the buffer rather than holding an unbounded burst', async () => {
    const watcher = new JsWatcher({ capacity: 200_000, debounceMs: 10_000 });
    watcher._running = true;
    for (let i = 0; i < 20_000; i += 1) {
      watcher._enqueueDebounced(`/synthetic/f${i}.ts`, 'modified', false, 0);
    }
    // The buffer holds windows, not events: every path was already reported on the leading edge, so
    // the ceiling costs those paths a *correction* and nothing else. Nothing is withheld and
    // nothing is lost.
    expect(watcher._pending.size).toBeLessThanOrEqual(4096);
    expect(watcher.stats().eventsQueued).toBe(20_000);
  });

  it('collapses repeat writes to one path into one pending entry', async () => {
    // The workload most likely to break it: one file written continuously. Memory must follow the
    // number of distinct paths, not the number of events.
    const watcher = new JsWatcher({ capacity: 1_000, debounceMs: 15 });
    watcher._running = true;
    for (let i = 0; i < 20_000; i += 1) {
      watcher._enqueueDebounced('/synthetic/app.ts', 'modified', false, i);
      expect(watcher._pending.size).toBe(1);
    }
    // Two events for twenty thousand writes: the leading one, and the single correction the window
    // owes once it closes. Memory followed the one distinct path, not the event count.
    await waitFor(() => watcher._pending.size === 0, { timeout: 5_000 });
    expect(watcher.stats().queuePending).toBe(2);
  });

  it('leaves no timer behind after stop', async () => {
    const watcher = new JsWatcher({ capacity: 100, debounceMs: 50 });
    watcher._running = true;
    for (let i = 0; i < 10; i += 1) {
      watcher._enqueueDebounced(`/synthetic/f${i}.ts`, 'modified', false, 0);
    }
    expect(watcher._sweep).not.toBeNull();
    watcher.stop();
    expect(watcher._sweep).toBeNull();
    expect(watcher._pending.size).toBe(0);
  });
});

describe('file hashing memory', () => {
  /** Larger than one chunk, and deliberately not a multiple of it. */
  const CHUNK = 1 << 20;

  it('hashes a multi-chunk file identically to the whole-buffer and streaming paths', async () => {
    // Chunking is only safe if it is invisible in the result. Three oracles at once: the same bytes
    // hashed in one piece, hashed in chunks synchronously, and hashed by the async stream.
    const dir = tempDir();
    const target = path.join(dir, 'big.bin');
    const bytes = Buffer.alloc(CHUNK * 2 + 12_345);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 31 + 7) & 0xff;
    fs.writeFileSync(target, bytes);

    const chunked = hashFileSync(target);
    expect(chunked.size).toBe(bytes.length);
    expect(chunked.hash).toBe(hashBytesSync(bytes));
    await expect(hashFile(target)).resolves.toEqual(chunked);
  });

  it('agrees with the whole-buffer hash at every boundary around a chunk', async () => {
    // Off-by-one at a chunk edge is the classic chunking bug, so the sizes either side of one are
    // checked explicitly rather than left to chance.
    const dir = tempDir();
    for (const size of [0, 1, CHUNK - 1, CHUNK, CHUNK + 1]) {
      const target = path.join(dir, `boundary-${size}.bin`);
      const bytes = Buffer.alloc(size, 0xa5);
      fs.writeFileSync(target, bytes);
      const result = hashFileSync(target);
      expect(result).toEqual({ hash: hashBytesSync(bytes), size });
      await expect(hashFile(target)).resolves.toEqual(result);
    }
  });

  it('hashes a file far larger than its resident buffer', async () => {
    // The point of the exercise: cost is decoupled from file size. 24 MiB is small enough to keep the
    // suite quick and large enough that a whole-file read would be obvious.
    const dir = tempDir();
    const target = path.join(dir, 'huge.bin');
    const block = Buffer.alloc(CHUNK, 0x5c);
    const handle = fs.openSync(target, 'w');
    for (let i = 0; i < 24; i += 1) fs.writeSync(handle, block);
    fs.closeSync(handle);

    const result = hashFileSync(target);
    expect(result.size).toBe(CHUNK * 24);
    await expect(hashFile(target)).resolves.toEqual(result);
  });
});

describe('tracking sets under a churning tree', () => {
  it('forgets a deleted subtree without copying the whole set', async () => {
    // `rm -rf node_modules`: one of these per directory in the tree. Copying the tracking set first
    // made the total cost the product of the two.
    const dir = tempDir();
    const doomed = path.join(dir, 'node_modules');
    for (let i = 0; i < 300; i += 1) {
      fs.mkdirSync(path.join(doomed, `dep${i}`), { recursive: true });
      fs.writeFileSync(path.join(doomed, `dep${i}`, 'index.js'), 'x');
    }
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'y');

    const watcher = new JsWatcher({ capacity: 100_000 });
    watcher.watch(dir, true);
    watcher.start();
    expect(watcher._known.size).toBeGreaterThan(300);
    // Measured on the directory tracking set rather than the handle count, because that is what
    // `_forgetSubtree` prunes on every platform; the handles are one-per-directory only where the
    // watch is, and are checked below where that holds.
    const knownDirs = watcher._knownDirs.size;
    expect(knownDirs).toBeGreaterThan(300);
    const handles = watcher.openDirectoryCount;

    watcher._forgetSubtree(doomed);
    expect(watcher._known.has(path.join(dir, 'src', 'app.ts'))).toBe(true);
    expect(watcher._known.has(path.join(doomed, 'dep0', 'index.js'))).toBe(false);
    expect(watcher._knownDirs.size).toBeLessThan(knownDirs - 300);
    if (!RECURSIVE_WATCH) expect(watcher.openDirectoryCount).toBeLessThan(handles - 300);
    watcher.stop();
    expect(watcher.openDirectoryCount).toBe(0);
  });

  it('bounds remembered paths even as unique names keep arriving', () => {
    // The long-session leak: an agent, a build step, or an editor producing uniquely-named files for
    // hours. The ceiling is a module constant, so it is substituted here to reach it in a test.
    const watcher = new JsWatcher({ capacity: 1_000 });
    watcher._known = new BoundedSet(256);
    for (let i = 0; i < FLOOD; i += 1) {
      watcher._known.add(`/repo/.cache/artifact-${i}.tmp`);
      expect(watcher._known.size).toBeLessThanOrEqual(256);
    }
  });

  it('still reports a deletion for a path it has forgotten', async () => {
    // The hazard bounding the set creates: a deletion used to be suppressed when the path was absent
    // from the set, which after eviction would mean a real deletion silently disappearing.
    const dir = tempDir();
    const target = path.join(dir, 'gone.ts');
    fs.writeFileSync(target, 'x');

    const watcher = new JsWatcher({ capacity: 100 });
    watcher.watch(dir, true);
    watcher.start();
    // Force the set past its ceiling so a miss no longer proves the path was never seen.
    watcher._known = new BoundedSet(4);
    for (let i = 0; i < 50; i += 1) watcher._known.add(`/unrelated/${i}`);
    expect(watcher._known.forgotten).toBe(true);
    expect(watcher._known.has(target)).toBe(false);

    fs.rmSync(target);
    await waitFor(
      () => {
        const events = [];
        for (let event = watcher.poll(); event; event = watcher.poll()) events.push(event);
        return events.some((e) => e.path === target && e.kind === 'deleted');
      },
      { timeout: 5_000 }
    );
    watcher.stop();
  });

  it('suppresses unknown-path noise while the set is still exact', async () => {
    // The other half of that trade: before anything has been forgotten the set is authoritative, so
    // the original suppression must still apply and behaviour for a normal project is unchanged.
    const dir = tempDir();
    const watcher = new JsWatcher({ capacity: 100 });
    watcher.watch(dir, true);
    watcher.start();
    expect(watcher._known.forgotten).toBe(false);

    watcher._onRawEvent(dir, 'rename', 'never-existed.ts');
    expect(watcher.stats().queuePending).toBe(0);
    watcher.stop();
  });
});

describe('drain scheduling', () => {
  /** A started watcher on the JavaScript engine, with `_drain` counted. */
  function counted(options = {}) {
    const retrigger = new Retrigger({ engine: 'javascript', capacity: FLOOD, ...options });
    retrigger.start();
    const drain = retrigger._drain.bind(retrigger);
    const calls = { count: 0 };
    retrigger._drain = () => {
      calls.count += 1;
      drain();
    };
    return { retrigger, calls };
  }

  it('queues one microtask for a burst, not one per event', async () => {
    // The engine notifies on every enqueue. Each notification used to queue its own closure, and the
    // microtask queue has no bound, so a tree-wide burst put a closure per event into memory for all
    // but the first to find the queue already drained.
    const { retrigger, calls } = counted();
    for (let i = 0; i < FLOOD; i += 1) retrigger._scheduleDrain();

    // Nothing runs synchronously: the whole burst is still just one pending microtask.
    expect(calls.count).toBe(0);
    await Promise.resolve();
    expect(calls.count).toBe(1);
    retrigger.close();
  });

  it('delivers every event of a burst despite coalescing the drains', async () => {
    // Coalescing is only safe because one drain empties the queue. If it stopped early, this is the
    // test that would show it: the events are enqueued before any drain runs.
    const { retrigger, calls } = counted();
    const seen = [];
    retrigger.on('all', (event) => seen.push(event.path));

    const engine = retrigger._watcher;
    const burst = 5_000;
    for (let i = 0; i < burst; i += 1) {
      engine._enqueue(engine._makeEvent(`/repo/src/mod${i}.ts`, 'modified', false, 1));
    }
    await Promise.resolve();

    expect(calls.count).toBe(1);
    expect(seen).toHaveLength(burst);
    expect(seen[0]).toBe('/repo/src/mod0.ts');
    expect(seen[burst - 1]).toBe(`/repo/src/mod${burst - 1}.ts`);
    expect(retrigger.getStats().queuePending).toBe(0);
    retrigger.close();
  });

  it('schedules again for events that arrive after a drain', async () => {
    // The flag must not latch: a second burst has to get its own microtask.
    const { retrigger, calls } = counted();
    for (let round = 1; round <= 5; round += 1) {
      for (let i = 0; i < 100; i += 1) retrigger._scheduleDrain();
      await Promise.resolve();
      expect(calls.count).toBe(round);
    }
    retrigger.close();
  });

  it('leaves nothing scheduled once stopped', async () => {
    const { retrigger, calls } = counted();
    retrigger._scheduleDrain();
    retrigger.stop();
    await Promise.resolve();

    // The queued microtask still fires, finds the watcher stopped and does nothing further; what
    // matters is that the flag it set is released rather than blocking every future drain.
    expect(retrigger._drainQueued).toBe(false);
    const before = calls.count;
    retrigger.start();
    retrigger._scheduleDrain();
    await Promise.resolve();
    expect(calls.count).toBe(before + 1);
    retrigger.close();
  });
});

describe('webpack plugin retention', () => {
  const fileEvent = (target, extra = {}) => ({
    path: target,
    kind: 'modified',
    isDirectory: false,
    size: 1,
    timestampNs: 0n,
    cookie: null,
    ...extra,
  });

  /** A plugin with no compiler attached: `_onEvent` is reachable without webpack. */
  const plugin = (options = {}) => new RetriggerWebpackPlugin({ engine: 'javascript', ...options });

  it('bounds the timestamp maps against paths webpack never asked about', () => {
    // The watcher reports everything under the watch root, not just webpack's dependencies, so a
    // session that generates uniquely-named files grows this map for as long as the process lives.
    const p = plugin();
    for (let i = 0; i < FLOOD; i += 1) {
      p._onEvent(fileEvent(`/repo/.cache/build-${i}.js`));
      expect(p.fileTimeInfo.size).toBeLessThanOrEqual(32_768);
    }
    expect(p.fileTimeInfo.size).toBe(32_768);
  });

  it('keeps the most recently touched entries and drops the coldest', () => {
    const p = plugin();
    const hot = '/repo/src/being-edited.ts';
    p._onEvent(fileEvent(hot));
    for (let i = 0; i < 40_000; i += 1) {
      p._onEvent(fileEvent(`/repo/cold/file${i}.ts`));
      // Touched on every pass, so it must never be the entry that gets evicted.
      p._onEvent(fileEvent(hot));
    }
    expect(p.fileTimeInfo.has(hot)).toBe(true);
    expect(p.fileTimeInfo.has('/repo/cold/file0.ts')).toBe(false);
    expect(p.fileTimeInfo.has('/repo/cold/file39999.ts')).toBe(true);
  });

  it('records a directory against the context map and a file against the file map', () => {
    // Bounding the two maps must not have merged them: webpack is handed them separately.
    const p = plugin();
    p._onEvent(fileEvent('/repo/src/a.ts'));
    p._onEvent(fileEvent('/repo/src', { isDirectory: true }));
    expect([...p.fileTimeInfo.keys()]).toEqual(['/repo/src/a.ts']);
    expect([...p.contextTimeInfo.keys()]).toEqual(['/repo/src']);
  });

  it('holds nothing pending when no session can ever adopt it', () => {
    // With replaceWatcher off, this plugin never owns webpack's watchFileSystem, so no WatchSession
    // exists and the held-over sets have no reader at all.
    const p = plugin({ replaceWatcher: false });
    for (let i = 0; i < FLOOD; i += 1) p._onEvent(fileEvent(`/repo/src/mod${i}.ts`));
    expect(p.pendingChanges.size).toBe(0);
    expect(p.pendingRemovals.size).toBe(0);
  });

  it('bounds the held-over sets and says so rather than growing', () => {
    const p = plugin();
    for (let i = 0; i < FLOOD; i += 1) {
      p._onEvent(fileEvent(`/repo/src/mod${i}.ts`));
      expect(p.pendingChanges.size).toBeLessThanOrEqual(16_384);
    }
    expect(p.pendingChanges.size).toBe(16_384);
    // The overflow is recorded, because a set that stopped enumerating is not the same as one that
    // saw nothing more.
    expect(p.pendingOverflow).toBe(true);
  });

  it('keeps a path already held over from counting against the ceiling', () => {
    // The agent-rewriting-one-file shape: repeat events for the same path must not overflow a set
    // that already contains it.
    const p = plugin();
    for (let i = 0; i < FLOOD; i += 1) p._onEvent(fileEvent('/repo/src/one.ts'));
    expect(p.pendingChanges.size).toBe(1);
    expect(p.pendingOverflow).toBe(false);
  });

  it('moves a path between the two held-over sets rather than holding it twice', () => {
    const p = plugin();
    p._onEvent(fileEvent('/repo/src/a.ts'));
    expect(p.pendingChanges.has('/repo/src/a.ts')).toBe(true);

    p._onEvent(fileEvent('/repo/src/a.ts', { kind: 'deleted' }));
    expect(p.pendingChanges.has('/repo/src/a.ts')).toBe(false);
    expect(p.pendingRemovals.has('/repo/src/a.ts')).toBe(true);

    p._onEvent(fileEvent('/repo/src/a.ts', { kind: 'created' }));
    expect(p.pendingRemovals.has('/repo/src/a.ts')).toBe(false);
    expect(p.pendingChanges.has('/repo/src/a.ts')).toBe(true);
  });

  it('releases every accumulated map when the watch is over', () => {
    const p = plugin();
    for (let i = 0; i < 1_000; i += 1) {
      p._onEvent(fileEvent(`/repo/src/mod${i}.ts`));
      p._onEvent(fileEvent(`/repo/src/dir${i}`, { isDirectory: true }));
    }
    expect(p.fileTimeInfo.size).toBeGreaterThan(0);

    p.stop();

    expect(p.fileTimeInfo.size).toBe(0);
    expect(p.contextTimeInfo.size).toBe(0);
    expect(p.pendingChanges.size).toBe(0);
    expect(p.pendingRemovals.size).toBe(0);
    expect(p.pendingOverflow).toBe(false);
  });

  it('deletes a removed path from the timestamp maps instead of restamping it', () => {
    const p = plugin();
    p._onEvent(fileEvent('/repo/src/a.ts'));
    p._onEvent(fileEvent('/repo/src/a.ts', { kind: 'deleted' }));
    expect(p.fileTimeInfo.has('/repo/src/a.ts')).toBe(false);
    expect(p.contextTimeInfo.has('/repo/src/a.ts')).toBe(false);
  });
});
