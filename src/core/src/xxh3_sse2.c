/*
 * XXH3 stripe kernels, x86-64 SSE2 (architectural baseline for x86-64).
 * Kernels only; see xxh3_internal.h for why they own the stripe loop.
 */

#include "xxh3_internal.h"

#if RTR_ENABLE_SSE2

#include <emmintrin.h>

static inline __m128i rtr_sse2_round(__m128i acc, const uint8_t *input,
                                     const uint8_t *secret) {
    __m128i const data_vec = _mm_loadu_si128((const __m128i *)input);
    __m128i const key_vec = _mm_loadu_si128((const __m128i *)secret);
    __m128i const data_key = _mm_xor_si128(data_vec, key_vec);
    __m128i const data_key_hi = _mm_shuffle_epi32(data_key, _MM_SHUFFLE(0, 3, 0, 1));
    __m128i const product = _mm_mul_epu32(data_key, data_key_hi);
    __m128i const data_swap = _mm_shuffle_epi32(data_vec, _MM_SHUFFLE(1, 0, 3, 2));

    return _mm_add_epi64(product, _mm_add_epi64(acc, data_swap));
}

void rtr_xxh3_accumulate_sse2(uint64_t *acc, const uint8_t *input,
                              const uint8_t *secret, size_t nb_stripes) {
    __m128i a0 = _mm_loadu_si128((const __m128i *)(acc + 0));
    __m128i a1 = _mm_loadu_si128((const __m128i *)(acc + 2));
    __m128i a2 = _mm_loadu_si128((const __m128i *)(acc + 4));
    __m128i a3 = _mm_loadu_si128((const __m128i *)(acc + 6));

    for (size_t n = 0; n < nb_stripes; n++) {
        const uint8_t *const in = input + n * RTR_STRIPE_LEN;
        const uint8_t *const sec = secret + n * RTR_SECRET_CONSUME_RATE;

        a0 = rtr_sse2_round(a0, in + 0, sec + 0);
        a1 = rtr_sse2_round(a1, in + 16, sec + 16);
        a2 = rtr_sse2_round(a2, in + 32, sec + 32);
        a3 = rtr_sse2_round(a3, in + 48, sec + 48);
    }
    _mm_storeu_si128((__m128i *)(acc + 0), a0);
    _mm_storeu_si128((__m128i *)(acc + 2), a1);
    _mm_storeu_si128((__m128i *)(acc + 4), a2);
    _mm_storeu_si128((__m128i *)(acc + 6), a3);
}

void rtr_xxh3_scramble_sse2(uint64_t *acc, const uint8_t *secret) {
    __m128i const prime32 = _mm_set1_epi32((int)RTR_PRIME32_1);

    for (size_t i = 0; i < RTR_STRIPE_LEN / 16; i++) {
        __m128i const acc_vec = _mm_loadu_si128((const __m128i *)(acc + i * 2));
        __m128i const shifted = _mm_srli_epi64(acc_vec, 47);
        __m128i const data_vec = _mm_xor_si128(acc_vec, shifted);
        __m128i const key_vec = _mm_loadu_si128((const __m128i *)(secret + i * 16));
        __m128i const data_key = _mm_xor_si128(data_vec, key_vec);
        __m128i const data_key_hi = _mm_shuffle_epi32(data_key, _MM_SHUFFLE(0, 3, 0, 1));
        __m128i const prod_lo = _mm_mul_epu32(data_key, prime32);
        __m128i const prod_hi = _mm_mul_epu32(data_key_hi, prime32);

        _mm_storeu_si128((__m128i *)(acc + i * 2),
                         _mm_add_epi64(prod_lo, _mm_slli_epi64(prod_hi, 32)));
    }
}

#else
typedef int rtr_xxh3_sse2_translation_unit_unused;
#endif /* RTR_ENABLE_SSE2 */
