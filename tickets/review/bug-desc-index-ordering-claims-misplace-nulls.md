---
description: Sorting a column that can hold blanks in descending order used to put the blank rows at the wrong end whenever the engine took a shortcut through a matching index; the shortcut is now refused unless the blanks are provably absent, so the answer no longer depends on which indexes exist.
files:
  - packages/quereus/src/vtab/best-access-plan.ts                   # NEW: nullSafeOrderingPrefixLength + NULL_EXCLUDING_OPS (~line 152)
  - packages/quereus/src/index.ts                                   # re-export (~line 113)
  - packages/quereus/src/vtab/memory/module.ts                      # indexSatisfiesOrdering (~1047) + buildMonotonicAdvertisement (~579)
  - packages/quereus-store/src/common/store-module-access-plan.ts   # local copy deleted; buildPkOrderingAdvertisement gated (~1382)
  - packages/quereus/test/optimizer/desc-index-ordering.spec.ts     # NEW describe: 'DESC index — NULL placement gate' (6 cases)
  - packages/quereus/test/logic/10.5.3-desc-index-ordering.sqllogic # section 3 rewritten
  - packages/quereus-store/test/index-ordering.spec.ts              # NEW describe: 'primary-key ordering advertisement: NULL placement gate' (8 cases)
  - docs/module-authoring.md                                        # line 180 — capability contract updated to point at the shared helper
difficulty: medium
---

# Review: DESC ordering claims no longer misplace NULLs

## What the rule is

`ORDER BY` in this engine places NULLs **first for both directions**. Placement is
absolute, never conditioned on ASC/DESC — that is `orderByNullResult` in
`packages/quereus/src/util/comparison.ts`.

Both storage backends disagree with that on a **descending** key column. The store
bit-inverts the column's key bytes, so NULL's low `0x00` tag ends up at the end of the
walk; the memory module negates the ascending comparator, and NULL is the lowest value, so
negation sends it to the end too. An **ascending** column agrees with the engine, so only
DESC columns were ever affected.

When a module claimed `providesOrdering` over such a column, the sort-absorption rule
deleted the Sort with no further check and the NULL rows came out at the wrong end. Same
query, two answers, depending on whether the index existed.

Columns are **NOT NULL by default** in this engine — a column is only exposed once it is
explicitly declared `null`. That is what keeps the blast radius small and why the existing
DESC suites (all plain `integer` / `text` columns) stayed green untouched.

## What changed

**One shared predicate, in core.** `nullSafeOrderingPrefixLength` now lives in
`packages/quereus/src/vtab/best-access-plan.ts` and is exported from the package root. It
truncates an ordered key's order-preserving prefix at the first DESC column a NULL could
reach. A DESC column survives when **any** of: it is declared NOT NULL; it is pinned by
this plan's own equality; or a pushed filter on it is NULL-excluding (`=`, `IN`, the four
range ops, `IS NOT NULL`). It takes the key columns as `ReadonlyArray<IndexColumnSchema>`,
which `PrimaryKeyColumnDefinition[]` also satisfies structurally — so an index's `columns`
and a table's `primaryKeyDefinition` both go in unchanged.

The store's local copy was deleted and its two call sites repointed. Its doc comment moved
across and was rewritten: the old one asserted that the memory module "has no NULL check"
and named this ticket as an open bug, both of which have stopped being true.

**Memory module — `indexSatisfiesOrdering`** now takes `tableInfo` and `request` (both
callers already had them in scope) and ends with
`nullSafeOrderingPrefixLength(..., i, equalityCols) === i`, where `i` is the number of
leading index columns the match actually consumed. It is a boolean rather than a
truncation because both callers claim `request.requiredOrdering` verbatim, all or nothing.
Judging only the *consumed* prefix matters: a nullable DESC column sitting beyond the match
is not part of the claim and must not disqualify the index. The primary key flows through
here as a pseudo-index (`gatherAvailableIndexes`), so a nullable DESC PK member is covered
with no `create index` involved.

**Store — `buildPkOrderingAdvertisement`** truncates its order-preserving prefix a second
time against the PK definition, and returns `{}` outright at prefix 0 — which drops
`monotonicOn` and `supportsAsofRight` along with `providesOrdering`.

## The two judgement calls — please check these specifically

**1. `supportsAsofRight` was settled by making it ride on `monotonicOn`, not by a separate
gate.** Its own declaration says it "implies `monotonicOn` is set", so the two are dropped
together whenever the leading key member is unclaimable, and kept together otherwise. I did
not analyse independently whether a forward-only asof reposition is *additionally* broken
by NULL placement on a claimable prefix — I argued only that a leading member good enough
for `monotonicOn` is good enough for asof. If that reasoning is wrong the fix is
under-tight, not over-tight.

**2. I gated one site the ticket did not name: memory's `buildMonotonicAdvertisement`**
(`packages/quereus/src/vtab/memory/module.ts`, ~line 612). It builds `direction: 'desc'`
from a nullable DESC leading column by exactly the same reasoning the store's PK
advertisement did, and the ticket's argument for treating the store's `monotonicOn` as an
arm applies verbatim. Gating it is four lines. Scope call — revert it if you disagree; no
test depends on it (see the gap below).

## Honest gaps

- **The `monotonicOn` arms are preventative, not repro-backed.**
  `deriveOrderingFromMonotonicOn` (`planner/framework/physical-utils.ts:243`) — the
  function the ticket cited as the second route back into an ordering claim — **has no
  callers today**. The other consumer that would expose it,
  `rule-monotonic-limit-pushdown`, requires `accessCapabilities.ordinalSeek`, and **no
  shipped module advertises `supportsOrdinalSeek`** (memory has an explicit TODO deferring
  it at module.ts:563). So neither `monotonicOn` gate can be observed as a wrong answer
  from SQL right now. The store's gate is pinned at plan level (`monotonicOn` /
  `supportsAsofRight` asserted `undefined`); **memory's has no test at all**, because there
  is no consumer to observe it through. If you want that pinned, it needs a direct
  `getBestAccessPlan` call in the memory spec — that spec currently has no such helper, and
  adding one is a bigger change than the gate itself.

- **`OR_RANGE` is deliberately not in `NULL_EXCLUDING_OPS`.** It *is* a union of
  NULL-rejecting ranges and would be sound to include, but it already disqualifies an
  ordering claim on other grounds in both backends, so including it would only widen what
  has to be argued. Documented at the constant.

- **The PK arm passes `NO_PINNED_COLUMNS`.** The argument is that any pinning a PK
  equality/range arm does is already visible as a NULL-excluding entry in
  `request.filters`, which the helper consults itself — so an explicit pinned set would be
  redundant. Worth a second pair of eyes; if it is wrong, the effect is a lost optimization
  on some PK shape, not a wrong answer.

- **`tableInfo.columns[col.index]?.notNull`** — an out-of-range column index degrades to
  "nullable", i.e. declines. Safe direction, untested.

- I did **not** re-derive whether the store's index arms have shapes the previous ticket's
  gate missed; I only moved that code. Its behaviour is unchanged and its existing tests
  still pass.

## Validation

Every gate case was checked with a **negative control** — the gate was temporarily
neutralized, the suite re-run to confirm the new tests actually fail, then restored. Both
controls are gone from the tree (`grep -r TEMP-NEGATIVE-CONTROL packages/` is clean).

- Memory, gate returning `true` unconditionally → the two wrong-answer tests fail
  (`a nullable DESC secondary index keeps its Sort…`, `a nullable DESC primary-key
  member…`); the four "must still claim" tests stay green, so they are not passing by
  accident of a disabled optimization.
- Store, `claimablePrefix = orderPreservingPrefix` → four tests fail, including the plan-shape
  one that asserts the Sort survives.

Commands run, all clean:

| command | result |
| --- | --- |
| `yarn build` | clean |
| `yarn typecheck` | clean |
| `yarn lint` | clean |
| `yarn workspace @quereus/quereus test` | 10001 passing, 25 pending, 0 failing |
| `yarn workspace @quereus/store test` | 1905 passing, 0 failing |
| `yarn test` (all workspaces) | clean |
| `yarn test:store` (LevelDB-backed logic tests) | 9993 passing, 33 pending, 0 failing |

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

## Use cases to poke at

Every one of these should give the **same answer with and without the index**, which is
the property the whole ticket is about. `select count(*) from query_plan(?) where op =
'SORT'` is how the tests read the plan shape.

**Must keep the Sort (NULLs first, index refuses the claim):**

```sql
create table t (id integer primary key, n integer null) using memory;
create index ix on t (n desc);
insert into t values (1, 3), (2, null), (3, 1), (4, 2);
select n from t order by n desc;                 -- null, 3, 2, 1 — SORT present
```

```sql
-- no CREATE INDEX at all; the PK pseudo-index is the claimant
create table p (a integer null, b integer, primary key (a desc, b)) using memory;
insert into p values (3, 1), (null, 2), (1, 3), (2, 4);
select a from p order by a desc;                 -- null, 3, 2, 1 — SORT present
```

Both of the above also want running with `using store`, which is where arm 3 lived.

**Must still elide the Sort (the gate must not be a blanket decline):**

```sql
create table nn (id integer primary key, n integer not null) using memory;
create index ix on nn (n desc);
select n from nn order by n desc;                -- NOT NULL declared — SORT absent
```

```sql
select n from t where n > 1 order by n desc;     -- bound evicts every NULL — SORT absent
select b from q where a = 2 order by b;          -- equality pins the DESC leading col
select a from w order by a;                      -- (a asc, b desc), nullable b beyond the claim
```

**Truncation rather than voiding** — `create table pt (a integer, b integer null, primary
key (a, b desc))` in the store: the bare advertisement is `[a asc]` only, `monotonicOn`
survives on `a`, and a required `[a asc, b desc]` declines entirely.

**Explicit NULLS placement is unaffected either way** — `trySortAbsorbViaIndexOrdering`
refuses any sort key carrying an explicit `NULLS FIRST`/`NULLS LAST`, so those Sorts
already survived and still do (pinned in the sqllogic file and in the store spec).

## Doc + test-file changes worth eyeballing

- `packages/quereus/test/logic/10.5.3-desc-index-ordering.sqllogic` section 3: its only
  bare-ordering query was `... where val is not null order by val desc`, which sidestepped
  the bug via the NULL-excluding exception, under a comment ("Quereus default: NULLs last
  for DESC if specified that way") that misstated the engine rule. The comment is corrected
  and the unfiltered `order by val desc` case — the assertion that would have caught this —
  is added above it. The filtered query is kept, now labelled as the re-enable case.
- `docs/module-authoring.md` line 180 previously pointed module authors at
  `@quereus/store`'s private copy. It now names the exported helper, its signature, the
  boolean-vs-truncation distinction, the primary-key case, and the `monotonicOn` corollary.

Related and deliberately **not** duplicated here:
`backlog/debt-nothing-checks-advertised-row-order` proposes the debug-mode runtime guard
that would catch this whole class rather than these instances. It is the class-level fix
and is already filed.
