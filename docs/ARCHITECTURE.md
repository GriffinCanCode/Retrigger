# Architecture

### **Phase 1: Core Hashing Engine (C)**
- Implement base portable hashing function using XXH3 algorithm as foundation (proven fastest non-cryptographic hasher)
- Add SIMD-optimized paths: AVX-512 for Intel Sapphire Rapids, AVX2 for older x86, NEON for ARM/Apple Silicon
- Implement incremental hashing with 4KB block-based approach for partial file updates
- Benchmark against xxHash, BLAKE3, and CityHash to verify 5-10x improvement on file operations
- Target: <0.5ms for 1MB file, <5ms for 100MB file

### **Phase 2: System Integration Layer (Zig)**
- Implement inotify wrapper for Linux with IN_MODIFY, IN_CREATE, IN_DELETE events
- Add fanotify support for mount-wide monitoring without per-directory watch limits
- Implement io_uring for zero-copy file reading with registered buffers and SQPOLL mode
- Create memory-mapped ring buffer (64MB default) for lock-free event passing between kernel and userspace
- Add eBPF tracepoint hooks on vfs_write/vfs_open for cases where inotify hits limits
- Target: <1ms latency from file change to event notification

### **Phase 3: High-Level API and Daemon (Rust)**
- Build daemon using tokio async runtime with multi-threaded executor
- Implement shared memory IPC using memmap2 crate for zero-copy communication with Node.js
- Add gRPC server (using tonic) for remote daemon connections
- Create hierarchical hash cache with dashmap for concurrent access
- Implement file pattern matching using globset crate for .gitignore-style excludes
- Add configuration hot-reload without daemon restart

### **Phase 4: Node.js Integration**
- Use napi-rs v2 with latest N-API features for Node.js bindings
- Implement SharedArrayBuffer-based communication for instant change notifications
- Create webpack plugin that hooks into webpack's FileSystemWatcher interface
- Add Rspack/Turbopack compatibility layers (both are Rust-based and growing fast)
- Support for Vite through custom HMR API integration
- Include TypeScript definitions generated automatically by napi-rs

### **Phase 5: Advanced Optimizations**
- Implement predictive pre-hashing using machine learning (track edit patterns with simple Markov chains)
- Add binary diff hashing - only rehash modified 4KB blocks using rolling checksums
- Implement FSEvents for macOS using kqueue and fseventsd integration
- Add ReadDirectoryChangesW support for Windows using completion ports
- Create eBPF program for in-kernel filtering to reduce userspace events by 90%
- Support for DRBD/NFS environments using fanotify marks on mount points

### **Phase 6: Platform Extensions**
- Add Docker container support by monitoring overlayfs layers
- Implement Kubernetes ConfigMap/Secret watching via inotify on mounted volumes
- Create VS Code extension that uses daemon for instant file search/indexing
- Add support for remote development (Codespaces/Gitpod) with WebSocket transport
- Integrate with Bazel/Buck2/Turborepo for monorepo build caching

### **Phase 7: Testing and Benchmarking**
- Test on major OSS projects: Next.js (50K+ files), Chromium (200K+ files), Linux kernel (70K+ files)
- Create reproducible benchmarks comparing against Watchman, Chokidar, and native webpack watching
- Implement stress tests: 1M files, 10K concurrent changes, network filesystems
- Add integration tests for all major bundlers: webpack 5, Vite 5, Rspack, Turbopack, esbuild
- Performance targets: 100x faster than Chokidar, 50x faster than webpack native watching

### **Key Technology Choices for 2025:**
- **io_uring** over epoll - 30% better performance for file operations on Linux 5.19+
- **eBPF** for overflow handling - when inotify limits hit, fall back to kernel tracing
- **NAPI-RS v2** - fastest Node.js binding framework, used by @node-rs/xxhash and others
- **Rust async** with tokio - better than threads for handling 100K+ concurrent file watches
- **Shared memory** over Unix sockets - zero-copy IPC for sub-millisecond latency
- **XXH3** as base algorithm - fastest for small inputs, perfect for incremental hashing

This architecture specifically targets the webpack ecosystem pain points: slow initial scanning (we'll do 50K files in <200ms), high CPU usage during watching (we'll use <1% CPU idle), and slow change detection (we'll achieve <5ms from save to webpack notification).