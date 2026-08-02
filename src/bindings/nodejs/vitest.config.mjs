import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.mjs'],
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
