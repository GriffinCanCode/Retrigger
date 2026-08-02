# Retrigger build system
#
# Three layers, three toolchains:
#   src/core            C          XXH3-64 hash engine with runtime SIMD dispatch
#   src/daemon          Rust       watcher, daemon, and the Node addon
#   src/bindings/nodejs JavaScript public package, bundler plugins, JS fallback
#
# The Zig layer that used to sit between Rust and the kernel is gone; the
# watcher is native Rust now, so `zig` is no longer a build dependency.

.DEFAULT_GOAL := help
SHELL := /bin/bash

BUILD_TYPE ?= release
CARGO_FLAGS := $(if $(filter debug,$(BUILD_TYPE)),,--release)

# Wall-clock budget per libFuzzer target. Short by default so `make fuzz` is usable
# in a normal edit-test loop; raise it for a real campaign (FUZZ_SECONDS=600).
FUZZ_SECONDS ?= 30

CORE_DIR := src/core
RUST_DIR := src/daemon
NODE_DIR := src/bindings/nodejs
DOCKER_DIR := deploy/docker

OS := $(shell uname -s | tr A-Z a-z)
ARCH := $(shell uname -m | sed -e 's/^x86_64$$/x64/' -e 's/^aarch64$$/arm64/')

RED := \033[0;31m
GREEN := \033[0;32m
YELLOW := \033[1;33m
BLUE := \033[0;34m
NC := \033[0m

define step
	@printf "$(BLUE)==>$(NC) %s\n" $(1)
endef

define ok
	@printf "$(GREEN) ok$(NC) %s\n" $(1)
endef

# ---------------------------------------------------------------- building

.PHONY: all
all: build-core build-rust build-node ## Build every layer

.PHONY: build
build: all ## Alias for 'all'

.PHONY: build-core
build-core: ## Build the C hash engine
	$(call step,"Building C hash engine")
	@$(MAKE) -C $(CORE_DIR) BUILD=$(BUILD_TYPE)
	$(call ok,"C hash engine")

.PHONY: build-rust
build-rust: ## Build the Rust workspace
	$(call step,"Building Rust workspace ($(BUILD_TYPE))")
	@cargo build --workspace $(CARGO_FLAGS)
	$(call ok,"Rust workspace")

.PHONY: build-node
build-node: ## Build the Node addon and install JS dependencies
	$(call step,"Building Node addon")
	@cd $(NODE_DIR) && npm ci --no-audit --no-fund
	@cd $(NODE_DIR) && npm run build$(if $(filter debug,$(BUILD_TYPE)),:debug,)
	$(call ok,"Node addon")

# ----------------------------------------------------------------- testing

.PHONY: test
test: test-core test-rust test-node test-daemon ## Run every test suite
	$(call ok,"all test suites passed")

.PHONY: test-core
test-core: ## C engine tests (reference vectors, SIMD equivalence, fuzz corpus)
	$(call step,"Testing C hash engine")
	@$(MAKE) -C $(CORE_DIR) test

.PHONY: test-core-asan
test-core-asan: ## C engine tests under AddressSanitizer + UBSan
	$(call step,"Testing C hash engine under ASan/UBSan")
	@$(MAKE) -C $(CORE_DIR) asan

.PHONY: test-core-fuzz
test-core-fuzz: ## Fuzz the C engine against its persistent corpus (FUZZ_SECONDS=n)
	$(call step,"Fuzzing C hash engine ($(FUZZ_SECONDS)s per target)")
	@$(MAKE) -C $(CORE_DIR) fuzz FUZZ_SECONDS=$(FUZZ_SECONDS)

# The Node addon is a cdylib whose napi_* symbols come from the Node process
# that loads it. Under napi 2 that meant a standalone `cargo test` harness had
# no host for them and the crate had to be excluded on every platform but
# macOS. napi 3 resolves them at load time (napi-sys `dyn-symbols`, on by
# default), so the harness links with no napi_* imports anywhere and the whole
# workspace is one command again.
.PHONY: test-rust
test-rust: ## Rust unit and integration tests
	$(call step,"Testing Rust workspace")
	@cargo test --workspace $(CARGO_FLAGS)

.PHONY: test-node
test-node: ## JavaScript test suite
	$(call step,"Testing JavaScript layer")
	@cd $(NODE_DIR) && npm test

# The daemon npm package is a shim over a compiled Rust binary shipped per
# platform, so its Node-side test proves the shim, the packaged config, and the
# documented no-binary degradation -- not the daemon itself, which cargo tests.
.PHONY: test-daemon
test-daemon: ## Daemon npm package smoke test (shim, config, degradation)
	$(call step,"Testing daemon npm package")
	@node $(RUST_DIR)/scripts/test-daemon.js

# Memory behaviour is spread across three toolchains and three kinds of check, so it
# gets one entry point. Everything here also runs inside the normal suites; this
# target is for iterating on the memory work without waiting for the rest.
.PHONY: test-memory
test-memory: ## Memory hardening suite: OOM injection, bounded-growth, leak, and property tests
	$(call step,"C: allocation-failure and leak injection")
	@$(MAKE) -C $(CORE_DIR) test
	$(call step,"C: sanitizers")
	@$(MAKE) -C $(CORE_DIR) asan
	$(call step,"Rust: bounded-growth stress suite")
	@cargo test -p retrigger-system $(CARGO_FLAGS) --test memory
	$(call step,"Rust: randomised invariant properties")
	@cargo test -p retrigger-system $(CARGO_FLAGS) --lib properties
	$(call step,"JavaScript: retention and leak suite")
	@cd $(NODE_DIR) && npx vitest run test/memory.test.mjs
	$(call ok,"memory suite passed")

.PHONY: test-install
test-install: ## Prove the npm package installs and loads in a clean directory
	$(call step,"Verifying packaged install")
	@cd $(NODE_DIR) && npm run test:pack

.PHONY: test-fresh
test-fresh: ## Build and test in a pristine copy of the tree (no cached artifacts)
	@scripts/verify-fresh-build.sh

.PHONY: test-docker
test-docker: ## Run the Linux suite in Docker (proves Linux from a Mac)
	$(call step,"Running Linux suite in Docker")
	@docker build -f $(DOCKER_DIR)/Dockerfile.test -t retrigger-test:linux .
	@docker run --rm retrigger-test:linux

.PHONY: test-flake
test-flake: ## Run the suites repeatedly to surface timing flakes
	$(call step,"Flake hunt: 5 consecutive runs")
	@for i in 1 2 3 4 5; do \
		printf "$(YELLOW)-- run %s --$(NC)\n" $$i; \
		$(MAKE) --no-print-directory test-rust test-node || exit 1; \
	done
	$(call ok,"no flakes in 5 runs")

# ------------------------------------------------------------- adversarial
#
# Three tiers, by cost and determinism:
#
#   test-adversarial  bounded, deterministic, seeded. Safe for the PR gate and a
#                     normal edit loop; these also run inside `make test` because
#                     the suites auto-discover their files. This target is the
#                     focused subset for iterating on them alone.
#   test-chaos        the heavy cases -- storms, repeated-run flake hunts, and
#                     fault injection -- kept out of the default run (Rust marks
#                     them #[ignore]) so they never tax the gate. Run them here or
#                     via the manual `campaign` workflow.
#   test-fuzz         time-budgeted stochastic exploration: the C libFuzzer
#                     targets plus a high-iteration proptest pass.
#
# PROPTEST_CASES and CHAOS_ITERATIONS scale the stochastic tiers without editing
# code; FUZZ_SECONDS (see above) scales the fuzz campaign.
CHAOS_ITERATIONS ?= 3
PROPTEST_CASES   ?= 4096

.PHONY: test-adversarial
test-adversarial: ## Bounded, seeded adversarial suites across all three layers
	$(call step,"C: deterministic metamorphic + contract + adversarial I/O")
	@$(MAKE) -C $(CORE_DIR) test
	$(call step,"Rust: state-machine properties and filesystem races")
	@cargo test -p retrigger-system $(CARGO_FLAGS) --lib properties
	@cargo test -p retrigger-system $(CARGO_FLAGS) --test races
	@cargo test -p retrigger-daemon $(CARGO_FLAGS) --lib config
	$(call step,"JavaScript: property and toxic-input suites")
	@cd $(NODE_DIR) && npx vitest run test/property.test.mjs test/toxic.test.mjs
	$(call ok,"adversarial suites passed")

.PHONY: test-chaos
test-chaos: ## Heavy storms, fault injection, and repeated-run flake hunts (local/manual)
	$(call step,"Rust: storms and fault injection (#[ignore] cases)")
	@PROPTEST_CASES=$(PROPTEST_CASES) cargo test --workspace $(CARGO_FLAGS) -- --ignored
	$(call step,"Flake hunt: $(CHAOS_ITERATIONS) consecutive adversarial runs")
	@for i in $$(seq 1 $(CHAOS_ITERATIONS)); do \
		printf "$(YELLOW)-- chaos run %s/%s --$(NC)\n" $$i $(CHAOS_ITERATIONS); \
		$(MAKE) --no-print-directory test-adversarial || exit 1; \
	done
	$(call ok,"chaos suites survived")

.PHONY: test-fuzz
test-fuzz: ## Time-budgeted stochastic exploration (C libFuzzer + high-iteration proptest)
	$(call step,"C: libFuzzer targets ($(FUZZ_SECONDS)s each)")
	@$(MAKE) -C $(CORE_DIR) fuzz FUZZ_SECONDS=$(FUZZ_SECONDS)
	$(call step,"Rust: high-iteration proptest ($(PROPTEST_CASES) cases)")
	@PROPTEST_CASES=$(PROPTEST_CASES) cargo test -p retrigger-system $(CARGO_FLAGS) --lib properties
	$(call ok,"fuzz campaign clean")

.PHONY: check-fuzz
check-fuzz: ## Compile the fuzz targets without running them (no libFuzzer needed)
	$(call step,"Type-checking fuzz targets")
	@$(MAKE) -C $(CORE_DIR) fuzz-build

# The gate. If this passes, the product is in a shippable state.
#
# `check-fuzz` rather than `test-core-fuzz`: the gate must give the same answer on
# every machine, and the fuzzer runtime is not present in every clang install. The
# targets are still compiled here so they cannot rot unnoticed; running them is a
# separate, time-budgeted step.
.PHONY: verify
verify: lint test test-core-asan check-fuzz test-install test-fresh ## Full verification gate
	$(call ok,"VERIFIED")

# ----------------------------------------------------------------- quality

.PHONY: lint
lint: lint-rust lint-node ## Run all linters

.PHONY: lint-rust
lint-rust:
	$(call step,"Linting Rust")
	@cargo clippy --workspace --all-targets -- -D warnings
	@cargo fmt --all -- --check

.PHONY: lint-node
lint-node:
	$(call step,"Linting JavaScript (format + published .d.ts contract)")
	@cd $(NODE_DIR) && npm run lint

.PHONY: format
format: ## Format all code
	@cargo fmt --all
	@cd $(NODE_DIR) && npm run format
	@command -v clang-format >/dev/null && clang-format -i $(CORE_DIR)/src/*.c $(CORE_DIR)/include/*.h || \
		printf "$(YELLOW) ..$(NC) clang-format not installed, skipping C\n"

.PHONY: audit
audit: ## Dependency vulnerability audit
	@cargo audit || printf "$(YELLOW) ..$(NC) install with: cargo install cargo-audit\n"
	@cd $(NODE_DIR) && npm audit --audit-level moderate

# -------------------------------------------------------------- benchmarks

.PHONY: bench
bench: ## Run benchmarks (real measurements only)
	$(call step,"Benchmarking C hash engine")
	@$(MAKE) -C $(CORE_DIR) bench
	$(call step,"Benchmarking Rust watcher")
	@cargo bench --workspace

# ------------------------------------------------------------------ docker

.PHONY: docker
docker: ## Build distribution Docker images
	@docker build -t retrigger:latest -f $(DOCKER_DIR)/Dockerfile .
	@docker build -t retrigger:alpine -f $(DOCKER_DIR)/Dockerfile.alpine .

# ----------------------------------------------------------------- utility

.PHONY: clean
clean: ## Remove build artifacts
	@cargo clean
	@$(MAKE) -C $(CORE_DIR) clean 2>/dev/null || true
	@rm -rf $(NODE_DIR)/node_modules $(NODE_DIR)/*.node $(NODE_DIR)/coverage
	@rm -rf src/build dist
	$(call ok,"cleaned")

.PHONY: check-deps
check-deps: ## Verify the required toolchains are present
	@fail=0; \
	for tool in cargo rustc node npm cc; do \
		if command -v $$tool >/dev/null 2>&1; then \
			printf "$(GREEN) ok$(NC) %-8s %s\n" $$tool "$$($$tool --version 2>&1 | head -1)"; \
		else \
			printf "$(RED)mis$(NC) %-8s not found\n" $$tool; fail=1; \
		fi; \
	done; \
	for tool in docker clang-format cargo-audit; do \
		command -v $$tool >/dev/null 2>&1 \
			&& printf "$(GREEN) ok$(NC) %-8s (optional)\n" $$tool \
			|| printf "$(YELLOW) ..$(NC) %-8s (optional) not found\n" $$tool; \
	done; \
	exit $$fail

.PHONY: info
info: ## Show build environment
	@printf "os=%s arch=%s build=%s\n" "$(OS)" "$(ARCH)" "$(BUILD_TYPE)"
	@printf "rust=%s\n" "$$(rustc --version 2>/dev/null || echo missing)"
	@printf "node=%s\n" "$$(node --version 2>/dev/null || echo missing)"
	@printf "cc=%s\n"   "$$(cc --version 2>/dev/null | head -1 || echo missing)"

.PHONY: help
help: ## Show this help
	@printf "$(BLUE)Retrigger$(NC)  make [target] [BUILD_TYPE=debug|release]\n\n"
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / \
		{printf "  $(GREEN)%-18s$(NC) %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@printf "\n  $(YELLOW)make verify$(NC) is the gate: lint + every suite + sanitizers + install proof\n"
