'use strict';

/**
 * Retrigger-driven manual rebuild wrapper for Rollup (`@retrigger/core/rollup`).
 *
 * ARCHITECTURAL FACT: `rollup.watch()` returns a `RollupWatcher` whose `watchChange` event is
 * observation-only — nothing in Rollup's public API lets a caller veto a rebuild a `RollupWatcher`
 * already started. Skipping a byte-identical rebuild therefore cannot be built on top of
 * `rollup.watch()`; this factory never calls it. Instead, Retrigger owns the watch, and a "build"
 * is a plain one-shot `rollup(inputOptions)` -> `bundle.write(outputOptions)` -> `bundle.close()`,
 * invoked by the shared {@link RebuildDriver} only when Retrigger's content-hash gate reports a
 * real byte change. This is the direct replacement for `rollup --watch` when the goal is skipping
 * no-op rebuilds — see `lib/rebuild-driver.js`'s header for the scheduler semantics (coalescing,
 * one in-flight build, one queued follow-up, clean cancellation).
 *
 * Fail-open discipline: a missing `rollup` install, or a missing `input`/`output`/`watchPaths`, is
 * a construction-time misuse the caller must fix — thrown synchronously, before anything is
 * watched. Once running, a build that throws is reported through `onError`/the driver's `'error'`
 * event and never crashes the watch; the next real change tries again.
 */

const { RebuildDriver } = require('./rebuild-driver');

/**
 * @param {{input: object, output: object|object[], watchPaths: string|string[],
 *   coalesceMs?: number, onError?: (error: Error) => void}} options plus any `RetriggerOptions`
 * @returns {{build: () => Promise<number>, start: () => Promise<object>, close: () => Promise<void>,
 *   buildCount: number, getStats: () => object, driver: RebuildDriver}}
 */
function createRetriggerRollupWatcher(options = {}) {
  const { input, output, watchPaths, onError, coalesceMs, ...retriggerOptions } = options;
  if (!input || typeof input !== 'object') {
    throw new TypeError('createRetriggerRollupWatcher requires `input` (Rollup InputOptions)');
  }
  if (!output || (Array.isArray(output) && output.length === 0)) {
    throw new TypeError('createRetriggerRollupWatcher requires `output` (Rollup OutputOptions)');
  }
  if (!watchPaths || (Array.isArray(watchPaths) && watchPaths.length === 0)) {
    throw new TypeError('createRetriggerRollupWatcher requires `watchPaths`');
  }

  let rollupFn;
  try {
    ({ rollup: rollupFn } = require('rollup'));
  } catch (err) {
    throw new Error(
      `createRetriggerRollupWatcher requires the "rollup" package to be installed alongside ` +
        `@retrigger/core (${err.message})`
    );
  }

  const outputs = Array.isArray(output) ? output : [output];
  let buildCount = 0;
  let started = false;
  let closed = false;

  /** One-shot build: `rollup()` -> `write()` per configured output -> `close()`. Never `watch()`. */
  async function runBuild() {
    const bundle = await rollupFn(input);
    try {
      for (const target of outputs) await bundle.write(target);
    } finally {
      // Releases the bundle's own resources regardless of whether `write()` succeeded; a bundle
      // left open would hold the read caches Rollup built for it until the process exits.
      await bundle.close();
    }
    buildCount += 1;
    return buildCount;
  }

  const driver = new RebuildDriver({
    watchPaths,
    coalesceMs,
    retriggerOptions,
    rebuild: () => runBuild(),
  });
  if (typeof onError === 'function') driver.on('error', onError);

  return {
    /** Run one Rollup build immediately, outside the change-driven schedule. */
    build: runBuild,

    /** Build once, then start watching for real changes. Idempotent. */
    async start() {
      if (started) return this;
      started = true;
      await runBuild();
      driver.start();
      return this;
    },

    /** Stop watching and release every handle Rollup and Retrigger hold. Idempotent. */
    async close() {
      if (closed) return;
      closed = true;
      await driver.close();
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

module.exports = { createRetriggerRollupWatcher };
module.exports.default = createRetriggerRollupWatcher;
