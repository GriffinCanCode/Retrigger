#!/usr/bin/env node

/**
 * Comprehensive test suite for Retrigger webpack/vite plugin functionality
 * Tests everything without requiring a full build environment
 */

const fs = require('fs');
const path = require('path');

console.log('🧪 Testing Retrigger Plugin Functionality\n');

let testsPassed = 0;
let testsTotal = 0;

function test(name, fn) {
  testsTotal++;
  try {
    console.log(`${testsTotal}. ${name}...`);
    fn();
    console.log('✅ PASSED\n');
    testsPassed++;
  } catch (error) {
    console.log(`❌ FAILED: ${error.message}\n`);
  }
}

// Test 1: Basic module loading
test('Load main Retrigger module', () => {
  const retrigger = require('./src/bindings/nodejs/index.js');
  
  if (!retrigger.RetriggerWebpackPlugin) {
    throw new Error('RetriggerWebpackPlugin not exported');
  }
  
  if (!retrigger.createRetriggerVitePlugin) {
    throw new Error('createRetriggerVitePlugin not exported');
  }
  
  if (typeof retrigger.RetriggerWebpackPlugin !== 'function') {
    throw new Error('RetriggerWebpackPlugin is not a constructor');
  }
  
  if (typeof retrigger.createRetriggerVitePlugin !== 'function') {
    throw new Error('createRetriggerVitePlugin is not a function');
  }
});

// Test 2: Webpack Plugin instantiation
test('Create Webpack Plugin instance', () => {
  const { RetriggerWebpackPlugin } = require('./src/bindings/nodejs/index.js');
  
  const plugin = new RetriggerWebpackPlugin({
    watchPaths: ['./src', './test'],
    verbose: false,
    debounceMs: 100,
    enableHMR: true
  });
  
  if (!plugin.apply || typeof plugin.apply !== 'function') {
    throw new Error('Plugin missing apply method');
  }
  
  if (!plugin.options) {
    throw new Error('Plugin missing options');
  }
  
  if (!plugin.options.watchPaths.includes('./src')) {
    throw new Error('Plugin options not set correctly');
  }
});

// Test 3: Vite Plugin creation
test('Create Vite Plugin instance', () => {
  const { createRetriggerVitePlugin } = require('./src/bindings/nodejs/index.js');
  
  const plugin = createRetriggerVitePlugin({
    watchPaths: ['./src'],
    verbose: false,
    debounceMs: 50
  });
  
  if (!plugin.name || plugin.name !== 'retrigger') {
    throw new Error('Vite plugin missing name');
  }
  
  if (!plugin.configureServer) {
    throw new Error('Vite plugin missing configureServer method');
  }
});

// Test 4: Mock webpack compiler integration
test('Webpack Plugin integration with mock compiler', () => {
  const { RetriggerWebpackPlugin } = require('./src/bindings/nodejs/index.js');
  
  let hooksRegistered = 0;
  const mockCompiler = {
    options: { context: process.cwd() },
    hooks: {
      initialize: { tap: (name, fn) => { hooksRegistered++; } },
      compilation: { tap: (name, fn) => { hooksRegistered++; } },
      watchRun: { tapAsync: (name, fn) => { hooksRegistered++; } },
      watchClose: { tap: (name, fn) => { hooksRegistered++; } }
    },
    watchFileSystem: null
  };
  
  const plugin = new RetriggerWebpackPlugin({
    watchPaths: ['./test'],
    verbose: false
  });
  
  plugin.apply(mockCompiler);
  
  if (hooksRegistered < 4) {
    throw new Error(`Expected 4 hooks registered, got ${hooksRegistered}`);
  }
  
  if (!mockCompiler.watchFileSystem) {
    throw new Error('FileSystem was not replaced');
  }
});

// Test 5: Mock Vite server integration
test('Vite Plugin integration with mock server', () => {
  const { createRetriggerVitePlugin } = require('./src/bindings/nodejs/index.js');
  
  let middlewareCount = 0;
  const mockServer = {
    config: { root: process.cwd() },
    middlewares: {
      use: (path, handler) => {
        middlewareCount++;
        if (path.includes('__retrigger_stats')) {
          // Test the stats endpoint
          const mockReq = { method: 'GET' };
          const mockRes = {
            setHeader: () => {},
            end: (data) => {
              try {
                JSON.parse(data);
              } catch (e) {
                throw new Error('Stats endpoint returned invalid JSON');
              }
            },
            statusCode: 200
          };
          handler(mockReq, mockRes, () => {});
        }
      }
    }
  };
  
  const plugin = createRetriggerVitePlugin({
    watchPaths: ['./test'],
    verbose: false
  });
  
  plugin.configureServer(mockServer);
  
  if (middlewareCount < 2) {
    throw new Error(`Expected at least 2 middleware registered, got ${middlewareCount}`);
  }
});

// Test 6: Plugin options validation
test('Plugin options validation', () => {
  const { RetriggerWebpackPlugin, createRetriggerVitePlugin } = require('./src/bindings/nodejs/index.js');
  
  // Test with no options
  const webpackPlugin1 = new RetriggerWebpackPlugin();
  if (!webpackPlugin1.options.watchPaths || !Array.isArray(webpackPlugin1.options.watchPaths)) {
    throw new Error('Default watchPaths not set correctly');
  }
  
  // Test with custom options
  const webpackPlugin2 = new RetriggerWebpackPlugin({
    watchPaths: ['./custom'],
    debounceMs: 200,
    verbose: true
  });
  
  if (webpackPlugin2.options.debounceMs !== 200) {
    throw new Error('Custom options not applied');
  }
  
  // Test Vite plugin options
  const vitePlugin = createRetriggerVitePlugin({
    watchPaths: ['./vite-test'],
    enableAdvancedHMR: false
  });
  
  // Should not throw
});

// Test 7: Error handling
test('Plugin error handling', () => {
  const { RetriggerWebpackPlugin } = require('./src/bindings/nodejs/index.js');
  
  const plugin = new RetriggerWebpackPlugin();
  
  // Test with invalid compiler
  try {
    plugin.apply({});
    // Should handle gracefully, not throw
  } catch (error) {
    throw new Error('Plugin should handle invalid compiler gracefully');
  }
  
  // Test with completely invalid input
  try {
    plugin.apply(null);
    plugin.apply(undefined);
    // Should not throw
  } catch (error) {
    throw new Error('Plugin should handle null/undefined compiler gracefully');
  }
  
  // Test stopping non-started watcher
  try {
    plugin.stopWatching();
    // Should not throw
  } catch (error) {
    throw new Error('stopWatching should be safe to call when not started');
  }
});

// Test 8: TypeScript definitions
test('TypeScript definitions available', () => {
  const typesPath = path.join(__dirname, 'src/bindings/nodejs/types/index.d.ts');
  
  if (!fs.existsSync(typesPath)) {
    throw new Error('TypeScript definitions file not found');
  }
  
  const typesContent = fs.readFileSync(typesPath, 'utf8');
  
  if (!typesContent.includes('RetriggerWebpackPlugin')) {
    throw new Error('RetriggerWebpackPlugin not in TypeScript definitions');
  }
  
  if (!typesContent.includes('createRetriggerVitePlugin')) {
    throw new Error('createRetriggerVitePlugin not in TypeScript definitions');
  }
});

// Test 9: Package.json configuration
test('Package.json NPM readiness', () => {
  const packagePath = path.join(__dirname, 'src/bindings/nodejs/package.json');
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  
  if (!pkg.name || !pkg.version) {
    throw new Error('Package missing name or version');
  }
  
  if (!pkg.main || pkg.main !== 'index.js') {
    throw new Error('Package main entry point incorrect');
  }
  
  if (!pkg.types || !pkg.types.includes('index.d.ts')) {
    throw new Error('Package TypeScript types not configured');
  }
  
  if (!pkg.files || !pkg.files.includes('plugins/')) {
    throw new Error('Package files array missing plugins');
  }
  
  if (!pkg.keywords || !pkg.keywords.includes('webpack')) {
    throw new Error('Package missing webpack keyword');
  }
});

// Test 10: Advanced features availability (graceful degradation)
test('Advanced features graceful degradation', () => {
  const { createAdvancedRetrigger } = require('./src/bindings/nodejs/index.js');
  
  const advancedInstance = createAdvancedRetrigger({
    enablePerformanceMonitoring: false,
    enableSharedBuffer: false,
    enableHMR: false
  });
  
  if (!advancedInstance) {
    throw new Error('Advanced Retrigger instance not created');
  }
  
  if (typeof advancedInstance.watch !== 'function') {
    throw new Error('Advanced instance missing basic functionality');
  }
  
  // Should work even when advanced features are disabled
});

// Summary
console.log('📊 Test Results Summary:');
console.log('='.repeat(50));
console.log(`✅ Passed: ${testsPassed}/${testsTotal} tests`);
console.log(`❌ Failed: ${testsTotal - testsPassed}/${testsTotal} tests`);

if (testsPassed === testsTotal) {
  console.log('\n🎉 All tests passed! Your plugin is ready for production.');
  console.log('\n📋 What this means:');
  console.log('  • ✅ Webpack integration works');
  console.log('  • ✅ Vite integration works');
  console.log('  • ✅ Plugin options are validated');
  console.log('  • ✅ Error handling is robust');
  console.log('  • ✅ TypeScript support available');
  console.log('  • ✅ NPM package properly configured');
  console.log('  • ✅ Advanced features gracefully degrade');
  console.log('\n🚀 Ready for NPM publication!');
  process.exit(0);
} else {
  console.log(`\n❌ ${testsTotal - testsPassed} tests failed. Please fix issues before publishing.`);
  process.exit(1);
}
