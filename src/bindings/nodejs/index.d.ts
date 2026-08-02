/**
 * Type definitions for @retrigger/core.
 *
 * These describe the runtime exactly. Every symbol declared here exists at
 * runtime and is covered by `test/api-contract.test.js`, which enumerates this
 * surface so the two cannot drift apart silently.
 */

/// <reference types="node" />

import { EventEmitter } from 'events';

/** Event kinds produced by the native engine. */
export type EventKind =
  'created' | 'modified' | 'deleted' | 'renamedFrom' | 'renamedTo' | 'metadata' | 'rescanRequired';

export interface FileEvent {
  /** Absolute path. Empty string for `rescanRequired`. */
  path: string;
  kind: EventKind;
  /** Monotonic timestamp from `process.hrtime.bigint()` (JS engine) or the OS. */
  timestampNs: bigint;
  size: number;
  isDirectory: boolean;
  /**
   * Rename correlation cookie. Always `null` on the JavaScript engine, which
   * cannot pair the two halves of a rename.
   */
  cookie: number | null;
  /**
   * Whether the bytes actually differ from the last time this watcher saw this
   * path. `undefined` when `contentHashing: false` was requested, which is the
   * only case in which the question was not asked.
   *
   * `false` means the file was rewritten with the contents it already had — a
   * formatter on save, a generator that reran, a branch switch that restored
   * what was there — and a rebuild would produce identical output. Everything
   * uncertain reports `true`: an unreadable file, a file above `maxHashBytes`,
   * a removal, and a `rescanRequired` signal.
   */
  contentChanged?: boolean;
  /**
   * The digest behind `contentChanged`, or `null` when none was computed
   * (directories, removals, rescans, and files that could not be read).
   *
   * Comparable only against digests from the *same* engine: the native engine
   * hashes with XXH3-64 and the JavaScript engine does not. `contentChanged` is
   * unaffected, because it only ever compares a path against itself.
   */
  hash?: string | null;
}

/** Content-hashing counters, `null` when `contentHashing: false`. */
export interface ContentStats {
  /** Digests currently cached. Never exceeds the configured ceiling. */
  entries: number;
  filesHashed: number;
  /** Files that could not be read, and were therefore reported as changed. */
  hashErrors: number;
  /** Events whose bytes turned out to be identical. */
  unchanged: number;
}

export interface WatchStats {
  engine: 'native' | 'javascript';
  backend: string;
  eventsQueued: number;
  eventsDropped: number;
  eventsDelivered: number;
  /** Number of paths registered with `add()`, not the number of open handles. */
  watchedPaths: number;
  queuePending: number;
  queueCapacity: number;
  isRunning: boolean;
  content: ContentStats | null;
  metrics: MetricsSnapshot;
}

export interface MetricsSnapshot {
  uptimeMs: number;
  eventsReceived: number;
  eventsEmitted: number;
  eventsFiltered: number;
  eventsUnchanged: number;
  rescans: number;
  errors: number;
  triggers: number;
  lastEventAt: number | null;
  lastTriggerAt: number | null;
  averageTriggerLatencyMs: number | null;
  maxTriggerLatencyMs: number | null;
  rss: number;
}

export interface EngineInfo {
  engine: 'native' | 'javascript';
  /** "inotify" | "fsevents" | "rdcw" | "kqueue" | "polling" | "unknown" */
  backend: string;
  /** Why this engine was selected — the load failure reason when falling back. */
  reason: string;
  /**
   * `"xxh3-64"` on the native engine. The JavaScript engine reports a
   * different algorithm (`"blake2b-64"` or `"sha256-64"`); digests are NOT
   * comparable between engines.
   */
  hashAlgorithm: string;
  simd: string;
  platform: string;
  nativeAttempts: Array<{ type: string; id: string; error?: string }>;
}

export interface RetriggerOptions {
  paths?: string | string[];
  recursive?: boolean;
  include?: string[];
  exclude?: string[];
  debounceMs?: number;
  capacity?: number;
  pollIntervalMs?: number;
  /** `'native'` throws if the addon is unavailable; `'auto'` never throws. */
  engine?: 'auto' | 'native' | 'javascript';
  emitDirectories?: boolean;
  unref?: boolean;
  /**
   * Hash every changed file and report `contentChanged` on the event.
   * Default `true`. Events are annotated, never withheld.
   */
  contentHashing?: boolean;
  /**
   * Files larger than this are reported as changed without being read, because
   * hashing runs on the drain loop. Default 4 MiB.
   */
  maxHashBytes?: number;
}

export declare class Retrigger extends EventEmitter {
  constructor(options?: RetriggerOptions);
  readonly options: Required<
    Pick<
      RetriggerOptions,
      | 'recursive'
      | 'include'
      | 'exclude'
      | 'debounceMs'
      | 'capacity'
      | 'pollIntervalMs'
      | 'emitDirectories'
      | 'unref'
      | 'contentHashing'
    >
  >;
  readonly isRunning: boolean;
  add(target: string, recursive?: boolean): this;
  /** Alias of `add`. */
  watch(target: string, recursive?: boolean): this;
  unwatch(target: string): this;
  start(): this;
  stop(): this;
  close(): this;
  getStats(): WatchStats;
  getEngineInfo(): EngineInfo;
  getSimdLevel(): string;

  on(event: 'add' | 'change' | 'unlink', listener: (path: string, event: FileEvent) => void): this;
  on(event: 'all' | 'rescan', listener: (event: FileEvent) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'ready', listener: () => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
}

export declare function createRetrigger(options?: RetriggerOptions): Retrigger;

/** 16 lowercase hex characters. Algorithm depends on the active engine. */
export declare function hashBytesSync(
  data: Buffer | Uint8Array | ArrayBuffer | string,
  seed?: bigint | number
): string;
export declare function hashFileSync(filePath: string): { hash: string; size: number };
export declare function hashFile(filePath: string): Promise<{ hash: string; size: number }>;
export declare function benchmarkHash(
  size: number,
  iterations: number
): Promise<{ throughputMbps: number; nsPerByte: number; level: string }>;

export declare function getSimdSupport(): string;
export declare function getCpuLevel(): string;
export declare function getAvailableLevels(): string[];
export declare function getEngineInfo(): EngineInfo;

// ------------------------------------------------------------------ webpack

export interface RetriggerWebpackPluginOptions {
  watchPaths?: string[];
  verbose?: boolean;
  debounceMs?: number;
  include?: string[];
  /** Defaults to `['**\/node_modules\/**', '**\/.git\/**']`. */
  exclude?: string[];
  engine?: 'auto' | 'native' | 'javascript';
  /** Replace webpack's Watchpack-based watcher. Default `true`. */
  replaceWatcher?: boolean;
  aggregateTimeout?: number;
  capacity?: number;
  pollIntervalMs?: number;
  /** Skip invalidation for files rewritten with identical bytes. Default `true`. */
  contentHashing?: boolean;
}

export declare class RetriggerWebpackPlugin {
  constructor(options?: RetriggerWebpackPluginOptions);
  readonly degraded: boolean;
  readonly degradedReason: string | null;
  apply(compiler: unknown): void;
  isUsable(): boolean;
  stop(): void;
  getStats(): (WatchStats & { degraded: boolean; watchedDirectories: number }) | null;
  getPerformanceStats(): Promise<
    (WatchStats & { degraded: boolean; watchedDirectories: number }) | null
  >;
}

// --------------------------------------------------------------------- vite

export interface RetriggerVitePluginOptions {
  watchPaths?: string[];
  include?: string[];
  /** Defaults to node_modules, .git, dist and .vite. */
  exclude?: string[];
  verbose?: boolean;
  debounceMs?: number;
  engine?: 'auto' | 'native' | 'javascript';
  capacity?: number;
  pollIntervalMs?: number;
  /** Mount the `/__retrigger_stats` endpoint. Default `true`. */
  stats?: boolean;
  /** Skip HMR for files rewritten with identical bytes. Default `true`. */
  contentHashing?: boolean;
}

export interface RetriggerVitePlugin {
  name: 'retrigger';
  apply: 'serve';
  configureServer(server: any): () => void;
  buildStart(): void;
  buildEnd(): void;
  closeBundle(): void;
  api: {
    getStats(): Record<string, unknown>;
    isWatching(): boolean;
    dispatch(event: FileEvent): 'watcher' | 'fallback' | 'skipped';
  };
}

export declare function createRetriggerVitePlugin(
  options?: RetriggerVitePluginOptions
): RetriggerVitePlugin;
