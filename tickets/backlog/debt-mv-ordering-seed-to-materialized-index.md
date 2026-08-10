---
description: A view whose stored copy is kept in sorted order gets that ordering by a trick that can force a column to reject blank values even when the view itself says blanks are allowed; keep the sort in a separate index instead, so the two stop contradicting each other.
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # computeBackingPrimaryKey (~236) and the two // NOTE: sites that reference this rework
tradeoffs: The concrete defects it would retire have each already been patched with narrow guards, so the payoff is removing guards rather than fixing live behaviour, against the cost of a new materialized secondary index mechanism.
---

# Replace ordering-seeded physical PK with a proper materialized secondary index

## Background

A **materialized view** is a query whose results the engine stores in a real table and keeps up to
date. Every such table needs a **primary key** — the set of columns that identifies a row uniquely
— and a primary key column is never allowed to be empty (NULL). The problem below is that the
engine reuses the primary key to also record *sort order*, which drags the sort column under that
no-empty rule even when the view's own definition permits empty values there.

When a materialized view's body carries `order by <col>`, the engine currently "seeds" the ordering
columns into the **physical** primary key of the backing table (`computeBackingPrimaryKey` in
`materialized-view-helpers.ts` ~236): the ordering columns lead the key, with the logical key (from
`keysOf`) appended as a uniqueness-preserving tiebreaker. This clusters the backing btree in body order so
scans return rows pre-sorted.

The problem: the ordering column is not part of the view's **logical** key and may be **logically
nullable**. Seeding it into the physical PK pins a column NOT NULL (a PK column can't hold NULL under the
memory manager's rule) even when the view's derived logical shape says the column is nullable. The moment a
NULL flows through the ordering column, the physical PK and the declared column nullability contradict each
other. This has already produced concrete defects that needed narrow guards to patch:

- `mv-reshape-loosens-not-null-on-ordering-seeded-backing-pk` — refresh tried to DROP NOT NULL on the
  seeded PK column and crashed; masked so it no longer emits that op.
- `mv-refresh-null-into-notnull-seeded-pk-guard` — refresh then silently stored a NULL into that
  still-declared-NOT-NULL PK column; now a loud error, but the MV becomes un-refreshable while a source
  NULL persists.

Both are workarounds for the same root cause. The `// NOTE:` comments at `computeBackingPrimaryKey` (~236)
and its callers already point at "the covering ticket replaces this seeding with a proper materialized
index" — **this is that ticket** (it did not previously exist as a filed item; the NOTEs were aspirational).

## What to build

Express body ordering as a **materialized secondary index** on the backing table rather than by inflating
the physical primary key:

- The backing table's physical primary key stays the **logical key** (`TableDerivation.logicalKey` /
  `keysOf`), matching `computeBackingPrimaryKey`'s no-`order by` behavior. No logically-nullable column is
  ever pinned NOT NULL, so the whole class of contradictions above disappears — a nullable ordering column
  simply keys/indexes as nullable.
- Body ordering becomes an ordered secondary index (already how the coarsened-key path opts out of seeding
  — see `deriveBackingShapeUnguarded` ~182, which drops the seed and treats `ordering` as informational).
  Reads that want body order use the index; the clustering optimization is preserved without touching the
  PK.

## Why it is deferred (not urgent)

The two narrow guards above make the current behavior *correct* (loud error instead of silent corruption),
so this is hardening/simplification debt, not an active data-loss bug. It is filed here so the aspirational
`// NOTE:` comments finally have a real referent, and so the two guards can be **removed** once it lands
(they are only needed while ordering-seeding pins the PK). When picked up, audit and delete:
`isPhysicalPkColumn` and its two mask call sites in `materialized-view-helpers.ts`, the
`nullInNotNullSeededPk` guard in `rebuildBacking`, and the associated known-limitation notes in
`docs/materialized-views.md`.

## Watch-outs for whoever plans this

- Persistence / catalog round-trip: the backing DDL and any adopt/import shape-match gates
  (`backingShapeMatches`, `describeBackingShapeMismatch`, the attach strict-shape check) currently encode
  the seeded PK; moving ordering to an index changes the canonical shape and must stay a fixed point across
  create → persist → reopen.
- Refresh reshape classification (`classifyBackingReshape`) treats a physical-PK change as inexpressible;
  with ordering off the PK, some deltas that are inexpressible today become index-only rebuilds.
- Confirm downstream consumers that rely on the backing arriving pre-sorted (if any) read through the index
  rather than assuming PK clustering.
