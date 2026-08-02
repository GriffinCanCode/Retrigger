// Property-based coverage for the pure-JavaScript surface: the glob matcher, the two-generation
// bounded containers, the content-change decision table, the chunked file hasher, and engine option
// normalization. Every `fc.assert` runs with a fixed seed so a failure is a permanent, replayable
// regression rather than a coin toss — rerun with the same seed to reproduce, and fast-check prints
// the shrunk counterexample to paste straight into an example test.

import fs from 'node:fs';
import path from 'node:path';

import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BoundedMap, BoundedSet } from '../lib/bounded.js';
import { ContentTracker } from '../lib/content.js';
import { getEngine, javascriptEngine } from '../lib/engine.js';
import { hashBytesSync, hashFile, hashFileSync } from '../lib/hash-js.js';
import { compile, Matcher } from '../lib/matcher.js';
import { cleanupTempDirs, tempDir } from './helpers/tmp.js';

/** One seed for the whole file: reproducible, and the number to quote in a bug report. */
const SEED = 0xc0ffee;

/** A path segment that carries no separator and no glob metacharacter. */
const segment = fc.stringMatching(/^[a-zA-Z0-9._-]+$/).filter((s) => s.length > 0 && s.length < 24);

/** An absolute-looking POSIX path built from real segments. */
const unixPath = fc
  .array(segment, { minLength: 1, maxLength: 6 })
  .map((segs) => `/${segs.join('/')}`);

describe('glob matcher properties', () => {
  it('matches the same whether a path uses forward or back slashes', () => {
    // Windows separators are normalised before matching, so the two spellings of one path can never
    // disagree — a filter that fired on a POSIX path but not its Windows twin would be a portability
    // bug that only shows up on one OS.
    fc.assert(
      fc.property(unixPath, (p) => {
        const m = new Matcher({ include: ['**/*'], exclude: ['**/node_modules/**', '*.log'] });
        expect(m.matches(p)).toBe(m.matches(p.replaceAll('/', '\\')));
      }),
      { seed: SEED, numRuns: 300 }
    );
  });

  it('lets exclusion beat inclusion for every path', () => {
    // `**/*` matches anything, so no set of includes may rescue a path it rejects.
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('**/*.js', 'src/**', '**/*'), { maxLength: 4 }),
        unixPath,
        (include, p) => {
          expect(new Matcher({ include, exclude: ['**/*'] }).matches(p)).toBe(false);
        }
      ),
      { seed: SEED, numRuns: 200 }
    );
  });

  it('never lets a single star cross a separator but always lets ** do so', () => {
    fc.assert(
      fc.property(fc.array(segment, { minLength: 2, maxLength: 5 }), (segs) => {
        const middle = segs.join('/');
        // A double star spans however many segments sit between a and b.
        expect(compile('a/**/b').test(`a/${middle}/b`)).toBe(true);
        // A single star must not: two or more segments cannot collapse into one `*`.
        expect(compile('a/*/b').test(`a/${middle}/b`)).toBe(false);
      }),
      { seed: SEED, numRuns: 200 }
    );
  });

  it('treats a metacharacter-free literal as itself and never throws', () => {
    // Regex-special but glob-inert characters (`. + ^ $ ( ) | =`) must stay literal, so a filename
    // that happens to contain them matches the pattern spelled the same way.
    const literal = fc
      .stringMatching(/^[a-zA-Z0-9.+^$()=@!~-]+$/)
      .filter((s) => s.length > 0 && s.length < 32);
    fc.assert(
      fc.property(literal, (lit) => {
        expect(() => compile(lit)).not.toThrow();
        expect(compile(lit).test(lit)).toBe(true);
      }),
      { seed: SEED, numRuns: 300 }
    );
  });
});

/** A key drawn from a small pool, so collisions and generation rotations actually happen. */
const key = fc.integer({ min: 0, max: 30 }).map((n) => `k${n}`);

describe('bounded container properties', () => {
  it('keeps a BoundedSet within its ceiling and exact until it first forgets', () => {
    const op = fc.oneof(
      key.map((k) => ({ kind: 'add', k })),
      key.map((k) => ({ kind: 'delete', k })),
      fc.constant({ kind: 'clear' })
    );
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 16 }),
        fc.array(op, { maxLength: 120 }),
        (ceiling, ops) => {
          const set = new BoundedSet(ceiling);
          const live = new Set(); // what an unbounded set would still hold

          for (const o of ops) {
            if (o.kind === 'add') {
              set.add(o.k);
              live.add(o.k);
              // The just-added key is always present: forgetting only ever touches the older generation.
              expect(set.has(o.k)).toBe(true);
            } else if (o.kind === 'delete') {
              set.delete(o.k);
              live.delete(o.k);
              expect(set.has(o.k)).toBe(false);
            } else {
              set.clear();
              live.clear();
            }

            expect(set.size).toBeLessThanOrEqual(ceiling);
            // While nothing has been dropped, the bounded set is indistinguishable from an exact one.
            if (!set.forgotten) {
              for (const k of live) expect(set.has(k)).toBe(true);
            }
          }
        }
      ),
      { seed: SEED, numRuns: 300 }
    );
  });

  it('keeps a BoundedMap within its ceiling and always returns the freshest value', () => {
    const op = fc.oneof(
      fc.record({ kind: fc.constant('set'), k: key, v: fc.integer() }),
      fc.record({ kind: fc.constant('delete'), k: key })
    );
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 16 }),
        fc.array(op, { maxLength: 120 }),
        (ceiling, ops) => {
          const map = new BoundedMap(ceiling);
          for (const o of ops) {
            if (o.kind === 'set') {
              map.set(o.k, o.v);
              // Recency is unconditional: a value just stored is readable, and no stale copy in the
              // aging generation may shadow it.
              expect(map.get(o.k)).toBe(o.v);
            } else {
              map.delete(o.k);
              expect(map.get(o.k)).toBeUndefined();
            }
            expect(map.size).toBeLessThanOrEqual(ceiling);
          }
        }
      ),
      { seed: SEED, numRuns: 300 }
    );
  });
});

describe('content-change decision properties', () => {
  it('reports a change exactly when the digest differs from the cached one', () => {
    // A deterministic fake engine: the "hash" of a path is whatever value was last written to it, so
    // the reference model can predict every decision without touching a disk or a real hash.
    const op = fc.oneof(
      fc.record({
        kind: fc.constant('write'),
        idx: fc.integer({ min: 0, max: 5 }),
        val: fc.integer(),
      }),
      fc.record({ kind: fc.constant('touch'), idx: fc.integer({ min: 0, max: 5 }) }),
      fc.record({ kind: fc.constant('delete'), idx: fc.integer({ min: 0, max: 5 }) })
    );
    fc.assert(
      fc.property(fc.array(op, { minLength: 1, maxLength: 60 }), (ops) => {
        const store = new Map(); // path -> current digest, present iff the file "exists"
        const engine = {
          hashFileSync(p) {
            const v = store.get(p);
            if (v === undefined) throw new Error('ENOENT');
            return { hash: v, size: v.length };
          },
        };
        const tracker = new ContentTracker(engine);
        const cached = new Map(); // path -> last digest the tracker fingerprinted

        for (const o of ops) {
          const p = `/f${o.idx}`;
          if (o.kind === 'write') {
            store.set(p, `d${o.val}`);
          } else if (o.kind === 'touch') {
            const ev = tracker.annotate({ path: p, kind: 'modified', size: 0, isDirectory: false });
            if (store.has(p)) {
              const h = store.get(p);
              expect(ev.hash).toBe(h);
              expect(ev.contentChanged).toBe(cached.get(p) !== h);
              cached.set(p, h);
            } else {
              // Unreadable is not unchanged, and a failed read stores nothing.
              expect(ev.contentChanged).toBe(true);
              expect(ev.hash).toBeNull();
            }
          } else {
            store.delete(p);
            const ev = tracker.annotate({ path: p, kind: 'deleted', size: 0, isDirectory: false });
            expect(ev.contentChanged).toBe(true);
            expect(ev.hash).toBeNull();
            cached.delete(p);
          }
        }
      }),
      { seed: SEED, numRuns: 300 }
    );
  });
});

describe('hash-js chunking properties', () => {
  let dir;
  let counter = 0;
  beforeAll(() => {
    dir = tempDir('retrigger-prop-hash-');
  });
  afterAll(() => {
    cleanupTempDirs();
  });

  it('hashes a file to exactly what hashing its bytes yields, at every length', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 4096 }), (bytes) => {
        const buf = Buffer.from(bytes);
        const file = path.join(dir, `s${counter++}.bin`);
        fs.writeFileSync(file, buf);

        const fromFile = hashFileSync(file);
        const fromBytes = hashBytesSync(buf);
        // The read loop must reassemble the identical digest and report the true byte count.
        expect(fromFile.hash).toBe(fromBytes);
        expect(fromFile.size).toBe(buf.length);
        expect(fromFile.hash).toMatch(/^[0-9a-f]{16}$/);
        // A zero seed is the no-seed case, and the digest is deterministic.
        expect(hashBytesSync(buf, 0n)).toBe(fromBytes);
        expect(hashBytesSync(buf)).toBe(fromBytes);
      }),
      { seed: SEED, numRuns: 150 }
    );
  });

  it('agrees between the synchronous and streaming file hashers', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 4096 }), async (bytes) => {
        const buf = Buffer.from(bytes);
        const file = path.join(dir, `a${counter++}.bin`);
        fs.writeFileSync(file, buf);

        const sync = hashFileSync(file);
        const streamed = await hashFile(file);
        expect(streamed.hash).toBe(sync.hash);
        expect(streamed.size).toBe(sync.size);
      }),
      { seed: SEED, numRuns: 80 }
    );
  });
});

describe('engine normalization properties', () => {
  it('builds a complete JavaScript engine for any reason string', () => {
    const methods = [
      'createWatcher',
      'hashBytesSync',
      'hashFileSync',
      'hashFile',
      'benchmarkHash',
      'getSimdSupport',
      'getCpuLevel',
      'getAvailableLevels',
    ];
    fc.assert(
      fc.property(fc.string(), (reason) => {
        const engine = javascriptEngine(reason);
        expect(engine.name).toBe('javascript');
        expect(engine.reason).toBe(reason);
        expect(typeof engine.hashAlgorithm).toBe('string');
        for (const m of methods) expect(typeof engine[m]).toBe('function');
        expect(engine.getSimdSupport()).toBe('scalar');
        expect(engine.getAvailableLevels()).toEqual(['scalar']);
      }),
      { seed: SEED, numRuns: 200 }
    );
  });

  it('always returns the JavaScript engine when it is explicitly preferred, whatever the environment', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.string()), (env) => {
        const engine = getEngine({ prefer: 'javascript', env, fresh: true });
        expect(engine.name).toBe('javascript');
      }),
      { seed: SEED, numRuns: 200 }
    );
  });
});
