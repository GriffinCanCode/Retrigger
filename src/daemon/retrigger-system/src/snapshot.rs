//! Point-in-time directory inventories, and comparing two of them.
//!
//! A watcher describes *changes*; sometimes a consumer needs the state those changes are relative
//! to — the first time a path is watched, or after a restart where the previous run's changes were
//! never durably recorded. [`Watcher::snapshot`] answers that by crawling the tree once, and
//! [`diff_snapshots`] turns two such crawls into the same [`FileEvent`] vocabulary a live watch
//! reports, so a consumer that lost its state can reconstruct what it missed without learning a
//! second API.
//!
//! Nothing here is persisted: a snapshot is a `Vec<SnapshotEntry>`, and keeping one around across a
//! restart — on disk, in a database, wherever — is entirely the caller's business. That is
//! deliberate; see [`diff_snapshots`].

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::WatchError;
use crate::event::{EventKind, FileEvent};
use crate::scan::{self, MAX_SNAPSHOT_ENTRIES};
use crate::watcher::Watcher;

/// The digest algorithm named by a [`SnapshotEnvelope`], today and for as long as this crate has
/// exactly one. Exists so a consumer can compare against a constant rather than a literal, and so
/// raising this crate's canonical algorithm later is a one-line change here.
pub const SNAPSHOT_ALGORITHM: &str = "xxh3-64";

/// Schema version of [`SnapshotEnvelope`] itself, bumped only when its *shape* changes in a way
/// that would break a consumer parsing an older persisted snapshot. Independent of
/// [`SNAPSHOT_ALGORITHM`], which can change without the envelope's fields doing so.
pub const SNAPSHOT_ENVELOPE_VERSION: u32 = 1;

/// A self-describing, portable form of a snapshot, suitable for persisting to disk or sending over
/// the wire (the daemon's `GET /snapshot` and the Node bindings' `snapshot`/`watchWithSnapshot`
/// both hand this shape back rather than a bare entry list).
///
/// "Self-describing" is the whole point: a snapshot loaded back after this crate has moved on to a
/// different digest or a different envelope shape must be able to say so rather than be
/// silently misread. Recording [`version`](Self::version) is what lets a future format change be
/// detected and rejected (or migrated) instead of guessed at from the JSON's shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnapshotEnvelope {
    /// The digest algorithm this envelope's format is defined in terms of. See
    /// [`SNAPSHOT_ALGORITHM`]; [`SnapshotEntry`] carries no digest today, but the field is here
    /// from the start so adding one later is not a breaking change to the envelope itself.
    pub algorithm: String,
    /// Schema version; see [`SNAPSHOT_ENVELOPE_VERSION`].
    pub version: u32,
    /// The inventory itself.
    pub entries: Vec<SnapshotEntry>,
}

impl SnapshotEnvelope {
    /// Wrap `entries` with this crate's current algorithm and envelope version.
    #[must_use]
    pub fn new(entries: Vec<SnapshotEntry>) -> Self {
        Self {
            algorithm: SNAPSHOT_ALGORITHM.to_owned(),
            version: SNAPSHOT_ENVELOPE_VERSION,
            entries,
        }
    }
}

/// One entry in a directory-tree inventory.
///
/// Deliberately smaller than [`FileEvent`]: a snapshot describes state, not a transition, so it
/// has no kind, no timestamp, and no rename cookie. [`diff_snapshots`] is what turns a pair of
/// these back into events.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnapshotEntry {
    /// Absolute path of the entry.
    pub path: PathBuf,
    /// Whether the entry is a directory.
    pub is_directory: bool,
    /// Size in bytes; always `0` for a directory.
    pub size: u64,
    /// Modification time in nanoseconds since the Unix epoch, when the file system reports one.
    pub modified_ns: Option<u64>,
}

impl From<scan::Inventoried> for SnapshotEntry {
    fn from(entry: scan::Inventoried) -> Self {
        Self {
            path: entry.path,
            is_directory: entry.is_directory,
            size: entry.size,
            modified_ns: entry.modified_ns,
        }
    }
}

impl Watcher {
    /// Crawl `path` and return an inventory of everything currently beneath it.
    ///
    /// Reuses the same bounded, symlink-safe walk [`crate::scan`] uses to reconcile a
    /// newly-watched directory, so the two can never disagree about what "the tree" means —
    /// unlike reconciliation, nothing here is pruned by this watcher's [`EventFilter`](crate::EventFilter):
    /// a snapshot describes the file system, and filtering what a caller does with that
    /// description is the caller's decision. `path` itself is not one of the returned entries.
    ///
    /// # Errors
    ///
    /// - [`WatchError::NotFound`] or [`WatchError::PermissionDenied`] if `path` cannot be
    ///   inspected.
    /// - [`WatchError::ScanTooLarge`] if the tree exceeds the entries this crate will hold in one
    ///   inventory.
    pub fn snapshot(&self, path: &Path) -> Result<Vec<SnapshotEntry>, WatchError> {
        self.core()
            .metadata(path)
            .map_err(|err| WatchError::from_io(path, err))?;
        scan::inventory(path, MAX_SNAPSHOT_ENTRIES)
            .map(|entries| entries.into_iter().map(SnapshotEntry::from).collect())
            .map_err(|_seen| WatchError::ScanTooLarge(path.to_path_buf()))
    }

    /// [`watch`](Self::watch) `path`, then [`snapshot`](Self::snapshot) it, with the watch
    /// registered *before* the crawl begins.
    ///
    /// Mirrors the ordering [`crate::scan`] relies on to reconcile a directory that appears inside
    /// a running watch: install the watch first, crawl second, so anything created during the
    /// crawl either lands in the inventory (the crawl reached it) or produces its own event once
    /// the backend sees it (the watch was already registered) — never neither. That guarantee
    /// holds only once the backend is attached; on a watcher that has not yet been
    /// [`start`](Self::start)ed, this call reserves the path's place in scope exactly as
    /// [`watch`](Self::watch) alone does, and the same documented gap between registering a path
    /// and `start` returning applies.
    ///
    /// # Errors
    ///
    /// Whatever [`watch`](Self::watch) or [`snapshot`](Self::snapshot) would return; watching is
    /// attempted first, so a path that cannot be watched is never partially snapshotted.
    pub fn watch_with_snapshot(
        &self,
        path: &Path,
        recursive: bool,
    ) -> Result<Vec<SnapshotEntry>, WatchError> {
        self.watch(path, recursive)?;
        self.snapshot(path)
    }
}

/// Compare two snapshots of the same root taken at different times and describe what changed, in
/// the same vocabulary a live watch reports.
///
/// Pure: no I/O, no persistent state, and no watcher — the caller decides how (or whether) to keep
/// a snapshot around between calls. That is what lets a consumer restart, load whatever it last
/// persisted, take a fresh snapshot, and diff the two to recover exactly the events it would have
/// missed while it was down, without this crate having an opinion about where that state lives.
///
/// For a path present in both, [`Modified`](EventKind::Modified) is reported when its size or
/// modification time differs and nothing is reported when they agree; a directory changes only by
/// modification time, since [`SnapshotEntry::size`] is always `0` for one. A path only in `new` is
/// [`Created`](EventKind::Created); a path only in `old` is [`Deleted`](EventKind::Deleted).
/// Timestamps on the returned events are stamped at call time, not inherited from either snapshot.
#[must_use]
pub fn diff_snapshots(old: &[SnapshotEntry], new: &[SnapshotEntry]) -> Vec<FileEvent> {
    use std::collections::HashMap;

    let before: HashMap<&Path, &SnapshotEntry> = old
        .iter()
        .map(|entry| (entry.path.as_path(), entry))
        .collect();
    let after: HashMap<&Path, &SnapshotEntry> = new
        .iter()
        .map(|entry| (entry.path.as_path(), entry))
        .collect();

    let mut events = Vec::new();
    for entry in new {
        match before.get(entry.path.as_path()) {
            None => events.push(FileEvent::new(
                entry.path.clone(),
                EventKind::Created,
                entry.size,
                entry.is_directory,
            )),
            Some(previous) => {
                if previous.size != entry.size || previous.modified_ns != entry.modified_ns {
                    events.push(FileEvent::new(
                        entry.path.clone(),
                        EventKind::Modified,
                        entry.size,
                        entry.is_directory,
                    ));
                }
            }
        }
    }
    for entry in old {
        if !after.contains_key(entry.path.as_path()) {
            events.push(FileEvent::new(
                entry.path.clone(),
                EventKind::Deleted,
                0,
                entry.is_directory,
            ));
        }
    }
    events
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str, is_directory: bool, size: u64, modified_ns: u64) -> SnapshotEntry {
        SnapshotEntry {
            path: PathBuf::from(path),
            is_directory,
            size,
            modified_ns: Some(modified_ns),
        }
    }

    #[test]
    fn identical_snapshots_produce_no_events() {
        let snap = vec![entry("/a", false, 4, 1), entry("/b", true, 0, 2)];
        assert!(diff_snapshots(&snap, &snap.clone()).is_empty());
    }

    #[test]
    fn a_new_path_is_created() {
        let old = vec![entry("/a", false, 4, 1)];
        let new = vec![entry("/a", false, 4, 1), entry("/b", false, 1, 2)];
        let events = diff_snapshots(&old, &new);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, EventKind::Created);
        assert_eq!(events[0].path, PathBuf::from("/b"));
    }

    #[test]
    fn a_missing_path_is_deleted() {
        let old = vec![entry("/a", false, 4, 1), entry("/b", false, 1, 2)];
        let new = vec![entry("/a", false, 4, 1)];
        let events = diff_snapshots(&old, &new);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, EventKind::Deleted);
        assert_eq!(events[0].path, PathBuf::from("/b"));
    }

    #[test]
    fn an_envelope_names_this_crates_current_algorithm_and_version() {
        let envelope = SnapshotEnvelope::new(vec![entry("/a", false, 4, 1)]);
        assert_eq!(envelope.algorithm, SNAPSHOT_ALGORITHM);
        assert_eq!(envelope.version, SNAPSHOT_ENVELOPE_VERSION);
        assert_eq!(envelope.entries.len(), 1);
    }

    #[test]
    fn a_changed_size_or_time_is_modified() {
        let old = vec![entry("/a", false, 4, 1)];
        assert_eq!(
            diff_snapshots(&old, &[entry("/a", false, 5, 1)])[0].kind,
            EventKind::Modified
        );
        assert_eq!(
            diff_snapshots(&old, &[entry("/a", false, 4, 2)])[0].kind,
            EventKind::Modified
        );
    }
}
