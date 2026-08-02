# @retrigger/core: A File Watcher for webpack and Vite

[![npm version](https://img.shields.io/npm/v/@retrigger/core.svg)](https://www.npmjs.com/package/@retrigger/core)
[![downloads](https://img.shields.io/npm/dm/@retrigger/core.svg)](https://www.npmjs.com/package/@retrigger/core)
[![install size](https://packagephobia.com/badge?p=@retrigger/core)](https://packagephobia.com/result?p=@retrigger/core)
[![node](https://img.shields.io/node/v/@retrigger/core.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@retrigger/core.svg)](https://github.com/GriffinCanCode/Retrigger/blob/main/LICENSE)

Fast file watching for webpack and Vite dev servers. Retrigger watches through the
platform's own backend — inotify on Linux, FSEvents on macOS, `ReadDirectoryChangesW` on
Windows — and hashes every changed file with XXH3-64, so a rebuild or hot module
replacement can be skipped when a file was rewritten with identical bytes.

A zero-dependency JavaScript fallback keeps it working on platforms with no native build.

## Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Which Engine Am I Running?](#which-engine-am-i-running)
- [API](#api)
- [webpack Plugin](#webpack-plugin)
- [Vite Plugin](#vite-plugin)
- [Requirements](#requirements)
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

Outside a bundler, construct a watcher directly and close it when you are done.

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

## Which Engine Am I Running?

`getEngineInfo()` answers that, and says why.

```javascript
const { getEngineInfo } = require('@retrigger/core');
console.log(getEngineInfo());
// {
//   engine: 'javascript',
//   backend: 'polling',
//   reason: "native addon unavailable (Cannot find module '@retrigger/core-linux-x64-gnu')",
//   hashAlgorithm: 'blake2b-64',
//   simd: 'scalar',
//   platform: 'linux-x64',
//   nativeAttempts: [ ... ]
// }
```

Set `RETRIGGER_SILENT=1` to suppress the fallback warning, `RETRIGGER_FORCE_JS=1` to always
use the JavaScript engine, or `RETRIGGER_NATIVE_PATH=/path/to.node` to load a specific
addon build.

### Engine Differences

The two engines differ in six ways, stated plainly.

- **Mechanism** — the native engine uses OS APIs (inotify, FSEvents,
  ReadDirectoryChangesW, kqueue), while the JavaScript fallback uses `fs.watch` with one
  watcher per directory.
- **`backend()`** — native returns the OS backend name, and the fallback returns
  `"polling"`.
- **Hash algorithm** — native computes XXH3-64, and the fallback computes BLAKE2b-512
  truncated to 64 bits (`blake2b-64`), or `sha256-64` on Node builds without BLAKE2.
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

Hashes are not comparable across engines.

The digest is 16 lowercase hex characters either way, but the algorithms differ. Never
persist a hash from one engine and compare it against the other, and note that
`getEngineInfo().hashAlgorithm` always reports the algorithm actually in use.

A correct pure-JavaScript XXH3-64 would need BigInt arithmetic that is roughly two orders
of magnitude slower than the native path and easy to get subtly wrong, so the fallback uses
a hash Node already implements in C rather than shipping a plausible-looking near-miss.

`event.contentChanged` is unaffected by any of this, and is comparable across engines even
though the digests behind it are not: the decision compares a path against its own earlier
digest, taken by the same engine in the same process. One test suite runs against the compiled
addon, a mock addon, and the JavaScript engine, and all three must reach the same answer.

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
- **A file that could not be read, or is larger than `maxHashBytes`** — `true`, with a `null`
  hash. Unknown is not the same as unchanged.
- **A file deleted or renamed away** — `true`, and the cached digest is forgotten.
- **A directory created, deleted or renamed** — `true`; modified or metadata is `false`,
  because directory mtime churn is not a content change.
- **A rescan signal** — `true`.

Hashing runs on the drain loop, which is why `maxHashBytes` exists: a source file costs tens of
microseconds and is worth it against a rebuild, while a large build artifact is neither cheap to
hash nor likely to have been rewritten byte-for-byte by hand. The digest cache is bounded the
same way every other map in this package is, and forgetting an entry costs one re-hash and a
redundant rebuild — never a missed change.

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
- **`createRetriggerVitePlugin(options?)`** — a function returning the Vite 5/6 plugin.

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
  engine: 'auto', // 'auto' | 'native' | 'javascript'
  emitDirectories: false,
  unref: false, // unref the poll timer
  contentHashing: true, // report `contentChanged` on every event
  maxHashBytes: 4194304, // above this a file is reported changed without being read
});
```

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
implementation of the same contract.

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

## Vite Plugin

Retrigger acts as an additional, faster event source for Vite's own HMR pipeline.

Detected changes are replayed onto `server.watcher`, so module-graph invalidation,
`handleHotUpdate` hooks and full-reload decisions all stay with Vite.

Vite's own watcher is deliberately left running as a safety net; whichever watcher sees the
write first wins, and the other becomes a no-op.

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
});
```

A write that did not change a file's bytes is not replayed onto `server.watcher`, so the module
graph is not invalidated and the browser is not reloaded. Vite's own chokidar watcher is still
running and is free to reach its own conclusion about that write; what Retrigger will not do is
add a second, redundant invalidation for it. `/__retrigger_stats` reports the count as
`metrics.eventsUnchanged`.

## Requirements

The package has two requirements.

- **Node.js** — 18.17 or newer.
- **Operating system** — Linux, macOS or Windows on x64 or arm64. Linux covers both
  glibc and musl, so Alpine images get the native engine rather than the fallback;
  the loader detects the libc and tries the other build if it guesses wrong.

The JavaScript engine works on every platform Node supports, including those with no
published native build.

## Who Should Not Be Here

This package watches in-process, which is the right shape for a single dev server.

- **Several processes watching one tree** — install
  [`@retrigger/daemon`](https://www.npmjs.com/package/@retrigger/daemon) instead, so that
  one watcher and one hash serve all of them.
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
