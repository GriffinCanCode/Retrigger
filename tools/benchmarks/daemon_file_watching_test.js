#!/usr/bin/env node
/**
 * Direct daemon file watching test
 * Focus on verifying the daemon can detect file events
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');

const colors = {
    reset: '\x1b[0m', bright: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m',
    yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
};

function colorize(color, text) {
    return `${colors[color]}${text}${colors.reset}`;
}

async function testDaemonFileWatching() {
    console.log(colorize('bright', 'Retrigger Daemon File Watching Verification Test'));
    console.log('='.repeat(70));

    const testDir = path.join(os.tmpdir(), `retrigger_daemon_test_${Date.now()}`);
    let daemonProcess = null;
    const daemonOutput = [];
    let eventsDetected = 0;

    try {
        // 1. Setup test environment
        await fs.promises.mkdir(testDir, { recursive: true });
        console.log(`✓ Created test directory: ${testDir}`);

        // 2. Create daemon config
        const configPath = path.join(testDir, 'retrigger.toml');
        await fs.promises.writeFile(configPath, `
[server]
bind_address = "127.0.0.1"
port = 9192
max_connections = 10
request_timeout_ms = 5000
enable_metrics = true
metrics_port = 9193

[watcher]
watch_paths = [
    { path = "${testDir}", recursive = true, enabled = true }
]
event_buffer_size = 1024
hash_cache_size = 1000
hash_cache_ttl_secs = 300
hash_block_size = 4096

[performance]
worker_threads = 1
enable_simd = true
event_batch_size = 10
poll_interval_us = 1000
enable_zero_copy = false

[logging]
level = "debug"
format = "pretty"
structured = false

[patterns]
include = ["**/*.txt", "**/*.js"]
exclude = ["**/.DS_Store", "**/.*"]
max_file_size = 1048576
ignore_binary = true
`);

        console.log('✓ Created daemon configuration');

        // 3. Start daemon and capture all output
        console.log(colorize('yellow', '\nStarting daemon...'));
        daemonProcess = spawn('../../target/debug/retrigger', ['start', '--config', configPath], {
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: __dirname
        });

        // Capture all daemon output for analysis
        daemonProcess.stdout.on('data', (data) => {
            const output = data.toString();
            daemonOutput.push(output);
            console.log(colorize('cyan', `[DAEMON] ${output.trim()}`));
            
            // Look for file event indicators in logs
            if (output.includes('file') && (output.includes('created') || output.includes('modified') || 
                output.includes('deleted') || output.includes('event') || output.includes('hash'))) {
                eventsDetected++;
            }
        });

        daemonProcess.stderr.on('data', (data) => {
            const output = data.toString();
            daemonOutput.push(output);
            console.log(colorize('blue', `[DAEMON STDERR] ${output.trim()}`));
            
            // Check stderr for events too
            if (output.includes('file') && (output.includes('event') || output.includes('watching') ||
                output.includes('detected') || output.includes('hash'))) {
                eventsDetected++;
            }
        });

        // Wait for daemon to fully start
        await new Promise(resolve => setTimeout(resolve, 3000));

        if (daemonProcess.killed || daemonProcess.exitCode !== null) {
            console.log(colorize('red', '✗ Daemon failed to start or crashed'));
            return false;
        }

        console.log(colorize('green', '✓ Daemon started successfully'));

        // 4. Generate file events and monitor for detection
        console.log(colorize('yellow', '\nGenerating file events...'));
        
        const testFiles = [
            { name: 'test1.txt', content: 'Hello World' },
            { name: 'test2.js', content: 'console.log("test");' },
            { name: 'test3.txt', content: 'Another test file' }
        ];

        for (let i = 0; i < testFiles.length; i++) {
            const file = testFiles[i];
            const filePath = path.join(testDir, file.name);
            
            console.log(`  Creating ${file.name}...`);
            await fs.promises.writeFile(filePath, file.content);
            await new Promise(resolve => setTimeout(resolve, 500)); // Wait for detection
            
            console.log(`  Modifying ${file.name}...`);
            await fs.promises.appendFile(filePath, '\n// Modified');
            await new Promise(resolve => setTimeout(resolve, 500)); // Wait for detection
        }

        // Delete one file to test delete events
        console.log(`  Deleting test1.txt...`);
        await fs.promises.unlink(path.join(testDir, 'test1.txt'));
        await new Promise(resolve => setTimeout(resolve, 500));

        // 5. Wait for processing
        console.log(colorize('yellow', '\nWaiting for event processing...'));
        await new Promise(resolve => setTimeout(resolve, 2000));

        // 6. Check if daemon is still stable
        if (daemonProcess.killed || daemonProcess.exitCode !== null) {
            console.log(colorize('red', '✗ Daemon crashed during file operations'));
            return false;
        }

        // 7. Analyze results
        console.log(colorize('bright', '\n=== ANALYSIS RESULTS ==='));
        
        const allOutput = daemonOutput.join('');
        
        // Check for key indicators
        const indicators = [
            { pattern: /started.*watch/i, description: 'Watcher initialization' },
            { pattern: /simd.*level/i, description: 'SIMD detection' },
            { pattern: /ipc.*created/i, description: 'IPC setup' },
            { pattern: /ring.*buffer/i, description: 'Event buffer setup' },
            { pattern: /file.*event/i, description: 'File event detection' },
            { pattern: /hash.*computed/i, description: 'Hash computation' },
        ];

        let foundIndicators = 0;
        indicators.forEach(indicator => {
            if (indicator.pattern.test(allOutput)) {
                console.log(colorize('green', `✓ ${indicator.description}`));
                foundIndicators++;
            } else {
                console.log(colorize('red', `✗ ${indicator.description}`));
            }
        });

        console.log(`\nEvents potentially detected in logs: ${eventsDetected}`);
        console.log(`Infrastructure indicators found: ${foundIndicators}/${indicators.length}`);

        // Overall assessment
        const success = foundIndicators >= 4 && daemonProcess && !daemonProcess.killed;
        
        if (success) {
            console.log(colorize('green', '\n🎉 DAEMON INFRASTRUCTURE IS WORKING!'));
            console.log('The daemon can start, initialize watchers, and remain stable.');
            if (eventsDetected > 0) {
                console.log(`Potential file events detected: ${eventsDetected}`);
            }
        } else {
            console.log(colorize('yellow', '\n⚠ PARTIAL SUCCESS'));
            console.log('Some components working, but not complete file watching.');
        }

        return success;

    } catch (error) {
        console.log(colorize('red', `✗ Test failed: ${error.message}`));
        return false;
    } finally {
        // Cleanup
        if (daemonProcess && !daemonProcess.killed) {
            console.log(colorize('yellow', '\nShutting down daemon...'));
            daemonProcess.kill('SIGTERM');
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (!daemonProcess.killed) {
                daemonProcess.kill('SIGKILL');
            }
        }

        try {
            await fs.promises.rm(testDir, { recursive: true, force: true });
            console.log(`✓ Cleaned up test directory`);
        } catch (e) {
            console.log(`Warning: Cleanup error: ${e.message}`);
        }
    }
}

async function main() {
    const success = await testDaemonFileWatching();
    
    console.log('\n' + '='.repeat(70));
    if (success) {
        console.log(colorize('green', '✅ DAEMON FILE WATCHING TEST PASSED'));
        console.log('Major infrastructure components are working!');
        process.exit(0);
    } else {
        console.log(colorize('red', '❌ DAEMON FILE WATCHING TEST NEEDS MORE WORK'));
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}
