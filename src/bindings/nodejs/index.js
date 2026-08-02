'use strict';

/**
 * @retrigger/core — public entry point.
 *
 * Hard rule: requiring this module must never throw, on any platform, with or
 * without a native binary. Nothing here touches the addon at load time; engine
 * resolution is deferred to first use and always resolves to either the native
 * engine or the pure-JavaScript one.
 */

const { getEngine, getEngineInfo } = require('./lib/engine');
const { Retrigger, createRetrigger } = require('./lib/retrigger');

/**
 * @param {Buffer|Uint8Array|string} data
 * @param {bigint|number} [seed]
 * @returns {string} 16 lowercase hex characters
 */
function hashBytesSync(data, seed) {
  return getEngine().hashBytesSync(data, seed);
}

/**
 * @param {string} filePath
 * @returns {{hash: string, size: number}}
 */
function hashFileSync(filePath) {
  return getEngine().hashFileSync(filePath);
}

/**
 * @param {string} filePath
 * @returns {Promise<{hash: string, size: number}>}
 */
function hashFile(filePath) {
  return getEngine().hashFile(filePath);
}

/**
 * @param {number} size bytes hashed per iteration
 * @param {number} iterations
 * @returns {Promise<{throughputMbps: number, nsPerByte: number, level: string}>}
 */
function benchmarkHash(size, iterations) {
  return getEngine().benchmarkHash(size, iterations);
}

/** @returns {string} active SIMD level, e.g. "neon" | "avx2" | "scalar" */
function getSimdSupport() {
  return getEngine().getSimdSupport();
}

/** @returns {string} */
function getCpuLevel() {
  return getEngine().getCpuLevel();
}

/** @returns {string[]} */
function getAvailableLevels() {
  return getEngine().getAvailableLevels();
}

module.exports = {
  Retrigger,
  benchmarkHash,
  createRetrigger,
  getAvailableLevels,
  getCpuLevel,
  getEngineInfo,
  getSimdSupport,
  hashBytesSync,
  hashFile,
  hashFileSync,
};

// Plugins are attached lazily so that a broken bundler integration can never
// prevent the core package from loading.
defineLazy('RetriggerWebpackPlugin', () => require('./plugins/webpack-plugin'));
defineLazy(
  'createRetriggerVitePlugin',
  () => require('./plugins/vite-plugin').createRetriggerVitePlugin
);

function defineLazy(name, load) {
  let cached;
  let loaded = false;
  Object.defineProperty(module.exports, name, {
    enumerable: true,
    configurable: true,
    get() {
      if (!loaded) {
        cached = load();
        loaded = true;
      }
      return cached;
    },
  });
}
