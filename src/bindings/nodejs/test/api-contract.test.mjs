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
      ['backend', 'engine', 'hashAlgorithm', 'nativeAttempts', 'platform', 'reason', 'simd'].sort()
    );
    expect(['native', 'javascript']).toContain(info.engine);
    expect(typeof info.backend).toBe('string');
    expect(typeof info.reason).toBe('string');
    expect(typeof info.hashAlgorithm).toBe('string');
    expect(Array.isArray(info.nativeAttempts)).toBe(true);
  });

  it('chains the fluent methods', () => {
    expect(watcher.start()).toBe(watcher);
    expect(watcher.stop()).toBe(watcher);
    expect(watcher.close()).toBe(watcher);
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
