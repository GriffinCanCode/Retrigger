//! The content-hashing seam.
//!
//! [`FileEventProcessor`](crate::FileEventProcessor) needs to know whether a file's *contents*
//! changed, not merely that the file system said something about it. It gets that through this
//! trait rather than by depending on a particular hash engine, so the production engine can be
//! substituted without this crate knowing anything about it.

use std::cell::Cell;
use std::fs::File;
use std::io::{self, Read};
use std::path::Path;

/// Buffer size for streaming a file through a hasher. One page-cluster; large enough that the
/// read syscall cost disappears, small enough to stay in L1/L2.
const CHUNK: usize = 64 * 1024;

thread_local! {
    /// The read buffer, reused across calls on this thread.
    ///
    /// This runs once per changed file, so a checkout of a large tree pays whatever a call costs a
    /// hundred thousand times over. Reuse is worth 3-7% on source-file-sized inputs, measured, and
    /// nothing on large ones where the byte loop dominates; the zeroing of `vec![0; CHUNK]` is
    /// *not* the reason, because the allocator hands back pages the OS zeroes lazily and a small
    /// file only ever touches the first of them.
    ///
    /// Reuse costs one 64 KiB allocation per thread that hashes, released when that thread exits.
    /// Hashing happens on [`tokio::task::spawn_blocking`], whose idle workers are reaped, so the
    /// retention tracks threads currently hashing rather than growing to the pool's ceiling.
    ///
    /// A `Cell` rather than a `RefCell` because the buffer is *taken* for the duration of the hash:
    /// a re-entrant call would find `None` and allocate its own instead of panicking on a double
    /// borrow. Nothing re-enters today; this keeps that from becoming a crash if it ever does.
    static SCRATCH: Cell<Option<Box<[u8]>>> = const { Cell::new(None) };
}

/// Computes a 64-bit content fingerprint for a file.
///
/// Implementations must be cheap enough to run on every change event for a source file, and must
/// not panic — the caller is a library sitting under someone's dev server.
///
/// Implementations are called from a blocking context (a dedicated thread or
/// [`tokio::task::spawn_blocking`]), so they may perform synchronous I/O freely.
pub trait ContentHasher: Send + Sync {
    /// Fingerprint the contents of `path`.
    ///
    /// # Errors
    ///
    /// Any I/O error from opening or reading the file. Callers treat an error as "unknown", not
    /// as "unchanged".
    fn hash_file(&self, path: &Path) -> io::Result<u64>;
}

/// Default [`ContentHasher`]: streaming FNV-1a, 64-bit.
///
/// A placeholder with no dependencies and a fully specified algorithm, chosen so its output is
/// reproducible and independently checkable rather than "whatever the standard library does this
/// release". It is *not* collision-resistant and must not be used for security decisions.
///
/// Substitute the production engine by implementing [`ContentHasher`] for it and passing it to
/// [`FileEventProcessor::with_hasher`](crate::FileEventProcessor::with_hasher).
#[derive(Debug, Clone, Copy, Default)]
pub struct Fnv1aHasher;

/// FNV-1a 64-bit offset basis, per the FNV specification.
const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
/// FNV-1a 64-bit prime, per the FNV specification.
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

/// FNV-1a 64-bit hash of `bytes`.
#[must_use]
pub fn fnv1a_64(bytes: &[u8]) -> u64 {
    bytes.iter().fold(FNV_OFFSET_BASIS, |hash, &byte| {
        (hash ^ u64::from(byte)).wrapping_mul(FNV_PRIME)
    })
}

impl Fnv1aHasher {
    /// Hash an in-memory buffer. Equivalent to [`fnv1a_64`].
    #[must_use]
    pub fn hash_bytes(&self, bytes: &[u8]) -> u64 {
        fnv1a_64(bytes)
    }
}

impl ContentHasher for Fnv1aHasher {
    fn hash_file(&self, path: &Path) -> io::Result<u64> {
        // Read straight into a `CHUNK`-sized buffer rather than through a `BufReader`: `BufReader`
        // hands a destination at least as large as its capacity to the inner reader untouched, so
        // wrapping the file would allocate a second 64 KiB buffer that is never read from.
        let mut file = File::open(path)?;
        // `try_with` because a thread being torn down cannot touch its locals, and a hasher living
        // under someone's dev server must degrade to allocating rather than panic.
        let mut buffer = SCRATCH
            .try_with(Cell::take)
            .ok()
            .flatten()
            .unwrap_or_else(|| vec![0_u8; CHUNK].into_boxed_slice());

        let hashed = fold_reader(&mut file, &mut buffer);

        // Returned on the error path too, so a run of unreadable files does not quietly throw the
        // buffer away and reallocate on the next success.
        let _ = SCRATCH.try_with(|scratch| scratch.set(Some(buffer)));
        hashed
    }
}

/// FNV-1a over everything `reader` yields, using `buffer` as scratch.
///
/// Only `buffer[..read]` is folded in, so bytes left behind by a longer previous file cannot reach
/// the digest.
fn fold_reader(reader: &mut impl Read, buffer: &mut [u8]) -> io::Result<u64> {
    let mut hash = FNV_OFFSET_BASIS;
    loop {
        let read = reader.read(buffer)?;
        if read == 0 {
            return Ok(hash);
        }
        for &byte in &buffer[..read] {
            hash = (hash ^ u64::from(byte)).wrapping_mul(FNV_PRIME);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    // Published FNV-1a 64-bit test vectors (Fowler/Noll/Vo reference `test_fnv.c`). Derived from
    // the specification, not from this implementation.
    const VECTORS: &[(&[u8], u64)] = &[
        (b"", 0xcbf2_9ce4_8422_2325),
        (b"a", 0xaf63_dc4c_8601_ec8c),
        (b"foobar", 0x8594_4171_f739_67e8),
    ];

    #[test]
    fn matches_published_fnv1a_vectors() {
        for (input, expected) in VECTORS {
            assert_eq!(
                fnv1a_64(input),
                *expected,
                "FNV-1a 64 of {:?}",
                String::from_utf8_lossy(input)
            );
        }
    }

    #[test]
    fn file_hashing_matches_the_in_memory_hash() -> io::Result<()> {
        let dir = tempfile::tempdir()?;
        for (input, expected) in VECTORS {
            let path = dir.path().join("v.bin");
            std::fs::write(&path, input)?;
            assert_eq!(Fnv1aHasher.hash_file(&path)?, *expected);
        }
        Ok(())
    }

    #[test]
    fn streaming_across_chunk_boundaries_is_identical_to_one_shot() -> io::Result<()> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("big.bin");
        // Deliberately not a multiple of the read buffer, so the final partial chunk is
        // exercised; deterministic contents so the expectation is stable.
        let contents: Vec<u8> = (0..(CHUNK * 2 + 12345))
            .map(|i| u8::try_from(i % 251).unwrap_or_default())
            .collect();
        let mut file = File::create(&path)?;
        file.write_all(&contents)?;
        file.sync_all()?;

        assert_eq!(Fnv1aHasher.hash_file(&path)?, fnv1a_64(&contents));
        Ok(())
    }

    /// The scratch buffer outlives a call, so a short file read into a buffer still holding a long
    /// file's bytes must hash to exactly what that short file hashes to on its own.
    #[test]
    fn a_short_file_after_a_long_one_is_not_contaminated_by_it() -> io::Result<()> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("reused");

        // Descending sizes, each crossing the buffer boundary differently, so a stale tail would
        // have to survive every one of them to go unnoticed.
        let sizes = [
            CHUNK * 3 + 7,
            CHUNK * 2,
            CHUNK + 1,
            CHUNK,
            CHUNK - 1,
            64,
            1,
            0,
        ];
        for size in sizes {
            let contents: Vec<u8> = (0..size)
                .map(|i| u8::try_from(i % 251).unwrap_or_default())
                .collect();
            std::fs::write(&path, &contents)?;
            assert_eq!(
                Fnv1aHasher.hash_file(&path)?,
                fnv1a_64(&contents),
                "hashing {size} bytes after a longer file"
            );
        }
        Ok(())
    }

    /// The buffer is taken for the duration of a hash, so concurrent hashers on different threads
    /// must not be able to observe each other's bytes.
    #[test]
    fn concurrent_hashers_do_not_share_a_buffer() -> io::Result<()> {
        let dir = tempfile::tempdir()?;
        let mut expected = Vec::new();
        for id in 0..8_u8 {
            let path = dir.path().join(format!("f{id}"));
            // Different lengths as well as different bytes: a shared buffer would show up as a
            // wrong digest either way.
            let contents = vec![id; CHUNK + usize::from(id) * 977];
            std::fs::write(&path, &contents)?;
            expected.push((path, fnv1a_64(&contents)));
        }

        std::thread::scope(|scope| {
            for (path, want) in &expected {
                scope.spawn(move || {
                    for _ in 0..25 {
                        assert_eq!(
                            Fnv1aHasher.hash_file(path).expect("hash file"),
                            *want,
                            "{} hashed differently under concurrency",
                            path.display()
                        );
                    }
                });
            }
        });
        Ok(())
    }

    /// An unreadable file must not cost the thread its buffer, or a directory full of permission
    /// errors would reallocate on every subsequent success.
    #[test]
    fn a_failed_read_still_leaves_a_working_hasher() -> io::Result<()> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("a");
        std::fs::write(&path, b"a")?;

        for _ in 0..4 {
            assert!(Fnv1aHasher.hash_file(&dir.path().join("missing")).is_err());
            assert_eq!(Fnv1aHasher.hash_file(&path)?, 0xaf63_dc4c_8601_ec8c);
        }
        Ok(())
    }

    #[test]
    fn different_contents_hash_differently() -> io::Result<()> {
        let dir = tempfile::tempdir()?;
        let a = dir.path().join("a");
        let b = dir.path().join("b");
        std::fs::write(&a, b"hello world")?;
        std::fs::write(&b, b"hello worle")?;
        assert_ne!(Fnv1aHasher.hash_file(&a)?, Fnv1aHasher.hash_file(&b)?);
        Ok(())
    }

    #[test]
    fn identical_contents_at_different_paths_hash_identically() -> io::Result<()> {
        let dir = tempfile::tempdir()?;
        let a = dir.path().join("a");
        let b = dir.path().join("nested/b");
        std::fs::create_dir_all(dir.path().join("nested"))?;
        std::fs::write(&a, b"same")?;
        std::fs::write(&b, b"same")?;
        assert_eq!(Fnv1aHasher.hash_file(&a)?, Fnv1aHasher.hash_file(&b)?);
        Ok(())
    }

    #[test]
    fn missing_file_is_an_error_not_a_panic() {
        let err = Fnv1aHasher
            .hash_file(Path::new("/definitely/not/here"))
            .expect_err("must fail");
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
    }

    #[test]
    fn hashing_a_directory_is_an_error_not_a_panic() -> io::Result<()> {
        let dir = tempfile::tempdir()?;
        assert!(Fnv1aHasher.hash_file(dir.path()).is_err());
        Ok(())
    }

    #[test]
    fn hasher_is_usable_as_a_trait_object() -> io::Result<()> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("a");
        std::fs::write(&path, b"a")?;
        let hasher: Box<dyn ContentHasher> = Box::new(Fnv1aHasher);
        assert_eq!(hasher.hash_file(&path)?, 0xaf63_dc4c_8601_ec8c);
        Ok(())
    }
}
