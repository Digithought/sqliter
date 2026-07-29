----
description: The persistent store used to keep two identical hidden indexes when someone declared both a UNIQUE column and a separate plain index on the same column; it now reuses the existing index instead of building a duplicate, and rebuilds the hidden one if that index is later dropped.
prereq:
files:
  - packages/quereus-store/src/common/store-table.ts   # findReusableIndexForUnique + indexCollationsMatchDeclared (new); withImplicitUniqueIndexes now skips a covered UNIQUE
  - packages/quereus-store/src/common/store-module.ts  # implicitUniqueIndexNameMap is reuse-aware; createIndex / dropIndex now call reconcileImplicitUniqueIndexStores
  - packages/quereus-store/test/unique-constraints.spec.ts  # new describe 'implicit unique index — explicit-index reuse' (10 tests) + createIndexTrackingProvider helper
difficulty: medium
----

# Store: reuse an existing explicit index instead of a duplicate implicit UNIQUE index

## What changed

Background: a plain `UNIQUE` (column-level `email text unique`, or table-level
`unique (email)`) is enforced in the store through a hidden secondary index named
`_uc_<cols>` (or after the constraint, when it is named). That index lives only in
`StoreTable`'s private "materialized" schema — the engine never sees it and it is never
persisted as a `create index`; it is re-derived from the constraint list every time the
table is opened.

Until now that hidden index was built **unconditionally**. If the user also declared
`create index ix on t(email)`, the store kept two byte-for-byte identical structures and
wrote to both on every insert/update/delete.

Now a UNIQUE whose columns are already covered by a **collation-compatible, full
(non-partial) explicit index** gets no hidden index — that index enforces it. Because
`findUniqueConflictViaIndex` already accepted any full index over the constrained
columns, enforcement code needed no change at all; only the materialization decision and
the physical-store lifecycle moved.

Three pieces:

- **`findReusableIndexForUnique(schema, uc)`** (new, exported from `store-table.ts`) —
  the gate. Returns the explicit index that realizes `uc`, or undefined. Refuses:
  index-derived UNIQUEs, partial UNIQUEs, partial indexes, collation-mismatched indexes,
  and the constraint's own `_uc_*` (so an already-materialized schema answers the same
  as its engine-facing original — that self-exclusion is load-bearing, see below).
  `withImplicitUniqueIndexes` consults it before adding a `_uc_*`.
- **`implicitUniqueIndexNameMap`** (`store-module.ts`) now applies the same gate, so the
  set of `_uc_*` stores that *should* exist matches what the materializer actually
  produces.
- **`createIndex` / `dropIndex`** now call the existing
  `reconcileImplicitUniqueIndexStores`, which diffs those name maps. Creating a covering
  index therefore tears down the now-redundant `_uc_*` store; dropping it rebuilds
  `_uc_*` from the live rows. No new reconciliation machinery — the ALTER-time
  reconciler already did exactly this shape of work.

A **DESC** index *is* reusable: every writer and reader derives direction flags from the
index's own `columns[].desc`, so the enforcement probe lands on the same window the entry
was written to.

## Why the collation gate is stricter than today's encoding needs

Store index keys are encoded under the **table key collation K** for every index alike
(`buildIndexKey` passes `this.encodeOptions`), *not* the index's declared per-column
`COLLATE`. So today any same-column index is byte-identical to the `_uc_*` it replaces,
and the collation gate rejects reuse the encoding would actually permit. Kept strict
deliberately, for two reasons stated in the code: it mirrors
`MemoryTableManager.indexCollationsMatchDeclared` so both backends reuse the same set of
indexes, and if store index keys ever move to per-column collations (there is a
`plan/debt-store-index-keys-use-column-collation` ticket for exactly that), reusing a
BINARY-collated index for a NOCASE-declared UNIQUE would make the enforcement seek
under-fetch and silently accept a duplicate. Cost of the strictness: one duplicate hidden
index in a rare declaration.

## Use cases to test / validate

Behavioral (must be indistinguishable from before):

- `email text unique` + `create index ix on t(email)` → duplicate insert still rejected,
  distinct insert still accepted, `or ignore` / `or replace` unchanged.
- `drop index ix` → the UNIQUE keeps enforcing, including for rows written *while* the
  explicit index was the one being maintained, and *excluding* rows deleted in that
  window (no phantom entries).
- `alter table ... add constraint u unique (email)` when `ix` already covers `email` →
  existing-row validation still runs, nothing is built; `drop constraint u` must **not**
  tear down the user's `ix`.

Structural (the point of the ticket):

- exactly one physical index store exists for the both-declared case;
- the store name set is right after each transition (`create index`, `drop index`,
  `add constraint`, `drop constraint`);
- close → reopen re-derives the same decision (nothing about reuse is persisted).

Non-reuse cases that must still build the hidden index: partial index, partial UNIQUE,
collation-mismatched index, index over different columns.

## Tests added

`packages/quereus-store/test/unique-constraints.spec.ts`, new describe
`implicit unique index — explicit-index reuse` (10 tests), plus a
`createIndexTrackingProvider()` helper that exposes which index stores exist and how many
entries each holds — the only way to observe reuse, since the reused index is invisible
to the engine-facing schema. Unlike the file's other in-memory provider it implements
`deleteIndexStore`, so a torn-down store is really gone and reopening the same name
yields a fresh store (matching LevelDB / IndexedDB; without it the closed instance would
be handed back and throw).

The existing test `an explicit index and the implicit index coexist` was flipped to
`an explicit index REPLACES the implicit index` — it asserted the old always-build
behavior. Its enforcement assertions are unchanged.

## Validation run

- `yarn build` — clean
- `yarn test` (full workspace) — clean, no failures
- `yarn test:store` (logic suite against the LevelDB store module) — 7758 passing,
  0 failing, 20 pending
- `yarn typecheck`, `yarn lint` — clean

## Known gaps / things worth an adversarial look

- **DDL inside a transaction.** `createIndex`'s new teardown closes and deletes a store
  the module coordinator may still hold buffered ops against (pending ops are keyed on
  the KVStore *handle*), so `begin; insert …; create index …; commit` on a
  UNIQUE-constrained column can fail at commit. This is the same exposure `dropIndex`'s
  own teardown has always had, and store DDL already declares
  `ddlTransactionality: 'auto-commit'` — but it is a *new site* for it. Flagged as a
  `NOTE:` at the call site. Not covered by a test; worth deciding whether it deserves
  one, or whether both sites should drain the doomed store's buffered ops.
- **Databases created before this change** still have a `_uc_*` store on disk for a
  constraint that now reuses an explicit index. Nothing reads it and nothing reclaims it
  — `materializedIndexNames` no longer lists it, so `drop table` / `rename table` will
  strand it. Harmless leak; not addressed (repo policy is "backwards compat: don't worry
  yet"), and not tested.
- **The self-exclusion in `findReusableIndexForUnique`** (ignoring the constraint's own
  `_uc_*`) is what keeps a *materialized* schema from concluding "already covered → no
  hidden index needed". Passing a materialized schema to `implicitUniqueIndexNameMap`
  without it would tear down every `_uc_*` store. Worth confirming the reasoning holds
  for every caller; no test pins the materialized-input case directly.
- **Name-aliasing case is untouched.** A user index whose name *equals* the constraint's
  implicit name (e.g. `create index uq_email on t(email)` where `uq_email` is the
  constraint) still takes the pre-existing path — the materializer's name check fires
  before the reuse gate, and the reconciler still lists that name. That aliasing is the
  subject of `fix/bug-drop-index-removes-unique-constraint-backing`; deliberately not
  changed here, but a reviewer should confirm this change did not shift its behavior.
- **Reuse is decided per schema update, not per row**, so it is off the hot path — but no
  benchmark was run to confirm the maintenance saving actually shows up. The `r2` test
  pins the structural claim (one store, N entries), not a timing.
