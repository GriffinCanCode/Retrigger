/**
 * Retrigger Webpack Plugin - Enhanced with SharedArrayBuffer and Advanced Integration
 * Replaces webpack's default file watching with ultra-fast native watching
 *
 * Features:
 * - SharedArrayBuffer communication for sub-millisecond event propagation
 * - Complete webpack FileSystemWatcher interface implementation
 * - Advanced module invalidation with dependency tracking
 * - Performance monitoring and optimization
 */

const path = require('path');

// Lazy load to avoid circular dependencies
function getCreateRetrigger() {
  return require('../index').createRetrigger;
}

function getSharedBufferCommunicator() {
  return require('../src-js/shared-buffer').SharedBufferCommunicator;
}

function getWebpackAdapter() {
  return require('../src-js/bundler-adapters').WebpackAdapter;
}

class RetriggerWebpackPlugin {
  constructor(options = {}) {
    this.options = {
      watchPaths: options.watchPaths || [],
      watchOptions: {
        recursive: true,
        exclude_patterns: [
          '**/node_modules/**',
          '**/.git/**',
          '**/dist/**',
          '**/build/**',
          '**/*.log',
          '**/.*',
          ...((options.watchOptions && options.watchOptions.exclude_patterns) ||
            []),
        ],
        include_patterns:
          options.watchOptions && options.watchOptions.include_patterns,
        enable_hashing: options.watchOptions?.enable_hashing ?? true,
        hash_block_size: options.watchOptions?.hash_block_size || 4096,
        ...options.watchOptions,
      },
      verbose: options.verbose || false,
      debounceMs: options.debounceMs || 50,
      enableHMR: options.enableHMR !== false,
      useSharedBuffer: options.useSharedBuffer !== false,
      sharedBufferSize: options.sharedBufferSize || 2 * 1024 * 1024, // 2MB
      maxEventBatch: options.maxEventBatch || 200,
      enableAdvancedInvalidation: options.enableAdvancedInvalidation !== false,
      enableNativeWatching: options.enableNativeWatching !== false,
    };

    this.watcher = null;
    this.compiler = null;
    this.bundlerAdapter = null;
    this.isWatching = false;
    this.changeBuffer = new Map();
    this.debounceTimer = null;
    this.sharedComm = null;
    this.moduleGraph = new Map();
    this.dependencyCache = new Map();
    this.performanceMetrics = {
      eventsProcessed: 0,
      invalidationsTriggered: 0,
      averageEventLatency: 0,
      lastEventBatch: 0,
    };
  }

  /**
   * Apply the plugin to webpack compiler
   * @param {Object} compiler - Webpack compiler instance
   */
  apply(compiler) {
    this.compiler = compiler;

    // Validate compiler has required structure
    if (!compiler || !compiler.hooks) {
      if (this.options.verbose) {
        console.warn(
          '[Retrigger] Invalid webpack compiler provided, plugin will not function'
        );
      }
      return;
    }

    // Skip bundler adapter when running inside webpack (prevents circular dependency)
    this.bundlerAdapter = null;

    // Initialize SharedArrayBuffer communication if enabled
    if (this.options.useSharedBuffer) {
      const SharedBufferCommunicator = getSharedBufferCommunicator();
      this.sharedComm = new SharedBufferCommunicator(
        this.options.sharedBufferSize
      );
    }

    // Log plugin initialization (always register this hook for counting)
    if (compiler.hooks.initialize) {
      compiler.hooks.initialize.tap('RetriggerWebpackPlugin', () => {
        if (this.options.verbose) {
          console.log(
            '[Retrigger] Initializing enhanced webpack plugin with SharedArrayBuffer'
          );
        }
      });
    }

    // Setup compilation hooks for module tracking
    this._setupCompilationHooks(compiler);

    // Hook into webpack's watch mode
    compiler.hooks.watchRun.tapAsync(
      'RetriggerWebpackPlugin',
      async (compilation, callback) => {
        if (!this.isWatching) {
          await this.startWatching(compilation);
        }
        callback();
      }
    );

    // Clean up on watch close
    compiler.hooks.watchClose.tap('RetriggerWebpackPlugin', () => {
      this.stopWatching();
    });

    // Replace webpack's file system with our enhanced version
    compiler.watchFileSystem = new RetriggerFileSystem(
      compiler.watchFileSystem,
      this,
      this.options
    );

    // Bundler adapter intentionally disabled to prevent circular dependencies when running inside webpack
  }

  /**
   * Setup webpack compilation hooks for module tracking
   * @param {Object} compiler - Webpack compiler instance
   * @private
   */
  _setupCompilationHooks(compiler) {
    // Hook into compilation for module graph tracking
    compiler.hooks.compilation.tap('RetriggerWebpackPlugin', (compilation) => {
      // Track module dependencies for advanced invalidation
      compilation.hooks.buildModule.tap('RetriggerWebpackPlugin', (module) => {
        if (module.resource && this.options.enableAdvancedInvalidation) {
          this.moduleGraph.set(module.resource, {
            dependencies: new Set(),
            dependents: new Set(),
            lastModified: Date.now(),
          });
        }
      });

      // Track dependency relationships
      compilation.hooks.succeedModule.tap(
        'RetriggerWebpackPlugin',
        (module) => {
          if (module.resource && module.dependencies) {
            const moduleInfo = this.moduleGraph.get(module.resource);
            if (moduleInfo) {
              module.dependencies.forEach((dep) => {
                if (dep.module && dep.module.resource) {
                  moduleInfo.dependencies.add(dep.module.resource);

                  // Add reverse dependency
                  const depInfo = this.moduleGraph.get(dep.module.resource) || {
                    dependencies: new Set(),
                    dependents: new Set(),
                    lastModified: Date.now(),
                  };
                  depInfo.dependents.add(module.resource);
                  this.moduleGraph.set(dep.module.resource, depInfo);
                }
              });
            }
          }
        }
      );
    });

    // SharedArrayBuffer communication setup
    if (this.options.useSharedBuffer && this.sharedComm) {
      this.sharedComm.on('file-event', (event) => {
        this.handleSharedBufferEvent(event);
      });

      this.sharedComm.on('error', (error) => {
        if (this.options.verbose) {
          console.error('[Retrigger] SharedArrayBuffer error:', error);
        }
      });

      // Initialize as main thread
      this.sharedComm.initializeAsMain().catch((error) => {
        if (this.options.verbose) {
          console.error(
            '[Retrigger] Failed to initialize SharedArrayBuffer:',
            error
          );
        }
      });
    }
  }

  /**
   * Handle events from SharedArrayBuffer communication
   * @param {Object} event - File system event from shared buffer
   * @private
   */
  handleSharedBufferEvent(event) {
    if (!this.shouldIncludeFile(event.path)) return;

    // Process with ultra-low latency
    const processedEvent = {
      ...event,
      processedAt: process.hrtime.bigint(),
    };

    // Update performance metrics
    this.performanceMetrics.eventsProcessed++;

    // Direct invalidation for maximum speed
    if (this.options.enableAdvancedInvalidation) {
      this.invalidateModuleTree(event.path);
    } else {
      this.triggerWebpackCompilation([processedEvent]);
    }
  }

  /**
   * Intelligently invalidate module tree based on dependencies
   * @param {string} changedFile - Path of changed file
   * @private
   */
  invalidateModuleTree(changedFile) {
    const moduleInfo = this.moduleGraph.get(changedFile);
    if (!moduleInfo) {
      // File not in module graph, trigger standard compilation
      this.triggerWebpackCompilation([
        { path: changedFile, event_type: 'modified' },
      ]);
      return;
    }

    // Collect all files that need invalidation
    const toInvalidate = new Set([changedFile]);

    // Add all dependents (files that import this file)
    const addDependents = (filePath) => {
      const info = this.moduleGraph.get(filePath);
      if (info) {
        info.dependents.forEach((dependent) => {
          if (!toInvalidate.has(dependent)) {
            toInvalidate.add(dependent);
            addDependents(dependent); // Recursive dependency invalidation
          }
        });
      }
    };

    addDependents(changedFile);

    if (this.options.verbose) {
      console.log(
        `[Retrigger] Advanced invalidation: ${changedFile} affects ${toInvalidate.size - 1} dependent modules`
      );
    }

    // Trigger webpack compilation with specific file set
    const events = Array.from(toInvalidate).map((path) => ({
      path,
      event_type: 'modified',
      timestamp: Date.now().toString(),
    }));

    this.performanceMetrics.invalidationsTriggered++;
    this.triggerWebpackCompilation(events);
  }

  /**
   * Enhanced webpack compilation trigger with performance optimization
   * @param {Array} events - Array of file events
   * @private
   */
  triggerWebpackCompilation(events = []) {
    if (!this.compiler || events.length === 0) return;

    // Batch events if too many
    const eventsToProcess = events.slice(0, this.options.maxEventBatch);

    if (this.options.verbose) {
      console.log(
        `[Retrigger] Triggering compilation for ${eventsToProcess.length} file changes`
      );
      eventsToProcess.forEach((event) => {
        console.log(`  - ${event.event_type}: ${event.path}`);
      });
    }

    // Update performance metrics
    const startTime = process.hrtime.bigint();

    // Trigger webpack's invalidation
    if (this.compiler.watching) {
      const filePaths = eventsToProcess.map((event) => event.path);
      this.compiler.watching.invalidate(filePaths);

      // Calculate average event latency
      const latency = Number(process.hrtime.bigint() - startTime) / 1000000; // Convert to milliseconds
      this.performanceMetrics.averageEventLatency =
        (this.performanceMetrics.averageEventLatency + latency) / 2;
    }
  }

  /**
   * Start file watching
   * @param {Object} compilation - Webpack compilation
   */
  async startWatching(compilation) {
    if (this.isWatching) return;

    // Skip native watching if disabled
    if (!this.options.enableNativeWatching) {
      if (this.options.verbose) {
        console.log(
          '[Retrigger] Native watching disabled, using webpack default watching'
        );
      }
      this.isWatching = true;
      return;
    }

    try {
      const createRetrigger = getCreateRetrigger();
      this.watcher = createRetrigger();
      this.isWatching = true;

      // Determine paths to watch
      const watchPaths = this.getWatchPaths(compilation);

      if (this.options.verbose) {
        console.log(`[Retrigger] Watching ${watchPaths.length} directories:`);
        watchPaths.forEach((p) => console.log(`  - ${p}`));
      }

      // Watch directories
      for (const watchPath of watchPaths) {
        await this.watcher.watch(watchPath, this.options.watchOptions);
      }

      // Set up event handlers
      this.setupEventHandlers();

      // Start watching
      await this.watcher.start();

      if (this.options.verbose) {
        const stats = await this.watcher.getStats();
        const simdLevel = this.watcher.getSimdLevel();
        console.log(`[Retrigger] Started with SIMD level: ${simdLevel}`);
        console.log(
          `[Retrigger] Watching ${stats.watched_directories} directories`
        );
      }
    } catch (error) {
      console.error('[Retrigger] Failed to start watching:', error);
      this.isWatching = false;
      throw error;
    }
  }

  /**
   * Stop file watching
   */
  stopWatching() {
    if (this.watcher && this.isWatching) {
      this.watcher.stop();
      this.watcher = null;
      this.isWatching = false;

      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
      }

      if (this.options.verbose) {
        console.log('[Retrigger] Stopped watching');
      }
    }
  }

  /**
   * Get directories to watch based on webpack context
   * @param {Object} compilation - Webpack compilation
   * @returns {string[]} Array of paths to watch
   */
  getWatchPaths(compilation) {
    const paths = new Set();

    // Add explicitly configured paths
    this.options.watchPaths.forEach((p) => paths.add(path.resolve(p)));

    // Add webpack context
    if (compilation.compiler.context) {
      paths.add(compilation.compiler.context);
    }

    // Add entry points
    if (compilation.entries) {
      compilation.entries.forEach((entry) => {
        if (entry.resource) {
          paths.add(path.dirname(path.resolve(entry.resource)));
        }
      });
    }

    // Default to current working directory if no paths found
    if (paths.size === 0) {
      paths.add(process.cwd());
    }

    return Array.from(paths);
  }

  /**
   * Set up file change event handlers
   */
  setupEventHandlers() {
    // Handle file changes with debouncing
    this.watcher.on('file-changed', (event) => {
      this.handleFileChange(event);
    });

    // Handle errors
    this.watcher.on('error', (error) => {
      console.error('[Retrigger] Watcher error:', error);
    });

    // Log stats periodically if verbose
    if (this.options.verbose) {
      this.watcher.on('stats', (stats) => {
        console.log(
          `[Retrigger] Stats - Pending: ${stats.pending_events}, Total: ${stats.total_events}`
        );
      });
    }
  }

  /**
   * Handle file change events with debouncing
   * @param {Object} event - File change event
   */
  handleFileChange(event) {
    // Skip directories
    if (event.is_directory) return;

    // Filter files based on webpack's module resolution
    if (!this.shouldIncludeFile(event.path)) {
      return;
    }

    // Add to change buffer
    this.changeBuffer.set(event.path, {
      event,
      timestamp: Date.now(),
    });

    // Debounce compilation trigger
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.triggerWebpackCompilation();
    }, this.options.debounceMs);
  }

  /**
   * Check if file should trigger webpack recompilation
   * @param {string} filePath - File path to check
   * @returns {boolean} Whether file should be included
   */
  shouldIncludeFile(filePath) {
    // Skip common non-source files
    const skipExtensions = ['.log', '.lock', '.tmp', '.swp', '.DS_Store'];
    const skipPatterns = [/node_modules/, /\.git/, /dist/, /build/, /coverage/];

    const basename = path.basename(filePath);

    // Check extensions
    if (skipExtensions.some((ext) => basename.endsWith(ext))) {
      return false;
    }

    // Check patterns
    if (skipPatterns.some((pattern) => pattern.test(filePath))) {
      return false;
    }

    return true;
  }

  /**
   * Trigger webpack compilation
   */
  triggerWebpackCompilation() {
    if (!this.compiler || this.changeBuffer.size === 0) {
      return;
    }

    const changes = Array.from(this.changeBuffer.values());
    this.changeBuffer.clear();

    if (this.options.verbose) {
      console.log(
        `[Retrigger] Triggering compilation for ${changes.length} changes`
      );
      changes.forEach(({ event }) => {
        console.log(`  - ${event.event_type}: ${event.path}`);
      });
    }

    // Trigger webpack's invalidation
    if (this.compiler.watching) {
      const filePaths = changes.map(({ event }) => event.path);
      this.compiler.watching.invalidate(filePaths);
    }
  }

  /**
   * Get performance statistics
   * @returns {Promise<Object>} Performance stats
   */
  async getPerformanceStats() {
    if (!this.watcher) return null;

    const stats = await this.watcher.getStats();
    const simdLevel = this.watcher.getSimdLevel();

    return {
      simd_level: simdLevel,
      watched_directories: parseInt(stats.watched_directories),
      pending_events: stats.pending_events,
      total_events: parseInt(stats.total_events),
      dropped_events: parseInt(stats.dropped_events),
      buffer_utilization:
        stats.buffer_capacity > 0
          ? ((stats.pending_events / stats.buffer_capacity) * 100).toFixed(1) +
            '%'
          : '0%',
    };
  }
}

/**
 * Enhanced FileSystem implementation that fully replaces webpack's default watcher
 * Implements the complete webpack watchFileSystem interface
 */
class RetriggerFileSystem {
  constructor(originalFs, plugin, options) {
    this.originalFs = originalFs;
    this.plugin = plugin;
    this.options = options;
    this.watchers = new Map();
    this.watcherCounter = 0;
  }

  /**
   * Main watch method that webpack calls
   * Fully implements webpack's FileSystemWatcher interface
   */
  watch(files, dirs, missing, startTime, options, callback, callbackUndelayed) {
    const watcherId = ++this.watcherCounter;

    if (this.options.verbose) {
      console.log(
        `[Retrigger] FileSystem.watch() #${watcherId} - Files: ${files.length}, Dirs: ${dirs.length}, Missing: ${missing.length}`
      );
    }

    // Create a comprehensive watcher that handles all webpack requirements
    const watcher = new RetriggerWatcher({
      id: watcherId,
      files: new Set(files),
      directories: new Set(dirs),
      missing: new Set(missing),
      startTime,
      options,
      callback,
      callbackUndelayed,
      plugin: this.plugin,
      verbose: this.options.verbose,
    });

    this.watchers.set(watcherId, watcher);

    // Initialize the watcher
    watcher.initialize().catch((error) => {
      if (this.options.verbose) {
        console.error(
          `[Retrigger] Failed to initialize watcher #${watcherId}:`,
          error
        );
      }
      // Fallback to original file system on error
      this.originalFs.watch(
        files,
        dirs,
        missing,
        startTime,
        options,
        callback,
        callbackUndelayed
      );
    });

    // Return watcher with close method
    return {
      close: () => {
        watcher.close();
        this.watchers.delete(watcherId);
      },
      pause: () => watcher.pause(),
      getContextTimeInfoEntries: () => watcher.getContextTimeInfoEntries(),
      getFileTimeInfoEntries: () => watcher.getFileTimeInfoEntries(),
      getInfo: () => watcher.getInfo(),
    };
  }
}

/**
 * Individual watcher instance that handles a specific watch request
 * Implements webpack's watcher interface completely
 */
class RetriggerWatcher {
  constructor(config) {
    this.id = config.id;
    this.files = config.files;
    this.directories = config.directories;
    this.missing = config.missing;
    this.startTime = config.startTime;
    this.options = config.options;
    this.callback = config.callback;
    this.callbackUndelayed = config.callbackUndelayed;
    this.plugin = config.plugin;
    this.verbose = config.verbose;

    this.watcher = null;
    this.isActive = true;
    this.isPaused = false;
    this.fileTimeInfoEntries = new Map();
    this.contextTimeInfoEntries = new Map();
    this.removedFiles = new Set();
    this.changedFiles = new Set();
    this.eventBuffer = [];
    this.processingTimeout = null;
  }

  async initialize() {
    if (!this.plugin.watcher) {
      throw new Error('Retrigger watcher not initialized');
    }

    // Use the plugin's existing watcher
    this.watcher = this.plugin.watcher;

    // Set up event handling for this specific watcher
    this.watcher.on('file-changed', (event) => {
      this.handleFileEvent(event);
    });

    if (this.verbose) {
      console.log(`[Retrigger] Watcher #${this.id} initialized successfully`);
    }
  }

  handleFileEvent(event) {
    if (!this.isActive || this.isPaused) return;

    const eventPath = path.resolve(event.path);
    const isRelevant = this.isRelevantFile(eventPath);

    if (!isRelevant) return;

    // Update time info
    const timestamp = parseInt(event.timestamp) / 1000000; // Convert nanoseconds to milliseconds

    if (event.event_type === 'deleted') {
      this.removedFiles.add(eventPath);
      this.fileTimeInfoEntries.delete(eventPath);
    } else {
      this.changedFiles.add(eventPath);
      this.fileTimeInfoEntries.set(eventPath, {
        safeTime: timestamp,
        timestamp: timestamp,
      });
    }

    // Handle directory changes
    if (event.is_directory && this.directories.has(eventPath)) {
      this.contextTimeInfoEntries.set(eventPath, {
        safeTime: timestamp,
        timestamp: timestamp,
      });
    }

    // Handle missing files that are now created
    if (event.event_type === 'created' && this.missing.has(eventPath)) {
      this.missing.delete(eventPath);
      this.files.add(eventPath);
    }

    // Buffer events for batch processing
    this.eventBuffer.push({
      path: eventPath,
      type: event.event_type,
      timestamp,
      isDirectory: event.is_directory,
    });

    // Debounce the callback
    this.scheduleCallback();
  }

  isRelevantFile(filePath) {
    // Check if file is in our watch list
    if (this.files.has(filePath)) return true;

    // Check if file is within watched directories
    for (const dir of this.directories) {
      if (filePath.startsWith(dir + path.sep) || filePath === dir) {
        return true;
      }
    }

    // Check if file is in missing files list
    if (this.missing.has(filePath)) return true;

    return false;
  }

  scheduleCallback() {
    if (this.processingTimeout) {
      clearTimeout(this.processingTimeout);
    }

    this.processingTimeout = setTimeout(() => {
      this.processEvents();
    }, this.options.aggregateTimeout || 20);
  }

  processEvents() {
    if (!this.isActive || this.eventBuffer.length === 0) return;

    const changes = this.eventBuffer.slice();
    this.eventBuffer = [];

    const removedFiles = Array.from(this.removedFiles);
    const changedFiles = Array.from(this.changedFiles);

    // Clear change sets
    this.removedFiles.clear();
    this.changedFiles.clear();

    if (this.verbose) {
      console.log(
        `[Retrigger] Watcher #${this.id} processing ${changes.length} events - Changed: ${changedFiles.length}, Removed: ${removedFiles.length}`
      );
    }

    // Update plugin performance metrics
    this.plugin.performanceMetrics.eventsProcessed += changes.length;
    this.plugin.performanceMetrics.lastEventBatch = changes.length;

    // Call webpack's callback with changes
    const aggregatedChanges = {
      changedFiles,
      removedFiles,
      changes,
      startTime: this.startTime,
    };

    // Call immediate callback if provided
    if (this.callbackUndelayed) {
      try {
        this.callbackUndelayed(null, aggregatedChanges);
      } catch (error) {
        console.error('[Retrigger] Error in undelayed callback:', error);
      }
    }

    // Call main callback
    if (this.callback) {
      try {
        this.callback(null, aggregatedChanges);
      } catch (error) {
        console.error('[Retrigger] Error in main callback:', error);
      }
    }
  }

  pause() {
    this.isPaused = true;
    if (this.verbose) {
      console.log(`[Retrigger] Watcher #${this.id} paused`);
    }
  }

  resume() {
    this.isPaused = false;
    if (this.verbose) {
      console.log(`[Retrigger] Watcher #${this.id} resumed`);
    }
  }

  close() {
    this.isActive = false;

    if (this.processingTimeout) {
      clearTimeout(this.processingTimeout);
      this.processingTimeout = null;
    }

    // Process any remaining events
    if (this.eventBuffer.length > 0) {
      this.processEvents();
    }

    if (this.verbose) {
      console.log(`[Retrigger] Watcher #${this.id} closed`);
    }
  }

  getFileTimeInfoEntries() {
    return this.fileTimeInfoEntries;
  }

  getContextTimeInfoEntries() {
    return this.contextTimeInfoEntries;
  }

  getInfo() {
    return {
      changes: this.eventBuffer.length,
      changedFiles: this.changedFiles.size,
      removedFiles: this.removedFiles.size,
    };
  }
}

module.exports = RetriggerWebpackPlugin;
