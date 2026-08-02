/*
 * XXH3-64: portable scalar reference implementation and the shared engine.
 *
 * This file is normative. Every SIMD level runs this exact code and differs
 * only in the accumulate/scramble_acc kernel passed in, which is why the
 * differential test can assert bit-identical output across levels rather than
 * hoping for it.
 *
 * Algorithm per the xxHash specification (Yann Collet, BSD-2-Clause):
 * https://github.com/Cyan4973/xxHash/blob/dev/doc/xxhash_spec.md
 * Length classes 0, 1-3, 4-8, 9-16, 17-128, 129-240 and the >240 long path
 * with its 1024-byte block scramble are all present; nothing is approximated.
 *
 * All input reads go through memcpy-based little-endian loads, so the file is
 * correct on big-endian targets and never performs an unaligned access that
 * the compiler has not been told about.
 */

#include "xxh3_internal.h"

/* ------------------------------------------------------------ kSecret */

const uint8_t rtr_xxh3_ksecret[RTR_SECRET_DEFAULT_SIZE] = {
    0xb8, 0xfe, 0x6c, 0x39, 0x23, 0xa4, 0x4b, 0xbe, 0x7c, 0x01, 0x81, 0x2c,
    0xf7, 0x21, 0xad, 0x1c, 0xde, 0xd4, 0x6d, 0xe9, 0x83, 0x90, 0x97, 0xdb,
    0x72, 0x40, 0xa4, 0xa4, 0xb7, 0xb3, 0x67, 0x1f, 0xcb, 0x79, 0xe6, 0x4e,
    0xcc, 0xc0, 0xe5, 0x78, 0x82, 0x5a, 0xd0, 0x7d, 0xcc, 0xff, 0x72, 0x21,
    0xb8, 0x08, 0x46, 0x74, 0xf7, 0x43, 0x24, 0x8e, 0xe0, 0x35, 0x90, 0xe6,
    0x81, 0x3a, 0x26, 0x4c, 0x3c, 0x28, 0x52, 0xbb, 0x91, 0xc3, 0x00, 0xcb,
    0x88, 0xd0, 0x65, 0x8b, 0x1b, 0x53, 0x2e, 0xa3, 0x71, 0x64, 0x48, 0x97,
    0xa2, 0x0d, 0xf9, 0x4e, 0x38, 0x19, 0xef, 0x46, 0xa9, 0xde, 0xac, 0xd8,
    0xa8, 0xfa, 0x76, 0x3f, 0xe3, 0x9c, 0x34, 0x3f, 0xf9, 0xdc, 0xbb, 0xc7,
    0xc7, 0x0b, 0x4f, 0x1d, 0x8a, 0x51, 0xe0, 0x4b, 0xcd, 0xb4, 0x59, 0x31,
    0xc8, 0x9f, 0x7e, 0xc9, 0xd9, 0x78, 0x73, 0x64, 0xea, 0xc5, 0xac, 0x83,
    0x34, 0xd3, 0xeb, 0xc3, 0xc5, 0x81, 0xa0, 0xff, 0xfa, 0x13, 0x63, 0xeb,
    0x17, 0x0d, 0xdd, 0x51, 0xb7, 0xf0, 0xda, 0x49, 0xd3, 0x16, 0x55, 0x26,
    0x29, 0xd4, 0x68, 0x9e, 0x2b, 0x16, 0xbe, 0x58, 0x7d, 0x47, 0xa1, 0xfc,
    0x8f, 0xf8, 0xb8, 0xd1, 0x7a, 0xd0, 0x31, 0xce, 0x45, 0xcb, 0x3a, 0x8f,
    0x95, 0x16, 0x04, 0x28, 0xaf, 0xd7, 0xfb, 0xca, 0xbb, 0x4b, 0x40, 0x7e,
};

/* ------------------------------------------------------------ helpers */

#if defined(__BYTE_ORDER__) && defined(__ORDER_BIG_ENDIAN__) && \
    __BYTE_ORDER__ == __ORDER_BIG_ENDIAN__
#define RTR_BIG_ENDIAN 1
#endif

static inline uint32_t rtr_read32le(const uint8_t *p) {
    uint32_t v;
    memcpy(&v, p, sizeof v);
#ifdef RTR_BIG_ENDIAN
    v = __builtin_bswap32(v);
#endif
    return v;
}

static inline uint64_t rtr_read64le(const uint8_t *p) {
    uint64_t v;
    memcpy(&v, p, sizeof v);
#ifdef RTR_BIG_ENDIAN
    v = __builtin_bswap64(v);
#endif
    return v;
}

static inline void rtr_write64le(uint8_t *p, uint64_t v) {
#ifdef RTR_BIG_ENDIAN
    v = __builtin_bswap64(v);
#endif
    memcpy(p, &v, sizeof v);
}

static inline uint32_t rtr_swap32(uint32_t v) { return __builtin_bswap32(v); }
static inline uint64_t rtr_swap64(uint64_t v) { return __builtin_bswap64(v); }

static inline uint64_t rtr_rotl64(uint64_t v, unsigned r) {
    return (v << r) | (v >> (64 - r));
}

static inline uint64_t rtr_mult32to64(uint64_t a, uint64_t b) {
    return (uint64_t)(uint32_t)a * (uint64_t)(uint32_t)b;
}

/* low64 ^ high64 of the 128-bit product: the folding step XXH3 leans on. */
static inline uint64_t rtr_mul128_fold64(uint64_t a, uint64_t b) {
#if defined(__SIZEOF_INT128__)
    __uint128_t const product = (__uint128_t)a * (__uint128_t)b;
    return (uint64_t)product ^ (uint64_t)(product >> 64);
#else
    uint64_t const lo_lo = rtr_mult32to64(a & 0xFFFFFFFF, b & 0xFFFFFFFF);
    uint64_t const hi_lo = rtr_mult32to64(a >> 32, b & 0xFFFFFFFF);
    uint64_t const lo_hi = rtr_mult32to64(a & 0xFFFFFFFF, b >> 32);
    uint64_t const hi_hi = rtr_mult32to64(a >> 32, b >> 32);
    uint64_t const cross = (lo_lo >> 32) + (hi_lo & 0xFFFFFFFF) + lo_hi;
    uint64_t const upper = (hi_lo >> 32) + (cross >> 32) + hi_hi;
    uint64_t const lower = (cross << 32) | (lo_lo & 0xFFFFFFFF);
    return lower ^ upper;
#endif
}

static inline uint64_t rtr_xorshift64(uint64_t v, unsigned shift) {
    return v ^ (v >> shift);
}

static inline uint64_t rtr_avalanche(uint64_t h) {
    h = rtr_xorshift64(h, 37);
    h *= 0x165667919E3779F9ULL;
    return rtr_xorshift64(h, 32);
}

static inline uint64_t rtr_xxh64_avalanche(uint64_t h) {
    h ^= h >> 33;
    h *= RTR_PRIME64_2;
    h ^= h >> 29;
    h *= RTR_PRIME64_3;
    h ^= h >> 32;
    return h;
}

static inline uint64_t rtr_rrmxmx(uint64_t h, uint64_t len) {
    h ^= rtr_rotl64(h, 49) ^ rtr_rotl64(h, 24);
    h *= 0x9FB21C651E98DF25ULL;
    h ^= (h >> 35) + len;
    h *= 0x9FB21C651E98DF25ULL;
    return rtr_xorshift64(h, 28);
}

/* ------------------------------------------------------ scalar kernel */

void rtr_xxh3_accumulate_scalar(uint64_t *acc, const uint8_t *input,
                                const uint8_t *secret, size_t nb_stripes) {
    uint64_t a[RTR_ACC_NB];

    memcpy(a, acc, sizeof a); /* hold the lanes in registers across stripes */
    for (size_t n = 0; n < nb_stripes; n++) {
        const uint8_t *const in = input + n * RTR_STRIPE_LEN;
        const uint8_t *const sec = secret + n * RTR_SECRET_CONSUME_RATE;

        for (size_t i = 0; i < RTR_ACC_NB; i++) {
            uint64_t const data_val = rtr_read64le(in + 8 * i);
            uint64_t const data_key = data_val ^ rtr_read64le(sec + 8 * i);
            a[i ^ 1] += data_val; /* the adjacent-lane swap */
            a[i] += rtr_mult32to64(data_key & 0xFFFFFFFF, data_key >> 32);
        }
    }
    memcpy(acc, a, sizeof a);
}

void rtr_xxh3_scramble_scalar(uint64_t *acc, const uint8_t *secret) {
    for (size_t i = 0; i < RTR_ACC_NB; i++) {
        uint64_t const key64 = rtr_read64le(secret + 8 * i);
        uint64_t v = rtr_xorshift64(acc[i], 47);
        v ^= key64;
        v *= RTR_PRIME32_1;
        acc[i] = v;
    }
}

/* --------------------------------------------------------- short paths */

static uint64_t rtr_len_1to3(const uint8_t *input, size_t len,
                             const uint8_t *secret, uint64_t seed) {
    uint8_t const c1 = input[0];
    uint8_t const c2 = input[len >> 1];
    uint8_t const c3 = input[len - 1];
    uint32_t const combined = ((uint32_t)c1 << 16) | ((uint32_t)c2 << 24) |
                              ((uint32_t)c3 << 0) | ((uint32_t)len << 8);
    uint64_t const bitflip =
        (uint64_t)(rtr_read32le(secret) ^ rtr_read32le(secret + 4)) + seed;
    return rtr_xxh64_avalanche((uint64_t)combined ^ bitflip);
}

static uint64_t rtr_len_4to8(const uint8_t *input, size_t len,
                             const uint8_t *secret, uint64_t seed) {
    seed ^= (uint64_t)rtr_swap32((uint32_t)seed) << 32;
    {
        uint32_t const input1 = rtr_read32le(input);
        uint32_t const input2 = rtr_read32le(input + len - 4);
        uint64_t const bitflip =
            (rtr_read64le(secret + 8) ^ rtr_read64le(secret + 16)) - seed;
        uint64_t const input64 = input2 + ((uint64_t)input1 << 32);
        return rtr_rrmxmx(input64 ^ bitflip, len);
    }
}

static uint64_t rtr_len_9to16(const uint8_t *input, size_t len,
                              const uint8_t *secret, uint64_t seed) {
    uint64_t const bitflip1 =
        (rtr_read64le(secret + 24) ^ rtr_read64le(secret + 32)) + seed;
    uint64_t const bitflip2 =
        (rtr_read64le(secret + 40) ^ rtr_read64le(secret + 48)) - seed;
    uint64_t const input_lo = rtr_read64le(input) ^ bitflip1;
    uint64_t const input_hi = rtr_read64le(input + len - 8) ^ bitflip2;
    uint64_t const acc = (uint64_t)len + rtr_swap64(input_lo) + input_hi +
                         rtr_mul128_fold64(input_lo, input_hi);
    return rtr_avalanche(acc);
}

static uint64_t rtr_len_0to16(const uint8_t *input, size_t len,
                              const uint8_t *secret, uint64_t seed) {
    if (len > 8) return rtr_len_9to16(input, len, secret, seed);
    if (len >= 4) return rtr_len_4to8(input, len, secret, seed);
    if (len) return rtr_len_1to3(input, len, secret, seed);
    return rtr_xxh64_avalanche(
        seed ^ (rtr_read64le(secret + 56) ^ rtr_read64le(secret + 64)));
}

static inline uint64_t rtr_mix16b(const uint8_t *input, const uint8_t *secret,
                                  uint64_t seed) {
    uint64_t const input_lo = rtr_read64le(input);
    uint64_t const input_hi = rtr_read64le(input + 8);
    return rtr_mul128_fold64(input_lo ^ (rtr_read64le(secret) + seed),
                             input_hi ^ (rtr_read64le(secret + 8) - seed));
}

static uint64_t rtr_len_17to128(const uint8_t *input, size_t len,
                                const uint8_t *secret, uint64_t seed) {
    uint64_t acc = (uint64_t)len * RTR_PRIME64_1;
    if (len > 32) {
        if (len > 64) {
            if (len > 96) {
                acc += rtr_mix16b(input + 48, secret + 96, seed);
                acc += rtr_mix16b(input + len - 64, secret + 112, seed);
            }
            acc += rtr_mix16b(input + 32, secret + 64, seed);
            acc += rtr_mix16b(input + len - 48, secret + 80, seed);
        }
        acc += rtr_mix16b(input + 16, secret + 32, seed);
        acc += rtr_mix16b(input + len - 32, secret + 48, seed);
    }
    acc += rtr_mix16b(input + 0, secret + 0, seed);
    acc += rtr_mix16b(input + len - 16, secret + 16, seed);
    return rtr_avalanche(acc);
}

static uint64_t rtr_len_129to240(const uint8_t *input, size_t len,
                                 const uint8_t *secret, uint64_t seed) {
    uint64_t acc = (uint64_t)len * RTR_PRIME64_1;
    uint64_t acc_end;
    size_t const nb_rounds = len / 16;
    size_t i;

    for (i = 0; i < 8; i++) acc += rtr_mix16b(input + 16 * i, secret + 16 * i, seed);
    acc_end = rtr_mix16b(input + len - 16,
                         secret + RTR_SECRET_SIZE_MIN - RTR_MIDSIZE_LASTOFFSET,
                         seed);
    acc = rtr_avalanche(acc);
    for (i = 8; i < nb_rounds; i++) {
        acc_end += rtr_mix16b(input + 16 * i,
                              secret + 16 * (i - 8) + RTR_MIDSIZE_STARTOFFSET,
                              seed);
    }
    return rtr_avalanche(acc + acc_end);
}

/* ---------------------------------------------------------- long path */

static const uint64_t rtr_init_acc[RTR_ACC_NB] = {
    RTR_PRIME32_3, RTR_PRIME64_1, RTR_PRIME64_2, RTR_PRIME64_3,
    RTR_PRIME64_4, RTR_PRIME32_2, RTR_PRIME64_5, RTR_PRIME32_1,
};

static inline void rtr_accumulate(uint64_t *acc, const uint8_t *input,
                                  const uint8_t *secret, size_t nb_stripes,
                                  const rtr_xxh3_kernel_t *k) {
    k->accumulate(acc, input, secret, nb_stripes);
}

static inline uint64_t rtr_mix2accs(const uint64_t *acc, const uint8_t *secret) {
    return rtr_mul128_fold64(acc[0] ^ rtr_read64le(secret),
                             acc[1] ^ rtr_read64le(secret + 8));
}

static uint64_t rtr_merge_accs(const uint64_t *acc, const uint8_t *secret,
                               uint64_t start) {
    uint64_t result = start;
    for (size_t i = 0; i < 4; i++) result += rtr_mix2accs(acc + 2 * i, secret + 16 * i);
    return rtr_avalanche(result);
}

static void rtr_hash_long_loop(uint64_t *acc, const uint8_t *input, size_t len,
                               const uint8_t *secret, size_t secret_size,
                               const rtr_xxh3_kernel_t *k) {
    size_t const nb_stripes_per_block =
        (secret_size - RTR_STRIPE_LEN) / RTR_SECRET_CONSUME_RATE;
    size_t const block_len = RTR_STRIPE_LEN * nb_stripes_per_block;
    size_t const nb_blocks = (len - 1) / block_len;

    for (size_t n = 0; n < nb_blocks; n++) {
        rtr_accumulate(acc, input + n * block_len, secret, nb_stripes_per_block, k);
        k->scramble_acc(acc, secret + secret_size - RTR_STRIPE_LEN);
    }

    {
        size_t const nb_stripes =
            ((len - 1) - (block_len * nb_blocks)) / RTR_STRIPE_LEN;
        rtr_accumulate(acc, input + nb_blocks * block_len, secret, nb_stripes, k);
    }
    /* The trailing stripe always covers the final 64 bytes, overlapping if need be. */
    k->accumulate(acc, input + len - RTR_STRIPE_LEN,
                  secret + secret_size - RTR_STRIPE_LEN - RTR_SECRET_LASTACC_START,
                  1);
}

static void rtr_init_custom_secret(uint8_t *custom_secret, uint64_t seed) {
    for (size_t i = 0; i < RTR_SECRET_DEFAULT_SIZE / 16; i++) {
        uint64_t const lo = rtr_read64le(rtr_xxh3_ksecret + 16 * i) + seed;
        uint64_t const hi = rtr_read64le(rtr_xxh3_ksecret + 16 * i + 8) - seed;
        rtr_write64le(custom_secret + 16 * i, lo);
        rtr_write64le(custom_secret + 16 * i + 8, hi);
    }
}

static uint64_t rtr_hash_long(const uint8_t *input, size_t len,
                              const uint8_t *secret, size_t secret_size,
                              const rtr_xxh3_kernel_t *k) {
#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L
    _Alignas(64)
#endif
    uint64_t acc[RTR_ACC_NB];

    memcpy(acc, rtr_init_acc, sizeof acc);
    rtr_hash_long_loop(acc, input, len, secret, secret_size, k);
    return rtr_merge_accs(acc, secret + RTR_SECRET_MERGEACCS_START,
                          (uint64_t)len * RTR_PRIME64_1);
}

/* -------------------------------------------------------- entry point */

uint64_t rtr_xxh3_64(const void *data, size_t len, uint64_t seed,
                     const rtr_xxh3_kernel_t *k) {
    const uint8_t *const input = (const uint8_t *)data;
    const uint8_t *const secret = rtr_xxh3_ksecret;

    if (len <= 16) return rtr_len_0to16(input, len, secret, seed);
    if (len <= 128) return rtr_len_17to128(input, len, secret, seed);
    if (len <= RTR_MIDSIZE_MAX) return rtr_len_129to240(input, len, secret, seed);

    if (seed == 0)
        return rtr_hash_long(input, len, secret, RTR_SECRET_DEFAULT_SIZE, k);
    {
        uint8_t custom_secret[RTR_SECRET_DEFAULT_SIZE];
        rtr_init_custom_secret(custom_secret, seed);
        return rtr_hash_long(input, len, custom_secret, RTR_SECRET_DEFAULT_SIZE, k);
    }
}

/* ----------------------------------------------------------- streaming */

void rtr_xxh3_state_reset(struct rtr_hash_state *st, uint64_t seed) {
    memset(st, 0, sizeof *st);
    memcpy(st->acc, rtr_init_acc, sizeof st->acc);
    st->seed = seed;
    st->use_seed = (seed != 0);
    st->secret_limit = RTR_SECRET_DEFAULT_SIZE - RTR_STRIPE_LEN;
    st->nb_stripes_per_block = st->secret_limit / RTR_SECRET_CONSUME_RATE;
    if (seed == 0)
        memcpy(st->custom_secret, rtr_xxh3_ksecret, RTR_SECRET_DEFAULT_SIZE);
    else
        rtr_init_custom_secret(st->custom_secret, seed);
}

/*
 * Absorb whole stripes, inserting a scramble whenever the secret block is
 * exhausted. nb_stripes_so_far is the position inside that block and is the
 * only thing that makes a chunked feed indistinguishable from a one-shot one.
 */
static void rtr_consume_stripes(uint64_t *acc, size_t *nb_stripes_so_far,
                                size_t nb_stripes_per_block,
                                const uint8_t *input, size_t nb_stripes,
                                const uint8_t *secret, size_t secret_limit,
                                const rtr_xxh3_kernel_t *k) {
    if (nb_stripes_per_block - *nb_stripes_so_far <= nb_stripes) {
        size_t const to_end = nb_stripes_per_block - *nb_stripes_so_far;
        size_t const after_block = nb_stripes - to_end;
        rtr_accumulate(acc, input,
                       secret + *nb_stripes_so_far * RTR_SECRET_CONSUME_RATE,
                       to_end, k);
        k->scramble_acc(acc, secret + secret_limit);
        rtr_accumulate(acc, input + to_end * RTR_STRIPE_LEN, secret, after_block, k);
        *nb_stripes_so_far = after_block;
    } else {
        rtr_accumulate(acc, input,
                       secret + *nb_stripes_so_far * RTR_SECRET_CONSUME_RATE,
                       nb_stripes, k);
        *nb_stripes_so_far += nb_stripes;
    }
}

#define RTR_INTERNALBUFFER_STRIPES (RTR_INTERNALBUFFER_SIZE / RTR_STRIPE_LEN)

void rtr_xxh3_state_update(struct rtr_hash_state *st, const uint8_t *input,
                           size_t len, const rtr_xxh3_kernel_t *k) {
    const uint8_t *const b_end = input + len;
    const uint8_t *const secret = st->custom_secret;

    st->total_len += len;

    if (st->buffered_size + len <= RTR_INTERNALBUFFER_SIZE) {
        memcpy(st->buffer + st->buffered_size, input, len);
        st->buffered_size += (uint32_t)len;
        return;
    }

    if (st->buffered_size) {
        size_t const load_size = RTR_INTERNALBUFFER_SIZE - st->buffered_size;
        memcpy(st->buffer + st->buffered_size, input, load_size);
        input += load_size;
        rtr_consume_stripes(st->acc, &st->nb_stripes_so_far,
                            st->nb_stripes_per_block, st->buffer,
                            RTR_INTERNALBUFFER_STRIPES, secret,
                            st->secret_limit, k);
        st->buffered_size = 0;
    }

    if ((size_t)(b_end - input) > st->nb_stripes_per_block * RTR_STRIPE_LEN) {
        size_t nb_stripes = (size_t)(b_end - 1 - input) / RTR_STRIPE_LEN;
        {
            size_t const to_end = st->nb_stripes_per_block - st->nb_stripes_so_far;
            rtr_accumulate(st->acc, input,
                           secret + st->nb_stripes_so_far * RTR_SECRET_CONSUME_RATE,
                           to_end, k);
            k->scramble_acc(st->acc, secret + st->secret_limit);
            st->nb_stripes_so_far = 0;
            input += to_end * RTR_STRIPE_LEN;
            nb_stripes -= to_end;
        }
        while (nb_stripes >= st->nb_stripes_per_block) {
            rtr_accumulate(st->acc, input, secret, st->nb_stripes_per_block, k);
            k->scramble_acc(st->acc, secret + st->secret_limit);
            input += st->nb_stripes_per_block * RTR_STRIPE_LEN;
            nb_stripes -= st->nb_stripes_per_block;
        }
        rtr_accumulate(st->acc, input, secret, nb_stripes, k);
        input += nb_stripes * RTR_STRIPE_LEN;
        st->nb_stripes_so_far = nb_stripes;
        /* Keep the stripe before the tail: digest may need it to back-fill. */
        memcpy(st->buffer + sizeof st->buffer - RTR_STRIPE_LEN,
               input - RTR_STRIPE_LEN, RTR_STRIPE_LEN);
    } else if ((size_t)(b_end - input) > RTR_INTERNALBUFFER_SIZE) {
        const uint8_t *const limit = b_end - RTR_INTERNALBUFFER_SIZE;
        do {
            rtr_consume_stripes(st->acc, &st->nb_stripes_so_far,
                                st->nb_stripes_per_block, input,
                                RTR_INTERNALBUFFER_STRIPES, secret,
                                st->secret_limit, k);
            input += RTR_INTERNALBUFFER_SIZE;
        } while (input < limit);
        memcpy(st->buffer + sizeof st->buffer - RTR_STRIPE_LEN,
               input - RTR_STRIPE_LEN, RTR_STRIPE_LEN);
    }

    memcpy(st->buffer, input, (size_t)(b_end - input));
    st->buffered_size = (uint32_t)(b_end - input);
}

/* Digests a copy of the accumulator, leaving the state usable afterwards. */
static void rtr_digest_long(uint64_t *acc, const struct rtr_hash_state *st,
                            const uint8_t *secret, const rtr_xxh3_kernel_t *k) {
    memcpy(acc, st->acc, RTR_ACC_NB * sizeof(uint64_t));
    if (st->buffered_size >= RTR_STRIPE_LEN) {
        size_t const nb_stripes = (st->buffered_size - 1) / RTR_STRIPE_LEN;
        size_t nb_stripes_so_far = st->nb_stripes_so_far;
        rtr_consume_stripes(acc, &nb_stripes_so_far, st->nb_stripes_per_block,
                            st->buffer, nb_stripes, secret, st->secret_limit, k);
        k->accumulate(acc, st->buffer + st->buffered_size - RTR_STRIPE_LEN,
                      secret + st->secret_limit - RTR_SECRET_LASTACC_START, 1);
    } else {
        /* Fewer than 64 bytes buffered: rebuild the last stripe from the tail
         * of the previous one, which update() deliberately kept. */
        uint8_t last_stripe[RTR_STRIPE_LEN];
        size_t const catchup = RTR_STRIPE_LEN - st->buffered_size;
        memcpy(last_stripe, st->buffer + sizeof st->buffer - catchup, catchup);
        memcpy(last_stripe + catchup, st->buffer, st->buffered_size);
        k->accumulate(acc, last_stripe,
                      secret + st->secret_limit - RTR_SECRET_LASTACC_START, 1);
    }
}

uint64_t rtr_xxh3_state_digest(const struct rtr_hash_state *st,
                               const rtr_xxh3_kernel_t *k) {
    const uint8_t *const secret = st->custom_secret;

    if (st->total_len > RTR_MIDSIZE_MAX) {
#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L
        _Alignas(64)
#endif
        uint64_t acc[RTR_ACC_NB];
        rtr_digest_long(acc, st, secret, k);
        return rtr_merge_accs(acc, secret + RTR_SECRET_MERGEACCS_START,
                              st->total_len * RTR_PRIME64_1);
    }
    /* Short total: everything ever fed is still in the buffer verbatim. */
    return rtr_xxh3_64(st->buffer, (size_t)st->total_len, st->seed, k);
}
