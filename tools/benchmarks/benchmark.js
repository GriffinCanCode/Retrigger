#!/usr/bin/env node
'use strict';

/**
 * Retrigger reproducible performance laboratory.
 *
 * Suites:
 *   hash       — content-hash throughput
 *   watch      — raw per-event latency (honest vs chokidar)
 *   rebuild    — FLAGSHIP: Vite/webpack rebuild counts + wall time
 *   scenarios  — crawl, storm, CPU/RSS, large tree, poll, snapshot, adapter
 *
 *   node tools/benchmarks/benchmark.js              # all suites
 *   node tools/benchmarks/benchmark.js rebuild
 *   node tools/benchmarks/benchmark.js hash watch
 *   node tools/benchmarks/benchmark.js --json results/run.json
 *   node tools/benchmarks/benchmark.js --gate        # exit 1 if a same-run gate fails
 *
 * Comparators (chokidar, watchpack, @parcel/watcher, vite, webpack) are optional:
 * a missing one prints "not installed" and is never estimated.
 */

const fs = require('fs');
const path = require('path');

const { captureEnv, ensureCore } = require('./lib/env');
const { SCHEMA_ID, SCHEMA_VERSION, validateResults, writeResults } = require('./lib/io');
const { renderSummary } = require('./lib/report');
const { runHashSuite } = require('./suites/hash');
const { runWatchSuite } = require('./suites/watch');
const { runRebuildSuite } = require('./suites/rebuild');
const { runScenariosSuite } = require('./suites/scenarios');

const SUITES = {
  hash: runHashSuite,
  watch: runWatchSuite,
  rebuild: runRebuildSuite,
  scenarios: runScenariosSuite,
};

function parseArgs(argv) {
  const args = {
    suites: [],
    json: null,
    gate: false,
    quiet: false,
    summary: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') args.json = argv[++i];
    else if (a.startsWith('--json=')) args.json = a.slice('--json='.length);
    else if (a === '--gate') args.gate = true;
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--no-summary') args.summary = false;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('-')) {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    } else if (SUITES[a]) args.suites.push(a);
    else {
      console.error(`unknown suite: ${a}`);
      console.error(`known: ${Object.keys(SUITES).join(', ')}`);
      process.exit(2);
    }
  }
  if (!args.suites.length) args.suites = Object.keys(SUITES);
  return args;
}

function usage() {
  console.log(`Usage: node benchmark.js [suites...] [--json path] [--gate] [--quiet]

Suites: ${Object.keys(SUITES).join(', ')}
Default: all suites.

  --json path   write results.v1 JSON (also validates against the schema)
  --gate        exit 1 if any same-run gate fails
  --quiet       suppress per-suite console tables (JSON still written)
  --no-summary  skip the final human summary`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  ensureCore();
  const env = captureEnv();
  console.log(
    `retrigger benchmark  ${env.engine} engine on ${env.platform}-${env.arch}  hash=${env.hashAlgorithm}`
  );
  if (env.engine !== 'native') console.log(`  native unavailable: ${env.engineReason}`);
  console.log(`  ${env.cpuCount}× ${env.cpuModel || '?'}  node ${env.node}`);

  const suites = [];
  const gates = [];
  for (const name of args.suites) {
    const result = await SUITES[name]({ quiet: args.quiet });
    suites.push(result);
    if (result.gates) gates.push(...result.gates);
  }

  const doc = {
    schema: SCHEMA_ID,
    schemaVersion: SCHEMA_VERSION,
    env,
    config: {
      suites: args.suites,
      warmup: true,
      note: 'Gates compare Retrigger to a stock watcher measured in THIS run only.',
    },
    suites,
    gates,
  };

  const check = validateResults(doc);
  if (!check.ok) {
    console.error('\nresults failed schema validation:');
    for (const e of check.errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  const jsonPath =
    args.json ||
    path.join(__dirname, 'results', `run-${env.timestamp.replace(/[:.]/g, '-')}.json`);
  writeResults(doc, jsonPath);
  // Convenience pointer for summary.js defaults.
  try {
    fs.copyFileSync(jsonPath, path.join(__dirname, 'results', 'latest.json'));
  } catch {
    /* results dir may be read-only in some sandboxes */
  }
  console.log(`\nwrote ${jsonPath}`);

  if (args.summary && !args.quiet) {
    console.log('');
    renderSummary(doc);
  } else if (gates.length) {
    console.log('\n── gates ──');
    for (const g of gates) console.log(`  ${g.pass ? 'PASS' : 'FAIL'}  ${g.id}: ${g.detail}`);
  }

  if (args.gate && gates.some((g) => !g.pass)) {
    process.exit(1);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
