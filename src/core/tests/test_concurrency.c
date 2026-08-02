/*
 * Concurrent hashing.
 *
 * rtr_hash_force_level is documented as process-global and not thread-safe
 * against concurrent hashing, so this suite never forces a level while threads
 * run. What it does exercise is the part that must be safe: many threads
 * hashing at once, racing the one-time dispatch initialisation (g_levels /
 * g_cpu_level), and each driving its own streaming state. Every thread must
 * agree with the single-threaded reference. Run under TSAN (`make -C src/core
 * tsan`) this also proves the initialisation race is benign rather than merely
 * usually-benign.
 *
 * POSIX threads; on Windows the suite reports a skip so the file still links.
 */

#include "rtr_test.h"

#if defined(_WIN32) || !defined(__has_include)
#define RTR_NO_THREADS 1
#elif !__has_include(<pthread.h>)
#define RTR_NO_THREADS 1
#endif

#if defined(RTR_NO_THREADS)

int main(void) {
    printf("test_concurrency\n");
    printf("  (skipped: no pthreads on this platform)\n");
    return RTR_REPORT("test_concurrency");
}

#else

#include <pthread.h>
#include <stdlib.h>

#define THREADS 8
#define ROUNDS  4000
#define BUFLEN  3333

static uint8_t g_buf[BUFLEN];
static uint64_t g_reference; /* one-shot digest computed single-threaded */

/* Shared failure flag: a worker sets it, main reports it. Threads must not call
 * the harness's non-atomic counters, so they signal through this instead. */
static int g_worker_failed;

static void *hammer_oneshot(void *arg) {
    (void)arg;
    for (int i = 0; i < ROUNDS; i++) {
        if (rtr_hash64(g_buf, BUFLEN) != g_reference) {
            g_worker_failed = 1;
            return NULL;
        }
    }
    return NULL;
}

/* Each thread owns its state; streaming in odd little chunks must still land on
 * the one-shot digest no matter how the threads interleave. */
static void *hammer_streaming(void *arg) {
    uintptr_t const id = (uintptr_t)arg;
    for (int i = 0; i < ROUNDS / 4; i++) {
        rtr_hash_state_t *st = rtr_hash_create();
        size_t off = 0;
        if (st == NULL) {
            g_worker_failed = 1;
            return NULL;
        }
        rtr_hash_reset(st, 0);
        while (off < BUFLEN) {
            size_t n = ((size_t)(i + id) % 257u) + 1u;
            if (n > BUFLEN - off)
                n = BUFLEN - off;
            rtr_hash_update(st, g_buf + off, n);
            off += n;
        }
        if (rtr_hash_digest(st) != g_reference)
            g_worker_failed = 1;
        rtr_hash_destroy(st);
    }
    return NULL;
}

static void run_pool(void *(*fn)(void *)) {
    pthread_t threads[THREADS];
    int spawned = 0;

    g_worker_failed = 0;
    for (int i = 0; i < THREADS; i++) {
        if (pthread_create(&threads[i], NULL, fn, (void *)(uintptr_t)i) == 0) {
            spawned++;
        } else {
            RTR_CHECK(0); /* could not spawn: recorded as a failure */
        }
    }
    for (int i = 0; i < spawned; i++)
        pthread_join(threads[i], NULL);
    RTR_CHECK(!g_worker_failed);
}

static void concurrent_oneshot_agrees(void) {
    run_pool(hammer_oneshot);
}
static void concurrent_streaming_agrees(void) {
    run_pool(hammer_streaming);
}

/* A level forced during setup -- the documented-safe usage -- must hold for all
 * threads that then hash, and reset must restore afterward. */
static void a_level_forced_before_the_race_is_honoured(void) {
    int levels[8];
    size_t const n = rtr_collect_levels(levels, 8);

    for (size_t l = 0; l < n; l++) {
        RTR_CHECK(rtr_hash_force_level((rtr_simd_level_t)levels[l]) == 0);
        g_reference = rtr_hash64(g_buf, BUFLEN);
        run_pool(hammer_oneshot);
        rtr_hash_reset_level();
    }
    /* Restore the reference for any later case. */
    g_reference = rtr_hash64(g_buf, BUFLEN);
}

int main(void) {
    printf("test_concurrency (%d threads)\n", THREADS);
    rtr_fill_test_buffer(g_buf, BUFLEN);
    g_reference = rtr_hash64(g_buf, BUFLEN);

    RTR_RUN(concurrent_oneshot_agrees);
    RTR_RUN(concurrent_streaming_agrees);
    RTR_RUN(a_level_forced_before_the_race_is_honoured);

    return RTR_REPORT("test_concurrency");
}

#endif /* threads */
