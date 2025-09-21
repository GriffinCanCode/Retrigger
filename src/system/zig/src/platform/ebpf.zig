//! eBPF integration for kernel-level file system monitoring
//! Follows SRP: Only responsible for eBPF tracepoint management and syscall interception

const std = @import("std");
const builtin = @import("builtin");

// Only compile eBPF support on Linux
comptime {
    if (builtin.os.tag != .linux) {
        @compileError("eBPF support is only available on Linux");
    }
}

const linux = std.os.linux;
const main = @import("../main.zig");
const FileEvent = main.FileEvent;
const EventType = main.EventType;
const EventRingBuffer = main.EventRingBuffer;

// C imports are only processed on Linux platforms
const c = @cImport({
    @cInclude("linux/bpf.h");
    @cInclude("linux/perf_event.h");
    @cInclude("sys/syscall.h");
    @cInclude("unistd.h");
    @cInclude("errno.h");
});

/// eBPF program event structure (must match kernel program)
const EBPFFileEvent = packed struct {
    pid: u32,
    tid: u32,
    syscall_nr: u32,
    timestamp: u64,
    filename_len: u32,
    filename: [256]u8,
    flags: u32,
    mode: u32,
};

/// eBPF program manager following ISP
pub const EBPFManager = struct {
    const Self = @This();

    allocator: std.mem.Allocator,

    // BPF program file descriptors
    prog_fds: std.ArrayList(i32),
    map_fds: std.ArrayList(i32),

    // Perf event file descriptors for reading events
    perf_fds: std.ArrayList(i32),

    // Memory mapped perf buffers
    perf_buffers: std.ArrayList([]align(4096) u8),

    // Event processing
    event_buffer: ?*EventRingBuffer,

    // Statistics
    events_processed: std.atomic.Value(u64),
    events_dropped: std.atomic.Value(u64),

    // Thread management
    monitor_thread: ?std.Thread,
    should_stop: std.atomic.Value(bool),

    pub fn init(allocator: std.mem.Allocator) Self {
        return Self{
            .allocator = allocator,
            .prog_fds = std.ArrayList(i32){},
            .map_fds = std.ArrayList(i32){},
            .perf_fds = std.ArrayList(i32){},
            .perf_buffers = std.ArrayList([]align(4096) u8){},
            .event_buffer = null,
            .events_processed = std.atomic.Value(u64).init(0),
            .events_dropped = std.atomic.Value(u64).init(0),
            .monitor_thread = null,
            .should_stop = std.atomic.Value(bool).init(false),
        };
    }

    pub fn deinit(self: *Self) void {
        self.stop_monitoring();

        // Close all file descriptors
        for (self.prog_fds.items) |fd| {
            _ = linux.close(fd);
        }
        for (self.map_fds.items) |fd| {
            _ = linux.close(fd);
        }
        for (self.perf_fds.items) |fd| {
            _ = linux.close(fd);
        }

        // Unmap perf buffers
        for (self.perf_buffers.items) |buffer| {
            std.posix.munmap(buffer);
        }

        self.prog_fds.deinit(self.allocator);
        self.map_fds.deinit(self.allocator);
        self.perf_fds.deinit(self.allocator);
        self.perf_buffers.deinit(self.allocator);
    }

    /// Setup eBPF programs for file system syscall monitoring
    pub fn setup_tracepoints(self: *Self, event_buffer: *EventRingBuffer) !void {
        self.event_buffer = event_buffer;

        // Load eBPF programs for key file system syscalls
        try self.load_syscall_tracer("sys_enter_openat");
        try self.load_syscall_tracer("sys_enter_unlinkat");
        try self.load_syscall_tracer("sys_enter_renameat2");
        try self.load_syscall_tracer("sys_enter_mkdir");
        try self.load_syscall_tracer("sys_enter_rmdir");
        try self.load_syscall_tracer("sys_enter_truncate");
        try self.load_syscall_tracer("sys_enter_ftruncate");

        // Setup perf event buffers for high-performance event delivery
        try self.setup_perf_events();
    }

    /// Load a specific syscall tracer eBPF program
    fn load_syscall_tracer(self: *Self, tracepoint_name: []const u8) !void {
        // Create BPF map for passing events to userspace
        const map_fd = try self.create_perf_event_map();
        try self.map_fds.append(map_fd);

        // Generate eBPF bytecode for this tracepoint
        const prog_fd = try self.load_bpf_program(tracepoint_name, map_fd);
        try self.prog_fds.append(prog_fd);

        // Attach to tracepoint
        try self.attach_tracepoint(prog_fd, tracepoint_name);
    }

    /// Create a BPF_MAP_TYPE_PERF_EVENT_ARRAY map
    fn create_perf_event_map(self: *Self) !i32 {
        _ = self;
        var map_create = linux.BPF.MapCreateAttr{
            .map_type = 4, // BPF_MAP_TYPE_PERF_EVENT_ARRAY
            .key_size = 4, // CPU number
            .value_size = 4, // perf event fd
            .max_entries = 256, // Max CPUs
            .map_flags = 0,
            .inner_map_fd = 0,
            .numa_node = 0,
            .map_name = undefined,
            .map_ifindex = 0,
            .btf_fd = 0,
            .btf_key_type_id = 0,
        };

        // Zero the map name and set it
        @memset(&map_create.map_name, 0);
        @memcpy(map_create.map_name[0.."events_map".len], "events_map");

        const map_fd = linux.bpf(.MAP_CREATE, @ptrCast(&map_create), @sizeOf(@TypeOf(map_create)));
        if (map_fd < 0) {
            return error.BPFMapCreateFailed;
        }

        return @intCast(map_fd);
    }

    /// Load eBPF program bytecode with full implementation
    fn load_bpf_program(self: *Self, tracepoint_name: []const u8, map_fd: i32) !i32 {

        // Generate specialized bytecode based on tracepoint type
        const instructions = try self.generate_tracepoint_bytecode(tracepoint_name, map_fd);
        defer self.allocator.free(instructions);

        // Full eBPF program structure following 2025 best practices

        var prog_load = linux.BPF.ProgLoadAttr{
            .prog_type = 5, // BPF_PROG_TYPE_TRACEPOINT
            .insn_cnt = instructions.len,
            .insns = @intFromPtr(&instructions[0]),
            .license = @intFromPtr("GPL"),
            .log_level = 0,
            .log_size = 0,
            .log_buf = 0,
            .kern_version = 0,
            .prog_flags = 0,
            .prog_name = undefined,
            .prog_ifindex = 0,
            .expected_attach_type = 0,
            .prog_btf_fd = 0,
            .func_info_rec_size = 0,
            .func_info = 0,
            .func_info_cnt = 0,
            .line_info_rec_size = 0,
            .line_info = 0,
            .line_info_cnt = 0,
        };

        @memset(&prog_load.prog_name, 0);
        @memcpy(prog_load.prog_name[0.."file_tracer".len], "file_tracer");

        const prog_fd = linux.bpf(.PROG_LOAD, @ptrCast(&prog_load), @sizeOf(@TypeOf(prog_load)));
        if (prog_fd < 0) {
            return error.BPFProgLoadFailed;
        }

        return @intCast(prog_fd);
    }

    /// Generate specialized eBPF bytecode for different tracepoint types
    fn generate_tracepoint_bytecode(self: *Self, tracepoint_name: []const u8, map_fd: i32) ![]linux.bpf_insn {
        // Determine syscall type for specialized handling
        const syscall_type = self.get_syscall_type(tracepoint_name);

        var instructions = std.ArrayList(linux.bpf_insn).init(self.allocator);

        // Common prologue: Load tracepoint context into r1
        try instructions.append(linux.bpf_insn{ .code = c.BPF_LDX | c.BPF_MEM | c.BPF_DW, .dst_reg = 1, .src_reg = 1, .off = 0, .imm = 0 });

        // Stack setup for event data structure
        try instructions.append(linux.bpf_insn{ .code = c.BPF_MOV64_REG, .dst_reg = 6, .src_reg = 10, .off = 0, .imm = 0 }); // r6 = stack pointer
        try instructions.append(linux.bpf_insn{ .code = c.BPF_ALU64_IMM, .dst_reg = 6, .src_reg = 0, .off = 0, .imm = -@sizeOf(EBPFFileEvent) }); // r6 -= sizeof(event)

        // Zero event structure on stack
        try instructions.append(linux.bpf_insn{ .code = c.BPF_ST | c.BPF_MEM | c.BPF_DW, .dst_reg = 6, .src_reg = 0, .off = 0, .imm = 0 });

        // Get current PID/TID
        try instructions.append(linux.bpf_insn{ .code = c.BPF_CALL, .dst_reg = 0, .src_reg = 0, .off = 0, .imm = c.BPF_FUNC_get_current_pid_tgid });
        try instructions.append(linux.bpf_insn{ .code = c.BPF_STX | c.BPF_MEM | c.BPF_W, .dst_reg = 6, .src_reg = 0, .off = @offsetOf(EBPFFileEvent, "pid"), .imm = 0 });
        try instructions.append(linux.bpf_insn{ .code = c.BPF_RSH64_IMM, .dst_reg = 0, .src_reg = 0, .off = 0, .imm = 32 });
        try instructions.append(linux.bpf_insn{ .code = c.BPF_STX | c.BPF_MEM | c.BPF_W, .dst_reg = 6, .src_reg = 0, .off = @offsetOf(EBPFFileEvent, "tid"), .imm = 0 });

        // Get timestamp
        try instructions.append(linux.bpf_insn{ .code = c.BPF_CALL, .dst_reg = 0, .src_reg = 0, .off = 0, .imm = c.BPF_FUNC_ktime_get_ns });
        try instructions.append(linux.bpf_insn{ .code = c.BPF_STX | c.BPF_MEM | c.BPF_DW, .dst_reg = 6, .src_reg = 0, .off = @offsetOf(EBPFFileEvent, "timestamp"), .imm = 0 });

        // Syscall-specific argument extraction
        try self.generate_syscall_args_extraction(&instructions, syscall_type);

        // Extract filename from syscall arguments (context-dependent)
        try self.generate_filename_extraction(&instructions, syscall_type);

        // Send event to userspace via perf buffer
        try instructions.append(linux.bpf_insn{ .code = c.BPF_LD | c.BPF_IMM | c.BPF_DW, .dst_reg = 2, .src_reg = 1, .off = 0, .imm = map_fd }); // r2 = map_fd
        try instructions.append(linux.bpf_insn{ .code = c.BPF_MOV64_REG, .dst_reg = 3, .src_reg = 6, .off = 0, .imm = 0 }); // r3 = event data
        try instructions.append(linux.bpf_insn{ .code = c.BPF_MOV64_IMM, .dst_reg = 4, .src_reg = 0, .off = 0, .imm = @sizeOf(EBPFFileEvent) }); // r4 = data size
        try instructions.append(linux.bpf_insn{ .code = c.BPF_MOV64_IMM, .dst_reg = 5, .src_reg = 0, .off = 0, .imm = 0 }); // r5 = flags
        try instructions.append(linux.bpf_insn{ .code = c.BPF_CALL, .dst_reg = 0, .src_reg = 0, .off = 0, .imm = c.BPF_FUNC_perf_event_output });

        // Return success
        try instructions.append(linux.bpf_insn{ .code = c.BPF_MOV64_IMM, .dst_reg = 0, .src_reg = 0, .off = 0, .imm = 0 });
        try instructions.append(linux.bpf_insn{ .code = c.BPF_EXIT, .dst_reg = 0, .src_reg = 0, .off = 0, .imm = 0 });

        return instructions.toOwnedSlice();
    }

    /// Determine syscall type from tracepoint name
    fn get_syscall_type(self: *Self, tracepoint_name: []const u8) SyscallType {
        _ = self;

        if (std.mem.containsAtLeast(u8, tracepoint_name, 1, "openat")) return .openat;
        if (std.mem.containsAtLeast(u8, tracepoint_name, 1, "unlinkat")) return .unlinkat;
        if (std.mem.containsAtLeast(u8, tracepoint_name, 1, "renameat")) return .renameat;
        if (std.mem.containsAtLeast(u8, tracepoint_name, 1, "mkdir")) return .mkdir;
        if (std.mem.containsAtLeast(u8, tracepoint_name, 1, "rmdir")) return .rmdir;
        if (std.mem.containsAtLeast(u8, tracepoint_name, 1, "truncate")) return .truncate;
        return .unknown;
    }

    /// Syscall types for specialized handling
    const SyscallType = enum {
        openat,
        unlinkat,
        renameat,
        mkdir,
        rmdir,
        truncate,
        unknown,
    };

    /// Generate syscall-specific argument extraction
    fn generate_syscall_args_extraction(self: *Self, instructions: *std.ArrayList(linux.bpf_insn), syscall_type: SyscallType) !void {
        _ = self;

        switch (syscall_type) {
            .openat => {
                // Store syscall number for openat
                try instructions.append(linux.bpf_insn{ .code = c.BPF_ST | c.BPF_MEM | c.BPF_W, .dst_reg = 6, .src_reg = 0, .off = @offsetOf(EBPFFileEvent, "syscall_nr"), .imm = linux.SYS.openat });

                // Extract flags from syscall args (arg2)
                try instructions.append(linux.bpf_insn{ .code = c.BPF_LDX | c.BPF_MEM | c.BPF_DW, .dst_reg = 2, .src_reg = 1, .off = 32, .imm = 0 }); // flags
                try instructions.append(linux.bpf_insn{ .code = c.BPF_STX | c.BPF_MEM | c.BPF_W, .dst_reg = 6, .src_reg = 2, .off = @offsetOf(EBPFFileEvent, "flags"), .imm = 0 });

                // Extract mode from syscall args (arg3)
                try instructions.append(linux.bpf_insn{ .code = c.BPF_LDX | c.BPF_MEM | c.BPF_DW, .dst_reg = 3, .src_reg = 1, .off = 40, .imm = 0 }); // mode
                try instructions.append(linux.bpf_insn{ .code = c.BPF_STX | c.BPF_MEM | c.BPF_W, .dst_reg = 6, .src_reg = 3, .off = @offsetOf(EBPFFileEvent, "mode"), .imm = 0 });
            },
            .unlinkat => {
                try instructions.append(linux.bpf_insn{ .code = c.BPF_ST | c.BPF_MEM | c.BPF_W, .dst_reg = 6, .src_reg = 0, .off = @offsetOf(EBPFFileEvent, "syscall_nr"), .imm = linux.SYS.unlinkat });
                try instructions.append(linux.bpf_insn{ .code = c.BPF_ST | c.BPF_MEM | c.BPF_W, .dst_reg = 6, .src_reg = 0, .off = @offsetOf(EBPFFileEvent, "flags"), .imm = 0 });
                try instructions.append(linux.bpf_insn{ .code = c.BPF_ST | c.BPF_MEM | c.BPF_W, .dst_reg = 6, .src_reg = 0, .off = @offsetOf(EBPFFileEvent, "mode"), .imm = 0 });
            },
            .renameat => {
                try instructions.append(linux.bpf_insn{ .code = c.BPF_ST | c.BPF_MEM | c.BPF_W, .dst_reg = 6, .src_reg = 0, .off = @offsetOf(EBPFFileEvent, "syscall_nr"), .imm = linux.SYS.renameat2 });
                try instructions.append(linux.bpf_insn{ .code = c.BPF_ST | c.BPF_MEM | c.BPF_W, .dst_reg = 6, .src_reg = 0, .off = @offsetOf(EBPFFileEvent, "flags"), .imm = 0 });
                try instructions.append(linux.bpf_insn{ .code = c.BPF_ST | c.BPF_MEM | c.BPF_W, .dst_reg = 6, .src_reg = 0, .off = @offsetOf(EBPFFileEvent, "mode"), .imm = 0 });
            },
            .mkdir => {
                try instructions.append(linux.bpf_insn{ .code = c.BPF_ST | c.BPF_MEM | c.BPF_W, .dst_reg = 6, .src_reg = 0, .off = @offsetOf(EBPFFileEvent, "syscall_nr"), .imm = linux.SYS.mkdir });

                // Extract mode for mkdir
                try instructions.append(linux.bpf_insn{ .code = c.BPF_LDX | c.BPF_MEM | c.BPF_DW, .dst_reg = 2, .src_reg = 1, .off = 24, .imm = 0 }); // mode
                try instructions.append(linux.bpf_insn{ .code = c.BPF_STX | c.BPF_MEM | c.BPF_W, .dst_reg = 6, .src_reg = 2, .off = @offsetOf(EBPFFileEvent, "mode"), .imm = 0 });
                try instructions.append(linux.bpf_insn{ .code = c.BPF_ST | c.BPF_MEM | c.BPF_W, .dst_reg = 6, .src_reg = 0, .off = @offsetOf(EBPFFileEvent, "flags"), .imm = 0 });
            },
            .truncate => {
                try instructions.append(linux.bpf_insn{ .code = c.BPF_ST | c.BPF_MEM | c.BPF_W, .dst_reg = 6, .src_reg = 0, .off = @offsetOf(EBPFFileEvent, "syscall_nr"), .imm = linux.SYS.truncate });

                // Extract size from syscall args (arg1 for truncate, arg2 for ftruncate)
                // For truncate: truncate(const char *path, off_t length) - length is arg1 (offset 24)
                try instructions.append(linux.bpf_insn{ .code = c.BPF_LDX | c.BPF_MEM | c.BPF_DW, .dst_reg = 2, .src_reg = 1, .off = 24, .imm = 0 }); // length
                // Check if size fits in 31 bits (0x7FFFFFFF max)
                try instructions.append(linux.bpf_insn{ .code = c.BPF_JGT_IMM, .dst_reg = 2, .src_reg = 0, .off = 3, .imm = 0x7FFFFFFF }); // Skip if too large
                // Set high bit flag to indicate size is present and store size in lower 31 bits
                try instructions.append(linux.bpf_insn{ .code = c.BPF_ALU64_IMM, .dst_reg = 2, .src_reg = 0, .off = 0, .imm = 0 }); // Clear high bits
                try instructions.append(linux.bpf_insn{ .code = c.BPF_OR64_IMM, .dst_reg = 2, .src_reg = 0, .off = 0, .imm = 0x80000000 }); // Set size present flag
                try instructions.append(linux.bpf_insn{ .code = c.BPF_STX | c.BPF_MEM | c.BPF_W, .dst_reg = 6, .src_reg = 2, .off = @offsetOf(EBPFFileEvent, "flags"), .imm = 0 });
                // Jump target for size too large case
                try instructions.append(linux.bpf_insn{ .code = c.BPF_ST | c.BPF_MEM | c.BPF_W, .dst_reg = 6, .src_reg = 0, .off = @offsetOf(EBPFFileEvent, "mode"), .imm = 0 });
            },
            else => {
                try instructions.append(linux.bpf_insn{ .code = c.BPF_ST | c.BPF_MEM | c.BPF_W, .dst_reg = 6, .src_reg = 0, .off = @offsetOf(EBPFFileEvent, "syscall_nr"), .imm = -1 });
                try instructions.append(linux.bpf_insn{ .code = c.BPF_ST | c.BPF_MEM | c.BPF_W, .dst_reg = 6, .src_reg = 0, .off = @offsetOf(EBPFFileEvent, "flags"), .imm = 0 });
                try instructions.append(linux.bpf_insn{ .code = c.BPF_ST | c.BPF_MEM | c.BPF_W, .dst_reg = 6, .src_reg = 0, .off = @offsetOf(EBPFFileEvent, "mode"), .imm = 0 });
            },
        }
    }

    /// Generate filename extraction logic
    fn generate_filename_extraction(self: *Self, instructions: *std.ArrayList(linux.bpf_insn), syscall_type: SyscallType) !void {
        _ = self;

        // Load filename pointer from syscall arguments (typically arg1 for most file syscalls)
        const filename_arg_offset: i16 = switch (syscall_type) {
            .openat => 24, // filename is arg1 for openat
            .unlinkat => 24, // pathname is arg1 for unlinkat
            .mkdir => 16, // pathname is arg0 for mkdir
            .rmdir => 16, // pathname is arg0 for rmdir
            .truncate => 16, // path is arg0 for truncate
            .renameat => 24, // oldpath is arg1 for renameat (we'll get the old path)
            else => 24,
        };

        try instructions.append(linux.bpf_insn{ .code = c.BPF_LDX | c.BPF_MEM | c.BPF_DW, .dst_reg = 7, .src_reg = 1, .off = filename_arg_offset, .imm = 0 }); // r7 = filename ptr

        // Bounds check for filename pointer (must be non-null)
        try instructions.append(linux.bpf_insn{ .code = c.BPF_JEQ_IMM, .dst_reg = 7, .src_reg = 0, .off = 10, .imm = 0 }); // Skip if null

        // Set up for probe_read_user_str call
        try instructions.append(linux.bpf_insn{ .code = c.BPF_MOV64_REG, .dst_reg = 1, .src_reg = 6, .off = 0, .imm = 0 }); // r1 = dest (event.filename)
        try instructions.append(linux.bpf_insn{ .code = c.BPF_ALU64_IMM, .dst_reg = 1, .src_reg = 0, .off = 0, .imm = @offsetOf(EBPFFileEvent, "filename") }); // r1 += filename offset
        try instructions.append(linux.bpf_insn{ .code = c.BPF_MOV64_IMM, .dst_reg = 2, .src_reg = 0, .off = 0, .imm = 255 }); // r2 = max length (255 chars)
        try instructions.append(linux.bpf_insn{ .code = c.BPF_MOV64_REG, .dst_reg = 3, .src_reg = 7, .off = 0, .imm = 0 }); // r3 = filename ptr

        // Call bpf_probe_read_user_str to safely copy filename
        try instructions.append(linux.bpf_insn{ .code = c.BPF_CALL, .dst_reg = 0, .src_reg = 0, .off = 0, .imm = c.BPF_FUNC_probe_read_user_str });

        // Store filename length (returned in r0, but clamped to valid range)
        try instructions.append(linux.bpf_insn{ .code = c.BPF_JLT_IMM, .dst_reg = 0, .src_reg = 0, .off = 1, .imm = 256 }); // Check if length < 256
        try instructions.append(linux.bpf_insn{ .code = c.BPF_MOV64_IMM, .dst_reg = 0, .src_reg = 0, .off = 0, .imm = 255 }); // Clamp to 255 if too large
        try instructions.append(linux.bpf_insn{ .code = c.BPF_STX | c.BPF_MEM | c.BPF_W, .dst_reg = 6, .src_reg = 0, .off = @offsetOf(EBPFFileEvent, "filename_len"), .imm = 0 });
    }

    /// Attach eBPF program to kernel tracepoint
    fn attach_tracepoint(self: *Self, prog_fd: i32, tracepoint_name: []const u8) !void {

        // Open tracepoint perf event
        var perf_event_attr = std.mem.zeroes(linux.perf_event_attr);
        perf_event_attr.type = linux.PERF.TYPE.TRACEPOINT;
        perf_event_attr.size = @sizeOf(linux.perf_event_attr);
        perf_event_attr.config = try self.get_tracepoint_id(tracepoint_name);
        perf_event_attr.sample_period = 1;
        perf_event_attr.wakeup_events = 1;

        const perf_fd = linux.perf_event_open(&perf_event_attr, -1, 0, -1, 0);
        if (perf_fd < 0) {
            return error.PerfEventOpenFailed;
        }

        // Attach eBPF program to perf event
        if (linux.ioctl(perf_fd, linux.PERF.EVENT_IOC.SET_BPF, @intCast(prog_fd)) < 0) {
            _ = linux.close(perf_fd);
            return error.BPFAttachFailed;
        }

        // Enable the event
        if (linux.ioctl(perf_fd, linux.PERF.EVENT_IOC.ENABLE, 0) < 0) {
            _ = linux.close(perf_fd);
            return error.PerfEventEnableFailed;
        }
    }

    /// Get tracepoint ID from debugfs
    fn get_tracepoint_id(self: *Self, tracepoint_name: []const u8) !u64 {
        _ = self;

        // Build path to tracepoint ID file
        var path_buf: [256]u8 = undefined;
        const path = try std.fmt.bufPrint(&path_buf, "/sys/kernel/debug/tracing/events/syscalls/{s}/id", .{tracepoint_name});

        // Read the tracepoint ID
        const file = std.fs.openFileAbsolute(path, .{}) catch |err| switch (err) {
            error.FileNotFound => return error.TracepointNotFound,
            else => return err,
        };
        defer file.close();

        var buf: [32]u8 = undefined;
        const bytes_read = try file.readAll(&buf);
        const id_str = std.mem.trim(u8, buf[0..bytes_read], " \n\t");

        return std.fmt.parseUnsigned(u64, id_str, 10) catch error.InvalidTracepointId;
    }

    /// Setup perf event buffers for reading eBPF events
    fn setup_perf_events(self: *Self) !void {
        const num_cpus = std.Thread.getCpuCount() catch 4;

        for (0..num_cpus) |cpu| {
            // Create perf event for this CPU
            var perf_attr = std.mem.zeroes(linux.perf_event_attr);
            perf_attr.type = linux.PERF.TYPE.SOFTWARE;
            perf_attr.config = linux.PERF.COUNT.SW.DUMMY;
            perf_attr.size = @sizeOf(linux.perf_event_attr);
            perf_attr.sample_type = linux.PERF.SAMPLE.RAW;
            perf_attr.wakeup_events = 1;

            const perf_fd = linux.perf_event_open(&perf_attr, -1, @intCast(cpu), -1, 0);
            if (perf_fd < 0) continue;

            try self.perf_fds.append(@intCast(perf_fd));

            // Memory map the perf buffer
            const mmap_size = 8 * 4096; // 8 pages: 1 metadata + 7 data
            const ptr = try std.posix.mmap(
                null,
                mmap_size,
                std.posix.PROT.READ | std.posix.PROT.WRITE,
                std.posix.MAP.SHARED,
                @intCast(perf_fd),
                0,
            );

            try self.perf_buffers.append(ptr);
        }
    }

    /// Start monitoring eBPF events
    pub fn start_monitoring(self: *Self) !void {
        if (self.monitor_thread != null) return;

        self.should_stop.store(false, .release);
        self.monitor_thread = try std.Thread.spawn(.{}, monitor_thread_fn, .{self});
    }

    /// Stop monitoring
    pub fn stop_monitoring(self: *Self) void {
        self.should_stop.store(true, .release);

        if (self.monitor_thread) |thread| {
            thread.join();
            self.monitor_thread = null;
        }
    }

    /// Main monitoring thread
    fn monitor_thread_fn(self: *Self) void {
        var poll_fds = self.allocator.alloc(linux.pollfd, self.perf_fds.items.len) catch return;
        defer self.allocator.free(poll_fds);

        // Setup poll structures
        for (self.perf_fds.items, 0..) |fd, i| {
            poll_fds[i] = linux.pollfd{
                .fd = fd,
                .events = linux.POLL.IN,
                .revents = 0,
            };
        }

        while (!self.should_stop.load(.acquire)) {
            // Poll for events with timeout
            const ready = linux.poll(poll_fds, 10); // 10ms timeout
            if (ready < 0) break;
            if (ready == 0) continue;

            // Process ready buffers
            for (poll_fds, 0..) |*pfd, i| {
                if (pfd.revents & linux.POLL.IN != 0) {
                    self.process_perf_buffer(i);
                    pfd.revents = 0;
                }
            }
        }
    }

    /// Process events from a perf buffer
    fn process_perf_buffer(self: *Self, buffer_idx: usize) void {
        if (buffer_idx >= self.perf_buffers.items.len) return;

        const buffer = self.perf_buffers.items[buffer_idx];
        const metadata = @as(*linux.perf_event_mmap_page, @ptrCast(@alignCast(buffer.ptr)));

        // Read available events from the ring buffer
        var data_head = metadata.data_head;
        const data_tail = metadata.data_tail;

        while (data_tail != data_head) {
            const event_ptr = buffer.ptr + 4096 + (data_tail % (7 * 4096));
            const perf_sample = @as(*linux.perf_event_header, @ptrCast(@alignCast(event_ptr)));

            if (perf_sample.type == linux.PERF.RECORD.SAMPLE) {
                self.process_ebpf_event(event_ptr + @sizeOf(linux.perf_event_header));
            }

            data_head += perf_sample.size;
        }

        // Update tail pointer
        metadata.data_tail = data_head;
    }

    /// Process individual eBPF file system event
    fn process_ebpf_event(self: *Self, event_data: [*]u8) void {
        const ebpf_event = @as(*EBPFFileEvent, @ptrCast(@alignCast(event_data)));

        // Convert eBPF event to FileEvent
        const filename_len = @min(ebpf_event.filename_len, ebpf_event.filename.len);
        const filename = ebpf_event.filename[0..filename_len];

        // Determine event type from syscall number
        const event_type: EventType = switch (ebpf_event.syscall_nr) {
            linux.SYS.openat => if (ebpf_event.flags & linux.O.CREAT != 0) .created else .modified,
            linux.SYS.unlinkat => .deleted,
            linux.SYS.renameat2 => .moved,
            linux.SYS.mkdir => .created,
            linux.SYS.rmdir => .deleted,
            linux.SYS.truncate, linux.SYS.ftruncate => .modified,
            else => .metadata_changed,
        };

        // Create owned path
        const owned_path = self.allocator.dupe(u8, filename) catch {
            self.events_dropped.fetchAdd(1, .acq_rel);
            return;
        };

        const file_event = FileEvent{
            .path = owned_path,
            .event_type = event_type,
            .timestamp = ebpf_event.timestamp,
            .size = self.extract_file_size_from_event(ebpf_event),
            .is_directory = (ebpf_event.mode & linux.S.IFDIR) != 0,
        };

        // Push to ring buffer
        if (self.event_buffer) |buffer| {
            if (!buffer.push(file_event)) {
                self.events_dropped.fetchAdd(1, .acq_rel);
                self.allocator.free(owned_path);
            } else {
                self.events_processed.fetchAdd(1, .acq_rel);
            }
        }
    }

    pub fn get_stats(self: *const Self) struct { processed: u64, dropped: u64 } {
        return .{
            .processed = self.events_processed.load(.acquire),
            .dropped = self.events_dropped.load(.acquire),
        };
    }

    /// Extract file size information from eBPF event context
    fn extract_file_size_from_event(self: *Self, ebpf_event: *const EBPFFileEvent) u64 {
        _ = self;

        // For most file operations, we can't get size from the syscall directly
        // This would require additional eBPF programs or userspace stat() calls
        // For now, return 0 and let userspace handle size detection

        // Special handling for truncate operations where size is an argument
        switch (ebpf_event.syscall_nr) {
            linux.SYS.truncate, linux.SYS.ftruncate => {
                // For truncate operations, the size is embedded in the event
                // The eBPF program should have extracted this from syscall arguments
                // Check if we have valid size data in the event
                if (ebpf_event.flags & 0x80000000 != 0) { // High bit indicates size data present
                    // Size is encoded in the lower 31 bits of flags field for truncate operations
                    return @as(u64, ebpf_event.flags & 0x7FFFFFFF);
                }
                return 0; // Size not available in this event
            },
            else => return 0,
        }
    }
};
