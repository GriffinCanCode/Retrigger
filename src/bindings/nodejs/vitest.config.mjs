import { defineConfig, configDefaults } from 'vitest/config';

// vite is deliberately held at 6 even though 8 is current, and it is a test-only
// dependency: nothing published imports it, and plugins/vite-plugin.js
// reimplements normalizePath precisely so it stays that way. vite 7+ bundles
// rolldown, which imports node:util#styleText (Node 20.12+), and because vitest
// loads this very file through vite, an older runtime fails at startup rather
// than in one test. That would cost the whole suite on Node 18 -- the floor
// package.json#engines.node promises -- to gain coverage of a build pipeline
// this package never invokes. Raise it when engines.node rises, not before.

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.mjs'],
    // rspack-extra.test.mjs has no webpack-side default run: it exercises Rspack's
    // `cache.type: 'persistent'` shape, which is not a valid webpack 5 cache option, so it only
    // makes sense under vitest.rspack.config.mjs's `webpack -> @rspack/core` alias (`npm run
    // test:rspack`). test/webpack.test.mjs itself has no such exclusion -- it is the shared
    // suite that *does* run for real here, against real webpack, exactly as before.
    exclude: [...configDefaults.exclude, 'test/rspack-extra.test.mjs'],
    // Real filesystem watchers, a real webpack watch build and a real Vite dev
    // server all need generous but bounded time.
    testTimeout: 30000,
    hookTimeout: 30000,
    // Forks, not worker threads: the resource-hygiene tests inspect libuv
    // handles, and fs watchers behave differently on a worker thread.
    pool: 'forks',
    // Serialised on purpose. These suites contend for OS watch descriptors and
    // measure handle counts; running them concurrently trades a little wall
    // time for flakiness, which is the wrong trade for a reliability suite.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['lib/**/*.js', 'plugins/**/*.js', 'index.js'],
      reporter: ['text', 'lcov'],
    },
  },
});
