/*
 * Internal contract between the XXH3-64 engine and its vector kernels.
 *
 * XXH3 is specified so that every vector width computes the same digest. That
 * property only survives if the widths share everything except the 64-byte
 * stripe accumulation, so this header draws the line exactly there: a kernel
 * supplies accumulate_512 and scramble_acc and nothing else. Length dispatch,
 * secret derivation, the streaming buffer and the final merge live once, in
 * xxh3_ref.c, and are used verbatim by every level.
 *
 * Not a public header. Nothing here is part of the ABI.
 */

#ifndef RTR_XXH3_INTERNAL_H
#define RTR_XXH3_INTERNAL_H

#include <stddef.h>
#include <stdint.h>
#include <string.h>

/* ----------------------------------------------------- spec constants */

#define RTR_SECRET_DEFAULT_SIZE 192u
#define RTR_SECRET_SIZE_MIN 136u
#define RTR_STRIPE_LEN 64u
#define RTR_ACC_NB 8u
#define RTR_SECRET_CONSUME_RATE 8u
#define RTR_SECRET_LASTACC_START 7u
#define RTR_SECRET_MERGEACCS_START 11u
#define RTR_MIDSIZE_MAX 240u
#define RTR_MIDSIZE_STARTOFFSET 3u
#define RTR_MIDSIZE_LASTOFFSET 17u
#define RTR_INTERNALBUFFER_SIZE 256u

#define RTR_PRIME32_1 0x9E3779B1u
#define RTR_PRIME32_2 0x85EBCA77u
#define RTR_PRIME32_3 0xC2B2AE3Du
#define RTR_PRIME64_1 0x9E3779B185EBCA87ULL
#define RTR_PRIME64_2 0xC2B2AE3D27D4EB4FULL
#define RTR_PRIME64_3 0x165667B19E3779F9ULL
#define RTR_PRIME64_4 0x85EBCA77C2B2AE63ULL
#define RTR_PRIME64_5 0x27D4EB2F165667C5ULL

/* The 192-byte default secret, kSecret, from the xxHash specification. */
extern const uint8_t rtr_xxh3_ksecret[RTR_SECRET_DEFAULT_SIZE];

/* ------------------------------------------------------------ kernels */

/*
 * A kernel absorbs `nb_stripes` consecutive 64-byte stripes into the eight
 * accumulators, advancing the secret by 8 bytes per stripe, and scrambles the
 * accumulators against a secret block.
 *
 * The stripe *loop* is inside the kernel on purpose. With one call per stripe
 * the accumulators have to be spilled to memory and reloaded every 64 bytes
 * across a non-inlinable indirect call, which costs more than the vector unit
 * saves -- measurably so: moving the loop in here took NEON from 14.6 GiB/s to
 * 32 GiB/s on an M-series core, and turned NEON from slower than scalar into
 * faster. Owning the loop lets a kernel keep all eight lanes in registers for
 * its whole run. A single stripe is just nb_stripes == 1.
 *
 * acc is 8 x uint64_t. input and secret may be unaligned; kernels must
 * therefore use unaligned loads.
 */
typedef void (*rtr_accumulate_fn)(uint64_t *acc, const uint8_t *input,
                                  const uint8_t *secret, size_t nb_stripes);
typedef void (*rtr_scramble_fn)(uint64_t *acc, const uint8_t *secret);

typedef struct rtr_xxh3_kernel {
    rtr_accumulate_fn accumulate;
    rtr_scramble_fn scramble_acc;
} rtr_xxh3_kernel_t;

/* Portable kernel. Always compiled, always available, normative. */
void rtr_xxh3_accumulate_scalar(uint64_t *acc, const uint8_t *input,
                                const uint8_t *secret, size_t nb_stripes);
void rtr_xxh3_scramble_scalar(uint64_t *acc, const uint8_t *secret);

/*
 * Vector kernels. Each lives in its own translation unit, and RTR_ENABLE_<ISA>
 * says whether that unit is part of this build. The default is "whatever the
 * target architecture can host", so compiling every .c file with no special
 * flags does the right thing; a build system that cannot produce one of them
 * (an assembler too old for AVX-512, say) defines the corresponding macro to 0
 * and the dispatcher stops referencing symbols that will not exist.
 */
#ifndef RTR_ENABLE_NEON
#if defined(__aarch64__) || defined(_M_ARM64) || defined(__ARM_NEON)
#define RTR_ENABLE_NEON 1
#else
#define RTR_ENABLE_NEON 0
#endif
#endif

#if defined(__x86_64__) || defined(_M_X64)
#define RTR_X86_TARGET 1
#else
#define RTR_X86_TARGET 0
#endif

#ifndef RTR_ENABLE_SSE2
#define RTR_ENABLE_SSE2 RTR_X86_TARGET
#endif
#ifndef RTR_ENABLE_AVX2
#define RTR_ENABLE_AVX2 RTR_X86_TARGET
#endif
#ifndef RTR_ENABLE_AVX512
#define RTR_ENABLE_AVX512 RTR_X86_TARGET
#endif

#if RTR_ENABLE_NEON
void rtr_xxh3_accumulate_neon(uint64_t *acc, const uint8_t *input,
                              const uint8_t *secret, size_t nb_stripes);
void rtr_xxh3_scramble_neon(uint64_t *acc, const uint8_t *secret);
#endif
#if RTR_ENABLE_SSE2
void rtr_xxh3_accumulate_sse2(uint64_t *acc, const uint8_t *input,
                              const uint8_t *secret, size_t nb_stripes);
void rtr_xxh3_scramble_sse2(uint64_t *acc, const uint8_t *secret);
#endif
#if RTR_ENABLE_AVX2
void rtr_xxh3_accumulate_avx2(uint64_t *acc, const uint8_t *input,
                              const uint8_t *secret, size_t nb_stripes);
void rtr_xxh3_scramble_avx2(uint64_t *acc, const uint8_t *secret);
#endif
#if RTR_ENABLE_AVX512
void rtr_xxh3_accumulate_avx512(uint64_t *acc, const uint8_t *input,
                                const uint8_t *secret, size_t nb_stripes);
void rtr_xxh3_scramble_avx512(uint64_t *acc, const uint8_t *secret);
#endif

/*
 * If the build system did not hand this unit its ISA flag -- cc-rs and other
 * "one flag set for every file" drivers do not -- ask for it per function.
 * With the flag already present these expand to nothing.
 */
#if defined(__GNUC__) || defined(__clang__)
#define RTR_TARGET(isa) __attribute__((target(isa)))
#else
#define RTR_TARGET(isa)
#endif

#ifdef __AVX2__
#define RTR_TARGET_AVX2
#else
#define RTR_TARGET_AVX2 RTR_TARGET("avx2")
#endif

#if defined(__AVX512F__) && defined(__AVX512BW__)
#define RTR_TARGET_AVX512
#else
#define RTR_TARGET_AVX512 RTR_TARGET("avx512f,avx512bw")
#endif

/* ------------------------------------------------------- shared engine */

uint64_t rtr_xxh3_64(const void *data, size_t len, uint64_t seed,
                     const rtr_xxh3_kernel_t *k);

/*
 * Streaming state. Layout mirrors the reference streaming design: a 256-byte
 * staging buffer, the running accumulator, and the position within the current
 * 1024-byte secret block, which is what lets an arbitrary chunk split land on
 * exactly the digest a one-shot hash would produce.
 */
struct rtr_hash_state {
    uint64_t acc[RTR_ACC_NB];
    uint8_t custom_secret[RTR_SECRET_DEFAULT_SIZE];
    uint8_t buffer[RTR_INTERNALBUFFER_SIZE];
    uint32_t buffered_size;
    uint32_t use_seed;
    size_t nb_stripes_so_far;
    size_t nb_stripes_per_block;
    size_t secret_limit;
    uint64_t total_len;
    uint64_t seed;
};

void rtr_xxh3_state_reset(struct rtr_hash_state *st, uint64_t seed);
void rtr_xxh3_state_update(struct rtr_hash_state *st, const uint8_t *input,
                           size_t len, const rtr_xxh3_kernel_t *k);
uint64_t rtr_xxh3_state_digest(const struct rtr_hash_state *st,
                               const rtr_xxh3_kernel_t *k);

#endif /* RTR_XXH3_INTERNAL_H */
