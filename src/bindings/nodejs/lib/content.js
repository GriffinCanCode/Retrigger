'use strict';

/**
 * Content-change detection: the answer to "did the bytes actually change?".
 *
 * A watcher reports that a file was written. That is not the question a bundler has. Editors,
 * formatters, code generators and `git checkout` all rewrite files whose contents are identical to
 * what was already there, and every one of those writes costs a rebuild if the only thing consulted
 * is the fact that a write happened. This keeps a digest per path and answers the real question.
 *
 * # Why this lives above the engine
 *
 * The native addon and the JavaScript fallback both hash with XXH3-64 (`lib/hash-js` compiles the
 * same engine to WebAssembly), so a digest from one is in fact comparable to a digest from the
 * other. This module never relies on that: it compares a path against its own previous digest,
 * taken by the same engine, in the same process, which is what makes the decision below correct
 * even on the day the two engines' outputs happen to differ for a reason neither has yet.
 *
 * # The decision table
 *
 * Deliberately identical to the Rust daemon's `FileEventProcessor`, so the in-process watcher and
 * the daemon cannot disagree about what counts as a change:
 *
 * | event                                                       | `contentChanged` |
 * |-------------------------------------------------------------|------------------|
 * | file created/modified/metadata/rename-target, digest differs  | `true`           |
 * | ditto, digest matches the cached one                          | `false`          |
 * | file could not be read (or, for `annotateAsync`, aborted)      | `true`           |
 * | file too large to hash synchronously within the budget        | `true`           |
 * | file deleted or renamed away                                  | `true`           |
 * | directory created/deleted/renamed                             | `true`           |
 * | directory modified/metadata                                   | `false`          |
 * | rescan signal                                                 | `true`           |
 *
 * Every uncertain case answers `true`. Unknown is not the same as unchanged: a redundant rebuild
 * costs a few seconds, a missed one costs a developer their afternoon.
 *
 * The size budget row is `annotate`'s alone: `annotateAsync` exists precisely so a file over that
 * budget is still read, on the non-blocking path, rather than answered with a guess.
 */

const path = require('path');

const { BoundedMap } = require('./bounded');

/**
 * Digests retained. Same order of magnitude as the Rust processor's default, and bounded for the
 * same reason: the key space is every path a session touches, which nothing in this package limits.
 */
const DEFAULT_MAX_ENTRIES = 100000;

/**
 * Largest file `annotate` hashes synchronously before the answer is assumed to be "changed".
 *
 * `annotate` hashing happens on the drain loop, so it is time the event loop does not have this
 * tick. At the throughputs this package measures, a source file costs tens of microseconds and is
 * unambiguously worth it against a rebuild. Past this size the file is reported as changed without
 * being read synchronously, which is the same fail-safe direction as an unreadable file. `annotateAsync`
 * uses this same threshold the other way around: at or under it a file is small enough that hashing
 * it synchronously is still cheaper than the bookkeeping an async read costs, so `Retrigger`'s drain
 * loop routes only files over this size to the non-blocking path (`engine.hashFile`) instead of
 * skipping them.
 */
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

/** Kinds that mean the path is gone from where it was. Mirrors `EventKind::is_removal`. */
const REMOVALS = new Set(['deleted', 'renamedFrom']);

/** Directory events that are a change of structure rather than of contents. */
const STRUCTURAL = new Set(['created', 'deleted', 'renamedFrom', 'renamedTo']);

class ContentTracker {
  /**
   * @param {{hashFileSync: (file: string) => {hash: string, size: number},
   *   hashFile?: (file: string, options?: {signal?: AbortSignal}) =>
   *     Promise<{hash: string, size: number}>}} engine
   * @param {{maxEntries?: number, maxBytes?: number}} [options]
   */
  constructor(engine, options = {}) {
    this._engine = engine;
    this._maxBytes = positive(options.maxBytes, DEFAULT_MAX_BYTES);
    this._cache = new BoundedMap(positive(options.maxEntries, DEFAULT_MAX_ENTRIES));
    this.filesHashed = 0;
    this.hashErrors = 0;
    this.unchanged = 0;
  }

  /**
   * The size, in bytes, past which a caller should prefer {@link annotateAsync} to
   * {@link annotate} for a file event — the threshold `_fingerprint` itself uses to decide
   * whether reading a file synchronously is still worth it.
   * @returns {number}
   */
  get maxBytes() {
    return this._maxBytes;
  }

  /**
   * Whether `event` is a kind {@link annotate}/{@link annotateAsync} would actually read a file
   * for, as opposed to one answered entirely from `event.kind`/`event.isDirectory` without
   * touching the file system. A caller deciding whether a hash is even in question for `event` —
   * `lib/retrigger.js`'s dispatch does, to route only real fingerprint work through the async
   * path — asks here rather than reimplementing the classification below.
   * @param {{kind: string, isDirectory?: boolean}} event
   * @returns {boolean}
   */
  needsFingerprint(event) {
    return !event.isDirectory && event.kind !== 'rescanRequired' && !REMOVALS.has(event.kind);
  }

  /**
   * Decide whether `event` represents a content change, and annotate it in place.
   *
   * Mutates rather than copying: the event object was just built by the engine for this one
   * delivery, and every listener downstream receives the same object anyway. Returns it for
   * convenience.
   *
   * @param {{path: string, kind: string, size?: number, isDirectory?: boolean}} event
   * @returns {object} the same event, with `contentChanged` and `hash` set
   */
  annotate(event) {
    const { contentChanged, hash } = this._evaluate(event);
    event.contentChanged = contentChanged;
    event.hash = hash;
    if (!contentChanged) this.unchanged += 1;
    return event;
  }

  /**
   * `annotate`'s asynchronous twin, for a file too large to fingerprint synchronously without
   * costing the caller's event loop a noticeable stall.
   *
   * Unlike {@link _fingerprint}, this never treats "too large" as a reason to skip reading the
   * file: the whole reason to call this instead of {@link annotate} is that the caller already
   * has a non-blocking way to read it (`engine.hashFile`, chunked and I/O-driven on every engine
   * this package ships), so there is no size past which guessing "changed" is cheaper than
   * knowing. Directory, removal, and rescan events need no I/O either way and are answered by
   * the same synchronous logic {@link annotate} uses.
   *
   * @param {{path: string, kind: string, size?: number, isDirectory?: boolean}} event
   * @param {{signal?: AbortSignal}} [options] threaded straight through to `engine.hashFile`
   * @returns {Promise<void>}
   */
  async annotateAsync(event, options) {
    if (!this.needsFingerprint(event)) {
      this.annotate(event);
      return;
    }
    const { contentChanged, hash } = await this._fingerprintAsync(event, options);
    event.contentChanged = contentChanged;
    event.hash = hash;
    if (!contentChanged) this.unchanged += 1;
  }

  /** @returns {{contentChanged: boolean, hash: string|null}} */
  _evaluate(event) {
    if (event.kind === 'rescanRequired') return CHANGED;

    if (event.isDirectory) {
      // A removed directory takes its subtree's digests with it, or a file restored at the same
      // path later would be compared against bytes from before the deletion.
      if (REMOVALS.has(event.kind)) this.forgetTree(event.path);
      return STRUCTURAL.has(event.kind) ? CHANGED : UNCHANGED_DIRECTORY;
    }

    if (REMOVALS.has(event.kind)) {
      this.forget(event.path);
      return CHANGED;
    }

    return this._fingerprint(event);
  }

  /** @returns {{contentChanged: boolean, hash: string|null}} */
  _fingerprint(event) {
    // The size the watcher already stat'd, so the ceiling costs no syscall of its own. A size of
    // zero is not trusted as "empty" — it is also what an engine reports when it does not know.
    // This ceiling is specific to the synchronous path: `_fingerprintAsync` has no equivalent,
    // because avoiding exactly this stall on a large file is the reason it exists.
    if (Number.isFinite(event.size) && event.size > this._maxBytes) return CHANGED;

    let hash;
    try {
      hash = this._engine.hashFileSync(event.path).hash;
      this.filesHashed += 1;
    } catch {
      // Unreadable is not unchanged: the file may well have changed, and it may simply have been
      // replaced again between the event and this read.
      this.hashErrors += 1;
      return CHANGED;
    }

    const previous = this._cache.get(event.path);
    this._cache.set(event.path, hash);
    return { contentChanged: previous !== hash, hash };
  }

  /** @returns {Promise<{contentChanged: boolean, hash: string|null}>} */
  async _fingerprintAsync(event, options) {
    let hash;
    try {
      hash = (await this._engine.hashFile(event.path, options)).hash;
      this.filesHashed += 1;
    } catch {
      // Same fail-safe direction as `_fingerprint`: unreadable (including "aborted", from a
      // watcher stopped mid-hash) is reported as changed, never as unchanged.
      this.hashErrors += 1;
      return CHANGED;
    }

    const previous = this._cache.get(event.path);
    this._cache.set(event.path, hash);
    return { contentChanged: previous !== hash, hash };
  }

  /**
   * Forget the digest for one path, so the next event for it is reported as a change.
   * @param {string} target
   */
  forget(target) {
    this._cache.delete(target);
  }

  /**
   * Forget `directory` and everything beneath it.
   * @param {string} directory
   */
  forgetTree(directory) {
    const prefix = directory.endsWith(path.sep) ? directory : directory + path.sep;
    this._cache.deleteMatching((key) => key === directory || key.startsWith(prefix));
  }

  /** Forget everything. */
  clear() {
    this._cache.clear();
  }

  /** @returns {{entries: number, filesHashed: number, hashErrors: number, unchanged: number}} */
  stats() {
    return {
      entries: this._cache.size,
      filesHashed: this.filesHashed,
      hashErrors: this.hashErrors,
      unchanged: this.unchanged,
    };
  }
}

/** Shared results: no allocation on the hot path for the cases that carry no digest. */
const CHANGED = Object.freeze({ contentChanged: true, hash: null });
const UNCHANGED_DIRECTORY = Object.freeze({ contentChanged: false, hash: null });

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

module.exports = { ContentTracker, DEFAULT_MAX_BYTES, DEFAULT_MAX_ENTRIES };
