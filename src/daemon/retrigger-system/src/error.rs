//! Error type for the watcher.

use std::io;
use std::path::{Path, PathBuf};

/// Errors produced by [`Watcher`](crate::Watcher) and [`EventFilter`](crate::EventFilter).
///
/// Every variant names an *actionable* cause: the caller can tell a missing path from a
/// permission problem from kernel watch-descriptor exhaustion without string matching.
#[derive(Debug, thiserror::Error)]
pub enum WatchError {
    /// The path does not exist, or (for [`Watcher::unwatch`](crate::Watcher::unwatch)) was
    /// never registered.
    #[error("path not found: {0}")]
    NotFound(PathBuf),

    /// The process lacks permission to read the path or install a watch on it.
    #[error("permission denied: {0}")]
    PermissionDenied(PathBuf),

    /// The kernel refused a new watch because the per-user watch limit is exhausted.
    ///
    /// On Linux this is `inotify`'s `max_user_watches`. The message carries the remediation
    /// so it is useful even when it is only logged.
    #[error(
        "watch limit exceeded while watching {0}: the kernel refused a new watch descriptor. \
         On Linux, raise the limit with \
         `sudo sysctl fs.inotify.max_user_watches=524288` \
         (persist it in /etc/sysctl.d/), or narrow the watch set with exclude patterns \
         (for example `**/node_modules/**`)"
    )]
    WatchLimitExceeded(PathBuf),

    /// A strict lifecycle transition was attempted on an already-running watcher.
    ///
    /// Note that [`Watcher::start`](crate::Watcher::start) is deliberately *idempotent* and
    /// therefore never returns this; the variant exists for callers that wrap this watcher in
    /// a stricter state machine and want a shared error type.
    #[error("watcher is already running")]
    AlreadyRunning,

    /// A strict lifecycle transition was attempted on a watcher that is not running.
    ///
    /// Note that [`Watcher::stop`](crate::Watcher::stop) is deliberately *idempotent* and
    /// therefore never returns this; the variant exists for callers that wrap this watcher in
    /// a stricter state machine and want a shared error type.
    #[error("watcher is not running")]
    NotRunning,

    /// A glob or regular expression supplied to [`EventFilter`](crate::EventFilter) could not
    /// be compiled.
    #[error("invalid filter pattern: {0}")]
    InvalidPattern(String),

    /// The platform watcher backend failed for a reason that does not map onto a more
    /// specific variant.
    #[error("watcher backend error: {0}")]
    Backend(#[from] notify::Error),

    /// An I/O error occurred while inspecting a path.
    #[error("io error: {0}")]
    Io(#[from] io::Error),

    /// A directory tree exceeded the bound [`Watcher::snapshot`](crate::Watcher::snapshot) is
    /// willing to hold in memory at once.
    ///
    /// The honest answer for a tree too large to inventory in one call, for the same reason
    /// [`EventKind::RescanRequired`](crate::EventKind::RescanRequired) exists: reporting a
    /// truncated snapshot as complete would be a silent wrong answer, which a content-addressed
    /// cache can never safely recover from.
    #[error(
        "cannot snapshot {0}: the tree exceeds the entries this crate will hold in one inventory"
    )]
    ScanTooLarge(PathBuf),
}

impl WatchError {
    /// Classify an [`io::Error`] observed while inspecting `path`.
    pub(crate) fn from_io(path: &Path, err: io::Error) -> Self {
        match err.kind() {
            io::ErrorKind::NotFound => Self::NotFound(path.to_path_buf()),
            io::ErrorKind::PermissionDenied => Self::PermissionDenied(path.to_path_buf()),
            _ => Self::Io(err),
        }
    }

    /// Classify a [`notify::Error`] observed while (un)watching `path`.
    ///
    /// `notify` reports "no such watch" and "no such path" through distinct kinds but both are
    /// the same actionable condition for a caller, so both become [`WatchError::NotFound`].
    pub(crate) fn from_notify(path: &Path, err: notify::Error) -> Self {
        match err.kind {
            notify::ErrorKind::PathNotFound | notify::ErrorKind::WatchNotFound => {
                Self::NotFound(path.to_path_buf())
            }
            notify::ErrorKind::MaxFilesWatch => Self::WatchLimitExceeded(path.to_path_buf()),
            notify::ErrorKind::Io(io) => Self::from_io(path, io),
            _ => Self::Backend(err),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn io_not_found_maps_to_not_found() {
        let err = WatchError::from_io(Path::new("/nope"), io::Error::from(io::ErrorKind::NotFound));
        assert!(matches!(err, WatchError::NotFound(p) if p == Path::new("/nope")));
    }

    #[test]
    fn io_permission_denied_maps_to_permission_denied() {
        let err = WatchError::from_io(
            Path::new("/root/secret"),
            io::Error::from(io::ErrorKind::PermissionDenied),
        );
        assert!(matches!(err, WatchError::PermissionDenied(_)));
    }

    #[test]
    fn other_io_errors_stay_io() {
        let err = WatchError::from_io(Path::new("/x"), io::Error::from(io::ErrorKind::WouldBlock));
        assert!(matches!(err, WatchError::Io(_)));
    }

    #[test]
    fn notify_watch_not_found_maps_to_not_found() {
        let err = WatchError::from_notify(Path::new("/x"), notify::Error::watch_not_found());
        assert!(matches!(err, WatchError::NotFound(_)));
    }

    #[test]
    fn notify_max_files_maps_to_limit_with_remediation() {
        let err = WatchError::from_notify(
            Path::new("/x"),
            notify::Error::new(notify::ErrorKind::MaxFilesWatch),
        );
        assert!(matches!(err, WatchError::WatchLimitExceeded(_)));
        // The remediation hint is part of the contract: it is frequently the only thing a
        // user sees in a dev-server log.
        assert!(err.to_string().contains("fs.inotify.max_user_watches"));
    }

    #[test]
    fn notify_generic_stays_backend() {
        let err = WatchError::from_notify(Path::new("/x"), notify::Error::generic("boom"));
        assert!(matches!(err, WatchError::Backend(_)));
    }

    #[test]
    fn lifecycle_variants_render() {
        assert_eq!(
            WatchError::AlreadyRunning.to_string(),
            "watcher is already running"
        );
        assert_eq!(WatchError::NotRunning.to_string(), "watcher is not running");
    }
}
