----
description: When someone declares both a UNIQUE column and a separate plain index on the same column in the persistent store, the store keeps two identical hidden indexes and updates both on every write; reuse the existing one instead of building a duplicate.
prereq: feat-store-implicit-unique-index
files:
  - packages/quereus-store/src/common/store-table.ts   # withImplicitUniqueIndexes (materialization helper)
  - packages/quereus-store/src/common/store-module.ts   # createIndex / dropIndex (reuse-transition reconciliation); reconcileImplicitUniqueIndexStores
  - packages/quereus/src/vtab/memory/layer/manager.ts   # indexCollationsMatchDeclared — the reuse gate to mirror
  - packages/quereus-store/test/unique-constraints.spec.ts   # "materialization & coexistence › an explicit index and the implicit index coexist" asserts BOTH are maintained today — flip it to assert a single index
----

# Store: reuse an existing explicit index instead of a duplicate implicit UNIQUE index

## What this is about

The `feat-store-implicit-unique-index` work makes the store build a hidden per-constraint
index (`_uc_*`) for every plain `UNIQUE`, so enforcement is a fast lookup. For simplicity
and soundness, that first pass **always** builds the hidden index — even when the user has
also declared an explicit `create index` over the same column(s). In the store, a hidden
`_uc_*` index and an explicit index over the same columns are byte-for-byte identical
structures (both key their columns under the table key collation K), so the duplicate is
harmless but wasteful: every insert/update/delete maintains two identical indexes instead of
one.

This ticket is the optimization: when a collation-compatible explicit **full** (non-partial)
index already covers a UNIQUE constraint's columns, enforce through it and skip building the
duplicate hidden index — mirroring what the memory backend already does
(`MemoryTableManager.ensureUniqueConstraintIndexes` reuses a same-column-set index whose
per-column collations match the declared ones).

## Why it was deferred, not done inline

Reuse makes the hidden index's lifecycle depend on the set of *explicit* indexes, not just
the set of UNIQUE constraints. That means the physical index store has to be reconciled on
the reuse **transition** — when `create index` over the constrained columns arrives, the
now-redundant hidden store must be torn down; when that explicit index is dropped, the hidden
store must be rebuilt from existing rows. Handling those transitions correctly pulls
reconciliation into the `createIndex` / `dropIndex` arms, which the always-build v1
deliberately avoided to keep the change to one sound, reviewable pass. The waste it leaves
behind (double maintenance only when a user declares both a UNIQUE and a separate index on
the same column — uncommon) is a performance cost, never a correctness one.

## Expected outcome

- A table with both `email text unique` and `create index ix on t(email)` maintains **one**
  index, not two.
- Dropping the explicit index that a UNIQUE was reusing rebuilds the hidden index from the
  current rows so enforcement stays correct.
- Enforcement and conflict semantics are unchanged from the always-build behavior.
