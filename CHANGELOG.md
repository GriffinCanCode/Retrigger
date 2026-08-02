# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**A hash value is part of the public API.** The hash is used as a cache key, so
a change to its output silently invalidates every consumer's cache while still
looking correct. Any change to hash output, the IPC message format, or the
on-disk format is a major version bump and is called out under **Breaking**.

## [Unreleased]

### Breaking

- The Zig system layer between Rust and the kernel has been removed. The watcher
  is native Rust now, and `zig` is no longer a build dependency.

### Changed

- The C hash engine is the real XXH3-64 algorithm as specified by xxHash, so
  correctness is checked against published reference vectors rather than against
  the engine's own output. The scalar, NEON, SSE2, AVX2, and AVX-512 paths are
  required to be bit-identical, and `rtr_hash_force_level` exists so a single
  machine can prove it.
- SIMD selection is a runtime `cpuid`/`xgetbv` decision. Nothing in the library
  is compiled with `-march=native`, so a binary built on one machine runs on
  another instead of trapping on an illegal instruction.
- `rtr_hash_file` streams a file in bounded chunks, keeping peak memory
  independent of file size.

## [1.0.4] - 2025-10-04

Published `@retrigger/core` and `@retrigger/daemon` to npm under the
`@retrigger` scope, with prebuilt platform packages for macOS, Linux (glibc and
musl), and Windows on x64 and arm64, and a zero-dependency JavaScript fallback
for everything else.

Releases before this one predate the changelog; `git log` is the record.

[unreleased]: https://github.com/GriffinCanCode/Retrigger/compare/v1.0.4...HEAD
[1.0.4]: https://github.com/GriffinCanCode/Retrigger/releases/tag/v1.0.4
