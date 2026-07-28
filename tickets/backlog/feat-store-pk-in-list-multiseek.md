---
description: Queries that match a table's primary key against a list of values still read the whole table on the persistent storage backend; the same list lookup already works for other indexed columns, but enabling it for primary keys first needs an ordering bug in the transaction-isolation layer resolved.
prereq: bug-isolation-multiseek-merge-order
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

## Why it was held back

When the isolation layer wraps the store, a primary-key scan is merged row-by-row with the
transaction's staged writes by walking two streams that must be in the same key order
(`mergeStreams`, `packages/quereus-isolation/src/merge-iterator.ts`). A list lookup emits rows
in list order, not key order, and the staged-writes side and the stored side do not agree on
that order — which can surface a stale row alongside its updated copy, or resurrect a deleted
one. That defect is filed separately as `bug-isolation-multiseek-merge-order`; it is reachable
today through the in-memory backend, independently of this ticket.

Once that is fixed (either by making both sides emit in key order, or by having the merge stop
assuming an order the plan never promised), enabling the primary-key claim here is small.

## Expected behavior

`select … from t where pk in (…)` against the store module resolves each list value with a
primary-key point lookup instead of scanning the table, returns each matching row exactly once,
skips NULL list entries, and stays correct under an open transaction's own uncommitted writes
and under the isolation layer.

Composite primary keys arrive as a cross-product of per-column lists and should be covered by
the same path.
