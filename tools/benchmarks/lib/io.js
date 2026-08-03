'use strict';

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;
const SCHEMA_ID = 'retrigger.benchmarks.results.v1';

/**
 * Lightweight structural validator for results.v1 — no ajv dependency.
 * @param {unknown} doc
 * @returns {{ok: true} | {ok: false, errors: string[]}}
 */
function validateResults(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object') return { ok: false, errors: ['root must be an object'] };
  if (doc.schema !== SCHEMA_ID) errors.push(`schema must be "${SCHEMA_ID}"`);
  if (doc.schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion must be ${SCHEMA_VERSION}`);
  if (!doc.env || typeof doc.env !== 'object') errors.push('env required');
  else {
    for (const key of ['timestamp', 'node', 'platform', 'arch', 'engine', 'hashAlgorithm']) {
      if (doc.env[key] == null) errors.push(`env.${key} required`);
    }
  }
  if (!Array.isArray(doc.suites)) errors.push('suites must be an array');
  else {
    for (let i = 0; i < doc.suites.length; i += 1) {
      const s = doc.suites[i];
      if (!s || typeof s !== 'object') {
        errors.push(`suites[${i}] must be an object`);
        continue;
      }
      if (typeof s.name !== 'string') errors.push(`suites[${i}].name required`);
      if (!Array.isArray(s.cases)) errors.push(`suites[${i}].cases must be an array`);
    }
  }
  if (doc.gates != null && !Array.isArray(doc.gates)) errors.push('gates must be an array when present');
  return errors.length ? { ok: false, errors } : { ok: true };
}

/**
 * @param {object} doc
 * @param {string} outPath
 */
function writeResults(doc, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const payload = `${JSON.stringify(doc, null, 2)}\n`;
  fs.writeFileSync(outPath, payload);
  return outPath;
}

/**
 * @param {string} filePath
 */
function readResults(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

module.exports = { SCHEMA_VERSION, SCHEMA_ID, validateResults, writeResults, readResults };
