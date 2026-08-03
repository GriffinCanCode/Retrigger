/**
 * Types for the chokidar v5-compatible adapter (`@retrigger/core/chokidar`).
 *
 * See `chokidar-adapter.js`'s header for the documented divergences from real chokidar; this
 * file describes the runtime exactly, covered by `test/chokidar-adapter.test.mjs`.
 */

/// <reference types="node" />

import { EventEmitter } from 'events';
import type { Stats } from 'fs';

/** A glob string, a predicate, or a mix of either — not a `RegExp`. */
export type ChokidarIgnored =
  | string
  | ((path: string, stats?: Stats) => boolean)
  | Array<string | ((path: string, stats?: Stats) => boolean)>;

export interface ChokidarAwaitWriteFinishOptions {
  stabilityThreshold?: number;
  pollInterval?: number;
}

export interface ChokidarWatchOptions {
  cwd?: string;
  ignored?: ChokidarIgnored;
  /** Default `false`: the initial scan emits `add`/`addDir` for every pre-existing entry. */
  ignoreInitial?: boolean;
  /** Default `true`. There is no per-level `depth`; use this for one level instead. */
  recursive?: boolean;
  /** Not chokidar's arbitrary integer depth: `0` behaves like `recursive: false`, anything
   * greater behaves like `recursive: true`. */
  depth?: number;
  awaitWriteFinish?: boolean | ChokidarAwaitWriteFinishOptions;
  /** Default `true` here (see the adapter's header comment for why this differs from
   * `Retrigger`'s own bare default of `false`). */
  atomic?: boolean | number;
  /** Accepted for interface compatibility; has no effect (see the adapter's header comment). */
  followSymlinks?: boolean;
  /** Default `true`. An extension real chokidar has no equivalent of: suppresses `change` for a
   * rewrite with identical bytes. */
  contentHashing?: boolean;
  engine?: 'auto' | 'native' | 'javascript' | 'watchman';
  include?: string[];
  exclude?: string[];
  capacity?: number;
  debounceMs?: number;
  pollIntervalMs?: number;
}

export declare class FSWatcher extends EventEmitter {
  constructor(options?: ChokidarWatchOptions);
  readonly options: ChokidarWatchOptions;
  add(paths: string | string[]): this;
  unwatch(paths: string | string[]): this;
  getWatched(): Record<string, string[]>;
  close(): Promise<void>;

  on(event: 'add' | 'change' | 'unlink', listener: (path: string, stats?: Stats) => void): this;
  on(event: 'addDir' | 'unlinkDir', listener: (path: string) => void): this;
  on(
    event: 'all',
    listener: (
      event: 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir',
      path: string,
      stats?: Stats
    ) => void
  ): this;
  on(event: 'ready', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
}

/**
 * @param paths a path or array of paths; each must already exist (see the adapter's header
 *   comment — unlike real chokidar, a not-yet-created path is not watched for its own creation).
 */
export declare function watch(paths: string | string[], options?: ChokidarWatchOptions): FSWatcher;

declare const _default: { watch: typeof watch; FSWatcher: typeof FSWatcher };
export default _default;
