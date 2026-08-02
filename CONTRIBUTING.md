# Contributing to Retrigger

## The shape of the repository

Three layers, three toolchains:

| Path                  | Language   | What lives there                                 |
| --------------------- | ---------- | ------------------------------------------------ |
| `src/core`            | C11        | XXH3-64 hash engine with runtime SIMD dispatch   |
| `src/daemon`          | Rust       | Watcher, standalone daemon, and the Node addon   |
| `src/bindings/nodejs` | JavaScript | Public npm package, bundler plugins, JS fallback |

`docs/ARCHITECTURE.md` explains how they fit together. Read it before moving
anything between layers.

## Getting set up

```bash
make check-deps   # tells you which toolchains are missing
make all          # build every layer
make test         # run every suite
```

You need a C compiler, a Rust toolchain, and Node 18 or newer. `rust-toolchain.toml`
and `.nvmrc` pin the versions; `clang-format` and `cargo-audit` are optional and
only needed for `make format` and `make audit`.

## The gate

```bash
make verify
```

That is lint, every suite, the sanitizers, and the packaged-install proof. If it
passes, the change is in a shippable state. CI runs the same things across nine
OS/arch/Node combinations plus musl, so a green local run is necessary but not
sufficient — expect the matrix to find platform-specific problems.

Useful narrower targets while iterating:

```bash
make test-core        # C engine only
make test-rust        # Rust only
make test-node        # JavaScript only
make test-core-asan   # C engine under AddressSanitizer and UBSan
make test-flake       # five consecutive runs, to surface timing flakes
make test-docker      # the Linux suite from a Mac
```

## Things this project is strict about

**A hash value is a contract.** The hash is a cache key. If it changes, every
consumer's cache silently becomes wrong while still looking fresh. Changing hash
output is a breaking change and needs a major version, not a patch.

**Every SIMD path must agree, bit for bit.** The scalar, NEON, SSE2, AVX2, and
AVX-512 kernels compute the same function. `rtr_hash_force_level` exists so one
machine can prove it. A new kernel is not done until the differential test
covers it.

**Dispatch is a runtime decision.** Never `-march=native`, never a compile-time
`#ifdef` choosing a vector width. The machine that builds the binary is not the
machine that runs it; a compile-time choice turns a portability question into an
illegal-instruction crash.

**The JavaScript fallback is not optional.** The package must load and work with
no native addon present at all. CI has a job that deletes every `.node` file and
runs the suite to prove it. An unsupported platform degrades; it does not throw
at `require()` time.

**Correctness is checked against an external oracle.** XXH3 has published
reference vectors. Tests assert against those, not against our own output.

**Benchmarks report real measurements.** No projected numbers, no figures from a
different machine presented as this one's.

## Style

Formatting is checked, not debated:

```bash
make format   # cargo fmt, prettier, clang-format
make lint     # clippy -D warnings, cargo fmt --check, prettier --check
```

The configuration lives in `rustfmt.toml`, `.clang-format`, `.prettierrc`, and
`.editorconfig`. If your editor honours EditorConfig, most of it is automatic.

Comments explain why, not what. The existing code is a good guide: it documents
the constraint that makes a line necessary — the reason dispatch cannot be a
compile-time decision, the reason `panic = "abort"` would be wrong — and leaves
the mechanics to the code.

## Commits and pull requests

Conventional-commit prefixes (`fix:`, `feat:`, `perf:`, `docs:`, `chore:`,
`deps:`) keep the log skimmable. Explain the problem in the body, not the patch.

Before opening a PR:

- `make verify` passes, or the PR says why it cannot run locally
- a behaviour change has a test that fails without the change
- anything touching hash output, the public JS API, or the IPC format says so
  explicitly in the PR description

## Reporting problems

Bugs and features go through the issue templates. Security vulnerabilities do
not: report them privately, per [SECURITY.md](.github/SECURITY.md).
