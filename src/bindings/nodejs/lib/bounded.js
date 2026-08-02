'use strict';

/**
 * A membership set with a hard ceiling, for tracking paths the file system chose.
 *
 * The JavaScript fallback watcher has to remember which files it has already reported, so it can
 * tell `created` from `modified`. The key space for that is "every path this process has ever seen",
 * which is not a bound — a long dev session in which build artifacts, editor temp files, or an agent's
 * scratch output come and go under unique names grows the set forever, and a `Set` of absolute path
 * strings costs roughly the length of each path plus per-entry overhead.
 *
 * Same policy as the Rust daemon's `BoundedMap`, for the same reasons and with the same trade:
 *
 *   - two generations; membership is checked against both, additions only ever land in the newer one;
 *   - when the newer generation fills, it becomes the older one and the generation behind it is
 *     dropped, which releases its strings in one move rather than scanning for candidates;
 *   - the ceiling therefore holds without any pass over the contents, in O(1) per addition, and the
 *     memory is genuinely returned instead of leaving a `Set` that has been emptied but still holds
 *     its table.
 *
 * The cost is forgetting, so callers must only use this where forgetting is *safe*: re-`add` an entry
 * whenever it is seen, so the paths under active change stay in the live generation, and never let a
 * miss decide whether an event is emitted at all — only what it is called.
 */
class BoundedSet {
  /**
   * @param {number} ceiling maximum entries held across both generations
   */
  constructor(ceiling) {
    const limit = Number(ceiling);
    /** Entries permitted per generation; two of them, hence the halving. */
    this._generation = Number.isFinite(limit) && limit >= 2 ? Math.floor(limit / 2) : 1;
    /** @type {Set<string>} */
    this._fresh = new Set();
    /** @type {Set<string>} */
    this._aging = new Set();
    this._forgotten = false;
  }

  /**
   * Whether any entry has ever been dropped to honour the ceiling.
   *
   * Lets a caller tell the two meanings of a failed {@link BoundedSet#has} apart. While this is
   * `false` the set is exact, so a miss proves the key was never added; once it is `true` a miss may
   * simply mean the key aged out, and a caller whose decision would otherwise be unsafe can fall back
   * to the conservative branch. A project small enough never to reach the ceiling therefore behaves
   * exactly as an unbounded set would.
   *
   * @returns {boolean}
   */
  get forgotten() {
    return this._forgotten;
  }

  /**
   * @param {string} key
   * @returns {boolean}
   */
  has(key) {
    return this._fresh.has(key) || this._aging.has(key);
  }

  /**
   * Record `key`, retiring a generation if this addition filled the current one.
   * @param {string} key
   */
  add(key) {
    this._fresh.add(key);
    if (this._fresh.size >= this._generation) {
      if (this._aging.size > 0) this._forgotten = true;
      this._aging = this._fresh;
      this._fresh = new Set();
    }
  }

  /**
   * @param {string} key
   * @returns {boolean} whether the key was present
   */
  delete(key) {
    // Both, because a key can sit in either generation.
    const fresh = this._fresh.delete(key);
    const aging = this._aging.delete(key);
    return fresh || aging;
  }

  /**
   * Drop every entry whose key `reject` accepts.
   *
   * The one O(size) operation here, which is inherent: a set cannot answer a question about key
   * prefixes without visiting its keys. Deleting during iteration is well defined for `Set`, so this
   * does not copy — copying is what made the previous subtree-forget quadratic.
   *
   * @param {(key: string) => boolean} reject
   */
  deleteMatching(reject) {
    for (const generation of [this._fresh, this._aging]) {
      for (const key of generation) {
        if (reject(key)) generation.delete(key);
      }
    }
  }

  /** Forget everything, releasing both generations. */
  clear() {
    this._fresh = new Set();
    this._aging = new Set();
    this._forgotten = false;
  }

  /** @returns {number} entries held across both generations */
  get size() {
    return this._fresh.size + this._aging.size;
  }
}

/**
 * The same two-generation ceiling as {@link BoundedSet}, carrying a value per key.
 *
 * Content-change detection needs the previous digest of a path, not merely the fact that the path
 * was seen, and the key space is just as unbounded: every file a long session ever touches. The
 * policy is unchanged — additions land in the fresh generation, a lookup consults both, and filling
 * the fresh one retires the generation behind it in a single drop — so the ceiling holds in O(1) per
 * insertion without a scan.
 *
 * Forgetting a digest is safe here for the same reason it is safe there: a miss cannot suppress an
 * event, only make it be reported as changed when it might not have been. That is the direction this
 * package always fails in — a redundant rebuild rather than a missed one.
 */
class BoundedMap {
  /**
   * @param {number} ceiling maximum entries held across both generations
   */
  constructor(ceiling) {
    const limit = Number(ceiling);
    this._generation = Number.isFinite(limit) && limit >= 2 ? Math.floor(limit / 2) : 1;
    /** @type {Map<string, unknown>} */
    this._fresh = new Map();
    /** @type {Map<string, unknown>} */
    this._aging = new Map();
  }

  /**
   * @param {string} key
   * @returns {unknown} the stored value, or `undefined`
   */
  get(key) {
    const fresh = this._fresh.get(key);
    return fresh === undefined ? this._aging.get(key) : fresh;
  }

  /**
   * Store `value` under `key`, retiring a generation if this filled the current one.
   * @param {string} key
   * @param {unknown} value
   */
  set(key, value) {
    // Deleted from the aging generation as well, so a stale value there can never shadow this one
    // once the generations rotate.
    this._aging.delete(key);
    this._fresh.set(key, value);
    if (this._fresh.size >= this._generation) {
      this._aging = this._fresh;
      this._fresh = new Map();
    }
  }

  /**
   * @param {string} key
   * @returns {boolean} whether the key was present
   */
  delete(key) {
    const fresh = this._fresh.delete(key);
    const aging = this._aging.delete(key);
    return fresh || aging;
  }

  /**
   * Drop every entry whose key `reject` accepts. O(size), and inherent: a map cannot answer a
   * question about key prefixes without visiting its keys.
   * @param {(key: string) => boolean} reject
   */
  deleteMatching(reject) {
    for (const generation of [this._fresh, this._aging]) {
      for (const key of generation.keys()) {
        if (reject(key)) generation.delete(key);
      }
    }
  }

  /** Forget everything, releasing both generations. */
  clear() {
    this._fresh = new Map();
    this._aging = new Map();
  }

  /** @returns {number} entries held across both generations */
  get size() {
    return this._fresh.size + this._aging.size;
  }
}

module.exports = { BoundedMap, BoundedSet };
