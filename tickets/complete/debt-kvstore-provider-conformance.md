---
description: The server and browser storage backends each had their own near-identical test for committing several stores together in one all-or-nothing write; those duplicated tests are now one shared suite both backends run, so they cannot quietly drift apart.
files:
  - packages/quereus-store/src/testing/kv-provider-conformance.ts (the shared provider suite)
  - packages/quereus-store/src/testing/kv-assert.ts (byte helpers shared by both suites)
  - packages/quereus-store/src/testing/index.ts (barrel for `@quereus/store/testing`)
  - packages/quereus-store/src/common/kv-store.ts (`AtomicBatch` single-use contract documented)
  - packages/quereus-store/README.md, docs/store.md (document the provider suite)
  - packages/quereus-plugin-leveldb/test/atomic-batch.spec.ts
  - packages/quereus-plugin-indexeddb/test/atomic-batch.spec.ts
  - packages/quereus-plugin-{leveldb,indexeddb}/package.json (typecheck now covers test files)
---

## What landed

`@quereus/store/testing` exports `runKVProviderConformance(name, makeProviderBackend)`, a
sibling of the existing single-store `runKVStoreConformance`. It asserts the
provider-level contract: `KVStoreProvider.beginAtomicBatch()` returns an `AtomicBatch`
whose `write()` commits queued ops across several of that provider's stores in one
durable, all-or-nothing physical write.

Nine shared cases, run identically by both persistent backends (seven from implement, two
added in review):

- data + index ops across two stores commit together, each op landing only in its own store;
- **nothing is visible until `write()`** — pre-write reads see the pre-batch state, and on a
  caching backend those reads must not survive the commit as stale entries (new in review);
- **a batched delete of a key that was never written is a no-op, not an error** (new in review);
- a delete and a put in one batch both apply;
- same-key ops resolve to the last one queued (both directions);
- `clear()` discards queued ops;
- an empty `write()` commits nothing and does not throw;
- a wrong-type store handle throws `QuereusError` / `StatusCode.MISUSE`, on `put` and `delete`;
- a correctly-typed handle from a *different* provider throws the same, on both.

Each backend supplies a three-method adapter (`open`, `openForeign`, `teardown`); every
assertion lives in the shared file. Both plugins' `test/atomic-batch.spec.ts` keep only
their genuinely backend-shaped case (LevelDB: no batch before the shared root is open;
IndexedDB: post-write read-cache invalidation).

## Review findings

**Suite sensitivity verified, not assumed.** Mutation-tested both backends against the
shared suite and reverted each edit: making `IndexedDBAtomicBatch.clear()` a no-op failed
exactly the `clear()` case; changing LevelDB's `resolveSublevel` to raise `INTERNAL`
instead of `MISUSE` failed exactly the two misuse cases. The suite is not vacuous.

**Minor — fixed in this pass:**

- *Coverage: deferred visibility untested.* Nothing asserted that queued ops stay invisible
  until `write()` — the defining half of "queue then commit". Added a case that queues a
  cross-store delete + put, reads both before `write()`, then re-reads after. On IndexedDB
  it also pins index-store cache invalidation, which only the data store had covered.
- *Coverage: delete of a missing key.* The coordinator replays index-maintenance deletes
  verbatim, so a delete for an entry that was never written can reach a batch. Added a case.
- *`AtomicBatch` reuse after `write()` is unspecified and the backends genuinely differ* —
  LevelDB's chained batch is closed by `write()` and throws on any later call; IndexedDB's
  merely resets its op list and keeps working. Unreachable today (the coordinator builds one
  batch per commit and drops it), so this is a contract gap rather than a bug: documented the
  batch as single-use on the `AtomicBatch` interface, and noted in the suite header why no
  reuse case is asserted (pinning either behavior would invent contract, not test it).
- *Plugin spec files were outside `yarn check`.* Both plugins' `typecheck` script was
  `tsc --noEmit` over `src` only, though each already has a `tsconfig.test.json`. Wired that
  second pass in, matching `@quereus/store`'s script. (Exposure was small — the plugins' Mocha
  runner is ts-node with type checking on, so a spec type error already failed `yarn test` —
  but whole-program checking of spec files is now part of `yarn check`.) Both pass clean.
- *Docs.* `docs/store.md`'s batch-ordering paragraph described `AtomicBatch` without
  mentioning that both backends now assert it from one shared battery — added, plus the
  single-use note. The store README's case list gained the two new cases.

**Major — none.** No new tickets filed. The implementation matches its handoff, both
backends pass the same list, and nothing found needed a design change.

**Tripwires (recorded, not ticketed):**

- No crash-atomicity assertion — a backend that committed op-by-op would still pass. The
  implementer's `NOTE:` at the top of `kv-provider-conformance.ts` stands; doing it properly
  needs a fault-injection seam no backend has. Re-verified as still accurate.
- `AtomicBatch` has no dispose, so a batch built and then abandoned without `write()` leaks
  whatever the backend holds. Only reachable via a MISUSE programming error today —
  `NOTE:` on the interface in `kv-store.ts`.
- The IndexedDB spec's `deleteDatabase` helper has no `onblocked` handler; per spec a blocked
  delete still completes, so rejecting there would be wrong, but a connection left open
  forever would surface as a Mocha hook timeout — `NOTE:` at the helper.

**Considered and deliberately left alone:** teardown logging a failed `closeAll()` rather
than rethrowing (teardown ordering across a never-opened provider is legitimately noisy, and
a genuinely broken close still shows up as a warning plus a failing delete); and the
`openForeign` adapter shape (only one test uses it, but the alternative — handing the suite a
foreign handle directly — forces every adapter to know suite internals).

## Validation

- `yarn build` — clean.
- `yarn lint` (all packages) — clean, 1m07s.
- `yarn test` (whole workspace) — 6m52s, no failures.
- Touched packages re-run individually: LevelDB 63 passing (was 61), IndexedDB 113 (was 111),
  `@quereus/store` 1156.
- `yarn workspace @quereus/plugin-leveldb run typecheck` and the IndexedDB equivalent — clean
  with the newly added `tsconfig.test.json` pass.
- Both plugins print the same nine shared test names under `<Backend>Provider atomic batch`
  plus one `(backend specifics)` case — 10 each. If those two middle lists ever differ,
  something moved that should not have.
