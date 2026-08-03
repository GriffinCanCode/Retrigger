'use strict';

/**
 * Flagship rebuild-time lab.
 *
 * Thesis under measurement: Retrigger skips byte-identical rebuilds.
 * Not "fastest watcher" — rebuild counts and rebuild-attributable wall time
 * for Vite HMR / webpack watch over real bundlers.
 *
 * `rebuildWallMs` is the product metric: time spent waiting for rebuilds that
 * actually ran. Observation/settle time (hashing, quiet windows) is reported
 * separately as `observationWallMs` so confirmation cost is not confused with
 * rebuild cost.
 */

const path = require('path');

const { CORE } = require('../lib/env');
const { viteFixture, webpackFixture, writeFile, rmTree } = require('../lib/fixtures');
const { sleep, waitFor, waitForQuiet, nowNs, elapsedMs } = require('../lib/time');
const { withResources, pad, ms, pct } = require('../lib/stats');
const { tryImport, tryLoad } = require('../lib/optional');

const IDENTICAL_WRITES = 8;
const REAL_EDITS = 4;
const BURST_IDENTICAL = 6;
const BURST_REAL = 3;
const WARMUP = 1;

/**
 * @param {{quiet?: boolean}} [opts]
 */
async function runRebuildSuite(opts = {}) {
  const quiet = opts.quiet === true;
  const log = quiet ? () => {} : (...args) => console.log(...args);

  log('\n══ rebuild-time lab (flagship) ══');
  log('  thesis: skip byte-identical rebuilds — not raw watcher latency');
  log('  metric: rebuildWallMs = time waiting for rebuilds that actually ran');

  const cases = [];
  const gates = [];

  const viteMod = await tryImport('vite');
  if (!viteMod.ok) {
    cases.push({ id: 'vite', watcher: 'vite', status: 'not_installed', error: viteMod.error });
    log(`  vite: ${viteMod.error}`);
  } else {
    const viteResult = await withResources(() => measureVite(viteMod.mod, log));
    cases.push(...viteResult.result.cases);
    gates.push(...viteResult.result.gates);
    for (const c of viteResult.result.cases) {
      if (c.status === 'ok') c.resources = viteResult.resources;
    }
  }

  const wpMod = tryLoad('webpack');
  if (!wpMod.ok) {
    cases.push({ id: 'webpack', watcher: 'webpack', status: 'not_installed', error: wpMod.error });
    log(`  webpack: ${wpMod.error}`);
  } else {
    const wpResult = await withResources(() => measureWebpack(wpMod.mod, log));
    cases.push(...wpResult.result.cases);
    gates.push(...wpResult.result.gates);
    for (const c of wpResult.result.cases) {
      if (c.status === 'ok') c.resources = wpResult.resources;
    }
  }

  printRebuildSummary(cases, log);
  return {
    name: 'rebuild',
    description:
      'End-to-end Vite/webpack rebuild counts and rebuild-attributable wall time for identical/real/burst writes',
    cases,
    gates,
  };
}

async function measureVite(vite, log) {
  const { createServer } = vite;
  const { createRetriggerVitePlugin } = require(path.join(CORE, 'plugins/vite-plugin.js'));
  const cases = [];
  const gates = [];

  for (const mode of ['retrigger', 'stock']) {
    const project = viteFixture({ seed: 0x51a7e });
    try {
      log(`\n  [vite/${mode}] root=${project.dir}`);
      const hotUpdates = [];
      const spy = {
        name: 'bench-spy',
        handleHotUpdate(ctx) {
          hotUpdates.push({ file: ctx.file, at: Date.now() });
        },
      };
      const plugin =
        mode === 'retrigger'
          ? createRetriggerVitePlugin({ debounceMs: 0, contentHashing: true })
          : null;
      const server = await createServer({
        root: project.dir,
        configFile: false,
        logLevel: 'silent',
        server: { port: 0, host: '127.0.0.1', hmr: { port: 0 } },
        plugins: mode === 'retrigger' ? [plugin, spy] : [spy],
        optimizeDeps: { noDiscovery: true, include: [] },
      });
      await server.listen();
      try {
        if (mode === 'retrigger') {
          await waitFor(() => plugin.api.isWatching(), {
            timeout: 15000,
            message: 'retrigger vite watcher ready',
          });
        } else {
          await sleep(400);
        }
        await server.transformRequest('/main.js');
        await server.transformRequest('/mod.js');

        for (let w = 0; w < WARMUP; w += 1) {
          writeFile(project.mod, `export const n = ${100 + w};\n`);
          await waitFor(() => hotUpdates.length > w, {
            timeout: 15000,
            message: 'vite warmup HMR',
          });
        }
        await waitForQuiet(() => hotUpdates.length, { quietMs: 400, timeout: 5000 });
        hotUpdates.length = 0;

        const identical = await runIdenticalPattern({
          mode,
          writes: IDENTICAL_WRITES,
          write: () => writeFile(project.mod, 'export const n = 42;\n'),
          prime: async () => {
            writeFile(project.mod, 'export const n = 42;\n');
            await waitFor(() => hotUpdates.length >= 1, {
              timeout: 15000,
              message: 'vite prime identical baseline',
            });
            await waitForQuiet(() => hotUpdates.length, { quietMs: 400, timeout: 5000 });
            hotUpdates.length = 0;
          },
          rebuildCount: () => hotUpdates.length,
          waitRebuild: async (before) => {
            await waitFor(() => hotUpdates.length > before, {
              timeout: 15000,
              message: 'vite stock identical HMR',
            });
          },
          observeSuppressed: async () => {
            const before = plugin.api.getStats().watcher?.content?.filesHashed ?? 0;
            await waitFor(
              () => (plugin.api.getStats().watcher?.content?.filesHashed ?? 0) > before,
              { timeout: 10000, message: 'identical write hashed' }
            );
          },
        });

        const real = await runRealPattern({
          write: (i) => writeFile(project.mod, `export const n = ${200 + i};\n`),
          rebuildCount: () => hotUpdates.length,
          waitRebuild: async (expected) => {
            await waitFor(() => hotUpdates.length >= expected, {
              timeout: 15000,
              message: `vite real edit HMR #${expected}`,
            });
          },
          settle: () => waitForQuiet(() => hotUpdates.length, { quietMs: 300, timeout: 4000 }),
          edits: REAL_EDITS,
          baseline: () => {
            hotUpdates.length = 0;
          },
        });

        const burst = await runBurstPattern({
          mode,
          writeIdentical: () => writeFile(project.mod, 'export const n = 777;\n'),
          writeReal: (i) => writeFile(project.mod, `export const n = ${800 + i};\n`),
          prime: async () => {
            writeFile(project.mod, 'export const n = 777;\n');
            await waitFor(() => hotUpdates.length >= 1, { timeout: 15000, message: 'burst prime' });
            await waitForQuiet(() => hotUpdates.length, { quietMs: 350, timeout: 4000 });
            hotUpdates.length = 0;
          },
          rebuildCount: () => hotUpdates.length,
          waitRebuild: async (expected) => {
            await waitFor(() => hotUpdates.length >= expected, {
              timeout: 15000,
              message: `burst real #${expected}`,
            });
          },
          observeSuppressed: async () => {
            const before = plugin.api.getStats().watcher?.content?.filesHashed ?? 0;
            await waitFor(
              () => (plugin.api.getStats().watcher?.content?.filesHashed ?? 0) > before,
              { timeout: 10000, message: 'burst identical hashed' }
            );
          },
        });

        cases.push(
          okCase('vite', mode, identical, real, burst, 'handleHotUpdate', identical.perWriteMs)
        );
        logIdentical(log, identical, real, burst);
      } finally {
        await server.close();
      }
    } catch (err) {
      cases.push(errCase('vite', mode, err));
      log(`    ERROR: ${err.message}`);
    } finally {
      rmTree(project.dir);
    }
  }

  gates.push(...compareGates('vite', cases));
  return { cases, gates };
}

async function measureWebpack(webpack, log) {
  const RetriggerWebpackPlugin = require(path.join(CORE, 'plugins/webpack-plugin.js'));
  const cases = [];
  const gates = [];

  for (const mode of ['retrigger', 'stock']) {
    const project = webpackFixture({ seed: 0x77ebc });
    try {
      log(`\n  [webpack/${mode}] root=${project.dir}`);
      const plugin =
        mode === 'retrigger'
          ? new RetriggerWebpackPlugin({
              watchPaths: [project.src],
              aggregateTimeout: 10,
              contentHashing: true,
            })
          : null;

      const compiler = webpack({
        mode: 'development',
        devtool: false,
        context: project.dir,
        entry: project.entry,
        output: { path: path.join(project.dir, 'dist'), filename: 'bundle.js' },
        plugins: plugin ? [plugin] : [],
        infrastructureLogging: { level: 'error' },
        stats: 'errors-only',
      });

      /** @type {object[]} */
      const builds = [];
      const watching = compiler.watch({ aggregateTimeout: 10, poll: false }, (err, stats) => {
        if (!err && stats) builds.push({ at: Date.now(), hash: stats.hash });
      });

      try {
        await waitFor(() => builds.length >= 1, {
          timeout: 30000,
          message: 'webpack initial build',
        });

        const sentinel = path.join(project.src, 'live.probe.js');
        await waitFor(
          () => {
            writeFile(sentinel, `export const probe = ${Date.now()};\n`);
            if (mode === 'retrigger') return plugin.fileTimeInfo.has(sentinel);
            return builds.length >= 2;
          },
          { timeout: 20000, interval: 50, message: 'webpack watcher live' }
        );
        await waitForQuiet(() => builds.length, { quietMs: 400, timeout: 5000 });

        for (let w = 0; w < WARMUP; w += 1) {
          const before = builds.length;
          writeFile(project.dep, `export const value = ${10 + w};\n`);
          await waitFor(() => builds.length > before, {
            timeout: 20000,
            message: 'webpack warmup rebuild',
          });
        }
        await waitForQuiet(() => builds.length, { quietMs: 400, timeout: 5000 });

        let rebuildBaseline = builds.length;
        const identical = await runIdenticalPattern({
          mode,
          writes: IDENTICAL_WRITES,
          write: () => writeFile(project.dep, 'export const value = 4242;\n'),
          prime: async () => {
            const before = builds.length;
            writeFile(project.dep, 'export const value = 4242;\n');
            await waitFor(() => builds.length > before, {
              timeout: 20000,
              message: 'webpack prime identical',
            });
            await waitForQuiet(() => builds.length, { quietMs: 400, timeout: 5000 });
            rebuildBaseline = builds.length;
          },
          rebuildCount: () => builds.length - rebuildBaseline,
          waitRebuild: async (before) => {
            await waitFor(() => builds.length - rebuildBaseline > before, {
              timeout: 20000,
              message: 'webpack stock identical rebuild',
            });
          },
          observeSuppressed: async () => {
            const hashedBefore = plugin.getStats()?.content?.filesHashed ?? 0;
            await waitFor(
              () => (plugin.getStats()?.content?.filesHashed ?? 0) > hashedBefore,
              { timeout: 10000, message: 'webpack identical hashed' }
            );
          },
        });

        const buildsBeforeReal = builds.length;
        const real = await runRealPattern({
          write: (i) => writeFile(project.dep, `export const value = ${200 + i};\n`),
          rebuildCount: () => builds.length - buildsBeforeReal,
          waitRebuild: async (expected) => {
            await waitFor(() => builds.length - buildsBeforeReal >= expected, {
              timeout: 20000,
              message: `webpack real rebuild #${expected}`,
            });
          },
          settle: () => waitForQuiet(() => builds.length, { quietMs: 350, timeout: 5000 }),
          edits: REAL_EDITS,
          baseline: () => {},
        });

        let burstBaseline = builds.length;
        const burst = await runBurstPattern({
          mode,
          writeIdentical: () => writeFile(project.dep, 'export const value = 777;\n'),
          writeReal: (i) => writeFile(project.dep, `export const value = ${800 + i};\n`),
          prime: async () => {
            const before = builds.length;
            writeFile(project.dep, 'export const value = 777;\n');
            await waitFor(() => builds.length > before, { timeout: 20000, message: 'burst prime' });
            await waitForQuiet(() => builds.length, { quietMs: 400, timeout: 5000 });
            burstBaseline = builds.length;
          },
          rebuildCount: () => builds.length - burstBaseline,
          waitRebuild: async (expected) => {
            await waitFor(() => builds.length - burstBaseline >= expected, {
              timeout: 20000,
              message: `webpack burst real #${expected}`,
            });
          },
          observeSuppressed: async () => {
            const before = plugin.getStats()?.content?.filesHashed ?? 0;
            await waitFor(
              () => (plugin.getStats()?.content?.filesHashed ?? 0) > before,
              { timeout: 10000, message: 'webpack burst identical hashed' }
            );
          },
        });

        cases.push(
          okCase('webpack', mode, identical, real, burst, 'compiler.watch', identical.perWriteMs)
        );
        logIdentical(log, identical, real, burst);
      } finally {
        await new Promise((resolve) => {
          watching.close(() => compiler.close(() => resolve()));
        });
      }
    } catch (err) {
      cases.push(errCase('webpack', mode, err));
      log(`    ERROR: ${err.message}`);
    } finally {
      rmTree(project.dir);
    }
  }

  gates.push(...compareGates('webpack', cases));
  return { cases, gates };
}

/**
 * Identical writes. Stock waits for each rebuild (rebuildWallMs accumulates).
 * Retrigger waits only for hash classification; rebuildWallMs stays 0 when
 * suppression works. A final quiet window catches false-positive rebuilds.
 */
async function runIdenticalPattern(opts) {
  await opts.prime();
  const baseline = opts.rebuildCount();
  const perWriteMs = [];
  const rebuildSamples = [];
  let rebuildWallMs = 0;
  let observationWallMs = 0;
  const wallStart = nowNs();

  for (let i = 0; i < opts.writes; i += 1) {
    const before = opts.rebuildCount();
    const t0 = nowNs();
    opts.write();
    if (opts.mode === 'retrigger') {
      await opts.observeSuppressed();
      observationWallMs += elapsedMs(t0);
      perWriteMs.push(elapsedMs(t0));
    } else {
      await opts.waitRebuild(before);
      const dt = elapsedMs(t0);
      rebuildWallMs += dt;
      rebuildSamples.push(dt);
      perWriteMs.push(dt);
    }
  }

  // Confirm no late rebuilds (retrigger) / drain residual (stock).
  const settleStart = nowNs();
  await waitForQuiet(() => opts.rebuildCount(), { quietMs: 400, timeout: 4000 });
  observationWallMs += elapsedMs(settleStart);

  return {
    writes: opts.writes,
    rebuilds: Math.max(0, opts.rebuildCount() - baseline),
    rebuildWallMs,
    observationWallMs,
    wallMs: elapsedMs(wallStart),
    perWriteMs,
    rebuildSamples,
  };
}

async function runRealPattern(opts) {
  opts.baseline();
  const perEditMs = [];
  const wallStart = nowNs();
  for (let i = 0; i < opts.edits; i += 1) {
    const t0 = nowNs();
    opts.write(i);
    await opts.waitRebuild(i + 1);
    perEditMs.push(elapsedMs(t0));
  }
  await opts.settle();
  return {
    edits: opts.edits,
    rebuilds: opts.rebuildCount(),
    wallMs: elapsedMs(wallStart),
    perEditMs,
  };
}

async function runBurstPattern(opts) {
  await opts.prime();
  const wallStart = nowNs();
  let expectedReal = 0;
  for (let i = 0; i < BURST_IDENTICAL + BURST_REAL; i += 1) {
    if (i % 3 === 2) {
      expectedReal += 1;
      opts.writeReal(i);
      await opts.waitRebuild(expectedReal);
    } else {
      opts.writeIdentical();
      if (opts.mode === 'retrigger') await opts.observeSuppressed();
      else await sleep(60);
      await waitForQuiet(() => opts.rebuildCount(), { quietMs: 200, timeout: 2000 });
    }
  }
  await waitForQuiet(() => opts.rebuildCount(), { quietMs: 400, timeout: 4000 });
  return {
    identicalWrites: BURST_IDENTICAL,
    realEdits: BURST_REAL,
    rebuilds: opts.rebuildCount(),
    expectedRebuilds: opts.mode === 'retrigger' ? BURST_REAL : BURST_IDENTICAL + BURST_REAL,
    wallMs: elapsedMs(wallStart),
  };
}

function okCase(bundler, mode, identical, real, burst, counter, samples) {
  return {
    id: `${bundler}/${mode}`,
    watcher: mode === 'retrigger' ? `retrigger-${bundler}` : `${bundler}-stock`,
    status: 'ok',
    metrics: {
      bundler,
      mode,
      identical,
      real,
      burst,
      note:
        mode === 'retrigger'
          ? `content-hash gate; rebuilds via ${counter}; rebuildWallMs is rebuild-attributable`
          : `stock watcher; rebuilds via ${counter}; rebuildWallMs sums write→rebuild waits`,
    },
    samples,
  };
}

function errCase(bundler, mode, err) {
  return {
    id: `${bundler}/${mode}`,
    watcher: mode === 'retrigger' ? `retrigger-${bundler}` : `${bundler}-stock`,
    status: 'error',
    error: err.message,
  };
}

function compareGates(bundler, cases) {
  const gates = [];
  const rt = cases.find((c) => c.id === `${bundler}/retrigger` && c.status === 'ok');
  const st = cases.find((c) => c.id === `${bundler}/stock` && c.status === 'ok');
  if (!rt || !st) return gates;

  const idR = rt.metrics.identical.rebuilds;
  const idS = st.metrics.identical.rebuilds;
  // Product metric: fraction of stock rebuild-attributable time avoided.
  const stockRebuild = st.metrics.identical.rebuildWallMs;
  const rtRebuild = rt.metrics.identical.rebuildWallMs;
  const saved = stockRebuild > 0 ? (stockRebuild - rtRebuild) / stockRebuild : null;

  gates.push({
    id: `${bundler}.identical.zero_rebuilds`,
    pass: idR === 0,
    detail: `retrigger identical rebuilds=${idR} (must be 0); stock=${idS}`,
  });
  gates.push({
    id: `${bundler}.identical.stock_rebuilds`,
    pass: idS > 0,
    detail: `stock must rebuild on identical writes (got ${idS}) — otherwise comparison is vacuous`,
  });
  gates.push({
    id: `${bundler}.real.both_rebuild`,
    pass: rt.metrics.real.rebuilds >= REAL_EDITS && st.metrics.real.rebuilds >= REAL_EDITS,
    detail: `retrigger real=${rt.metrics.real.rebuilds}, stock real=${st.metrics.real.rebuilds} (need ≥${REAL_EDITS})`,
  });
  gates.push({
    id: `${bundler}.identical.rebuild_wall_saved`,
    pass: saved != null && saved >= 0.9,
    detail: `rebuild-attributable wall saved vs stock: ${pct(saved)} (gate ≥90%; stock=${ms(stockRebuild)}, retrigger=${ms(rtRebuild)})`,
  });
  // Burst: retrigger rebuilds must equal real edits (no extras from identical).
  gates.push({
    id: `${bundler}.burst.only_real`,
    pass: rt.metrics.burst.rebuilds === BURST_REAL,
    detail: `retrigger burst rebuilds=${rt.metrics.burst.rebuilds} (must equal real edits=${BURST_REAL})`,
  });

  if (saved != null) {
    rt.metrics.identical.wallTimeSavedVsStock = saved;
    rt.metrics.identical.stockRebuildWallMs = stockRebuild;
  }
  return gates;
}

function logIdentical(log, identical, real, burst) {
  log(
    `    identical: ${identical.rebuilds}/${identical.writes} rebuilds  rebuildWall=${ms(identical.rebuildWallMs)}  observe=${ms(identical.observationWallMs)}`
  );
  log(`    real:      ${real.rebuilds}/${real.edits} rebuilds in ${ms(real.wallMs)}`);
  log(
    `    burst:     ${burst.rebuilds} rebuilds (expect ~${burst.expectedRebuilds}) in ${ms(burst.wallMs)}`
  );
}

function printRebuildSummary(cases, log) {
  log('\n  flagship summary (identical → rebuilds / rebuild-attributable wall)');
  log(
    `  ${pad('case', 22)}  ${pad('rebuilds', 12)}  ${pad('rebuildWall', 14)}  saved vs stock`
  );
  for (const bundler of ['vite', 'webpack']) {
    const rt = cases.find((c) => c.id === `${bundler}/retrigger` && c.status === 'ok');
    const st = cases.find((c) => c.id === `${bundler}/stock` && c.status === 'ok');
    if (!rt && !st) continue;
    if (rt) {
      const saved = rt.metrics.identical.wallTimeSavedVsStock;
      log(
        `  ${pad(`${bundler}/retrigger`, 22)}  ${pad(`${rt.metrics.identical.rebuilds}/${rt.metrics.identical.writes}`, 12)}  ${pad(ms(rt.metrics.identical.rebuildWallMs), 14)}  ${saved != null ? pct(saved) : 'n/a'}`
      );
    }
    if (st) {
      log(
        `  ${pad(`${bundler}/stock`, 22)}  ${pad(`${st.metrics.identical.rebuilds}/${st.metrics.identical.writes}`, 12)}  ${pad(ms(st.metrics.identical.rebuildWallMs), 14)}  —`
      );
    }
  }
}

module.exports = { runRebuildSuite };
