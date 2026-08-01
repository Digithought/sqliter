---
description: Creating a case-insensitive unique index over a JSON column succeeds on the persistent store even when the existing rows already violate it, leaving a table the store's own inserts would have rejected. The in-memory backend correctly refuses.
files:
  - packages/quereus-store/src/common/store-module-index-build.ts   # dedupeRowSignature / indexDedupeNormalizers — the build-time check
  - packages/quereus/src/util/key-serializer.ts                     # serializeKey: applies a normalizer only to string values
  - packages/quereus/src/types/json-type.ts                         # JSON_TYPE.compare honors the collation for a string-scalar pair
  - packages/quereus-store/src/common/store-table-constraints.ts    # the write-time enforcement that DOES honor the collation
repro: verified
difficulty: medium
---

# Store index build admits duplicates its own writes would reject

## What happens

Two rows hold the JSON string scalars `"a"` and `"A"`. `create unique index … (d collate nocase)`
over them:

- **memory backend** — refuses: `UNIQUE constraint failed`.
- **persistent store** — succeeds, and the index is now live over two rows that
  violate it. A subsequent `insert` of either value into the same table *is*
  rejected, so the table is left in a state the store itself would never have
  produced by writing.

Verified by running both backends side by side against the same statements
(`create table … (id integer primary key, d json)` ± `using store`, insert both
values, then create the unique index).

## Why

The store has two independent duplicate checks over the same constraint and they
do not agree on how a collation reaches a value:

- **Write time** (`store-table-constraints.ts`) compares through the engine's typed
  comparator. `JSON_TYPE.compare` applies the collation it is handed when both
  operands are string scalars, so `"a"` and `"A"` collide under NOCASE — correct.
- **Build time** (`dedupeRowSignature` in `store-module-index-build.ts`) builds a
  string signature instead: the value first goes through the JSON key transform,
  which turns it into a byte array, and the signature serializer only applies a
  collation normalizer to *string* values. The byte array is not a string, so the
  NOCASE normalizer never runs and the two rows sign differently.

So the build-time check is effectively BINARY for JSON columns while every other
check on the same constraint is not.

## Scope

Found while reviewing `any-type-compare-honors-collation`; **not** caused by it —
nothing in that change touched JSON or the build path, and the divergence
reproduces the same way before it. It is filed separately because it is a real
integrity gap reachable today.

Note the shape needs an *index-level* `collate` clause: a `json` column cannot
carry a non-BINARY collation of its own (column DDL rejects it), but index DDL
does not apply that type gate.

## Expected behavior

The duplicate check that runs when an index is built must admit exactly the rows
the write path would admit, for every column type and every collation — one
answer per constraint, whichever path asks. Whether that is reached by making the
build-time signature honor the collation for transformed values, by having the
build path reuse the write-time comparator outright, or by closing the index-DDL
gap that lets a collation be named on a type that cannot carry one, is for the
fix to decide; the first two are the ones that also cover a custom collation.

Worth checking as part of the same investigation whether any other type whose
values are transformed before signing (TIMESPAN) has the same split, and whether
the analogous table-level `unique(...)` validation path
(`validateUniqueOverExistingRows`) diverges too.
