/*
 * Deterministic metamorphic properties.
 *
 * The libFuzzer targets (fuzz_hash.c) explore the same invariants, but they run
 * only where clang ships a fuzzer runtime -- not Apple's clang, and not the CI
 * gate. This file runs the identical properties as an ordinary test: a fixed
 * xorshift stream drives thousands of (length, seed, chunking) triples, so it
 * is reproducible, needs no special toolchain, and fails the gate the moment a
 * kernel or the streaming state machine diverges.
 *
 * The seed is fixed on purpose. A test that picks a fresh random seed each run
 * is a test whose failures cannot be reproduced from the log; RTR_PROP_SEED can
 * be overridden to widen the search in a campaign without making the default
 * non-deterministic.
 */

#include "rtr_test.h"

#ifndef RTR_PROP_SEED
#define RTR_PROP_SEED 0x9E3779B97F4A7C15ULL
#endif

/* Kept modest so the case runs in well under a second on the gate; the chaos
 * tier re-runs this file many times, which is where breadth comes from. */
#define RTR_PROP_ITERS  4000u
#define RTR_PROP_MAXLEN 9000u

static uint8_t *g_pool; /* RTR_PROP_MAXLEN bytes of rng-filled input */
static int g_levels[8];
static size_t g_nlevels;

/* One-shot digest at a specific level, restoring the previous forcing after. */
static uint64_t at_level(int level, const uint8_t *data, size_t len,
                         uint64_t seed) {
    uint64_t d;
    RTR_CHECK(rtr_hash_force_level((rtr_simd_level_t)level) == 0);
    d = rtr_hash64_seed(data, len, seed);
    rtr_hash_reset_level();
    return d;
}

/* Stream `data` in chunks drawn from `rng`, at whatever level is in effect. */
static uint64_t stream_chunked(rtr_rng *rng, const uint8_t *data, size_t len,
                               uint64_t seed) {
    rtr_hash_state_t *st = rtr_hash_create();
    uint64_t digest;
    size_t off = 0;
    int idle = 0;

    if (st == NULL)
        return 0;
    rtr_hash_reset(st, seed);
    while (off < len) {
        size_t n = rtr_rng_below(rng, 1024);
        if (n > len - off)
            n = len - off;
        /* A zero-length update must be inert; force progress so a run of them
         * cannot stall the loop. */
        if (n == 0 && ++idle > 2)
            n = 1;
        if (n != 0)
            idle = 0;
        rtr_hash_update(st, data + off, n);
        off += n;
    }
    digest = rtr_hash_digest(st);
    rtr_hash_destroy(st);
    return digest;
}

/* Every compiled-in kernel must agree with the scalar reference, bit for bit,
 * at every length the stream produces. This is the property the whole SIMD
 * design rests on. */
static void every_level_agrees_with_scalar(void) {
    rtr_rng rng = {RTR_PROP_SEED};

    for (unsigned i = 0; i < RTR_PROP_ITERS; i++) {
        size_t const len = rtr_rng_below(&rng, RTR_PROP_MAXLEN + 1);
        uint64_t const seed = rtr_rng_next(&rng);
        uint64_t const reference = at_level(RTR_SIMD_SCALAR, g_pool, len, seed);

        for (size_t l = 0; l < g_nlevels; l++) {
            if (!RTR_CHECK_EQ_MSG(
                    at_level(g_levels[l], g_pool, len, seed), reference,
                    rtr_hash_level_str((rtr_simd_level_t)g_levels[l]))) {
                fprintf(stderr, "      iter=%u len=%zu seed=0x%016llX\n", i,
                        len, (unsigned long long)seed);
                return;
            }
        }
    }
}

/* Any chunking of the input must stream to exactly the one-shot digest, at
 * every level. This is the streaming state machine's core contract. */
static void streaming_matches_oneshot(void) {
    rtr_rng rng = {RTR_PROP_SEED ^ 0xD1B54A32D192ED03ULL};

    for (unsigned i = 0; i < RTR_PROP_ITERS; i++) {
        size_t const len = rtr_rng_below(&rng, RTR_PROP_MAXLEN + 1);
        uint64_t const seed = rtr_rng_next(&rng);

        for (size_t l = 0; l < g_nlevels; l++) {
            uint64_t oneshot, streamed;
            RTR_CHECK(rtr_hash_force_level((rtr_simd_level_t)g_levels[l]) == 0);
            oneshot = rtr_hash64_seed(g_pool, len, seed);
            streamed = stream_chunked(&rng, g_pool, len, seed);
            rtr_hash_reset_level();
            if (!RTR_CHECK_EQ_MSG(
                    streamed, oneshot,
                    rtr_hash_level_str((rtr_simd_level_t)g_levels[l]))) {
                fprintf(stderr, "      iter=%u len=%zu seed=0x%016llX\n", i,
                        len, (unsigned long long)seed);
                return;
            }
        }
    }
}

/* Splitting the input at an arbitrary point and streaming the two halves must
 * equal hashing the whole: hash(a || b) == stream(a); stream(b). A boundary bug
 * in the accumulator's carry between updates shows up here and nowhere in the
 * one-shot path. */
static void concatenation_is_associative(void) {
    rtr_rng rng = {RTR_PROP_SEED ^ 0x2545F4914F6CDD1DULL};

    for (unsigned i = 0; i < RTR_PROP_ITERS; i++) {
        size_t const len = rtr_rng_below(&rng, RTR_PROP_MAXLEN + 1);
        size_t const split = rtr_rng_below(&rng, len + 1);
        uint64_t const seed = rtr_rng_next(&rng);
        uint64_t const whole = rtr_hash64_seed(g_pool, len, seed);
        rtr_hash_state_t *st = rtr_hash_create();
        uint64_t split_digest;

        if (!RTR_CHECK(st != NULL))
            return;
        rtr_hash_reset(st, seed);
        rtr_hash_update(st, g_pool, split);
        rtr_hash_update(st, g_pool + split, len - split);
        split_digest = rtr_hash_digest(st);
        rtr_hash_destroy(st);

        if (!RTR_CHECK_EQ_MSG(split_digest, whole,
                              "split stream equals whole")) {
            fprintf(stderr, "      iter=%u len=%zu split=%zu seed=0x%016llX\n",
                    i, len, split, (unsigned long long)seed);
            return;
        }
    }
}

/* Hashing is a pure function: the same bytes, seed, and level always give the
 * same digest, and the digest is non-destructive of the streaming state. */
static void hashing_is_deterministic(void) {
    rtr_rng rng = {RTR_PROP_SEED ^ 0xA0761D6478BD642FULL};

    for (unsigned i = 0; i < RTR_PROP_ITERS; i++) {
        size_t const len = rtr_rng_below(&rng, RTR_PROP_MAXLEN + 1);
        uint64_t const seed = rtr_rng_next(&rng);
        RTR_CHECK_EQ_MSG(rtr_hash64_seed(g_pool, len, seed),
                         rtr_hash64_seed(g_pool, len, seed),
                         "same input, same digest");
    }
}

int main(void) {
    g_pool = (uint8_t *)malloc(RTR_PROP_MAXLEN);
    if (g_pool == NULL) {
        fprintf(stderr,
                "test_property: out of memory allocating the input pool\n");
        return 1;
    }
    rtr_fill_test_buffer(g_pool, RTR_PROP_MAXLEN);
    g_nlevels = rtr_collect_levels(g_levels, 8);

    printf("test_property (seed=0x%016llX, %u iters)\n",
           (unsigned long long)RTR_PROP_SEED, RTR_PROP_ITERS);
    rtr_print_levels();
    RTR_RUN(every_level_agrees_with_scalar);
    RTR_RUN(streaming_matches_oneshot);
    RTR_RUN(concatenation_is_associative);
    RTR_RUN(hashing_is_deterministic);

    free(g_pool);
    return RTR_REPORT("test_property");
}
