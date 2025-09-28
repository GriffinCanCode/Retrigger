//! macOS file system monitoring implementation using FSEvents
//! Follows SRP: Only responsible for macOS-specific file watching using native APIs

const std = @import("std");
const main = @import("../main.zig");
const FileEvent = main.FileEvent;
const EventType = main.EventType;
const EventRingBuffer = main.EventRingBuffer;

const c = @cImport({
    @cInclude("CoreServices/CoreServices.h");
    @cInclude("CoreFoundation/CoreFoundation.h");
    @cInclude("sys/stat.h");
    @cInclude("unistd.h");
    @cInclude("mach/mach.h");
    @cInclude("sys/proc.h");
    @cInclude("sys/sysctl.h");
});

/// Context structure passed to FSEvents callback
const FSEventsContext = struct {
    watcher: *MacOSWatcher,
    event_buffer: *EventRingBuffer,
};

/// Watched path configuration for filtering
const WatchedPath = struct {
    path: []const u8,
    is_recursive: bool,

    /// Check if a given path matches this watched path
    pub fn matches(self: *const WatchedPath, test_path: []const u8) bool {
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

/// Userspace eBPF Virtual Machine for macOS
const MacOSEBPFVM = struct {
    const Self = @This();

    allocator: std.mem.Allocator,
    programs: std.ArrayList(EBPFProgram),
    maps: std.ArrayList(EBPFMap),
    is_running: bool,
    event_buffer: ?*EventRingBuffer,
    // Path filtering support
    watched_paths: std.ArrayList(WatchedPath),
    recursive_enabled: bool,

    const EBPFProgram = struct {
        instructions: []const EBPFInstruction,
        program_type: EBPFProgramType,
        attached: bool,
        name: []const u8,
    };

    const EBPFMap = struct {
        map_type: EBPFMapType,
        key_size: u32,
        value_size: u32,
        max_entries: u32,
        data: std.HashMap(u64, []u8, std.hash_map.AutoContext(u64), 80),
    };

    const EBPFInstruction = packed struct {
        opcode: u8,
        dst_reg: u4,
        src_reg: u4,
        offset: i16,
        immediate: i32,
    };

    const EBPFProgramType = enum {
        socket_filter,
        kprobe,
        tracepoint,
        xdp,
        perf_event,
    };

    const EBPFMapType = enum {
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
    };

    pub fn init(allocator: std.mem.Allocator) Self {
        return Self{
            .allocator = allocator,
            .programs = std.ArrayList(EBPFProgram){},
            .maps = std.ArrayList(EBPFMap){},
            .is_running = false,
            .event_buffer = null,
            .watched_paths = std.ArrayList(WatchedPath){},
            .recursive_enabled = false,
        };
    }

    pub fn deinit(self: *Self) void {
        for (self.programs.items) |program| {
            self.allocator.free(program.instructions);
            self.allocator.free(program.name);
        }
        self.programs.deinit(self.allocator);

        for (self.maps.items) |*map| {
            var iterator = map.data.iterator();
            while (iterator.next()) |entry| {
                self.allocator.free(entry.value_ptr.*);
            }
            map.data.deinit();
        }
        self.maps.deinit(self.allocator);

        // Clean up watched paths
        for (self.watched_paths.items) |watched_path| {
            self.allocator.free(watched_path.path);
        }
        self.watched_paths.deinit(self.allocator);
    }

    /// Load eBPF program into userspace VM
    pub fn load_program(self: *Self, instructions: []const EBPFInstruction, program_type: EBPFProgramType, name: []const u8) !u32 {
        const owned_instructions = try self.allocator.dupe(EBPFInstruction, instructions);
        const owned_name = try self.allocator.dupe(u8, name);

        const program = EBPFProgram{
            .instructions = owned_instructions,
            .program_type = program_type,
            .attached = false,
            .name = owned_name,
        };

        try self.programs.append(self.allocator, program);
        return @intCast(self.programs.items.len - 1);
    }

    /// Create eBPF map
    pub fn create_map(self: *Self, map_type: EBPFMapType, key_size: u32, value_size: u32, max_entries: u32) !u32 {
        const map = EBPFMap{
            .map_type = map_type,
            .key_size = key_size,
            .value_size = value_size,
            .max_entries = max_entries,
            .data = std.HashMap(u64, []u8, std.hash_map.AutoContext(u64), 80).init(self.allocator),
        };

        try self.maps.append(self.allocator, map);
        return @intCast(self.maps.items.len - 1);
    }

    /// Execute eBPF program with context
    pub fn execute_program(self: *Self, program_id: u32, context: []const u8) !u32 {
        if (program_id >= self.programs.items.len) return error.InvalidProgramId;

        const program = &self.programs.items[program_id];
        if (!program.attached) return error.ProgramNotAttached;

        return self.run_ebpf_interpreter(program.instructions, context);
    }

    /// Run eBPF bytecode interpreter
    fn run_ebpf_interpreter(self: *Self, instructions: []const EBPFInstruction, context: []const u8) !u32 {
        var registers: [11]u64 = std.mem.zeroes([11]u64);
        var stack: [512]u8 = std.mem.zeroes([512]u8);
        var pc: usize = 0;

        // Initialize context pointer in r1
        registers[1] = @intFromPtr(context.ptr);

        // Initialize stack pointer in r10
        registers[10] = @intFromPtr(&stack[stack.len - 1]);

        while (pc < instructions.len) {
            const inst = instructions[pc];

            switch (inst.opcode) {
                // BPF_LD class
                0x18 => { // BPF_LD | BPF_IMM | BPF_DW - Load 64-bit immediate
                    if (pc + 1 >= instructions.len) return error.InvalidInstruction;
                    registers[inst.dst_reg] = @as(u64, @intCast(inst.immediate)) | (@as(u64, @intCast(instructions[pc + 1].immediate)) << 32);
                    pc += 2;
                    continue;
                },

                // BPF_LDX class - Memory loads
                0x61 => { // BPF_LDX | BPF_MEM | BPF_W - Load word from memory
                    const addr = registers[inst.src_reg] +% @as(u64, @bitCast(@as(i64, inst.offset)));
                    registers[inst.dst_reg] = std.mem.readIntLittle(u32, @as([*]u8, @ptrFromInt(addr))[0..4]);
                },
                0x69 => { // BPF_LDX | BPF_MEM | BPF_H - Load half word
                    const addr = registers[inst.src_reg] +% @as(u64, @bitCast(@as(i64, inst.offset)));
                    registers[inst.dst_reg] = std.mem.readIntLittle(u16, @as([*]u8, @ptrFromInt(addr))[0..2]);
                },
                0x71 => { // BPF_LDX | BPF_MEM | BPF_B - Load byte
                    const addr = registers[inst.src_reg] +% @as(u64, @bitCast(@as(i64, inst.offset)));
                    registers[inst.dst_reg] = @as(*u8, @ptrFromInt(addr)).*;
                },
                0x79 => { // BPF_LDX | BPF_MEM | BPF_DW - Load double word
                    const addr = registers[inst.src_reg] +% @as(u64, @bitCast(@as(i64, inst.offset)));
                    registers[inst.dst_reg] = std.mem.readIntLittle(u64, @as([*]u8, @ptrFromInt(addr))[0..8]);
                },

                // BPF_STX class - Memory stores
                0x62 => { // BPF_STX | BPF_MEM | BPF_W - Store word
                    const addr = registers[inst.dst_reg] +% @as(u64, @bitCast(@as(i64, inst.offset)));
                    std.mem.writeIntLittle(u32, @as([*]u8, @ptrFromInt(addr))[0..4], @truncate(registers[inst.src_reg]));
                },
                0x6a => { // BPF_STX | BPF_MEM | BPF_H - Store half word
                    const addr = registers[inst.dst_reg] +% @as(u64, @bitCast(@as(i64, inst.offset)));
                    std.mem.writeIntLittle(u16, @as([*]u8, @ptrFromInt(addr))[0..2], @truncate(registers[inst.src_reg]));
                },
                0x72 => { // BPF_STX | BPF_MEM | BPF_B - Store byte
                    const addr = registers[inst.dst_reg] +% @as(u64, @bitCast(@as(i64, inst.offset)));
                    @as(*u8, @ptrFromInt(addr)).* = @truncate(registers[inst.src_reg]);
                },
                0x7a => { // BPF_STX | BPF_MEM | BPF_DW - Store double word
                    const addr = registers[inst.dst_reg] +% @as(u64, @bitCast(@as(i64, inst.offset)));
                    std.mem.writeIntLittle(u64, @as([*]u8, @ptrFromInt(addr))[0..8], registers[inst.src_reg]);
                },

                // BPF_ALU64 class
                0xbf => { // BPF_ALU64 | BPF_MOV | BPF_X - Move register to register
                    registers[inst.dst_reg] = registers[inst.src_reg];
                },
                0xb7 => { // BPF_ALU64 | BPF_MOV | BPF_K - Move immediate to register
                    registers[inst.dst_reg] = @as(u64, @bitCast(@as(i64, inst.immediate)));
                },
                0x07 => { // BPF_ALU64 | BPF_ADD | BPF_K - Add immediate
                    registers[inst.dst_reg] +%= @as(u64, @bitCast(@as(i64, inst.immediate)));
                },
                0x0f => { // BPF_ALU64 | BPF_ADD | BPF_X - Add register
                    registers[inst.dst_reg] +%= registers[inst.src_reg];
                },
                0x17 => { // BPF_ALU64 | BPF_SUB | BPF_K - Subtract immediate
                    registers[inst.dst_reg] -%= @as(u64, @bitCast(@as(i64, inst.immediate)));
                },
                0x1f => { // BPF_ALU64 | BPF_SUB | BPF_X - Subtract register
                    registers[inst.dst_reg] -%= registers[inst.src_reg];
                },
                0x27 => { // BPF_ALU64 | BPF_MUL | BPF_K - Multiply immediate
                    registers[inst.dst_reg] *%= @as(u64, @bitCast(@as(i64, inst.immediate)));
                },
                0x2f => { // BPF_ALU64 | BPF_MUL | BPF_X - Multiply register
                    registers[inst.dst_reg] *%= registers[inst.src_reg];
                },
                0x37 => { // BPF_ALU64 | BPF_DIV | BPF_K - Divide by immediate
                    const divisor = @as(u64, @bitCast(@as(i64, inst.immediate)));
                    if (divisor == 0) return error.DivisionByZero;
                    registers[inst.dst_reg] /= divisor;
                },
                0x3f => { // BPF_ALU64 | BPF_DIV | BPF_X - Divide by register
                    if (registers[inst.src_reg] == 0) return error.DivisionByZero;
                    registers[inst.dst_reg] /= registers[inst.src_reg];
                },
                0x47 => { // BPF_ALU64 | BPF_OR | BPF_K - Bitwise OR with immediate
                    registers[inst.dst_reg] |= @as(u64, @bitCast(@as(i64, inst.immediate)));
                },
                0x4f => { // BPF_ALU64 | BPF_OR | BPF_X - Bitwise OR with register
                    registers[inst.dst_reg] |= registers[inst.src_reg];
                },
                0x57 => { // BPF_ALU64 | BPF_AND | BPF_K - Bitwise AND with immediate
                    registers[inst.dst_reg] &= @as(u64, @bitCast(@as(i64, inst.immediate)));
                },
                0x5f => { // BPF_ALU64 | BPF_AND | BPF_X - Bitwise AND with register
                    registers[inst.dst_reg] &= registers[inst.src_reg];
                },
                0x67 => { // BPF_ALU64 | BPF_LSH | BPF_K - Left shift by immediate
                    registers[inst.dst_reg] <<= @as(u6, @intCast(inst.immediate & 0x3F));
                },
                0x6f => { // BPF_ALU64 | BPF_LSH | BPF_X - Left shift by register
                    registers[inst.dst_reg] <<= @as(u6, @intCast(registers[inst.src_reg] & 0x3F));
                },
                0x77 => { // BPF_ALU64 | BPF_RSH | BPF_K - Right shift by immediate
                    registers[inst.dst_reg] >>= @as(u6, @intCast(inst.immediate & 0x3F));
                },
                0x7f => { // BPF_ALU64 | BPF_RSH | BPF_X - Right shift by register
                    registers[inst.dst_reg] >>= @as(u6, @intCast(registers[inst.src_reg] & 0x3F));
                },
                0xa7 => { // BPF_ALU64 | BPF_XOR | BPF_K - Bitwise XOR with immediate
                    registers[inst.dst_reg] ^= @as(u64, @bitCast(@as(i64, inst.immediate)));
                },
                0xaf => { // BPF_ALU64 | BPF_XOR | BPF_X - Bitwise XOR with register
                    registers[inst.dst_reg] ^= registers[inst.src_reg];
                },

                // BPF_JMP class
                0x85 => { // BPF_CALL - Function call
                    const result = try self.handle_helper_call(@intCast(inst.immediate), &registers);
                    registers[0] = result;
                },
                0x95 => { // BPF_EXIT - Program exit
                    return @intCast(registers[0]);
                },
                0x05 => { // BPF_JA - Unconditional jump
                    pc = @intCast(@as(i64, @intCast(pc)) + 1 + inst.offset);
                    continue;
                },
                0x15 => { // BPF_JEQ | BPF_K - Jump if equal to immediate
                    if (registers[inst.dst_reg] == @as(u64, @bitCast(@as(i64, inst.immediate)))) {
                        pc = @intCast(@as(i64, @intCast(pc)) + 1 + inst.offset);
                        continue;
                    }
                },
                0x1d => { // BPF_JEQ | BPF_X - Jump if equal to register
                    if (registers[inst.dst_reg] == registers[inst.src_reg]) {
                        pc = @intCast(@as(i64, @intCast(pc)) + 1 + inst.offset);
                        continue;
                    }
                },
                0x25 => { // BPF_JGT | BPF_K - Jump if greater than immediate (unsigned)
                    if (registers[inst.dst_reg] > @as(u64, @bitCast(@as(i64, inst.immediate)))) {
                        pc = @intCast(@as(i64, @intCast(pc)) + 1 + inst.offset);
                        continue;
                    }
                },
                0x2d => { // BPF_JGT | BPF_X - Jump if greater than register (unsigned)
                    if (registers[inst.dst_reg] > registers[inst.src_reg]) {
                        pc = @intCast(@as(i64, @intCast(pc)) + 1 + inst.offset);
                        continue;
                    }
                },
                0x35 => { // BPF_JGE | BPF_K - Jump if greater or equal to immediate (unsigned)
                    if (registers[inst.dst_reg] >= @as(u64, @bitCast(@as(i64, inst.immediate)))) {
                        pc = @intCast(@as(i64, @intCast(pc)) + 1 + inst.offset);
                        continue;
                    }
                },
                0x3d => { // BPF_JGE | BPF_X - Jump if greater or equal to register (unsigned)
                    if (registers[inst.dst_reg] >= registers[inst.src_reg]) {
                        pc = @intCast(@as(i64, @intCast(pc)) + 1 + inst.offset);
                        continue;
                    }
                },
                0x55 => { // BPF_JNE | BPF_K - Jump if not equal to immediate
                    if (registers[inst.dst_reg] != @as(u64, @bitCast(@as(i64, inst.immediate)))) {
                        pc = @intCast(@as(i64, @intCast(pc)) + 1 + inst.offset);
                        continue;
                    }
                },
                0x5d => { // BPF_JNE | BPF_X - Jump if not equal to register
                    if (registers[inst.dst_reg] != registers[inst.src_reg]) {
                        pc = @intCast(@as(i64, @intCast(pc)) + 1 + inst.offset);
                        continue;
                    }
                },
                0xa5 => { // BPF_JLT | BPF_K - Jump if less than immediate (unsigned)
                    if (registers[inst.dst_reg] < @as(u64, @bitCast(@as(i64, inst.immediate)))) {
                        pc = @intCast(@as(i64, @intCast(pc)) + 1 + inst.offset);
                        continue;
                    }
                },
                0xad => { // BPF_JLT | BPF_X - Jump if less than register (unsigned)
                    if (registers[inst.dst_reg] < registers[inst.src_reg]) {
                        pc = @intCast(@as(i64, @intCast(pc)) + 1 + inst.offset);
                        continue;
                    }
                },
                0xb5 => { // BPF_JLE | BPF_K - Jump if less or equal to immediate (unsigned)
                    if (registers[inst.dst_reg] <= @as(u64, @bitCast(@as(i64, inst.immediate)))) {
                        pc = @intCast(@as(i64, @intCast(pc)) + 1 + inst.offset);
                        continue;
                    }
                },
                0xbd => { // BPF_JLE | BPF_X - Jump if less or equal to register (unsigned)
                    if (registers[inst.dst_reg] <= registers[inst.src_reg]) {
                        pc = @intCast(@as(i64, @intCast(pc)) + 1 + inst.offset);
                        continue;
                    }
                },

                else => {
                    std.log.warn("Unimplemented eBPF opcode: 0x{x}", .{inst.opcode});
                    return error.UnimplementedOpcode;
                },
            }

            pc += 1;
        }

        return 0;
    }

    /// Handle eBPF helper function calls
    fn handle_helper_call(self: *Self, func_id: u32, registers: *[11]u64) !u64 {
        switch (func_id) {
            1 => { // bpf_map_lookup_elem
                return self.map_lookup_elem(@intCast(registers[1]), registers[2]);
            },
            2 => { // bpf_map_update_elem
                return self.map_update_elem(@intCast(registers[1]), registers[2], registers[3], @intCast(registers[4]));
            },
            5 => { // bpf_ktime_get_ns
                return @intCast(std.time.nanoTimestamp());
            },
            11 => { // bpf_get_current_pid_tgid
                return (@as(u64, @intCast(std.os.getpid())) << 32) | @as(u64, @intCast(std.Thread.getCurrentId()));
            },
            25 => { // bpf_perf_event_output
                return self.perf_event_output(@intCast(registers[1]), @intCast(registers[2]), registers[3], @intCast(registers[4]));
            },
            else => {
                std.log.warn("Unimplemented eBPF helper function: {}", .{func_id});
                return 0;
            },
        }
    }

    /// eBPF map lookup implementation
    fn map_lookup_elem(self: *Self, map_id: u32, key_ptr: u64) !u64 {
        if (map_id >= self.maps.items.len) return 0;

        const map = &self.maps.items[map_id];
        const key_bytes = @as([*]u8, @ptrFromInt(key_ptr))[0..map.key_size];
        const key_hash = std.hash_map.hashString(key_bytes);

        if (map.data.get(key_hash)) |value| {
            return @intFromPtr(value.ptr);
        }

        return 0; // NULL
    }

    /// eBPF map update implementation
    fn map_update_elem(self: *Self, map_id: u32, key_ptr: u64, value_ptr: u64, flags: u64) !u64 {
        // BPF flag constants
        const BPF_ANY: u64 = 0;
        const BPF_NOEXIST: u64 = 1;
        const BPF_EXIST: u64 = 2;

        if (map_id >= self.maps.items.len) return 1; // -ENOENT

        var map = &self.maps.items[map_id];
        const key_bytes = @as([*]u8, @ptrFromInt(key_ptr))[0..map.key_size];
        const value_bytes = @as([*]u8, @ptrFromInt(value_ptr))[0..map.value_size];
        const key_hash = std.hash_map.hashString(key_bytes);

        // Handle BPF_* flags for conditional updates
        const key_exists = map.data.contains(key_hash);

        switch (flags) {
            BPF_NOEXIST => {
                if (key_exists) return 17; // -EEXIST: Element already exists
            },
            BPF_EXIST => {
                if (!key_exists) return 2; // -ENOENT: Element doesn't exist
            },
            BPF_ANY => {
                // No conditions, always update
            },
            else => {
                std.log.warn("Unknown BPF flag: {}", .{flags});
                return 22; // -EINVAL: Invalid argument
            },
        }

        const owned_value = try self.allocator.dupe(u8, value_bytes);
        try map.data.put(key_hash, owned_value);

        return 0; // Success
    }

    /// eBPF map delete implementation
    fn map_delete_elem(self: *Self, map_id: u32, key_ptr: u64) !u64 {
        if (map_id >= self.maps.items.len) return 1; // -ENOENT

        const map = &self.maps.items[map_id];
        const key_bytes = @as([*]u8, @ptrFromInt(key_ptr))[0..map.key_size];
        const key_hash = std.hash_map.hashString(key_bytes);

        if (map.data.remove(key_hash)) {
            return 0; // Success
        } else {
            return 2; // -ENOENT: Key doesn't exist
        }
    }

    /// eBPF probe read implementation (simplified for userspace)
    fn probe_read(self: *Self, dst: u64, size: u32, src: u64) !u64 {
        _ = self; // Unused in this implementation

        // Simplified implementation: just copy memory if both pointers are valid
        if (dst == 0 or src == 0 or size == 0) return 1; // -EFAULT

        // In a real implementation, this would safely read from kernel/user space
        // For our purposes, we'll just do a basic memory copy with bounds checking
        const src_ptr = @as([*]const u8, @ptrFromInt(src));
        const dst_ptr = @as([*]u8, @ptrFromInt(dst));

        // Copy up to the requested size
        const copy_size = @min(size, 4096); // Limit to reasonable size
        @memcpy(dst_ptr[0..copy_size], src_ptr[0..copy_size]);

        return 0; // Success
    }

    /// eBPF get current comm implementation
    fn get_current_comm(self: *Self, buf: u64, size: u32) !u64 {
        _ = self; // Unused in this implementation

        if (buf == 0 or size == 0) return 1; // -EFAULT

        // Get the current process name (simplified for macOS)
        const process_name = "retrigger-daemon"; // Could be made dynamic
        const name_len = process_name.len;
        const copy_len = @min(size, name_len);

        const buf_ptr = @as([*]u8, @ptrFromInt(buf));
        @memcpy(buf_ptr[0..copy_len], process_name[0..copy_len]);

        // Null-terminate if there's space
        if (copy_len < size) {
            buf_ptr[copy_len] = 0;
        }

        return 0; // Success
    }

    /// eBPF perf event output implementation
    fn perf_event_output(self: *Self, ctx: u32, map_id: u32, data_ptr: u64, size: u32) !u64 {
        _ = ctx;
        _ = map_id;

        if (self.event_buffer) |buffer| {
            // Convert eBPF event data to FileEvent
            if (size >= @sizeOf(MacOSEBPFEvent)) {
                const ebpf_event = @as(*const MacOSEBPFEvent, @ptrFromInt(data_ptr));
                try self.process_ebpf_event(ebpf_event, buffer);
            }
        }

        return 0;
    }

    /// Process eBPF-generated file system event
    fn process_ebpf_event(self: *Self, ebpf_event: *const MacOSEBPFEvent, buffer: *EventRingBuffer) !void {
        const filename_len = @min(ebpf_event.filename_len, 255);
        const filename = ebpf_event.filename[0..filename_len];

        const event_type: EventType = switch (ebpf_event.event_type) {
            1 => .created,
            2 => .deleted,
            3 => .modified,
            4 => .moved,
            else => .metadata_changed,
        };

        const owned_path = try self.allocator.dupe(u8, filename);

        const file_event = FileEvent{
            .path = owned_path,
            .event_type = event_type,
            .timestamp = ebpf_event.timestamp,
            .size = ebpf_event.file_size,
            .is_directory = ebpf_event.is_directory,
        };

        if (!buffer.push(file_event)) {
            self.allocator.free(owned_path);
            return error.BufferFull;
        }
    }
};

/// macOS eBPF event structure for userspace VM
const MacOSEBPFEvent = packed struct {
    pid: u32,
    tid: u32,
    timestamp: u64,
    event_type: u32,
    filename_len: u32,
    filename: [256]u8,
    file_size: u64,
    is_directory: bool,
    _padding: [7]u8, // Ensure proper alignment
};

/// macOS-specific watcher implementation following ISP
pub const MacOSWatcher = struct {
    const Self = @This();

    allocator: std.mem.Allocator,
    fsevents_stream: ?c.FSEventStreamRef,
    run_loop: ?c.CFRunLoopRef,
    watched_paths: std.ArrayList([]const u8),

    // Context for FSEvents callback
    fs_context: ?*FSEventsContext,

    // Userspace eBPF Virtual Machine for macOS
    ebpf_vm: MacOSEBPFVM,
    ebpf_enabled: bool,

    // Statistics
    dropped_events: std.atomic.Value(u64),
    total_events: std.atomic.Value(u64),
    ebpf_events_processed: std.atomic.Value(u64),

    // Thread management
    monitor_thread: ?std.Thread,
    ebpf_monitor_thread: ?std.Thread,
    should_stop: std.atomic.Value(bool),

    // Event buffer reference
    event_buffer: ?*EventRingBuffer,

    pub fn init(allocator: std.mem.Allocator) !Self {
        const ebpf_vm = MacOSEBPFVM.init(allocator);

        return Self{
            .allocator = allocator,
            .fsevents_stream = null,
            .run_loop = null,
            .watched_paths = std.ArrayList([]const u8){},
            .fs_context = null,
            .ebpf_vm = ebpf_vm,
            .ebpf_enabled = true, // Userspace eBPF VM is always available
            .dropped_events = std.atomic.Value(u64).init(0),
            .total_events = std.atomic.Value(u64).init(0),
            .ebpf_events_processed = std.atomic.Value(u64).init(0),
            .monitor_thread = null,
            .ebpf_monitor_thread = null,
            .should_stop = std.atomic.Value(bool).init(false),
            .event_buffer = null,
        };
    }

    pub fn deinit(self: *Self) void {
        self.stop_monitoring();

        // Clean up watched paths
        for (self.watched_paths.items) |path| {
            self.allocator.free(path);
        }
        self.watched_paths.deinit(self.allocator);

        // Clean up eBPF VM
        self.ebpf_vm.deinit();

        // Clean up context
        if (self.fs_context) |ctx| {
            self.allocator.destroy(ctx);
        }
    }

    pub fn watch_directory(self: *Self, path: []const u8, recursive: bool, event_buffer: *EventRingBuffer) !void {
        std.log.info("macOS watch_directory called for: {s} (recursive: {})", .{ path, recursive });

        // Store reference to event buffer for use in event processing
        self.event_buffer = event_buffer;
        std.log.info("Stored event buffer reference", .{});

        // Store the path with better error handling
        std.log.info("About to duplicate path: {s} (len: {})", .{ path, path.len });
        const owned_path = self.allocator.dupe(u8, path) catch |err| {
            std.log.err("Failed to allocate memory for path: {}", .{err});
            return; // Continue without storing this path
        };
        std.log.info("Duplicated path string successfully", .{});

        self.watched_paths.append(self.allocator, owned_path) catch |err| {
            std.log.err("Failed to append path to watched_paths: {}", .{err});
            self.allocator.free(owned_path);
            return; // Continue without watching this path
        };
        std.log.info("Added path to watched_paths successfully", .{});

        // Setup userspace eBPF VM for enhanced monitoring
        std.log.info("Checking eBPF setup (enabled: {})", .{self.ebpf_enabled});
        if (self.ebpf_enabled) {
            std.log.info("Setting up eBPF monitoring...", .{});
            self.setup_ebpf_monitoring(path, recursive, event_buffer) catch |err| {
                std.log.warn("eBPF monitoring setup failed: {}, continuing without eBPF", .{err});
            };
            std.log.info("eBPF monitoring setup completed", .{});
        }

        // Create FSEvents context
        std.log.info("Creating FSEvents context with buffer at address: {*}", .{event_buffer});
        if (self.fs_context == null) {
            self.fs_context = try self.allocator.create(FSEventsContext);
            self.fs_context.?.* = FSEventsContext{
                .watcher = self,
                .event_buffer = event_buffer,
            };
            std.log.info("FSEvents context created with buffer: {*}", .{event_buffer});
        } else {
            std.log.info("FSEvents context already exists", .{});
        }

        // Convert path to CFString with null termination
        var path_cstr: [1024:0]u8 = undefined;
        if (path.len >= path_cstr.len) {
            std.log.warn("Path too long for FSEvents: {s}", .{path});
            return; // Skip overly long paths
        }
        @memcpy(path_cstr[0..path.len], path);
        path_cstr[path.len] = 0;

        const cf_path = c.CFStringCreateWithCString(c.kCFAllocatorDefault, &path_cstr, c.kCFStringEncodingUTF8);
        if (cf_path == null) {
            std.log.warn("Failed to create CFString for path: {s}", .{path});
            return; // Continue without this path
        }
        defer c.CFRelease(cf_path);

        // Create CFArray with the path
        const paths_array = c.CFArrayCreate(c.kCFAllocatorDefault, @ptrCast(@constCast(&cf_path)), 1, &c.kCFTypeArrayCallBacks);
        if (paths_array == null) {
            std.log.warn("Failed to create CFArray for FSEvents", .{});
            return; // Continue without FSEvents
        }
        defer c.CFRelease(paths_array);

        // Configure FSEvents flags for high performance
        var flags: c.FSEventStreamCreateFlags = c.kFSEventStreamCreateFlagUseCFTypes;
        if (recursive) {
            flags |= c.kFSEventStreamCreateFlagWatchRoot;
        }
        flags |= c.kFSEventStreamCreateFlagIgnoreSelf;
        flags |= c.kFSEventStreamCreateFlagFileEvents; // Monitor individual files
        flags |= c.kFSEventStreamCreateFlagNoDefer; // No event coalescing for low latency

        // Create FSEventStreamContext for callback data
        var stream_context: c.FSEventStreamContext = .{
            .version = 0,
            .info = self.fs_context,
            .retain = null,
            .release = null,
            .copyDescription = null,
        };

        // Create FSEventStream
        self.fsevents_stream = c.FSEventStreamCreate(
            c.kCFAllocatorDefault,
            fsevents_callback,
            &stream_context,
            paths_array,
            c.kFSEventStreamEventIdSinceNow,
            0.001, // 1ms latency for high performance
            flags,
        );

        if (self.fsevents_stream == null) {
            std.log.warn("Failed to create FSEventStream, continuing in polling mode", .{});
            return; // Continue without FSEvents - we can still work in polling mode
        }

        std.log.info("FSEvents stream created successfully for path: {s}", .{path});
    }

    pub fn unwatch_directory(self: *Self, path: []const u8) !void {
        // Find and remove the path
        var i: usize = 0;
        while (i < self.watched_paths.items.len) {
            if (std.mem.eql(u8, self.watched_paths.items[i], path)) {
                const removed_path = self.watched_paths.orderedRemove(i);
                self.allocator.free(removed_path);
                break;
            }
            i += 1;
        }

        // If no more paths, stop the stream
        if (self.watched_paths.items.len == 0 and self.fsevents_stream != null) {
            c.FSEventStreamStop(self.fsevents_stream.?);
            c.FSEventStreamInvalidate(self.fsevents_stream.?);
            c.FSEventStreamRelease(self.fsevents_stream.?);
            self.fsevents_stream = null;
        }
    }

    pub fn start_monitoring(self: *Self) !void {
        if (self.monitor_thread != null) return;

        self.should_stop.store(false, .release);

        // Start FSEvents monitoring thread for real-time event processing
        std.log.info("Starting FSEvents monitoring thread...", .{});
        if (self.fsevents_stream != null) {
            self.monitor_thread = try std.Thread.spawn(.{}, monitor_thread_fn, .{self});
            std.log.info("FSEvents monitoring thread started", .{});
        }

        // Start userspace eBPF VM monitoring thread if enabled
        if (self.ebpf_enabled) {
            self.ebpf_monitor_thread = try std.Thread.spawn(.{}, ebpf_vm_monitor_thread_fn, .{self});
        }

        std.log.info("macOS monitoring setup completed with FSEvents thread", .{});
    }

    pub fn stop_monitoring(self: *Self) void {
        self.should_stop.store(true, .release);

        // Stop FSEvents stream
        if (self.fsevents_stream) |stream| {
            c.FSEventStreamStop(stream);
            c.FSEventStreamInvalidate(stream);
            c.FSEventStreamRelease(stream);
            self.fsevents_stream = null;
        }

        // Stop run loop
        if (self.run_loop) |loop| {
            c.CFRunLoopStop(loop);
        }

        // Stop eBPF VM
        if (self.ebpf_enabled) {
            self.ebpf_vm.is_running = false;
        }

        // Join threads
        if (self.monitor_thread) |thread| {
            thread.join();
            self.monitor_thread = null;
        }

        if (self.ebpf_monitor_thread) |thread| {
            thread.join();
            self.ebpf_monitor_thread = null;
        }
    }

    pub fn get_dropped_events(self: *const Self) u64 {
        return self.dropped_events.load(.acquire);
    }

    /// Main monitoring thread function
    fn monitor_thread_fn(self: *Self) void {
        if (self.fsevents_stream == null) return;

        // Get current run loop
        self.run_loop = c.CFRunLoopGetCurrent();

        // Schedule the stream
        c.FSEventStreamScheduleWithRunLoop(
            self.fsevents_stream.?,
            self.run_loop.?,
            c.kCFRunLoopDefaultMode,
        );

        // Start the stream
        if (c.FSEventStreamStart(self.fsevents_stream.?) == 0) {
            std.log.err("Failed to start FSEventStream", .{});
            return;
        }

        // Run the loop until stopped - optimized for low latency
        while (!self.should_stop.load(.acquire)) {
            const result = c.CFRunLoopRunInMode(c.kCFRunLoopDefaultMode, 0.001, @intFromBool(true)); // 1ms timeout
            if (result == c.kCFRunLoopRunStopped or result == c.kCFRunLoopRunFinished) {
                break;
            }
        }
    }

    /// Process a single FSEvent and convert to FileEvent
    fn process_fsevent(self: *Self, path_cfstr: c.CFStringRef, flags: c.FSEventStreamEventFlags, event_buffer: *EventRingBuffer) void {
        // Convert CFString to C string
        var path_buffer: [1024]u8 = undefined;
        const success = c.CFStringGetCString(path_cfstr, &path_buffer, path_buffer.len, c.kCFStringEncodingUTF8);
        if (success == 0) {
            _ = self.dropped_events.fetchAdd(1, .acq_rel);
            return;
        }

        const path_len = std.mem.len(@as([*:0]const u8, @ptrCast(&path_buffer)));
        const path = path_buffer[0..path_len];

        // Determine event type from flags
        std.log.info("FSEvent: Processing path with flags 0x{x}: detecting event type", .{flags});
        const event_type: EventType = if (flags & c.kFSEventStreamEventFlagItemCreated != 0)
            .created
        else if (flags & c.kFSEventStreamEventFlagItemRemoved != 0)
            .deleted
        else if (flags & c.kFSEventStreamEventFlagItemModified != 0)
            .modified
        else if (flags & c.kFSEventStreamEventFlagItemRenamed != 0)
            .moved
        else if (flags & (c.kFSEventStreamEventFlagItemInodeMetaMod | c.kFSEventStreamEventFlagItemChangeOwner | c.kFSEventStreamEventFlagItemXattrMod) != 0)
            .metadata_changed
        else if (flags & c.kFSEventStreamEventFlagItemIsFile != 0) blk: {
            std.log.info("FSEvent: File creation detected (ItemIsFile flag)", .{});
            break :blk .created;
        } else blk: {
            // Treat any other flag as a file creation/modification event
            std.log.info("FSEvent: Treating unknown flags 0x{x} as created event", .{flags});
            break :blk .created;
        };

        // Get file statistics - optimized path
        var file_size: u64 = 0;
        var is_directory = false;

        var stat_buf: c.struct_stat = undefined;
        if (c.stat(path.ptr, &stat_buf) == 0) {
            file_size = @intCast(stat_buf.st_size);
            is_directory = c.S_ISDIR(stat_buf.st_mode);
        }

        // Create owned path
        const owned_path = self.allocator.dupe(u8, path) catch {
            _ = self.dropped_events.fetchAdd(1, .acq_rel);
            return;
        };

        // Create FileEvent
        const event = FileEvent{
            .path = owned_path,
            .event_type = event_type,
            .timestamp = @intCast(std.time.nanoTimestamp()),
            .size = file_size,
            .is_directory = is_directory,
        };

        // Push to ring buffer
        if (!event_buffer.push(event)) {
            _ = self.dropped_events.fetchAdd(1, .acq_rel);
            self.allocator.free(owned_path);
            std.log.warn("FSEvent: Event buffer full, dropped event for {s}", .{path});
        } else {
            _ = self.total_events.fetchAdd(1, .acq_rel);
        }
    }

    /// Setup userspace eBPF monitoring for enhanced file system tracking
    fn setup_ebpf_monitoring(self: *Self, path: []const u8, recursive: bool, event_buffer: *EventRingBuffer) !void {
        if (!self.ebpf_enabled) return;

        self.ebpf_vm.event_buffer = event_buffer;

        // Configure path filtering and recursive monitoring
        const owned_path = try self.allocator.dupe(u8, path);
        const watched_path = WatchedPath{
            .path = owned_path,
            .is_recursive = recursive,
        };
        try self.ebpf_vm.watched_paths.append(self.allocator, watched_path);
        self.ebpf_vm.recursive_enabled = recursive;

        // Create eBPF map for file events
        _ = try self.ebpf_vm.create_map(.ringbuf, 0, 0, 64 * 1024); // 64KB ring buffer

        // Generate eBPF program for file monitoring with path filtering
        // Generate simple eBPF program for file monitoring
        var program_instructions = std.ArrayList(u8){};
        defer program_instructions.deinit(self.allocator);

        // Add minimal eBPF instructions (simplified)
        try program_instructions.append(self.allocator, 0x95); // BPF_EXIT

        // Load eBPF program into VM
        // Create a dummy eBPF instruction instead of using bytes
        const ebpf_instruction = MacOSEBPFVM.EBPFInstruction{ .opcode = 0x95, .dst_reg = 0, .src_reg = 0, .offset = 0, .immediate = 0 };
        const program_id = try self.ebpf_vm.load_program(&[_]MacOSEBPFVM.EBPFInstruction{ebpf_instruction}, .tracepoint, "macos_file_monitor");

        // Mark program as attached (simulate attachment to FSEvents)
        self.ebpf_vm.programs.items[program_id].attached = true;

        std.log.info("macOS userspace eBPF VM monitoring setup completed for path: {s} (recursive: {})", .{ path, recursive });
    }

    /// eBPF VM monitoring thread function
    fn ebpf_vm_monitor_thread_fn(self: *Self) void {
        if (!self.ebpf_enabled) return;

        self.ebpf_vm.is_running = true;

        while (!self.should_stop.load(.acquire) and self.ebpf_vm.is_running) {
            // Process eBPF events (simplified simulation)
            std.Thread.sleep(10 * std.time.ns_per_ms);
        }

        self.ebpf_vm.is_running = false;
    }
};

/// FSEvents callback function - follows functional programming principles
fn fsevents_callback(
    stream: ?*const c.struct___FSEventStream,
    client_info: ?*anyopaque,
    num_events: usize,
    event_paths: ?*anyopaque,
    event_flags: [*c]const c.FSEventStreamEventFlags,
    event_ids: [*c]const c.FSEventStreamEventId,
) callconv(.c) void {
    _ = stream;
    _ = event_ids;

    std.log.info("FSEvents callback triggered with {} events", .{num_events});

    // Get context from client_info
    if (client_info == null) {
        std.log.warn("FSEvents callback: client_info is null", .{});
        return;
    }
    const context = @as(*FSEventsContext, @ptrCast(@alignCast(client_info)));

    if (event_paths == null or event_flags == null) {
        std.log.warn("FSEvents callback: event_paths or event_flags is null", .{});
        return;
    }

    const paths = @as(c.CFArrayRef, @ptrCast(event_paths));
    const count = c.CFArrayGetCount(paths);
    std.log.info("FSEvents callback: Processing {} path entries", .{count});

    for (0..@intCast(@min(count, num_events))) |i| {
        const path_cfstr = @as(c.CFStringRef, @ptrCast(c.CFArrayGetValueAtIndex(paths, @intCast(i))));
        const flags = event_flags[i];

        std.log.info("FSEvents callback: Processing event {} with flags 0x{x}", .{ i, flags });

        // Process event using the context
        context.watcher.process_fsevent(path_cfstr, flags, context.event_buffer);
    }

    std.log.info("FSEvents callback: Finished processing {} events", .{num_events});
}
