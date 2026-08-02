#ifndef RETRIGGER_HASH_H
#define RETRIGGER_HASH_H

/*
 * Retrigger hashing engine: XXH3-64.
 *
 * This is the real XXH3 algorithm as specified by Yann Collet's xxHash, not a
 * lookalike. That choice is deliberate and is what makes the engine testable:
 * XXH3 has published reference vectors, so correctness is checked against an
 * external oracle rather than against our own output.
 *
 * XXH3 is defined so that every vector width computes the same value. The
 * scalar, NEON, AVX2, and AVX-512 paths here are therefore required to be
 * bit-identical, and rtr_hash_force_level exists so a single machine can prove
 * it by running one input through every path it supports.
 *
 * Dispatch is a runtime decision (see rtr_hash_cpu_level). Nothing in this
 * library may be compiled with -march=native: a binary built on one machine
 * has to run on another, and compile-time SIMD selection turns a portability
 * question into an illegal-instruction crash.
 */

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define RTR_HASH_ABI_VERSION 2u

/* ------------------------------------------------------------- dispatch */

typedef enum {
    RTR_SIMD_SCALAR = 0, /* portable C, available everywhere */
    RTR_SIMD_NEON = 1,   /* AArch64 / ARMv7 NEON             */
    RTR_SIMD_SSE2 = 2,   /* x86-64 baseline                  */
    RTR_SIMD_AVX2 = 3,   /* x86-64 AVX2                      */
    RTR_SIMD_AVX512 = 4  /* x86-64 AVX-512F                  */
} rtr_simd_level_t;

/*
 * Initialize dispatch. Idempotent and thread-safe; every entry point calls it
 * implicitly, so callers only need it to learn the selected level early.
 * Returns the level now in effect.
 */
rtr_simd_level_t rtr_hash_init(void);

/* Best level this CPU supports, determined by runtime feature detection. */
rtr_simd_level_t rtr_hash_cpu_level(void);

/* Level currently in effect (differs from cpu_level only after a force). */
rtr_simd_level_t rtr_hash_active_level(void);

/* Bitmask of usable levels: bit N set means (rtr_simd_level_t)N is available. */
uint32_t rtr_hash_available_levels(void);

/*
 * Pin dispatch to a specific level. Returns 0 on success, -1 if the level is
 * not compiled in or not supported by this CPU.
 *
 * This exists for the differential test that asserts every path agrees, and
 * for bisecting a suspected SIMD bug in the field. It is process-global and
 * not thread-safe against concurrent hashing; set it during setup, not while
 * other threads are hashing.
 */
int rtr_hash_force_level(rtr_simd_level_t level);

/* Undo rtr_hash_force_level and return to the CPU-selected level. */
void rtr_hash_reset_level(void);

/* Static, never-NULL name for a level ("scalar", "neon", "avx2", ...). */
const char *rtr_hash_level_str(rtr_simd_level_t level);

/* ------------------------------------------------------------- one-shot */

/*
 * XXH3-64 with the default secret and a zero seed.
 *
 * `(NULL, 0)` hashes as the empty input. `(NULL, len != 0)` is a caller bug --
 * there is no buffer to read -- and aborts the process rather than reading from
 * NULL or fabricating a digest of bytes that were never supplied; see
 * rtr_hash64_seed.
 */
uint64_t rtr_hash64(const void *data, size_t len);

/*
 * XXH3-64 with a caller-supplied seed.
 *
 * Contract for a NULL `data`: `len == 0` hashes as the empty input; `len != 0`
 * aborts. The streaming API (rtr_hash_update) rejects the same mistake with -1,
 * but a uint64_t return has no error channel, and returning any value would be a
 * plausible-looking fingerprint of data that does not exist -- a silent wrong
 * answer is the one outcome a content hasher must never produce.
 */
uint64_t rtr_hash64_seed(const void *data, size_t len, uint64_t seed);

/*
 * The ABI version the compiled library implements, i.e. the value of
 * RTR_HASH_ABI_VERSION at build time. A caller that links this library at run
 * time (rather than compiling against this header) can compare it against the
 * RTR_HASH_ABI_VERSION it was built with to detect a struct-layout mismatch
 * before it corrupts a read.
 */
uint32_t rtr_hash_abi_version(void);

/* ------------------------------------------------------------ streaming */

/*
 * Streaming state. Feeding a byte sequence through update() in any chunking
 * must produce exactly the digest that hashing the whole sequence at once
 * produces; the test suite asserts this against randomized chunk splits.
 */
typedef struct rtr_hash_state rtr_hash_state_t;

rtr_hash_state_t *rtr_hash_create(void);
void rtr_hash_destroy(rtr_hash_state_t *state);

/* Reset to the initial state so one allocation can hash many inputs. */
int rtr_hash_reset(rtr_hash_state_t *state, uint64_t seed);

/* Absorb another chunk. Returns 0 on success, -1 on invalid argument. */
int rtr_hash_update(rtr_hash_state_t *state, const void *data, size_t len);

/* Current digest. Non-destructive: the state may be updated further. */
uint64_t rtr_hash_digest(const rtr_hash_state_t *state);

/* ----------------------------------------------------------------- file */

typedef struct rtr_hash_file_result {
    uint64_t hash;
    uint64_t size;  /* bytes read; 64-bit so files above 4 GiB are exact */
    int32_t error;  /* 0 on success, else the errno observed             */
    int32_t reserved;
} rtr_hash_file_result_t;

/*
 * The Rust binding declares this struct by hand rather than generating it,
 * which keeps libclang off the list of things a machine needs in order to
 * build Retrigger from source. These assertions are one half of what makes
 * that safe: the C compiler proves the layout is what we claim here, and the
 * Rust side proves the same numbers independently. If either drifts, the
 * mismatch is a compile error rather than a corrupted read at runtime.
 */
_Static_assert(sizeof(rtr_hash_file_result_t) == 24, "rtr_hash_file_result_t must be 24 bytes");
_Static_assert(offsetof(rtr_hash_file_result_t, hash) == 0, "hash must be at offset 0");
_Static_assert(offsetof(rtr_hash_file_result_t, size) == 8, "size must be at offset 8");
_Static_assert(offsetof(rtr_hash_file_result_t, error) == 16, "error must be at offset 16");

/*
 * Hash a file's contents by streaming it in bounded chunks. Streaming rather
 * than reading the whole file keeps peak memory independent of file size, so
 * hashing a large artifact cannot OOM the daemon.
 */
rtr_hash_file_result_t rtr_hash_file(const char *path);

/* ------------------------------------------------------------ benchmark */

typedef struct rtr_benchmark_result {
    double throughput_mbps;
    double ns_per_byte;
    uint64_t bytes_hashed;
    uint64_t elapsed_ns;
    uint64_t checksum; /* accumulated digest, so the work cannot be optimized away */
    int32_t level;     /* rtr_simd_level_t actually exercised */
    int32_t reserved;
} rtr_benchmark_result_t;

_Static_assert(sizeof(rtr_benchmark_result_t) == 48, "rtr_benchmark_result_t must be 48 bytes");
_Static_assert(offsetof(rtr_benchmark_result_t, throughput_mbps) == 0, "throughput_mbps at 0");
_Static_assert(offsetof(rtr_benchmark_result_t, ns_per_byte) == 8, "ns_per_byte at 8");
_Static_assert(offsetof(rtr_benchmark_result_t, bytes_hashed) == 16, "bytes_hashed at 16");
_Static_assert(offsetof(rtr_benchmark_result_t, elapsed_ns) == 24, "elapsed_ns at 24");
_Static_assert(offsetof(rtr_benchmark_result_t, checksum) == 32, "checksum at 32");
_Static_assert(offsetof(rtr_benchmark_result_t, level) == 40, "level at 40");

/* The C enum must be a plain int for the Rust declaration to match. */
_Static_assert(sizeof(rtr_simd_level_t) == sizeof(int), "rtr_simd_level_t must be int-sized");

/* Largest `test_size` rtr_hash_benchmark will accept, in bytes. */
#define RTR_BENCH_MAX_SIZE (1024u * 1024u * 1024u)

/*
 * Measure throughput over `test_size` bytes for `iterations` passes. Returns a
 * measurement of real work; `checksum` is folded from every pass specifically
 * so the compiler cannot elide the loop and report a fictional number.
 *
 * Total by construction: no argument can crash or abort the process. A zero
 * `test_size` or `iterations`, a `test_size` above RTR_BENCH_MAX_SIZE, or an
 * allocation that fails all return a result with `bytes_hashed == 0`, which is
 * how a caller distinguishes "no measurement" from a measurement. The size is
 * capped rather than handed to the allocator because an absurd request aborts
 * under glibc and under AddressSanitizer instead of returning NULL, and the
 * caller is often a scripting language whose numbers are not to be trusted.
 */
rtr_benchmark_result_t rtr_hash_benchmark(size_t test_size, uint32_t iterations);

#ifdef __cplusplus
}
#endif

#endif /* RETRIGGER_HASH_H */
