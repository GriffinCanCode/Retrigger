#!/usr/bin/env node
'use strict';

/**
 * Retrigger benchmarks.
 *
 * Replaces six earlier scripts that were written against `RetriggerWrapper`
 * and a `/tmp` mmap IPC bridge, neither of which exists any more.
 *
 * Every number printed is measured in this process, now. Comparators
 * (chokidar, watchpack, @parcel/watcher) are optional: a missing one is
 * reported as "not installed" rather than silently skipped or estimated.
 *
 *   node tools/benchmarks/benchmark.js            # both suites
 *   node tools/benchmarks/benchmark.js hash
 *   node tools/benchmarks/benchmark.js watch
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const CORE = path.resolve(__dirname, '../../src/bindings/nodejs');
const { benchmarkHash, createRetrigger, getEngineInfo } = require(CORE);

const FILE_COUNT = 200;
const SAMPLES = 40;

async function hashSuite() {
  const info = getEngineInfo();
  console.log(`\nhash throughput  engine=${info.engine}  algorithm=${info.hashAlgorithm}`);
  console.log('  size      throughput      ns/byte');
  for (const size of [1024, 64 * 1024, 1024 * 1024, 16 * 1024 * 1024]) {
    const iterations = Math.max(4, Math.floor(64 * 1024 * 1024 / size));
    const result = await benchmarkHash(size, iterations);
    console.log(
      `  ${pad(bytes(size), 8)}  ${pad(`${result.throughputMbps.toFixed(1)} MB/s`, 14)}  ${result.nsPerByte.toFixed(3)}`
    );
  }
}

async function watchSuite() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retrigger-bench-'));
  try {
    for (let i = 0; i < FILE_COUNT; i += 1) {
      fs.writeFileSync(path.join(dir, `file-${i}.js`), `export const v = ${i};\n`);
    }

    console.log(`\nwatch latency  ${FILE_COUNT} files, ${SAMPLES} samples, ${dir}`);
    const results = [];
    results.push(await measure('retrigger', dir, retriggerHarness));
    results.push(await measure('chokidar', dir, chokidarHarness));
    results.push(await measure('watchpack', dir, watchpackHarness));
    results.push(await measure('parcel', dir, parcelHarness));

    console.log('  watcher      p50        p95        max        events');
    for (const r of results) {
      if (r.error) {
        console.log(`  ${pad(r.name, 11)}  ${r.error}`);
        continue;
      }
      console.log(
        `  ${pad(r.name, 11)}  ${pad(ms(r.p50), 9)}  ${pad(ms(r.p95), 9)}  ${pad(ms(r.max), 9)}  ${r.count}/${SAMPLES}`
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Times the wall gap between writing a file and the watcher reporting it.
 * @param {string} name
 * @param {string} dir
 * @param {(dir: string, onChange: (p: string) => void) => Promise<{close: () => unknown}>} harness
 */
async function measure(name, dir, harness) {
  let handle;
  try {
    let resolveHit = null;
    handle = await harness(dir, (changed) => {
      if (resolveHit) resolveHit(changed);
    });
    await sleep(300); // let the watcher finish its initial scan

    const samples = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      const target = path.join(dir, `file-${i % FILE_COUNT}.js`);
      const hit = new Promise((resolve) => {
        resolveHit = resolve;
      });
      const started = process.hrtime.bigint();
      fs.writeFileSync(target, `export const v = ${Date.now()};\n`);
      const winner = await Promise.race([hit, sleep(2000).then(() => null)]);
      resolveHit = null;
      if (winner === null) continue;
      samples.push(Number(process.hrtime.bigint() - started) / 1e6);
      await sleep(30);
    }
    if (samples.length === 0) return { name, error: 'no events observed' };
    samples.sort((a, b) => a - b);
    return {
      name,
      p50: samples[Math.floor(samples.length * 0.5)],
      p95: samples[Math.floor(samples.length * 0.95)] ?? samples[samples.length - 1],
      max: samples[samples.length - 1],
      count: samples.length,
    };
  } catch (err) {
    const missing = err.code === 'MODULE_NOT_FOUND' || err.code === 'ERR_MODULE_NOT_FOUND';
    return { name, error: missing ? 'not installed' : err.message };
  } finally {
    try {
      if (handle) await handle.close();
    } catch {
      /* nothing to clean up */
    }
  }
}

async function retriggerHarness(dir, onChange) {
  const watcher = createRetrigger({ paths: dir, pollIntervalMs: 1 });
  watcher.on('change', onChange);
  watcher.on('add', onChange);
  watcher.start();
  return { close: () => watcher.close() };
}

async function chokidarHarness(dir, onChange) {
  const { watch } = await import('chokidar'); // v5 is ESM-only
  const watcher = watch(dir, { ignoreInitial: true });
  watcher.on('change', onChange);
  watcher.on('add', onChange);
  await Promise.race([new Promise((r) => watcher.once('ready', r)), sleep(2000)]);
  return { close: () => watcher.close() };
}

async function watchpackHarness(dir, onChange) {
  const Watchpack = require('watchpack');
  const wp = new Watchpack({ aggregateTimeout: 0, poll: false });
  wp.on('change', onChange);
  wp.watch({ files: [], directories: [dir], missing: [], startTime: Date.now() });
  return { close: () => wp.close() };
}

async function parcelHarness(dir, onChange) {
  const parcel = require('@parcel/watcher');
  const sub = await parcel.subscribe(dir, (err, events) => {
    if (err) return;
    for (const event of events) onChange(event.path);
  });
  return { close: () => sub.unsubscribe() };
}

const sleep = (msValue) => new Promise((resolve) => setTimeout(resolve, msValue));
const pad = (value, width) => String(value).padEnd(width);
const ms = (value) => `${value.toFixed(2)}ms`;
const bytes = (value) =>
  value >= 1024 * 1024 ? `${value / 1024 / 1024}MB` : `${value / 1024}KB`;

async function main() {
  const which = process.argv[2];
  const info = getEngineInfo();
  console.log(`retrigger benchmark  ${info.engine} engine on ${info.platform}`);
  if (info.engine !== 'native') console.log(`  native unavailable: ${info.reason}`);
  if (!which || which === 'hash') await hashSuite();
  if (!which || which === 'watch') await watchSuite();
  console.log('');
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
