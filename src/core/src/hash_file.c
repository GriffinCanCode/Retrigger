/*
 * File hashing by streaming, not by slurping.
 *
 * Peak memory is one chunk regardless of file size, so hashing a multi-GiB
 * artifact cannot take the daemon down with it, and the byte count is a
 * uint64_t so a large file reports its real size instead of a truncated one.
 * Failures surface the observed errno rather than a silent zero hash.
 */

#include "retrigger_hash.h"

#include "rtr_alloc.h"

#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>

#define RTR_FILE_CHUNK (256u * 1024u)

#if defined(_WIN32)
#define RTR_STAT_IS_DIR(m) (((m) & _S_IFDIR) != 0)
#else
#define RTR_STAT_IS_DIR(m) S_ISDIR(m)
#endif

static rtr_hash_file_result_t rtr_file_error(int err) {
    rtr_hash_file_result_t r;
    memset(&r, 0, sizeof r);
    r.error = (int32_t)err;
    return r;
}

rtr_hash_file_result_t rtr_hash_file(const char *path) {
    rtr_hash_file_result_t result;
    rtr_hash_state_t *state;
    uint8_t *chunk;
    struct stat st;
    FILE *fp;
    uint64_t total = 0;
    int failure = 0;

    memset(&result, 0, sizeof result);
    if (path == NULL) return rtr_file_error(EINVAL);

    /* Reject directories up front: on some systems opening one succeeds and
     * only the first read fails, which reports a less useful errno. */
    if (stat(path, &st) != 0) return rtr_file_error(errno ? errno : EIO);
    if (RTR_STAT_IS_DIR(st.st_mode)) return rtr_file_error(EISDIR);

    fp = fopen(path, "rb");
    if (fp == NULL) return rtr_file_error(errno ? errno : EIO);

    state = rtr_hash_create();
    chunk = (uint8_t *)RTR_MALLOC(RTR_FILE_CHUNK);
    if (state == NULL || chunk == NULL) {
        RTR_FREE(chunk);
        rtr_hash_destroy(state);
        fclose(fp);
        return rtr_file_error(ENOMEM);
    }
    /* Read straight into our chunk; stdio's own buffer would only add a copy. */
    setvbuf(fp, NULL, _IONBF, 0);

    for (;;) {
        size_t const got = fread(chunk, 1, RTR_FILE_CHUNK, fp);

        if (got > 0) {
            if (rtr_hash_update(state, chunk, got) != 0) {
                failure = EIO;
                break;
            }
            total += (uint64_t)got;
        }
        if (got < RTR_FILE_CHUNK) {
            if (ferror(fp)) failure = errno ? errno : EIO;
            break;
        }
    }

    if (failure == 0) {
        result.hash = rtr_hash_digest(state);
        result.size = total;
    } else {
        result.error = (int32_t)failure;
    }

    RTR_FREE(chunk);
    rtr_hash_destroy(state);
    fclose(fp);
    return result;
}
