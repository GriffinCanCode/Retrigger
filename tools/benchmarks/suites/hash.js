'use strict';

const { CORE } = require('../lib/env');
const { pad, bytes } = require('../lib/stats');

/**
 * @param {{quiet?: boolean}} [opts]
 */
async function runHashSuite(opts = {}) {
  const quiet = opts.quiet === true;
  const log = quiet ? () => {} : (...args) => console.log(...args);
  const { benchmarkHash, getEngineInfo } = require(CORE);
  const info = getEngineInfo();

  log(`\nhash throughput  engine=${info.engine}  algorithm=${info.hashAlgorithm}`);
  log('  size      throughput      ns/byte');

  const cases = [];
  const sizes = [1024, 64 * 1024, 1024 * 1024, 16 * 1024 * 1024];
  for (const size of sizes) {
    const iterations = Math.max(4, Math.floor((64 * 1024 * 1024) / size));
    const result = await benchmarkHash(size, iterations);
    log(
      `  ${pad(bytes(size), 8)}  ${pad(`${result.throughputMbps.toFixed(1)} MB/s`, 14)}  ${result.nsPerByte.toFixed(3)}`
    );
    cases.push({
      id: `hash/${size}`,
      watcher: 'retrigger',
      status: 'ok',
      metrics: {
        sizeBytes: size,
        iterations,
        throughputMbps: result.throughputMbps,
        nsPerByte: result.nsPerByte,
        level: result.level,
      },
    });
  }

  return {
    name: 'hash',
    description: 'Content-hash throughput (XXH3 / JS fallback)',
    cases,
  };
}

module.exports = { runHashSuite };
