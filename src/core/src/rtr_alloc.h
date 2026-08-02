/*
 * The allocation seam.
 *
 * Every heap allocation in this library goes through these two macros. They
 * expand to plain malloc/free in a normal build and cost nothing, but they give
 * the test suite somewhere to stand.
 *
 * The reason to bother: the out-of-memory branches are the only branches here
 * that never execute in practice, which is precisely why they are the ones most
 * likely to be wrong. `rtr_hash_file` allocates twice and has to unwind both on
 * failure while still closing its file; that unwinding was unreachable from a
 * test before this seam existed.
 *
 * With -DRTR_ALLOC_HOOKS the library calls into an allocator the test provides,
 * which can fail the Nth allocation on demand and count outstanding blocks.
 * Block counting also gives us a leak oracle on platforms where
 * LeakSanitizer is unavailable, macOS among them.
 */

#ifndef RTR_ALLOC_H
#define RTR_ALLOC_H

#include <stdlib.h>

#ifdef RTR_ALLOC_HOOKS

/* Defined by the test binary, not by the library. */
void *rtr_hook_malloc(size_t size);
void rtr_hook_free(void *ptr);

#define RTR_MALLOC(size) rtr_hook_malloc(size)
#define RTR_FREE(ptr) rtr_hook_free(ptr)

#else

#define RTR_MALLOC(size) malloc(size)
#define RTR_FREE(ptr) free(ptr)

#endif /* RTR_ALLOC_HOOKS */

#endif /* RTR_ALLOC_H */
