# Retrigger

**High-Performance File System Watcher for Modern Development Workflows**

⚠️ **PROJECT STATUS**: Retrigger is an ambitious file system monitoring project with a working hash engine but currently broken file watching functionality. The performance claims below are theoretical and cannot be verified with the current implementation.

## What Retrigger Aims to Do

Retrigger aims to monitor project files and detect changes with sub-millisecond latency. The intended workflow:

- ❌ Detect changes through kernel-level file system events (currently broken)
- ✅ Compute optimized hashes using SIMD-accelerated algorithms (working)
- ❌ Maintain an in-memory cache of file states (not functional)
- ❌ Notify development tools (webpack, Vite, etc.) through zero-copy IPC (broken)
- ❌ Trigger rebuilds in under 5ms (cannot test - file watching broken)

**Current Reality**: The hash engine works well, but core file watching is non-functional.

## Why I Built Retrigger

The original motivation was to improve file watching performance for large projects. However, benchmarking reveals that current tools are already quite efficient:

**Actual Performance of Existing Tools:**
- Chokidar (webpack/vite default): 0.3-0.7ms first event latency
- @parcel/watcher: 4-56ms first event latency  
- Native fs.watch: 0.8-2.2ms first event latency

**Reality Check**: The premise that JavaScript watchers are "prohibitively slow" doesn't match current measurements. Modern file watchers already achieve sub-10ms latencies, making the claimed 100-400x improvements mathematically questionable.

**Current Status**: While the hash engine shows promise with SIMD optimization, the core file watching implementation needs to be completed and tested against realistic benchmarks.

## System Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   File System   │    │  Retrigger      │    │  Development    │
│    Changes      │    │    Daemon       │    │     Tools       │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         │ inotify/FSEvents      │                       │
         ├──────────────────────►│                       │
         │                       │                       │
         │                    ┌──▼──────────────────┐    │
         │                    │  System Watcher     │    │
         │                    │  (Zig/C)           │    │
         │                    └──┬──────────────────┘    │
         │                       │                       │
         │                    ┌──▼──────────────────┐    │
         │                    │  Hash Engine        │    │
         │                    │  (SIMD-optimized)   │    │
         │                    └──┬──────────────────┘    │
         │                       │                       │
         │                    ┌──▼──────────────────┐    │
         │                    │  Cache & IPC        │    │
         │                    │  (Rust daemon)      │    │
         │                    └──┬──────────────────┘    │
         │                       │                       │
         │                    ┌──▼──────────────────┐    │
         │                    │  Node.js Bindings   │    │
         │                    │  (Zero-copy IPC)    │    │
         │                    └──┬──────────────────┘    │
         │                       │                       │
         │                       │ Plugin Interface      │
         │                       ├──────────────────────►│
         │                       │                       │
         │                   <5ms latency              webpack
         │                                             Vite
         │                                             Rspack
```

## Key Features

**Performance**
- Sub-5ms file change detection and notification
- SIMD-accelerated hashing (AVX-512, AVX2, NEON)
- Zero-copy IPC using shared memory
- Incremental hashing for partial file updates

**System Integration**
- Native kernel integration (inotify, FSEvents, ReadDirectoryChangesW)
- eBPF support for advanced filtering
- io_uring for zero-copy file operations on Linux
- Hot-reloadable configuration without daemon restart

**Developer Experience**
- Drop-in webpack/Vite plugin integration
- TypeScript definitions included
- Comprehensive metrics and monitoring
- Cross-platform support (Linux, macOS, Windows)

## Performance Benchmarks

⚠️ **IMPORTANT: Core file watching functionality is currently broken. The statistics below show what competitors actually achieve, not Retrigger performance.**

### Verified Performance (Tested September 2025)

| Component | Status | Performance |
|-----------|--------|-------------|
| Hash Engine | ✅ Working | SIMD-accelerated (Neon), 11GB/s throughput |
| File Watching | ❌ Broken | Cannot measure - implementation issues |
| Memory Usage | ✅ Lower | Minimal overhead compared to alternatives |

### Actual Webpack/Vite File Watcher Performance

| Watcher | First Event Latency | Average Latency | Memory Usage | Status |
|---------|-------------------|-----------------|--------------|---------|
| chokidar (webpack/vite default) | 0.3-0.7ms | 0.02-0.04ms | Low | ✅ Fast |
| @parcel/watcher | 4-56ms | 2.8-3.4ms | 58-106MB | ✅ Functional |  
| node fs.watch | 0.8-2.2ms | 0.05-0.13ms | 58-106MB | ✅ Lightweight |
| **Retrigger** | ❌ Cannot test | ❌ Cannot test | ❌ Cannot test | ❌ Broken |

### File Scan Performance (Large Projects)

| File Count | Chokidar Ready Time | Parcel Watcher Ready | 
|-----------|-------------------|---------------------|
| 1,000 files | 33ms | 0ms |
| 5,000 files | 152ms | 50ms |
| 10,000 files | 341ms | 29ms |
| 25,000 files | 858ms | 14ms |

**Current Reality**: Existing tools are already quite fast. Claims of 100-400x improvement appear unrealistic.

## Getting Started

⚠️ **WARNING: Retrigger is not ready for production use. Core file watching functionality is broken.**

### Current Status

- ✅ Hash engine can be built and tested
- ❌ File watching daemon crashes
- ❌ Node.js bindings for file watching don't work
- ❌ Webpack/Vite plugins are non-functional

### Testing the Hash Engine (What Works)

```bash
# Build the project
cd src/bindings/nodejs
cargo build --release

# Test hash functionality only
node -e "
const { hashBytesSync, getSimdSupport } = require('./index.js');
console.log('SIMD:', getSimdSupport());
console.log('Hash test:', hashBytesSync(Buffer.from('hello world')));
"
```

### Running Benchmarks

```bash
cd tools/benchmarks

# Test what actually works vs alternatives
node working_components_benchmark.js

# Results will show:
# - Hash engine performance (working)
# - Competitor file watcher performance
# - Verification of README claims
```

**Recommendation**: Use existing tools like chokidar or @parcel/watcher for production webpack/Vite setups until Retrigger's file watching is fixed.

## Technical Implementation

Retrigger implements a multi-layer architecture optimized for performance:

1. **Core Hash Engine (C)**: SIMD-optimized XXH3 implementation with AVX-512/NEON support
2. **System Integration (Zig)**: Zero-overhead bindings to kernel file system APIs
3. **Daemon Logic (Rust)**: Async runtime with tokio, concurrent hash caching, gRPC server
4. **Node.js Bindings**: NAPI-RS based bindings with SharedArrayBuffer communication

**Note**: The system architecture is well-designed in theory, but the implementation is incomplete. The hash engine works and shows promise, but file watching components need significant debugging and fixes.

## Benchmark Results Summary (September 2025)

This README has been updated with **actual verified performance data**. Here's what testing revealed:

### ✅ What Works
- **Hash Engine**: SIMD-accelerated (Neon on M1), achieving ~11GB/s throughput
- **Build System**: Project compiles successfully on macOS ARM64
- **Basic Bindings**: Can load and call hash functions from Node.js

### ❌ What's Broken  
- **File Watching**: Core functionality crashes - cannot detect file changes
- **IPC Communication**: Event polling fails
- **Performance Claims**: Cannot verify any file watching performance claims
- **Plugin Integration**: Webpack/Vite plugins don't work

### 📊 Competitor Reality Check
Current webpack/Vite alternatives perform much better than originally claimed:

| Tool | First Event | Average | Memory |
|------|------------|---------|---------|
| chokidar | 0.3-0.7ms | 0.02-0.04ms | Low |
| @parcel/watcher | 4-56ms | 2.8-3.4ms | 58-106MB |
| Node fs.watch | 0.8-2.2ms | 0.05-0.13ms | 58-106MB |

**Conclusion**: Claims of 100-400x improvement over "slow" JavaScript watchers appear to be based on outdated assumptions. Modern file watchers are already quite fast.

### 🎯 Path Forward
1. Fix core file watching implementation
2. Get daemon and IPC working reliably  
3. Run proper benchmarks against working implementation
4. Revise performance claims based on actual measurements
5. Compare against real-world webpack/Vite usage patterns

---

## License

MIT License - see LICENSE file for details.

## Contributing

**Current Priority**: Fix core file watching functionality before adding features. The hash engine foundation is solid, but the main value proposition depends on reliable file system monitoring.
