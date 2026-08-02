/**
 * ESM entry point. The implementation is CommonJS; this file only re-exports
 * it so that `import { createRetrigger } from '@retrigger/core'` — the form the
 * README has always shown — actually works.
 */

import core from './index.js';

export const Retrigger = core.Retrigger;
export const RetriggerWebpackPlugin = core.RetriggerWebpackPlugin;
export const benchmarkHash = core.benchmarkHash;
export const createRetrigger = core.createRetrigger;
export const createRetriggerVitePlugin = core.createRetriggerVitePlugin;
export const getAvailableLevels = core.getAvailableLevels;
export const getCpuLevel = core.getCpuLevel;
export const getEngineInfo = core.getEngineInfo;
export const getSimdSupport = core.getSimdSupport;
export const hashBytesSync = core.hashBytesSync;
export const hashFile = core.hashFile;
export const hashFileSync = core.hashFileSync;

export default core;
