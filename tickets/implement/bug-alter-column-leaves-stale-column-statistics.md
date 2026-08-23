---
description: After renaming a column and then adding a new column that reuses the freed name, the new (empty) column inherits the old column's saved measurements, so the query planner sizes it wrongly — and that survives closing and reopening the database.
files:
  - packages/quereus/src/schema/schema.ts                     # Schema.addTable — the single seam every table registration passes through; where the invariant goes
  - packages/quereus/src/schema/table.ts                      # TableSchema.statistics + buildColumnIndexMap; natural home for the prune helper
  - packages/quereus/src/planner/stats/catalog-stats.ts       # TableStatistics / ColumnStatistics types; columnStats keyed by LOWERCASE column name
  - packages/quereus/src/planner/stats/analyze.ts             # ANALYZE builds columnStats, keys lowercased (line ~94)
  - packages/quereus/src/runtime/emit/alter-table.ts          # runRenameColumn (~line 368) — Phase 2 re-key site
  - packages/quereus-store/src/common/store-module-alter.ts   # store's add/drop/rename arms — they build from table.getSchema(), which carries statistics
  - packages/quereus-store/src/common/store-table-base.ts     # publishPersistedStatistics (~line 638) — stamps the disk snapshot back via schema.addTable
  - packages/quereus/src/vtab/memory/module.ts                # alterTable returns manager.tableSchema (~line 1240), which never carries statistics
repro: verified
difficulty: medium
---

# ALTER TABLE on a column never prunes the table's column statistics

## What was actually observed

The original bug report inferred this from reading the code and assumed all backends carry the
measurements across unchanged. Running it shows the two backends behave *differently*, and only
one of them is dangerous.

Setup used for both runs: `create table t (id integer primary key, k integer null, v integer
null)`, 50 rows with `k = i % 7`, then `analyze`.

**Store-backed (`using store`) — the defect, confirmed.**

| step | table columns | statistics keys | entry under `k` |
|---|---|---|---|
| after `analyze` | id, k, v | id, k, v | distinct 7, nulls 0, min 0, max 6 |
| after `rename column k to k2` | id, k2, v | id, k, v | unchanged |
| after `add column k integer null` | id, k2, v, k | id, k, v | unchanged |
| after close + reopen | id, k2, v, k | id, k, v | distinct 7, nulls 0, min 0, max 6 |

The brand-new, entirely-NULL column `k` is credited with 7 distinct values, zero NULLs and a
range of 0–6. A predicate `where k = 3` is then estimated at roughly 50/7 ≈ 7 rows when the true
answer is 0. The renamed column `k2` has no entry at all, so it falls back to the default guess —
the measurements were not moved, only stranded.

The last row is the part that matters most: the mis-attribution is written to disk and re-stamped
onto the fresh schema on reopen (the histogram does not survive serialization, but distinct count,
null count, min and max do). Nothing but a fresh `ANALYZE` clears it.

**Memory-backed (default module) — no mis-attribution, but a different surprise.**

Every column-level ALTER form (`rename column`, `drop column`, `alter column`) leaves the table
with *no statistics at all* — `TableSchema.statistics` becomes `undefined`. `alter table … rename
to` (whole-table rename) keeps them. So on the memory backend a single ALTER silently throws away
the last `ANALYZE`, and the user has to re-run it.

That is fail-safe rather than wrong, so it is not the bug being fixed here — but it is worth
knowing, and it means a test written only against the memory backend passes vacuously.

## Why the two differ

Both backends' ALTER arms return a schema they build themselves, and the engine installs that
return value into the catalog verbatim:

- The **store** module builds from `table.getSchema()`, which does carry `statistics`, and copies
  every field it does not explicitly override — so the measurement map rides along by reference,
  still keyed by the pre-ALTER column names.
- The **memory** module returns `manager.tableSchema`, the manager's own cached copy, which the
  `ANALYZE` stamp never touched — so the measurements simply are not in the returned object.

Six module-side builders (three forms × two backends), plus the engine's own no-module rename
fallback, each decide this independently, and a seventh will do the same the day someone adds
another ALTER form. Patching them one at a time is the wrong shape.

## The fix: one invariant at the install seam

Every table-schema registration in the engine goes through `Schema.addTable`
(`packages/quereus/src/schema/schema.ts`) — the module ALTER results, the store's reopen-time
stamp in `publishPersistedStatistics`, `ANALYZE`'s own write, everything. That is the one place to
enforce:

> A registered table schema's `statistics.columnStats` names only columns that exist in that same
> schema.

The invariant is *self-contained* — it needs no comparison against the previous schema — and it
covers all three reported consequences:

- rename `k` → `k2`: the `k` entry no longer names a live column, so it is dropped, and a later
  `add column k` finds nothing to inherit;
- drop column: the dropped column's entry no longer names a live column, so it is dropped;
- add column: a new name was never in the map, so there is nothing to inherit once the two above
  hold.

`statistics.rowCount` is unaffected — no column-level ALTER changes the row count, so it stays
valid.

`columnStats` keys and `columnIndexMap` keys are both lowercased (`analyze.ts` line ~94,
`buildColumnIndexMap` in `table.ts` line ~337), so membership is a direct `columnIndexMap.has(key)`
test with no re-normalization.

Make the helper return the *same object* when nothing needs pruning — the overwhelmingly common
case (no statistics at all, or all keys live) — so `addTable` stays a map write on every ordinary
`create table`, and the only object replacement happens exactly when the input was wrong. Nothing
in the engine compares table schemas by reference identity (checked), so replacing the object on
the prune path is safe.

The stale bytes stay on disk in the store's `__stats__` record; that is fine once the stamp is
pruned on the way in, and the next `ANALYZE` rewrites the record wholesale. Do not add a
disk-rewrite pass for it.

## Second arm (recommended, same root cause): let a rename keep its measurements

Pruning alone makes `rename column k to k2` *lose* the measurements rather than misplace them. The
engine already knows both names at one site — `runRenameColumn` in `alter-table.ts` — and can
re-key there, using the **pre-ALTER catalog schema's** `statistics` rather than the module's return
value. Sourcing it from the pre-ALTER schema is what makes this work on both backends at once: it
repairs the store's stranded entry and, at the same time, stops the memory backend losing its
measurements on a rename.

Only rename gets this treatment in this ticket. Do **not** generalize the carry to `alter column …
set data type`: a type change rewrites values, so the old min/max and histogram would describe
values the column no longer holds — dropping them there is correct.

## Guard

A property-style assertion, not three one-off cases: for each column-level ALTER form, assert that
every key in the resulting `statistics.columnStats` names a column in the resulting schema. One
assertion covers today's forms and any future one.

It has to run store-backed to mean anything — on the memory backend the statistics are absent after
an ALTER, so the assertion passes without exercising anything.
`packages/quereus-store/test/add-column-inline-constraint-reopen.spec.ts` has the
in-memory-provider + reopen harness to copy (its `createInMemoryProvider`, then
`mod.whenCatalogPersisted()`, then a fresh `Database` + `mod.rehydrateCatalog(db)`).

## Related, deliberately not merged

`bug-drop-table-leaves-stale-stats-entry` is the same *family* — a statistics record outliving what
it described — but a different site (the store's `tearDownTableStorage` never deletes the
whole-table `__stats__` entry). Keep them separate.

## TODO

**Phase 1 — the invariant**

- Add a prune helper next to `TableSchema` in `packages/quereus/src/schema/table.ts` that takes a
  `TableSchema` and returns one whose `statistics.columnStats` is restricted to keys present in
  `columnIndexMap`. Return the input object unchanged when no key is stale, and when `statistics`
  is absent or its map is empty.
- Call it from `Schema.addTable` in `packages/quereus/src/schema/schema.ts`, before the map write.
  Log at debug when it actually prunes something, naming the table and the dropped keys — a silent
  prune makes a future "where did my statistics go" question unanswerable.
- Add a unit spec in `packages/quereus/test/` covering the helper and the `addTable` seam directly:
  a schema whose statistics name a column it does not have comes back out of `getTable` with those
  entries gone; a schema whose statistics are all live comes back as the identical object.

**Phase 2 — rename keeps its measurements**

- In `runRenameColumn` (`packages/quereus/src/runtime/emit/alter-table.ts`), between the
  `module.alterTable` call and `schema.addTable(updatedTableSchema)`, build the installed schema's
  `statistics` from the **pre-ALTER** `tableSchema.statistics`, moving the entry under the old
  (lowercased) name to the new one and leaving every other entry as it is. Absent statistics stay
  absent. Order matters: this must happen before `addTable`, or Phase 1 prunes the entry being
  moved.
- Leave `runAddColumn`, `runDropColumn` and `runAlterColumn` alone — Phase 1 already makes them
  correct, and a type change must not carry min/max forward.

**Phase 3 — the guard and the note**

- New spec in `packages/quereus-store/test/` (store-backed, using the reopen harness named above).
  Two parts:
  - the property: for each of `rename column`, `add column`, `drop column`, every key in the
    resulting `statistics.columnStats` names a column in the resulting schema;
  - the original scenario end to end: analyze → rename `k` to `k2` → `add column k` → close →
    reopen → the new `k` has no statistics entry, and (Phase 2) `k2` carries the numbers `k` was
    measured with.
- Add a `NOTE:` comment where the memory module's `alterTable` returns `manager.tableSchema`
  (`packages/quereus/src/vtab/memory/module.ts`, ~line 1240) recording that a column-level ALTER
  drops the table's statistics on this backend while the store backend keeps them (minus the pruned
  entries), so the two backends need a re-`ANALYZE` at different times; revisit if that difference
  ever shows up as a plan discrepancy between backends.
- Check whether `docs/optimizer.md` (or whichever doc describes statistics collection) states what
  happens to statistics across DDL; if it does, bring it in line, and if it says nothing, add the
  one-line rule — statistics only ever describe columns the table currently has.

**Validation**

- `yarn test` from the repo root, and `yarn workspace @quereus/quereus-store test` (or
  `yarn test:store`) for the store-backed guard.
- `yarn lint` in `packages/quereus`.
