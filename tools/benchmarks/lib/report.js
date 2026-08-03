'use strict';

const { pad, ms, bytes, pct } = require('./stats');

/**
 * Render a human-readable summary from a results.v1 document.
 * @param {object} doc
 * @param {(line?: string) => void} [out]
 */
function renderSummary(doc, out = console.log) {
  const env = doc.env || {};
  out('Retrigger benchmark results');
  out(`  schema ${doc.schema} v${doc.schemaVersion}`);
  out(
    `  ${env.timestamp}  ${env.platform}/${env.arch}  node ${env.node}  engine=${env.engine}  hash=${env.hashAlgorithm}`
  );
  out(
    `  cpu: ${env.cpuCount}× ${env.cpuModel || '?'}  git=${env.gitSha ? env.gitSha.slice(0, 12) : 'n/a'}`
  );

  for (const suite of doc.suites || []) {
    out('');
    out(`── ${suite.name} ──`);
    if (suite.description) out(`  ${suite.description}`);

    if (suite.name === 'rebuild') {
      renderRebuild(suite, out);
      continue;
    }
    if (suite.name === 'watch') {
      renderWatch(suite, out);
      continue;
    }
    if (suite.name === 'hash') {
      renderHash(suite, out);
      continue;
    }
    if (suite.name === 'scenarios') {
      renderScenarios(suite, out);
      continue;
    }

    for (const c of suite.cases || []) {
      if (c.status !== 'ok') out(`  ${c.id}: ${c.status}${c.error ? ` (${c.error})` : ''}`);
      else out(`  ${c.id}: ok`);
    }
  }

  if (doc.gates?.length) {
    out('');
    out('── gates (same-run self-comparison only) ──');
    for (const g of doc.gates) {
      out(`  ${g.pass ? 'PASS' : 'FAIL'}  ${g.id}: ${g.detail}`);
    }
  }
  out('');
}

function renderRebuild(suite, out) {
  out(
    `  ${pad('case', 22)}  ${pad('identical', 14)}  ${pad('rebuildWall', 14)}  ${pad('real', 10)}  saved`
  );
  for (const bundler of ['vite', 'webpack']) {
    for (const mode of ['retrigger', 'stock']) {
      const c = (suite.cases || []).find((x) => x.id === `${bundler}/${mode}`);
      if (!c) continue;
      if (c.status !== 'ok') {
        out(`  ${pad(c.id, 22)}  ${c.status}: ${c.error || ''}`);
        continue;
      }
      const id = c.metrics.identical;
      const real = c.metrics.real;
      const saved = id.wallTimeSavedVsStock;
      const rebuildWall = id.rebuildWallMs ?? id.wallMs;
      out(
        `  ${pad(c.id, 22)}  ${pad(`${id.rebuilds}/${id.writes}`, 14)}  ${pad(ms(rebuildWall), 14)}  ${pad(`${real.rebuilds}/${real.edits}`, 10)}  ${saved != null ? pct(saved) : '—'}`
      );
    }
  }
}

function renderWatch(suite, out) {
  out(`  ${pad('watcher', 18)}  ${pad('p50', 10)}  ${pad('p95', 10)}  ${pad('max', 10)}  n`);
  for (const c of suite.cases || []) {
    if (c.status !== 'ok') {
      out(`  ${pad(c.watcher || c.id, 18)}  ${c.status}${c.error ? `: ${c.error}` : ''}`);
      continue;
    }
    out(
      `  ${pad(c.watcher, 18)}  ${pad(ms(c.metrics.p50), 10)}  ${pad(ms(c.metrics.p95), 10)}  ${pad(ms(c.metrics.max), 10)}  ${c.metrics.events}`
    );
  }
  const rt = (suite.cases || []).find((c) => c.watcher === 'retrigger' && c.status === 'ok');
  const ck = (suite.cases || []).find((c) => c.watcher === 'chokidar' && c.status === 'ok');
  if (rt && ck) {
    const delta = rt.metrics.p50 - ck.metrics.p50;
    out(
      `  note: retrigger p50 ${ms(rt.metrics.p50)} vs chokidar ${ms(ck.metrics.p50)}` +
        (delta > 0
          ? ` — trails by ${ms(delta)}; product win is rebuild skip, not raw latency`
          : ` — ahead by ${ms(-delta)}`)
    );
  }
}

function renderHash(suite, out) {
  out(`  ${pad('size', 10)}  ${pad('throughput', 14)}  ns/byte`);
  for (const c of suite.cases || []) {
    if (c.status !== 'ok') continue;
    out(
      `  ${pad(bytes(c.metrics.sizeBytes), 10)}  ${pad(`${c.metrics.throughputMbps.toFixed(1)} MB/s`, 14)}  ${c.metrics.nsPerByte.toFixed(3)}`
    );
  }
}

function renderScenarios(suite, out) {
  for (const c of suite.cases || []) {
    if (c.status !== 'ok') {
      out(`  ${c.id}: ${c.status}${c.error ? ` (${c.error})` : ''}`);
      continue;
    }
    const m = c.metrics;
    const rss = c.resources ? ` peakRSS=${bytes(c.resources.rssPeakBytes)}` : '';
    const cpu = c.resources ? ` cpu=${ms(c.resources.cpuTotalMs)}` : '';
    if (m.readyMs != null) out(`  ${c.id}: ready ${ms(m.readyMs)}${rss}${cpu}`);
    else if (m.wallMs != null && m.entries != null)
      out(`  ${c.id}: ${m.entries} entries in ${ms(m.wallMs)}${rss}${cpu}`);
    else if (m.delivered != null)
      out(
        `  ${c.id}: delivered=${m.delivered} unchanged=${m.contentUnchanged} dropped=${m.eventsDropped} wall=${ms(m.wallMs)}${rss}${cpu}`
      );
    else if (m.p50 != null) out(`  ${c.id}: p50=${ms(m.p50)} p95=${ms(m.p95)}${rss}`);
    else if (m.events != null) out(`  ${c.id}: events=${m.events} ready=${ms(m.readyMs)}${rss}`);
    else out(`  ${c.id}: ok${rss}${cpu}`);
  }
}

module.exports = { renderSummary };
