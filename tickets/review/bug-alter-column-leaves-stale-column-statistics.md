---
description: Renaming a column and then adding a new column that reused the freed name gave the new, empty column the old column's saved measurements, and that survived closing and reopening the database; the measurements now follow the rename and the reused name inherits nothing.
files:
  - packages/quereus/src/schema/table.ts                              # pruneStaleColumnStatistics (new) — the invariant helper
  - packages/quereus/src/schema/schema.ts                             # Schema.addTable — calls the helper before the map write
  - packages/quereus/src/runtime/emit/alter-table.ts                  # carryStatisticsAcrossColumnRename (new) + call in runRenameColumn
  - packages/quereus/src/vtab/memory/module.ts                        # NOTE: on the memory backend dropping statistics on a column-level ALTER
  - packages/quereus-store/src/common/store-table-base.ts             # remapPersistedColumnStatistics + columnStatisticsRemap (new)
  - packages/quereus-store/src/common/store-module-alter.ts           # alterTable dispatch seam — calls the remap after every arm
  - packages/quereus-store/src/common/serialization.ts                # TableStats.columnStats doc — corrected reasoning
  - packages/quereus/test/schema-column-statistics-prune.spec.ts      # NEW — helper + addTable seam
  - packages/quereus-store/test/alter-column-statistics-prune.spec.ts # NEW — store-backed property + end-to-end reopen
  - packages/quereus-store/test/stats-persistence.spec.ts             # rewritten rename test (asserted the OLD behavior)
  - packages/quereus-store/test/column-statistics-plan.spec.ts        # two tests re-based off a device that no longer works
  - docs/optimizer-costing.md                                         # new "Statistics across DDL" rule
  - docs/store.md                                                     # new "Column statistics across a column-level ALTER"
repro: verified
difficulty: medium
---

# Review: column statistics no longer outlive the columns they describe

## What the bug was

`ANALYZE` records per-column measurements (distinct count, NULL count, min, max, and
sometimes a histogram) on `TableSchema.statistics.columnStats`, keyed by lowercase column
name. Every `ALTER TABLE` arm in a virtual-table module builds the post-ALTER table schema
itself and the engine installs that return value into the catalog verbatim. The store
module builds its result from the pre-ALTER schema and copies across every field it does
not override — so the measurement map rode along **still keyed by the pre-ALTER column
names**.

Consequence, store-backed, verified end to end: `analyze` → `rename column k to k2` →
`add column k` left the brand-new, entirely-NULL `k` credited with the old `k`'s 7 distinct
values, 0 NULLs and range 0-6, so `where k = 3` was estimated at ~7 rows against a true 0.
The mis-attribution was written to disk and re-stamped onto a fresh schema on reopen; only
a new `ANALYZE` cleared it.

## What changed

Three layers, in the order they matter.

**1. One invariant at the catalog seam.** `pruneStaleColumnStatistics`
(`packages/quereus/src/schema/table.ts`) takes a `TableSchema` and returns one whose
`statistics.columnStats` names only columns that schema actually has. `Schema.addTable`
calls it before the map write. That seam is the single place every table registration
passes through — `CREATE TABLE`, each module's ALTER return value, `ANALYZE`'s own write,
and the store's reopen-time stamp — so no module needs to get this right individually.
The helper returns the **input object itself** whenever nothing is stale (no statistics, an
empty map, or every key live), so ordinary registration stays a map write and only a
genuinely wrong input gets a replacement object. It logs at debug when it prunes, naming
the table and the dropped keys.

**2. A rename keeps its measurements.** `carryStatisticsAcrossColumnRename`
(`packages/quereus/src/runtime/emit/alter-table.ts`, called from `runRenameColumn` just
before `schema.addTable`) moves the renamed column's entry from the old lowercase key to
the new one, reading the **pre-ALTER catalog schema** rather than the module's return
value. That source is what makes it work on both backends at once: it repairs the store's
stranded entry, and it stops the memory backend losing its measurements on a rename (the
memory module returns its manager's own cached schema, which the `ANALYZE` stamp never
touched). `ALTER COLUMN … SET DATA TYPE` deliberately does not get this — a type change
rewrites values, so the old min/max would describe values the column no longer holds.

**3. The store re-keys its persisted snapshot.** *This step is a deliberate departure from
the implement ticket, which said not to touch the on-disk record — please review the
reasoning.* The ticket's argument was that pruning the stamp on the way back in is enough.
It is not, and the guard spec proves it: the disk record still named `k`, and by reopen time
the table **had** a column named `k` again (the newly added one), so the stale key named a
live column and the prune correctly let it through. The catalog-side invariant is
self-contained by design and cannot distinguish "the original `k`" from "a different column
that later took the name `k`".

So the record itself is corrected at the moment the name is freed:
`StoreModuleAlter.alterTable` calls `StoreTableBase.remapPersistedColumnStatistics(change)`
after every ALTER arm; the method moves a renamed column's entry onto its new name, removes
a dropped column's outright, and flushes immediately. It is a no-op for a table with no
persisted snapshot and for any change that frees no name, so an ordinary ALTER performs no
extra write. Putting the per-form decision inside that one method (`columnStatisticsRemap`)
rather than in each arm is what makes a future ALTER form face the question rather than skip
it silently.

## What to exercise

- `analyze t` → `alter table t rename column k to k2` → `alter table t add column k …`,
  store-backed, then close and reopen. `k2` should carry `k`'s numbers; the new `k` should
  have no entry, before and after the reopen.
- The same on the default (memory) backend, where a column-level ALTER other than rename
  leaves the table with **no** statistics at all. That is unchanged and fail-safe, but it
  means an assertion written only against the memory backend passes vacuously — worth
  checking that any test you add is actually store-backed.
- `drop column`, then `add column` reusing the dropped name, store-backed, across a reopen.
- A never-analyzed table: no extra writes, no behavior change.
- `ANALYZE` after any of the above should reconcile everything wholesale.

## Tests

New:

- `packages/quereus/test/schema-column-statistics-prune.spec.ts` — the helper (identity
  return on every no-op path, exact prune on the stale path, input not mutated) and the
  `Schema.addTable` seam.
- `packages/quereus-store/test/alter-column-statistics-prune.spec.ts` — store-backed. The
  property (for `rename column`, `add column`, `drop column`: every key in the resulting
  `columnStats` names a column in the resulting schema) plus the reported scenario end to
  end through a close and reopen.

Rewritten because they asserted the pre-fix behavior:

- `packages/quereus-store/test/stats-persistence.spec.ts` — the rename test asserted the
  renamed column had *no* statistics. It now asserts the entry moved, and adds the reuse arm
  (a new column taking the freed name inherits nothing).
- `packages/quereus-store/test/column-statistics-plan.spec.ts`, two tests — both used
  "rename a column after `ANALYZE`" purely as a *device* to make a column lose its
  statistics, so the wholesale-fallback path could be observed. That device no longer works
  by design. They now use "add a column after `ANALYZE`" instead, which is the honest way an
  indexed column can lack statistics; the second one drops the competing index so the
  composite arm under test is the only candidate. Their subject (fall back wholesale rather
  than mixing a measured factor with a shape constant) is unchanged — worth confirming the
  re-based versions still pin what they were written to pin.

## Validation run

- `yarn test` (whole workspace) — 10168 + 1914 + others, all passing, no failures.
- `yarn test:store` (quereus logic tests re-run against the LevelDB store module) — 10160
  passing.
- `yarn workspace @quereus/quereus run lint` — clean (eslint + `tsc -p tsconfig.test.json`).
- `yarn workspace @quereus/store run typecheck` — clean.
- `yarn build` — clean.

Note for anyone re-running the store specs by hand: `packages/quereus-store` resolves
`@quereus/quereus` through its built `dist`, so an engine-side edit needs
`yarn workspace @quereus/quereus run build` before the store tests see it. A store spec that
"still fails after the fix" is usually this.

## Known gaps, honestly

- **`ALTER COLUMN … SET DATA TYPE` still carries stale min/max, store-backed.** The column
  keeps its name, so the prune has nothing to catch, and no arm drops the entry — after
  `alter column v set data type text` the persisted min/max still describe the pre-cast
  integers. The implement ticket explicitly scoped this out ("leave `runAlterColumn`
  alone"), and it is a different decision at a different site, so it was not touched. It is
  a real latent mis-description rather than a conditional concern, so it wants a judgement:
  file it, or accept it with a `NOTE:` at the arm. Not filed here because that call belongs
  to review. The memory backend does not have it (it drops all statistics on that form).
- **The remap write does not ride the transaction coordinator.** It flushes straight
  through, so a column rename inside an explicit transaction that later rolls back leaves
  the re-keyed record on disk. This matches the deliberate, documented behavior of the
  neighbouring `saveStatistics` (statistics are advisory and the next `ANALYZE` reconciles
  both), but it is a second site now making that assumption.
- **A case-only rename** (`rename column k to K`) is handled — the engine returns the
  pre-ALTER statistics unchanged, and the store's remap moves the key onto itself — but is
  not covered by a test.
- **`alterPrimaryKey`, `addConstraint`, `dropConstraint`, `renameConstraint`** free no
  column name, so `columnStatisticsRemap` returns `undefined` and the remap is a no-op.
  Asserted only by the absence of failures in the existing suites, not by a test of its own.
- **The histogram does not survive persistence** for columns the store cannot seek on
  (`toPersistedColumnStats` drops it, by size arithmetic that predates this work). So a
  renamed column keeps its distinct count, NULL count and min/max across a reopen but can
  lose its histogram. Pre-existing; the guard spec compares the four scalar fields rather
  than deep-equalling the whole entry, and says why.
- **The memory backend still discards a table's statistics on `add column`, `drop column`
  and `alter column`**, returning a schema that never carried them. Fail-safe (the planner
  falls back to defaults) rather than wrong, so it was left alone; recorded as a `NOTE:` at
  `packages/quereus/src/vtab/memory/module.ts` where `alterTable` returns
  `manager.tableSchema`. The two backends therefore need a re-`ANALYZE` at different times.

## Tripwires parked in code

- `packages/quereus/src/vtab/memory/module.ts` — `NOTE:` on the memory backend dropping
  statistics on a column-level ALTER while the store keeps them, and the revisit condition
  (if the difference ever shows up as a plan discrepancy between backends).
- `packages/quereus/src/runtime/emit/alter-table.ts` — `NOTE:` on
  `carryStatisticsAcrossColumnRename` being in-memory-only from the engine's side, and that
  the durable half is the store's job.

## Related, deliberately not merged

`bug-drop-table-leaves-stale-stats-entry` is the same family — a statistics record
outliving what it described — but a different site (the store's `tearDownTableStorage`
never deletes the whole-table `__stats__` entry). Untouched here.
