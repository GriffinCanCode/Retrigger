/**
 * Retrigger - Ultra-fast file system watcher for Node.js
 * @fileoverview Main entry point providing convenient APIs
 */

const { loadBinding } = require('@node-rs/helper');
const { EventEmitter } = require('events');
const path = require('path');

/**
 * Load the native binding
 */
const {
  RetriggerWrapper,
  hash_file_sync,
  hash_bytes_sync,
  get_simd_support,
  benchmark_hash,
} = loadBinding(__dirname, 'retrigger-bindings', '@retrigger/core');

/**
 * Event emitter wrapper for convenient file watching
 */
class RetriggerEmitter extends EventEmitter {
  constructor(watcher) {
    super();
    this.watcher = watcher;
    this.running = false;
    this.pollInterval = null;
  }

  /**
   * Start emitting file events
   */
  async start() {
    if (this.running) return;
    
    this.running = true;
    await this.watcher.start();
    
    // Start event polling loop
    this._startEventLoop();
  }

  /**
   * Stop emitting events
   */
  stop() {
    this.running = false;
    if (this.pollInterval) {
      clearTimeout(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * Internal event polling loop
   * @private
   */
  async _startEventLoop() {
    while (this.running) {
      try {
        // Wait for event with 100ms timeout
        const event = await this.watcher.wait_event(100);
        
        if (event) {
          // Emit specific event type
          this.emit(`file-${event.event_type}`, event);
          
          // Emit generic change event
          this.emit('file-changed', event);
          
          // Emit stats periodically
          if (Math.random() < 0.01) { // 1% chance to emit stats
            const stats = await this.watcher.get_stats();
            this.emit('stats', stats);
          }
        }
      } catch (error) {
        this.emit('error', error);
        // Brief pause on error to avoid tight error loop
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }
}

/**
 * Create a new Retrigger instance with convenient API
 * @param {Object} options - Configuration options
 * @returns {Object} Retrigger instance
 */
function createRetrigger(options = {}) {
  const wrapper = new RetriggerWrapper();
  const emitter = new RetriggerEmitter(wrapper);
  
  return {
    // Core functionality
    wrapper,
    emitter,
    
    // Convenience methods
    async watch(paths, watchOptions) {
      const pathArray = Array.isArray(paths) ? paths : [paths];
      
      for (const watchPath of pathArray) {
        await wrapper.watch_directory(path.resolve(watchPath), watchOptions);
      }
      
      return this;
    },
    
    async start() {
      await emitter.start();
      return this;
    },
    
    stop() {
      emitter.stop();
      return this;
    },
    
    // Event handlers
    on(event, listener) {
      emitter.on(event, listener);
      return this;
    },
    
    once(event, listener) {
      emitter.once(event, listener);
      return this;
    },
    
    off(event, listener) {
      emitter.off(event, listener);
      return this;
    },
    
    // Stats and info
    async getStats() {
      return await wrapper.get_stats();
    },
    
    getSimdLevel() {
      return wrapper.get_simd_level();
    },
    
    // Hashing utilities
    async hashFile(filePath) {
      return await wrapper.hash_file(path.resolve(filePath));
    },
    
    hashBytes(data) {
      return wrapper.hash_bytes(data);
    },
  };
}

/**
 * Quick file hashing utility
 * @param {string|Buffer} input - File path or buffer to hash
 * @returns {Object} Hash result
 */
function quickHash(input) {
  if (typeof input === 'string') {
    return hash_file_sync(path.resolve(input));
  } else if (Buffer.isBuffer(input)) {
    return hash_bytes_sync(input);
  } else {
    throw new Error('Input must be a file path string or Buffer');
  }
}

/**
 * Get system information
 * @returns {Object} System info
 */
function getSystemInfo() {
  return {
    simd_support: get_simd_support(),
    node_version: process.version,
    platform: process.platform,
    arch: process.arch,
  };
}

/**
 * Run performance benchmark
 * @param {number} testSize - Size of test data (default: 1MB)
 * @returns {Promise<Object>} Benchmark results
 */
async function runBenchmark(testSize = 1024 * 1024) {
  const results = await benchmark_hash(testSize);
  
  return {
    test_size_mb: (testSize / (1024 * 1024)).toFixed(2),
    throughput_mbps: results.throughput_mbps.toFixed(2),
    latency_ns: results.latency_ns.toFixed(0),
    ...results,
  };
}

// Lazy-loaded plugin factories to avoid circular dependencies
function getRetriggerWebpackPlugin() {
  return require('./plugins/webpack-plugin');
}

function getCreateRetriggerVitePlugin() {
  return require('./plugins/vite-plugin').createRetriggerVitePlugin;
}

function getSharedBufferCommunicator() {
  return require('./src-js/shared-buffer').SharedBufferCommunicator;
}

function getHMRManager() {
  return require('./src-js/hmr-integration').HMRManager;
}

function getPerformanceMonitor() {
  return require('./src-js/performance-monitor').PerformanceMonitor;
}

function getBundlerAdapters() {
  return require('./src-js/bundler-adapters');
}

/**
 * Enhanced Retrigger instance with advanced features
 * @param {Object} options - Configuration options
 * @returns {Object} Enhanced Retrigger instance
 */
function createAdvancedRetrigger(options = {}) {
  const retrigger = createRetrigger(options);
  
  // Add advanced features
  const advancedOptions = {
    enablePerformanceMonitoring: options.enablePerformanceMonitoring !== false,
    enableSharedBuffer: options.enableSharedBuffer !== false,
    enableHMR: options.enableHMR !== false,
    performanceOptions: options.performanceOptions || {},
    sharedBufferSize: options.sharedBufferSize || 2 * 1024 * 1024, // 2MB
    ...options,
  };

  let performanceMonitor = null;
  let sharedComm = null;
  let hmrManager = null;

  return {
    ...retrigger,
    
    // Advanced initialization
    async initializeAdvanced() {
      // Initialize performance monitoring
      if (advancedOptions.enablePerformanceMonitoring) {
        const PerformanceMonitor = getPerformanceMonitor();
        performanceMonitor = new PerformanceMonitor(advancedOptions.performanceOptions);
        await performanceMonitor.initialize();
        
        // Hook into file events for performance tracking
        retrigger.on('file-changed', (event) => {
          performanceMonitor.recordEvent(event);
        });
      }

      // Initialize SharedArrayBuffer communication
      if (advancedOptions.enableSharedBuffer) {
        const SharedBufferCommunicator = getSharedBufferCommunicator();
        sharedComm = new SharedBufferCommunicator(advancedOptions.sharedBufferSize);
        await sharedComm.initializeAsMain();
        
        // Bridge events from shared buffer to retrigger
        sharedComm.on('file-event', (event) => {
          retrigger.emitter.emit('file-changed', event);
        });
      }

      // Initialize HMR manager
      if (advancedOptions.enableHMR) {
        const HMRManager = getHMRManager();
        hmrManager = new HMRManager({
          enableSourceMaps: advancedOptions.enableSourceMaps,
          invalidationStrategy: advancedOptions.hmrInvalidationStrategy,
          verbose: advancedOptions.verbose,
        });
      }

      return this;
    },

    // Performance monitoring API
    getPerformanceStats() {
      return performanceMonitor ? performanceMonitor.getPerformanceReport() : null;
    },

    getDashboard() {
      return performanceMonitor ? performanceMonitor.getDashboardData() : null;
    },

    forceGC() {
      return performanceMonitor ? performanceMonitor.forceGarbageCollection() : false;
    },

    // SharedArrayBuffer API
    getSharedBufferStats() {
      return sharedComm ? sharedComm.getStats() : null;
    },

    // HMR API
    async processFileChangeForHMR(event, bundlerInstance, bundlerType = 'webpack') {
      if (!hmrManager) {
        throw new Error('HMR manager not initialized');
      }

      if (!hmrManager.bundlerInstance) {
        await hmrManager.initialize(bundlerType, bundlerInstance);
      }

      return await hmrManager.processFileChange(event);
    },

    getHMRStats() {
      return hmrManager ? hmrManager.getPerformanceStats() : null;
    },

    // Enhanced cleanup
    async destroy() {
      // Stop original retrigger
      retrigger.stop();

      // Cleanup advanced features
      if (performanceMonitor) {
        performanceMonitor.destroy();
        performanceMonitor = null;
      }

      if (sharedComm) {
        sharedComm.destroy();
        sharedComm = null;
      }

      if (hmrManager) {
        hmrManager.destroy();
        hmrManager = null;
      }
    },
  };
}

module.exports = {
  // Main API
  createRetrigger,
  createAdvancedRetrigger,
  
  // Low-level API
  RetriggerWrapper,
  RetriggerEmitter,
  
  // Utilities
  quickHash,
  getSystemInfo,
  runBenchmark,
  
  // Synchronous functions
  hash_file_sync,
  hash_bytes_sync,
  get_simd_support,
  benchmark_hash,
  
  // Plugins (lazy-loaded to avoid circular dependencies)
  get RetriggerWebpackPlugin() { return getRetriggerWebpackPlugin(); },
  get createRetriggerVitePlugin() { return getCreateRetriggerVitePlugin(); },
  
  // Advanced Components (lazy-loaded to avoid circular dependencies)
  get SharedBufferCommunicator() { return getSharedBufferCommunicator(); },
  get HMRManager() { return getHMRManager(); },
  get PerformanceMonitor() { return getPerformanceMonitor(); },
  
  // Bundler Adapters (lazy-loaded to avoid circular dependencies)
  get BundlerFactory() { return getBundlerAdapters().BundlerFactory; },
  get WebpackAdapter() { return getBundlerAdapters().WebpackAdapter; },
  get RspackAdapter() { return getBundlerAdapters().RspackAdapter; },
  get TurbopackAdapter() { return getBundlerAdapters().TurbopackAdapter; },
  
  // Constants
  DEFAULT_WATCH_OPTIONS: {
    recursive: true,
    exclude_patterns: [
      '**/node_modules/**',
      '**/.git/**',
      '**/.*',
      '**/*.log',
    ],
    enable_hashing: true,
    hash_block_size: 4096,
  },

  ADVANCED_DEFAULT_OPTIONS: {
    enablePerformanceMonitoring: true,
    enableSharedBuffer: true,
    enableHMR: true,
    enableSourceMaps: true,
    hmrInvalidationStrategy: 'smart',
    sharedBufferSize: 2 * 1024 * 1024, // 2MB
    performanceOptions: {
      metricsInterval: 1000,
      memoryCheckInterval: 5000,
      enableMemoryLeakDetection: true,
      enableAdaptiveOptimization: true,
      enableAlerting: true,
    },
  },
};

// Default export for ES modules
module.exports.default = module.exports;
