# Retrigger - Ultra-fast file system watcher
# Multi-language build system for C, Zig, Rust, and Node.js components

.PHONY: all build test clean install dev benchmark docker lint format check-deps setup help
.DEFAULT_GOAL := help

# Build configuration
BUILD_TYPE ?= release
TARGET ?= $(shell rustc -vV | grep host | cut -d' ' -f2)
NODE_VERSION ?= 18

# Directories
CORE_DIR := src/core
ZIG_DIR := src/system/zig
RUST_DIR := src/daemon
BINDINGS_DIR := src/bindings/nodejs
TOOLS_DIR := tools
BENCHMARK_DIR := tools/benchmarks
DOCKER_DIR := deploy/docker

# Colors for output
RED := \033[0;31m
GREEN := \033[0;32m
YELLOW := \033[1;33m
BLUE := \033[0;34m
NC := \033[0m # No Color

# Detect OS and architecture
OS := $(shell uname -s | tr A-Z a-z)
ARCH := $(shell uname -m)

ifeq ($(ARCH),x86_64)
    ARCH := x64
endif
ifeq ($(ARCH),aarch64)
    ARCH := arm64
endif
ifeq ($(ARCH),arm64)
    ARCH := arm64
endif

## Build targets

all: check-deps build-core build-system build-rust build-bindings ## Build all components
	@echo "$(GREEN)✓ All components built successfully$(NC)"

build: all ## Alias for 'all'

build-core: ## Build C hashing core with SIMD optimizations
	@echo "$(BLUE)Building C core hashing engine...$(NC)"
	@mkdir -p build/$(OS)-$(ARCH)
	@cd $(CORE_DIR) && $(MAKE) BUILD_TYPE=$(BUILD_TYPE) TARGET=$(TARGET)
	@echo "$(GREEN)✓ C core built$(NC)"

build-system: check-zig ## Build Zig system integration layer
	@echo "$(BLUE)Building Zig system integration...$(NC)"
	@cd $(ZIG_DIR) && zig build -Doptimize=$(if $(filter debug,$(BUILD_TYPE)),Debug,ReleaseFast)
	@echo "$(GREEN)✓ Zig system layer built$(NC)"

build-rust: ## Build Rust daemon and libraries
	@echo "$(BLUE)Building Rust components...$(NC)"
	@cargo build $(if $(filter debug,$(BUILD_TYPE)),,--release) --workspace
	@echo "$(GREEN)✓ Rust components built$(NC)"

build-bindings: check-node ## Build Node.js native bindings
	@echo "$(BLUE)Building Node.js bindings...$(NC)"
	@cd $(BINDINGS_DIR) && npm ci
	@cd $(BINDINGS_DIR) && npm run build$(if $(filter debug,$(BUILD_TYPE)),:debug,)
	@echo "$(GREEN)✓ Node.js bindings built$(NC)"

## Development targets

dev: ## Set up development environment
	@echo "$(BLUE)Setting up development environment...$(NC)"
	@$(MAKE) setup
	@$(MAKE) build BUILD_TYPE=debug
	@echo "$(GREEN)✓ Development environment ready$(NC)"

setup: check-deps ## Install all dependencies and tools
	@echo "$(BLUE)Installing dependencies...$(NC)"
	
	# Install Rust dependencies
	@rustup component add rustfmt clippy
	@cargo install cargo-watch cargo-nextest
	
	# Install Node.js dependencies
	@cd $(BINDINGS_DIR) && npm ci
	
	# Install additional tools
	@if command -v brew >/dev/null 2>&1; then \
		echo "Installing system dependencies via Homebrew..."; \
		brew install zig llvm; \
	elif command -v apt-get >/dev/null 2>&1; then \
		echo "Installing system dependencies via apt..."; \
		sudo apt-get update && sudo apt-get install -y zig-dev llvm-dev liburing-dev; \
	else \
		echo "$(YELLOW)Please install zig and llvm manually$(NC)"; \
	fi
	
	@echo "$(GREEN)✓ Setup complete$(NC)"

watch: ## Run in development watch mode
	@echo "$(BLUE)Starting development watch mode...$(NC)"
	@cargo watch -x "build" -x "test" --ignore "bindings/**" --ignore "*.log" &
	@cd $(BINDINGS_DIR) && npm run build:debug --watch &
	@wait

## Testing targets

test: test-core test-rust test-bindings ## Run all tests
	@echo "$(GREEN)✓ All tests passed$(NC)"

test-core: build-core ## Run C core tests
	@echo "$(BLUE)Running C core tests...$(NC)"
	@cd $(CORE_DIR) && $(MAKE) test
	@echo "$(GREEN)✓ C core tests passed$(NC)"

test-rust: ## Run Rust tests
	@echo "$(BLUE)Running Rust tests...$(NC)"
	@cargo nextest run --workspace $(if $(filter debug,$(BUILD_TYPE)),,--release)
	@echo "$(GREEN)✓ Rust tests passed$(NC)"

test-bindings: build-bindings ## Run Node.js binding tests
	@echo "$(BLUE)Running Node.js binding tests...$(NC)"
	@cd $(BINDINGS_DIR) && npm test
	@echo "$(GREEN)✓ Node.js binding tests passed$(NC)"

test-integration: build ## Run integration tests
	@echo "$(BLUE)Running integration tests...$(NC)"
	@cd tests/integration && ./run-integration-tests.sh
	@echo "$(GREEN)✓ Integration tests passed$(NC)"

## Performance targets

benchmark: build ## Run performance benchmarks
	@echo "$(BLUE)Running benchmarks...$(NC)"
	@cd $(RUST_DIR)/retrigger-daemon && cargo bench
	@cd $(BINDINGS_DIR) && npm run bench
	@echo "$(GREEN)✓ Benchmarks complete$(NC)"

profile: build ## Profile performance with perf/instruments
	@echo "$(BLUE)Profiling application...$(NC)"
ifeq ($(OS),darwin)
	@instruments -t "Time Profiler" target/$(if $(filter debug,$(BUILD_TYPE)),debug,release)/retrigger --version
else
	@perf record --call-graph dwarf target/$(if $(filter debug,$(BUILD_TYPE)),debug,release)/retrigger --version
	@perf report
endif

## Quality targets

lint: ## Run all linters
	@echo "$(BLUE)Running linters...$(NC)"
	@cargo clippy --workspace --all-targets -- -D warnings
	@cd $(BINDINGS_DIR) && npm run lint
	@echo "$(GREEN)✓ Linting passed$(NC)"

format: ## Format all code
	@echo "$(BLUE)Formatting code...$(NC)"
	@cargo fmt --all
	@cd $(CORE_DIR) && clang-format -i src/*.c include/*.h
	@cd $(ZIG_DIR) && zig fmt src/*.zig
	@cd $(BINDINGS_DIR) && npm run format
	@echo "$(GREEN)✓ Code formatted$(NC)"

check: lint test ## Run all checks (lint + test)
	@echo "$(GREEN)✓ All checks passed$(NC)"

## Package targets

package: build ## Create distribution packages
	@echo "$(BLUE)Creating packages...$(NC)"
	@mkdir -p dist/
	
	# Package Rust daemon
	@cargo build --release --bin retrigger
	@tar -czf dist/retrigger-daemon-$(shell cargo pkgid | cut -d'#' -f2)-$(OS)-$(ARCH).tar.gz \
		-C target/release retrigger
	
	# Package Node.js bindings
	@cd $(BINDINGS_DIR) && npm pack
	@mv $(BINDINGS_DIR)/*.tgz dist/
	
	@echo "$(GREEN)✓ Packages created in dist/$(NC)"

install: build ## Install to system (requires sudo)
	@echo "$(BLUE)Installing Retrigger...$(NC)"
	@sudo cargo install --path src/daemon/retrigger-daemon --root /usr/local
	@echo "$(GREEN)✓ Retrigger installed to /usr/local/bin$(NC)"

uninstall: ## Uninstall from system
	@echo "$(BLUE)Uninstalling Retrigger...$(NC)"
	@sudo rm -f /usr/local/bin/retrigger
	@echo "$(GREEN)✓ Retrigger uninstalled$(NC)"

## Docker targets

docker: ## Build Docker images
	@echo "$(BLUE)Building Docker images...$(NC)"
	@docker build -t retrigger:latest -f $(DOCKER_DIR)/Dockerfile .
	@docker build -t retrigger:alpine -f $(DOCKER_DIR)/Dockerfile.alpine .
	@echo "$(GREEN)✓ Docker images built$(NC)"

docker-test: docker ## Test Docker images
	@echo "$(BLUE)Testing Docker images...$(NC)"
	@docker run --rm retrigger:latest --version
	@docker run --rm retrigger:alpine --version
	@echo "$(GREEN)✓ Docker images tested$(NC)"

## Utility targets

clean: ## Clean build artifacts
	@echo "$(BLUE)Cleaning build artifacts...$(NC)"
	@cargo clean
	@cd $(CORE_DIR) && $(MAKE) clean 2>/dev/null || true
	@cd $(ZIG_DIR) && rm -rf zig-cache zig-out 2>/dev/null || true
	@cd $(BINDINGS_DIR) && rm -rf node_modules *.node target 2>/dev/null || true
	@rm -rf build/ dist/ *.log
	@echo "$(GREEN)✓ Clean complete$(NC)"

reset: clean ## Reset to fresh state (clean + remove deps)
	@echo "$(BLUE)Resetting to fresh state...$(NC)"
	@cd $(BINDINGS_DIR) && rm -rf node_modules package-lock.json
	@rm -f Cargo.lock
	@echo "$(GREEN)✓ Reset complete$(NC)"

check-deps: ## Check if all required dependencies are installed
	@echo "$(BLUE)Checking dependencies...$(NC)"
	@$(MAKE) --quiet check-rust check-zig check-node check-system
	@echo "$(GREEN)✓ All dependencies available$(NC)"

check-rust:
	@command -v rustc >/dev/null || (echo "$(RED)✗ Rust not found$(NC)" && exit 1)
	@command -v cargo >/dev/null || (echo "$(RED)✗ Cargo not found$(NC)" && exit 1)

check-zig:
	@command -v zig >/dev/null || (echo "$(RED)✗ Zig not found - install from https://ziglang.org$(NC)" && exit 1)

check-node:
	@command -v node >/dev/null || (echo "$(RED)✗ Node.js not found$(NC)" && exit 1)
	@command -v npm >/dev/null || (echo "$(RED)✗ npm not found$(NC)" && exit 1)

check-system:
ifeq ($(OS),linux)
	@ldconfig -p | grep -q liburing || echo "$(YELLOW)⚠ liburing not found - some features may be disabled$(NC)"
endif

info: ## Display build information
	@echo "$(BLUE)Build Information:$(NC)"
	@echo "  OS: $(OS)"
	@echo "  Architecture: $(ARCH)"
	@echo "  Build Type: $(BUILD_TYPE)"
	@echo "  Target: $(TARGET)"
	@echo ""
	@echo "$(BLUE)Tool Versions:$(NC)"
	@echo "  Rust: $(shell rustc --version 2>/dev/null || echo 'not found')"
	@echo "  Zig: $(shell zig version 2>/dev/null || echo 'not found')"
	@echo "  Node.js: $(shell node --version 2>/dev/null || echo 'not found')"
	@echo "  GCC: $(shell gcc --version 2>/dev/null | head -1 || echo 'not found')"

help: ## Show this help message
	@echo "$(BLUE)Retrigger Build System$(NC)"
	@echo ""
	@echo "$(YELLOW)Usage:$(NC) make [target] [BUILD_TYPE=debug|release]"
	@echo ""
	@echo "$(YELLOW)Primary Targets:$(NC)"
	@awk '/^[a-zA-Z_-]+:.*?## .*$$/ { \
		if ($$0 !~ /^[[:space:]]*#/) { \
			helpCommand = substr($$1, 1, index($$1, ":")-1); \
			helpMessage = substr($$0, index($$0, "## ")+3); \
			printf "  $(GREEN)%-15s$(NC) %s\n", helpCommand, helpMessage; \
		} \
	}' $(MAKEFILE_LIST)
	@echo ""
	@echo "$(YELLOW)Examples:$(NC)"
	@echo "  make dev                    # Set up development environment"
	@echo "  make build BUILD_TYPE=debug # Build in debug mode"
	@echo "  make test                   # Run all tests"
	@echo "  make benchmark              # Run performance benchmarks"
	@echo "  make docker                 # Build Docker images"
