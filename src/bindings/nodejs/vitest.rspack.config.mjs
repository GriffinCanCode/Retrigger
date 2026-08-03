import { defineConfig } from 'vitest/config';

// Runs the very same `test/webpack.test.mjs` suite the default config runs, against
// `@rspack/core` instead of `webpack` -- see that file for why the plain `import webpack from
// 'webpack'` (rather than a `require()`) is what makes this alias effective: Vite's resolver
// only rewrites the ESM import graph it controls. `@rspack/core`'s default export is the same
// kind of directly-callable, webpack-options-in/compiler-out function `webpack` is (Rspack's
// explicit compatibility goal for `compiler.watchFileSystem`, the surface this plugin targets),
// so no plugin code changes for the swap itself. This config file is loaded by vitest's own
// internal vite instance (from `vite`, not `@rspack/core`), so it is safe to load on every Node
// version this package supports; it is only `@rspack/core` itself, once the compiler under test
// actually runs, that needs the floor in its own `engines.node` (`^20.19.0 || >=22.12.0`): run
// only via `npm run test:rspack`, which gates on that floor first, and never from `npm test`.
export default defineConfig({
  test: {
    name: 'rspack',
    environment: 'node',
    include: ['test/webpack.test.mjs', 'test/rspack-extra.test.mjs'],
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'forks',
    fileParallelism: false,
  },
  resolve: {
    alias: [{ find: /^webpack$/, replacement: '@rspack/core' }],
  },
});
