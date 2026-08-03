#!/usr/bin/env node
'use strict';

/**
 * Runs `test/webpack.test.mjs` (plus the Rspack-only persistent-cache case in
 * `test/rspack-extra.test.mjs`) against `@rspack/core` (see `vitest.rspack.config.mjs`) instead of
 * the `webpack` the default `npm test` pins. Gated on `@rspack/core`'s own `engines.node`
 * (`^20.19.0 || >=22.12.0`, checked directly from its package.json rather than duplicated as a
 * literal here so a future Rspack bump can't silently drift out of sync with this gate) -- mirrors
 * `scripts/test-vite7.js`. A version below the floor is reported and skipped with a clean exit
 * rather than failing, so this script is safe to wire into a CI leg that also runs on older Node
 * without the leg itself needing its own version conditional.
 */

const path = require('path');
const { spawnSync } = require('child_process');

const { engines } = require('@rspack/core/package.json');
const [major, minor] = process.versions.node.split('.').map(Number);
const meetsFloor = major > 22 || (major === 22 && minor >= 12) || (major === 20 && minor >= 19);
if (!meetsFloor) {
  console.log(
    `[test:rspack] skipping: Node ${process.version} is below @rspack/core's floor (${engines.node})`
  );
  process.exit(0);
}

const vitest = path.join(
  __dirname,
  '..',
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'vitest.cmd' : 'vitest'
);
const result = spawnSync(vitest, ['run', '--config', 'vitest.rspack.config.mjs'], {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit',
});
if (result.error) {
  console.error(`[test:rspack] failed to launch vitest: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
