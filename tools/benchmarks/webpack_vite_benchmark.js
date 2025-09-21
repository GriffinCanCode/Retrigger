#!/usr/bin/env node
/**
 * Comprehensive benchmark comparing Retrigger against file watchers
 * actually used by webpack and Vite in real development workflows
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
        this.startTime = null;
    }
    
    start(intervalMs = 100) {
        this.samples = [];
        this.startTime = Date.now();
        this.interval = setInterval(() => {
            try {
                const cpuUsage = process.cpuUsage();
                const memUsage = process.memoryUsage();
                
                this.samples.push({
                    timestamp: Date.now(),
                    cpu: cpuUsage,
                    memory: memUsage,
                });
            } catch (e) {
                // Ignore sampling errors
            }
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
                avgCpuPercent: 0,
                samples: 0 
            };
        }
        
        // Calculate memory statistics
        const avgMemory = this.samples.reduce((sum, sample) => 
            sum + (sample.memory ? sample.memory.rss : 0), 0) / this.samples.length;
        const peakMemory = Math.max(...this.samples.map(s => s.memory ? s.memory.rss : 0));
        
        // Calculate CPU usage percentage (approximation)
        let avgCpuPercent = 0;
        if (this.samples.length > 1) {
            const totalTime = this.samples[this.samples.length - 1].timestamp - this.samples[0].timestamp;
            if (totalTime > 0) {
                // This is a rough approximation
                const cpuSamples = this.samples.filter(s => s.cpu);
                if (cpuSamples.length > 0) {
                    avgCpuPercent = cpuSamples.reduce((sum, sample) => 
                        sum + (sample.cpu.user + sample.cpu.system), 0) / cpuSamples.length / 1000; // microseconds to ms
                }
            }
        }
        
        return {
            avgMemoryMB: (avgMemory || 0) / 1024 / 1024,
            peakMemoryMB: (peakMemory || 0) / 1024 / 1024,
            avgCpuPercent: Math.min(avgCpuPercent, 100), // Cap at 100%
            samples: this.samples.length,
            totalTimeMs: this.samples.length > 0 ? 
                this.samples[this.samples.length - 1].timestamp - this.samples[0].timestamp : 0
        };
    }
}

// Configuration for realistic webpack/vite scenarios
const BENCHMARK_CONFIG = {
    // Test scenarios that match real development workflows
    scenarios: [
        { name: "small_project", fileCount: 50, description: "Small React/Vue project" },
        { name: "medium_project", fileCount: 500, description: "Medium webapp with deps" },
        { name: "large_project", fileCount: 2000, description: "Large monorepo project" },
        { name: "huge_project", fileCount: 10000, description: "Enterprise codebase" },
    ],
    iterations: 5, // Multiple runs for statistical significance
    timeoutMs: 60000, // 1 minute timeout
    fileSize: 2048, // 2KB per file (realistic average)
    // Test different types of file changes
    testTypes: ['modify', 'create', 'delete'],
    // Memory and CPU sampling
    resourceSamplingMs: 100,
};

// Colors for output
const colors = {
    reset: '\x1b[0m', bright: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m',
    yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
};

function colorize(color, text) {
    return `${colors[color]}${text}${colors.reset}`;
}

// Create test directory structure that mimics real projects
async function createRealisticProject(testDir, fileCount) {
    await fs.promises.mkdir(testDir, { recursive: true });
    
    const structure = [
        'src/components', 'src/utils', 'src/hooks', 'src/pages', 'src/styles',
        'public', 'tests', 'node_modules/some-package/dist', 'build', 'dist'
    ];
    
    // Create directory structure
    for (const dir of structure) {
        await fs.promises.mkdir(path.join(testDir, dir), { recursive: true });
    }
    
    // Create files with realistic extensions and sizes
    const extensions = ['.js', '.ts', '.jsx', '.tsx', '.vue', '.css', '.scss', '.json'];
    const promises = [];
    
    for (let i = 0; i < fileCount; i++) {
        const ext = extensions[i % extensions.length];
        const dirIndex = Math.floor(i / (fileCount / structure.length));
        const targetDir = structure[Math.min(dirIndex, structure.length - 1)];
        
        const filePath = path.join(testDir, targetDir, `file_${i}${ext}`);
        const content = generateRealisticContent(ext, BENCHMARK_CONFIG.fileSize);
        
        promises.push(fs.promises.writeFile(filePath, content));
    }
    
    await Promise.all(promises);
    
    // Create some package.json and config files
    await fs.promises.writeFile(path.join(testDir, 'package.json'), 
        JSON.stringify({ name: "test-project", scripts: { dev: "vite" } }, null, 2));
    await fs.promises.writeFile(path.join(testDir, 'vite.config.js'), 
        'export default { server: { hmr: true } }');
}

function generateRealisticContent(extension, targetSize) {
    const templates = {
        '.js': 'export function component() { return "Hello World"; }\n',
        '.ts': 'export interface Props { id: string; }\nexport const Component: React.FC<Props> = () => {};\n',
        '.jsx': 'import React from "react";\nexport const Component = () => <div>Hello</div>;\n',
        '.tsx': 'import React from "react";\ninterface Props { title: string }\nexport const Component: React.FC<Props> = ({title}) => <h1>{title}</h1>;\n',
        '.vue': '<template><div>{{ message }}</div></template>\n<script>export default { data() { return { message: "Hello" } } }</script>\n',
        '.css': '.container { display: flex; justify-content: center; align-items: center; }\n',
        '.scss': '$primary-color: #333;\n.button { background: $primary-color; }\n',
        '.json': '{ "name": "test", "version": "1.0.0" }\n',
    };
    
    const template = templates[extension] || 'console.log("test");\n';
    
    // Repeat content to reach target size
    let content = template;
    while (content.length < targetSize) {
        content += template;
    }
    
    return content.substring(0, targetSize);
}

// Clean up test files
async function cleanupTestFiles(testDir) {
    try {
        await fs.promises.rm(testDir, { recursive: true, force: true });
    } catch (error) {
        // Ignore cleanup errors
    }
}

// Chokidar benchmark (webpack/vite default)
async function benchmarkChokidar(testDir, scenario) {
    try {
        const chokidar = require('chokidar');
        
        let eventCount = 0;
        let startTime, firstEventTime, lastEventTime;
        const events = [];
        
        const watcher = chokidar.watch(testDir, {
            ignoreInitial: true,
            persistent: true,
            depth: 10,
            // Webpack-like configuration
            ignored: /node_modules|\.git/,
        });
        
        watcher.on('change', (filePath) => {
            const now = performance.now();
            if (eventCount === 0) {
                firstEventTime = now;
            }
            eventCount++;
            lastEventTime = now;
            events.push({ path: filePath, time: now });
        });
        
        // Wait for ready
        await new Promise((resolve) => {
            watcher.on('ready', resolve);
        });
        
        // Start resource monitoring
        const resourceMonitor = new ResourceMonitor();
        resourceMonitor.start(BENCHMARK_CONFIG.resourceSamplingMs);
        
        // Start modifying files (simulate real development workflow)
        startTime = performance.now();
        
        const modifyPromises = [];
        const filesToModify = Math.min(scenario.fileCount, 100); // Don't modify all files at once
        
        for (let i = 0; i < filesToModify; i++) {
            const fileIndex = Math.floor(Math.random() * scenario.fileCount);
            const filePath = path.join(testDir, `src/components/file_${fileIndex}.js`);
            
            // Simulate real edit - add a comment
            modifyPromises.push(
                fs.promises.appendFile(filePath, `\n// Modified at ${Date.now()}\n`)
                    .catch(() => {}) // Ignore if file doesn't exist
            );
        }
        
        await Promise.all(modifyPromises);
        
        // Wait for all events with timeout
        const timeout = BENCHMARK_CONFIG.timeoutMs;
        const endTime = Date.now() + timeout;
        
        while (eventCount < filesToModify && Date.now() < endTime) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        
        const resources = resourceMonitor.stop();
        await watcher.close();
        
        const totalTime = lastEventTime - startTime;
        const firstEventLatency = firstEventTime - startTime;
        const avgLatency = totalTime / Math.max(eventCount, 1);
        
        return {
            success: true,
            watcher: 'chokidar',
            scenario: scenario.name,
            eventsReceived: eventCount,
            expectedEvents: filesToModify,
            totalTimeMs: totalTime,
            firstEventLatencyMs: firstEventLatency,
            avgLatencyMs: avgLatency,
            eventsPerSecond: eventCount / (totalTime / 1000),
            ...resources
        };
        
    } catch (error) {
        return {
            success: false,
            watcher: 'chokidar',
            scenario: scenario.name,
            error: error.message,
        };
    }
}

// Parcel Watcher benchmark (webpack 5+ alternative)
async function benchmarkParcelWatcher(testDir, scenario) {
    try {
        const watcher = require('@parcel/watcher');
        
        let eventCount = 0;
        let startTime, firstEventTime, lastEventTime;
        let subscription;
        
        // Setup event handler
        const eventHandler = (err, events) => {
            if (err) return;
            
            events.forEach(event => {
                if (eventCount === 0) {
                    firstEventTime = performance.now();
                }
                eventCount++;
                lastEventTime = performance.now();
            });
        };
        
        // Start watching
        subscription = await watcher.subscribe(testDir, eventHandler, {
            ignore: ['node_modules', '.git', 'dist', 'build']
        });
        
        await new Promise(resolve => setTimeout(resolve, 200)); // Wait for watcher to be ready
        
        const resourceMonitor = new ResourceMonitor();
        resourceMonitor.start(BENCHMARK_CONFIG.resourceSamplingMs);
        
        startTime = performance.now();
        
        const modifyPromises = [];
        const filesToModify = Math.min(scenario.fileCount, 100);
        
        for (let i = 0; i < filesToModify; i++) {
            const fileIndex = Math.floor(Math.random() * scenario.fileCount);
            const filePath = path.join(testDir, `src/components/file_${fileIndex}.js`);
            
            modifyPromises.push(
                fs.promises.appendFile(filePath, `\n// Modified at ${Date.now()}\n`)
                    .catch(() => {})
            );
        }
        
        await Promise.all(modifyPromises);
        
        // Wait for events
        const timeout = BENCHMARK_CONFIG.timeoutMs;
        const endTime = Date.now() + timeout;
        
        while (eventCount < filesToModify && Date.now() < endTime) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        
        const resources = resourceMonitor.stop();
        await subscription.unsubscribe();
        
        const totalTime = lastEventTime - startTime;
        const firstEventLatency = firstEventTime - startTime;
        const avgLatency = totalTime / Math.max(eventCount, 1);
        
        return {
            success: true,
            watcher: 'parcel-watcher',
            scenario: scenario.name,
            eventsReceived: eventCount,
            expectedEvents: filesToModify,
            totalTimeMs: totalTime,
            firstEventLatencyMs: firstEventLatency,
            avgLatencyMs: avgLatency,
            eventsPerSecond: eventCount / (totalTime / 1000),
            ...resources
        };
        
    } catch (error) {
        return {
            success: false,
            watcher: 'parcel-watcher',
            scenario: scenario.name,
            error: error.message,
        };
    }
}

// Retrigger benchmark
async function benchmarkRetrigger(testDir, scenario) {
    try {
        const { RetriggerWrapper } = require('../../src/bindings/nodejs');
        
        const watcher = new RetriggerWrapper();
        let eventCount = 0;
        let startTime, firstEventTime, lastEventTime;
        
        // Start watching
        await watcher.watchDirectory(testDir, { recursive: true });
        await watcher.start();
        
        await new Promise(resolve => setTimeout(resolve, 300)); // Wait for watcher
        
        const resourceMonitor = new ResourceMonitor();
        resourceMonitor.start(BENCHMARK_CONFIG.resourceSamplingMs);
        
        startTime = performance.now();
        
        const modifyPromises = [];
        const filesToModify = Math.min(scenario.fileCount, 100);
        
        for (let i = 0; i < filesToModify; i++) {
            const fileIndex = Math.floor(Math.random() * scenario.fileCount);
            const filePath = path.join(testDir, `src/components/file_${fileIndex}.js`);
            
            modifyPromises.push(
                fs.promises.appendFile(filePath, `\n// Modified at ${Date.now()}\n`)
                    .catch(() => {})
            );
        }
        
        await Promise.all(modifyPromises);
        
        // Poll for events
        const timeout = BENCHMARK_CONFIG.timeoutMs;
        const endTime = Date.now() + timeout;
        
        while (eventCount < filesToModify && Date.now() < endTime) {
            try {
                const eventResult = await watcher.pollEvent();
                if (eventResult && eventResult.path) {
                    if (eventCount === 0) {
                        firstEventTime = performance.now();
                    }
                    eventCount++;
                    lastEventTime = performance.now();
                }
            } catch (e) {
                await new Promise(resolve => setTimeout(resolve, 1));
            }
        }
        
        const resources = resourceMonitor.stop();
        
        const totalTime = lastEventTime - startTime;
        const firstEventLatency = firstEventTime - startTime;
        const avgLatency = totalTime / Math.max(eventCount, 1);
        
        let stats = {};
        try {
            stats = await watcher.getStats() || {};
        } catch (e) {
            stats = {};
        }
        
        return {
            success: true,
            watcher: 'retrigger',
            scenario: scenario.name,
            eventsReceived: eventCount,
            expectedEvents: filesToModify,
            totalTimeMs: totalTime,
            firstEventLatencyMs: firstEventLatency,
            avgLatencyMs: avgLatency,
            eventsPerSecond: eventCount / (totalTime / 1000),
            simdLevel: watcher.getSimdLevel ? watcher.getSimdLevel() : 'unknown',
            ...resources
        };
        
    } catch (error) {
        return {
            success: false,
            watcher: 'retrigger',
            scenario: scenario.name,
            error: error.message,
        };
    }
}

// Watchpack benchmark (webpack internal)
async function benchmarkWatchpack(testDir, scenario) {
    try {
        // Watchpack is webpack's internal watcher
        const Watchpack = require('watchpack');
        
        let eventCount = 0;
        let startTime, firstEventTime, lastEventTime;
        
        const wp = new Watchpack({
            ignored: /node_modules/,
        });
        
        wp.watch({
            files: [],
            directories: [testDir],
            missing: [],
            startTime: Date.now()
        });
        
        wp.on('change', (filePath) => {
            if (eventCount === 0) {
                firstEventTime = performance.now();
            }
            eventCount++;
            lastEventTime = performance.now();
        });
        
        await new Promise(resolve => setTimeout(resolve, 200));
        
        const resourceMonitor = new ResourceMonitor();
        resourceMonitor.start(BENCHMARK_CONFIG.resourceSamplingMs);
        
        startTime = performance.now();
        
        const modifyPromises = [];
        const filesToModify = Math.min(scenario.fileCount, 100);
        
        for (let i = 0; i < filesToModify; i++) {
            const fileIndex = Math.floor(Math.random() * scenario.fileCount);
            const filePath = path.join(testDir, `src/components/file_${fileIndex}.js`);
            
            modifyPromises.push(
                fs.promises.appendFile(filePath, `\n// Modified at ${Date.now()}\n`)
                    .catch(() => {})
            );
        }
        
        await Promise.all(modifyPromises);
        
        // Wait for events
        const timeout = BENCHMARK_CONFIG.timeoutMs;
        const endTime = Date.now() + timeout;
        
        while (eventCount < filesToModify && Date.now() < endTime) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        
        const resources = resourceMonitor.stop();
        wp.close();
        
        const totalTime = lastEventTime - startTime;
        const firstEventLatency = firstEventTime - startTime;
        const avgLatency = totalTime / Math.max(eventCount, 1);
        
        return {
            success: true,
            watcher: 'watchpack',
            scenario: scenario.name,
            eventsReceived: eventCount,
            expectedEvents: filesToModify,
            totalTimeMs: totalTime,
            firstEventLatencyMs: firstEventLatency,
            avgLatencyMs: avgLatency,
            eventsPerSecond: eventCount / (totalTime / 1000),
            ...resources
        };
        
    } catch (error) {
        return {
            success: false,
            watcher: 'watchpack',  
            scenario: scenario.name,
            error: error.message,
        };
    }
}

// Run single benchmark
async function runSingleBenchmark(name, benchmarkFn, testDir, scenario, iteration) {
    console.log(`    ${colorize('cyan', name)} (run ${iteration + 1}/${BENCHMARK_CONFIG.iterations})...`);
    
    try {
        const result = await Promise.race([
            benchmarkFn(testDir, scenario),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Benchmark timeout')), BENCHMARK_CONFIG.timeoutMs + 5000)
            )
        ]);
        
        if (result.success) {
            const completeness = (result.eventsReceived / result.expectedEvents * 100);
            console.log(`      Events: ${result.eventsReceived}/${result.expectedEvents} (${completeness.toFixed(1)}%)`);
            console.log(`      Latency: ${result.firstEventLatencyMs?.toFixed(2) || 'N/A'}ms (first), ${result.avgLatencyMs?.toFixed(2) || 'N/A'}ms (avg)`);
            console.log(`      Resources: ${result.avgMemoryMB?.toFixed(1) || 'N/A'}MB memory, ${result.avgCpuPercent?.toFixed(1) || 'N/A'}% CPU`);
            
            if (result.simdLevel) {
                console.log(`      SIMD: ${result.simdLevel}`);
            }
        } else {
            console.log(`      ${colorize('red', 'Failed:')} ${result.error}`);
        }
        
        return result;
        
    } catch (error) {
        console.log(`      ${colorize('red', 'Error:')} ${error.message}`);
        return { success: false, watcher: name, scenario: scenario.name, error: error.message };
    }
}

// Calculate statistics from multiple runs
function calculateStats(results) {
    const successful = results.filter(r => r.success && r.eventsReceived > 0);
    
    if (successful.length === 0) {
        return { success: false, runs: 0 };
    }
    
    const getValue = (key) => successful.map(r => r[key]).filter(v => v != null && !isNaN(v));
    
    const calc = (values) => values.length > 0 ? {
        avg: values.reduce((a, b) => a + b, 0) / values.length,
        min: Math.min(...values),
        max: Math.max(...values)
    } : { avg: 0, min: 0, max: 0 };
    
    return {
        success: true,
        runs: successful.length,
        ...calc(getValue('avgLatencyMs')),
        firstLatency: calc(getValue('firstEventLatencyMs')),
        throughput: calc(getValue('eventsPerSecond')),
        memory: calc(getValue('avgMemoryMB')),
        cpu: calc(getValue('avgCpuPercent')),
        completeness: (successful.reduce((sum, r) => sum + r.eventsReceived, 0) / 
                      successful.reduce((sum, r) => sum + r.expectedEvents, 0)) * 100
    };
}

// Display results in a formatted table
function displayResults(allResults) {
    console.log(`\n${colorize('bright', 'WEBPACK/VITE FILE WATCHER COMPARISON')}`);
    console.log('='.repeat(120));
    
    // Group results by scenario
    const scenarios = BENCHMARK_CONFIG.scenarios;
    
    scenarios.forEach(scenario => {
        console.log(`\n${colorize('yellow', `${scenario.description} (${scenario.fileCount} files)`)}`);
        console.log('-'.repeat(80));
        
        const scenarioResults = allResults[scenario.name];
        if (!scenarioResults) return;
        
        // Table header
        console.log(`${'Watcher'.padEnd(15)} | ${'Latency (ms)'.padEnd(15)} | ${'Memory (MB)'.padEnd(12)} | ${'CPU %'.padEnd(8)} | ${'Events/s'.padEnd(10)} | ${'Status'.padEnd(10)}`);
        console.log('-'.repeat(90));
        
        let bestLatency = Infinity;
        let bestWatcher = '';
        
        Object.entries(scenarioResults).forEach(([watcher, stats]) => {
            if (stats.success && stats.runs > 0) {
                const latency = `${stats.avg.toFixed(1)} ±${(stats.max - stats.min).toFixed(1)}`;
                const memory = stats.memory.avg > 0 ? `${stats.memory.avg.toFixed(1)}` : 'N/A';
                const cpu = stats.cpu.avg > 0 ? `${stats.cpu.avg.toFixed(1)}` : 'N/A';
                const throughput = `${stats.throughput.avg.toFixed(0)}`;
                const status = stats.completeness >= 90 ? 
                    colorize('green', `${stats.completeness.toFixed(1)}%`) : 
                    colorize('yellow', `${stats.completeness.toFixed(1)}%`);
                
                if (stats.avg < bestLatency && stats.completeness >= 90) {
                    bestLatency = stats.avg;
                    bestWatcher = watcher;
                }
                
                console.log(`${watcher.padEnd(15)} | ${latency.padEnd(15)} | ${memory.padEnd(12)} | ${cpu.padEnd(8)} | ${throughput.padEnd(10)} | ${status.padEnd(10)}`);
            } else {
                console.log(`${watcher.padEnd(15)} | ${colorize('red', 'FAILED').padEnd(15)} | ${'N/A'.padEnd(12)} | ${'N/A'.padEnd(8)} | ${'N/A'.padEnd(10)} | ${colorize('red', 'ERROR').padEnd(10)}`);
            }
        });
        
        if (bestWatcher) {
            console.log(`${colorize('green', '🏆 Best performance:')} ${colorize('green', bestWatcher)}`);
        }
    });
    
    // Summary comparison against README claims
    console.log(`\n${colorize('bright', 'README CLAIMS VERIFICATION')}`);
    console.log('='.repeat(60));
    
    scenarios.forEach(scenario => {
        const results = allResults[scenario.name];
        if (!results) return;
        
        const retrigger = results.retrigger;
        const chokidar = results.chokidar;
        
        if (retrigger?.success && chokidar?.success) {
            const latencyImprovement = chokidar.avg / retrigger.avg;
            const memoryImprovement = chokidar.memory.avg > 0 && retrigger.memory.avg > 0 ? 
                chokidar.memory.avg / retrigger.memory.avg : null;
            
            console.log(`\n${scenario.description}:`);
            console.log(`  Latency improvement: ${latencyImprovement.toFixed(1)}x faster than chokidar`);
            console.log(`  README claim: 100-400x faster (${colorize(latencyImprovement >= 100 ? 'green' : 'red', latencyImprovement >= 100 ? 'VERIFIED' : 'NOT VERIFIED')})`);
            
            if (memoryImprovement) {
                console.log(`  Memory improvement: ${memoryImprovement.toFixed(1)}x less than chokidar`);
                console.log(`  README claim: 2-7x less memory (${colorize(memoryImprovement >= 2 ? 'green' : 'red', memoryImprovement >= 2 ? 'VERIFIED' : 'NOT VERIFIED')})`);
            }
            
            // Hot reload latency check
            if (retrigger.avg < 5) {
                console.log(`  Hot reload: ${colorize('green', 'VERIFIED')} - ${retrigger.avg.toFixed(1)}ms < 5ms claim`);
            } else {
                console.log(`  Hot reload: ${colorize('red', 'NOT VERIFIED')} - ${retrigger.avg.toFixed(1)}ms >= 5ms claim`);
            }
        }
    });
}

// Main benchmark execution
async function runBenchmarks() {
    console.log(colorize('bright', 'Webpack/Vite File Watcher Performance Benchmark'));
    console.log(colorize('cyan', 'Testing against real-world development scenarios'));
    console.log('='.repeat(80));
    
    // File watchers commonly used with webpack/vite
    const watchers = {
        chokidar: benchmarkChokidar,
        'parcel-watcher': benchmarkParcelWatcher,
        retrigger: benchmarkRetrigger,
    };
    
    // Try to add watchpack if available (webpack internal)
    try {
        require('watchpack');
        watchers.watchpack = benchmarkWatchpack;
    } catch (e) {
        console.log(colorize('yellow', 'Note: watchpack not available, skipping'));
    }
    
    const allResults = {};
    
    // Initialize results structure
    BENCHMARK_CONFIG.scenarios.forEach(scenario => {
        allResults[scenario.name] = {};
        Object.keys(watchers).forEach(watcher => {
            allResults[scenario.name][watcher] = {};
        });
    });
    
    // Run benchmarks for each scenario
    for (const scenario of BENCHMARK_CONFIG.scenarios) {
        console.log(`\n${colorize('bright', `Testing: ${scenario.description}`)}`);
        console.log(`Files: ${scenario.fileCount}, Iterations: ${BENCHMARK_CONFIG.iterations}`);
        console.log('-'.repeat(50));
        
        const testDir = path.join(os.tmpdir(), `retrigger_bench_${scenario.name}_${Date.now()}`);
        
        try {
            // Create realistic project structure
            console.log('  Creating realistic project structure...');
            await createRealisticProject(testDir, scenario.fileCount);
            
            // Run each watcher multiple times
            for (const [name, benchmarkFn] of Object.entries(watchers)) {
                console.log(`  ${colorize('magenta', `Testing ${name}...`)}`);
                const iterationResults = [];
                
                for (let i = 0; i < BENCHMARK_CONFIG.iterations; i++) {
                    const result = await runSingleBenchmark(name, benchmarkFn, testDir, scenario, i);
                    iterationResults.push(result);
                    
                    // Brief pause between iterations
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
                
                // Calculate statistics for this watcher
                const stats = calculateStats(iterationResults);
                allResults[scenario.name][name] = stats;
                
                if (stats.success) {
                    console.log(`    ${colorize('green', '✓')} Average: ${stats.avg.toFixed(1)}ms, ${stats.runs}/${BENCHMARK_CONFIG.iterations} successful runs`);
                } else {
                    console.log(`    ${colorize('red', '✗')} Failed all iterations`);
                }
            }
            
        } finally {
            // Cleanup
            await cleanupTestFiles(testDir);
        }
    }
    
    // Display final results
    displayResults(allResults);
    
    return allResults;
}

// Check dependencies and run
async function main() {
    console.log('Checking dependencies...\n');
    
    const dependencies = [];
    
    try {
        require('../../src/bindings/nodejs');
        dependencies.push({ name: 'retrigger', available: true });
    } catch (error) {
        dependencies.push({ name: 'retrigger', available: false, error: 'Build bindings first' });
    }
    
    try {
        require('chokidar');
        dependencies.push({ name: 'chokidar', available: true });
    } catch (error) {
        dependencies.push({ name: 'chokidar', available: false, error: 'npm install chokidar' });
    }
    
    try {
        require('@parcel/watcher');
        dependencies.push({ name: 'parcel-watcher', available: true });
    } catch (error) {
        dependencies.push({ name: 'parcel-watcher', available: false, error: 'npm install @parcel/watcher' });
    }
    
    try {
        require('watchpack');
        dependencies.push({ name: 'watchpack', available: true });
    } catch (error) {
        dependencies.push({ name: 'watchpack', available: false, error: 'npm install watchpack' });
    }
    
    dependencies.forEach(dep => {
        const status = dep.available ? colorize('green', '✓') : colorize('red', '✗');
        console.log(`  ${status} ${dep.name}`);
        if (!dep.available) {
            console.log(`    ${colorize('yellow', dep.error)}`);
        }
    });
    console.log();
    
    const availableCount = dependencies.filter(dep => dep.available).length;
    if (availableCount < 2) {
        console.log(colorize('red', 'Error: Need at least 2 file watchers for comparison'));
        process.exit(1);
    }
    
    try {
        const results = await runBenchmarks();
        console.log(`\n${colorize('green', '✓')} Benchmark completed successfully!`);
        
        // Save results to file
        const resultsFile = path.join(__dirname, 'benchmark_results.json');
        await fs.promises.writeFile(resultsFile, JSON.stringify(results, null, 2));
        console.log(`Results saved to: ${resultsFile}`);
        
    } catch (error) {
        console.error(`\n${colorize('red', 'Error:')} ${error.message}`);
        console.error(error.stack);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    runBenchmarks,
    BENCHMARK_CONFIG,
};
