'use strict';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll until `predicate` is truthy or `timeout` elapses.
 * @template T
 * @param {() => T | Promise<T>} predicate
 * @param {{timeout?: number, interval?: number, message?: string}} [opts]
 * @returns {Promise<T>}
 */
async function waitFor(predicate, opts = {}) {
  const timeout = opts.timeout ?? 5000;
  const interval = opts.interval ?? 10;
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    last = await predicate();
    if (last) return last;
    if (Date.now() >= deadline) {
      throw new Error(`waitFor timed out after ${timeout}ms: ${opts.message || 'condition not met'}`);
    }
    await sleep(interval);
  }
}

/**
 * Wait until `count()` is unchanged for `quietMs`, bounded by `timeout`.
 * @param {() => number} count
 * @param {{quietMs?: number, timeout?: number}} [opts]
 */
async function waitForQuiet(count, opts = {}) {
  const quietMs = opts.quietMs ?? 250;
  const timeout = opts.timeout ?? 4000;
  const deadline = Date.now() + timeout;
  let last = count();
  let lastChange = Date.now();
  while (Date.now() < deadline) {
    await sleep(20);
    const current = count();
    if (current !== last) {
      last = current;
      lastChange = Date.now();
    } else if (Date.now() - lastChange >= quietMs) {
      return last;
    }
  }
  return last;
}

/** @returns {bigint} */
const nowNs = () => process.hrtime.bigint();

/** @param {bigint} start @returns {number} milliseconds */
const elapsedMs = (start) => Number(process.hrtime.bigint() - start) / 1e6;

module.exports = { sleep, waitFor, waitForQuiet, nowNs, elapsedMs };
