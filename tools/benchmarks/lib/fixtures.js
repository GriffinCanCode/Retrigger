'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/**
 * Deterministic PRNG (mulberry32) seeded for reproducible fixture bytes.
 * @param {number} seed
 */
function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function tempDir(prefix = 'retrigger-bench-') {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

/**
 * Tiny Vite app used by the rebuild-time lab.
 * @param {{seed?: number}} [opts]
 */
function viteFixture(opts = {}) {
  const seed = opts.seed ?? 0x51a7e;
  const dir = tempDir('retrigger-bench-vite-');
  writeFile(
    path.join(dir, 'index.html'),
    '<!doctype html><html><body><script type="module" src="/main.js"></script></body></html>\n'
  );
  writeFile(path.join(dir, 'main.js'), "import { n } from './mod.js';\nconsole.log(n);\n");
  const modBody = 'export const n = 1;\n';
  writeFile(path.join(dir, 'mod.js'), modBody);
  // Extra modules so the graph is non-trivial but still fast.
  const rand = mulberry32(seed);
  for (let i = 0; i < 8; i += 1) {
    writeFile(
      path.join(dir, `util-${i}.js`),
      `export const u${i} = ${Math.floor(rand() * 1000)};\n`
    );
  }
  return {
    dir,
    main: path.join(dir, 'main.js'),
    mod: path.join(dir, 'mod.js'),
    modBody,
  };
}

/**
 * Tiny webpack project for the rebuild-time lab.
 * @param {{seed?: number}} [opts]
 */
function webpackFixture(opts = {}) {
  const seed = opts.seed ?? 0x77ebc;
  const dir = tempDir('retrigger-bench-wp-');
  const src = path.join(dir, 'src');
  writeFile(path.join(src, 'entry.js'), "import { value } from './dep.js';\nconsole.log(value);\n");
  const depBody = 'export const value = 1;\n';
  writeFile(path.join(src, 'dep.js'), depBody);
  const rand = mulberry32(seed);
  for (let i = 0; i < 8; i += 1) {
    writeFile(
      path.join(src, `lib-${i}.js`),
      `export const l${i} = ${Math.floor(rand() * 1000)};\n`
    );
  }
  return {
    dir,
    src,
    entry: path.join(src, 'entry.js'),
    dep: path.join(src, 'dep.js'),
    depBody,
  };
}

/**
 * Large tree for crawl / monorepo / storm scenarios.
 * Layout: packages/pkg-N/src/file-M.js
 * @param {{dirs?: number, filesPerDir?: number, bytesPerFile?: number, seed?: number}} [opts]
 */
function largeTree(opts = {}) {
  const dirs = opts.dirs ?? 40;
  const filesPerDir = opts.filesPerDir ?? 50;
  const bytesPerFile = opts.bytesPerFile ?? 256;
  const seed = opts.seed ?? 0xc0ffee;
  const rand = mulberry32(seed);
  const root = tempDir('retrigger-bench-tree-');
  const files = [];
  for (let d = 0; d < dirs; d += 1) {
    const pkg = path.join(root, 'packages', `pkg-${String(d).padStart(3, '0')}`, 'src');
    for (let f = 0; f < filesPerDir; f += 1) {
      const file = path.join(pkg, `file-${String(f).padStart(3, '0')}.js`);
      const body = Buffer.alloc(bytesPerFile);
      for (let i = 0; i < bytesPerFile; i += 1) body[i] = Math.floor(rand() * 256);
      // Stable printable header so content is identifiable.
      const header = Buffer.from(`// pkg=${d} file=${f} seed=${seed}\n`);
      header.copy(body, 0);
      writeFile(file, body);
      files.push(file);
    }
  }
  return {
    root,
    files,
    fileCount: files.length,
    dirs,
    filesPerDir,
    bytesPerFile,
    seed,
  };
}

/**
 * Flat watch-latency fixture (existing suite shape).
 * @param {{fileCount?: number, seed?: number}} [opts]
 */
function watchFixture(opts = {}) {
  const fileCount = opts.fileCount ?? 200;
  const seed = opts.seed ?? 0x71a7;
  const dir = tempDir('retrigger-bench-watch-');
  for (let i = 0; i < fileCount; i += 1) {
    writeFile(path.join(dir, `file-${i}.js`), `export const v = ${i};\n// seed=${seed}\n`);
  }
  return { dir, fileCount, seed };
}

function rmTree(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/** Stable content fingerprint for asserting byte-identical rewrites. */
function digest(contents) {
  return crypto.createHash('sha256').update(contents).digest('hex').slice(0, 16);
}

module.exports = {
  mulberry32,
  tempDir,
  writeFile,
  viteFixture,
  webpackFixture,
  largeTree,
  watchFixture,
  rmTree,
  digest,
};
