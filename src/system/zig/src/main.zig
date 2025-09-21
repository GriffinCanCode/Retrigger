//! Retrigger System Integration Layer
//! High-performance file system monitoring using platform-native APIs
//! Follows SRP: Only responsible for system-level file watching

const std = @import("std");
const builtin = @import("builtin");
const print = std.debug.print;

// Platform-specific modules
const linux = @import("platform/linux.zig");
const macos = @import("platform/macos.zig");
const windows = @import("platform/windows.zig");

// Error handling
const error_handling = @import("error_handling.zig");
const ErrorHandler = error_handling.ErrorHandler;

// Performance optimization
const performance = @import("performance.zig");
const PerformanceOptimizer = performance.PerformanceOptimizer;

/// File system event types
pub const EventType = enum(u8) {
    created = 1,
    modified = 2,
    deleted = 3,
    moved = 4,
    metadata_changed = 5,
};

/// File system event structure
pub const FileEvent = struct {
    path: []const u8,
    event_type: EventType,
    timestamp: u64, // nanoseconds since epoch
    size: u64,
    is_directory: bool,

    pub fn deinit(self: *FileEvent, allocator: std.mem.Allocator) void {
        allocator.free(self.path);
    }
};

/// Ring buffer for lock-free event passing
pub const EventRingBuffer = struct {
    const BUFFER_SIZE = 64 * 1024 * 1024; // 64MB default
    const MAX_EVENTS = BUFFER_SIZE / @sizeOf(FileEvent);

    events: []FileEvent,
    read_pos: std.atomic.Value(u32),
    write_pos: std.atomic.Value(u32),
    allocator: std.mem.Allocator,

    pub fn init(allocator: std.mem.Allocator) !EventRingBuffer {
        const events = try allocator.alloc(FileEvent, MAX_EVENTS);
        return EventRingBuffer{
            .events = events,
            .read_pos = std.atomic.Value(u32).init(0),
            .write_pos = std.atomic.Value(u32).init(0),
            .allocator = allocator,
        };
    }

    pub fn deinit(self: *EventRingBuffer) void {
        self.allocator.free(self.events);
    }

    /// Lock-free push (producer)
    pub fn push(self: *EventRingBuffer, event: FileEvent) bool {
        const current_write = self.write_pos.load(.acquire);
        const next_write = (current_write + 1) % MAX_EVENTS;

        // Check if buffer is full
        if (next_write == self.read_pos.load(.acquire)) {
            return false; // Buffer full
        }

        self.events[current_write] = event;
        self.write_pos.store(next_write, .release);
        return true;
    }

    /// Lock-free pop (consumer)
    pub fn pop(self: *EventRingBuffer) ?FileEvent {
        const current_read = self.read_pos.load(.acquire);
        if (current_read == self.write_pos.load(.acquire)) {
            return null; // Buffer empty
        }

        const event = self.events[current_read];
        const next_read = (current_read + 1) % MAX_EVENTS;
        self.read_pos.store(next_read, .release);

        return event;
    }

    pub fn is_empty(self: *const EventRingBuffer) bool {
        return self.read_pos.load(.acquire) == self.write_pos.load(.acquire);
    }

    pub fn is_full(self: *const EventRingBuffer) bool {
        const next_write = (self.write_pos.load(.acquire) + 1) % MAX_EVENTS;
        return next_write == self.read_pos.load(.acquire);
    }
};

/// File system watcher interface - follows Interface Segregation Principle
pub const FileWatcher = struct {
    const Self = @This();

    // Platform-specific implementation
    impl: switch (builtin.os.tag) {
        .linux => linux.LinuxWatcher,
        .macos => macos.MacOSWatcher,
        .windows => windows.WindowsWatcher,
        else => @compileError("Unsupported platform"),
    },

    event_buffer: EventRingBuffer,
    allocator: std.mem.Allocator,
    is_running: std.atomic.Value(bool),

    // Error handling and recovery
    error_handler: ErrorHandler,

    // Performance optimization and monitoring
    performance_optimizer: PerformanceOptimizer,
    last_performance_check: std.atomic.Value(i64),
    events_processed_last_check: std.atomic.Value(u64),

    pub fn init(allocator: std.mem.Allocator) !Self {
        const event_buffer = try EventRingBuffer.init(allocator);
        var error_handler = error_handling.create_default_error_handler(allocator) catch |err| blk: {
            std.log.warn("Failed to create error handler: {any}. Using fallback error handler.", .{err});
            break :blk error_handling.ErrorHandler.init(allocator);
        };

        // Initialize performance optimizer with low-latency configuration
        const perf_config = performance.create_low_latency_config(allocator) catch performance.PerformanceConfig{};
        const performance_optimizer = PerformanceOptimizer.init(allocator, perf_config) catch |err| {
            std.log.warn("Failed to create performance optimizer: {any}. Continuing without performance optimizations.", .{err});
            return PerformanceOptimizer.init(allocator, performance.PerformanceConfig{}) catch unreachable;
        };

        return Self{
            .impl = switch (builtin.os.tag) {
                .linux => linux.LinuxWatcher.init(allocator) catch |err| {
                    error_handler.handle_error(.critical, .platform_api, err, "Failed to initialize Linux watcher");
                    return err;
                },
                .macos => macos.MacOSWatcher.init(allocator) catch |err| {
                    error_handler.handle_error(.critical, .platform_api, err, "Failed to initialize macOS watcher");
                    return err;
                },
                .windows => windows.WindowsWatcher.init(allocator) catch |err| {
                    error_handler.handle_error(.critical, .platform_api, err, "Failed to initialize Windows watcher");
                    return err;
                },
                else => unreachable,
            },
            .event_buffer = event_buffer,
            .allocator = allocator,
            .is_running = std.atomic.Value(bool).init(false),
            .error_handler = error_handler,
            .performance_optimizer = performance_optimizer,
            .last_performance_check = std.atomic.Value(i64).init(std.time.milliTimestamp()),
            .events_processed_last_check = std.atomic.Value(u64).init(0),
        };
    }

    pub fn deinit(self: *Self) void {
        self.stop();
        self.impl.deinit();
        self.event_buffer.deinit();
        self.error_handler.deinit();
        self.performance_optimizer.deinit();
    }

    /// Start watching a directory tree with error handling
    pub fn watch_directory(self: *Self, path: []const u8, recursive: bool) !void {
        self.impl.watch_directory(path, recursive, &self.event_buffer) catch |err| {
            const context = std.fmt.allocPrint(self.allocator, "Failed to watch directory: {s}", .{path}) catch "watch_directory";
            defer if (!std.mem.eql(u8, context, "watch_directory")) self.allocator.free(context);

            error_handling.handle_filesystem_error(&self.error_handler, err, context);
            return err;
        };
    }

    /// Remove a directory from watching
    pub fn unwatch_directory(self: *Self, path: []const u8) !void {
        return self.impl.unwatch_directory(path);
    }

    /// Start the watcher event loop with error handling
    pub fn start(self: *Self) !void {
        if (self.is_running.cmpxchgWeak(false, true, .acquire, .acquire)) |_| {
            return; // Already running
        }

        // Apply performance optimizations before starting monitoring
        self.performance_optimizer.apply_optimizations() catch |err| {
            std.log.warn("Failed to apply performance optimizations: {any}. Continuing with default performance.", .{err});
        };

        self.impl.start_monitoring() catch |err| {
            self.is_running.store(false, .release);
            error_handling.handle_platform_error(&self.error_handler, err, "Failed to start monitoring");
            return err;
        };

        // Initialize performance monitoring
        self.last_performance_check.store(std.time.milliTimestamp(), .release);
        self.events_processed_last_check.store(0, .release);
    }

    /// Stop the watcher
    pub fn stop(self: *Self) void {
        if (self.is_running.cmpxchgWeak(true, false, .acquire, .acquire)) |_| {
            self.impl.stop_monitoring();
        }
    }

    /// Get next available event (non-blocking) with performance monitoring and latency tracking
    pub fn poll_event(self: *Self) ?FileEvent {
        const start_time = std.time.nanoTimestamp();
        const event = self.event_buffer.pop();

        if (event) |e| {
            // Calculate and record event latency for performance optimization
            const event_latency = @as(u64, @intCast(std.time.nanoTimestamp())) - e.timestamp;
            self.performance_optimizer.record_latency_sample(event_latency) catch {};

            _ = self.events_processed_last_check.fetchAdd(1, .acq_rel);

            // Periodic performance check (every 5 seconds)
            const current_time = std.time.milliTimestamp();
            const last_check = self.last_performance_check.load(.acquire);

            if (current_time - last_check > 5000) { // 5 seconds
                self.check_performance(current_time);
            }
        }

        // Record poll operation latency
        const poll_latency = @as(u64, @intCast(std.time.nanoTimestamp())) - @as(u64, @intCast(start_time));
        if (poll_latency > 100_000) { // > 100μs for a poll operation indicates potential issue
            self.performance_optimizer.record_latency_sample(poll_latency) catch {};
        }

        return event;
    }

    /// Wait for next event with timeout
    pub fn wait_event(self: *Self, timeout_ms: u32) !?FileEvent {
        const start_time = std.time.milliTimestamp();

        while (std.time.milliTimestamp() - start_time < timeout_ms) {
            if (self.poll_event()) |event| {
                return event;
            }
            std.Thread.sleep(1_000_000); // Sleep 1ms
        }

        return null; // Timeout
    }

    /// Check performance and handle degradation
    fn check_performance(self: *Self, current_time: i64) void {
        const events_processed = self.events_processed_last_check.swap(0, .acq_rel);
        const time_diff_ms = current_time - self.last_performance_check.swap(current_time, .acq_rel);

        if (time_diff_ms > 0) {
            const events_per_second = (events_processed * 1000) / @as(u64, @intCast(time_diff_ms));

            // Check if performance is degrading
            if (events_per_second < 1000) { // Less than 1000 events/sec indicates potential issues
                const context = std.fmt.allocPrint(self.allocator, "Low event processing rate: {d} events/sec", .{events_per_second}) catch "Performance degradation detected";
                defer if (!std.mem.eql(u8, context, "Performance degradation detected")) self.allocator.free(context);

                error_handling.handle_performance_warning(&self.error_handler, context);
            }

            // Check buffer utilization
            const stats = self.get_stats();
            const buffer_usage = (@as(f64, @floatFromInt(stats.pending)) / @as(f64, @floatFromInt(stats.capacity))) * 100.0;

            if (buffer_usage > 80.0) { // More than 80% buffer usage
                const context = std.fmt.allocPrint(self.allocator, "High buffer usage: {d:.1}%", .{buffer_usage}) catch "High buffer usage detected";
                defer if (!std.mem.eql(u8, context, "High buffer usage detected")) self.allocator.free(context);

                error_handling.handle_performance_warning(&self.error_handler, context);
            }
        }
    }

    /// Get comprehensive statistics including error handling
    pub fn get_stats(self: *const Self) struct {
        pending: u32,
        capacity: u32,
        dropped: u64,
        error_stats: struct {
            total_errors: u64,
            successful_recoveries: u64,
            recovery_rate: f64,
        },
        performance_stats: struct {
            avg_latency_us: f64,
            max_latency_us: f64,
            target_met_percentage: f64,
            samples_count: u32,
        },
    } {
        const read_pos = self.event_buffer.read_pos.load(.acquire);
        const write_pos = self.event_buffer.write_pos.load(.acquire);

        const pending = if (write_pos >= read_pos)
            write_pos - read_pos
        else
            (EventRingBuffer.MAX_EVENTS - read_pos) + write_pos;

        const error_stats = self.error_handler.get_stats();
        const perf_stats = self.performance_optimizer.get_performance_stats();

        return .{
            .pending = pending,
            .capacity = EventRingBuffer.MAX_EVENTS,
            .dropped = self.impl.get_dropped_events(),
            .error_stats = .{
                .total_errors = error_stats.total_errors,
                .successful_recoveries = error_stats.successful_recoveries,
                .recovery_rate = error_stats.recovery_rate,
            },
            .performance_stats = .{
                .avg_latency_us = perf_stats.avg_latency_us,
                .max_latency_us = perf_stats.max_latency_us,
                .target_met_percentage = perf_stats.target_met_percentage,
                .samples_count = perf_stats.samples_count,
            },
        };
    }

    /// Get recent errors for debugging
    pub fn get_recent_errors(self: *const Self, max_count: u32) []const error_handling.ErrorInfo {
        return self.error_handler.get_recent_errors(max_count);
    }
};

/// C API for integration with Rust
export fn fw_watcher_create() ?*FileWatcher {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    const allocator = gpa.allocator();

    const watcher = allocator.create(FileWatcher) catch return null;
    watcher.* = FileWatcher.init(allocator) catch {
        allocator.destroy(watcher);
        return null;
    };

    return watcher;
}

export fn fw_watcher_destroy(watcher: *FileWatcher) void {
    const allocator = watcher.allocator;
    watcher.deinit();
    allocator.destroy(watcher);
}

export fn fw_watcher_watch_directory(watcher: *FileWatcher, path: [*:0]const u8, recursive: bool) c_int {
    const path_slice = std.mem.span(path);
    watcher.watch_directory(path_slice, recursive) catch return -1;
    return 0;
}

export fn fw_watcher_start(watcher: *FileWatcher) c_int {
    watcher.start() catch return -1;
    return 0;
}

export fn fw_watcher_poll_event(watcher: *FileWatcher, out_event: *FileEvent) bool {
    if (watcher.poll_event()) |event| {
        out_event.* = event;
        return true;
    }
    return false;
}

// Tests
test "EventRingBuffer basic operations" {
    const allocator = std.testing.allocator;
    var buffer = try EventRingBuffer.init(allocator);
    defer buffer.deinit();

    // Test empty buffer
    try std.testing.expect(buffer.is_empty());
    try std.testing.expect(!buffer.is_full());
    try std.testing.expect(buffer.pop() == null);

    // Test push/pop
    const test_path = try allocator.dupe(u8, "/test/path");
    const event = FileEvent{
        .path = test_path,
        .event_type = .created,
        .timestamp = std.time.nanoTimestamp(),
        .size = 1024,
        .is_directory = false,
    };

    try std.testing.expect(buffer.push(event));
    try std.testing.expect(!buffer.is_empty());

    const popped = buffer.pop().?;
    try std.testing.expectEqualStrings(event.path, popped.path);
    try std.testing.expect(event.event_type == popped.event_type);

    allocator.free(test_path);
}

/// Main function for testing the retrigger system integration
pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    print("🚀 Retrigger System Integration Layer\n", .{});
    print("====================================\n", .{});
    print("Platform: {s}\n", .{@tagName(builtin.target.os.tag)});
    print("Architecture: {s}\n", .{@tagName(builtin.target.cpu.arch)});

    // Initialize file watcher based on platform
    var watcher = try FileWatcher.init(allocator);
    defer watcher.deinit();

    print("✅ File watcher initialized successfully\n", .{});
    print("🔍 Ready for file system monitoring\n", .{});
}
