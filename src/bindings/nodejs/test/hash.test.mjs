import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import * as jsHash from '../lib/hash-js.js';
import { cleanupTempDirs, tempDir, writeFile } from './helpers/tmp.js';

afterAll(cleanupTempDirs);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');
const require = createRequire(import.meta.url);

/**
 * The compiled Rust addon, if one has been built for this host -- the same lookup
 * `parity-native.test.mjs` uses, duplicated rather than imported so this file has no reason to
 * load `lib/native.js` (and therefore no reason to touch `RETRIGGER_NATIVE_PATH`, which every
 * other suite in this process also reads exactly once).
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
      'linux-s390x-gnu',
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

/**
 * The xxHash sanity-check byte generator: an LCG seeded with `PRIME32_1`, taking the high byte
 * of each 32-bit state. This exact sequence is what `src/core/tests/test_vectors.c` feeds
 * through the upstream xxHash reference implementation to produce the vectors below -- changing
 * this generator would make every one of those vectors describe a different input.
 * @param {number} len
 * @returns {Buffer}
 */
function fillTestBuffer(len) {
  const buf = Buffer.allocUnsafe(len);
  let r = 2654435761;
  for (let i = 0; i < len; i += 1) {
    r = (Math.imul(r, 2654435761) + 2654435769) >>> 0;
    buf[i] = (r >>> 24) & 0xff;
  }
  return buf;
}

/**
 * A sample of `src/core/tests/test_vectors.c`'s table: every length class boundary the algorithm
 * itself defines (0, the 1-3/4-8/9-16 short paths, 17-128, 129-240, the 240/241 crossover into
 * the long path, and the 4096-byte secret-block scale), each at all four of that file's seeds.
 *
 * PROVENANCE: produced by the upstream xxHash reference implementation (xxHash v0.8.3, `xxhash.h`
 * SHA-256 `17973c0dc49d9854ca26caa191f0e12f7a424b68858d9a78de3860d959d85e4b`), not by this code --
 * see `test_vectors.c` for the full table and its cross-checks against `xxhsum` and the Python
 * `xxhash` module. `0x2d06800538d394c2` for the empty input is the widely published XXH3-64 hash
 * of `""`.
 */
const OFFICIAL_VECTORS = [
  [0, 0x0000000000000000n, 0x2d06800538d394c2n],
  [0, 0x0000000000000001n, 0x4dc5b0cc826f6703n],
  [0, 0x9e3779b185ebca87n, 0x07f70f819703314dn],
  [0, 0xffffffffffffffffn, 0x4c093276ae47a555n],
  [1, 0x0000000000000000n, 0xdd02fbe6d2c66464n],
  [3, 0x9e3779b185ebca87n, 0xb15fee9f3508fbadn],
  [8, 0x0000000000000000n, 0x9d14848e54f122a8n],
  [9, 0xffffffffffffffffn, 0xcd09a583ca133a12n],
  [16, 0x0000000000000000n, 0x65d15380c6cbcc1cn],
  [17, 0x0000000000000000n, 0x1f523e66cebaf22fn],
  [127, 0x9e3779b185ebca87n, 0x1fa159212e08da6dn],
  [128, 0x0000000000000000n, 0xb5d563b38c2810afn],
  [129, 0xffffffffffffffffn, 0xecd602aa56a3a75fn],
  [239, 0x0000000000000000n, 0xac68f5437a2e3188n],
  [240, 0x0000000000000000n, 0x89b3b9e11abe7146n],
  [241, 0x0000000000000000n, 0x287e3395cd063d80n],
  [4095, 0x0000000000000000n, 0x5851c8e382e77ee1n],
  [4096, 0x0000000000000000n, 0xf092d3c13d60b3a3n],
  [100000, 0x0000000000000000n, 0x6b0a48c2264c8324n],
];

/** The longest input any vector or cross-engine check below needs. */
const REFERENCE_BUFFER = fillTestBuffer(100000);

function hex(big) {
  return big.toString(16).padStart(16, '0');
}

describe('JavaScript engine hash', () => {
  it('names the algorithm it actually uses', () => {
    expect(jsHash.ALGORITHM).toBe('xxh3-64');
  });

  it('matches the published XXH3-64 reference vectors', () => {
    for (const [len, seed, expected] of OFFICIAL_VECTORS) {
      const input = REFERENCE_BUFFER.subarray(0, len);
      expect(jsHash.hashBytesSync(input, seed)).toBe(hex(expected));
    }
  });

  it.skipIf(!ADDON)(
    'agrees with the compiled native addon on a corpus spanning every chunk and secret-block boundary',
    () => {
      // The corpus the plan calls for by name: empty, one byte, the 240/241 long-path crossover,
      // 4 KiB, ~300 KB, and a size that straddles hash-js's own 1 MiB chunk boundary.
      const CHUNK = 1 << 20;
      const sizes = [0, 1, 240, 241, 4096, 300_000, CHUNK - 1, CHUNK, CHUNK + 1];
      for (const size of sizes) {
        const bytes = fillTestBuffer(size);
        for (const seed of [undefined, 0n, 1n, 0x9e3779b185ebca87n]) {
          const fromNative = native.hashBytesSync(bytes, seed);
          const fromFallback = jsHash.hashBytesSync(bytes, seed);
          expect(fromFallback, `size=${size} seed=${seed}`).toBe(fromNative);
        }
      }
    }
  );

  it.skipIf(!ADDON)('agrees with the compiled native addon on a multi-chunk file', () => {
    const dir = tempDir();
    const target = path.join(dir, 'cross-engine.bin');
    const bytes = fillTestBuffer((1 << 20) * 2 + 12_345);
    writeFile(target, bytes);
    expect(jsHash.hashFileSync(target)).toEqual(native.hashFileSync(target));
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

  it('a zero seed and no seed are the same input to XXH3, and any other seed changes the digest', () => {
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

  it('an open stream is freed on error, not merely on success', async () => {
    // `openStream()` hands back a wasm-side allocation; a hasher that errors partway through a
    // read must still release it. This cannot observe the allocation directly, so it observes the
    // only thing that would go wrong if it leaked: many failed hashes in a row still work.
    for (let i = 0; i < 50; i += 1) {
      await expect(jsHash.hashFile(path.join(tempDir(), `absent-${i}`))).rejects.toThrow();
    }
    expect(jsHash.hashBytesSync('still alive')).toMatch(/^[0-9a-f]{16}$/);
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
