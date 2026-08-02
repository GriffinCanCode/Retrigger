'use strict';

/**
 * Minimal, dependency-free glob matching for include/exclude filters.
 *
 * Supported: `*` (no separator), `**` (any depth), `?`, `[abc]`, `{a,b}`, and
 * a leading `!` for negation inside a pattern list. Extglobs (`+(a|b)`) and
 * POSIX classes are deliberately unsupported — they are rejected as literals
 * rather than silently mismatched.
 */

const SEP = '[\\\\/]';

/** Escape a literal character for use inside a RegExp. */
function esc(ch) {
  return /[.+^$(){}|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/**
 * Compile one glob pattern to an anchored RegExp source.
 * @param {string} glob
 * @returns {string}
 */
function globToRegExpSource(glob) {
  let out = '';
  let i = 0;
  const n = glob.length;

  while (i < n) {
    const ch = glob[i];

    if (ch === '*') {
      const isDouble = glob[i + 1] === '*';
      if (isDouble) {
        i += 2;
        // `**/` matches zero or more path segments; a trailing `**` matches all.
        if (glob[i] === '/' || glob[i] === '\\') {
          i += 1;
          out += `(?:.*${SEP})?`;
        } else {
          out += '.*';
        }
      } else {
        i += 1;
        out += `[^\\\\/]*`;
      }
      continue;
    }

    if (ch === '?') {
      out += `[^\\\\/]`;
      i += 1;
      continue;
    }

    if (ch === '/' || ch === '\\') {
      out += SEP;
      i += 1;
      continue;
    }

    if (ch === '[') {
      const close = glob.indexOf(']', i + 1);
      if (close === -1) {
        out += '\\[';
        i += 1;
        continue;
      }
      let body = glob.slice(i + 1, close);
      let negate = '';
      if (body[0] === '!' || body[0] === '^') {
        negate = '^';
        body = body.slice(1);
      }
      out += `[${negate}${body.replace(/\\/g, '\\\\')}]`;
      i = close + 1;
      continue;
    }

    if (ch === '{') {
      const close = matchingBrace(glob, i);
      if (close === -1) {
        out += '\\{';
        i += 1;
        continue;
      }
      const alts = splitAlternatives(glob.slice(i + 1, close));
      out += `(?:${alts.map(globToRegExpSource).join('|')})`;
      i = close + 1;
      continue;
    }

    out += esc(ch);
    i += 1;
  }

  return out;
}

function matchingBrace(str, start) {
  let depth = 0;
  for (let i = start; i < str.length; i += 1) {
    if (str[i] === '{') depth += 1;
    else if (str[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitAlternatives(body) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '{') depth += 1;
    if (ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/**
 * Compile a glob into an anchored RegExp.
 * A pattern with no separator (`*.log`) also matches on basename, matching the
 * behaviour every bundler user expects from `exclude: ['*.log']`.
 * @param {string} glob
 * @returns {RegExp}
 */
function compile(glob) {
  const source = globToRegExpSource(glob);
  const bare = !/[\\/]/.test(glob);
  const full = bare ? `(?:.*${SEP})?(?:${source})` : source;
  return new RegExp(`^${full}$`, process.platform === 'win32' ? 'i' : '');
}

/**
 * A compiled include/exclude filter.
 *
 * Semantics (documented because they are load-bearing for parity between
 * engines): a path is accepted when it matches at least one include pattern
 * (or no include patterns were given) and matches no exclude pattern.
 * Exclusion always wins.
 */
class Matcher {
  /**
   * @param {{include?: string[], exclude?: string[]}} [options]
   */
  constructor(options = {}) {
    this.includeSource = normaliseList(options.include);
    this.excludeSource = normaliseList(options.exclude);
    this.include = this.includeSource.map(compile);
    this.exclude = this.excludeSource.map(compile);
  }

  get isEmpty() {
    return this.include.length === 0 && this.exclude.length === 0;
  }

  /**
   * @param {string} filePath absolute or relative path
   * @returns {boolean}
   */
  matches(filePath) {
    const path = String(filePath).replace(/\\/g, '/');
    for (const re of this.exclude) {
      if (re.test(path)) return false;
    }
    if (this.include.length === 0) return true;
    for (const re of this.include) {
      if (re.test(path)) return true;
    }
    return false;
  }

  /**
   * Directory pre-filter used to prune tree walks. A directory is only skipped
   * when an exclude pattern matches the directory itself or everything under
   * it; include patterns are never used to prune, because a directory that
   * does not match an include may still contain files that do.
   * @param {string} dirPath
   * @returns {boolean}
   */
  allowsDirectory(dirPath) {
    const path = String(dirPath).replace(/\\/g, '/');
    for (let i = 0; i < this.exclude.length; i += 1) {
      if (this.exclude[i].test(path)) return false;
      // `**/node_modules/**` should prune `/x/node_modules` itself.
      const src = this.excludeSource[i];
      if (src.endsWith('/**') && compile(src.slice(0, -3)).test(path)) return false;
    }
    return true;
  }
}

function normaliseList(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.filter((p) => typeof p === 'string' && p.length > 0);
}

module.exports = { Matcher, compile, globToRegExpSource };
