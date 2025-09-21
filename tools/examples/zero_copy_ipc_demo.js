#!/usr/bin/env node
/**
 * Zero-Copy IPC Integration Demo
 * 
 * Demonstrates the complete shared memory IPC system between
 * Rust daemon and Node.js with real-time file monitoring.
 */

const { SharedBufferCommunicator } = require('../bindings/nodejs/src/shared-buffer');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

class IPCDemo {
  constructor() {
    this.communicator = null;
    this.daemon = null;
    this.testDir = '/tmp/retrigger-demo';
    this.stats = {
      eventsReceived: 0,
      startTime: 0,
      latencies: [],
      errors: 0,
    };
    this.isRunning = false;
  }

  /**
   * Initialize the demo
   */
  async initialize() {
    console.log('🚀 Retrigger Zero-Copy IPC Demo');
    console.log('================================\n');

    // Create test directory
    await this.createTestEnvironment();
    
    // Start Rust daemon
    await this.startRustDaemon();
    
    // Setup IPC communication
    await this.setupIPC();
    
    // Start demo
    await this.runDemo();
  }

  /**
   * Create test environment
   */
  async createTestEnvironment() {
    console.log('📁 Setting up test environment...');
    
    // Remove existing test directory
    if (fs.existsSync(this.testDir)) {
      fs.rmSync(this.testDir, { recursive: true, force: true });
    }
    
    // Create fresh test directory
    fs.mkdirSync(this.testDir, { recursive: true });
    
    console.log(`   Created test directory: ${this.testDir}`);
  }

  /**
   * Start the Rust daemon
   */
  async startRustDaemon() {
    console.log('🦀 Starting Rust daemon...');
    
    const daemonPath = path.join(__dirname, '../target/debug/retrigger-daemon');
    
    // Check if daemon exists
    if (!fs.existsSync(daemonPath)) {
      console.log('   Building daemon first...');
      await this.buildDaemon();
    }
    
    // Create daemon configuration
    const config = {
      watcher: {
        watch_paths: [
          { path: this.testDir, recursive: true, enabled: true }
        ],
        event_buffer_size: 10000,
      },
      server: {
        port: 0, // Disable gRPC for this demo
        bind_address: '127.0.0.1',
        enable_metrics: false,
      },
      ipc: {
        memory_size: 16 * 1024 * 1024, // 16MB
        ring_capacity: 10000,
        shared_path: '/tmp/retrigger-ipc.mmap',
        enable_notifications: true,
      },
    };
    
    const configPath = '/tmp/retrigger-demo.toml';
    fs.writeFileSync(configPath, this.tomlStringify(config));
    
    // Start daemon process
    this.daemon = spawn(daemonPath, [
      'start',
      '--config', configPath,
      '--foreground',
      '--debug'
    ], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    // Handle daemon output
    this.daemon.stdout.on('data', (data) => {
      console.log(`[DAEMON] ${data.toString().trim()}`);
    });
    
    this.daemon.stderr.on('data', (data) => {
      console.log(`[DAEMON ERR] ${data.toString().trim()}`);
    });
    
    this.daemon.on('exit', (code) => {
      console.log(`[DAEMON] Exited with code ${code}`);
      this.cleanup();
    });
    
    // Wait for daemon to initialize
    console.log('   Waiting for daemon to initialize...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    console.log('✅ Rust daemon started');
  }

  /**
   * Build the Rust daemon if needed
   */
  async buildDaemon() {
    return new Promise((resolve, reject) => {
      const build = spawn('cargo', ['build'], {
        cwd: path.join(__dirname, '..'),
        stdio: 'inherit'
      });
      
      build.on('exit', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Build failed with code ${code}`));
        }
      });
    });
  }

  /**
   * Setup IPC communication
   */
  async setupIPC() {
    console.log('🔗 Setting up zero-copy IPC...');
    
    this.communicator = new SharedBufferCommunicator({
      mmapPath: '/tmp/retrigger-ipc.mmap',
      pollIntervalMs: 1, // 1ms for maximum responsiveness
      enableAutoReconnect: true,
    });
    
    // Setup event handlers
    this.communicator.on('connected', () => {
      console.log('✅ Connected to Rust daemon IPC');
      this.stats.startTime = performance.now();
    });
    
    this.communicator.on('file-event', (event) => {
      this.handleFileEvent(event);
    });
    
    this.communicator.on('batch-processed', (count) => {
      console.log(`   📦 Processed batch of ${count} events`);
    });
    
    this.communicator.on('error', (error) => {
      console.error('❌ IPC Error:', error.message);
      this.stats.errors++;
    });
    
    this.communicator.on('disconnected', () => {
      console.log('❌ Disconnected from Rust daemon');
    });
    
    this.communicator.on('daemon-shutdown', () => {
      console.log('🛑 Daemon shutdown detected');
      this.cleanup();
    });
    
    // Initialize connection
    await this.communicator.initializeAsMain();
    
    console.log('✅ Zero-copy IPC initialized');
  }

  /**
   * Handle incoming file events
   */
  handleFileEvent(event) {
    this.stats.eventsReceived++;
    
    // Calculate latency
    const eventTime = parseInt(event.timestamp) / 1000000; // Convert ns to ms
    const now = performance.now();
    const latency = now - eventTime;
    this.stats.latencies.push(latency);
    
    console.log(`📄 File Event #${this.stats.eventsReceived}:`);
    console.log(`   Path: ${event.path}`);
    console.log(`   Type: ${event.event_type}`);
    console.log(`   Size: ${event.size} bytes`);
    console.log(`   Directory: ${event.is_directory}`);
    console.log(`   Latency: ${latency.toFixed(3)}ms`);
    if (event.hash) {
      console.log(`   Hash: ${event.hash.hash} (${event.hash.algorithm})`);
    }
    console.log();
  }

  /**
   * Run the main demo
   */
  async runDemo() {
    console.log('🎬 Starting demo sequence...\n');
    
    this.isRunning = true;
    
    // Wait for initial connection
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Demo sequence
    await this.demoFileOperations();
    await this.demoBulkOperations();
    await this.demoPerformanceTest();
    
    // Show final statistics
    this.showStatistics();
    
    // Cleanup and exit
    setTimeout(() => {
      this.cleanup();
    }, 2000);
  }

  /**
   * Demo basic file operations
   */
  async demoFileOperations() {
    console.log('🔧 Demo 1: Basic File Operations');
    console.log('--------------------------------');
    
    const testFile = path.join(this.testDir, 'demo.txt');
    
    // Create file
    console.log('Creating file...');
    fs.writeFileSync(testFile, 'Hello, Retrigger!');
    await this.waitForEvents(1);
    
    // Modify file
    console.log('Modifying file...');
    fs.appendFileSync(testFile, '\nZero-copy IPC is awesome!');
    await this.waitForEvents(1);
    
    // Delete file
    console.log('Deleting file...');
    fs.unlinkSync(testFile);
    await this.waitForEvents(1);
    
    console.log('✅ Basic file operations completed\n');
  }

  /**
   * Demo bulk operations
   */
  async demoBulkOperations() {
    console.log('📦 Demo 2: Bulk File Operations');
    console.log('-------------------------------');
    
    const fileCount = 100;
    console.log(`Creating ${fileCount} files rapidly...`);
    
    const startTime = performance.now();
    
    // Create many files quickly
    for (let i = 0; i < fileCount; i++) {
      const filePath = path.join(this.testDir, `bulk_${i}.txt`);
      fs.writeFileSync(filePath, `File ${i} content\n`.repeat(10));
    }
    
    // Wait for all events
    await this.waitForEvents(fileCount, 5000);
    
    const endTime = performance.now();
    const duration = endTime - startTime;
    
    console.log(`✅ Created ${fileCount} files in ${duration.toFixed(2)}ms`);
    console.log(`   Average: ${(duration / fileCount).toFixed(3)}ms per file\n`);
    
    // Cleanup bulk files
    for (let i = 0; i < fileCount; i++) {
      const filePath = path.join(this.testDir, `bulk_${i}.txt`);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  }

  /**
   * Demo performance test
   */
  async demoPerformanceTest() {
    console.log('⚡ Demo 3: Performance Stress Test');
    console.log('----------------------------------');
    
    const testCount = 1000;
    console.log(`Running ${testCount} rapid file operations...`);
    
    const startTime = performance.now();
    
    // Rapid file operations
    for (let i = 0; i < testCount; i++) {
      const filePath = path.join(this.testDir, `perf_test.txt`);
      fs.writeFileSync(filePath, `Performance test ${i}\n`);
      
      // Add small delay to prevent overwhelming the system
      if (i % 100 === 0) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    
    const endTime = performance.now();
    const duration = endTime - startTime;
    
    console.log(`✅ Completed ${testCount} operations in ${duration.toFixed(2)}ms`);
    console.log(`   Throughput: ${(testCount / (duration / 1000)).toFixed(0)} ops/second\n`);
    
    // Cleanup
    const perfFile = path.join(this.testDir, 'perf_test.txt');
    if (fs.existsSync(perfFile)) {
      fs.unlinkSync(perfFile);
    }
  }

  /**
   * Wait for a specific number of events
   */
  async waitForEvents(count, timeoutMs = 2000) {
    const startCount = this.stats.eventsReceived;
    const startTime = Date.now();
    
    while (this.stats.eventsReceived < startCount + count) {
      if (Date.now() - startTime > timeoutMs) {
        console.warn(`Timeout waiting for ${count} events (got ${this.stats.eventsReceived - startCount})`);
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  /**
   * Show final statistics
   */
  showStatistics() {
    console.log('📊 Final Statistics');
    console.log('===================');
    
    const totalTime = performance.now() - this.stats.startTime;
    const avgLatency = this.stats.latencies.length > 0 ?
      this.stats.latencies.reduce((a, b) => a + b, 0) / this.stats.latencies.length : 0;
    
    const minLatency = Math.min(...this.stats.latencies);
    const maxLatency = Math.max(...this.stats.latencies);
    
    console.log(`Events Received: ${this.stats.eventsReceived}`);
    console.log(`Total Runtime: ${(totalTime / 1000).toFixed(2)} seconds`);
    console.log(`Events/Second: ${(this.stats.eventsReceived / (totalTime / 1000)).toFixed(1)}`);
    console.log(`Average Latency: ${avgLatency.toFixed(3)}ms`);
    console.log(`Min Latency: ${minLatency.toFixed(3)}ms`);
    console.log(`Max Latency: ${maxLatency.toFixed(3)}ms`);
    console.log(`Errors: ${this.stats.errors}`);
    
    // IPC Statistics
    if (this.communicator) {
      const ipcStats = this.communicator.getStats();
      console.log('\n🔗 IPC Statistics:');
      console.log(`Connected: ${ipcStats.connected}`);
      console.log(`Events Received: ${ipcStats.eventsReceived}`);
      console.log(`Bytes Transferred: ${(ipcStats.bytesTransferred / 1024).toFixed(1)} KB`);
      console.log(`Uptime: ${(ipcStats.uptime / 1000).toFixed(1)} seconds`);
      console.log(`Events/Second: ${ipcStats.eventsPerSecond}`);
      
      if (ipcStats.bridge && ipcStats.bridge.connected) {
        console.log('\n🦀 Rust Bridge Statistics:');
        console.log(`Ring Capacity: ${ipcStats.bridge.capacity}`);
        console.log(`Ring Utilization: ${ipcStats.bridge.utilization.toFixed(1)}%`);
        console.log(`Total Events: ${ipcStats.bridge.totalEvents}`);
        console.log(`Dropped Events: ${ipcStats.bridge.droppedEvents}`);
        console.log(`Average Latency: ${(ipcStats.bridge.avgLatencyUs / 1000).toFixed(3)}ms`);
      }
    }
    
    console.log('\n🎉 Demo completed successfully!');
  }

  /**
   * Simple TOML stringifier for config
   */
  tomlStringify(obj) {
    let toml = '';
    
    for (const [section, values] of Object.entries(obj)) {
      toml += `[${section}]\n`;
      
      for (const [key, value] of Object.entries(values)) {
        if (Array.isArray(value)) {
          toml += `${key} = [\n`;
          value.forEach(item => {
            if (typeof item === 'object') {
              toml += `  { `;
              for (const [k, v] of Object.entries(item)) {
                toml += `${k} = ${typeof v === 'string' ? `"${v}"` : v}, `;
              }
              toml += `},\n`;
            }
          });
          toml += `]\n`;
        } else if (typeof value === 'string') {
          toml += `${key} = "${value}"\n`;
        } else {
          toml += `${key} = ${value}\n`;
        }
      }
      toml += '\n';
    }
    
    return toml;
  }

  /**
   * Cleanup resources
   */
  cleanup() {
    if (!this.isRunning) return;
    this.isRunning = false;
    
    console.log('\n🧹 Cleaning up...');
    
    // Disconnect IPC
    if (this.communicator) {
      this.communicator.disconnect();
    }
    
    // Stop daemon
    if (this.daemon && !this.daemon.killed) {
      this.daemon.kill('SIGTERM');
      setTimeout(() => {
        if (!this.daemon.killed) {
          this.daemon.kill('SIGKILL');
        }
      }, 5000);
    }
    
    // Remove test directory
    if (fs.existsSync(this.testDir)) {
      fs.rmSync(this.testDir, { recursive: true, force: true });
    }
    
    // Remove IPC file
    if (fs.existsSync('/tmp/retrigger-ipc.mmap')) {
      fs.unlinkSync('/tmp/retrigger-ipc.mmap');
    }
    
    // Remove config file
    if (fs.existsSync('/tmp/retrigger-demo.toml')) {
      fs.unlinkSync('/tmp/retrigger-demo.toml');
    }
    
    console.log('✅ Cleanup completed');
    process.exit(0);
  }
}

// Handle process signals
process.on('SIGINT', () => {
  console.log('\nReceived SIGINT, cleaning up...');
  if (global.demoInstance) {
    global.demoInstance.cleanup();
  } else {
    process.exit(0);
  }
});

process.on('SIGTERM', () => {
  console.log('\nReceived SIGTERM, cleaning up...');
  if (global.demoInstance) {
    global.demoInstance.cleanup();
  } else {
    process.exit(0);
  }
});

// Main execution
async function main() {
  const demo = new IPCDemo();
  global.demoInstance = demo;
  
  try {
    await demo.initialize();
  } catch (error) {
    console.error('❌ Demo failed:', error);
    demo.cleanup();
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = { IPCDemo };
