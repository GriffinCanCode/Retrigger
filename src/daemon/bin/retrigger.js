#!/usr/bin/env node
'use strict';

/*
 * `retrigger` CLI shim.
 *
 * The daemon is a compiled Rust binary, so it cannot live in this package: it
 * is shipped per-platform through the optional @retrigger/daemon-<platform>-<arch>
 * dependencies. This shim finds whichever one npm installed for the host and
 * execs it.
 *
 * The alternative -- pointing package.json#bin straight at a checked-in
 * bin/retrigger -- is how this package previously shipped, and it is broken in
 * both directions: a fresh clone has no such file, and a stale one left in a
 * working tree gets published as though it were current.
 *
 * Unlike the post-install check, which must never fail an install, this script
 * exits non-zero when the binary is missing. Someone typing `retrigger` asked
 * for the daemon specifically, so silence would be the wrong answer.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const exeName = process.platform === 'win32' ? 'retrigger.exe' : 'retrigger';

function resolveBinary() {
  // Preferred: the platform package npm selected via optionalDependencies.
  try {
    return require.resolve(`@retrigger/daemon-${process.platform}-${process.arch}/${exeName}`);
  } catch {
    /* fall through to the local build */
  }

  // Local development: `cargo build --release --bin retrigger` copied here.
  const local = path.join(__dirname, exeName);
  return fs.existsSync(local) ? local : null;
}

const binary = resolveBinary();

if (!binary) {
  const { platform, arch } = process;
  console.error(`retrigger: no daemon binary available for ${platform}-${arch}.`);
  console.error('retrigger: the daemon is optional -- @retrigger/core watches in-process without it.');
  console.error('retrigger: to build from source:');
  console.error('retrigger:   cargo install --git https://github.com/GriffinCanCode/Retrigger retrigger-daemon');
  process.exit(127);
}

const child = spawn(binary, process.argv.slice(2), { stdio: 'inherit' });

child.on('error', (err) => {
  console.error(`retrigger: failed to start the daemon (${err.message})`);
  process.exit(126);
});

// Mirror the child's fate so shell scripts and supervisors see the truth: a
// signalled child is reported as a signal, not as a plain non-zero exit.
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
