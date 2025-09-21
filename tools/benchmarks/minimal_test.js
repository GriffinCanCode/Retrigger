#!/usr/bin/env node
/**
 * Minimal test that only tests what's actually working
 */

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

// Test just the hash functions first
async function testHashFunctions() {
    console.log('Testing hash functions...');
    
    try {
        const { hashFileSync, hashBytesSync, getSimdSupport } = require('../../src/bindings/nodejs');
        
        console.log('✓ Bindings loaded');
        console.log('✓ SIMD Support:', getSimdSupport());
        
        // Test hashing
        const testData = Buffer.from('Hello, World!');
        const hashResult = hashBytesSync(testData);
        console.log('✓ Hash result:', hashResult);
        
        // Create a temp file and hash it
        const tempFile = '/tmp/retrigger_hash_test.txt';
        await fs.promises.writeFile(tempFile, 'Test file content');
        
        const fileHashResult = hashFileSync(tempFile);
        console.log('✓ File hash result:', fileHashResult);
        
        await fs.promises.unlink(tempFile);
        
        return true;
    } catch (error) {
        console.error('❌ Hash test error:', error.message);
        return false;
    }
}

// Chokidar basic benchmark
async function benchmarkChokidarOnly() {
    console.log('\nRunning Chokidar benchmark only...');
    
    try {
        const chokidar = require('chokidar');
        
        const testDir = '/tmp/chokidar_bench';
        await fs.promises.mkdir(testDir, { recursive: true });
        
        // Create test files
        const fileCount = 10;
        for (let i = 0; i < fileCount; i++) {
            await fs.promises.writeFile(
                path.join(testDir, `test_${i}.txt`), 
                `content ${i}`
            );
        }
        
        let eventCount = 0;
        let startTime, firstEventTime, lastEventTime;
        
        const watcher = chokidar.watch(testDir, {
            ignoreInitial: true,
            persistent: true,
        });
        
        watcher.on('change', () => {
            if (eventCount === 0) {
                firstEventTime = performance.now();
            }
            eventCount++;
            lastEventTime = performance.now();
        });
        
        // Wait for ready
        await new Promise(resolve => watcher.on('ready', resolve));
        console.log('✓ Chokidar ready');
        
        // Start timing and modify files
        startTime = performance.now();
        
        for (let i = 0; i < fileCount; i++) {
            await fs.promises.appendFile(
                path.join(testDir, `test_${i}.txt`), 
                `_modified_${Date.now()}`
            );
        }
        
        // Wait for events
        const endTime = Date.now() + 5000; // 5 second timeout
        while (eventCount < fileCount && Date.now() < endTime) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        
        await watcher.close();
        
        if (eventCount > 0) {
            const totalTime = lastEventTime - startTime;
            const firstEventLatency = firstEventTime - startTime;
            const avgLatency = totalTime / eventCount;
            
            console.log('✓ Chokidar Results:');
            console.log(`  Events: ${eventCount}/${fileCount}`);
            console.log(`  First event latency: ${firstEventLatency.toFixed(2)}ms`);
            console.log(`  Average latency: ${avgLatency.toFixed(2)}ms`);
            console.log(`  Throughput: ${(eventCount / (totalTime / 1000)).toFixed(0)} events/sec`);
        } else {
            console.log('⚠ No events received');
        }
        
        // Cleanup
        await fs.promises.rmdir(testDir, { recursive: true });
        
        return true;
    } catch (error) {
        console.error('❌ Chokidar benchmark error:', error.message);
        return false;
    }
}

// Test Node.js fs.watch
async function benchmarkNodeWatch() {
    console.log('\nRunning Node.js fs.watch benchmark...');
    
    try {
        const testDir = '/tmp/node_watch_bench';
        await fs.promises.mkdir(testDir, { recursive: true });
        
        const fileCount = 10;
        const watchers = [];
        let eventCount = 0;
        let startTime, firstEventTime, lastEventTime;
        
        // Create files and watchers
        for (let i = 0; i < fileCount; i++) {
            const filePath = path.join(testDir, `test_${i}.txt`);
            await fs.promises.writeFile(filePath, `content ${i}`);
            
            const watcher = fs.watch(filePath, () => {
                if (eventCount === 0) {
                    firstEventTime = performance.now();
                }
                eventCount++;
                lastEventTime = performance.now();
            });
            
            watchers.push(watcher);
        }
        
        // Wait a bit for watchers to be ready
        await new Promise(resolve => setTimeout(resolve, 100));
        console.log('✓ Node.js fs.watch ready');
        
        // Start timing and modify files
        startTime = performance.now();
        
        for (let i = 0; i < fileCount; i++) {
            await fs.promises.appendFile(
                path.join(testDir, `test_${i}.txt`), 
                `_modified_${Date.now()}`
            );
        }
        
        // Wait for events
        const endTime = Date.now() + 5000; // 5 second timeout
        while (eventCount < fileCount && Date.now() < endTime) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        
        // Close watchers
        watchers.forEach(watcher => watcher.close());
        
        if (eventCount > 0) {
            const totalTime = lastEventTime - startTime;
            const firstEventLatency = firstEventTime - startTime;
            const avgLatency = totalTime / eventCount;
            
            console.log('✓ Node.js fs.watch Results:');
            console.log(`  Events: ${eventCount}/${fileCount}`);
            console.log(`  First event latency: ${firstEventLatency.toFixed(2)}ms`);
            console.log(`  Average latency: ${avgLatency.toFixed(2)}ms`);
            console.log(`  Throughput: ${(eventCount / (totalTime / 1000)).toFixed(0)} events/sec`);
        } else {
            console.log('⚠ No events received');
        }
        
        // Cleanup
        await fs.promises.rmdir(testDir, { recursive: true });
        
        return true;
    } catch (error) {
        console.error('❌ Node.js fs.watch benchmark error:', error.message);
        return false;
    }
}

async function main() {
    console.log('Running minimal tests to verify working components...\n');
    
    const hashTest = await testHashFunctions();
    const chokidarTest = await benchmarkChokidarOnly();
    const nodeWatchTest = await benchmarkNodeWatch();
    
    console.log('\n=== Summary ===');
    console.log(`Hash functions: ${hashTest ? '✓' : '❌'}`);
    console.log(`Chokidar: ${chokidarTest ? '✓' : '❌'}`);  
    console.log(`Node.js fs.watch: ${nodeWatchTest ? '✓' : '❌'}`);
    
    if (!hashTest) {
        console.log('\n❌ Retrigger bindings have issues - cannot benchmark');
        console.log('Performance claims in README cannot be verified until bindings are fixed');
    } else {
        console.log('\n✓ Hash functions work - but file watching is broken');
        console.log('README claims about file watching latency cannot be verified');
    }
}

if (require.main === module) {
    main();
}
