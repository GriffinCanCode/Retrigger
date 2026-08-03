# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**A hash value is part of the public API.** The hash is used as a cache key, so
a change to its output silently invalidates every consumer's cache while still
looking correct. Any change to hash output, the IPC message format, or the
on-disk format is a major version bump and is called out under **Breaking**.

## [Unreleased]

## [2.0.0] - 2026-08-02

Retrigger is rebuilt on three toolchains that agree with each other — C for the
hash, Rust for the watcher and daemon, JavaScript for the bundler plugins — and
the thing being released is that an install works somewhere other than the
machine it was built on.

### Breaking

- **Hash output has changed.** The C engine now computes the real XXH3-64
  algorithm; the previous engine called itself XXH3 but matched no published
  vector and produced a different digest per SIMD path. Every digest this
  project has ever emitted is therefore invalid as a cache key, which is what
  makes this a major version rather than a fix.
- The Zig system layer between Rust and the kernel has been removed. The watcher
  is native Rust over `notify`, and `zig` is no longer a build dependency.
- The gRPC and IPC surfaces and the `src-js` modules are removed.
- The daemon configuration schema has changed.
- `POST /watch` and `POST /unwatch` now require an absolute path that names its
  target directly; a `.` or `..` component is answered with a 400 instead of
  being resolved. Roots configured in `[[watcher.paths]]` are unaffected, as is
  every in-process caller of the `retrigger-system` API.

### Added

- A pure-JavaScript fallback engine, so `require('@retrigger/core')` never
  throws. With no native binary present the package still watches and still
  hashes, held to the addon's behaviour by a parity suite both engines run.
- Prebuilt platform packages for musl (`linux-x64-musl`, `linux-arm64-musl`),
  built and executed inside Alpine rather than cross-compiled, so an Alpine
  install resolves a native binary instead of silently degrading.
- `Retrigger#hasContentChanged`, the content oracle the bundler plugins share.
- `rtr_hash_force_level`, so one machine can prove every SIMD path agrees.
- Layered adversarial, property, and fuzz suites across all three languages,
  with bounded seeded tiers in the PR gate and storms, fault injection, and
  fuzzing behind `test-chaos` / `test-fuzz` and a manual campaign workflow.
- Project documentation and repository policy: `LICENSE`, `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`, this changelog, a security policy, issue templates,
  `CODEOWNERS`, and Dependabot.

### Changed

- Correctness of the hash is checked against published reference vectors rather
  than against the engine's own output. The scalar, NEON, SSE2, AVX2, and
  AVX-512 paths are required to be bit-identical.
- SIMD selection is a runtime `cpuid`/`xgetbv` decision. Nothing in the library
  is compiled with `-march=native`, so a binary built on one machine runs on
  another instead of trapping on an illegal instruction.
- `rtr_hash_file` streams a file in bounded chunks, keeping peak memory
  independent of file size.
- macOS event kinds are re-derived from the file system before delivery, because
  FSEvents reports a union of flags rather than a sequence of operations.
- The daemon is rebuilt over the same two crates the Node addon uses.
- The burst-coalescing window widened from 120ms to 500ms; at 120ms the tail of
  a burst routinely opened a second window, which measured machine load rather
  than coalescing.

### Fixed

- **Installing produced a working native package.** 1.0.4 published a root
  package whose `optionalDependencies` named eight platform packages that were
  never published, so every install resolved no native binary and quietly fell
  back. The release now publishes the platform packages and then installs the
  result from the registry on every supported OS, failing if the native engine
  is not the one that loads.
- `@retrigger/core` and `@retrigger/daemon` are released in step. The daemon
  peer-depends on the core line, so a release that moved core's major and left
  the daemon behind would make `npm install` of the two together fail outright
  with `ERESOLVE`. One tag now publishes both, and the release proves a default
  install of the pair before it finishes.
- The JavaScript engine covers a tree with a single recursive watch on Windows.
  A `fs.watch` handle per directory is re-issued there after each batch it
  reports and drops whatever lands in the gap, so a burst of a few hundred
  writes arrived as two or three events, with no error raised and nothing to
  tell the loss from quiet. Every other platform keeps one watch per directory.
- A directory watch that faulted is re-armed rather than abandoned. The engine
  had closed it and carried on reporting itself healthy while every later change
  in that directory went unseen; it now reopens the watch, bounded by a ceiling
  on consecutive failures, and queues `rescanRequired` for the gap.
- Linux delivered no events at all — the old Zig watcher never armed its inotify
  thread — and the paths that did arrive were corrupt, because `FileEvent` used
  a fat pointer where Rust read a thin one.
- The webpack plugin no longer watches above the project root. Node's resolver
  probes for `package.json` and `node_modules` in every directory up to the
  filesystem root, and registering the parent of each miss put a watch on `/`,
  the home directory, and `/tmp` — so an idle dev server rebuilt continuously.
- The Vite plugin keeps the roots that exist when one cannot be watched, rather
  than disabling itself over a single typo in `watchPaths`, and a start that
  fails after creating the engine now closes it instead of leaking the handle.
- Vite's own chokidar is gated through the shared content oracle. It previously
  reported every write unconditionally, so a save that changed no bytes still
  reloaded the browser and a genuine edit was invalidated twice.
- Watcher options coming from a config file are normalized. A capacity of `0`
  produced a watcher that started, reported every counter healthy, and delivered
  nothing; a `null` left by a trailing comma in an exclude list made the native
  engine reject the whole list and cost the caller their watcher.
- Retained watcher state is bounded, drains are coalesced to one microtask per
  burst, and the content hasher reuses its read buffer.
- A reconciler spawn failure raises a rescan signal instead of silently
  accepting the create/write loss window.
- The `lib/` sources the package ships were being published to npm while ignored
  by git, so the tarball contained code absent from the repository.
- The workspace repository URL pointed at an account that does not exist, and
  `retrigger-system` declared no license, repository, or `rust-version`, which
  would have made it unpublishable.

## [1.0.4] - 2025-10-04

Published `@retrigger/core` and `@retrigger/daemon` to npm under the
`@retrigger` scope, with prebuilt platform packages for macOS, Linux (glibc and
musl), and Windows on x64 and arm64, and a zero-dependency JavaScript fallback
for everything else.

Releases before this one predate the changelog; `git log` is the record.

[unreleased]: https://github.com/GriffinCanCode/Retrigger/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/GriffinCanCode/Retrigger/compare/v1.0.4...v2.0.0
[1.0.4]: https://github.com/GriffinCanCode/Retrigger/releases/tag/v1.0.4
