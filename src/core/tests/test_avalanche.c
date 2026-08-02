/*
 * Statistical quality: does the hash actually mix, and does it collide?
 *
 * These are the properties the rest of Retrigger depends on. A file watcher
 * compares digests of near-identical inputs -- two builds of the same file
 * differing in one byte, or a directory of paths that share a long prefix --
 * so a hash with poor avalanche or clustered output would produce false
 * "unchanged" verdicts, which no correctness test on a single input catches.
 *
 * Thresholds are loose enough that a healthy hash never trips them and tight
 * enough that a broken mix (say, a kernel that drops the multiply) does.
 */

#include "rtr_test.h"

static unsigned popcount64(uint64_t v) {
    unsigned n = 0;
    while (v) {
        v &= v - 1;
        n++;
    }
    return n;
}

/*
 * Flip one input bit, count how many of the 64 output bits move. A good
 * 64-bit hash moves 32 of them on average and never leaves one pinned.
 */
static void single_bit_avalanche(void) {
    static const size_t lens[] = {1, 4, 8, 16, 32, 64, 100, 256, 1024};
    size_t const max_bits_per_len = 4096;
    uint8_t *const buf = (uint8_t *)malloc(1024);
    uint64_t bit_flips[64];
    uint64_t total_flips = 0, samples = 0;

    if (!RTR_CHECK(buf != NULL)) return;
    memset(bit_flips, 0, sizeof bit_flips);

    for (size_t i = 0; i < sizeof lens / sizeof lens[0]; i++) {
        size_t const len = lens[i];
        size_t const nbits = len * 8 < max_bits_per_len ? len * 8 : max_bits_per_len;
        uint64_t base;

        rtr_fill_test_buffer(buf, len);
        base = rtr_hash64(buf, len);
        for (size_t b = 0; b < nbits; b++) {
            uint64_t diff;

            buf[b >> 3] ^= (uint8_t)(1u << (b & 7u));
            diff = rtr_hash64(buf, len) ^ base;
            buf[b >> 3] ^= (uint8_t)(1u << (b & 7u));

            /* Any single input bit must change something. */
            if (!RTR_CHECK(diff != 0))
                fprintf(stderr, "      len=%zu bit=%zu produced no change\n", len, b);
            total_flips += popcount64(diff);
            for (unsigned o = 0; o < 64; o++)
                bit_flips[o] += (diff >> o) & 1u;
            samples++;
        }
    }

    {
        double const mean = (double)total_flips / (double)samples;
        printf("\n    mean output bits flipped: %.3f of 64 over %llu samples\n",
               mean, (unsigned long long)samples);
        if (!RTR_CHECK(mean > 31.0 && mean < 33.0))
            fprintf(stderr, "      mean avalanche %.4f is outside [31, 33]\n", mean);

        for (unsigned o = 0; o < 64; o++) {
            double const p = (double)bit_flips[o] / (double)samples;

            if (!RTR_CHECK(bit_flips[o] != 0))
                fprintf(stderr, "      output bit %u is stuck low\n", o);
            if (!RTR_CHECK(bit_flips[o] != samples))
                fprintf(stderr, "      output bit %u is stuck high\n", o);
            if (!RTR_CHECK(p > 0.45 && p < 0.55))
                fprintf(stderr, "      output bit %u flips %.4f of the time\n", o, p);
        }
    }
    free(buf);
}

/* Distinct seeds on identical input must decorrelate as well. */
static void seed_avalanche(void) {
    uint8_t buf[64];
    uint64_t total = 0;
    size_t samples = 0;

    rtr_fill_test_buffer(buf, sizeof buf);
    for (unsigned b = 0; b < 64; b++) {
        uint64_t const base = rtr_hash64_seed(buf, sizeof buf, 0);
        uint64_t const flipped = rtr_hash64_seed(buf, sizeof buf, 1ULL << b);

        total += popcount64(base ^ flipped);
        samples++;
    }
    {
        double const mean = (double)total / (double)samples;
        if (!RTR_CHECK(mean > 28.0 && mean < 36.0))
            fprintf(stderr, "      seed avalanche mean %.3f\n", mean);
    }
}

/* --------------------------------------------------------- collisions */

typedef struct {
    uint64_t *slot;
    uint8_t *used;
    size_t mask;
} hashset;

static int hashset_insert(hashset *hs, uint64_t v) {
    size_t idx = (size_t)v & hs->mask;

    for (;;) {
        if (!hs->used[idx]) {
            hs->used[idx] = 1;
            hs->slot[idx] = v;
            return 1;
        }
        if (hs->slot[idx] == v) return 0;
        idx = (idx + 1) & hs->mask;
    }
}

typedef size_t (*rtr_keygen)(char *out, size_t cap, size_t i);

static size_t count_collisions(rtr_keygen make, size_t n) {
    size_t const cap = 1u << 20;
    hashset hs;
    char key[128];
    size_t collisions = 0;

    hs.slot = (uint64_t *)malloc(cap * sizeof(uint64_t));
    hs.used = (uint8_t *)calloc(cap, 1);
    hs.mask = cap - 1;
    if (hs.slot == NULL || hs.used == NULL) {
        free(hs.slot);
        free(hs.used);
        return SIZE_MAX;
    }
    for (size_t i = 0; i < n; i++) {
        size_t const len = make(key, sizeof key, i);
        if (!hashset_insert(&hs, rtr_hash64(key, len))) collisions++;
    }
    free(hs.slot);
    free(hs.used);
    return collisions;
}

/* The real workload: long shared prefixes, tiny differences at the end. */
static size_t make_path(char *out, size_t cap, size_t i) {
    return (size_t)snprintf(out, cap,
                            "/Users/dev/projects/retrigger/src/module_%03zu/"
                            "component_%03zu/file_%06zu.ts",
                            i % 97, (i / 97) % 89, i);
}

static size_t make_sequential(char *out, size_t cap, size_t i) {
    return (size_t)snprintf(out, cap, "%zu", i);
}

static size_t make_suffixed(char *out, size_t cap, size_t i) {
    return (size_t)snprintf(out, cap,
                            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa%zu", i);
}

static void no_collisions_in_structured_inputs(void) {
    struct {
        const char *what;
        rtr_keygen make;
        size_t n;
    } const cases[] = {
        {"file-path-like strings", make_path, 200000},
        {"sequential decimal integers", make_sequential, 200000},
        {"shared 44-byte prefix", make_suffixed, 200000},
    };

    for (size_t c = 0; c < sizeof cases / sizeof cases[0]; c++) {
        size_t const collisions = count_collisions(cases[c].make, cases[c].n);

        if (!RTR_CHECK(collisions != SIZE_MAX)) continue;
        printf("\n    %-30s %zu keys, %zu collisions", cases[c].what, cases[c].n,
               collisions);
        /* Expected 64-bit collisions among 200k keys is about 1e-9. */
        RTR_CHECK_EQ_MSG(collisions, 0u, cases[c].what);
    }
    printf("\n    ");
}

/* Digest bytes should be uniform; a byte-level bias would show up here. */
static void output_bytes_are_uniform(void) {
    size_t const n = 200000;
    size_t counts[8][256];
    uint8_t key[32];

    memset(counts, 0, sizeof counts);
    for (size_t i = 0; i < n; i++) {
        uint64_t h;

        memset(key, 0, sizeof key);
        memcpy(key, &i, sizeof i);
        h = rtr_hash64(key, sizeof key);
        for (size_t b = 0; b < 8; b++) counts[b][(h >> (b * 8)) & 0xFFu]++;
    }
    {
        /* Chi-square over 256 buckets, 255 df: 5% critical value is ~293,
         * so 500 is a wide margin that still catches a real bias. */
        double const expect = (double)n / 256.0;

        for (size_t b = 0; b < 8; b++) {
            double chi2 = 0.0;

            for (size_t v = 0; v < 256; v++) {
                double const d = (double)counts[b][v] - expect;
                chi2 += d * d / expect;
            }
            if (!RTR_CHECK(chi2 < 500.0))
                fprintf(stderr, "      output byte %zu chi2=%.1f\n", b, chi2);
        }
    }
}

int main(void) {
    printf("test_avalanche\n");
    rtr_print_levels();

    RTR_RUN(single_bit_avalanche);
    RTR_RUN(seed_avalanche);
    RTR_RUN(no_collisions_in_structured_inputs);
    RTR_RUN(output_bytes_are_uniform);

    return RTR_REPORT("test_avalanche");
}
