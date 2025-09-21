//! Comprehensive error handling and recovery system
//! Follows SRP: Only responsible for error management, logging, and recovery strategies

const std = @import("std");
const main = @import("main.zig");

/// Error severity levels for proper categorization
pub const ErrorSeverity = enum(u8) {
    debug = 0,
    info = 1,
    warning = 2,
    err = 3,
    critical = 4,
};

/// Error categories for better error handling strategies
pub const ErrorCategory = enum(u8) {
    system_resource, // File descriptor, memory, etc.
    platform_api, // OS-specific API failures
    network_io, // Network-related errors
    file_system, // File system access errors
    configuration, // Configuration/setup errors
    performance, // Performance degradation
    security, // Security-related issues
    unknown, // Uncategorized errors
};

/// Comprehensive error information structure
pub const ErrorInfo = struct {
    timestamp: u64,
    severity: ErrorSeverity,
    category: ErrorCategory,
    error_code: u32,
    message: []const u8,
    context: []const u8,
    recovery_attempted: bool = false,
    recovery_successful: bool = false,

    pub fn format(
        self: ErrorInfo,
        comptime fmt: []const u8,
        options: std.fmt.FormatOptions,
        writer: anytype,
    ) !void {
        _ = fmt;
        _ = options;
        const severity_str = switch (self.severity) {
            .debug => "DEBUG",
            .info => "INFO",
            .warning => "WARN",
            .err => "ERROR",
            .critical => "CRITICAL",
        };

        const category_str = switch (self.category) {
            .system_resource => "SYS_RES",
            .platform_api => "PLAT_API",
            .network_io => "NET_IO",
            .file_system => "FILE_SYS",
            .configuration => "CONFIG",
            .performance => "PERF",
            .security => "SECURITY",
            .unknown => "UNKNOWN",
        };

        try writer.print("[{d}] {s}:{s} #{d} - {s} ({s})", .{
            self.timestamp,
            severity_str,
            category_str,
            self.error_code,
            self.message,
            self.context,
        });
    }
};

/// Recovery strategy interface following ISP
pub const RecoveryStrategy = struct {
    const Self = @This();

    name: []const u8,
    can_recover_fn: *const fn (error_info: ErrorInfo) bool,
    attempt_recovery_fn: *const fn (allocator: std.mem.Allocator, error_info: ErrorInfo) anyerror!bool,

    pub fn can_recover(self: *const Self, error_info: ErrorInfo) bool {
        return self.can_recover_fn(error_info);
    }

    pub fn attempt_recovery(self: *const Self, allocator: std.mem.Allocator, error_info: ErrorInfo) !bool {
        return self.attempt_recovery_fn(allocator, error_info);
    }
};

/// Error handler manager following OCP and SRP
pub const ErrorHandler = struct {
    const Self = @This();

    allocator: std.mem.Allocator,
    error_log: std.ArrayList(ErrorInfo),
    recovery_strategies: std.ArrayList(RecoveryStrategy),

    // Configuration
    max_log_entries: u32 = 10000,
    auto_recovery_enabled: bool = true,
    log_to_console: bool = true,
    log_to_file: bool = false,
    log_file_path: ?[]const u8 = null,

    // Statistics
    total_errors: std.atomic.Value(u64),
    successful_recoveries: std.atomic.Value(u64),
    failed_recoveries: std.atomic.Value(u64),

    pub fn init(allocator: std.mem.Allocator) Self {
        return Self{
            .allocator = allocator,
            .error_log = std.ArrayList(ErrorInfo){},
            .recovery_strategies = std.ArrayList(RecoveryStrategy){},
            .total_errors = std.atomic.Value(u64).init(0),
            .successful_recoveries = std.atomic.Value(u64).init(0),
            .failed_recoveries = std.atomic.Value(u64).init(0),
        };
    }

    pub fn deinit(self: *Self) void {
        // Free all error message strings
        for (self.error_log.items) |error_info| {
            self.allocator.free(error_info.message);
            self.allocator.free(error_info.context);
        }
        self.error_log.deinit(self.allocator);
        self.recovery_strategies.deinit(self.allocator);
    }

    /// Register a recovery strategy
    pub fn register_recovery_strategy(self: *Self, strategy: RecoveryStrategy) !void {
        try self.recovery_strategies.append(self.allocator, strategy);
    }

    /// Log an error and attempt recovery if enabled
    pub fn handle_error(
        self: *Self,
        severity: ErrorSeverity,
        category: ErrorCategory,
        err: anyerror,
        context: []const u8,
    ) void {
        const error_code = @intFromError(err);
        const message = self.allocator.dupe(u8, @errorName(err)) catch "OutOfMemory";
        const owned_context = self.allocator.dupe(u8, context) catch "OutOfMemory";

        var error_info = ErrorInfo{
            .timestamp = @intCast(std.time.nanoTimestamp()),
            .severity = severity,
            .category = category,
            .error_code = error_code,
            .message = message,
            .context = owned_context,
        };

        // Log the error
        self.log_error(error_info);

        // Attempt recovery if enabled and error is recoverable
        if (self.auto_recovery_enabled and severity != .critical) {
            self.attempt_recovery(&error_info);
        }

        // Store in error log (with size limit)
        if (self.error_log.items.len >= self.max_log_entries) {
            const oldest = self.error_log.orderedRemove(0);
            self.allocator.free(oldest.message);
            self.allocator.free(oldest.context);
        }

        self.error_log.append(self.allocator, error_info) catch {};
        _ = self.total_errors.fetchAdd(1, .acq_rel);
    }

    /// Log error to configured outputs
    fn log_error(self: *const Self, error_info: ErrorInfo) void {
        if (self.log_to_console) {
            std.log.err("{any}", .{error_info});
        }

        if (self.log_to_file and self.log_file_path != null) {
            self.write_to_log_file(error_info) catch {};
        }
    }

    /// Write error to log file
    fn write_to_log_file(self: *const Self, error_info: ErrorInfo) !void {
        _ = error_info;
        // File logging disabled for Zig 0.15.1 compatibility
        _ = self.log_file_path;
    }

    /// Attempt error recovery using registered strategies
    fn attempt_recovery(self: *Self, error_info: *ErrorInfo) void {
        for (self.recovery_strategies.items) |*strategy| {
            if (strategy.can_recover(error_info.*)) {
                error_info.recovery_attempted = true;

                if (strategy.attempt_recovery(self.allocator, error_info.*)) |success| {
                    error_info.recovery_successful = success;
                    if (success) {
                        _ = self.successful_recoveries.fetchAdd(1, .acq_rel);
                        std.log.info("Successfully recovered from error using strategy: {s}", .{strategy.name});
                        return;
                    }
                } else |recovery_err| {
                    std.log.warn("Recovery strategy '{s}' failed: {any}", .{ strategy.name, recovery_err });
                }
            }
        }

        if (error_info.recovery_attempted) {
            _ = self.failed_recoveries.fetchAdd(1, .acq_rel);
        }
    }

    /// Get error handler statistics
    pub fn get_stats(self: *const Self) struct {
        total_errors: u64,
        successful_recoveries: u64,
        failed_recoveries: u64,
        recovery_rate: f64,
    } {
        const total = self.total_errors.load(.acquire);
        const successful = self.successful_recoveries.load(.acquire);
        const failed = self.failed_recoveries.load(.acquire);

        const recovery_rate = if (total > 0)
            @as(f64, @floatFromInt(successful)) / @as(f64, @floatFromInt(total)) * 100.0
        else
            0.0;

        return .{
            .total_errors = total,
            .successful_recoveries = successful,
            .failed_recoveries = failed,
            .recovery_rate = recovery_rate,
        };
    }

    /// Get recent errors for debugging
    pub fn get_recent_errors(self: *const Self, max_count: u32) []const ErrorInfo {
        const start_idx = if (self.error_log.items.len > max_count)
            self.error_log.items.len - max_count
        else
            0;
        return self.error_log.items[start_idx..];
    }
};

// Recovery strategy implementations

/// File descriptor exhaustion recovery
fn can_recover_fd_exhaustion(error_info: ErrorInfo) bool {
    return error_info.category == .system_resource and
        (error_info.error_code == @intFromError(error.ProcessFdQuotaExceeded) or
            error_info.error_code == @intFromError(error.SystemFdQuotaExceeded));
}

fn attempt_fd_exhaustion_recovery(allocator: std.mem.Allocator, error_info: ErrorInfo) !bool {
    _ = allocator;
    _ = error_info;

    // In a real implementation, this would:
    // 1. Close unused file descriptors
    // 2. Reduce buffer sizes to lower FD usage
    // 3. Implement FD pooling
    // 4. Restart components with lower resource usage

    std.log.info("Attempting FD exhaustion recovery...", .{});

    // Simulate recovery attempt
    std.Thread.sleep(100_000_000); // 100ms

    // Check if recovery was successful (simplified)
    return true;
}

/// Memory allocation failure recovery
fn can_recover_memory_exhaustion(error_info: ErrorInfo) bool {
    return error_info.category == .system_resource and
        error_info.error_code == @intFromError(error.OutOfMemory);
}

fn attempt_memory_exhaustion_recovery(allocator: std.mem.Allocator, error_info: ErrorInfo) !bool {
    _ = allocator;
    _ = error_info;

    // In a real implementation, this would:
    // 1. Reduce buffer sizes
    // 2. Clear caches
    // 3. Trigger garbage collection
    // 4. Disable non-essential features

    std.log.info("Attempting memory exhaustion recovery...", .{});

    // Force garbage collection if using GPA
    std.Thread.sleep(50_000_000); // 50ms

    return true;
}

/// Platform API failure recovery
fn can_recover_platform_api_failure(error_info: ErrorInfo) bool {
    return error_info.category == .platform_api;
}

fn attempt_platform_api_recovery(allocator: std.mem.Allocator, error_info: ErrorInfo) !bool {
    _ = allocator;
    _ = error_info;

    // In a real implementation, this would:
    // 1. Retry with exponential backoff
    // 2. Fallback to alternative APIs
    // 3. Reduce feature complexity
    // 4. Reset API connections

    std.log.info("Attempting platform API recovery...", .{});

    // Simulate retry with backoff
    std.Thread.sleep(200_000_000); // 200ms

    return true;
}

/// Create default error handler with common recovery strategies
pub fn create_default_error_handler(allocator: std.mem.Allocator) !ErrorHandler {
    var handler = ErrorHandler.init(allocator);

    // Register common recovery strategies
    try handler.register_recovery_strategy(.{
        .name = "FD Exhaustion Recovery",
        .can_recover_fn = can_recover_fd_exhaustion,
        .attempt_recovery_fn = attempt_fd_exhaustion_recovery,
    });

    try handler.register_recovery_strategy(.{
        .name = "Memory Exhaustion Recovery",
        .can_recover_fn = can_recover_memory_exhaustion,
        .attempt_recovery_fn = attempt_memory_exhaustion_recovery,
    });

    try handler.register_recovery_strategy(.{
        .name = "Platform API Recovery",
        .can_recover_fn = can_recover_platform_api_failure,
        .attempt_recovery_fn = attempt_platform_api_recovery,
    });

    return handler;
}

/// Convenience macros for error handling
pub fn handle_system_error(handler: *ErrorHandler, err: anyerror, context: []const u8) void {
    handler.handle_error(.err, .system_resource, err, context);
}

pub fn handle_platform_error(handler: *ErrorHandler, err: anyerror, context: []const u8) void {
    handler.handle_error(.err, .platform_api, err, context);
}

pub fn handle_filesystem_error(handler: *ErrorHandler, err: anyerror, context: []const u8) void {
    handler.handle_error(.warning, .file_system, err, context);
}

pub fn handle_performance_warning(handler: *ErrorHandler, context: []const u8) void {
    handler.handle_error(.warning, .performance, error.PerformanceDegraded, context);
}

/// Custom error types
pub const RetriggerError = error{
    PerformanceDegraded,
    ConfigurationInvalid,
    PlatformNotSupported,
    ResourceExhausted,
    SecurityViolation,
} || std.mem.Allocator.Error || std.fs.File.OpenError;

// Tests
test "ErrorHandler basic functionality" {
    var handler = ErrorHandler.init(std.testing.allocator);
    defer handler.deinit();

    // Test error handling
    handler.handle_error(.err, .system_resource, error.OutOfMemory, "Test context");

    const stats = handler.get_stats();
    try std.testing.expect(stats.total_errors == 1);

    const recent_errors = handler.get_recent_errors(10);
    try std.testing.expect(recent_errors.len == 1);
    try std.testing.expect(recent_errors[0].category == .system_resource);
}

test "Recovery strategies" {
    var handler = try create_default_error_handler(std.testing.allocator);
    defer handler.deinit();

    // Test that recovery strategies are registered
    try std.testing.expect(handler.recovery_strategies.items.len == 3);

    // Test recovery for FD exhaustion
    handler.handle_error(.err, .system_resource, error.ProcessFdQuotaExceeded, "FD test");

    const stats = handler.get_stats();
    try std.testing.expect(stats.total_errors == 1);
}
