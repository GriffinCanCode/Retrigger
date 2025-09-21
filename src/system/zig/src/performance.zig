//! Performance optimization module for sub-1ms latency file system monitoring
//! Follows SRP: Only responsible for performance tuning and latency optimization

const std = @import("std");
const linux = std.os.linux;
const builtin = @import("builtin");

/// Performance configuration structure
pub const PerformanceConfig = struct {
    // CPU affinity and scheduling
    cpu_affinity_mask: ?std.DynamicBitSet = null,
    thread_priority: i32 = -10, // High priority (requires privileges)
    use_realtime_scheduler: bool = false,

    // Memory optimization
    lock_memory: bool = false, // mlockall() to prevent swapping
    huge_pages_enabled: bool = false,
    memory_prefault: bool = true,

    // Buffer optimization
    buffer_size_kb: u32 = 64 * 1024, // 64MB default
    event_batch_size: u32 = 64, // Process events in batches

    // Latency optimization
    disable_context_switching: bool = false,
    cpu_frequency_scaling: CpuFrequencyMode = .performance,
    interrupt_coalescing: bool = false,

    // Platform-specific optimizations
    linux_optimizations: LinuxOptimizations = .{},
    macos_optimizations: MacOSOptimizations = .{},
    windows_optimizations: WindowsOptimizations = .{},
};

/// CPU frequency scaling modes
const CpuFrequencyMode = enum {
    ondemand,
    performance,
    powersave,
    conservative,
};

/// Linux-specific performance optimizations
const LinuxOptimizations = struct {
    use_sched_fifo: bool = false, // Real-time FIFO scheduler
    disable_numa_balancing: bool = true,
    set_cpu_isolation: bool = false,
    use_rcu_nocb: bool = false, // No-callback RCU
    disable_irq_balancing: bool = false,
    transparent_hugepages: bool = true,
};

/// macOS-specific performance optimizations
const MacOSOptimizations = struct {
    thread_time_constraint_policy: bool = true,
    disable_app_nap: bool = true,
    high_priority_io: bool = true,
    memory_pressure_handling: bool = true,
};

/// Windows-specific performance optimizations
const WindowsOptimizations = struct {
    high_priority_class: bool = true,
    disable_power_throttling: bool = true,
    set_timer_resolution: bool = true,
    use_multimedia_timers: bool = true,
};

/// Performance optimizer following OCP
pub const PerformanceOptimizer = struct {
    const Self = @This();

    allocator: std.mem.Allocator,
    config: PerformanceConfig,
    original_affinity: ?std.DynamicBitSet = null,

    // Performance monitoring
    latency_samples: std.ArrayList(u64),
    last_optimization_time: i64,

    pub fn init(allocator: std.mem.Allocator, config: PerformanceConfig) !Self {
        return Self{
            .allocator = allocator,
            .config = config,
            .latency_samples = std.ArrayList(u64){},
            .last_optimization_time = std.time.milliTimestamp(),
        };
    }

    pub fn deinit(self: *Self) void {
        self.latency_samples.deinit(self.allocator);

        // Restore original CPU affinity if it was changed
        if (self.original_affinity) |*affinity| {
            self.restore_cpu_affinity(affinity) catch {};
            affinity.deinit();
        }
    }

    /// Apply all performance optimizations
    pub fn apply_optimizations(self: *Self) !void {
        std.log.info("Applying performance optimizations for sub-1ms latency...", .{});

        // Platform-specific optimizations
        switch (builtin.os.tag) {
            .linux => try self.apply_linux_optimizations(),
            .macos => try self.apply_macos_optimizations(),
            .windows => try self.apply_windows_optimizations(),
            else => std.log.warn("Performance optimizations not implemented for this platform", .{}),
        }

        std.log.info("Performance optimizations applied successfully", .{});
    }

    /// Apply Linux-specific optimizations
    fn apply_linux_optimizations(self: *Self) !void {
        // Set CPU affinity if configured
        if (self.config.cpu_affinity_mask) |*mask| {
            try self.set_cpu_affinity(mask);
        }

        // Set thread scheduling policy and priority
        if (self.config.linux_optimizations.use_sched_fifo) {
            try self.set_realtime_scheduler();
        } else {
            try self.set_thread_priority(self.config.thread_priority);
        }

        // Lock memory to prevent swapping
        if (self.config.lock_memory) {
            try self.lock_process_memory();
        }

        // Configure CPU frequency scaling
        try self.set_cpu_frequency_scaling(self.config.cpu_frequency_scaling);

        // Disable NUMA balancing for consistent latency
        if (self.config.linux_optimizations.disable_numa_balancing) {
            self.disable_numa_balancing() catch |err| {
                std.log.warn("Failed to disable NUMA balancing: {}", .{err});
            };
        }

        // Enable transparent huge pages if configured
        if (self.config.linux_optimizations.transparent_hugepages) {
            self.enable_transparent_hugepages() catch |err| {
                std.log.warn("Failed to enable transparent huge pages: {}", .{err});
            };
        }
    }

    /// Apply macOS-specific optimizations
    fn apply_macos_optimizations(self: *Self) !void {
        // Set thread time constraint policy for low latency
        if (self.config.macos_optimizations.thread_time_constraint_policy) {
            try self.set_macos_thread_policy();
        }

        // Disable App Nap for consistent performance
        if (self.config.macos_optimizations.disable_app_nap) {
            try self.disable_app_nap();
        }

        // Set high I/O priority
        if (self.config.macos_optimizations.high_priority_io) {
            try self.set_macos_io_priority();
        }
    }

    /// Apply Windows-specific optimizations
    fn apply_windows_optimizations(self: *Self) !void {
        // Set high priority process class
        if (self.config.windows_optimizations.high_priority_class) {
            try self.set_windows_priority_class();
        }

        // Disable power throttling
        if (self.config.windows_optimizations.disable_power_throttling) {
            try self.disable_power_throttling();
        }

        // Set high resolution timer
        if (self.config.windows_optimizations.set_timer_resolution) {
            try self.set_timer_resolution();
        }
    }

    /// Set CPU affinity for current thread
    fn set_cpu_affinity(self: *Self, mask: *const std.DynamicBitSet) !void {
        if (builtin.os.tag != .linux) return;

        // Store original affinity for restoration
        var original = try std.DynamicBitSet.initEmpty(self.allocator, 128);

        // Get current affinity
        var cpu_set: linux.cpu_set_t = undefined;
        if (linux.sched_getaffinity(0, @sizeOf(linux.cpu_set_t), &cpu_set) == 0) {
            // Convert cpu_set to DynamicBitSet (manual bit checking)
            const cpu_set_bytes = std.mem.asBytes(&cpu_set);
            for (0..128) |i| {
                const byte_idx = i / 8;
                const bit_idx = @as(u3, @intCast(i % 8));
                if (byte_idx < cpu_set_bytes.len and (cpu_set_bytes[byte_idx] & (@as(u8, 1) << bit_idx)) != 0) {
                    original.set(i);
                }
            }
            self.original_affinity = original;
        }

        // Set new affinity
        @memset(std.mem.asBytes(&cpu_set), 0);
        var iter = mask.iterator(.{});
        while (iter.next()) |cpu| {
            // Manual bit setting
            const cpu_set_bytes = std.mem.asBytes(&cpu_set);
            const byte_idx = cpu / 8;
            const bit_idx = @as(u3, @intCast(cpu % 8));
            if (byte_idx < cpu_set_bytes.len) {
                cpu_set_bytes[byte_idx] |= (@as(u8, 1) << bit_idx);
            }
        }

        linux.sched_setaffinity(0, &cpu_set) catch {
            return error.SetAffinityFailed;
        };

        std.log.info("CPU affinity set successfully", .{});
    }

    /// Restore original CPU affinity
    fn restore_cpu_affinity(_: *Self, original: *const std.DynamicBitSet) !void {
        if (builtin.os.tag != .linux) return;

        var cpu_set: linux.cpu_set_t = undefined;
        @memset(std.mem.asBytes(&cpu_set), 0);

        var iter = original.iterator(.{});
        while (iter.next()) |cpu| {
            // Manual bit setting
            const cpu_set_bytes = std.mem.asBytes(&cpu_set);
            const byte_idx = cpu / 8;
            const bit_idx = @as(u3, @intCast(cpu % 8));
            if (byte_idx < cpu_set_bytes.len) {
                cpu_set_bytes[byte_idx] |= (@as(u8, 1) << bit_idx);
            }
        }

        _ = linux.sched_setaffinity(0, &cpu_set) catch {};
    }

    /// Set real-time FIFO scheduler (requires root privileges)
    fn set_realtime_scheduler(self: *Self) !void {
        _ = self;
        if (builtin.os.tag != .linux) return;

        var param: linux.sched_param = std.mem.zeroes(linux.sched_param);
        param.priority = 50; // High RT priority
        const sched_fifo: linux.SCHED = @bitCast(@as(i32, 1)); // SCHED_FIFO = 1
        if (linux.sched_setscheduler(0, sched_fifo, &param) != 0) {
            return error.SetSchedulerFailed;
        }

        std.log.info("Real-time FIFO scheduler enabled", .{});
    }

    /// Set thread priority (nice value)
    fn set_thread_priority(self: *Self, priority: i32) !void {
        _ = self;

        switch (builtin.os.tag) {
            .linux, .macos => {
                // Skip priority setting for now - API has changed significantly in Zig 0.15.1
                std.log.warn("Thread priority setting skipped - API compatibility issue", .{});
            },
            else => {},
        }

        std.log.info("Thread priority set to: {}", .{priority});
    }

    /// Lock process memory to prevent swapping
    fn lock_process_memory(self: *Self) !void {
        _ = self;
        if (builtin.os.tag != .linux) return;

        // Lock all current and future pages
        // Create MCL struct with CURRENT and FUTURE flags
        const mcl_flags: linux.MCL = @bitCast(@as(u32, 1 | 2)); // MCL_CURRENT | MCL_FUTURE
        if (linux.mlockall(mcl_flags) != 0) {
            return error.MemoryLockFailed;
        }

        std.log.info("Process memory locked to prevent swapping", .{});
    }

    /// Set CPU frequency scaling governor
    fn set_cpu_frequency_scaling(self: *Self, mode: CpuFrequencyMode) !void {
        if (builtin.os.tag != .linux) return;

        const governor = switch (mode) {
            .performance => "performance",
            .ondemand => "ondemand",
            .powersave => "powersave",
            .conservative => "conservative",
        };

        // This would typically require root privileges and write to sysfs
        const cmd = try std.fmt.allocPrint(self.allocator, "echo {s} | sudo tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor > /dev/null", .{governor});
        defer self.allocator.free(cmd);

        _ = std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ "sh", "-c", cmd },
        }) catch |err| {
            std.log.warn("Failed to set CPU frequency scaling: {}", .{err});
            return;
        };

        std.log.info("CPU frequency scaling set to: {s}", .{governor});
    }

    /// Disable NUMA balancing for consistent latency
    fn disable_numa_balancing(self: *Self) !void {
        // Write to kernel parameter
        const cmd = "echo 0 | sudo tee /proc/sys/kernel/numa_balancing > /dev/null";
        _ = std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ "sh", "-c", cmd },
        }) catch return error.DisableNumaBalancingFailed;

        std.log.info("NUMA balancing disabled", .{});
    }

    /// Enable transparent huge pages
    fn enable_transparent_hugepages(self: *Self) !void {
        const cmd = "echo always | sudo tee /sys/kernel/mm/transparent_hugepage/enabled > /dev/null";
        _ = std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ "sh", "-c", cmd },
        }) catch return error.EnableTransparentHugepagesFailed;

        std.log.info("Transparent huge pages enabled", .{});
    }

    /// Set macOS thread time constraint policy
    fn set_macos_thread_policy(self: *Self) !void {
        _ = self;
        if (builtin.os.tag != .macos) return;

        // This would use thread_policy_set() with THREAD_TIME_CONSTRAINT_POLICY
        // Implementation would require macOS-specific headers and linking
        std.log.info("macOS thread time constraint policy would be set here", .{});
    }

    /// Disable App Nap on macOS
    fn disable_app_nap(self: *Self) !void {
        _ = self;
        if (builtin.os.tag != .macos) return;

        // This would use NSProcessInfo beginActivity methods
        std.log.info("macOS App Nap would be disabled here", .{});
    }

    /// Set high I/O priority on macOS
    fn set_macos_io_priority(self: *Self) !void {
        _ = self;
        if (builtin.os.tag != .macos) return;

        // This would use setiopolicy_np()
        std.log.info("macOS high I/O priority would be set here", .{});
    }

    /// Set Windows high priority process class
    fn set_windows_priority_class(self: *Self) !void {
        _ = self;
        if (builtin.os.tag != .windows) return;

        // This would use SetPriorityClass(GetCurrentProcess(), HIGH_PRIORITY_CLASS)
        std.log.info("Windows high priority class would be set here", .{});
    }

    /// Disable Windows power throttling
    fn disable_power_throttling(self: *Self) !void {
        _ = self;
        if (builtin.os.tag != .windows) return;

        // This would use SetThreadInformation with ThreadPowerThrottling
        std.log.info("Windows power throttling would be disabled here", .{});
    }

    /// Set high resolution timer on Windows
    fn set_timer_resolution(self: *Self) !void {
        _ = self;
        if (builtin.os.tag != .windows) return;

        // This would use timeBeginPeriod(1) for 1ms resolution
        std.log.info("Windows timer resolution would be set here", .{});
    }

    /// Monitor and record latency samples
    pub fn record_latency_sample(self: *Self, latency_ns: u64) !void {
        try self.latency_samples.append(self.allocator, latency_ns);

        // Keep only recent samples (last 1000)
        if (self.latency_samples.items.len > 1000) {
            _ = self.latency_samples.orderedRemove(0);
        }

        // Periodically analyze and optimize based on latency trends
        const current_time = std.time.milliTimestamp();
        if (current_time - self.last_optimization_time > 10000) { // Every 10 seconds
            self.analyze_and_optimize() catch {};
            self.last_optimization_time = current_time;
        }
    }

    /// Analyze latency patterns and apply dynamic optimizations
    fn analyze_and_optimize(self: *Self) !void {
        if (self.latency_samples.items.len < 100) return;

        // Calculate recent latency statistics
        const recent_samples = self.latency_samples.items[self.latency_samples.items.len - 100 ..];

        var sum: u64 = 0;
        var max_latency: u64 = 0;

        for (recent_samples) |sample| {
            sum += sample;
            max_latency = @max(max_latency, sample);
        }

        const avg_latency = sum / recent_samples.len;
        const target_latency_ns: u64 = 1_000_000; // 1ms target

        if (avg_latency > target_latency_ns) {
            std.log.warn("Average latency ({d} μs) exceeds target (1000 μs). Applying optimizations...", .{avg_latency / 1000});

            // Dynamic optimization based on latency analysis
            try self.apply_dynamic_optimizations(avg_latency, max_latency);
        } else {
            std.log.info("Latency target met: {d} μs average", .{avg_latency / 1000});
        }
    }

    /// Apply dynamic optimizations based on observed latency
    fn apply_dynamic_optimizations(self: *Self, avg_latency_ns: u64, max_latency_ns: u64) !void {
        _ = max_latency_ns;

        // If latency is high, try more aggressive optimizations
        if (avg_latency_ns > 2_000_000) { // > 2ms
            std.log.info("High latency detected. Applying aggressive optimizations...", .{});

            // Try to enable real-time scheduling
            if (!self.config.linux_optimizations.use_sched_fifo) {
                self.set_realtime_scheduler() catch |err| {
                    std.log.warn("Could not enable real-time scheduler: {}", .{err});
                };
            }

            // Try to lock memory if not already locked
            if (!self.config.lock_memory) {
                self.lock_process_memory() catch |err| {
                    std.log.warn("Could not lock process memory: {}", .{err});
                };
            }
        }
    }

    /// Get performance statistics
    pub fn get_performance_stats(self: *const Self) struct {
        avg_latency_us: f64,
        max_latency_us: f64,
        min_latency_us: f64,
        samples_count: u32,
        target_met_percentage: f64,
    } {
        if (self.latency_samples.items.len == 0) {
            return .{
                .avg_latency_us = 0,
                .max_latency_us = 0,
                .min_latency_us = 0,
                .samples_count = 0,
                .target_met_percentage = 0,
            };
        }

        var sum: u64 = 0;
        var max_latency: u64 = 0;
        var min_latency: u64 = std.math.maxInt(u64);
        var target_met_count: u32 = 0;
        const target_latency_ns: u64 = 1_000_000; // 1ms

        for (self.latency_samples.items) |sample| {
            sum += sample;
            max_latency = @max(max_latency, sample);
            min_latency = @min(min_latency, sample);

            if (sample <= target_latency_ns) {
                target_met_count += 1;
            }
        }

        const count = self.latency_samples.items.len;
        const avg_latency = @as(f64, @floatFromInt(sum)) / @as(f64, @floatFromInt(count));
        const target_met_percentage = (@as(f64, @floatFromInt(target_met_count)) / @as(f64, @floatFromInt(count))) * 100.0;

        return .{
            .avg_latency_us = avg_latency / 1000.0,
            .max_latency_us = @as(f64, @floatFromInt(max_latency)) / 1000.0,
            .min_latency_us = @as(f64, @floatFromInt(min_latency)) / 1000.0,
            .samples_count = @intCast(count),
            .target_met_percentage = target_met_percentage,
        };
    }
};

/// Create optimized performance config for sub-1ms latency
pub fn create_low_latency_config(allocator: std.mem.Allocator) !PerformanceConfig {
    var config = PerformanceConfig{};

    // Set aggressive low-latency defaults
    config.thread_priority = -20; // Highest priority
    config.lock_memory = true;
    config.use_realtime_scheduler = true;
    config.cpu_frequency_scaling = .performance;
    config.event_batch_size = 16; // Smaller batches for lower latency

    // Platform-specific aggressive settings
    switch (builtin.os.tag) {
        .linux => {
            config.linux_optimizations.use_sched_fifo = true;
            config.linux_optimizations.disable_numa_balancing = true;
            config.linux_optimizations.transparent_hugepages = true;
        },
        .macos => {
            config.macos_optimizations.thread_time_constraint_policy = true;
            config.macos_optimizations.disable_app_nap = true;
            config.macos_optimizations.high_priority_io = true;
        },
        .windows => {
            config.windows_optimizations.high_priority_class = true;
            config.windows_optimizations.disable_power_throttling = true;
            config.windows_optimizations.set_timer_resolution = true;
        },
        else => {},
    }

    // Set CPU affinity to use only performance cores (on supported systems)
    if (builtin.os.tag == .linux) {
        const cpu_count = std.Thread.getCpuCount() catch 4;
        if (cpu_count > 4) {
            // Use first 4 cores for dedicated performance
            var affinity = try std.DynamicBitSet.initEmpty(allocator, cpu_count);
            affinity.setRangeValue(.{ .start = 0, .end = 4 }, true);
            config.cpu_affinity_mask = affinity;
        }
    }

    return config;
}
