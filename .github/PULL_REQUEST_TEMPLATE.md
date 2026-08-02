## What changed

<!-- One or two sentences. What behaviour is different after this merges? -->

## Why

<!-- The problem, not the patch. If it fixes an issue, link it: Fixes #123 -->

## Layers touched

- [ ] `src/core` — C hash engine
- [ ] `src/daemon` — Rust watcher / daemon / addon
- [ ] `src/bindings/nodejs` — public npm package, bundler plugins, JS fallback
- [ ] Build, CI, or packaging
- [ ] Docs only

## Verification

<!-- Paste what you ran. `make verify` is the gate: lint, every suite,
     sanitizers, and the packaged-install proof. -->

```
$ make verify
```

- [ ] `make verify` passes locally, or the reason it cannot is explained above
- [ ] Behaviour changes are covered by a test that fails without this change

## Risk

- [ ] Changes hash output or the on-disk/IPC format (**breaking**: a cache key
      that changes silently is a stale build that looks fresh)
- [ ] Changes the public JS API, TypeScript types, or exported paths
- [ ] Platform-specific — which platforms were actually exercised?
- [ ] Adds a dependency (say which, and why the alternative was worse)

## Notes for the reviewer

<!-- Anything non-obvious: a tradeoff you took, something you chose not to fix,
     a follow-up you plan. -->
