description: Reopening a saved database rebuilt stored query results from scratch whenever the result was keyed by a text column; it now reuses what was already saved, so startup no longer scales with how much data the database holds.
files:
  - packages/quereus/src/vtab/module.ts                                    # optional `normalizeCreateSchema` hook on VirtualTableModule (~234)
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts         # normalizeBackingShape (~369), rawReadingIsTheLiveOne (~500), deriveBackingShape's `backing` param (~138)
  - packages/quereus/src/runtime/emit/materialized-view.ts                 # ~200 — refreshMaintainedTable call site
  - packages/quereus/src/schema/manager.ts                                 # importMaterializedView (~3343)
  - packages/quereus-store/src/common/store-module.ts                      # normalizeCreateSchema impl (~311); create routes through it (~341)
  - packages/quereus-isolation/src/isolation-module.ts                     # conditional forward of the hook (~177)
  - packages/quereus/test/mv-backing-normalize-shape.spec.ts               # engine-side suite (13 cases)
  - packages/quereus-store/test/mv-rehydrate-adopt.spec.ts                 # `text primary-key backing` describe (5 cases)
  - packages/quereus-store/test/mv-store-backing.spec.ts                   # 2 cases under `using store(...)` args
  - docs/module-authoring.md, docs/module-capabilities.md, docs/mv-backing-host.md, docs/materialized-views.md
difficulty: medium
----

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

A new optional module hook publishes that rewrite:

```ts
// VirtualTableModule
normalizeCreateSchema?(tableSchema: TableSchema): TableSchema;
```

Pure, deterministic, may adjust per-column attributes the module owns physically, may not
add/remove/reorder/rename columns. `StoreModule` implements it (reading `K` off the
schema's own `vtabArgs`) and routes its own `create` through it, so the rewrite has one
owner. `IsolationModule` forwards it by presence — required, since the registered `store`
module is the wrapper. Absent ⇒ identity (memory, every third-party module).

Engine side, `normalizeBackingShape` builds a probe `TableSchema` from the derived shape
and passes it through the hook; `deriveBackingShape` applies it before returning, so every
consumer (`backingShapeMatches`, `describeBackingShapeMismatch`, `classifyBackingReshape`,
the rename-propagation assertion) compares post-normalization shapes without knowing the
hook exists. A hook that reshapes raises `INTERNAL`.

## Two-valued compatibility, and how review narrowed it

`ColumnSchema.collationExplicit` is not persisted, so after a catalog round-trip a declared
`COLLATE BINARY` is indistinguishable from no clause at all. A shape attribute the body
left implicit is therefore compatible with **either** its own declared value or the
module's normalized one, and `deriveBackingShape` takes an optional `against` (the table
this shape will be compared to) to pick the reading that agrees with the live table. On a
create path `against` is omitted and the module's answer is taken verbatim.

Review narrowed *which attributes that agreement test weighs* — see the finding below.

# Review findings

## Checked

Read the implement diff (`git show f090f6e29`) before the handoff summary. Covered: the
hook contract on `VirtualTableModule`, the engine-side probe construction (physical PK,
`vtabArgs` provenance, column copying), the purity guard, all eight `deriveBackingShape`
call sites (each threads the right module identity and comparison target), the store
implementation and its `create` re-route, the isolation wrapper's presence-mirroring
forward, both new spec files, and all four touched docs. Ran `yarn build`, `yarn lint`,
`yarn typecheck`, `yarn test`, `yarn test:store`.

## Major — found and fixed in this pass

**The two-valued agreement test weighed attributes the hook never rewrote, breaking a
declared-`collate binary` maintained table after a source `NOT NULL` loosening.**

`normalizeBackingShape` kept the raw (pre-normalization) reading only when the raw column
agreed with the live column on type **and** not-null **and** collation. Not-null is exactly
the attribute `describeBackingShapeMismatch` *deliberately masks* for a physical-PK column
(an MV backing keeps its key columns NOT NULL regardless of the re-derived logical
nullability). So:

```sql
create table src (id integer primary key, a text not null, b integer) using store;
create table mt (a text not null collate binary primary key, n integer not null)
  using store maintained as select a, count(*) as n from src group by a;
alter table src alter column a drop not null;
```

made the not-null term disagree, which discarded the raw reading, applied the module's
`NOCASE`, and turned a no-op into a physical primary-key re-key. Observed (repro run
before the fix): the ALTER marked the view stale, and `refresh materialized view mt` threw
`the derivation's output shape changed incompatibly with table 'main.mt' (primary-key
column 0 collation BINARY → NOCASE)`. That is the original bug in mirror image, on the
exact table shape `06.6-aggregate-extended.sqllogic` uses — the shape the implementer
introduced `against` to protect.

Fixed at the site rather than filed: it is one predicate in the function the ticket added.
The agreement test now weighs **only the attributes the hook actually rewrote**
(`rawReadingIsTheLiveOne`, `materialized-view-helpers.ts` ~500). An attribute the hook left
alone carries no second reading, so a difference in it is a genuine shape change for the
comparison sites to report — it says nothing about which reading of the rewritten attribute
is live. Regression coverage added on both sides:

- `packages/quereus/test/mv-backing-normalize-shape.spec.ts` → `two-valued compatibility` →
  *"a NOT NULL loosening on the source does not drag the key over to the module K"*
- `packages/quereus-store/test/mv-store-backing.spec.ts` → *"a declared `collate binary` key
  survives a source NOT NULL loosening (still data-only)"* — the real store module through
  the isolation wrapper.

Both fail on the pre-fix code (verified: stale-marker assertion fails, refresh throws).

## Minor — fixed in this pass

- `normalizeBackingShape` was exported with no caller outside its own module (the handoff
  flagged it as possibly-too-much surface). Un-exported; the engine spec already drives
  every case through `deriveBackingShape`.

## Tripwires parked (not tickets)

- `materialized-view-helpers.ts`, in `normalizeBackingShape`: a `NOTE:` that `against` is
  read **positionally**, which is what the rename cascade needs, but would ask the wrong
  column if a reshape ever moved a hook-rewritten column to a position the live table fills
  with a different column. Fine today — `against` is only consulted for a column the hook
  rewrote, so append/drop reshapes still resolve correctly.
- The implementer's existing `NOTE:` at the same site (the two readings exist only because
  `collationExplicit` is not persisted) was kept and still reads correctly after the
  narrowing.

## Checked and deliberately not filed

- **`coarsenedKey.weakened[].outputCollation` records the plan's pre-normalization output
  collation** while a store backing physically keys under `K`. Real, but **pre-existing**:
  it was equally true before this diff, because the created backing was always
  post-reconcile while `buildCoarsenedKeyInfo` always read the plan. This change neither
  introduces nor widens it, and the ticket declared the store's key-collation choice out of
  scope. Not filed; recorded here so the next reader does not re-derive it.
- **`materialized-view-helpers.ts` is 3,404 lines** (`wc -l`, 2026-08-17; 3,107 before this
  ticket). Already an arm of `backlog/debt-oversized-source-files`; updated the measurement
  there rather than filing a duplicate.
- **`isPhysicalPkColumn`'s not-null mask** is owned by
  `debt-mv-ordering-seed-to-materialized-index` and was left untouched, per the ticket.

## No findings in these categories, and why

- **Call-site coverage** — all eight `deriveBackingShape` sites thread `backing`; grepped
  to confirm none was missed, including the rename-propagation path.
- **Wrapper forwarding** — `IsolationModule` is the only module in the tree that forwards
  `createBacking`/`getBackingHost`, so it is the only one that needed the hook. Confirmed
  independently of the handoff's claim.
- **Docs** — read all four touched files against the code. They describe the shipped
  behavior accurately, including the two-valued rule; the narrowing above did not change
  what any of them assert (they speak about *which reading wins*, not which attributes are
  weighed to decide it), so none needed an edit.

# Validation

- `yarn build`, `yarn lint`, `yarn typecheck` — clean.
- `yarn test` — 9665 passing across every workspace suite, 0 failing.
- `yarn test:store` — 9657 passing, 0 failing (the LevelDB/store-module run of the engine
  logic suite; this is the run that caught the implementer's original design problem and
  the one to re-run if the compatibility rule is touched again).

# Known gaps carried forward

Stated plainly rather than closed — none blocks the fix, and none is worth a ticket on its
own evidence:

- **No performance assertion.** The suites prove *adoption* via a sentinel row planted in
  the backing's physical key-value store between sessions (content the body would never
  produce), which is the behavioural cause. Nothing would catch a future regression that
  adopts and is still slow for a different reason.
- **No IndexedDB end-to-end run.** The downstream report was `@quereus/plugin-indexeddb` at
  ~60k rows (8–14 s reopen). Everything here is exercised over the in-memory KV provider
  and LevelDB; the browser path is unverified.
- **`coarsenedKey` interaction is reasoned, not tested.** Normalization only touches
  `columns`; `coarsenedKey`, `primaryKey`, `ordering`, `sourceTables`, `allProvedKeys` pass
  through untouched. No coarsened-key MV over a store text-keyed backing was constructed.
- **The purity contract is still advisory.** The engine checks column count and per-position
  names only. A hook that silently changed a column's *type* or *not-null* would pass the
  guard — though after the narrowing it now resolves coherently through the same
  per-attribute agreement rule instead of being taken at face value.
