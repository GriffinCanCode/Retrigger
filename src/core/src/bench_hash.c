/*
 * Benchmark driver.
 *
 * The previous version of this file reported a "xxHash (simulated)" column
 * computed as 0.9x our own number. That comparison was invented, not measured,
 * and it is gone. What remains is only work this process actually performed:
 * throughput per SIMD level, per input size, with the digest folded into a
 * checksum that is printed so the optimizer cannot delete the loop.
 *
 * The level named in each row is the level that ran, taken from the result
 * struct, not the one we intended to run.
 */

#include "retrigger_hash.h"

#include <stdio.h>
#include <stdlib.h>
#include <time.h>

static const size_t g_sizes[] = {
    64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 16777216,
};

/* Enough iterations for a stable reading without a slow run at large sizes. */
static uint32_t iterations_for(size_t size) {
    uint64_t const target_bytes = 512ull * 1024 * 1024;
    uint64_t n = target_bytes / size;

    if (n < 16) n = 16;
    if (n > 2000000) n = 2000000;
    return (uint32_t)n;
}

static void bench_level(rtr_simd_level_t level) {
    if (rtr_hash_force_level(level) != 0) {
        printf("  %-7s unsupported on this CPU, skipped\n",
               rtr_hash_level_str(level));
        return;
    }
    printf("  %-8s %10s %12s %12s %14s %20s\n", "level", "size", "iters",
           "MiB/s", "ns/byte", "checksum");
    for (size_t i = 0; i < sizeof g_sizes / sizeof g_sizes[0]; i++) {
        uint32_t const iters = iterations_for(g_sizes[i]);
        rtr_benchmark_result_t const r = rtr_hash_benchmark(g_sizes[i], iters);

        printf("  %-8s %10zu %12u %12.1f %14.4f   0x%016llX\n",
               rtr_hash_level_str((rtr_simd_level_t)r.level), g_sizes[i], iters,
               r.throughput_mbps, r.ns_per_byte,
               (unsigned long long)r.checksum);
    }
    printf("\n");
}

static uint64_t now_ns(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;
}

/* Streaming carries per-chunk overhead, so it gets its own measurement. */
static void bench_streaming(size_t chunk, uint64_t total) {
    rtr_hash_state_t *st = rtr_hash_create();
    uint8_t *buf = (uint8_t *)malloc(chunk);
    uint64_t const rounds = total / chunk;
    uint64_t start, elapsed;

    if (st == NULL || buf == NULL) {
        free(buf);
        rtr_hash_destroy(st);
        return;
    }
    for (size_t i = 0; i < chunk; i++) buf[i] = (uint8_t)(i * 31u + 7u);

    rtr_hash_reset(st, 0);
    rtr_hash_update(st, buf, chunk); /* warm the code paths */
    rtr_hash_reset(st, 0);

    start = now_ns();
    for (uint64_t i = 0; i < rounds; i++) rtr_hash_update(st, buf, chunk);
    {
        uint64_t const digest = rtr_hash_digest(st);
        elapsed = now_ns() - start;
        if (elapsed == 0) elapsed = 1;
        printf("  %llu updates of %zu B: %.1f MiB/s (digest 0x%016llX)\n",
               (unsigned long long)rounds, chunk,
               ((double)(rounds * chunk) / (1024.0 * 1024.0)) /
                   ((double)elapsed / 1e9),
               (unsigned long long)digest);
    }
    free(buf);
    rtr_hash_destroy(st);
}

int main(void) {
    uint32_t const mask = rtr_hash_available_levels();

    printf("Retrigger XXH3-64 benchmark\n");
    printf("CPU-selected level: %s\n", rtr_hash_level_str(rtr_hash_cpu_level()));
    printf("Available levels  :");
    for (int lvl = 0; lvl <= (int)RTR_SIMD_AVX512; lvl++)
        if (mask & (1u << (unsigned)lvl))
            printf(" %s", rtr_hash_level_str((rtr_simd_level_t)lvl));
    printf("\n\n");

    for (int lvl = 0; lvl <= (int)RTR_SIMD_AVX512; lvl++)
        if (mask & (1u << (unsigned)lvl)) bench_level((rtr_simd_level_t)lvl);

    rtr_hash_reset_level();
    printf("streaming (level %s)\n", rtr_hash_level_str(rtr_hash_active_level()));
    bench_streaming(65536, 512ull * 1024 * 1024);
    return 0;
}
