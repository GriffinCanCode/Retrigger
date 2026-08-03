# Upstream request: a watcher-substitution / pre-rebuild veto seam for Turbopack

## Status

**Blocked on upstream — request filed.** Turbopack exposes no public JS API for
file-watch observation, watcher substitution, or vetoing a rebuild before it
starts. Its only extensibility surface is `turbopack.rules` in `next.config.*`,
which maps file extensions to webpack-compatible *loaders* (per-file transforms)
— not plugins, and explicitly not a watcher or a change-detection hook. There is
no seam a third party can attach to, so Retrigger cannot integrate with
Turbopack from its own tree at any amount of effort. This is a hard external
dependency, not schedulable engineering work in this repository.

The request below was filed upstream at
[`vercel/next.js#96520`](https://github.com/vercel/next.js/issues/96520). The
draft is retained here as the record of what was asked for; integration stays
deferred until one of the seams it requests ships and is documented.

Until such an API exists, the supported Retrigger path for Next.js is
**webpack mode** (`RetriggerWebpackPlugin`), which owns `compiler.watchFileSystem`.

## What Retrigger needs (the contract)

Retrigger's value is skipping work when a file's *bytes* did not change (a
formatter-on-save, a generator that reran, a branch switch that restored
identical contents). To deliver that under Turbopack, one of the following
public, stable seams would suffice, in order of preference:

1. **Pre-rebuild veto.** A hook invoked with the changed path(s) *before*
   Turbopack schedules a rebuild, whose return value can suppress the rebuild
   for a given path. This is the minimal surface that expresses "these bytes are
   identical; do nothing."
2. **Watcher substitution.** A documented way to supply the file watcher
   Turbopack consumes (analogous to webpack's settable
   `compiler.watchFileSystem`), so an external watcher can be the sole source of
   change events.
3. **Change observation + invalidation.** A hook that reports which paths
   changed in the current pass *and* an API to programmatically invalidate a
   path, so an integration can watch itself and drive invalidation only for real
   changes.

Any one of these unblocks the integration. (1) is the smallest.

## Draft issue text (file verbatim upstream)

> **Title:** Public API for pre-rebuild veto or watcher substitution in Turbopack (dev)
>
> **Summary:** Turbopack currently offers no public JS seam to observe which
> files changed in a watch pass, to substitute the underlying file watcher, or to
> veto a rebuild before it runs. `turbopack.rules` covers per-file loaders only.
> This blocks an entire class of dev-tooling — content-addressed watchers,
> no-op-write suppression, custom notification backends (e.g. Watchman on large
> monorepos, polling on network filesystems) — that webpack supports today via a
> settable `compiler.watchFileSystem` and that Vite supports via `server.watcher`
> + `handleHotUpdate`.
>
> **Request:** Expose one of (in order of preference): (1) a pre-rebuild veto hook
> receiving the changed path(s) that can suppress the rebuild for a path; (2) a
> documented watcher-substitution point analogous to `compiler.watchFileSystem`;
> or (3) a change-observation hook plus a programmatic path-invalidation API.
>
> **Use case:** We maintain a native content-hashing watcher that skips
> byte-identical rebuilds. It integrates with webpack (`watchFileSystem`), Vite,
> Rspack, Rollup, and esbuild. Turbopack is the only major bundler with no
> attachable seam, so Next.js users on Turbopack cannot get no-op-write
> suppression today and must fall back to `bundler: 'webpack'`.
>
> **Prior art:** webpack `compiler.watchFileSystem`; Vite `server.watcher` +
> `handleHotUpdate`; Rspack `compiler.watchFileSystem` compatibility.

## Completion criterion for this lane

Per the program's selected scope, the overall program stays **incomplete** for
Turbopack until:

1. an upstream API from the list above ships and is documented, and
2. a real Turbopack dev-server E2E integration is implemented against it,
   proving that a byte-identical write triggers zero rebuilds while a real edit
   rebuilds correctly — the same bar every other bundler lane meets.

No private/internal Turbopack patch is acceptable as a substitute.
