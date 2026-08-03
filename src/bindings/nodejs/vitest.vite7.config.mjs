import { defineConfig } from 'vitest/config';

// Runs the very same `test/vite.test.mjs` suite the default config runs, against `vite@7`
// instead of the `vite@6` `vitest.config.mjs` pins -- see that file for why 6 is the default.
// `vite7` (package.json devDependencies: `"vite7": "npm:vite@^7"`) is `vite@7` installed under a
// name that leaves the real `vite` package alone, and the alias below is what lets the unmodified
// test file's `import { createServer } from 'vite'` resolve to it. This config file is itself
// loaded and executed by vitest's own internal vite instance, which still comes from `vite`
// (6.4.3) via ordinary node_modules resolution -- the alias only rewrites what the *test file*
// resolves 'vite' to, not what vitest resolves its own dependency to -- so this file loads fine on
// every Node version this package supports. It is `vite@7` itself, once the test file's dev server
// actually starts, that needs `node:util#styleText` (Node 20.12+): run only via `npm run
// test:vite7`, which gates on that floor before ever invoking this config, and never from the
// default `npm test`.
export default defineConfig({
  test: {
    name: 'vite7',
    environment: 'node',
    include: ['test/vite.test.mjs'],
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'forks',
    fileParallelism: false,
  },
  resolve: {
    alias: [{ find: /^vite$/, replacement: 'vite7' }],
  },
});
