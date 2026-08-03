'use strict';

/**
 * Scenario matrix: crawl/startup, CPU, peak RSS, event storms, large trees,
 * polling mode, snapshot/watchWithSnapshot, chokidar adapter.
 */

const path = require('path');
const fs = require('fs');

const { CORE } = require('../lib/env');
const { largeTree, rmTree, writeFile } = require('../lib/fixtures');
const { sleep, waitFor, waitForQuiet, nowNs, elapsedMs } = require('../lib/time');
const { summarize, withResources, pad, ms, bytes } = require('../lib/stats');
const { tryImport } = require('../lib/optional');

/** Default monorepo-scale fixture: 40 pkgs × 50 files = 2000 files. */
const TREE = { dirs: 40, filesPerDir: 50, bytesPerFile: 256, seed: 0xc0ffee };
const STORM_WRITES = 2000;
const LATENCY_SAMPLES = 30;

/**
 * @param {{quiet?: boolean, tree?: typeof TREE}} [opts]
 */
async function runScenariosSuite(opts = {}) {
  const quiet = opts.quiet === true;
  const log = quiet ? () => {} : (...args) => console.log(...args);
  const treeOpts = { ...TREE, ...opts.tree };
  const { createRetrigger } = require(CORE);

  log('\n══ scenario matrix ══');
  log(
    `  fixture: ${treeOpts.dirs} dirs × ${treeOpts.filesPerDir} files = ${treeOpts.dirs * treeOpts.filesPerDir} files (${treeOpts.bytesPerFile}B each)`
  );

  const tree = largeTree(treeOpts);
  const cases = [];

  try {
    cases.push(await scenarioCrawl(createRetrigger, tree, log));
    cases.push(await scenarioWatchWithSnapshot(createRetrigger, tree, log));
    cases.push(await scenarioStorm(createRetrigger, tree, log, { mode: 'native' }));
    cases.push(await scenarioStorm(createRetrigger, tree, log, { mode: 'poll' }));
    cases.push(await scenarioChokidarAdapter(tree, log));
    cases.push(await scenarioChokidarStock(tree, log));
    cases.push(await scenarioLargeTreeLatency(createRetrigger, tree, log));
  } finally {
    rmTree(tree.root);
  }

  log(`\n  ${pad('scenario', 28)}  ${pad('status', 8)}  highlight`);
  for (const c of cases) {
    const highlight = c.status !== 'ok' ? c.error || c.status : formatHighlight(c);
    log(`  ${pad(c.id, 28)}  ${pad(c.status, 8)}  ${highlight}`);
  }

  return {
    name: 'scenarios',
    description: 'Startup/crawl, storm, CPU/RSS, large-tree, poll, snapshot, chokidar adapter',
    cases,
  };
}

async function scenarioCrawl(createRetrigger, tree, log) {
  log('\n  [crawl] snapshot() over large tree');
  const watcher = createRetrigger({ contentHashing: false });
  try {
    const measured = await withResources(async () => {
      const t0 = nowNs();
      const snap = await watcher.snapshot(tree.root);
      return { wallMs: elapsedMs(t0), entries: snap.entries.length, algorithm: snap.algorithm };
    });
    log(
      `    snapshot: ${measured.result.entries} entries in ${ms(measured.result.wallMs)}  peakRSS=${bytes(measured.resources.rssPeakBytes)}  cpu=${ms(measured.resources.cpuTotalMs)}`
    );
    return {
      id: 'scenarios/crawl-snapshot',
      watcher: 'retrigger',
      status: 'ok',
      metrics: { ...measured.result, fileCount: tree.fileCount },
      resources: measured.resources,
    };
  } catch (err) {
    return { id: 'scenarios/crawl-snapshot', watcher: 'retrigger', status: 'error', error: err.message };
  } finally {
    watcher.close();
  }
}

async function scenarioWatchWithSnapshot(createRetrigger, tree, log) {
  log('\n  [crawl] watchWithSnapshot() — register then crawl');
  const watcher = createRetrigger({ contentHashing: false, pollIntervalMs: 1 });
  try {
    const measured = await withResources(async () => {
      const t0 = nowNs();
      watcher.start();
      const snap = await watcher.watchWithSnapshot(tree.root, true);
      const readyMs = elapsedMs(t0);
      return { readyMs, entries: snap.entries.length };
    });
    log(
      `    watchWithSnapshot ready: ${ms(measured.result.readyMs)}  entries=${measured.result.entries}  peakRSS=${bytes(measured.resources.rssPeakBytes)}`
    );
    return {
      id: 'scenarios/watch-with-snapshot',
      watcher: 'retrigger',
      status: 'ok',
      metrics: { ...measured.result, fileCount: tree.fileCount },
      resources: measured.resources,
    };
  } catch (err) {
    return {
      id: 'scenarios/watch-with-snapshot',
      watcher: 'retrigger',
      status: 'error',
      error: err.message,
    };
  } finally {
    watcher.close();
  }
}

async function scenarioStorm(createRetrigger, tree, log, { mode }) {
  const id = mode === 'poll' ? 'scenarios/storm-poll' : 'scenarios/storm-native';
  log(`\n  [storm] ${STORM_WRITES} rapid writes (${mode})`);
  const opts =
    mode === 'poll'
      ? {
          paths: tree.root,
          contentHashing: true,
          backend: { mode: 'poll', pollIntervalMs: 25, compareContents: true },
        }
      : { paths: tree.root, contentHashing: true, pollIntervalMs: 1 };
  const watcher = createRetrigger(opts);
  let delivered = 0;
  let unchanged = 0;
  let changed = 0;
  watcher.on('all', (ev) => {
    delivered += 1;
    if (ev.contentChanged === false) unchanged += 1;
    else changed += 1;
  });
  try {
    watcher.start();
    await sleep(400);

    const targets = tree.files.slice(0, Math.min(STORM_WRITES, tree.files.length));
    const measured = await withResources(async () => {
      const t0 = nowNs();
      // Half identical (rewrite same buffer), half real.
      for (let i = 0; i < targets.length; i += 1) {
        const file = targets[i];
        if (i % 2 === 0) {
          const cur = fs.readFileSync(file);
          fs.writeFileSync(file, cur);
        } else {
          fs.writeFileSync(file, `// storm ${i} ${Date.now()}\n`);
        }
      }
      await waitForQuiet(() => delivered, { quietMs: 500, timeout: 15000 });
      const wallMs = elapsedMs(t0);
      const stats = watcher.getStats();
      return {
        wallMs,
        writes: targets.length,
        delivered,
        unchanged,
        changed,
        eventsDropped: stats.eventsDropped,
        eventsQueued: stats.eventsQueued,
        filesHashed: stats.content?.filesHashed ?? 0,
        contentUnchanged: stats.content?.unchanged ?? 0,
      };
    });

    log(
      `    writes=${measured.result.writes} delivered=${measured.result.delivered} unchanged=${measured.result.contentUnchanged} dropped=${measured.result.eventsDropped} wall=${ms(measured.result.wallMs)} cpu=${ms(measured.resources.cpuTotalMs)} peakRSS=${bytes(measured.resources.rssPeakBytes)}`
    );
    return {
      id,
      watcher: mode === 'poll' ? 'retrigger-poll' : 'retrigger',
      status: 'ok',
      metrics: measured.result,
      resources: measured.resources,
    };
  } catch (err) {
    return { id, watcher: 'retrigger', status: 'error', error: err.message };
  } finally {
    watcher.close();
  }
}

async function scenarioChokidarAdapter(tree, log) {
  log('\n  [adapter] @retrigger/core/chokidar over large tree + storm sample');
  try {
    const adapter = require(path.join(CORE, 'lib/chokidar-adapter.js'));
    let ready = false;
    let events = 0;
    const measured = await withResources(async () => {
      const t0 = nowNs();
      const watcher = adapter.watch(tree.root, {
        ignoreInitial: true,
        contentHashing: true,
      });
      watcher.on('ready', () => {
        ready = true;
      });
      watcher.on('all', () => {
        events += 1;
      });
      await waitFor(() => ready, { timeout: 30000, message: 'chokidar adapter ready' });
      const readyMs = elapsedMs(t0);

      const sample = tree.files.slice(0, 200);
      const stormStart = nowNs();
      for (let i = 0; i < sample.length; i += 1) {
        if (i % 2 === 0) fs.writeFileSync(sample[i], fs.readFileSync(sample[i]));
        else fs.writeFileSync(sample[i], `// adapter ${i}\n`);
      }
      await waitForQuiet(() => events, { quietMs: 400, timeout: 10000 });
      const stormMs = elapsedMs(stormStart);
      await watcher.close();
      return { readyMs, stormMs, writes: sample.length, events };
    });
    log(
      `    ready=${ms(measured.result.readyMs)} storm events=${measured.result.events}/${measured.result.writes} in ${ms(measured.result.stormMs)} peakRSS=${bytes(measured.resources.rssPeakBytes)}`
    );
    return {
      id: 'scenarios/chokidar-adapter',
      watcher: 'retrigger-chokidar',
      status: 'ok',
      metrics: measured.result,
      resources: measured.resources,
    };
  } catch (err) {
    return {
      id: 'scenarios/chokidar-adapter',
      watcher: 'retrigger-chokidar',
      status: 'error',
      error: err.message,
    };
  }
}

async function scenarioChokidarStock(tree, log) {
  log('\n  [comparator] stock chokidar crawl+storm (optional)');
  const loaded = await tryImport('chokidar');
  if (!loaded.ok) {
    log(`    chokidar: ${loaded.error}`);
    return {
      id: 'scenarios/chokidar-stock',
      watcher: 'chokidar',
      status: 'not_installed',
      error: loaded.error,
    };
  }
  try {
    let ready = false;
    let events = 0;
    const measured = await withResources(async () => {
      const t0 = nowNs();
      const watcher = loaded.mod.watch(tree.root, { ignoreInitial: true });
      watcher.on('ready', () => {
        ready = true;
      });
      watcher.on('all', () => {
        events += 1;
      });
      await waitFor(() => ready, { timeout: 60000, message: 'chokidar ready' });
      const readyMs = elapsedMs(t0);
      const sample = tree.files.slice(0, 200);
      const stormStart = nowNs();
      for (let i = 0; i < sample.length; i += 1) {
        fs.writeFileSync(sample[i], `// chokidar ${i} ${Date.now()}\n`);
      }
      await waitForQuiet(() => events, { quietMs: 400, timeout: 15000 });
      const stormMs = elapsedMs(stormStart);
      await watcher.close();
      return { readyMs, stormMs, writes: sample.length, events };
    });
    log(
      `    ready=${ms(measured.result.readyMs)} storm events=${measured.result.events}/${measured.result.writes} in ${ms(measured.result.stormMs)} peakRSS=${bytes(measured.resources.rssPeakBytes)}`
    );
    return {
      id: 'scenarios/chokidar-stock',
      watcher: 'chokidar',
      status: 'ok',
      metrics: measured.result,
      resources: measured.resources,
    };
  } catch (err) {
    return {
      id: 'scenarios/chokidar-stock',
      watcher: 'chokidar',
      status: 'error',
      error: err.message,
    };
  }
}

async function scenarioLargeTreeLatency(createRetrigger, tree, log) {
  log(`\n  [latency] ${LATENCY_SAMPLES} samples on large tree`);
  const watcher = createRetrigger({
    paths: tree.root,
    contentHashing: false,
    pollIntervalMs: 1,
  });
  let resolveHit = null;
  watcher.on('change', (p) => {
    if (resolveHit) resolveHit(p);
  });
  try {
    watcher.start();
    await sleep(500);
    const measured = await withResources(async () => {
      const samples = [];
      for (let i = 0; i < LATENCY_SAMPLES; i += 1) {
        const target = tree.files[i % tree.files.length];
        const hit = new Promise((resolve) => {
          resolveHit = resolve;
        });
        const t0 = nowNs();
        writeFile(target, `// latency ${i} ${Date.now()}\n`);
        const winner = await Promise.race([hit, sleep(3000).then(() => null)]);
        resolveHit = null;
        if (winner !== null) samples.push(elapsedMs(t0));
        await sleep(30);
      }
      return { samples, summary: summarize(samples) };
    });
    if (!measured.result.summary) {
      return {
        id: 'scenarios/large-tree-latency',
        watcher: 'retrigger',
        status: 'error',
        error: 'no events observed',
      };
    }
    log(
      `    p50=${ms(measured.result.summary.p50)} p95=${ms(measured.result.summary.p95)} n=${measured.result.summary.count} peakRSS=${bytes(measured.resources.rssPeakBytes)}`
    );
    return {
      id: 'scenarios/large-tree-latency',
      watcher: 'retrigger',
      status: 'ok',
      metrics: measured.result.summary,
      samples: measured.result.samples,
      resources: measured.resources,
    };
  } catch (err) {
    return {
      id: 'scenarios/large-tree-latency',
      watcher: 'retrigger',
      status: 'error',
      error: err.message,
    };
  } finally {
    watcher.close();
  }
}

function formatHighlight(c) {
  const m = c.metrics || {};
  if (m.readyMs != null) return `ready ${ms(m.readyMs)}`;
  if (m.wallMs != null && m.entries != null) return `${m.entries} entries / ${ms(m.wallMs)}`;
  if (m.delivered != null) return `delivered ${m.delivered}, drop ${m.eventsDropped}`;
  if (m.p50 != null) return `p50 ${ms(m.p50)} p95 ${ms(m.p95)}`;
  if (m.events != null) return `events ${m.events}`;
  return '';
}

module.exports = { runScenariosSuite };
