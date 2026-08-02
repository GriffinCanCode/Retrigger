/*
 * Streaming must be indistinguishable from one-shot.
 *
 * The old engine XORed independent block hashes together, which is a different
 * function from hashing the concatenation, and its test only compared the byte
 * count -- so the divergence survived. Here the digest itself is the assertion,
 * under randomized chunk splits that deliberately land on the awkward places:
 * zero-length updates, single bytes, and chunks straddling the 256-byte staging
 * buffer and the 1024-byte secret block where the accumulator gets scrambled.
 */

#include "rtr_test.h"

#define RTR_MAXLEN (600u * 1024u)

static uint8_t *g_buf;

static uint64_t stream_in_chunks(const uint8_t *data, size_t len, uint64_t seed,
                                 rtr_rng *rng, int allow_empty) {
    rtr_hash_state_t *st = rtr_hash_create();
    uint64_t digest;
    size_t off = 0;

    if (st == NULL) return 0;
    rtr_hash_reset(st, seed);
    while (off < len) {
        size_t n = rtr_rng_below(rng, 512);

        if (allow_empty && (rtr_rng_next(rng) & 7u) == 0) n = 0;
        if (n > len - off) n = len - off;
        if (n == 0 && !allow_empty) n = 1;
        rtr_hash_update(st, data + off, n);
        off += n;
    }
    digest = rtr_hash_digest(st);
    rtr_hash_destroy(st);
    return digest;
}

static void random_splits_match_oneshot(void) {
    static const size_t lens[] = {0,   1,    2,    63,   64,    65,   127,
                                  128, 129,  239,  240,  241,   255,  256,
                                  257, 511,  512,  513,  1023,  1024, 1025,
                                  2047, 2048, 4096, 65536, 300000, 600000};
    static const uint64_t seeds[] = {0, 1, UINT64_MAX};
    rtr_rng rng = {0x0123456789ABCDEFULL};

    for (size_t i = 0; i < sizeof lens / sizeof lens[0]; i++) {
        for (size_t s = 0; s < sizeof seeds / sizeof seeds[0]; s++) {
            uint64_t const want = rtr_hash64_seed(g_buf, lens[i], seeds[s]);

            for (int trial = 0; trial < 4; trial++) {
                uint64_t const got =
                    stream_in_chunks(g_buf, lens[i], seeds[s], &rng, 1);
                if (!RTR_CHECK_EQ_MSG(got, want, "random chunk split")) {
                    fprintf(stderr, "      len=%zu seed=0x%016llX trial=%d\n",
                            lens[i], (unsigned long long)seeds[s], trial);
                }
            }
        }
    }
}

/* One byte at a time is the worst case for the staging buffer's bookkeeping. */
static void single_byte_chunks(void) {
    static const size_t lens[] = {1, 63, 64, 255, 256, 257, 1024, 1025, 4096};
    rtr_hash_state_t *st = rtr_hash_create();

    if (!RTR_CHECK(st != NULL)) return;
    for (size_t i = 0; i < sizeof lens / sizeof lens[0]; i++) {
        RTR_CHECK(rtr_hash_reset(st, 0) == 0);
        for (size_t b = 0; b < lens[i]; b++)
            RTR_CHECK(rtr_hash_update(st, g_buf + b, 1) == 0);
        RTR_CHECK_EQ_MSG(rtr_hash_digest(st), rtr_hash64(g_buf, lens[i]),
                         "byte-at-a-time");
    }
    rtr_hash_destroy(st);
}

/* Every possible split point around each internal boundary. */
static void every_split_point_near_boundaries(void) {
    static const size_t boundaries[] = {64, 256, 1024, 1088, 2048};
    rtr_hash_state_t *st = rtr_hash_create();

    if (!RTR_CHECK(st != NULL)) return;
    for (size_t b = 0; b < sizeof boundaries / sizeof boundaries[0]; b++) {
        size_t const len = boundaries[b] + 16;

        for (size_t cut = 0; cut <= len; cut++) {
            RTR_CHECK(rtr_hash_reset(st, 0) == 0);
            RTR_CHECK(rtr_hash_update(st, g_buf, cut) == 0);
            RTR_CHECK(rtr_hash_update(st, g_buf + cut, len - cut) == 0);
            if (!RTR_CHECK_EQ_MSG(rtr_hash_digest(st), rtr_hash64(g_buf, len),
                                  "two-way split"))
                fprintf(stderr, "      len=%zu cut=%zu\n", len, cut);
        }
    }
    rtr_hash_destroy(st);
}

/* Zero-length updates must be inert, whatever pointer they carry. */
static void empty_updates_are_inert(void) {
    rtr_hash_state_t *st = rtr_hash_create();

    if (!RTR_CHECK(st != NULL)) return;
    RTR_CHECK(rtr_hash_reset(st, 0) == 0);
    RTR_CHECK(rtr_hash_update(st, NULL, 0) == 0);
    RTR_CHECK(rtr_hash_update(st, g_buf, 0) == 0);
    RTR_CHECK(rtr_hash_update(st, g_buf, 100) == 0);
    RTR_CHECK(rtr_hash_update(st, NULL, 0) == 0);
    RTR_CHECK(rtr_hash_update(st, g_buf + 100, 0) == 0);
    RTR_CHECK(rtr_hash_update(st, g_buf + 100, 900) == 0);
    RTR_CHECK(rtr_hash_update(st, g_buf + 1000, 0) == 0);
    RTR_CHECK_EQ_MSG(rtr_hash_digest(st), rtr_hash64(g_buf, 1000),
                     "digest with interleaved empty updates");
    rtr_hash_destroy(st);
}

/* digest() is a query, not a finalizer: it must not consume the state. */
static void digest_is_non_destructive(void) {
    rtr_hash_state_t *st = rtr_hash_create();

    if (!RTR_CHECK(st != NULL)) return;
    RTR_CHECK(rtr_hash_reset(st, 0) == 0);
    RTR_CHECK(rtr_hash_update(st, g_buf, 5000) == 0);
    {
        uint64_t const first = rtr_hash_digest(st);
        uint64_t const second = rtr_hash_digest(st);

        RTR_CHECK_EQ_MSG(first, rtr_hash64(g_buf, 5000), "digest at 5000");
        RTR_CHECK_EQ_MSG(second, first, "digest called twice");

        RTR_CHECK(rtr_hash_update(st, g_buf + 5000, 3000) == 0);
        RTR_CHECK_EQ_MSG(rtr_hash_digest(st), rtr_hash64(g_buf, 8000),
                         "digest after continuing");
        RTR_CHECK_EQ_MSG(rtr_hash_digest(st), rtr_hash64(g_buf, 8000),
                         "digest repeated after continuing");
    }
    rtr_hash_destroy(st);
}

/* Interleaving digests mid-stream must not perturb the running accumulator. */
static void digest_between_every_update(void) {
    rtr_hash_state_t *st = rtr_hash_create();
    size_t total = 0;

    if (!RTR_CHECK(st != NULL)) return;
    RTR_CHECK(rtr_hash_reset(st, 12345) == 0);
    for (size_t i = 0; i < 40; i++) {
        size_t const n = 37 + i * 11;

        RTR_CHECK(rtr_hash_update(st, g_buf + total, n) == 0);
        total += n;
        if (!RTR_CHECK_EQ_MSG(rtr_hash_digest(st),
                              rtr_hash64_seed(g_buf, total, 12345),
                              "interleaved digest"))
            fprintf(stderr, "      after %zu bytes\n", total);
    }
    rtr_hash_destroy(st);
}

/* One allocation, many inputs: reset must be a true rewind. */
static void reset_and_reuse(void) {
    static const size_t lens[] = {0, 17, 240, 241, 1024, 5000, 70000};
    rtr_hash_state_t *st = rtr_hash_create();

    if (!RTR_CHECK(st != NULL)) return;
    for (int pass = 0; pass < 3; pass++) {
        for (size_t i = 0; i < sizeof lens / sizeof lens[0]; i++) {
            uint64_t const seed = (uint64_t)pass * 0x9E3779B97F4A7C15ULL;

            RTR_CHECK(rtr_hash_reset(st, seed) == 0);
            RTR_CHECK(rtr_hash_update(st, g_buf, lens[i]) == 0);
            RTR_CHECK_EQ_MSG(rtr_hash_digest(st),
                             rtr_hash64_seed(g_buf, lens[i], seed), "after reset");
        }
    }
    /* A fresh state is seed 0 without an explicit reset. */
    {
        rtr_hash_state_t *fresh = rtr_hash_create();
        if (RTR_CHECK(fresh != NULL)) {
            RTR_CHECK(rtr_hash_update(fresh, g_buf, 300) == 0);
            RTR_CHECK_EQ_MSG(rtr_hash_digest(fresh), rtr_hash64(g_buf, 300),
                             "fresh state defaults to seed 0");
            rtr_hash_destroy(fresh);
        }
    }
    rtr_hash_destroy(st);
}

static void api_rejects_bad_arguments(void) {
    rtr_hash_state_t *st = rtr_hash_create();

    RTR_CHECK_EQ_INT(rtr_hash_reset(NULL, 0), -1);
    RTR_CHECK_EQ_INT(rtr_hash_update(NULL, "x", 1), -1);
    RTR_CHECK_EQ_INT(rtr_hash_update(st, NULL, 4), -1);
    RTR_CHECK_EQ(rtr_hash_digest(NULL), 0u);
    rtr_hash_destroy(NULL); /* must not crash */
    rtr_hash_destroy(st);
}

int main(void) {
    printf("test_streaming\n");
    g_buf = (uint8_t *)malloc(RTR_MAXLEN);
    if (g_buf == NULL) {
        fprintf(stderr, "out of memory\n");
        return 1;
    }
    rtr_fill_test_buffer(g_buf, RTR_MAXLEN);

    RTR_RUN(random_splits_match_oneshot);
    RTR_RUN(single_byte_chunks);
    RTR_RUN(every_split_point_near_boundaries);
    RTR_RUN(empty_updates_are_inert);
    RTR_RUN(digest_is_non_destructive);
    RTR_RUN(digest_between_every_update);
    RTR_RUN(reset_and_reuse);
    RTR_RUN(api_rejects_bad_arguments);

    free(g_buf);
    return RTR_REPORT("test_streaming");
}
