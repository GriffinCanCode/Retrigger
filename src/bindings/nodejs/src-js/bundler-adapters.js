/**
 * Bundler Adapters - Unified interfaces for webpack, Rspack, and Turbopack
 * 
 * Implements SOLID principles with elegant, modular design:
 * - Single Responsibility: Each adapter handles one bundler type
 * - Open/Closed: Easy to extend with new bundlers
 * - Liskov Substitution: All adapters implement the same interface
 * - Interface Segregation: Separate interfaces for different concerns
 * - Dependency Inversion: Abstractions over concrete implementations
 */

const { EventEmitter } = require('events');
const path = require('path');

/**
 * Abstract base class defining the bundler interface
 * Implements Interface Segregation Principle
 */
class BundlerAdapter extends EventEmitter {
  constructor(config = {}) {
    super();
    
    if (new.target === BundlerAdapter) {
      throw new Error('Cannot instantiate abstract BundlerAdapter class');
    }

    this.config = config;
    this.isWatching = false;
    this.compiler = null;
    this.watcher = null;
  }

  /**
   * Abstract methods that must be implemented by subclasses
   */
  
  /** Initialize the bundler with configuration */
  async initialize() {
    throw new Error('Method initialize() must be implemented');
  }

  /** Start the bundler in build mode */
  async build() {
    throw new Error('Method build() must be implemented');
  }

  /** Start the bundler in watch mode */
  async watch() {
    throw new Error('Method watch() must be implemented');
  }

  /** Stop watching and cleanup */
  stop() {
    throw new Error('Method stop() must be implemented');
  }

  /** Get bundler-specific performance stats */
  getStats() {
    throw new Error('Method getStats() must be implemented');
  }

  /** Invalidate specific files/modules */
  invalidate(files) {
    throw new Error('Method invalidate() must be implemented');
  }

  /** Get the bundler type identifier */
  getType() {
    throw new Error('Method getType() must be implemented');
  }

  /**
   * Common helper methods available to all adapters
   */

  /**
   * Normalize file paths for cross-platform compatibility
   * @param {string} filePath - Input file path
   * @returns {string} Normalized path
   * @protected
   */
  _normalizePath(filePath) {
    return path.normalize(filePath).replace(/\\/g, '/');
  }

  /**
   * Check if a file should trigger bundler recompilation
   * @param {string} filePath - File to check
   * @returns {boolean} Whether file should trigger rebuild
   * @protected
   */
  _shouldProcessFile(filePath) {
    const skipPatterns = [
      /node_modules/,
      /\.git/,
      /dist/,
      /build/,
      /coverage/,
      /\.log$/,
      /\.lock$/,
      /\.tmp$/,
      /\.swp$/,
      /\.DS_Store$/,
    ];

    const normalizedPath = this._normalizePath(filePath);
    return !skipPatterns.some(pattern => pattern.test(normalizedPath));
  }

  /**
   * Get common bundler statistics
   * @returns {Object} Base stats object
   * @protected
   */
  _getBaseStats() {
    return {
      type: this.getType(),
      isWatching: this.isWatching,
      timestamp: Date.now(),
      version: this._getBundlerVersion(),
    };
  }

  /**
   * Get bundler version (to be overridden by subclasses)
   * @returns {string} Version string
   * @protected
   */
  _getBundlerVersion() {
    return 'unknown';
  }
}

/**
 * Webpack 5+ Adapter with advanced integration
 * Implements Single Responsibility Principle
 */
class WebpackAdapter extends BundlerAdapter {
  constructor(config = {}) {
    super(config);
    this.webpack = null;
    this.watching = null;
    this.fileSystemWatcher = null;
  }

  async initialize() {
    try {
      // Check if webpack is already available (we're running inside webpack)
      if (typeof __webpack_require__ !== 'undefined') {
        // We're running inside webpack, use the existing compiler
        this.webpack = null; // Don't need to require webpack
        this.emit('initialized', { type: 'webpack', source: 'existing' });
        return true;
      }
      
      // Try to require webpack normally
      this.webpack = require('webpack');
      this.compiler = this.webpack(this.config);
      
      // Hook into compiler events
      this._setupCompilerHooks();
      
      this.emit('initialized', { type: 'webpack' });
      return true;
      
    } catch (error) {
      // If webpack is not available or there's a circular dependency, just skip initialization
      if (error.message.includes('circular') || error.code === 'MODULE_NOT_FOUND') {
        console.log('[Retrigger] Skipping webpack adapter initialization (running in webpack context)');
        this.emit('initialized', { type: 'webpack', source: 'skipped' });
        return true;
      }
      
      this.emit('error', new Error(`Failed to initialize Webpack: ${error.message}`));
      return false;
    }
  }

  async build() {
    if (!this.compiler) {
      throw new Error('Webpack not initialized');
    }

    return new Promise((resolve, reject) => {
      this.compiler.run((err, stats) => {
        if (err) {
          this.emit('error', err);
          reject(err);
          return;
        }

        const info = stats.toJson();
        
        if (stats.hasErrors()) {
          const errors = info.errors;
          this.emit('build-error', errors);
          reject(new Error(`Build failed with ${errors.length} errors`));
          return;
        }

        if (stats.hasWarnings()) {
          this.emit('build-warning', info.warnings);
        }

        this.emit('build-complete', {
          stats: this._extractStatsInfo(info),
          duration: info.time,
        });

        resolve(info);
      });
    });
  }

  async watch() {
    if (!this.compiler) {
      throw new Error('Webpack not initialized');
    }

    if (this.isWatching) {
      return this.watching;
    }

    const watchOptions = {
      aggregateTimeout: this.config.watchOptions?.aggregateTimeout || 300,
      poll: this.config.watchOptions?.poll,
      ignored: this.config.watchOptions?.ignored || [
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
        '**/build/**',
      ],
      ...this.config.watchOptions,
    };

    return new Promise((resolve, reject) => {
      this.watching = this.compiler.watch(watchOptions, (err, stats) => {
        if (err) {
          this.emit('error', err);
          if (!this.isWatching) reject(err);
          return;
        }

        const info = stats.toJson();
        
        if (stats.hasErrors()) {
          this.emit('watch-error', info.errors);
        } else if (stats.hasWarnings()) {
          this.emit('watch-warning', info.warnings);
        } else {
          this.emit('watch-rebuild', {
            stats: this._extractStatsInfo(info),
            duration: info.time,
            changedFiles: Array.from(stats.compilation.modifiedFiles || []),
            addedFiles: Array.from(stats.compilation.addedFiles || []),
            removedFiles: Array.from(stats.compilation.removedFiles || []),
          });
        }
      });

      this.isWatching = true;
      this.emit('watch-started');
      
      if (!this.isWatching) resolve(this.watching);
    });
  }

  stop() {
    if (this.watching) {
      return new Promise((resolve) => {
        this.watching.close((err) => {
          if (err) {
            this.emit('error', err);
          }
          
          this.watching = null;
          this.isWatching = false;
          this.emit('watch-stopped');
          resolve();
        });
      });
    }
    
    return Promise.resolve();
  }

  invalidate(files = []) {
    if (!this.watching) return false;

    const filesToInvalidate = Array.isArray(files) ? files : [files];
    const resolvedFiles = filesToInvalidate.map(f => path.resolve(f));
    
    this.watching.invalidate(resolvedFiles);
    this.emit('invalidated', { files: resolvedFiles });
    
    return true;
  }

  getStats() {
    const baseStats = this._getBaseStats();
    const webpackStats = this.compiler ? this.compiler.getStats() : null;

    return {
      ...baseStats,
      webpack: {
        config: this._extractConfigInfo(),
        cache: this._getCacheStats(),
        modules: webpackStats ? webpackStats.compilation.modules.size : 0,
        assets: webpackStats ? Object.keys(webpackStats.compilation.assets).length : 0,
      },
      watching: this.watching ? {
        startTime: this.watching.startTime,
        running: this.watching.running,
      } : null,
    };
  }

  getType() {
    return 'webpack';
  }

  _getBundlerVersion() {
    try {
      return require('webpack/package.json').version;
    } catch {
      return 'unknown';
    }
  }

  /**
   * Setup webpack compiler event hooks
   * @private
   */
  _setupCompilerHooks() {
    if (!this.compiler) return;

    // Compilation hooks
    this.compiler.hooks.compile.tap('RetriggerWebpackAdapter', () => {
      this.emit('compile-start');
    });

    this.compiler.hooks.done.tap('RetriggerWebpackAdapter', (stats) => {
      this.emit('compile-done', {
        hasErrors: stats.hasErrors(),
        hasWarnings: stats.hasWarnings(),
        time: stats.endTime - stats.startTime,
      });
    });

    this.compiler.hooks.failed.tap('RetriggerWebpackAdapter', (error) => {
      this.emit('compile-failed', error);
    });

    // Watch hooks
    this.compiler.hooks.watchRun.tap('RetriggerWebpackAdapter', () => {
      this.emit('watch-compile-start');
    });

    this.compiler.hooks.watchClose.tap('RetriggerWebpackAdapter', () => {
      this.emit('watch-compile-close');
    });
  }

  /**
   * Extract useful stats information
   * @private
   */
  _extractStatsInfo(info) {
    return {
      time: info.time,
      builtAt: info.builtAt,
      publicPath: info.publicPath,
      outputPath: info.outputPath,
      assetsByChunkName: info.assetsByChunkName,
      entrypoints: Object.keys(info.entrypoints || {}),
      chunks: (info.chunks || []).length,
      modules: (info.modules || []).length,
      assets: (info.assets || []).length,
    };
  }

  /**
   * Extract webpack configuration info
   * @private
   */
  _extractConfigInfo() {
    if (!this.config) return null;

    return {
      mode: this.config.mode,
      devtool: this.config.devtool,
      target: this.config.target,
      entry: typeof this.config.entry === 'object' ? Object.keys(this.config.entry) : !!this.config.entry,
      output: this.config.output ? {
        path: this.config.output.path,
        filename: this.config.output.filename,
        publicPath: this.config.output.publicPath,
      } : null,
    };
  }

  /**
   * Get webpack cache statistics
   * @private
   */
  _getCacheStats() {
    if (!this.compiler || !this.compiler.cache) return null;

    try {
      return {
        type: this.compiler.options.cache?.type || 'memory',
        cacheDirectory: this.compiler.options.cache?.cacheDirectory,
      };
    } catch {
      return null;
    }
  }
}

/**
 * Rspack Adapter for high-performance bundling
 * Implements Open/Closed Principle
 */
class RspackAdapter extends BundlerAdapter {
  constructor(config = {}) {
    super(config);
    this.rspack = null;
  }

  async initialize() {
    try {
      // Try to load @rspack/core
      this.rspack = require('@rspack/core');
      this.compiler = this.rspack(this.config);
      
      this._setupCompilerHooks();
      
      this.emit('initialized', { type: 'rspack' });
      return true;
      
    } catch (error) {
      if (error.code === 'MODULE_NOT_FOUND') {
        this.emit('error', new Error('Rspack not installed. Install @rspack/core to use RspackAdapter'));
      } else {
        this.emit('error', new Error(`Failed to initialize Rspack: ${error.message}`));
      }
      return false;
    }
  }

  async build() {
    if (!this.compiler) {
      throw new Error('Rspack not initialized');
    }

    return new Promise((resolve, reject) => {
      this.compiler.run((err, stats) => {
        if (err) {
          this.emit('error', err);
          reject(err);
          return;
        }

        // Rspack stats processing (similar to webpack but with Rspack-specific optimizations)
        const info = stats.toJson();
        
        if (stats.hasErrors()) {
          const errors = info.errors;
          this.emit('build-error', errors);
          reject(new Error(`Build failed with ${errors.length} errors`));
          return;
        }

        this.emit('build-complete', {
          stats: info,
          duration: info.time,
          rspackOptimizations: this._getRspackOptimizations(info),
        });

        resolve(info);
      });
    });
  }

  async watch() {
    if (!this.compiler) {
      throw new Error('Rspack not initialized');
    }

    if (this.isWatching) return this.watching;

    const watchOptions = {
      // Rspack-specific optimized watch options
      aggregateTimeout: this.config.watchOptions?.aggregateTimeout || 100, // Faster than webpack
      poll: this.config.watchOptions?.poll,
      ignored: this.config.watchOptions?.ignored || [
        '**/node_modules/**',
        '**/.git/**',
      ],
      ...this.config.watchOptions,
    };

    return new Promise((resolve) => {
      this.watching = this.compiler.watch(watchOptions, (err, stats) => {
        if (err) {
          this.emit('error', err);
          return;
        }

        const info = stats.toJson();
        
        this.emit('watch-rebuild', {
          stats: info,
          duration: info.time,
          rspackPerf: this._getRspackPerformanceMetrics(stats),
        });
      });

      this.isWatching = true;
      this.emit('watch-started');
      resolve(this.watching);
    });
  }

  stop() {
    if (this.watching) {
      return new Promise((resolve) => {
        this.watching.close((err) => {
          if (err) this.emit('error', err);
          
          this.watching = null;
          this.isWatching = false;
          this.emit('watch-stopped');
          resolve();
        });
      });
    }
    
    return Promise.resolve();
  }

  invalidate(files = []) {
    if (!this.watching) return false;

    const filesToInvalidate = Array.isArray(files) ? files : [files];
    
    // Rspack-specific invalidation
    this.watching.invalidate();
    this.emit('invalidated', { files: filesToInvalidate });
    
    return true;
  }

  getStats() {
    return {
      ...this._getBaseStats(),
      rspack: {
        config: this.config,
        performance: this._getRspackPerformanceMetrics(),
      },
    };
  }

  getType() {
    return 'rspack';
  }

  _getBundlerVersion() {
    try {
      return require('@rspack/core/package.json').version;
    } catch {
      return 'unknown';
    }
  }

  _setupCompilerHooks() {
    if (!this.compiler) return;

    // Rspack compiler hooks (similar to webpack but optimized)
    this.compiler.hooks.compile.tap('RetriggerRspackAdapter', () => {
      this.emit('compile-start');
    });

    this.compiler.hooks.done.tap('RetriggerRspackAdapter', (stats) => {
      this.emit('compile-done', {
        hasErrors: stats.hasErrors(),
        hasWarnings: stats.hasWarnings(),
        time: stats.endTime - stats.startTime,
      });
    });
  }

  _getRspackOptimizations(info) {
    return {
      rustOptimizations: true, // Rspack is built in Rust
      parallelProcessing: true,
      incrementalCompilation: true,
      buildTime: info.time,
    };
  }

  _getRspackPerformanceMetrics(stats) {
    if (!stats) return null;

    return {
      compilationTime: stats.endTime - stats.startTime,
      memoryUsage: process.memoryUsage(),
      rustPerformance: true, // Placeholder for Rust-specific metrics
    };
  }
}

/**
 * Turbopack Adapter for next-generation bundling
 * Implements Liskov Substitution Principle
 */
class TurbopackAdapter extends BundlerAdapter {
  constructor(config = {}) {
    super(config);
    this.turbopack = null;
  }

  async initialize() {
    try {
      // Turbopack integration (experimental)
      // This would integrate with Next.js 13+ turbopack
      this.turbopack = await this._loadTurbopack();
      
      this.emit('initialized', { type: 'turbopack' });
      return true;
      
    } catch (error) {
      this.emit('error', new Error(`Failed to initialize Turbopack: ${error.message}`));
      return false;
    }
  }

  async build() {
    throw new Error('Turbopack build mode not yet implemented - primarily for Next.js dev mode');
  }

  async watch() {
    if (!this.turbopack) {
      throw new Error('Turbopack not initialized');
    }

    // Turbopack watching implementation
    this.isWatching = true;
    this.emit('watch-started');
    
    // Turbopack has built-in watching via Next.js dev server
    this._setupTurbopackWatching();
    
    return Promise.resolve();
  }

  stop() {
    if (this.isWatching) {
      this.isWatching = false;
      this.emit('watch-stopped');
    }
    
    return Promise.resolve();
  }

  invalidate(files = []) {
    if (!this.isWatching) return false;

    // Turbopack invalidation through Next.js HMR
    this.emit('invalidated', { files });
    return true;
  }

  getStats() {
    return {
      ...this._getBaseStats(),
      turbopack: {
        experimental: true,
        nextjsIntegration: true,
        performance: 'rust-native',
      },
    };
  }

  getType() {
    return 'turbopack';
  }

  _getBundlerVersion() {
    try {
      // Turbopack version tied to Next.js version
      return require('next/package.json').version;
    } catch {
      return 'unknown';
    }
  }

  async _loadTurbopack() {
    // Placeholder for Turbopack loading logic
    // In reality, this would integrate with Next.js 13+ dev server
    throw new Error('Turbopack adapter is experimental and requires Next.js 13+');
  }

  _setupTurbopackWatching() {
    // Turbopack watching implementation
    // Would integrate with Next.js HMR system
  }
}

/**
 * Bundler Factory for creating appropriate adapters
 * Implements Dependency Inversion Principle
 */
class BundlerFactory {
  static supportedTypes = ['webpack', 'rspack', 'turbopack'];

  /**
   * Create a bundler adapter based on type
   * @param {string} type - Bundler type ('webpack', 'rspack', 'turbopack')
   * @param {Object} config - Bundler configuration
   * @returns {BundlerAdapter} Bundler adapter instance
   */
  static create(type, config = {}) {
    const normalizedType = type.toLowerCase();

    switch (normalizedType) {
      case 'webpack':
        return new WebpackAdapter(config);
      
      case 'rspack':
        return new RspackAdapter(config);
      
      case 'turbopack':
        return new TurbopackAdapter(config);
      
      default:
        throw new Error(`Unsupported bundler type: ${type}. Supported types: ${this.supportedTypes.join(', ')}`);
    }
  }

  /**
   * Auto-detect bundler type from project
   * @param {string} projectPath - Path to project directory
   * @returns {string|null} Detected bundler type
   */
  static async detectBundler(projectPath = process.cwd()) {
    const fs = require('fs').promises;
    const packageJsonPath = path.join(projectPath, 'package.json');

    try {
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };

      // Check for Next.js with Turbopack
      if (deps.next && this._hasNextjsTurbopack(packageJson)) {
        return 'turbopack';
      }

      // Check for Rspack
      if (deps['@rspack/core'] || deps['@rspack/cli']) {
        return 'rspack';
      }

      // Check for Webpack
      if (deps.webpack || deps['webpack-cli']) {
        return 'webpack';
      }

      return null;
    } catch {
      return null;
    }
  }

  static _hasNextjsTurbopack(packageJson) {
    // Check if Next.js version supports Turbopack (13+)
    const nextVersion = packageJson.dependencies?.next || packageJson.devDependencies?.next;
    if (!nextVersion) return false;

    const majorVersion = parseInt(nextVersion.replace(/[^\d.].*$/, '').split('.')[0]);
    return majorVersion >= 13;
  }

  /**
   * Get all available bundler types
   * @returns {string[]} Available bundler types
   */
  static getSupportedTypes() {
    return [...this.supportedTypes];
  }
}

module.exports = {
  BundlerAdapter,
  WebpackAdapter,
  RspackAdapter,
  TurbopackAdapter,
  BundlerFactory,
};
