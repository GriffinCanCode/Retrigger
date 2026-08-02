'use strict';

/**
 * Safe native addon loader.
 *
 * Contract: nothing in this module may ever throw at require time or from
 * `loadNative()`. Every failure mode resolves to `null` plus a human-readable
 * reason, which callers surface through `getEngineInfo()`.
 */

const { existsSync } = require('fs');
const { join, isAbsolute, resolve } = require('path');

const NAPI_NAME = 'retrigger-nodejs-bindings';
const PKG_SCOPE = '@retrigger/core';

/**
 * Members the rebuilt addon must expose. A binary that loads but predates the
 * current contract (or was built from a partial rewrite) is treated as
 * unusable rather than half-adopted.
 */
const REQUIRED_FUNCTIONS = ['getSimdSupport', 'hashBytesSync', 'hashFileSync'];
const REQUIRED_CLASSES = ['Watcher'];

/**
 * Every triple this package publishes, keyed by `${platform}-${arch}`.
 * `libc` entries are ordered by likelihood; the loader tries all of them, so a
 * wrong libc guess costs one failed `require` instead of a broken install.
 */
const TRIPLES = {
  'darwin-x64': ['darwin-x64'],
  'darwin-arm64': ['darwin-arm64'],
  'win32-x64': ['win32-x64-msvc'],
  'win32-arm64': ['win32-arm64-msvc'],
  'linux-x64': ['linux-x64-gnu', 'linux-x64-musl'],
  'linux-arm64': ['linux-arm64-gnu', 'linux-arm64-musl'],
  'linux-arm': ['linux-arm-gnueabihf'],
};

/**
 * Detect musl libc. Unlike the napi-generated default this fails *safe*: an
 * indeterminate result reports glibc (the common case) and the loader still
 * tries the musl build as a second candidate.
 */
function isMusl() {
  try {
    if (process.report && typeof process.report.getReport === 'function') {
      const report = process.report.getReport();
      const header = (report && report.header) || {};
      if (typeof header.glibcVersionRuntime === 'string') return false;
      if (Array.isArray(report.sharedObjects)) {
        return report.sharedObjects.some((so) => /libc\.musl|ld-musl/.test(so));
      }
      return !header.glibcVersionRuntime;
    }
  } catch {
    /* fall through to ldd probe */
  }
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('ldd', ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.includes('musl');
  } catch (err) {
    // `ldd --version` exits non-zero on musl but still prints to stderr.
    const text = `${(err && err.stdout) || ''}${(err && err.stderr) || ''}`;
    if (text.includes('musl')) return true;
  }
  return false;
}

/**
 * Ordered load candidates for the current platform: an explicit override
 * first, then co-located `.node` files, then published platform packages.
 * @returns {{candidates: Array<{type: string, id: string}>, supported: boolean}}
 */
function getCandidates(env = process.env, platform = process.platform, arch = process.arch) {
  const candidates = [];

  // An explicit override is exclusive: "use this binary" must not silently
  // resolve to a different one when it fails.
  const override = env.RETRIGGER_NATIVE_PATH;
  if (override) {
    candidates.push({
      type: 'override',
      id: isAbsolute(override) ? override : resolve(process.cwd(), override),
    });
    return { candidates, supported: true };
  }

  let triples = TRIPLES[`${platform}-${arch}`];
  if (!triples) return { candidates, supported: false };

  if (triples.length > 1 && isMusl()) triples = [...triples].reverse();

  for (const triple of triples) {
    const local = join(__dirname, '..', `${NAPI_NAME}.${triple}.node`);
    if (existsSync(local)) candidates.push({ type: 'local', id: local });
    candidates.push({ type: 'package', id: `${PKG_SCOPE}-${triple}` });
  }

  return { candidates, supported: true };
}

/**
 * @returns {{ok: boolean, missing: string[]}}
 */
function checkContract(binding) {
  const missing = [];
  if (!binding || typeof binding !== 'object') return { ok: false, missing: ['<module>'] };
  for (const name of REQUIRED_FUNCTIONS) {
    if (typeof binding[name] !== 'function') missing.push(name);
  }
  for (const name of REQUIRED_CLASSES) {
    if (typeof binding[name] !== 'function') missing.push(name);
  }
  return { ok: missing.length === 0, missing };
}

/**
 * Attempt to load the native addon.
 * @returns {{binding: object|null, reason: string, attempts: Array<object>}}
 */
function loadNative(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const requireFn = options.require || require;
  const attempts = [];

  if (env.RETRIGGER_FORCE_JS === '1' || env.RETRIGGER_ENGINE === 'javascript') {
    return { binding: null, reason: 'forced to the JavaScript engine by environment', attempts };
  }

  let candidates;
  let supported;
  try {
    ({ candidates, supported } = getCandidates(env, platform, arch));
  } catch (err) {
    return { binding: null, reason: `platform detection failed: ${errText(err)}`, attempts };
  }

  if (!supported) {
    return {
      binding: null,
      reason: `no native build is published for ${platform}-${arch}`,
      attempts,
    };
  }

  for (const candidate of candidates) {
    try {
      const binding = requireFn(candidate.id);
      const contract = checkContract(binding);
      if (!contract.ok) {
        attempts.push({
          ...candidate,
          error: `loaded but missing required export(s): ${contract.missing.join(', ')}`,
        });
        continue;
      }
      return { binding, reason: `loaded ${candidate.type} binding ${candidate.id}`, attempts };
    } catch (err) {
      attempts.push({ ...candidate, error: errText(err) });
    }
  }

  // A binary that loaded but failed the contract check is far more actionable
  // than "module not found", so report that in preference to the last attempt.
  const mismatch = attempts.find((a) => a.error.startsWith('loaded but missing'));
  const detail = mismatch
    ? `${mismatch.id} ${mismatch.error}`
    : attempts.length
      ? attempts[attempts.length - 1].error
      : 'no load candidates for this platform';
  return {
    binding: null,
    reason: `native addon unavailable (${detail})`,
    attempts,
  };
}

function errText(err) {
  if (!err) return 'unknown error';
  const msg = typeof err === 'string' ? err : err.message || String(err);
  return msg.split('\n')[0].slice(0, 300);
}

let cached = null;

/**
 * Cached loader used by the rest of the package.
 * @returns {{binding: object|null, reason: string, attempts: Array<object>}}
 */
function getNative() {
  if (!cached) cached = loadNative();
  return cached;
}

/** Testing seam: drop the memoised load result. */
function resetNativeCache() {
  cached = null;
}

module.exports = {
  NAPI_NAME,
  PKG_SCOPE,
  REQUIRED_CLASSES,
  REQUIRED_FUNCTIONS,
  TRIPLES,
  checkContract,
  getCandidates,
  getNative,
  isMusl,
  loadNative,
  resetNativeCache,
};
