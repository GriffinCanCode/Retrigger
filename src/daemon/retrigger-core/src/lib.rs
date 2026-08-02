//! XXH3-64 hashing, backed by the C engine in `src/core`.
//!
//! # One algorithm, always
//!
//! An earlier version of this crate chose between BLAKE3 and XXH3 depending on
//! input size. That meant the same bytes produced different digests depending
//! on how large the file was, and nothing outside this crate — least of all the
//! JavaScript layer — could reproduce a hash without knowing the threshold.
//! There is now exactly one algorithm. `hash(x)` is XXH3-64 of `x`, on every
//! platform, at every size, from every entry point.
//!
//! # SIMD is a runtime decision
//!
//! The C engine detects CPU features at runtime and dispatches to a scalar,
//! NEON, SSE2, AVX2, or AVX-512 kernel. All of them compute identical values;
//! the C test suite proves this by running the same inputs through every
//! kernel the host supports, and validates the result against reference
//! vectors taken from upstream xxHash.
//!
//! # The FFI declarations are hand-written
//!
//! Deliberately, so that building from source does not require `libclang` for
//! bindgen. What makes that safe is that both sides assert the layout
//! independently: `retrigger_hash.h` carries `_Static_assert`s and this module
//! carries matching `const` assertions. If the two ever disagree, one of them
//! stops compiling.

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::fmt;
use std::io;
use std::path::Path;
use std::ptr::NonNull;

use serde::{Deserialize, Serialize};
use thiserror::Error;

// ---------------------------------------------------------------------- ffi

#[allow(non_camel_case_types)]
mod ffi {
    use super::{c_char, c_int, c_void};

    /// Opaque streaming state owned by the C engine.
    #[repr(C)]
    pub struct rtr_hash_state {
        _private: [u8; 0],
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct rtr_hash_file_result_t {
        pub hash: u64,
        pub size: u64,
        pub error: i32,
        pub reserved: i32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct rtr_benchmark_result_t {
        pub throughput_mbps: f64,
        pub ns_per_byte: f64,
        pub bytes_hashed: u64,
        pub elapsed_ns: u64,
        pub checksum: u64,
        pub level: i32,
        pub reserved: i32,
    }

    extern "C" {
        pub fn rtr_hash_abi_version() -> u32;
        pub fn rtr_hash_init() -> c_int;
        pub fn rtr_hash_cpu_level() -> c_int;
        pub fn rtr_hash_active_level() -> c_int;
        pub fn rtr_hash_available_levels() -> u32;
        pub fn rtr_hash_force_level(level: c_int) -> c_int;
        pub fn rtr_hash_reset_level();
        pub fn rtr_hash_level_str(level: c_int) -> *const c_char;

        pub fn rtr_hash64(data: *const c_void, len: usize) -> u64;
        pub fn rtr_hash64_seed(data: *const c_void, len: usize, seed: u64) -> u64;

        pub fn rtr_hash_create() -> *mut rtr_hash_state;
        pub fn rtr_hash_destroy(state: *mut rtr_hash_state);
        pub fn rtr_hash_reset(state: *mut rtr_hash_state, seed: u64) -> c_int;
        pub fn rtr_hash_update(
            state: *mut rtr_hash_state,
            data: *const c_void,
            len: usize,
        ) -> c_int;
        pub fn rtr_hash_digest(state: *const rtr_hash_state) -> u64;

        pub fn rtr_hash_file(path: *const c_char) -> rtr_hash_file_result_t;
        pub fn rtr_hash_benchmark(test_size: usize, iterations: u32) -> rtr_benchmark_result_t;
    }
}

/// The struct layout this binding was written against, and the value it expects
/// [`ffi::rtr_hash_abi_version`] to return. Bumped in lockstep with
/// `RTR_HASH_ABI_VERSION` in `retrigger_hash.h`; the runtime handshake test
/// below fails if the linked library disagrees with this number, and the
/// compile-time assertions fail if the struct shape it describes has drifted.
pub const EXPECTED_ABI_VERSION: u32 = 2;

// The other half of the layout contract asserted in retrigger_hash.h. These are
// compile-time: a mismatch is a build failure, never a runtime surprise. Sizes
// alone are not enough -- two structs can share a size while a field moved -- so
// every offset the C header pins with offsetof is pinned here too, via the
// stable std::mem::offset_of!.
const _: () = {
    use std::mem::{offset_of, size_of};

    assert!(size_of::<c_int>() == 4);

    assert!(size_of::<ffi::rtr_hash_file_result_t>() == 24);
    assert!(offset_of!(ffi::rtr_hash_file_result_t, hash) == 0);
    assert!(offset_of!(ffi::rtr_hash_file_result_t, size) == 8);
    assert!(offset_of!(ffi::rtr_hash_file_result_t, error) == 16);
    assert!(offset_of!(ffi::rtr_hash_file_result_t, reserved) == 20);

    assert!(size_of::<ffi::rtr_benchmark_result_t>() == 48);
    assert!(offset_of!(ffi::rtr_benchmark_result_t, throughput_mbps) == 0);
    assert!(offset_of!(ffi::rtr_benchmark_result_t, ns_per_byte) == 8);
    assert!(offset_of!(ffi::rtr_benchmark_result_t, bytes_hashed) == 16);
    assert!(offset_of!(ffi::rtr_benchmark_result_t, elapsed_ns) == 24);
    assert!(offset_of!(ffi::rtr_benchmark_result_t, checksum) == 32);
    assert!(offset_of!(ffi::rtr_benchmark_result_t, level) == 40);
    assert!(offset_of!(ffi::rtr_benchmark_result_t, reserved) == 44);
};

/// The ABI version the linked C engine implements.
///
/// A hand-written FFI is only safe while both sides agree on struct layout. The
/// compile-time assertions above catch a mismatch when this crate is built
/// against the current header; this catches the other case -- a shared library
/// swapped underneath a binary that was built against a different header -- by
/// asking the engine at runtime.
pub fn abi_version() -> u32 {
    // SAFETY: no arguments, returns a plain integer.
    unsafe { ffi::rtr_hash_abi_version() }
}

// ------------------------------------------------------------------- errors

/// Something went wrong hashing.
#[derive(Debug, Error)]
pub enum HashError {
    /// The path contained an interior NUL and cannot cross the C boundary.
    #[error("path is not representable as a C string: {0}")]
    InvalidPath(String),

    /// The OS refused the read; carries the original `errno`.
    #[error("could not hash {path}: {source}")]
    Io {
        /// The file being hashed.
        path: String,
        /// The underlying OS error.
        #[source]
        source: io::Error,
    },

    /// The engine could not allocate streaming state.
    #[error("hash engine failed to allocate streaming state")]
    Alloc,

    /// The requested SIMD level is not usable on this CPU or was not compiled.
    #[error("SIMD level {0} is unavailable on this machine")]
    UnsupportedLevel(SimdLevel),
}

// -------------------------------------------------------------------- level

/// A hash kernel. Every level computes identical values; they differ only in
/// how much of the CPU they use to get there.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SimdLevel {
    /// Portable C. Available everywhere.
    Scalar,
    /// AArch64 / ARMv7 NEON.
    Neon,
    /// x86-64 baseline SSE2.
    Sse2,
    /// x86-64 AVX2.
    Avx2,
    /// x86-64 AVX-512F.
    Avx512,
}

impl SimdLevel {
    fn from_raw(v: c_int) -> Self {
        match v {
            1 => Self::Neon,
            2 => Self::Sse2,
            3 => Self::Avx2,
            4 => Self::Avx512,
            _ => Self::Scalar,
        }
    }

    fn as_raw(self) -> c_int {
        match self {
            Self::Scalar => 0,
            Self::Neon => 1,
            Self::Sse2 => 2,
            Self::Avx2 => 3,
            Self::Avx512 => 4,
        }
    }

    /// The engine's own name for this level.
    pub fn name(self) -> &'static str {
        // SAFETY: the C function returns a static, never-NULL string for any
        // input, including values outside the enum.
        unsafe { CStr::from_ptr(ffi::rtr_hash_level_str(self.as_raw())) }
            .to_str()
            .unwrap_or("unknown")
    }
}

impl fmt::Display for SimdLevel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

/// The best level this CPU supports.
pub fn cpu_level() -> SimdLevel {
    // SAFETY: no arguments, no pointers; the engine self-initializes.
    SimdLevel::from_raw(unsafe { ffi::rtr_hash_cpu_level() })
}

/// The level currently dispatching, which differs from [`cpu_level`] only
/// after a call to [`force_level`].
pub fn active_level() -> SimdLevel {
    // SAFETY: as above.
    SimdLevel::from_raw(unsafe { ffi::rtr_hash_active_level() })
}

/// Every level usable on this machine, lowest first.
pub fn available_levels() -> Vec<SimdLevel> {
    // SAFETY: as above.
    let mask = unsafe { ffi::rtr_hash_available_levels() };
    [
        SimdLevel::Scalar,
        SimdLevel::Neon,
        SimdLevel::Sse2,
        SimdLevel::Avx2,
        SimdLevel::Avx512,
    ]
    .into_iter()
    .filter(|l| mask & (1 << l.as_raw()) != 0)
    .collect()
}

/// Pin dispatch to one kernel.
///
/// This exists for differential testing and for bisecting a suspected kernel
/// bug in the field. It is process-global and is **not** safe to call while
/// other threads are hashing.
pub fn force_level(level: SimdLevel) -> Result<(), HashError> {
    // SAFETY: passes a plain integer; the engine validates it and reports
    // failure rather than trusting the caller.
    if unsafe { ffi::rtr_hash_force_level(level.as_raw()) } == 0 {
        Ok(())
    } else {
        Err(HashError::UnsupportedLevel(level))
    }
}

/// Undo [`force_level`] and return to CPU-selected dispatch.
pub fn reset_level() {
    // SAFETY: no arguments.
    unsafe { ffi::rtr_hash_reset_level() }
}

/// Initialize dispatch eagerly and report the level chosen. Optional: every
/// entry point initializes on demand.
pub fn init() -> SimdLevel {
    // SAFETY: idempotent and thread-safe per the engine's contract.
    SimdLevel::from_raw(unsafe { ffi::rtr_hash_init() })
}

// --------------------------------------------------------------- one-shot

/// XXH3-64 of `data` with a zero seed.
pub fn hash(data: &[u8]) -> u64 {
    // SAFETY: pointer and length come from the same live slice. An empty slice
    // yields a dangling-but-aligned pointer with len 0, which the engine
    // handles as the documented empty-input case.
    unsafe { ffi::rtr_hash64(data.as_ptr() as *const c_void, data.len()) }
}

/// XXH3-64 of `data` with an explicit seed.
pub fn hash_with_seed(data: &[u8], seed: u64) -> u64 {
    // SAFETY: as [`hash`].
    unsafe { ffi::rtr_hash64_seed(data.as_ptr() as *const c_void, data.len(), seed) }
}

/// Lowercase, zero-padded 16-character hex, the form the Node layer exchanges.
pub fn to_hex(hash: u64) -> String {
    format!("{hash:016x}")
}

// --------------------------------------------------------------- streaming

/// Incremental hasher. Feeding bytes in any chunking produces exactly the
/// digest that [`hash`] gives for the concatenation.
pub struct Hasher {
    state: NonNull<ffi::rtr_hash_state>,
}

// SAFETY: the state is a plain allocation owned exclusively by this handle.
// The engine keeps no global mutable state on the hashing path (dispatch
// selection is set up once and only mutated by force_level, which is
// documented as setup-only), so moving a Hasher between threads is sound.
unsafe impl Send for Hasher {}

impl Hasher {
    /// A hasher with a zero seed.
    pub fn new() -> Result<Self, HashError> {
        Self::with_seed(0)
    }

    /// A hasher with an explicit seed.
    pub fn with_seed(seed: u64) -> Result<Self, HashError> {
        // SAFETY: the engine either returns a valid pointer or NULL.
        let raw = unsafe { ffi::rtr_hash_create() };
        let state = NonNull::new(raw).ok_or(HashError::Alloc)?;
        let mut this = Self { state };
        this.reset(seed);
        Ok(this)
    }

    /// Absorb more bytes.
    pub fn update(&mut self, data: &[u8]) {
        // SAFETY: `state` is a live allocation we own; pointer and length come
        // from the same live slice.
        unsafe {
            ffi::rtr_hash_update(
                self.state.as_ptr(),
                data.as_ptr() as *const c_void,
                data.len(),
            );
        }
    }

    /// The digest so far. Non-destructive; the hasher may be updated further.
    pub fn digest(&self) -> u64 {
        // SAFETY: `state` is live and the call does not mutate it.
        unsafe { ffi::rtr_hash_digest(self.state.as_ptr()) }
    }

    /// Return to the initial state so one allocation can hash many inputs.
    pub fn reset(&mut self, seed: u64) {
        // SAFETY: `state` is live and owned by us.
        unsafe {
            ffi::rtr_hash_reset(self.state.as_ptr(), seed);
        }
    }
}

impl Drop for Hasher {
    fn drop(&mut self) {
        // SAFETY: `state` was produced by rtr_hash_create and is freed once,
        // here, because Hasher is neither Copy nor Clone.
        unsafe { ffi::rtr_hash_destroy(self.state.as_ptr()) }
    }
}

impl std::hash::Hasher for Hasher {
    fn finish(&self) -> u64 {
        self.digest()
    }
    fn write(&mut self, bytes: &[u8]) {
        self.update(bytes);
    }
}

/// Lets a file be streamed in with `io::copy` without a second buffer.
impl io::Write for Hasher {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.update(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

// -------------------------------------------------------------------- file

/// A file's digest and the number of bytes that produced it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileHash {
    /// XXH3-64 of the file's contents.
    pub hash: u64,
    /// Size in bytes.
    pub size: u64,
}

/// Hash a file by streaming it in bounded chunks, so peak memory does not
/// scale with file size.
pub fn hash_file(path: impl AsRef<Path>) -> Result<FileHash, HashError> {
    let path = path.as_ref();
    let display = path.display().to_string();

    let c_path = CString::new(path.as_os_str().as_encoded_bytes())
        .map_err(|_| HashError::InvalidPath(display.clone()))?;

    // SAFETY: `c_path` is a valid NUL-terminated string that outlives the call.
    let result = unsafe { ffi::rtr_hash_file(c_path.as_ptr()) };

    if result.error != 0 {
        return Err(HashError::Io {
            path: display,
            source: io::Error::from_raw_os_error(result.error),
        });
    }
    Ok(FileHash {
        hash: result.hash,
        size: result.size,
    })
}

// --------------------------------------------------------------- benchmark

/// A measured throughput result.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Benchmark {
    /// Throughput in mebibytes per second.
    pub throughput_mbps: f64,
    /// Nanoseconds per input byte.
    pub ns_per_byte: f64,
    /// Total bytes hashed across all iterations.
    pub bytes_hashed: u64,
    /// Wall time consumed.
    pub elapsed_ns: u64,
    /// The kernel that was exercised.
    pub level: SimdLevel,
}

/// Measure throughput over `test_size` bytes for `iterations` passes.
pub fn benchmark(test_size: usize, iterations: u32) -> Benchmark {
    // SAFETY: scalar arguments only.
    let r = unsafe { ffi::rtr_hash_benchmark(test_size, iterations) };
    Benchmark {
        throughput_mbps: r.throughput_mbps,
        ns_per_byte: r.ns_per_byte,
        bytes_hashed: r.bytes_hashed,
        elapsed_ns: r.elapsed_ns,
        level: SimdLevel::from_raw(r.level),
    }
}

// ------------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;
    use std::sync::Mutex;

    /// `force_level` mutates process-global dispatch, so tests that use it
    /// must not run concurrently with each other or with anything hashing.
    static LEVEL_LOCK: Mutex<()> = Mutex::new(());

    /// The empty-input digest for XXH3-64 with a zero seed. This value is
    /// published by upstream xxHash; it is an external oracle, not something
    /// this crate produced. The exhaustive vector suite (148 vectors against
    /// upstream v0.8.3) lives in `src/core/tests/test_vectors.c`; the tests
    /// here exist to prove the *binding* is faithful, not to re-verify XXH3.
    const XXH3_EMPTY: u64 = 0x2D06_8005_38D3_94C2;

    #[test]
    fn matches_the_published_empty_vector() {
        assert_eq!(hash(b""), XXH3_EMPTY);
        assert_eq!(hash(&[]), XXH3_EMPTY);
    }

    #[test]
    fn abi_version_handshake_holds() {
        // The linked engine must report exactly the ABI this binding was
        // written for. If C bumps RTR_HASH_ABI_VERSION for a layout change, the
        // offset_of! assertions above stop compiling and this constant must be
        // moved in lockstep -- so a silently mismatched library cannot slip
        // past both checks.
        assert_eq!(
            abi_version(),
            EXPECTED_ABI_VERSION,
            "linked engine reports ABI {} but this binding expects {}",
            abi_version(),
            EXPECTED_ABI_VERSION
        );
    }

    #[test]
    fn seeding_changes_the_digest() {
        let data = b"retrigger";
        assert_ne!(hash_with_seed(data, 0), hash_with_seed(data, 1));
        // A zero seed must be exactly the unseeded case.
        assert_eq!(hash_with_seed(data, 0), hash(data));
    }

    #[test]
    fn digest_depends_on_every_byte() {
        let base = vec![0u8; 512];
        let baseline = hash(&base);
        for i in 0..base.len() {
            let mut m = base.clone();
            m[i] ^= 1;
            assert_ne!(
                hash(&m),
                baseline,
                "flipping byte {i} did not change the digest"
            );
        }
    }

    #[test]
    fn length_is_part_of_the_input() {
        // Truncation must not be invisible.
        assert_ne!(hash(b"abc"), hash(b"abc\0"));
        assert_ne!(hash(&[0u8; 8]), hash(&[0u8; 9]));
    }

    #[test]
    fn streaming_matches_one_shot_for_every_split() {
        let data: Vec<u8> = (0..4096u32)
            .map(|i| (i.wrapping_mul(2654435761) >> 24) as u8)
            .collect();
        let expected = hash(&data);

        // Split points chosen to straddle the engine's internal 256-byte
        // buffer and its 1024-byte block boundary, where an off-by-one in the
        // buffering logic would hide.
        for split in [0, 1, 255, 256, 257, 1023, 1024, 1025, 4095, 4096] {
            let mut h = Hasher::new().expect("allocate hasher");
            h.update(&data[..split]);
            h.update(&data[split..]);
            assert_eq!(h.digest(), expected, "split at {split}");
        }
    }

    #[test]
    fn single_byte_chunks_match_one_shot() {
        let data = b"the quick brown fox jumps over the lazy dog";
        let mut h = Hasher::new().expect("allocate hasher");
        for b in data {
            h.update(&[*b]);
        }
        assert_eq!(h.digest(), hash(data));
    }

    #[test]
    fn digest_is_non_destructive_and_resettable() {
        let mut h = Hasher::new().expect("allocate hasher");
        h.update(b"abc");
        let first = h.digest();
        assert_eq!(h.digest(), first, "digest mutated the state");

        h.update(b"def");
        assert_eq!(h.digest(), hash(b"abcdef"));

        h.reset(0);
        assert_eq!(
            h.digest(),
            XXH3_EMPTY,
            "reset did not restore the initial state"
        );
    }

    #[test]
    fn empty_updates_are_inert() {
        let mut h = Hasher::new().expect("allocate hasher");
        h.update(b"");
        h.update(b"abc");
        h.update(b"");
        assert_eq!(h.digest(), hash(b"abc"));
    }

    #[test]
    fn hasher_works_as_an_io_sink() {
        let data = vec![7u8; 100_000];
        let mut h = Hasher::new().expect("allocate hasher");
        h.write_all(&data).expect("write to hasher");
        assert_eq!(h.digest(), hash(&data));
    }

    // ---- the point of the whole SIMD design: every kernel agrees ----------
    #[test]
    fn every_available_level_computes_the_same_digest() {
        let _guard = LEVEL_LOCK.lock().unwrap_or_else(|e| e.into_inner());

        let levels = available_levels();
        assert!(
            levels.contains(&SimdLevel::Scalar),
            "the scalar kernel must always be available; got {levels:?}"
        );

        // Sizes that cross every length-class boundary in XXH3 plus several
        // multi-block inputs.
        let sizes = [
            0usize, 1, 3, 4, 8, 9, 16, 17, 64, 128, 129, 240, 241, 1024, 4096, 100_000,
        ];

        for size in sizes {
            let data: Vec<u8> = (0..size).map(|i| (i * 31 % 251) as u8).collect();

            force_level(SimdLevel::Scalar).expect("scalar is always available");
            let reference = hash(&data);

            for &level in &levels {
                force_level(level).expect("level reported as available");
                assert_eq!(active_level(), level, "force_level did not take effect");
                assert_eq!(
                    hash(&data),
                    reference,
                    "{level} disagrees with scalar at {size} bytes"
                );
            }
        }
        reset_level();

        // Not a hard assertion -- a scalar-only CPU is legitimate -- but a
        // single-level run proves much less, so make that visible.
        if levels.len() == 1 {
            eprintln!("note: only the scalar kernel is available here; cross-kernel equivalence was not exercised");
        }
    }

    #[test]
    fn forcing_an_unsupported_level_fails_cleanly() {
        let _guard = LEVEL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let available = available_levels();

        for level in [
            SimdLevel::Neon,
            SimdLevel::Sse2,
            SimdLevel::Avx2,
            SimdLevel::Avx512,
        ] {
            if !available.contains(&level) {
                assert!(
                    force_level(level).is_err(),
                    "{level} is unavailable but force_level accepted it"
                );
                // The engine must be left usable after a rejected request.
                assert_eq!(hash(b"still works"), hash(b"still works"));
            }
        }
        reset_level();
    }

    #[test]
    fn levels_report_sane_metadata() {
        assert!(!available_levels().is_empty());
        assert!(available_levels().contains(&cpu_level()));
        for l in [
            SimdLevel::Scalar,
            SimdLevel::Neon,
            SimdLevel::Sse2,
            SimdLevel::Avx2,
            SimdLevel::Avx512,
        ] {
            assert!(!l.name().is_empty(), "{l:?} has no name");
        }
        assert_eq!(init(), active_level());
    }

    // ---- files ------------------------------------------------------------
    #[test]
    fn file_hash_matches_memory_hash() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("sample.bin");

        // Larger than the engine's 256 KiB read chunk, so chunk stitching is
        // actually exercised rather than assumed.
        let data: Vec<u8> = (0..700_000u32).map(|i| (i % 256) as u8).collect();
        std::fs::write(&path, &data).expect("write sample");

        let got = hash_file(&path).expect("hash file");
        assert_eq!(got.hash, hash(&data));
        assert_eq!(got.size, data.len() as u64);
    }

    #[test]
    fn empty_file_hashes_to_the_empty_vector() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("empty");
        std::fs::write(&path, b"").expect("write empty");

        let got = hash_file(&path).expect("hash empty file");
        assert_eq!(got.hash, XXH3_EMPTY);
        assert_eq!(got.size, 0);
    }

    #[test]
    fn missing_file_reports_not_found() {
        let dir = tempfile::tempdir().expect("temp dir");
        let err = hash_file(dir.path().join("nope")).expect_err("must fail");
        match err {
            HashError::Io { source, .. } => {
                assert_eq!(source.kind(), io::ErrorKind::NotFound, "got {source:?}");
            }
            other => panic!("expected an Io error, got {other:?}"),
        }
    }

    #[test]
    fn directory_is_rejected_rather_than_hashed() {
        let dir = tempfile::tempdir().expect("temp dir");
        assert!(hash_file(dir.path()).is_err());
    }

    #[test]
    fn path_with_interior_nul_is_rejected() {
        // Only Unix lets an OsString carry a NUL this way.
        #[cfg(unix)]
        {
            use std::ffi::OsString;
            use std::os::unix::ffi::OsStringExt;
            let bad = std::path::PathBuf::from(OsString::from_vec(b"/tmp/a\0b".to_vec()));
            assert!(matches!(hash_file(bad), Err(HashError::InvalidPath(_))));
        }
    }

    #[test]
    fn hex_is_zero_padded_to_sixteen_chars() {
        assert_eq!(to_hex(0), "0000000000000000");
        assert_eq!(to_hex(u64::MAX), "ffffffffffffffff");
        assert_eq!(to_hex(XXH3_EMPTY).len(), 16);
    }

    #[test]
    fn benchmark_reports_real_work() {
        let b = benchmark(64 * 1024, 8);
        assert_eq!(b.bytes_hashed, 64 * 1024 * 8);
        assert!(b.elapsed_ns > 0, "benchmark reported zero elapsed time");
        assert!(b.throughput_mbps > 0.0);
        assert!(available_levels().contains(&b.level));
    }

    #[test]
    fn hashing_is_consistent_across_threads() {
        let data: Vec<u8> = (0..50_000u32).map(|i| (i % 256) as u8).collect();
        let expected = hash(&data);
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let d = data.clone();
                std::thread::spawn(move || {
                    for _ in 0..50 {
                        assert_eq!(hash(&d), expected);
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().expect("worker thread panicked");
        }
    }
}
