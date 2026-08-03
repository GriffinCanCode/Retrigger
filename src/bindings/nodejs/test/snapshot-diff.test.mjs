import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { Retrigger } from '../lib/retrigger.js';
import { cleanupTempDirs, sleep, tempDir, writeFile } from './helpers/tmp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');
const require = createRequire(import.meta.url);

afterAll(cleanupTempDirs);

/**
 * The compiled Rust addon, if one has been built for this host — the same lookup
 * `hash.test.mjs`/`parity-native.test.mjs` use, duplicated rather than imported so this file has
 * no reason to touch `RETRIGGER_NATIVE_PATH` except in the one test that deliberately forces the
 * JavaScript fallback to prove parity.
 * @returns {string|null}
 */
function findAddon() {
  const triples = {
    darwin: ['darwin-arm64', 'darwin-x64'],
    win32: ['win32-x64-msvc', 'win32-arm64-msvc'],
    linux: [
      'linux-x64-gnu',
      'linux-x64-musl',
      'linux-arm64-gnu',
      'linux-arm64-musl',
      'linux-arm-gnueabihf',
      'linux-ppc64-gnu',
    ],
    freebsd: ['freebsd-x64'],
  }[process.platform];
  for (const triple of triples || []) {
    const candidate = path.join(PKG_ROOT, `retrigger-nodejs-bindings.${triple}.node`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const ADDON = findAddon();
const native = ADDON ? require(ADDON) : null;

/** @returns {{path: string, isDirectory: boolean, size: number, modifiedNs: bigint}} */
function entry(entryPath, isDirectory, size, modifiedNs) {
  return { path: entryPath, isDirectory, size, modifiedNs: BigInt(modifiedNs) };
}

/** Drops `timestampNs` (stamped at call time, so never comparable across two calls) and sorts by
 * path, so two independently-produced diffs can be compared with `toEqual`. */
function normalise(events) {
  return [...events]
    .map(({ timestampNs: _timestampNs, ...rest }) => rest)
    .sort((a, b) => a.path.localeCompare(b.path));
}

describe('Retrigger.diffSnapshots', () => {
  it('is a static method, not an instance one', () => {
    expect(typeof Retrigger.diffSnapshots).toBe('function');
  });

  it('reports no events for identical snapshots', () => {
    const snap = [entry('/a', false, 4, 1), entry('/b', true, 0, 2)];
    expect(Retrigger.diffSnapshots(snap, [...snap])).toEqual([]);
  });

  it('classifies a new path as created', () => {
    const before = [entry('/a', false, 4, 1)];
    const after = [entry('/a', false, 4, 1), entry('/b', false, 1, 2)];
    const events = Retrigger.diffSnapshots(before, after);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ path: '/b', kind: 'created', isDirectory: false });
  });

  it('classifies a missing path as deleted', () => {
    const before = [entry('/a', false, 4, 1), entry('/b', false, 1, 2)];
    const after = [entry('/a', false, 4, 1)];
    const events = Retrigger.diffSnapshots(before, after);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ path: '/b', kind: 'deleted', size: 0 });
  });

  it('classifies a changed size or modification time as modified, and leaves the rest silent', () => {
    const before = [entry('/unchanged', false, 4, 1), entry('/a', false, 4, 1)];
    expect(
      Retrigger.diffSnapshots(before, [entry('/unchanged', false, 4, 1), entry('/a', false, 5, 1)])
    ).toEqual([expect.objectContaining({ path: '/a', kind: 'modified' })]);
    expect(
      Retrigger.diffSnapshots(before, [entry('/unchanged', false, 4, 1), entry('/a', false, 4, 2)])
    ).toEqual([expect.objectContaining({ path: '/a', kind: 'modified' })]);
  });

  it('a directory changes only by modification time, never by size', () => {
    const before = [entry('/dir', true, 0, 1)];
    expect(Retrigger.diffSnapshots(before, [entry('/dir', true, 0, 1)])).toEqual([]);
    expect(Retrigger.diffSnapshots(before, [entry('/dir', true, 0, 2)])).toEqual([
      expect.objectContaining({ path: '/dir', kind: 'modified', isDirectory: true }),
    ]);
  });

  it('treats a null modifiedNs on both sides as unchanged', () => {
    const before = [{ path: '/a', isDirectory: false, size: 4, modifiedNs: null }];
    const after = [{ path: '/a', isDirectory: false, size: 4, modifiedNs: null }];
    expect(Retrigger.diffSnapshots(before, after)).toEqual([]);
  });
});

describe('Retrigger.diffSnapshots against real snapshot() output', () => {
  /** @type {Retrigger[]} */
  const open = [];
  afterEach(() => {
    while (open.length) open.pop().close();
  });

  function watcher(engine) {
    const w = new Retrigger({ engine });
    open.push(w);
    return w;
  }

  /**
   * Runs the add/remove/modify scenario the plan calls for, through whichever engine `engine`
   * names, so the diff is exercised against a snapshot this package's own crawler produced —
   * not a hand-built fixture.
   */
  async function addRemoveModify(engine) {
    const dir = tempDir();
    const w = watcher(engine);
    writeFile(path.join(dir, 'untouched.txt'), 'same');
    writeFile(path.join(dir, 'will_change.txt'), 'before');
    writeFile(path.join(dir, 'will_be_removed.txt'), 'gone soon');

    const before = await w.snapshot(dir);

    // A modification-time tick coarser than some volumes' resolution, mirroring
    // `tests/snapshot.rs`'s own `diff_reports_exactly_one_event_per_real_difference`.
    await sleep(20);
    writeFile(path.join(dir, 'will_change.txt'), 'after, and longer');
    fs.rmSync(path.join(dir, 'will_be_removed.txt'));
    writeFile(path.join(dir, 'will_be_created.txt'), 'new');

    const after = await w.snapshot(dir);
    const events = Retrigger.diffSnapshots(before.entries, after.entries);
    return { dir, events };
  }

  it.each(['javascript', ...(ADDON ? ['native'] : [])])(
    'classifies an add, a removal and a modification (%s engine)',
    async (engine) => {
      const { dir, events } = await addRemoveModify(engine);
      const byPath = Object.fromEntries(events.map((e) => [path.relative(dir, e.path), e]));

      expect(byPath['will_be_created.txt']).toMatchObject({ kind: 'created' });
      expect(byPath['will_be_removed.txt']).toMatchObject({ kind: 'deleted' });
      expect(byPath['will_change.txt']).toMatchObject({
        kind: 'modified',
        size: 'after, and longer'.length,
      });
      expect(byPath['untouched.txt']).toBeUndefined();
    }
  );
});

describe.skipIf(!ADDON)('native/JavaScript engine parity', () => {
  afterEach(() => {
    delete process.env.RETRIGGER_FORCE_JS;
  });

  it('the native addon exposes diffSnapshots', () => {
    expect(typeof native.diffSnapshots).toBe('function');
  });

  it('the native addon and the pure-JavaScript fallback agree on the same input', async () => {
    const { resetNativeCache } = await import('../lib/native.js');
    const before = [
      entry('/unchanged', false, 4, 1),
      entry('/removed', false, 2, 1),
      entry('/changed', false, 4, 1),
    ];
    const after = [
      entry('/unchanged', false, 4, 1),
      entry('/changed', false, 5, 1),
      entry('/created', false, 1, 3),
    ];

    const fromNative = normalise(native.diffSnapshots(before, after));

    process.env.RETRIGGER_FORCE_JS = '1';
    resetNativeCache();
    try {
      const fromFallback = normalise(Retrigger.diffSnapshots(before, after));
      expect(fromFallback).toEqual(fromNative);
    } finally {
      delete process.env.RETRIGGER_FORCE_JS;
      resetNativeCache();
    }
  });
});
