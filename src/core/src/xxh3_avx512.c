/*
 * XXH3 stripe kernels, x86-64 AVX-512F.
 *
 * One 512-bit register holds the whole 64-byte stripe and all eight
 * accumulator lanes, so a run of stripes is a single register-resident loop.
 * Compiled only with -mavx512f -mavx512bw; the dispatcher gates every call on
 * cpuid plus an XCR0 check for ZMM state.
 */

#include "xxh3_internal.h"

#if RTR_ENABLE_AVX512

#include <immintrin.h>

RTR_TARGET_AVX512 void rtr_xxh3_accumulate_avx512(uint64_t *acc,
                                                  const uint8_t *input,
                                                  const uint8_t *secret,
                                                  size_t nb_stripes) {
    __m512i a = _mm512_loadu_si512((const void *)acc);

    for (size_t n = 0; n < nb_stripes; n++) {
        const uint8_t *const in = input + n * RTR_STRIPE_LEN;
        const uint8_t *const sec = secret + n * RTR_SECRET_CONSUME_RATE;
        __m512i const data_vec = _mm512_loadu_si512((const void *)in);
        __m512i const key_vec = _mm512_loadu_si512((const void *)sec);
        __m512i const data_key = _mm512_xor_si512(data_vec, key_vec);
        __m512i const data_key_hi = _mm512_srli_epi64(data_key, 32);
        __m512i const product = _mm512_mul_epu32(data_key, data_key_hi);
        __m512i const data_swap =
            _mm512_shuffle_epi32(data_vec, (_MM_PERM_ENUM)_MM_SHUFFLE(1, 0, 3, 2));

        a = _mm512_add_epi64(product, _mm512_add_epi64(a, data_swap));
    }
    _mm512_storeu_si512((void *)acc, a);
}

RTR_TARGET_AVX512 void rtr_xxh3_scramble_avx512(uint64_t *acc,
                                                const uint8_t *secret) {
    __m512i const prime32 = _mm512_set1_epi32((int)RTR_PRIME32_1);
    __m512i const acc_vec = _mm512_loadu_si512((const void *)acc);
    __m512i const shifted = _mm512_srli_epi64(acc_vec, 47);
    __m512i const data_vec = _mm512_xor_si512(acc_vec, shifted);
    __m512i const key_vec = _mm512_loadu_si512((const void *)secret);
    __m512i const data_key = _mm512_xor_si512(data_vec, key_vec);
    __m512i const data_key_hi = _mm512_srli_epi64(data_key, 32);
    __m512i const prod_lo = _mm512_mul_epu32(data_key, prime32);
    __m512i const prod_hi = _mm512_mul_epu32(data_key_hi, prime32);

    _mm512_storeu_si512((void *)acc,
                        _mm512_add_epi64(prod_lo, _mm512_slli_epi64(prod_hi, 32)));
}

#else
typedef int rtr_xxh3_avx512_translation_unit_unused;
#endif /* RTR_ENABLE_AVX512 */
