//! Compiles the C XXH3 engine into this crate.
//!
//! This mirrors `src/core/Makefile` and is governed by the same two rules:
//!
//!   1. No `-march=native`. The previous version of this script used it, which
//!      meant a binary built on one machine could fault with an illegal
//!      instruction on another. Since this crate ends up inside a published
//!      Node addon, "another machine" is every user.
//!   2. Each SIMD translation unit gets only its own ISA flag. `cc::Build`
//!      applies one flag set to every file it compiles, so each kernel needs
//!      its own `Build` instance. Compiling the dispatcher with `-mavx2` would
//!      let the compiler emit AVX2 into the very code whose job is to decide
//!      whether AVX2 may be used.
//!
//! Whichever kernels are skipped are disabled by `-DRTR_ENABLE_<ISA>=0`, which
//! must be visible to *every* translation unit: the dispatcher branches on
//! those macros, so a mismatch would leave it calling a kernel that was never
//! compiled.

use std::env;
use std::path::{Path, PathBuf};

const CORE_REL: &str = "../../core";

/// Kernels that can exist for a given architecture, with the flag each needs.
struct Kernel {
    file: &'static str,
    gnu_flags: &'static [&'static str],
    msvc_flags: &'static [&'static str],
    /// Macro that disables this kernel in C when it is not compiled.
    disable_define: &'static str,
}

fn main() {
    let core = PathBuf::from(CORE_REL);
    let src = core.join("src");
    let include = core.join("include");

    assert!(
        src.join("xxh3_ref.c").exists(),
        "C hash engine not found at {}. Expected the repository layout \
         src/core/src/*.c relative to this crate.",
        src.display()
    );

    let arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    let is_msvc = env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default() == "msvc";

    let candidates: &[Kernel] = match arch.as_str() {
        "x86_64" => &[
            // SSE2 is part of the x86-64 baseline, so it needs no extra flag
            // and is always available.
            Kernel {
                file: "xxh3_sse2.c",
                gnu_flags: &["-msse2"],
                msvc_flags: &[],
                disable_define: "RTR_ENABLE_SSE2",
            },
            Kernel {
                file: "xxh3_avx2.c",
                gnu_flags: &["-mavx2"],
                msvc_flags: &["/arch:AVX2"],
                disable_define: "RTR_ENABLE_AVX2",
            },
            Kernel {
                file: "xxh3_avx512.c",
                gnu_flags: &["-mavx512f", "-mavx512bw"],
                msvc_flags: &["/arch:AVX512"],
                disable_define: "RTR_ENABLE_AVX512",
            },
        ],
        "aarch64" => &[Kernel {
            // NEON is architecturally guaranteed on AArch64.
            file: "xxh3_neon.c",
            gnu_flags: &[],
            msvc_flags: &[],
            disable_define: "RTR_ENABLE_NEON",
        }],
        _ => &[],
    };

    // Probe first, compile second: the full set of disable-defines has to be
    // known before any translation unit is built, including the kernels'.
    let mut enabled: Vec<&Kernel> = Vec::new();
    let mut disabled: Vec<&'static str> = Vec::new();

    for k in candidates {
        let flags: &[&str] = if is_msvc { k.msvc_flags } else { k.gnu_flags };
        if !src.join(k.file).exists() {
            disabled.push(k.disable_define);
            continue;
        }
        if flags.iter().all(|f| flag_supported(&include, f)) {
            enabled.push(k);
        } else {
            println!(
                "cargo:warning=toolchain rejected {:?}; building without {}",
                flags, k.file
            );
            disabled.push(k.disable_define);
        }
    }

    // Kernels for other architectures are never compiled here.
    for name in [
        "RTR_ENABLE_NEON",
        "RTR_ENABLE_SSE2",
        "RTR_ENABLE_AVX2",
        "RTR_ENABLE_AVX512",
    ] {
        let compiled = enabled.iter().any(|k| k.disable_define == name);
        if !compiled && !disabled.contains(&name) {
            disabled.push(name);
        }
    }

    let base = |b: &mut cc::Build| {
        b.include(&include).opt_level(3).warnings(false);
        for d in &disabled {
            b.define(d, "0");
        }
    };

    // Portable translation units.
    let mut core_build = cc::Build::new();
    base(&mut core_build);
    for f in ["xxh3_ref.c", "dispatch.c", "hash_file.c", "benchmark.c"] {
        core_build.file(src.join(f));
    }
    core_build.compile("retrigger_hash_core");

    // One Build per kernel, each with only its own ISA flag.
    for k in &enabled {
        let mut b = cc::Build::new();
        base(&mut b);
        let flags: &[&str] = if is_msvc { k.msvc_flags } else { k.gnu_flags };
        for f in flags {
            b.flag(f);
        }
        b.file(src.join(k.file));
        b.compile(&format!("retrigger_hash_{}", k.file.trim_end_matches(".c")));
    }

    println!("cargo:rerun-if-changed={}", src.display());
    println!("cargo:rerun-if-changed={}", include.display());
}

/// Ask the configured compiler whether it accepts a flag, so an older
/// assembler degrades to fewer kernels instead of failing the whole build.
fn flag_supported(include: &Path, flag: &str) -> bool {
    if flag.is_empty() {
        return true;
    }
    let mut probe = cc::Build::new();
    probe.include(include).warnings(false).cargo_metadata(false);
    probe.is_flag_supported(flag).unwrap_or(false)
}
