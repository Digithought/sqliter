----
description: Fixed a memory-table bug where dropping a UNIQUE index/constraint inside an open transaction kept enforcing the (now-gone) constraint for the rest of that transaction.
files:
  - packages/quereus/src/vtab/memory/layer/transaction.ts   # adoptSchema — removal pass
  - packages/quereus/src/vtab/memory/layer/manager.ts        # dropIndex / dropConstraint — adoptSchemaOnOpenLayers
  - packages/quereus/test/logic/10.1.3-ddl-drop-in-transaction.sqllogic
  - packages/quereus/test/logic/10.1.3.1-ddl-drop-savepoint-memory.sqllogic
  - packages/quereus/test/logic.spec.ts                      # MEMORY_ONLY_FILES
  - docs/memory-table.md                                     # §"DDL and transactions"
----

# Complete: `DROP INDEX` / `DROP CONSTRAINT` inside a transaction now stops enforcing (memory)

## What the bug was

A memory `TransactionLayer` freezes its table schema at construction and enforces UNIQUE off that
frozen schema. `createIndex` / `addUniqueConstraint` already re-handed the new schema to open
layers (`adoptSchemaOnOpenLayers`), but the subtractive DDL paths (`dropIndex` / `dropConstraint`)
did not, and `TransactionLayer.adoptSchema` had only add/replace logic — no removal. So dropping a
unique index/constraint mid-transaction kept rejecting colliding rows against a constraint that no
longer existed.

## What the fix does

- `transaction.ts` `adoptSchema` — after the add/replace loop, a removal pass drops every held
  `MemoryIndex` whose name the new schema no longer declares (empty/undefined `indexes` drops all).
  Removed the `if (!newSchema.indexes) return;` early-out that would have skipped removal.
- `manager.ts` `dropIndex` — added `adoptSchemaOnOpenLayers(finalNewTableSchema)` after the schema
  swap (inside the try; catch still restores).
- `manager.ts` `dropConstraint` — added `adoptSchemaOnOpenLayers(newSchema)` after the swap; a
  no-op for CHECK/FK (they hold no per-layer index structure), necessary for UNIQUE.
- `docs/memory-table.md` — §"DDL and transactions" now documents removal and that it is not undone
  by ROLLBACK / ROLLBACK TO SAVEPOINT (DDL not transactional here; `feat-ddl-transaction-capability`).
- Tests: `10.1.3-ddl-drop-in-transaction.sqllogic` (cross-backend: drop index, drop constraint,
  sibling-index guard), `10.1.3.1-ddl-drop-savepoint-memory.sqllogic` (memory-only savepoint pin).

## Review findings

### Verified (checked, no defect)

- **Removal-loop safety (sharpest edge).** `adoptSchema`'s removal pass deletes any held index the
  new schema omits — so the concern is a caller handing it a schema that drops an index the layer
  must keep. Traced all six `adoptSchemaOnOpenLayers` callers: `createIndex` and
  `addUniqueConstraint` (both arms) only ever *add* an index; `alterColumn` calls it only on
  `collationChanged` (index names unchanged, objects rebuilt) and routes `set data type` through
  `convertColumnOnOpenLayers` instead; `dropIndex` / `dropConstraint(UNIQUE)` are the only paths
  that shrink the index set, which is exactly the intended removal. **No unsafe caller.**
- **CHECK / FK drop path.** `dropConstraint` now calls `adoptSchemaOnOpenLayers` for *all*
  constraint classes, not just UNIQUE — new behavior for CHECK/FK. Confirmed harmless: those arms
  spread `...this.tableSchema` (indexes identity-unchanged → add/replace and removal both no-op),
  and the memory layer enforces UNIQUE only (CHECK/FK are engine-side), so swapping the layer's
  frozen `checkConstraints`/`foreignKeys` changes nothing the layer consults. Full suite green
  corroborates no regression.
- **UNIQUE-constraint reuse of a user index.** Dropping a named UNIQUE that reused an existing
  user `unique` index leaves that index in `indexes` (`droppedIndexName` stays undefined), so the
  removal pass keeps it and the user index goes on enforcing its own uniqueness — correct.
- **Case-sensitivity of removal.** Removal keys on exact `IndexSchema.name`, the same source the
  `secondaryIndexes` Map was built from — consistent within a layer chain.
- **Docs.** `docs/memory-table.md` §"DDL and transactions" reflects the new reality; the old
  "One carve-out remains…" paragraph is gone. No other doc referenced the retired carve-out.
- **Validation.** Memory `yarn workspace @quereus/quereus run test` → 6918 passing, 0 failing.
  `lint` → exit 0. Store (`--store --grep 10.1.3`) → cross-backend file passes, memory-only file
  skipped (registered in `MEMORY_ONLY_FILES`).

### Major (new ticket filed)

- **Store silently loses an INSERT after `rollback to savepoint` that dropped an index.**
  Independently reproduced on the store backend: `savepoint s; drop index; rollback to s; insert
  (dup)` returns success with no error, but the row is absent even mid-transaction — silent data
  loss. Store-specific (memory keeps the row); the cross-backend enforcement cases (1–3) pass on
  store. It sits in the deferred transactional-DDL area, so filed to
  `backlog/bug-store-savepoint-ddl-drop-lost-insert.md` rather than promoted to `fix/` — a clean
  fix needs the `feat-ddl-transaction-capability` decision on whether savepoint rollback undoes
  DDL. Not a tripwire: it is a confirmed reproducible defect.

### Tripwire (parked in code/docs, no ticket)

- **Memory DDL-not-transactional divergence.** After `rollback to savepoint`, memory does not
  restore a dropped index, so a post-rollback duplicate insert is accepted where strict SQL would
  reject. Same divergence already accepted for the additive side; it can never *manufacture* a
  UNIQUE violation (no constraint left to violate). Parked in the `adoptSchema` doc-comment,
  `docs/memory-table.md`, and pinned by `10.1.3.1-ddl-drop-savepoint-memory.sqllogic`. Deferred to
  `feat-ddl-transaction-capability`.
- **`rebuildAllSecondaryIndexes` breadth (pre-existing).** `alterColumn`'s NOT-NULL / collation
  paths rebuild every secondary index, not only those covering the altered column; already carries
  a `NOTE:` at the site flagging it if it ever shows as slow. Not touched by this change.

### Minor coverage observations (no action)

- No dedicated test for CHECK/FK-constraint drop *inside a transaction* (the new
  `adoptSchemaOnOpenLayers` call on those arms). Reasoned harmless above and covered indirectly by
  the passing constraint suites; a targeted no-regression test would be nice-to-have, not required.
- The optional `test/plan/` assertion (dropped index no longer *planned* within the transaction)
  was skipped per the implement ticket. The functional cases already prove the index is neither
  enforced (case 1) nor scanned incorrectly (case 3's sibling still resolves), so the plan-level
  check is redundant for correctness.

## Result

Memory fix is correct and well-covered. Lint + full memory suite green; store cross-backend green.
One major store defect surfaced and filed to backlog. No inline fixes were needed — the
implementation held up under review.
