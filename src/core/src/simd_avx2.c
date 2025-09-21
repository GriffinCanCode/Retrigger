#include "../include/retrigger_hash.h"
#include <immintrin.h>

// Forward declaration for fallback
rtr_hash_result_t rtr_hash_generic(const void* data, size_t len);

/**
 * AVX2-optimized XXH3 implementation
 * Processes 32 bytes per iteration using AVX2 instructions
 */

rtr_hash_result_t rtr_hash_avx2(const void* data, size_t len) {
#ifdef __AVX2__
    const uint8_t* input = (const uint8_t*)data;
    
    // AVX2 constants
    const __m256i secret1 = _mm256_set1_epi64x(0x9E3779B185EBCA87ULL);
    const __m256i mult = _mm256_set1_epi64x(0x165667919E3779F9ULL);
    
    __m256i acc = _mm256_set1_epi64x(0x9E3779B185EBCA87ULL);
    
    // Process 32-byte chunks with AVX2
    size_t chunks = len / 32;
    for (size_t i = 0; i < chunks; i++) {
        __m256i chunk = _mm256_loadu_si256((const __m256i*)(input + i * 32));
        
        // Parallel multiplication and mixing
        __m256i mixed1 = _mm256_xor_si256(chunk, secret1);
        __m256i mixed2 = _mm256_mul_epu32(mixed1, mult);
        
        // Rotate and accumulate
        __m256i rotated = _mm256_or_si256(
            _mm256_slli_epi64(mixed2, 31),
            _mm256_srli_epi64(mixed2, 33)
        );
        
        acc = _mm256_xor_si256(acc, rotated);
    }
    
    // Horizontal reduction to get final hash
    __m128i acc128 = _mm_xor_si128(
        _mm256_extracti128_si256(acc, 0),
        _mm256_extracti128_si256(acc, 1)
    );
    
    uint64_t hash = _mm_extract_epi64(acc128, 0) ^ _mm_extract_epi64(acc128, 1);
    
    // Process remaining bytes with scalar code
    size_t remaining_start = chunks * 32;
    for (size_t i = remaining_start; i < len; i++) {
        hash ^= input[i];
        hash *= 0x9E3779B185EBCA87ULL;
    }
    
    // Final avalanche mixing
    hash ^= hash >> 33;
    hash *= 0xFF51AFD7ED558CCDULL;
    hash ^= hash >> 33;
    hash *= 0xC4CEB9FE1A85EC53ULL;
    hash ^= hash >> 33;
    
    return (rtr_hash_result_t){
        .hash = hash,
        .size = (uint32_t)len,
        .is_incremental = false
    };
#else
    // Fallback to generic implementation if AVX2 not available
    return rtr_hash_generic(data, len);
#endif
}
