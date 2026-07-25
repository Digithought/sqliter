---
description: A table stored on disk whose primary key is a JSON value returns the same row twice inside a transaction after you update it, and a row you deleted inside a transaction is still visible.
files:
  - packages/quereus-store/src/common/encoding.ts          # value → key byte encoding (OBJECT/JSON path)
  - packages/quereus-store/src/common/store-table.ts       # resolvePkKeyTransforms; no comparePrimaryKey
  - packages/quereus-isolation/src/isolated-table.ts       # getComparePK fallback, mergedQuery
  - packages/quereus/src/types/json-type.ts                # JSON structural compare
  - packages/quereus/src/vtab/memory/table.ts              # comparePrimaryKey (memory backend)
  - docs/types.md                                          # "Semantic ordering" section
difficulty: hard
---

# JSON primary key: persistent store scan order disagrees with JSON's own ordering

## Symptom

Reproduced today against the in-memory KV provider (so it is not a LevelDB quirk).
Table has a JSON primary key and lives in the persistent store behind the isolation
(transaction) layer:

```sql
create table t (j json primary key, v int) using istore;
insert into t values ('[2]', 1), ('[10]', 2), ('[3]', 3);

begin;
update t set v = 99 where v = 1;
select j, v from t;
```

Expected 3 rows. Actual 4 — the updated row appears both in its new form and in its
committed form:

```
[{"j":[2],"v":99},{"j":[10],"v":2},{"j":[2],"v":1},{"j":[3],"v":3}]
```

The same setup with `delete from t where v = 1` leaves the deleted row visible for the
rest of the transaction (3 rows instead of 2). Both self-correct after `commit`, so the
data is not corrupted on disk — but every read inside the transaction is wrong, which
is enough to make a read-modify-write inside a transaction produce a wrong answer.

## Cause

Two different orderings for the same column:

- The **persistent store** writes a JSON key as its canonical JSON text and scans in
  byte order. Text order puts `[10]` before `[2]`.
- **Everything else** — the JSON type's own `compare`, the in-memory table backend,
  `order by` — orders JSON structurally (element-wise, so `[2]` before `[10]`).

The isolation layer merges the pending (overlay) rows against the committed rows as two
sorted streams, using a primary-key comparator to decide which pending row replaces
which committed row. `StoreTable` supplies no `comparePrimaryKey` of its own, so the
isolation layer falls back to comparing by the column's declared type — structural
order — while the stream it is merging arrives in text order. The streams are not in
the same order, the merge loses alignment, and a pending row stops shadowing the
committed row it is supposed to replace.

Confirmed pre-existing: reproduces identically with the semantic-comparator changes
from `duration-json-semantic-ordering-store` reverted. It became reachable when the
engine started ordering JSON structurally; the store was never brought along.

TIMESPAN used to have exactly this problem and no longer does, because the store now
encodes a TIMESPAN key as total seconds — a form whose byte order *is* the type's
order. JSON has no equivalent one-line fix: structural JSON ordering (type rank, then
element-wise recursion, with a length tiebreak) has no obvious order-preserving byte
encoding.

## What needs deciding / building

Any of these would close it; they trade off very differently and the fix stage should
pick deliberately:

- Make the store encode a JSON key in an order-preserving form (a tagged, length-aware
  structural encoding). Most faithful, most work, and changes the on-disk key format.
- Have `StoreTable` publish a `comparePrimaryKey` matching its own byte order, and make
  the isolation layer feed both streams through it. Only works if the pending-row store
  can be made to emit in that same order too — today it is a memory table, which orders
  structurally.
- Have the isolation layer stop assuming the two streams share an order for
  semantic-ordering key columns (buffer + sort, or fall back to the PK-exclusion
  strategy the secondary-index path already uses).
- Reject JSON as a primary-key column in the persistent store until one of the above
  lands, so the failure is a clear DDL error instead of silently wrong reads.

## Expected behavior once fixed

- A pending update to a JSON-keyed row replaces the committed row in every read inside
  the transaction — never both.
- A pending delete of a JSON-keyed row hides it for the rest of the transaction.
- A plain `select` of a JSON-keyed store table agrees with the in-memory backend on
  which rows exist (ordering without `order by` may still differ; `order by j` already
  agrees today because a real sort runs).
- Whatever is decided, `docs/types.md` "Semantic ordering" must be updated — it
  currently carries a pointer to this ticket.
