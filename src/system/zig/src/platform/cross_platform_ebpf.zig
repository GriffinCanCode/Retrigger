//! Cross-Platform eBPF Abstraction Layer
//! Unifies eBPF support across Linux (kernel), Windows (Microsoft eBPF), and macOS (userspace VM)
//! Follows SRP: Only responsible for providing a unified eBPF interface across platforms

const std = @import("std");
const builtin = @import("builtin");
const main = @import("../main.zig");
const FileEvent = main.FileEvent;
const EventType = main.EventType;
const EventRingBuffer = main.EventRingBuffer;

// Platform-specific eBPF implementations
const linux = @import("linux.zig");
const windows = @import("windows.zig");
const macos = @import("macos.zig");

/// Cross-platform eBPF program handle
pub const EBPFProgram = struct {
    handle: EBPFHandle,
    program_type: EBPFProgramType,
    attached: bool,
    platform: EBPFPlatform,
};

/// Cross-platform eBPF map handle
pub const EBPFMap = struct {
    handle: EBPFHandle,
    map_type: EBPFMapType,
    key_size: u32,
    value_size: u32,
    max_entries: u32,
    platform: EBPFPlatform,
};

/// Platform-agnostic eBPF handle
pub const EBPFHandle = union(EBPFPlatform) {
    linux: i32, // Linux kernel eBPF file descriptor
    windows: WindowsEBPFHandle, // Windows eBPF handle
    macos: MacOSEBPFHandle, // macOS userspace VM handle
};

/// Windows eBPF handle wrapper
pub const WindowsEBPFHandle = struct {
    program_fd: if (builtin.os.tag == .windows) windows.c.ebpf_handle_t else u32,
    map_fd: if (builtin.os.tag == .windows) windows.c.ebpf_handle_t else u32,
    attach_handle: if (builtin.os.tag == .windows) windows.c.ebpf_handle_t else u32,
};

/// macOS eBPF VM handle wrapper
pub const MacOSEBPFHandle = struct {
    program_id: u32,
    map_id: u32,
    vm_ref: if (builtin.os.tag == .macos) *macos.MacOSEBPFVM else *u32,
};

/// eBPF platform types
pub const EBPFPlatform = enum {
    linux,
    windows,
    macos,
};

/// eBPF program types (cross-platform)
pub const EBPFProgramType = enum {
    socket_filter,
    kprobe,
    tracepoint,
    xdp,
    perf_event,
    bind, // Windows-specific
    cgroup_sock,
    lwt_in,
    lwt_out,
    lwt_xmit,
    sock_ops,
    sk_skb,
    cgroup_device,
    sk_msg,
    raw_tracepoint,
    cgroup_sock_addr,
    lwt_seg6local,
    lirc_mode2,
    sk_reuseport,
    flow_dissector,
    cgroup_sysctl,
    cgroup_sockopt,
    tracing,
    struct_ops,
    ext,
    lsm,
};

/// eBPF map types (cross-platform)
pub const EBPFMapType = enum {
    unspec,
    hash,
    array,
    prog_array,
    perf_event_array,
    percpu_hash,
    percpu_array,
    stack_trace,
    cgroup_array,
    lru_hash,
    lru_percpu_hash,
    lpm_trie,
    array_of_maps,
    hash_of_maps,
    devmap,
    sockmap,
    cpumap,
    xskmap,
    sockhash,
    cgroup_storage,
    reuseport_sockarray,
    percpu_cgroup_storage,
    queue,
    stack,
    sk_storage,
    devmap_hash,
    struct_ops,
    ringbuf,
    inode_storage,
    task_storage,
};

/// Cross-platform eBPF instruction
pub const EBPFInstruction = packed struct {
    opcode: u8,
    dst_reg: u4,
    src_reg: u4,
    offset: i16,
    immediate: i32,
};

/// eBPF error types
pub const EBPFError = error{
    PlatformNotSupported,
    ProgramLoadFailed,
    ProgramAttachFailed,
    MapCreateFailed,
    InvalidHandle,
    ExecutionFailed,
    VerificationFailed,
    InstructionLimitExceeded,
    OutOfMemory,
    InvalidProgram,
    InvalidMap,
    PermissionDenied,
};

/// Cross-Platform eBPF Manager
pub const CrossPlatformEBPF = struct {
    const Self = @This();

    allocator: std.mem.Allocator,
    platform: EBPFPlatform,
    programs: std.ArrayList(EBPFProgram),
    maps: std.ArrayList(EBPFMap),

    // Platform-specific managers
    linux_manager: if (builtin.os.tag == .linux) linux.ebpf.EBPFManager else void,
    windows_context: if (builtin.os.tag == .windows) windows.WindowsEBPFContext else void,
    macos_vm: if (builtin.os.tag == .macos) macos.MacOSEBPFVM else void,

    // Statistics
    programs_loaded: std.atomic.Value(u64),
    programs_failed: std.atomic.Value(u64),
    events_processed: std.atomic.Value(u64),

    pub fn init(allocator: std.mem.Allocator) !Self {
        const platform: EBPFPlatform = switch (builtin.os.tag) {
            .linux => .linux,
            .windows => .windows,
            .macos => .macos,
            else => return EBPFError.PlatformNotSupported,
        };

        const self = Self{
            .allocator = allocator,
            .platform = platform,
            .programs = std.ArrayList(EBPFProgram).init(allocator),
            .maps = std.ArrayList(EBPFMap).init(allocator),
            .linux_manager = if (builtin.os.tag == .linux) linux.ebpf.EBPFManager.init(allocator) else {},
            .windows_context = if (builtin.os.tag == .windows) undefined else {},
            .macos_vm = if (builtin.os.tag == .macos) macos.MacOSEBPFVM.init(allocator) else {},
            .programs_loaded = std.atomic.Value(u64).init(0),
            .programs_failed = std.atomic.Value(u64).init(0),
            .events_processed = std.atomic.Value(u64).init(0),
        };

        // Initialize platform-specific components
        switch (platform) {
            .linux => {
                if (builtin.os.tag == .linux) {
                    // Linux eBPF manager is already initialized
                    std.log.info("Initialized Linux kernel eBPF support", .{});
                }
            },
            .windows => {
                if (builtin.os.tag == .windows) {
                    // Initialize Windows eBPF context
                    std.log.info("Initialized Windows eBPF support", .{});
                }
            },
            .macos => {
                if (builtin.os.tag == .macos) {
                    // macOS eBPF VM is already initialized
                    std.log.info("Initialized macOS userspace eBPF VM", .{});
                }
            },
        }

        return self;
    }

    pub fn deinit(self: *Self) void {
        // Clean up programs and maps
        self.programs.deinit(self.allocator);
        self.maps.deinit(self.allocator);

        // Platform-specific cleanup
        switch (self.platform) {
            .linux => {
                if (builtin.os.tag == .linux) {
                    self.linux_manager.deinit();
                }
            },
            .windows => {
                // Windows cleanup handled by WindowsWatcher
            },
            .macos => {
                if (builtin.os.tag == .macos) {
                    self.macos_vm.deinit();
                }
            },
        }
    }

    /// Create cross-platform eBPF map
    pub fn create_map(self: *Self, map_type: EBPFMapType, key_size: u32, value_size: u32, max_entries: u32) !u32 {
        const handle = switch (self.platform) {
            .linux => blk: {
                if (builtin.os.tag != .linux) return EBPFError.PlatformNotSupported;
                const fd = try self.create_linux_map(map_type, key_size, value_size, max_entries);
                break :blk EBPFHandle{ .linux = fd };
            },
            .windows => blk: {
                if (builtin.os.tag != .windows) return EBPFError.PlatformNotSupported;
                const win_handle = try self.create_windows_map(map_type, key_size, value_size, max_entries);
                break :blk EBPFHandle{ .windows = win_handle };
            },
            .macos => blk: {
                if (builtin.os.tag != .macos) return EBPFError.PlatformNotSupported;
                const macos_handle = try self.create_macos_map(map_type, key_size, value_size, max_entries);
                break :blk EBPFHandle{ .macos = macos_handle };
            },
        };

        const map = EBPFMap{
            .handle = handle,
            .map_type = map_type,
            .key_size = key_size,
            .value_size = value_size,
            .max_entries = max_entries,
            .platform = self.platform,
        };

        try self.maps.append(map);
        return @intCast(self.maps.items.len - 1);
    }

    /// Load cross-platform eBPF program
    pub fn load_program(self: *Self, instructions: []const EBPFInstruction, program_type: EBPFProgramType, name: []const u8) !u32 {
        const handle = switch (self.platform) {
            .linux => blk: {
                if (builtin.os.tag != .linux) return EBPFError.PlatformNotSupported;
                const fd = try self.load_linux_program(instructions, program_type, name);
                break :blk EBPFHandle{ .linux = fd };
            },
            .windows => blk: {
                if (builtin.os.tag != .windows) return EBPFError.PlatformNotSupported;
                const win_handle = try self.load_windows_program(instructions, program_type, name);
                break :blk EBPFHandle{ .windows = win_handle };
            },
            .macos => blk: {
                if (builtin.os.tag != .macos) return EBPFError.PlatformNotSupported;
                const macos_handle = try self.load_macos_program(instructions, program_type, name);
                break :blk EBPFHandle{ .macos = macos_handle };
            },
        };

        const program = EBPFProgram{
            .handle = handle,
            .program_type = program_type,
            .attached = false,
            .platform = self.platform,
        };

        try self.programs.append(program);
        self.programs_loaded.fetchAdd(1, .acq_rel);

        return @intCast(self.programs.items.len - 1);
    }

    /// Attach eBPF program (cross-platform)
    pub fn attach_program(self: *Self, program_id: u32, attach_point: []const u8) !void {
        if (program_id >= self.programs.items.len) return EBPFError.InvalidProgram;

        var program = &self.programs.items[program_id];

        switch (self.platform) {
            .linux => {
                if (builtin.os.tag != .linux) return EBPFError.PlatformNotSupported;
                try self.attach_linux_program(program.handle.linux, attach_point);
            },
            .windows => {
                if (builtin.os.tag != .windows) return EBPFError.PlatformNotSupported;
                try self.attach_windows_program(&program.handle.windows, attach_point);
            },
            .macos => {
                if (builtin.os.tag != .macos) return EBPFError.PlatformNotSupported;
                try self.attach_macos_program(&program.handle.macos, attach_point);
            },
        }

        program.attached = true;
    }

    /// Execute eBPF program (mainly for userspace VMs)
    pub fn execute_program(self: *Self, program_id: u32, context: []const u8) !u32 {
        if (program_id >= self.programs.items.len) return EBPFError.InvalidProgram;

        const program = &self.programs.items[program_id];

        return switch (self.platform) {
            .linux => {
                // Linux eBPF runs in kernel space, execution is handled by kernel
                return 0; // Success
            },
            .windows => {
                // Windows eBPF execution is handled by the kernel/driver
                return 0; // Success
            },
            .macos => {
                if (builtin.os.tag != .macos) return EBPFError.PlatformNotSupported;
                return self.macos_vm.execute_program(program.handle.macos.program_id, context);
            },
        };
    }

    /// Map lookup (cross-platform)
    pub fn map_lookup_elem(self: *Self, map_id: u32, key: []const u8) !?[]const u8 {
        if (map_id >= self.maps.items.len) return EBPFError.InvalidMap;

        const map = &self.maps.items[map_id];

        return switch (self.platform) {
            .linux => {
                if (builtin.os.tag != .linux) return EBPFError.PlatformNotSupported;
                return self.linux_map_lookup(map.handle.linux, key);
            },
            .windows => {
                if (builtin.os.tag != .windows) return EBPFError.PlatformNotSupported;
                return self.windows_map_lookup(&map.handle.windows, key);
            },
            .macos => {
                if (builtin.os.tag != .macos) return EBPFError.PlatformNotSupported;
                return self.macos_map_lookup(&map.handle.macos, key);
            },
        };
    }

    /// Map update (cross-platform)
    pub fn map_update_elem(self: *Self, map_id: u32, key: []const u8, value: []const u8, flags: u64) !void {
        if (map_id >= self.maps.items.len) return EBPFError.InvalidMap;

        const map = &self.maps.items[map_id];

        switch (self.platform) {
            .linux => {
                if (builtin.os.tag != .linux) return EBPFError.PlatformNotSupported;
                try self.linux_map_update(map.handle.linux, key, value, flags);
            },
            .windows => {
                if (builtin.os.tag != .windows) return EBPFError.PlatformNotSupported;
                try self.windows_map_update(&map.handle.windows, key, value, flags);
            },
            .macos => {
                if (builtin.os.tag != .macos) return EBPFError.PlatformNotSupported;
                try self.macos_map_update(&map.handle.macos, key, value, flags);
            },
        }
    }

    /// Get eBPF statistics (cross-platform)
    pub fn get_stats(self: *const Self) struct {
        platform: EBPFPlatform,
        programs_loaded: u64,
        programs_failed: u64,
        events_processed: u64,
        platform_specific: union(EBPFPlatform) {
            linux: struct { kernel_events: u64 },
            windows: struct { driver_events: u64 },
            macos: struct { vm_executions: u64 },
        },
    } {
        const platform_stats = switch (self.platform) {
            .linux => .{ .linux = .{ .kernel_events = 0 } }, // Would get from kernel
            .windows => .{ .windows = .{ .driver_events = 0 } }, // Would get from driver
            .macos => .{ .macos = .{ .vm_executions = 0 } }, // Would get from VM
        };

        return .{
            .platform = self.platform,
            .programs_loaded = self.programs_loaded.load(.acquire),
            .programs_failed = self.programs_failed.load(.acquire),
            .events_processed = self.events_processed.load(.acquire),
            .platform_specific = platform_stats,
        };
    }

    /// Check if eBPF is available on current platform
    pub fn is_available(self: *const Self) bool {
        return switch (self.platform) {
            .linux => builtin.os.tag == .linux,
            .windows => builtin.os.tag == .windows, // Would check for Windows 11+
            .macos => builtin.os.tag == .macos, // Userspace VM always available
        };
    }

    /// Get current platform
    pub fn get_platform(self: *const Self) EBPFPlatform {
        return self.platform;
    }

    // Platform-specific implementations (would be filled in with actual logic)
    fn create_linux_map(_: *Self, _: EBPFMapType, _: u32, _: u32, _: u32) !i32 {
        if (builtin.os.tag == .linux) {
            // Would use linux.bpf() syscall
            return 1; // Placeholder
        }
        return EBPFError.PlatformNotSupported;
    }

    fn create_windows_map(_: *Self, _: EBPFMapType, _: u32, _: u32, _: u32) !WindowsEBPFHandle {
        if (builtin.os.tag == .windows) {
            // Would use Windows eBPF APIs
            return WindowsEBPFHandle{ .program_fd = 1, .map_fd = 1, .attach_handle = 1 };
        }
        return EBPFError.PlatformNotSupported;
    }

    fn create_macos_map(self: *Self, map_type: EBPFMapType, key_size: u32, value_size: u32, max_entries: u32) !MacOSEBPFHandle {
        if (builtin.os.tag == .macos) {
            const vm_map_type = switch (map_type) {
                .hash => macos.MacOSEBPFVM.EBPFMapType.hash,
                .array => macos.MacOSEBPFVM.EBPFMapType.array,
                .ringbuf => macos.MacOSEBPFVM.EBPFMapType.ringbuf,
                else => macos.MacOSEBPFVM.EBPFMapType.hash,
            };
            const map_id = try self.macos_vm.create_map(vm_map_type, key_size, value_size, max_entries);
            return MacOSEBPFHandle{ .program_id = 0, .map_id = map_id, .vm_ref = &self.macos_vm };
        }
        return EBPFError.PlatformNotSupported;
    }

    fn load_linux_program(_: *Self, _: []const EBPFInstruction, _: EBPFProgramType, _: []const u8) !i32 {
        if (builtin.os.tag == .linux) {
            // Would convert instructions and use linux.bpf() syscall
            return 1; // Placeholder
        }
        return EBPFError.PlatformNotSupported;
    }

    fn load_windows_program(_: *Self, _: []const EBPFInstruction, _: EBPFProgramType, _: []const u8) !WindowsEBPFHandle {
        if (builtin.os.tag == .windows) {
            // Would use Windows eBPF APIs
            return WindowsEBPFHandle{ .program_fd = 1, .map_fd = 1, .attach_handle = 1 };
        }
        return EBPFError.PlatformNotSupported;
    }

    fn load_macos_program(self: *Self, instructions: []const EBPFInstruction, program_type: EBPFProgramType, name: []const u8) !MacOSEBPFHandle {
        if (builtin.os.tag == .macos) {
            // Convert cross-platform instructions to macOS VM instructions
            var vm_instructions = std.ArrayList(macos.MacOSEBPFVM.EBPFInstruction).init(self.allocator);
            defer vm_instructions.deinit(self.allocator);

            for (instructions) |inst| {
                try vm_instructions.append(.{
                    .opcode = inst.opcode,
                    .dst_reg = inst.dst_reg,
                    .src_reg = inst.src_reg,
                    .offset = inst.offset,
                    .immediate = inst.immediate,
                });
            }

            const vm_program_type = switch (program_type) {
                .tracepoint => macos.MacOSEBPFVM.EBPFProgramType.tracepoint,
                .kprobe => macos.MacOSEBPFVM.EBPFProgramType.kprobe,
                .socket_filter => macos.MacOSEBPFVM.EBPFProgramType.socket_filter,
                else => macos.MacOSEBPFVM.EBPFProgramType.tracepoint,
            };

            const program_id = try self.macos_vm.load_program(vm_instructions.items, vm_program_type, name);
            return MacOSEBPFHandle{ .program_id = program_id, .map_id = 0, .vm_ref = &self.macos_vm };
        }
        return EBPFError.PlatformNotSupported;
    }

    // Additional platform-specific helper methods would go here...
    fn attach_linux_program(_: *Self, _: i32, _: []const u8) !void {
        // Linux-specific attachment logic
    }

    fn attach_windows_program(_: *Self, _: *WindowsEBPFHandle, _: []const u8) !void {
        // Windows-specific attachment logic
    }

    fn attach_macos_program(self: *Self, handle: *MacOSEBPFHandle, _: []const u8) !void {
        if (builtin.os.tag == .macos) {
            // Mark program as attached in VM
            if (handle.program_id < self.macos_vm.programs.items.len) {
                self.macos_vm.programs.items[handle.program_id].attached = true;
            }
        }
    }

    fn linux_map_lookup(_: *Self, _: i32, _: []const u8) !?[]const u8 {
        return null; // Placeholder
    }

    fn windows_map_lookup(_: *Self, _: *WindowsEBPFHandle, _: []const u8) !?[]const u8 {
        return null; // Placeholder
    }

    fn macos_map_lookup(self: *Self, handle: *MacOSEBPFHandle, key: []const u8) !?[]const u8 {
        if (builtin.os.tag == .macos) {
            // Use VM map lookup
            _ = try self.macos_vm.map_lookup_elem(handle.map_id, @intFromPtr(key.ptr));
        }
        return null; // Placeholder
    }

    fn linux_map_update(_: *Self, _: i32, _: []const u8, _: []const u8, _: u64) !void {
        // Linux map update logic
    }

    fn windows_map_update(_: *Self, _: *WindowsEBPFHandle, _: []const u8, _: []const u8, _: u64) !void {
        // Windows map update logic
    }

    fn macos_map_update(self: *Self, handle: *MacOSEBPFHandle, key: []const u8, value: []const u8, flags: u64) !void {
        if (builtin.os.tag == .macos) {
            _ = try self.macos_vm.map_update_elem(handle.map_id, @intFromPtr(key.ptr), @intFromPtr(value.ptr), flags);
        }
    }
};

/// Convenience function to create cross-platform eBPF manager
pub fn create_cross_platform_ebpf(allocator: std.mem.Allocator) !CrossPlatformEBPF {
    return CrossPlatformEBPF.init(allocator);
}

/// Check eBPF availability on current platform
pub fn is_ebpf_available() bool {
    return switch (builtin.os.tag) {
        .linux => true, // Always available on Linux (kernel 3.18+)
        .windows => check_windows_ebpf_support(),
        .macos => true, // Userspace VM always available
        else => false,
    };
}

/// Check Windows eBPF support
fn check_windows_ebpf_support() bool {
    if (builtin.os.tag != .windows) return false;

    // Would check for Windows 11 or Windows Server 2022+
    // For now, assume available
    return true;
}

/// Get platform-specific eBPF capabilities
pub fn get_ebpf_capabilities() struct {
    kernel_ebpf: bool,
    userspace_vm: bool,
    jit_compilation: bool,
    verifier: bool,
    map_types: []const EBPFMapType,
    program_types: []const EBPFProgramType,
} {
    return switch (builtin.os.tag) {
        .linux => .{
            .kernel_ebpf = true,
            .userspace_vm = false,
            .jit_compilation = true,
            .verifier = true,
            .map_types = &[_]EBPFMapType{ .hash, .array, .perf_event_array, .ringbuf },
            .program_types = &[_]EBPFProgramType{ .socket_filter, .kprobe, .tracepoint, .xdp },
        },
        .windows => .{
            .kernel_ebpf = true,
            .userspace_vm = false,
            .jit_compilation = true,
            .verifier = true,
            .map_types = &[_]EBPFMapType{ .hash, .array, .ringbuf },
            .program_types = &[_]EBPFProgramType{ .bind, .xdp },
        },
        .macos => .{
            .kernel_ebpf = false,
            .userspace_vm = true,
            .jit_compilation = false, // Could be added later
            .verifier = true, // VM provides verification
            .map_types = &[_]EBPFMapType{ .hash, .array, .ringbuf },
            .program_types = &[_]EBPFProgramType{ .socket_filter, .kprobe, .tracepoint },
        },
        else => .{
            .kernel_ebpf = false,
            .userspace_vm = false,
            .jit_compilation = false,
            .verifier = false,
            .map_types = &[_]EBPFMapType{},
            .program_types = &[_]EBPFProgramType{},
        },
    };
}
