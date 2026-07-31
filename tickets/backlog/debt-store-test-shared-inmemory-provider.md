description: The storage package's tests each paste their own copy of the same ~28-line setup helper — over twenty near-identical copies — so any change to it has to be made twenty times and new tests keep copying it again.
files:
  - packages/quereus-store/test/                     # ~20+ spec files each defining createInMemoryProvider
  - packages/quereus-store/src/testing/index.ts      # existing shared test-support entry point (@quereus/store/testing)
difficulty: easy
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
- This is mechanical and low-risk, but it touches many files: the test suite passing
  unchanged is the whole acceptance criterion.
