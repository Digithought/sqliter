---
description: A column that can hold any kind of value and is declared case-insensitive is treated as case-insensitive by ordinary queries but case-sensitive by indexes and primary keys, so adding an index changes what a query returns and duplicate check fails to see a duplicate. Make the two agree.
files:
  - packages/quereus/src/types/builtin-types.ts                        # ANY_TYPE.compare — THE root site; also TEXT_TYPE.compare (the correct sibling)
  - packages/quereus/src/types/logical-type.ts                         # LogicalType — add the new `collationAware` flag here
  - packages/quereus/src/planner/analysis/comparison-collation.ts      # pkKeyCollationName — the derived "any keys BINARY" rule
  - packages/quereus/src/util/comparison.ts                            # createTypedComparator / createSemanticRowComparator doc comments
  - packages/quereus/src/vtab/memory/index.ts                          # MemoryIndex key comparators (single + composite) — fixed transitively
  - packages/quereus/src/vtab/memory/utils/primary-key.ts              # memory PK comparator — fixed transitively
  - packages/quereus-store/src/common/pk-key-resolution.ts             # resolvePkKeyCollations / resolveIndexKeyCollations / the three order-safety gates
  - packages/quereus-isolation/src/isolated-table.ts                   # canSeekForConstraint doc + overlay key normalizers
  - packages/quereus-store/test/collation-order-preserving.spec.ts     # "declines BOTH arms on an `any` column carrying a declared COLLATE"
  - packages/quereus-store/test/pushdown.spec.ts                       # "collation-unsafe index over an ANY column declines the seek"
  - packages/quereus-store/test/index-column-collation.spec.ts         # resolveIndexKeyCollations unit expectations
  - packages/quereus-store/test/unique-constraints.spec.ts             # "an ANY column with a declared COLLATE falls back to the full scan"
  - packages/quereus-store/test/isolated-store.spec.ts                 # "an ANY column with a declared COLLATE declines the seek"
  - packages/quereus-isolation/test/isolation-layer.spec.ts            # ANY COLLATE NOCASE PRIMARY KEY cases (~line 530, ~line 6136)
  - docs/store.md                                                      # §"Per-column PK key collation" — the `any` bullet, ~line 500
  - docs/types.md                                                      # ~line 395 ("TEXT/ANY column's declared compare is not collation-aware")
difficulty: hard
---

# Make `ANY_TYPE.compare` honor the collation it is handed

## The one line that is wrong

`packages/quereus/src/types/builtin-types.ts`:

```ts
export const ANY_TYPE: LogicalType = {
	name: 'ANY',
	physicalType: PhysicalType.NULL,
	validate: () => true,
	parse: (v) => v,
	compare: (a, b) => compareSqlValuesFast(a, b, BINARY_COLLATION),   // <-- takes no `collation`
};
```

The signature is `compare?(a, b, collation?)`. `ANY_TYPE.compare` declares only two
parameters, so the collation `createTypedComparator` passes as the third argument is
silently dropped and every value goes through BINARY. Its sibling `TEXT_TYPE.compare`
does the right thing one screen up (`(collation ?? BINARY_COLLATION)(a, b)`).

Everything below is a consequence of that one line. There is no second defect site.

## What it costs — all reproduced (memory backend, plain `Database`, no store module)

Each pair below is the SAME data answered two ways. The first answer comes from the
generic comparison path, which honors the column's declared collation; the second comes
from a structure keyed by `createTypedComparator(ANY_TYPE, …)`, which does not.

**1. Creating an index changes the answer.**

```sql
create table t (id integer primary key, v any collate nocase);
insert into t values (1, 'Bob'), (2, 'zed');
select id from t where v = 'BOB';       -- [1]
select id from t where v > 'a';         -- [1, 2]
create index ix on t (v);
select id from t where v = 'BOB';       -- []      wrong
select id from t where v > 'a';         -- [2]     wrong
```

**2. Creating an index changes `order by`** (the index supplies the ordering and the
`Sort` is elided, so the BINARY key order becomes the answer):

```sql
create table t6 (id integer primary key, v any collate nocase);
insert into t6 values (1, 'b'), (2, 'A'), (3, 'C');
select id from t6 order by v;           -- [2, 1, 3]  (A, b, C — NOCASE)
create index ix6 on t6 (v);
select id from t6 order by v;           -- [2, 3, 1]  (A, C, b — BINARY)  wrong
```

**3. An index `COLLATE` on a plain `any` column is a lie.** No column collation is
involved at all here — the planner's cover analysis correctly decides the NOCASE index
serves the NOCASE demand, but the index is physically keyed BINARY:

```sql
create table t (id integer primary key, v any);
insert into t values (1, 'Bob'), (2, 'zed');
select id from t where v = 'BOB' collate nocase;   -- [1]
create index ix2 on t (v collate nocase);
select id from t where v = 'BOB' collate nocase;   -- []   wrong
```

**4. Uniqueness is not enforced under the collation the rest of the engine uses.** The
memory PK BTree and the memory unique index are both keyed by
`createTypedComparator(ANY_TYPE, …)`:

```sql
create table pk (k any collate nocase primary key, n integer);
insert into pk values ('Bob', 1);
insert into pk values ('BOB', 2);       -- ACCEPTED; two rows now exist
select n from pk where k = 'BOB';       -- [2] only — the PK point-lookup window is BINARY

create table u (id integer primary key, v any collate nocase, unique (v));
insert into u values (1, 'Bob'), (2, 'BOB');   -- ACCEPTED
```

**5. …while every hash/set identity site in the engine already says those are one value:**

```sql
create table g (id integer primary key, v any collate nocase);
insert into g values (1,'Bob'), (2,'BOB'), (3,'zed');
select v, count(*) from g group by v;   -- [('Bob', 2), ('zed', 1)]
select distinct v from g;               -- ['Bob', 'zed']
select id from g where v in ('BOB');    -- [1, 2]
```

So `=`, `<`/`>`, `order by`, `group by`, `distinct`, and `in` all honor a declared
`COLLATE` on an `any` column **today**. Only the declared-key BTrees (memory primary key,
memory secondary index) and the key encoders derived from them do not. Case 5 against case
4 is the sharpest statement of the inconsistency: `distinct` collapses two rows that
`unique` just admitted.

## Which direction, and why it is not really a choice

The source ticket left the direction open — honor the collation, or declare a `COLLATE` on
an `any` column meaningless. **Honor it.** Case 3 settles it: an index `COLLATE NOCASE` on
an undecorated `any` column already returns wrong rows, and no amount of ignoring the
*column's* collation fixes that — the index's own `COLLATE` would have to be rejected too.
And case 5 shows the "meaningless" reading would have to change six collation-honoring
paths (`=`, ranges, `order by`, `group by`, `distinct`, `in`) to align with the two broken
ones, silently flipping answers for every existing query over such a column.

`ANY`'s value space is exactly what `compareSqlValuesFast` was written for: it already
ranks mixed storage classes by class and only consults the collation function for a
TEXT/TEXT pair. So honoring the collation is total and needs no new comparison logic.

The invariant to hold: **creating an index never changes a query's result**, and a memory
table and a store-backed table return the same rows for the same data.

## The change

### Engine

Add an explicit marker to `LogicalType` rather than special-casing `ANY_TYPE` by object
identity — the store already learned that lesson for `JSON_TYPE` (the engine and the store
can be two module instances with two distinct singletons, which is why
`storeSemanticKeyTransform` matches JSON by `name`).

```ts
/**
 * True when {@link compare} actually applies the collation function it is handed
 * (TEXT, ANY). When unset, the type's compare is collation-blind, so a key
 * structure over such a column must be keyed under BINARY regardless of the
 * column's declared COLLATE — see `pkKeyCollationName`.
 */
collationAware?: boolean;
```

Set it on `TEXT_TYPE` and `ANY_TYPE`. Leave it unset on JSON and the temporal types: they
declare `supportedCollations: []`, so a *column* of those types can never carry a
non-BINARY collation, and their orders (structural / elapsed-time / hard-BINARY) are not
reproducible from a collation. JSON was checked and is not affected by this bug — with
`create index ixj on j (v collate nocase)` its answers agree before and after the index,
because `JSON_TYPE` carries `semanticOrdering` and the comparison path routes around the
collation entirely.

Then:

- `ANY_TYPE.compare: (a, b, collation) => compareSqlValuesFast(a, b, collation ?? BINARY_COLLATION)`.
- `pkKeyCollationName` (`planner/analysis/comparison-collation.ts`) switches its textual
  branch from `logicalType.isTextual` to the new flag:
  `return isCollationAware(column.logicalType) ? column.collation : 'BINARY'`.
  Rewrite its doc block — it currently *explains* the bug as the reason `any` keys BINARY.

Note what does **not** move: `resolveDefaultCollation` gates the session `default_collation`
on `supportedCollations?.includes(...)`, and `ANY_TYPE` declares no list, so an *undecorated*
`any` column's collation stays `'BINARY'` even under a non-BINARY session default. Its key
bytes are therefore unchanged. Only a column (or index column) with an explicit
non-BINARY `COLLATE` moves. Confirm this rather than assuming it — it is the difference
between "one rare shape re-keys" and "every `any` column re-keys".

### Store (`quereus-store`)

`resolvePkKeyCollations` and `resolveIndexKeyCollations` delegate to `pkKeyCollationName`,
so they follow automatically — but three order-safety gates then start *admitting* a shape
they deliberately decline today, and that is the part to verify rather than assume:

- `indexPrefixSeekIsCollationExact` — key collation now equals the residual collation for
  an `any collate nocase` index column, so the equality window is claimed.
- `indexLeadingRangeIsOrderSafe` / `keyOrderMatchesCollation` — same, plus the
  `orderPreserving` assertion, which NOCASE/RTRIM/BINARY all carry (stamped at
  registration in `core/database.ts`). Range windows open up too.
- `pkOrderPreservingPrefixLength` — its inline `NOTE` about `k any collate nocase`
  declining becomes false; delete or rewrite it.

Every doc block in `pk-key-resolution.ts` that says "text-capable but not `isTextual`
(`any`, `json`, the temporal types) → hard-coded `'BINARY'` — those types' `compare`
ignores collation" must drop `any` from that list and re-state the rule in terms of the
new flag. There are five such passages.

`reconcilePkCollations` (`store-module-schema-rewrite.ts`) is gated on
`col.logicalType.isTextual` and should **stay** that way: an undecorated `any` PK column
compares under BINARY in the engine, so rewriting it to the table key collation K would
re-open exactly the key-vs-compare mismatch this ticket closes. Leave it, and say so in a
comment so the next reader does not "fix" the asymmetry.

Check that `StoreTableBase.validateKeyCollations` accepts a non-BINARY name on an `any`
key column (it needs a registered normalizer; NOCASE has one).

On-disk index/PK bytes change for `any` columns carrying an explicit non-BINARY `COLLATE`.
Per AGENTS.md, backwards compatibility is not a concern yet — but state the change in the
review handoff.

### Isolation (`quereus-isolation`)

`IsolatedTable`'s overlay key normalizers and `canSeekForConstraint` both read
`pkKeyCollationName`, so both follow automatically. `canSeekForConstraint`'s doc block
lists `any` among the not-seekable shapes — rewrite that bullet.

### Tests to re-derive (not delete)

These state the current contract and were written knowing it was a compromise. In almost
every case the **answer** assertions stay green and only the **plan-shape** assertions
(`to.not.match(SEEK)`) flip — check each rather than assuming:

- `quereus-store/test/collation-order-preserving.spec.ts` — "declines BOTH arms on an
  `any` column carrying a declared COLLATE". Its comment names this ticket by slug and
  says the memory backend is not the oracle for this shape; after the fix it is. Keep the
  before/after-index equality assertions, flip the two `not.match(SEEK)` to `match(SEEK)`.
- `quereus-store/test/pushdown.spec.ts` — "collation-unsafe index over an ANY column
  declines the seek but stays correct". Same shape.
- `quereus-store/test/index-column-collation.spec.ts` — the unit expectation
  `resolveIndexKeyCollations(...)` → `[undefined, 'BINARY']` for `v any collate nocase`
  becomes `[undefined, 'NOCASE']`.
- `quereus-store/test/unique-constraints.spec.ts` — "an ANY column with a declared COLLATE
  falls back to the full scan": the assertions (dup rejected, `count = 1`) hold either
  way; only the comment's rationale is now wrong. The adjacent JSON case is unaffected and
  must stay.
- `quereus-store/test/isolated-store.spec.ts` — "an ANY column with a declared COLLATE
  declines the seek and still catches the collision": now seeks; it must still catch.
- `quereus-isolation/test/isolation-layer.spec.ts` — `ANY COLLATE NOCASE PRIMARY KEY`
  (~line 530) and `email any collate nocase` (~line 6136).
- `quereus-store/test/key-set-seek-store.spec.ts` (~line 437),
  `runtime-key-set-plan.spec.ts` (~line 257) — `any collate nocase` shapes; check both.

### New coverage

Add memory-backend regressions for cases 1–4 above — the memory backend has no test for
this shape at all today, which is why the divergence went unnoticed. A sqllogic file under
`packages/quereus/test/logic/` is the natural home for cases 1, 2 and 4; case 3 (index
`COLLATE` on an undecorated `any` column) needs no store module either. Assert the
before-index answer as the oracle and the after-index answer against it, so the test
states the invariant rather than today's numbers.

### Docs

- `docs/store.md` §"Per-column PK key collation" (~line 500): the bullet claiming
  `create table t (k any collate nocase primary key)` leaves the `nocase` "inert — honored
  neither in the key bytes nor in the comparison" is exactly what this ticket reverses.
  The same section's closing line calls the memory PK BTree "a memory-module defect, not a
  contract the store must match" — that defect is now fixed and the two agree; rewrite.
- `docs/types.md` (~line 395): "TEXT/ANY column's declared `compare` is not
  collation-aware" — half of that is no longer true. Document the new
  `LogicalType.collationAware` flag alongside `semanticOrdering` while you are there.

## TODO

Phase 1 — engine

- Add `collationAware?: boolean` to `LogicalType` with the doc block above; set it on
  `TEXT_TYPE` and `ANY_TYPE`.
- Make `ANY_TYPE.compare` accept and apply its `collation` argument.
- Switch `pkKeyCollationName`'s textual branch to the new flag; rewrite its doc block.
- Confirm an undecorated `any` column still resolves to collation `'BINARY'` under a
  non-BINARY session `default_collation` (so its key bytes do not move).
- Update the stale reasoning in `util/comparison.ts` — `createSemanticRowComparator`'s
  "TEXT/ANY … declared `compare` is not collation-aware and must not be consulted here",
  and `comparisonSemanticsDiffer`'s type list.

Phase 2 — backends

- Re-derive the five `pk-key-resolution.ts` doc passages that list `any` under
  "hard-coded BINARY"; delete the stale `NOTE` in `pkOrderPreservingPrefixLength`.
- Verify `StoreTableBase.validateKeyCollations` admits a non-BINARY collation on an `any`
  key column.
- Leave `reconcilePkCollations` gated on `isTextual`; add a comment saying why.
- Rewrite the `any` bullet in `IsolatedTable.canSeekForConstraint`'s doc block.

Phase 3 — tests and docs

- Add memory-backend regressions for repro cases 1–4 (and case 3, the index-`COLLATE`
  shape). State the invariant: the before-index answer is the oracle.
- Re-derive each listed store / isolation spec; keep every answer assertion, flip only the
  plan-shape ones that genuinely change.
- Update `docs/store.md` and `docs/types.md` as above.
- `yarn build`, `yarn test`, `yarn lint`. Run `yarn test:store` as well — this ticket
  changes on-disk key bytes for one column shape, which the memory-backed default suite
  cannot exercise.
