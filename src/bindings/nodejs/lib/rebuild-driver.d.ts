/**
 * Types for the shared manual-rebuild scheduler (`lib/rebuild-driver.js`).
 *
 * Not published under its own subpath — `lib/rollup-plugin.d.ts` and `lib/esbuild-plugin.d.ts`
 * import {@link RebuildDriver} from here to type the `driver` handle each factory returns.
 */

import type { EventEmitter } from 'events';
import type { Retrigger, RetriggerOptions, WatchStats } from '../index';
import type { MetricsSnapshot } from '../index';

export interface RebuildDriverStats {
  /** Successful `rebuild()` calls the driver has made. */
  rebuildCount: number;
  /** `rebuild()` calls that threw or rejected (and were not from an abort during `close()`). */
  errorCount: number;
  /** Real (`contentChanged !== false`) file events accepted into a rebuild. */
  eventsChanged: number;
  /** File events whose bytes were identical to what this session already saw. */
  eventsUnchanged: number;
  inFlight: boolean;
  /** Paths accumulated for the next rebuild, not yet dispatched. */
  pendingPaths: number;
  metrics: MetricsSnapshot;
  watcher: WatchStats;
}

export interface RebuildDriverOptions {
  /** Called with every path batch a coalescing window closed on, and never re-entered
   * concurrently with itself: the driver never calls this again until the previous call's
   * returned promise (or synchronous return) has settled. */
  rebuild: (changedPaths: string[], context: { signal: AbortSignal }) => unknown;
  /** Roots to watch. Forwarded to `createRetrigger({ ...retriggerOptions, paths })`. */
  watchPaths?: string | string[];
  retriggerOptions?: RetriggerOptions;
  /** Trailing coalescing window in milliseconds, reset on every new change. Default 20. */
  coalesceMs?: number;
  /** Convenience: registered as an `'error'` listener. */
  onError?: (error: Error) => void;
}

export declare class RebuildDriver extends EventEmitter {
  constructor(options: RebuildDriverOptions);
  readonly watcher: Retrigger;
  readonly isRunning: boolean;
  start(): this;
  close(): Promise<void>;
  getStats(): RebuildDriverStats;

  on(event: 'rebuild', listener: (changedPaths: string[]) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
}

export declare const DEFAULT_COALESCE_MS: number;
