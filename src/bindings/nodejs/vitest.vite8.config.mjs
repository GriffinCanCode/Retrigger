import { mergeConfig } from 'vitest/config';
import vite7 from './vitest.vite7.config.mjs';

// Keep the Node 18 test runner on Vite 6; test Vite 8 on the modern bundler leg.
export default mergeConfig(vite7, {
  test: { name: 'vite8' },
  resolve: { alias: [{ find: /^vite$/, replacement: 'vite8' }] },
});
