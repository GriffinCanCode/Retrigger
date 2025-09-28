#!/usr/bin/env node

const { exec } = require('child_process');
const { platform, arch } = process;
const path = require('path');
const fs = require('fs');

console.log('🚀 Installing Retrigger daemon...');
console.log(`Platform: ${platform}-${arch}`);

// Make binary executable
const binPath = path.join(__dirname, '..', 'bin', 'retrigger');
if (fs.existsSync(binPath)) {
  try {
    fs.chmodSync(binPath, 0o755);
    console.log('✅ Made daemon binary executable');
  } catch (error) {
    console.warn('⚠️  Could not make binary executable:', error.message);
  }
} else {
  console.warn('⚠️  Daemon binary not found at:', binPath);
}

// Test daemon
console.log('🔍 Testing daemon installation...');
exec(`${binPath} --version`, (error, stdout, stderr) => {
  if (error) {
    console.error('❌ Daemon test failed:', error.message);
    process.exit(1);
  }
  
  console.log('✅ Daemon installed successfully!');
  console.log(`Version: ${stdout.trim()}`);
  console.log('');
  console.log('Usage:');
  console.log('  retrigger start    # Start the daemon');
  console.log('  retrigger stop     # Stop the daemon');
  console.log('  retrigger status   # Check daemon status');
  console.log('  retrigger --help   # Show all commands');
  console.log('');
  console.log('📖 Documentation: https://github.com/GriffinCanCode/Retrigger');
});
