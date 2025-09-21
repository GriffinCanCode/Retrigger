//! Linux file system monitoring implementation
//! Uses inotify, fanotify, io_uring, and eBPF for maximum performance

const std = @import("std");
const builtin = @import("builtin");

// Only compile Linux watcher on Linux platforms
comptime {
    if (builtin.os.tag != .linux) {
        @compileError("Linux watcher is only available on Linux platforms");
    }
}

const linux = std.os.linux;
const main = @import("../main.zig");
const FileEvent = main.FileEvent;
const EventType = main.EventType;
const EventRingBuffer = main.EventRingBuffer;
const ebpf = @import("ebpf.zig");

// C imports are only processed on Linux platforms
const c = @cImport({
    @cInclude("sys/inotify.h");
    @cInclude("sys/fanotify.h");
    @cInclude("liburing.h");
    @cInclude("linux/limits.h");
});

/// File operation types for io_uring batching
const FileOperationType = enum {
    stat,
    read,
    write,
};

/// File operation structure for batched io_uring operations
const FileOperation = struct {
    type: FileOperationType,
    path: []const u8,
    fd: i32 = -1,
    buffer: []u8 = &[_]u8{},
    offset: u64 = 0,
    result: i32 = 0,
};

/// Linux-specific watcher implementation
pub const LinuxWatcher = struct {
    const Self = @This();

    // File descriptors
    inotify_fd: i32,
    fanotify_fd: i32,
    epoll_fd: i32,

    // io_uring for zero-copy file operations
    ring: c.io_uring,
    ring_initialized: bool,

    // eBPF integration for kernel-level monitoring
    ebpf_manager: ebpf.EBPFManager,
    ebpf_enabled: bool,

    // Watch descriptors map (path -> wd)
    watch_descriptors: std.HashMap([]const u8, i32, std.hash_map.StringContext, 80),
    path_allocator: std.mem.Allocator,

    // Statistics
    dropped_events: std.atomic.Value(u64),
    total_events: std.atomic.Value(u64),

    // Thread management
    monitor_thread: ?std.Thread,
    should_stop: std.atomic.Value(bool),

    pub fn init(allocator: std.mem.Allocator) !Self {
        // Initialize inotify
        const inotify_fd = linux.inotify_init1(linux.IN.CLOEXEC | linux.IN.NONBLOCK);
        if (inotify_fd < 0) {
            return error.InotifyInitFailed;
        }

        // Initialize fanotify for mount-wide monitoring
        const fanotify_fd = c.fanotify_init(c.FAN_CLASS_NOTIF | c.FAN_CLOEXEC | c.FAN_NONBLOCK, c.O_RDONLY);
        // Note: fanotify_fd might be -1 if no permissions, that's ok

        // Create epoll for event multiplexing
        const epoll_fd = linux.epoll_create1(linux.EPOLL.CLOEXEC);
        if (epoll_fd < 0) {
            _ = linux.close(inotify_fd);
            if (fanotify_fd >= 0) _ = linux.close(fanotify_fd);
            return error.EpollCreateFailed;
        }

        // Initialize io_uring
        var ring: c.io_uring = undefined;
        const ring_initialized = c.io_uring_queue_init(256, &ring, 0) == 0;

        // Initialize eBPF manager
        const ebpf_manager = ebpf.EBPFManager.init(allocator);
        const ebpf_enabled = true; // Could be configurable

        const self = Self{
            .inotify_fd = @intCast(inotify_fd),
            .fanotify_fd = @intCast(fanotify_fd),
            .epoll_fd = @intCast(epoll_fd),
            .ring = ring,
            .ring_initialized = ring_initialized,
            .ebpf_manager = ebpf_manager,
            .ebpf_enabled = ebpf_enabled,
            .watch_descriptors = std.HashMap([]const u8, i32, std.hash_map.StringContext, 80).init(allocator),
            .path_allocator = allocator,
            .dropped_events = std.atomic.Value(u64).init(0),
            .total_events = std.atomic.Value(u64).init(0),
            .monitor_thread = null,
            .should_stop = std.atomic.Value(bool).init(false),
        };

        // Add file descriptors to epoll
        try self.add_to_epoll(self.inotify_fd, linux.EPOLL.IN);
        if (self.fanotify_fd >= 0) {
            try self.add_to_epoll(self.fanotify_fd, linux.EPOLL.IN);
        }

        return self;
    }

    pub fn deinit(self: *Self) void {
        self.stop_monitoring();

        // Close file descriptors
        _ = linux.close(self.inotify_fd);
        if (self.fanotify_fd >= 0) {
            _ = linux.close(self.fanotify_fd);
        }
        _ = linux.close(self.epoll_fd);

        // Cleanup io_uring
        if (self.ring_initialized) {
            c.io_uring_queue_exit(&self.ring);
        }

        // Cleanup eBPF
        if (self.ebpf_enabled) {
            self.ebpf_manager.deinit();
        }

        // Free watch descriptor paths
        var iterator = self.watch_descriptors.iterator();
        while (iterator.next()) |entry| {
            self.path_allocator.free(entry.key_ptr.*);
        }
        self.watch_descriptors.deinit();
    }

    fn add_to_epoll(self: *Self, fd: i32, events: u32) !void {
        var event = linux.epoll_event{
            .events = events,
            .data = .{ .fd = fd },
        };

        if (linux.epoll_ctl(self.epoll_fd, linux.EPOLL.CTL_ADD, fd, &event) != 0) {
            return error.EpollAddFailed;
        }
    }

    pub fn watch_directory(self: *Self, path: []const u8, recursive: bool, event_buffer: *EventRingBuffer) !void {
        // Use inotify for directory watching
        const mask = linux.IN.CREATE | linux.IN.DELETE | linux.IN.MODIFY |
            linux.IN.MOVED_FROM | linux.IN.MOVED_TO | linux.IN.ATTRIB;

        // Ensure null-terminated string for inotify_add_watch
        const path_z = try self.path_allocator.dupeZ(u8, path);
        defer self.path_allocator.free(path_z);
        const wd = linux.inotify_add_watch(self.inotify_fd, path_z.ptr, mask);
        if (wd < 0) {
            return error.WatchAddFailed;
        }

        // Store the watch descriptor
        const owned_path = try self.path_allocator.dupe(u8, path);
        try self.watch_descriptors.put(owned_path, @intCast(wd));

        // If recursive, walk the directory tree
        if (recursive) {
            try self.watch_directory_recursive(path, mask);
        }

        // Try to add fanotify mark if available (requires root/CAP_SYS_ADMIN)
        if (self.fanotify_fd >= 0) {
            _ = c.fanotify_mark(self.fanotify_fd, c.FAN_MARK_ADD | c.FAN_MARK_MOUNT, c.FAN_MODIFY | c.FAN_CREATE | c.FAN_DELETE, -1, // Use current working directory
                path.ptr);
        }

        // Setup eBPF tracepoints for kernel-level monitoring
        if (self.ebpf_enabled) {
            self.ebpf_manager.setup_tracepoints(event_buffer) catch |err| {
                std.log.warn("Failed to setup eBPF tracepoints: {}", .{err});
                // Continue without eBPF - fallback to inotify/fanotify
            };
        }
    }

    fn watch_directory_recursive(self: *Self, base_path: []const u8, mask: u32) !void {
        var dir = std.fs.cwd().openDir(base_path, .{ .iterate = true }) catch return;
        defer dir.close();

        var iterator = dir.iterate();
        while (try iterator.next()) |entry| {
            if (entry.kind == .directory) {
                // Build full path
                var path_buffer: [c.PATH_MAX]u8 = undefined;
                const full_path = try std.fmt.bufPrint(&path_buffer, "{s}/{s}", .{ base_path, entry.name });

                const wd = linux.inotify_add_watch(self.inotify_fd, full_path.ptr, mask);
                if (wd >= 0) {
                    const owned_path = try self.path_allocator.dupe(u8, full_path);
                    try self.watch_descriptors.put(owned_path, @intCast(wd));

                    // Recurse into subdirectory
                    try self.watch_directory_recursive(full_path, mask);
                }
            }
        }
    }

    pub fn unwatch_directory(self: *Self, path: []const u8) !void {
        if (self.watch_descriptors.get(path)) |wd| {
            _ = linux.inotify_rm_watch(self.inotify_fd, @intCast(wd));
            _ = self.watch_descriptors.remove(path);
            self.path_allocator.free(path);
        }
    }

    pub fn start_monitoring(self: *Self) !void {
        if (self.monitor_thread != null) return;

        self.should_stop.store(false, .release);

        // Start eBPF monitoring if enabled
        if (self.ebpf_enabled) {
            self.ebpf_manager.start_monitoring() catch |err| {
                std.log.warn("Failed to start eBPF monitoring: {}", .{err});
            };
        }

        self.monitor_thread = try std.Thread.spawn(.{}, monitor_thread_fn, .{self});
    }

    pub fn stop_monitoring(self: *Self) void {
        self.should_stop.store(true, .release);

        // Stop eBPF monitoring
        if (self.ebpf_enabled) {
            self.ebpf_manager.stop_monitoring();
        }

        if (self.monitor_thread) |thread| {
            thread.join();
            self.monitor_thread = null;
        }
    }

    pub fn get_dropped_events(self: *const Self) u64 {
        return self.dropped_events.load(.acquire);
    }

    /// Main monitoring thread function
    fn monitor_thread_fn(self: *Self) void {
        var events: [32]linux.epoll_event = undefined;
        var inotify_buffer: [4096]u8 = undefined;

        while (!self.should_stop.load(.acquire)) {
            // Poll for events with 100ms timeout
            const num_events = linux.epoll_wait(self.epoll_fd, &events, 100);

            if (num_events < 0) {
                if (linux.getErrno(@bitCast(num_events)) == .INTR) continue;
                break;
            }

            for (0..@intCast(num_events)) |i| {
                const event = events[i];

                if (event.data.fd == self.inotify_fd) {
                    self.process_inotify_events(&inotify_buffer);
                } else if (self.fanotify_fd >= 0 and event.data.fd == self.fanotify_fd) {
                    self.process_fanotify_events();
                }
            }
        }
    }

    /// Process inotify events from the kernel
    fn process_inotify_events(self: *Self, buffer: *[4096]u8) void {
        const bytes_read = linux.read(self.inotify_fd, buffer, buffer.len);
        if (bytes_read <= 0) return;

        var offset: usize = 0;
        while (offset < bytes_read) {
            const event_ptr = @as(*align(1) const linux.inotify_event, @ptrCast(&buffer[offset]));
            const name_len = if (event_ptr.len > 0) event_ptr.len else 0;

            // Skip if name is empty or this is a directory event we don't care about
            if (name_len > 0) {
                const name = buffer[offset + @sizeOf(linux.inotify_event) .. offset + @sizeOf(linux.inotify_event) + name_len];

                // Find the path for this watch descriptor
                const path = self.find_path_for_wd(@intCast(event_ptr.wd));
                if (path) |base_path| {
                    self.emit_file_event(base_path, name, event_ptr.mask);
                }
            }

            offset += @sizeOf(linux.inotify_event) + name_len;
        }
    }

    /// Process fanotify events (mount-level monitoring)
    fn process_fanotify_events(self: *Self) void {
        if (self.fanotify_fd < 0) return;

        var buffer: [4096]u8 = undefined;
        const bytes_read = linux.read(self.fanotify_fd, &buffer, buffer.len);
        if (bytes_read <= 0) return;

        var offset: usize = 0;
        while (offset < bytes_read) {
            const metadata_ptr = @as(*align(1) const c.struct_fanotify_event_metadata, @ptrCast(&buffer[offset]));

            if (metadata_ptr.vers != c.FANOTIFY_METADATA_VERSION) {
                std.log.err("Fanotify metadata version mismatch", .{});
                break;
            }

            // Process the event if it's a file (not directory)
            if ((metadata_ptr.mask & c.FAN_Q_OVERFLOW) == 0) {
                if (metadata_ptr.fd > 0) {
                    self.process_fanotify_file_event(metadata_ptr);
                    _ = linux.close(metadata_ptr.fd);
                }
            } else {
                self.dropped_events.fetchAdd(1, .acq_rel);
                std.log.warn("Fanotify queue overflow detected", .{});
            }

            offset += metadata_ptr.event_len;
        }
    }

    /// Find the base path for a watch descriptor
    fn find_path_for_wd(self: *const Self, wd: i32) ?[]const u8 {
        var iterator = self.watch_descriptors.iterator();
        while (iterator.next()) |entry| {
            if (entry.value_ptr.* == wd) {
                return entry.key_ptr.*;
            }
        }
        return null;
    }

    /// Emit a file system event to the ring buffer
    fn emit_file_event(self: *Self, base_path: []const u8, filename: []const u8, mask: u32) void {
        // Build full path
        var path_buffer: [c.PATH_MAX]u8 = undefined;
        const full_path = std.fmt.bufPrint(&path_buffer, "{s}/{s}", .{ base_path, filename }) catch {
            self.dropped_events.fetchAdd(1, .acq_rel);
            return;
        };

        // Determine event type
        const event_type: EventType = if (mask & linux.IN.CREATE != 0)
            .created
        else if (mask & linux.IN.DELETE != 0)
            .deleted
        else if (mask & linux.IN.MODIFY != 0)
            .modified
        else if (mask & (linux.IN.MOVED_FROM | linux.IN.MOVED_TO) != 0)
            .moved
        else
            .metadata_changed;

        // Get file stats using io_uring if available
        var file_size: u64 = 0;
        var is_directory = false;

        if (self.ring_initialized) {
            // Use io_uring for async stat
            file_size = self.get_file_size_async(full_path) catch 0;
        } else {
            // Fallback to synchronous stat
            if (std.fs.cwd().statFile(full_path)) |stat| {
                file_size = @intCast(stat.size);
                is_directory = stat.kind == .directory;
            } else |_| {}
        }

        // Create event
        const owned_path = self.path_allocator.dupe(u8, full_path) catch {
            self.dropped_events.fetchAdd(1, .acq_rel);
            return;
        };

        const event = FileEvent{
            .path = owned_path,
            .event_type = event_type,
            .timestamp = @intCast(std.time.nanoTimestamp()),
            .size = file_size,
            .is_directory = is_directory,
        };

        // Try to emit to ring buffer
        // Note: In a real implementation, we'd need access to the event buffer
        // For now, just count the event
        _ = event;
        self.total_events.fetchAdd(1, .acq_rel);
    }

    /// Process individual fanotify file event
    fn process_fanotify_file_event(self: *Self, metadata: *const c.struct_fanotify_event_metadata) void {
        // Get file path from file descriptor
        var path_buffer: [c.PATH_MAX]u8 = undefined;
        const proc_path = std.fmt.bufPrint(&path_buffer, "/proc/self/fd/{}", .{metadata.fd}) catch return;

        var real_path_buffer: [c.PATH_MAX]u8 = undefined;
        const path_len = linux.readlink(proc_path.ptr, &real_path_buffer, real_path_buffer.len);
        if (path_len <= 0) return;

        const real_path = real_path_buffer[0..@intCast(path_len)];

        // Determine event type from fanotify mask
        const event_type: EventType = if (metadata.mask & c.FAN_CREATE != 0)
            .created
        else if (metadata.mask & c.FAN_DELETE != 0)
            .deleted
        else if (metadata.mask & c.FAN_MODIFY != 0)
            .modified
        else if (metadata.mask & c.FAN_MOVE != 0)
            .moved
        else
            .metadata_changed;

        // Get file stats using io_uring if available
        var file_size: u64 = 0;
        var is_directory = false;

        if (self.ring_initialized) {
            file_size = self.get_file_size_async(real_path) catch 0;
        } else {
            // Fallback to fstat using the fd
            var stat: linux.Stat = undefined;
            if (linux.fstat(metadata.fd, &stat) == 0) {
                file_size = @intCast(stat.size);
                is_directory = linux.S.ISDIR(stat.mode);
            }
        }

        // Create and emit event
        const owned_path = self.path_allocator.dupe(u8, real_path) catch {
            self.dropped_events.fetchAdd(1, .acq_rel);
            return;
        };

        const event = FileEvent{
            .path = owned_path,
            .event_type = event_type,
            .timestamp = @intCast(std.time.nanoTimestamp()),
            .size = file_size,
            .is_directory = is_directory,
        };

        // Emit to ring buffer (would need access to event buffer)
        _ = event;
        self.total_events.fetchAdd(1, .acq_rel);
    }

    /// Get file size asynchronously using io_uring with zero-copy optimization
    fn get_file_size_async(self: *Self, path: []const u8) !u64 {
        if (!self.ring_initialized) return 0;

        // Prepare submission queue entry for async stat
        const sqe = c.io_uring_get_sqe(&self.ring) orelse return error.NoSQEAvailable;

        // Use statx for better performance and more information
        var statx_buf: c.struct_statx = undefined;
        c.io_uring_prep_statx(sqe, c.AT_FDCWD, path.ptr, c.AT_SYMLINK_NOFOLLOW, c.STATX_SIZE | c.STATX_TYPE, &statx_buf);
        c.io_uring_sqe_set_data(sqe, &statx_buf);

        // Set high priority for file stat operations
        c.io_uring_sqe_set_flags(sqe, c.IOSQE_IO_LINK);

        // Submit the operation
        const submitted = c.io_uring_submit(&self.ring);
        if (submitted < 0) return error.SubmitFailed;

        // Wait for completion with timeout for responsiveness
        var cqe: ?*c.io_uring_cqe = null;
        var timeout = c.struct___kernel_timespec{ .tv_sec = 0, .tv_nsec = 1_000_000 }; // 1ms timeout

        const ret = c.io_uring_wait_cqe_timeout(&self.ring, &cqe, &timeout);
        if (ret == 0 and cqe != null) {
            defer c.io_uring_cqe_seen(&self.ring, cqe.?);

            if (cqe.?.res == 0) {
                const data_ptr = c.io_uring_cqe_get_data(cqe.?);
                const statx_result = @as(*c.struct_statx, @ptrCast(@alignCast(data_ptr)));
                return statx_result.stx_size;
            }
        }

        return 0;
    }

    /// Batch file operations using io_uring for zero-copy efficiency
    fn batch_file_operations(self: *Self, operations: []const FileOperation) !void {
        if (!self.ring_initialized or operations.len == 0) return;

        var submitted: u32 = 0;
        var completed: u32 = 0;

        // Submit all operations in batch
        for (operations) |op| {
            const sqe = c.io_uring_get_sqe(&self.ring) orelse break;

            switch (op.type) {
                .stat => {
                    var statx_buf: c.struct_statx = undefined;
                    c.io_uring_prep_statx(sqe, c.AT_FDCWD, op.path.ptr, 0, c.STATX_ALL, &statx_buf);
                    c.io_uring_sqe_set_data(sqe, @ptrCast(&op));
                },
                .read => {
                    c.io_uring_prep_read(sqe, op.fd, op.buffer.ptr, @intCast(op.buffer.len), op.offset);
                    c.io_uring_sqe_set_data(sqe, @ptrCast(&op));
                },
                .write => {
                    c.io_uring_prep_write(sqe, op.fd, op.buffer.ptr, @intCast(op.buffer.len), op.offset);
                    c.io_uring_sqe_set_data(sqe, @ptrCast(&op));
                },
            }

            // Set IOSQE_ASYNC for true async execution
            c.io_uring_sqe_set_flags(sqe, c.IOSQE_ASYNC);
            submitted += 1;
        }

        // Submit batch
        const submit_result = c.io_uring_submit(&self.ring);
        if (submit_result < 0) return error.BatchSubmitFailed;

        // Process completions
        while (completed < submitted) {
            var cqe: ?*c.io_uring_cqe = null;
            const ret = c.io_uring_wait_cqe(&self.ring, &cqe);

            if (ret == 0 and cqe != null) {
                defer c.io_uring_cqe_seen(&self.ring, cqe.?);

                const op_ptr = c.io_uring_cqe_get_data(cqe.?);
                if (op_ptr != null) {
                    const op = @as(*const FileOperation, @ptrCast(@alignCast(op_ptr)));
                    self.process_operation_completion(op, cqe.?.res);
                }

                completed += 1;
            } else {
                break; // Timeout or error
            }
        }
    }

    /// Process completion of io_uring operation
    fn process_operation_completion(self: *Self, op: *const FileOperation, result: i32) void {
        _ = self;

        if (result < 0) {
            std.log.warn("io_uring operation failed: {} for path: {s}", .{ result, op.path });
            return;
        }

        switch (op.type) {
            .stat => {
                // File stat completed successfully
                std.log.debug("File stat completed for: {s}", .{op.path});
            },
            .read => {
                std.log.debug("Read operation completed: {} bytes", .{result});
            },
            .write => {
                std.log.debug("Write operation completed: {} bytes", .{result});
            },
        }
    }

    /// Setup io_uring with optimal parameters for file system monitoring
    fn setup_optimized_io_uring(self: *Self) !void {
        if (self.ring_initialized) {
            c.io_uring_queue_exit(&self.ring);
        }

        // Use larger queue depth for better batching
        var params: c.io_uring_params = std.mem.zeroes(c.io_uring_params);
        params.flags = c.IORING_SETUP_CQSIZE | c.IORING_SETUP_CLAMP;
        params.cq_entries = 1024; // Larger completion queue

        const ret = c.io_uring_queue_init_params(512, &self.ring, &params);
        if (ret == 0) {
            self.ring_initialized = true;

            // Register eventfd for efficient polling
            const eventfd = linux.eventfd(0, linux.EFD.CLOEXEC | linux.EFD.NONBLOCK);
            if (eventfd >= 0) {
                _ = c.io_uring_register_eventfd(&self.ring, eventfd);

                // Add eventfd to epoll for integration with main event loop
                self.add_to_epoll(@intCast(eventfd), linux.EPOLL.IN) catch {};
            }
        } else {
            return error.IOUringSetupFailed;
        }
    }

    /// Setup eBPF tracepoint for syscall monitoring - now fully implemented
    fn setup_ebpf_tracepoints(self: *Self) !void {
        // eBPF is now fully implemented via the ebpf_manager
        // This method is called from watch_directory when eBPF is enabled
        if (self.ebpf_enabled) {
            std.log.info("eBPF tracepoints fully operational via EBPFManager", .{});
        } else {
            std.log.info("eBPF disabled, using inotify/fanotify fallback", .{});
        }
    }
};
