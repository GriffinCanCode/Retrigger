/*
 * Boundary behaviour: null and empty inputs, alignment, and extreme seeds.
 *
 * The alignment sweep is the important one. Vector kernels are the classic
 * place to reach for an aligned load because it is a little faster, and it
 * works right up until a caller hands over a pointer from the middle of a
 * buffer. Here the same bytes are hashed at every offset 0..63 and compared
 * against an aligned copy, on every SIMD level, so an aligned load would fault
 * or diverge instead of lurking.
 */

#include "rtr_test.h"

#define RTR_PAD 64u

static uint8_t *g_buf;

static void null_and_empty(void) {
    uint64_t const empty = rtr_hash64(NULL, 0);

    RTR_CHECK_EQ_MSG(empty, 0x2D06800538D394C2ULL, "XXH3-64 of the empty input");
    RTR_CHECK_EQ_MSG(rtr_hash64(g_buf, 0), empty, "zero length, non-NULL pointer");
    RTR_CHECK_EQ_MSG(rtr_hash64("", 0), empty, "zero length, literal pointer");
    RTR_CHECK_EQ_MSG(rtr_hash64_seed(NULL, 0, 0), empty, "NULL, 0, seed 0");
    RTR_CHECK(rtr_hash64_seed(NULL, 0, 42) != empty);

    /* Empty input is not a degenerate zero, and the seed still matters. */
    RTR_CHECK(empty != 0);
    RTR_CHECK(rtr_hash64_seed(g_buf, 0, 1) != rtr_hash64_seed(g_buf, 0, 2));
}

static void unaligned_matches_aligned(void) {
    static const size_t lens[] = {1,   7,   8,    16,   17,   33,   64,
                                  65,  127, 128,  240,  241,  256,  1024,
                                  1025, 4096, 10000};
    int levels[8];
    size_t const nlevels = rtr_collect_levels(levels, 8);
    /* Over-allocate so every offset still has the full length available. */
    uint8_t *const pool = (uint8_t *)malloc(20000 + RTR_PAD);
    uint8_t *const aligned = (uint8_t *)malloc(20000);

    if (!RTR_CHECK(pool != NULL && aligned != NULL)) {
        free(pool);
        free(aligned);
        return;
    }
    rtr_fill_test_buffer(pool, 20000 + RTR_PAD);

    for (size_t l = 0; l < nlevels; l++) {
        const char *const name = rtr_hash_level_str((rtr_simd_level_t)levels[l]);

        RTR_CHECK(rtr_hash_force_level((rtr_simd_level_t)levels[l]) == 0);
        for (size_t i = 0; i < sizeof lens / sizeof lens[0]; i++) {
            for (size_t off = 0; off < RTR_PAD; off++) {
                uint64_t want, got;

                memcpy(aligned, pool + off, lens[i]);
                want = rtr_hash64(aligned, lens[i]);
                got = rtr_hash64(pool + off, lens[i]);
                if (!RTR_CHECK_EQ_MSG(got, want, name)) {
                    fprintf(stderr, "      len=%zu offset=%zu\n", lens[i], off);
                    break;
                }
            }
        }
    }
    rtr_hash_reset_level();
    free(pool);
    free(aligned);
}

/* Streaming feeds the kernels from its own buffer; check the input side too. */
static void unaligned_streaming(void) {
    uint8_t *const pool = (uint8_t *)malloc(4096 + RTR_PAD);
    rtr_hash_state_t *st = rtr_hash_create();

    if (!RTR_CHECK(pool != NULL && st != NULL)) {
        free(pool);
        rtr_hash_destroy(st);
        return;
    }
    rtr_fill_test_buffer(pool, 4096 + RTR_PAD);
    for (size_t off = 0; off < 16; off++) {
        RTR_CHECK(rtr_hash_reset(st, 0) == 0);
        RTR_CHECK(rtr_hash_update(st, pool + off, 4096) == 0);
        RTR_CHECK_EQ_MSG(rtr_hash_digest(st), rtr_hash64(pool + off, 4096),
                         "unaligned streaming input");
    }
    rtr_hash_destroy(st);
    free(pool);
}

static void seed_extremes(void) {
    static const uint64_t seeds[] = {0,
                                     1,
                                     UINT64_MAX,
                                     UINT64_MAX - 1,
                                     0x8000000000000000ULL,
                                     0x00000000FFFFFFFFULL,
                                     0xFFFFFFFF00000000ULL,
                                     0x9E3779B185EBCA87ULL};
    static const size_t lens[] = {0, 1, 4, 9, 17, 129, 240, 241, 1024, 100000};

    for (size_t i = 0; i < sizeof lens / sizeof lens[0]; i++) {
        uint64_t seen[sizeof seeds / sizeof seeds[0]];
        size_t const nseeds = sizeof seeds / sizeof seeds[0];

        for (size_t s = 0; s < nseeds; s++)
            seen[s] = rtr_hash64_seed(g_buf, lens[i], seeds[s]);
        /* Distinct seeds should give distinct digests; a collision here at
         * this scale would mean the seed is being dropped somewhere. */
        for (size_t a = 0; a < nseeds; a++)
            for (size_t b = a + 1; b < nseeds; b++)
                if (!RTR_CHECK(seen[a] != seen[b]))
                    fprintf(stderr, "      len=%zu seeds 0x%016llX / 0x%016llX\n",
                            lens[i], (unsigned long long)seeds[a],
                            (unsigned long long)seeds[b]);
    }
    RTR_CHECK_EQ_MSG(rtr_hash64_seed(g_buf, 5000, 0), rtr_hash64(g_buf, 5000),
                     "seed 0 is the unseeded hash");
}

/* Content, not just length, must reach the digest at every length class. */
static void single_bit_change_is_visible(void) {
    static const size_t lens[] = {1, 3, 4, 8, 9, 16, 17, 64, 128, 129,
                                  240, 241, 1024, 2048, 70000};
    uint8_t *const scratch = (uint8_t *)malloc(70000);

    if (!RTR_CHECK(scratch != NULL)) return;
    for (size_t i = 0; i < sizeof lens / sizeof lens[0]; i++) {
        size_t const len = lens[i];
        uint64_t const base = rtr_hash64(g_buf, len);
        size_t const probes[] = {0, len / 2, len - 1};

        for (size_t p = 0; p < 3; p++) {
            memcpy(scratch, g_buf, len);
            scratch[probes[p]] ^= 0x01u;
            RTR_CHECK(rtr_hash64(scratch, len) != base);
        }
    }
    free(scratch);
}

/* Truncation must change the digest: length is mixed in, not implied. */
static void length_is_part_of_the_input(void) {
    for (size_t len = 1; len <= 300; len++)
        RTR_CHECK(rtr_hash64(g_buf, len) != rtr_hash64(g_buf, len - 1));
}

int main(void) {
    printf("test_edge_cases\n");
    rtr_print_levels();

    g_buf = (uint8_t *)malloc(200000);
    if (g_buf == NULL) {
        fprintf(stderr, "out of memory\n");
        return 1;
    }
    rtr_fill_test_buffer(g_buf, 200000);

    RTR_RUN(null_and_empty);
    RTR_RUN(unaligned_matches_aligned);
    RTR_RUN(unaligned_streaming);
    RTR_RUN(seed_extremes);
    RTR_RUN(single_bit_change_is_visible);
    RTR_RUN(length_is_part_of_the_input);

    free(g_buf);
    return RTR_REPORT("test_edge_cases");
}
