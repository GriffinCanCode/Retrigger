'use strict';

/**
 * Counters for things this process actually observed.
 *
 * Every field here is incremented from a real code path. There is no simulated
 * GC accounting, no synthetic baseline, and no derived "improvement factor" —
 * the previous 1129-line monitor had all three and was wired to nothing.
 */
class Metrics {
  constructor(now = () => Date.now()) {
    this._now = now;
    this.reset();
  }

  reset() {
    this.startedAt = null;
    this.eventsReceived = 0;
    this.eventsEmitted = 0;
    this.eventsFiltered = 0;
    this.eventsUnchanged = 0;
    this.rescans = 0;
    this.errors = 0;
    this.triggers = 0;
    this.lastEventAt = null;
    this.lastTriggerAt = null;
    this._triggerLatencySumMs = 0;
    this._triggerLatencyCount = 0;
    this._maxTriggerLatencyMs = 0;
  }

  markStarted() {
    this.startedAt = this._now();
  }

  markStopped() {
    this.startedAt = null;
  }

  /** @param {string} kind one of the contract event kinds */
  recordEvent(kind) {
    this.eventsReceived += 1;
    this.lastEventAt = this._now();
    if (kind === 'rescanRequired') this.rescans += 1;
  }

  recordEmitted() {
    this.eventsEmitted += 1;
  }

  recordFiltered() {
    this.eventsFiltered += 1;
  }

  /**
   * An event whose file was rewritten with identical bytes. Counted, not hidden: this is the number
   * that says how much work content hashing saved, and a zero here on a real project is a reason to
   * doubt that hashing is wired up rather than a reason to celebrate.
   */
  recordUnchanged() {
    this.eventsUnchanged += 1;
  }

  recordError() {
    this.errors += 1;
  }

  /**
   * Record a downstream action (a webpack invalidation, a Vite HMR dispatch).
   * @param {number} latencyMs measured wall time from event receipt to dispatch
   */
  recordTrigger(latencyMs) {
    this.triggers += 1;
    this.lastTriggerAt = this._now();
    if (Number.isFinite(latencyMs) && latencyMs >= 0) {
      this._triggerLatencySumMs += latencyMs;
      this._triggerLatencyCount += 1;
      if (latencyMs > this._maxTriggerLatencyMs) this._maxTriggerLatencyMs = latencyMs;
    }
  }

  /** @returns {object} a plain snapshot; all values are measured, none inferred */
  snapshot() {
    const uptimeMs = this.startedAt === null ? 0 : this._now() - this.startedAt;
    return {
      uptimeMs,
      eventsReceived: this.eventsReceived,
      eventsEmitted: this.eventsEmitted,
      eventsFiltered: this.eventsFiltered,
      eventsUnchanged: this.eventsUnchanged,
      rescans: this.rescans,
      errors: this.errors,
      triggers: this.triggers,
      lastEventAt: this.lastEventAt,
      lastTriggerAt: this.lastTriggerAt,
      averageTriggerLatencyMs:
        this._triggerLatencyCount > 0
          ? this._triggerLatencySumMs / this._triggerLatencyCount
          : null,
      maxTriggerLatencyMs: this._triggerLatencyCount > 0 ? this._maxTriggerLatencyMs : null,
      rss: process.memoryUsage().rss,
    };
  }
}

module.exports = { Metrics };
