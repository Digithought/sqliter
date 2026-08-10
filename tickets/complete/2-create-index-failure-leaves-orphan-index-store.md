description: A failed CREATE INDEX on a disk-backed table used to leave a half-created index behind that the session kept updating and that blocked retrying the same statement; it is now a clean no-op, and a failed DROP INDEX likewise leaves the index intact and still maintained.
files:
  - packages/quereus-store/src/common/store-module-index.ts    # createIndex, dropIndex, unwindFailedIndexDdl, guardedUnwindStep
  - packages/quereus-store/test/stream-index-build.spec.ts     # 6 new tests + snapshotResidue / expectRefusedDdlLeavesNoResidue helpers
  - docs/module-authoring.md                                   # § DDL inside an open transaction — the "engine unwinds nothing" contract
difficulty: medium
----

# What shipped

`StoreModule.createIndex` used to guard only the index *build*. Everything after it — the
connected table's cached-schema swap, the catalog write, the reconcile of the hidden `_uc_*`
stores that back a plain UNIQUE, the schema-change event — ran unguarded, and the engine
(`SchemaManager.createIndex`) registers the index in its own schema only *after* the module
returns and does no cleanup on a throw. So a failure in any of those later steps left residue
the session kept acting on.

The try/catch now spans every step. An `IndexDdlProgress` record (`{ schemaSwapped,
catalogWritten }`) tracks how far the statement got, and the catch runs the exact inverse,
newest step first: restore the cached schema and re-run `reconcileImplicitUniqueIndexStores`
with the *failed* schema as its `oldSchema` (the symmetric inverse, which rebuilds any `_uc_*`
the forward pass tore down); re-write the catalog with the pre-create bundle, only if the
statement got past `saveTableDDL`; tear down the index store. Each step is individually
guarded (`guardedUnwindStep`) so a cleanup failure is logged and the *original* error still
reaches the caller.

`dropIndex` got the mirror treatment over its own window (cached-schema swap, catalog write,
`ddlCommitPendingOps`), sharing `unwindFailedIndexDdl`. Its window deliberately **ends at
`tearDownIndexStore`**: once the physical delete has started, restoring the schema would point
the table at an index that no longer exists. That boundary is stated at the site.

# Validation

- `yarn workspace @quereus/store run test` — **1587 passing**, 0 failing (1581 before the
  ticket; 4 implement-stage tests + 2 review-stage tests).
- `yarn build`, `yarn typecheck`, `yarn lint` — all clean.
- `yarn test` (all workspaces) — clean, 6m 26s.
- Red-check on both review-stage tests: each was confirmed to fail with the behavior it guards
  temporarily disabled, then the source restored from a scratchpad backup. Failure modes seen
  were exactly the claimed ones (see *Review findings* below).

# Review findings

## What was checked

- **The implement diff, read first and on its own** (`git show a14405b0`), source and tests,
  before the handoff summary.
- **The central premise, against the engine.** `SchemaManager.createIndex`
  (`packages/quereus/src/schema/manager.ts:2443-2456`) calls the module, re-wraps a throw in a
  `QuereusError` with no cleanup, and only then does `schema.addTable(updatedTableSchema)`.
  `dropIndex` has the same shape. The premise holds — the module genuinely owns the unwind.
- **Whether any second entry point bypasses the fixed arm.** `IsolationModule.createIndex`
  prefers an instance-level `underlyingTable.createIndex` over the module-level one. `StoreTable`
  defines none, so wrapped store tables reach the fixed arm. No bypass.
- **The one unflushed teardown.** `createIndex`'s unwind tears the index store down without the
  `ddlCommitPendingOps()` flush that `dropIndex` and the `_uc_*` reconcile both take before
  their teardowns. Confirmed sound rather than assumed: `buildIndexEntries` writes through
  `indexStore.batch()` directly, outside the transaction coordinator, and nothing else can have
  queued ops against a store created moments earlier in the same statement — so there is
  nothing to replay into the closed store. Parked as a tripwire (below).
- **Unwind ordering and gating.** `progress`-gated steps, the "don't re-write the catalog if
  `saveTableDDL` is what threw" rule, and `markDdlSaved` staying set after a re-save of the old
  bundle — each re-derived and each correct as documented.
- **Source hygiene.** `store-module-index.ts` is 608 lines against sibling
  `store-module-alter.ts` at 697 — no split warranted. Functions are short and named for what
  they do; the comment density matches the file's existing (high, deliberate) style.
- **Accepted tradeoffs at the sites.** The reconcile's `NOTE:` declining a teardown-on-failure
  wrapper for `_uc_*` builds, and `store-module-alter.ts`'s durable-marker `NOTE:` for the
  row-rewriting arms. Both still stand; neither revisit condition has tripped, so neither was
  re-filed.
- **Docs.** Every doc touching `createIndex` / `dropIndex` module obligations was read:
  `docs/module-authoring.md`, `docs/schema.md`, `docs/invariants.md` (SCH-001),
  `docs/module-capabilities.md`, `docs/design-isolation-layer.md`. One gap found (below).

## Minor — fixed in this pass

- **Test gap: a `DROP INDEX` refused while the index realizes a plain UNIQUE.** While
  `uq_email` exists it realizes the plain UNIQUE on `email`, so no `_uc_email` store exists.
  The refused drop's cached-schema swap re-materializes `_uc_email` — a structure with no
  physical store — and enforcement by seek against an absent store reports no conflict. The
  unwind handles it correctly, but nothing covered it. Red-check with the drop unwind disabled:
  `insert into t values (3, 'a@x.com')` is **silently accepted** — the same silent-duplicate
  harm as the filed ALTER ticket, one arm away. Test added.
- **Test gap: `guardedUnwindStep`'s own contract.** No test covered "a cleanup step that throws
  is logged and swallowed, and the original error still reaches the caller" — the reason the
  helper exists. Test added, driving both the catalog write and the index-store delete to fail
  in one statement and asserting on the captured `console.warn`.
- **Doc gap: `docs/module-authoring.md` § DDL inside an open transaction** listed a module's
  obligations for DDL but never stated that the engine unwinds nothing on a refused call — the
  contract this whole ticket implements. A paragraph was added naming the three things that
  outlive a refused statement (physical structure, catalog entry, cached
  `VirtualTable.tableSchema`), pointing at `unwindFailedIndexDdl` as the reference
  implementation, and stating the log-and-swallow rule for cleanup failures.
- **Misleading unwind log label.** `guardedUnwindStep('restore the cached schema', …)` also
  covered the `_uc_*` rebuild, so a rebuild failure logged the wrong subject. Relabelled, with
  a comment on why the two are deliberately one step (the rebuild is only meaningful with the
  restored schema live).

## Major — none new

The one major finding in this area was already made and correctly filed by the implementer:
the `ALTER TABLE` arms share this defect and, for `add constraint unique`, silently accept a
duplicate row. `tickets/fix/5-alter-table-failure-leaves-half-applied-schema.md` — read in
full, verified accurate, and correctly scoped at the seam (one shared "adopt and persist,
undoing on failure" helper) rather than four copied try/catches, with the row-rewriting arms
explicitly excluded and pointed at the existing durable-marker `NOTE:`. Nothing to add.

No further major finding surfaced. The unwind is correct at every ordering and gating decision
I re-derived, and the residue snapshot is the right shape for the class.

## Tripwires — recorded, not filed

- **`createIndex`'s unwind teardown takes no coordinator flush**, sound only while
  `buildIndexEntries` writes outside the coordinator. `NOTE:` at the teardown site in
  `store-module-index.ts` says so and names the condition that would break it.
- **`snapshotResidue` compares entry counts, not values** — it would miss a refused statement
  that rewrote an existing entry's value in place outside the catalog. No arm has that shape
  today. `NOTE:` on the helper in `stream-index-build.spec.ts`.

## Considered and declined

- **Lifting `snapshotResidue` / `expectRefusedDdlLeavesNoResidue` to a shared test helper.**
  Still one consumer; the filed ALTER ticket already asks for the lift as part of becoming the
  second. Moving it now would be a speculative refactor.
- **Making `unwindFailedIndexDdl` / `guardedUnwindStep` `protected` so the ALTER arms can reach
  them.** That is the filed ticket's design decision to make — it may lift the helper somewhere
  else entirely. Widening visibility ahead of a consumer buys nothing.
- **`dropIndex`'s teardown-onward window staying uncovered**, and a provider whose
  `tearDownIndexStore` only *closes* rather than deletes leaving a reopenable orphan. Both are
  stated in the implement handoff as deliberate scope boundaries, both need the same
  durable-marker approach rather than a wider try/catch, and the second is already tracked as
  `bug-mobile-providers-delete-table-stores-only-closes`.
