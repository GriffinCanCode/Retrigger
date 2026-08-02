/**
 * The content-change decision table, tested directly.
 *
 * `parity.test.mjs` proves the decision is reached identically on every engine through real file
 * system events. This proves the table itself — including the branches an event stream cannot be
 * made to produce on demand, such as an unreadable file or a cache at its ceiling.
 *
 * The expected values here come from the table documented on `lib/content.js` and on the Rust
 * `FileEventProcessor` it deliberately mirrors, not from running this code and recording what it
 * said.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { ContentTracker, DEFAULT_MAX_BYTES } from '../lib/content.js';
import { BoundedMap } from '../lib/bounded.js';
import jsHash from '../lib/hash-js.js';
import { cleanupTempDirs, tempDir, writeFile } from './helpers/tmp.js';

afterAll(cleanupTempDirs);

/** The JavaScript engine's hash surface is all a tracker needs. */
const engine = { hashFileSync: jsHash.hashFileSync };

const event = (target, kind, extra = {}) => ({
  path: target,
  kind,
  size: 0,
  isDirectory: false,
  ...extra,
});

describe('ContentTracker', () => {
  it('treats the first sighting of a file as a change', () => {
    const dir = tempDir();
    const target = path.join(dir, 'a.txt');
    writeFile(target, 'hello');

    const annotated = new ContentTracker(engine).annotate(event(target, 'created'));
    expect(annotated.contentChanged).toBe(true);
    expect(annotated.hash).toBe(jsHash.hashBytesSync('hello'));
  });

  it('does not call a byte-for-byte rewrite a change', () => {
    const dir = tempDir();
    const target = path.join(dir, 'a.txt');
    writeFile(target, 'hello');
    const tracker = new ContentTracker(engine);

    tracker.annotate(event(target, 'created'));
    writeFile(target, 'hello');
    const second = tracker.annotate(event(target, 'modified'));

    expect(
      second.contentChanged,
      'a formatter that rewrites a file byte-for-byte must not wake the bundler'
    ).toBe(false);
    expect(tracker.stats().unchanged).toBe(1);
  });

  it('calls changed bytes a change', () => {
    const dir = tempDir();
    const target = path.join(dir, 'a.txt');
    writeFile(target, 'hello');
    const tracker = new ContentTracker(engine);

    tracker.annotate(event(target, 'created'));
    writeFile(target, 'hello!');
    const second = tracker.annotate(event(target, 'modified'));

    expect(second.contentChanged).toBe(true);
    expect(second.hash).toBe(jsHash.hashBytesSync('hello!'));
  });

  it('still verifies contents behind a metadata event', () => {
    const dir = tempDir();
    const target = path.join(dir, 'a.txt');
    writeFile(target, 'x');
    const tracker = new ContentTracker(engine);

    tracker.annotate(event(target, 'created'));
    const meta = tracker.annotate(event(target, 'metadata'));
    expect(meta.contentChanged).toBe(false);
    expect(tracker.stats().filesHashed).toBe(2);
  });

  it('treats an unreadable file as changed rather than unchanged', () => {
    const tracker = new ContentTracker(engine);
    const annotated = tracker.annotate(event('/definitely/not/here.txt', 'modified'));

    expect(
      annotated.contentChanged,
      'unknown must fail towards rebuilding, never towards silence'
    ).toBe(true);
    expect(annotated.hash).toBe(null);
    expect(tracker.stats().hashErrors).toBe(1);
  });

  it('reports a file above the ceiling as changed without reading it', () => {
    const dir = tempDir();
    const target = path.join(dir, 'big.bin');
    writeFile(target, 'not actually big');
    const tracker = new ContentTracker(engine, { maxBytes: 4 });

    const annotated = tracker.annotate(event(target, 'modified', { size: 1024 }));
    expect(annotated.contentChanged).toBe(true);
    expect(annotated.hash).toBe(null);
    expect(tracker.stats().filesHashed, 'the file must not have been opened').toBe(0);
  });

  it('hashes a file whose reported size is unknown', () => {
    const dir = tempDir();
    const target = path.join(dir, 'unknown-size.txt');
    writeFile(target, 'content');
    const tracker = new ContentTracker(engine, { maxBytes: 4 });

    // Size 0 is what an engine reports when it does not know, and is also a genuinely empty file.
    // Neither may be mistaken for "over the ceiling".
    const annotated = tracker.annotate(event(target, 'modified', { size: 0 }));
    expect(annotated.hash).toBe(jsHash.hashBytesSync('content'));
  });

  it('defaults the ceiling to four mebibytes', () => {
    expect(DEFAULT_MAX_BYTES).toBe(4 * 1024 * 1024);
  });

  describe('removals', () => {
    it('are a change, and forget the digest so a recreation is one too', () => {
      const dir = tempDir();
      const target = path.join(dir, 'a.txt');
      writeFile(target, 'x');
      const tracker = new ContentTracker(engine);

      tracker.annotate(event(target, 'created'));
      expect(tracker.stats().entries).toBe(1);

      const deletion = tracker.annotate(event(target, 'deleted'));
      expect(deletion.contentChanged).toBe(true);
      expect(deletion.hash).toBe(null);
      expect(tracker.stats().entries).toBe(0);

      // Restoring the same bytes at the same path is a change: what the consumer built against is
      // gone, and it was told so.
      writeFile(target, 'x');
      expect(tracker.annotate(event(target, 'created')).contentChanged).toBe(true);
    });

    it('include the source half of a rename', () => {
      const tracker = new ContentTracker(engine);
      const annotated = tracker.annotate(event('/anywhere/before.txt', 'renamedFrom'));
      expect(annotated.contentChanged).toBe(true);
      expect(tracker.stats().hashErrors, 'a vanished path must not be read').toBe(0);
    });
  });

  describe('directories', () => {
    it('are structural: created, deleted and renamed are changes', () => {
      const tracker = new ContentTracker(engine);
      for (const kind of ['created', 'deleted', 'renamedFrom', 'renamedTo']) {
        const annotated = tracker.annotate(event('/some/dir', kind, { isDirectory: true }));
        expect(annotated.contentChanged, `${kind} on a directory`).toBe(true);
        expect(annotated.hash).toBe(null);
      }
    });

    it('are not changed by mtime churn', () => {
      const tracker = new ContentTracker(engine);
      for (const kind of ['modified', 'metadata']) {
        expect(
          tracker.annotate(event('/some/dir', kind, { isDirectory: true })).contentChanged,
          `${kind} on a directory`
        ).toBe(false);
      }
      expect(tracker.stats().filesHashed).toBe(0);
    });

    it('forget their whole subtree when removed, and nothing outside it', () => {
      const dir = tempDir();
      const inside = path.join(dir, 'sub', 'deep', 'a.txt');
      const sibling = path.join(dir, 'submarine.txt');
      const outside = path.join(dir, 'other.txt');
      for (const [target, body] of [
        [inside, 'a'],
        [sibling, 'b'],
        [outside, 'c'],
      ]) {
        writeFile(target, body);
      }

      const tracker = new ContentTracker(engine);
      tracker.annotate(event(inside, 'created'));
      tracker.annotate(event(sibling, 'created'));
      tracker.annotate(event(outside, 'created'));
      expect(tracker.stats().entries).toBe(3);

      tracker.annotate(event(path.join(dir, 'sub'), 'deleted', { isDirectory: true }));
      expect(
        tracker.stats().entries,
        'only paths beneath the deleted directory should be forgotten — "submarine.txt" merely ' +
          'starts with the same characters as "sub"'
      ).toBe(2);
    });
  });

  it('treats a rescan signal as a change and touches no file', () => {
    const tracker = new ContentTracker(engine);
    const annotated = tracker.annotate(event('', 'rescanRequired'));
    expect(annotated.contentChanged).toBe(true);
    expect(annotated.hash).toBe(null);
    expect(tracker.stats().filesHashed).toBe(0);
    expect(tracker.stats().hashErrors).toBe(0);
  });

  it('keeps the digest cache under its ceiling', () => {
    const dir = tempDir();
    const tracker = new ContentTracker(engine, { maxEntries: 32 });
    for (let i = 0; i < 500; i += 1) {
      const target = path.join(dir, `f${i}.txt`);
      writeFile(target, `body ${i}`);
      tracker.annotate(event(target, 'created'));
    }
    expect(tracker.stats().entries).toBeLessThanOrEqual(32);
    expect(tracker.stats().filesHashed).toBe(500);
  });

  it('forgets everything on clear()', () => {
    const dir = tempDir();
    const target = path.join(dir, 'a.txt');
    writeFile(target, 'x');
    const tracker = new ContentTracker(engine);

    tracker.annotate(event(target, 'created'));
    tracker.clear();
    expect(tracker.stats().entries).toBe(0);
    expect(tracker.annotate(event(target, 'modified')).contentChanged).toBe(true);
  });

  it('survives a file replaced by a directory between events', () => {
    const dir = tempDir();
    const target = path.join(dir, 'swapped');
    writeFile(target, 'was a file');
    const tracker = new ContentTracker(engine);
    tracker.annotate(event(target, 'created'));

    fs.rmSync(target);
    fs.mkdirSync(target);
    // Reported as a file because the watcher stat'd it before the swap: reading it throws EISDIR,
    // which must degrade to "changed" rather than escaping to the drain loop.
    const annotated = tracker.annotate(event(target, 'modified'));
    expect(annotated.contentChanged).toBe(true);
    expect(tracker.stats().hashErrors).toBe(1);
  });
});

describe('BoundedMap', () => {
  it('holds its ceiling across both generations', () => {
    const map = new BoundedMap(32);
    for (let i = 0; i < 10000; i += 1) map.set(`key-${i}`, i);
    expect(map.size).toBeLessThanOrEqual(32);
  });

  it('returns the newest value for a key rewritten across a rotation', () => {
    const map = new BoundedMap(8);
    map.set('a', 'first');
    // Enough insertions to rotate 'a' into the aging generation and back out again.
    for (let i = 0; i < 6; i += 1) map.set(`filler-${i}`, i);
    map.set('a', 'second');
    for (let i = 6; i < 12; i += 1) map.set(`filler-${i}`, i);
    expect(map.get('a')).not.toBe('first');
  });

  it('deletes from whichever generation holds the key', () => {
    const map = new BoundedMap(8);
    map.set('a', 1);
    for (let i = 0; i < 4; i += 1) map.set(`filler-${i}`, i);
    expect(map.delete('a')).toBe(true);
    expect(map.get('a')).toBeUndefined();
    expect(map.delete('a')).toBe(false);
  });

  it('reports a miss as undefined rather than throwing', () => {
    expect(new BoundedMap(8).get('absent')).toBeUndefined();
  });
});
