#!/usr/bin/env node
'use strict';

/**
 * Packaging proof.
 *
 * Packs the tarball npm would publish, installs it into an empty directory,
 * and exercises it from clean subprocesses. This is the direct answer to "does
 * it work when I install it somewhere else" — nothing here reaches back into
 * the source tree, and no native binary is present.
 *
 *   node scripts/verify-package.js [--keep]
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const PKG_ROOT = path.resolve(__dirname, '..');
const KEEP = process.argv.includes('--keep');

const checks = [];

function check(name, fn) {
  const started = Date.now();
  try {
    fn();
    checks.push({ name, ok: true, ms: Date.now() - started });
    console.log(`  ok    ${name}`);
  } catch (err) {
    checks.push({ name, ok: false, ms: Date.now() - started, error: err.message });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${String(err.message).split('\n').join('\n        ')}`);
  }
}

/** No step here may hang the caller; every subprocess gets a hard deadline. */
const NPM_TIMEOUT_MS = 180_000;
const NODE_TIMEOUT_MS = 30_000;

/**
 * npm is `npm.cmd` on Windows, and Node refuses to spawn a `.cmd` without a shell, so there the
 * command has to go through one. Its arguments then travel as a single command line rather than as
 * a vector, which is why they are quoted: every path passed below sits under the temp directory,
 * and on a machine whose user name contains a space one argument would otherwise arrive as two.
 */
function npm(args, cwd) {
  const windows = process.platform === 'win32';
  const result = spawnSync(
    windows ? 'npm.cmd' : 'npm',
    windows ? args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)) : args,
    {
      cwd,
      encoding: 'utf8',
      timeout: NPM_TIMEOUT_MS,
      shell: windows,
      env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
    }
  );
  if (result.error) throw new Error(`npm ${args.join(' ')}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(' ')} failed (${result.status})\n${result.stderr}`);
  }
  return result.stdout;
}

/**
 * Run a script inside the consumer directory, isolated from this repo.
 * @returns {{status: number, stdout: string, stderr: string}}
 */
function runInConsumer(consumer, script, { esm = false, env = {} } = {}) {
  const args = esm ? ['--input-type=module', '-e', script] : ['-e', script];
  return spawnSync(process.execPath, args, {
    cwd: consumer,
    encoding: 'utf8',
    timeout: NODE_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    env: {
      // A deliberately minimal environment: no inherited NODE_PATH, no
      // RETRIGGER_* overrides leaking in from the developer's shell.
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      SystemRoot: process.env.SystemRoot,
      ...env,
    },
  });
}

function expectClean(result, what) {
  if (result.error) throw new Error(`${what}: ${result.error.message}`);
  if (result.signal) throw new Error(`${what} was killed by ${result.signal} (timed out)`);
  if (result.status !== 0) {
    throw new Error(
      `${what} exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );
  }
  return result.stdout.trim();
}

function main() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'retrigger-pack-'));
  const consumer = path.join(workspace, 'consumer');
  fs.mkdirSync(consumer);

  console.log(`packaging proof in ${workspace}`);

  let tarball;
  try {
    console.log('\npacking');
    const output = npm(['pack', '--json', '--pack-destination', workspace], PKG_ROOT);
    const meta = JSON.parse(output)[0];
    tarball = path.join(workspace, meta.filename);
    console.log(
      `  ${meta.filename}  ${(meta.size / 1024).toFixed(1)} KiB, ${meta.entryCount} entries`
    );

    check('tarball contains no native binary', () => {
      const names = meta.files.map((f) => f.path);
      const binaries = names.filter((n) => n.endsWith('.node'));
      assert.deepStrictEqual(binaries, [], `tarball ships ${binaries.join(', ')}`);
    });

    check('tarball contains the entry points and library', () => {
      const names = new Set(meta.files.map((f) => f.path));
      for (const required of [
        'package.json',
        'index.js',
        'index.mjs',
        'index.d.ts',
        'lib/native.js',
        'lib/js-watcher.js',
        'lib/engine.js',
        'lib/retrigger.js',
        'plugins/webpack-plugin.js',
        'plugins/vite-plugin.js',
        'README.md',
      ]) {
        assert.ok(names.has(required), `missing ${required}`);
      }
    });

    check('tarball contains no tests or dev scaffolding', () => {
      const leaked = meta.files
        .map((f) => f.path)
        .filter(
          (n) => n.startsWith('test/') || n.endsWith('.test.mjs') || n === 'vitest.config.mjs'
        );
      assert.deepStrictEqual(leaked, [], `tarball ships ${leaked.join(', ')}`);
    });

    console.log('\ninstalling into an empty directory');
    fs.writeFileSync(
      path.join(consumer, 'package.json'),
      JSON.stringify({ name: 'consumer', version: '1.0.0', private: true }, null, 2)
    );
    npm(['install', tarball, '--omit=optional', '--no-audit', '--no-fund'], consumer);
    const installed = path.join(consumer, 'node_modules', '@retrigger', 'core');
    console.log(`  installed to ${path.relative(workspace, installed)}`);

    check('installed copy has no native binary and no runtime dependencies', () => {
      const binaries = fs.readdirSync(installed).filter((f) => f.endsWith('.node'));
      assert.deepStrictEqual(binaries, [], `found ${binaries.join(', ')}`);
      const manifest = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
      assert.deepStrictEqual(manifest.dependencies ?? {}, {});
      const scoped = path.join(consumer, 'node_modules', '@retrigger');
      assert.deepStrictEqual(fs.readdirSync(scoped), ['core'], 'unexpected sibling packages');
    });

    check('require() succeeds in a clean subprocess', () => {
      const out = expectClean(
        runInConsumer(
          consumer,
          `const c = require('@retrigger/core');
           const info = c.getEngineInfo();
           if (info.engine !== 'javascript') throw new Error('expected the JS engine, got ' + info.engine);
           if (info.backend !== 'polling') throw new Error('unexpected backend ' + info.backend);
           if (info.hashAlgorithm === 'xxh3-64') throw new Error('fallback must not claim xxh3-64');
           process.stdout.write(info.engine + '/' + info.hashAlgorithm);`
        ),
        'require()'
      );
      console.log(`        engine: ${out}`);
    });

    check('require() prints exactly one warning line and no stack trace', () => {
      const result = runInConsumer(consumer, `require('@retrigger/core').getSimdSupport();`);
      expectClean(result, 'warning check');
      const lines = result.stderr.split('\n').filter(Boolean);
      assert.strictEqual(
        lines.length,
        1,
        `expected 1 stderr line, got ${lines.length}: ${result.stderr}`
      );
      assert.ok(lines[0].includes('[retrigger]'), lines[0]);
      assert.ok(!result.stderr.includes('\n    at '), 'a stack trace leaked into the warning');
    });

    check('RETRIGGER_SILENT=1 suppresses all output', () => {
      const result = runInConsumer(consumer, `require('@retrigger/core').getSimdSupport();`, {
        env: { RETRIGGER_SILENT: '1' },
      });
      expectClean(result, 'silent check');
      assert.strictEqual(result.stderr.trim(), '');
    });

    check('ESM import works', () => {
      const out = expectClean(
        runInConsumer(
          consumer,
          `import { createRetrigger, getEngineInfo } from '@retrigger/core';
           if (typeof createRetrigger !== 'function') throw new Error('createRetrigger missing');
           process.stdout.write(getEngineInfo().engine);`,
          { esm: true, env: { RETRIGGER_SILENT: '1' } }
        ),
        'ESM import'
      );
      assert.strictEqual(out, 'javascript');
    });

    check('subpath exports resolve for both CJS and ESM', () => {
      expectClean(
        runInConsumer(
          consumer,
          `const w = require('@retrigger/core/webpack');
           const v = require('@retrigger/core/vite');
           if (typeof w !== 'function') throw new Error('webpack subpath is not a constructor');
           if (typeof v.createRetriggerVitePlugin !== 'function') throw new Error('vite subpath missing');
           require('@retrigger/core/package.json');`,
          { env: { RETRIGGER_SILENT: '1' } }
        ),
        'CJS subpaths'
      );
      expectClean(
        runInConsumer(
          consumer,
          `import Webpack from '@retrigger/core/webpack';
           import { createRetriggerVitePlugin } from '@retrigger/core/vite';
           if (typeof Webpack !== 'function') throw new Error('webpack ESM subpath broken');
           if (typeof createRetriggerVitePlugin !== 'function') throw new Error('vite ESM subpath broken');`,
          { esm: true, env: { RETRIGGER_SILENT: '1' } }
        ),
        'ESM subpaths'
      );
    });

    check('the installed copy actually watches files', () => {
      const out = expectClean(
        runInConsumer(
          consumer,
          `const fs = require('fs');
           const os = require('os');
           const path = require('path');
           const { createRetrigger } = require('@retrigger/core');
           const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rt-consumer-')));
           const seen = [];
           const w = createRetrigger({ paths: dir });
           w.on('add', (p) => seen.push('add:' + path.basename(p)));
           w.on('change', (p) => seen.push('change:' + path.basename(p)));
           w.on('unlink', (p) => seen.push('unlink:' + path.basename(p)));
           w.start();
           const target = path.join(dir, 'watched.js');
           const deadline = Date.now() + 10000;
           setTimeout(() => fs.writeFileSync(target, 'v1'), 50);
           setTimeout(() => fs.writeFileSync(target, 'v2-longer'), 400);
           setTimeout(() => fs.unlinkSync(target), 800);
           const poll = setInterval(() => {
             const done = seen.some(s => s.startsWith('add:')) &&
                          seen.some(s => s.startsWith('change:')) &&
                          seen.some(s => s.startsWith('unlink:'));
             if (done || Date.now() > deadline) {
               clearInterval(poll);
               w.close();
               fs.rmSync(dir, { recursive: true, force: true });
               if (!done) { console.error('only saw ' + JSON.stringify(seen)); process.exit(1); }
               process.stdout.write(seen.join(','));
             }
           }, 20);`,
          { env: { RETRIGGER_SILENT: '1' } }
        ),
        'watch cycle'
      );
      console.log(`        events: ${out}`);
    });

    check('hashing works in the installed copy', () => {
      const out = expectClean(
        runInConsumer(
          consumer,
          `const c = require('@retrigger/core');
           const h = c.hashBytesSync('hello');
           if (!/^[0-9a-f]{16}$/.test(h)) throw new Error('bad digest ' + h);
           process.stdout.write(h);`,
          { env: { RETRIGGER_SILENT: '1' } }
        ),
        'hashing'
      );
      console.log(`        hashBytesSync('hello') = ${out}`);
    });

    check('the process exits on its own after close()', () => {
      const result = runInConsumer(
        consumer,
        `const fs = require('fs');
         const os = require('os');
         const path = require('path');
         const { createRetrigger } = require('@retrigger/core');
         const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-exit-'));
         fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
         const w = createRetrigger({ paths: dir });
         w.start();
         setTimeout(() => {
           w.close();
           fs.rmSync(dir, { recursive: true, force: true });
         }, 100);`,
        { env: { RETRIGGER_SILENT: '1' } }
      );
      expectClean(result, 'exit check');
    });
  } finally {
    if (!KEEP) fs.rmSync(workspace, { recursive: true, force: true });
    else console.log(`\nkept ${workspace}`);
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) {
    console.log(`failed: ${failed.map((c) => c.name).join(', ')}`);
    process.exitCode = 1;
  }
}

main();
