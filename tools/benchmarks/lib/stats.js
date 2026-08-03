'use strict';

/**
 * @param {number[]} samples
 * @returns {{count: number, min: number, max: number, mean: number, p50: number, p95: number, p99: number}|null}
 */
function summarize(samples) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
  };
}

/**
 * Single-core CPU utilization (%) over a wall interval:
 * `(cpuTotalMs / wallMs) * 100`.
 * @param {number} cpuTotalMs
 * @param {number} wallMs
 */
function cpuUtilizationPct(cpuTotalMs, wallMs) {
  if (!(wallMs > 0) || !Number.isFinite(cpuTotalMs)) return 0;
  return (cpuTotalMs / wallMs) * 100;
}

/**
 * Poll RSS while `fn` runs; return result + resource deltas.
 * Also samples single-core CPU utilization over the wall-clock window:
 * overall `(cpuTotalMs / wallMs) * 100`, plus min/avg/max from interval deltas.
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{intervalMs?: number}} [opts]
 */
async function withResources(fn, opts = {}) {
  const intervalMs = opts.intervalMs ?? 25;
  const cpu0 = process.cpuUsage();
  const wall0 = process.hrtime.bigint();
  const mem0 = process.memoryUsage();
  let peakRss = mem0.rss;
  let sampleCpu = process.cpuUsage();
  let sampleWall = process.hrtime.bigint();
  /** @type {number[]} */
  const utilSamples = [];
  const timer = setInterval(() => {
    const rss = process.memoryUsage().rss;
    if (rss > peakRss) peakRss = rss;
    const cpuDelta = process.cpuUsage(sampleCpu);
    const wallNow = process.hrtime.bigint();
    const sampleWallMs = Number(wallNow - sampleWall) / 1e6;
    const sampleCpuMs = (cpuDelta.user + cpuDelta.system) / 1000;
    if (sampleWallMs > 0) utilSamples.push(cpuUtilizationPct(sampleCpuMs, sampleWallMs));
    sampleCpu = process.cpuUsage();
    sampleWall = wallNow;
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const result = await fn();
    const cpu = process.cpuUsage(cpu0);
    const wallMs = Number(process.hrtime.bigint() - wall0) / 1e6;
    const mem1 = process.memoryUsage();
    const cpuUserMs = cpu.user / 1000;
    const cpuSystemMs = cpu.system / 1000;
    const cpuTotalMs = cpuUserMs + cpuSystemMs;
    const util = cpuUtilizationPct(cpuTotalMs, wallMs);
    const utilAvg =
      utilSamples.length > 0
        ? utilSamples.reduce((a, b) => a + b, 0) / utilSamples.length
        : util;
    return {
      result,
      resources: {
        cpuUserMs,
        cpuSystemMs,
        cpuTotalMs,
        /** Single-core utilization over the full measured wall window. */
        cpuUtilizationPct: util,
        cpuUtilizationMinPct: utilSamples.length ? Math.min(...utilSamples) : util,
        cpuUtilizationAvgPct: utilAvg,
        cpuUtilizationMaxPct: utilSamples.length ? Math.max(...utilSamples) : util,
        wallMs,
        rssStartBytes: mem0.rss,
        rssEndBytes: mem1.rss,
        rssPeakBytes: Math.max(peakRss, mem1.rss),
        heapUsedEndBytes: mem1.heapUsed,
      },
    };
  } finally {
    clearInterval(timer);
  }
}

const pad = (value, width) => String(value).padEnd(width);
const bytes = (n) => {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
};
const ms = (n) => (typeof n === 'number' && Number.isFinite(n) ? `${n.toFixed(2)}ms` : 'n/a');
const pct = (n) => (typeof n === 'number' && Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : 'n/a');

module.exports = { summarize, withResources, cpuUtilizationPct, pad, bytes, ms, pct };
