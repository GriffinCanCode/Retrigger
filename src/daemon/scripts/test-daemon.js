#!/usr/bin/env node
'use strict';

/*
 * Smoke test for the @retrigger/daemon npm package.
 *
 * This package is not the daemon: the daemon is a compiled Rust binary shipped
 * per-platform through optional dependencies. What this package ships is the
 * `bin/retrigger.js` shim that finds and execs that binary, the default config,
 * and the post-install check. So this is what a smoke test can honestly assert
 * from Node, without a Rust toolchain:
 *
 *   1. the shim runs under node and is not a syntax error;
 *   2. with no binary installed it exits 127 with the documented guidance --
 *      the expected state on any host without a prebuilt daemon, which is most
 *      of CI -- rather than crashing or, worse, exiting 0;
 *   3. when a binary *is* resolvable it answers --version with exit 0;
 *   4. the shipped config file exists and is non-empty (its schema is proven by
 *      the Rust `config` tests, not re-parsed here);
 *   5. the package's own module loads without throwing.
 *
 * The previous version spawned `bin/retrigger` -- a path that has never existed
 * in this package -- so it failed at spawn on every machine and proved nothing.
 *
 * Run with `node scripts/test-daemon.js`; node's built-in runner exits non-zero
 * on any failed assertion.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const PKG_ROOT = path.join(__dirname, '..');
const SHIM = path.join(PKG_ROOT, 'bin', 'retrigger.js');
const EXE = process.platform === 'win32' ? 'retrigger.exe' : 'retrigger';

/** Is a real daemon binary resolvable on this host, by the same rules the shim uses? */
function daemonBinaryPresent() {
  try {
    require.resolve(`@retrigger/daemon-${process.platform}-${process.arch}/${EXE}`);
    return true;
  } catch {
    return fs.existsSync(path.join(PKG_ROOT, 'bin', EXE));
  }
}

function runShim(args) {
  return spawnSync(process.execPath, [SHIM, ...args], {
    encoding: 'utf8',
    timeout: 15_000,
    // Keep the shim from inheriting a TTY it might treat specially.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('the shim is present and is valid JavaScript', () => {
  assert.ok(fs.existsSync(SHIM), `expected the shim at ${SHIM}`);
  const check = spawnSync(process.execPath, ['--check', SHIM], { encoding: 'utf8' });
  assert.equal(check.status, 0, `bin/retrigger.js is not valid JS:\n${check.stderr}`);
});

test('running the shim degrades or answers honestly, never crashes', () => {
  const present = daemonBinaryPresent();
  const result = runShim(['--version']);

  assert.equal(result.error, undefined, `the shim failed to spawn: ${result.error && result.error.message}`);

  if (present) {
    // A binary was installed for this host: it must actually answer.
    assert.equal(result.status, 0, `--version should succeed when a daemon binary is present:\n${result.stderr}`);
    assert.match(`${result.stdout}${result.stderr}`, /\S/, 'expected some --version output');
  } else {
    // The documented no-binary contract: exit 127 with actionable guidance.
    // A plain crash (non-zero without the message) or a false success (0) are
    // both failures of this contract.
    assert.equal(
      result.status,
      127,
      `with no daemon binary the shim must exit 127, got ${result.status}\nstdout:${result.stdout}\nstderr:${result.stderr}`,
    );
    assert.match(result.stderr, /no daemon binary available/i, 'the shim must explain the missing binary');
    assert.match(result.stderr, /@retrigger\/core/, 'the shim must point at the in-process alternative');
  }
});

test('config generation output stays inside an isolated temp dir', () => {
  // Only meaningful when a binary exists; otherwise assert the shim still fails
  // closed (127) rather than writing anything.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retrigger-daemon-test-'));
  const out = path.join(dir, 'retrigger.toml');
  try {
    const result = runShim(['config', '--output', out]);
    assert.equal(result.error, undefined, 'the shim failed to spawn');
    if (daemonBinaryPresent()) {
      assert.equal(result.status, 0, `config generation should succeed:\n${result.stderr}`);
      assert.ok(fs.existsSync(out), 'config generation reported success but wrote no file');
      assert.match(fs.readFileSync(out, 'utf8'), /\S/, 'generated config is empty');
    } else {
      assert.equal(result.status, 127, 'with no binary, config generation must fail closed');
      assert.ok(!fs.existsSync(out), 'nothing must be written when there is no daemon');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the shipped default config exists and is non-empty', () => {
  const config = path.join(PKG_ROOT, 'config', 'retrigger.toml');
  assert.ok(fs.existsSync(config), `expected a shipped config at ${config}`);
  assert.match(fs.readFileSync(config, 'utf8'), /\S/, 'the shipped config is empty');
});

test('the package module loads without throwing', () => {
  const mod = require(path.join(PKG_ROOT, 'index.js'));
  assert.equal(typeof mod, 'function', 'index.js must export the RetriggerDaemon class');
  assert.equal(typeof mod.RetriggerDaemon, 'function');
  assert.ok(mod.daemon, 'a default daemon instance should be exported');
});
