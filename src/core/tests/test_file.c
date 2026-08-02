/*
 * File hashing: same answer as memory, bounded memory, honest errors.
 *
 * The engine reads in 256 KiB chunks, so the interesting cases are the ones
 * that land near that boundary, and the size field is a uint64_t because the
 * previous implementation truncated it to 32 bits -- a 5 GiB file used to
 * report 705 MB. Actually writing a 5 GiB file here would make `make test`
 * unusable, so that case is covered by a direct test of the accumulation
 * arithmetic instead, and the fact is noted rather than glossed over.
 */

#include "rtr_test.h"

#include <errno.h>
#include <stdio.h>

#if defined(_WIN32)
#include <direct.h>
#include <process.h>
#define rtr_getpid _getpid
#define rtr_mkdir(p) _mkdir(p)
#define rtr_rmdir _rmdir
#else
#include <sys/stat.h>
#include <unistd.h>
#define rtr_getpid getpid
#define rtr_mkdir(p) mkdir((p), 0700)
#define rtr_rmdir rmdir
#endif

#define RTR_CHUNK (256u * 1024u)

static char g_dir[512];

static void temp_path(char *out, size_t cap, const char *name) {
    snprintf(out, cap, "%s/%s", g_dir, name);
}

static int write_file(const char *path, const uint8_t *data, size_t len) {
    FILE *fp = fopen(path, "wb");
    size_t wrote;

    if (fp == NULL) return -1;
    wrote = len ? fwrite(data, 1, len, fp) : 0;
    return (fclose(fp) == 0 && wrote == len) ? 0 : -1;
}

static void check_roundtrip(const char *name, size_t len, uint8_t *scratch) {
    char path[600];
    rtr_hash_file_result_t r;

    temp_path(path, sizeof path, name);
    rtr_fill_test_buffer(scratch, len);
    if (!RTR_CHECK(write_file(path, scratch, len) == 0)) return;

    r = rtr_hash_file(path);
    RTR_CHECK_EQ_INT(r.error, 0);
    RTR_CHECK_EQ_MSG(r.size, (uint64_t)len, "reported size");
    RTR_CHECK_EQ_MSG(r.hash, rtr_hash64(scratch, len), name);
    remove(path);
}

static void file_matches_memory(void) {
    /* Straddle the 256 KiB read chunk in both directions, and the streaming
     * buffer and secret block below it. */
    static const size_t lens[] = {1,
                                  63,
                                  256,
                                  1024,
                                  4096,
                                  RTR_CHUNK - 1,
                                  RTR_CHUNK,
                                  RTR_CHUNK + 1,
                                  RTR_CHUNK + 63,
                                  2u * RTR_CHUNK,
                                  2u * RTR_CHUNK + 12345u};
    uint8_t *scratch = (uint8_t *)malloc(3u * RTR_CHUNK);

    if (!RTR_CHECK(scratch != NULL)) return;
    for (size_t i = 0; i < sizeof lens / sizeof lens[0]; i++)
        check_roundtrip("rtr_roundtrip.bin", lens[i], scratch);
    free(scratch);
}

static void empty_file(void) {
    char path[600];
    rtr_hash_file_result_t r;

    temp_path(path, sizeof path, "rtr_empty.bin");
    if (!RTR_CHECK(write_file(path, NULL, 0) == 0)) return;

    r = rtr_hash_file(path);
    RTR_CHECK_EQ_INT(r.error, 0);
    RTR_CHECK_EQ_MSG(r.size, 0u, "empty file size");
    RTR_CHECK_EQ_MSG(r.hash, rtr_hash64(NULL, 0), "empty file hash");
    RTR_CHECK_EQ_MSG(r.hash, 0x2D06800538D394C2ULL, "empty file is XXH3 of \"\"");
    remove(path);
}

static void missing_file_reports_enoent(void) {
    char path[600];
    rtr_hash_file_result_t r;

    temp_path(path, sizeof path, "rtr_definitely_not_here.bin");
    remove(path);
    r = rtr_hash_file(path);
    RTR_CHECK_EQ_INT(r.error, ENOENT);
    RTR_CHECK_EQ(r.hash, 0u);
    RTR_CHECK_EQ(r.size, 0u);
}

static void directory_fails_cleanly(void) {
    rtr_hash_file_result_t const r = rtr_hash_file(g_dir);

    RTR_CHECK_EQ_INT(r.error, EISDIR);
    RTR_CHECK_EQ(r.size, 0u);
}

static void null_path_is_einval(void) {
    rtr_hash_file_result_t const r = rtr_hash_file(NULL);

    RTR_CHECK_EQ_INT(r.error, EINVAL);
}

/*
 * The size arithmetic itself, without writing 5 GiB. This is exactly the
 * accumulation rtr_hash_file performs; done in a 32-bit accumulator it wraps,
 * which is the bug the uint64_t field exists to prevent.
 */
static void size_arithmetic_survives_4gib(void) {
    uint64_t const target = 5ULL * 1024 * 1024 * 1024 + 4096; /* 5 GiB + 4 KiB */
    uint64_t total = 0;
    uint32_t narrow = 0;
    uint64_t remaining = target;

    while (remaining > 0) {
        uint32_t const got = remaining > RTR_CHUNK ? RTR_CHUNK : (uint32_t)remaining;
        total += got;
        narrow += got;
        remaining -= got;
    }
    RTR_CHECK_EQ_MSG(total, target, "64-bit chunk accumulation");
    RTR_CHECK(narrow != target); /* the old 32-bit field really did truncate */
    RTR_CHECK_EQ_MSG((uint64_t)narrow, target & 0xFFFFFFFFULL, "32-bit wraparound");

    /* And the struct field is genuinely 64 bits wide, not a widened copy of a
     * 32-bit value assigned somewhere upstream. */
    {
        rtr_hash_file_result_t probe;
        memset(&probe, 0, sizeof probe);
        probe.size = target;
        RTR_CHECK_EQ_MSG(probe.size, target, "rtr_hash_file_result_t.size width");
        RTR_CHECK_EQ_INT(sizeof probe.size, 8);
    }
}

/* A file read must not depend on which SIMD level happens to be active. */
static void file_hash_agrees_across_levels(void) {
    char path[600];
    int levels[8];
    size_t const nlevels = rtr_collect_levels(levels, 8);
    size_t const len = RTR_CHUNK + 777u;
    uint8_t *scratch = (uint8_t *)malloc(len);
    uint64_t reference = 0;

    if (!RTR_CHECK(scratch != NULL)) return;
    rtr_fill_test_buffer(scratch, len);
    temp_path(path, sizeof path, "rtr_levels.bin");
    if (!RTR_CHECK(write_file(path, scratch, len) == 0)) {
        free(scratch);
        return;
    }
    for (size_t l = 0; l < nlevels; l++) {
        rtr_hash_file_result_t r;

        RTR_CHECK(rtr_hash_force_level((rtr_simd_level_t)levels[l]) == 0);
        r = rtr_hash_file(path);
        RTR_CHECK_EQ_INT(r.error, 0);
        RTR_CHECK_EQ_MSG(r.size, (uint64_t)len, "size per level");
        if (l == 0)
            reference = r.hash;
        else
            RTR_CHECK_EQ_MSG(r.hash, reference,
                             rtr_hash_level_str((rtr_simd_level_t)levels[l]));
        RTR_CHECK_EQ_MSG(r.hash, rtr_hash64(scratch, len), "file vs memory");
    }
    rtr_hash_reset_level();
    remove(path);
    free(scratch);
}

int main(void) {
    printf("test_file\n");
    snprintf(g_dir, sizeof g_dir, "%s/rtr_hash_test_%d", rtr_test_tmpdir(),
             (int)rtr_getpid());
    if (rtr_mkdir(g_dir) != 0 && errno != EEXIST) {
        fprintf(stderr, "cannot create %s: %s\n", g_dir, strerror(errno));
        return 1;
    }

    RTR_RUN(file_matches_memory);
    RTR_RUN(empty_file);
    RTR_RUN(missing_file_reports_enoent);
    RTR_RUN(directory_fails_cleanly);
    RTR_RUN(null_path_is_einval);
    RTR_RUN(size_arithmetic_survives_4gib);
    RTR_RUN(file_hash_agrees_across_levels);

    rtr_rmdir(g_dir);
    return RTR_REPORT("test_file");
}
