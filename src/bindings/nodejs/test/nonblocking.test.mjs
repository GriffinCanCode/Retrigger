import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { Retrigger } from '../lib/retrigger.js';
import { cleanupTempDirs, tempDir, waitFor, waitUntilLive, writeFile } from './helpers/tmp.js';

afterAll(cleanupTempDirs);

/** Comfortably past every `maxHashBytes` used below, so it always takes the async path. */
const LARGE_FILE_BYTES = 24 * 1024 * 1024;
/** Comfortably under it, so it always takes the synchronous path. */
const SMALL_MAX_HASH_BYTES = 4096;

/**
 * Sample `Date.now()` on an interval and record the gap between consecutive ticks. A drain loop
 * that hashed a large file synchronously would show up here as one tick arriving tens of
 * milliseconds late -- the event loop had no chance to run the timer's callback until the hash
 * finished reading and digesting the whole file.
 */
function heartbeat(intervalMs = 5) {
  const gaps = [];
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    gaps.push(now - last);
    last = now;
  }, intervalMs);
  timer.unref();
  return {
    stop: () => clearInterval(timer),
    maxGap: () => gaps.reduce((max, gap) => Math.max(max, gap), 0),
  };
}

describe('nonblocking burst hashing', () => {
  it('keeps the event loop responsive while hashing a large file', async () => {
    const dir = tempDir();
    const target = path.join(dir, 'large.bin');
    writeFile(target, crypto.randomBytes(LARGE_FILE_BYTES));

    const events = [];
    const watcher = new Retrigger({
      paths: dir,
      engine: 'javascript',
      maxHashBytes: SMALL_MAX_HASH_BYTES,
    });
    watcher.on('all', (e) => events.push(e));
    watcher.start();
    await waitUntilLive(dir, events);

    const pulse = heartbeat();
    writeFile(target, crypto.randomBytes(LARGE_FILE_BYTES));
    const changed = await waitFor(
      () => events.find((e) => e.path === target && e.kind === 'modified'),
      { timeout: 15000, message: 'large file change never arrived' }
    );
    pulse.stop();
    watcher.close();

    expect(changed.contentChanged).toBe(true);
    expect(changed.hash).toMatch(/^[0-9a-f]{16}$/);
    // Generous on purpose: this is a floor against regressing to a synchronous hash of a 24 MiB
    // file (which costs tens of milliseconds even on a fast engine), not a tight latency budget.
    expect(pulse.maxGap()).toBeLessThan(250);
  });

  it('hashes a small file synchronously without touching the async queue', async () => {
    const dir = tempDir();
    const target = path.join(dir, 'small.txt');
    writeFile(target, 'x');

    const events = [];
    const watcher = new Retrigger({
      paths: dir,
      engine: 'javascript',
      maxHashBytes: SMALL_MAX_HASH_BYTES,
    });
    watcher.on('all', (e) => events.push(e));
    watcher.start();
    await waitUntilLive(dir, events);

    writeFile(target, 'xyz');
    const changed = await waitFor(
      () => events.find((e) => e.path === target && e.kind === 'modified'),
      { timeout: 5000, message: 'small file change never arrived' }
    );
    expect(changed.contentChanged).toBe(true);
    expect(watcher.getStats().asyncHashesInFlight).toBe(0);
    expect(watcher.getStats().asyncHashesQueued).toBe(0);
    watcher.close();
  });

  it('bounds concurrent hashes to maxConcurrentHashes and drains the rest from a queue', async () => {
    const dir = tempDir();
    const files = Array.from({ length: 6 }, (_, i) => path.join(dir, `f${i}.bin`));
    for (const file of files) writeFile(file, crypto.randomBytes(LARGE_FILE_BYTES));

    const events = [];
    const watcher = new Retrigger({
      paths: dir,
      engine: 'javascript',
      maxHashBytes: SMALL_MAX_HASH_BYTES,
      maxConcurrentHashes: 2,
    });
    watcher.on('all', (e) => events.push(e));
    watcher.start();
    await waitUntilLive(dir, events);

    for (const file of files) writeFile(file, crypto.randomBytes(LARGE_FILE_BYTES));
    await waitFor(() => watcher.getStats().asyncHashesInFlight > 0, {
      timeout: 5000,
      message: 'no async hash ever started',
    });
    // Sampled while the burst is still draining: never more in flight than the configured
    // ceiling, with the rest waiting their turn rather than having been started anyway.
    expect(watcher.getStats().asyncHashesInFlight).toBeLessThanOrEqual(2);

    await waitFor(
      () => files.every((file) => events.some((e) => e.path === file && e.kind === 'modified')),
      { timeout: 20000, message: 'not every large file change arrived' }
    );
    // The queue must drain to empty. Poll for that rather than asserting it instantaneously: on the
    // JS engine a single write can surface more than one filesystem event, so a straggler hash may
    // still be settling the moment the last file's change is first observed. A real leak never
    // reaches zero and fails this wait on its timeout.
    await waitFor(
      () =>
        watcher.getStats().asyncHashesInFlight === 0 && watcher.getStats().asyncHashesQueued === 0,
      { timeout: 20000, message: 'async hash queue never drained to zero' }
    );
    watcher.close();
  });

  it('abandons in-flight async hashes on close() without leaking handles or emitting late', async () => {
    const dir = tempDir();
    const target = path.join(dir, 'abandoned.bin');
    writeFile(target, crypto.randomBytes(LARGE_FILE_BYTES));

    const events = [];
    const watcher = new Retrigger({
      paths: dir,
      engine: 'javascript',
      maxHashBytes: SMALL_MAX_HASH_BYTES,
    });
    watcher.on('all', (e) => events.push(e));
    watcher.start();
    await waitUntilLive(dir, events);

    const before = new Map();
    for (const kind of process.getActiveResourcesInfo())
      before.set(kind, (before.get(kind) || 0) + 1);

    writeFile(target, crypto.randomBytes(LARGE_FILE_BYTES));
    await waitFor(() => watcher.getStats().asyncHashesInFlight > 0, {
      timeout: 5000,
      message: 'no async hash ever started to abandon',
    });
    events.length = 0;
    watcher.close();

    // Let libuv actually retire whatever close() released before counting.
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 100));

    const after = new Map();
    for (const kind of process.getActiveResourcesInfo())
      after.set(kind, (after.get(kind) || 0) + 1);
    for (const [kind, count] of after) {
      expect(count, `${kind} handle(s) still active after close()`).toBeLessThanOrEqual(
        before.get(kind) || 0
      );
    }

    // The abandoned hash must never surface as a delayed event once its promise finally settles.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(events.some((e) => e.path === target)).toBe(false);
  });
});
