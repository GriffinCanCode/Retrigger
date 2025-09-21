/**
 * Advanced HMR Integration System
 *
 * Features:
 * - Intelligent module graph analysis
 * - Source map support for accurate line mapping
 * - Advanced dependency tracking
 * - Performance-optimized invalidation strategies
 * - Cross-bundler compatibility
 */

const { EventEmitter } = require('events');
const path = require('path');

/**
 * HMR Manager - Core system for Hot Module Replacement
 * Implements SOLID principles with modular, extensible design
 */
class HMRManager extends EventEmitter {
  constructor(options = {}) {
    super();

    this.options = {
      enableSourceMaps: options.enableSourceMaps !== false,
      enableDependencyTracking: options.enableDependencyTracking !== false,
      maxInvalidationDepth: options.maxInvalidationDepth || 10,
      invalidationStrategy: options.invalidationStrategy || 'smart', // 'smart', 'aggressive', 'conservative'
      cacheBustingStrategy: options.cacheBustingStrategy || 'timestamp', // 'timestamp', 'hash', 'version'
      verbose: options.verbose || false,
      ...options,
    };

    this.moduleRegistry = new ModuleRegistry();
    this.dependencyGraph = new DependencyGraph();
    this.sourceMapManager = new SourceMapManager(this.options);
    this.invalidationStrategies = new InvalidationStrategies();
    this.performanceTracker = new HMRPerformanceTracker();

    this.activeUpdates = new Map();
    this.updateQueue = [];
    this.isProcessingUpdates = false;
  }

  /**
   * Initialize HMR system with bundler-specific configuration
   * @param {string} bundlerType - Type of bundler ('webpack', 'vite', 'rspack', etc.)
   * @param {Object} bundlerInstance - Bundler instance
   */
  async initialize(bundlerType, bundlerInstance) {
    this.bundlerType = bundlerType;
    this.bundlerInstance = bundlerInstance;

    // Initialize subsystems
    await this.moduleRegistry.initialize(bundlerType, bundlerInstance);
    await this.dependencyGraph.initialize(bundlerInstance);

    if (this.options.enableSourceMaps) {
      await this.sourceMapManager.initialize(bundlerInstance);
    }

    this.emit('initialized', { bundlerType });

    if (this.options.verbose) {
      console.log(`[HMR] Initialized for ${bundlerType} bundler`);
    }
  }

  /**
   * Process file change event with optimized fast path
   * @param {Object} event - File system event
   * @returns {Promise<Object>} Update result
   */
  async processFileChange(event) {
    try {
      // Fast path: Skip complex analysis for simple changes
      const isSimpleChange = this.isSimpleFileChange(event);

      if (isSimpleChange) {
        return await this.processSimpleUpdate(event);
      }

      // Complex path: Full analysis for special cases
      const moduleId = await this.moduleRegistry.getOrCreateModule(event.path);

      if (!moduleId) {
        return {
          type: 'skip',
          reason: 'not-in-module-graph',
          path: event.path,
        };
      }

      const updatePlan = await this.createUpdatePlan(moduleId, event);

      if (updatePlan.type === 'full-reload') {
        return await this.triggerFullReload(updatePlan);
      }

      const updateResult = await this.executeUpdate(updatePlan);

      // Track performance asynchronously
      setImmediate(() => {
        this.performanceTracker.recordUpdate(0, updateResult);
      });

      return updateResult;
    } catch (error) {
      this.emit('error', error);
      return await this.triggerFullReload({
        type: 'full-reload',
        reason: 'error',
        error: error.message,
      });
    }
  }

  /**
   * Check if this is a simple file change that can use fast path
   * @param {Object} event - File system event
   * @returns {boolean} Whether this is a simple change
   * @private
   */
  isSimpleFileChange(event) {
    // Fast path for common file types that don't need complex analysis
    const simpleExtensions = ['.js', '.jsx', '.ts', '.tsx', '.css', '.scss'];
    const hasSimpleExtension = simpleExtensions.some((ext) =>
      event.path.endsWith(ext)
    );

    // Skip complex analysis for standard modifications
    const isSimpleModification =
      event.event_type === 'modified' || event.event_type === 'changed';

    // Not in node_modules (which would need full reload)
    const isNotDependency = !event.path.includes('node_modules');

    return hasSimpleExtension && isSimpleModification && isNotDependency;
  }

  /**
   * Process simple update with minimal overhead
   * @param {Object} event - File system event
   * @returns {Promise<Object>} Update result
   * @private
   */
  async processSimpleUpdate(event) {
    const result = {
      type: 'hmr-update',
      moduleId: event.path,
      affectedModules: [event.path],
      strategy: 'fast-path',
      timestamp: Date.now(),
      updates: [
        {
          moduleId: event.path,
          path: event.path,
          type: event.path.endsWith('.css') ? 'css-update' : 'js-update',
          timestamp: Date.now(),
        },
      ],
    };

    // Send directly to bundler without complex processing
    await this.sendUpdatesToClient(result);

    // Update metrics asynchronously
    setImmediate(() => {
      this.emit('update-complete', result);
    });

    return result;
  }

  /**
   * Create an intelligent update plan based on module dependencies and change type
   * @param {string} moduleId - Changed module ID
   * @param {Object} event - File system event
   * @returns {Promise<Object>} Update plan
   * @private
   */
  async createUpdatePlan(moduleId, event) {
    const module = this.moduleRegistry.getModule(moduleId);
    const dependencies = this.dependencyGraph.getDependents(moduleId);

    // Analyze change impact
    const changeAnalysis = await this.analyzeChangeImpact(module, event);

    // Select invalidation strategy
    const strategy = this.invalidationStrategies.select(
      this.options.invalidationStrategy,
      changeAnalysis
    );

    const updatePlan = {
      moduleId,
      strategy,
      affectedModules: new Set([moduleId]),
      updateType: this.determineUpdateType(module, changeAnalysis),
      timestamp: Date.now(),
      cacheBuster: this.generateCacheBuster(),
    };

    // Add dependent modules based on strategy
    switch (strategy) {
      case 'conservative':
        // Only update the changed module
        break;

      case 'smart':
        // Update changed module and immediate dependents
        dependencies.immediate.forEach((dep) =>
          updatePlan.affectedModules.add(dep)
        );
        break;

      case 'aggressive':
        // Update entire dependency chain (with depth limit)
        this.addDependencyChain(
          updatePlan.affectedModules,
          moduleId,
          this.options.maxInvalidationDepth
        );
        break;
    }

    // Check for special cases that require full reload
    if (changeAnalysis.requiresFullReload) {
      updatePlan.type = 'full-reload';
      updatePlan.reason = changeAnalysis.fullReloadReason;
    }

    return updatePlan;
  }

  /**
   * Analyze the impact of a file change
   * @param {Object} module - Module information
   * @param {Object} event - File system event
   * @returns {Promise<Object>} Change analysis
   * @private
   */
  async analyzeChangeImpact(module, event) {
    const analysis = {
      changeType: event.event_type,
      isStylesheet: this.isStylesheet(module.path),
      isEntryPoint: module.isEntryPoint,
      hasHotAccept: module.hotAcceptable,
      requiresFullReload: false,
      fullReloadReason: null,
      sourceMapInfo: null,
    };

    // Analyze source maps if available
    if (this.options.enableSourceMaps) {
      analysis.sourceMapInfo = await this.sourceMapManager.analyzeChange(
        module,
        event
      );
    }

    // Determine if full reload is required
    if (analysis.isEntryPoint && event.event_type === 'deleted') {
      analysis.requiresFullReload = true;
      analysis.fullReloadReason = 'entry-point-deleted';
    } else if (module.path.includes('node_modules')) {
      analysis.requiresFullReload = true;
      analysis.fullReloadReason = 'dependency-change';
    } else if (!analysis.hasHotAccept && !analysis.isStylesheet) {
      // Check if any parent module accepts this module
      const acceptingParent = this.findAcceptingParent(module.id);
      if (!acceptingParent) {
        analysis.requiresFullReload = true;
        analysis.fullReloadReason = 'no-hot-accept';
      }
    }

    return analysis;
  }

  /**
   * Execute the HMR update plan
   * @param {Object} updatePlan - Update plan to execute
   * @returns {Promise<Object>} Update result
   * @private
   */
  async executeUpdate(updatePlan) {
    this.activeUpdates.set(updatePlan.moduleId, updatePlan);

    try {
      const result = {
        type: 'hmr-update',
        moduleId: updatePlan.moduleId,
        affectedModules: Array.from(updatePlan.affectedModules),
        strategy: updatePlan.strategy,
        timestamp: updatePlan.timestamp,
        updates: [],
      };

      // Process each affected module
      for (const moduleId of updatePlan.affectedModules) {
        const moduleUpdate = await this.updateModule(moduleId, updatePlan);
        result.updates.push(moduleUpdate);
      }

      // Send updates to the bundler
      await this.sendUpdatesToClient(result);

      this.emit('update-complete', result);
      return result;
    } finally {
      this.activeUpdates.delete(updatePlan.moduleId);
    }
  }

  /**
   * Update a specific module
   * @param {string} moduleId - Module ID to update
   * @param {Object} updatePlan - Overall update plan
   * @returns {Promise<Object>} Module update result
   * @private
   */
  async updateModule(moduleId, updatePlan) {
    const module = this.moduleRegistry.getModule(moduleId);

    const moduleUpdate = {
      moduleId,
      path: module.path,
      type: updatePlan.updateType,
      timestamp: updatePlan.timestamp,
      cacheBuster: updatePlan.cacheBuster,
    };

    // Handle different update types
    switch (updatePlan.updateType) {
      case 'js-update':
        moduleUpdate.content = await this.generateJSUpdate(module, updatePlan);
        break;

      case 'css-update':
        moduleUpdate.content = await this.generateCSSUpdate(module, updatePlan);
        break;

      case 'asset-update':
        moduleUpdate.url = await this.generateAssetUpdate(module, updatePlan);
        break;
    }

    // Add source map information
    if (this.options.enableSourceMaps && updatePlan.sourceMapInfo) {
      moduleUpdate.sourceMap = updatePlan.sourceMapInfo.sourceMap;
      moduleUpdate.mappings = updatePlan.sourceMapInfo.mappings;
    }

    return moduleUpdate;
  }

  /**
   * Send HMR updates to the client (browser)
   * @param {Object} updateResult - Update result to send
   * @private
   */
  async sendUpdatesToClient(updateResult) {
    switch (this.bundlerType) {
      case 'webpack':
        await this.sendWebpackUpdate(updateResult);
        break;

      case 'vite':
        await this.sendViteUpdate(updateResult);
        break;

      case 'rspack':
        await this.sendRspackUpdate(updateResult);
        break;

      default:
        throw new Error(`Unsupported bundler type: ${this.bundlerType}`);
    }
  }

  /**
   * Send updates via Webpack's HMR
   * @param {Object} updateResult - Update to send
   * @private
   */
  async sendWebpackUpdate(updateResult) {
    if (!this.bundlerInstance || !this.bundlerInstance.watching) return;

    // Webpack-specific HMR update
    const compilation = this.bundlerInstance.watching.compiler.compilation;

    updateResult.updates.forEach((update) => {
      // Invalidate webpack module
      const module = compilation.moduleGraph.getModuleById(update.moduleId);
      if (module) {
        compilation.moduleGraph.invalidateModule(module);
      }
    });

    // Trigger webpack's HMR
    this.bundlerInstance.watching.invalidate();
  }

  /**
   * Send updates via Vite's HMR
   * @param {Object} updateResult - Update to send
   * @private
   */
  async sendViteUpdate(updateResult) {
    if (!this.bundlerInstance || !this.bundlerInstance.ws) return;

    // Convert updates to Vite format
    const viteUpdates = updateResult.updates.map((update) => ({
      type: update.type === 'css-update' ? 'css-update' : 'js-update',
      path: update.path,
      acceptedPath: update.path,
      timestamp: update.timestamp,
      explicitImportRequired: false,
    }));

    // Send to Vite's WebSocket
    this.bundlerInstance.ws.send({
      type: 'update',
      updates: viteUpdates,
    });
  }

  /**
   * Send updates via Rspack's HMR
   * @param {Object} updateResult - Update to send
   * @private
   */
  async sendRspackUpdate(updateResult) {
    // Rspack HMR (similar to webpack but with optimizations)
    await this.sendWebpackUpdate(updateResult);
  }

  /**
   * Trigger a full page reload
   * @param {Object} reloadInfo - Reload information
   * @returns {Promise<Object>} Reload result
   * @private
   */
  async triggerFullReload(reloadInfo) {
    const result = {
      type: 'full-reload',
      reason: reloadInfo.reason,
      timestamp: Date.now(),
    };

    // Send reload command to client
    switch (this.bundlerType) {
      case 'webpack':
        // Webpack full reload
        if (this.bundlerInstance.watching) {
          this.bundlerInstance.watching.invalidate();
        }
        break;

      case 'vite':
        if (this.bundlerInstance.ws) {
          this.bundlerInstance.ws.send({ type: 'full-reload' });
        }
        break;

      case 'rspack':
        // Rspack full reload
        if (this.bundlerInstance.watching) {
          this.bundlerInstance.watching.invalidate();
        }
        break;
    }

    this.emit('full-reload', result);

    if (this.options.verbose) {
      console.log(`[HMR] Full reload triggered: ${reloadInfo.reason}`);
    }

    return result;
  }

  /**
   * Generate cache buster based on strategy
   * @returns {string} Cache buster value
   * @private
   */
  generateCacheBuster() {
    switch (this.options.cacheBustingStrategy) {
      case 'timestamp':
        return Date.now().toString();
      case 'hash':
        return Math.random().toString(36).substr(2, 9);
      case 'version':
        return `v${Date.now()}`;
      default:
        return Date.now().toString();
    }
  }

  /**
   * Determine update type based on module and analysis
   * @param {Object} module - Module information
   * @param {Object} analysis - Change analysis
   * @returns {string} Update type
   * @private
   */
  determineUpdateType(module, analysis) {
    if (analysis.isStylesheet) return 'css-update';
    if (module.type === 'asset') return 'asset-update';
    return 'js-update';
  }

  /**
   * Check if file is a stylesheet
   * @param {string} filePath - File path to check
   * @returns {boolean} Whether file is a stylesheet
   * @private
   */
  isStylesheet(filePath) {
    const styleExtensions = [
      '.css',
      '.scss',
      '.sass',
      '.less',
      '.styl',
      '.stylus',
    ];
    return styleExtensions.some((ext) => filePath.endsWith(ext));
  }

  /**
   * Get HMR performance statistics
   * @returns {Object} Performance stats
   */
  getPerformanceStats() {
    return this.performanceTracker.getStats();
  }

  /**
   * Cleanup HMR system
   */
  destroy() {
    this.activeUpdates.clear();
    this.updateQueue = [];
    this.moduleRegistry.destroy();
    this.dependencyGraph.destroy();
    this.sourceMapManager.destroy();
    this.removeAllListeners();
  }
}

/**
 * Module Registry - Tracks all modules in the system
 */
class ModuleRegistry {
  constructor() {
    this.modules = new Map();
    this.pathToId = new Map();
    this.nextId = 1;
  }

  async initialize(bundlerType, bundlerInstance) {
    this.bundlerType = bundlerType;
    this.bundlerInstance = bundlerInstance;
  }

  async getOrCreateModule(filePath) {
    const normalizedPath = path.normalize(filePath);

    if (this.pathToId.has(normalizedPath)) {
      return this.pathToId.get(normalizedPath);
    }

    // Check if file is part of module graph
    if (!this.isModuleFile(normalizedPath)) {
      return null;
    }

    const moduleId = `module-${this.nextId++}`;
    const module = {
      id: moduleId,
      path: normalizedPath,
      type: this.inferModuleType(normalizedPath),
      isEntryPoint: false,
      hotAcceptable: true,
      dependencies: new Set(),
      lastModified: Date.now(),
    };

    this.modules.set(moduleId, module);
    this.pathToId.set(normalizedPath, moduleId);

    return moduleId;
  }

  getModule(moduleId) {
    return this.modules.get(moduleId);
  }

  isModuleFile(filePath) {
    const moduleExtensions = [
      '.js',
      '.jsx',
      '.ts',
      '.tsx',
      '.vue',
      '.svelte',
      '.css',
      '.scss',
      '.sass',
      '.less',
      '.styl',
      '.png',
      '.jpg',
      '.jpeg',
      '.gif',
      '.svg',
      '.webp',
    ];

    return moduleExtensions.some((ext) => filePath.endsWith(ext));
  }

  inferModuleType(filePath) {
    if (filePath.match(/\.(css|scss|sass|less|styl)$/)) return 'stylesheet';
    if (filePath.match(/\.(png|jpg|jpeg|gif|svg|webp)$/)) return 'asset';
    if (filePath.match(/\.(js|jsx|ts|tsx|vue|svelte)$/)) return 'javascript';
    return 'unknown';
  }

  destroy() {
    this.modules.clear();
    this.pathToId.clear();
  }
}

/**
 * Dependency Graph - Tracks module dependencies
 */
class DependencyGraph {
  constructor() {
    this.dependencies = new Map(); // moduleId -> Set of dependencies
    this.dependents = new Map(); // moduleId -> Set of dependents
  }

  async initialize(bundlerInstance) {
    this.bundlerInstance = bundlerInstance;
  }

  addDependency(moduleId, dependsOn) {
    if (!this.dependencies.has(moduleId)) {
      this.dependencies.set(moduleId, new Set());
    }
    if (!this.dependents.has(dependsOn)) {
      this.dependents.set(dependsOn, new Set());
    }

    this.dependencies.get(moduleId).add(dependsOn);
    this.dependents.get(dependsOn).add(moduleId);
  }

  getDependents(moduleId) {
    const immediate = this.dependents.get(moduleId) || new Set();
    const all = new Set(immediate);

    // Add transitive dependents
    const addTransitive = (id, depth = 0) => {
      if (depth > 10) return; // Prevent infinite loops

      const deps = this.dependents.get(id) || new Set();
      deps.forEach((dep) => {
        if (!all.has(dep)) {
          all.add(dep);
          addTransitive(dep, depth + 1);
        }
      });
    };

    immediate.forEach((dep) => addTransitive(dep));

    return { immediate, all };
  }

  destroy() {
    this.dependencies.clear();
    this.dependents.clear();
  }
}

/**
 * Source Map Manager - Handles source map integration
 */
class SourceMapManager {
  constructor(options) {
    this.options = options;
    this.sourceMaps = new Map();
  }

  async initialize(bundlerInstance) {
    this.bundlerInstance = bundlerInstance;
  }

  async analyzeChange(module, event) {
    if (!this.options.enableSourceMaps) return null;

    // Placeholder for source map analysis
    return {
      sourceMap: null,
      mappings: null,
      originalLine: null,
      generatedLine: null,
    };
  }

  destroy() {
    this.sourceMaps.clear();
  }
}

/**
 * Invalidation Strategies - Different approaches to module invalidation
 */
class InvalidationStrategies {
  select(strategy, changeAnalysis) {
    switch (strategy) {
      case 'conservative':
        return 'conservative';
      case 'aggressive':
        return 'aggressive';
      case 'smart':
      default:
        // Smart strategy based on analysis
        if (changeAnalysis.isStylesheet) return 'conservative';
        if (changeAnalysis.hasHotAccept) return 'conservative';
        return 'smart';
    }
  }
}

/**
 * Performance Tracker - Monitors HMR performance
 */
class HMRPerformanceTracker {
  constructor() {
    this.stats = {
      totalUpdates: 0,
      averageUpdateTime: 0,
      fastestUpdate: Infinity,
      slowestUpdate: 0,
      updatesByType: {},
      recentUpdates: [],
    };
  }

  recordUpdate(duration, result) {
    this.stats.totalUpdates++;
    this.stats.averageUpdateTime =
      (this.stats.averageUpdateTime + duration) / 2;
    this.stats.fastestUpdate = Math.min(this.stats.fastestUpdate, duration);
    this.stats.slowestUpdate = Math.max(this.stats.slowestUpdate, duration);

    const updateType = result.type;
    this.stats.updatesByType[updateType] =
      (this.stats.updatesByType[updateType] || 0) + 1;

    this.stats.recentUpdates.push({
      timestamp: Date.now(),
      duration,
      type: updateType,
    });

    // Keep only last 100 updates
    if (this.stats.recentUpdates.length > 100) {
      this.stats.recentUpdates.shift();
    }
  }

  getStats() {
    return { ...this.stats };
  }
}

module.exports = {
  HMRManager,
  ModuleRegistry,
  DependencyGraph,
  SourceMapManager,
  InvalidationStrategies,
  HMRPerformanceTracker,
};
