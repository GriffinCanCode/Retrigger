'use strict';

/**
 * JavaScript-engine content hashing.
 *
 * IMPORTANT — this is NOT XXH3-64.
 *
 * The native engine returns XXH3-64. A correct pure-JS XXH3-64 needs 64-bit
 * arithmetic that JavaScript can only do through BigInt, which is roughly two
 * orders of magnitude slower than the native path and easy to get subtly wrong.
 * Rather than ship a plausible-looking near-miss, the fallback uses a hash Node
 * already implements in C — BLAKE2b-512 truncated to its first 8 bytes (or
 * SHA-256 truncated, on Node builds without BLAKE2) — and reports which one it
 * used via `getEngineInfo().hashAlgorithm`.
 *
 * Consequences, stated plainly:
 *   - Digests are 16 lowercase hex characters on both engines, so the shape is
 *     interchangeable and callers need no branching.
 *   - Digest *values* are NOT comparable across engines. Never persist a hash
 *     produced by one engine and compare it against the other.
 */

const crypto = require('crypto');
const fs = require('fs');

const AVAILABLE = new Set(safeGetHashes());
const NODE_ALGORITHM = AVAILABLE.has('blake2b512') ? 'blake2b512' : 'sha256';

/** Public, stable identifier reported through `getEngineInfo()`. */
const ALGORITHM = NODE_ALGORITHM === 'blake2b512' ? 'blake2b-64' : 'sha256-64';

const DIGEST_BYTES = 8;

/**
 * Bytes held resident while hashing a file.
 *
 * Reading a whole file into a Buffer costs its full size in memory, and a watcher does not get to
 * choose what it is pointed at: a build output, a bundle, a source map, or a dataset committed by
 * mistake are all ordinary things to find in a repository, and any of them can be far larger than the
 * events describing them suggest. Above two gigabytes it is not merely expensive — Node cannot
 * allocate the Buffer at all and the read throws. Chunking makes the cost of hashing a file
 * independent of that file's size, which is the same reason the native core reads in chunks.
 */
const CHUNK_BYTES = 1 << 20;

function safeGetHashes() {
  try {
    return crypto.getHashes();
  } catch {
    return ['sha256'];
  }
}

/**
 * XXH3 accepts a 64-bit seed. There is no keyed variant of `createHash`, so a
 * non-zero seed is domain-separated by prefixing its little-endian bytes.
 * Documented rather than silently ignored.
 */
function seedPrefix(seed) {
  if (seed === undefined || seed === null) return null;
  const value = typeof seed === 'bigint' ? seed : BigInt(seed);
  if (value === 0n) return null;
  const buf = Buffer.allocUnsafe(8);
  buf.writeBigUInt64LE(BigInt.asUintN(64, value));
  return buf;
}

/**
 * @param {Buffer|Uint8Array|string} data
 * @param {bigint|number} [seed]
 * @returns {string} 16 lowercase hex characters
 */
function hashBytesSync(data, seed) {
  const buf = toBuffer(data);
  const hash = crypto.createHash(NODE_ALGORITHM);
  const prefix = seedPrefix(seed);
  if (prefix) hash.update(prefix);
  hash.update(buf);
  return hash.digest().subarray(0, DIGEST_BYTES).toString('hex');
}

/**
 * Hash a file without holding more than {@link CHUNK_BYTES} of it at a time.
 * @param {string} filePath
 * @returns {{hash: string, size: number}}
 */
function hashFileSync(filePath) {
  const hash = crypto.createHash(NODE_ALGORITHM);
  const fd = fs.openSync(filePath, 'r');
  let size = 0;
  try {
    // Sized to the file when it is small, so hashing a directory full of little source files does not
    // allocate a megabyte per file.
    let capacity = CHUNK_BYTES;
    try {
      capacity = Math.min(CHUNK_BYTES, Math.max(1, fs.fstatSync(fd).size));
    } catch {
      /* unknown size: use the full chunk */
    }
    const buf = Buffer.allocUnsafe(capacity);
    for (;;) {
      const read = fs.readSync(fd, buf, 0, capacity, null);
      if (read === 0) break;
      // A view, not a copy: nothing beyond `buf` is allocated per chunk.
      hash.update(buf.subarray(0, read));
      size += read;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { hash: hash.digest().subarray(0, DIGEST_BYTES).toString('hex'), size };
}

/**
 * Asynchronous variant, equally bounded — `createReadStream` reads in chunks.
 * @param {string} filePath
 * @returns {Promise<{hash: string, size: number}>}
 */
function hashFile(filePath) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = crypto.createHash(NODE_ALGORITHM);
    let size = 0;
    const stream = fs.createReadStream(filePath);
    stream.on('error', rejectPromise);
    stream.on('data', (chunk) => {
      size += chunk.length;
      hash.update(chunk);
    });
    stream.on('end', () => {
      resolvePromise({
        hash: hash.digest().subarray(0, DIGEST_BYTES).toString('hex'),
        size,
      });
    });
  });
}

/**
 * Measured throughput for the fallback hash. No invented baselines: the number
 * returned is whatever this machine actually did, just now.
 * @param {number} size bytes per iteration
 * @param {number} iterations
 * @returns {Promise<{throughputMbps: number, nsPerByte: number, level: string}>}
 */
async function benchmarkHash(size, iterations) {
  const bytes = Math.max(1, Math.floor(size));
  const runs = Math.max(1, Math.floor(iterations));
  const buf = crypto.randomBytes(bytes);

  hashBytesSync(buf); // warm the OpenSSL context out of the timed region

  const start = process.hrtime.bigint();
  for (let i = 0; i < runs; i += 1) hashBytesSync(buf);
  const elapsedNs = Number(process.hrtime.bigint() - start);

  const totalBytes = bytes * runs;
  const seconds = elapsedNs / 1e9;
  return {
    throughputMbps: seconds > 0 ? totalBytes / 1e6 / seconds : 0,
    nsPerByte: totalBytes > 0 ? elapsedNs / totalBytes : 0,
    level: ALGORITHM,
  };
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  throw new TypeError('hashBytesSync expects a Buffer, Uint8Array, ArrayBuffer, or string');
}

module.exports = {
  ALGORITHM,
  NODE_ALGORITHM,
  benchmarkHash,
  hashBytesSync,
  hashFile,
  hashFileSync,
};
