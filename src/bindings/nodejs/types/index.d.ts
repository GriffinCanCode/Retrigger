/**
 * Retrigger - Ultra-fast file system watcher for Node.js
 * Native performance file watching with sub-millisecond latency
 */

export interface FileEvent {
  /** Absolute path to the file that changed */
  path: string;
  /** Type of file system event */
  event_type: 'created' | 'modified' | 'deleted' | 'moved' | 'metadata_changed';
  /** Timestamp of the event in nanoseconds (as string for BigInt compatibility) */
  timestamp: string;
  /** Size of the file in bytes (as string for BigInt compatibility) */
  size: string;
  /** Whether the path is a directory */
  is_directory: boolean;
  /** Hash information if available */
  hash?: HashResult;
}

export interface HashResult {
  /** File hash as string (for BigInt compatibility) */
  hash: string;
  /** Size of hashed content in bytes */
  size: number;
  /** Whether this was computed incrementally */
  is_incremental: boolean;
}

export interface WatcherStats {
  /** Number of pending events in buffer */
  pending_events: number;
  /** Total buffer capacity */
  buffer_capacity: number;
  /** Number of dropped events (as string for BigInt compatibility) */
  dropped_events: string;
  /** Total events processed (as string for BigInt compatibility) */
  total_events: string;
  /** Number of currently watched directories */
  watched_directories: number;
}

export interface WatchOptions {
  /** Watch subdirectories recursively (default: true) */
  recursive?: boolean;
  /** Patterns to include (glob format) */
  include_patterns?: string[];
  /** Patterns to exclude (glob format) */
  exclude_patterns?: string[];
  /** Enable file hashing (default: true) */
  enable_hashing?: boolean;
  /** Block size for incremental hashing (default: 4096) */
  hash_block_size?: number;
}

export interface BenchmarkResult {
  /** Throughput in MB/s */
  throughput_mbps: number;
  /** CPU cycles per byte */
  cycles_per_byte: number;
  /** Average latency in nanoseconds */
  latency_ns: number;
}

/**
 * Main Retrigger class for file system monitoring
 */
export class RetriggerWrapper {
  /** Create a new Retrigger instance */
  constructor();
  
  /** Watch a directory for changes */
  watch_directory(path: string, options?: WatchOptions): Promise<void>;
  
  /** Start the file watcher */
  start(): Promise<void>;
  
  /** Poll for the next event (non-blocking) */
  poll_event(): Promise<FileEvent | null>;
  
  /** Wait for the next event with timeout in milliseconds */
  wait_event(timeout_ms: number): Promise<FileEvent | null>;
  
  /** Get watcher statistics */
  get_stats(): Promise<WatcherStats>;
  
  /** Hash a file directly */
  hash_file(path: string): Promise<HashResult>;
  
  /** Hash bytes directly */
  hash_bytes(data: Buffer): HashResult;
  
  /** Get SIMD optimization level */
  get_simd_level(): string;
}

/**
 * Synchronously hash a file
 * @param path - Path to file to hash
 * @returns Hash result
 */
export function hash_file_sync(path: string): HashResult;

/**
 * Synchronously hash bytes
 * @param data - Data to hash
 * @returns Hash result
 */
export function hash_bytes_sync(data: Buffer): HashResult;

/**
 * Get available SIMD support level
 * @returns SIMD level string
 */
export function get_simd_support(): string;

/**
 * Run hash performance benchmark
 * @param test_size - Size of test data in bytes
 * @returns Benchmark results
 */
export function benchmark_hash(test_size: number): Promise<Record<string, number>>;

/**
 * Webpack plugin for Retrigger integration
 */
export class RetriggerWebpackPlugin {
  constructor(options?: {
    /** Directories to watch */
    watchPaths?: string[];
    /** Watch options */
    watchOptions?: WatchOptions;
    /** Enable verbose logging */
    verbose?: boolean;
  });
  
  /** Apply the plugin to a webpack compiler */
  apply(compiler: any): void;
}

/**
 * Vite plugin for Retrigger integration
 */
export function createRetriggerVitePlugin(options?: {
  /** Directories to watch */
  watchPaths?: string[];
  /** Watch options */
  watchOptions?: WatchOptions;
}): any;

/**
 * Event emitter interface for file watching
 */
export class RetriggerEmitter extends NodeJS.EventEmitter {
  constructor(watcher: RetriggerWrapper);
  
  /** Start emitting events */
  start(): Promise<void>;
  
  /** Stop emitting events */
  stop(): void;
  
  on(event: 'file-created', listener: (event: FileEvent) => void): this;
  on(event: 'file-modified', listener: (event: FileEvent) => void): this;
  on(event: 'file-deleted', listener: (event: FileEvent) => void): this;
  on(event: 'file-moved', listener: (event: FileEvent) => void): this;
  on(event: 'file-changed', listener: (event: FileEvent) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'stats', listener: (stats: WatcherStats) => void): this;
}

/**
 * Advanced Retrigger Options
 */
export interface AdvancedRetriggerOptions {
  /** Enable performance monitoring system */
  enablePerformanceMonitoring?: boolean;
  /** Enable SharedArrayBuffer communication */
  enableSharedBuffer?: boolean;
  /** Enable advanced HMR integration */
  enableHMR?: boolean;
  /** Enable source map support */
  enableSourceMaps?: boolean;
  /** HMR invalidation strategy */
  hmrInvalidationStrategy?: 'conservative' | 'smart' | 'aggressive';
  /** SharedArrayBuffer size in bytes */
  sharedBufferSize?: number;
  /** Performance monitoring options */
  performanceOptions?: PerformanceMonitorOptions;
  /** Enable verbose logging */
  verbose?: boolean;
}

/**
 * Performance Monitor Options
 */
export interface PerformanceMonitorOptions {
  /** Metrics collection interval in ms */
  metricsInterval?: number;
  /** Memory check interval in ms */
  memoryCheckInterval?: number;
  /** Memory usage threshold (0-1) */
  memoryThreshold?: number;
  /** CPU usage threshold (0-1) */
  cpuThreshold?: number;
  /** Event latency threshold in ms */
  eventLatencyThreshold?: number;
  /** Enable memory leak detection */
  enableMemoryLeakDetection?: boolean;
  /** Enable adaptive optimization */
  enableAdaptiveOptimization?: boolean;
  /** Enable alerting system */
  enableAlerting?: boolean;
}

/**
 * Performance Dashboard Data
 */
export interface DashboardData {
  timestamp: number;
  metrics: {
    cpu_usage: number;
    memory_usage: number;
    event_rate: number;
    average_latency: number;
  };
  status: {
    overall: 'healthy' | 'warning' | 'critical';
    memory: 'healthy' | 'warning' | 'critical';
    performance: 'excellent' | 'good' | 'needs_attention';
  };
  recent_issues: any[];
  trends: any;
}

/**
 * HMR Update Result
 */
export interface HMRUpdateResult {
  type: 'hmr-update' | 'full-reload' | 'skip';
  moduleId?: string;
  affectedModules?: string[];
  strategy?: string;
  timestamp: number;
  updates?: any[];
  reason?: string;
}

/**
 * SharedArrayBuffer Communication Stats
 */
export interface SharedBufferStats {
  role: 'consumer' | 'producer';
  bufferSize: number;
  producer: any;
  consumer: any;
}

/**
 * Advanced Retrigger Instance
 */
export interface AdvancedRetriggerInstance extends RetriggerInstance {
  /** Initialize advanced features */
  initializeAdvanced(): Promise<this>;
  
  /** Get comprehensive performance statistics */
  getPerformanceStats(): any;
  
  /** Get real-time dashboard data */
  getDashboard(): DashboardData;
  
  /** Force garbage collection */
  forceGC(): boolean;
  
  /** Get SharedArrayBuffer statistics */
  getSharedBufferStats(): SharedBufferStats | null;
  
  /** Process file change for HMR */
  processFileChangeForHMR(event: FileEvent, bundlerInstance: any, bundlerType?: string): Promise<HMRUpdateResult>;
  
  /** Get HMR performance statistics */
  getHMRStats(): any;
  
  /** Enhanced cleanup with advanced features */
  destroy(): Promise<void>;
}

/**
 * Standard Retrigger Instance
 */
export interface RetriggerInstance {
  wrapper: RetriggerWrapper;
  emitter: RetriggerEmitter;
  
  watch(paths: string | string[], watchOptions?: WatchOptions): Promise<this>;
  start(): Promise<this>;
  stop(): this;
  
  on(event: string, listener: (...args: any[]) => void): this;
  once(event: string, listener: (...args: any[]) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
  
  getStats(): Promise<WatcherStats>;
  getSimdLevel(): string;
  hashFile(filePath: string): Promise<HashResult>;
  hashBytes(data: Buffer): HashResult;
}

/**
 * Create standard Retrigger instance
 */
export function createRetrigger(options?: WatchOptions): RetriggerInstance;

/**
 * Create advanced Retrigger instance with enhanced features
 */
export function createAdvancedRetrigger(options?: AdvancedRetriggerOptions): AdvancedRetriggerInstance;

/**
 * SharedArrayBuffer Communication System
 */
export class SharedBufferCommunicator extends NodeJS.EventEmitter {
  constructor(bufferSize?: number);
  
  /** Initialize as main thread (consumer) */
  initializeAsMain(): Promise<void>;
  
  /** Initialize as worker thread (producer) */
  initializeAsWorker(sharedBuffer: SharedArrayBuffer): void;
  
  /** Write event (worker thread only) */
  writeEvent(event: FileEvent): boolean;
  
  /** Get communication statistics */
  getStats(): SharedBufferStats;
  
  /** Cleanup resources */
  destroy(): void;
  
  on(event: 'file-event', listener: (event: FileEvent) => void): this;
  on(event: 'worker-message', listener: (message: any) => void): this;
  on(event: 'batch-processed', listener: (count: number) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

/**
 * Advanced HMR Manager
 */
export class HMRManager extends NodeJS.EventEmitter {
  constructor(options?: any);
  
  /** Initialize with bundler */
  initialize(bundlerType: string, bundlerInstance: any): Promise<void>;
  
  /** Process file change for HMR */
  processFileChange(event: FileEvent): Promise<HMRUpdateResult>;
  
  /** Get performance statistics */
  getPerformanceStats(): any;
  
  /** Cleanup resources */
  destroy(): void;
  
  on(event: 'update-complete', listener: (result: HMRUpdateResult) => void): this;
  on(event: 'full-reload', listener: (result: any) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

/**
 * Performance Monitor
 */
export class PerformanceMonitor extends NodeJS.EventEmitter {
  constructor(options?: PerformanceMonitorOptions);
  
  /** Initialize monitoring */
  initialize(): Promise<boolean>;
  
  /** Record file system event */
  recordEvent(event: FileEvent): void;
  
  /** Get comprehensive performance report */
  getPerformanceReport(): any;
  
  /** Get real-time dashboard data */
  getDashboardData(): DashboardData;
  
  /** Force garbage collection */
  forceGarbageCollection(): boolean;
  
  /** Stop monitoring and cleanup */
  destroy(): void;
  
  on(event: 'metrics-collected', listener: (metrics: any) => void): this;
  on(event: 'memory-threshold-exceeded', listener: (info: any) => void): this;
  on(event: 'performance-issues', listener: (issues: any[]) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

/**
 * Bundler Factory
 */
export class BundlerFactory {
  static supportedTypes: string[];
  
  /** Create bundler adapter */
  static create(type: string, config?: any): any;
  
  /** Auto-detect bundler type */
  static detectBundler(projectPath?: string): Promise<string | null>;
  
  /** Get supported bundler types */
  static getSupportedTypes(): string[];
}

/**
 * Enhanced Webpack plugin options
 */
export interface EnhancedWebpackPluginOptions {
  /** Directories to watch */
  watchPaths?: string[];
  /** Watch options */
  watchOptions?: WatchOptions;
  /** Enable verbose logging */
  verbose?: boolean;
  /** Debounce time in milliseconds */
  debounceMs?: number;
  /** Enable HMR */
  enableHMR?: boolean;
  /** Use SharedArrayBuffer */
  useSharedBuffer?: boolean;
  /** SharedArrayBuffer size */
  sharedBufferSize?: number;
  /** Max event batch size */
  maxEventBatch?: number;
  /** Enable advanced invalidation */
  enableAdvancedInvalidation?: boolean;
}

/**
 * Enhanced Vite plugin options
 */
export interface EnhancedVitePluginOptions {
  /** Directories to watch */
  watchPaths?: string[];
  /** Watch options */
  watchOptions?: WatchOptions;
  /** Enable verbose logging */
  verbose?: boolean;
  /** Debounce time in milliseconds */
  debounceMs?: number;
  /** Enable source map updates */
  enableSourceMapUpdate?: boolean;
  /** Use SharedArrayBuffer */
  useSharedBuffer?: boolean;
  /** SharedArrayBuffer size */
  sharedBufferSize?: number;
  /** Enable advanced HMR */
  enableAdvancedHMR?: boolean;
  /** HMR invalidation strategy */
  hmrInvalidationStrategy?: 'conservative' | 'smart' | 'aggressive';
}

/**
 * Enhanced Webpack plugin for Retrigger integration
 */
export class RetriggerWebpackPlugin {
  constructor(options?: EnhancedWebpackPluginOptions);
  
  /** Apply the plugin to a webpack compiler */
  apply(compiler: any): void;
  
  /** Get performance statistics */
  getPerformanceStats(): Promise<any>;
}

/**
 * Enhanced Vite plugin for Retrigger integration
 */
export function createRetriggerVitePlugin(options?: EnhancedVitePluginOptions): any;

/**
 * Advanced default options
 */
export const ADVANCED_DEFAULT_OPTIONS: AdvancedRetriggerOptions;
