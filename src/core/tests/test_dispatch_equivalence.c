/*
 * Cross-path differential.
 *
 * XXH3's whole design premise is that a wider vector unit computes the same
 * number, so a SIMD kernel that "optimizes" the multiply away is not faster,
 * it is broken. This suite pins each level in turn with rtr_hash_force_level
 * and demands a bit-identical result against the scalar reference for every
 * length that can reach a different branch: 0..2048 exhaustively, plus sizes
 * that cross the 1024-byte secret-block scramble several times over.
 *
 * The levels actually exercised are printed, so a passing run on a machine
 * that only has one path cannot be mistaken for proof that the others agree.
 */

#include "rtr_test.h"

#define RTR_SWEEP_MAX 2048u

static uint8_t *g_buf;
static size_t g_buf_len;
static int g_levels[8];
static size_t g_nlevels;

static const size_t g_large[] = {
    2049, 4096, 65536, 65537, 1024u * 1024u, 1024u * 1024u + 1,
    3u * 1024u * 1024u + 123u,
};

static void sweep_small_lengths(void) {
    static uint64_t reference[RTR_SWEEP_MAX + 1];

    RTR_CHECK(rtr_hash_force_level(RTR_SIMD_SCALAR) == 0);
    for (size_t len = 0; len <= RTR_SWEEP_MAX; len++)
        reference[len] = rtr_hash64(g_buf, len);

    for (size_t l = 0; l < g_nlevels; l++) {
        int const level = g_levels[l];
        const char *const name = rtr_hash_level_str((rtr_simd_level_t)level);

        if (level == (int)RTR_SIMD_SCALAR) continue;
        RTR_CHECK(rtr_hash_force_level((rtr_simd_level_t)level) == 0);
        for (size_t len = 0; len <= RTR_SWEEP_MAX; len++)
            if (!RTR_CHECK_EQ_MSG(rtr_hash64(g_buf, len), reference[len], name))
                break; /* one report per level is enough to localize it */
    }
    rtr_hash_reset_level();
}

static void sweep_large_lengths(void) {
    for (size_t i = 0; i < sizeof g_large / sizeof g_large[0]; i++) {
        size_t const len = g_large[i];
        uint64_t reference;

        if (len > g_buf_len) continue;
        RTR_CHECK(rtr_hash_force_level(RTR_SIMD_SCALAR) == 0);
        reference = rtr_hash64(g_buf, len);
        for (size_t l = 0; l < g_nlevels; l++) {
            RTR_CHECK(rtr_hash_force_level((rtr_simd_level_t)g_levels[l]) == 0);
            RTR_CHECK_EQ_MSG(rtr_hash64(g_buf, len), reference,
                             rtr_hash_level_str((rtr_simd_level_t)g_levels[l]));
        }
    }
    rtr_hash_reset_level();
}

/* The seeded long path derives a custom secret; it must agree per level too. */
static void sweep_seeded(void) {
    static const uint64_t seeds[] = {1, 0x9E3779B185EBCA87ULL, UINT64_MAX};

    for (size_t s = 0; s < sizeof seeds / sizeof seeds[0]; s++) {
        for (size_t len = 240; len <= 1200; len += 37) {
            uint64_t reference;

            RTR_CHECK(rtr_hash_force_level(RTR_SIMD_SCALAR) == 0);
            reference = rtr_hash64_seed(g_buf, len, seeds[s]);
            for (size_t l = 0; l < g_nlevels; l++) {
                RTR_CHECK(rtr_hash_force_level((rtr_simd_level_t)g_levels[l]) == 0);
                RTR_CHECK_EQ_MSG(rtr_hash64_seed(g_buf, len, seeds[s]), reference,
                                 rtr_hash_level_str((rtr_simd_level_t)g_levels[l]));
            }
        }
    }
    rtr_hash_reset_level();
}

/* Streaming uses the same kernels through a different call path. */
static void streaming_agrees_per_level(void) {
    static const size_t lens[] = {0, 1, 255, 256, 257, 1024, 1025, 100000};
    rtr_hash_state_t *st = rtr_hash_create();

    if (!RTR_CHECK(st != NULL)) return;
    for (size_t i = 0; i < sizeof lens / sizeof lens[0]; i++) {
        uint64_t const reference = rtr_hash64(g_buf, lens[i]);

        for (size_t l = 0; l < g_nlevels; l++) {
            RTR_CHECK(rtr_hash_force_level((rtr_simd_level_t)g_levels[l]) == 0);
            RTR_CHECK(rtr_hash_reset(st, 0) == 0);
            RTR_CHECK(rtr_hash_update(st, g_buf, lens[i]) == 0);
            RTR_CHECK_EQ_MSG(rtr_hash_digest(st), reference,
                             rtr_hash_level_str((rtr_simd_level_t)g_levels[l]));
        }
    }
    rtr_hash_reset_level();
    rtr_hash_destroy(st);
}

/* Forcing something this CPU cannot run must be refused, not attempted. */
static void unsupported_level_is_refused(void) {
    uint32_t const mask = rtr_hash_available_levels();
    uint64_t const before = rtr_hash64(g_buf, 4096);

    for (int lvl = 0; lvl <= (int)RTR_SIMD_AVX512; lvl++) {
        int const rc = rtr_hash_force_level((rtr_simd_level_t)lvl);
        int const supported = (mask & (1u << (unsigned)lvl)) != 0;
        RTR_CHECK_EQ_INT(rc, supported ? 0 : -1);
    }
    rtr_hash_reset_level();

    /* Out-of-range values must be rejected without disturbing dispatch. */
    RTR_CHECK_EQ_INT(rtr_hash_force_level((rtr_simd_level_t)99), -1);
    RTR_CHECK_EQ_INT(rtr_hash_force_level((rtr_simd_level_t)-1), -1);
    RTR_CHECK_EQ(rtr_hash64(g_buf, 4096), before);

    /* Scalar is the one level that must exist everywhere. */
    RTR_CHECK((mask & (1u << RTR_SIMD_SCALAR)) != 0);
    RTR_CHECK_EQ_INT(rtr_hash_force_level(RTR_SIMD_SCALAR), 0);
    RTR_CHECK_EQ_INT(rtr_hash_active_level(), RTR_SIMD_SCALAR);
    rtr_hash_reset_level();
    RTR_CHECK_EQ_INT(rtr_hash_active_level(), rtr_hash_cpu_level());
}

static void level_names_are_sane(void) {
    for (int lvl = 0; lvl <= (int)RTR_SIMD_AVX512; lvl++) {
        const char *s = rtr_hash_level_str((rtr_simd_level_t)lvl);
        RTR_CHECK(s != NULL && s[0] != '\0');
        RTR_CHECK(strcmp(s, "unknown") != 0);
    }
    RTR_CHECK(strcmp(rtr_hash_level_str((rtr_simd_level_t)77), "unknown") == 0);
}

int main(void) {
    printf("test_dispatch_equivalence\n");
    rtr_print_levels();

    g_nlevels = rtr_collect_levels(g_levels, 8);
    printf("  differential will compare %zu level(s) against scalar:", g_nlevels);
    for (size_t i = 0; i < g_nlevels; i++)
        printf(" %s", rtr_hash_level_str((rtr_simd_level_t)g_levels[i]));
    printf("\n");
    if (g_nlevels < 2)
        printf("  NOTE: only one level exists here; cross-path claims are untested.\n");

    g_buf_len = 3u * 1024u * 1024u + 1024u;
    g_buf = (uint8_t *)malloc(g_buf_len);
    if (g_buf == NULL) {
        fprintf(stderr, "out of memory\n");
        return 1;
    }
    rtr_fill_test_buffer(g_buf, g_buf_len);

    RTR_RUN(sweep_small_lengths);
    RTR_RUN(sweep_large_lengths);
    RTR_RUN(sweep_seeded);
    RTR_RUN(streaming_agrees_per_level);
    RTR_RUN(unsupported_level_is_refused);
    RTR_RUN(level_names_are_sane);

    free(g_buf);
    return RTR_REPORT("test_dispatch_equivalence");
}
