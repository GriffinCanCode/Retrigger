/*
 * Adversarial file inputs.
 *
 * test_file.c covers the happy path and the chunk boundaries. This covers the
 * shapes a real tree throws at a watcher's hasher: symlinks (to files and to
 * directories), dangling links, unreadable files, binary content with embedded
 * NULs, and the empty file. Each must return either the correct digest or a
 * specific errno -- never a wrong hash and never a crash.
 *
 * All POSIX; on Windows the whole suite reports a skip so the file still links
 * into the cross-platform build.
 */

#include "rtr_test.h"

#if defined(_WIN32)

int main(void) {
    printf("test_file_adversarial\n");
    printf("  (skipped: POSIX-only file types)\n");
    return RTR_REPORT("test_file_adversarial");
}

#else

#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static char g_dir[512];

static void path_in(char *out, size_t cap, const char *name) {
    snprintf(out, cap, "%s/%s", g_dir, name);
}

/* A symlink to a regular file hashes as the file it points at: fopen follows
 * the link, and the digest and size must match hashing the same bytes in
 * memory -- including the embedded NUL, which a string-based reader would
 * truncate at. */
static void symlink_to_file_follows_to_target(void) {
    /* Deliberately contains a NUL: content, not a C string. */
    static const uint8_t content[] = {'a', 'b',  0x00, 'c',
                                      'd', 0xFF, 0x01, 'z'};
    char target[512], link[512];
    FILE *fp;

    path_in(target, sizeof target, "real.bin");
    path_in(link, sizeof link, "link.bin");

    fp = fopen(target, "wb");
    if (!RTR_CHECK(fp != NULL))
        return;
    RTR_CHECK(fwrite(content, 1, sizeof content, fp) == sizeof content);
    fclose(fp);
    if (!RTR_CHECK(symlink(target, link) == 0))
        return;

    rtr_hash_file_result_t const via_link = rtr_hash_file(link);
    RTR_CHECK_EQ_INT(via_link.error, 0);
    RTR_CHECK_EQ_MSG(via_link.size, sizeof content,
                     "symlink size is the target's");
    RTR_CHECK_EQ_MSG(via_link.hash, rtr_hash64(content, sizeof content),
                     "hashing a symlink equals hashing its target's bytes");
}

/* A symlink whose target is a directory must be refused as a directory, not
 * opened and read as though it were a file. */
static void symlink_to_directory_is_eisdir(void) {
    char subdir[512], link[512];

    path_in(subdir, sizeof subdir, "adir");
    path_in(link, sizeof link, "dirlink");
    if (!RTR_CHECK(mkdir(subdir, 0755) == 0))
        return;
    if (!RTR_CHECK(symlink(subdir, link) == 0))
        return;

    RTR_CHECK_EQ_INT(rtr_hash_file(link).error, EISDIR);
}

/* A link pointing at nothing fails at stat with ENOENT, before any open. */
static void dangling_symlink_is_enoent(void) {
    char link[512];
    path_in(link, sizeof link, "dangling");
    if (!RTR_CHECK(symlink("/no/such/target/anywhere", link) == 0))
        return;
    RTR_CHECK_EQ_INT(rtr_hash_file(link).error, ENOENT);
}

static void a_missing_path_is_enoent(void) {
    char missing[512];
    path_in(missing, sizeof missing, "does-not-exist");
    RTR_CHECK_EQ_INT(rtr_hash_file(missing).error, ENOENT);
}

/* A file the process cannot read reports EACCES rather than a zero hash.
 * Skipped under an effective root, for whom the permission bits do not apply.
 */
static void unreadable_file_is_eacces(void) {
    char path[512];
    FILE *fp;

    if (geteuid() == 0) {
        printf("(root: skipped) ");
        return;
    }
    path_in(path, sizeof path, "secret.bin");
    fp = fopen(path, "wb");
    if (!RTR_CHECK(fp != NULL))
        return;
    RTR_CHECK(fwrite("x", 1, 1, fp) == 1);
    fclose(fp);
    if (!RTR_CHECK(chmod(path, 0) == 0))
        return;

    RTR_CHECK_EQ_INT(rtr_hash_file(path).error, EACCES);
    chmod(path, 0644); /* let the temp-dir cleanup remove it */
}

static void an_empty_file_is_the_empty_digest(void) {
    char path[512];
    FILE *fp;

    path_in(path, sizeof path, "empty.bin");
    fp = fopen(path, "wb");
    if (!RTR_CHECK(fp != NULL))
        return;
    fclose(fp);

    rtr_hash_file_result_t const r = rtr_hash_file(path);
    RTR_CHECK_EQ_INT(r.error, 0);
    RTR_CHECK_EQ_MSG(r.size, 0, "empty file has size 0");
    RTR_CHECK_EQ_MSG(r.hash, rtr_hash64(NULL, 0),
                     "empty file is the empty-input digest");
}

int main(void) {
    printf("test_file_adversarial\n");

    {
        const char *tmp = getenv("TMPDIR");
        if (tmp == NULL || tmp[0] == '\0')
            tmp = "/tmp";
        snprintf(g_dir, sizeof g_dir, "%s/rtr_file_adv_%ld", tmp,
                 (long)getpid());
        if (mkdir(g_dir, 0755) != 0 && errno != EEXIST) {
            fprintf(stderr, "test_file_adversarial: could not create %s: %s\n",
                    g_dir, strerror(errno));
            return 1;
        }
    }

    RTR_RUN(symlink_to_file_follows_to_target);
    RTR_RUN(symlink_to_directory_is_eisdir);
    RTR_RUN(dangling_symlink_is_enoent);
    RTR_RUN(a_missing_path_is_enoent);
    RTR_RUN(unreadable_file_is_eacces);
    RTR_RUN(an_empty_file_is_the_empty_digest);

    /* Best-effort cleanup; the OS reclaims the temp dir regardless. */
    {
        char cmd[600];
        snprintf(cmd, sizeof cmd, "rm -rf '%s'", g_dir);
        if (system(cmd) != 0) { /* nothing actionable if cleanup fails */
        }
    }
    return RTR_REPORT("test_file_adversarial");
}

#endif /* _WIN32 */
