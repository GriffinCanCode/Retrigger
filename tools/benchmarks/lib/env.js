'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CORE = path.resolve(__dirname, '../../../src/bindings/nodejs');

function gitSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: path.resolve(__dirname, '../../..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function captureEnv() {
  const { getEngineInfo } = require(CORE);
  const info = getEngineInfo();
  const cpus = os.cpus();
  return {
    timestamp: new Date().toISOString(),
    gitSha: gitSha(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    cpuModel: cpus[0]?.model ?? null,
    cpuCount: cpus.length,
    totalMemoryBytes: os.totalmem(),
    engine: info.engine,
    backend: info.backend,
    hashAlgorithm: info.hashAlgorithm,
    simd: info.simd,
    engineReason: info.reason ?? null,
    corePath: CORE,
  };
}

function ensureCore() {
  if (!fs.existsSync(path.join(CORE, 'package.json'))) {
    throw new Error(`@retrigger/core not found at ${CORE}`);
  }
  return CORE;
}

module.exports = { CORE, captureEnv, ensureCore, gitSha };
