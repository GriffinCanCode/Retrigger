/**
 * Retrigger Vite Plugin - Enhanced with Advanced HMR Integration
 * Integrates Retrigger with Vite's HMR system for ultra-fast hot reloading
 * 
 * Features:
 * - Advanced HMR with intelligent module invalidation
 * - Source map support for accurate debugging
 * - SharedArrayBuffer communication for sub-millisecond updates
 * - Performance optimization and monitoring
 */

const path = require('path');

// Lazy load to avoid circular dependencies
function getCreateRetrigger() {
  return require('../index').createRetrigger;
}

function getSharedBufferCommunicator() {
  return require('../src-js/shared-buffer').SharedBufferCommunicator;
}

function getHMRManager() {
  return require('../src-js/hmr-integration').HMRManager;
}

/**
 * Create Retrigger Vite plugin
 * @param {Object} options - Plugin options
 * @returns {Object} Vite plugin
 */
function createRetriggerVitePlugin(options = {}) {
  const pluginOptions = {
    watchPaths: options.watchPaths || [],
    watchOptions: {
      recursive: true,
      exclude_patterns: [
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
        '**/build/**',
        '**/.vite/**',
        '**/*.log',
        '**/.*',
        ...((options.watchOptions && options.watchOptions.exclude_patterns) || []),
      ],
      include_patterns: options.watchOptions && options.watchOptions.include_patterns,
      enable_hashing: options.watchOptions?.enable_hashing ?? true,
      hash_block_size: options.watchOptions?.hash_block_size || 4096,
      ...options.watchOptions,
    },
    verbose: options.verbose || false,
    debounceMs: options.debounceMs || 10, // Lower debounce for Vite
    enableSourceMapUpdate: options.enableSourceMapUpdate !== false,
    useSharedBuffer: options.useSharedBuffer !== false,
    sharedBufferSize: options.sharedBufferSize || 1024 * 1024, // 1MB for Vite
    enableAdvancedHMR: options.enableAdvancedHMR !== false,
    hmrInvalidationStrategy: options.hmrInvalidationStrategy || 'smart',
    enableNativeWatching: options.enableNativeWatching !== false,
  };

  let watcher = null;
  let viteServer = null;
  let isWatching = false;
  let changeBuffer = new Map();
  let debounceTimer = null;
  let sharedComm = null;
  let hmrManager = null;
  let performanceMetrics = {
    hmrUpdates: 0,
    fullReloads: 0,
    averageUpdateTime: 0,
    lastUpdateTime: 0,
  };

  return {
    name: 'retrigger',
    
    // Configure development server
    configureServer(server) {
      viteServer = server;
      
      if (pluginOptions.verbose) {
        console.log('[Retrigger] Configuring enhanced Vite server with advanced HMR');
      }

      // Initialize SharedArrayBuffer communication
      if (pluginOptions.useSharedBuffer) {
        const SharedBufferCommunicator = getSharedBufferCommunicator();
        sharedComm = new SharedBufferCommunicator(pluginOptions.sharedBufferSize);
      }

      // Initialize advanced HMR manager
      if (pluginOptions.enableAdvancedHMR) {
        const HMRManager = getHMRManager();
        hmrManager = new HMRManager({
          enableSourceMaps: pluginOptions.enableSourceMapUpdate,
          invalidationStrategy: pluginOptions.hmrInvalidationStrategy,
          verbose: pluginOptions.verbose,
        });
      }

      // Enhanced stats endpoint with HMR metrics
      server.middlewares.use('/__retrigger_stats', async (req, res, next) => {
        if (req.method === 'GET') {
          if (watcher) {
            const stats = await getPerformanceStats();
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(stats, null, 2));
          } else {
            res.statusCode = 503;
            res.end('Retrigger not initialized');
          }
        } else {
          next();
        }
      });

      // HMR performance endpoint
      server.middlewares.use('/__retrigger_hmr_stats', async (req, res, next) => {
        if (req.method === 'GET') {
          const hmrStats = hmrManager ? hmrManager.getPerformanceStats() : null;
          const combinedStats = {
            performance: performanceMetrics,
            hmr: hmrStats,
            sharedBuffer: sharedComm ? sharedComm.getStats() : null,
          };
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(combinedStats, null, 2));
        } else {
          next();
        }
      });
    },

    // Build start hook
    async buildStart() {
      if (viteServer && !isWatching) {
        await startWatching();
      }
    },

    // Build end hook
    buildEnd() {
      if (!viteServer) {
        stopWatching();
      }
    },

    // Close hook
    closeWatcher() {
      stopWatching();
    },
  };

  /**
   * Start file watching with enhanced HMR integration
   */
  async function startWatching() {
    if (isWatching || !viteServer) return;

    // Skip native watching if disabled
    if (!pluginOptions.enableNativeWatching) {
      if (pluginOptions.verbose) {
        console.log('[Retrigger] Native watching disabled, using Vite default watching');
      }
      isWatching = true;
      return;
    }

    try {
      const createRetrigger = getCreateRetrigger();
      watcher = createRetrigger();
      isWatching = true;

      // Initialize SharedArrayBuffer communication
      if (sharedComm) {
        await sharedComm.initializeAsMain();
        
        sharedComm.on('file-event', async (event) => {
          await handleSharedBufferEvent(event);
        });
      }

      // Initialize HMR manager
      if (hmrManager) {
        await hmrManager.initialize('vite', viteServer);
        
        hmrManager.on('update-complete', (result) => {
          performanceMetrics.hmrUpdates++;
          performanceMetrics.lastUpdateTime = Date.now();
        });

        hmrManager.on('full-reload', (result) => {
          performanceMetrics.fullReloads++;
        });
      }

      // Determine paths to watch
      const watchPaths = getWatchPaths();
      
      if (pluginOptions.verbose) {
        console.log(`[Retrigger] Enhanced Vite plugin watching ${watchPaths.length} directories:`);
        watchPaths.forEach(p => console.log(`  - ${p}`));
      }

      // Watch directories
      for (const watchPath of watchPaths) {
        await watcher.watch(watchPath, pluginOptions.watchOptions);
      }

      // Set up event handlers
      setupEventHandlers();

      // Start watching
      await watcher.start();

      if (pluginOptions.verbose) {
        const stats = await watcher.getStats();
        const simdLevel = watcher.getSimdLevel();
        console.log(`[Retrigger] Enhanced Vite integration started with SIMD: ${simdLevel}`);
        console.log(`[Retrigger] Watching ${stats.watched_directories} directories`);
        console.log(`[Retrigger] Advanced HMR: ${hmrManager ? 'enabled' : 'disabled'}`);
        console.log(`[Retrigger] SharedArrayBuffer: ${sharedComm ? 'enabled' : 'disabled'}`);
      }

    } catch (error) {
      console.error('[Retrigger] Failed to start enhanced Vite watching:', error);
      isWatching = false;
      throw error;
    }
  }

  /**
   * Stop file watching and cleanup resources
   */
  function stopWatching() {
    if (watcher && isWatching) {
      watcher.stop();
      watcher = null;
      isWatching = false;
      
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }

      // Cleanup SharedArrayBuffer communication
      if (sharedComm) {
        sharedComm.destroy();
        sharedComm = null;
      }

      // Cleanup HMR manager
      if (hmrManager) {
        hmrManager.destroy();
        hmrManager = null;
      }
      
      if (pluginOptions.verbose) {
        console.log('[Retrigger] Stopped enhanced Vite watching and cleaned up resources');
      }
    }
  }

  /**
   * Get directories to watch
   * @returns {string[]} Array of paths to watch
   */
  function getWatchPaths() {
    const paths = new Set();
    
    // Add explicitly configured paths
    pluginOptions.watchPaths.forEach(p => paths.add(path.resolve(p)));
    
    // Add Vite root
    if (viteServer.config.root) {
      paths.add(path.resolve(viteServer.config.root));
    }
    
    // Add source directories from Vite config
    if (viteServer.config.build?.rollupOptions?.input) {
      const inputs = viteServer.config.build.rollupOptions.input;
      const inputArray = Array.isArray(inputs) ? inputs : Object.values(inputs);
      
      inputArray.forEach(input => {
        if (typeof input === 'string') {
          paths.add(path.dirname(path.resolve(input)));
        }
      });
    }
    
    // Default to current working directory
    if (paths.size === 0) {
      paths.add(process.cwd());
    }
    
    return Array.from(paths);
  }

  /**
   * Set up file change event handlers
   */
  function setupEventHandlers() {
    // Handle file changes
    watcher.on('file-changed', (event) => {
      handleFileChange(event);
    });

    // Handle errors
    watcher.on('error', (error) => {
      console.error('[Retrigger] Vite watcher error:', error);
    });

    // Log stats periodically
    if (pluginOptions.verbose) {
      watcher.on('stats', (stats) => {
        console.log(`[Retrigger] Vite stats - Pending: ${stats.pending_events}`);
      });
    }
  }

  /**
   * Handle file change events with optimized HMR processing
   * @param {Object} event - File change event
   */
  async function handleFileChange(event) {
    if (!viteServer || event.is_directory) return;

    // Quick filter check (optimized for speed)
    if (!shouldProcessFile(event.path)) {
      return;
    }

    // Fast path: Direct HMR without complex processing chains
    if (hmrManager && pluginOptions.enableAdvancedHMR) {
      try {
        // Skip performance tracking in hot path for better responsiveness
        const updateResult = await hmrManager.processFileChange(event);
        
        // Update metrics asynchronously to avoid blocking
        setImmediate(() => {
          performanceMetrics.hmrUpdates++;
          performanceMetrics.lastUpdateTime = Date.now();
        });

        // Only log in verbose mode and don't block on it
        if (pluginOptions.verbose && updateResult.type === 'hmr-update') {
          setImmediate(() => {
            console.log(`[Retrigger] HMR update for ${event.path} (${updateResult.affectedModules.length} modules)`);
          });
        }

        return;
      } catch (error) {
        // Async error logging to avoid blocking
        if (pluginOptions.verbose) {
          setImmediate(() => {
            console.error('[Retrigger] Advanced HMR failed, using fallback:', error.message);
          });
        }
        // Fall through to standard HMR
      }
    }

    // Optimized standard HMR path
    const normalizedPath = path.relative(viteServer.config.root, event.path);
    const module = viteServer.moduleGraph.getModuleById(normalizedPath);
    
    if (module) {
      // Direct invalidation without complex batching
      viteServer.moduleGraph.invalidateModule(module);
      
      // Send HMR update immediately for better responsiveness
      const updateType = event.path.endsWith('.css') ? 'css-update' : 'js-update';
      
      viteServer.ws.send({
        type: 'update',
        updates: [{
          type: updateType,
          path: normalizedPath,
          acceptedPath: normalizedPath,
          timestamp: Date.now(),
        }],
      });

      // Update metrics asynchronously
      setImmediate(() => {
        performanceMetrics.hmrUpdates++;
      });
    } else {
      // Full reload fallback
      viteServer.ws.send({ type: 'full-reload' });
      setImmediate(() => {
        performanceMetrics.fullReloads++;
      });
    }
  }

  /**
   * Handle events from SharedArrayBuffer (ultra-fast path)
   * @param {Object} event - File system event from shared buffer
   */
  async function handleSharedBufferEvent(event) {
    if (!shouldProcessFile(event.path)) return;

    // Ultra-fast path: Skip all intermediate processing
    const normalizedPath = path.relative(viteServer.config.root, event.path);
    const module = viteServer.moduleGraph.getModuleById(normalizedPath);
    
    if (module) {
      // Immediate invalidation and update
      viteServer.moduleGraph.invalidateModule(module);
      
      viteServer.ws.send({
        type: 'update',
        updates: [{
          type: event.path.endsWith('.css') ? 'css-update' : 'js-update',
          path: normalizedPath,
          acceptedPath: normalizedPath,
          timestamp: Date.now(),
        }],
      });
    } else {
      // Immediate full reload
      viteServer.ws.send({ type: 'full-reload' });
    }
  }

  /**
   * Trigger immediate HMR update without debouncing
   * @param {Object} event - File change event
   */
  async function triggerImmediateHMR(event) {
    if (!viteServer.ws) return;

    try {
      const normalizedPath = path.relative(viteServer.config.root, event.path);
      const module = viteServer.moduleGraph.getModuleById(normalizedPath);
      
      if (module) {
        // Invalidate module
        viteServer.moduleGraph.invalidateModule(module);
        
        // Send immediate HMR update
        viteServer.ws.send({
          type: 'update',
          updates: [{
            type: event.path.endsWith('.css') ? 'css-update' : 'js-update',
            path: normalizedPath,
            acceptedPath: normalizedPath,
            timestamp: Date.now(),
          }],
        });

        performanceMetrics.hmrUpdates++;
      }
    } catch (error) {
      console.error('[Retrigger] Immediate HMR failed:', error);
    }
  }

  /**
   * Check if file should trigger HMR
   * @param {string} filePath - File path
   * @returns {boolean} Whether to process file
   */
  function shouldProcessFile(filePath) {
    // Vite handles these file types well
    const supportedExtensions = [
      '.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte',
      '.css', '.scss', '.sass', '.less', '.styl',
      '.html', '.json', '.md',
    ];

    // Skip non-source files
    const skipPatterns = [
      /node_modules/,
      /\.git/,
      /dist/,
      /build/,
      /\.vite/,
      /\.temp/,
      /coverage/,
    ];

    const ext = path.extname(filePath);
    
    // Check if supported extension
    if (!supportedExtensions.includes(ext)) {
      return false;
    }

    // Check skip patterns
    if (skipPatterns.some(pattern => pattern.test(filePath))) {
      return false;
    }

    return true;
  }

  /**
   * Trigger Vite HMR
   */
  function triggerHMR() {
    if (!viteServer.ws || changeBuffer.size === 0) {
      return;
    }

    const changes = Array.from(changeBuffer.values());
    changeBuffer.clear();

    if (pluginOptions.verbose) {
      console.log(`[Retrigger] Triggering Vite HMR for ${changes.length} changes`);
    }

    // Process each changed file
    changes.forEach(({ event }) => {
      const filePath = event.path;
      
      try {
        // Normalize path for Vite
        const normalizedPath = path.relative(viteServer.config.root, filePath);
        
        // Get module graph node
        const module = viteServer.moduleGraph.getModuleById(normalizedPath);
        
        if (module) {
          // Invalidate module
          viteServer.moduleGraph.invalidateModule(module);
          
          // Send HMR update
          if (event.event_type === 'deleted') {
            // Handle file deletion
            viteServer.ws.send({
              type: 'prune',
              paths: [normalizedPath],
            });
          } else {
            // Handle file modification/creation
            viteServer.ws.send({
              type: 'update',
              updates: [{
                type: 'js-update',
                path: normalizedPath,
                acceptedPath: normalizedPath,
                timestamp: Date.now(),
              }],
            });
          }
          
          if (pluginOptions.verbose) {
            console.log(`[Retrigger] HMR update sent for: ${normalizedPath}`);
          }
        } else {
          // File not in module graph, trigger full reload
          viteServer.ws.send({
            type: 'full-reload',
          });
          
          if (pluginOptions.verbose) {
            console.log(`[Retrigger] Full reload triggered for: ${normalizedPath}`);
          }
        }
      } catch (error) {
        console.error(`[Retrigger] Error processing HMR for ${filePath}:`, error);
      }
    });
  }

  /**
   * Get comprehensive performance statistics
   * @returns {Promise<Object>} Performance stats
   */
  async function getPerformanceStats() {
    if (!watcher) return null;

    const stats = await watcher.getStats();
    const simdLevel = watcher.getSimdLevel();
    const hmrStats = hmrManager ? hmrManager.getPerformanceStats() : null;
    const sharedBufferStats = sharedComm ? sharedComm.getStats() : null;

    return {
      plugin: 'Retrigger Enhanced Vite Plugin',
      version: '2.0.0',
      simd_level: simdLevel,
      watched_directories: parseInt(stats.watched_directories),
      pending_events: stats.pending_events,
      total_events: parseInt(stats.total_events),
      dropped_events: parseInt(stats.dropped_events),
      
      // HMR Statistics
      hmr: {
        enabled: !!hmrManager,
        updates: performanceMetrics.hmrUpdates,
        full_reloads: performanceMetrics.fullReloads,
        average_update_time_ms: performanceMetrics.averageUpdateTime,
        last_update: performanceMetrics.lastUpdateTime,
        advanced_stats: hmrStats,
      },

      // SharedArrayBuffer Statistics
      shared_buffer: {
        enabled: !!sharedComm,
        stats: sharedBufferStats,
      },

      // Plugin Configuration
      config: {
        debounce_ms: pluginOptions.debounceMs,
        source_maps_enabled: pluginOptions.enableSourceMapUpdate,
        advanced_hmr_enabled: pluginOptions.enableAdvancedHMR,
        invalidation_strategy: pluginOptions.hmrInvalidationStrategy,
      },

      // Buffer State
      change_buffer_size: changeBuffer.size,
      is_watching: isWatching,
      
      // Performance Metrics
      performance: {
        memory_usage: process.memoryUsage(),
        uptime: process.uptime(),
        timestamp: Date.now(),
      },
    };
  }
}

module.exports = { createRetriggerVitePlugin };
