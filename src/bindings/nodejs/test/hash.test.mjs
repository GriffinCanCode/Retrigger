import crypto from 'node:crypto';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import * as jsHash from '../lib/hash-js.js';
import { cleanupTempDirs, tempDir, writeFile } from './helpers/tmp.js';

afterAll(cleanupTempDirs);

const HAS_BLAKE2 = crypto.getHashes().includes('blake2b512');

/**
 * Reference vectors for the algorithm the JavaScript engine actually uses.
 * These are the first 8 bytes of the published BLAKE2b-512 digests, not
 * numbers copied from a previous run of this code.
 */
const BLAKE2B_64_VECTORS = [
  // BLAKE2b-512("") = 786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419...
  ['', '786a02f742015903'],
  // BLAKE2b-512("abc") = ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d1...
  ['abc', 'ba80a53f981c4d0d'],
  // BLAKE2b-512("hello") = e4cfa39a3d37be31c59609e807970799caa68a19bfaa15135f165085e01d41a6...
  ['hello', 'e4cfa39a3d37be31'],
  // BLAKE2b-512("The quick brown fox jumps over the lazy dog")
  //   = a8add4bdddfd93e4877d2746e62817b116364a1fa7bc148d95090bc7333b3673...
  ['The quick brown fox jumps over the lazy dog', 'a8add4bdddfd93e4'],
];

describe('JavaScript engine hash', () => {
  it('names the algorithm it actually uses', () => {
    expect(jsHash.ALGORITHM).toBe(HAS_BLAKE2 ? 'blake2b-64' : 'sha256-64');
    expect(jsHash.ALGORITHM).not.toBe('xxh3-64');
  });

  it.runIf(HAS_BLAKE2)('matches published BLAKE2b reference vectors', () => {
    for (const [input, expected] of BLAKE2B_64_VECTORS) {
      expect(jsHash.hashBytesSync(input)).toBe(expected);
    }
  });

  it('is the documented truncation of the full Node digest', () => {
    const data = Buffer.from('truncation check');
    const full = crypto.createHash(jsHash.NODE_ALGORITHM).update(data).digest('hex');
    expect(jsHash.hashBytesSync(data)).toBe(full.slice(0, 16));
  });

  it('handles empty input', () => {
    expect(jsHash.hashBytesSync(Buffer.alloc(0))).toMatch(/^[0-9a-f]{16}$/);
    expect(jsHash.hashBytesSync('')).toBe(jsHash.hashBytesSync(Buffer.alloc(0)));
  });

  it('treats strings as UTF-8, so unicode is stable and not mangled', () => {
    const text = 'héllo → 世界 🎉';
    expect(jsHash.hashBytesSync(text)).toBe(jsHash.hashBytesSync(Buffer.from(text, 'utf8')));
    expect(jsHash.hashBytesSync('e\u0301')).not.toBe(jsHash.hashBytesSync('\u00e9'));
  });

  it('accepts Uint8Array and ArrayBuffer views without copying semantics changing', () => {
    const backing = Buffer.from('0123456789');
    const view = new Uint8Array(backing.buffer, backing.byteOffset + 2, 5);
    expect(jsHash.hashBytesSync(view)).toBe(jsHash.hashBytesSync(Buffer.from('23456')));
  });

  it('rejects unhashable input with a TypeError', () => {
    expect(() => jsHash.hashBytesSync(42)).toThrow(TypeError);
    expect(() => jsHash.hashBytesSync(null)).toThrow(TypeError);
    expect(() => jsHash.hashBytesSync({})).toThrow(TypeError);
  });

  it('domain-separates a non-zero seed and ignores a zero seed', () => {
    const data = Buffer.from('seeded');
    const unseeded = jsHash.hashBytesSync(data);
    expect(jsHash.hashBytesSync(data, 0n)).toBe(unseeded);
    expect(jsHash.hashBytesSync(data, undefined)).toBe(unseeded);
    expect(jsHash.hashBytesSync(data, 1n)).not.toBe(unseeded);
    expect(jsHash.hashBytesSync(data, 1n)).toBe(jsHash.hashBytesSync(data, 1n));
    expect(jsHash.hashBytesSync(data, 1n)).not.toBe(jsHash.hashBytesSync(data, 2n));
  });

  it('handles a large input and reports its true size', () => {
    const big = crypto.randomBytes(8 * 1024 * 1024);
    const dir = tempDir();
    const target = path.join(dir, 'large.bin');
    writeFile(target, big);
    const result = jsHash.hashFileSync(target);
    expect(result.size).toBe(big.length);
    expect(result.hash).toBe(jsHash.hashBytesSync(big));
  });

  it('streams and buffers a file to the same digest', async () => {
    const dir = tempDir();
    const target = path.join(dir, 'streamed.bin');
    const bytes = crypto.randomBytes(3 * 1024 * 1024 + 17);
    writeFile(target, bytes);
    const streamed = await jsHash.hashFile(target);
    expect(streamed).toEqual(jsHash.hashFileSync(target));
  });

  it('hashes a file whose name contains unicode and spaces', () => {
    const dir = tempDir();
    const target = path.join(dir, 'a file — with ünicode.txt');
    writeFile(target, 'contents');
    expect(jsHash.hashFileSync(target).hash).toBe(jsHash.hashBytesSync('contents'));
  });

  it('rejects a missing file rather than returning a bogus digest', () => {
    expect(() => jsHash.hashFileSync(path.join(tempDir(), 'absent'))).toThrow();
    return expect(jsHash.hashFile(path.join(tempDir(), 'absent'))).rejects.toThrow();
  });

  it('benchmarks with measured, non-fabricated numbers', async () => {
    const result = await jsHash.benchmarkHash(64 * 1024, 8);
    expect(result.level).toBe(jsHash.ALGORITHM);
    expect(result.throughputMbps).toBeGreaterThan(0);
    expect(Number.isFinite(result.nsPerByte)).toBe(true);
    expect(result.nsPerByte).toBeGreaterThan(0);
  });

  it('clamps degenerate benchmark parameters instead of dividing by zero', async () => {
    const result = await jsHash.benchmarkHash(0, 0);
    expect(Number.isFinite(result.throughputMbps)).toBe(true);
    expect(Number.isFinite(result.nsPerByte)).toBe(true);
  });
});
