---
description: Reopening a saved database rebuilt stored query results from scratch whenever the result was keyed by a text column; it now reuses what was already saved, so startup no longer scales with how much data the database holds.
files:
  - packages/quereus/src/vtab/module.ts                                    # new optional `normalizeCreateSchema` hook on VirtualTableModule (~234)
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts         # normalizeBackingShape (~363), deriveBackingShape's new `backing` param (~140)
  - packages/quereus/src/runtime/emit/materialized-view.ts                 # ~200 — refreshMaintainedTable call site
  - packages/quereus/src/schema/manager.ts                                 # importMaterializedView (~3343) — pre-existing lookup moved above the derivation
  - packages/quereus-store/src/common/store-module.ts                      # normalizeCreateSchema impl (~311); create routes through it (~341)
  - packages/quereus-isolation/src/isolation-module.ts                     # conditional forward of the hook (~176, ~193)
  - packages/quereus/test/mv-backing-normalize-shape.spec.ts               # NEW — engine-side suite (12 cases)
  - packages/quereus-store/test/mv-rehydrate-adopt.spec.ts                 # NEW describe: text primary-key backing (5 cases)
  - packages/quereus-store/test/mv-store-backing.spec.ts                   # NEW case under `using store(...)` args (isolation-wrapper forward)
  - docs/module-authoring.md                                               # new § normalizeCreateSchema
  - docs/module-capabilities.md                                            # surface inventory row + signaling list
  - docs/mv-backing-host.md                                                # gate 2 + the store's "text PK keys under K" bullet
  - docs/materialized-views.md                                            # declared-collation note on CREATE TABLE … MAINTAINED AS
difficulty: medium
---

# What shipped

A materialized view stores its answer in a real table (its **backing**). On reopen the
engine either **adopts** that stored table (metadata-only, cheap) or **refills** it by
re-running the view's query over every source row. Adoption is gated on the stored table's
shape still matching the shape the query would produce today.

The comparison was asymmetric. The store module rewrites one attribute as it creates a
table — a `text` primary-key column with no `collate` clause is keyed under the store's
table-level key collation `K` (`NOCASE` by default) instead of the engine's `BINARY`
default — and that rewrite was private to `StoreModule.create`. So the *persisted* backing
read `COLLATE NOCASE` while the *re-derived* shape said `BINARY`, the gate saw a
difference that did not exist, and any view keyed on an undecorated text column refilled
on **every** open, forever.

## The mechanism

**A new optional module hook** publishes that rewrite:

```ts
// VirtualTableModule
normalizeCreateSchema?(tableSchema: TableSchema): TableSchema;
```

Pure, deterministic, may adjust per-column attributes the module owns physically, may not
add/remove/reorder/rename columns. `StoreModule` implements it (reading `K` off the
schema's own `vtabArgs`) and routes its own `create` through it, so the rewrite has one
owner. `IsolationModule` forwards it by presence — required, since the registered `store`
module is the wrapper. Absent ⇒ identity (memory, every third-party module).

**Engine side**, `normalizeBackingShape` builds a probe `TableSchema` from the derived
shape and passes it through the hook; `deriveBackingShape` applies it before returning, so
every consumer (`backingShapeMatches`, `describeBackingShapeMismatch`,
`classifyBackingReshape`, the rename-propagation assertion) compares post-normalization
shapes without knowing the hook exists. A hook that reshapes raises `INTERNAL`.

## The one design change vs the ticket

The ticket specified blanket normalization at all eight `deriveBackingShape` call sites.
That broke `yarn test:store` — `06.6-aggregate-extended.sqllogic` creates

```sql
create table agg_rt_mt (grp text not null collate binary primary key, …)
  maintained as select grp, … from agg_rt group by grp;
```

i.e. a **declared-shape** maintained table whose text key deliberately opts *out* of the
store's `K`. Blanket normalization pushed the body's implicit `BINARY` to `NOCASE` and the
strict declared-shape gate rejected the create. Left unaddressed past the create, the same
table would have refilled on every reopen and errored on `refresh` (a physical-PK
collation change is an inexpressible reshape) — the original bug in mirror image.

Root cause of the ambiguity: **`ColumnSchema.collationExplicit` is not persisted.** After a
round-trip a declared `COLLATE BINARY` is indistinguishable from no clause at all, so
"would the module have rewritten this column?" is unanswerable from the live table.

Resolution — `normalizeBackingShape` takes an optional `against?: TableSchema` (the table
this shape will be compared to), threaded through `deriveBackingShape`'s `backing`
parameter. An attribute the body left *implicit* is compatible with **either** its own
declared value or the module's normalized one; the reading that agrees with `against`
wins. A value matching neither is still a genuine mismatch and still refills. On a create
path `against` is omitted and the module's answer is taken verbatim.

Consequences to check in review:
- the adopt/compare sites had to learn their comparison target, so `manager.ts`'s
  `preExisting` lookup moved above the shape derivation (pure read; the adopt/collision
  *decisions* still happen after the arity and ordering gates), and
  `tryRecompileMaterializedViewLive` resolves its live backing before deriving.
- `restoreUnaffectedMaterializedViews` / `renameShiftedBackingColumns` pass the live table
  as `against` during a rename cascade, when names have shifted. The compatibility test is
  name-blind (type / not-null / collation, positional), which is what a pure name shift
  needs — but it is worth a second pair of eyes.

# How to exercise it

## The fix itself

`packages/quereus-store/test/mv-rehydrate-adopt.spec.ts` → `describe('text primary-key
backing (module-normalized collation)')`. The oracle throughout the suite is a **sentinel
row** planted directly into the backing's physical key-value store between sessions —
content the body would never produce. Serving it after reopen proves adoption; its absence
proves a refill.

```
yarn workspace @quereus/store test --grep "text primary-key backing"
```

Manually:

```sql
create table src (id integer primary key, a text not null, b integer) using store;
insert into src values (1, 'x', 10), (2, 'y', 20);
create materialized view mv using store as select a, count(*) as n from src group by a;
-- close cleanly, reopen: `mv` must adopt (source rows unread), twice in a row
```

## Adversarial angles worth pushing on

- **Does the negative property really hold?** The two-valued rule is the risky part. It is
  pinned at `mv-backing-normalize-shape.spec.ts` → `two-valued compatibility` (three cases,
  including "a live collation matching NEITHER reading is still a mismatch") and at
  `mv-rehydrate-adopt.spec.ts` → "a GENUINE collation divergence still fails the shape gate
  and refills" (a source `set collate rtrim` between sessions). Try to construct a case
  where the rule adopts a backing whose physical keying the body would *not* produce.
- **Wrapper forwarding.** `mv-store-backing.spec.ts` covers the isolation-wrapped path via
  a refresh assertion. Any other module wrapper in the tree? I checked: `IsolationModule`
  is the only one that forwards `createBacking` / `getBackingHost`, so it is the only one
  that needed the hook.
- **`refresh materialized view` on a text-keyed store backing.** Before this change it
  classified a no-op as a physical-PK re-key ⇒ inexpressible reshape ⇒ error. Pinned in
  both new suites; try other reshape combinations on a text-keyed backing (add a column
  *and* keep the text key, drop a column, rename a key column).

## What I verified, and how

- **The bug is real and the tests catch it.** I temporarily disabled the normalization
  call, rebuilt, and re-ran: the core store adopt case fails (`sentinel scrubbed` ⇒ the
  backing refilled) and the engine suite's first case fails on `shape.columns[0].collation`.
  Restored afterwards. Two of the five store cases (`collation = 'BINARY'`, `any`-typed PK)
  pass with or without the fix — they are regression guards for the identity paths, not
  bug-catchers, and are labelled as such.
- `yarn build`, `yarn lint`, `yarn typecheck` — clean.
- `yarn test` — 9661 + all workspace suites passing, 0 failing.
- `yarn test:store` — 9656 passing, 0 failing (this is the run that caught the design
  problem above; it is the one to re-run if the compatibility rule is touched).

# Known gaps — treat the tests as a floor

- **No performance assertion.** The ticket's evidence table (10k rows: 37.9 ms + 10,000
  source rows read → 1.7 ms + 0 read) is not encoded as a test. The suites prove
  *adoption* via the sentinel, which is the behavioural cause, but nothing would catch a
  future regression that adopts and is still slow for another reason.
- **No IndexedDB / LevelDB end-to-end run.** The downstream report was
  `@quereus/plugin-indexeddb` at ~60k rows (8–14 s reopen). Everything here is exercised
  over the in-memory KV provider and LevelDB via `test:store`; the real browser path is
  unverified by me.
- **`coarsenedKey` interaction is reasoned, not tested.** The ticket lists coarsened
  lineage keys as an edge case. Normalization only touches `columns`; `coarsenedKey`,
  `primaryKey`, `ordering`, `sourceTables`, `allProvedKeys` pass through untouched, and the
  coarsening path deliberately drops the ordering seed. I did not construct a
  coarsened-key MV over a store backing with a text key to confirm end-to-end.
- **`normalizeBackingShape` is exported but only reachable through `deriveBackingShape`.**
  It is exported for the new engine spec's direct assertions. If that reads as too much
  surface, it can be un-exported and the spec rewritten to drive it through
  `deriveBackingShape` only (which is what most of the cases already do).
- **The purity contract is advisory.** The engine checks column count and per-position
  names. A hook that silently changed a column's *type* or *not-null* would pass the guard
  and be taken at face value.

# Tripwires parked in code

- `materialized-view-helpers.ts`, in `normalizeBackingShape`: a `NOTE:` recording that the
  two-valued compatibility rule exists **only** because `collationExplicit` is not
  persisted — if explicitness is ever persisted, the rule collapses to a single reading
  ("take the module's answer iff the live column is implicit").

# Deliberately out of scope (unchanged, per the ticket)

- Which collation the store keys an implicit text primary key under — `K` (default
  `NOCASE`) stays.
- The `isPhysicalPkColumn` not-null mask beside the collation compare, owned by
  `debt-mv-ordering-seed-to-materialized-index`. Untouched.
