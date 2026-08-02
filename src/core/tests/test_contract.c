/*
 * The API contract at its edges: null and invalid arguments, the level query
 * surface, the ABI-version handshake, and the one case that must abort rather
 * than lie.
 *
 * A content hasher's worst possible behaviour is a confident wrong answer, so
 * the sharpest test here is negative: rtr_hash64(NULL, len>0) has no buffer to
 * read and no error channel to report it, and it must fail loud instead of
 * returning a plausible digest of bytes that were never supplied. That is a
 * death test -- it asserts the process aborts -- so it runs in a forked child
 * on POSIX and is skipped where fork is unavailable.
 */

#include "rtr_test.h"

#if !defined(_WIN32)
#include <sys/wait.h>
#include <unistd.h>
#endif

#include <errno.h>

static uint8_t g_buf[256];

static void abi_version_is_reported(void) {
    /* The macro and the compiled accessor must agree; a caller that links the
     * library at runtime compares its own header's macro against this. */
    RTR_CHECK_EQ_MSG(rtr_hash_abi_version(), RTR_HASH_ABI_VERSION,
                     "compiled ABI version matches the header macro");
    RTR_CHECK(rtr_hash_abi_version() >= 1u);
}

static void level_names_are_total_and_never_null(void) {
    /* Every valid level has its documented name. */
    RTR_CHECK(strcmp(rtr_hash_level_str(RTR_SIMD_SCALAR), "scalar") == 0);
    RTR_CHECK(strcmp(rtr_hash_level_str(RTR_SIMD_NEON), "neon") == 0);
    RTR_CHECK(strcmp(rtr_hash_level_str(RTR_SIMD_SSE2), "sse2") == 0);
    RTR_CHECK(strcmp(rtr_hash_level_str(RTR_SIMD_AVX2), "avx2") == 0);
    RTR_CHECK(strcmp(rtr_hash_level_str(RTR_SIMD_AVX512), "avx512") == 0);
    /* Out-of-range values still return a non-NULL string, not a crash. */
    RTR_CHECK(rtr_hash_level_str((rtr_simd_level_t)-1) != NULL);
    RTR_CHECK(rtr_hash_level_str((rtr_simd_level_t)999) != NULL);
    RTR_CHECK(strcmp(rtr_hash_level_str((rtr_simd_level_t)999), "unknown") ==
              0);
}

static void available_levels_are_self_consistent(void) {
    uint32_t const mask = rtr_hash_available_levels();
    rtr_simd_level_t const cpu = rtr_hash_cpu_level();
    rtr_simd_level_t const active = rtr_hash_active_level();

    /* Scalar is available on every CPU, by definition. */
    RTR_CHECK((mask & (1u << RTR_SIMD_SCALAR)) != 0);
    /* Whatever the CPU and active levels are, they must be in the mask. */
    RTR_CHECK((mask & (1u << (unsigned)cpu)) != 0);
    RTR_CHECK((mask & (1u << (unsigned)active)) != 0);
    /* init reports the same level as the active-level query. */
    RTR_CHECK_EQ_INT(rtr_hash_init(), active);
}

static void forcing_rejects_the_impossible_and_restores(void) {
    uint32_t const mask = rtr_hash_available_levels();
    rtr_simd_level_t const cpu = rtr_hash_cpu_level();

    /* Out-of-range levels are refused without changing the active level. */
    RTR_CHECK(rtr_hash_force_level((rtr_simd_level_t)-1) == -1);
    RTR_CHECK(rtr_hash_force_level((rtr_simd_level_t)999) == -1);
    RTR_CHECK_EQ_INT(rtr_hash_active_level(), cpu);

    /* A level the CPU does not support is refused too. */
    for (int lvl = 0; lvl <= (int)RTR_SIMD_AVX512; lvl++) {
        if (mask & (1u << (unsigned)lvl)) {
            RTR_CHECK(rtr_hash_force_level((rtr_simd_level_t)lvl) == 0);
            RTR_CHECK_EQ_INT(rtr_hash_active_level(), lvl);
        } else {
            RTR_CHECK(rtr_hash_force_level((rtr_simd_level_t)lvl) == -1);
        }
    }
    rtr_hash_reset_level();
    RTR_CHECK_EQ_INT(rtr_hash_active_level(), cpu);

    /* Scalar is forceable everywhere: the differential tests depend on it. */
    RTR_CHECK(rtr_hash_force_level(RTR_SIMD_SCALAR) == 0);
    rtr_hash_reset_level();
}

static void streaming_rejects_bad_arguments(void) {
    rtr_hash_state_t *st = rtr_hash_create();

    /* Null state is an error on every entry point, never a crash. */
    RTR_CHECK(rtr_hash_reset(NULL, 0) == -1);
    RTR_CHECK(rtr_hash_update(NULL, g_buf, sizeof g_buf) == -1);
    RTR_CHECK_EQ_MSG(rtr_hash_digest(NULL), 0, "digest of NULL state is 0");

    if (!RTR_CHECK(st != NULL))
        return;
    /* A zero-length update is inert, including with a NULL pointer. */
    RTR_CHECK(rtr_hash_update(st, NULL, 0) == 0);
    RTR_CHECK(rtr_hash_update(st, g_buf, 0) == 0);
    /* A NULL pointer with a non-zero length is the caller bug the one-shot path
     * aborts on; streaming has an error channel, so here it returns -1. */
    RTR_CHECK(rtr_hash_update(st, NULL, 16) == -1);
    /* Having rejected the bad call, the state is still usable. */
    RTR_CHECK(rtr_hash_update(st, g_buf, sizeof g_buf) == 0);
    rtr_hash_destroy(st);
}

static void one_shot_null_with_zero_length_is_the_empty_hash(void) {
    uint64_t const empty = rtr_hash64(NULL, 0);
    RTR_CHECK_EQ_MSG(empty, 0x2D06800538D394C2ULL,
                     "XXH3-64 of the empty input");
    RTR_CHECK_EQ_MSG(rtr_hash64(g_buf, 0), empty,
                     "zero length is empty regardless of pointer");
}

static void hashing_a_null_path_is_einval(void) {
    rtr_hash_file_result_t const r = rtr_hash_file(NULL);
    RTR_CHECK_EQ_INT(r.error, EINVAL);
    RTR_CHECK_EQ_MSG(r.size, 0, "a rejected file reports no bytes");
    RTR_CHECK_EQ_MSG(r.hash, 0, "a rejected file reports no hash");
}

#if !defined(_WIN32)
/* The death test: rtr_hash64(NULL, len>0) must abort the process. Run in a
 * child so the abort does not take the suite down, with the child's stderr
 * silenced so the deliberate diagnostic does not look like a failure. */
static void null_with_length_aborts(void) {
    pid_t const pid = fork();
    if (pid == 0) {
        /* Child: silence stderr, then make the forbidden call. If it returns,
         * exit 0 so the parent sees the contract was violated. glibc marks
         * freopen warn_unused_result, and a bare (void) cast does not satisfy
         * it, so the result is bound before it is discarded. Failing to
         * silence stderr only makes the output noisier, never wrong. */
        FILE *const devnull = freopen("/dev/null", "w", stderr);
        (void)devnull;
        volatile uint64_t sink = rtr_hash64(NULL, 8);
        (void)sink;
        _exit(0);
    }
    if (!RTR_CHECK(pid > 0))
        return; /* fork failed; cannot run the death test */

    int status = 0;
    RTR_CHECK(waitpid(pid, &status, 0) == pid);
    /* Success is abnormal termination: a signal (SIGABRT) or, failing that, a
     * non-zero exit. A clean exit 0 means the guard let the bad call through.
     */
    if (WIFEXITED(status)) {
        RTR_CHECK_EQ_INT(WIFEXITED(status) ? 0 : 1,
                         0); /* record the case ran */
        RTR_CHECK(WEXITSTATUS(status) != 0);
    } else {
        RTR_CHECK(WIFSIGNALED(status));
    }
}
#endif

int main(void) {
    printf("test_contract\n");
    rtr_fill_test_buffer(g_buf, sizeof g_buf);

    RTR_RUN(abi_version_is_reported);
    RTR_RUN(level_names_are_total_and_never_null);
    RTR_RUN(available_levels_are_self_consistent);
    RTR_RUN(forcing_rejects_the_impossible_and_restores);
    RTR_RUN(streaming_rejects_bad_arguments);
    RTR_RUN(one_shot_null_with_zero_length_is_the_empty_hash);
    RTR_RUN(hashing_a_null_path_is_einval);
#if !defined(_WIN32)
    RTR_RUN(null_with_length_aborts);
#else
    printf("  null_with_length_aborts            skipped (no fork on this "
           "platform)\n");
#endif

    return RTR_REPORT("test_contract");
}
