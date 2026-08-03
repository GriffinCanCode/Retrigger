/**
 * One behavioural suite, run once per engine.
 *
 * The point is evidence, not coverage: if the JavaScript fallback is a real
 * substitute for the native engine, the same file operations must produce the
 * same observable behaviour through the same public API. Adding a third engine
 * means adding one entry to the table in `parity.test.js`; the whole suite
 * comes with it.
 *
 * What this proves: the public `Retrigger` surface behaves identically over two
 * independently written watch implementations (`fs.watch` notifications vs.
 * periodic stat diffing).
 *
 * What it does not prove: that the real Rust addon behaves this way. That can
 * only be established by running this suite against the shipped binary, which
 * is exactly what it is written to allow.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { tempDir, waitFor, waitForQuiet, waitUntilLive, writeFile } from '../helpers/tmp.js';

export const STATS_KEYS = [
  'engine',
  'backend',
  'eventsQueued',
  'eventsDropped',
  'eventsDelivered',
  'watchedPaths',
  'queuePending',
  'queueCapacity',
  'isRunning',
  'content',
  'metrics',
];

/**
 * @param {string} engineName
 * @param {(options?: object) => import('../../index').Retrigger} makeRetrigger
 */
export function runEngineSuite(engineName, makeRetrigger) {
  describe(`engine: ${engineName}`, () => {
    /** @type {Array<{close: () => void}>} */
    const open = [];

    afterEach(() => {
      while (open.length) {
        try {
          open.pop().close();
        } catch {
          /* already closed */
        }
      }
    });

    /**
     * Start a watcher over a fresh temp dir, wait until it is demonstrably
     * live, and collect every event from that point on.
     * @returns {Promise<{dir: string, events: object[], watcher: object}>}
     */
    async function start(options = {}) {
      const dir = options.dir || tempDir();
      const events = [];
      const watcher = makeRetrigger({ paths: dir, ...options });
      watcher.on('all', (event) => events.push(event));
      watcher.on('error', (err) => events.push({ kind: '__error__', error: err }));
      watcher.start();
      open.push(watcher);
      await waitUntilLive(dir, events);
      return { dir, events, watcher };
    }

    const kindsFor = (events, target) => events.filter((e) => e.path === target).map((e) => e.kind);

    // ------------------------------------------------------------ event kinds

    it('reports a new file as "created"', async () => {
      const { dir, events } = await start();
      const target = path.join(dir, 'new.js');
      writeFile(target, 'export const a = 1;');
      await waitFor(() => kindsFor(events, target).includes('created'), {
        message: `no created event for ${target}`,
      });
    });

    it('reports a rewritten file as "modified"', async () => {
      const dir = tempDir();
      const target = path.join(dir, 'existing.js');
      writeFile(target, 'v1');
      const { events } = await start({ dir });
      writeFile(target, 'v2-longer-content');
      await waitFor(() => kindsFor(events, target).includes('modified'), {
        message: 'no modified event',
      });
      expect(kindsFor(events, target)).not.toContain('created');
    });

    it('reports a removed file as "deleted"', async () => {
      const dir = tempDir();
      const target = path.join(dir, 'doomed.js');
      writeFile(target, 'bye');
      const { events } = await start({ dir });
      fs.unlinkSync(target);
      await waitFor(() => kindsFor(events, target).includes('deleted'), {
        message: 'no deleted event',
      });
    });

    it('reports a rename as an unlink of the old path and an add of the new', async () => {
      const dir = tempDir();
      const from = path.join(dir, 'before.js');
      const to = path.join(dir, 'after.js');
      writeFile(from, 'x');
      const { watcher } = await start({ dir });

      // This asserts the emitted events, not the raw `kind`, because the kind
      // is legitimately platform-specific: inotify pairs the two halves of a
      // rename and reports renamedFrom/renamedTo with a cookie, while FSEvents
      // cannot pair them and reports deleted/created. Both map through
      // KIND_TO_EVENT to the same unlink/add pair, and that pair is what every
      // consumer acts on. Asserting the label instead would force the native
      // engine to discard the one thing it knows that the fallback cannot --
      // and it did fail here on real inotify before this was corrected.
      const emitted = [];
      watcher.on('unlink', (target) => emitted.push(`unlink:${target}`));
      watcher.on('add', (target) => emitted.push(`add:${target}`));

      fs.renameSync(from, to);
      await waitFor(() => emitted.includes(`unlink:${from}`) && emitted.includes(`add:${to}`), {
        message: `rename did not produce unlink + add; saw ${JSON.stringify(emitted)}`,
      });
    });

    it('sees files in nested directories', async () => {
      const dir = tempDir();
      fs.mkdirSync(path.join(dir, 'a', 'b', 'c'), { recursive: true });
      const { events } = await start({ dir });
      const target = path.join(dir, 'a', 'b', 'c', 'deep.js');
      writeFile(target, 'deep');
      await waitFor(() => kindsFor(events, target).includes('created'), {
        message: 'nested file missed',
      });
    });

    it('sees files in directories created after start()', async () => {
      const { dir, events } = await start();
      const sub = path.join(dir, 'late');
      fs.mkdirSync(sub);
      const target = path.join(sub, 'inside.js');
      // No sleep between mkdir and write: this is the race the watcher must win.
      writeFile(target, 'inside');
      await waitFor(() => kindsFor(events, target).includes('created'), {
        message: 'file in newly created directory missed',
      });
    });

    it('does not report nested files when recursive is false', async () => {
      const dir = tempDir();
      fs.mkdirSync(path.join(dir, 'nested'));
      const { events } = await start({ dir, recursive: false });
      const shallow = path.join(dir, 'shallow.js');
      const deep = path.join(dir, 'nested', 'deep.js');
      writeFile(deep, 'deep');
      writeFile(shallow, 'shallow');
      await waitFor(() => kindsFor(events, shallow).length > 0, {
        message: 'shallow file missed',
      });
      await waitForQuiet(() => events.length);
      expect(kindsFor(events, deep)).toEqual([]);
    });

    // -------------------------------------------------------------- filtering

    it('drops paths matched by exclude', async () => {
      const { dir, events } = await start({ exclude: ['**/*.log'] });
      const kept = path.join(dir, 'keep.js');
      const dropped = path.join(dir, 'drop.log');
      writeFile(dropped, 'noise');
      writeFile(kept, 'signal');
      await waitFor(() => kindsFor(events, kept).length > 0, { message: 'kept file missed' });
      await waitForQuiet(() => events.length);
      expect(kindsFor(events, dropped)).toEqual([]);
    });

    it('keeps only paths matched by include', async () => {
      const { dir, events } = await start({ include: ['**/*.ts'] });
      const kept = path.join(dir, 'yes.ts');
      const dropped = path.join(dir, 'no.js');
      writeFile(dropped, 'nope');
      writeFile(kept, 'yep');
      await waitFor(() => kindsFor(events, kept).length > 0, { message: 'included file missed' });
      await waitForQuiet(() => events.length);
      expect(kindsFor(events, dropped)).toEqual([]);
    });

    it('lets exclude win over include for the same path', async () => {
      const { dir, events } = await start({ include: ['**/*.ts'], exclude: ['**/ignored.ts'] });
      const kept = path.join(dir, 'kept.ts');
      const dropped = path.join(dir, 'ignored.ts');
      writeFile(dropped, 'x');
      writeFile(kept, 'y');
      await waitFor(() => kindsFor(events, kept).length > 0, { message: 'kept file missed' });
      await waitForQuiet(() => events.length);
      expect(kindsFor(events, dropped)).toEqual([]);
    });

    it('stops reporting a path after unwatch()', async () => {
      const dir = tempDir();
      const sub = path.join(dir, 'child');
      fs.mkdirSync(sub);
      const { events, watcher } = await start({ dir });
      const target = path.join(sub, 'file.js');
      writeFile(target, 'one');
      await waitFor(() => kindsFor(events, target).length > 0, { message: 'first write missed' });

      watcher.unwatch(dir);
      const before = events.length;
      writeFile(target, 'two-longer');
      await waitForQuiet(() => events.length);
      expect(events.length).toBe(before);
    });

    // -------------------------------------------------------------- debouncing

    it('collapses a burst of writes to one event and one correction', async () => {
      // Six writes must not be six wake-ups. They must also not be *one*: the window closes with a
      // correction carrying the file's final bytes, because the leading event was delivered while
      // the burst was still running and described the file part-way through it.
      const dir = tempDir();
      const target = path.join(dir, 'burst.js');
      writeFile(target, 'v0');
      // The window has to outlast the slowest thing between a write and its notification, which is
      // the backend rather than anything here: a stat differ reports on its own poll schedule and
      // `fs.watch` on macOS delivers through a coalescing stream. At 120 ms the tail of the burst
      // routinely landed after the window had already closed, which legitimately opens a second
      // window and is the debouncer behaving correctly — so the test was measuring machine load.
      const { events } = await start({ dir, debounceMs: 500 });

      // Spaced tightly enough that the whole burst, plus the lag before a backend reports its tail,
      // lands well inside the window. A write whose notification arrived *after* the window closed
      // would legitimately open a second one, and this test is about the first.
      const last = 'v6'.padEnd(10, 'x');
      for (let i = 1; i <= 6; i += 1) {
        writeFile(target, i === 6 ? last : `v${i}`.padEnd(i + 4, 'x'));
        await new Promise((r) => setTimeout(r, 5));
      }
      await waitFor(() => kindsFor(events, target).length > 0, { message: 'no debounced event' });
      await waitForQuiet(() => events.length, { quietMs: 250 });

      const kinds = kindsFor(events, target);
      expect(
        kinds.length,
        `6 writes produced ${kinds.length} events: ${kinds}`
      ).toBeLessThanOrEqual(2);
      expect(new Set(kinds)).toEqual(new Set(['modified']));
      expect(fs.readFileSync(target, 'utf8')).toBe(last);
    });

    it('reports a create at once and corrects the write that followed it', async () => {
      // The leading event keeps its own identity — a new file is announced as created, not as a
      // modification — and the write the window absorbed still reaches the consumer, as the
      // correction that closes the window.
      const { dir, events } = await start({ debounceMs: 120 });
      const target = path.join(dir, 'fresh.js');
      writeFile(target, 'a');
      await new Promise((r) => setTimeout(r, 20));
      writeFile(target, 'ab');
      // Waiting for the correction rather than for the stream to fall quiet. Quiet is reached
      // when nothing has arrived for 250ms, which on a loaded macOS runner can happen while the
      // correction is still inside FSEvents' coalescing latency -- the assertion then ran before
      // the event it was about. The exact sequence is still asserted, and a correction that never
      // comes still fails, now by timing out here rather than by reading a half-filled list.
      await waitFor(() => kindsFor(events, target).length >= 2, {
        message: 'the write absorbed by the window never arrived as a correction',
      });
      await waitForQuiet(() => events.length, { quietMs: 250 });
      expect(kindsFor(events, target)).toEqual(['created', 'modified']);
    });

    // -------------------------------------------------------- content changes

    /**
     * The reason this package exists, held to the same standard on every engine.
     *
     * The two engines hash with different algorithms and will never agree on a digest *value*. They
     * must still agree on every `contentChanged` decision, because the decision only ever compares a
     * path against its own earlier digest taken by the same engine. That is what makes the fallback
     * a substitute here rather than a downgrade.
     */
    /**
     * Write `contents` to `target` and return the first event the watcher reported for it.
     *
     * The *first* specifically. A backend is free to report one write more than once — FSEvents
     * unions flags and can follow a write with a metadata event — and every event after the first
     * describes bytes that have genuinely not changed since the one before it, so it is correct for
     * those to say `contentChanged: false`. The question this suite asks is what the watcher says
     * about the write itself.
     */
    async function writeAndTake(events, target, contents) {
      const from = events.length;
      writeFile(target, contents);
      await waitFor(() => events.slice(from).some((e) => e.path === target), {
        message: `no event for ${target}`,
      });
      await waitForQuiet(() => events.length, { quietMs: 150 });
      return events.slice(from).find((e) => e.path === target);
    }

    it('reports a rewrite with identical bytes as not a content change', async () => {
      const dir = tempDir();
      const target = path.join(dir, 'formatted.js');
      writeFile(target, 'export const a = 1;\n');
      const { events } = await start({ dir });

      // Establish the baseline digest, the way any first sighting would.
      const first = await writeAndTake(events, target, 'export const a = 2;\n');
      expect(first.contentChanged).toBe(true);
      expect(first.hash).toMatch(/^[0-9a-f]{16}$/);

      const rewrite = await writeAndTake(events, target, 'export const a = 2;\n');
      expect(
        rewrite.contentChanged,
        'a file rewritten byte-for-byte must not be reported as a content change'
      ).toBe(false);
      expect(rewrite.hash).toBe(first.hash);
    });

    it('reports a rewrite with different bytes as a content change', async () => {
      const dir = tempDir();
      const target = path.join(dir, 'edited.js');
      writeFile(target, 'v1');
      const { events } = await start({ dir });

      const first = await writeAndTake(events, target, 'v1-baseline');
      const edit = await writeAndTake(events, target, 'v2-genuinely-different');
      expect(edit.contentChanged).toBe(true);
      expect(edit.hash).not.toBe(first.hash);
    });

    it('treats a deletion as a change, and carries no digest for it', async () => {
      const dir = tempDir();
      const target = path.join(dir, 'gone.js');
      writeFile(target, 'x');
      const { events } = await start({ dir });

      fs.unlinkSync(target);
      await waitFor(() => kindsFor(events, target).includes('deleted'), {
        message: 'no deleted event',
      });
      const deletion = events.find((e) => e.path === target && e.kind === 'deleted');
      expect(deletion.contentChanged).toBe(true);
      expect(deletion.hash).toBe(null);
    });

    it('counts the writes it suppressed', async () => {
      const dir = tempDir();
      const target = path.join(dir, 'noisy.js');
      writeFile(target, 'stable');
      const { events, watcher } = await start({ dir });

      await writeAndTake(events, target, 'stable-v2');
      await writeAndTake(events, target, 'stable-v2');

      const stats = watcher.getStats();
      expect(stats.content.filesHashed).toBeGreaterThan(0);
      expect(stats.content.unchanged).toBeGreaterThan(0);
      expect(stats.metrics.eventsUnchanged).toBe(stats.content.unchanged);
    });

    it('asks nothing and reports nothing when content hashing is off', async () => {
      const dir = tempDir();
      const { events, watcher } = await start({ dir, contentHashing: false });
      const target = path.join(dir, 'unasked.js');
      writeFile(target, 'x');
      await waitFor(() => kindsFor(events, target).length > 0, { message: 'no event' });

      const event = events.find((e) => e.path === target);
      expect(event.contentChanged).toBeUndefined();
      expect(watcher.getStats().content).toBe(null);
    });

    // ------------------------------------------------------------------- stats

    it('exposes the same stats shape', async () => {
      const { watcher } = await start();
      const stats = watcher.getStats();
      expect(Object.keys(stats).sort()).toEqual([...STATS_KEYS].sort());
      expect(typeof stats.eventsQueued).toBe('number');
      expect(typeof stats.eventsDropped).toBe('number');
      expect(typeof stats.eventsDelivered).toBe('number');
      expect(typeof stats.watchedPaths).toBe('number');
      expect(typeof stats.queuePending).toBe('number');
      expect(typeof stats.queueCapacity).toBe('number');
      expect(typeof stats.backend).toBe('string');
      expect(stats.isRunning).toBe(true);
      expect(stats.watchedPaths).toBe(1);
    });

    it('counts delivered events and clears isRunning on stop()', async () => {
      const { dir, events, watcher } = await start();
      writeFile(path.join(dir, 'counted.js'), 'x');
      await waitFor(() => events.length > 0, { message: 'no events' });
      expect(watcher.getStats().eventsDelivered).toBeGreaterThan(0);
      watcher.stop();
      expect(watcher.getStats().isRunning).toBe(false);
      expect(watcher.isRunning).toBe(false);
    });

    // ------------------------------------------------------------------ errors

    it('throws the same error type for a path that does not exist', () => {
      const watcher = makeRetrigger();
      open.push(watcher);
      let caught;
      try {
        watcher.add(path.join(tempDir(), 'definitely-absent'));
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught.code).toBe('ENOENT');
    });

    it('throws TypeError for a non-string path', () => {
      const watcher = makeRetrigger();
      open.push(watcher);
      expect(() => watcher.add(42)).toThrow(TypeError);
      expect(() => watcher.unwatch(null)).toThrow(TypeError);
    });

    it('does not let a throwing listener stop event delivery', async () => {
      const { dir, watcher } = await start();
      const seen = [];
      watcher.on('all', () => {
        throw new Error('listener exploded');
      });
      watcher.on('add', (p) => seen.push(p));
      const first = path.join(dir, 'one.js');
      const second = path.join(dir, 'two.js');
      writeFile(first, '1');
      await waitFor(() => seen.length >= 1, { message: 'first event lost' });
      writeFile(second, '2');
      await waitFor(() => seen.length >= 2, { message: 'watcher died after a listener threw' });
    });

    // -------------------------------------------------------------- lifecycle

    it('is idempotent across repeated start/stop cycles', async () => {
      const { dir, events, watcher } = await start();
      for (let i = 0; i < 3; i += 1) {
        watcher.stop();
        watcher.stop();
        watcher.start();
        watcher.start();
      }
      const target = path.join(dir, 'after-cycles.js');
      writeFile(target, 'still alive');
      await waitFor(() => kindsFor(events, target).length > 0, {
        message: 'watcher stopped working after start/stop cycles',
      });
    });

    it('emits ready exactly once per start()', async () => {
      const watcher = makeRetrigger({ paths: tempDir() });
      open.push(watcher);
      let readyCount = 0;
      watcher.on('ready', () => {
        readyCount += 1;
      });
      watcher.start();
      await waitFor(() => readyCount === 1, { message: 'ready never fired' });
      await waitForQuiet(() => readyCount, { quietMs: 100 });
      expect(readyCount).toBe(1);
    });

    // ------------------------------------------------------------------- hash

    it('produces a 16-character lowercase hex digest', () => {
      const watcher = makeRetrigger();
      open.push(watcher);
      const digest = watcher.engine.hashBytesSync(Buffer.from('parity'));
      expect(digest).toMatch(/^[0-9a-f]{16}$/);
      expect(watcher.engine.hashBytesSync(Buffer.from('parity'))).toBe(digest);
      expect(watcher.engine.hashBytesSync(Buffer.from('parity!'))).not.toBe(digest);
    });

    it('agrees between file and buffer hashing', () => {
      const watcher = makeRetrigger();
      open.push(watcher);
      const dir = tempDir();
      const target = path.join(dir, 'hashme.bin');
      const bytes = Buffer.from('content for hashing \u00e9\u00e8');
      writeFile(target, bytes);
      const fromFile = watcher.engine.hashFileSync(target);
      expect(fromFile.hash).toBe(watcher.engine.hashBytesSync(bytes));
      expect(fromFile.size).toBe(bytes.length);
    });
  });
}
