#!/usr/bin/env node
'use strict';

/*
 * Prove a freshly built native artifact is worth publishing.
 *
 * The release workflow runs this on the native runner immediately after
 * `napi build`, before the .node is uploaded. It is the last gate between a
 * broken binary and the registry.
 *
 * It deliberately `require`s the .node **directly** rather than going through
 * `index.js`. The package's whole design is that a bad or missing addon falls
 * back to the JavaScript engine without throwing -- which is right for users
 * and useless for a release gate, because it would turn "this binary is
 * corrupt" into a silent pass. Here, the binary either works or the job fails.
 *
 * Hash expectations are the published XXH3-64 vectors, not values read back
 * from the binary under test, so an engine that merely produces 16 hex
 * characters cannot satisfy them.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { NAPI_NAME, REQUIRED_CLASSES, REQUIRED_FUNCTIONS } = require('../lib/native');

const PKG_ROOT = path.join(__dirname, '..');

// Canonical XXH3-64 digests, seed 0.
const VECTORS = [
  ['', '2d06800538d394c2'],
  ['abc', '78af5f94892f3950'],
];

let failures = 0;

function ok(label, detail) {
  console.log(`  ok    ${label}${detail ? `\n        ${detail}` : ''}`);
}

function fail(label, detail) {
  failures += 1;
  console.error(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
}

function check(label, fn) {
  try {
    const detail = fn();
    ok(label, detail);
  } catch (err) {
    fail(label, (err && err.message) || String(err));
  }
}

async function checkAsync(label, fn) {
  try {
    const detail = await fn();
    ok(label, detail);
  } catch (err) {
    fail(label, (err && err.message) || String(err));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Every artifact napi dropped in the package root. */
function findArtifacts() {
  return fs
    .readdirSync(PKG_ROOT)
    .filter((name) => name.startsWith(`${NAPI_NAME}.`) && name.endsWith('.node'))
    .map((name) => path.join(PKG_ROOT, name));
}

/** Wait for `predicate` to hold, draining the watcher's queue. */
function pollUntil(watcher, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const seen = [];
  while (Date.now() < deadline) {
    let event = watcher.poll();
    while (event) {
      seen.push(event);
      if (predicate(seen)) return seen;
      event = watcher.poll();
    }
    // Busy-wait deliberately: this is a one-shot CI gate with no event loop
    // work to yield to, and Atomics.wait keeps it off a spin at full tilt.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return seen;
}

async function main() {
  console.log(`\nverifying native artifact on ${process.platform}-${process.arch}\n`);

  const artifacts = findArtifacts();
  if (artifacts.length !== 1) {
    fail(
      'exactly one built artifact is present',
      artifacts.length === 0
        ? `no ${NAPI_NAME}.*.node in ${PKG_ROOT} -- did the build step run?`
        : `found ${artifacts.length}: ${artifacts.map((a) => path.basename(a)).join(', ')}`
    );
    return;
  }

  const artifact = artifacts[0];
  ok('exactly one built artifact is present', path.basename(artifact));

  let binding;
  try {
    binding = require(artifact);
    ok('the artifact loads in this process');
  } catch (err) {
    fail('the artifact loads in this process', (err && err.message) || String(err));
    return; // Nothing below can mean anything.
  }

  check('it satisfies the loader contract', () => {
    const missing = [...REQUIRED_FUNCTIONS, ...REQUIRED_CLASSES].filter(
      (name) => typeof binding[name] !== 'function'
    );
    assert(missing.length === 0, `missing export(s): ${missing.join(', ')}`);
    return [...REQUIRED_FUNCTIONS, ...REQUIRED_CLASSES].join(', ');
  });

  check('it reports a real SIMD level', () => {
    const level = binding.getSimdSupport();
    assert(typeof level === 'string' && level.length > 0, `got ${JSON.stringify(level)}`);
    assert(level !== 'mock-simd', 'this is the test mock, not the addon');
    const levels = binding.getAvailableLevels();
    assert(Array.isArray(levels) && levels.length > 0, 'getAvailableLevels() returned nothing');
    return `${level} (available: ${levels.join(', ')})`;
  });

  check('it names its hash algorithm honestly', () => {
    const algorithm = binding.hashAlgorithm();
    assert(algorithm === 'xxh3-64', `reported ${JSON.stringify(algorithm)}`);
    return algorithm;
  });

  check('it matches the published XXH3-64 vectors', () => {
    for (const [input, expected] of VECTORS) {
      const actual = binding.hashBytesSync(Buffer.from(input));
      assert(
        actual === expected,
        `hash(${JSON.stringify(input)}) = ${actual}, expected ${expected}`
      );
    }
    return VECTORS.map(([input, hash]) => `${JSON.stringify(input)} -> ${hash}`).join(', ');
  });

  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'retrigger-artifact-')));

  try {
    check('hashFileSync agrees with hashBytesSync', () => {
      const file = path.join(scratch, 'payload.bin');
      const contents = Buffer.from('the quick brown fox'.repeat(1000));
      fs.writeFileSync(file, contents);
      const result = binding.hashFileSync(file);
      assert(result.size === contents.length, `size ${result.size} != ${contents.length}`);
      assert(
        result.hash === binding.hashBytesSync(contents),
        `file hash ${result.hash} != buffer hash ${binding.hashBytesSync(contents)}`
      );
      return `${result.hash} over ${result.size} bytes`;
    });

    await checkAsync('hashFile agrees with the sync path', async () => {
      const file = path.join(scratch, 'payload.bin');
      const asyncResult = await binding.hashFile(file);
      const syncResult = binding.hashFileSync(file);
      assert(asyncResult.hash === syncResult.hash, 'async and sync hashes differ');
      return asyncResult.hash;
    });

    await checkAsync('benchmarkHash runs and reports throughput', async () => {
      const result = await binding.benchmarkHash(64 * 1024, 16);
      assert(result.throughputMbps > 0, `throughput ${result.throughputMbps}`);
      return `${result.throughputMbps.toFixed(0)} MB/s on ${result.level}`;
    });

    check('the watcher observes a real filesystem change', () => {
      const tree = path.join(scratch, 'tree');
      fs.mkdirSync(tree);
      const watcher = new binding.Watcher({ capacity: 1024, debounceMs: 0 });
      try {
        watcher.watch(tree, true);
        watcher.start();

        const backend = watcher.backend();
        assert(backend !== 'polling', `expected an OS backend, got ${backend}`);

        // Give the backend a moment to arm before generating the change: on
        // FSEvents the stream comes up on another thread, so a write in the
        // first few milliseconds can be missed outright rather than delayed.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);

        const target = path.join(tree, 'created.txt');
        fs.writeFileSync(target, 'hello');

        const seen = pollUntil(
          watcher,
          (events) => events.some((event) => event.path === target),
          10_000
        );
        assert(
          seen.some((event) => event.path === target),
          `no event for ${target}; saw ${seen.length}: ${seen.map((e) => `${e.kind} ${e.path}`).join(' | ') || '<nothing>'}`
        );

        const stats = watcher.stats();
        assert(stats.isRunning === true, 'stats() says the watcher is not running');
        return `${backend} backend, ${stats.eventsQueued} queued`;
      } finally {
        watcher.stop();
      }
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main()
  .catch((err) => {
    fail('the verifier itself crashed', (err && err.stack) || String(err));
  })
  .finally(() => {
    if (failures > 0) {
      console.error(`\n${failures} check(s) failed -- this artifact must not ship.\n`);
      process.exit(1);
    }
    console.log('\nartifact verified\n');
  });
