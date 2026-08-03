'use strict';

/**
 * Raw per-event watch latency. Honest about trailing chokidar — the product's
 * win is rebuild suppression (see the rebuild suite), not beating chokidar p50.
 */

const path = require('path');
const fs = require('fs');

const { CORE } = require('../lib/env');
const { watchFixture, rmTree } = require('../lib/fixtures');
const { sleep, nowNs, elapsedMs } = require('../lib/time');
const { summarize, pad, ms, withResources } = require('../lib/stats');
const { tryLoad, tryImport } = require('../lib/optional');

const FILE_COUNT = 200;
const SAMPLES = 40;
const WARMUP = 3;

/**
 * @param {{quiet?: boolean, samples?: number}} [opts]
 */
async function runWatchSuite(opts = {}) {
  const quiet = opts.quiet === true;
  const samples = opts.samples ?? SAMPLES;
  const log = quiet ? () => {} : (...args) => console.log(...args);
  const { createRetrigger } = require(CORE);

  const fixture = watchFixture({ fileCount: FILE_COUNT, seed: 0x71a7 });
  log(`\nwatch latency  ${FILE_COUNT} files, ${samples} samples, ${fixture.dir}`);
  log('  (raw FS event delivery — not rebuild suppression; see rebuild suite for that)');

  const harnesses = [
    {
      name: 'retrigger',
      run: (dir, onChange) => retriggerHarness(createRetrigger, dir, onChange, {}),
    },
    {
      name: 'retrigger-poll',
      run: (dir, onChange) =>
        retriggerHarness(createRetrigger, dir, onChange, {
          backend: { mode: 'poll', pollIntervalMs: 20 },
        }),
    },
    {
      name: 'retrigger-chokidar',
      run: (dir, onChange) => chokidarAdapterHarness(dir, onChange),
    },
    { name: 'chokidar', run: chokidarHarness },
    { name: 'watchpack', run: watchpackHarness },
    { name: 'parcel', run: parcelHarness },
  ];

  const cases = [];
  try {
    log(`  ${pad('watcher', 18)}  ${pad('p50', 10)}  ${pad('p95', 10)}  ${pad('max', 10)}  events`);
    for (const h of harnesses) {
      const measured = await withResources(() =>
        measure(h.name, fixture.dir, h.run, samples)
      );
      const r = measured.result;
      if (r.error) {
        const status = r.error === 'not installed' ? 'not_installed' : 'error';
        cases.push({ id: `watch/${h.name}`, watcher: h.name, status, error: r.error });
        log(`  ${pad(h.name, 18)}  ${r.error}`);
        continue;
      }
      cases.push({
        id: `watch/${h.name}`,
        watcher: h.name,
        status: 'ok',
        metrics: {
          p50: r.summary.p50,
          p95: r.summary.p95,
          p99: r.summary.p99,
          max: r.summary.max,
          mean: r.summary.mean,
          min: r.summary.min,
          events: r.summary.count,
          requested: samples,
        },
        samples: r.samples,
        resources: measured.resources,
      });
      log(
        `  ${pad(h.name, 18)}  ${pad(ms(r.summary.p50), 10)}  ${pad(ms(r.summary.p95), 10)}  ${pad(ms(r.summary.max), 10)}  ${r.summary.count}/${samples}`
      );
    }

    const rt = cases.find((c) => c.id === 'watch/retrigger' && c.status === 'ok');
    const ck = cases.find((c) => c.id === 'watch/chokidar' && c.status === 'ok');
    if (rt && ck) {
      const trail = rt.metrics.p50 - ck.metrics.p50;
      log(
        `\n  honesty check: retrigger p50 ${ms(rt.metrics.p50)} vs chokidar p50 ${ms(ck.metrics.p50)}` +
          (trail > 0
            ? ` — retrigger trails by ${ms(trail)} (expected; win is rebuild skip)`
            : ` — retrigger ahead by ${ms(-trail)}`)
      );
    }
  } finally {
    rmTree(fixture.dir);
  }

  return {
    name: 'watch',
    description: 'Per-event watch latency vs optional comparators',
    cases,
  };
}

async function measure(name, dir, harness, sampleCount) {
  let handle;
  try {
    let resolveHit = null;
    handle = await harness(dir, (changed) => {
      if (resolveHit) resolveHit(changed);
    });
    await sleep(300);

    for (let i = 0; i < WARMUP; i += 1) {
      const target = path.join(dir, `file-${i % FILE_COUNT}.js`);
      const hit = new Promise((resolve) => {
        resolveHit = resolve;
      });
      fs.writeFileSync(target, `export const v = ${Date.now()};\n`);
      await Promise.race([hit, sleep(2000)]);
      resolveHit = null;
      await sleep(20);
    }

    const samples = [];
    for (let i = 0; i < sampleCount; i += 1) {
      const target = path.join(dir, `file-${i % FILE_COUNT}.js`);
      const hit = new Promise((resolve) => {
        resolveHit = resolve;
      });
      const started = nowNs();
      fs.writeFileSync(target, `export const v = ${Date.now()};\n`);
      const winner = await Promise.race([hit, sleep(2000).then(() => null)]);
      resolveHit = null;
      if (winner === null) continue;
      samples.push(elapsedMs(started));
      await sleep(30);
    }
    if (!samples.length) return { error: 'no events observed' };
    return { samples, summary: summarize(samples) };
  } catch (err) {
    const missing = err.code === 'MODULE_NOT_FOUND' || err.code === 'ERR_MODULE_NOT_FOUND';
    return { error: missing ? 'not installed' : err.message };
  } finally {
    try {
      if (handle) await handle.close();
    } catch {
      /* nothing */
    }
  }
}

async function retriggerHarness(createRetrigger, dir, onChange, extra) {
  const watcher = createRetrigger({
    paths: dir,
    pollIntervalMs: 1,
    contentHashing: false,
    ...extra,
  });
  watcher.on('change', onChange);
  watcher.on('add', onChange);
  watcher.start();
  return { close: () => watcher.close() };
}

async function chokidarAdapterHarness(dir, onChange) {
  const adapter = require(path.join(CORE, 'lib/chokidar-adapter.js'));
  const watcher = adapter.watch(dir, {
    ignoreInitial: true,
    contentHashing: false,
    pollIntervalMs: 1,
  });
  watcher.on('change', onChange);
  watcher.on('add', onChange);
  await Promise.race([new Promise((r) => watcher.once('ready', r)), sleep(3000)]);
  return { close: () => watcher.close() };
}

async function chokidarHarness(dir, onChange) {
  const loaded = await tryImport('chokidar');
  if (!loaded.ok) throw Object.assign(new Error(loaded.error), { code: 'MODULE_NOT_FOUND' });
  const watcher = loaded.mod.watch(dir, { ignoreInitial: true });
  watcher.on('change', onChange);
  watcher.on('add', onChange);
  await Promise.race([new Promise((r) => watcher.once('ready', r)), sleep(2000)]);
  return { close: () => watcher.close() };
}

async function watchpackHarness(dir, onChange) {
  const loaded = tryLoad('watchpack');
  if (!loaded.ok) throw Object.assign(new Error(loaded.error), { code: 'MODULE_NOT_FOUND' });
  const Watchpack = loaded.mod;
  const wp = new Watchpack({ aggregateTimeout: 0, poll: false });
  wp.on('change', onChange);
  wp.watch({ files: [], directories: [dir], missing: [], startTime: Date.now() });
  return { close: () => wp.close() };
}

async function parcelHarness(dir, onChange) {
  const loaded = tryLoad('@parcel/watcher');
  if (!loaded.ok) throw Object.assign(new Error(loaded.error), { code: 'MODULE_NOT_FOUND' });
  const sub = await loaded.mod.subscribe(dir, (err, events) => {
    if (err) return;
    for (const event of events) onChange(event.path);
  });
  return { close: () => sub.unsubscribe() };
}

module.exports = { runWatchSuite };
