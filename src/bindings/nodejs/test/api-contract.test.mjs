import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');
const require = createRequire(import.meta.url);

process.env.RETRIGGER_SILENT = '1';
const core = require(PKG_ROOT);
const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
const readme = fs.readFileSync(path.join(PKG_ROOT, 'README.md'), 'utf8');
const dts = fs.readFileSync(path.join(PKG_ROOT, 'index.d.ts'), 'utf8');

/**
 * The documented surface, written down once. Everything below checks the
 * runtime, the type definitions and the README against this list, so a symbol
 * cannot be added to one without the others noticing.
 */
const SURFACE = {
  Retrigger: 'class',
  RetriggerWebpackPlugin: 'class',
  benchmarkHash: 'function',
  createRetrigger: 'function',
  createRetriggerVitePlugin: 'function',
  getAvailableLevels: 'function',
  getCpuLevel: 'function',
  getEngineInfo: 'function',
  getSimdSupport: 'function',
  hashBytesSync: 'function',
  hashFile: 'function',
  hashFileSync: 'function',
};

describe('public API surface', () => {
  it('exports exactly the documented symbols, no more and no fewer', () => {
    expect(Object.keys(core).sort()).toEqual(Object.keys(SURFACE).sort());
  });

  it.each(Object.entries(SURFACE))('%s is a callable %s', (name, kind) => {
    const value = core[name];
    expect(typeof value, `${name} is missing`).toBe('function');
    if (kind === 'class') {
      expect(/^class\s|^function\s/.test(value.toString())).toBe(true);
    }
  });

  it('declares every runtime export in index.d.ts', () => {
    const declared = new Set([
      ...[...dts.matchAll(/export declare (?:function|class)\s+(\w+)/g)].map((m) => m[1]),
    ]);
    for (const name of Object.keys(SURFACE)) {
      expect(declared.has(name), `${name} is exported but not declared in index.d.ts`).toBe(true);
    }
  });

  it('declares nothing in index.d.ts that the runtime does not export', () => {
    const declared = [...dts.matchAll(/export declare (?:function|class)\s+(\w+)/g)].map(
      (m) => m[1]
    );
    for (const name of declared) {
      expect(typeof core[name], `index.d.ts declares ${name}, runtime does not export it`).toBe(
        'function'
      );
    }
  });

  it('backs every symbol the README imports with a real export', () => {
    const named = new Set();
    for (const match of readme.matchAll(/(?:const|import)\s*\{([^}]+)\}\s*(?:=|from)/g)) {
      for (const raw of match[1].split(',')) {
        const name = raw
          .trim()
          .split(/\s+as\s+/)[0]
          .trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) named.add(name);
      }
    }
    // Sanity: the extraction must actually find something.
    expect(named.size).toBeGreaterThan(3);
    for (const name of named) {
      expect(typeof core[name], `README imports ${name}, which is not exported`).toBe('function');
    }
  });

  it('lists every export in the README API table', () => {
    for (const name of Object.keys(SURFACE)) {
      expect(readme.includes(`\`${name}`), `${name} is missing from the README table`).toBe(true);
    }
  });
});

describe('instance surface', () => {
  const watcher = core.createRetrigger({ engine: 'javascript' });

  it.each([
    'add',
    'watch',
    'unwatch',
    'snapshot',
    'watchWithSnapshot',
    'start',
    'stop',
    'close',
    'getStats',
    'getEngineInfo',
    'getSimdLevel',
    'on',
    'once',
    'off',
    'emit',
    'removeAllListeners',
  ])('Retrigger#%s is callable', (method) => {
    expect(typeof watcher[method]).toBe('function');
  });

  it('returns the documented shape from getEngineInfo()', () => {
    const info = core.getEngineInfo();
    expect(Object.keys(info).sort()).toEqual(
      [
        'backend',
        'engine',
        'hashAlgorithm',
        'nativeAttempts',
        'platform',
        'reason',
        'simd',
        'watchman',
      ].sort()
    );
    expect(['native', 'javascript']).toContain(info.engine);
    expect(typeof info.backend).toBe('string');
    expect(typeof info.reason).toBe('string');
    expect(typeof info.hashAlgorithm).toBe('string');
    expect(Array.isArray(info.nativeAttempts)).toBe(true);
    expect(typeof info.watchman.available).toBe('boolean');
    expect([null, 'fb-watchman', 'cli']).toContain(info.watchman.kind);
    expect(typeof info.watchman.reason).toBe('string');
  });

  it('chains the fluent methods', () => {
    expect(watcher.start()).toBe(watcher);
    expect(watcher.stop()).toBe(watcher);
    expect(watcher.close()).toBe(watcher);
  });
});

describe('options that came from a config file', () => {
  /**
   * Every value here is one somebody writes by accident: a trailing comma, an unset environment
   * variable, a knob set to zero because zero looked like "no limit". None of them can express an
   * intention, and none of them may cost the caller a working watcher — the native engine rejects
   * a glob list outright if one member is not a string, and a capacity of zero would bound the
   * drain loop to zero events while every counter still reported the watcher healthy.
   */
  it('drops list entries that cannot be patterns', () => {
    const w = core.createRetrigger({
      engine: 'javascript',
      include: ['**/*.js', null, undefined, '', 7],
      exclude: null,
    });
    expect(w.options.include).toEqual(['**/*.js']);
    expect(w.options.exclude).toEqual([]);
    w.close();
  });

  it('reads a size of zero as unspecified and a negative duration as none', () => {
    const w = core.createRetrigger({
      engine: 'javascript',
      capacity: 0,
      pollIntervalMs: -1,
      debounceMs: -5,
    });
    expect(w.options.capacity).toBe(8192);
    expect(w.options.pollIntervalMs).toBeGreaterThan(0);
    expect(w.options.debounceMs).toBe(0);
    // The engine's own queue is sized the same way; the two must not disagree, because the drain
    // loop is bounded by one of them and the queue by the other.
    expect(w.getStats().queueCapacity).toBe(w.options.capacity);
    w.close();
  });

  it('still honours the values a careful caller passes', () => {
    const w = core.createRetrigger({
      engine: 'javascript',
      capacity: 64,
      pollIntervalMs: 25,
      debounceMs: 30,
      include: ['src/**'],
    });
    expect(w.options.capacity).toBe(64);
    expect(w.options.pollIntervalMs).toBe(25);
    expect(w.options.debounceMs).toBe(30);
    expect(w.options.include).toEqual(['src/**']);
    w.close();
  });
});

describe('package manifest', () => {
  it('ships every file the exports map points at', () => {
    const targets = new Set();
    const walk = (node) => {
      if (typeof node === 'string') targets.add(node);
      else if (node && typeof node === 'object') Object.values(node).forEach(walk);
    };
    walk(pkg.exports);
    for (const target of targets) {
      expect(fs.existsSync(path.join(PKG_ROOT, target)), `${target} is missing`).toBe(true);
    }
  });

  it('points main, module and types at files that exist', () => {
    for (const key of ['main', 'module', 'types']) {
      expect(fs.existsSync(path.join(PKG_ROOT, pkg[key])), `${key}: ${pkg[key]}`).toBe(true);
    }
  });

  it('declares no runtime dependencies', () => {
    expect(pkg.dependencies ?? {}).toEqual({});
  });

  it('keeps every optionalDependency pinned to this package version', () => {
    for (const [name, range] of Object.entries(pkg.optionalDependencies)) {
      expect(range, `${name} should track ${pkg.version}`).toBe(pkg.version);
    }
  });

  // The two lists are one fact written twice: napi.targets is what the release
  // workflow builds, optionalDependencies is what an install will try to fetch.
  // They drifted apart once -- three platforms were declared for a year that no
  // job ever built, so those installs silently fell back to the JavaScript
  // engine -- and nothing failed, because nothing compared them.
  it('declares exactly the platforms it builds', () => {
    // The same mapping napi applies when it names a platform package. Spelled
    // out rather than parsed, so an unrecognised triple fails here instead of
    // being silently turned into a package name nobody publishes.
    const PACKAGE_FOR_TRIPLE = {
      'x86_64-apple-darwin': 'darwin-x64',
      'aarch64-apple-darwin': 'darwin-arm64',
      'x86_64-pc-windows-msvc': 'win32-x64-msvc',
      'aarch64-pc-windows-msvc': 'win32-arm64-msvc',
      'x86_64-unknown-linux-gnu': 'linux-x64-gnu',
      'aarch64-unknown-linux-gnu': 'linux-arm64-gnu',
      'x86_64-unknown-linux-musl': 'linux-x64-musl',
      'aarch64-unknown-linux-musl': 'linux-arm64-musl',
      'x86_64-unknown-freebsd': 'freebsd-x64',
      'armv7-unknown-linux-gnueabihf': 'linux-arm-gnueabihf',
      'powerpc64le-unknown-linux-gnu': 'linux-ppc64-gnu',
      's390x-unknown-linux-gnu': 'linux-s390x-gnu',
    };

    const built = pkg.napi.targets.map((triple) => {
      const suffix = PACKAGE_FOR_TRIPLE[triple];
      expect(suffix, `unknown target triple ${triple}`).toBeDefined();
      return `${pkg.name}-${suffix}`;
    });

    expect(built.sort()).toEqual(Object.keys(pkg.optionalDependencies).sort());
  });

  it('points every script at something that exists', () => {
    for (const [name, command] of Object.entries(pkg.scripts)) {
      // `node -e '...'` evaluates inline and names no file, so the first
      // argument is only a path when it is not a flag.
      const match = command.match(/^node\s+(?!-)(\S+)/);
      if (!match) continue;
      expect(fs.existsSync(path.resolve(PKG_ROOT, match[1])), `script "${name}"`).toBe(true);
    }
  });

  it('covers the exports map with the files allowlist', () => {
    const allow = pkg.files;
    const covered = (target) =>
      allow.some((entry) =>
        entry.endsWith('/') ? target.startsWith(`./${entry}`) : target === `./${entry}`
      ) || allow.includes(target.replace(/^\.\//, ''));
    const targets = [];
    const walk = (node) => {
      if (typeof node === 'string') targets.push(node);
      else if (node && typeof node === 'object') Object.values(node).forEach(walk);
    };
    walk(pkg.exports);
    for (const target of targets) {
      if (target === './package.json') continue;
      expect(covered(target), `${target} would not be published`).toBe(true);
    }
  });
});
