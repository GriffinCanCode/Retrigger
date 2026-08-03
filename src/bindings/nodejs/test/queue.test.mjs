import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
process.env.RETRIGGER_NATIVE_PATH = path.join(HERE, 'helpers', 'mock-native.js');
process.env.RETRIGGER_SILENT = '1';

import { JsWatcher } from '../lib/js-watcher.js';
import { cleanupTempDirs, tempDir, waitFor } from './helpers/tmp.js';
import mockNative from './helpers/mock-native.js';

afterAll(cleanupTempDirs);

/**
 * Overflow is exercised white-box because it must be deterministic. Driving it
 * through the filesystem would make the assertion depend on how fast the OS
 * delivers notifications, which is exactly the kind of flakiness a reliability
 * suite must not contain. A filesystem-driven variant follows, with tolerances.
 */
const IMPLEMENTATIONS = [
  { name: 'JsWatcher', make: (options) => new JsWatcher(options) },
  { name: 'mock addon Watcher', make: (options) => new mockNative.Watcher(options) },
];

for (const impl of IMPLEMENTATIONS) {
  describe(`bounded queue: ${impl.name}`, () => {
    const push = (watcher, n) => {
      for (let i = 0; i < n; i += 1) {
        watcher._enqueue({
          path: `/synthetic/${i}`,
          kind: 'modified',
          timestampNs: 0n,
          size: 0,
          isDirectory: false,
          cookie: null,
        });
      }
    };

    it('accepts exactly `capacity` events before overflowing', () => {
      const watcher = impl.make({ capacity: 5 });
      push(watcher, 5);
      expect(watcher.stats().queuePending).toBe(5);
      expect(watcher.stats().eventsDropped).toBe(0);
      expect(watcher.stats().eventsQueued).toBe(5);
    });

    it('discards the backlog and puts rescanRequired at the head on overflow', () => {
      const watcher = impl.make({ capacity: 4 });
      push(watcher, 10);
      const first = watcher.poll();
      expect(first.kind).toBe('rescanRequired');
      expect(first.path).toBe('');
      // Like inotify's IN_Q_OVERFLOW, the stream continues after the marker;
      // only the events that could not be held are lost.
      expect(watcher.stats().queuePending).toBeLessThanOrEqual(4);
    });

    it('counts every discarded and rejected event', () => {
      const watcher = impl.make({ capacity: 4 });
      push(watcher, 10);
      // Of ten pushes with capacity four: four are queued, the fifth triggers
      // overflow (discarding those four and queueing the marker), events six
      // through eight refill the queue, and nine and ten are rejected.
      // Dropped = 4 discarded + 1 rejected + 2 rejected = 7.
      expect(watcher.stats().eventsDropped).toBe(7);
      // Queued counts the four originals, the marker, and the three refills.
      expect(watcher.stats().eventsQueued).toBe(8);
    });

    it('never queues two rescan markers for one overflow', () => {
      const watcher = impl.make({ capacity: 2 });
      push(watcher, 50);
      const kinds = drain(watcher);
      expect(kinds.filter((k) => k === 'rescanRequired')).toHaveLength(1);
      expect(kinds[0]).toBe('rescanRequired');
    });

    it('re-arms overflow only after the rescan marker is consumed', () => {
      const watcher = impl.make({ capacity: 2 });
      push(watcher, 50);
      expect(watcher.poll().kind).toBe('rescanRequired');
      drain(watcher);
      push(watcher, 50);
      const kinds = drain(watcher);
      expect(kinds.filter((k) => k === 'rescanRequired')).toHaveLength(1);
    });

    const drain = (watcher) => {
      const kinds = [];
      for (let e = watcher.poll(); e; e = watcher.poll()) kinds.push(e.kind);
      return kinds;
    };

    it('reports queueCapacity and defaults a nonsensical capacity', () => {
      expect(impl.make({ capacity: 7 }).stats().queueCapacity).toBe(7);
      expect(impl.make({ capacity: 0 }).stats().queueCapacity).toBe(8192);
      expect(impl.make({ capacity: -3 }).stats().queueCapacity).toBe(8192);
      expect(impl.make({}).stats().queueCapacity).toBe(8192);
    });

    it('counts delivered events only as they are polled', () => {
      const watcher = impl.make({ capacity: 10 });
      push(watcher, 3);
      expect(watcher.stats().eventsDelivered).toBe(0);
      watcher.poll();
      watcher.poll();
      expect(watcher.stats().eventsDelivered).toBe(2);
    });
  });
}

describe('bounded queue under real filesystem pressure', () => {
  it('drops and signals a rescan when nothing is polling', async () => {
    const dir = tempDir();
    const watcher = new JsWatcher({ capacity: 8 });
    watcher.watch(dir, true);
    watcher.start();
    try {
      // fs.watch is not armed synchronously on every platform. On Windows the writes below can
      // all land before the watch is live, and the test then reads a stats block of zeroes and
      // reports that the queue never overflowed -- a true statement about a watcher that never
      // saw anything. Prove delivery first, then apply the pressure this test is about.
      fs.mkdirSync(path.join(dir, 'live-sentinel'), { recursive: true });
      await waitFor(() => watcher.stats().eventsQueued > 0, {
        message: 'the watcher never delivered a first event',
      });
      for (let event = watcher.poll(); event; event = watcher.poll());

      for (let i = 0; i < 300; i += 1) {
        fs.writeFileSync(path.join(dir, `f${i}.js`), String(i));
      }
      await waitFor(() => watcher.stats().eventsDropped > 0, {
        // Built at failure time and including what the watcher itself saw: a stats block of zeroes
        // says only that nothing arrived, and cannot distinguish a queue that never filled from a
        // directory watch that died and took the event stream with it.
        message: () =>
          `queue never overflowed (stats=${JSON.stringify(watcher.stats())}, ` +
          `openDirs=${watcher.openDirectoryCount}, ` +
          `errors=${JSON.stringify(watcher.drainErrors().map((e) => `${e.code || '?'}: ${e.message}`))})`,
      });
      const stats = watcher.stats();
      expect(stats.eventsDropped).toBeGreaterThan(0);
      expect(stats.queuePending).toBeLessThanOrEqual(stats.queueCapacity);

      const kinds = [];
      for (let event = watcher.poll(); event; event = watcher.poll()) kinds.push(event.kind);
      expect(kinds).toContain('rescanRequired');
    } finally {
      watcher.stop();
    }
  });

  /**
   * White-box for the same reason the overflow tests above are: the fault being modelled is a
   * one-shot error raised on a directory handle, which Windows produces under conditions no test
   * can ask for on demand and the other platforms do not produce at all. Emitting it directly is
   * the only way to hold every platform to the same answer.
   */
  it('re-arms a directory watch that faulted, and declares the gap', async () => {
    const dir = tempDir();
    const watcher = new JsWatcher({ capacity: 64 });
    watcher.watch(dir, true);
    watcher.start();
    try {
      expect(watcher.openDirectoryCount).toBe(1);
      const faulted = watcher._dirWatchers.get(dir);
      faulted.emit('error', Object.assign(new Error('handle fell over'), { code: 'EPERM' }));

      expect(watcher.openDirectoryCount, 'the directory must be watched again').toBe(1);
      const kinds = [];
      for (let event = watcher.poll(); event; event = watcher.poll()) kinds.push(event.kind);
      expect(kinds, 'changes during the gap were unobservable, so a rescan is owed').toContain(
        'rescanRequired'
      );

      // The point of re-arming: the stream is still live afterwards. Written repeatedly under a
      // fresh name rather than once, because macOS brings the replacement stream up on another
      // thread and a single write racing that can be missed outright rather than merely delayed --
      // which would make this assert how promptly the watch re-arms, not whether it did.
      let attempt = 0;
      await waitFor(
        () => {
          fs.writeFileSync(path.join(dir, `after-the-fault-${(attempt += 1)}.js`), 'x');
          for (let event = watcher.poll(); event; event = watcher.poll()) {
            if (event.path.includes('after-the-fault')) return true;
          }
          return false;
        },
        { interval: 100, message: 'nothing was reported after the watch was re-armed' }
      );
    } finally {
      watcher.stop();
    }
  });

  it('stops re-arming a directory whose watch fails every time', () => {
    const dir = tempDir();
    const watcher = new JsWatcher({ capacity: 64 });
    watcher.watch(dir, true);
    watcher.start();
    try {
      // One more than the ceiling, so the last attempt is the one that must not happen.
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const current = watcher._dirWatchers.get(dir);
        if (!current) break;
        current.emit('error', new Error('fails every time'));
      }
      expect(
        watcher.openDirectoryCount,
        'a directory that cannot be watched must not be retried forever'
      ).toBe(0);
    } finally {
      watcher.stop();
    }
  });

  /**
   * Deliberately runs against the mock addon rather than the JavaScript
   * engine. The JavaScript engine exposes `setNotifier`, so `Retrigger` drains
   * its queue on a microtask after every single event and, with `fs.watch`
   * delivering one callback per tick, it cannot realistically overflow through
   * the public API. The addon contract has no notifier — it is polled — which
   * is precisely the shape that can overflow, so that is what is tested here.
   */
  it('surfaces rescanRequired through the public API as a "rescan" event', async () => {
    const { Retrigger } = await import('../lib/retrigger.js');
    const dir = tempDir();
    const watcher = new Retrigger({
      paths: dir,
      engine: 'native',
      capacity: 4,
      pollIntervalMs: 150,
    });
    const rescans = [];
    watcher.on('rescan', (event) => rescans.push(event));
    watcher.start();
    try {
      for (let i = 0; i < 400; i += 1) {
        fs.writeFileSync(path.join(dir, `burst-${i}.js`), String(i));
      }
      await waitFor(() => rescans.length > 0, {
        timeout: 10000,
        message: 'no rescan event surfaced',
      });
      expect(rescans[0].kind).toBe('rescanRequired');
      expect(watcher.getStats().metrics.rescans).toBeGreaterThan(0);
      expect(watcher.getStats().eventsDropped).toBeGreaterThan(0);
    } finally {
      watcher.close();
    }
  });
});

describe('debounce windows', () => {
  const sinks = (watcher) => {
    const seen = [];
    for (let e = watcher.poll(); e; e = watcher.poll()) seen.push(`${e.path}:${e.kind}`);
    return seen;
  };

  it('delivers the first event at once and absorbs the repeats behind it', async () => {
    const watcher = new JsWatcher({ debounceMs: 30 });
    watcher._emitIfMatched('/x/a.js', 'created', false, 1);
    watcher._emitIfMatched('/x/a.js', 'modified', false, 4);
    watcher._emitIfMatched('/x/a.js', 'modified', false, 9);

    expect(sinks(watcher), 'only the leading event is immediate').toEqual(['/x/a.js:created']);

    await new Promise((r) => setTimeout(r, 60));
    // One correction, not one per absorbed write, and it carries the final size rather than the
    // size the leading event described.
    expect(sinks(watcher)).toEqual(['/x/a.js:modified']);
  });

  it('closes a window that absorbed nothing without inventing an event', async () => {
    const watcher = new JsWatcher({ debounceMs: 30 });
    watcher._emitIfMatched('/x/a.js', 'modified', false, 1);
    expect(sinks(watcher)).toEqual(['/x/a.js:modified']);

    await new Promise((r) => setTimeout(r, 60));
    expect(sinks(watcher), 'a single write is a single event').toEqual([]);
  });

  it('never absorbs a delete, even mid-window', async () => {
    // The window may only ever collapse repeat noise. Swallowing a delete would change what the
    // stream means, and is how a dev server ends up serving a file that is gone.
    const watcher = new JsWatcher({ debounceMs: 30 });
    watcher._emitIfMatched('/x/a.js', 'created', false, 1);
    watcher._emitIfMatched('/x/a.js', 'deleted', false, 0);
    expect(sinks(watcher)).toEqual(['/x/a.js:created', '/x/a.js:deleted']);

    // The delete ended the window, so the arrival that follows it is news again rather than
    // something a still-open window could absorb.
    watcher._emitIfMatched('/x/a.js', 'created', false, 2);
    expect(sinks(watcher)).toEqual(['/x/a.js:created']);

    await new Promise((r) => setTimeout(r, 60));
    expect(sinks(watcher)).toEqual([]);
  });
});
