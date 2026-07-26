---
description: Dropping a column from a table with a foreign key used to break the table — the next insert either crashed or started checking the wrong column against the parent. Now the surviving keys renumber and any key that lost a column is removed.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts                        # dropColumn — FK partition/shift added (~2040), old BUG comment removed
  - packages/quereus-store/src/common/store-module.ts                        # alterDropColumn — same partition/shift (~1750)
  - packages/quereus/test/logic/41.10-alter-drop-column-foreign-key.sqllogic # NEW — 6 cases, runs under both modules
  - packages/quereus-store/test/drop-column-foreign-key-reopen.spec.ts       # NEW — persist→reopen round-trip (2 cases)
  - docs/sql-ddl.md                                                          # DROP COLUMN section (~583)
difficulty: medium
---

# DROP COLUMN now renumbers (and prunes) the table's own foreign keys

## What was wrong

A foreign key records which of **its own** table's columns it constrains by *position*
(`foreignKeys[].columns` holds indices into that table's column list). `DROP COLUMN` already
renumbered the primary key, the secondary indexes and the UNIQUE constraints when a column
disappeared from before them — but never the foreign keys. Two failure modes:

- Drop a column *before* an FK child column → the recorded index dangled past the end of the
  column array → next enforced write threw a raw `TypeError: Cannot read properties of
  undefined (reading 'name')`.
- Drop the FK's *own* child column → the key stayed put and its index silently slid onto
  whatever column took that slot, so the table began enforcing a foreign key against a column
  never declared to have one. No error at `alter` time. This was the worse of the two.

## What changed

Both modules now partition the table's own `foreignKeys` on the dropped column:

- A key that uses the dropped column as **any** of its child columns is **removed outright** —
  single-column and multi-column alike. Rationale (same call the UNIQUE path already made): a
  key missing one of its child columns is a *different* constraint against the parent's key,
  not a narrowed one.
- Every other key **survives with its child positions shifted** down over the removed slot.
- When no key survives, the field goes back to `undefined` — the shape `dropConstraint`
  already produces.

`referencedColumns` is untouched in both: enforcement resolves parent indices by name from
`referencedColumnNames` at write time.

This is a deliberate divergence from SQLite (which refuses the drop). It matches what the
engine already does for UNIQUE and keeps the `ADD COLUMN` revert path — which drops the
just-added column unconditionally — working.

## Why the store half mattered more than it looks

`generateTableDDL` serializes an FK child column by resolving the recorded **index back to a
name**. So on the store module an unshifted index wasn't merely a live-schema bug: it got
**persisted as the wrong column name**, and a reopen faithfully restored the corruption. The
new reopen spec is what pins that; the sqllogic harness has no reconnect primitive.

## Validation performed

All green, zero failing:

| Command | Result |
|---|---|
| `yarn build` | clean |
| `yarn test` | 7329 + 1051 + others passing, **0 failing** |
| `yarn test:store` | 7323 passing, 19 pending, **0 failing** |
| `yarn typecheck` | 0 errors |
| `yarn lint` | clean |

**The fix is demonstrated, not just asserted.** Before the rebuild, `yarn test:store` failed on
the new sqllogic file with the exact production symptom —
`Table-valued function foreign_key_info failed: Cannot read properties of undefined (reading
'name')` — and passed once the corrected store module was built. Ticket cases A/B/C/D/E all
reproduce as described.

### New coverage

`41.10-alter-drop-column-foreign-key.sqllogic` (runs under **both** modules), 6 cases:
shift-and-still-enforce; drop-the-only-child-column removes the key and leaves the next column
unconstrained (the silent-corruption repro — `insert into FkGone values (11, 'r')` was rejected
before); multi-column key removed in full; control case (unrelated column dropped, key still
enforces); two keys where one is removed and the other shifts in the same statement; and
`on delete cascade` still firing after a preceding drop.

`drop-column-foreign-key-reopen.spec.ts`: persist → close → fresh `Database` + module over the
same provider → `rehydrateCatalog`, asserting both the shifted position and the removed key
across the reconnect, plus behavioral enforcement after it.

## Reviewer: treat these as the floor, not the finish line

Known gaps, in rough priority order:

- **Named foreign keys are untested.** Every FK in the new tests is auto-named. A key declared
  `constraint fk_x foreign key (...)` should behave identically (the partition never reads
  `name`), but nothing pins it.
- **`on update` actions and deferred FKs are untested** after a drop. Only `on delete cascade`
  is covered.
- **The sqllogic error assertions match the auto-generated constraint name** (e.g.
  `_fk_fkshift_fkcol`). Deliberate — the name proves *which* column is being enforced, which a
  generic `-- error: foreign key` would not. Tradeoff: renaming the `_fk_<table>_<cols>`
  convention breaks these tests. Worth a second opinion on whether that's the right trade.
- **Forward FK enforcement surfaces as `CHECK constraint failed: _fk_…`**, not as a
  foreign-key-worded error. Pre-existing and unrelated to this ticket, but it surprised me
  while writing the tests and may deserve its own ticket.
- **Parent-side foreign keys were out of scope per the ticket** (another table pointing *at*
  the dropped column) and remain untested here. That path resolves parent columns by name at
  enforcement time, so it is a genuinely separate problem.
- **Self-referential foreign keys after a drop** are not covered. The child-side shift should
  handle them since parent columns resolve by name, but it is unverified.

## Verified claims from the original ticket

- Nothing else in either module caches an FK child-column index across the drop. Every other FK
  site in both (`dropConstraint`, `renameConstraint`, `addForeignKeyConstraint`,
  `retargetSelfForeignKeys`, `renameColumnInSelfForeignKeys`) is name-keyed or append-only.
- The isolation module needs no change — checked directly at
  `packages/quereus-isolation/src/isolation-module.ts:1426`, which forwards to
  `underlying.alterTable` and takes its returned schema verbatim, doing no index arithmetic.
- `runDropColumn` in `runtime/emit/alter-table.ts` needed no change; it passes the module's
  `foreignKeys` through untouched.

## Tripwires parked

None. The pre-existing `NOTE:` in the memory module's `dropColumn` about unshifted
generated-column bookkeeping (`generatedColumnDependencies` / `generatedColumnTopoOrder`) was
**left in place** — the engine recomputes that graph from column names immediately after the
call (`withGeneratedColumnGraph`), so only a caller driving the module API directly sees the
stale map. That was already documented and is out of scope here.
