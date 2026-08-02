'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const created = new Set();

/**
 * @param {string} [prefix]
 * @returns {string} an absolute, symlink-resolved temp directory
 */
function tempDir(prefix = 'retrigger-test-') {
  // macOS resolves /var -> /private/var; without realpath, event paths and
  // expected paths disagree and every assertion becomes a false negative.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  created.add(dir);
  return dir;
}

function cleanupTempDirs() {
  for (const dir of created) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  created.clear();
}

/**
 * Poll a predicate against a deadline. Never a bare sleep: a suite that exists
 * to prove reliability must not itself be timing-flaky.
 *
 * @template T
 * @param {() => T} predicate returns a falsy value until the condition holds
 * @param {{timeout?: number, interval?: number, message?: string}} [options]
 * @returns {Promise<T>}
 */
async function waitFor(predicate, options = {}) {
  const timeout = options.timeout ?? 5000;
  const interval = options.interval ?? 5;
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await predicate();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    if (Date.now() >= deadline) {
      const detail = options.message || 'condition not met';
      const state = last instanceof Error ? last.message : JSON.stringify(last);
      throw new Error(`waitFor timed out after ${timeout}ms: ${detail} (last=${state})`);
    }
    await sleep(interval);
  }
}

/**
 * Wait until no new events have arrived for `quietMs`, bounded by `timeout`.
 * Used to assert the *absence* of events without guessing a fixed delay.
 * @param {() => number} count
 */
async function waitForQuiet(count, { quietMs = 150, timeout = 3000 } = {}) {
  const deadline = Date.now() + timeout;
  let last = count();
  let lastChange = Date.now();
  while (Date.now() < deadline) {
    await sleep(15);
    const current = count();
    if (current !== last) {
      last = current;
      lastChange = Date.now();
    } else if (Date.now() - lastChange >= quietMs) {
      return current;
    }
  }
  return count();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Block until a watcher over `dir` is demonstrably delivering events, then
 * discard everything it saw getting there.
 *
 * `fs.watch` on macOS starts its FSEvents stream on another thread, so a write
 * landing in the first few milliseconds after `start()` can be lost outright —
 * not delayed, lost. A test that writes immediately after starting is therefore
 * measuring stream-startup luck rather than watcher behaviour. Instead of
 * sleeping and hoping, this creates a sentinel directory and retries until one
 * is actually reported.
 *
 * @param {string} dir a directory inside the watched tree
 * @param {object[]} events the array the test is collecting events into
 */
async function waitUntilLive(dir, events, { timeout = 10000, attemptMs = 300 } = {}) {
  const deadline = Date.now() + timeout;
  for (let attempt = 0; Date.now() < deadline; attempt += 1) {
    const sentinel = path.join(dir, `.retrigger-live-${attempt}`);
    fs.mkdirSync(sentinel, { recursive: true });
    const until = Date.now() + attemptMs;
    while (Date.now() < until) {
      if (events.some((e) => e.path === sentinel)) {
        // Let any trailing sentinel noise land before wiping the slate.
        await waitForQuiet(() => events.length, { quietMs: 60, timeout: 1000 });
        events.length = 0;
        return;
      }
      await sleep(5);
    }
  }
  throw new Error(`watcher never became live for ${dir}`);
}

/**
 * Write a file and make sure the bytes reached the filesystem before the test
 * continues, so watcher latency is the only variable left.
 */
function writeFile(target, contents) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const fd = fs.openSync(target, 'w');
  try {
    fs.writeSync(fd, contents);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = {
  cleanupTempDirs,
  sleep,
  tempDir,
  waitFor,
  waitForQuiet,
  waitUntilLive,
  writeFile,
};
