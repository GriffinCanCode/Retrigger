# Retrigger: A File System Watcher for Node.js

[![npm version](https://img.shields.io/npm/v/@retrigger/core.svg)](https://www.npmjs.com/package/@retrigger/core)
[![downloads](https://img.shields.io/npm/dm/@retrigger/core.svg)](https://www.npmjs.com/package/@retrigger/core)
[![install size](https://packagephobia.com/badge?p=@retrigger/core)](https://packagephobia.com/result?p=@retrigger/core)
[![node](https://img.shields.io/node/v/@retrigger/core.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@retrigger/core.svg)](LICENSE)

![Retrigger — a fast file system watcher for Node.js, webpack and Vite](assets/retrigger-project.png)

A fast file system watcher for Node.js, webpack and Vite dev servers. It watches through
the platform's own backend — inotify, FSEvents, `ReadDirectoryChangesW` — and hashes every
changed file with a native XXH3-64 engine, so a rebuild can be skipped when the bytes did
not actually change.

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

That digest is canonical XXH3-64 only when the native engine loaded. The JavaScript engine returns
a BLAKE2b-64 digest of the same shape, and `getEngineInfo().hashAlgorithm` says which you have.
Never persist a digest from one engine and compare it against the other.

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

## Installation

The failure mode this package works hardest to avoid is an install that throws.

- **`require()` never throws** — if no native binary matches the platform, the JavaScript
  engine (`fs.watch` and BLAKE2b-64) takes over, prints one warning line, and keeps going.
  `RETRIGGER_SILENT=1` suppresses it, and `getEngineInfo().nativeAttempts` explains what
  was tried and why each candidate was rejected.
- **No runtime dependencies** — the published tarball is 38.4 KiB across 20 entries and
  contains no native binary. The addon arrives through one of nine platform packages
  listed as `optionalDependencies`, so a platform without one degrades instead of failing.
- **Both engines are held to one test suite** — the JavaScript fallback, a mock addon, and
  the real compiled addon each run the same parity suite, so the fallback is a substitute
  rather than an aspiration.

`npm run test:pack` performs the whole thing end to end: pack the tarball, install it into
an empty directory, require it in a clean subprocess, watch a file, and confirm the process
still exits on its own.

## Measured Performance

Every number below was produced by a command in this repository on one machine — an Apple
M4 Max running macOS 26.5.1 and Node 22.12 — with a warm page cache.

They are not projections, and no comparison against other watchers is claimed here because
none was measured in the same run.

### In-Memory Hashing

`make -C src/core bench` measures XXH3-64 through NEON.

- **64 B** — 15,624 MiB/s.
- **1 KiB** — 36,784 MiB/s.
- **64 KiB** — 32,058 MiB/s.
- **16 MiB** — 31,378 MiB/s.

### End-to-End File Hashing

The shipped Node API counts `open` and `read` inside every figure below.

- **1 KiB** — 11.4 µs per file, 86 MiB/s.
- **16 KiB** — 11.9 µs per file, 1,317 MiB/s.
- **256 KiB** — 25.0 µs per file, 10,013 MiB/s.
- **4 MiB** — 240 µs per file, 16,643 MiB/s.

The ~11 µs floor is syscall overhead, and it is the number that matters for a watcher:
below roughly 16 KiB, hashing a file costs about as much as opening it.

### Watcher Latency

`cargo bench -p retrigger-system` measures FSEvents.

- **Single event, change to delivery** — 1.7 ms median, across a 1.07–2.68 ms range.
- **200 creations in a burst** — 16.0 ms.
- **2,000 files moved into a watched tree** — 13.7 ms.
- **Include/exclude decision** — 187 ns allowed, 88 ns excluded.

First-event latency is dominated by the platform backend, not by this code: on macOS,
FSEvents coalesces and delivers on its own schedule. Retrigger is not meaningfully quicker
than any other FSEvents consumer at noticing a change.

What it adds is content hashing fast enough to run on every event, so a rebuild can be
skipped when a file was rewritten with identical bytes, and bounded memory under churn.

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
- **JavaScript, 320 tests** — passes on both.
- **Packaged install, 12 checks** — passes on both.

The C suite runs a differential test that hashes the same inputs through every SIMD level
the CPU offers and compares them against scalar, so "AVX2 is enabled" is a measurement
rather than an assumption.

Published XXH3-64 vectors are checked from C, from Rust, and from the Node addon. The
JavaScript fallback is checked against published BLAKE2b vectors, because that is the
algorithm it actually uses.

What the two engines are held to _jointly_ is the content-change decision, which is the thing
a consumer depends on. One suite runs against the compiled addon, a mock addon, and the
JavaScript engine, and all three must agree on which writes changed a file's bytes — from
digests that are deliberately not comparable, because each engine only ever compares a path
against its own earlier digest.

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

It speaks HTTP with JSON bodies and streams events over SSE.

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

- **Linux x64 and arm64, gnu and musl** — inotify, with the full suite verified.
- **macOS arm64 and x64** — FSEvents, with the full suite verified.
- **Windows x64 and arm64** — `ReadDirectoryChangesW`, in the CI matrix but not verified in
  this run.
- **Anywhere else** — the `fs.watch` fallback, degraded but never broken.

## Who Should Not Be Here

This repository is the source, and most readers want the published package instead.

- **Using Retrigger in an application** — install `@retrigger/core` and read
  [the package README](src/bindings/nodejs/README.md), which carries the full API, the
  options, and the differences between the two engines.
- **Sharing one watcher between several processes** — read
  [the daemon README](src/daemon/README.md), because nothing else needs the daemon.
- **Comparing watchers** — no comparison against other watchers is claimed here, because
  none was measured in the same run.

## Reporting a Problem

Everything published out of this repository is tracked in one place.

- **A bug in any package** — open an issue on
  [the issue tracker](https://github.com/GriffinCanCode/Retrigger/issues), since
  `@retrigger/core`, `@retrigger/daemon` and the platform packages are all built from this
  tree.
- **A vulnerability** — follow [the security policy](.github/SECURITY.md), which reports
  privately through GitHub Security Advisories rather than the issue tracker, and sets out
  what is in scope.
- **Slow first-event delivery** — that is usually the platform backend rather than
  Retrigger, as the measurements above set out.

## License

MIT, in [LICENSE](LICENSE).
