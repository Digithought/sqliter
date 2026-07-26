----
description: On in-memory tables, changing a column to a type that treats differently-spelled values as equal (for example a duration, where "1 hour" and "60 minutes" mean the same thing) leaves any index on that column comparing the old way, so lookups miss rows and duplicate values can slip past the uniqueness rule.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts        # alterColumn — the same-physical-class SET DATA TYPE branch (~2130) is the whole defect
  - packages/quereus/src/vtab/memory/layer/base.ts           # rebuildAllSecondaryIndexes (~174) — recreates every MemoryIndex from the CURRENT schema
  - packages/quereus/src/vtab/memory/index.ts                # MemoryIndex comparators come from createTypedComparator(columnSchema.logicalType, …) (~122, ~143)
  - packages/quereus/src/util/comparison.ts                  # hasSemanticOrdering / semanticKeyTransform (~493) — home for the new predicate
  - packages/quereus/src/types/temporal-types.ts             # TIMESPAN semanticOrdering + compare (~287); DATE/TIME/DATETIME compare (~72/149/191)
  - packages/quereus/src/runtime/emit/alter-table.ts         # ~972 — engine already rejects SET DATA TYPE on any PK column
  - packages/quereus-store/src/common/store-module.ts        # ~2185 keyTransformChanged — the store's equivalent guard, already correct; reference behavior
  - packages/quereus/test/logic/41.7.3-alter-column-retype-unique.sqllogic   # sibling coverage (value-rewriting retypes)
  - packages/quereus/test/logic/41.2-alter-column.sqllogic   # existing SET DATA TYPE coverage that must keep passing
  - docs/sql-ddl.md                                          # ~616-617 — the "schema-only change when the new type shares the same physical representation" claim is what's wrong
  - docs/memory-table.md                                     # ~203-300 — ALTER COLUMN re-validation / rebuild narrative
  - docs/module-authoring.md                                 # ~880 module contract table
difficulty: medium
----

# `ALTER COLUMN … SET DATA TYPE` into a semantically-comparing type leaves memory indexes stale

## What actually happens (reproduced, `main` @ ddd939e1)

The fix ticket's two symptoms are both real, but its diagnosis of the second one was wrong.
Reproduction narrowed it: **the planner and the expression layer are fine. Only the in-memory
secondary index structures are stale.**

Evidence (memory module, autocommit):

| Case | Result on `main` | Correct |
|---|---|---|
| retype `text → timespan` with **no index** | `where v = 'PT3600S'` finds every one-hour row | ✔ identical to a natively-declared `timespan` column |
| retype with a **non-unique** index | `where v = 'PT3600S'` finds nothing; `where v = 'PT1H'` finds only the literally-spelled row | ✘ |
| retype with a **unique** index, rows `'PT1H'` + `'PT60M'` | ALTER accepted; then `insert 'PT3600S'` → `UNIQUE constraint failed`, but `where v = 'PT3600S'` → 0 rows | ✘ (should have rejected the ALTER) |
| retype with a **unique** index, rows `'PT1H'` + `'PT2H'` (**no collision — a legal ALTER**) | ALTER accepted; `where v = 'PT60M'` → 0 rows | ✘ |

That last row is the important one and is not what the fix ticket described: **there is no
uniqueness violation at all**, yet the table is left broken. So this is not only a missing guard —
the index structures genuinely have to be rebuilt on an accepted change too.

The insert-rejects-but-select-can't-see contradiction falls straight out of this: write-time
uniqueness enforcement reads the *current* schema (semantic, correct), while the index B-tree still
holds the comparator captured when the index was built (textual, stale).

## Root cause

`MemoryTableManager.alterColumn` (manager.ts ~2130) splits `SET DATA TYPE` on whether the
**physical storage class** changes:

- **class changes** (`text → integer`): sets `valueConvert` → pre-validates uniqueness over the
  converted rows, rewrites the base, rebuilds every secondary index, converts open transaction
  layers. Correct.
- **class unchanged** (`text → timespan`, both store text): swaps `logicalType` and falls through,
  setting neither `valueConvert` nor `collationChanged`. So **none** of the pre-validation,
  `baseLayer.rebuildAllSecondaryIndexes()`, or `adoptSchemaOnOpenLayers()` runs.

But a `MemoryIndex`'s comparator is built from `createTypedComparator(columnSchema.logicalType, …)`
(index.ts ~122/~143), so the logical type alone decides how two keys compare. This is exactly the
`SET COLLATE` shape — values untouched, comparator changed — and `SET COLLATE` is handled; this is
not.

All the machinery already exists and is reached from the `collationChanged` arm:
`validateRekeyedUniqueStructures` (already builds its probe comparators from the *new* schema's
logical types), `baseLayer.rebuildAllSecondaryIndexes` (already recreates every `MemoryIndex` from
`this.tableSchema.columns`), `adoptSchemaOnOpenLayers`. Nothing new needs to be written for the
mechanics — only a third trigger condition wired into the same three places.

## Trigger condition

The guard must fire exactly when the column's *comparator* changes, and stay silent otherwise
(a `text → varchar(50)` retype must remain a metadata-only no-op — `41.2-alter-column.sqllogic`).

`createTypedComparator(type, coll)` is fully determined by `type.compare`: present → the type's own
`compare`; absent → `compareSqlValuesFast` under the collation. So the predicate is simply whether
the two types carry the same `compare` function:

```ts
/** True when two logical types order values differently — i.e. `createTypedComparator`
 *  would return comparators that are not interchangeable. */
export function comparisonSemanticsDiffer(a: LogicalType, b: LogicalType): boolean {
    return a.compare !== b.compare;
}
```

Put it in `src/util/comparison.ts` next to `hasSemanticOrdering` / `semanticKeyTransform`, so the
trigger is a property of the types rather than a hand-maintained type list.

**Which same-physical-class pairs this actually catches** (the ticket asked for this to be stated
plainly):

- Among the TEXT-physical types, **only `TIMESPAN` has `semanticOrdering: true`** — `'PT1H'`,
  `'PT60M'` and `'PT3600S'` are one value. `text ↔ timespan` in either direction is the headline
  case.
- `DATE` / `TIME` / `DATETIME` are also TEXT-physical and each carry their own `compare`, which is
  hard-wired to `BINARY_COLLATION` and **ignores the column's declared collation**. So
  `text collate nocase → date` really does change ordering (nocase → binary) even though both
  orderings are "textual". The `compare`-identity check covers it; a `semanticOrdering`-only check
  would not.
- `JSON` has semantic ordering but `PhysicalType.OBJECT`, so it already takes the value-rewriting
  branch and is correct today (verified: the colliding case is rejected with `CONSTRAINT`).
- Same-type retypes (`text → varchar`, `integer → bigint`) flatten to the *same* `LogicalType`
  object, so `compare` is identical and the predicate stays false. No-op preserved.

## Verified fix shape

A throwaway patch wiring a `comparatorChanged` flag (set in the same-physical-class branch) into the
three `collationChanged` sites — the pre-validation block, the `rebuildAllSecondaryIndexes()` block,
and the `adoptSchemaOnOpenLayers()` block — made every case above behave, including inside an
explicit transaction with a staged colliding row (rejected, transaction left usable), and
`yarn test` was fully green (7205 + 2000-odd across the workspace, 0 failing). The patch was
reverted; the tree is clean. Treat that as a confirmed starting point, not a finished
implementation — see the TODOs for what it did not cover.

Do **not** reuse `collationChanged` itself: that flag also drives the per-index-column collation
propagation and the `pkColumnRekeyed` path, neither of which applies here.

## Primary key

The engine rejects `SET DATA TYPE` on **any** PK column at `runtime/emit/alter-table.ts` ~972
(`Cannot SET DATA TYPE on PRIMARY KEY column 'v'`), before the module is called — confirmed for both
the same-class and class-changing cases. The memory manager keeps its own defense-in-depth guard, but
only inside the class-changing branch. Add the symmetric guard to the same-class branch, gated on the
comparator actually changing, so a direct module call can't re-key the primary tree behind the
manager's back.

## Store backend: already correct

Checked, as the ticket asked. `packages/quereus-store/src/common/store-module.ts` ~2185 computes
`keyTransformChanged` and routes it through the same re-validation + index-rebuild path as a
collation change. Reproduced against the store module with an in-memory KV provider:

- colliding rows → `alter … set data type timespan` rejected with `UNIQUE constraint failed: ts (v)`,
  table and declared type left untouched and writable;
- non-colliding rows → ALTER accepted and `where v = 'PT60M'` correctly finds the `'PT1H'` row;
- no index → correct.

So the store is the reference behavior here and needs no change. The memory module should match it
exactly, including the error text.

## Expected behavior after the fix

- A same-physical-class `SET DATA TYPE` that changes how values compare re-validates every
  uniqueness-enforcing structure covering the column, over the DDL transaction's effective rows,
  under the new comparator, **before any mutation** — rejecting with `CONSTRAINT`
  (`UNIQUE constraint failed: <table> (<cols>)`) and leaving table, schema and transaction untouched.
- An **accepted** such change rebuilds every secondary index under the new comparator and hands the
  new schema to open transaction layers, so `where v = <another spelling>` finds the row, ordering
  follows the type's semantics, and no value is simultaneously "duplicate on insert" and "absent on
  select".
- A retype between types that compare identically stays a metadata-only no-op.

## TODO

- Add `comparisonSemanticsDiffer(a, b)` to `packages/quereus/src/util/comparison.ts`, next to
  `hasSemanticOrdering`, with a doc comment naming the TIMESPAN and DATE/TIME/DATETIME cases; export
  it from `src/index.ts` alongside the neighbouring comparison helpers.
- In `MemoryTableManager.alterColumn`, set a `comparatorChanged` flag in the same-physical-class
  `setDataType` branch and wire it (as `collationChanged || comparatorChanged`) into the
  pre-validation block, the `rebuildAllSecondaryIndexes()` block and the `adoptSchemaOnOpenLayers()`
  block. Leave the index-column collation propagation and `pkColumnRekeyed` on `collationChanged`
  alone.
- Add the defense-in-depth PK guard to the same-physical-class branch (throw `CONSTRAINT`, message
  matching the existing class-changing one) when `comparatorChanged` is true.
- Update the block comment above the pre-validation block: it currently says the two arms "are
  mutually exclusive today — SET COLLATE never sets `valueConvert`". Add the third arm and say why it
  needs no `mapRow` (values are untouched; only the comparator moves).
- **Consider while in here:** the same-physical-class branch performs *no* value validation at all,
  so `alter column v set data type date` on a text column holding `'hello'` is accepted and the junk
  value survives under a DATE declaration. Decide whether that is in scope; if not, file it
  separately as `bug-` — it is reachable today, so it is a defect, not a tripwire.
- **Check while in here:** the metadata-only fall-through (`SET DEFAULT`, and a `SET NOT NULL` with
  no backfill) also never calls `adoptSchemaOnOpenLayers`, so open transaction layers keep their
  creation-time column metadata for the rest of the transaction. Verify whether that is observable;
  if it is only theoretical, record it as a `NOTE:` comment at the site rather than a ticket.

### Tests

- New `packages/quereus/test/logic/41.7.4-alter-column-retype-semantic-memory.sqllogic`, modelled on
  `41.7.1-alter-column-collate-unique.sqllogic`, covering:
  - unique index + `'PT1H'`/`'PT60M'` → ALTER rejected with `UNIQUE constraint failed`, `table_info`
    still reports `TEXT`, table still writable (`insert 'PT3600S'` succeeds);
  - unique index + `'PT1H'`/`'PT2H'` → ALTER accepted, `where v = 'PT60M'` returns the `'PT1H'` row,
    `insert 'PT120M'` now rejected as a duplicate of `'PT2H'`;
  - non-unique index → `where v = 'PT3600S'` returns every one-hour row (same answer as the same
    table with no index, and as a natively-declared `timespan` column);
  - inline `v text unique` (auto-index, not a standalone `create index`) → same outcomes;
  - reverse direction `timespan → text` → comparison becomes textual, spellings separate again;
  - `text → varchar(50)` and `integer → bigint` → still accepted, still no-ops, rows unchanged;
  - the whole colliding case inside `begin` … `rollback`, with the colliding row staged in the
    transaction → rejected, transaction still usable.
- Extend `packages/quereus/test/alter-table-conformance.spec.ts` if the `setDataType` arm's
  `confirm` read-back does not already prove a semantic retype took effect behaviorally.
- Run `yarn test` and `yarn lint`. `yarn test:store` is optional here (the store leg is unchanged and
  already correct), but cheap confirmation if time allows.

### Docs

- `docs/sql-ddl.md` ~616: "`SET DATA TYPE` is a schema-only change when the new type shares the same
  physical representation" is now wrong — such a change is schema-only *only* when the comparator is
  unchanged; otherwise it re-validates uniqueness and re-keys the structures. Fold it into the
  neighbouring bullet at ~617 that already documents the re-validation contract.
- `docs/memory-table.md` ~203-300: add the comparator-change arm alongside the existing "value
  rewrite" and "collation change" arms.
- `docs/module-authoring.md` ~880: the module-contract table lists the `setCollation` re-key
  obligation; add the matching `setDataType`-into-a-differently-comparing-type obligation so a
  third-party module author knows to honor it.
