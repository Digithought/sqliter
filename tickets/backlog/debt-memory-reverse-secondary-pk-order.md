description: If the query engine ever asks the in-memory table to read a secondary index backwards, rows that share the same indexed value would come back in the wrong relative order, which would corrupt reads inside a transaction; nothing asks for that today, so this is a latent problem to fix before that path is turned on.
files: packages/quereus/src/vtab/memory/layer/scan-layer.ts, packages/quereus/src/vtab/memory/index.ts, packages/quereus-isolation/src/isolated-table.ts, packages/quereus/src/vtab/memory/layer/scan-plan.ts
difficulty: easy
---

## What is wrong

The in-memory table serves a secondary-index read as: walk the index structure, and for
each distinct indexed value emit the rows behind it in primary-key order. When the walk is
*backwards* (a reversed scan), the index values come out in reverse, but the primary keys
inside each group are still emitted forwards.

The transaction-isolation layer merges a table read with the rows a transaction has staged
but not yet committed. It pairs the two streams by the composite ordering
"(indexed value, then primary key)", and for a reversed read it reverses that whole
ordering — primary-key tie-break included. So for a reversed secondary-index read of a
table with two or more rows sharing one indexed value, the two streams disagree, and the
merge can emit a stale copy of a row it should have replaced, or fail to suppress a row the
transaction deleted. Same failure family as the already-fixed
`bug-isolation-multiseek-merge-order`, one level down (within an index group instead of
across index values).

## Why it is not a live bug today

Nothing currently asks the in-memory backend for a backwards secondary-index read:

- No part of the engine emits the `ordCons=DESC` marker, nor the `plan=1` / `plan=4`
  descending plan codes, that `scan-plan.ts` reads to set its `descending` flag.
- The one caller that does pass a descending request (`scanEffective`, used by
  materialized-view / delta-aggregate reads) always reads the primary key tree, never a
  secondary index.

A backwards `order by` on an indexed column is satisfied today by sorting downstream
instead of reverse-walking the index. Verified by instrumenting the module's `idxStr`
during review of `bug-isolation-multiseek-merge-order`.

## Expected behavior

A reversed secondary-index read from the in-memory table should emit rows in the exact
reverse of the order a forward read of the same window emits them — including the
primary-key order inside a group of rows sharing one indexed value. Equivalently: the
composite "(indexed value, then primary key)" ordering, fully reversed.

This should hold for every shape of reversed secondary-index read (plain walk, range,
point equality, multi-value `IN` seek), and should be pinned by a test at the in-memory
module level plus one through the isolation layer with staged updates and deletes present.

Whoever enables a reverse-walk plan for a secondary index (so the engine can drop a sort)
must land this first, or that optimization silently corrupts transactional reads.
