# Retrigger core hashing engine (XXH3-64).
#
# Two rules govern this build and neither is negotiable:
#
#   1. No -march=native, anywhere. The library must load and run on any CPU of
#      the target architecture, so the dispatcher and the engine are compiled
#      at the portable baseline and choose a kernel at runtime.
#   2. Each SIMD translation unit gets only its own ISA flag. -mavx2 applies to
#      xxh3_avx2.c and nothing else; if it leaked into dispatch.c the CPU
#      detection code would fault on the very machines it exists to protect.

CC       ?= cc
AR       ?= ar
BUILD    ?= release

SRC_DIR     := src
INC_DIR     := include
TEST_DIR    := tests
OS          := $(shell uname -s | tr A-Z a-z)
ARCH        := $(shell uname -m)
BUILD_DIR   := ../build/$(OS)-$(ARCH)
OBJ_DIR     := $(BUILD_DIR)/obj
LIB_DIR     := $(BUILD_DIR)/lib
BIN_DIR     := $(BUILD_DIR)/bin

# Portable baseline. -Werror is on because the previous engine shipped with
# fourteen warnings and one of them was a real bug.
#
# -Wvla is a memory-safety warning rather than a style one: a variable-length
# array puts a length this library does not control onto the stack, where there
# is no allocation failure to check and overflowing it is not detectable. With
# -Werror it is a ban, which is the intent.
WARNINGS := -Wall -Wextra -Werror -Wshadow -Wstrict-prototypes -Wpointer-arith -Wvla
BASE     := -std=c11 -fPIC -I$(INC_DIR) $(WARNINGS)

ifeq ($(BUILD),debug)
  BASE += -O0 -g -DDEBUG
else
  BASE += -O3 -DNDEBUG
endif

CFLAGS  ?=

ifeq ($(OS),darwin)
  LIB_EXT    := dylib
  SO_LDFLAGS := -dynamiclib -install_name @rpath/libretrigger_hash.dylib
else ifeq ($(OS),linux)
  LIB_EXT    := so
  # Full RELRO: the relocation table is mapped read-only before any of this
  # library's code runs, so a write through a stray pointer cannot repoint one of
  # our own calls. Costs a one-off resolve at load time and nothing after.
  SO_LDFLAGS := -shared -Wl,-soname,libretrigger_hash.so -Wl,-z,relro,-z,now
else
  LIB_EXT    := so
  SO_LDFLAGS := -shared
endif

# ---------------------------------------------------------------- sources

CORE_SRCS := $(SRC_DIR)/xxh3_ref.c $(SRC_DIR)/dispatch.c \
             $(SRC_DIR)/hash_file.c $(SRC_DIR)/benchmark.c

# Only compile the kernels that can exist on this architecture. A flag is
# probed before use so an old assembler does not break the whole build.
cc_accepts = $(shell $(CC) $(1) -x c -c /dev/null -o /dev/null 2>/dev/null && echo yes)

# A TU that is not compiled must also not be referenced, so every decision
# here is mirrored into the code as -DRTR_ENABLE_<ISA>=0.
SIMD_SRCS :=
ISA_DEFS  :=
ifneq ($(filter x86_64 amd64,$(ARCH)),)
  SIMD_SRCS += $(SRC_DIR)/xxh3_sse2.c
  ifeq ($(call cc_accepts,-mavx2),yes)
    SIMD_SRCS += $(SRC_DIR)/xxh3_avx2.c
  else
    ISA_DEFS += -DRTR_ENABLE_AVX2=0
  endif
  ifeq ($(call cc_accepts,-mavx512f -mavx512bw),yes)
    SIMD_SRCS += $(SRC_DIR)/xxh3_avx512.c
  else
    ISA_DEFS += -DRTR_ENABLE_AVX512=0
  endif
else ifneq ($(filter aarch64 arm64,$(ARCH)),)
  SIMD_SRCS += $(SRC_DIR)/xxh3_neon.c
else
  # Unknown architecture: scalar only, and nothing may reference a kernel.
  ISA_DEFS += -DRTR_ENABLE_NEON=0 -DRTR_ENABLE_SSE2=0 \
              -DRTR_ENABLE_AVX2=0 -DRTR_ENABLE_AVX512=0
endif

# Hardening, probed rather than assumed: these sources get built on machines we
# do not choose, and a flag an old compiler rejects would fail the whole build.
#
# _FORTIFY_SOURCE only does anything in an optimizing build and warns when
# something has already defined it, which under -Werror would be fatal -- hence
# the -U ahead of it and the release-only guard.
HARDEN := $(if $(call cc_accepts,-fstack-protector-strong),-fstack-protector-strong,)
ifneq ($(BUILD),debug)
  HARDEN += $(if $(call cc_accepts,-O2 -U_FORTIFY_SOURCE -D_FORTIFY_SOURCE=2),\
              -U_FORTIFY_SOURCE -D_FORTIFY_SOURCE=2,)
endif

BASE       += $(ISA_DEFS) $(HARDEN)
ALL_CFLAGS := $(BASE) $(CFLAGS)

# The ISA flag for one library source, as a shell case statement, mirroring the
# per-TU object rules below.
#
# The instrumented builds (sanitizers, allocation hooks, fuzzing) compile the
# library from source instead of linking the shipped archive, and they must not
# lose these flags: handing xxh3_avx2.c to the compiler without -mavx2 does not
# produce a slower build, it produces no build at all.
ISA_CASE := isa=""; case $$src in \
	*xxh3_avx2.c)   isa="-mavx2";; \
	*xxh3_avx512.c) isa="-mavx512f -mavx512bw";; \
	*xxh3_sse2.c)   isa="-msse2";; \
	esac

# Compile every library source into $(2) with $(1) added. See ISA_CASE.
define build_lib_variant
	@mkdir -p $(2)
	@for src in $(LIB_SRCS); do \
	  $(ISA_CASE); \
	  $(CC) $(BASE) $(1) $$isa -c $$src -o $(2)/$$(basename $$src .c).o || exit 1; \
	done
endef

LIB_SRCS := $(CORE_SRCS) $(SIMD_SRCS)
LIB_OBJS := $(LIB_SRCS:$(SRC_DIR)/%.c=$(OBJ_DIR)/%.o)
LIB_DEPS := $(LIB_OBJS:.o=.d)

STATIC_LIB := $(LIB_DIR)/libretrigger_hash.a
SHARED_LIB := $(LIB_DIR)/libretrigger_hash.$(LIB_EXT)

TEST_SRCS := $(wildcard $(TEST_DIR)/test_*.c)
TEST_BINS := $(TEST_SRCS:$(TEST_DIR)/%.c=$(BIN_DIR)/%)
BENCH_BIN := $(BIN_DIR)/bench_hash

PREFIX ?= /usr/local

.PHONY: all static shared test test-shared asan tsan bench fuzz fuzz-build \
        clean-asan clean install uninstall info help

# dlopen lives in libdl on Linux and in libc everywhere else this builds.
DL_LIBS :=
ifeq ($(OS),linux)
  DL_LIBS := -ldl
endif

all: static shared ## Build the static and shared libraries

static: $(STATIC_LIB)  ## Build the static library
shared: $(SHARED_LIB)  ## Build the shared library

$(OBJ_DIR) $(LIB_DIR) $(BIN_DIR):
	@mkdir -p $@

# --------------------------------------------------------- per-TU flags
#
# Everything defaults to the baseline; the three lines below are the entire
# set of ISA-specific compilation in this project.
$(OBJ_DIR)/xxh3_avx2.o:   TU_FLAGS := -mavx2
$(OBJ_DIR)/xxh3_avx512.o: TU_FLAGS := -mavx512f -mavx512bw
$(OBJ_DIR)/xxh3_sse2.o:   TU_FLAGS := -msse2

$(OBJ_DIR)/%.o: $(SRC_DIR)/%.c | $(OBJ_DIR)
	@echo "CC $<"
	@$(CC) $(ALL_CFLAGS) $(TU_FLAGS) -MMD -MP -c $< -o $@

$(STATIC_LIB): $(LIB_OBJS) | $(LIB_DIR)
	@echo "AR $@"
	@$(AR) rcs $@ $^

$(SHARED_LIB): $(LIB_OBJS) | $(LIB_DIR)
	@echo "LD $@"
	@$(CC) $(SO_LDFLAGS) -o $@ $^ $(LDFLAGS)

# ------------------------------------------------------------- programs

$(BIN_DIR)/%: $(TEST_DIR)/%.c $(TEST_DIR)/rtr_test.h $(STATIC_LIB) | $(BIN_DIR)
	@echo "CC $@"
	@$(CC) $(ALL_CFLAGS) -I$(TEST_DIR) $< $(STATIC_LIB) -o $@

# test_oom substitutes its own allocator for the library's, so it cannot link the
# shipped archive -- that one was compiled to call malloc directly. It gets its
# own copy of the library built with the seam redirected. This explicit rule
# takes precedence over the pattern rule above.
$(BIN_DIR)/test_oom: $(TEST_DIR)/test_oom.c $(TEST_DIR)/rtr_test.h $(LIB_SRCS) $(SRC_DIR)/rtr_alloc.h | $(BIN_DIR)
	@echo "CC $@"
	$(call build_lib_variant,-DRTR_ALLOC_HOOKS,$(OBJ_DIR)/hooked)
	@$(CC) $(ALL_CFLAGS) -DRTR_ALLOC_HOOKS -I$(TEST_DIR) $< $(OBJ_DIR)/hooked/*.o -o $@

$(BENCH_BIN): $(SRC_DIR)/bench_hash.c $(STATIC_LIB) | $(BIN_DIR)
	@echo "CC $@"
	@$(CC) $(ALL_CFLAGS) $< $(STATIC_LIB) -o $@

test: $(TEST_BINS) ## Build and run the test suite (non-zero exit on failure)
	@fail=0; \
	for t in $(TEST_BINS); do \
	  echo "=== $$t"; \
	  $$t || fail=1; \
	done; \
	if [ $$fail -ne 0 ]; then echo "TEST SUITE FAILED"; exit 1; fi; \
	echo "ALL TEST BINARIES PASSED"

# Load the shipped shared library and resolve its public symbols. Separate from
# the archive-linked suite because it needs -ldl and the library's path; it
# proves the .so/.dylib a consumer actually links is complete and correct.
test-shared: $(SHARED_LIB) | $(BIN_DIR) ## Load the shared library and check its exported symbols
	@echo "CC $(BIN_DIR)/shlib_check"
	@$(CC) $(ALL_CFLAGS) -I$(TEST_DIR) -DRTR_SHARED_LIB='"$(abspath $(SHARED_LIB))"' \
	    $(TEST_DIR)/shlib_check.c -o $(BIN_DIR)/shlib_check $(DL_LIBS)
	@$(BIN_DIR)/shlib_check

# Instrumentation shared by the sanitizer and fuzzer builds.
#
# _FORTIFY_SOURCE is switched back off here: it and the sanitizers instrument the
# same libc calls, and running both is a documented source of false reports. The
# sanitizer is the stronger check, so it wins for these builds.
SAN_FLAGS := -O1 -g -fno-omit-frame-pointer -U_FORTIFY_SOURCE \
             -fsanitize=address,undefined -fno-sanitize-recover=all

# Tests that replace the library's allocator and therefore need their own build
# of it. Kept as a list so adding another is one word, not another rule.
HOOKED_TESTS := test_oom

# Same suite, rebuilt with the sanitizers. Separate object directories so the
# instrumented build never contaminates the shipped one.
asan: ## Build and run the tests under AddressSanitizer + UBSan
	@echo "--- rebuilding under -fsanitize=address,undefined"
	@$(MAKE) --no-print-directory clean-asan
	$(call build_lib_variant,$(SAN_FLAGS),$(OBJ_DIR)/asan)
	$(call build_lib_variant,$(SAN_FLAGS) -DRTR_ALLOC_HOOKS,$(OBJ_DIR)/asan-hooked)
	@mkdir -p $(BIN_DIR)/asan
	@for t in $(TEST_SRCS); do \
	  name=$$(basename $$t .c); objs=$(OBJ_DIR)/asan; hooks=""; \
	  case " $(HOOKED_TESTS) " in \
	    *" $$name "*) objs=$(OBJ_DIR)/asan-hooked; hooks="-DRTR_ALLOC_HOOKS";; \
	  esac; \
	  echo "CC $(BIN_DIR)/asan/$$name"; \
	  $(CC) $(BASE) $(SAN_FLAGS) $$hooks -I$(TEST_DIR) $$t $$objs/*.o \
	    -o $(BIN_DIR)/asan/$$name || exit 1; \
	done
	@fail=0; \
	for t in $(TEST_SRCS); do \
	  bin=$(BIN_DIR)/asan/$$(basename $$t .c); \
	  echo "=== $$bin"; \
	  $$bin || fail=1; \
	done; \
	if [ $$fail -ne 0 ]; then echo "ASAN SUITE FAILED"; exit 1; fi; \
	echo "ALL ASAN TESTS PASSED"

clean-asan:
	@rm -rf $(BIN_DIR)/asan $(OBJ_DIR)/asan $(OBJ_DIR)/asan-hooked $(BIN_DIR)/tsan $(OBJ_DIR)/tsan

# ThreadSanitizer over the multithreaded suite.
#
# Only the concurrency test spawns threads, so only it is worth instrumenting:
# TSAN over single-threaded tests finds nothing and roughly doubles their cost.
# The point is to prove the lock-free dispatch initialisation race (g_levels /
# g_cpu_level) is genuinely benign, not merely benign on the runs we happened to
# take. Probed by linking, like the fuzzer, since not every toolchain ships the
# TSan runtime.
TSAN_FLAGS := -O1 -g -fno-omit-frame-pointer -fsanitize=thread -fno-sanitize-recover=all
HAVE_TSAN := $(shell printf 'int main(void){return 0;}\n' \
  | $(CC) -fsanitize=thread -x c - -o /dev/null 2>/dev/null && echo yes)

tsan: ## Build and run the concurrency test under ThreadSanitizer
ifneq ($(HAVE_TSAN),yes)
	@echo "tsan: $(CC) cannot link a -fsanitize=thread binary; skipping."
	@echo "      The concurrency invariants are also checked without TSan by 'make test'."
else
	@$(MAKE) --no-print-directory clean-asan
	$(call build_lib_variant,$(TSAN_FLAGS),$(OBJ_DIR)/tsan)
	@mkdir -p $(BIN_DIR)/tsan
	@echo "CC $(BIN_DIR)/tsan/test_concurrency"
	@$(CC) $(BASE) $(TSAN_FLAGS) -I$(TEST_DIR) $(TEST_DIR)/test_concurrency.c \
	    $(OBJ_DIR)/tsan/*.o -o $(BIN_DIR)/tsan/test_concurrency
	@$(BIN_DIR)/tsan/test_concurrency
	@echo "TSAN CONCURRENCY CLEAN"
endif

bench: $(BENCH_BIN) ## Build and run the benchmark
	@$(BENCH_BIN)

# Every fuzz target in tests/, discovered rather than listed, so adding one is a
# new file and nothing else.
FUZZ_SRCS    := $(wildcard $(TEST_DIR)/fuzz_*.c)
FUZZ_SECONDS ?= 30
# Findings are kept between runs: a corpus that is thrown away each time makes
# every run start from nothing, which is the difference between fuzzing and
# generating random input.
FUZZ_CORPUS  ?= $(BUILD_DIR)/corpus

# Whether this toolchain can actually produce a fuzzer binary.
#
# Probed by linking, not compiling: Apple's clang accepts -fsanitize=fuzzer and
# then fails at link time because Xcode ships no fuzzer runtime, so a
# compile-only probe reports a capability that is not there. Resolved at parse
# time so the recipe below can be skipped as a whole rather than each line having
# to re-check.
HAVE_FUZZER := $(shell printf \
  'int LLVMFuzzerTestOneInput(const unsigned char*x,unsigned long n){(void)x;return (int)n*0;}\n' \
  | $(CC) -fsanitize=fuzzer -x c - -o /dev/null 2>/dev/null && echo yes)

fuzz: ## Build and run every libFuzzer target (requires clang with the fuzzer runtime)
ifneq ($(HAVE_FUZZER),yes)
	@echo "fuzz: $(CC) cannot link a libFuzzer target (-fsanitize=fuzzer); skipping."
	@echo "      Xcode's clang ships no fuzzer runtime; try a Homebrew or LLVM clang:"
	@echo "      make fuzz CC=\$$(brew --prefix llvm)/bin/clang"
	@echo "      The fuzz targets' invariants are also covered deterministically by"
	@echo "      'make test' (test_streaming, test_dispatch_equivalence, test_file)."
else
	$(call build_lib_variant,$(SAN_FLAGS) -fsanitize=fuzzer-no-link,$(OBJ_DIR)/fuzz)
	@mkdir -p $(BIN_DIR)
	@for f in $(FUZZ_SRCS); do \
	  name=$$(basename $$f .c); \
	  echo "CC $(BIN_DIR)/$$name"; \
	  $(CC) $(BASE) $(SAN_FLAGS) -fsanitize=fuzzer -I$(TEST_DIR) $$f \
	    $(OBJ_DIR)/fuzz/*.o -o $(BIN_DIR)/$$name || exit 1; \
	done
	@for f in $(FUZZ_SRCS); do \
	  name=$$(basename $$f .c); \
	  mkdir -p $(FUZZ_CORPUS)/$$name; \
	  echo "=== $$name ($(FUZZ_SECONDS)s)"; \
	  $(BIN_DIR)/$$name $(FUZZ_CORPUS)/$$name \
	    -max_total_time=$(FUZZ_SECONDS) -max_len=8192 || exit 1; \
	done
	@echo "ALL FUZZ TARGETS CLEAN"
endif

# Compile every fuzz target without the fuzzer runtime, purely to prove they
# still build. Cheap, has no toolchain requirement, and stops a fuzz target from
# rotting unnoticed on a machine that cannot run one -- which, given Xcode, is
# most of the machines this is developed on.
fuzz-build: ## Type-check the fuzz targets without needing libFuzzer
	$(call build_lib_variant,,$(OBJ_DIR)/fuzzcheck)
	@for f in $(FUZZ_SRCS); do \
	  echo "CC $$(basename $$f)"; \
	  $(CC) $(ALL_CFLAGS) -I$(TEST_DIR) -c $$f -o $(OBJ_DIR)/fuzzcheck/$$(basename $$f .c).o \
	    || exit 1; \
	done
	@echo "FUZZ TARGETS BUILD CLEAN"

install: $(STATIC_LIB) $(SHARED_LIB) ## Install libraries and public headers
	@install -d $(DESTDIR)$(PREFIX)/lib $(DESTDIR)$(PREFIX)/include/retrigger
	@install -m 644 $(STATIC_LIB) $(SHARED_LIB) $(DESTDIR)$(PREFIX)/lib/
	@install -m 644 $(INC_DIR)/retrigger_hash.h $(DESTDIR)$(PREFIX)/include/retrigger/
	@echo "installed to $(DESTDIR)$(PREFIX)"

uninstall: ## Remove installed artifacts
	@rm -f $(DESTDIR)$(PREFIX)/lib/libretrigger_hash.*
	@rm -f $(DESTDIR)$(PREFIX)/include/retrigger/retrigger_hash.h

clean: ## Remove build artifacts
	@rm -rf $(BUILD_DIR)

info: ## Print the resolved build configuration
	@echo "CC         : $(CC)"
	@echo "platform   : $(OS)-$(ARCH)"
	@echo "build      : $(BUILD)"
	@echo "baseline   : $(ALL_CFLAGS)"
	@echo "simd TUs   : $(notdir $(SIMD_SRCS))"
	@echo "tests      : $(notdir $(TEST_BINS))"

help: ## Show this help
	@awk 'BEGIN{FS=":.*## "} /^[a-zA-Z_-]+:.*## /{printf "  %-10s %s\n",$$1,$$2}' $(MAKEFILE_LIST)

-include $(LIB_DEPS)
