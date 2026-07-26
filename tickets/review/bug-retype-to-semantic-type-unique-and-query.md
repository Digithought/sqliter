---
description: Changing an in-memory table's column to a type that treats differently-spelled values as equal (like a duration, where "1 hour" and "60 minutes" mean the same thing) used to leave any index on that column comparing the old way; it now rebuilds the index and re-checks uniqueness first, matching what the persistent storage backend already did.
files:
  - packages/quereus/src/util/comparison.ts                  # new comparisonSemanticsDiffer predicate (~498)
  - packages/quereus/src/index.ts                            # export (~126)
  - packages/quereus/src/vtab/memory/layer/manager.ts        # alterColumn — comparatorChanged flag + structuresRekeyed wiring
  - packages/quereus/src/vtab/memory/layer/transaction.ts    # adoptSchema doc comment (~167)
  - packages/quereus/test/logic/41.7.4-alter-column-retype-semantic-memory.sqllogic   # new coverage
  - packages/quereus/test/logic.spec.ts                      # MEMORY_ONLY_FILES entry (~48)
  - packages/quereus/test/alter-table-conformance.spec.ts    # two new arms (~347)
  - docs/sql-ddl.md, docs/memory-table.md, docs/module-authoring.md
difficulty: medium
---

# `ALTER COLUMN … SET DATA TYPE` into a differently-comparing type now re-keys memory indexes

## The defect, in plain terms

TEXT and TIMESPAN are both stored as text, so retyping a column between them rewrites no stored
byte. It does change how two values *compare*: TIMESPAN ranks by elapsed time, so `'PT1H'`,
`'PT60M'` and `'PT3600S'` are one value where text sees three.

The memory module treated "same physical storage" as "nothing to do". But every in-memory index
builds its comparator from the column's logical type, so the index stayed sorted the text way
while write-time uniqueness checks read the new schema. Result on `main`:

- with a non-unique index, `where v = 'PT3600S'` found nothing even though a one-hour row was there;
- with a unique index, an `insert 'PT3600S'` was rejected as a duplicate while `select … where v =
  'PT3600S'` returned zero rows — the same value simultaneously "duplicate" and "absent";
- with colliding rows (`'PT1H'` + `'PT60M'`) the ALTER was accepted at all, when it should have
  been rejected;
- and — the case the original fix ticket missed — even with **no collision** (`'PT1H'` + `'PT2H'`,
  a perfectly legal ALTER) the table came out broken, because the index was never re-sorted.

## What changed

**`comparisonSemanticsDiffer(a, b)`** (`src/util/comparison.ts`) — returns `a.compare !== b.compare`.
`createTypedComparator` is fully determined by `type.compare`, so comparing those two function
identities *is* the question "would the rebuilt comparator differ". Exported from `src/index.ts`.

Notably it catches more than a `semanticOrdering` check would: DATE / TIME / DATETIME are also
TEXT-physical and each carry their own `compare` hard-wired to BINARY, ignoring the column's
declared collation — so `text collate nocase → date` genuinely re-orders. And a retype that
flattens to the same `LogicalType` object (`text → varchar(50)`, `integer → bigint`) shares one
`compare`, so the predicate correctly reports no change and the ALTER stays a metadata-only no-op.

**`MemoryTableManager.alterColumn`** — the same-physical-class `setDataType` branch now sets a
`comparatorChanged` flag, and a derived `structuresRekeyed = collationChanged || comparatorChanged`
drives the three sites that were previously `collationChanged`-only: the UNIQUE pre-validation, the
`baseLayer.rebuildAllSecondaryIndexes()` call, and `adoptSchemaOnOpenLayers`. The index-column
collation propagation and the `pkColumnRekeyed` primary-tree path stay on `collationChanged` alone,
as the fix ticket specified. A defense-in-depth PK guard (`CONSTRAINT`, message matching the
class-changing branch) now covers the same-class arm too.

**One thing the fix ticket's verified patch did NOT cover, found while implementing.** Wiring only
those three sites left the in-transaction case broken: with a pending transaction layer,
`select … where v = 'PT3600S'` returned nothing after an accepted retype. Cause —
`TransactionLayer.adoptSchema` decides an index must be *replaced* by `IndexSchema` **object
identity**, and the schema rebuild only rebuilt those objects under `collationChanged` (where it
had a collation field to write). A comparator-only retype has no index-column field to change, so
the objects were reused, `adoptSchema` skipped them, and the layer kept its old-comparator
`MemoryIndex` — which then became the committed head and shadowed the base's rebuilt trees. Fixed
by moving `updatedIndexes` onto `structuresRekeyed` and applying the collation rewrite only when
`collationChanged`. **This is the least obvious part of the diff and the part most worth a second
pair of eyes.**

**Docs** — `sql-ddl.md` (the "schema-only when the physical representation matches" claim was
wrong, now stated correctly and the re-validation bullet generalized to cover both value-collapse
and comparator-move), `memory-table.md` (comparator-change arm added alongside value-rewrite and
collation-change; `adoptSchema` identity-signal note), `module-authoring.md` (the module contract
table's `setDataType` row now spells out the re-key obligation for third-party module authors).

## How to exercise it

`packages/quereus/test/logic/41.7.4-alter-column-retype-semantic-memory.sqllogic` — 8 sections:
colliding rows under an explicit unique index → rejected with `UNIQUE constraint failed`, declared
type still TEXT, table still writable; same via inline `v text unique`; the non-colliding accepted
case (lookup by another spelling finds the row, `insert 'PT120M'` now duplicates `'PT2H'`);
non-unique index answering identically to the same table with no index and to a natively-declared
TIMESPAN column; reverse `timespan → text`; `text → varchar(50)` and `integer → bigint` still
no-ops; `text collate nocase → date`; and both transaction cases (a staged colliding row rejects
and leaves the transaction usable and retryable; a collision only among deleted rows does not
block). It is memory-only (listed in `MEMORY_ONLY_FILES` with a reason).

`packages/quereus/test/alter-table-conformance.spec.ts` gained two arms — an honored semantic
retype whose `confirm` probes *behaviorally* (`where v = 'PT60M'` must find the row stored as
`'PT1H'`, and `'PT120M'` must be rejected as a duplicate of `'PT2H'`), and the collision case as a
clean `CONSTRAINT` reject. The pre-existing `SET DATA TYPE` arm only covered the lossy-`MISMATCH`
path, so nothing previously proved a retype took effect behaviorally.

Manual sanity check worth repeating: `create table t (id integer primary key, v text); create index
… ; insert 'PT1H','PT60M'; alter … set data type timespan; select * from t where v = 'PT3600S';`
should return both rows.

## Validation run

`yarn test` — **7210 passing in `packages/quereus`** (7205 before, +5: 1 logic file, 2 memory
conformance arms, 2 stub-module arms), every other workspace package green, 0 failing.
`yarn lint` — clean. No pre-existing failures encountered.

## Honest gaps — where to push

- **`yarn test:store` was NOT run.** The store leg is unchanged by this diff (the fix ticket
  verified the store already handles the TIMESPAN half via its own `keyTransformChanged` guard),
  and the new logic file is memory-only, so nothing in the store path should have moved. But that
  is reasoning, not a run.
- **The store and memory triggers are not the same predicate.** The store keys off
  `storeSemanticKeyTransform` identity (defined for TIMESPAN, which has a `groupKey`); memory keys
  off `compare` identity. So `text collate nocase → date` re-keys on memory and, as far as I can
  tell from reading, does **not** on the store — DATE has a `compare` but no `groupKey`. I did not
  verify that against a running store, and did not file it, because it is a store-side question
  that deserves its own reproduction first. If a reviewer confirms it, it is a real ticket.
- **Only the memory module's structures are re-keyed.** Anything else that caches a comparator
  derived from a column's logical type across a DDL boundary (planner-side caches, materialized
  views) was not audited. The fix ticket's reproduction showed the planner and expression layers
  reading the current schema correctly, so this is a "did not look" gap, not a known one.
- **The new test file asserts `table_info` type strings** (`TEXT`, `TIMESPAN`, `DATE`). If those
  rendered names ever change, the fixture breaks in a way that looks unrelated to the fix.
- **`comparisonSemanticsDiffer` is a *function-identity* test.** Two logical types that
  legitimately share one `compare` implementation but should compare differently (e.g. a future
  type family parameterized at construction) would be reported as identical. No such type exists
  today; worth a moment's thought if one is added.

## Tripwires parked in code (index only — the analysis lives at each site)

- `src/vtab/memory/layer/manager.ts`, after the `convertColumnOnOpenLayers` call: a `NOTE:` recording
  that the *metadata-only* fall-through (`SET DEFAULT`, `DROP NOT NULL`, a `SET NOT NULL` needing no
  backfill) still never hands the new schema to open transaction layers. The fix ticket asked whether
  that is observable; I probed it inside a transaction holding a pending layer — both DEFAULT
  application and NOT NULL enforcement behave correctly, because they happen above the module off the
  catalog schema, and a layer's frozen schema drives only its index set, its `uniqueConstraints`
  enforcement and its comparators, none of which those changes touch. Theoretical today; the NOTE says
  what would make it real.

## Spun off, not fixed here

`tickets/fix/bug-retype-same-class-skips-value-validation.md` — the same-physical-class branch does
**no value validation at all**, so `alter column v set data type date` on a text column holding
`'hello'` is accepted and the junk value survives under a DATE declaration (while a fresh insert of
the same shape is correctly rejected). Reproduced during this work; deliberately out of scope,
because adding value validation is a behavior change of its own rather than a stale-structure fix.
