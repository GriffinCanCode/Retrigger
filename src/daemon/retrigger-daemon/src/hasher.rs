//! The content-hashing bridge: `retrigger-core`'s XXH3-64 engine, seen through the
//! [`ContentHasher`] seam that `retrigger-system` hashes files with.

use std::io;
use std::path::Path;

use retrigger_core::HashError;
use retrigger_system::ContentHasher;

/// XXH3-64 over the C engine, with runtime SIMD dispatch.
///
/// This replaces `retrigger-system`'s default `Fnv1aHasher`, which documents itself as a
/// placeholder. The difference that matters here is not speed but collision behaviour: the
/// processor decides "did this file change?" by comparing fingerprints, so a collision is a
/// *missed rebuild* — the one failure mode a watcher must not have.
///
/// # Digest width
///
/// The trait is `u64` because the processor's cache is keyed on `u64`, and XXH3-64 is exactly
/// 64 bits wide, so nothing is truncated here. If the engine ever grows a wider digest, the
/// truncation belongs in this impl and must be documented at that point rather than pushed into
/// the trait.
///
/// # Example
///
/// ```
/// use retrigger_daemon::Xxh3Hasher;
/// use retrigger_system::ContentHasher;
///
/// # let dir = tempfile::tempdir()?;
/// # let path = dir.path().join("a.txt");
/// # std::fs::write(&path, b"hello")?;
/// assert_eq!(Xxh3Hasher.hash_file(&path)?, retrigger_core::hash(b"hello"));
/// # Ok::<(), std::io::Error>(())
/// ```
#[derive(Debug, Clone, Copy, Default)]
pub struct Xxh3Hasher;

impl ContentHasher for Xxh3Hasher {
    fn hash_file(&self, path: &Path) -> io::Result<u64> {
        retrigger_core::hash_file(path)
            .map(|file| file.hash)
            .map_err(into_io)
    }
}

/// Preserve the OS error where there is one, so the processor's caller can still tell "the file
/// vanished mid-event" (routine, and expected during a build) from "the disk is failing".
fn into_io(err: HashError) -> io::Error {
    match err {
        HashError::Io { source, .. } => source,
        err @ HashError::InvalidPath(_) => io::Error::new(io::ErrorKind::InvalidInput, err),
        err @ HashError::Alloc => io::Error::new(io::ErrorKind::OutOfMemory, err),
        err @ HashError::UnsupportedLevel(_) => io::Error::new(io::ErrorKind::Unsupported, err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use retrigger_system::{EventKind, FileEvent, FileEventProcessor};
    use std::path::PathBuf;

    fn write(dir: &tempfile::TempDir, name: &str, bytes: &[u8]) -> io::Result<PathBuf> {
        let path = dir.path().join(name);
        std::fs::write(&path, bytes)?;
        Ok(path)
    }

    #[test]
    fn agrees_with_the_core_engine_on_files() -> io::Result<()> {
        let dir = tempfile::tempdir()?;
        // Sizes chosen to cross XXH3's length classes and the engine's read-chunk boundary, so
        // this is not just a one-block test.
        for size in [0usize, 1, 16, 240, 241, 4096, 300_000] {
            let bytes: Vec<u8> = (0..size)
                .map(|i| u8::try_from(i % 251).unwrap_or(0))
                .collect();
            let path = write(&dir, "sample.bin", &bytes)?;

            let bridged = Xxh3Hasher.hash_file(&path)?;
            let direct = retrigger_core::hash_file(&path)
                .map_err(into_io)
                .map(|f| f.hash)?;
            assert_eq!(
                bridged, direct,
                "bridge disagrees with hash_file at {size} bytes"
            );
            assert_eq!(
                bridged,
                retrigger_core::hash(&bytes),
                "bridge disagrees with the in-memory hash at {size} bytes"
            );
        }
        Ok(())
    }

    #[test]
    fn is_not_the_placeholder_it_replaces() -> io::Result<()> {
        // If this ever passes by accident the wiring is broken, not the algorithms: the whole
        // point of the bridge is that the processor stops using FNV-1a.
        let dir = tempfile::tempdir()?;
        let path = write(&dir, "a.txt", b"hello")?;
        assert_ne!(
            Xxh3Hasher.hash_file(&path)?,
            retrigger_system::fnv1a_64(b"hello")
        );
        Ok(())
    }

    #[test]
    fn missing_file_keeps_its_error_kind() {
        let err = Xxh3Hasher
            .hash_file(Path::new("/definitely/not/here.txt"))
            .expect_err("a missing file must be an error");
        assert_eq!(
            err.kind(),
            io::ErrorKind::NotFound,
            "the OS error kind must survive the bridge, or callers cannot tell \
             a vanished file from a broken disk"
        );
    }

    #[test]
    fn a_directory_is_an_error_not_a_panic() -> io::Result<()> {
        let dir = tempfile::tempdir()?;
        assert!(Xxh3Hasher.hash_file(dir.path()).is_err());
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn a_path_with_an_interior_nul_is_rejected_cleanly() {
        use std::ffi::OsString;
        use std::os::unix::ffi::OsStringExt;

        let bad = PathBuf::from(OsString::from_vec(b"/tmp/a\0b".to_vec()));
        let err = Xxh3Hasher
            .hash_file(&bad)
            .expect_err("a path the C boundary cannot carry must fail, not panic");
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn the_processor_uses_it_and_still_detects_change() -> io::Result<()> {
        let dir = tempfile::tempdir()?;
        let path = write(&dir, "a.txt", b"one")?;
        let processor = FileEventProcessor::with_hasher(Xxh3Hasher);
        let event = |kind| FileEvent {
            path: path.clone(),
            kind,
            timestamp_ns: 0,
            size: 0,
            is_directory: false,
            cookie: None,
        };

        let first = processor.process(event(EventKind::Created));
        assert!(first.content_changed);
        assert_eq!(
            first.hash,
            Some(retrigger_core::hash(b"one")),
            "the processor must be reporting the XXH3 digest, not the placeholder's"
        );

        write(&dir, "a.txt", b"one")?;
        assert!(
            !processor
                .process(event(EventKind::Modified))
                .content_changed,
            "identical bytes rewritten must not be reported as a change"
        );

        write(&dir, "a.txt", b"two")?;
        assert!(
            processor
                .process(event(EventKind::Modified))
                .content_changed
        );
        Ok(())
    }

    #[test]
    fn hashing_the_same_file_concurrently_agrees() -> io::Result<()> {
        // The engine dispatches through process-global state; a daemon hashes from a pump thread
        // while the HTTP server reads stats, so disagreement here would be a live bug.
        let dir = tempfile::tempdir()?;
        let bytes: Vec<u8> = (0..100_000u32)
            .map(|i| u8::try_from(i % 256).unwrap_or(0))
            .collect();
        let path = write(&dir, "big.bin", &bytes)?;
        let expected = retrigger_core::hash(&bytes);

        let handles: Vec<_> = (0..8)
            .map(|_| {
                let path = path.clone();
                std::thread::spawn(move || Xxh3Hasher.hash_file(&path))
            })
            .collect();
        for handle in handles {
            let got = handle.join().expect("hashing thread panicked")?;
            assert_eq!(got, expected);
        }
        Ok(())
    }
}
