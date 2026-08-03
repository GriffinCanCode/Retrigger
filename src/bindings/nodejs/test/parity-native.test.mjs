/**
 * The third entry in the parity table: the compiled Rust addon.
 *
 * `parity.test.mjs` proves the JavaScript fallback and the mock agree. This
 * file runs the *same* suite against the binary this package actually ships,
 * which is the only thing that turns "the fallback is a substitute for the
 * native engine" from a design intention into a measurement.
 *
 * It is a separate file because `RETRIGGER_NATIVE_PATH` is read once and the
 * resulting binding is memoised: a process can host the mock or the real
 * addon, not both. Vitest isolates files, so a file is the unit of "which
 * addon is native here".
 *
 * Skipped in full when no binary has been built for this host -- `npm run
 * build` first, and note that a green run without it proves nothing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');

const TRIPLES = {
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
};

/** @returns {string|null} the addon built for this host, if any */
function findAddon() {
  for (const triple of TRIPLES[process.platform] || []) {
    const candidate = path.join(PKG_ROOT, `retrigger-nodejs-bindings.${triple}.node`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const ADDON = findAddon();

// Must be set before the engine module resolves a binding.
if (ADDON) process.env.RETRIGGER_NATIVE_PATH = ADDON;
process.env.RETRIGGER_SILENT = '1';

const { Retrigger } = await import('../lib/retrigger.js');
const { getEngine, resetEngineCache } = await import('../lib/engine.js');
const { resetNativeCache } = await import('../lib/native.js');
const { cleanupTempDirs } = await import('./helpers/tmp.js');
const { runEngineSuite } = await import('./shared/engine-suite.mjs');

afterAll(cleanupTempDirs);

describe.skipIf(!ADDON)('the addon under test really is the compiled Rust engine', () => {
  it('is the native engine, not the fallback and not the mock', () => {
    resetNativeCache();
    resetEngineCache();
    const engine = getEngine({ prefer: 'native', fresh: true });
    expect(engine.name).toBe('native');
    expect(engine.reason).toContain(ADDON);
    expect(engine.getSimdSupport()).not.toBe('mock-simd');
  });

  it('hashes with genuine xxh3-64', () => {
    const engine = getEngine({ prefer: 'native', fresh: true });
    expect(engine.hashAlgorithm).toBe('xxh3-64');
    // Canonical XXH3-64 digests. These are the published vectors, not values
    // read back from this implementation, so they fail if the engine is ever
    // swapped for something that merely produces 16 hex characters.
    expect(engine.hashBytesSync(Buffer.alloc(0))).toBe('2d06800538d394c2');
    expect(engine.hashBytesSync(Buffer.from('abc'))).toBe('78af5f94892f3950');
  });

  it('watches through a real OS backend rather than polling', () => {
    const watcher = new Retrigger({ engine: 'native' });
    try {
      expect(watcher.getStats().backend).not.toBe('polling');
      expect(watcher.getStats().engine).toBe('native');
    } finally {
      watcher.close();
    }
  });
});

if (ADDON) {
  runEngineSuite('native (real addon, xxh3-64)', (options = {}) => {
    return new Retrigger({ ...options, engine: 'native' });
  });
}
