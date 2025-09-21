const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    // Static library for Rust integration
    const lib = b.addLibrary(.{
        .name = "retrigger_system",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    lib.linkLibC();

    // Add macOS frameworks if building for macOS
    if (target.result.os.tag == .macos) {
        lib.linkFramework("CoreFoundation");
        lib.linkFramework("CoreServices");
    }

    b.installArtifact(lib);

    // Main executable for testing
    const exe = b.addExecutable(.{
        .name = "retrigger_system",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    exe.linkLibC();

    // Add macOS frameworks if building for macOS
    if (target.result.os.tag == .macos) {
        exe.linkFramework("CoreFoundation");
        exe.linkFramework("CoreServices");
    }

    b.installArtifact(exe);

    // Unit tests
    const main_tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    main_tests.linkLibC();

    // Add macOS frameworks if building for macOS
    if (target.result.os.tag == .macos) {
        main_tests.linkFramework("CoreFoundation");
        main_tests.linkFramework("CoreServices");
    }

    const run_unit_tests = b.addRunArtifact(main_tests);
    const test_step = b.step("test", "Run unit tests");
    test_step.dependOn(&run_unit_tests.step);

    // Validation executable
    const validation = b.addExecutable(.{
        .name = "retrigger_validation",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/validation.zig"),
            .target = target,
            .optimize = .ReleaseFast,
        }),
    });
    validation.linkLibC();

    // Add macOS frameworks if building for macOS
    if (target.result.os.tag == .macos) {
        validation.linkFramework("CoreFoundation");
        validation.linkFramework("CoreServices");
    }

    b.installArtifact(validation);

    const run_validation = b.addRunArtifact(validation);
    const validation_step = b.step("validate", "Run performance validation");
    validation_step.dependOn(&run_validation.step);

    // Benchmark executable
    const benchmark = b.addExecutable(.{
        .name = "retrigger_benchmark",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/benchmark.zig"),
            .target = target,
            .optimize = .ReleaseFast,
        }),
    });
    benchmark.linkLibC();

    // Add macOS frameworks if building for macOS
    if (target.result.os.tag == .macos) {
        benchmark.linkFramework("CoreFoundation");
        benchmark.linkFramework("CoreServices");
    }

    b.installArtifact(benchmark);

    const run_benchmark = b.addRunArtifact(benchmark);
    const bench_step = b.step("bench", "Run benchmarks");
    bench_step.dependOn(&run_benchmark.step);

    // Complete test suite
    const all_tests = b.step("test-all", "Run all tests");
    all_tests.dependOn(test_step);
    all_tests.dependOn(validation_step);
    all_tests.dependOn(bench_step);

    // Default run step
    const run_cmd = b.addRunArtifact(exe);
    run_cmd.step.dependOn(b.getInstallStep());
    if (b.args) |args| {
        run_cmd.addArgs(args);
    }

    const run_step = b.step("run", "Run the app");
    run_step.dependOn(&run_cmd.step);
}
