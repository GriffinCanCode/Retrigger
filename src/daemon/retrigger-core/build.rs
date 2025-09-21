use std::env;
use std::path::PathBuf;

fn main() {
    let mut build = cc::Build::new();
    
    // Add source files
    build.file("../../core/src/retrigger_hash.c");
    
    // Add SIMD-specific files based on target architecture
    if cfg!(target_arch = "x86_64") {
        build
            .file("../../core/src/simd_avx2.c")
            .file("../../core/src/simd_avx512.c");
    }
    
    if cfg!(target_arch = "aarch64") {
        build.file("../../core/src/simd_neon.c");
    }
    
    // Include directory
    build.include("../../core/include");
    
    // Optimization flags
    build
        .opt_level(3)
        .flag("-march=native")
        .flag("-mtune=native");
    
    // SIMD feature detection
    if cfg!(target_arch = "x86_64") {
        build.flag("-mavx2");
        if env::var("CARGO_CFG_TARGET_FEATURE").unwrap_or_default().contains("avx512f") {
            build.flag("-mavx512f");
        }
    }
    
    if cfg!(target_arch = "aarch64") {
        build.flag("-march=armv8-a+simd");
    }
    
    // Compile the library
    build.compile("retrigger_hash");
    
    // Generate bindings
    let bindings = bindgen::Builder::default()
        .header("../../core/include/retrigger_hash.h")
        .parse_callbacks(Box::new(bindgen::CargoCallbacks))
        .generate()
        .expect("Unable to generate bindings");
    
    let out_path = PathBuf::from(env::var("OUT_DIR").unwrap());
    bindings
        .write_to_file(out_path.join("bindings.rs"))
        .expect("Couldn't write bindings!");
    
    // Rerun if C files change
    println!("cargo:rerun-if-changed=../../core/src/");
    println!("cargo:rerun-if-changed=../../core/include/");
}
