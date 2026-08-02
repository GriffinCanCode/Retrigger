import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Must be set before the engine module resolves a binding.
process.env.RETRIGGER_NATIVE_PATH = path.join(HERE, 'helpers', 'mock-native.js');
process.env.RETRIGGER_SILENT = '1';

const { Retrigger } = await import('../lib/retrigger.js');
const { getEngine, resetEngineCache } = await import('../lib/engine.js');
const { resetNativeCache } = await import('../lib/native.js');
const { cleanupTempDirs } = await import('./helpers/tmp.js');
const { runEngineSuite } = await import('./shared/engine-suite.mjs');

afterAll(cleanupTempDirs);

/**
 * Engine table. Every entry inherits the entire shared suite.
 *
 * The third engine -- the compiled Rust addon -- lives in
 * `parity-native.test.mjs` rather than here. Which binary counts as "native"
 * is fixed by `RETRIGGER_NATIVE_PATH` before the loader's first call and then
 * memoised, so one process can only ever host one addon; a separate file is
 * how vitest gives it a separate process. That file runs this same suite.
 */
const ENGINES = [
  {
    name: 'javascript (fs.watch)',
    make: (options = {}) => new Retrigger({ ...options, engine: 'javascript' }),
  },
  {
    name: 'native (mock addon, stat diffing)',
    make: (options = {}) => new Retrigger({ ...options, engine: 'native' }),
  },
];

describe('the mock addon really is loaded as native', () => {
  it('resolves to the native engine, not a JavaScript stand-in', () => {
    resetNativeCache();
    resetEngineCache();
    const engine = getEngine({ prefer: 'native', fresh: true });
    expect(engine.name).toBe('native');
    expect(engine.getSimdSupport()).toBe('mock-simd');
    expect(engine.hashAlgorithm).toBe('mock-sha1-64');
  });

  it('uses a different hash algorithm from the JavaScript engine, and says so', () => {
    const native = getEngine({ prefer: 'native', fresh: true });
    const js = getEngine({ prefer: 'javascript', fresh: true });
    expect(native.hashAlgorithm).not.toBe(js.hashAlgorithm);
    const data = Buffer.from('cross-engine');
    // Digests are deliberately NOT compared for equality: the two engines use
    // different algorithms and the package documents that they are not
    // interchangeable. Only the shape is a shared contract.
    expect(native.hashBytesSync(data)).toMatch(/^[0-9a-f]{16}$/);
    expect(js.hashBytesSync(data)).toMatch(/^[0-9a-f]{16}$/);
    expect(native.hashBytesSync(data)).not.toBe(js.hashBytesSync(data));
  });
});

for (const engine of ENGINES) {
  runEngineSuite(engine.name, engine.make);
}
