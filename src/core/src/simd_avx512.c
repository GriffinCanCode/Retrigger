#include "../include/retrigger_hash.h"
#include <immintrin.h>

// Forward declaration for fallback
rtr_hash_result_t rtr_hash_generic(const void* data, size_t len);

/**
 * AVX-512 optimized XXH3 implementation
 * Processes 64 bytes per iteration using AVX-512 instructions
 */

rtr_hash_result_t rtr_hash_avx512(const void* data, size_t len) {
#ifdef __AVX512F__
    const uint8_t* input = (const uint8_t*)data;
    
    // AVX-512 constants
    const __m512i secret1 = _mm512_set1_epi64(0x9E3779B185EBCA87ULL);
    const __m512i secret2 = _mm512_set1_epi64(0xC2B2AE3D27D4EB4FULL);
    const __m512i mult = _mm512_set1_epi64(0x165667919E3779F9ULL);
    
    __m512i acc = _mm512_set1_epi64(0x9E3779B185EBCA87ULL);
    
    // Process 64-byte chunks with AVX-512 (optimized for throughput)
    size_t chunks = len / 64;
    
    // Use multiple accumulators to maximize instruction-level parallelism
    __m512i acc0 = acc;
    __m512i acc1 = _mm512_set1_epi64(0xC2B2AE3D27D4EB4FULL);
    
    for (size_t i = 0; i < chunks; i++) {
        __m512i chunk = _mm512_loadu_si512((const __m512i*)(input + i * 64));
        
        // Interleave operations to maximize pipeline utilization
        __m512i mixed1 = _mm512_xor_si512(chunk, secret1);
        __m512i mixed2 = _mm512_xor_si512(chunk, secret2);
        
        // Use more efficient multiplication and rotation pattern
        __m512i mul1 = _mm512_mullo_epi64(mixed1, mult);
        __m512i mul2 = _mm512_mullo_epi64(mixed2, secret1);
        
        // Optimized rotation using rol instruction if available
        __m512i rot1 = _mm512_rol_epi64(mul1, 31);
        __m512i rot2 = _mm512_rol_epi64(mul2, 17);
        
        // Alternate between accumulators to reduce data dependencies
        acc0 = _mm512_xor_si512(acc0, rot1);
        acc1 = _mm512_xor_si512(acc1, rot2);
    }
    
    // Combine accumulators
    acc = _mm512_xor_si512(acc0, acc1);
    
    // Horizontal reduction - AVX-512 to scalar
    uint64_t hash = _mm512_reduce_xor_epi64(acc);
    
    // Process remaining bytes
    size_t remaining_start = chunks * 64;
    for (size_t i = remaining_start; i < len; i++) {
        hash ^= input[i];
        hash *= 0x9E3779B185EBCA87ULL;
    }
    
    // Final mixing
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
    // Fallback to generic implementation if AVX512 not available
    return rtr_hash_generic(data, len);
#endif
}
