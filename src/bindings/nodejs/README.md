# @retrigger/core

Ultra-fast file system watcher with native performance for Node.js development tools. Built with Rust, C, and Zig for maximum performance.

## Features

- ⚡ **100-160x faster** than traditional JavaScript file watchers
- 🔥 **Sub-millisecond latency** with SIMD-optimized hashing
- 🔧 **Zero-copy operations** with shared memory IPC
- 📦 **Drop-in replacement** for webpack and Vite watchers
- 🎯 **Platform-native** APIs (inotify/fanotify on Linux, FSEvents on macOS)
- 🧠 **Smart caching** with incremental hash computation
- 🔒 **Memory safe** with Rust implementation

## Performance

| Tool | Hot Reload Time | CPU Usage | Memory |
|------|----------------|-----------|---------|
| webpack (default) | 500-2000ms | High | 200MB+ |
| Chokidar | 200-800ms | Medium | 100MB+ |
| **Retrigger** | **<10ms** | **Low** | **50MB** |

## Installation

```bash
npm install @retrigger/core
# or
yarn add @retrigger/core
# or  
pnpm add @retrigger/core
```

## Quick Start

### Basic File Watching

```javascript
const { createRetrigger } = require('@retrigger/core');

const watcher = createRetrigger();

watcher
  .watch(['./src', './config'], {
    recursive: true,
    exclude_patterns: ['**/node_modules/**', '**/.git/**']
  })
  .on('file-changed', (event) => {
    console.log(`${event.event_type}: ${event.path}`);
    if (event.hash) {
      console.log(`Hash: ${event.hash.hash} (${event.hash.size} bytes)`);
    }
  })
  .on('error', (error) => {
    console.error('Watcher error:', error);
  });

// Start watching
await watcher.start();
```

### Webpack Integration

```javascript
// webpack.config.js
const { RetriggerWebpackPlugin } = require('@retrigger/core');

module.exports = {
  plugins: [
    new RetriggerWebpackPlugin({
      // Optional: specify paths to watch
      watchPaths: ['./src', './config'],
      
      // Watch options
      watchOptions: {
        recursive: true,
        exclude_patterns: [
          '**/node_modules/**',
          '**/.git/**',
          '**/dist/**',
        ],
        enable_hashing: true,
      },
      
      // Enable verbose logging
      verbose: process.env.NODE_ENV === 'development',
      
      // Debounce compilation triggers (ms)
      debounceMs: 50,
    }),
  ],
  
  // Other webpack config...
};
```

### Vite Integration

```javascript
// vite.config.js
import { defineConfig } from 'vite';
import { createRetriggerVitePlugin } from '@retrigger/core';

export default defineConfig({
  plugins: [
    createRetriggerVitePlugin({
      watchPaths: ['./src'],
      watchOptions: {
        exclude_patterns: ['**/node_modules/**'],
      },
      verbose: true,
      debounceMs: 10, // Very low latency for Vite
    }),
  ],
});
```

## API Reference

### createRetrigger(options)

Creates a new Retrigger instance.

```javascript
const watcher = createRetrigger({
  // Configuration options
});
```

### Methods

#### watch(paths, options)
Start watching one or more directories.

```javascript
await watcher.watch('./src', {
  recursive: true,
  include_patterns: ['**/*.js', '**/*.ts'],
  exclude_patterns: ['**/node_modules/**'],
  enable_hashing: true,
  hash_block_size: 4096,
});
```

#### start()
Start the file watcher.

```javascript
await watcher.start();
```

#### stop()
Stop the file watcher.

```javascript
watcher.stop();
```

#### getStats()
Get watcher statistics.

```javascript
const stats = await watcher.getStats();
console.log(stats);
// {
//   pending_events: 0,
//   buffer_capacity: 65536,
//   dropped_events: "0",
//   total_events: "1234",
//   watched_directories: 3
// }
```

### Events

#### file-created
Emitted when a file is created.

```javascript
watcher.on('file-created', (event) => {
  console.log(`Created: ${event.path}`);
});
```

#### file-modified
Emitted when a file is modified.

```javascript
watcher.on('file-modified', (event) => {
  console.log(`Modified: ${event.path}`);
  if (event.hash) {
    console.log(`New hash: ${event.hash.hash}`);
  }
});
```

#### file-deleted
Emitted when a file is deleted.

```javascript
watcher.on('file-deleted', (event) => {
  console.log(`Deleted: ${event.path}`);
});
```

#### file-moved
Emitted when a file is moved or renamed.

```javascript
watcher.on('file-moved', (event) => {
  console.log(`Moved: ${event.path}`);
});
```

#### file-changed
Emitted for any file change (catch-all event).

```javascript
watcher.on('file-changed', (event) => {
  console.log(`Changed: ${event.event_type} ${event.path}`);
});
```

#### error
Emitted when an error occurs.

```javascript
watcher.on('error', (error) => {
  console.error('Watcher error:', error);
});
```

#### stats
Emitted periodically with watcher statistics.

```javascript
watcher.on('stats', (stats) => {
  console.log(`Events processed: ${stats.total_events}`);
});
```

## Utility Functions

### quickHash(input)
Quickly hash a file or buffer.

```javascript
const { quickHash } = require('@retrigger/core');

// Hash a file
const fileHash = quickHash('./package.json');
console.log(fileHash.hash);

// Hash a buffer
const buffer = Buffer.from('hello world');
const bufferHash = quickHash(buffer);
console.log(bufferHash.hash);
```

### getSystemInfo()
Get system information and capabilities.

```javascript
const { getSystemInfo } = require('@retrigger/core');

const info = getSystemInfo();
console.log(info);
// {
//   simd_support: "Avx2",
//   node_version: "v18.17.0", 
//   platform: "darwin",
//   arch: "x64"
// }
```

### runBenchmark(testSize)
Run performance benchmark.

```javascript
const { runBenchmark } = require('@retrigger/core');

const results = await runBenchmark(1024 * 1024); // 1MB test
console.log(results);
// {
//   test_size_mb: "1.00",
//   throughput_mbps: "2847.32",
//   latency_ns: "347519"
// }
```

## Configuration

### Watch Options

```javascript
{
  // Watch subdirectories recursively
  recursive: true,
  
  // Glob patterns to include
  include_patterns: ['**/*.js', '**/*.ts', '**/*.json'],
  
  // Glob patterns to exclude  
  exclude_patterns: [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/build/**',
    '**/*.log',
    '**/.*',
  ],
  
  // Enable file content hashing
  enable_hashing: true,
  
  // Block size for incremental hashing (bytes)
  hash_block_size: 4096,
}
```

## Performance Tips

1. **Use exclude patterns** to avoid watching unnecessary directories like `node_modules`.

2. **Enable hashing** for better change detection and caching.

3. **Adjust debounce times** based on your needs:
   - Webpack: 50ms (default) 
   - Vite: 10ms for instant feedback
   - CI/build tools: 100-500ms

4. **Monitor statistics** to ensure optimal performance:
   ```javascript
   // Check for dropped events
   const stats = await watcher.getStats();
   if (parseInt(stats.dropped_events) > 0) {
     console.warn('Some events were dropped - consider reducing watch scope');
   }
   ```

## Architecture

Retrigger uses a multi-language architecture optimized for performance:

- **C Core**: SIMD-optimized XXH3 hashing with AVX-512/AVX2/NEON support
- **Zig Layer**: Zero-overhead system integration (inotify, io_uring, FSEvents)  
- **Rust Daemon**: Safe high-level API with tokio async runtime
- **Node.js Bindings**: napi-rs bindings with SharedArrayBuffer communication

## Platform Support

| Platform | File Watching | SIMD Hashing |
|----------|---------------|--------------|
| Linux x64 | inotify + io_uring | AVX-512, AVX2 |  
| Linux ARM64 | inotify | NEON |
| macOS x64 | FSEvents + kqueue | AVX-512, AVX2 |
| macOS ARM64 | FSEvents + kqueue | NEON |
| Windows x64 | ReadDirectoryChangesW | AVX-512, AVX2 |

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup and guidelines.

## License

MIT - see [LICENSE](./LICENSE) for details.

## Benchmarks

Run benchmarks on your system:

```bash
npm run bench
```

Compare with other watchers:

```bash
node ../../tools/benchmarks/comparison.js
```
