//! A path-keyed map that holds a hard ceiling and gives its memory back.
//!
//! Every map in this crate keyed by a path the *file system* chose is a memory liability: the key
//! space is whatever the tree contains, and the write rate is whatever an editor, a build tool, or
//! an agent rewriting a directory decides. Two such maps exist — the watcher's delivery ledger and
//! the processor's fingerprint cache — and both are [`BoundedMap`].
//!
//! # Why not prune by age, or evict a sample
//!
//! The two obvious policies both fail on the workload this crate exists for — a large tree
//! changing all at once:
//!
//! - **Prune entries older than a cutoff.** When more distinct paths change *inside* the cutoff
//!   than the cap allows, the scan frees nothing, the map grows past its cap anyway, and every
//!   later insert pays another O(n) scan. Cost becomes quadratic exactly when the tree is busiest.
//!   A `git checkout`, an `npm install`, or an agent regenerating a directory is not an edge case.
//! - **Sample, sort by age, remove the oldest.** Bounded per call, but the candidate buffer is
//!   proportional to the overshoot, so relieving pressure on a large map means a large transient
//!   allocation and a sort — an allocation spike triggered by memory pressure.
//!
//! Neither returns capacity: a `HashMap` keeps its buckets after `retain` and after `clear`, so one
//! burst raises the floor for the life of the process.
//!
//! # The policy
//!
//! Two generations. Reads consult both; writes only ever land in `fresh`. When `fresh` reaches the
//! per-generation limit it becomes `aging`, and the generation behind it is **dropped** — which
//! releases its keys and its buckets in one move.
//!
//! - **A hard ceiling**, not a soft target: `fresh.len() + aging.len() <= 2 * generation` at every
//!   instant, enforced without scanning anything.
//! - **O(1) worst case** per insert: no scan, no sort, no transient buffer.
//! - **Capacity comes back** on every rotation, so a burst costs a burst's memory rather than a
//!   permanent floor.
//!
//! What rotation costs is *forgetting*, so it is worth being exact about what forgetting means at
//! each call site. Both are fail-safe, in the direction this crate already fails when its queue
//! overflows:
//!
//! - dropping a ledger entry can only cause an event to be **delivered** that would have been
//!   suppressed — a redundant wake-up, never a missed change;
//! - dropping a fingerprint can only cause a file to be **re-hashed** and reported changed — a
//!   redundant rebuild, never a missed one.
//!
//! What ages out is the generation that has *not been written to lately*, which is what makes the
//! forgetting cheap rather than merely bounded — but it puts a requirement on the caller: to keep an
//! entry, re-[`insert`](BoundedMap::insert) it whenever it is used. Both call sites do, which is why
//! the file someone is actively editing — the one path guaranteed to be accompanied by churn
//! elsewhere — is never the entry that gets dropped.
//!
//! # No interior locking
//!
//! This type takes no lock of its own, because a sharded concurrent map cannot honour the ceiling
//! above. Any check-then-insert that does not hold an exclusive lock lets every racing writer past
//! the length check before one of them rotates, so the ceiling is exceeded by the number of
//! concurrent writers — which is a bound on nothing, since it grows with the thread count. That was
//! measured here, not assumed: a sharded first draft of this module failed its own ceiling
//! assertion at 513 entries with a cap of 512 and eight writers.
//!
//! Serialising costs nothing at either call site. The processor holds this lock for two map
//! operations either side of *hashing a file*, so the work it serialises against is I/O measured in
//! microseconds while an uncontended [`parking_lot::Mutex`] round trip is measured in nanoseconds;
//! the watcher's ledger is already inside a mutex for its own reasons.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Approximate heap cost of one stored entry: the path's own bytes, the `PathBuf` that owns them,
/// and the value beside it.
///
/// Approximate by construction — a hash table's real per-entry overhead depends on a load factor
/// that is not observable — so this is for watching a growth trend, not for accounting to the byte.
fn entry_bytes<V>(path: &Path) -> usize {
    path.as_os_str().len() + std::mem::size_of::<PathBuf>() + std::mem::size_of::<V>()
}

/// A path-keyed map with a hard entry ceiling and O(1) worst-case insertion.
///
/// Not internally synchronised: hold it behind the caller's own lock. See the
/// [module documentation](self) for the eviction policy, what it trades away, and why it does not
/// lock itself.
pub(crate) struct BoundedMap<V> {
    fresh: HashMap<PathBuf, V>,
    aging: HashMap<PathBuf, V>,
    generation: usize,
}

impl<V> BoundedMap<V> {
    /// Build a map holding at most `ceiling` entries across both generations.
    ///
    /// A `ceiling` below two still yields a working map, holding one entry per generation.
    pub(crate) fn new(ceiling: usize) -> Self {
        Self {
            fresh: HashMap::new(),
            aging: HashMap::new(),
            generation: (ceiling / 2).max(1),
        }
    }

    /// The value stored for `path`, from whichever generation still holds it.
    pub(crate) fn get(&self, path: &Path) -> Option<&V> {
        self.fresh.get(path).or_else(|| self.aging.get(path))
    }

    /// Store `value` for `path`, retiring a generation if this write filled the current one.
    pub(crate) fn insert(&mut self, path: &Path, value: V) {
        self.fresh.insert(path.to_path_buf(), value);
        if self.fresh.len() >= self.generation {
            // Replacing rather than clearing is the point: the outgoing generation's buckets are
            // freed instead of being held for a burst that may never come again.
            self.aging =
                std::mem::replace(&mut self.fresh, HashMap::with_capacity(self.generation));
        }
    }

    /// Forget one path, in whichever generations hold it.
    pub(crate) fn remove(&mut self, path: &Path) {
        self.fresh.remove(path);
        self.aging.remove(path);
    }

    /// Forget every entry whose key `keep` rejects.
    ///
    /// The one operation here that is O(entries) rather than O(1), which is inherent: a hash map
    /// cannot answer a question about key prefixes without visiting the keys. Bounded by the
    /// ceiling, so its cost is capped even though its shape is a scan.
    pub(crate) fn retain_keys(&mut self, mut keep: impl FnMut(&Path) -> bool) {
        self.fresh.retain(|path, _| keep(path));
        self.aging.retain(|path, _| keep(path));
    }

    /// Forget every entry, returning all capacity.
    pub(crate) fn clear(&mut self) {
        self.fresh = HashMap::new();
        self.aging = HashMap::new();
    }

    /// Entries currently held across both generations.
    pub(crate) fn len(&self) -> usize {
        self.fresh.len() + self.aging.len()
    }

    /// Whether the map holds nothing.
    ///
    /// The counterpart `len` is expected to have (`clippy::len_without_is_empty`); the tests that
    /// prove `clear` gives everything back are its only callers so far.
    #[allow(dead_code)]
    pub(crate) fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Approximate heap bytes held by the stored entries.
    pub(crate) fn bytes(&self) -> usize {
        self.fresh
            .keys()
            .chain(self.aging.keys())
            .map(|path| entry_bytes::<V>(path))
            .sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The case a cutoff-based prune cannot bound: far more distinct keys than the ceiling, all
    /// arriving too fast for any of them to be old enough to discard.
    const FLOOD: usize = 200_000;

    #[test]
    fn a_stored_value_is_readable() {
        let mut map: BoundedMap<u64> = BoundedMap::new(64);
        assert_eq!(map.get(Path::new("/x/a")), None);
        map.insert(Path::new("/x/a"), 7);
        assert_eq!(map.get(Path::new("/x/a")), Some(&7));
    }

    #[test]
    fn a_value_survives_the_rotation_that_demotes_it() {
        // Demoted to the previous generation, it must still be found: a rotation may forget, but
        // never one generation early.
        let mut map: BoundedMap<u64> = BoundedMap::new(8);
        map.insert(Path::new("/x/hot"), 7);
        for i in 0..4 {
            map.insert(&PathBuf::from(format!("/x/other{i}")), i);
        }
        assert_eq!(map.get(Path::new("/x/hot")), Some(&7));
    }

    #[test]
    fn a_key_written_on_every_pass_is_never_forgotten() {
        // The hot-path guarantee the call sites rely on: an entry re-recorded on every event stays
        // in the newest generation, so the churn of a large tree cannot evict the file someone is
        // actually editing.
        let mut map: BoundedMap<u64> = BoundedMap::new(64);
        let hot = Path::new("/x/being-edited.ts");
        for i in 0..FLOOD {
            map.insert(&PathBuf::from(format!("/x/cold{i}")), 0);
            map.insert(hot, 1);
            assert_eq!(
                map.get(hot),
                Some(&1),
                "the actively written key vanished at insert {i}"
            );
        }
    }

    #[test]
    fn overwriting_a_key_does_not_double_count_it() {
        let mut map: BoundedMap<u64> = BoundedMap::new(64);
        for value in 0..10 {
            map.insert(Path::new("/x/a"), value);
        }
        assert_eq!(map.len(), 1);
        assert_eq!(map.get(Path::new("/x/a")), Some(&9));
    }

    #[test]
    fn the_ceiling_holds_when_every_key_is_brand_new() {
        const CEILING: usize = 512;
        let mut map: BoundedMap<u64> = BoundedMap::new(CEILING);
        for i in 0..FLOOD {
            map.insert(&PathBuf::from(format!("/repo/src/module{i}/index.ts")), 0);
            assert!(map.len() <= CEILING, "grew to {} at insert {i}", map.len());
        }
    }

    #[test]
    fn a_degenerate_ceiling_still_functions() {
        for ceiling in [0, 1, 2, 3] {
            let mut map: BoundedMap<u64> = BoundedMap::new(ceiling);
            for i in 0..100 {
                map.insert(&PathBuf::from(format!("/x/{i}")), i);
            }
            assert!(map.len() <= 2, "ceiling {ceiling} held {}", map.len());
            assert!(
                !map.is_empty(),
                "a map that drops everything is not a cache"
            );
        }
    }

    #[test]
    fn removal_and_retain_reach_both_generations() {
        let mut map: BoundedMap<u64> = BoundedMap::new(8);
        map.insert(Path::new("/keep/a"), 1);
        for i in 0..6 {
            map.insert(&PathBuf::from(format!("/drop/f{i}")), i);
        }
        map.retain_keys(|path| path.starts_with("/keep"));
        assert_eq!(map.get(Path::new("/keep/a")), Some(&1));
        assert_eq!(map.len(), 1);
        map.remove(Path::new("/keep/a"));
        assert!(map.is_empty());
    }

    #[test]
    fn clearing_releases_everything() {
        let mut map: BoundedMap<u64> = BoundedMap::new(1024);
        for i in 0..500 {
            map.insert(&PathBuf::from(format!("/x/{i}")), i);
        }
        assert!(!map.is_empty());
        map.clear();
        assert!(map.is_empty());
        assert_eq!(map.bytes(), 0);
    }

    #[test]
    fn byte_accounting_tracks_the_paths_actually_held() {
        let mut map: BoundedMap<u64> = BoundedMap::new(1024);
        assert_eq!(map.bytes(), 0);
        let long = "/a/reasonably/long/path/to/a/source/file.ts";
        map.insert(Path::new(long), 1);
        let one = map.bytes();
        assert!(one > long.len(), "the path's own bytes must be counted");
        map.insert(Path::new("/b/another/file.ts"), 2);
        assert!(map.bytes() > one);
    }

    /// Randomised operation sequences, checking the properties the call sites actually depend on.
    ///
    /// The hand-written tests above each pin one scenario; these assert the invariants hold for
    /// *any* interleaving, which is what a rotation bug would need to hide in — the failure mode of
    /// a two-generation map is a key and a value drifting apart across a rotation, and no fixed
    /// sequence is likely to catch that.
    mod properties {
        use super::*;
        use proptest::prelude::*;
        use std::collections::HashMap as RefMap;

        /// One call against the map under test.
        #[derive(Debug, Clone)]
        enum Op {
            Insert(u8, u64),
            Remove(u8),
            RetainEven,
            Clear,
        }

        fn op() -> impl Strategy<Value = Op> {
            prop_oneof![
                8 => (0u8..40, any::<u64>()).prop_map(|(key, value)| Op::Insert(key, value)),
                2 => (0u8..40).prop_map(Op::Remove),
                1 => Just(Op::RetainEven),
                1 => Just(Op::Clear),
            ]
        }

        /// Keys are `/p/<n>` so `retain_keys` has something structural to filter on.
        fn path_for(key: u8) -> PathBuf {
            PathBuf::from(format!("/p/{key}"))
        }

        proptest! {
            #[test]
            fn the_ceiling_and_value_integrity_survive_any_sequence(
                ceiling in 1usize..64,
                ops in prop::collection::vec(op(), 1..600),
            ) {
                let mut map: BoundedMap<u64> = BoundedMap::new(ceiling);
                // The last value written per key. A stored entry may be forgotten at any rotation,
                // but it must never come back holding some *other* key's value.
                let mut expected: RefMap<u8, u64> = RefMap::new();

                for op in ops {
                    match op {
                        Op::Insert(key, value) => {
                            map.insert(&path_for(key), value);
                            expected.insert(key, value);
                            prop_assert_eq!(
                                map.get(&path_for(key)),
                                Some(&value),
                                "a value must be readable immediately after it is written"
                            );
                        }
                        Op::Remove(key) => {
                            map.remove(&path_for(key));
                            expected.remove(&key);
                            prop_assert_eq!(map.get(&path_for(key)), None);
                        }
                        Op::RetainEven => {
                            map.retain_keys(|path| {
                                path.file_name()
                                    .and_then(|name| name.to_str())
                                    .and_then(|name| name.parse::<u8>().ok())
                                    .is_some_and(|key| key % 2 == 0)
                            });
                            expected.retain(|key, _| key % 2 == 0);
                            for key in (0u8..40).filter(|key| key % 2 == 1) {
                                prop_assert_eq!(map.get(&path_for(key)), None);
                            }
                        }
                        Op::Clear => {
                            map.clear();
                            expected.clear();
                            prop_assert!(map.is_empty());
                            prop_assert_eq!(map.bytes(), 0);
                        }
                    }

                    prop_assert!(
                        map.len() <= ceiling.max(2),
                        "held {} entries against a ceiling of {}",
                        map.len(),
                        ceiling
                    );
                    // Whatever survived must still agree with the last write for its key.
                    for (&key, &value) in &expected {
                        if let Some(&held) = map.get(&path_for(key)) {
                            prop_assert_eq!(
                                held,
                                value,
                                "key {} came back with a stale or foreign value",
                                key
                            );
                        }
                    }
                    // Nothing may materialise for a key that was never written or was removed.
                    for key in 0u8..40 {
                        if !expected.contains_key(&key) {
                            prop_assert_eq!(
                                map.get(&path_for(key)),
                                None,
                                "key {} appeared without being written",
                                key
                            );
                        }
                    }
                }
            }

            #[test]
            fn a_key_rewritten_every_step_is_always_present(
                ceiling in 1usize..64,
                cold_keys in 1usize..500,
            ) {
                // The agent-editing-one-file shape, over arbitrary ceilings and churn volumes.
                let mut map: BoundedMap<u64> = BoundedMap::new(ceiling);
                let hot = PathBuf::from("/hot/file.ts");
                for i in 0..cold_keys {
                    map.insert(&PathBuf::from(format!("/cold/{i}")), i as u64);
                    map.insert(&hot, 1);
                    prop_assert_eq!(map.get(&hot), Some(&1));
                }
            }
        }
    }

    #[test]
    fn accounted_bytes_stay_bounded_under_a_flood_of_long_paths() {
        // Growth in *bytes*, not just entry count: a ceiling on entries is worth little if the keys
        // are unbounded, and file system paths get long.
        const CEILING: usize = 256;
        let mut map: BoundedMap<u64> = BoundedMap::new(CEILING);
        let deep = "/very/deeply/nested/monorepo/packages/some-package/src/components";
        for i in 0..20_000 {
            map.insert(&PathBuf::from(format!("{deep}/Component{i}/index.tsx")), 0);
        }
        let ceiling_bytes = CEILING * (deep.len() + 64 + std::mem::size_of::<PathBuf>() + 8);
        assert!(
            map.bytes() <= ceiling_bytes,
            "held {} bytes, expected at most {ceiling_bytes}",
            map.bytes()
        );
    }
}
