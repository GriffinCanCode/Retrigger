# Retrigger: Skip Byte-Identical Rebuilds

[![npm version](https://img.shields.io/npm/v/@retrigger/core.svg)](https://www.npmjs.com/package/@retrigger/core)
[![downloads](https://img.shields.io/npm/dm/@retrigger/core.svg)](https://www.npmjs.com/package/@retrigger/core)
[![install size](https://packagephobia.com/badge?p=@retrigger/core)](https://packagephobia.com/result?p=@retrigger/core)
[![node](https://img.shields.io/node/v/@retrigger/core.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@retrigger/core.svg)](LICENSE)

![Retrigger — skip byte-identical rebuilds for Node.js, webpack and Vite](assets/retrigger-project.png)

Retrigger exists so a Vite or webpack (or Rspack, Rollup, or esbuild) dev server does
**not** rebuild when a file's bytes did not change — a formatter on save, a generator that
reran, a branch switch that restored identical contents. It watches through the platform
backend (inotify, FSEvents, `ReadDirectoryChangesW`), hashes every changed file with
XXH3-64, and withholds the event from the bundler when the digest matches.

Raw per-event latency is not the product. Measured against Chokidar on the same machine,
Retrigger is slower at delivering a single filesystem event; it trades a few milliseconds
of watch latency for skipping entire rebuilds. That is the right trade for dev-server
rebuild suppression. The watcher, hashing API, plugins, snapshots, and optional daemon are
supporting machinery for that thesis — not co-equal headline features.

A pure-JavaScript fallback takes over where no native binary exists, so that `require()`
works on every platform.

Install it from npm.

```bash
npm install @retrigger/core
```

## Contents

- [Architecture](#architecture)
- [Usage](#usage)
- [Installation](#installation)
- [Measured Performance](#measured-performance)
- [Verification](#verification)
- [The Optional Daemon](#the-optional-daemon)
- [Building from Source](#building-from-source)
- [Platform Support](#platform-support)
- [Who Should Not Be Here](#who-should-not-be-here)
- [Reporting a Problem](#reporting-a-problem)
- [License](#license)

## Architecture

Each layer below does one job.

- **`src/core`** — C implementing XXH3-64 with runtime SIMD dispatch across AVX2, SSE2,
  NEON and scalar.
- **`src/daemon/retrigger-core`** — Rust wrapping the C engine in FFI, with layout
  assertions on both sides.
- **`src/daemon/retrigger-system`** — Rust carrying the watcher itself, reaching inotify,
  FSEvents and `ReadDirectoryChangesW` through `notify`.
- **`src/daemon/retrigger-daemon`** — Rust for the optional standalone daemon, which
  speaks HTTP/JSON and SSE.
- **`src/bindings/nodejs`** — Rust and JavaScript together, carrying the N-API addon, the
  bundler plugins, and the JavaScript fallback engine.

Watching happens in-process by default.

The daemon exists only for sharing one watcher between several processes; nothing requires
it, and the npm package does not install it.

## Usage

Construct a watcher, subscribe to the events worth acting on, and start it.

```javascript
const { Retrigger } = require('@retrigger/core');

const watcher = new Retrigger({
  paths: ['./src'],
  include: ['**/*.{ts,tsx,js}'],
  exclude: ['**/node_modules/**'],
  debounceMs: 10,
});

watcher.on('add', (path) => console.log('added', path));
watcher.on('change', (path) => console.log('changed', path));
watcher.on('unlink', (path) => console.log('removed', path));

watcher.start();
```

Every event says whether the bytes actually changed, so a write that rewrote a file with the
contents it already had can be told apart from an edit:

```javascript
watcher.on('change', (path, event) => {
  if (event.contentChanged === false) return; // a formatter on save; nothing to rebuild
  rebuild(path);
});
```

That comparison is a path against its own previous digest, so it works on both engines even though
they hash with different algorithms. `contentHashing: false` turns it off; events are then delivered
without the field.

Hashing is exposed directly, and is the same engine the watcher uses.

```javascript
const {
  hashFileSync,
  hashBytesSync,
  getEngineInfo,
} = require('@retrigger/core');

hashBytesSync(Buffer.from('abc')); // '78af5f94892f3950' on the native engine
hashFileSync('./src/index.ts'); // { hash: '…', size: 1234 }
getEngineInfo(); // which engine loaded, and why
```

That digest is canonical XXH3-64 whichever engine loaded: the JavaScript engine computes the same
algorithm through a prebuilt WebAssembly module rather than a different one, so a digest from one
engine is comparable to a digest from the other. `getEngineInfo().hashAlgorithm` says which engine
you have, but both report `"xxh3-64"`.

### Bundler Plugins

webpack takes the plugin as a constructor from the `@retrigger/core/webpack` subpath.

```javascript
// webpack.config.js
const { RetriggerWebpackPlugin } = require('@retrigger/core/webpack');
module.exports = {
  plugins: [new RetriggerWebpackPlugin({ watchPaths: ['./src'] })],
};
```

Vite takes it as a factory from the `@retrigger/core/vite` subpath.

```javascript
// vite.config.js
import { createRetriggerVitePlugin } from '@retrigger/core/vite';
export default {
  plugins: [createRetriggerVitePlugin({ watchPaths: ['./src'] })],
};
```

Both plugins hash before they invalidate. A write that did not change a file's bytes is not
reported to webpack and does not reach Vite's HMR pipeline, so a formatter on save, a generator
that reran, or a branch switch that restored the same contents costs nothing. `contentHashing:
false` restores the ordinary behaviour of rebuilding on every write. The count of writes each
plugin suppressed is `metrics.eventsUnchanged`, which Vite serves at `/__retrigger_stats`.

Next.js is supported in **webpack mode** via `RetriggerWebpackPlugin`. Turbopack is not — it
exposes no public watcher or pre-rebuild veto seam; see
[`docs/upstream/turbopack-watcher-request.md`](docs/upstream/turbopack-watcher-request.md).
Integration there is deferred until Vercel ships an API. Rspack works with the same webpack
plugin; Rollup and esbuild use `@retrigger/core/rollup` and `@retrigger/core/esbuild`. Full
options, Astro, Watchman, and the chokidar adapter live in
[the package README](src/bindings/nodejs/README.md).

## Installation

The failure mode this package works hardest to avoid is an install that throws.

- **`require()` never throws** — if no native binary matches the platform, the JavaScript
  engine (`fs.watch` and the same XXH3-64 through WebAssembly) takes over, prints one warning
  line, and keeps going.
  `RETRIGGER_SILENT=1` suppresses it, and `getEngineInfo().nativeAttempts` explains what
  was tried and why each candidate was rejected.
- **No runtime dependencies** — the published tarball is 90.2 KiB across 34 entries and
  contains no native binary. The addon arrives through one of twelve platform packages
  listed as `optionalDependencies`, so a platform without one degrades instead of failing.
- **Both engines are held to one test suite** — the JavaScript fallback, a mock addon, and
  the real compiled addon each run the same parity suite, so the fallback is a substitute
  rather than an aspiration.

`npm run test:pack` performs the whole thing end to end: pack the tarball, install it into
an empty directory, require it in a clean subprocess, watch a file, and confirm the process
still exits on its own.

## Measured Performance

Numbers below come from this repository's performance lab
([`tools/benchmarks/`](tools/benchmarks/)), measured on **Apple M4 Max · darwin arm64 ·
Node v22 · native engine · XXH3-64**. They are not universal guarantees. Reproduce with:

```bash
cd tools/benchmarks && npm install && npm run bench:all
```

### Flagship: skip byte-identical rebuilds

Real Vite and webpack watch builds, same machine, same fixtures. Rebuilds are counted from
the bundler (`handleHotUpdate` / `compiler.watch`), not guessed from watcher events.

| Scenario                         | Retrigger                            | Stock watcher                           |
| -------------------------------- | ------------------------------------ | --------------------------------------- |
| Vite, 8 byte-identical writes    | **0/8** rebuilds (0 ms rebuild wall) | **8/8** (~804 ms rebuild wall)          |
| webpack, 8 byte-identical writes | **0/8** rebuilds (0 ms rebuild wall) | **8/8** (~386 ms rebuild wall)          |
| Vite / webpack, 4 real edits     | **4/4** rebuild correctly            | **4/4** rebuild correctly               |
| Burst (identical + real)         | Only the real edits rebuild          | Stock rebuilds for identical writes too |

On that run, identical writes saved **100%** of rebuild-attributable wall time versus stock
(0 vs ~804 ms Vite, 0 vs ~386 ms webpack). Observation/hash-confirm time is separate from
rebuild wall — the product metric is rebuilds that never ran.

### Honesty: raw watch latency trails Chokidar

Same-run raw FS-event latency (p50), native Retrigger vs Chokidar:

- **Chokidar** — ~0.31 ms
- **Retrigger** — ~11.80 ms

Retrigger trades a few milliseconds of per-event latency for skipping entire rebuilds.
If your bottleneck is noticing a change rather than rebuilding, stay with a lighter
watcher; if your bottleneck is rebuilds that produce identical output, that trade is the
point.

### Supporting scenarios

Also measured on the same machine class:

- Snapshot crawl of **2,000** files in ~6.3 ms
- Event storm of **2,000** writes — **0** events dropped
- Peak RSS in the webpack rebuild lab ~151 MB

### Hash throughput (supporting)

`make -C src/core bench` measures XXH3-64 through NEON on this class of machine (warm
cache). Below roughly 16 KiB, end-to-end file hashing is dominated by `open`/`read`, not
by the hash — which is why hashing every event is affordable when a rebuild costs tens or
hundreds of milliseconds.

## Verification

`make verify` runs the whole gate: lint, every test suite, the C engine under ASan/UBSan,
the fuzz targets' type check, the packaged-install proof, and a build from a pristine copy
of the tree.

Linux is proven from a macOS workstation rather than taken on faith, on both architectures.

```bash
docker build --platform linux/arm64 -f deploy/docker/Dockerfile.test -t retrigger-test .
docker run --rm --platform linux/arm64 retrigger-test
```

The build context excludes host build outputs, so nothing that passes inside the container
can be a macOS artifact that rode along. Every suite currently passes on both `linux/arm64`
and `linux/x86-64`.

- **C hash engine** — passes under NEON on arm64 and under AVX2 on x86-64.
- **C under ASan/UBSan** — passes on both.
- **Rust workspace** — passes on both.
- **Native addon artifact** — passes on both.
- **JavaScript, 389 tests** — passes on both.
- **Packaged install, 15 checks** — passes on both.

The C suite runs a differential test that hashes the same inputs through every SIMD level
the CPU offers and compares them against scalar, so "AVX2 is enabled" is a measurement
rather than an assumption.

Published XXH3-64 vectors are checked from C, from Rust, from the Node addon, and from the
JavaScript fallback's WebAssembly module — the same algorithm, the same vectors, four
independent call paths.

What the two Node engines are held to _jointly_ is more than the content-change decision now:
one suite runs against the compiled addon, a mock addon, and the JavaScript engine and checks
that all three agree on which writes changed a file's bytes, and a separate cross-engine suite
hashes a shared corpus through both real engines and asserts the digests themselves are equal,
byte for byte — not merely that each engine agrees with its own earlier digest.

### Adversarial suites and campaigns

Beyond the example tests, three tiers push the code the way a hostile file system would. They
share seeds and durations so every failure is replayable rather than a one-off.

```bash
make test-adversarial   # bounded, seeded, deterministic — safe for the PR gate
make test-chaos         # storms, fault injection, and repeated-run flake hunts
make test-fuzz          # time-budgeted libFuzzer plus a high-iteration proptest pass
```

- `test-adversarial` is the bounded subset: C metamorphic, contract, and adversarial-I/O
  proofs plus a shared-library load check; Rust queue/cache/watcher state-machine properties
  and real-filesystem race suites; and the JavaScript glob, bounded-container, content-change,
  and chunked-hash properties. It also runs inside `make test`, because the suites
  auto-discover their files; this target is the focused way to iterate on them alone.
- `test-chaos` runs the heavier storms and the `#[ignore]`-marked fault-injection cases, then
  repeats the bounded tier `CHAOS_ITERATIONS` times to hunt flakes.
- `test-fuzz` runs the C libFuzzer targets for `FUZZ_SECONDS` each and a `PROPTEST_CASES`-deep
  proptest pass.

Every knob is an environment variable, so a campaign is one line and a failing seed replays
exactly:

```bash
FUZZ_SECONDS=120 PROPTEST_CASES=65536 CHAOS_ITERATIONS=25 make test-chaos test-fuzz

# Replay a specific proptest counterexample (fast-check and proptest both print the seed):
PROPTEST_CASES=1 cargo test -p retrigger-system --lib properties
cd src/bindings/nodejs && npx vitest run test/properties.test.mjs   # seed is fixed in the file
```

The same campaigns run on demand in CI through the `campaign` workflow
(`workflow_dispatch`), which accepts the seed and duration inputs and uses only the free
standard runners — there is no scheduled job.

## The Optional Daemon

The daemon installs separately and is driven from the command line.

```bash
npm install -g @retrigger/daemon
retrigger config --output retrigger.toml
retrigger start
```

It speaks HTTP with JSON bodies and streams events over SSE, including
`GET /snapshot` for a self-describing tree inventory (the same shape as the in-process
`snapshot()` / `watchWithSnapshot()` APIs).

`retrigger validate` checks a config file before the daemon tries to run it, and
`retrigger status` reports on a running one.

The npm package ships a launcher that resolves the binary from a platform package, and
explains how to build from source when none exists rather than failing the install.

## Building from Source

Three targets cover the build, the tests, and the full gate.

```bash
make all      # C engine, Rust workspace, Node addon
make test     # every suite
make verify   # the full gate
```

Building requires a C compiler, Rust 1.88 or newer, and Node 18.17 or newer.

`libclang` is deliberately not required — the FFI declarations are hand-written and guarded
by layout assertions on both sides, so building does not depend on `bindgen`.

## Platform Support

Retrigger runs wherever Node does, though not every platform gets a native binary.
The Node package ships twelve platform optionalDependencies; each has a release job.
Verification tiers (what CI/release actually prove):

- **Executed native** — Linux x64/arm64 (gnu + musl), macOS x64/arm64, Windows x64,
  FreeBSD x64 (`vmactions/freebsd-vm`). Full suite on GitHub-hosted OS/arch legs;
  FreeBSD runs the Node package build + test + pack on a real FreeBSD guest.
- **Cross-built, executed under QEMU** — Linux armv7 (`linux-arm-gnueabihf`),
  ppc64le, s390x. Built with a free cross toolchain, then `verify-artifact` (and
  post-publish install) under QEMU.
- **Cross-built, not executed** — Windows arm64. No free arm64 Windows runner; the
  release job emits a `::warning::` and skips the smoke test (same honesty bar as
  before).
- **Anywhere else** — the `fs.watch` fallback, degraded but never broken.

See [the package README](src/bindings/nodejs/README.md#native-platform-matrix) for the
full triple → package suffix table.

## Who Should Not Be Here

This repository is the source, and most readers want the published package instead.

- **Using Retrigger in an application** — install `@retrigger/core` and read
  [the package README](src/bindings/nodejs/README.md), which carries the full API, the
  options, and the differences between the two engines.
- **Sharing one watcher between several processes** — read
  [the daemon README](src/daemon/README.md), because nothing else needs the daemon.
- **Wanting the lowest possible raw watch latency** — Retrigger is not that product; see
  [Measured Performance](#measured-performance). Use it when skipping no-op rebuilds is
  the win.

## Reporting a Problem

Everything published out of this repository is tracked in one place.

- **A bug in any package** — open an issue on
  [the issue tracker](https://github.com/GriffinCanCode/Retrigger/issues), since
  `@retrigger/core`, `@retrigger/daemon` and the platform packages are all built from this
  tree.
- **A vulnerability** — follow [the security policy](.github/SECURITY.md), which reports
  privately through GitHub Security Advisories rather than the issue tracker, and sets out
  what is in scope.
- **Slow first-event delivery** — Retrigger is not racing Chokidar on per-event latency;
  see [Measured Performance](#measured-performance). If a real edit is missed, that is a
  bug — open an issue.

## License

MIT, in [LICENSE](LICENSE).
