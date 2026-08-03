/**
 * Types for the Rollup manual-rebuild wrapper (`@retrigger/core/rollup`).
 *
 * See `rollup-plugin.js`'s header for why this owns the watch instead of `rollup.watch()`, and
 * `rebuild-driver.d.ts` for the scheduler `driver` exposes.
 */

import type { OutputOptions, RollupOptions } from 'rollup';
import type { RetriggerOptions } from '../index';
import type { RebuildDriver, RebuildDriverStats } from './rebuild-driver';

export interface RetriggerRollupWatcherOptions extends RetriggerOptions {
  /** Passed to `rollup()` untouched. */
  input: RollupOptions;
  /** Passed to `bundle.write()`; an array is written in turn, once per configured output. */
  output: OutputOptions | OutputOptions[];
  /** Roots to watch for real changes. Required: nothing here can be inferred from `input`. */
  watchPaths: string | string[];
  /** Trailing coalescing window in milliseconds, reset on every new change. Default 20. */
  coalesceMs?: number;
  /** Convenience: registered as an `'error'` listener on `driver`. */
  onError?: (error: Error) => void;
}

export interface RetriggerRollupWatcher {
  /** Run one Rollup build immediately, outside the change-driven schedule. */
  build(): Promise<number>;
  /** Build once, then start watching for real changes. Idempotent. */
  start(): Promise<RetriggerRollupWatcher>;
  /** Stop watching and release every handle Rollup and Retrigger hold. Idempotent. */
  close(): Promise<void>;
  readonly buildCount: number;
  getStats(): { buildCount: number; started: boolean; closed: boolean; driver: RebuildDriverStats };
  /** The underlying scheduler, exposed for tests and for the benchmark lane. */
  readonly driver: RebuildDriver;
}

export declare function createRetriggerRollupWatcher(
  options: RetriggerRollupWatcherOptions
): RetriggerRollupWatcher;
export default createRetriggerRollupWatcher;
