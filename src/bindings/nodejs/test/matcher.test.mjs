import { describe, expect, it } from 'vitest';

import { Matcher, compile } from '../lib/matcher.js';

describe('glob compilation', () => {
  const cases = [
    ['*.log', '/a/b/c.log', true],
    ['*.log', '/a/b/c.txt', false],
    ['**/node_modules/**', '/p/node_modules/x/y.js', true],
    ['**/node_modules/**', '/p/src/node_modules/deep/y.js', true],
    ['**/node_modules/**', '/p/src/nodemodules/y.js', false],
    ['src/**', 'src/a/b.js', true],
    ['src/**', 'other/a/b.js', false],
    ['src/*.js', 'src/a.js', true],
    // A single star must not cross a separator.
    ['src/*.js', 'src/nested/a.js', false],
    ['**/*.{ts,tsx}', '/p/a.ts', true],
    ['**/*.{ts,tsx}', '/p/a.tsx', true],
    ['**/*.{ts,tsx}', '/p/a.js', false],
    ['file?.js', '/p/file1.js', true],
    ['file?.js', '/p/file12.js', false],
    ['[abc].js', '/p/b.js', true],
    ['[abc].js', '/p/d.js', false],
    ['[!abc].js', '/p/d.js', true],
    // Regex metacharacters in a literal position stay literal.
    ['a+b.js', '/p/a+b.js', true],
    ['a+b.js', '/p/aab.js', false],
    ['a.b.js', '/p/aXb.js', false],
    // `**/` matches zero segments too.
    ['**/x.js', '/x.js', true],
    ['**/x.js', 'x.js', true],
  ];

  it.each(cases)('%s vs %s -> %s', (glob, target, expected) => {
    expect(compile(glob).test(target.replace(/\\/g, '/'))).toBe(expected);
  });

  it('treats an unterminated brace or bracket as a literal instead of throwing', () => {
    expect(() => compile('a{b.js')).not.toThrow();
    expect(() => compile('a[b.js')).not.toThrow();
    expect(compile('a{b.js').test('a{b.js')).toBe(true);
    expect(compile('a[b.js').test('a[b.js')).toBe(true);
  });
});

describe('Matcher', () => {
  it('accepts everything when no patterns are given', () => {
    const m = new Matcher();
    expect(m.isEmpty).toBe(true);
    expect(m.matches('/anything/at/all.js')).toBe(true);
  });

  it('requires an include match once includes are present', () => {
    const m = new Matcher({ include: ['**/*.ts'] });
    expect(m.matches('/p/a.ts')).toBe(true);
    expect(m.matches('/p/a.js')).toBe(false);
  });

  it('lets exclusion beat inclusion', () => {
    const m = new Matcher({ include: ['**/*.ts'], exclude: ['**/*.d.ts'] });
    expect(m.matches('/p/a.ts')).toBe(true);
    expect(m.matches('/p/a.d.ts')).toBe(false);
  });

  it('prunes a directory when a pattern excludes everything beneath it', () => {
    const m = new Matcher({ exclude: ['**/node_modules/**'] });
    expect(m.allowsDirectory('/p/node_modules')).toBe(false);
    expect(m.allowsDirectory('/p/node_modules/pkg')).toBe(false);
    expect(m.allowsDirectory('/p/src')).toBe(true);
  });

  it('never prunes a directory on include patterns alone', () => {
    // /p/src does not match `**/*.ts`, but it certainly contains .ts files.
    const m = new Matcher({ include: ['**/*.ts'] });
    expect(m.allowsDirectory('/p/src')).toBe(true);
  });

  it('normalises Windows separators before matching', () => {
    const m = new Matcher({ exclude: ['**/node_modules/**'] });
    expect(m.matches('C:\\p\\node_modules\\x\\y.js')).toBe(false);
    expect(m.matches('C:\\p\\src\\y.js')).toBe(true);
  });

  it('ignores empty and non-string patterns rather than crashing', () => {
    const m = new Matcher({ include: ['', null, undefined, 42, '**/*.js'], exclude: null });
    expect(m.include).toHaveLength(1);
    expect(m.matches('/p/a.js')).toBe(true);
  });

  it('accepts a bare string instead of an array', () => {
    const m = new Matcher({ exclude: '**/*.log' });
    expect(m.matches('/p/a.log')).toBe(false);
  });
});
