----
description: When a materialized view is being used to police a UNIQUE constraint, it fails to spot that two different spellings of the same duration (like "PT1H" and "PT60M") are the same value, so a duplicate gets in.
prereq: memory-unique-semantic-compare
files:
  - packages/quereus/src/core/database-materialized-views.ts   # lookupCoveringConflicts (~1051) / tryBuildCoveringPrefix (~1181)
  - packages/quereus/src/schema/unique-enforcement.ts          # uniqueEnforcementComparators (added by the prereq ticket)
  - packages/quereus/src/util/comparison.ts                    # hasSemanticOrdering / createTypedComparator
  - packages/quereus/test/covering-structure.spec.ts           # where the candidate-generator tests live
difficulty: medium
----

# Covering-MV conflict candidates ignore semantic-ordering identity

## Background

Some declared column types define their own notion of "same value" that differs from comparing
the stored text byte-for-byte — `docs/types.md` § "Semantic ordering". `TIMESPAN` is the
motivating case: `'PT1H'` and `'PT60M'` are two spellings of one hour and `TIMESPAN.compare`
returns 0 for them.

A **row-time covering materialized view** is an MV the engine may use *instead of* a table's
own index to answer a UNIQUE constraint: when a row is written, the engine looks the MV's
backing table up for rows carrying the same constrained values, and each hit becomes a
*candidate* conflict that the writing backend then re-validates against the live source row.
`MaterializedViewManager.lookupCoveringConflicts` (`core/database-materialized-views.ts`
~1051) is the shared candidate generator; both the in-memory backend
(`MemoryTableManager.checkUniqueViaMaterializedView`) and the persistent store
(`StoreTable.findUniqueConflictViaCoveringMv`) call it through `Database._lookupCoveringConflicts`.

## Reproduction

```sql
create table t (id integer primary key, d timespan, unique (d));
create materialized view ix as select d, id from t order by d;   -- becomes t's covering structure
insert into t values (1, 'PT1H');
insert into t values (2, 'PT60M');   -- ACCEPTED — should be a UNIQUE violation
```

Verified on `main` (scratch mocha spec, deleted). Controls that still behave correctly in the
same setup: a second `'PT1H'` (identical spelling) is rejected, and an `integer` column with a
covering MV rejects its duplicate — so the covering route itself works; only the identity
notion is wrong.

The prerequisite ticket `memory-unique-semantic-compare` fixes the memory backend's
re-validation comparison, but on its own it does not fix this case, because no candidate ever
reaches the re-validator.

## Root cause — precisely one comparison

The backing scan is already semantic-aware. `lookupCoveringConflicts` seeks the backing with an
equality prefix built from the writing row's constrained values, and the memory backing's scan
comparators come from `resolveScanComparators` (`vtab/memory/layer/plan-filter.ts` ~70), which
builds `createTypedComparator(logicalType, …)` per key column. Instrumented on `main`:

```
DBG lookupCoveringConflicts prefix= ["PT60M"]
DBG candidate backingRow= ["PT1H",1]        <- the seek DID surface the conflicting row
```

The row is then discarded by the per-candidate filter inside the scan loop (~1130):

```ts
if (compareSqlValuesFast(newRow[uc.columns[k]], backingRow[ucBackingCols[k]], ucCollationFns[k]) !== 0) {
    match = false; break;
}
```

`ucCollationFns` are the source columns' **declared collations** — storage-class + collation,
no type involvement — so `'PT1H' ≠ 'PT60M'` and the candidate is dropped. The self-exclusion
comparison immediately below (~1141, `sourcePk` vs `newSourcePk` under `pkCollationFns`) has the
same blind spot for a semantic-ordering PRIMARY KEY member.

## Expected behaviour

The covering-MV route reaches the same verdict as the table's own index: the reproduction above
raises the ordinary UNIQUE violation, and `on conflict ignore` / `replace` behave accordingly —
on both the memory and the store backend.

## Design notes

- **Keep the declared-collation choice for collations.** The comment above `ucCollationFns`
  explains at length that this generator deliberately narrows under the *declared* collation
  rather than the constraint's enforcement collation, because the declared-collation candidate
  set is a sound superset that the re-validators then filter down — a pairing guarded by
  `coveringMvHonorsIndexCollation`. Do not "DRY" that away. The change here is orthogonal: it
  adds the type's `compare` for semantic-ordering columns, which is *not* a
  coarser-or-finer question — the two spellings are one value at every site, so admitting them
  as candidates keeps the set a superset either way.
- **Reuse the shared helper.** `uniqueEnforcementComparators(columns, ucColumns, collations)`
  from `schema/unique-enforcement.ts` (added by the prereq ticket) is exactly the construction
  needed; pass `sourceSchema.columns`, `uc.columns`, and the already-resolved `ucCollationFns`.
  Resolve once above the scan loop, as the collations already are.
- **Self-PK exclusion** needs the same treatment per PK member — `hasSemanticOrdering` on
  `sourceSchema.columns[pkDef[i].index].logicalType`, else the current
  `compareSqlValuesFast(..., pkCollationFns[i])`. Both backends' own `keysEqual` already do
  this (`StoreTable.keysEqual` via `pkSemanticEquality`; the memory manager via its typed PK
  comparator), so this closes the last inconsistent copy.
- **`tryBuildCoveringPrefix` (~1181) needs no gate change, but does need a comment.** Its
  BINARY-collation check is a soundness gate for the prefix seek's early-termination. A
  semantic-ordering column typically declares no collation, so it passes the gate — and that is
  *correct*, because both backends key such a column semantically (memory: `createTypedComparator`
  in `resolveScanComparators`; store: the `groupKey` key transform in `storeSemanticKeyTransform`),
  so equal-value rows are physically contiguous and the seek lands on the group. Record that
  reasoning as a `NOTE:` at the gate — it is non-obvious and a future reader may otherwise
  "fix" the gate to decline these columns and silently lose the fast path.

## TODO

- Route the per-candidate UC comparison in `lookupCoveringConflicts` through
  `uniqueEnforcementComparators`, resolved once above the scan loop.
- Give the self-PK exclusion the same per-member semantic-ordering treatment.
- Add the `NOTE:` at `tryBuildCoveringPrefix`'s BINARY gate explaining why a
  semantic-ordering column may pass it.
- Tests in `packages/quereus/test/covering-structure.spec.ts`, alongside the existing
  `'non-binary collation bypasses the prefix fast path'` case:
  - generator-level: `_lookupCoveringConflicts` on a TIMESPAN-covered constraint returns the
    conflicting source PK for an equal-elapsed probe (the direct analogue of the NOCASE case
    already there);
  - end-to-end on the memory backend: the reproduction SQL above raises the UNIQUE violation,
    plus `insert or ignore` / `insert or replace` behaviour, plus an integer control;
  - self-exclusion: an UPDATE that re-spells the constrained value on the same row succeeds.
- Add an end-to-end store case in
  `packages/quereus-store/test/timespan-semantic-key-identity.spec.ts` § "secondary UNIQUE
  identity" — a `using store` table with a covering MV — so the store's
  `findUniqueConflictViaCoveringMv` route is pinned too (its own re-validation comparators are
  already semantic-aware; only the candidates were missing).
- Validate: `yarn build`, `yarn lint`, `yarn test`, and `yarn test:store`.
- If `docs/` documents the covering-structure conflict protocol, note there that candidate
  generation honours semantic-ordering identity.
