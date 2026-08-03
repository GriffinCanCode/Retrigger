#!/usr/bin/env node
'use strict';

/**
 * Runs `test/vite.test.mjs` against `vite@7` (see `vitest.vite7.config.mjs`) instead of the
 * `vite@6` the default `npm test` pins. Gated on Node >= 20.12: vite 7 bundles rolldown, which
 * imports `node:util#styleText`, unavailable before that -- see `vitest.config.mjs` for the full
 * rationale this mirrors. A version below the floor is reported and skipped with a clean exit
 * rather than failing, so this script is safe to wire into a CI leg that also runs on older Node
 * without the leg itself needing its own version conditional.
 */

const path = require('path');
const { spawnSync } = require('child_process');

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 12)) {
  console.log(`[test:vite7] skipping: Node ${process.version} is below the vite@7 floor (20.12)`);
  process.exit(0);
}

const vitest = path.join(
  __dirname,
  '..',
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'vitest.cmd' : 'vitest'
);
const result = spawnSync(vitest, ['run', '--config', 'vitest.vite7.config.mjs'], {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit',
});
if (result.error) {
  console.error(`[test:vite7] failed to launch vitest: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
