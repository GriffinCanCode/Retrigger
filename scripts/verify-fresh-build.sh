#!/usr/bin/env bash
#
# Fresh-build verification.
#
# Copies the working tree into a scratch directory with every build output
# excluded, then builds all three layers from zero and runs the suites there.
#
# The failure this is designed to catch is specific and common: a repository
# that builds only because of artifacts already sitting on the developer's
# disk -- a stale libretrigger_hash.a, a target/ directory, a node_modules, a
# .node addon left over from an earlier layout. Those make `make test` pass
# locally while a fresh clone on someone else's machine fails immediately.
# Building in a pristine copy is the cheapest way to tell the two apart
# without waiting for CI.
#
# Usage: scripts/verify-fresh-build.sh [--keep]

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

WORK="$(mktemp -d "${TMPDIR:-/tmp}/retrigger-fresh.XXXXXX")"
cleanup() {
    if [[ $KEEP -eq 1 ]]; then
        printf '\nScratch tree kept at: %s\n' "$WORK"
    else
        rm -rf "$WORK"
    fi
}
trap cleanup EXIT

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
pass() { printf '\033[0;32mPASS\033[0m %s\n' "$*"; }
fail() { printf '\033[0;31mFAIL\033[0m %s\n' "$*"; }
info() { printf '\033[0;34m  ..\033[0m %s\n' "$*"; }

bold "═══ fresh-build verification ═══"
info "source: $REPO_ROOT"
info "scratch: $WORK"

# Copy everything except build outputs and VCS metadata. Deliberately NOT a
# `git archive`, because that would silently skip work that is still untracked.
bold "── copying tree (excluding all build output)"
rsync -a \
    --exclude '.git/' \
    --exclude 'target/' \
    --exclude '**/target/' \
    --exclude 'node_modules/' \
    --exclude '**/node_modules/' \
    --exclude 'src/build/' \
    --exclude '**/*.node' \
    --exclude '**/*.o' \
    --exclude '**/*.a' \
    --exclude '**/*.dylib' \
    --exclude '**/*.so' \
    --exclude '**/*.tgz' \
    --exclude 'coverage/' \
    --exclude '**/coverage/' \
    --exclude 'dist/' \
    "$REPO_ROOT/" "$WORK/"

# Prove the exclusions worked. If any build output survived the copy, the rest
# of this script would be measuring the wrong thing.
LEFTOVER="$(find "$WORK" \( -name '*.node' -o -name '*.a' -o -name '*.o' -o -name '*.dylib' \
    -o -name 'node_modules' -o -name 'target' \) -print -quit 2>/dev/null || true)"
if [[ -n "$LEFTOVER" ]]; then
    fail "build output leaked into the scratch tree: $LEFTOVER"
    exit 1
fi
pass "scratch tree contains no prebuilt artifacts"
echo

cd "$WORK"

FAILURES=()
run() {
    local name="$1"; shift
    bold "── $name"
    if "$@"; then pass "$name"; else fail "$name"; FAILURES+=("$name"); fi
    echo
}

run "build: C hash engine"  make --no-print-directory build-core
run "test:  C hash engine"  make --no-print-directory test-core
run "build: Rust workspace" cargo build --workspace --release
run "test:  Rust workspace" cargo test  --workspace --release
run "install: JS deps"      bash -c 'cd src/bindings/nodejs && npm install --no-audit --no-fund'
run "test:  JavaScript"     bash -c 'cd src/bindings/nodejs && npm test'

bold "═══ verdict ═══"
if [[ ${#FAILURES[@]} -eq 0 ]]; then
    pass "a clean tree builds and tests green from scratch"
    exit 0
fi
fail "${#FAILURES[@]} stage(s) failed in a clean tree:"
for f in "${FAILURES[@]}"; do printf '       - %s\n' "$f"; done
printf '\nRe-run with --keep to inspect the scratch tree.\n'
exit 1
