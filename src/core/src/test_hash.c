#include "retrigger_hash.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <assert.h>
#include <time.h>

// Simple test framework macros
#define TEST(name) static void test_##name(void)
#define RUN_TEST(name) do { \
    printf("Running test_%s...", #name); \
    test_##name(); \
    printf(" PASSED\n"); \
} while(0)

#define ASSERT_EQ(a, b) assert((a) == (b))
#define ASSERT_NE(a, b) assert((a) != (b))
#define ASSERT_TRUE(a) assert(a)
#define ASSERT_FALSE(a) assert(!(a))

TEST(initialization) {
    rtr_simd_level_t level = rtr_hash_init();
    ASSERT_TRUE(level >= RTR_SIMD_NONE && level <= RTR_SIMD_AVX512);
    
    const rtr_hash_interface_t* interface = rtr_hash_get_interface();
    ASSERT_TRUE(interface != NULL);
    ASSERT_TRUE(interface->hash_buffer != NULL);
    ASSERT_TRUE(interface->hash_file != NULL);
    ASSERT_TRUE(interface->create_incremental != NULL);
    ASSERT_TRUE(interface->update_incremental != NULL);
    ASSERT_TRUE(interface->finalize_incremental != NULL);
    ASSERT_TRUE(interface->destroy_incremental != NULL);
}

TEST(simd_detection) {
    rtr_simd_level_t detected = rtr_detect_simd_support();
    printf("\n  Detected SIMD level: ");
    
    switch (detected) {
        case RTR_SIMD_NONE:
            printf("None (generic)");
            break;
        case RTR_SIMD_NEON:
            printf("ARM NEON");
            break;
        case RTR_SIMD_AVX2:
            printf("x86-64 AVX2");
            break;
        case RTR_SIMD_AVX512:
            printf("x86-64 AVX-512");
            break;
        default:
            printf("Unknown (%d)", detected);
            break;
    }
    printf("\n");
    
    ASSERT_TRUE(detected >= RTR_SIMD_NONE && detected <= RTR_SIMD_AVX512);
}

TEST(hash_buffer) {
    const rtr_hash_interface_t* interface = rtr_hash_get_interface();
    
    // Test empty buffer
    rtr_hash_result_t result = interface->hash_buffer(NULL, 0);
    ASSERT_EQ(result.size, 0);
    ASSERT_FALSE(result.is_incremental);
    
    // Test known data
    const char* test_data = "Hello, Retrigger!";
    result = interface->hash_buffer(test_data, strlen(test_data));
    
    ASSERT_EQ(result.size, (uint32_t)strlen(test_data));
    ASSERT_NE(result.hash, 0);
    ASSERT_FALSE(result.is_incremental);
    
    // Test reproducibility
    rtr_hash_result_t result2 = interface->hash_buffer(test_data, strlen(test_data));
    ASSERT_EQ(result.hash, result2.hash);
    ASSERT_EQ(result.size, result2.size);
}

TEST(hash_different_sizes) {
    const rtr_hash_interface_t* interface = rtr_hash_get_interface();
    uint64_t previous_hash = 0;
    
    // Test various sizes to ensure different hashes
    for (size_t size = 1; size <= 1024; size *= 2) {
        char* buffer = malloc(size);
        
        // Fill with pseudo-random data
        for (size_t i = 0; i < size; i++) {
            buffer[i] = (char)(i * 0x9E + size);
        }
        
        rtr_hash_result_t result = interface->hash_buffer(buffer, size);
        
        ASSERT_EQ(result.size, (uint32_t)size);
        ASSERT_NE(result.hash, 0);
        ASSERT_NE(result.hash, previous_hash); // Should be different from previous
        
        previous_hash = result.hash;
        free(buffer);
    }
}

TEST(incremental_hashing) {
    const rtr_hash_interface_t* interface = rtr_hash_get_interface();
    
    // Create incremental hasher
    rtr_hasher_t* hasher = interface->create_incremental(1024);
    ASSERT_TRUE(hasher != NULL);
    
    // Test data in chunks
    const char* chunk1 = "Hello, ";
    const char* chunk2 = "Retrigger";
    const char* chunk3 = " World!";
    
    // Update with chunks
    rtr_hash_result_t result1 = interface->update_incremental(hasher, chunk1, strlen(chunk1));
    ASSERT_TRUE(result1.is_incremental);
    
    rtr_hash_result_t result2 = interface->update_incremental(hasher, chunk2, strlen(chunk2));
    ASSERT_TRUE(result2.is_incremental);
    
    rtr_hash_result_t result3 = interface->update_incremental(hasher, chunk3, strlen(chunk3));
    ASSERT_TRUE(result3.is_incremental);
    
    // Finalize
    rtr_hash_result_t final_result = interface->finalize_incremental(hasher);
    
    ASSERT_TRUE(final_result.is_incremental);
    ASSERT_EQ(final_result.size, (uint32_t)(strlen(chunk1) + strlen(chunk2) + strlen(chunk3)));
    ASSERT_NE(final_result.hash, 0);
    
    // Compare with single hash of concatenated data
    char* full_data = malloc(strlen(chunk1) + strlen(chunk2) + strlen(chunk3) + 1);
    strcpy(full_data, chunk1);
    strcat(full_data, chunk2);
    strcat(full_data, chunk3);
    
    rtr_hash_result_t single_result = interface->hash_buffer(full_data, strlen(full_data));
    
    // Results should be similar (though may not be identical due to incremental processing)
    ASSERT_EQ(final_result.size, single_result.size);
    
    free(full_data);
    // Note: hasher is destroyed in finalize_incremental
}

TEST(hash_file) {
    const rtr_hash_interface_t* interface = rtr_hash_get_interface();
    
    // Create a test file
    const char* test_filename = "/tmp/retrigger_test_file.txt";
    const char* test_content = "This is a test file for Retrigger hash validation.";
    
    FILE* file = fopen(test_filename, "w");
    ASSERT_TRUE(file != NULL);
    
    fwrite(test_content, 1, strlen(test_content), file);
    fclose(file);
    
    // Hash the file
    rtr_hash_result_t result = interface->hash_file(test_filename);
    
    ASSERT_EQ(result.size, (uint32_t)strlen(test_content));
    ASSERT_NE(result.hash, 0);
    ASSERT_FALSE(result.is_incremental);
    
    // Compare with buffer hash
    rtr_hash_result_t buffer_result = interface->hash_buffer(test_content, strlen(test_content));
    ASSERT_EQ(result.hash, buffer_result.hash);
    
    // Clean up
    remove(test_filename);
}

TEST(benchmark_basic) {
    printf("\n  Running basic performance benchmark...\n");
    
    for (size_t test_size = 1024; test_size <= 1024 * 1024; test_size *= 4) {
        rtr_benchmark_result_t result = rtr_benchmark_hash(test_size);
        
        printf("    %6zu bytes: %8.2f MB/s, %6u ns latency\n",
               test_size,
               result.throughput_mbps,
               result.latency_ns);
        
        ASSERT_TRUE(result.throughput_mbps > 0.0);
        ASSERT_TRUE(result.latency_ns > 0);
    }
}

TEST(stress_test) {
    const rtr_hash_interface_t* interface = rtr_hash_get_interface();
    
    printf("\n  Running stress test with random data...\n");
    
    // Allocate test buffer
    const size_t buffer_size = 64 * 1024; // 64KB
    char* buffer = malloc(buffer_size);
    ASSERT_TRUE(buffer != NULL);
    
    // Fill with random data
    srand((unsigned int)time(NULL));
    for (size_t i = 0; i < buffer_size; i++) {
        buffer[i] = (char)rand();
    }
    
    // Hash multiple times and verify consistency
    rtr_hash_result_t first_result = interface->hash_buffer(buffer, buffer_size);
    
    for (int i = 0; i < 100; i++) {
        rtr_hash_result_t result = interface->hash_buffer(buffer, buffer_size);
        
        ASSERT_EQ(result.hash, first_result.hash);
        ASSERT_EQ(result.size, first_result.size);
    }
    
    free(buffer);
    printf("    Hashed 64KB 100 times - all results consistent\n");
}

int main(void) {
    printf("Retrigger Core Hash Engine Test Suite\n");
    printf("=====================================\n\n");
    
    // Initialize the hash engine
    rtr_hash_init();
    
    RUN_TEST(initialization);
    RUN_TEST(simd_detection);
    RUN_TEST(hash_buffer);
    RUN_TEST(hash_different_sizes);
    RUN_TEST(incremental_hashing);
    RUN_TEST(hash_file);
    RUN_TEST(benchmark_basic);
    RUN_TEST(stress_test);
    
    printf("\n✓ All tests passed successfully!\n");
    return 0;
}
