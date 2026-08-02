'use strict';

/**
 * Engine selection.
 *
 * An "engine" is the small surface the rest of the package depends on:
 * `createWatcher`, the four hash entry points, and SIMD reporting. The native
 * addon and the JavaScript implementation both satisfy it, so `Retrigger`
 * never branches on which one it received.
 */

const jsHash = require('./hash-js');
const { JsWatcher } = require('./js-watcher');
const { getNative } = require('./native');

const XXH3 = 'xxh3-64';

let warned = false;

function warnOnce(message, env = process.env) {
  if (warned) return;
  warned = true;
  if (env.RETRIGGER_SILENT === '1' || env.RETRIGGER_SILENT === 'true') return;
  // One line, never a stack trace: a fallback is expected, not a crash.
  console.warn(`[retrigger] ${message}`);
}

/** Testing seam. */
function resetWarning() {
  warned = false;
}

/**
 * @param {object} binding loaded native addon
 * @returns {object} engine
 */
function nativeEngine(binding, reason) {
  return {
    name: 'native',
    // The shipped addon hashes with XXH3-64. An addon may override this so
    // that `getEngineInfo()` never reports an algorithm it is not using.
    hashAlgorithm:
      typeof binding.hashAlgorithm === 'function' ? String(binding.hashAlgorithm()) : XXH3,
    reason,
    createWatcher: (options) => new binding.Watcher(options),
    hashBytesSync: (data, seed) =>
      seed === undefined ? binding.hashBytesSync(data) : binding.hashBytesSync(data, seed),
    hashFileSync: (file) => binding.hashFileSync(file),
    hashFile: (file) =>
      typeof binding.hashFile === 'function'
        ? binding.hashFile(file)
        : Promise.resolve(binding.hashFileSync(file)),
    benchmarkHash: (size, iterations) => binding.benchmarkHash(size, iterations),
    getSimdSupport: () => binding.getSimdSupport(),
    getCpuLevel: () =>
      typeof binding.getCpuLevel === 'function' ? binding.getCpuLevel() : binding.getSimdSupport(),
    getAvailableLevels: () =>
      typeof binding.getAvailableLevels === 'function' ? binding.getAvailableLevels() : [],
  };
}

/**
 * @param {string} reason why the native engine was not used
 * @returns {object} engine
 */
function javascriptEngine(reason) {
  return {
    name: 'javascript',
    hashAlgorithm: jsHash.ALGORITHM,
    reason,
    createWatcher: (options) => new JsWatcher(options),
    hashBytesSync: jsHash.hashBytesSync,
    hashFileSync: jsHash.hashFileSync,
    hashFile: jsHash.hashFile,
    benchmarkHash: jsHash.benchmarkHash,
    getSimdSupport: () => 'scalar',
    getCpuLevel: () => 'scalar',
    getAvailableLevels: () => ['scalar'],
  };
}

let cachedEngine = null;

/**
 * Resolve the engine for this process. Never throws.
 * @param {{prefer?: 'auto'|'native'|'javascript', env?: object}} [options]
 * @returns {object} engine
 */
function getEngine(options = {}) {
  const prefer = options.prefer || 'auto';
  if (prefer === 'javascript') {
    return javascriptEngine('explicitly requested by the caller');
  }

  let engine = options.fresh ? null : cachedEngine;
  if (!engine) {
    const { binding, reason } = getNative();
    if (binding) {
      engine = nativeEngine(binding, reason);
    } else {
      engine = javascriptEngine(reason);
      if (prefer !== 'native') {
        warnOnce(
          `native engine unavailable, using the JavaScript fallback (${reason}). ` +
            `Hashes use ${jsHash.ALGORITHM}, not xxh3-64. Set RETRIGGER_SILENT=1 to hide this.`,
          options.env
        );
      }
    }
    if (!options.fresh) cachedEngine = engine;
  }

  // Checked after the cache lookup too: a memoised JavaScript engine must not
  // silently satisfy a caller that explicitly demanded the native one.
  if (prefer === 'native' && engine.name !== 'native') {
    const error = new Error(`native engine requested but unavailable: ${engine.reason}`);
    error.code = 'ERR_RETRIGGER_NO_NATIVE';
    throw error;
  }

  return engine;
}

/** Testing seam: forget the memoised engine. */
function resetEngineCache() {
  cachedEngine = null;
  resetWarning();
}

/**
 * @returns {{engine: 'native'|'javascript', backend: string, reason: string,
 *   hashAlgorithm: string, simd: string, platform: string, nativeAttempts: object[]}}
 */
function getEngineInfo() {
  const engine = getEngine();
  const { attempts } = getNative();
  let backend = 'unknown';
  let simd = 'unknown';
  try {
    const probe = engine.createWatcher({ capacity: 1 });
    backend = probe.backend();
    if (typeof probe.stop === 'function') probe.stop();
  } catch {
    backend = engine.name === 'javascript' ? 'polling' : 'unknown';
  }
  try {
    simd = engine.getSimdSupport();
  } catch {
    simd = 'unknown';
  }
  return {
    engine: engine.name,
    backend,
    reason: engine.reason,
    hashAlgorithm: engine.hashAlgorithm,
    simd,
    platform: `${process.platform}-${process.arch}`,
    nativeAttempts: attempts,
  };
}

module.exports = {
  XXH3,
  getEngine,
  getEngineInfo,
  javascriptEngine,
  nativeEngine,
  resetEngineCache,
  resetWarning,
};
