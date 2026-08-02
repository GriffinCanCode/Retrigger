/*
 * Runtime CPU dispatch and the public rtr_hash_* API.
 *
 * This translation unit is compiled at the portable architecture baseline and
 * must stay that way: it is the code that decides whether the AVX2 kernel is
 * safe to call, so it cannot itself contain an AVX2 instruction. Selection is
 * a runtime cpuid/xgetbv question, never a compile-time #ifdef, because the
 * machine that builds the binary is not the machine that runs it.
 */

#include "retrigger_hash.h"
#include "rtr_alloc.h"
#include "xxh3_internal.h"

#include <stdio.h>
#include <stdlib.h>

#if defined(__x86_64__) || defined(_M_X64)
#define RTR_X86 1
#if defined(__GNUC__) || defined(__clang__)
#include <cpuid.h>
#endif
#endif

#if defined(__STDC_NO_ATOMICS__) || !defined(__STDC_VERSION__) || \
    __STDC_VERSION__ < 201112L
typedef volatile int rtr_atomic_int;
#define RTR_LOAD(x)     (x)
#define RTR_STORE(x, v) ((x) = (v))
#else
#include <stdatomic.h>
typedef _Atomic int rtr_atomic_int;
#define RTR_LOAD(x)     atomic_load_explicit(&(x), memory_order_acquire)
#define RTR_STORE(x, v) atomic_store_explicit(&(x), (v), memory_order_release)
#endif

/* -------------------------------------------------- feature detection */

#ifdef RTR_X86
/* XCR0 bits: 1 = SSE state, 2 = YMM state, 5..7 = opmask/ZMM_hi256/hi16_ZMM. */
static uint64_t rtr_xgetbv0(void) {
    uint32_t eax, edx;
    /* Encoded by hand so this TU never needs -mxsave. */
    __asm__ __volatile__(".byte 0x0f, 0x01, 0xd0"
                         : "=a"(eax), "=d"(edx)
                         : "c"(0));
    return ((uint64_t)edx << 32) | eax;
}
#endif

static uint32_t rtr_detect_levels(void) {
    uint32_t mask = 1u << RTR_SIMD_SCALAR;

#if RTR_ENABLE_NEON
    /* NEON is architecturally mandatory on AArch64; nothing to probe. */
    mask |= 1u << RTR_SIMD_NEON;
#endif

#ifdef RTR_X86
#if RTR_ENABLE_SSE2
    mask |= 1u << RTR_SIMD_SSE2; /* baseline for the x86-64 ABI */
#endif
#if RTR_ENABLE_AVX2 || RTR_ENABLE_AVX512
    {
        uint32_t eax = 0, ebx = 0, ecx = 0, edx = 0;
        int have_osxsave = 0, have_avx = 0;

        if (__get_cpuid(1, &eax, &ebx, &ecx, &edx)) {
            have_osxsave = (ecx & (1u << 27)) != 0;
            have_avx = (ecx & (1u << 28)) != 0;
        }
        /* OSXSAVE plus the XCR0 bits: the CPU can have AVX while the kernel
         * has not enabled the register state, and using it then is a SIGILL. */
        if (have_osxsave && have_avx) {
            uint64_t const xcr0 = rtr_xgetbv0();
            int const ymm_ok = (xcr0 & 0x6u) == 0x6u;
            int const zmm_ok = (xcr0 & 0xE6u) == 0xE6u;

            eax = ebx = ecx = edx = 0;
            if (ymm_ok && __get_cpuid_count(7, 0, &eax, &ebx, &ecx, &edx)) {
#if RTR_ENABLE_AVX2
                if (ebx & (1u << 5))
                    mask |= 1u << RTR_SIMD_AVX2;
#endif
#if RTR_ENABLE_AVX512
                /* AVX-512F plus BW, matching what the kernel TU is built with.
                 */
                if (zmm_ok && (ebx & (1u << 16)) && (ebx & (1u << 30)))
                    mask |= 1u << RTR_SIMD_AVX512;
#else
                (void)zmm_ok;
#endif
            }
        }
    }
#endif
#endif
    return mask;
}

/* ------------------------------------------------------------ kernels */

static const rtr_xxh3_kernel_t rtr_kernel_scalar = {rtr_xxh3_accumulate_scalar,
                                                    rtr_xxh3_scramble_scalar};
#if RTR_ENABLE_NEON
static const rtr_xxh3_kernel_t rtr_kernel_neon = {rtr_xxh3_accumulate_neon,
                                                  rtr_xxh3_scramble_neon};
#endif
#if RTR_ENABLE_SSE2
static const rtr_xxh3_kernel_t rtr_kernel_sse2 = {rtr_xxh3_accumulate_sse2,
                                                  rtr_xxh3_scramble_sse2};
#endif
#if RTR_ENABLE_AVX2
static const rtr_xxh3_kernel_t rtr_kernel_avx2 = {rtr_xxh3_accumulate_avx2,
                                                  rtr_xxh3_scramble_avx2};
#endif
#if RTR_ENABLE_AVX512
static const rtr_xxh3_kernel_t rtr_kernel_avx512 = {rtr_xxh3_accumulate_avx512,
                                                    rtr_xxh3_scramble_avx512};
#endif

static const rtr_xxh3_kernel_t *rtr_kernel_for(rtr_simd_level_t level) {
    switch (level) {
#if RTR_ENABLE_NEON
    case RTR_SIMD_NEON:
        return &rtr_kernel_neon;
#endif
#if RTR_ENABLE_SSE2
    case RTR_SIMD_SSE2:
        return &rtr_kernel_sse2;
#endif
#if RTR_ENABLE_AVX2
    case RTR_SIMD_AVX2:
        return &rtr_kernel_avx2;
#endif
#if RTR_ENABLE_AVX512
    case RTR_SIMD_AVX512:
        return &rtr_kernel_avx512;
#endif
    default:
        return &rtr_kernel_scalar;
    }
}

/* --------------------------------------------------------------- state */

/*
 * Detection is a pure function of the CPU, so two threads racing to fill these
 * in write the same value; no lock is needed to make init idempotent.
 */
static rtr_atomic_int g_levels = -1;
static rtr_atomic_int g_cpu_level = -1;
static rtr_atomic_int g_forced = -1;

static rtr_simd_level_t rtr_best_of(uint32_t mask) {
    for (int lvl = RTR_SIMD_AVX512; lvl > RTR_SIMD_SCALAR; lvl--)
        if (mask & (1u << lvl))
            return (rtr_simd_level_t)lvl;
    return RTR_SIMD_SCALAR;
}

static uint32_t rtr_levels(void) {
    int cached = RTR_LOAD(g_levels);
    if (cached < 0) {
        uint32_t const mask = rtr_detect_levels();
        RTR_STORE(g_cpu_level, (int)rtr_best_of(mask));
        RTR_STORE(g_levels, (int)mask);
        return mask;
    }
    return (uint32_t)cached;
}

static rtr_simd_level_t rtr_active(void) {
    int const forced = RTR_LOAD(g_forced);
    if (forced >= 0)
        return (rtr_simd_level_t)forced;
    (void)rtr_levels();
    return (rtr_simd_level_t)RTR_LOAD(g_cpu_level);
}

static const rtr_xxh3_kernel_t *rtr_active_kernel(void) {
    return rtr_kernel_for(rtr_active());
}

rtr_simd_level_t rtr_hash_init(void) {
    return rtr_active();
}

rtr_simd_level_t rtr_hash_cpu_level(void) {
    (void)rtr_levels();
    return (rtr_simd_level_t)RTR_LOAD(g_cpu_level);
}

rtr_simd_level_t rtr_hash_active_level(void) {
    return rtr_active();
}

uint32_t rtr_hash_available_levels(void) {
    return rtr_levels();
}

int rtr_hash_force_level(rtr_simd_level_t level) {
    uint32_t const mask = rtr_levels();
    int const lvl = (int)level;

    if (lvl < (int)RTR_SIMD_SCALAR || lvl > (int)RTR_SIMD_AVX512)
        return -1;
    if (!(mask & (1u << (unsigned)lvl)))
        return -1;
    RTR_STORE(g_forced, lvl);
    return 0;
}

void rtr_hash_reset_level(void) {
    RTR_STORE(g_forced, -1);
}

const char *rtr_hash_level_str(rtr_simd_level_t level) {
    switch (level) {
    case RTR_SIMD_SCALAR:
        return "scalar";
    case RTR_SIMD_NEON:
        return "neon";
    case RTR_SIMD_SSE2:
        return "sse2";
    case RTR_SIMD_AVX2:
        return "avx2";
    case RTR_SIMD_AVX512:
        return "avx512";
    default:
        return "unknown";
    }
}

uint32_t rtr_hash_abi_version(void) {
    return RTR_HASH_ABI_VERSION;
}

/* ------------------------------------------------------------ one-shot */

uint64_t rtr_hash64(const void *data, size_t len) {
    return rtr_hash64_seed(data, len, 0);
}

uint64_t rtr_hash64_seed(const void *data, size_t len, uint64_t seed) {
    static const uint8_t empty = 0;
    /* A NULL/0 call is legal and must hash as the empty input, not crash. */
    if (data == NULL) {
        if (len == 0) {
            data = &empty;
        } else {
            /* NULL with a non-zero length is a caller bug: there is no buffer
             * to read, and the streaming API rejects the identical mistake with
             * -1. A uint64_t return has no error channel, so the only honest
             * answers are to read from NULL (undefined) or to fabricate a
             * digest of bytes that were never supplied. This library does
             * neither: it fails loud so the bug is found, rather than returning
             * a plausible value that would read back as a real, and wrong,
             * content fingerprint. Correct callers -- including the Rust FFI,
             * which always passes a valid pointer -- never reach this. */
            fprintf(stderr,
                    "retrigger: rtr_hash64_seed called with NULL data and "
                    "len=%zu; this is a caller bug (no buffer to hash)\n",
                    len);
            abort();
        }
    }
    return rtr_xxh3_64(data, len, seed, rtr_active_kernel());
}

/* ----------------------------------------------------------- streaming */

rtr_hash_state_t *rtr_hash_create(void) {
    struct rtr_hash_state *st = (struct rtr_hash_state *)RTR_MALLOC(sizeof *st);
    if (st != NULL)
        rtr_xxh3_state_reset(st, 0);
    return st;
}

void rtr_hash_destroy(rtr_hash_state_t *state) {
    RTR_FREE(state);
}

int rtr_hash_reset(rtr_hash_state_t *state, uint64_t seed) {
    if (state == NULL)
        return -1;
    rtr_xxh3_state_reset(state, seed);
    return 0;
}

int rtr_hash_update(rtr_hash_state_t *state, const void *data, size_t len) {
    if (state == NULL)
        return -1;
    if (len == 0)
        return 0; /* including data == NULL */
    if (data == NULL)
        return -1;
    rtr_xxh3_state_update(state, (const uint8_t *)data, len,
                          rtr_active_kernel());
    return 0;
}

uint64_t rtr_hash_digest(const rtr_hash_state_t *state) {
    if (state == NULL)
        return 0;
    return rtr_xxh3_state_digest(state, rtr_active_kernel());
}
