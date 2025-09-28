use std::env;
use std::path::Path;
use std::process::Command;

fn main() {
    let _out_dir = env::var("OUT_DIR").unwrap();
    let manifest_dir = env::var("CARGO_MANIFEST_DIR").unwrap();

    // Build the Zig system library
    let zig_dir = Path::new(&manifest_dir)
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("system/zig");

    let output = Command::new("zig")
        .args(["build", "-Doptimize=ReleaseFast"])
        .current_dir(&zig_dir)
        .output();

    match output {
        Ok(output) => {
            if !output.status.success() {
                println!(
                    "cargo:warning=Zig build failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
                println!("cargo:warning=Falling back to stub implementation");
                return;
            }
        }
        Err(e) => {
            println!("cargo:warning=Zig not found ({e}), using stub implementation");
            return;
        }
    }

    // Link the Zig library
    let zig_lib_dir = zig_dir.join("zig-out/lib");
    println!("cargo:rustc-link-search=native={}", zig_lib_dir.display());
    println!("cargo:rustc-link-lib=static=retrigger_system");

    // Platform-specific libraries
    if cfg!(target_os = "linux") {
        println!("cargo:rustc-link-lib=uring");
    } else if cfg!(target_os = "macos") {
        println!("cargo:rustc-link-lib=framework=CoreFoundation");
        println!("cargo:rustc-link-lib=framework=CoreServices");
    }

    println!("cargo:rerun-if-changed=../../system/zig/");
}
