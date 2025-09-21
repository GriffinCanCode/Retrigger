import { defineConfig } from 'vite';
import { createRetriggerVitePlugin } from '@retrigger/core/plugins/vite-plugin';

export default defineConfig({
  plugins: [
    createRetriggerVitePlugin({
      verbose: true,
      debounceMs: 5, // Lower debounce for smoother updates
      enableAdvancedHMR: true, // Enable advanced HMR for better performance
      useSharedBuffer: false, // Temporarily disable due to native binding issues
      enableNativeWatching: false, // Temporarily disable due to Rust binding issues  
      hmrInvalidationStrategy: 'smart', // Intelligent invalidation
      enableSourceMapUpdate: true, // Better debugging experience
      // Note: Using JavaScript-based optimizations while native bindings are fixed
    }),
  ],
  server: {
    port: 3000,
    open: true,
  },
  build: {
    outDir: 'dist',
  },
});
