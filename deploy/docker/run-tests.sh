#!/usr/bin/env bash
#
# Linux verification runner, executed as the test images' entrypoint.
#
# Beyond pass/fail, this reports which code paths actually ran -- the detected
# SIMD level and the watcher backend. A green suite that silently fell back to
# scalar hashing or a polling watcher would not prove what we need it to prove,
# so the evidence is printed rather than assumed.

set -uo pipefail

cd /src

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
pass() { printf '\033[0;32mPASS\033[0m %s\n' "$*"; }
fail() { printf '\033[0;31mFAIL\033[0m %s\n' "$*"; }
info() { printf '\033[0;34m  ..\033[0m %s\n' "$*"; }

FAILURES=()

run_suite() {
  local name="$1"
  shift
  bold "── ${name}"
  if "$@"; then
    pass "${name}"
  else
    fail "${name}"
    FAILURES+=("${name}")
  fi
  echo
}

bold "═══ Retrigger Linux verification ═══"
info "kernel:  $(uname -sr)"
info "arch:    $(uname -m)"
info "libc:    $(ldd --version 2>&1 | head -1)"
info "cpu:     $(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | xargs || echo unknown)"
info "inotify: max_user_watches=$(cat /proc/sys/fs/inotify/max_user_watches 2>/dev/null || echo unknown)"
echo

# --- evidence that the intended native paths are live -----------------------
bold "── environment capability probe"

if [[ -x ./src/core/build/bin/hash_info ]]; then
  ./src/core/build/bin/hash_info || true
elif [[ -x ./src/build/linux-$(uname -m)/bin/hash_info ]]; then
  "./src/build/linux-$(uname -m)/bin/hash_info" || true
else
  info "hash_info probe not built; SIMD level will be reported by the C suite"
fi
echo

# --- suites -----------------------------------------------------------------
run_suite "C hash engine" make --no-print-directory -C src/core test
run_suite "C hash engine (ASan/UBSan)" make --no-print-directory -C src/core asan
# retrigger-nodejs-bindings is included again as of napi 3. It is a `cdylib`
# whose napi_* symbols come from the Node process that loads it, and under
# napi 2 the harness `cargo test` builds had no such host: on x86-64 it linked
# but the loader died with exit 127 resolving napi_reference_unref through a
# GOT relocation. napi 3 loads those symbols at runtime (napi-sys
# `dyn-symbols`), so the harness has no napi_* imports left to resolve and its
# pure-logic unit tests run here rather than only on macOS.
run_suite "Rust workspace" cargo test --workspace --release
run_suite "Native addon artifact" bash -c 'cd src/bindings/nodejs && node scripts/verify-artifact.js'
run_suite "JavaScript" bash -c 'cd src/bindings/nodejs && npm test'
run_suite "Packaged install" bash -c 'cd src/bindings/nodejs && npm run test:pack'

# --- verdict ----------------------------------------------------------------
bold "═══ verdict ═══"
if [[ ${#FAILURES[@]} -eq 0 ]]; then
  pass "all suites passed on $(uname -s)/$(uname -m)"
  exit 0
fi

fail "${#FAILURES[@]} suite(s) failed:"
for f in "${FAILURES[@]}"; do printf '       - %s\n' "$f"; done
exit 1
