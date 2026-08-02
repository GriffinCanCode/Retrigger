'use strict';

/**
 * Stand-in for the Rust addon, loadable through `RETRIGGER_NATIVE_PATH`.
 *
 * It exists so the native code path can be exercised while the real binary
 * does not. To keep the parity suite meaningful it is deliberately built on a
 * *different* detection mechanism from the JavaScript engine: this one diffs
 * periodic `readdir`/`stat` snapshots, while `lib/js-watcher.js` reacts to
 * `fs.watch` notifications. Its queue and debounce logic are written from the
 * contract rather than reused, so a disagreement between the two shows up as a
 * failing parity test instead of being defined away.
 *
 * Two things ARE shared with the real implementation and therefore are not
 * independently verified by parity: the glob `Matcher` (glob semantics are one
 * contract, tested directly in `matcher.test.js`) and nothing else.
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const { Matcher } = require('../../lib/matcher');

const SCAN_INTERVAL_MS = Number(process.env.RETRIGGER_MOCK_INTERVAL_MS || 15);

class Watcher {
  constructor(options = {}) {
    this.capacity = options.capacity > 0 ? Math.floor(options.capacity) : 8192;
    this.debounceMs = options.debounceMs > 0 ? Math.floor(options.debounceMs) : 0;
    this.matcher = new Matcher({ include: options.include, exclude: options.exclude });

    this.roots = new Map();
    this.snapshot = new Map();
    this.queue = [];
    this.pending = new Map();
    this.running = false;
    this.overflowed = false;
    this.timer = null;
    this.counters = { queued: 0, dropped: 0, delivered: 0 };
  }

  watch(target, recursive = true) {
    if (typeof target !== 'string' || target.length === 0) {
      throw new TypeError('watch(path) requires a non-empty string path');
    }
    const abs = path.resolve(target);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch (err) {
      const error = new Error(`cannot watch ${abs}: ${err.message}`);
      error.code = err.code || 'ENOENT';
      throw error;
    }
    this.roots.set(abs, { recursive: recursive !== false, isDirectory: stat.isDirectory() });
    if (this.running) this._merge(this._scan(), false);
  }

  unwatch(target) {
    if (typeof target !== 'string' || target.length === 0) {
      throw new TypeError('unwatch(path) requires a non-empty string path');
    }
    const abs = path.resolve(target);
    this.roots.delete(abs);
    for (const key of [...this.snapshot.keys()]) {
      if (key === abs || key.startsWith(abs + path.sep)) this.snapshot.delete(key);
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.snapshot = this._scan();
    this.timer = setInterval(() => this._tick(), SCAN_INTERVAL_MS);
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
    this.queue.length = 0;
    this.snapshot.clear();
    this.overflowed = false;
  }

  poll() {
    const event = this.queue.shift();
    if (!event) return null;
    if (event.kind === 'rescanRequired') this.overflowed = false;
    this.counters.delivered += 1;
    return event;
  }

  stats() {
    return {
      eventsQueued: this.counters.queued,
      eventsDropped: this.counters.dropped,
      eventsDelivered: this.counters.delivered,
      watchedPaths: this.roots.size,
      queuePending: this.queue.length,
      queueCapacity: this.capacity,
      isRunning: this.running,
    };
  }

  backend() {
    return 'polling';
  }

  // --------------------------------------------------------------- internals

  _tick() {
    if (!this.running) return;
    this._merge(this._scan(), true);
  }

  /** @returns {Map<string, {mtimeMs: number, size: number, isDirectory: boolean}>} */
  _scan() {
    const found = new Map();
    for (const [root, info] of this.roots) {
      if (info.isDirectory) this._scanDir(root, info.recursive, found);
      else this._record(root, found);
    }
    return found;
  }

  _scanDir(dir, recursive, found) {
    if (!this.matcher.allowsDirectory(dir)) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!this.matcher.allowsDirectory(full)) continue;
        found.set(full, { mtimeMs: 0, size: 0, isDirectory: true });
        if (recursive) this._scanDir(full, recursive, found);
      } else if (entry.isFile()) {
        this._record(full, found);
      }
    }
  }

  _record(target, found) {
    try {
      const stat = fs.statSync(target);
      found.set(target, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        isDirectory: stat.isDirectory(),
      });
    } catch {
      /* raced with a delete */
    }
  }

  /**
   * @param {Map} next
   * @param {boolean} emit false while adopting a newly registered root
   */
  _merge(next, emit) {
    if (!emit) {
      for (const [key, value] of next) {
        if (!this.snapshot.has(key)) this.snapshot.set(key, value);
      }
      return;
    }
    for (const [key, value] of next) {
      const previous = this.snapshot.get(key);
      if (!previous) {
        this._emit(key, 'created', value);
      } else if (
        !value.isDirectory &&
        (previous.mtimeMs !== value.mtimeMs || previous.size !== value.size)
      ) {
        this._emit(key, 'modified', value);
      }
    }
    for (const [key, value] of this.snapshot) {
      if (!next.has(key)) this._emit(key, 'deleted', value);
    }
    this.snapshot = next;
  }

  _emit(target, kind, info) {
    if (!info.isDirectory && !this.matcher.matches(target)) return;
    if (info.isDirectory && !this.matcher.allowsDirectory(target)) return;
    if (this.debounceMs <= 0) {
      this._enqueue(makeEvent(target, kind, info));
      return;
    }
    const existing = this.pending.get(target);
    if (existing) {
      clearTimeout(existing.timer);
      existing.kind = coalesce(existing.kind, kind);
      existing.info = info;
      existing.timer = setTimeout(() => this._flush(target), this.debounceMs);
      return;
    }
    this.pending.set(target, {
      kind,
      info,
      timer: setTimeout(() => this._flush(target), this.debounceMs),
    });
  }

  _flush(target) {
    const entry = this.pending.get(target);
    if (!entry) return;
    this.pending.delete(target);
    this._enqueue(makeEvent(target, entry.kind, entry.info));
  }

  _enqueue(event) {
    if (this.queue.length >= this.capacity) {
      if (!this.overflowed) {
        this.counters.dropped += this.queue.length;
        this.queue.length = 0;
        this.overflowed = true;
        this.queue.push(makeEvent('', 'rescanRequired', { size: 0, isDirectory: false }));
        this.counters.queued += 1;
      }
      this.counters.dropped += 1;
      return;
    }
    this.queue.push(event);
    this.counters.queued += 1;
  }
}

function makeEvent(target, kind, info) {
  return {
    path: target,
    kind,
    timestampNs: process.hrtime.bigint(),
    size: info && !info.isDirectory ? info.size : 0,
    isDirectory: Boolean(info && info.isDirectory),
    cookie: null,
  };
}

function coalesce(previous, next) {
  if (next === 'deleted') return 'deleted';
  if (previous === 'created' && next === 'modified') return 'created';
  if (previous === 'deleted' && next === 'created') return 'modified';
  return next;
}

// --------------------------------------------------------------------- hash

/**
 * A distinct algorithm from both the real addon (xxh3-64) and the JavaScript
 * fallback (blake2b-64), so tests can prove `getEngineInfo()` reports what is
 * actually in use rather than a hard-coded label.
 */
function digest(buf) {
  return crypto.createHash('sha1').update(buf).digest().subarray(0, 8).toString('hex');
}

module.exports = {
  Watcher,
  hashAlgorithm: () => 'mock-sha1-64',
  getSimdSupport: () => 'mock-simd',
  getCpuLevel: () => 'mock-simd',
  getAvailableLevels: () => ['scalar', 'mock-simd'],
  hashBytesSync: (data) => digest(Buffer.isBuffer(data) ? data : Buffer.from(data)),
  hashFileSync: (file) => {
    const buf = fs.readFileSync(file);
    return { hash: digest(buf), size: buf.length };
  },
  hashFile: async (file) => {
    const buf = await fs.promises.readFile(file);
    return { hash: digest(buf), size: buf.length };
  },
  benchmarkHash: async (size, iterations) => ({
    throughputMbps: 1,
    nsPerByte: 1,
    level: 'mock-simd',
  }),
};
