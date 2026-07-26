---
description: Two storage backends each keep their own copy of the same bookkeeping for dropping a column, and the copies have already drifted apart once and caused a bug; fold them into one shared routine.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts      # dropColumn (~1987-2076) — indexes / UNIQUE / foreign-key renumbering
  - packages/quereus-store/src/common/store-module.ts      # alterDropColumn (~1700-1780) — the same three blocks again
  - packages/quereus/src/vtab/memory/layer/manager.ts      # shiftSchemaIndicesForInsert — the ADD COLUMN mirror, already a single named function
difficulty: easy
---

# Share the DROP COLUMN index-renumbering between the memory and store modules

## What's duplicated

Every part of a table's definition that refers to a column **by position** has to be
renumbered when a column is removed: the primary key, each secondary index, each UNIQUE
constraint, each foreign key's child columns. Both built-in storage backends implement
that renumbering, independently, with near-identical code and near-identical explanatory
comments — roughly six copies of a `drop the ones that used the removed column, shift the
rest down` pass.

## Why it matters

The copies have already drifted. The foreign-key pass was missing from *both* backends
(fixed under `bug-drop-column-leaves-fk-child-index-dangling`) — the duplication is why the
same defect had to be found and fixed twice, in two packages, with two sets of tests. Any
future position-bearing field added to a table definition has the same trap waiting.

The insert side already shows the shape to aim for: `shiftSchemaIndicesForInsert` is one
named function returning the renumbered fields to spread over the new definition. The drop
side wants the same, minus the parts that are genuinely backend-specific (the memory module
additionally tears down the internal covering structures behind a removed UNIQUE, and the
store module re-encodes stored rows).

## Shape

A single exported helper in `@quereus/quereus` taking the old table definition and the
removed column position, returning the renumbered position-bearing fields — the mirror of
`shiftSchemaIndicesForInsert`. The store module already imports a dozen such shared schema
helpers (`buildColumnIndexMap`, `appendIndexToTableSchema`, `renameColumnInCheckConstraints`,
…), so there is an established place for it and no new dependency direction.

Backend-specific follow-up work (which covering structures to discard, which rows to
re-encode) stays in each module and keys off what the helper reports as removed.

Behavior must not change; the existing `41.x` ALTER logic tests plus the store reopen specs
are the guard.
