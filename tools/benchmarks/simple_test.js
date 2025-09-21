#!/usr/bin/env node
/**
 * Simple test to debug Retrigger bindings
 */

const fs = require('fs');
const path = require('path');

async function testRetriggerBindings() {
    console.log('Testing Retrigger bindings...');
    
    try {
        console.log('1. Loading bindings...');
        const { RetriggerWrapper } = require('../../src/bindings/nodejs');
        console.log('✓ Bindings loaded successfully');
        
        console.log('2. Creating wrapper instance...');
        const watcher = new RetriggerWrapper();
        console.log('✓ Wrapper created successfully');
        
        console.log('3. Testing SIMD level...');
        const simdLevel = watcher.getSimdLevel();
        console.log(`✓ SIMD Level: ${simdLevel}`);
        
        console.log('4. Creating test directory...');
        const testDir = '/tmp/retrigger_simple_test';
        await fs.promises.mkdir(testDir, { recursive: true });
        
        console.log('5. Creating a test file...');
        await fs.promises.writeFile(path.join(testDir, 'test.txt'), 'hello world');
        console.log('✓ Test file created');
        
        console.log('6. Starting watcher...');
        await watcher.watchDirectory(testDir, { recursive: true });
        await watcher.start();
        console.log('✓ Watcher started');
        
        console.log('7. Modifying file...');
        await fs.promises.appendFile(path.join(testDir, 'test.txt'), '\nmodified');
        
        console.log('8. Polling for events...');
        let foundEvent = false;
        for (let i = 0; i < 100; i++) {  // Poll 100 times
            try {
                const event = await watcher.pollEvent();
                if (event && event.path) {
                    console.log('✓ Found event:', event);
                    foundEvent = true;
                    break;
                }
            } catch (e) {
                // No event, continue
            }
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        
        if (!foundEvent) {
            console.log('⚠ No events found within polling period');
        }
        
        console.log('9. Getting stats...');
        try {
            const stats = await watcher.getStats();
            console.log('✓ Stats:', stats);
        } catch (e) {
            console.log('⚠ Stats error:', e.message);
        }
        
        console.log('10. Cleanup...');
        await fs.promises.rmdir(testDir, { recursive: true });
        console.log('✓ Test completed successfully!');
        
    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

async function testChokidarBasic() {
    console.log('\nTesting Chokidar for comparison...');
    
    try {
        const chokidar = require('chokidar');
        console.log('✓ Chokidar loaded');
        
        const testDir = '/tmp/chokidar_simple_test';
        await fs.promises.mkdir(testDir, { recursive: true });
        
        let eventReceived = false;
        const watcher = chokidar.watch(testDir, {
            ignoreInitial: true,
            persistent: true,
        });
        
        watcher.on('change', (path) => {
            console.log('✓ Chokidar event:', path);
            eventReceived = true;
        });
        
        await new Promise(resolve => watcher.on('ready', resolve));
        
        await fs.promises.writeFile(path.join(testDir, 'test.txt'), 'hello');
        await new Promise(resolve => setTimeout(resolve, 100));
        await fs.promises.appendFile(path.join(testDir, 'test.txt'), ' world');
        
        // Wait for event
        for (let i = 0; i < 50; i++) {
            if (eventReceived) break;
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        
        await watcher.close();
        await fs.promises.rmdir(testDir, { recursive: true });
        
        console.log(eventReceived ? '✓ Chokidar working' : '⚠ Chokidar no events');
        
    } catch (error) {
        console.error('❌ Chokidar error:', error.message);
    }
}

async function main() {
    await testRetriggerBindings();
    await testChokidarBasic();
}

if (require.main === module) {
    main();
}
