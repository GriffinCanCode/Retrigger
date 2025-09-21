#ifndef RETRIGGER_HASH_H
#define RETRIGGER_HASH_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Retrigger Core Hashing Engine
 * High-performance XXH3-based hashing with SIMD optimizations
 * Follows SRP: Single responsibility for hash computation
 */

// Hash result structure for type safety and extensibility
typedef struct {
    uint64_t hash;
    uint32_t size;
    bool is_incremental;
} rtr_hash_result_t;

// Incremental hasher context for block-based hashing
typedef struct rtr_hasher {
    void* internal_state;
    uint32_t block_size;
    uint64_t total_size;
} rtr_hasher_t;

// SIMD optimization levels detected at runtime
typedef enum {
    RTR_SIMD_NONE = 0,
    RTR_SIMD_NEON = 1,     // ARM NEON
    RTR_SIMD_AVX2 = 2,     // x86-64 AVX2
    RTR_SIMD_AVX512 = 3    // x86-64 AVX-512
} rtr_simd_level_t;

// Core hashing interface - follows Interface Segregation Principle
typedef struct {
    rtr_hash_result_t (*hash_buffer)(const void* data, size_t len);
    rtr_hash_result_t (*hash_file)(const char* filepath);
    rtr_hasher_t* (*create_incremental)(uint32_t block_size);
    rtr_hash_result_t (*update_incremental)(rtr_hasher_t* hasher, const void* data, size_t len);
    rtr_hash_result_t (*finalize_incremental)(rtr_hasher_t* hasher);
    void (*destroy_incremental)(rtr_hasher_t* hasher);
} rtr_hash_interface_t;

// Initialize the hashing engine with optimal SIMD level
rtr_simd_level_t rtr_hash_init(void);

// Get the singleton hash interface (Dependency Inversion Principle)
const rtr_hash_interface_t* rtr_hash_get_interface(void);

// CPU feature detection
rtr_simd_level_t rtr_detect_simd_support(void);

// Performance benchmarking utilities
typedef struct {
    double throughput_mbps;
    uint64_t cycles_per_byte;
    uint32_t latency_ns;
} rtr_benchmark_result_t;

rtr_benchmark_result_t rtr_benchmark_hash(size_t test_size);

#ifdef __cplusplus
}
#endif

#endif // RETRIGGER_HASH_H
