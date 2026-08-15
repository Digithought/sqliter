---
description: Renaming, adding, or dropping a column leaves the table's saved per-column measurements untouched, so a column can end up credited with a different column's numbers and the query planner sizes it wrongly.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts               # the three ALTER column forms; install path + withGeneratedColumnGraph
  - packages/quereus/src/schema/table.ts                            # TableSchema.statistics — the field nothing prunes
  - packages/quereus/src/planner/stats/catalog-stats.ts             # reads columnStats by current column name (lowercased)
  - packages/quereus/src/vtab/memory/layer/manager.ts               # memory module's add/drop/rename column schema builders
  - packages/quereus-store/src/common/store-module-alter.ts         # store module's add/drop/rename column schema builders
  - packages/quereus-store/src/common/store-table-base.ts           # primeStats stamps the persisted snapshot back at open
repro: static
severity: edge-case
likelihood: contrived
tradeoffs: The damage is confined to cost estimates — no query returns wrong rows — and hitting the mis-attribution needs a rename followed by a new column reusing the freed name, so a maintainer may reasonably rank this below anything user-visible.
---

# ALTER TABLE on a column never prunes the table's column statistics

## What happens

`ANALYZE` records a per-column measurement set (distinct count, null count, min/max,
histogram) on the table's schema, keyed by lowercase column name. Every `ALTER TABLE` form
that changes the column set builds the new schema by copying the old one field-by-field and
overriding only the columns — so the measurement set is carried across by reference, exactly
as it was, with no attempt to drop or re-key the entries whose columns no longer exist under
those names.

Three consequences, in ascending order of severity:

- **DROP COLUMN** leaves the dropped column's entry in the set. Unreachable, so harmless
  beyond a few bytes.
- **RENAME COLUMN `k` to `k2`** leaves the entry under `k`. Lookups for `k2` miss and fall
  back to the default guess, so the planner simply loses the measurements it had — a
  degradation, not an error.
- **RENAME COLUMN `k` to `k2`, then ADD COLUMN `k`** hands the brand-new (all-NULL) column
  the old column's distinct count, null count, min, max and histogram. The planner now
  estimates that column's predicates from a distribution belonging to a different column's
  data. This is the actual defect; the first two are the same root cause seen without teeth.

The effect is bounded to plan choice — a seek picked where a scan was right, or the reverse.
No query returns wrong rows.

## Why it matters more now than it used to

Before per-column statistics were persisted, this mis-attribution lasted only as long as the
process: close the database and the measurements were gone. They now survive a reopen, so a
mis-attributed entry can outlive the session that created it indefinitely, and nothing short
of re-running `ANALYZE` clears it.

## Expected behavior

After any `ALTER TABLE` that renames, adds, or drops a column, the table's statistics describe
only columns that still exist under the names they were measured under. A column whose name is
new to the table — whether freshly added or freed by a rename — has no statistics at all, the
same state as a table nobody has analyzed. Whether a rename should *carry* its measurements to
the new name is a separate, optional improvement; correctness only requires that it must not
leave them where a future column can claim them.

## Shape of the fix

This is a class, not three instances. All six module-side schema builders (memory and store,
one per ALTER form) plus the engine's rename fallback copy the statistics blindly, and a
seventh will do the same the day someone adds another ALTER form. The durable fix is an
invariant at the install seam rather than a patch per builder: when a schema is registered
whose column-name set differs from the one it replaced, filter its statistics down to the
surviving names. `alter-table.ts` already funnels add/drop through one post-processing helper,
which is the natural place; rename needs the same treatment.

A property-style test is the right guard — for each ALTER column form, assert that every key
in the resulting statistics names a column that exists in the resulting schema. That one
assertion covers all present forms and any future one.

## Confirming it

Read-only inference from the code; no test was run. What would confirm it: create a table with
two differently-distributed columns, `ANALYZE`, rename one, add a new column reusing the freed
name, and read the new column's entry off `TableSchema.statistics` — a populated entry
carrying the old column's numbers is the defect. For the persistence half, do the same against
a store-backed database and reopen it.
