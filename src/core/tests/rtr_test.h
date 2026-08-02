/*
 * A test harness small enough to read in one sitting and with no dependencies
 * beyond libc, so `make test` works on any box that can build the library.
 *
 * Each test file is its own executable with its own main(); a crash therefore
 * takes down one suite instead of hiding the results of the others. Every
 * binary prints a pass/fail count and returns non-zero if anything failed.
 */

#ifndef RTR_TEST_H
#define RTR_TEST_H

#include "retrigger_hash.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int rtr_checks_run;
static int rtr_checks_failed;
static int rtr_cases_run;
static int rtr_cases_failed;
static int rtr_case_bad;

/* Failures are capped so one systematically broken path cannot bury the
 * summary under a hundred thousand identical lines. */
#define RTR_FAIL_BUDGET 20

static inline int rtr_fail_(const char *file, int line) {
    rtr_checks_failed++;
    rtr_case_bad = 1;
    if (rtr_checks_failed > RTR_FAIL_BUDGET) {
        if (rtr_checks_failed == RTR_FAIL_BUDGET + 1)
            fprintf(stderr, "    ... further failures suppressed\n");
        return 0;
    }
    fprintf(stderr, "    FAIL %s:%d: ", file, line);
    return 1;
}

static inline int rtr_check_(int ok, const char *expr, const char *file, int line) {
    rtr_checks_run++;
    if (ok) return 1;
    if (rtr_fail_(file, line)) fprintf(stderr, "%s\n", expr);
    return 0;
}

static inline int rtr_check_eq_u64_(uint64_t got, uint64_t want, const char *what,
                                    const char *file, int line) {
    rtr_checks_run++;
    if (got == want) return 1;
    if (rtr_fail_(file, line))
        fprintf(stderr, "%s: got 0x%016llX want 0x%016llX\n", what,
                (unsigned long long)got, (unsigned long long)want);
    return 0;
}

static inline int rtr_check_eq_int_(long long got, long long want, const char *what,
                                    const char *file, int line) {
    rtr_checks_run++;
    if (got == want) return 1;
    if (rtr_fail_(file, line))
        fprintf(stderr, "%s: got %lld want %lld\n", what, got, want);
    return 0;
}

static inline void rtr_run_(const char *name, void (*fn)(void)) {
    int const before = rtr_checks_failed;
    rtr_cases_run++;
    rtr_case_bad = 0;
    printf("  %-34s ", name);
    fflush(stdout);
    fn();
    if (rtr_case_bad) {
        rtr_cases_failed++;
        printf("FAIL (%d checks failed)\n", rtr_checks_failed - before);
    } else {
        printf("ok\n");
    }
    fflush(stdout);
}

static inline int rtr_report_(const char *suite) {
    printf("%s: %d/%d cases passed, %d/%d checks passed\n", suite,
           rtr_cases_run - rtr_cases_failed, rtr_cases_run,
           rtr_checks_run - rtr_checks_failed, rtr_checks_run);
    return rtr_cases_failed == 0 && rtr_checks_failed == 0 ? 0 : 1;
}

#define RTR_CHECK(cond) rtr_check_((cond) ? 1 : 0, #cond, __FILE__, __LINE__)
#define RTR_CHECK_EQ(got, want) \
    rtr_check_eq_u64_((uint64_t)(got), (uint64_t)(want), #got, __FILE__, __LINE__)
#define RTR_CHECK_EQ_MSG(got, want, msg) \
    rtr_check_eq_u64_((uint64_t)(got), (uint64_t)(want), (msg), __FILE__, __LINE__)
#define RTR_CHECK_EQ_INT(got, want) \
    rtr_check_eq_int_((long long)(got), (long long)(want), #got, __FILE__, __LINE__)
#define RTR_RUN(fn) rtr_run_(#fn, fn)
#define RTR_REPORT(suite) rtr_report_(suite)

/* ------------------------------------------------------------ fixtures */

/*
 * The xxHash sanity-check byte generator: an LCG seeded with PRIME32_1, taking
 * the high byte of each state. Reference vectors in test_vectors.c are tied to
 * this exact sequence, so it must not change.
 */
static inline void rtr_fill_test_buffer(uint8_t *buf, size_t len) {
    uint32_t r = 2654435761U;
    for (size_t i = 0; i < len; i++) {
        r = r * 2654435761U + 2654435769U;
        buf[i] = (uint8_t)(r >> 24);
    }
}

/* xorshift64*, for tests that want arbitrary but reproducible choices. */
typedef struct {
    uint64_t s;
} rtr_rng;

static inline uint64_t rtr_rng_next(rtr_rng *g) {
    uint64_t x = g->s;
    x ^= x >> 12;
    x ^= x << 25;
    x ^= x >> 27;
    g->s = x;
    return x * 0x2545F4914F6CDD1DULL;
}

static inline size_t rtr_rng_below(rtr_rng *g, size_t bound) {
    return bound == 0 ? 0 : (size_t)(rtr_rng_next(g) % bound);
}

/* Every level this CPU can run, most capable first, for differential tests. */
static inline size_t rtr_collect_levels(int *out, size_t cap) {
    uint32_t const mask = rtr_hash_available_levels();
    size_t n = 0;
    for (int lvl = 0; lvl <= (int)RTR_SIMD_AVX512 && n < cap; lvl++)
        if (mask & (1u << (unsigned)lvl)) out[n++] = lvl;
    return n;
}

static inline void rtr_print_levels(void) {
    int levels[8];
    size_t const n = rtr_collect_levels(levels, 8);
    printf("  levels available on this CPU:");
    for (size_t i = 0; i < n; i++)
        printf(" %s", rtr_hash_level_str((rtr_simd_level_t)levels[i]));
    printf("  (cpu picks: %s)\n", rtr_hash_level_str(rtr_hash_cpu_level()));
}

#endif /* RTR_TEST_H */
