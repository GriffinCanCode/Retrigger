//! High-performance benchmark suite for file system monitoring
//! Follows SRP: Only responsible for measuring and verifying performance metrics

const std = @import("std");
const main_module = @import("main.zig");
const FileWatcher = main_module.FileWatcher;
const FileEvent = main_module.FileEvent;
const EventType = main_module.EventType;
const print = std.debug.print;

/// Benchmark configuration
pub const BenchmarkConfig = struct {
    test_duration_ms: u32 = 5000,
    target_latency_ns: u64 = 1_000_000, // 1ms target
    num_test_files: u32 = 1000,
    concurrent_operations: u32 = 10,
    test_directory: []const u8 = "/tmp/retrigger_bench",

    // Performance thresholds
    max_acceptable_latency_ns: u64 = 2_000_000, // 2ms max
    min_events_per_second: u32 = 10000,
    max_dropped_events_percent: f64 = 0.1, // 0.1% max dropped
};

/// Benchmark statistics
const BenchmarkStats = struct {
    total_events: u64 = 0,
    total_operations: u64 = 0,
    min_latency_ns: u64 = std.math.maxInt(u64),
    max_latency_ns: u64 = 0,
    avg_latency_ns: f64 = 0,
    p50_latency_ns: u64 = 0,
    p95_latency_ns: u64 = 0,
    p99_latency_ns: u64 = 0,
    events_per_second: f64 = 0,
    dropped_events: u64 = 0,
    dropped_events_percent: f64 = 0,
    cpu_usage_percent: f64 = 0,
    memory_usage_mb: f64 = 0,

    // Latency histogram for detailed analysis
    latency_histogram: [100]u64 = [_]u64{0} ** 100,

    pub fn update_latency(self: *BenchmarkStats, latency_ns: u64) void {
        self.min_latency_ns = @min(self.min_latency_ns, latency_ns);
        self.max_latency_ns = @max(self.max_latency_ns, latency_ns);

        // Update histogram (buckets in 100μs intervals)
        const bucket = @min(latency_ns / 100_000, self.latency_histogram.len - 1);
        self.latency_histogram[bucket] += 1;
    }

    pub fn finalize(self: *BenchmarkStats, latencies: []u64, duration_ms: u32) void {
        if (latencies.len == 0) return;

        // Sort latencies for percentile calculation
        std.mem.sort(u64, latencies, {}, comptime std.sort.asc(u64));

        // Calculate percentiles
        const len = latencies.len;
        self.p50_latency_ns = latencies[len / 2];
        self.p95_latency_ns = latencies[(len * 95) / 100];
        self.p99_latency_ns = latencies[(len * 99) / 100];

        // Calculate average
        var sum: u64 = 0;
        for (latencies) |latency| {
            sum += latency;
        }
        self.avg_latency_ns = @as(f64, @floatFromInt(sum)) / @as(f64, @floatFromInt(len));

        // Calculate events per second
        self.events_per_second = @as(f64, @floatFromInt(self.total_events * 1000)) / @as(f64, @floatFromInt(duration_ms));

        // Calculate dropped events percentage
        if (self.total_events > 0) {
            self.dropped_events_percent = (@as(f64, @floatFromInt(self.dropped_events)) / @as(f64, @floatFromInt(self.total_events))) * 100.0;
        }
    }
};

/// Individual benchmark test following ISP
const BenchmarkTest = struct {
    name: []const u8,
    description: []const u8,
    run_fn: *const fn (allocator: std.mem.Allocator, config: BenchmarkConfig) anyerror!BenchmarkStats,
};

/// Main benchmark runner following OCP
pub const BenchmarkRunner = struct {
    const Self = @This();

    allocator: std.mem.Allocator,
    config: BenchmarkConfig,
    tests: std.ArrayList(BenchmarkTest),

    pub fn init(allocator: std.mem.Allocator, config: BenchmarkConfig) Self {
        return Self{
            .allocator = allocator,
            .config = config,
            .tests = std.ArrayList(BenchmarkTest){},
        };
    }

    pub fn deinit(self: *Self) void {
        self.tests.deinit(self.allocator);
    }

    pub fn add_test(self: *Self, test_case: BenchmarkTest) !void {
        try self.tests.append(self.allocator, test_case);
    }

    pub fn run_all_tests(self: *Self) !void {
        print("\n🚀 Retrigger System Integration Benchmark Suite\n", .{});
        print("================================================\n", .{});
        print("Target Latency: {any} μs\n", .{self.config.target_latency_ns / 1000});
        print("Test Duration: {any} ms\n", .{self.config.test_duration_ms});
        print("Test Files: {any}\n", .{self.config.num_test_files});
        print("Concurrent Ops: {any}\n\n", .{self.config.concurrent_operations});

        var total_passed: u32 = 0;
        var total_tests: u32 = 0;

        for (self.tests.items) |test_case| {
            total_tests += 1;
            print("🔬 Running: {s}\n", .{test_case.name});
            print("   {s}\n", .{test_case.description});

            const stats = test_case.run_fn(self.allocator, self.config) catch |err| {
                print("   ❌ ERROR: {}\n\n", .{err});
                continue;
            };

            const passed = self.evaluate_test_results(stats);
            if (passed) {
                print("   ✅ PASSED\n", .{});
                total_passed += 1;
            } else {
                print("   ❌ FAILED\n", .{});
            }

            self.print_test_results(stats);
            print("\n", .{});
        }

        print("📊 Summary: {}/{} tests passed\n", .{ total_passed, total_tests });

        if (total_passed == total_tests) {
            print("🎉 All benchmarks passed! System meets performance targets.\n", .{});
        } else {
            print("⚠️  Some benchmarks failed. Performance tuning recommended.\n", .{});
        }
    }

    fn evaluate_test_results(self: *const Self, stats: BenchmarkStats) bool {
        // Check latency target
        if (stats.p99_latency_ns > self.config.max_acceptable_latency_ns) {
            return false;
        }

        // Check events per second
        if (stats.events_per_second < @as(f64, @floatFromInt(self.config.min_events_per_second))) {
            return false;
        }

        // Check dropped events percentage
        if (stats.dropped_events_percent > self.config.max_dropped_events_percent) {
            return false;
        }

        return true;
    }

    fn print_test_results(self: *const Self, stats: BenchmarkStats) void {
        _ = self;
        print("   📈 Results:\n", .{});
        print("      Events Processed: {}\n", .{stats.total_events});
        print("      Events/sec: {d:.0}\n", .{stats.events_per_second});
        print("      Avg Latency: {d:.0} μs\n", .{stats.avg_latency_ns / 1000});
        print("      P50 Latency: {} μs\n", .{stats.p50_latency_ns / 1000});
        print("      P95 Latency: {} μs\n", .{stats.p95_latency_ns / 1000});
        print("      P99 Latency: {} μs\n", .{stats.p99_latency_ns / 1000});
        print("      Max Latency: {} μs\n", .{stats.max_latency_ns / 1000});
        print("      Dropped Events: {} ({d:.2}%)\n", .{ stats.dropped_events, stats.dropped_events_percent });
    }
};

/// Setup test environment
fn setup_test_environment(allocator: std.mem.Allocator, config: BenchmarkConfig) !void {
    // Create test directory
    std.fs.cwd().makeDir(config.test_directory) catch |err| switch (err) {
        error.PathAlreadyExists => {}, // OK if exists
        else => return err,
    };

    // Clean up any existing test files
    var dir = try std.fs.cwd().openDir(config.test_directory, .{ .iterate = true });
    defer dir.close();

    var iterator = dir.iterate();
    while (try iterator.next()) |entry| {
        if (std.mem.startsWith(u8, entry.name, "test_")) {
            dir.deleteFile(entry.name) catch {};
        }
    }

    _ = allocator;
}

/// Cleanup test environment
fn cleanup_test_environment(allocator: std.mem.Allocator, config: BenchmarkConfig) !void {
    _ = allocator;

    // Remove test directory
    std.fs.cwd().deleteTree(config.test_directory) catch {};
}

/// Basic latency benchmark - measures file creation to event latency
pub fn benchmark_basic_latency(allocator: std.mem.Allocator, config: BenchmarkConfig) !BenchmarkStats {
    try setup_test_environment(allocator, config);
    defer cleanup_test_environment(allocator, config) catch {};

    var stats = BenchmarkStats{};
    var latencies = std.ArrayList(u64){};
    defer latencies.deinit(allocator);

    // Initialize file watcher
    var watcher = try FileWatcher.init(allocator);
    defer watcher.deinit();

    try watcher.watch_directory(config.test_directory, false);
    try watcher.start();

    const start_time = std.time.milliTimestamp();
    var operations: u32 = 0;

    while (std.time.milliTimestamp() - start_time < config.test_duration_ms and operations < config.num_test_files) {
        const operation_start = std.time.nanoTimestamp();

        // Create test file
        var filename_buf: [256]u8 = undefined;
        const filename = try std.fmt.bufPrint(&filename_buf, "{s}/test_{}.txt", .{ config.test_directory, operations });

        var file = try std.fs.cwd().createFile(filename, .{});
        try file.writeAll("test data");
        file.close();

        // Wait for event with timeout
        const event = watcher.wait_event(100) catch null;

        if (event) |e| {
            const current_time = @as(u64, @intCast(std.time.nanoTimestamp()));
            const latency_ns: u64 = if (current_time > operation_start) @as(u64, @intCast(current_time -% operation_start)) else 0;
            stats.update_latency(latency_ns);
            try latencies.append(allocator, latency_ns);
            stats.total_events += 1;

            // Cleanup event
            allocator.free(e.path);
        }

        operations += 1;
        stats.total_operations += 1;
    }

    // Get watcher statistics
    const watcher_stats = watcher.get_stats();
    stats.dropped_events = watcher_stats.dropped;

    stats.finalize(latencies.items, config.test_duration_ms);
    return stats;
}

/// High-throughput benchmark - measures maximum events per second
pub fn benchmark_high_throughput(allocator: std.mem.Allocator, config: BenchmarkConfig) !BenchmarkStats {
    try setup_test_environment(allocator, config);
    defer cleanup_test_environment(allocator, config) catch {};

    var stats = BenchmarkStats{};
    var latencies = std.ArrayList(u64){};
    defer latencies.deinit(allocator);

    var watcher = try FileWatcher.init(allocator);
    defer watcher.deinit();

    try watcher.watch_directory(config.test_directory, false);
    try watcher.start();

    const start_time = std.time.milliTimestamp();
    var operations: u32 = 0;

    // Create files as fast as possible
    while (std.time.milliTimestamp() - start_time < config.test_duration_ms and operations < config.num_test_files) {
        const operation_start = std.time.nanoTimestamp();

        var filename_buf: [256]u8 = undefined;
        const filename = try std.fmt.bufPrint(&filename_buf, "{s}/test_{}.txt", .{ config.test_directory, operations });

        var file = try std.fs.cwd().createFile(filename, .{});
        try file.writeAll("test data");
        file.close();

        // Immediately try to get event (non-blocking)
        if (watcher.poll_event()) |e| {
            const current_time = @as(u64, @intCast(std.time.nanoTimestamp()));
            const latency_ns: u64 = if (current_time > operation_start) @as(u64, @intCast(current_time -% operation_start)) else 0;
            stats.update_latency(latency_ns);
            try latencies.append(allocator, latency_ns);
            stats.total_events += 1;
            allocator.free(e.path);
        }

        operations += 1;
        stats.total_operations += 1;
    }

    // Process any remaining events
    while (watcher.poll_event()) |e| {
        stats.total_events += 1;
        allocator.free(e.path);
    }

    const watcher_stats = watcher.get_stats();
    stats.dropped_events = watcher_stats.dropped;

    stats.finalize(latencies.items, config.test_duration_ms);
    return stats;
}

/// Concurrent operations benchmark - tests multi-threaded performance
pub fn benchmark_concurrent_operations(allocator: std.mem.Allocator, config: BenchmarkConfig) !BenchmarkStats {
    try setup_test_environment(allocator, config);
    defer cleanup_test_environment(allocator, config) catch {};

    var stats = BenchmarkStats{};
    var latencies = std.ArrayList(u64){};
    defer latencies.deinit(allocator);

    var watcher = try FileWatcher.init(allocator);
    defer watcher.deinit();

    try watcher.watch_directory(config.test_directory, true);
    try watcher.start();

    // Create worker threads
    var threads = std.ArrayList(std.Thread){};
    defer {
        for (threads.items) |thread| {
            thread.join();
        }
        threads.deinit(allocator);
    }

    const worker_operations = config.num_test_files / config.concurrent_operations;

    for (0..config.concurrent_operations) |thread_id| {
        const thread = try std.Thread.spawn(.{}, concurrent_worker, .{ config, thread_id, worker_operations });
        try threads.append(allocator, thread);
    }

    // Monitor events while workers run
    const start_time = std.time.milliTimestamp();
    while (std.time.milliTimestamp() - start_time < config.test_duration_ms) {
        if (watcher.poll_event()) |e| {
            stats.total_events += 1;
            allocator.free(e.path);
        }
        std.Thread.sleep(1_000_000); // 1ms sleep to prevent busy waiting
    }

    // Wait for workers to complete
    for (threads.items) |thread| {
        thread.join();
    }

    // Process remaining events
    while (watcher.poll_event()) |e| {
        stats.total_events += 1;
        allocator.free(e.path);
    }

    const watcher_stats = watcher.get_stats();
    stats.dropped_events = watcher_stats.dropped;
    stats.total_operations = config.num_test_files;

    stats.finalize(latencies.items, config.test_duration_ms);
    return stats;
}

/// Worker function for concurrent benchmark
fn concurrent_worker(config: BenchmarkConfig, thread_id: usize, operations: u32) void {
    for (0..operations) |i| {
        var filename_buf: [256]u8 = undefined;
        const filename = std.fmt.bufPrint(&filename_buf, "{s}/test_{}_{}.txt", .{ config.test_directory, thread_id, i }) catch continue;

        var file = std.fs.cwd().createFile(filename, .{}) catch continue;
        file.writeAll("concurrent test data") catch {};
        file.close();

        std.Thread.sleep(1_000_000); // 1ms delay between operations
    }
}

/// Main benchmark entry point
pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    const config = BenchmarkConfig{
        .test_duration_ms = 10000, // 10 seconds
        .num_test_files = 5000,
        .concurrent_operations = 8,
    };

    var runner = BenchmarkRunner.init(allocator, config);
    defer runner.deinit();

    // Register benchmark tests
    try runner.add_test(.{
        .name = "Basic Latency",
        .description = "Measures file creation to event notification latency",
        .run_fn = benchmark_basic_latency,
    });

    try runner.add_test(.{
        .name = "High Throughput",
        .description = "Tests maximum events per second processing",
        .run_fn = benchmark_high_throughput,
    });

    try runner.add_test(.{
        .name = "Concurrent Operations",
        .description = "Multi-threaded file operations stress test",
        .run_fn = benchmark_concurrent_operations,
    });

    try runner.run_all_tests();
}
