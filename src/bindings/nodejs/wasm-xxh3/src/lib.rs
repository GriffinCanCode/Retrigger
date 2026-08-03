//! A minimal C-ABI surface exposing `xxhash-rust`'s XXH3-64 to a `WebAssembly.Instance`.
//!
//! No `wasm-bindgen`, no imports: the compiled module needs nothing from its host beyond linear
//! memory, which every WebAssembly runtime provides for free (and exports under the name
//! `memory` by default). A caller writes bytes into memory it reserved via [`alloc`], calls
//! [`xxh3_64`], and gives the buffer back via [`dealloc`] — the same manual-arena pattern every
//! no-import WASM hash module uses, because there is no allocator on the other side of the
//! boundary to call `malloc` for it. See `hash-js.js` for the JavaScript half of this contract.

use std::alloc::{alloc as sys_alloc, dealloc as sys_dealloc, Layout};

/// Reserve `len` bytes of linear memory and return a pointer the caller may write into.
///
/// Returns null for `len == 0` rather than a dangling non-null pointer some allocators would
/// give a zero-size layout; [`xxh3_64`] and [`dealloc`] both special-case a null pointer to mean
/// exactly that.
///
/// # Safety
///
/// The returned pointer is valid for writes of up to `len` bytes until passed to [`dealloc`]
/// with that same `len`. The only caller is the fixed JS glue in `hash-js.js`, which never
/// resizes or forgets a buffer it allocated, so this contract has exactly one, auditable, user.
#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return std::ptr::null_mut();
    }
    // SAFETY: `len` is non-zero and byte alignment (1) is always valid, so this layout is valid
    // for `std::alloc::alloc`. `dealloc` below is given the identical layout, one-for-one.
    unsafe { sys_alloc(Layout::from_size_align_unchecked(len, 1)) }
}

/// Release a buffer previously returned by [`alloc`].
///
/// # Safety
///
/// `ptr` and `len` must be exactly what a matching, not-yet-freed [`alloc`] call returned and was
/// given; a null `ptr` (the `len == 0` case) is a documented no-op rather than undefined
/// behaviour.
#[no_mangle]
pub extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }
    // SAFETY: caller contract, documented above; identical layout to the matching `alloc`.
    unsafe { sys_dealloc(ptr, Layout::from_size_align_unchecked(len, 1)) };
}

/// XXH3-64 of the `len` bytes at `ptr`, optionally seeded.
///
/// `seed == 0` is XXH3's own no-seed case — `xxhash-rust` dispatches it to the identical code
/// path its unseeded `xxh3_64` uses — so this one export covers both `hashBytesSync`'s seeded
/// and unseeded calls; the JS glue never needs to pick between two exports.
///
/// # Safety
///
/// `ptr` must be null (if and only if `len == 0`) or point at `len` bytes that are readable and
/// not concurrently written for the duration of this call — exactly what [`alloc`] hands back
/// and what JavaScript's single-threaded execution already guarantees for a synchronous call.
#[no_mangle]
pub extern "C" fn xxh3_64(ptr: *const u8, len: usize, seed: u64) -> u64 {
    // SAFETY: caller contract, documented above.
    xxhash_rust::xxh3::xxh3_64_with_seed(unsafe { borrow(ptr, len) }, seed)
}

/// # Safety
/// As [`xxh3_64`]: `ptr` is null iff `len == 0`, otherwise valid for `len` readable bytes.
unsafe fn borrow<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if len == 0 {
        &[]
    } else {
        std::slice::from_raw_parts(ptr, len)
    }
}

/// Start an incremental hash, seeded exactly like [`xxh3_64`], and return an opaque handle.
///
/// Streaming exists for one reason: `hash-js.js` must hash a file without holding more than one
/// chunk of it resident at a time, and XXH3's one-shot function has no way to do that. The C
/// engine this mirrors offers the same split (`rtr_hash_new`/`update`/`digest`) for the same
/// reason, and both are specified to produce the byte-identical digest a one-shot call over the
/// concatenated bytes would — that identity is exactly what `hash.test.mjs` and
/// `memory.test.mjs` hold this module to.
///
/// The handle is a raw pointer smuggled through a `u32`, valid only for `wasm32`'s 32-bit address
/// space; it must be passed to [`xxh3_update`] or [`xxh3_digest`] and eventually [`xxh3_free`],
/// exactly once each per byte of state it owns.
#[no_mangle]
pub extern "C" fn xxh3_new(seed: u64) -> u32 {
    let state = Box::new(xxhash_rust::xxh3::Xxh3::with_seed(seed));
    Box::into_raw(state) as u32
}

/// Feed `len` bytes at `ptr` into the hasher `handle` names.
///
/// # Safety
///
/// `handle` must be a live value [`xxh3_new`] returned that has not yet reached [`xxh3_free`];
/// `ptr`/`len` follow [`xxh3_64`]'s contract.
#[no_mangle]
pub extern "C" fn xxh3_update(handle: u32, ptr: *const u8, len: usize) {
    // SAFETY: caller contract, documented above.
    let state = unsafe { &mut *(handle as *mut xxhash_rust::xxh3::Xxh3) };
    // SAFETY: caller contract, documented above.
    state.update(unsafe { borrow(ptr, len) });
}

/// The digest of everything fed to `handle` so far. Does not consume or reset `handle`, so a
/// caller may keep updating and re-check the running digest — `hash-js.js` never does, but
/// nothing here forbids it.
///
/// # Safety
///
/// As [`xxh3_update`].
#[no_mangle]
pub extern "C" fn xxh3_digest(handle: u32) -> u64 {
    // SAFETY: caller contract, documented above.
    let state = unsafe { &*(handle as *const xxhash_rust::xxh3::Xxh3) };
    state.digest()
}

/// Release a hasher [`xxh3_new`] returned. `hash-js.js` calls this exactly once per hasher, in a
/// `finally`, so a hash that errors partway through a file still releases its state.
///
/// # Safety
///
/// `handle` must be a value [`xxh3_new`] returned, not yet freed.
#[no_mangle]
pub extern "C" fn xxh3_free(handle: u32) {
    // SAFETY: caller contract, documented above; reclaims exactly the allocation `Box::into_raw`
    // in `xxh3_new` produced.
    drop(unsafe { Box::from_raw(handle as *mut xxhash_rust::xxh3::Xxh3) });
}
