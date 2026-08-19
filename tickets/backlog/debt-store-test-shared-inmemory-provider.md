description: The storage package's tests each paste their own copy of the same ~28-line setup helper — over twenty near-identical copies — so any change to it has to be made twenty times and new tests keep copying it again.
files:
  - packages/quereus-store/test/                     # ~20+ spec files each defining createInMemoryProvider
  - packages/quereus-store/src/testing/index.ts      # existing shared test-support entry point (@quereus/store/testing)
difficulty: easy
tradeoffs: Pure test-code cleanup that touches every spec in the package at once, making it a merge-conflict magnet against any other in-flight store work.
----

# One shared in-memory storage provider for the store package's tests

## The situation

Nearly every spec file under `packages/quereus-store/test/` opens with its own local
`createInMemoryProvider()` — a small factory that hands out in-memory key-value stores
keyed by schema/table name, plus no-op close methods. `grep` finds it in more than twenty
files. The copies are not identical: some name the helper `get`, some `ensure`; some give
the per-table statistics store its own name, some share one. None of the differences look
deliberate.

The cost is the usual one: a change to the provider interface has to be applied twenty
times, a reviewer cannot tell the meaningful variations from the accidental ones, and each
new test file copies whichever version happened to be nearby.

## What's wanted

One shared factory the specs import instead. The package already has a test-support entry
point for exactly this kind of thing — `packages/quereus-store/src/testing/` (published as
`@quereus/store/testing`), which today exports the shared conformance batteries. A provider
factory belongs there, or in a plain `test/helpers/` module if the entry point should stay
reserved for cross-backend conformance suites.

Points to settle while doing it:

- Reconcile the variants first — check whether any spec depends on its copy's specific
  store-naming before collapsing them, so the shared version does not quietly change what a
  test exercises.
- A few specs want extra behavior from the provider (failure injection, counting calls).
  The shared factory should take options rather than force those specs to keep a private
  copy.
- Two copies now take an optional backend cost declaration —
  `test/cost-profile.spec.ts` and `test/key-set-seek-store.spec.ts` both accept a
  `costProfile?` argument and spread it in only when present, deliberately, so the
  "declares nothing" provider has no such property at all. The shared factory needs that
  same option with that same spread, or those two specs stop testing what they test.
- This is mechanical and low-risk, but it touches many files: the test suite passing
  unchanged is the whole acceptance criterion.

## Arm added during review of `store-counting-double-extraction`

A sibling of this helper has since been collapsed and published: the counting variant now
lives once in `packages/quereus-store/src/testing/kv-counting-store.ts` as
`createCountingProvider(map, scope?)`, exported from `@quereus/store/testing`. Three specs
that each had their own copy now import it.

Two things that pass settle the "reconcile the variants first" question above, and the
shared plain provider should match them:

- Store names come from `buildDataStoreName` / `buildIndexStoreName` and the reserved
  `__stats__` / `__catalog__` constants, not hand-composed template strings. Hand-composing
  drops the builders' lowercasing, so a mixed-case table name reaches a store no real
  backend would have used.
- The statistics store is ONE unified store for every table, which is what the provider
  interface specifies (its schema/table arguments are documented as ignored) and what every
  real backend does. The per-table `schema.table.__stats__` spelling that most copies use
  is the accidental variant, not a deliberate one.

Still open here: `test/unique-constraints.spec.ts` holds a third counting-double shape of
its own (a `CountingKVStore` that counts only iteration, plus a `createCountingProvider`
exposing a `dataEntriesScanned(table)` method instead of a map). Folding it onto the shared
pair is a natural companion to this ticket's sweep.


## Arm added while planning `bench-store-suite`

The shared plain provider this ticket asks for is now being created as part of the
benchmark work: `bench-store-workloads` (implement/) adds `createInMemoryProvider(options?)`
to `packages/quereus-store/src/testing/`, exported from `@quereus/store/testing`, because
the store benchmark backend needs one and writing a twenty-first local copy inside `bench/`
would be the wrong move.

It is specified to match the two conventions the `store-counting-double-extraction` review
settled (store names from the shared builders; one unified `__stats__` store) plus the
only-when-present `costProfile` option this ticket already called for, and additionally to
implement `deleteIndexStore` / `deleteTableStores` with real erase semantics - the counting
sibling deliberately does not, and the benchmark suite's index-build workload drops and
recreates an index on every iteration.

**What remains for this ticket after that lands is the sweep itself**: pointing the twenty-odd
local `createInMemoryProvider` copies at the shared one, reconciling their variations, and
folding in `test/unique-constraints.spec.ts`'s third counting shape. The sweep was deliberately
kept out of the benchmark ticket, which would otherwise have become a merge-conflict magnet
across the whole store test suite.

## Arm added: `store-shared-inmemory-provider` landed the shared factory

`createInMemoryProvider(options?)` now exists at
`packages/quereus-store/src/testing/memory-provider.ts`, exported from
`@quereus/store/testing`, matching everything specified above: shared-builder store names,
one unified `__stats__` store, only-when-present `costProfile`, real-erase
`deleteIndexStore`/`deleteTableStores` (backed by a new `InMemoryKVStore.isClosed` getter so
the erase can tell a live handle from one the caller already closed, per
`KVStoreProvider.deleteTableStores`'s contract), and no `renameTableStores`.
`test/memory-provider.spec.ts` registers `runStoreNameDistinctness` and
`runStoreReclaimConformance` against it plus the `costProfile`-shape cases. This ticket's
own scope — deliberately excluded from that one — is still entirely open: the twenty-odd
local copies are not yet pointed at it.
