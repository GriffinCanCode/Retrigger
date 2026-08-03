import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import {
  checkContract,
  getCandidates,
  isMusl,
  loadNative,
  resetNativeCache,
} from '../lib/native.js';
import { getEngine, getEngineInfo, resetEngineCache } from '../lib/engine.js';
import { cleanupTempDirs, tempDir } from './helpers/tmp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');
const MOCK = path.join(HERE, 'helpers', 'mock-native.js');

/**
 * An override path that cannot resolve. `RETRIGGER_NATIVE_PATH` is exclusive,
 * so pointing it at a missing file reproduces "no native binary present"
 * regardless of whether this checkout happens to have one built beside it.
 */
const NO_BINARY = path.join(HERE, 'helpers', 'no-such-binding.node');

afterAll(cleanupTempDirs);

/** Minimal object satisfying the addon contract. */
function conformingBinding() {
  return {
    getSimdSupport: () => 'avx2',
    hashBytesSync: () => '0000000000000000',
    hashFileSync: () => ({ hash: '0000000000000000', size: 0 }),
    Watcher: class {},
  };
}

describe('loadNative', () => {
  it('returns the binding when a candidate loads and satisfies the contract', () => {
    const binding = conformingBinding();
    const result = loadNative({
      env: {},
      platform: 'linux',
      arch: 'x64',
      require: () => binding,
    });
    expect(result.binding).toBe(binding);
    expect(result.reason).toMatch(/loaded/);
  });

  it('falls back with a reason when no candidate exists', () => {
    const result = loadNative({
      env: {},
      platform: 'linux',
      arch: 'x64',
      require: () => {
        const err = new Error("Cannot find module '@retrigger/core-linux-x64-gnu'");
        err.code = 'MODULE_NOT_FOUND';
        throw err;
      },
    });
    expect(result.binding).toBeNull();
    expect(result.reason).toMatch(/native addon unavailable/);
    expect(result.attempts.length).toBeGreaterThan(0);
  });

  it('survives a candidate that throws a non-Error on load', () => {
    const result = loadNative({
      env: {},
      platform: 'linux',
      arch: 'x64',
      require: () => {
        // eslint-disable-next-line no-throw-literal
        throw 'dlopen exploded';
      },
    });
    expect(result.binding).toBeNull();
    expect(result.reason).toContain('dlopen exploded');
  });

  it('rejects a binary that loads but predates the current contract', () => {
    const stale = {
      getSimdSupport: () => 'neon',
      hashBytesSync: () => '',
      hashFileSync: () => ({}),
    };
    const result = loadNative({
      env: {},
      platform: 'darwin',
      arch: 'arm64',
      require: () => stale,
    });
    expect(result.binding).toBeNull();
    expect(result.reason).toContain('Watcher');
    expect(result.attempts[0].error).toMatch(/missing required export/);
  });

  it('reports unsupported platforms without throwing', () => {
    const result = loadNative({ env: {}, platform: 'sunos', arch: 'sparc64', require: () => {} });
    expect(result.binding).toBeNull();
    expect(result.reason).toBe('no native build is published for sunos-sparc64');
  });

  it('honours RETRIGGER_FORCE_JS without attempting any load', () => {
    let called = false;
    const result = loadNative({
      env: { RETRIGGER_FORCE_JS: '1' },
      platform: 'linux',
      arch: 'x64',
      require: () => {
        called = true;
        return conformingBinding();
      },
    });
    expect(called).toBe(false);
    expect(result.binding).toBeNull();
  });

  it('uses RETRIGGER_NATIVE_PATH as the first candidate', () => {
    const seen = [];
    loadNative({
      env: { RETRIGGER_NATIVE_PATH: '/tmp/custom.node' },
      platform: 'linux',
      arch: 'x64',
      require: (id) => {
        seen.push(id);
        throw new Error('nope');
      },
    });
    expect(seen[0]).toBe('/tmp/custom.node');
  });
});

describe('platform candidate table', () => {
  it('only attempts packages this package declares as optionalDependencies', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
    const declared = new Set(Object.keys(pkg.optionalDependencies));
    const attempted = new Set();
    for (const platform of ['darwin', 'win32', 'linux', 'freebsd']) {
      for (const arch of ['x64', 'arm64', 'arm', 'ia32', 'riscv64', 's390x', 'ppc64']) {
        const { candidates } = getCandidates({}, platform, arch);
        for (const c of candidates) if (c.type === 'package') attempted.add(c.id);
      }
    }
    expect([...attempted].sort()).toEqual([...declared].sort());
  });

  it('tries both libc variants on Linux so libc misdetection cannot break the install', () => {
    const { candidates } = getCandidates({}, 'linux', 'x64');
    const ids = candidates.filter((c) => c.type === 'package').map((c) => c.id);
    expect(ids).toContain('@retrigger/core-linux-x64-gnu');
    expect(ids).toContain('@retrigger/core-linux-x64-musl');
  });

  it('isMusl never throws and returns a boolean', () => {
    expect(typeof isMusl()).toBe('boolean');
  });
});

describe('checkContract', () => {
  it('names every missing member', () => {
    const { ok, missing } = checkContract({ getSimdSupport: () => '' });
    expect(ok).toBe(false);
    expect(missing).toEqual(['hashBytesSync', 'hashFileSync', 'Watcher']);
  });

  it('rejects non-objects', () => {
    expect(checkContract(null).ok).toBe(false);
    expect(checkContract(undefined).ok).toBe(false);
    expect(checkContract('nope').ok).toBe(false);
  });
});

describe('engine selection', () => {
  it('serves an explicit javascript request without consulting the addon', () => {
    const engine = getEngine({ prefer: 'javascript' });
    expect(engine.name).toBe('javascript');
    // Same algorithm as the native engine (see hash.test.mjs) -- what distinguishes this engine
    // is `name`/`backend`, not the digest it produces.
    expect(engine.hashAlgorithm).toBe('xxh3-64');
  });

  it('refuses a native request even after the JavaScript engine was memoised', () => {
    // Regression: the memoised engine used to short-circuit the check, so a
    // caller demanding `native` silently received the fallback instead.
    const previous = process.env.RETRIGGER_FORCE_JS;
    process.env.RETRIGGER_FORCE_JS = '1';
    resetNativeCache();
    resetEngineCache();
    try {
      expect(getEngine({ prefer: 'auto', env: { RETRIGGER_SILENT: '1' } }).name).toBe('javascript');
      let thrown = null;
      try {
        getEngine({ prefer: 'native' });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown.code).toBe('ERR_RETRIGGER_NO_NATIVE');
    } finally {
      if (previous === undefined) delete process.env.RETRIGGER_FORCE_JS;
      else process.env.RETRIGGER_FORCE_JS = previous;
      resetNativeCache();
      resetEngineCache();
    }
  });

  it('never throws from getEngineInfo', () => {
    resetEngineCache();
    const info = getEngineInfo();
    expect(['native', 'javascript']).toContain(info.engine);
    expect(typeof info.backend).toBe('string');
    expect(typeof info.reason).toBe('string');
    expect(Array.isArray(info.nativeAttempts)).toBe(true);
  });
});

/**
 * The headline guarantee. Each case runs in a clean child process so module
 * caching cannot mask a failure, and asserts both that `require` survived and
 * that `getEngineInfo()` describes what really happened.
 */
describe('require() never throws (subprocess)', () => {
  const script = (extra = '') => `
    const core = require(${JSON.stringify(PKG_ROOT)});
    const info = core.getEngineInfo();
    ${extra}
    process.stdout.write(JSON.stringify(info));
  `;

  function run(env) {
    const out = execFileSync(process.execPath, ['-e', script()], {
      encoding: 'utf8',
      env: { ...process.env, RETRIGGER_SILENT: '1', ...env },
    });
    return JSON.parse(out);
  }

  it('loads with no native binary present at all', () => {
    const info = run({ RETRIGGER_NATIVE_PATH: NO_BINARY });
    expect(info.engine).toBe('javascript');
    expect(info.backend).toBe('polling');
    // Same algorithm as the native engine would have reported (see hash.test.mjs).
    expect(info.hashAlgorithm).toBe('xxh3-64');
    expect(info.reason).toBeTruthy();
  });

  it('loads and reports "native" when a conforming addon is present', () => {
    const info = run({ RETRIGGER_NATIVE_PATH: MOCK });
    expect(info.engine).toBe('native');
    expect(info.hashAlgorithm).toBe('mock-sha1-64');
    expect(info.simd).toBe('mock-simd');
  });

  it('loads when the addon throws during its own evaluation', () => {
    const dir = tempDir('retrigger-throwing-');
    const bad = path.join(dir, 'throwing.js');
    fs.writeFileSync(bad, 'throw new Error("boom during addon init");');
    const info = run({ RETRIGGER_NATIVE_PATH: bad });
    expect(info.engine).toBe('javascript');
    expect(info.nativeAttempts).toHaveLength(1);
    expect(info.nativeAttempts[0].error).toContain('boom during addon init');
  });

  it('loads when the addon file is corrupt binary garbage', () => {
    const dir = tempDir('retrigger-corrupt-');
    const bad = path.join(dir, 'corrupt.node');
    fs.writeFileSync(bad, Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02, 0x03]));
    const info = run({ RETRIGGER_NATIVE_PATH: bad });
    expect(info.engine).toBe('javascript');
    expect(info.nativeAttempts[0].error).toBeTruthy();
  });

  it('loads when the addon exists but exports the wrong shape', () => {
    const dir = tempDir('retrigger-stale-');
    const bad = path.join(dir, 'stale.js');
    fs.writeFileSync(bad, 'module.exports = { RetriggerWrapper: class {}, hashBytesSync(){} };');
    const info = run({ RETRIGGER_NATIVE_PATH: bad });
    expect(info.engine).toBe('javascript');
    expect(info.reason).toContain('missing required export');
  });

  it('emits exactly one warning line on fallback, and none when silenced', () => {
    const args = ['-e', `require(${JSON.stringify(PKG_ROOT)}).getSimdSupport();`];
    const loud = spawnStderr(args, { RETRIGGER_SILENT: '0', RETRIGGER_NATIVE_PATH: NO_BINARY });
    expect(loud.split('\n').filter(Boolean)).toHaveLength(1);
    expect(loud).toContain('[retrigger]');
    expect(loud).not.toContain('at ');

    const quiet = spawnStderr(args, { RETRIGGER_SILENT: '1', RETRIGGER_NATIVE_PATH: NO_BINARY });
    expect(quiet.trim()).toBe('');
  });

  it('is importable as ESM', () => {
    const url = new URL(`file://${path.join(PKG_ROOT, 'index.mjs')}`).href;
    const out = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { createRetrigger, getEngineInfo } from ${JSON.stringify(url)};
         process.stdout.write(typeof createRetrigger + ':' + getEngineInfo().engine);`,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, RETRIGGER_SILENT: '1', RETRIGGER_NATIVE_PATH: NO_BINARY },
      }
    );
    expect(out).toBe('function:javascript');
  });
});

function spawnStderr(args, env) {
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  expect(result.status).toBe(0);
  return result.stderr;
}
