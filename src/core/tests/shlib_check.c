/*
 * Shared-library load and symbol smoke test.
 *
 * The rest of the suite links the static archive, so nothing else proves the
 * shipped .so/.dylib actually loads and exports its public API. A visibility
 * regression, a broken SONAME, or an unresolved internal reference would pass
 * every other test and only fail a downstream consumer. This dlopen()s the
 * shared library with RTLD_NOW -- forcing every relocation to resolve up front
 * -- looks up each public symbol, and calls a couple to confirm they compute
 * the documented values and that the library's ABI version matches this
 * build's.
 *
 * Not named test_*.c on purpose: it needs -ldl and the library path, so it has
 * its own Makefile target (`make test-shared`) rather than joining the archive-
 * linked suite. On Windows it is a no-op that still compiles.
 */

#include "retrigger_hash.h"

#include <stdio.h>
#include <string.h>

#if defined(_WIN32)

int main(void) {
    printf("shlib_check: skipped (no dlopen on this platform)\n");
    return 0;
}

#else

#include <dlfcn.h>

#ifndef RTR_SHARED_LIB
#error "RTR_SHARED_LIB must be defined with the path to the shared library"
#endif

static int failures;

static void *need(void *lib, const char *sym) {
    void *p = dlsym(lib, sym);
    if (p == NULL) {
        fprintf(stderr, "  MISSING symbol: %s\n", sym);
        failures++;
    }
    return p;
}

int main(void) {
    printf("shlib_check (%s)\n", RTR_SHARED_LIB);

    void *lib = dlopen(RTR_SHARED_LIB, RTLD_NOW | RTLD_LOCAL);
    if (lib == NULL) {
        fprintf(stderr, "  dlopen failed: %s\n", dlerror());
        return 1;
    }

    /* Every symbol a consumer links against must resolve. */
    static const char *const api[] = {
        "rtr_hash64",
        "rtr_hash64_seed",
        "rtr_hash_abi_version",
        "rtr_hash_file",
        "rtr_hash_create",
        "rtr_hash_destroy",
        "rtr_hash_reset",
        "rtr_hash_update",
        "rtr_hash_digest",
        "rtr_hash_init",
        "rtr_hash_cpu_level",
        "rtr_hash_active_level",
        "rtr_hash_available_levels",
        "rtr_hash_force_level",
        "rtr_hash_reset_level",
        "rtr_hash_level_str",
    };
    for (size_t i = 0; i < sizeof api / sizeof api[0]; i++)
        need(lib, api[i]);

    /* Resolve two through function pointers and confirm they behave. Casting
     * the void* from dlsym to a function pointer is a POSIX-sanctioned
     * extension; it warns only under -Wpedantic, which the library build does
     * not enable. */
    uint64_t (*hash64)(const void *, size_t) =
        (uint64_t (*)(const void *, size_t))need(lib, "rtr_hash64");
    uint32_t (*abi)(void) =
        (uint32_t (*)(void))need(lib, "rtr_hash_abi_version");

    if (hash64 != NULL) {
        uint64_t const empty = hash64(NULL, 0);
        if (empty != 0x2D06800538D394C2ULL) {
            fprintf(stderr, "  empty digest wrong: got 0x%016llX\n",
                    (unsigned long long)empty);
            failures++;
        }
    }
    if (abi != NULL && abi() != RTR_HASH_ABI_VERSION) {
        fprintf(stderr, "  ABI mismatch: library %u, header %u\n", abi(),
                (unsigned)RTR_HASH_ABI_VERSION);
        failures++;
    }

    dlclose(lib);
    if (failures == 0) {
        printf("shlib_check: all public symbols resolved and answered "
               "correctly\n");
        return 0;
    }
    printf("shlib_check: %d failure(s)\n", failures);
    return 1;
}

#endif /* _WIN32 */
