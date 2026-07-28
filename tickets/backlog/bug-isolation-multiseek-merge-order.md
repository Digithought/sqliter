---
description: Inside a transaction, a query that matches the primary key against a list of values can return a row twice — once as you just changed it and once in its old form — or bring back a row you deleted, when the list is not written in ascending key order.
files: packages/quereus-isolation/src/isolated-table.ts, packages/quereus-isolation/src/merge-iterator.ts, packages/quereus/src/vtab/memory/layer/scan-layer.ts, packages/quereus/src/planner/rules/access/rule-select-access-path.ts
---

## What goes wrong

The transaction-isolation layer answers a read by combining two streams: the rows already
stored, and the rows this transaction has changed but not committed. It walks both at once and
assumes each arrives in the same order — ascending primary key (`mergeStreams`,
`packages/quereus-isolation/src/merge-iterator.ts`, whose doc comment states the requirement).
That is how a staged edit knows which stored row it replaces, and how a staged delete knows
which stored row to suppress.

A `where pk in (…)` query breaks the assumption. The planner turns the list into one seek per
value and the backend visits them **in the order they were written in the query**, not in key
order. Once the two streams disagree about order, the pairing slips: a staged row can be
emitted before the stored row it was supposed to replace, after which the stored (stale) copy
is emitted too.

## Reproduction (reasoned from the code; not yet run)

With the in-memory backend under the isolation layer, in one transaction:

1. `create table t (id integer primary key, v text)`; insert ids 1, 2, 3.
2. `begin`; `update t set v = 'new' where id = 1`.
3. `select * from t where id in (3, 1, 2)` — note the list is **not** in ascending order.

Expected: three rows, id=1 showing `'new'`. Suspected actual: four rows — the updated id=1
first (it sorts before the stream's first stored row, id=3), then the stored 3, 1, 2 including
the stale id=1.

The same shape with a staged `delete from t where id = 1` should show the deleted row
reappearing.

A list already in ascending key order (`in (1, 2, 3)`) is expected to work, which is likely why
this has gone unnoticed.

## Scope notes

- This is about the **primary-key** merge path. The separate secondary-index merge path
  (`mergedSecondaryIndexQuery`) tolerates an out-of-order underlying stream: every row from
  both sides is still emitted exactly once, only the interleaving position of staged rows can
  be off — and a list lookup promises no ordering to begin with, so nothing downstream depends
  on it.
- The persistent store backend does not currently produce a primary-key list lookup at all, so
  the bug is reachable through the in-memory backend. Fixing it unblocks
  `feat-store-pk-in-list-multiseek`.

## Possible directions (for whoever picks this up)

Either make both streams emit list lookups in key order (sort the seek values by key before
visiting them, on both the stored side and the staged side), or make the merge stop assuming an
order for plans that never advertised one — e.g. route a list lookup through the same
staged-row-exclusion strategy the secondary-index path already uses.

Whichever way, the fix needs a regression test that runs a deliberately unsorted list against a
staged update and a staged delete.
