----
description: Changing a text column's sort/compare rule inside a transaction now checks the rows that transaction just wrote, and the new rule governs the rest of the transaction and survives commit — previously duplicates slipped through and the change was silently discarded.
files:
  - packages/quereus/src/schema/unique-enforcement.ts            # exported `indexEnforcesUnique`
  - packages/quereus/src/vtab/memory/layer/manager.ts            # alterColumn, validateRekeyedUniqueStructures, adoptSchemaOnOpenLayers
  - packages/quereus/src/vtab/memory/layer/base.ts               # rebuildAllSecondaryIndexes doc; strict paths deleted
  - packages/quereus/src/vtab/memory/layer/transaction.ts        # adoptSchema now replaces, not just adds
  - packages/quereus/src/vtab/memory/index.ts                    # stale doc reference
  - packages/quereus/test/ddl-in-transaction-validation.spec.ts  # 15 cases
  - docs/memory-table.md                                         # § DDL and transactions
----

# `alter column … set collate` sees, and then governs, the issuing transaction's rows

## What shipped

The memory backend keeps committed rows in a **base layer** and each open transaction's
uncommitted writes in a **transaction layer** stacked on top. `alter table … alter column …
set collate` used to rebuild only the base layer's structures, which meant: a duplicate living
only in the transaction's pending rows was accepted; a row the transaction had deleted still
blocked a legal change; the accepted change never reached the open transaction; and at commit
the pending layer became the committed head carrying its old-collation schema and index trees,
silently discarding the change.

Two parts:

**Validate over effective rows, then rebuild non-enforcing.** `MemoryTableManager.alterColumn`
calls a new `validateRekeyedUniqueStructures()` before any mutation, once per index of the new
schema that mentions the altered column and enforces uniqueness. It reuses the sibling fix's
`validateUniqueOverEffectiveRows()` — a throwaway collation-aware `MemoryIndex` populated from
`effectiveDdlRows()`, the layer a `select` in the same transaction would scan. The base rebuild
then became non-enforcing (`rebuildAllSecondaryIndexes()`), because base rows are not a subset of
effective rows. `BaseLayer.rebuildAllSecondaryIndexesStrict` and `BaseLayer.populateNewIndex` were
deleted; `indexEnforcesUnique` was lifted to `src/schema/unique-enforcement.ts`.

**Re-key the open transaction's layers.** `alterColumn` calls `adoptSchemaOnOpenLayers()` on a
collation change, and `TransactionLayer.adoptSchema` learned to *replace* an index, not merely add
missing ones, discriminating on `IndexSchema` object identity. A collation change on a primary-key
column is explicitly carved out and remains broken inside a transaction — owned by
`alter-collate-pk-in-transaction`.

## Review findings

### Checked and clean

- **Read the implement diff before the handoff.** Traced `alterColumn` → `validateRekeyedUniqueStructures`
  → `validateUniqueOverEffectiveRows` → `populateIndexFromRows`, and `adoptSchemaOnOpenLayers` →
  `adoptSchema` → `reindexOwnWrites`.
- **Chain-walk ordering.** `adoptSchemaOnOpenLayers` walks oldest-first, so each layer's replacement
  `MemoryIndex` is built over a parent tree that has already been re-keyed. Verified the committed-
  but-not-yet-collapsed layer that can sit in the chain: `reindexOwnWrites` removes the parent's
  entry and re-adds the layer's own effective row under the new key, which for an already-drained
  layer is a no-op. Correct.
- **`reindexOwnWrites` cannot throw.** It calls `addEntry`, never the enforcing path. A savepoint
  snapshot whose own rows collide under the new collation therefore cannot make `adoptSchema` throw
  after the base has been mutated — which would have left the layer chain half-adopted. This is the
  quiet reason the ordering in `alterColumn` (validate, mutate, adopt) is safe.
- **The materialized-view worry raised in the handoff is not a bug.** `findIndexForConstraint`
  prefers a row-time covering MV over the auto-index, but a source-table `alter column` emits a
  `table_modified` event that either marks the dependent MV stale or forces a content-stability-gated
  recompile; `findRowTimeCoveringStructure` declines a stale MV, and `lookupCoveringConflicts`
  re-compares every candidate under the source column's *declared* (post-ALTER) collation, falling
  back to a full scan for any non-BINARY collation. Enforcement stays exact either way, and the
  auto-index that validation walks always exists alongside. No ticket filed.
- **The `catch` rollback path.** Confirmed the handoff's reading: `rebuildPrimaryTreeStrict()` can
  still throw after the secondaries are re-keyed, so the unconditional restore is still needed.
- **The PK carve-out.** `pkColumnRekeyed` suppresses `adoptSchemaOnOpenLayers`; outside a transaction
  there are no open layers so it is a no-op, and `test/logic/41.7.x` sqllogic files pass unchanged.
- **Lint** (`eslint` + `tsc -p tsconfig.test.json --noEmit`) clean. **Tests**: `yarn test` green across
  all workspaces; `packages/quereus` 6751 passing, 0 failing (6749 before, +2 added below). No
  pre-existing failures surfaced, so `tickets/.pre-existing-error.md` was not written.

### Major — filed as tickets

- **`tickets/backlog/bug-rolled-back-rows-violate-surviving-ddl.md`.** Row-validating DDL is
  validated against the issuing transaction's *view*, but the DDL is not undone when that view is
  discarded. Reproduced two ways: (a) `create unique index` after a pending `delete` of the
  duplicate, then `rollback to savepoint` — the table commits holding two `'a'` under a UNIQUE
  index; (b) this ticket's `set collate nocase` after a pending `delete`, then `rollback` — the
  column stays NOCASE, the index stays keyed NOCASE, and the deleted `'A'` comes back beside `'a'`.
  Case (b) is a behavior change from this diff (the old strict base rebuild would have refused the
  ALTER), but the old behavior was also wrong — it blocked the legal committing case, which is
  exactly the bug this ticket fixed. Root cause is shared with the open
  `feat-ddl-transaction-capability` question, so the ticket lays out the three ways it could be
  resolved rather than prescribing one. Not fixable inline.

- **`tickets/backlog/bug-alter-column-set-data-type-leaves-old-values.md`.** The handoff flagged
  "`setDataType` does not rebuild secondary indexes" as a suspected pre-existing defect. Probing it
  turned up something larger and simpler: `alter column … set data type integer` does not convert
  the stored values at all, in plain autocommit. After the ALTER the old text values match neither
  `v = 9` nor `v = '9'`, so those rows are unreachable by any predicate on the column while still
  counting in `count(*)`. The missing index rebuild is recorded there as a second thing the fix must
  handle. Distinct from `bug-alter-column-changes-ignore-open-transaction`, which is about the same
  statement's blindness to an open transaction's rows.

### Minor — fixed in this pass

- **Two coverage gaps closed** in `test/ddl-in-transaction-validation.spec.ts` (both pass):
  - *a table with no secondary indexes at all* — exercises `adoptSchema`'s early return, where the
    schema swap alone is what makes the rest of the transaction and the committed head compare under
    the new collation. Nothing covered this path.
  - *an index that does not mention the altered column* — the diff's claim that **every** index must
    be replaced (because `rebuildAllSecondaryIndexes` hands every one a fresh tree) had no test. The
    new case asserts an unrelated unique index still enforces and still resolves, inside the
    transaction and after commit.
- **Docs.** `docs/memory-table.md` § DDL and transactions gained a short paragraph stating that rule 1
  assumes the transaction commits, and pointing at the new rollback ticket. The rest of the section
  was re-read against the code and is accurate.

### Tripwires — parked, not ticketed

- `manager.ts`, `alterColumn`'s `catch`: a `NOTE:` recording that a validation rejection mutates
  nothing yet still pays an O(rows) rebuild that swaps the base's index trees for fresh,
  content-identical ones. Harmless today (a pending layer keeps reading its orphaned but correct
  copy-on-write base); if a rejected ALTER on a large table ever shows up as slow, gate the rebuild
  on a "mutation started" flag.
- `manager.ts`, `validateRekeyedUniqueStructures`: the pre-existing `NOTE:` about the probe index
  carrying the *pre-change* `primaryKeyFunctions` was re-checked and is sound — duplicate detection
  fires on the index key before any primary key is stored.

### Deliberately unchanged

- A primary-key column's collation change inside a transaction is still broken. The guard is in
  place, no test covers it, and it is `alter-collate-pk-in-transaction`'s scope.
- No sqllogic coverage was added for the transactional cases: `test/logic/41.7.x` runs in store mode
  too, where it would fail until `isolation-ddl-validation-ignores-overlay-rows` lands. Memory-only
  spec coverage is the right home for now, as the implementer chose.
