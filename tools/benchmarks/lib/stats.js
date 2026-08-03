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
 * Poll RSS while `fn` runs; return result + resource deltas.
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{intervalMs?: number}} [opts]
 */
async function withResources(fn, opts = {}) {
  const intervalMs = opts.intervalMs ?? 25;
  const cpu0 = process.cpuUsage();
  const mem0 = process.memoryUsage();
  let peakRss = mem0.rss;
  const timer = setInterval(() => {
    const rss = process.memoryUsage().rss;
    if (rss > peakRss) peakRss = rss;
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const result = await fn();
    const cpu = process.cpuUsage(cpu0);
    const mem1 = process.memoryUsage();
    return {
      result,
      resources: {
        cpuUserMs: cpu.user / 1000,
        cpuSystemMs: cpu.system / 1000,
        cpuTotalMs: (cpu.user + cpu.system) / 1000,
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

module.exports = { summarize, withResources, pad, bytes, ms, pct };
