/*
 * XXH3 stripe kernels, AArch64/ARMv7 NEON.
 *
 * Only the stripe accumulation and the scramble live here; everything else is
 * shared with xxh3_ref.c. These compute exactly the scalar result -- the lane
 * swap is a vext, and the 32x32->64 widening multiply is vmlal_u32, both of
 * which are literal transcriptions of the scalar operations rather than
 * substitutes for them. Any deviation is a bug the differential test catches.
 *
 * The eight accumulator lanes are loaded once into four q registers and stay
 * there for the whole run, which is the entire reason this function owns the
 * loop instead of being called once per stripe.
 */

#include "xxh3_internal.h"

#if RTR_ENABLE_NEON

#include <arm_neon.h>

static inline uint64x2_t rtr_neon_round(uint64x2_t acc, const uint8_t *input,
                                        const uint8_t *secret) {
    uint8x16_t const data_vec = vld1q_u8(input);
    uint8x16_t const key_vec = vld1q_u8(secret);
    uint64x2_t const data64 = vreinterpretq_u64_u8(data_vec);
    uint64x2_t const swapped = vextq_u64(data64, data64, 1);
    uint64x2_t const data_key = vreinterpretq_u64_u8(veorq_u8(data_vec, key_vec));
    uint32x2_t const lo = vmovn_u64(data_key);
    uint32x2_t const hi = vshrn_n_u64(data_key, 32);

    return vmlal_u32(vaddq_u64(acc, swapped), lo, hi);
}

void rtr_xxh3_accumulate_neon(uint64_t *acc, const uint8_t *input,
                              const uint8_t *secret, size_t nb_stripes) {
    uint64x2_t a0 = vld1q_u64(acc + 0);
    uint64x2_t a1 = vld1q_u64(acc + 2);
    uint64x2_t a2 = vld1q_u64(acc + 4);
    uint64x2_t a3 = vld1q_u64(acc + 6);

    for (size_t n = 0; n < nb_stripes; n++) {
        const uint8_t *const in = input + n * RTR_STRIPE_LEN;
        const uint8_t *const sec = secret + n * RTR_SECRET_CONSUME_RATE;

        a0 = rtr_neon_round(a0, in + 0, sec + 0);
        a1 = rtr_neon_round(a1, in + 16, sec + 16);
        a2 = rtr_neon_round(a2, in + 32, sec + 32);
        a3 = rtr_neon_round(a3, in + 48, sec + 48);
    }
    vst1q_u64(acc + 0, a0);
    vst1q_u64(acc + 2, a1);
    vst1q_u64(acc + 4, a2);
    vst1q_u64(acc + 6, a3);
}

void rtr_xxh3_scramble_neon(uint64_t *acc, const uint8_t *secret) {
    uint32x2_t const prime = vdup_n_u32(RTR_PRIME32_1);

    for (size_t i = 0; i < RTR_STRIPE_LEN / 16; i++) {
        uint64x2_t const acc_vec = vld1q_u64(acc + i * 2);
        uint64x2_t const shifted = vshrq_n_u64(acc_vec, 47);
        uint64x2_t const data_vec = veorq_u64(acc_vec, shifted);
        uint8x16_t const key_vec = vld1q_u8(secret + i * 16);
        uint64x2_t const data_key =
            veorq_u64(data_vec, vreinterpretq_u64_u8(key_vec));
        uint32x2_t const lo = vmovn_u64(data_key);
        uint32x2_t const hi = vshrn_n_u64(data_key, 32);
        /* 64x32 multiply split into two widening 32x32 halves. */
        uint64x2_t const prod_hi = vshlq_n_u64(vmull_u32(hi, prime), 32);

        vst1q_u64(acc + i * 2, vmlal_u32(prod_hi, lo, prime));
    }
}

#else
typedef int rtr_xxh3_neon_translation_unit_unused;
#endif /* RTR_ENABLE_NEON */
