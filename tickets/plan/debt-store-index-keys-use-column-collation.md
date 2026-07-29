---
description: Secondary indexes in the persistent store write their text values using the table's single default text-sorting rule, not the rule declared on the indexed column. That mismatch forces the query planner to give up on fast lookups in common cases, and it should instead store each indexed text value under its own column's rule.
prereq: store-range-seek-order-preserving-gate
files:
  - packages/quereus-store/src/common/key-builder.ts   # buildIndexKey, buildIndexPrefixBounds
  - packages/quereus-store/src/common/store-table.ts   # index maintenance, indexSeekHonorsEnforcementCollation, analyzeIndexAccess
  - packages/quereus-store/src/common/store-module.ts  # buildIndexEntries (index rebuild), tryIndexAccessPlan → safeToHandle
difficulty: hard
---

# Encode secondary-index text columns under the column's collation, not the table key collation

## What is going on

Every store table has one **table key collation** `K` (the `collation = …` module option,
default `NOCASE`). A secondary index writes an indexed text column's key bytes by running
the value through `K`'s normalizer — regardless of the collation declared on the column
itself, or on the index column via `CREATE INDEX … (col COLLATE …)`.

But the rows an index scan produces are re-checked under the *column's* collation `C`
(`StoreTable.matchesFilters`), and the planner decides whether the pushed predicate is
fully covered under `C` too. So `K` and `C` can disagree, and the store has to defend
against it:

- `StoreModule.tryIndexAccessPlan`'s `safeToHandle` refuses to mark a filter handled
  unless `C === K` or `K` is the strictly coarser built-in (`K = NOCASE`, `C = BINARY`) —
  falling back to a full scan with the residual retained.
- `StoreTable.indexSeekHonorsEnforcementCollation` guards the write-side UNIQUE check for
  the same reason.
- After `store-range-seek-order-preserving-gate` lands, the *range* arm is tighter still:
  it requires `C === K` outright, because the coarser-`K` allowance is unsound for ranges
  (see that ticket's `§ K-vs-C`). That costs the default shape — an index on a plain
  BINARY text column of a default `K = NOCASE` table — its range seek.

## What we should do instead

Encode a text index column's bytes under `C` (the index column's `COLLATE` if present,
else the table column's declared collation), exactly as `resolvePkKeyCollations` already
does for primary-key members. Then key bytes and comparisons agree by construction, `K`
stops governing secondary-index columns entirely, `safeToHandle` collapses to "is `C`
order-preserving", the write-side enforcement guard disappears, and the range seek is
restored for the default shape.

The PK suffix embedded in each index key keeps using the per-PK-column collations it
already uses; only the leading index-column bytes change.

## Why it is not urgent

Nothing is *wrong* today — every mismatch is defended by falling back to a slower plan
that retains the residual filter. This is a performance and simplicity debt: three
separate guards exist only because the index key layout picked the wrong collation.

## What makes it non-trivial

- It changes on-disk index key bytes. Backwards compatibility is waived project-wide
  (AGENTS.md), but any persisted index must be rebuilt, and `StoreModule.buildIndexEntries`
  (the rebuild path) and the live maintenance path must not drift.
- `quereus-isolation`'s `isolated-table.ts` builds sort keys that must merge against the
  store's index-key byte order — check that path.
- The UNIQUE-enforcement seek through an index (`findUniqueConflictViaIndex`) currently
  reasons about `K` vs the enforcement collation; that reasoning has to be re-derived.
