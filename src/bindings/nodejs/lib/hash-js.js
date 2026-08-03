'use strict';

/**
 * JavaScript-engine content hashing: genuine XXH3-64, byte-identical to the native engine.
 *
 * The digest is computed by a ~16 KB WebAssembly module compiled ahead of time from the same
 * `xxhash-rust` crate's XXH3 implementation the native addon and the Rust daemon's `Xxh3Hasher`
 * ultimately agree with (see `wasm-xxh3/`, rebuilt by `npm run build:wasm`) -- not reimplemented
 * by hand in JavaScript's much slower BigInt arithmetic, and not a plausible-looking near-miss.
 * `require()` never touches the Rust or `wasm32` toolchain: the compiled artifact ships prebuilt
 * at `lib/xxh3.wasm`, and instantiating it needs nothing from the host beyond the linear memory
 * every WebAssembly runtime already provides -- no imports, so no `env` object to fake.
 *
 * Consequences, stated plainly:
 *   - Digests are 16 lowercase hex characters on both engines, and `getEngineInfo().hashAlgorithm`
 *     reports `"xxh3-64"` for both.
 *   - Digest *values* are canonically comparable across engines: the same bytes and the same seed
 *     produce the same 64-bit number whichever engine computed it. `hash.test.mjs` proves this
 *     against the compiled addon and the official XXH3-64 reference vectors, not merely against
 *     this module's own prior output.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** Public, stable identifier reported through `getEngineInfo()`. */
const ALGORITHM = 'xxh3-64';

const DIGEST_HEX_LENGTH = 16;

/**
 * Bytes held resident per chunk while hashing a file.
 *
 * Reading a whole file into a Buffer costs its full size in memory, and a watcher does not get to
 * choose what it is pointed at: a build output, a bundle, a source map, or a dataset committed by
 * mistake are all ordinary things to find in a repository, and any of them can be far larger than the
 * events describing them suggest. Above two gigabytes it is not merely expensive -- Node cannot
 * allocate the Buffer at all and the read throws. Chunking makes the cost of hashing a file
 * independent of that file's size, which is the same reason the native core reads in chunks -- and
 * why the wasm module has an incremental hasher ([`openStream`]) rather than only a one-shot export.
 */
const CHUNK_BYTES = 1 << 20;

/**
 * Load the bundled module once, at require time. Never throws: a failure here is exceedingly
 * unlikely (this is a fixed local file, not a network fetch or a toolchain invocation) but every
 * other module in this package holds `require()` to the same standard, so this one does too --
 * the error is captured and re-raised, with an actionable message, only if a hash is attempted.
 * @returns {{exports: WebAssembly.Exports}|{error: Error}}
 */
function loadWasm() {
  try {
    const bytes = fs.readFileSync(path.join(__dirname, 'xxh3.wasm'));
    const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
    return { exports: instance.exports };
  } catch (error) {
    return { error };
  }
}

const wasm = loadWasm();

/** @returns {WebAssembly.Exports} */
function engine() {
  if (wasm.error) {
    throw new Error(
      `the bundled XXH3 WebAssembly module (lib/xxh3.wasm) failed to load: ${wasm.error.message}. ` +
        'This is an installation problem, not a usage error -- reinstalling the package should fix it.'
    );
  }
  return wasm.exports;
}

/**
 * Copy `buf` into the module's linear memory, run `fn(ptr)`, and always free the allocation.
 *
 * The view onto `memory.buffer` is created *after* `alloc` returns and not before: `alloc` can
 * grow the module's memory to satisfy the request, and growing detaches any `ArrayBuffer`
 * reference taken before it, which would otherwise make this write silently a no-op.
 * @param {WebAssembly.Exports} wasmExports
 * @param {Buffer} buf
 * @param {(ptr: number) => T} fn
 * @returns {T}
 * @template T
 */
function withCopy(wasmExports, buf, fn) {
  const { memory, alloc, dealloc } = wasmExports;
  const ptr = alloc(buf.length);
  try {
    if (buf.length > 0) new Uint8Array(memory.buffer, ptr, buf.length).set(buf);
    return fn(ptr);
  } finally {
    dealloc(ptr, buf.length);
  }
}

/** @returns {bigint} */
function normalizeSeed(seed) {
  if (seed === undefined || seed === null) return 0n;
  return BigInt.asUintN(64, typeof seed === 'bigint' ? seed : BigInt(seed));
}

/** @returns {string} 16 lowercase hex characters */
function toHex(digest) {
  return BigInt.asUintN(64, digest).toString(16).padStart(DIGEST_HEX_LENGTH, '0');
}

/**
 * @param {Buffer|Uint8Array|string} data
 * @param {bigint|number} [seed]
 * @returns {string} 16 lowercase hex characters
 */
function hashBytesSync(data, seed) {
  const buf = toBuffer(data);
  const wasmExports = engine();
  const seedValue = normalizeSeed(seed);
  return toHex(
    withCopy(wasmExports, buf, (ptr) => wasmExports.xxh3_64(ptr, buf.length, seedValue))
  );
}

/**
 * An incremental XXH3-64 hash over the module's own linear memory, one chunk at a time.
 *
 * The one-shot export used by {@link hashBytesSync} has no way to hash a file without holding
 * all of it in memory at once; this wraps the module's `xxh3_new`/`update`/`digest`/`free`
 * quartet so {@link hashFileSync} and {@link hashFile} can stay within {@link CHUNK_BYTES}
 * regardless of the file's size, and produce the *identical* digest a one-shot call over the
 * concatenated bytes would (`memory.test.mjs` holds this to that standard explicitly).
 * @param {bigint} [seed]
 */
function openStream(seed = 0n) {
  const wasmExports = engine();
  const handle = wasmExports.xxh3_new(seed);
  return {
    /** @param {Buffer} chunk */
    update(chunk) {
      withCopy(wasmExports, chunk, (ptr) => wasmExports.xxh3_update(handle, ptr, chunk.length));
    },
    /** @returns {string} */
    digestHex() {
      return toHex(wasmExports.xxh3_digest(handle));
    },
    free() {
      wasmExports.xxh3_free(handle);
    },
  };
}

/**
 * Hash a file without holding more than {@link CHUNK_BYTES} of it at a time.
 * @param {string} filePath
 * @returns {{hash: string, size: number}}
 */
function hashFileSync(filePath) {
  const stream = openStream();
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
      stream.update(buf.subarray(0, read));
      size += read;
    }
    return { hash: stream.digestHex(), size };
  } finally {
    fs.closeSync(fd);
    stream.free();
  }
}

/**
 * Asynchronous variant, equally bounded -- `createReadStream` reads in chunks, so hashing a large
 * file costs the event loop nothing beyond the ordinary I/O it takes to read one anyway. This is
 * what lets `ContentTracker#annotateAsync` (`lib/content.js`) fingerprint a file too large for the
 * synchronous path without blocking whatever else is scheduled on this tick.
 * @param {string} filePath
 * @param {{signal?: AbortSignal}} [options] `signal` lets a caller give up on a hash already in
 *   flight -- `Retrigger#stop` (`lib/retrigger.js`) does, for every hash a stopped watcher no
 *   longer has a reason to finish -- by destroying the underlying read stream, which releases its
 *   file descriptor exactly as promptly as an error from the file system itself would.
 * @returns {Promise<{hash: string, size: number}>}
 */
function hashFile(filePath, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const { signal } = options;
    if (signal && signal.aborted) {
      rejectPromise(abortError());
      return;
    }
    const stream = openStream();
    let size = 0;
    let settled = false;
    const finish = (run) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      stream.free();
      run();
    };
    const readable = fs.createReadStream(filePath);
    const onAbort = () => readable.destroy(abortError());
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    readable.on('error', (err) => finish(() => rejectPromise(err)));
    readable.on('data', (chunk) => {
      size += chunk.length;
      stream.update(chunk);
    });
    readable.on('end', () => finish(() => resolvePromise({ hash: stream.digestHex(), size })));
  });
}

/** @returns {Error} named and coded the way Node's own abort errors are. */
function abortError() {
  const error = new Error('hashFile was aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
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

  hashBytesSync(buf); // warm the wasm instance's allocator out of the timed region

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
  benchmarkHash,
  hashBytesSync,
  hashFile,
  hashFileSync,
  openStream,
};
