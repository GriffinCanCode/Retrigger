#!/usr/bin/env node
/**
 * Retrigger vs Competition Benchmark
 * Compares Retrigger against popular file watchers
 */

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const os = require('os');

const execAsync = promisify(exec);

// System resource monitoring
class ResourceMonitor {
    constructor() {
        this.samples = [];
        this.interval = null;
    }
    
    start(intervalMs = 100) {
        this.samples = [];
        this.interval = setInterval(() => {
            const cpuUsage = process.cpuUsage();
            const memUsage = process.memoryUsage();
            
            this.samples.push({
                timestamp: Date.now(),
                cpu: cpuUsage,
                memory: memUsage,
            });
        }, intervalMs);
    }
    
    stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
        
        if (this.samples.length === 0) {
            return { 
                avgMemoryMB: 0, 
                peakMemoryMB: 0, 
                samples: 0 
            };
        }
        
        // Calculate averages
        const avgMemory = this.samples.reduce((sum, sample) => 
            sum + (sample.memory ? sample.memory.rss : 0), 0) / this.samples.length;
        
        // CPU is harder to calculate meaningfully in Node.js
        // We'll use peak memory as a proxy for resource usage
        const peakMemory = Math.max(...this.samples.map(s => s.memory ? s.memory.rss : 0));
        
        return {
            avgMemoryMB: (avgMemory || 0) / 1024 / 1024,
            peakMemoryMB: (peakMemory || 0) / 1024 / 1024,
            samples: this.samples.length,
        };
    }
}

// Configuration
const BENCHMARK_CONFIG = {
    testSizes: [10, 100, 1000],  // Start with smaller sizes for debugging
    iterations: 3, // Reduce iterations for faster testing
    timeoutMs: 30000, // 30 second timeout
    fileSize: 1024, // 1KB per file
    largeFileSize: 1024 * 50, // 50KB for some tests
    testTypes: ['modify'], // Focus on modify operations for now
};

// Colors for output
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
};

function colorize(color, text) {
    return `${colors[color]}${text}${colors.reset}`;
}

// Create test directory structure
async function createTestFiles(testDir, count, fileSize) {
    await fs.promises.mkdir(testDir, { recursive: true });
    
    const content = 'x'.repeat(fileSize);
    const promises = [];
    
    for (let i = 0; i < count; i++) {
        const filePath = path.join(testDir, `test_${i.toString().padStart(6, '0')}.txt`);
        promises.push(fs.promises.writeFile(filePath, content));
    }
    
    await Promise.all(promises);
}

// Clean up test files
async function cleanupTestFiles(testDir) {
    try {
        await fs.promises.rmdir(testDir, { recursive: true });
    } catch (error) {
        // Ignore cleanup errors
    }
}

// Parcel Watcher benchmark
async function benchmarkParcelWatcher(testDir, fileCount) {
    try {
        const watcher = require('@parcel/watcher');
        
        let eventCount = 0;
        let startTime, firstEventTime, lastEventTime;
        let subscription;
        
        // Setup event handler
        const eventHandler = () => {
            if (eventCount === 0) {
                firstEventTime = performance.now();
            }
            eventCount++;
            lastEventTime = performance.now();
        };
        
        // Start watching
        subscription = await watcher.subscribe(testDir, eventHandler, {
            ignore: []
        });
        
        // Wait a bit for watcher to be ready
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Start modifying files
        startTime = performance.now();
        
        const modifyPromises = [];
        for (let i = 0; i < fileCount; i++) {
            const filePath = path.join(testDir, `test_${i.toString().padStart(6, '0')}.txt`);
            modifyPromises.push(
                fs.promises.appendFile(filePath, `_modified_${Date.now()}`)
            );
        }
        
        await Promise.all(modifyPromises);
        
        // Wait for all events
        const timeout = 10000; // 10 seconds
        const endTime = Date.now() + timeout;
        
        while (eventCount < fileCount && Date.now() < endTime) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        
        await subscription.unsubscribe();
        
        const totalTime = lastEventTime - startTime;
        const firstEventLatency = firstEventTime - startTime;
        const avgLatency = totalTime / eventCount;
        
        return {
            success: true,
            eventsReceived: eventCount,
            expectedEvents: fileCount,
            totalTimeMs: totalTime,
            firstEventLatencyMs: firstEventLatency,
            avgLatencyMs: avgLatency,
            eventsPerSecond: eventCount / (totalTime / 1000),
        };
        
    } catch (error) {
        return {
            success: false,
            error: error.message,
        };
    }
}

// Retrigger benchmark using our Node.js bindings
async function benchmarkRetrigger(testDir, fileCount) {
    try {
        // Load our bindings (if built)
        const { RetriggerWrapper } = require('../../src/bindings/nodejs');
        
        const watcher = new RetriggerWrapper();
        let eventCount = 0;
        let startTime, firstEventTime, lastEventTime;
        let events = [];
        
        // Start watching the directory
        await watcher.watchDirectory(testDir, { recursive: true });
        await watcher.start();
        
        // Wait a bit for watcher to be ready
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Start modifying files
        startTime = performance.now();
        
        const modifyPromises = [];
        for (let i = 0; i < fileCount; i++) {
            const filePath = path.join(testDir, `test_${i.toString().padStart(6, '0')}.txt`);
            modifyPromises.push(
                fs.promises.appendFile(filePath, `_modified_${Date.now()}`)
            );
        }
        
        await Promise.all(modifyPromises);
        
        // Poll for events
        const timeout = 10000; // 10 seconds
        const endTime = Date.now() + timeout;
        
        while (eventCount < fileCount && Date.now() < endTime) {
            try {
                const eventResult = await watcher.pollEvent();
                if (eventResult && eventResult.path) {
                    if (eventCount === 0) {
                        firstEventTime = performance.now();
                    }
                    eventCount++;
                    lastEventTime = performance.now();
                    events.push(eventResult);
                }
            } catch (e) {
                // No event available, continue polling
                await new Promise(resolve => setTimeout(resolve, 1));
            }
        }
        
        const totalTime = lastEventTime - startTime;
        const firstEventLatency = firstEventTime - startTime;
        const avgLatency = totalTime / eventCount;
        
        let stats = {};
        try {
            const statsResult = await watcher.getStats();
            stats = statsResult || {};
        } catch (e) {
            stats = { dropped_events: '0' };
        }
        
        return {
            success: true,
            eventsReceived: eventCount,
            expectedEvents: fileCount,
            totalTimeMs: totalTime,
            firstEventLatencyMs: firstEventLatency,
            avgLatencyMs: avgLatency,
            eventsPerSecond: eventCount / (totalTime / 1000),
            droppedEvents: stats.droppedEvents ? parseInt(stats.droppedEvents) : 0,
            simdLevel: watcher.getSimdLevel(),
        };
        
    } catch (error) {
        return {
            success: false,
            error: error.message,
        };
    }
}

// Chokidar benchmark
async function benchmarkChokidar(testDir, fileCount) {
    try {
        // Try to require chokidar
        const chokidar = require('chokidar');
        
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
        await new Promise((resolve) => {
            watcher.on('ready', resolve);
        });
        
        // Start modifying files
        startTime = performance.now();
        
        const modifyPromises = [];
        for (let i = 0; i < fileCount; i++) {
            const filePath = path.join(testDir, `test_${i.toString().padStart(6, '0')}.txt`);
            modifyPromises.push(
                fs.promises.appendFile(filePath, `_modified_${Date.now()}`)
            );
        }
        
        await Promise.all(modifyPromises);
        
        // Wait for all events
        const timeout = 10000;
        const endTime = Date.now() + timeout;
        
        while (eventCount < fileCount && Date.now() < endTime) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        
        await watcher.close();
        
        const totalTime = lastEventTime - startTime;
        const firstEventLatency = firstEventTime - startTime;
        const avgLatency = totalTime / eventCount;
        
        return {
            success: true,
            eventsReceived: eventCount,
            expectedEvents: fileCount,
            totalTimeMs: totalTime,
            firstEventLatencyMs: firstEventLatency,
            avgLatencyMs: avgLatency,
            eventsPerSecond: eventCount / (totalTime / 1000),
        };
        
    } catch (error) {
        return {
            success: false,
            error: error.message,
        };
    }
}

// Node.js fs.watch benchmark  
async function benchmarkNodeWatch(testDir, fileCount) {
    try {
        let eventCount = 0;
        let startTime, firstEventTime, lastEventTime;
        
        const watchers = [];
        
        // Create watcher for each file (fs.watch limitation)
        for (let i = 0; i < fileCount; i++) {
            const filePath = path.join(testDir, `test_${i.toString().padStart(6, '0')}.txt`);
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
        
        // Start modifying files
        startTime = performance.now();
        
        const modifyPromises = [];
        for (let i = 0; i < fileCount; i++) {
            const filePath = path.join(testDir, `test_${i.toString().padStart(6, '0')}.txt`);
            modifyPromises.push(
                fs.promises.appendFile(filePath, `_modified_${Date.now()}`)
            );
        }
        
        await Promise.all(modifyPromises);
        
        // Wait for all events
        const timeout = 10000;
        const endTime = Date.now() + timeout;
        
        while (eventCount < fileCount && Date.now() < endTime) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        
        // Close all watchers
        watchers.forEach(watcher => watcher.close());
        
        const totalTime = lastEventTime - startTime;
        const firstEventLatency = firstEventTime - startTime;
        const avgLatency = totalTime / eventCount;
        
        return {
            success: true,
            eventsReceived: eventCount,
            expectedEvents: fileCount,
            totalTimeMs: totalTime,
            firstEventLatencyMs: firstEventLatency,
            avgLatencyMs: avgLatency,
            eventsPerSecond: eventCount / (totalTime / 1000),
        };
        
    } catch (error) {
        return {
            success: false,
            error: error.message,
        };
    }
}

// Run benchmark for a specific watcher
async function runSingleBenchmark(name, benchmarkFn, testDir, fileCount, iteration) {
    console.log(`  ${colorize('cyan', name)} (iteration ${iteration + 1})...`);
    
    try {
        // Start resource monitoring
        const resourceMonitor = new ResourceMonitor();
        resourceMonitor.start(50); // Sample every 50ms
        
        const result = await benchmarkFn(testDir, fileCount);
        
        // Stop resource monitoring
        const resources = resourceMonitor.stop();
        
        if (result.success) {
            const completeness = (result.eventsReceived / result.expectedEvents * 100).toFixed(1);
            console.log(`    Events: ${result.eventsReceived}/${result.expectedEvents} (${completeness}%)`);
            console.log(`    Latency: ${result.firstEventLatencyMs.toFixed(2)}ms (first), ${result.avgLatencyMs.toFixed(2)}ms (avg)`);
            console.log(`    Throughput: ${result.eventsPerSecond.toFixed(0)} events/sec`);
            console.log(`    Memory: ${resources.avgMemoryMB.toFixed(1)}MB avg, ${resources.peakMemoryMB.toFixed(1)}MB peak`);
            
            if (result.simdLevel) {
                console.log(`    SIMD: ${result.simdLevel}`);
            }
            if (result.droppedEvents > 0) {
                console.log(`    ${colorize('yellow', 'Dropped:')} ${result.droppedEvents} events`);
            }
            
            // Add resource info to result
            result.avgMemoryMB = resources.avgMemoryMB;
            result.peakMemoryMB = resources.peakMemoryMB;
        } else {
            console.log(`    ${colorize('red', 'Failed:')} ${result.error}`);
        }
        
        return result;
        
    } catch (error) {
        console.log(`    ${colorize('red', 'Error:')} ${error.message}`);
        return { success: false, error: error.message };
    }
}

// Calculate statistics
function calculateStats(results) {
    const successful = results.filter(r => r.success && r.eventsReceived > 0);
    
    if (successful.length === 0) {
        return { success: false };
    }
    
    const latencies = successful.map(r => r.avgLatencyMs);
    const throughputs = successful.map(r => r.eventsPerSecond);
    const firstLatencies = successful.map(r => r.firstEventLatencyMs);
    const avgMemories = successful.filter(r => r.avgMemoryMB).map(r => r.avgMemoryMB);
    const peakMemories = successful.filter(r => r.peakMemoryMB).map(r => r.peakMemoryMB);
    
    return {
        success: true,
        runs: successful.length,
        avgLatency: latencies.reduce((a, b) => a + b, 0) / latencies.length,
        minLatency: Math.min(...latencies),
        maxLatency: Math.max(...latencies),
        avgThroughput: throughputs.reduce((a, b) => a + b, 0) / throughputs.length,
        maxThroughput: Math.max(...throughputs),
        avgFirstLatency: firstLatencies.reduce((a, b) => a + b, 0) / firstLatencies.length,
        avgMemoryMB: avgMemories.length > 0 ? avgMemories.reduce((a, b) => a + b, 0) / avgMemories.length : 0,
        peakMemoryMB: peakMemories.length > 0 ? Math.max(...peakMemories) : 0,
        completeness: (successful.reduce((sum, r) => sum + r.eventsReceived, 0) / 
                      successful.reduce((sum, r) => sum + r.expectedEvents, 0)) * 100,
    };
}

// Display comparison results
function displayComparison(results) {
    console.log(`\n${colorize('bright', 'COMPARISON SUMMARY')}`);
    console.log('='.repeat(80));
    
    const watchers = Object.keys(results);
    const fileCounts = Object.keys(results[watchers[0]]);
    
    // Header
    console.log(`${'Watcher'.padEnd(15)} | ${'Files'.padEnd(8)} | ${'Latency'.padEnd(12)} | ${'Throughput'.padEnd(12)} | ${'Memory'.padEnd(12)} | ${'Complete'.padEnd(10)}`);
    console.log('-'.repeat(95));
    
    // Results for each file count
    fileCounts.forEach(fileCount => {
        console.log(`\n${colorize('yellow', `${fileCount} files:`)}`);
        
        let bestThroughput = 0;
        let bestWatcher = '';
        
        watchers.forEach(watcher => {
            const stats = results[watcher][fileCount];
            
            if (stats.success) {
                const latencyStr = `${stats.avgLatency.toFixed(1)}ms`;
                const throughputStr = `${stats.avgThroughput.toFixed(0)} ev/s`;
                const memoryStr = stats.avgMemoryMB > 0 ? `${stats.avgMemoryMB.toFixed(1)}MB` : 'N/A';
                const completenessStr = `${stats.completeness.toFixed(1)}%`;
                
                if (stats.avgThroughput > bestThroughput) {
                    bestThroughput = stats.avgThroughput;
                    bestWatcher = watcher;
                }
                
                console.log(`  ${watcher.padEnd(13)} | ${fileCount.padEnd(8)} | ${latencyStr.padEnd(12)} | ${throughputStr.padEnd(12)} | ${memoryStr.padEnd(12)} | ${completenessStr.padEnd(10)}`);
            } else {
                console.log(`  ${watcher.padEnd(13)} | ${fileCount.padEnd(8)} | ${colorize('red', 'FAILED')} `);
            }
        });
        
        if (bestWatcher) {
            console.log(`  ${colorize('green', '✓')} Best: ${colorize('green', bestWatcher)}`);
        }
    });
    
    // Performance improvement calculation
    console.log(`\n${colorize('bright', 'PERFORMANCE IMPROVEMENTS')}`);
    console.log('='.repeat(40));
    
    if (results.retrigger) {
        fileCounts.forEach(fileCount => {
            const retriggerStats = results.retrigger[fileCount];
            
            if (retriggerStats.success) {
                console.log(`\n${fileCount} files:`);
                
                watchers.forEach(watcher => {
                    if (watcher === 'retrigger') return;
                    
                    const otherStats = results[watcher][fileCount];
                    
                    if (otherStats.success) {
                        const speedup = otherStats.avgLatency / retriggerStats.avgLatency;
                        const throughputImprovement = retriggerStats.avgThroughput / otherStats.avgThroughput;
                        
                        let memoryComparison = '';
                        if (retriggerStats.avgMemoryMB > 0 && otherStats.avgMemoryMB > 0) {
                            const memoryImprovement = otherStats.avgMemoryMB / retriggerStats.avgMemoryMB;
                            memoryComparison = `, ${colorize('green', `${memoryImprovement.toFixed(1)}x`)} less memory`;
                        }
                        
                        console.log(`  vs ${watcher}: ${colorize('green', `${speedup.toFixed(1)}x`)} faster latency, ${colorize('green', `${throughputImprovement.toFixed(1)}x`)} higher throughput${memoryComparison}`);
                    }
                });
            }
        });
    }
}

// Main benchmark function
async function runBenchmarks() {
    console.log(colorize('bright', 'Retrigger vs Competition Benchmark'));
    console.log('='.repeat(50));
    
    const watchers = {
        retrigger: benchmarkRetrigger,
        chokidar: benchmarkChokidar,
        'parcel-watcher': benchmarkParcelWatcher,
        'node-fs-watch': benchmarkNodeWatch,
    };
    
    const results = {};
    
    // Initialize results structure
    Object.keys(watchers).forEach(watcher => {
        results[watcher] = {};
    });
    
    // Run benchmarks for each file count
    for (const fileCount of BENCHMARK_CONFIG.testSizes) {
        console.log(`\n${colorize('bright', `Testing with ${fileCount} files`)}`);
        console.log('-'.repeat(30));
        
        const testDir = path.join(__dirname, `temp_test_${fileCount}_${Date.now()}`);
        
        try {
            // Create test files
            console.log(`Creating ${fileCount} test files...`);
            await createTestFiles(testDir, fileCount, BENCHMARK_CONFIG.fileSize);
            
            // Run each watcher
            for (const [name, benchmarkFn] of Object.entries(watchers)) {
                const iterationResults = [];
                
                for (let i = 0; i < BENCHMARK_CONFIG.iterations; i++) {
                    const result = await runSingleBenchmark(name, benchmarkFn, testDir, fileCount, i);
                    iterationResults.push(result);
                    
                    // Small delay between iterations
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
                
                // Calculate statistics
                const stats = calculateStats(iterationResults);
                results[name][fileCount] = stats;
                
                if (stats.success) {
                    console.log(`  ${colorize('green', '✓')} ${name}: ${stats.avgLatency.toFixed(1)}ms avg latency, ${stats.avgThroughput.toFixed(0)} events/sec`);
                } else {
                    console.log(`  ${colorize('red', '✗')} ${name}: Failed all iterations`);
                }
            }
            
        } finally {
            // Cleanup
            await cleanupTestFiles(testDir);
        }
    }
    
    // Display final comparison
    displayComparison(results);
}

// Check dependencies
async function checkDependencies() {
    const dependencies = [];
    
    // Check if our bindings exist
    try {
        require('../../src/bindings/nodejs');
        dependencies.push({ name: 'retrigger', available: true });
    } catch (error) {
        dependencies.push({ name: 'retrigger', available: false, error: 'Build retrigger bindings first' });
    }
    
    // Check chokidar
    try {
        require('chokidar');
        dependencies.push({ name: 'chokidar', available: true });
    } catch (error) {
        dependencies.push({ name: 'chokidar', available: false, error: 'npm install chokidar' });
    }
    
    // Check parcel watcher
    try {
        require('@parcel/watcher');
        dependencies.push({ name: 'parcel-watcher', available: true });
    } catch (error) {
        dependencies.push({ name: 'parcel-watcher', available: false, error: 'npm install @parcel/watcher' });
    }
    
    console.log('Dependency Check:');
    dependencies.forEach(dep => {
        const status = dep.available 
            ? colorize('green', '✓') 
            : colorize('red', '✗');
        
        console.log(`  ${status} ${dep.name}`);
        
        if (!dep.available) {
            console.log(`    ${colorize('yellow', dep.error)}`);
        }
    });
    console.log();
    
    return dependencies.filter(dep => dep.available).length > 1;
}

// Main execution
async function main() {
    console.log('Starting benchmark comparison...\n');
    
    if (!(await checkDependencies())) {
        console.log(colorize('red', 'Error: Not enough watchers available for comparison'));
        console.log('Please install missing dependencies and build Retrigger bindings');
        process.exit(1);
    }
    
    try {
        await runBenchmarks();
        console.log(`\n${colorize('green', '✓')} Benchmark completed successfully!`);
    } catch (error) {
        console.error(`\n${colorize('red', 'Error:')} ${error.message}`);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    benchmarkRetrigger,
    benchmarkChokidar,
    benchmarkNodeWatch,
    runBenchmarks,
};
