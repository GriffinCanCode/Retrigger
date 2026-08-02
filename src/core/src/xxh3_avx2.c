/*
 * XXH3 stripe kernels, x86-64 AVX2.
 *
 * This translation unit is the only one compiled with -mavx2. Nothing else in
 * the library may be, or the dispatcher itself would fault on a CPU without
 * AVX2 before it ever got the chance to choose a different level.
 */

#include "xxh3_internal.h"

#if RTR_ENABLE_AVX2

#include <immintrin.h>

RTR_TARGET_AVX2 static inline __m256i
rtr_avx2_round(__m256i acc, const uint8_t *input, const uint8_t *secret) {
    __m256i const data_vec = _mm256_loadu_si256((const __m256i *)input);
    __m256i const key_vec = _mm256_loadu_si256((const __m256i *)secret);
    __m256i const data_key = _mm256_xor_si256(data_vec, key_vec);
    __m256i const data_key_hi = _mm256_srli_epi64(data_key, 32);
    __m256i const product = _mm256_mul_epu32(data_key, data_key_hi);
    __m256i const data_swap =
        _mm256_shuffle_epi32(data_vec, _MM_SHUFFLE(1, 0, 3, 2));

    return _mm256_add_epi64(product, _mm256_add_epi64(acc, data_swap));
}

RTR_TARGET_AVX2 void rtr_xxh3_accumulate_avx2(uint64_t *acc, const uint8_t *input,
                                              const uint8_t *secret,
                                              size_t nb_stripes) {
    __m256i a0 = _mm256_loadu_si256((const __m256i *)(acc + 0));
    __m256i a1 = _mm256_loadu_si256((const __m256i *)(acc + 4));

    for (size_t n = 0; n < nb_stripes; n++) {
        const uint8_t *const in = input + n * RTR_STRIPE_LEN;
        const uint8_t *const sec = secret + n * RTR_SECRET_CONSUME_RATE;

        a0 = rtr_avx2_round(a0, in + 0, sec + 0);
        a1 = rtr_avx2_round(a1, in + 32, sec + 32);
    }
    _mm256_storeu_si256((__m256i *)(acc + 0), a0);
    _mm256_storeu_si256((__m256i *)(acc + 4), a1);
}

RTR_TARGET_AVX2 void rtr_xxh3_scramble_avx2(uint64_t *acc, const uint8_t *secret) {
    __m256i const prime32 = _mm256_set1_epi32((int)RTR_PRIME32_1);

    for (size_t i = 0; i < RTR_STRIPE_LEN / 32; i++) {
        __m256i const acc_vec = _mm256_loadu_si256((const __m256i *)(acc + i * 4));
        __m256i const shifted = _mm256_srli_epi64(acc_vec, 47);
        __m256i const data_vec = _mm256_xor_si256(acc_vec, shifted);
        __m256i const key_vec = _mm256_loadu_si256((const __m256i *)(secret + i * 32));
        __m256i const data_key = _mm256_xor_si256(data_vec, key_vec);
        __m256i const data_key_hi = _mm256_srli_epi64(data_key, 32);
        __m256i const prod_lo = _mm256_mul_epu32(data_key, prime32);
        __m256i const prod_hi = _mm256_mul_epu32(data_key_hi, prime32);

        _mm256_storeu_si256((__m256i *)(acc + i * 4),
                            _mm256_add_epi64(prod_lo, _mm256_slli_epi64(prod_hi, 32)));
    }
}

#else
typedef int rtr_xxh3_avx2_translation_unit_unused;
#endif /* RTR_ENABLE_AVX2 */
