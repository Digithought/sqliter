---
description: The server and browser storage backends each had their own near-identical test for committing several stores together in one all-or-nothing write; those duplicated tests are now one shared suite both backends run, so they cannot quietly drift apart.
files:
  - packages/quereus-store/src/testing/kv-provider-conformance.ts (new — the shared provider suite)
  - packages/quereus-store/src/testing/kv-assert.ts (new — byte helpers lifted out of kv-conformance.ts)
  - packages/quereus-store/src/testing/index.ts (new — barrel for `@quereus/store/testing`)
  - packages/quereus-store/src/testing/kv-conformance.ts (imports the extracted helpers)
  - packages/quereus-store/package.json (`./testing` export now points at the barrel)
  - packages/quereus-store/README.md (documents the provider suite)
  - packages/quereus-plugin-leveldb/test/atomic-batch.spec.ts (rewritten to run the shared suite)
  - packages/quereus-plugin-indexeddb/test/atomic-batch.spec.ts (rewritten to run the shared suite)
---

## What landed

`@quereus/store/testing` now exports a second conformance battery,
`runKVProviderConformance(name, makeProviderBackend)`, a sibling of the existing
single-store `runKVStoreConformance`. It asserts the **provider-level** contract:
`KVStoreProvider.beginAtomicBatch()` returns an `AtomicBatch` whose `write()` commits
queued ops across several of that provider's stores in one durable, all-or-nothing
physical write.

Seven shared cases, run identically by both persistent backends:

- data + index ops across two stores commit together, and each op lands **only** in its
  own store (the batch addresses stores by handle, so a provider that mixed handles up
  would still commit — just to the wrong place);
- a delete and a put in one batch both apply;
- same-key ops resolve to the last one queued (both `put`-then-`delete` and the reverse);
- `clear()` discards queued ops — nothing commits;
- an empty `write()` commits nothing and does not throw;
- a wrong-type store handle throws `QuereusError` / `StatusCode.MISUSE`, on both `put`
  and `delete`;
- a correctly-typed handle belonging to a *different* provider throws the same, on both.

Backend adapter (`KVProviderBackend`) is three methods: `open()` (provider over a fresh
empty keyspace), `openForeign()` (a second provider over a *different* keyspace — the
source of the foreign handle), `teardown()` (release both).

Both plugins' `test/atomic-batch.spec.ts` were rewritten to call the shared suite and keep
only their genuinely backend-shaped case:

- LevelDB — `beginAtomicBatch()` returns `undefined` before the shared root is open (the
  root opens lazily on first `getStore`);
- IndexedDB — post-write cache invalidation, so a read after an atomic write that bypassed
  the `CachedKVStore` wrapper still sees post-write data.

Two supporting refactors: the byte helpers (`u8`, `assertBytes`, `b`) moved out of
`kv-conformance.ts` into `kv-assert.ts` so both suites share them, and `./testing` now
resolves to a barrel (`src/testing/index.ts`) instead of directly to `kv-conformance.js`.
Existing `import { runKVStoreConformance } from '@quereus/store/testing'` call sites are
unchanged.

## Coverage this actually gained (not just moved)

Consolidation was the point, but IndexedDB previously lacked three of the cases LevelDB
had. It now runs them and passes:

- ops land only in their own object store (the isolation half of the multi-store case);
- an empty `write()` is a no-op;
- a standalone delete-plus-put case.

Both backends also now check `MISUSE` on **both** `put` and `delete` (each file previously
checked only one direction per scenario).

## How to validate

```
yarn workspace @quereus/store run build      # the suite ships from dist — build first
node --import ./packages/quereus-plugin-leveldb/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus-plugin-leveldb/test/atomic-batch.spec.ts" --reporter spec
node --import ./packages/quereus-plugin-indexeddb/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus-plugin-indexeddb/test/atomic-batch.spec.ts" --reporter spec
```

Each prints the same seven shared test names under `<Backend>Provider atomic batch`, plus
one `(backend specifics)` case — 8 passing per plugin. That identical middle block *is* the
anti-drift guarantee; if the two lists ever differ, something moved that should not have.

Drift check worth doing by hand: break one backend's `beginAtomicBatch` (e.g. drop the
handle-ownership check in `packages/quereus-plugin-leveldb/src/provider.ts`
`resolveSublevel`) and confirm the shared suite fails for that backend only.

## Full validation run

- `yarn build` — clean.
- `yarn test` (whole workspace) — 4m27s, **0 failing**; totals include 7701 (quereus),
  1156 (store), 111 (indexeddb), 61 (leveldb).
- `npx tsc -p packages/quereus-plugin-leveldb/tsconfig.test.json --noEmit` and the
  IndexedDB equivalent — clean. Worth knowing: the plugins' own `typecheck` script is
  `tsc --noEmit` over `src` only, and Mocha runs specs through ts-node with type
  stripping, so **plugin spec files are not type-checked by `yarn check`**. The explicit
  `tsconfig.test.json` passes above are the only thing that type-checked these two files.
- `yarn workspace @quereus/store run typecheck` (includes its `tsconfig.test.json`) — clean.

## Known gaps / what a reviewer should push on

- **No crash-atomicity assertion.** The suite tests the queue-and-commit contract (what
  lands where, in what order), not that the commit is physically one write. A backend that
  looped op-by-op would still pass all seven. Parked as a `NOTE:` at the top of
  `kv-provider-conformance.ts` — needs a fault-injection seam to do properly, which no
  backend has today.
- **`openForeign` is a suite-shaped API.** Only one test uses it, but every adapter must
  implement it. Alternative designs (pass the foreign handle in directly) were not tried;
  push back if the shape reads wrong.
- **`assertMisuse` asserts a synchronous throw at queue time.** That matches both current
  implementations, but it is now the enforced contract — `AtomicBatch`'s doc comment says
  handles "must have been produced by the same provider" without saying *when* the
  violation surfaces. If deferring validation to `write()` should stay legal, this suite
  now forbids it.
- **`beginAtomicBatch()` returning `undefined` is asserted only in LevelDB's file.** The
  shared suite's `beginBatch` helper asserts a batch *is* returned after a store is open;
  the "not before" half stayed backend-specific because IndexedDB has no equivalent state.
- **Teardown logs rather than rethrows.** Both adapters wrap `closeAll()` in
  `try/catch` + `console.warn` (the prior specs swallowed silently). A genuinely broken
  close now warns instead of failing the test — deliberate, since teardown ordering across
  a not-yet-opened provider is legitimately noisy, but it is a judgement call.
- Per-test resource names use a process-local counter (`process.pid`-scoped for LevelDB),
  matching the existing `conformance.spec.ts` convention rather than the old
  `Date.now()/Math.random()` one.
