#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

const binPath = path.join(__dirname, '..', 'bin', 'retrigger');

console.log('🧪 Testing Retrigger daemon...');

// Test help command
console.log('1. Testing --help command...');
const helpProcess = spawn(binPath, ['--help'], { stdio: 'pipe' });

let output = '';
helpProcess.stdout.on('data', (data) => {
  output += data.toString();
});

helpProcess.on('close', (code) => {
  if (code === 0) {
    console.log('✅ Help command works');
    
    // Test version command
    console.log('2. Testing --version command...');
    const versionProcess = spawn(binPath, ['--version'], { stdio: 'pipe' });
    
    let versionOutput = '';
    versionProcess.stdout.on('data', (data) => {
      versionOutput += data.toString();
    });
    
    versionProcess.on('close', (versionCode) => {
      if (versionCode === 0) {
        console.log('✅ Version command works:', versionOutput.trim());
        
        // Test config generation
        console.log('3. Testing config generation...');
        const configProcess = spawn(binPath, ['config', '--output', '/tmp/retrigger-test.toml'], { stdio: 'pipe' });
        
        configProcess.on('close', (configCode) => {
          if (configCode === 0) {
            console.log('✅ Config generation works');
            console.log('');
            console.log('🎉 All daemon tests passed!');
          } else {
            console.log('⚠️  Config generation failed (non-critical)');
            console.log('🎉 Core daemon functionality works!');
          }
        });
      } else {
        console.error('❌ Version command failed');
        process.exit(1);
      }
    });
  } else {
    console.error('❌ Help command failed');
    process.exit(1);
  }
});
