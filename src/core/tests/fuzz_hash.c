/*
 * libFuzzer entry point: the two invariants that must hold for any input.
 *
 *   1. Every SIMD level agrees with the scalar reference, bit for bit.
 *   2. Any chunking of the input streams to the one-shot digest.
 *
 * Neither needs an expected value, so the fuzzer can explore freely; a
 * disagreement is the bug report. Built only by `make fuzz`, which is guarded
 * on clang having libFuzzer -- `make test` never depends on this file.
 *
 *   make fuzz CC=clang FUZZ_SECONDS=120
 */

#include "retrigger_hash.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

static uint64_t stream_with_split(const uint8_t *data, size_t size, uint64_t seed,
                                  uint64_t split_source) {
    rtr_hash_state_t *st = rtr_hash_create();
    uint64_t digest, r = split_source | 1u;
    size_t off = 0;

    if (st == NULL) return 0;
    rtr_hash_reset(st, seed);
    for (int idle = 0; off < size;) {
        size_t n;

        r ^= r << 13;
        r ^= r >> 7;
        r ^= r << 17;
        n = (size_t)(r % 1024u);
        if (n > size - off) n = size - off;
        /* Zero-length updates must be inert, but two in a row is enough of a
         * demonstration; forcing progress keeps the fuzzer from stalling. */
        if (n == 0 && ++idle > 2) n = 1;
        if (n != 0) idle = 0;
        rtr_hash_update(st, data + off, n);
        off += n;
    }
    digest = rtr_hash_digest(st);
    rtr_hash_destroy(st);
    return digest;
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size);

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
    uint32_t const mask = rtr_hash_available_levels();
    /* Derive a seed from the input so seeded paths get explored too. */
    uint64_t const seed = size >= 8 ? (uint64_t)data[0] * 0x9E3779B97F4A7C15ULL : 0;
    uint64_t reference;

    if (rtr_hash_force_level(RTR_SIMD_SCALAR) != 0) abort();
    reference = rtr_hash64_seed(data, size, seed);

    for (int lvl = 0; lvl <= (int)RTR_SIMD_AVX512; lvl++) {
        if (!(mask & (1u << (unsigned)lvl))) continue;
        if (rtr_hash_force_level((rtr_simd_level_t)lvl) != 0) abort();
        if (rtr_hash64_seed(data, size, seed) != reference) {
            fprintf(stderr, "level %s disagrees with scalar on %zu bytes\n",
                    rtr_hash_level_str((rtr_simd_level_t)lvl), size);
            abort();
        }
        if (stream_with_split(data, size, seed, size + 1) != reference) {
            fprintf(stderr, "streaming disagrees with one-shot at level %s, %zu bytes\n",
                    rtr_hash_level_str((rtr_simd_level_t)lvl), size);
            abort();
        }
    }
    rtr_hash_reset_level();
    return 0;
}
