# Idea

**Skip byte-identical rebuilds.** Editors, formatters, generators, and branch switches
often rewrite a file with the same bytes. A stock Vite or webpack watcher still rebuilds.
Retrigger hashes each changed path with XXH3-64 and withholds the event when the digest
matches, so those no-ops cost nothing.

Raw per-event latency is not the goal and is not the win: Retrigger honestly trails a
light watcher like Chokidar on single-event p50. The trade is a few milliseconds of watch
latency for skipping entire rebuilds — the right trade for dev-server rebuild suppression.

Everything else in the tree (platform watchers, native + WASM hashing, bundler plugins,
snapshots, optional daemon, Watchman, chokidar adapter) exists to deliver that gate
reliably across engines and machines. Turbopack is out of scope until upstream exposes a
watcher or veto seam; Next.js is supported in webpack mode today.
