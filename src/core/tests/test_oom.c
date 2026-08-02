/*
 * Out-of-memory and leak behaviour, driven rather than hoped for.
 *
 * This binary is linked against the library compiled with -DRTR_ALLOC_HOOKS, so
 * every allocation the library makes lands in rtr_hook_malloc below. That buys
 * two things no other suite here can get:
 *
 *   1. Failure injection. Each entry point that allocates is run once per
 *      allocation it makes, with that one allocation failing, and is required to
 *      report the failure rather than crash, hand back a plausible-looking hash,
 *      or leak what it had already taken. `rtr_hash_file` is the interesting one:
 *      it allocates twice and must unwind both while still closing its file.
 *
 *   2. A leak oracle. Every case asserts the library's outstanding block count
 *      returns to zero. AddressSanitizer's LeakSanitizer would cover this on
 *      Linux, but it does not exist on macOS, and a watcher that leaks a
 *      256 KiB chunk per hashed file is a defect on both.
 *
 * The counters deliberately track the *library's* allocations only. Anything
 * this file allocates for its own fixtures uses malloc directly.
 */

#include "rtr_test.h"

#include <errno.h>
#include <stdio.h>

#if defined(_WIN32)
#include <process.h>
#define rtr_getpid _getpid
#else
#include <unistd.h>
#define rtr_getpid getpid
#endif

/* ------------------------------------------------------- the hooked allocator */

/* Allocations remaining before one fails. Negative means never fail. */
static long rtr_oom_countdown = -1;
/* Blocks the library currently holds. */
static long rtr_oom_live;
/* Allocations the library has requested since the last arm(). */
static long rtr_oom_requested;
/* Allocations actually refused. */
static long rtr_oom_refused;

void *rtr_hook_malloc(size_t size) {
    rtr_oom_requested++;
    if (rtr_oom_countdown >= 0) {
        if (rtr_oom_countdown == 0) {
            rtr_oom_refused++;
            rtr_oom_countdown = -1; /* one shot: fail this call only */
            return NULL;
        }
        rtr_oom_countdown--;
    }
    {
        void *p = malloc(size);
        if (p != NULL) rtr_oom_live++;
        return p;
    }
}

void rtr_hook_free(void *ptr) {
    if (ptr != NULL) rtr_oom_live--;
    free(ptr);
}

/* Let the next `n` allocations succeed, then fail exactly one. */
static void rtr_oom_arm(long n) {
    rtr_oom_countdown = n;
    rtr_oom_requested = 0;
    rtr_oom_refused = 0;
}

static void rtr_oom_disarm(void) { rtr_oom_countdown = -1; }

/* ------------------------------------------------------------------ fixtures */

static char g_fixture[600];

static void rtr_init_fixture_path(void) {
    snprintf(g_fixture, sizeof g_fixture, "%s/rtr_oom_%d.bin", rtr_test_tmpdir(),
             (int)rtr_getpid());
}

static const char *rtr_temp_path(void) { return g_fixture; }

static int rtr_write_fixture(size_t bytes) {
    FILE *fp = fopen(rtr_temp_path(), "wb");
    uint8_t *buf;
    size_t written;

    if (fp == NULL) return -1;
    buf = (uint8_t *)malloc(bytes == 0 ? 1 : bytes);
    if (buf == NULL) {
        fclose(fp);
        return -1;
    }
    rtr_fill_test_buffer(buf, bytes);
    written = bytes == 0 ? 0 : fwrite(buf, 1, bytes, fp);
    free(buf);
    fclose(fp);
    return written == bytes ? 0 : -1;
}

static void rtr_remove_fixture(void) { remove(rtr_temp_path()); }

/* ---------------------------------------------------------------------- cases */

static void oom_create_reports_null(void) {
    rtr_oom_arm(0); /* the very first allocation fails */
    RTR_CHECK(rtr_hash_create() == NULL);
    RTR_CHECK_EQ_INT(rtr_oom_refused, 1);
    rtr_oom_disarm();
    RTR_CHECK_EQ_INT(rtr_oom_live, 0);
}

static void destroying_null_is_a_no_op(void) {
    /* free(NULL) is legal C, and the wrapper must not count it as a release. */
    rtr_hash_destroy(NULL);
    RTR_CHECK_EQ_INT(rtr_oom_live, 0);
}

static void streaming_state_is_released(void) {
    for (int i = 0; i < 100; i++) {
        rtr_hash_state_t *st = rtr_hash_create();
        RTR_CHECK(st != NULL);
        rtr_hash_update(st, "abc", 3);
        rtr_hash_reset(st, 7);
        rtr_hash_update(st, "def", 3);
        (void)rtr_hash_digest(st);
        rtr_hash_destroy(st);
    }
    RTR_CHECK_EQ_MSG((uint64_t)rtr_oom_live, 0,
                     "a hundred create/destroy cycles must leave nothing behind");
}

/*
 * Every allocation inside rtr_hash_file, failed one at a time.
 *
 * The count is discovered rather than assumed, so this keeps covering the whole
 * function if it starts allocating a third time.
 */
static void oom_in_file_hashing_is_reported(void) {
    long allocations;

    if (rtr_write_fixture(4096) != 0) {
        RTR_CHECK_EQ_MSG(0, 1, "could not write the fixture file");
        return;
    }

    /* Baseline: how many allocations does a successful call make? */
    rtr_oom_arm(-1);
    rtr_oom_requested = 0;
    {
        rtr_hash_file_result_t const ok = rtr_hash_file(rtr_temp_path());
        RTR_CHECK_EQ_INT(ok.error, 0);
        RTR_CHECK_EQ_INT(ok.size, 4096);
    }
    allocations = rtr_oom_requested;
    RTR_CHECK(allocations >= 2);
    RTR_CHECK_EQ_INT(rtr_oom_live, 0);

    for (long n = 0; n < allocations; n++) {
        rtr_hash_file_result_t r;

        rtr_oom_arm(n);
        r = rtr_hash_file(rtr_temp_path());
        rtr_oom_disarm();

        RTR_CHECK_EQ_MSG((uint64_t)rtr_oom_refused, 1, "the injected failure must be taken");
        RTR_CHECK_EQ_MSG((uint64_t)r.error, (uint64_t)ENOMEM,
                         "an allocation failure must surface as ENOMEM");
        RTR_CHECK_EQ_MSG((uint64_t)r.hash, 0, "a failed hash must not report a digest");
        RTR_CHECK_EQ_MSG((uint64_t)r.size, 0, "a failed hash must not report a size");
        RTR_CHECK_EQ_MSG((uint64_t)rtr_oom_live, 0,
                         "the allocation that did succeed must still be released");
    }

    rtr_remove_fixture();
}

static void repeated_file_hashing_does_not_accumulate(void) {
    if (rtr_write_fixture(300u * 1024u) != 0) {
        RTR_CHECK_EQ_MSG(0, 1, "could not write the fixture file");
        return;
    }
    /* Larger than the 256 KiB read chunk, so the read loop runs more than once
     * and a per-iteration leak would show up. */
    for (int i = 0; i < 50; i++) {
        rtr_hash_file_result_t const r = rtr_hash_file(rtr_temp_path());
        RTR_CHECK_EQ_INT(r.error, 0);
        RTR_CHECK_EQ_INT(r.size, 300u * 1024u);
    }
    RTR_CHECK_EQ_MSG((uint64_t)rtr_oom_live, 0,
                     "peak memory must not grow across repeated hashes");
    rtr_remove_fixture();
}

static void a_missing_file_allocates_nothing(void) {
    rtr_oom_arm(-1);
    rtr_oom_requested = 0;
    {
        rtr_hash_file_result_t const r = rtr_hash_file("./definitely/not/here.bin");
        RTR_CHECK(r.error != 0);
    }
    RTR_CHECK_EQ_MSG((uint64_t)rtr_oom_requested, 0,
                     "a path that cannot be opened must be rejected before allocating");
    RTR_CHECK_EQ_INT(rtr_oom_live, 0);
}

static void oom_in_benchmark_is_reported(void) {
    rtr_oom_arm(0);
    {
        rtr_benchmark_result_t const r = rtr_hash_benchmark(1024, 4);
        RTR_CHECK_EQ_MSG((uint64_t)r.bytes_hashed, 0,
                         "a benchmark that could not allocate must report no work");
        RTR_CHECK_EQ_MSG((uint64_t)r.elapsed_ns, 0, "and no elapsed time");
    }
    rtr_oom_disarm();
    RTR_CHECK_EQ_INT(rtr_oom_live, 0);
}

/*
 * No `test_size` may reach the allocator unchecked.
 *
 * Two distinct bugs live here. `test_size + 64` used to wrap for a size near the
 * top of the address space, sizing the buffer from the wrapped sum while every
 * read from it still used the unwrapped test_size -- a heap over-read that
 * crashed with a bus error. And a size that does *not* wrap but is still absurd
 * must not be handed to malloc either: glibc and AddressSanitizer abort on a
 * request that large rather than returning NULL, so the caller would be choosing
 * how the process dies. A caller reaching either through the Node binding is
 * merely passing a large number.
 *
 * The assertion is therefore that nothing is even requested, not that the request
 * failed.
 */
static void an_unservable_size_is_refused_without_allocating(void) {
    /* 64 is the benchmark's internal slack, so the two sizes either side of
     * SIZE_MAX - 64 are the wrap boundary. Written out rather than importing the
     * constant: the slack is an implementation detail, and a test that knows it
     * only by value still fails if the arithmetic regresses. */
    size_t const sizes[] = {
        SIZE_MAX,
        SIZE_MAX - 1,
        SIZE_MAX - 63, /* wraps test_size + slack */
        SIZE_MAX - 64, /* does not wrap, still unservable */
        SIZE_MAX / 2,
        (size_t)RTR_BENCH_MAX_SIZE + 1, /* just over the documented ceiling */
    };

    for (size_t i = 0; i < sizeof sizes / sizeof sizes[0]; i++) {
        rtr_oom_arm(-1);
        rtr_oom_requested = 0;
        {
            rtr_benchmark_result_t const r = rtr_hash_benchmark(sizes[i], 1);
            RTR_CHECK_EQ_MSG((uint64_t)r.bytes_hashed, 0,
                             "a size this large must be refused, not attempted");
        }
        RTR_CHECK_EQ_MSG((uint64_t)rtr_oom_requested, 0,
                         "an unservable size must never reach the allocator");
        RTR_CHECK_EQ_MSG((uint64_t)rtr_oom_live, 0, "and must leave nothing allocated");
    }
}

/* The ceiling itself must still work: a bound nobody can reach is not a bound. */
static void the_largest_accepted_size_still_measures(void) {
    rtr_benchmark_result_t const r = rtr_hash_benchmark(RTR_BENCH_MAX_SIZE, 1);

    /* An allocation this large may legitimately fail on a small machine, in which
     * case the documented empty result is correct. What must not happen is a
     * crash, or a measurement of work that was never done. */
    if (r.bytes_hashed == 0) {
        RTR_CHECK_EQ_MSG((uint64_t)r.elapsed_ns, 0, "no work means no elapsed time");
    } else {
        RTR_CHECK_EQ_MSG(r.bytes_hashed, (uint64_t)RTR_BENCH_MAX_SIZE, "bytes hashed");
        RTR_CHECK(r.elapsed_ns > 0);
    }
    RTR_CHECK_EQ_MSG((uint64_t)rtr_oom_live, 0, "the buffer must be released either way");
    RTR_CHECK_EQ_MSG((uint64_t)r.checksum != 0 || r.bytes_hashed == 0, 1,
                     "a measurement with no checksum means the loop was elided");
}

static void zero_work_benchmarks_allocate_nothing(void) {
    rtr_oom_arm(-1);
    rtr_oom_requested = 0;
    {
        rtr_benchmark_result_t const a = rtr_hash_benchmark(0, 10);
        rtr_benchmark_result_t const b = rtr_hash_benchmark(1024, 0);
        RTR_CHECK_EQ_INT(a.bytes_hashed, 0);
        RTR_CHECK_EQ_INT(b.bytes_hashed, 0);
    }
    RTR_CHECK_EQ_MSG((uint64_t)rtr_oom_requested, 0,
                     "no work requested means no memory taken");
    RTR_CHECK_EQ_INT(rtr_oom_live, 0);
}

static void one_shot_hashing_never_allocates(void) {
    /* The documented property that makes this engine safe to call per event: the
     * one-shot path is entirely on the stack. */
    uint8_t buf[4096];

    rtr_fill_test_buffer(buf, sizeof buf);
    rtr_oom_arm(-1);
    rtr_oom_requested = 0;
    for (size_t len = 0; len <= sizeof buf; len += 97) (void)rtr_hash64(buf, len);
    RTR_CHECK_EQ_MSG((uint64_t)rtr_oom_requested, 0,
                     "rtr_hash64 must not touch the heap at any length");
    RTR_CHECK_EQ_INT(rtr_oom_live, 0);
}

int main(void) {
    printf("test_oom: allocation failure and leak accounting\n");
    rtr_print_levels();
    rtr_init_fixture_path();

    RTR_RUN(oom_create_reports_null);
    RTR_RUN(destroying_null_is_a_no_op);
    RTR_RUN(streaming_state_is_released);
    RTR_RUN(oom_in_file_hashing_is_reported);
    RTR_RUN(repeated_file_hashing_does_not_accumulate);
    RTR_RUN(a_missing_file_allocates_nothing);
    RTR_RUN(oom_in_benchmark_is_reported);
    RTR_RUN(an_unservable_size_is_refused_without_allocating);
    RTR_RUN(the_largest_accepted_size_still_measures);
    RTR_RUN(zero_work_benchmarks_allocate_nothing);
    RTR_RUN(one_shot_hashing_never_allocates);

    rtr_remove_fixture();
    return RTR_REPORT("test_oom");
}
