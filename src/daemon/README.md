# @retrigger/daemon

**High-performance file system watcher daemon service for ultra-fast development tools**

A native Rust daemon that provides sub-millisecond file watching with zero-copy IPC communication. Works in conjunction with `@retrigger/core` for maximum performance in your development workflow.

## Quick Start

```bash
npm install -g @retrigger/daemon
retrigger start
```

Or use programmatically:

```bash
npm install @retrigger/daemon
```

```javascript
const { daemon } = require('@retrigger/daemon');

// Start daemon
await daemon.start({
  foreground: true,
  debug: true,
  port: 50051
});

// Check status
const status = await daemon.status();
console.log(status);
```

## 📦 Installation Options

### Global Installation (Recommended)
```bash
npm install -g @retrigger/daemon
```
This installs the `retrigger` command system-wide.

### Local Installation
```bash
npm install @retrigger/daemon
```
Use via Node.js API or `npx retrigger`.

### With Core Package
```bash
npm install @retrigger/core @retrigger/daemon
```

## 🔧 Command Line Usage

### Start the Daemon
```bash
retrigger start [options]

Options:
  -c, --config <file>    Configuration file (default: retrigger.toml)
  -f, --foreground       Run in foreground (don't daemonize)
  -d, --debug           Enable debug logging
  --bind <address>      Override bind address
  -p, --port <port>     Override port number
```

### Stop the Daemon
```bash
retrigger stop [options]

Options:
  -f, --force           Force stop (SIGKILL)
```

### Check Status
```bash
retrigger status
```

### Validate Configuration
```bash
retrigger validate [options]

Options:
  -c, --config <file>   Configuration file to validate
```

### Generate Configuration
```bash
retrigger config [options]

Options:
  -o, --output <file>   Output file (default: retrigger.toml)
  --force              Overwrite existing file
```

### Run Benchmarks
```bash
retrigger benchmark [options]

Options:
  -d, --directory <dir> Test directory (default: current)
  -f, --files <num>     Number of test files (default: 1000)
  -s, --size <bytes>    File size in bytes (default: 1024)
```

## 📋 Configuration

Generate a default configuration file:

```bash
retrigger config --output retrigger.toml
```

Example configuration:

```toml
[server]
bind_address = "127.0.0.1"
port = 50051
enable_metrics = true
metrics_port = 9090

[watcher]
event_buffer_size = 10000
debounce_ms = 50
recursive = true

[patterns]
include = ["**/*.{js,jsx,ts,tsx,vue,svelte}"]
exclude = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**"
]

[ipc]
enable_zero_copy = true
mmap_path = "/tmp/retrigger-ipc.mmap"
ring_buffer_size = 2097152  # 2MB
max_consumers = 4

[performance]
enable_simd = true
hash_block_size = 4096
cache_size = 100000
```

## Node.js API

### Basic Usage

```javascript
const { daemon } = require('@retrigger/daemon');

// Start daemon in foreground with debug logging
await daemon.start({
  foreground: true,
  debug: true,
  config: './my-config.toml'
});

// Get status
const status = await daemon.status();
console.log('Daemon status:', status);

// Stop daemon
await daemon.stop();
```

### Advanced Usage

```javascript
const { RetriggerDaemon } = require('@retrigger/daemon');

const myDaemon = new RetriggerDaemon();

// Start with custom options
await myDaemon.start({
  bind: '0.0.0.0',
  port: 50052,
  debug: process.env.NODE_ENV === 'development'
});

// Run benchmarks
await myDaemon.benchmark({
  directory: './test-files',
  files: 5000,
  size: 2048
});

// Validate configuration
try {
  await myDaemon.validateConfig('./retrigger.toml');
  console.log('✅ Configuration is valid');
} catch (error) {
  console.error('❌ Invalid configuration:', error.message);
}
```

## 🔗 Communication Protocols

### gRPC API
- **Port**: 50051 (default)
- **Protocol**: HTTP/2 with Protocol Buffers
- **Use case**: Remote control, status monitoring

### Zero-Copy IPC
- **Method**: Memory-mapped files + ring buffers
- **Latency**: Sub-millisecond
- **Use case**: High-frequency file events

### Metrics Endpoint
- **Port**: 9090 (default)
- **Format**: Prometheus metrics
- **Endpoint**: `http://localhost:9090/metrics`

## 📊 Performance

| Metric | Value |
|--------|--------|
| File event latency | <1ms |
| Events per second | >100,000 |
| Memory usage | 10-30MB |
| CPU usage (idle) | <1% |
| Startup time | <100ms |

## 🏗️ Architecture

```
┌─────────────────┐    ┌──────────────────┐
│   @retrigger/   │    │  @retrigger/     │
│      core       │◄──►│     daemon       │
│  (Node.js pkg)  │    │ (Native service) │
└─────────────────┘    └──────────────────┘
         │                       │
         ├── Webpack Plugin      ├── File System Watcher
         ├── Vite Plugin         ├── gRPC Server
         ├── IPC Bridge          ├── Zero-Copy IPC
         └── HMR Integration     └── Metrics Collection
```

## 🛠️ Requirements

- **Node.js**: 16.0.0 or higher
- **Operating Systems**: Linux, macOS, Windows
- **Architecture**: x64, ARM64

## 🔍 Troubleshooting

### Daemon Won't Start
```bash
# Check if port is available
netstat -tulpn | grep :50051

# Try different port
retrigger start --port 50052

# Check logs with debug mode
retrigger start --foreground --debug
```

### High CPU Usage
```bash
# Reduce file watching scope in config
[patterns]
exclude = [
  "**/node_modules/**",
  "**/.git/**",
  "**/coverage/**",
  "**/*.log"
]
```

### Memory Issues
```bash
# Reduce buffer sizes in config
[watcher]
event_buffer_size = 1000

[ipc]
ring_buffer_size = 524288  # 512KB
```

## 🤝 Used With

- **@retrigger/core** - Node.js development integration
- **Webpack** - Build tool integration
- **Vite** - Lightning-fast development server
- **Rspack** - Rust-based bundler
- **Any Node.js project** requiring fast file watching

## 📄 License

MIT License - see LICENSE file for details.

---

**Part of the Retrigger ecosystem - ultra-fast file watching for modern development.**
