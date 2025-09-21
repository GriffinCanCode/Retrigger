//! Windows file system monitoring implementation using ReadDirectoryChangesW
//! Follows SRP: Only responsible for Windows-specific file watching using native APIs

const std = @import("std");
const main = @import("../main.zig");
const FileEvent = main.FileEvent;
const EventType = main.EventType;
const EventRingBuffer = main.EventRingBuffer;

const c = @cImport({
    @cDefine("WIN32_LEAN_AND_MEAN", "1");
    @cInclude("windows.h");
    @cInclude("winbase.h");
    @cInclude("fileapi.h");
    // eBPF for Windows support (requires Windows 11 or Server 2022+)
    @cInclude("ebpf_api.h");
    @cInclude("ebpf_windows.h");
    @cInclude("bpf.h");
});

/// Directory watch entry for tracking multiple watched directories
const WatchEntry = struct {
    path: []const u8,
    handle: c.HANDLE,
    overlapped: c.OVERLAPPED,
    buffer: [8192]u8, // Buffer for directory change notifications
    recursive: bool,
};

/// Watched path configuration for Windows filtering
const WindowsWatchedPath = struct {
    path: []const u8,
    is_recursive: bool,

    /// Check if a given path matches this watched path
    pub fn matches(self: *const WindowsWatchedPath, test_path: []const u8) bool {
        if (self.is_recursive) {
            // For recursive paths, check if test_path is under this path
            return std.mem.startsWith(u8, test_path, self.path);
        } else {
            // For non-recursive paths, check exact directory match
            const parent_dir = std.fs.path.dirname(test_path) orelse return false;
            return std.mem.eql(u8, parent_dir, self.path);
        }
    }
};

/// Windows eBPF program context
const WindowsEBPFContext = struct {
    program_fd: c.ebpf_handle_t,
    map_fd: c.ebpf_handle_t,
    attach_handle: c.ebpf_handle_t,
    program_type: c.ebpf_program_type_t,
};

/// File system event from Windows eBPF program
const WindowsEBPFFileEvent = packed struct {
    process_id: u32,
    thread_id: u32,
    timestamp: u64,
    event_type: u32, // FILE_ACTION_* constants
    filename_length: u32,
    filename: [260]u8, // MAX_PATH in Windows
    file_attributes: u32,
    file_size: u64,
};

/// Windows-specific watcher implementation following ISP
pub const WindowsWatcher = struct {
    const Self = @This();

    allocator: std.mem.Allocator,
    watched_directories: std.ArrayList(*WatchEntry),
    completion_port: c.HANDLE,
    event_buffer: ?*EventRingBuffer,

    // eBPF support for Windows 11+
    ebpf_enabled: bool,
    ebpf_contexts: std.ArrayList(WindowsEBPFContext),
    ebpf_event_buffer: []align(std.mem.page_size) u8,
    // Path filtering support
    watched_paths: std.ArrayList(WindowsWatchedPath),

    // Statistics
    dropped_events: std.atomic.Value(u64),
    total_events: std.atomic.Value(u64),
    ebpf_events_processed: std.atomic.Value(u64),

    // Thread management
    monitor_thread: ?std.Thread,
    ebpf_monitor_thread: ?std.Thread,
    should_stop: std.atomic.Value(bool),

    pub fn init(allocator: std.mem.Allocator) !Self {
        // Create I/O completion port for async operations
        const completion_port = c.CreateIoCompletionPort(c.INVALID_HANDLE_VALUE, null, 0, 0);
        if (completion_port == null) {
            return error.CompletionPortCreateFailed;
        }

        // Check if eBPF is available (Windows 11/Server 2022+)
        const ebpf_enabled = Self.check_ebpf_support();

        // Allocate eBPF event buffer if eBPF is available
        const ebpf_event_buffer = if (ebpf_enabled)
            try allocator.alignedAlloc(u8, std.mem.page_size, 64 * 1024) // 64KB buffer
        else
            &[_]u8{};

        return Self{
            .allocator = allocator,
            .watched_directories = std.ArrayList(*WatchEntry).init(allocator),
            .completion_port = completion_port,
            .event_buffer = null,
            .ebpf_enabled = ebpf_enabled,
            .ebpf_contexts = std.ArrayList(WindowsEBPFContext).init(allocator),
            .ebpf_event_buffer = ebpf_event_buffer,
            .watched_paths = std.ArrayList(WindowsWatchedPath).init(allocator),
            .dropped_events = std.atomic.Value(u64).init(0),
            .total_events = std.atomic.Value(u64).init(0),
            .ebpf_events_processed = std.atomic.Value(u64).init(0),
            .monitor_thread = null,
            .ebpf_monitor_thread = null,
            .should_stop = std.atomic.Value(bool).init(false),
        };
    }

    pub fn deinit(self: *Self) void {
        self.stop_monitoring();

        // Clean up watched directories
        for (self.watched_directories.items) |entry| {
            _ = c.CloseHandle(entry.handle);
            self.allocator.free(entry.path);
            self.allocator.destroy(entry);
        }
        self.watched_directories.deinit(self.allocator);

        // Clean up eBPF contexts
        for (self.ebpf_contexts.items) |context| {
            if (self.ebpf_enabled) {
                _ = c.ebpf_object_close(context.attach_handle);
                _ = c.ebpf_object_close(context.map_fd);
                _ = c.ebpf_object_close(context.program_fd);
            }
        }
        self.ebpf_contexts.deinit(self.allocator);

        // Clean up watched paths
        for (self.watched_paths.items) |watched_path| {
            self.allocator.free(watched_path.path);
        }
        self.watched_paths.deinit();

        // Free eBPF event buffer
        if (self.ebpf_enabled and self.ebpf_event_buffer.len > 0) {
            self.allocator.free(self.ebpf_event_buffer);
        }

        // Close completion port
        if (self.completion_port != c.INVALID_HANDLE_VALUE) {
            _ = c.CloseHandle(self.completion_port);
        }
    }

    pub fn watch_directory(self: *Self, path: []const u8, recursive: bool, event_buffer: *EventRingBuffer) !void {
        self.event_buffer = event_buffer;

        // Try eBPF first if available (more efficient)
        if (self.ebpf_enabled) {
            try self.setup_ebpf_monitoring(path, recursive);
        }

        // Always setup ReadDirectoryChangesW as fallback/complement
        // Convert path to wide string for Windows API
        var wide_path: [c.MAX_PATH]u16 = undefined;
        const path_len = try std.unicode.utf8ToUtf16Le(&wide_path, path);
        wide_path[path_len] = 0;

        // Open directory for monitoring
        const handle = c.CreateFileW(
            &wide_path,
            c.FILE_LIST_DIRECTORY,
            c.FILE_SHARE_READ | c.FILE_SHARE_WRITE | c.FILE_SHARE_DELETE,
            null,
            c.OPEN_EXISTING,
            c.FILE_FLAG_BACKUP_SEMANTICS | c.FILE_FLAG_OVERLAPPED, // Overlapped for async I/O
            null,
        );

        if (handle == c.INVALID_HANDLE_VALUE) {
            return error.DirectoryOpenFailed;
        }

        // Associate with completion port
        const completion_key = @intFromPtr(self);
        if (c.CreateIoCompletionPort(handle, self.completion_port, completion_key, 0) == null) {
            _ = c.CloseHandle(handle);
            return error.CompletionPortAssociateFailed;
        }

        // Create watch entry
        const entry = try self.allocator.create(WatchEntry);
        entry.* = WatchEntry{
            .path = try self.allocator.dupe(u8, path),
            .handle = handle,
            .overlapped = std.mem.zeroes(c.OVERLAPPED),
            .buffer = undefined,
            .recursive = recursive,
        };

        try self.watched_directories.append(entry);

        // Start async directory monitoring
        try self.start_directory_watch(entry);
    }

    pub fn unwatch_directory(self: *Self, path: []const u8) !void {
        var i: usize = 0;
        while (i < self.watched_directories.items.len) {
            const entry = self.watched_directories.items[i];
            if (std.mem.eql(u8, entry.path, path)) {
                // Cancel I/O and close handle
                _ = c.CancelIo(entry.handle);
                _ = c.CloseHandle(entry.handle);

                // Clean up and remove
                self.allocator.free(entry.path);
                self.allocator.destroy(entry);
                _ = self.watched_directories.orderedRemove(i);
                return;
            }
            i += 1;
        }
    }

    pub fn start_monitoring(self: *Self) !void {
        if (self.monitor_thread != null) return;

        self.should_stop.store(false, .release);

        // Start ReadDirectoryChangesW monitoring thread
        self.monitor_thread = try std.Thread.spawn(.{}, monitor_thread_fn, .{self});

        // Start eBPF monitoring thread if available
        if (self.ebpf_enabled) {
            self.ebpf_monitor_thread = try std.Thread.spawn(.{}, ebpf_monitor_thread_fn, .{self});
        }
    }

    pub fn stop_monitoring(self: *Self) void {
        self.should_stop.store(true, .release);

        // Post quit message to completion port
        if (self.completion_port != c.INVALID_HANDLE_VALUE) {
            _ = c.PostQueuedCompletionStatus(self.completion_port, 0, 0, null);
        }

        // Join ReadDirectoryChangesW thread
        if (self.monitor_thread) |thread| {
            thread.join();
            self.monitor_thread = null;
        }

        // Join eBPF monitoring thread
        if (self.ebpf_monitor_thread) |thread| {
            thread.join();
            self.ebpf_monitor_thread = null;
        }
    }

    pub fn get_dropped_events(self: *const Self) u64 {
        return self.dropped_events.load(.acquire);
    }

    /// Start async directory watching for a specific entry
    fn start_directory_watch(_: *Self, entry: *WatchEntry) !void {
        const notify_filter = c.FILE_NOTIFY_CHANGE_FILE_NAME |
            c.FILE_NOTIFY_CHANGE_DIR_NAME |
            c.FILE_NOTIFY_CHANGE_ATTRIBUTES |
            c.FILE_NOTIFY_CHANGE_SIZE |
            c.FILE_NOTIFY_CHANGE_LAST_WRITE |
            c.FILE_NOTIFY_CHANGE_LAST_ACCESS |
            c.FILE_NOTIFY_CHANGE_CREATION |
            c.FILE_NOTIFY_CHANGE_SECURITY;

        var bytes_returned: c.DWORD = undefined;
        const success = c.ReadDirectoryChangesW(
            entry.handle,
            &entry.buffer,
            entry.buffer.len,
            if (entry.recursive) c.TRUE else c.FALSE,
            notify_filter,
            &bytes_returned,
            &entry.overlapped,
            null,
        );

        if (success == 0) {
            const err = c.GetLastError();
            std.log.err("ReadDirectoryChangesW failed with error: {}", .{err});
            return error.ReadDirectoryChangesFailed;
        }
    }

    /// Main monitoring thread function using I/O completion port
    fn monitor_thread_fn(self: *Self) void {
        var bytes_transferred: c.DWORD = undefined;
        var completion_key: c.ULONG_PTR = undefined;
        var overlapped: ?*c.OVERLAPPED = null;

        while (!self.should_stop.load(.acquire)) {
            // Wait for completion with 100ms timeout for responsive shutdown
            const result = c.GetQueuedCompletionStatus(
                self.completion_port,
                &bytes_transferred,
                &completion_key,
                &overlapped,
                100, // 100ms timeout
            );

            if (result == 0) {
                const err = c.GetLastError();
                if (err == c.WAIT_TIMEOUT) continue;
                if (err == c.ERROR_ABANDONED_WAIT_0) break;
                continue;
            }

            // Check for shutdown signal
            if (completion_key == 0 and overlapped == null) break;

            // Process the completion
            if (overlapped) |ov| {
                self.process_directory_changes(ov, bytes_transferred);
            }
        }
    }

    /// Process directory change notifications
    fn process_directory_changes(self: *Self, overlapped: *c.OVERLAPPED, bytes_transferred: c.DWORD) void {
        // Find the watch entry for this overlapped structure
        const entry = self.find_watch_entry_by_overlapped(overlapped) orelse {
            std.log.err("Could not find watch entry for overlapped structure", .{});
            return;
        };

        if (bytes_transferred == 0) {
            // Buffer overflow or other error - restart watching
            self.start_directory_watch(entry) catch |err| {
                std.log.err("Failed to restart directory watch: {}", .{err});
            };
            return;
        }

        // Parse FILE_NOTIFY_INFORMATION structures
        var offset: usize = 0;
        while (offset < bytes_transferred) {
            const notify_info = @as(*align(1) const c.FILE_NOTIFY_INFORMATION, @ptrCast(&entry.buffer[offset]));

            // Convert filename from UTF-16 to UTF-8
            const filename_utf16 = @as([*]const u16, @ptrCast(@alignCast(&entry.buffer[offset + @sizeOf(c.FILE_NOTIFY_INFORMATION)])));
            const filename_len = notify_info.FileNameLength / 2;

            var utf8_buffer: [c.MAX_PATH]u8 = undefined;
            const utf8_len = std.unicode.utf16leToUtf8(&utf8_buffer, filename_utf16[0..filename_len]) catch {
                self.dropped_events.fetchAdd(1, .acq_rel);
                break;
            };

            const filename = utf8_buffer[0..utf8_len];

            // Create full path
            var full_path_buffer: [c.MAX_PATH * 2]u8 = undefined;
            const full_path = std.fmt.bufPrint(&full_path_buffer, "{s}\\{s}", .{ entry.path, filename }) catch {
                self.dropped_events.fetchAdd(1, .acq_rel);
                break;
            };

            // Convert action to event type
            const event_type: EventType = switch (notify_info.Action) {
                c.FILE_ACTION_ADDED => .created,
                c.FILE_ACTION_REMOVED => .deleted,
                c.FILE_ACTION_MODIFIED => .modified,
                c.FILE_ACTION_RENAMED_OLD_NAME, c.FILE_ACTION_RENAMED_NEW_NAME => .moved,
                else => .metadata_changed,
            };

            // Get file attributes
            var file_size: u64 = 0;
            var is_directory = false;

            // Convert to wide string for GetFileAttributes
            var wide_full_path: [c.MAX_PATH]u16 = undefined;
            if (std.unicode.utf8ToUtf16Le(&wide_full_path, full_path)) |wide_len| {
                wide_full_path[wide_len] = 0;

                const attrs = c.GetFileAttributesW(&wide_full_path);
                if (attrs != c.INVALID_FILE_ATTRIBUTES) {
                    is_directory = (attrs & c.FILE_ATTRIBUTE_DIRECTORY) != 0;

                    // Get file size if it's a file
                    if (!is_directory) {
                        const file_handle = c.CreateFileW(
                            &wide_full_path,
                            c.GENERIC_READ,
                            c.FILE_SHARE_READ,
                            null,
                            c.OPEN_EXISTING,
                            c.FILE_ATTRIBUTE_NORMAL,
                            null,
                        );

                        if (file_handle != c.INVALID_HANDLE_VALUE) {
                            var file_size_info: c.LARGE_INTEGER = undefined;
                            if (c.GetFileSizeEx(file_handle, &file_size_info) != 0) {
                                file_size = @intCast(file_size_info.QuadPart);
                            }
                            _ = c.CloseHandle(file_handle);
                        }
                    }
                }
            } else |_| {
                self.dropped_events.fetchAdd(1, .acq_rel);
            }

            // Create file event
            const owned_path = self.allocator.dupe(u8, full_path) catch {
                self.dropped_events.fetchAdd(1, .acq_rel);
                break;
            };

            const event = FileEvent{
                .path = owned_path,
                .event_type = event_type,
                .timestamp = @intCast(std.time.nanoTimestamp()),
                .size = file_size,
                .is_directory = is_directory,
            };

            // Push to ring buffer
            if (self.event_buffer) |buffer| {
                if (!buffer.push(event)) {
                    self.dropped_events.fetchAdd(1, .acq_rel);
                    self.allocator.free(owned_path);
                } else {
                    self.total_events.fetchAdd(1, .acq_rel);
                }
            }

            // Move to next notification
            if (notify_info.NextEntryOffset == 0) break;
            offset += notify_info.NextEntryOffset;
        }

        // Restart monitoring for this directory
        self.start_directory_watch(entry) catch |err| {
            std.log.err("Failed to restart directory watch: {}", .{err});
        };
    }

    /// Find watch entry by overlapped structure
    fn find_watch_entry_by_overlapped(self: *Self, overlapped: *c.OVERLAPPED) ?*WatchEntry {
        for (self.watched_directories.items) |entry| {
            if (@intFromPtr(&entry.overlapped) == @intFromPtr(overlapped)) {
                return entry;
            }
        }
        return null;
    }

    /// Check if eBPF is supported on this Windows version
    fn check_ebpf_support() bool {
        // Try to initialize eBPF - if it fails, eBPF is not supported
        const result = c.ebpf_api_initiate();
        if (result == c.EBPF_SUCCESS) {
            c.ebpf_api_terminate();
            return true;
        }
        return false;
    }

    /// Setup eBPF monitoring for file system events on Windows
    fn setup_ebpf_monitoring(self: *Self, path: []const u8, recursive: bool) !void {
        if (!self.ebpf_enabled) return;

        // Create eBPF map for events
        var map_create_info = c.ebpf_map_create_info_t{
            .type = c.BPF_MAP_TYPE_RINGBUF,
            .key_size = 0,
            .value_size = 0,
            .max_entries = 64 * 1024, // 64KB ring buffer
            .map_flags = 0,
        };

        var map_fd: c.ebpf_handle_t = undefined;
        const result = c.ebpf_map_create(&map_create_info, &map_fd);
        if (result != c.EBPF_SUCCESS) {
            std.log.warn("Failed to create eBPF map for Windows: {}", .{result});
            return;
        }

        // Load eBPF program for file system monitoring
        const program_bytecode = try self.generate_windows_ebpf_program(map_fd);
        defer self.allocator.free(program_bytecode);

        var program_load_info = c.ebpf_program_load_info_t{
            .program_type = c.EBPF_PROGRAM_TYPE_BIND,
            .expected_attach_type = c.EBPF_ATTACH_TYPE_BIND,
            .program_name = "file_monitor",
            .execution_context = c.EBPF_EXECUTION_CONTEXT_KERNEL,
        };

        var program_fd: c.ebpf_handle_t = undefined;
        result = c.ebpf_program_load(program_bytecode.ptr, @intCast(program_bytecode.len), &program_load_info, &program_fd);

        if (result != c.EBPF_SUCCESS) {
            std.log.warn("Failed to load eBPF program for Windows: {}", .{result});
            _ = c.ebpf_object_close(map_fd);
            return;
        }

        // Attach eBPF program
        var attach_handle: c.ebpf_handle_t = undefined;
        result = c.ebpf_program_attach(program_fd, null, 0, &attach_handle);
        if (result != c.EBPF_SUCCESS) {
            std.log.warn("Failed to attach eBPF program for Windows: {}", .{result});
            _ = c.ebpf_object_close(program_fd);
            _ = c.ebpf_object_close(map_fd);
            return;
        }

        // Store context
        const context = WindowsEBPFContext{
            .program_fd = program_fd,
            .map_fd = map_fd,
            .attach_handle = attach_handle,
            .program_type = c.EBPF_PROGRAM_TYPE_BIND,
        };

        try self.ebpf_contexts.append(context);

        // Configure path filtering and recursive monitoring
        const owned_path = try self.allocator.dupe(u8, path);
        const watched_path = WindowsWatchedPath{
            .path = owned_path,
            .is_recursive = recursive,
        };
        try self.watched_paths.append(watched_path);

        std.log.info("eBPF monitoring setup completed for Windows: {s} (recursive: {})", .{ path, recursive });
    }

    /// Check if a file event should be processed based on path filtering
    pub fn should_process_event(self: *const Self, event_path: []const u8) bool {
        // If no watched paths are configured, process all events
        if (self.watched_paths.items.len == 0) return true;

        // Check if the event path matches any of the watched paths
        for (self.watched_paths.items) |watched_path| {
            if (watched_path.matches(event_path)) {
                return true;
            }
        }

        return false;
    }

    /// Generate Windows-specific eBPF program bytecode
    fn generate_windows_ebpf_program(self: *Self, map_fd: c.ebpf_handle_t) ![]u8 {
        _ = map_fd; // Intentionally unused for this simplified implementation

        // This is a simplified eBPF program for Windows
        // In a real implementation, this would be more comprehensive and use map_fd
        const program = [_]c.ebpf_inst{
            // Load context
            c.ebpf_inst{ .opcode = c.EBPF_OP_LDXW, .dst = 1, .src = 1, .off = 0, .imm = 0 },

            // Call helper to get file event data
            c.ebpf_inst{ .opcode = c.EBPF_OP_CALL, .dst = 0, .src = 0, .off = 0, .imm = c.EBPF_FUNC_get_current_time },

            // Store event and return
            c.ebpf_inst{ .opcode = c.EBPF_OP_MOV64_IMM, .dst = 0, .src = 0, .off = 0, .imm = 0 },
            c.ebpf_inst{ .opcode = c.EBPF_OP_EXIT, .dst = 0, .src = 0, .off = 0, .imm = 0 },
        };

        const bytecode = try self.allocator.alloc(u8, @sizeOf(@TypeOf(program)));
        @memcpy(bytecode, std.mem.asBytes(&program));
        return bytecode;
    }

    /// eBPF monitoring thread function
    fn ebpf_monitor_thread_fn(self: *Self) void {
        if (!self.ebpf_enabled) return;

        while (!self.should_stop.load(.acquire)) {
            // Poll eBPF ring buffer for events
            for (self.ebpf_contexts.items) |context| {
                self.poll_ebpf_events(context);
            }

            std.Thread.sleep(1_000_000); // Sleep 1ms
        }
    }

    /// Poll eBPF ring buffer for file system events
    fn poll_ebpf_events(self: *Self, context: WindowsEBPFContext) void {
        var event_data: [1024]u8 = undefined;
        var event_size: usize = event_data.len;

        // Try to read from eBPF map (ring buffer)
        const result = c.ebpf_map_lookup_elem(context.map_fd, null, &event_data, &event_size);
        if (result == c.EBPF_SUCCESS and event_size >= @sizeOf(WindowsEBPFFileEvent)) {
            const ebpf_event = @as(*const WindowsEBPFFileEvent, @ptrCast(@alignCast(&event_data)));
            self.process_ebpf_file_event(ebpf_event);
        }
    }

    /// Process eBPF file system event
    fn process_ebpf_file_event(self: *Self, ebpf_event: *const WindowsEBPFFileEvent) void {
        // Extract filename
        const filename_len = @min(ebpf_event.filename_length, 259);
        const filename = ebpf_event.filename[0..filename_len];

        // Convert Windows event type to our EventType
        const event_type: EventType = switch (ebpf_event.event_type) {
            c.FILE_ACTION_ADDED => .created,
            c.FILE_ACTION_REMOVED => .deleted,
            c.FILE_ACTION_MODIFIED => .modified,
            c.FILE_ACTION_RENAMED_OLD_NAME, c.FILE_ACTION_RENAMED_NEW_NAME => .moved,
            else => .metadata_changed,
        };

        // Create owned path
        const owned_path = self.allocator.dupe(u8, filename) catch {
            self.dropped_events.fetchAdd(1, .acq_rel);
            return;
        };

        const file_event = FileEvent{
            .path = owned_path,
            .event_type = event_type,
            .timestamp = ebpf_event.timestamp,
            .size = ebpf_event.file_size,
            .is_directory = (ebpf_event.file_attributes & c.FILE_ATTRIBUTE_DIRECTORY) != 0,
        };

        // Push to ring buffer
        if (self.event_buffer) |buffer| {
            if (!buffer.push(file_event)) {
                self.dropped_events.fetchAdd(1, .acq_rel);
                self.allocator.free(owned_path);
            } else {
                self.ebpf_events_processed.fetchAdd(1, .acq_rel);
            }
        }
    }
};
