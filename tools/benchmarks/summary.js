#!/usr/bin/env node
'use strict';

/**
 * Human-readable summary from a results.v1 JSON document.
 *
 *   node tools/benchmarks/summary.js results/latest.json
 */

const path = require('path');
const { readResults, validateResults } = require('./lib/io');
const { renderSummary } = require('./lib/report');

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node summary.js <results.json>');
    process.exit(2);
  }
  const doc = readResults(path.resolve(file));
  const check = validateResults(doc);
  if (!check.ok) {
    console.error('invalid results document:');
    for (const e of check.errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  renderSummary(doc);
}

main();
