//! The event type delivered to consumers.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// What happened to a path.
///
/// This is a deliberately small, backend-independent vocabulary: `notify`'s much richer
/// [`notify::EventKind`] is collapsed onto these seven cases so consumers do not have to
/// reason about platform quirks. See [`crate::Watcher`] for the exact mapping table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum EventKind {
    /// The path came into existence.
    Created,
    /// The contents of the path changed.
    Modified,
    /// The path was removed.
    Deleted,
    /// The path is the *source* of a rename (it no longer exists under this name).
    RenamedFrom,
    /// The path is the *destination* of a rename.
    RenamedTo,
    /// Metadata changed (mode, ownership, times, extended attributes) but not contents.
    Metadata,
    /// Events were lost and the consumer must re-scan to regain correctness.
    ///
    /// Emitted when the bounded queue overflows, when the kernel reports an overflow
    /// (`IN_Q_OVERFLOW` on Linux, `kFSEventStreamEventFlagMustScanSubDirs` on macOS), or when a
    /// watch could not be installed because the kernel watch limit was reached.
    RescanRequired,
}

impl EventKind {
    /// Whether this kind belongs to the coalescable class: "the path exists and something about
    /// its contents was touched".
    ///
    /// [`Created`](Self::Created), [`Modified`](Self::Modified) and [`Metadata`](Self::Metadata)
    /// are members. One event of this class is only ever collapsed into *another* member of the
    /// same class within the debounce window, so a burst of write/metadata/close noise — or, on
    /// macOS, the repeated `ITEM_CREATED` that `FSEvents` reports for successive writes to one path
    /// — becomes a single wake-up.
    ///
    /// Deletes and renames are *not* members. Collapsing them would change what the stream means
    /// rather than how often it fires, and a delete following a write, or a create following a
    /// delete, is always delivered. See [`crate::WatcherConfig::debounce`].
    #[must_use]
    pub const fn is_coalescable(self) -> bool {
        matches!(self, Self::Created | Self::Modified | Self::Metadata)
    }

    /// Whether this kind indicates the path no longer exists under that name.
    #[must_use]
    pub const fn is_removal(self) -> bool {
        matches!(self, Self::Deleted | Self::RenamedFrom)
    }

    /// Whether this kind announces that the path has arrived, as opposed to changed.
    ///
    /// The distinction decides whether a consumer has been told the path is *new*. A
    /// [`Modified`](Self::Modified) is not an announcement: a consumer that has never heard of the
    /// path has no reason to act on a change to it, which is why reconciliation restates an arrival
    /// that only a write happened to reach first.
    #[must_use]
    pub const fn is_arrival(self) -> bool {
        matches!(self, Self::Created | Self::RenamedTo)
    }
}

/// A single file system change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileEvent {
    /// Absolute path the event refers to.
    ///
    /// On macOS this is the path as `FSEvents` reports it, which is fully resolved
    /// (`/private/var/...` rather than `/var/...`). Compare paths with care, or canonicalize
    /// the roots you pass to [`crate::Watcher::watch`] first.
    ///
    /// Empty for [`EventKind::RescanRequired`], which refers to the whole watch set rather than
    /// one path.
    pub path: PathBuf,
    /// What happened.
    pub kind: EventKind,
    /// Wall-clock time the event was observed, in nanoseconds since the Unix epoch.
    ///
    /// This is the time *this crate* saw the event, not a kernel timestamp: no supported
    /// backend provides one. Zero if the system clock is before the Unix epoch.
    pub timestamp_ns: u64,
    /// Size of the file in bytes; `0` when unknown, when the path is a directory, or when the
    /// path no longer exists (deletes and rename sources).
    pub size: u64,
    /// Whether the path is (or, for removals, was reported by the backend as) a directory.
    ///
    /// For a removal the backend hint is used when present; otherwise this is `false`, because
    /// the path can no longer be inspected.
    pub is_directory: bool,
    /// Correlates [`EventKind::RenamedFrom`] with its matching [`EventKind::RenamedTo`].
    ///
    /// Available on Linux only (inotify's rename cookie). macOS `FSEvents` and Windows
    /// `ReadDirectoryChangesW` provide no correlation identifier, so this is `None` there.
    pub cookie: Option<u64>,
}

impl FileEvent {
    /// Build an event for `path`, stamping it with the current wall-clock time.
    pub(crate) fn new(path: PathBuf, kind: EventKind, size: u64, is_directory: bool) -> Self {
        Self {
            path,
            kind,
            timestamp_ns: now_ns(),
            size,
            is_directory,
            cookie: None,
        }
    }

    /// Attach a rename correlation cookie.
    pub(crate) fn with_cookie(mut self, cookie: Option<u64>) -> Self {
        self.cookie = cookie;
        self
    }

    /// Build the "you must re-scan" signal.
    pub(crate) fn rescan() -> Self {
        Self::new(PathBuf::new(), EventKind::RescanRequired, 0, false)
    }

    /// Whether this event is the [`EventKind::RescanRequired`] signal.
    #[must_use]
    pub fn is_rescan(&self) -> bool {
        self.kind == EventKind::RescanRequired
    }

    /// The event's path as a [`Path`].
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// Current wall-clock time in nanoseconds since the Unix epoch, saturating at `0`.
pub(crate) fn now_ns() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_nanos()).unwrap_or(u64::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_coalescable_class_is_create_modify_metadata() {
        for kind in [EventKind::Created, EventKind::Modified, EventKind::Metadata] {
            assert!(kind.is_coalescable(), "{kind:?} should be coalescable");
        }
        for kind in [
            EventKind::Deleted,
            EventKind::RenamedFrom,
            EventKind::RenamedTo,
            EventKind::RescanRequired,
        ] {
            assert!(
                !kind.is_coalescable(),
                "{kind:?} changes what the stream means and must never be coalesced"
            );
        }
    }

    #[test]
    fn removals_are_delete_and_rename_source() {
        assert!(EventKind::Deleted.is_removal());
        assert!(EventKind::RenamedFrom.is_removal());
        assert!(!EventKind::RenamedTo.is_removal());
        assert!(!EventKind::Created.is_removal());
    }

    #[test]
    fn rescan_has_empty_path_and_is_flagged() {
        let ev = FileEvent::rescan();
        assert!(ev.is_rescan());
        assert_eq!(ev.path, PathBuf::new());
        assert_eq!(ev.size, 0);
        assert!(!ev.is_directory);
        assert_eq!(ev.cookie, None);
    }

    #[test]
    fn timestamps_are_after_2020() {
        // 2020-01-01T00:00:00Z in nanoseconds. Guards against a unit mix-up (ms vs ns), which
        // is exactly the class of bug the deleted FFI layer shipped.
        const Y2020_NS: u64 = 1_577_836_800_000_000_000;
        assert!(now_ns() > Y2020_NS);
    }

    #[test]
    fn cookie_round_trips() {
        let ev = FileEvent::new("/a".into(), EventKind::RenamedFrom, 0, false).with_cookie(Some(7));
        assert_eq!(ev.cookie, Some(7));
    }

    #[test]
    fn events_serialize_round_trip() {
        let ev = FileEvent::new("/a/b.txt".into(), EventKind::Modified, 12, false);
        let json = serde_json::to_string(&ev).expect("serialize");
        let back: FileEvent = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(ev, back);
    }
}
