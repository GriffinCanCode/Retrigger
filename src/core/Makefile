# C Core Hashing Engine Makefile
# High-performance SIMD-optimized hashing implementation

# Configuration
BUILD_TYPE ?= release
CC ?= gcc
AR ?= ar
TARGET ?= $(shell $(CC) -dumpmachine)

# Directories
SRC_DIR := src
INCLUDE_DIR := include
BUILD_DIR := ../build/$(shell uname -s | tr A-Z a-z)-$(shell uname -m)
OBJ_DIR := $(BUILD_DIR)/obj
LIB_DIR := $(BUILD_DIR)/lib
BIN_DIR := $(BUILD_DIR)/bin

# Compiler flags
CFLAGS := -Wall -Wextra -std=c11 -fPIC -I$(INCLUDE_DIR)
LDFLAGS := -shared

# Optimization flags
ifeq ($(BUILD_TYPE),release)
    CFLAGS += -O3 -DNDEBUG -march=native -mtune=native
else
    CFLAGS += -O0 -g -DDEBUG -fsanitize=address
    LDFLAGS += -fsanitize=address
endif

# Platform-specific flags
UNAME_S := $(shell uname -s)
UNAME_M := $(shell uname -m)

ifeq ($(UNAME_S),Darwin)
    LDFLAGS += -install_name @rpath/libretrigger_hash.dylib
    LIB_EXT := dylib
else ifeq ($(UNAME_S),Linux)
    LDFLAGS += -Wl,-soname,libretrigger_hash.so
    LIB_EXT := so
else
    LIB_EXT := dll
endif

# SIMD detection and flags
ifeq ($(UNAME_M),x86_64)
    # Check for AVX-512 support (requires both F and DQ for full functionality)
    AVX512_SUPPORT := $(shell $(CC) -mavx512f -mavx512dq -E -dM - < /dev/null 2>/dev/null | grep -E "__AVX512(F|DQ)__" | wc -l | grep -q "2" && echo 1 || echo 0)
    ifeq ($(AVX512_SUPPORT),1)
        CFLAGS += -mavx512f -mavx512dq -DHAVE_AVX512
    endif
    
    # Check for AVX2 support  
    AVX2_SUPPORT := $(shell $(CC) -mavx2 -E -dM - < /dev/null 2>/dev/null | grep -q "__AVX2__" && echo 1 || echo 0)
    ifeq ($(AVX2_SUPPORT),1)
        CFLAGS += -mavx2 -DHAVE_AVX2
    endif
else ifeq ($(UNAME_M),aarch64)
    CFLAGS += -march=armv8-a+simd -DHAVE_NEON
else ifeq ($(UNAME_M),arm64)
    CFLAGS += -march=armv8-a+simd -DHAVE_NEON
endif

# Library source files (platform-specific)
LIB_SOURCES := $(SRC_DIR)/retrigger_hash.c

# Platform-specific SIMD sources
ifeq ($(UNAME_M),x86_64)
    SIMD_SOURCES := $(SRC_DIR)/simd_avx2.c $(SRC_DIR)/simd_avx512.c
else ifeq ($(UNAME_M),aarch64)
    SIMD_SOURCES := $(SRC_DIR)/simd_neon.c
else ifeq ($(UNAME_M),arm64)
    SIMD_SOURCES := $(SRC_DIR)/simd_neon.c
endif

LIB_SOURCES += $(SIMD_SOURCES)
LIB_OBJECTS := $(LIB_SOURCES:$(SRC_DIR)/%.c=$(OBJ_DIR)/%.o)
LIB_DEPS := $(LIB_OBJECTS:.o=.d)

# Targets
STATIC_LIB := $(LIB_DIR)/libretrigger_hash.a
SHARED_LIB := $(LIB_DIR)/libretrigger_hash.$(LIB_EXT)
TEST_BIN := $(BIN_DIR)/test_hash
BENCH_BIN := $(BIN_DIR)/bench_hash

.PHONY: all static shared test benchmark clean install uninstall help

all: static shared ## Build both static and shared libraries

static: $(STATIC_LIB) ## Build static library

shared: $(SHARED_LIB) ## Build shared library

# Create directories
$(OBJ_DIR) $(LIB_DIR) $(BIN_DIR):
	@mkdir -p $@

# Compile source files with dependency tracking
$(OBJ_DIR)/%.o: $(SRC_DIR)/%.c | $(OBJ_DIR)
	@echo "CC $<"
	@$(CC) $(CFLAGS) -MMD -MP -c $< -o $@

# Build static library
$(STATIC_LIB): $(LIB_OBJECTS) | $(LIB_DIR)
	@echo "AR $@"
	@$(AR) rcs $@ $^

# Build shared library
$(SHARED_LIB): $(LIB_OBJECTS) | $(LIB_DIR)
	@echo "LD $@"
	@$(CC) $(LDFLAGS) -o $@ $^

# Build test executable
$(TEST_BIN): $(SRC_DIR)/test_hash.c $(STATIC_LIB) | $(BIN_DIR)
	@echo "CC $@"
	@$(CC) $(CFLAGS) -I$(INCLUDE_DIR) $< $(STATIC_LIB) -o $@

# Build benchmark executable
$(BENCH_BIN): $(SRC_DIR)/bench_hash.c $(STATIC_LIB) | $(BIN_DIR)
	@echo "CC $@"
	@$(CC) $(CFLAGS) -I$(INCLUDE_DIR) $< $(STATIC_LIB) -o $@ -lm

test: $(TEST_BIN) ## Build and run tests
	@echo "Running tests..."
	@$(TEST_BIN)

benchmark: $(BENCH_BIN) ## Build and run benchmarks
	@echo "Running benchmarks..."
	@$(BENCH_BIN)

install: $(SHARED_LIB) $(STATIC_LIB) ## Install libraries and headers
	@echo "Installing libraries..."
	@sudo mkdir -p /usr/local/lib /usr/local/include/retrigger
	@sudo cp $(SHARED_LIB) $(STATIC_LIB) /usr/local/lib/
	@sudo cp $(INCLUDE_DIR)/*.h /usr/local/include/retrigger/
	@sudo ldconfig 2>/dev/null || true

uninstall: ## Uninstall libraries and headers
	@echo "Uninstalling libraries..."
	@sudo rm -f /usr/local/lib/libretrigger_hash.*
	@sudo rm -rf /usr/local/include/retrigger/
	@sudo ldconfig 2>/dev/null || true

clean: ## Clean build artifacts
	@echo "Cleaning..."
	@rm -rf $(BUILD_DIR)

info: ## Show build configuration
	@echo "Build Configuration:"
	@echo "  CC: $(CC)"
	@echo "  Target: $(TARGET)"
	@echo "  Build Type: $(BUILD_TYPE)"
	@echo "  CFLAGS: $(CFLAGS)"
	@echo "  LDFLAGS: $(LDFLAGS)"
	@echo "  Platform: $(UNAME_S)-$(UNAME_M)"
	@echo "  Library Extension: $(LIB_EXT)"

help: ## Show this help
	@echo "C Core Hashing Engine Build System"
	@echo ""
	@echo "Usage: make [target] [BUILD_TYPE=debug|release]"
	@echo ""
	@echo "Targets:"
	@awk '/^[a-zA-Z_-]+:.*?## .*$$/ { \
		helpCommand = substr($$1, 1, index($$1, ":")-1); \
		helpMessage = substr($$0, index($$0, "## ")+3); \
		printf "  %-15s %s\n", helpCommand, helpMessage; \
	}' $(MAKEFILE_LIST)

# Include dependency files
-include $(LIB_DEPS)
