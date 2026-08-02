# Architecture

Retrigger answers one question for a dev server: **which files changed, and did their
bytes actually change?** Everything below exists to answer it quickly and to be honest
when it cannot.

Three toolchains, four boundaries. This document is about the boundaries — what crosses
each one, and what each side is allowed to assume. `CONTRIBUTING.md` covers how to build
and test; the root `README.md` names the layers. Read this before moving anything between
them.

## The layers

| Path                         | Language   | Responsibility                                    |
| ---------------------------- | ---------- | ------------------------------------------------- |
| `src/core`                   | C11        | XXH3-64, with a kernel per SIMD level              |
| `src/daemon/retrigger-core`  | Rust       | Safe FFI over the C engine                        |
| `src/daemon/retrigger-system`| Rust       | The watcher: backends, filtering, coalescing      |
| `src/daemon/retrigger-daemon`| Rust       | Optional standalone daemon over HTTP/JSON and SSE |
| `src/bindings/nodejs`        | Rust + JS  | N-API addon, JS fallback, bundler plugins         |

Each depends only on the one above it in the hash column, and the watcher and the hash
meet for the first time in the layer that consumes both.

## Boundary 1: C to Rust

`src/core` exposes a C ABI through `include/retrigger_hash.h`. `retrigger-core` declares
it by hand rather than generating bindings, so building from source does not require
`libclang`.

What makes hand-written declarations safe is that **both sides assert the layout
independently**: the header carries `_Static_assert`s and the Rust module carries matching
`const` assertions. If the two ever disagree, one of them stops compiling rather than
reading a struct at the wrong offset at runtime.

Two invariants live here and are load-bearing everywhere above:

- **One algorithm, always.** `hash(x)` is XXH3-64 of `x` — every platform, every size,
  every entry point. An earlier version chose between BLAKE3 and XXH3 by input size,
  which meant the same bytes hashed differently depending on how many of them there were.
- **Dispatch is a runtime decision.** `dispatch.c` reads CPU features through
  `cpuid`/`xgetbv` and selects a scalar, SSE2, AVX2, AVX-512, or NEON kernel. Nothing is
  compiled with `-march=native`. The machine that builds the binary is not the machine
  that runs it, and a compile-time choice turns a portability question into an
  illegal-instruction crash.

Every kernel computes the same function, bit for bit. `rtr_hash_force_level` exists so a
single machine can prove it, and the C suite checks the result against reference vectors
from upstream xxHash rather than against the engine's own output.

## Boundary 2: the kernel to the watcher

`retrigger-system` is a safe layer over the `notify` crate — `forbid(unsafe_code)` at the
crate root, no FFI. `notify` supplies inotify, FSEvents, and `ReadDirectoryChangesW`; this
crate supplies the properties a dev-server watcher needs and those backends do not agree
on by themselves:

- **A bounded queue that reports its own losses.** Capacity is finite, so a burst larger
  than the queue must lose events. When that happens the watcher emits
  `EventKind::RescanRequired` rather than dropping events quietly. A consumer that sees it
  must re-read the tree instead of trusting the stream.
- **Per-path coalescing that never swallows a delete.** Rapid writes to one path collapse
  into one event within the window; a delete or rename is never absorbed by a write that
  preceded it.
- **Uniform semantics across backends.** Recursion, and the meaning of each event kind,
  are the same on all three platforms. macOS needs the most work here: FSEvents reports a
  *union of flags* accumulated since the last notification rather than a sequence of
  operations, so event kinds are re-derived from the file system before delivery.
- **Filtering before queueing.** Include and exclude globs are applied before an event
  reaches the queue, so an excluded tree cannot consume the capacity a watched one needs.
- **A lifecycle that joins its threads.** `stop()` returns when the threads are actually
  gone, not when they have been asked to leave.

## Boundary 3: events to decisions

An event says a file was written. A bundler needs to know whether to rebuild, and those
are different questions: editors, formatters, code generators, and `git checkout` all
rewrite files byte-identically. This is where the hash earns its place — a digest is kept
per path, and a write whose digest matches the cached one is not a change.

The decision is implemented twice, in Rust (`processor.rs`) and in JavaScript
(`lib/content.js`), and the two decision tables are deliberately identical so the
in-process watcher and the daemon cannot disagree about what counts as a change.

The digests themselves are *not* comparable across engines — the addon hashes with XXH3-64
and the JavaScript fallback with BLAKE2b-64 — and they do not need to be. Each path is
only ever compared against its own previous digest, taken by the same engine in the same
process. Both engines therefore reach identical `contentChanged` answers from
non-identical digest values.

Unreadable, oversized, and deleted files all resolve to "changed". Failing open is the
only safe direction: a missed rebuild is a wrong answer that looks correct.

## Boundary 4: native to JavaScript

`src/bindings/nodejs` is the published package, and the boundary that matters most,
because it is the one users cross by accident.

An **engine** is the small surface the rest of the package depends on: `createWatcher`,
four hash entry points, and SIMD reporting. Two implementations satisfy it — the N-API
addon (`src/lib.rs`, over the two Rust crates) and a pure-JavaScript one (`lib/js-watcher.js`,
`lib/hash-js.js`). `lib/engine.js` picks one at load time; `Retrigger` never branches on
which it received.

That indirection is the whole shape of the install story. `require('@retrigger/core')`
must never throw. Where a prebuilt binary exists it is used; where none does, the package
degrades to JavaScript with one warning line and no stack trace, because a fallback is
expected rather than exceptional. A shared parity suite runs both engines against the same
assertions, and CI has a job that deletes every `.node` file and runs the suite to prove
the fallback alone is sufficient.

Above the engine sit the two bundler integrations. Both are gated through the same content
oracle, including each bundler's own watcher where it keeps one running — Vite's chokidar
is deliberately left alive so a failure here can never be the reason a dev server stops
reloading, but its events are passed through the same digest cache so a no-op save does
not reload the browser and a real edit is not invalidated twice.

## The daemon is optional

`retrigger-daemon` runs one watcher and one hash cache for several processes and exposes
them over HTTP/JSON with server-sent events and Prometheus metrics. It is built from the
same two crates the addon uses, which is what keeps its answers identical to the
in-process ones.

Nothing requires it. Watching happens in-process by default, and `@retrigger/core` does
not install it. It exists for the case where several processes would otherwise each open
their own watcher over the same tree.

## What is deliberately absent

Removed in 2.0.0, and not to be reintroduced without a decision that says why:

- **The Zig system layer.** It sat between Rust and the kernel, never armed its inotify
  thread on Linux, and described `FileEvent` with a fat pointer where Rust read a thin
  one. `notify` covers the same three backends with no fourth toolchain.
- **gRPC and shared-memory IPC.** The daemon speaks HTTP/JSON. Two more wire formats cost
  more than the latency they saved for a process that is optional to begin with.
- **`src-js`.** Superseded by `lib/`, which is what the package ships.
