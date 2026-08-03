# Retrigger performance laboratory

Reproducible, machine-readable benchmarks for `@retrigger/core`.

**The thesis under test is “skip byte-identical rebuilds,” not “fastest watcher.”**
Raw per-event latency may trail Chokidar; that is measured and reported honestly.
The flagship suite is the Vite/webpack rebuild-time lab.

## Setup

```bash
cd tools/benchmarks
npm install
```

Requires the Node bindings at `src/bindings/nodejs` (native engine preferred).
Comparators (`chokidar`, `watchpack`, `@parcel/watcher`, `vite`, `webpack`) are
optional: a missing one prints `not installed` and is never estimated.

## Suites

| Suite | Command | What it measures |
| --- | --- | --- |
| **rebuild** (flagship) | `npm run bench:rebuild` | Real Vite + webpack: byte-identical / real / burst writes → rebuild counts + wall time |
| **watch** | `npm run bench:watch` | Raw FS-event latency vs chokidar / watchpack / parcel / chokidar-adapter / poll |
| **hash** | `npm run bench:hash` | XXH3 (or JS) throughput |
| **scenarios** | `npm run bench:scenarios` | Crawl/startup, CPU, peak RSS, event storms, large tree (2k files), snapshot APIs |

```bash
# All suites → JSON + same-run gates
npm run bench:all

# Or from repo root (keeps src/bindings/nodejs `npm run bench` working)
node tools/benchmarks/benchmark.js
node tools/benchmarks/benchmark.js rebuild --json tools/benchmarks/results/latest.json
node tools/benchmarks/summary.js tools/benchmarks/results/latest.json
```

## Flagship: rebuild-time lab

Boots a real Vite dev server and a real webpack watch build over deterministic
fixtures, then runs three write patterns for **retrigger** and **stock**:

1. **byte-identical rewrite** — formatter-on-save / generator rerun. Retrigger
   must produce **0** HMR updates / rebuilds; stock rebuilds every time.
2. **real edit** — both must rebuild (proves Retrigger does not drop changes).
3. **burst** — mixed identical + real; Retrigger rebuilds only for the real ones.

Rebuilds are counted by observing the bundler (`handleHotUpdate` for Vite,
`compiler.watch` callbacks for webpack), not by guessing from watcher events.

**`rebuildWallMs`** is the product metric: wall time spent waiting for rebuilds
that actually ran (≈0 with Retrigger on identical writes). Observation/settle
time is reported separately as `observationWallMs` so hash-confirm cost is not
confused with rebuild cost.

## Gates (same-run only)

`--gate` fails the process if a same-run self-comparison fails, e.g.:

- identical writes → 0 rebuilds with Retrigger
- stock watcher rebuilds on identical writes (comparison not vacuous)
- real edits rebuild on both
- ≥30% wall-time saved vs stock **in this run**

No absolute cross-machine latency numbers are gated.

## JSON output

Schema id: `retrigger.benchmarks.results.v1`  
JSON Schema: [`schema/results.v1.schema.json`](schema/results.v1.schema.json)

```json
{
  "schema": "retrigger.benchmarks.results.v1",
  "schemaVersion": 1,
  "env": {
    "timestamp": "...",
    "gitSha": "...",
    "node": "v...",
    "platform": "darwin",
    "arch": "arm64",
    "cpuModel": "...",
    "cpuCount": 8,
    "engine": "native",
    "hashAlgorithm": "xxh3-64"
  },
  "suites": [{ "name": "rebuild", "cases": [/* ... */] }],
  "gates": [{ "id": "vite.identical.zero_rebuilds", "pass": true, "detail": "..." }]
}
```

Raw latency samples are recorded under each case’s `samples` array when applicable.
Resource counters (`cpuUserMs`, `rssPeakBytes`, …) appear under `resources`.

## Fixture sizes / seeds

| Fixture | Size | Seed |
| --- | --- | --- |
| Vite / webpack rebuild apps | tiny + 8 helper modules | `0x51a7e` / `0x77ebc` |
| Watch latency dir | 200 files | `0x71a7` |
| Scenario monorepo tree | 40 × 50 = 2000 files, 256 B | `0xc0ffee` |

Warmup writes precede measured samples. Sample counts are fixed in the suite
sources (`IDENTICAL_WRITES`, `SAMPLES`, `STORM_WRITES`, …).

## Interpreting watch vs rebuild

If `watch/retrigger` p50 trails `watch/chokidar`, that is expected on many
machines: content hashing and the native pipeline add work per event. The
product claim is that those identical-byte events never reach Vite/webpack —
which is what the rebuild lab quantifies as rebuild count and wall time saved.
