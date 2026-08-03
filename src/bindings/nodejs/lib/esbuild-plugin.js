'use strict';

/**
 * Retrigger-driven manual rebuild wrapper for esbuild (`@retrigger/core/esbuild`).
 *
 * ARCHITECTURAL FACT: esbuild's `context(options).watch()` is likewise observation-only — there is
 * no seam to veto a rebuild once esbuild's own watch mode decides to run one. This factory keeps
 * one `esbuild.context(buildOptions)` alive for the life of the watch and calls `ctx.rebuild()`
 * itself, through the shared {@link RebuildDriver}, only when Retrigger's content-hash gate reports
 * a real byte change. `ctx.watch()` is never called. See `lib/rebuild-driver.js`'s header for the
 * scheduler semantics this relies on (coalescing, one in-flight build, one queued follow-up).
 *
 * Fail-open discipline: a missing `esbuild` install, or a missing `watchPaths`, is a
 * construction-time misuse thrown synchronously before anything is watched. Once running, a build
 * that throws is reported through `onError`/the driver's `'error'` event and never crashes the
 * watch — the context stays alive and the next real change tries `ctx.rebuild()` again.
 */

const { RebuildDriver } = require('./rebuild-driver');

/**
 * Retrigger's own knobs, so they can sit beside ordinary esbuild `BuildOptions` in one flat
 * object — the factory's signature is `{ ...buildOptions, watchPaths, ...retriggerOptions }` —
 * without esbuild ever seeing a key it does not understand.
 */
const RETRIGGER_OPTION_KEYS = new Set([
  'recursive',
  'include',
  'exclude',
  'debounceMs',
  'capacity',
  'pollIntervalMs',
  'engine',
  'emitDirectories',
  'unref',
  'contentHashing',
  'maxHashBytes',
  'maxConcurrentHashes',
  'backend',
  'awaitWriteFinish',
  'atomicWriteNormalization',
]);

/** @returns {{retriggerOptions: object, buildOptions: object}} */
function splitOptions(options) {
  const retriggerOptions = {};
  const buildOptions = {};
  for (const [key, value] of Object.entries(options)) {
    (RETRIGGER_OPTION_KEYS.has(key) ? retriggerOptions : buildOptions)[key] = value;
  }
  return { retriggerOptions, buildOptions };
}

/**
 * @param {{watchPaths: string|string[], coalesceMs?: number,
 *   onError?: (error: Error) => void} & Record<string, unknown>} options esbuild `BuildOptions`
 *   plus `watchPaths`, any `RetriggerOptions`, `coalesceMs`, and `onError`, all flat
 * @returns {{build: () => Promise<object>, start: () => Promise<object>, close: () => Promise<void>,
 *   buildCount: number, getStats: () => object, driver: RebuildDriver}}
 */
function createRetriggerEsbuildWatcher(options = {}) {
  const { watchPaths, onError, coalesceMs, ...remaining } = options;
  if (!watchPaths || (Array.isArray(watchPaths) && watchPaths.length === 0)) {
    throw new TypeError('createRetriggerEsbuildWatcher requires `watchPaths`');
  }
  const { retriggerOptions, buildOptions } = splitOptions(remaining);

  let esbuild;
  try {
    esbuild = require('esbuild');
  } catch (err) {
    throw new Error(
      `createRetriggerEsbuildWatcher requires the "esbuild" package to be installed alongside ` +
        `@retrigger/core (${err.message})`
    );
  }

  /** @type {import('esbuild').BuildContext|null} */
  let ctx = null;
  let buildCount = 0;
  let started = false;
  let closed = false;

  async function ensureContext() {
    if (!ctx) ctx = await esbuild.context(buildOptions);
    return ctx;
  }

  /** One-shot rebuild through the live context. Never `ctx.watch()`. */
  async function runBuild() {
    const context = await ensureContext();
    const result = await context.rebuild();
    buildCount += 1;
    return result;
  }

  const driver = new RebuildDriver({
    watchPaths,
    coalesceMs,
    retriggerOptions,
    rebuild: () => runBuild(),
  });
  if (typeof onError === 'function') driver.on('error', onError);

  return {
    /** Run one esbuild rebuild immediately, outside the change-driven schedule. */
    build: runBuild,

    /** Build once, then start watching for real changes. Idempotent. */
    async start() {
      if (started) return this;
      started = true;
      await runBuild();
      driver.start();
      return this;
    },

    /** Stop watching, release Retrigger's handles, and `ctx.dispose()`. Idempotent. */
    async close() {
      if (closed) return;
      closed = true;
      await driver.close();
      if (ctx) {
        const dying = ctx;
        ctx = null;
        await dying.dispose();
      }
    },

    get buildCount() {
      return buildCount;
    },

    getStats() {
      return { buildCount, started, closed, driver: driver.getStats() };
    },

    /** The underlying scheduler, exposed for tests and for the benchmark lane. */
    driver,
  };
}

module.exports = { createRetriggerEsbuildWatcher };
module.exports.default = createRetriggerEsbuildWatcher;
