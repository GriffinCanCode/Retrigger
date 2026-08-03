# @retrigger/core: Skip Byte-Identical Rebuilds

[![npm version](https://img.shields.io/npm/v/@retrigger/core.svg)](https://www.npmjs.com/package/@retrigger/core)
[![downloads](https://img.shields.io/npm/dm/@retrigger/core.svg)](https://www.npmjs.com/package/@retrigger/core)
[![install size](https://packagephobia.com/badge?p=@retrigger/core)](https://packagephobia.com/result?p=@retrigger/core)
[![node](https://img.shields.io/node/v/@retrigger/core.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@retrigger/core.svg)](https://github.com/GriffinCanCode/Retrigger/blob/main/LICENSE)

Skip rebuilds when a file's bytes did not change. That is the product.

Retrigger plugs into webpack, Vite, Rspack, Rollup, and esbuild so a formatter on save, a
generator that reran, or a branch switch that restored identical contents does not trigger
HMR or a full rebuild. It watches through the platform backend (inotify, FSEvents,
`ReadDirectoryChangesW`), hashes every changed path with XXH3-64, and withholds the event
when the digest matches.

It is not the fastest raw watcher. Measured against Chokidar on the same machine, Retrigger
trades a few milliseconds of per-event latency for skipping entire rebuilds — the right
trade for dev-server rebuild suppression. The hashing API, snapshots, Watchman engine,
chokidar adapter, and optional daemon support that thesis; they are not co-equal headline
features.

A zero-dependency JavaScript fallback keeps it working on platforms with no native build.

## Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Measured Performance](#measured-performance)
- [Which Engine Am I Running?](#which-engine-am-i-running)
- [API](#api)
- [webpack Plugin](#webpack-plugin)
- [Next.js](#nextjs)
- [Vite Plugin](#vite-plugin)
- [Rollup / esbuild (Manual Rebuild)](#rollup--esbuild-manual-rebuild)
- [Snapshots / Change-Since](#snapshots--change-since)
- [Watchman Engine (Optional)](#watchman-engine-optional)
- [Chokidar-Compatible Adapter](#chokidar-compatible-adapter)
- [Requirements](#requirements)
- [Native platform matrix](#native-platform-matrix)
- [Who Should Not Be Here](#who-should-not-be-here)
- [Reporting a Problem](#reporting-a-problem)
- [License](#license)

## Installation

Install it from npm.

```bash
npm install @retrigger/core
```

`require('@retrigger/core')` never throws.

If the native addon for your platform is missing or fails to load, the package
transparently falls back to a pure-JavaScript engine that implements the same interface,
prints one warning line, and tells you exactly what happened through `getEngineInfo()`.

There is no build step, no daemon to start and no post-install script.

## Quick Start

### webpack

webpack takes the plugin as a constructor.

```javascript
// webpack.config.js
const { RetriggerWebpackPlugin } = require('@retrigger/core');

module.exports = {
  plugins: [new RetriggerWebpackPlugin({ verbose: true })],
};
```

### Vite

Vite takes it as a factory.

```javascript
// vite.config.js
import { createRetriggerVitePlugin } from '@retrigger/core';

export default {
  plugins: [createRetriggerVitePlugin({ verbose: true })],
};
```

Subpath imports are also available, so you can pull in only what you need.

```javascript
import RetriggerWebpackPlugin from '@retrigger/core/webpack';
import { createRetriggerVitePlugin } from '@retrigger/core/vite';
```

### Standalone Watcher

Outside a bundler, construct a watcher directly and close it when you are done. Prefer the
bundler plugins when the goal is rebuild suppression; the standalone watcher is the same
content-hash gate without a bundler seam.

```javascript
const { createRetrigger } = require('@retrigger/core');

const watcher = createRetrigger({ paths: ['./src'], exclude: ['**/*.log'] });
watcher.on('add', (path) => console.log('added', path));
watcher.on('change', (path) => console.log('changed', path));
watcher.on('unlink', (path) => console.log('removed', path));
watcher.on('error', (err) => console.error(err));
watcher.start();
// ...
watcher.close();
```

## Measured Performance

From this repository's lab (`tools/benchmarks/`), measured on **Apple M4 Max · darwin
arm64 · Node v22 · native engine · XXH3-64**. Not universal guarantees. Reproduce:

```bash
cd tools/benchmarks && npm install && npm run bench:all
```

**Flagship — byte-identical writes must not rebuild:**

| Scenario                        | Retrigger                            | Stock                                    |
| ------------------------------- | ------------------------------------ | ---------------------------------------- |
| Vite, 8 identical writes        | **0/8** rebuilds (0 ms rebuild wall) | **8/8** (~804 ms)                        |
| webpack, 8 identical writes     | **0/8** rebuilds (0 ms rebuild wall) | **8/8** (~386 ms)                        |
| 4 real edits (Vite and webpack) | **4/4** rebuild                      | **4/4** rebuild                          |
| Burst (identical + real)        | Only real edits rebuild              | Stock also rebuilds for identical writes |

**Honesty — raw watch latency trails Chokidar** (same-run p50): Chokidar ~0.31 ms vs
Retrigger ~11.80 ms. A few milliseconds of per-event latency buys skipping entire rebuilds.

Supporting: snapshot crawl of 2,000 files in ~6.3 ms; storm of 2,000 writes with 0 dropped;
peak RSS in the webpack rebuild lab ~151 MB.

## Which Engine Am I Running?

`getEngineInfo()` answers that, and says why.

```javascript
const { getEngineInfo } = require('@retrigger/core');
console.log(getEngineInfo());
// {
//   engine: 'javascript',
//   backend: 'polling',
//   reason: "native addon unavailable (Cannot find module '@retrigger/core-linux-x64-gnu')",
//   hashAlgorithm: 'xxh3-64',
//   simd: 'scalar',
//   platform: 'linux-x64',
//   nativeAttempts: [ ... ]
// }
```

Set `RETRIGGER_SILENT=1` to suppress the fallback warning, `RETRIGGER_FORCE_JS=1` to always
use the JavaScript engine, or `RETRIGGER_NATIVE_PATH=/path/to.node` to load a specific
addon build.

### Engine Differences

The two engines differ in five ways, stated plainly.

- **Mechanism** — the native engine uses OS APIs (inotify, FSEvents,
  ReadDirectoryChangesW, kqueue), while the JavaScript fallback uses `fs.watch` with one
  watcher per directory.
- **`backend()`** — native returns the OS backend name, and the fallback returns
  `"polling"`.
- **Renames** — native may report `renamedFrom` and `renamedTo` with a correlation cookie,
  while the fallback reports them as `deleted` plus `created` and `cookie` is always
  `null`.
- **Symlinked directories** — native follows them per OS behaviour, and the fallback does
  not traverse them.
- **Startup window** — the native stream is live when `start()` returns, whereas on macOS
  the fallback's `fs.watch` brings its FSEvents stream up asynchronously, so a write in the
  first few milliseconds after `start()` can be missed.

The startup window matters only if you write to a watched tree the instant you start
watching. Both bundler plugins handle it by reading the tree once on the first compile
rather than relying on the event stream for that moment.

### Hash Comparability

Hashes are canonically comparable across engines: both compute XXH3-64, so the same bytes and
the same seed produce the same 16-character digest whichever engine ran.

The native engine calls the C engine directly; the JavaScript fallback calls the same XXH3-64
implementation compiled ahead of time to a ~16 KB WebAssembly module (`lib/xxh3.wasm`, built
from the `xxhash-rust` crate, matching official reference vectors — see `hash.test.mjs`), rather
than a hand-written, roughly two-orders-of-magnitude-slower BigInt reimplementation, or a
plausible-looking near-miss with a different algorithm. `require()` never touches a toolchain:
the module ships prebuilt, and instantiating it needs nothing from the host beyond linear memory.

`event.contentChanged` was always comparable across engines, and now the digest behind it is
too: the decision compares a path against its own earlier digest, taken by the same engine in
the same process, but that digest is also equal to what the other engine would have computed
for the same bytes. One test suite runs against the compiled addon, a mock addon, and the
JavaScript engine, and all three must reach the same answer.

### Content Changes

Every event carries `contentChanged`, and the plugins act on it.

```javascript
watcher.on('change', (path, event) => {
  if (event.contentChanged === false) return; // rewritten with the bytes it already had
  rebuild(path);
});
```

The decision table is the same one the Rust daemon uses, so an in-process watcher and the
daemon cannot disagree.

- **A file whose digest differs from the cached one** — `true`, and `event.hash` is the new
  digest.
- **A file whose digest matches** — `false`.
- **A file that could not be read** — `true`, with a `null` hash. Unknown is not the same as
  unchanged.
- **A file deleted or renamed away** — `true`, and the cached digest is forgotten.
- **A directory created, deleted or renamed** — `true`; modified or metadata is `false`,
  because directory mtime churn is not a content change.
- **A rescan signal** — `true`.

Hashing a small file runs on the drain loop, because a source file costs tens of microseconds and
is worth it against a rebuild there. A file larger than `maxHashBytes` is hashed off that loop
instead — chunked and I/O-driven, on both engines — so a large build artifact changing cannot
delay delivery of every other event that tick; it is still hashed, just asynchronously, and its
event is emitted once the digest resolves. `maxConcurrentHashes` bounds how many of those run at
once, and `getStats().asyncHashesInFlight`/`asyncHashesQueued` report the current load. The digest
cache is bounded the same way every other map in this package is, and forgetting an entry costs
one re-hash and a redundant rebuild — never a missed change.

## API

Twelve exports make up the API.

- **`createRetrigger(options?)`** — a function returning a `Retrigger`, which it does not
  start.
- **`Retrigger`** — a class extending `EventEmitter`; see the events below.
- **`hashBytesSync(data, seed?)`** — a function returning 16 lowercase hex characters.
- **`hashFileSync(path)`** — a function returning `{ hash, size }`.
- **`hashFile(path)`** — a function returning a Promise of `{ hash, size }`.
- **`benchmarkHash(size, iterations)`** — a function reporting measured throughput, with no
  baselines.
- **`getSimdSupport()`** — a function reporting the active SIMD level.
- **`getCpuLevel()`** — a function reporting the highest level the CPU supports.
- **`getAvailableLevels()`** — a function reporting all compiled levels.
- **`getEngineInfo()`** — a function reporting which engine you got, and why.
- **`RetriggerWebpackPlugin`** — a class implementing the webpack 5 plugin.
- **`createRetriggerVitePlugin(options?)`** — a function returning the Vite 5/6/7 plugin.

### Watcher Options

Every option carries a default, so an empty call is valid.

```javascript
createRetrigger({
  paths: ['./src'], // string | string[]
  recursive: true,
  include: [], // globs; empty means "everything"
  exclude: [], // globs; exclusion always wins over inclusion
  debounceMs: 0, // coalesce events per path
  capacity: 8192, // bounded queue; overflow emits `rescan`
  pollIntervalMs: 5, // how often the engine queue is drained
  engine: 'auto', // 'auto' | 'native' | 'javascript' | 'watchman'
  emitDirectories: false,
  unref: false, // unref the poll timer
  contentHashing: true, // report `contentChanged` on every event
  maxHashBytes: 4194304, // above this, hashing moves off the drain loop onto the async path
  maxConcurrentHashes: 4, // ceiling on async hashes running at once
  // Network / remote FS: force portable polling (native engine). JS engine always polls.
  backend: { mode: 'auto', pollIntervalMs: 1000, compareContents: false },
  // Hold a path until size+mtime stop changing (chunked / NFS-style writes).
  awaitWriteFinish: undefined, // or { pollIntervalMs: 100, stabilityThresholdMs: 2000 }
  // Fold editor write-temp-then-rename into one `change`. Default false on Retrigger.
  atomicWriteNormalization: false,
});
```

Watcher contracts worth knowing (explicit, not magic):

- **Polling / network filesystems** — `backend: { mode: 'poll' }` when kernel events cannot
  be trusted (NFS, some network mounts). Optional `compareContents` hashes on each poll to
  catch same-size/same-mtime rewrites.
- **`awaitWriteFinish`** — write stabilization before delivery (same idea as chokidar).
- **Atomic saves** — `atomicWriteNormalization: true` folds temp-then-rename into one
  `change`.
- **Symlinks** — native follows per OS behaviour; the JavaScript engine does not traverse
  symlinked directories. Permission errors and unreadable paths fail open as
  `contentChanged: true` (never silently "unchanged").
- **Async hashing** — files above `maxHashBytes` hash off the drain loop so large bursts do
  not block the event loop; `maxConcurrentHashes` caps concurrency.

#### How `debounceMs` behaves

Debouncing is **leading-edge with a trailing correction**, and both halves matter.

The first event for a path is delivered immediately — nothing waits out the window — and further
events for that path inside the window are absorbed. If the window absorbed anything, it closes
with one `modified` carrying the file's final size.

The correction is not redundant. Because the first event is delivered at once, it can describe a
file that is still being written; a large save fires on its first chunk, and the write that
completes it lands inside the window. Without the correction that completing write would never be
reported, and the consumer would keep the partial file. So a burst costs two wake-ups, not one, and
the second is the one that is definitely current.

With `contentHashing` on, a correction whose bytes did not actually move since the leading event
arrives with `contentChanged: false`, so it costs a hash rather than a rebuild.

Deletes and renames are never absorbed: they end the window and are delivered on their own. Both
engines implement this identically, and the parity suite holds them to it.

### Events

A `Retrigger` emits seven events.

- **`add`** — `(path, event)`, fired for a file created.
- **`change`** — `(path, event)`, fired for a file modified or metadata changed.
- **`unlink`** — `(path, event)`, fired for a file deleted.
- **`all`** — `(event)`, fired for every event, including directory and rescan events.
- **`rescan`** — `(event)`, fired when the queue overflowed; re-read state from disk.
- **`error`** — `(error)`, fired on engine failure, and never thrown.
- **`ready`** — no arguments, fired once per `start()`.

A listener that throws is reported through `error` and never stops delivery.

## webpack Plugin

The plugin replaces webpack's Watchpack-based `watchFileSystem` with a Retrigger-backed
implementation of the same contract. It also works unmodified with `@rspack/core`, which
implements `compiler.watchFileSystem` compatibly, including with Rspack's persistent cache —
`npm run test:rspack` runs this package's whole webpack test suite against it.

If Retrigger cannot start, every call is delegated to webpack's original watcher and the
build proceeds unchanged — the plugin never throws out of a webpack hook.

Its options and their defaults are these.

```javascript
new RetriggerWebpackPlugin({
  watchPaths: [], // extra roots beyond webpack's own dependency set
  verbose: false,
  debounceMs: 0,
  include: [],
  exclude: ['**/node_modules/**', '**/.git/**'],
  engine: 'auto',
  replaceWatcher: true, // false leaves webpack's watcher in place
  aggregateTimeout: 20,
  capacity: 16384,
  pollIntervalMs: 5,
  contentHashing: true, // skip files rewritten with identical bytes
});
```

A write that did not change a file's bytes is never reported to webpack: no timestamp is
advanced, no watch session is notified, and nothing is held over for the next one. Leaving the
recorded timestamp where it was is the truthful answer, since the contents webpack compiled are
still the contents on disk, and webpack re-stats anything it was not told about.

`plugin.getStats()` returns measured counters, or `null` before the first watch;
`metrics.eventsUnchanged` is how many rebuilds this saved.

Default exclusions matter. `node_modules` is not recursed into, so edits inside it will not
trigger a rebuild while `replaceWatcher` is on. Pass `exclude: []` if you are actively
editing a dependency in place.

## Next.js

Next.js is supported in **webpack mode**: add `RetriggerWebpackPlugin` to
`webpack` in `next.config.*` the same way you would for a plain webpack project.

**Turbopack is not supported.** Turbopack exposes no public watcher-substitution or
pre-rebuild veto API, so Retrigger cannot attach without an upstream seam. That integration
is intentionally deferred until Vercel ships one; see
[the upstream request note](https://github.com/GriffinCanCode/Retrigger/blob/main/docs/upstream/turbopack-watcher-request.md).
Do not expect no-op-rebuild suppression under `next dev --turbopack`.

## Vite Plugin

Works with Vite 5, 6 and 7, and with Astro's dev server (which mounts a Vite instance
internally) — `test/astro.test.mjs` boots a real Astro dev server against it. Rspack is a
webpack plugin concern; see [webpack Plugin](#webpack-plugin).

Retrigger becomes the **sole** file-system event source for Vite's dev server: the plugin's
`config()` hook sets `server.watch = null`, which Vite documents as disabling its own chokidar,
so `server.watcher` is Vite's inert `NoopWatcher` — still a real `EventEmitter` whose identity
never changes. Detected changes are replayed onto it with plain `server.watcher.emit('add' |
'change' | 'unlink', file)` calls, so module-graph invalidation, `handleHotUpdate` hooks and
full-reload decisions all stay with Vite, and any other plugin's own `server.watcher.on(...)`
listener — registered before or after this one runs — keeps working exactly as it would against
a real chokidar instance.

**Fail-open:** disabling Vite's own watcher trades away the safety net a second live watcher
would have provided, so this plugin rebuilds an equivalent one on demand instead. If Retrigger
cannot start, or degrades mid-session (repeated engine errors, or a caller invoking
`plugin.api.degrade()` directly), a minimal `fs.watch`-based fallback takes over and keeps
relaying events onto `server.watcher` — HMR does not die because Retrigger did.

**Escape hatch:** `legacyWatcher: true` restores the pre-rewrite design — Vite's own chokidar is
left running, and the plugin gates its `server.watcher.emit` calls so a byte-identical write
chokidar itself observed does not also reach the module graph — for the rare composability edge
where another plugin's `config()` hook overrides `server.watch` back to non-null after this one
runs.

Its options and their defaults are these.

```javascript
createRetriggerVitePlugin({
  watchPaths: [],
  include: [],
  exclude: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/.vite/**'],
  verbose: false,
  debounceMs: 0,
  engine: 'auto',
  capacity: 8192,
  pollIntervalMs: 5,
  stats: true, // mounts GET /__retrigger_stats
  contentHashing: true, // skip files rewritten with identical bytes
  legacyWatcher: false, // true restores the pre-rewrite shared-watcher design; see above
});
```

A write that did not change a file's bytes is never replayed onto `server.watcher`, so the
module graph is not invalidated and the browser is not reloaded. `/__retrigger_stats` reports
the count as `metrics.eventsUnchanged`.

## Rollup / esbuild (Manual Rebuild)

Neither Rollup nor esbuild exposes a public seam to veto a rebuild a watch has already started —
Rollup's `RollupWatcher` (`watchChange`) and esbuild's `context(...).watch()` are both
observation-only. `@retrigger/core/rollup` and `@retrigger/core/esbuild` therefore do not call
either tool's own watch API at all: Retrigger owns the watch, and a build is a plain one-shot
`rollup()`/`ctx.rebuild()` call, driven by a shared scheduler (`lib/rebuild-driver.js`) only when
the content-hash gate reports a real byte change. This is the direct replacement for `rollup
--watch` or `esbuild --watch` when the goal is skipping no-op rebuilds.

```javascript
const rollupWatcher = require('@retrigger/core/rollup');

const build = await rollupWatcher
  .createRetriggerRollupWatcher({
    input: { input: './src/index.js' },
    output: { file: './dist/bundle.js', format: 'esm' },
    watchPaths: ['./src'],
  })
  .start(); // builds once immediately, then watches
// ...
await build.close();
```

```javascript
const esbuildWatcher = require('@retrigger/core/esbuild');

const build = await esbuildWatcher
  .createRetriggerEsbuildWatcher({
    entryPoints: ['./src/index.js'],
    outfile: './dist/bundle.js',
    bundle: true,
    watchPaths: ['./src'],
  })
  .start();
// ...
await build.close();
```

Both factories share the same scheduling semantics:

- **Coalescing** — a burst of real edits inside `coalesceMs` (default 20) collapses into one
  rebuild, not one per file.
- **Backpressure** — at most one rebuild runs at a time; a change that lands while one is running
  is not dropped, but it does not start a second concurrent rebuild either — it schedules exactly
  one follow-up once the current one settles, coalescing anything else that arrives before then.
- **Errors** — a build that throws is reported through `onError`/the returned `driver`'s `'error'`
  event and never crashes the watch; the next real change tries again.
- **Shutdown** — `close()` stops watching, waits for an in-flight build to settle, and (for
  esbuild) calls `ctx.dispose()`.

`build.buildCount`, `build.getStats()` and `build.driver.getStats()` report measured counters —
`driver.getStats().eventsUnchanged` is how many rebuilds this saved, the same number the webpack
and Vite plugins report as `metrics.eventsUnchanged`.

## Snapshots / Change-Since

`snapshot(path)` crawls a tree into a self-describing envelope (safe to persist as JSON;
`algorithm` / `version` tell a reader whether it still matches). `watchWithSnapshot(path)`
registers the watch first, then crawls, so creations during the crawl are not lost. Both
are methods on a `Retrigger` instance — supporting change-since workflows around the same
content-hash gate, not a separate product surface.

```javascript
const { createRetrigger } = require('@retrigger/core');

const watcher = createRetrigger({ paths: ['./src'] });
const snap = await watcher.watchWithSnapshot('./src');
// snap.entries, snap.algorithm ('xxh3-64'), …
```

The optional daemon exposes the same inventory over `GET /snapshot`. With
`engine: 'watchman'`, `changesSince(path, clock)` adds Watchman clock-backed deltas (see
below).

## Watchman Engine (Optional)

A third engine talks to [Watchman](https://facebook.github.io/watchman/), Meta's own file
watching service, when it is explicitly requested and actually present. Watchman is never a
dependency and never auto-selected — `engine: 'auto'` still only ever picks native or
JavaScript.

```javascript
const watcher = createRetrigger({ paths: ['./src'], engine: 'watchman' });
```

If neither the optional [`fb-watchman`](https://www.npmjs.com/package/fb-watchman) client nor
the `watchman` binary on `PATH` is available, this falls back to the native → JavaScript path
with one documented warning line (suppressed by `RETRIGGER_SILENT=1`, same as the native
fallback). `getEngineInfo().watchman` reports `{ available, kind: 'fb-watchman' | 'cli' | null,
reason }` unconditionally, whether or not you asked for Watchman.

Beyond the shared engine contract, a Watchman-backed watcher exposes one Watchman-specific
method for change-since queries backed by Watchman's own clock, complementing Lane 2's
walk-based `snapshot()`/`diff_snapshots()`:

```javascript
const first = await watcher.snapshot('./src'); // establishes a Watchman clockspec
// ...later...
const since = await watcher.changesSince('./src', first.clock); // since.files, since.clock
```

## Chokidar-Compatible Adapter

`@retrigger/core/chokidar` exports a [chokidar](https://github.com/paulmillr/chokidar) v5-shaped
`watch(paths, options)` for codebases already written against chokidar's API.

```javascript
const chokidarAdapter = require('@retrigger/core/chokidar');

const watcher = chokidarAdapter.watch(['./src'], { ignoreInitial: true });
watcher.on('add', (path) => console.log('added', path));
watcher.on('change', (path) => console.log('changed', path));
watcher.on('unlink', (path) => console.log('removed', path));
watcher.on('ready', () => console.log('initial scan complete'));
```

It supports `add()`/`unwatch()` (both array-accepting), `getWatched()`, the `all`/`ready`/`error`
events, and the options `ignored`, `ignoreInitial`, `cwd`, `awaitWriteFinish` (mapped to Lane 1's
stabilizer), `followSymlinks`, and `atomic` (mapped to Lane 1's atomic-write normalization; unlike
`Retrigger` itself, this adapter defaults `atomic: true` to match real chokidar). It also accepts
Retrigger's own `contentHashing` for no-op-write suppression, which real chokidar has no
equivalent for.

Documented divergences from real chokidar:

- No glob support inside `add()` — pass concrete paths or directories, same as `Retrigger`.
- No `raw` event; nothing here fabricates chokidar's internal `fs.watch` event names.
- `awaitWriteFinish`'s `pollInterval`/`stabilityThreshold` map onto Lane 1's own stabilizer
  rather than a re-implementation, so timing characteristics track that stabilizer, not
  chokidar's.

## Requirements

The package has two requirements.

- **Node.js** — 18.17 or newer.
- **Native addon** — published for the platforms below. Everywhere else, including
  arches with no binary, the JavaScript/`fs.watch` engine takes over.

### Native platform matrix

Every row is a real `optionalDependency` with a release job that produces a `.node`
artifact. Verification tiers are what the release workflow actually does — not
aspirational coverage.

| Target triple                   | Package suffix        | Verification                                                 |
| ------------------------------- | --------------------- | ------------------------------------------------------------ |
| `x86_64-unknown-linux-gnu`      | `linux-x64-gnu`       | Executed native (GitHub-hosted)                              |
| `aarch64-unknown-linux-gnu`     | `linux-arm64-gnu`     | Executed native (GitHub-hosted)                              |
| `x86_64-unknown-linux-musl`     | `linux-x64-musl`      | Executed native (Alpine container)                           |
| `aarch64-unknown-linux-musl`    | `linux-arm64-musl`    | Executed native (Alpine container)                           |
| `x86_64-apple-darwin`           | `darwin-x64`          | Executed native (GitHub-hosted)                              |
| `aarch64-apple-darwin`          | `darwin-arm64`        | Executed native (GitHub-hosted)                              |
| `x86_64-pc-windows-msvc`        | `win32-x64-msvc`      | Executed native (GitHub-hosted)                              |
| `aarch64-pc-windows-msvc`       | `win32-arm64-msvc`    | Cross-built, **not executed** (no free arm64 Windows runner) |
| `x86_64-unknown-freebsd`        | `freebsd-x64`         | Executed native (FreeBSD VM via `vmactions/freebsd-vm`)      |
| `armv7-unknown-linux-gnueabihf` | `linux-arm-gnueabihf` | Cross-built, executed under QEMU                             |
| `powerpc64le-unknown-linux-gnu` | `linux-ppc64-gnu`     | Cross-built, executed under QEMU                             |

Linux gnu/musl: the loader detects libc and tries the other build if it guesses wrong.
On FreeBSD the native engine re-scans on an interval (`backend()` reports `"polling"`)
rather than using `kqueue`, whose recursive mode does not reliably observe directories
created after the watch begins; every other platform uses its native OS backend. The
JavaScript engine works on every platform Node supports.

## Who Should Not Be Here

This package watches in-process, which is the right shape for a single dev server that
wants to skip byte-identical rebuilds.

- **Several processes watching one tree** — install
  [`@retrigger/daemon`](https://www.npmjs.com/package/@retrigger/daemon) instead, so that
  one watcher and one hash serve all of them.
- **Wanting the lowest raw watch latency** — Retrigger trails Chokidar on per-event p50;
  see [Measured Performance](#measured-performance).
- **Next.js with Turbopack** — unsupported until upstream exposes a seam; use webpack mode
  or wait. See [Next.js](#nextjs).
- **Reading the C and Rust layers, or building from source** — go to
  [the repository](https://github.com/GriffinCanCode/Retrigger).

## Reporting a Problem

Every package built from this tree is tracked in one place.

- **A bug** — open an issue on
  [the issue tracker](https://github.com/GriffinCanCode/Retrigger/issues).
- **A vulnerability** — follow
  [the security policy](https://github.com/GriffinCanCode/Retrigger/blob/main/.github/SECURITY.md),
  which reports privately rather than through the issue tracker.
- **A platform with no native build** — that is expected rather than a bug, and
  `getEngineInfo()` reports what was tried and why.

## License

MIT
