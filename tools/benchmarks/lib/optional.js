'use strict';

/**
 * Load an optional comparator. Missing modules are reported as `"not installed"`,
 * never estimated.
 * @param {string} name
 * @returns {{ok: true, mod: unknown} | {ok: false, error: 'not installed' | string}}
 */
function tryLoad(name) {
  try {
    return { ok: true, mod: require(name) };
  } catch (err) {
    const missing = err.code === 'MODULE_NOT_FOUND' || err.code === 'ERR_MODULE_NOT_FOUND';
    return { ok: false, error: missing ? 'not installed' : err.message };
  }
}

/**
 * Dynamic-import variant for ESM-only packages (chokidar v5).
 * @param {string} name
 */
async function tryImport(name) {
  try {
    return { ok: true, mod: await import(name) };
  } catch (err) {
    const missing = err.code === 'MODULE_NOT_FOUND' || err.code === 'ERR_MODULE_NOT_FOUND';
    return { ok: false, error: missing ? 'not installed' : err.message };
  }
}

module.exports = { tryLoad, tryImport };
