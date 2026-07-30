---
description: Queries that match a table's primary key against a list of values still read the whole table on the persistent storage backend, even though the same list lookup already works for other indexed columns.
files: packages/quereus-store/src/common/store-module.ts, packages/quereus-store/src/common/store-table.ts
---

## Context

`feat-store-in-list-index-pushdown` taught the store module to serve `where col in (v1, v2, …)`
from a **secondary** index — one deduplicated, key-ordered seek per distinct list value. It
deliberately did **not** extend that to the primary key, so
`select … from t where pk in (1, 2, 3)` still full-scans on the store.

The runtime half already exists: `StoreTable`'s multi-seek arm has a primary-key branch (one
point lookup per tuple, deduplicated and emitted in primary-key order). What is missing is the
planner half — `StoreModule`'s primary-key equality arm still matches only `=`, so it never
names a primary-key multi-seek plan.

## Why it was held back (no longer a blocker)

When the isolation layer wraps the store, a primary-key scan is merged row-by-row with the
transaction's staged writes by walking two streams that must be in the same key order
(`mergeStreams`, `packages/quereus-isolation/src/merge-iterator.ts`). A list lookup emits rows
in list order, not key order, and the staged-writes side and the stored side did not agree on
that order — which could surface a stale row alongside its updated copy, or resurrect a deleted
one. That defect was filed separately as `bug-isolation-multiseek-merge-order` and has since
been fixed, so nothing outside this ticket stands in the way now.

Re-confirm the merge behaves under an open transaction when the work is picked up, but expect
the remaining change to be small: it is the planner half only.

## Expected behavior

`select … from t where pk in (…)` against the store module resolves each list value with a
primary-key point lookup instead of scanning the table, returns each matching row exactly once,
skips NULL list entries, and stays correct under an open transaction's own uncommitted writes
and under the isolation layer.

Composite primary keys arrive as a cross-product of per-column lists and should be covered by
the same path.
