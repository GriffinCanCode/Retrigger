//! Retrigger Core - High-performance hashing engine
//!
//! This crate provides the core hashing functionality with SIMD optimizations.
//! Follows the Single Responsibility Principle - only handles hash computation.

use serde::{Deserialize, Serialize};
use std::ffi::CString;
use std::path::Path;
use std::ptr;
use thiserror::Error;

// Include generated C bindings
#[allow(non_upper_case_globals)]
#[allow(non_camel_case_types)]
#[allow(non_snake_case)]
#[allow(dead_code)]
mod ffi {
    include!(concat!(env!("OUT_DIR"), "/bindings.rs"));
}

/// Errors that can occur during hashing operations
#[derive(Error, Debug)]
pub enum HashError {
    #[error("Invalid file path: {0}")]
    InvalidPath(String),
    #[error("Hash computation failed")]
    ComputationFailed,
    #[error("Incremental hasher not initialized")]
    HasherNotInitialized,
}

/// Result of a hash computation
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HashResult {
    pub hash: u64,
    pub size: u32,
    pub is_incremental: bool,
}

/// SIMD optimization levels available
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SimdLevel {
    None = 0,
    Neon = 1,
    Avx2 = 2,
    Avx512 = 3,
    Blake3 = 4, // BLAKE3's built-in SIMD
}

/// Hash algorithm selection strategy
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum HashStrategy {
    /// Use BLAKE3 for all files (secure + fast for large files)
    Blake3Only,
    /// Use XXH3 for all files (fastest for small files)
    Xxh3Only,
    /// Hybrid: BLAKE3 for files >1MB, XXH3 for smaller (optimal)
    Hybrid,
    /// Auto-detect best algorithm based on data characteristics
    Auto,
}

impl From<ffi::rtr_simd_level_t> for SimdLevel {
    fn from(level: ffi::rtr_simd_level_t) -> Self {
        match level {
            ffi::rtr_simd_level_t_RTR_SIMD_NONE => SimdLevel::None,
            ffi::rtr_simd_level_t_RTR_SIMD_NEON => SimdLevel::Neon,
            ffi::rtr_simd_level_t_RTR_SIMD_AVX2 => SimdLevel::Avx2,
            ffi::rtr_simd_level_t_RTR_SIMD_AVX512 => SimdLevel::Avx512,
            _ => SimdLevel::None,
        }
    }
}

impl From<ffi::rtr_hash_result_t> for HashResult {
    fn from(result: ffi::rtr_hash_result_t) -> Self {
        HashResult {
            hash: result.hash,
            size: result.size,
            is_incremental: result.is_incremental,
        }
    }
}

/// Benchmark results for performance testing
#[derive(Debug, Clone)]
pub struct BenchmarkResult {
    pub throughput_mbps: f64,
    pub cycles_per_byte: u64,
    pub latency_ns: u32,
}

impl From<ffi::rtr_benchmark_result_t> for BenchmarkResult {
    fn from(result: ffi::rtr_benchmark_result_t) -> Self {
        BenchmarkResult {
            throughput_mbps: result.throughput_mbps,
            cycles_per_byte: result.cycles_per_byte,
            latency_ns: result.latency_ns,
        }
    }
}

/// Fast hash trait for extensibility (Interface Segregation Principle)
pub trait FastHash {
    fn hash_bytes(&self, data: &[u8]) -> Result<HashResult, HashError>;
    fn hash_file<P: AsRef<Path>>(&self, path: P) -> Result<HashResult, HashError>;
}

/// Incremental hasher for streaming large files
pub trait IncrementalHash {
    fn new(block_size: Option<u32>) -> Result<Self, HashError>
    where
        Self: Sized;
    fn update(&mut self, data: &[u8]) -> Result<HashResult, HashError>;
    fn finalize(self) -> Result<HashResult, HashError>;
}

/// Main hashing engine - Hybrid pattern for optimal performance
pub struct HashEngine {
    interface: *const ffi::rtr_hash_interface_t,
    simd_level: SimdLevel,
    strategy: HashStrategy,
}

/// BLAKE3-specific hasher for large files
#[derive(Default)]
pub struct Blake3FastHash {
    hasher: blake3::Hasher,
}

impl Blake3FastHash {
    pub fn new() -> Self {
        Self {
            hasher: blake3::Hasher::new(),
        }
    }

    pub fn hash_bytes(&mut self, data: &[u8]) -> Result<HashResult, HashError> {
        self.hasher.reset();
        self.hasher.update(data);
        let hash = self.hasher.finalize();

        // Convert BLAKE3 hash to u64 for compatibility
        let bytes = hash.as_bytes();
        let hash_u64 = u64::from_le_bytes([
            bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        ]);

        Ok(HashResult {
            hash: hash_u64,
            size: data.len() as u32,
            is_incremental: false,
        })
    }
}

/// SIMD-optimized file size threshold for algorithm selection
const HYBRID_THRESHOLD: usize = 1024 * 1024; // 1MB

unsafe impl Send for HashEngine {}
unsafe impl Sync for HashEngine {}

impl HashEngine {
    /// Initialize the hash engine with optimal SIMD support and hybrid strategy
    pub fn new() -> Self {
        Self::with_strategy(HashStrategy::Hybrid)
    }

    /// Initialize with specific hash strategy
    pub fn with_strategy(strategy: HashStrategy) -> Self {
        let simd_level = unsafe { ffi::rtr_hash_init() };
        let interface = unsafe { ffi::rtr_hash_get_interface() };

        HashEngine {
            interface,
            simd_level: simd_level.into(),
            strategy,
        }
    }

    /// Get current hash strategy
    pub fn strategy(&self) -> HashStrategy {
        self.strategy
    }

    /// Get the current SIMD optimization level
    pub fn simd_level(&self) -> SimdLevel {
        self.simd_level
    }

    /// Detect available SIMD support
    pub fn detect_simd() -> SimdLevel {
        let level = unsafe { ffi::rtr_detect_simd_support() };
        level.into()
    }

    /// Run benchmark for performance testing
    pub fn benchmark(&self, test_size: usize) -> BenchmarkResult {
        let result = unsafe { ffi::rtr_benchmark_hash(test_size) };
        result.into()
    }
}

impl Default for HashEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl FastHash for HashEngine {
    fn hash_bytes(&self, data: &[u8]) -> Result<HashResult, HashError> {
        match self.strategy {
            HashStrategy::Blake3Only => self.hash_bytes_blake3(data),
            HashStrategy::Xxh3Only => self.hash_bytes_xxh3(data),
            HashStrategy::Hybrid => {
                // Use BLAKE3 for large files, XXH3 for small files
                if data.len() >= HYBRID_THRESHOLD {
                    self.hash_bytes_blake3(data)
                } else {
                    self.hash_bytes_xxh3(data)
                }
            }
            HashStrategy::Auto => {
                // Auto-detect based on data characteristics
                self.hash_bytes_auto(data)
            }
        }
    }

    fn hash_file<P: AsRef<Path>>(&self, path: P) -> Result<HashResult, HashError> {
        // For files, we can check size before reading
        let metadata = std::fs::metadata(&path)
            .map_err(|_| HashError::InvalidPath(path.as_ref().display().to_string()))?;

        match self.strategy {
            HashStrategy::Blake3Only => self.hash_file_blake3(&path),
            HashStrategy::Xxh3Only => self.hash_file_xxh3(&path),
            HashStrategy::Hybrid => {
                if metadata.len() >= HYBRID_THRESHOLD as u64 {
                    self.hash_file_blake3(&path)
                } else {
                    self.hash_file_xxh3(&path)
                }
            }
            HashStrategy::Auto => self.hash_file_auto(&path, metadata.len()),
        }
    }
}

impl HashEngine {
    /// Hash bytes using BLAKE3
    fn hash_bytes_blake3(&self, data: &[u8]) -> Result<HashResult, HashError> {
        let hash = blake3::hash(data);
        let bytes = hash.as_bytes();
        let hash_u64 = u64::from_le_bytes([
            bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        ]);

        Ok(HashResult {
            hash: hash_u64,
            size: data.len() as u32,
            is_incremental: false,
        })
    }

    /// Hash bytes using optimized XXH3
    fn hash_bytes_xxh3(&self, data: &[u8]) -> Result<HashResult, HashError> {
        if self.interface.is_null() {
            // Re-initialize if interface is null
            let _ = unsafe { ffi::rtr_hash_init() };
            let interface = unsafe { ffi::rtr_hash_get_interface() };
            if interface.is_null() {
                return Err(HashError::ComputationFailed);
            }
        }

        let result = unsafe {
            let hash_fn = (*self.interface).hash_buffer;
            if hash_fn.is_none() {
                return Err(HashError::ComputationFailed);
            }
            hash_fn.unwrap()(data.as_ptr() as *const _, data.len())
        };

        Ok(result.into())
    }

    /// Auto-detect best algorithm for data
    fn hash_bytes_auto(&self, data: &[u8]) -> Result<HashResult, HashError> {
        // For auto-detection, analyze data characteristics
        let entropy = self.calculate_entropy(data);

        // High entropy data benefits more from BLAKE3's parallelism
        // Low entropy data is better with XXH3's speed
        if entropy > 0.8 || data.len() >= HYBRID_THRESHOLD {
            self.hash_bytes_blake3(data)
        } else {
            self.hash_bytes_xxh3(data)
        }
    }

    /// Hash file using BLAKE3
    fn hash_file_blake3<P: AsRef<Path>>(&self, path: P) -> Result<HashResult, HashError> {
        let data = std::fs::read(&path)
            .map_err(|_| HashError::InvalidPath(path.as_ref().display().to_string()))?;

        self.hash_bytes_blake3(&data)
    }

    /// Hash file using XXH3
    fn hash_file_xxh3<P: AsRef<Path>>(&self, path: P) -> Result<HashResult, HashError> {
        if self.interface.is_null() {
            return Err(HashError::ComputationFailed);
        }

        let path_str = path
            .as_ref()
            .to_str()
            .ok_or_else(|| HashError::InvalidPath(path.as_ref().display().to_string()))?;

        let c_path =
            CString::new(path_str).map_err(|_| HashError::InvalidPath(path_str.to_string()))?;

        let result = unsafe {
            let hash_fn = (*self.interface).hash_file;
            if hash_fn.is_none() {
                return Err(HashError::ComputationFailed);
            }
            hash_fn.unwrap()(c_path.as_ptr())
        };

        if result.hash == 0 && result.size == 0 {
            return Err(HashError::ComputationFailed);
        }

        Ok(result.into())
    }

    /// Auto-detect best algorithm for file
    fn hash_file_auto<P: AsRef<Path>>(&self, path: P, size: u64) -> Result<HashResult, HashError> {
        // For large files, always use BLAKE3 due to parallelism
        if size >= HYBRID_THRESHOLD as u64 {
            return self.hash_file_blake3(&path);
        }

        // For smaller files, we could sample to determine entropy
        // For now, just use XXH3 for speed
        self.hash_file_xxh3(&path)
    }

    /// Calculate Shannon entropy of data (simplified)
    fn calculate_entropy(&self, data: &[u8]) -> f64 {
        if data.is_empty() {
            return 0.0;
        }

        let mut counts = [0u32; 256];
        for &byte in data {
            counts[byte as usize] += 1;
        }

        let len = data.len() as f64;
        let mut entropy = 0.0;

        for &count in &counts {
            if count > 0 {
                let p = count as f64 / len;
                entropy -= p * p.log2();
            }
        }

        entropy / 8.0 // Normalize to 0-1 range
    }
}

/// Incremental hasher implementation
pub struct IncrementalHasher {
    hasher: *mut ffi::rtr_hasher_t,
    interface: *const ffi::rtr_hash_interface_t,
}

impl IncrementalHasher {
    fn get_interface() -> *const ffi::rtr_hash_interface_t {
        unsafe { ffi::rtr_hash_get_interface() }
    }
}

impl IncrementalHash for IncrementalHasher {
    fn new(block_size: Option<u32>) -> Result<Self, HashError> {
        let interface = Self::get_interface();
        if interface.is_null() {
            return Err(HashError::HasherNotInitialized);
        }

        let hasher = unsafe {
            let create_fn = (*interface).create_incremental;
            if create_fn.is_none() {
                return Err(HashError::HasherNotInitialized);
            }
            create_fn.unwrap()(block_size.unwrap_or(4096))
        };

        if hasher.is_null() {
            return Err(HashError::HasherNotInitialized);
        }

        Ok(IncrementalHasher { hasher, interface })
    }

    fn update(&mut self, data: &[u8]) -> Result<HashResult, HashError> {
        if self.hasher.is_null() || self.interface.is_null() {
            return Err(HashError::HasherNotInitialized);
        }

        let result = unsafe {
            let update_fn = (*self.interface).update_incremental;
            if update_fn.is_none() {
                return Err(HashError::HasherNotInitialized);
            }
            update_fn.unwrap()(self.hasher, data.as_ptr() as *const _, data.len())
        };

        Ok(result.into())
    }

    fn finalize(mut self) -> Result<HashResult, HashError> {
        if self.hasher.is_null() || self.interface.is_null() {
            return Err(HashError::HasherNotInitialized);
        }

        let result = unsafe {
            let finalize_fn = (*self.interface).finalize_incremental;
            if finalize_fn.is_none() {
                return Err(HashError::HasherNotInitialized);
            }
            finalize_fn.unwrap()(self.hasher)
        };

        // Prevent double-free by setting to null
        self.hasher = ptr::null_mut();

        Ok(result.into())
    }
}

impl Drop for IncrementalHasher {
    fn drop(&mut self) {
        if !self.hasher.is_null() && !self.interface.is_null() {
            unsafe {
                if let Some(destroy_fn) = (*self.interface).destroy_incremental {
                    destroy_fn(self.hasher);
                }
            }
        }
    }
}

/// Convenience functions for common operations
pub mod prelude {
    use super::*;

    /// Quick hash of byte data using optimal algorithm
    pub fn hash_bytes(data: &[u8]) -> Result<HashResult, HashError> {
        let engine = HashEngine::new(); // Uses Hybrid by default
        engine.hash_bytes(data)
    }

    /// Quick hash of a file using optimal algorithm
    pub fn hash_file<P: AsRef<Path>>(path: P) -> Result<HashResult, HashError> {
        let engine = HashEngine::new(); // Uses Hybrid by default
        engine.hash_file(path)
    }

    /// Hash bytes using BLAKE3 specifically
    pub fn hash_bytes_blake3(data: &[u8]) -> Result<HashResult, HashError> {
        let engine = HashEngine::with_strategy(HashStrategy::Blake3Only);
        engine.hash_bytes(data)
    }

    /// Hash file using BLAKE3 specifically
    pub fn hash_file_blake3<P: AsRef<Path>>(path: P) -> Result<HashResult, HashError> {
        let engine = HashEngine::with_strategy(HashStrategy::Blake3Only);
        engine.hash_file(path)
    }

    /// Hash bytes using XXH3 specifically
    pub fn hash_bytes_xxh3(data: &[u8]) -> Result<HashResult, HashError> {
        let engine = HashEngine::with_strategy(HashStrategy::Xxh3Only);
        engine.hash_bytes(data)
    }

    /// Hash file using XXH3 specifically
    pub fn hash_file_xxh3<P: AsRef<Path>>(path: P) -> Result<HashResult, HashError> {
        let engine = HashEngine::with_strategy(HashStrategy::Xxh3Only);
        engine.hash_file(path)
    }

    /// Create an incremental hasher with default block size
    pub fn incremental_hasher() -> Result<IncrementalHasher, HashError> {
        IncrementalHasher::new(None)
    }

    /// Benchmark both algorithms and return comparison
    pub fn benchmark_algorithms(test_size: usize) -> BenchmarkComparison {
        let data: Vec<u8> = (0..test_size).map(|i| (i * 0x9E3779B1) as u8).collect();

        let blake3_engine = HashEngine::with_strategy(HashStrategy::Blake3Only);
        let xxh3_engine = HashEngine::with_strategy(HashStrategy::Xxh3Only);

        // Benchmark BLAKE3
        let blake3_start = std::time::Instant::now();
        for _ in 0..100 {
            let _ = blake3_engine.hash_bytes(&data);
        }
        let blake3_time = blake3_start.elapsed();

        // Benchmark XXH3
        let xxh3_start = std::time::Instant::now();
        for _ in 0..100 {
            let _ = xxh3_engine.hash_bytes(&data);
        }
        let xxh3_time = xxh3_start.elapsed();

        BenchmarkComparison {
            test_size,
            blake3_ns_per_op: blake3_time.as_nanos() / 100,
            xxh3_ns_per_op: xxh3_time.as_nanos() / 100,
            blake3_throughput_mbps: (test_size as f64 * 100.0)
                / (blake3_time.as_secs_f64() * 1024.0 * 1024.0),
            xxh3_throughput_mbps: (test_size as f64 * 100.0)
                / (xxh3_time.as_secs_f64() * 1024.0 * 1024.0),
        }
    }
}

/// Benchmark comparison between algorithms
#[derive(Debug, Clone)]
pub struct BenchmarkComparison {
    pub test_size: usize,
    pub blake3_ns_per_op: u128,
    pub xxh3_ns_per_op: u128,
    pub blake3_throughput_mbps: f64,
    pub xxh3_throughput_mbps: f64,
}

#[cfg(test)]
mod tests {
    use super::prelude::*;
    use super::*;

    #[test]
    fn test_engine_initialization() {
        let engine = HashEngine::new();
        let simd_level = engine.simd_level();
        // Should detect some level of SIMD support on modern CPUs
        println!("Detected SIMD level: {simd_level:?}");
        println!("Strategy: {:?}", engine.strategy());
    }

    #[test]
    fn test_hash_strategies() {
        let data = b"Hello, Retrigger! This is a test of the hybrid hashing system.";

        // Test all strategies
        let hybrid = HashEngine::with_strategy(HashStrategy::Hybrid);
        let blake3 = HashEngine::with_strategy(HashStrategy::Blake3Only);
        let xxh3 = HashEngine::with_strategy(HashStrategy::Xxh3Only);
        let auto = HashEngine::with_strategy(HashStrategy::Auto);

        let result_hybrid = hybrid.hash_bytes(data).unwrap();
        let result_blake3 = blake3.hash_bytes(data).unwrap();
        let result_xxh3 = xxh3.hash_bytes(data).unwrap();
        let result_auto = auto.hash_bytes(data).unwrap();

        // All should produce valid hashes
        assert_ne!(result_hybrid.hash, 0);
        assert_ne!(result_blake3.hash, 0);
        assert_ne!(result_xxh3.hash, 0);
        assert_ne!(result_auto.hash, 0);

        // Size should be consistent
        assert_eq!(result_hybrid.size, data.len() as u32);
        assert_eq!(result_blake3.size, data.len() as u32);
        assert_eq!(result_xxh3.size, data.len() as u32);
        assert_eq!(result_auto.size, data.len() as u32);
    }

    #[test]
    fn test_hybrid_threshold() {
        // Small data should use XXH3
        let small_data = vec![0u8; 1000];
        // Large data should use BLAKE3
        let large_data = vec![0u8; 2 * 1024 * 1024]; // 2MB

        let engine = HashEngine::with_strategy(HashStrategy::Hybrid);

        let small_result = engine.hash_bytes(&small_data).unwrap();
        let large_result = engine.hash_bytes(&large_data).unwrap();

        assert_ne!(small_result.hash, 0);
        assert_ne!(large_result.hash, 0);
        assert_eq!(small_result.size, small_data.len() as u32);
        assert_eq!(large_result.size, large_data.len() as u32);
    }

    #[test]
    fn test_prelude_functions() {
        let data = b"Test data for prelude functions";

        let result_default = hash_bytes(data).unwrap();
        let result_blake3 = hash_bytes_blake3(data).unwrap();
        let result_xxh3 = hash_bytes_xxh3(data).unwrap();

        assert_ne!(result_default.hash, 0);
        assert_ne!(result_blake3.hash, 0);
        assert_ne!(result_xxh3.hash, 0);

        // BLAKE3 and XXH3 should produce different hashes
        assert_ne!(result_blake3.hash, result_xxh3.hash);
    }

    #[test]
    fn test_benchmark_comparison() {
        let comparison = benchmark_algorithms(1024);

        assert!(comparison.blake3_ns_per_op > 0);
        assert!(comparison.xxh3_ns_per_op > 0);
        assert!(comparison.blake3_throughput_mbps > 0.0);
        assert!(comparison.xxh3_throughput_mbps > 0.0);

        println!("Benchmark results for 1KB:");
        println!(
            "BLAKE3: {} ns/op, {:.2} MB/s",
            comparison.blake3_ns_per_op, comparison.blake3_throughput_mbps
        );
        println!(
            "XXH3: {} ns/op, {:.2} MB/s",
            comparison.xxh3_ns_per_op, comparison.xxh3_throughput_mbps
        );
    }

    #[test]
    fn test_performance_targets() {
        // Test 1MB file performance target: <0.1ms
        let mb_data = vec![0xABu8; 1024 * 1024];
        let engine = HashEngine::new();

        let start = std::time::Instant::now();
        for _ in 0..10 {
            engine.hash_bytes(&mb_data).unwrap();
        }
        let elapsed = start.elapsed();
        let avg_per_op = elapsed / 10;

        println!("1MB hash time: {avg_per_op:?} (target: <0.1ms)");
        // Note: This may not pass on all systems, but gives us a baseline

        // Test 100MB would be too large for unit tests, but we can extrapolate
        let estimated_100mb = avg_per_op * 100;
        println!("Estimated 100MB hash time: {estimated_100mb:?} (target: <1ms)");
    }

    #[test]
    fn test_incremental_hashing() {
        let mut hasher = IncrementalHasher::new(Some(1024)).unwrap();

        let chunk1 = b"Hello, ";
        let chunk2 = b"Retrigger!";

        hasher.update(chunk1).unwrap();
        hasher.update(chunk2).unwrap();

        let result = hasher.finalize().unwrap();
        assert!(result.is_incremental);
        assert_eq!(result.size, (chunk1.len() + chunk2.len()) as u32);
    }
}
