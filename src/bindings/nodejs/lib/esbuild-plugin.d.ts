/**
 * Types for the esbuild manual-rebuild wrapper (`@retrigger/core/esbuild`).
 *
 * See `esbuild-plugin.js`'s header for why this owns the watch instead of `ctx.watch()`, and
 * `rebuild-driver.d.ts` for the scheduler `driver` exposes.
 */

import type { BuildOptions, BuildResult } from 'esbuild';
import type { RetriggerOptions } from '../index';
import type { RebuildDriver, RebuildDriverStats } from './rebuild-driver';

/**
 * esbuild `BuildOptions` and `RetriggerOptions` sit side by side in one flat object, plus
 * `watchPaths` (required) and this wrapper's own `coalesceMs`/`onError`.
 */
export type RetriggerEsbuildWatcherOptions = BuildOptions &
  RetriggerOptions & {
    /** Roots to watch for real changes. Required: nothing here can be inferred from `entryPoints`. */
    watchPaths: string | string[];
    /** Trailing coalescing window in milliseconds, reset on every new change. Default 20. */
    coalesceMs?: number;
    /** Convenience: registered as an `'error'` listener on `driver`. */
    onError?: (error: Error) => void;
  };

export interface RetriggerEsbuildWatcher {
  /** Run one esbuild rebuild immediately, outside the change-driven schedule. */
  build(): Promise<BuildResult>;
  /** Build once, then start watching for real changes. Idempotent. */
  start(): Promise<RetriggerEsbuildWatcher>;
  /** Stop watching, release Retrigger's handles, and `ctx.dispose()`. Idempotent. */
  close(): Promise<void>;
  readonly buildCount: number;
  getStats(): { buildCount: number; started: boolean; closed: boolean; driver: RebuildDriverStats };
  /** The underlying scheduler, exposed for tests and for the benchmark lane. */
  readonly driver: RebuildDriver;
}

export declare function createRetriggerEsbuildWatcher(
  options: RetriggerEsbuildWatcherOptions
): RetriggerEsbuildWatcher;
export default createRetriggerEsbuildWatcher;
