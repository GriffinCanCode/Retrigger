/*
 * Throughput measurement for whichever level is currently active.
 *
 * Every pass folds its digest into `checksum`, which the caller can read, so
 * the compiler cannot delete the loop and hand back a number that describes no
 * work. There is no comparison against any other hash function here: the only
 * honest thing to report is what this code actually did.
 */

#include "retrigger_hash.h"

#include "rtr_alloc.h"

#include <stdint.h>
#include <string.h>
#include <time.h>

#define RTR_BENCH_SLACK 64u

/*
 * RTR_BENCH_MAX_SIZE is declared in the public header because it is part of the
 * contract. Why there is a ceiling at all:
 *
 * test_size reaches here from whatever called the binding, so it is an arbitrary
 * 64-bit number rather than a plausible one, and two things go wrong if it is
 * passed straight through. Adding the slack to a size near the top of the address
 * space wraps the sum, which would size the allocation from the wrapped value
 * while every read from it still used the unwrapped test_size. And "the allocator
 * will return NULL for something absurd" is not portable: glibc and
 * AddressSanitizer both abort the process on a request that large instead, which
 * hands the caller a way to kill a daemon by asking for a big benchmark.
 *
 * A gibibyte per pass is already past the point where this measures the hash
 * rather than the memory subsystem, so refusing more costs no measurement anyone
 * wanted, and it puts the ceiling far enough below SIZE_MAX to close the wrap.
 */
_Static_assert(RTR_BENCH_MAX_SIZE <= (size_t)-1 - RTR_BENCH_SLACK,
               "the benchmark ceiling plus its slack must not wrap size_t");

static uint64_t rtr_now_ns(void) {
#if defined(CLOCK_MONOTONIC)
    struct timespec ts;
    if (clock_gettime(CLOCK_MONOTONIC, &ts) == 0)
        return (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;
#endif
    return (uint64_t)clock() * (1000000000ULL / CLOCKS_PER_SEC);
}

rtr_benchmark_result_t rtr_hash_benchmark(size_t test_size, uint32_t iterations) {
    rtr_benchmark_result_t result;
    uint8_t *data;
    uint64_t checksum = 0;
    uint64_t start, elapsed;

    memset(&result, 0, sizeof result);
    result.level = (int32_t)rtr_hash_init();
    if (test_size == 0 || iterations == 0) return result;

    /* Refused rather than attempted; see RTR_BENCH_MAX_SIZE. */
    if (test_size > RTR_BENCH_MAX_SIZE) return result;

    /* Slack at the end lets each pass hash a different window of exactly
     * test_size bytes, so no pass can be a cached repeat of the last one. */
    data = (uint8_t *)RTR_MALLOC(test_size + RTR_BENCH_SLACK);
    if (data == NULL) return result;

    {   /* Deterministic filler; a constant pattern would flatter the loads. */
        uint64_t seed = 0x9E3779B185EBCA87ULL;
        for (size_t i = 0; i < test_size + RTR_BENCH_SLACK; i++) {
            seed = seed * 6364136223846793005ULL + 1442695040888963407ULL;
            data[i] = (uint8_t)(seed >> 33);
        }
    }

    for (uint32_t i = 0; i < 8; i++) checksum ^= rtr_hash64(data, test_size);

    start = rtr_now_ns();
    for (uint32_t i = 0; i < iterations; i++) {
        checksum = checksum * 31u + rtr_hash64(data + (i % RTR_BENCH_SLACK), test_size);
    }
    elapsed = rtr_now_ns() - start;
    if (elapsed == 0) elapsed = 1;

    result.bytes_hashed = (uint64_t)test_size * iterations;
    result.elapsed_ns = elapsed;
    result.checksum = checksum;
    result.ns_per_byte = (double)elapsed / (double)result.bytes_hashed;
    result.throughput_mbps =
        ((double)result.bytes_hashed / (1024.0 * 1024.0)) /
        ((double)elapsed / 1e9);

    RTR_FREE(data);
    return result;
}
