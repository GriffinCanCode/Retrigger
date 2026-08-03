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

/** One entry of a {@link SnapshotEnvelope}. */
export interface SnapshotEntry {
  /** Absolute path. */
  path: string;
  isDirectory: boolean;
  /** Always `0` for a directory. */
  size: number;
  /** Nanoseconds since the Unix epoch, `null` when the file system reports none. */
  modifiedNs: bigint | null;
}

/**
 * A self-describing, portable directory-tree inventory, returned by {@link Retrigger.snapshot}
 * and {@link Retrigger.watchWithSnapshot}. Safe to persist as JSON and load back later: `algorithm`
 * and `version` are what let a reader tell whether a persisted snapshot still matches what this
 * package produces before trusting it.
 */
export interface SnapshotEnvelope {
  /** The digest algorithm this envelope's format is defined in terms of. Currently `"xxh3-64"`. */
  algorithm: string;
  /** Envelope schema version. */
  version: number;
  entries: SnapshotEntry[];
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
  /** Async hashes of oversized files (see `maxHashBytes`) currently reading. Bounded by `maxConcurrentHashes`. */
  asyncHashesInFlight: number;
  /** Oversized-file hashes queued behind `maxConcurrentHashes` already-running ones. */
  asyncHashesQueued: number;
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
  /** `'watchman'` is only ever reported here if a watcher explicitly requested it and it was
   * available; `getEngine()`'s default `'auto'` resolution never selects it. */
  engine: 'native' | 'javascript' | 'watchman';
  /** "inotify" | "fsevents" | "rdcw" | "kqueue" | "polling" | "watchman" | "unknown" */
  backend: string;
  /** Why this engine was selected — the load failure reason when falling back. */
  reason: string;
  /**
   * `"xxh3-64"` on every engine: the JavaScript and Watchman engines both hash with the same
   * algorithm compiled to WebAssembly, so a digest from one is comparable to a digest from
   * another.
   */
  hashAlgorithm: string;
  simd: string;
  platform: string;
  nativeAttempts: Array<{ type: string; id: string; error?: string }>;
  /** Whether `prefer: 'watchman'` would succeed right now, and why, reported unconditionally —
   * mirrors `nativeAttempts` for the optional Watchman engine. */
  watchman: { available: boolean; kind: 'fb-watchman' | 'cli' | null; reason: string };
}

/**
 * Which watcher backend drives event delivery. `'auto'` (the default) is the
 * platform-native backend (`inotify`/`FSEvents`/`ReadDirectoryChangesW`).
 * `'poll'` forces the portable, interval-driven fallback `notify` itself
 * ships, for network/remote file systems where kernel watch events cannot be
 * trusted. Ignored by the JavaScript fallback engine, which always polls.
 */
export interface BackendOptions {
  mode?: 'auto' | 'poll';
  /** Re-scan interval in milliseconds. Only meaningful for `mode: 'poll'`. Default 1000. */
  pollIntervalMs?: number;
  /**
   * Also hash file contents on each poll, to catch a same-size, same-mtime
   * rewrite that `stat` alone would miss. Only meaningful for `mode: 'poll'`.
   * Default `false`.
   */
  compareContents?: boolean;
}

/**
 * Hold a changed file until it stops growing before reporting it (chokidar
 * calls this the same thing). `undefined` (the default) reports as soon as
 * the backend sees a change, which for a large file written in chunks means
 * the first chunk.
 */
export interface AwaitWriteFinishOptions {
  /** How often to re-`stat` a path while waiting for it to settle. Default 100. */
  pollIntervalMs?: number;
  /** How long size and mtime must be unchanged before the path is reported. Default 2000. */
  stabilityThresholdMs?: number;
}

export interface RetriggerOptions {
  paths?: string | string[];
  recursive?: boolean;
  include?: string[];
  exclude?: string[];
  debounceMs?: number;
  capacity?: number;
  pollIntervalMs?: number;
  /**
   * `'native'` throws if the addon is unavailable; `'auto'` never throws and never selects
   * `'watchman'` on its own. `'watchman'` falls back to `'auto'`'s resolution, with a warning,
   * when neither the `fb-watchman` client nor the `watchman` binary can be reached.
   */
  engine?: 'auto' | 'native' | 'javascript' | 'watchman';
  emitDirectories?: boolean;
  unref?: boolean;
  /**
   * Hash every changed file and report `contentChanged` on the event.
   * Default `true`. Events are annotated, never withheld.
   */
  contentHashing?: boolean;
  /**
   * The synchronous/asynchronous hashing threshold. A changed file at or under this size is
   * hashed synchronously on the drain loop; a larger one is hashed on the non-blocking async
   * path instead (see `maxConcurrentHashes`) so it cannot stall delivery of other events.
   * Default 4 MiB.
   */
  maxHashBytes?: number;
  /**
   * Ceiling on async hashes (see `maxHashBytes`) running at once; the rest wait their turn in a
   * FIFO queue. Default 4.
   */
  maxConcurrentHashes?: number;
  /** Which backend implementation drives event delivery. See {@link BackendOptions}. */
  backend?: BackendOptions;
  /** Coalesce a chunked write into one final event. See {@link AwaitWriteFinishOptions}. */
  awaitWriteFinish?: AwaitWriteFinishOptions;
  /**
   * Fold an atomic-save `renamedTo` for a path already seen to arrive into
   * `change`, so an editor's write-temp-then-rename save is never missed by a
   * listener that only reacts to content changes. Default `false`.
   */
  atomicWriteNormalization?: boolean;
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
  /** Crawl `target`'s current contents, without registering a watch on it. */
  snapshot(target: string): Promise<SnapshotEnvelope>;
  /**
   * `add(target, recursive)` followed by `snapshot(target)`, with the watch registered before the
   * crawl begins so nothing created during the crawl is lost.
   */
  watchWithSnapshot(target: string, recursive?: boolean): Promise<SnapshotEnvelope>;
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
  /**
   * Escape hatch: restore the pre-rewrite design (Vite's own chokidar watcher left running,
   * gated by content hash) instead of disabling it via `server.watch: null`. Default `false`.
   * See the header comment in `plugins/vite-plugin.js` for the composability trade-off.
   */
  legacyWatcher?: boolean;
}

export interface RetriggerVitePlugin {
  name: 'retrigger';
  apply: 'serve';
  enforce: 'pre';
  config(): { server: { watch: null } } | undefined;
  configureServer(server: any): () => void;
  buildStart(): void;
  buildEnd(): void;
  closeBundle(): void;
  api: {
    getStats(): Record<string, unknown>;
    isWatching(): boolean;
    dispatch(event: FileEvent): 'watcher' | 'fallback' | 'skipped';
    /** Force fail-open to a real watcher, as a repeated engine error would. Idempotent. */
    degrade(reason?: Error | string): void;
  };
}

export declare function createRetriggerVitePlugin(
  options?: RetriggerVitePluginOptions
): RetriggerVitePlugin;
