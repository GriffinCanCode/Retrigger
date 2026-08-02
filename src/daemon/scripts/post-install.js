#!/usr/bin/env node
'use strict';

/*
 * Post-install check for @retrigger/daemon.
 *
 * This script reports; it does not fail. The previous version called
 * process.exit(1) when the daemon binary was missing or unrunnable, which
 * turned an optional component into a hard `npm install` failure for every
 * user on a platform without a prebuilt binary.
 *
 * The daemon is optional: @retrigger/core watches in-process and needs nothing
 * from this package. So a missing binary is a degraded state worth explaining,
 * never a reason to break someone's install.
 */

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const QUIET = process.env.RETRIGGER_SILENT === '1' || process.env.CI === 'true';

function note(msg) {
  if (!QUIET) console.log(`retrigger: ${msg}`);
}

function warn(msg) {
  if (!QUIET) console.warn(`retrigger: ${msg}`);
}

function binaryName() {
  return process.platform === 'win32' ? 'retrigger.exe' : 'retrigger';
}

function localBinary() {
  return path.join(__dirname, '..', 'bin', binaryName());
}

/** Resolve the platform package npm should have installed for this host. */
function platformPackage() {
  const { platform, arch } = process;
  try {
    return require.resolve(`@retrigger/daemon-${platform}-${arch}/${binaryName()}`);
  } catch {
    return null;
  }
}

function explainMissing() {
  warn(`no prebuilt daemon binary for ${process.platform}-${process.arch}.`);
  warn('this is not fatal: @retrigger/core watches in-process and does not require the daemon.');
  warn('to build it from source: cargo install --git https://github.com/GriffinCanCode/Retrigger retrigger-daemon');
}

function main() {
  const resolved = platformPackage() || (fs.existsSync(localBinary()) ? localBinary() : null);

  if (!resolved) {
    explainMissing();
    return;
  }

  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(resolved, 0o755);
    } catch (err) {
      warn(`could not mark the daemon executable (${err.message}); you may need to chmod +x it yourself.`);
    }
  }

  // Verify it actually runs on this machine. A binary that exists but was
  // built for the wrong CPU baseline would otherwise only reveal itself later,
  // at the least convenient moment.
  execFile(resolved, ['--version'], { timeout: 10_000 }, (err, stdout) => {
    if (err) {
      warn(`the daemon binary is present but did not run: ${err.message}`);
      warn('falling back to in-process watching; run `retrigger --version` to investigate.');
      return;
    }
    note(`daemon ready (${String(stdout).trim()})`);
  });
}

try {
  main();
} catch (err) {
  // Nothing this script can hit is worth failing an install over.
  warn(`post-install check skipped: ${err && err.message}`);
}
