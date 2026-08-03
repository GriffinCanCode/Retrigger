import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { cleanupTempDirs, tempDir, waitFor, writeFile } from './helpers/tmp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');

/**
 * The compiled Rust addon, if one has been built for this host -- the same lookup
 * `parity-native.test.mjs` and `hash.test.mjs` use, duplicated rather than shared for the same
 * reason `hash.test.mjs` gives: this file has no other reason to touch `lib/native.js` or
 * `RETRIGGER_NATIVE_PATH`.
 * @returns {string|null}
 */
function findAddon() {
  const triples = {
    darwin: ['darwin-arm64', 'darwin-x64'],
    win32: ['win32-x64-msvc', 'win32-arm64-msvc'],
    linux: [
      'linux-x64-gnu',
      'linux-x64-musl',
      'linux-arm64-gnu',
      'linux-arm64-musl',
      'linux-arm-gnueabihf',
      'linux-ppc64-gnu',
    ],
    freebsd: ['freebsd-x64'],
  }[process.platform];
  for (const triple of triples || []) {
    const candidate = path.join(PKG_ROOT, `retrigger-nodejs-bindings.${triple}.node`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const ADDON = findAddon();

// Must be set before `lib/engine.js` resolves a binding, matching `parity-native.test.mjs`.
if (ADDON) process.env.RETRIGGER_NATIVE_PATH = ADDON;
process.env.RETRIGGER_SILENT = '1';

const { Retrigger } = await import('../lib/retrigger.js');

afterAll(cleanupTempDirs);

/** Short enough to keep the suite fast; matches `polling.rs`'s own `POLL_INTERVAL`. */
const POLL_INTERVAL_MS = 50;

/**
 * `backend: { mode: 'poll', compareContents: true }` threaded from JS through N-API into the
 * compiled addon's `BackendMode::Poll { compare_contents: true, .. }` -- `polling.rs` already
 * proves the Rust side of this at the crate level; this is the missing Node-level confirmation
 * that the option actually reaches it rather than being silently dropped somewhere in the
 * `Retrigger` -> `WatcherOptions` -> `backend_mode()` chain.
 */
describe.skipIf(!ADDON)('backend: { mode: "poll", compareContents: true } (native addon)', () => {
  /** @type {Retrigger[]} */
  const open = [];
  afterEach(() => {
    while (open.length) open.pop().close();
  });

  it('reports the poll backend and catches a same-size rewrite within one mtime tick', async () => {
    const dir = tempDir();
    const target = path.join(dir, 'config.json');
    writeFile(target, '{"v":1}');

    const watcher = new Retrigger({
      paths: dir,
      engine: 'native',
      debounceMs: 0,
      backend: { mode: 'poll', pollIntervalMs: POLL_INTERVAL_MS, compareContents: true },
    });
    const events = [];
    watcher.on('all', (e) => events.push(e));
    watcher.start();
    open.push(watcher);

    // Proves `backend: { mode: 'poll' }` really engaged the portable backend rather than being
    // ignored in favour of the platform-native one.
    expect(watcher.getStats().backend).toBe('polling');
    expect(watcher.getEngineInfo().engine).toBe('native');

    // Same size, so only content comparison -- not size/mtime alone -- can promise the rewrite is
    // caught regardless of this file system's mtime resolution. The canonical case
    // `compareContents` exists for: an atomic rename-over-existing (see `polling.rs`'s
    // `an_atomic_save_over_an_existing_file_is_reported_under_poll`).
    const tmp = path.join(dir, 'config.json.tmp');
    writeFile(tmp, '{"v":2}');
    fs.renameSync(tmp, target);

    const detected = await waitFor(
      () => events.find((e) => e.path === target && (e.kind === 'modified' || e.kind === 'renamedTo')),
      {
        timeout: 15000,
        interval: POLL_INTERVAL_MS,
        message: 'a same-size rewrite under the poll backend was never detected',
      }
    );
    expect(detected).toBeTruthy();
  });
});
