/*
 * libFuzzer entry point for the file path: rtr_hash_file.
 *
 * fuzz_hash.c covers the pure computation, which takes a pointer and a length
 * the caller already validated. This one covers the code around it -- the
 * allocation, the fread loop, the partial-chunk exit, the error unwinding -- by
 * putting the fuzzer's bytes on disk and hashing them back.
 *
 * The oracle needs no expected value: hashing a file must return exactly what
 * hashing the same bytes in memory returns, and the reported size must be the
 * number of bytes written. A disagreement is the bug report.
 *
 * The interesting inputs are the ones near the 256 KiB read chunk, where the
 * loop's partial-read exit lives, and libFuzzer will not reach 256 KiB from an
 * 8 KiB -max_len. So the input is also used to *derive* a length that straddles
 * the boundary, and the fixture is filled by repeating the input. That keeps the
 * boundary reachable while leaving the byte values under the fuzzer's control.
 */

#include "retrigger_hash.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
#include <process.h>
#define rtr_getpid _getpid
#else
#include <unistd.h>
#define rtr_getpid getpid
#endif

#define RTR_CHUNK (256u * 1024u)

/* One chunk either side of the boundary, so every loop exit is reachable. */
#define RTR_MAX_FIXTURE (RTR_CHUNK + 4096u)

static const char *fixture_path(void) {
    static char path[512];

    if (path[0] == '\0') {
        const char *tmp = getenv("TMPDIR");

        if (tmp == NULL || tmp[0] == '\0') tmp = "/tmp";
        snprintf(path, sizeof path, "%s/rtr_fuzz_file_%d.bin", tmp, (int)rtr_getpid());
    }
    return path;
}

/*
 * Lengths worth trying, derived from the input so the fuzzer steers them.
 *
 * Each is clamped into the fixture buffer, and 0 is included deliberately: an
 * empty file has a defined digest and used to be the case that regressed.
 */
static size_t derive_length(const uint8_t *data, size_t size, unsigned which) {
    uint32_t selector = size == 0 ? 0 : data[size - 1];

    switch (which) {
        case 0: return size;
        case 1: return 0;
        case 2: return RTR_CHUNK - 1u;
        case 3: return RTR_CHUNK;
        case 4: return RTR_CHUNK + 1u;
        /* Somewhere arbitrary but reproducible, so the space between the
         * boundaries is not left entirely unvisited. */
        default: return (size_t)(selector * 1024u) % (RTR_MAX_FIXTURE + 1u);
    }
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size);

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
    uint8_t *fixture = (uint8_t *)malloc(RTR_MAX_FIXTURE);

    if (fixture == NULL) return 0;

    /* Fill by repeating the input, so a short input still produces a long file
     * whose contents the fuzzer chose. A zero-length input gives a zero fill,
     * which is a legitimate case in its own right. */
    if (size == 0) {
        memset(fixture, 0, RTR_MAX_FIXTURE);
    } else {
        for (size_t off = 0; off < RTR_MAX_FIXTURE; off += size) {
            size_t const n = size < RTR_MAX_FIXTURE - off ? size : RTR_MAX_FIXTURE - off;
            memcpy(fixture + off, data, n);
        }
    }

    for (unsigned which = 0; which < 6; which++) {
        size_t len = derive_length(data, size, which);
        rtr_hash_file_result_t result;
        FILE *fp;

        if (len > RTR_MAX_FIXTURE) len = RTR_MAX_FIXTURE;

        fp = fopen(fixture_path(), "wb");
        if (fp == NULL) break; /* no writable temp dir: nothing to assert */
        if (len != 0 && fwrite(fixture, 1, len, fp) != len) {
            fclose(fp);
            break;
        }
        fclose(fp);

        result = rtr_hash_file(fixture_path());
        if (result.error != 0) {
            fprintf(stderr, "rtr_hash_file failed with errno %d on %zu bytes\n",
                    (int)result.error, len);
            abort();
        }
        if (result.size != (uint64_t)len) {
            fprintf(stderr, "size mismatch: reported %llu, wrote %zu\n",
                    (unsigned long long)result.size, len);
            abort();
        }
        if (result.hash != rtr_hash64(fixture, len)) {
            fprintf(stderr, "file digest disagrees with memory digest on %zu bytes\n", len);
            abort();
        }
    }

    remove(fixture_path());
    free(fixture);
    return 0;
}
