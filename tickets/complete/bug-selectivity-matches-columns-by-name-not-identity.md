---
description: The planner used to guess how many rows a filter keeps by matching the filtered column to table statistics by name, so a computed column that reused a real column's name borrowed that column's statistics. It now matches by column identity instead.
files:
  - packages/quereus/src/planner/stats/index.ts                              # ColumnStatsResolver type + optional `resolve` params
  - packages/quereus/src/planner/stats/catalog-stats.ts                      # EstimateContext threading; both extract* helpers
  - packages/quereus/src/planner/rules/predicate/rule-filter-selectivity.ts  # hoisted origins map, makeResolver, three narrowings
  - packages/quereus/src/planner/util/column-origins.ts                      # "Known gap" section added in review
  - packages/quereus/test/optimizer/filter-selectivity.spec.ts               # 7 end-to-end tests
  - packages/quereus/test/planner/stats/catalog-stats.spec.ts                # 6 provider-level resolver tests added in review
  - docs/optimizer.md                                                        # Statistics Abstraction + filter-selectivity sections
difficulty: medium
---

# Complete: filter selectivity resolves columns by attribute identity

## What shipped

A `where` clause's estimated selectivity used to be looked up by the **name** written in
the predicate's column reference, so any column carrying that name got that name's
statistics whether or not it was the base table's column. `select id * 7 as qty from o`
— arithmetic that merely happens to be aliased `qty` — was charged `o.qty`'s distinct
count, and renaming the alias moved the planner's row estimate.

The fix threads an optional column resolver from `rule-filter-selectivity` into
`CatalogStatsProvider`:

```ts
export type ColumnStatsResolver = (attributeId: number) => string | undefined;
```

It maps a column reference's *attribute id* — the planner's identity token for a column
— back to the base-table column it actually is, using the `collectColumnOrigins` map
that already existed for routing conjuncts to relations. An attribute with no
base-table origin resolves to nothing and the estimate declines rather than borrowing a
same-named column's statistics. `selectivity`, `statsOnlySelectivity` and
`joinSelectivity` each gained a trailing optional `resolve` parameter; inside
`catalog-stats.ts` the statistics and the resolver travel together as a private
`EstimateContext` so the six recursive methods keep two-parameter signatures.

`collectColumnOrigins` was hoisted to the top of the rule so both the single-table and
the multi-relation path get it, and `makeResolver(origins, accept)` narrows the map per
call site: schema equality on the single-table path, `TableReferenceNode` **instance**
equality for a single-relation conjunct (so the two arms of a self-join stay separate),
and accept-all for a cross-relation conjunct whose two origins were already resolved and
stats-checked immediately above.

Measured effect (100-row `o`, `cat` 4 distinct, `qty` 7 distinct, analysed):

| query | before | after |
|---|---|---|
| `select * from (select cat, id * 7 as qty from o) x where x.qty = 3` | `0.142857` | `0.1` |
| `select * from (select cat, id * 7 as zz from o) x where x.zz = 3` | `0.1` | `0.1` |
| `select * from (select cat as qty from o) x where x.qty = 'a'` | `0.1` | `0.25` |
| `select * from (select cat, qty from o) x where x.qty = 3` | `0.142857` | `0.142857` |
| `select * from o where qty = 3` | `0.142857` | `0.142857` |

Only estimates ever changed — returned rows were always correct, before and after.

## Review findings

Reviewed the implement diff (`04304a9d`) against the source files it touched and the
ones it should have touched, then ran lint and the full suite.

### Major — one regression found, ticket filed

**A filter over a `with` clause lost its statistics-derived estimate.** Reproduced on
this tree with an analysed table:

```
select * from o where qty = 3                                      -- 0.142857 (1/7, correct)
with c as (select cat, qty from o) select * from c where c.qty = 3 -- 0.1 (naive guess) — was 0.142857 before this change
```

`CTEReferenceNode` allocates brand-new attribute ids for every column it republishes,
while `extractRowSourceTableSchema` still walks straight through it to the base table.
So the single-table path runs, but no attribute under the CTE reference is in the origin
map and every column resolves to nothing. The old name matching got this right by luck
(the name "qty" survived the CTE), which is why it reads as a regression rather than a
pre-existing hole.

Not fixed inline, because the obvious fix is wrong: two references to one CTE **share a
single plan subtree** (verified — the plan for a CTE self-join contains two
`CTEReference` nodes over exactly one `TableReference`), so pairing the fresh ids
positionally with the body's would resolve both arms of `a.qty > b.qty` to the same
origin and collapse a two-relation predicate into a one-relation one. A correct fix
needs a per-reference identity for CTE-republished columns, which is a change to the
`ColumnOrigin` shape — a design call, not a review edit.

Filed as `fix/bug-cte-reference-loses-column-origin-attribution` (top-priority stage,
picked next) with the reproduction, the shared-subtree evidence, and the expected
behaviour. Parked a "Known gap" section in `column-origins.ts` and a paragraph in
`docs/optimizer.md` so the limitation is discoverable from both the code and the docs
until it lands.

Scope of the gap was bounded, not guessed: every use of `PlanNode.nextAttrId()` under
`planner/nodes/` was inspected. `CTEReferenceNode` is the only operator that both
re-mints ids and is descended by the origins walk. Aggregates, set operations and
recursive CTEs are already excluded from the walk; computed projections and window
outputs mint only for genuinely new columns (`WindowNode` forwards its source
attributes verbatim and appends).

### Minor — fixed in this pass

**No direct provider-level coverage of the new `resolve` parameter.** The
implementation's 7 tests are all end-to-end through the optimizer, so the optional-
parameter contract itself was only exercised indirectly — a provider change could break
it with the rule still masking the failure. Added a `ColumnStatsResolver` describe block
to `test/planner/stats/catalog-stats.spec.ts` (6 tests): resolved column wins over the
AST name; unresolvable attribute falls to the naive guess (`selectivity`) and to
`undefined` (`statsOnlySelectivity`); the deliberate first-unresolvable-child bail-out
and its operand-order asymmetry; both sides of an equi-join resolved by identity; an
equi-join with one unresolvable side; and the resolver threading down through a `NOT`.
`mockColumnRef` gained an optional `attributeId` argument (defaulted, so no existing
call site changed). AND/OR could not be driven from these mocks — `splitConjuncts` gates
on `instanceof BinaryOpNode` — which the file already documents; `UnaryOp` is the one
non-leaf hop reachable, and it is covered.

### Tripwires — recorded, not ticketed

- **`indexSelectivity` does not thread a resolver**, so its delegated estimate still
  matches by name. It has no production caller today (only its own tests), so nothing is
  wrong now. `NOTE:` added at the method in `catalog-stats.ts` telling the first
  production caller to widen the signature.
- **The origins walk now runs for every Filter, not only filters over joins**, so a
  stack of N filters over one subtree is O(N·subtree). The implementer's `NOTE:` at the
  `collectColumnOrigins` call already records this and the two escape hatches; verified
  it is accurate and left in place.

### Checked and found clean

- **`joinSelectivity` argument alignment.** `extractEquiJoinColumns` reads the pair off
  the condition's own child order and `crossRelationConjunct` derives `leftOrigin` from
  `conjunct.left`, so `colNames.left` and `leftTable` still describe the same side under
  the resolver. FK→PK shortcut unaffected.
- **The three narrowing predicates.** Reference identity on the single-relation conjunct
  is load-bearing and is pinned by the implementer's self-join test; schema equality on
  the single-table path is sound because the strict walk proves a single-relation chain;
  accept-all on the cross-relation path is safe because both origins are resolved and
  stats-checked before the resolver is built.
- **Docs.** Read `docs/optimizer.md` and both touched file doc-comments against the new
  behaviour. The implementer's correction to the "which source qualifies for the
  single-table path" paragraph is right — the old text justified the strict walk by name
  resolution, which is no longer true. Added the CTE gap; nothing else was stale.
- **Source hygiene.** `catalog-stats.ts` 638 lines, `rule-filter-selectivity.ts` 364,
  `stats/index.ts` 194 — all reasonable for their content. `EstimateContext` is the right
  call over a seventh parameter on six methods; `makeResolver` is a two-line closure
  factory with three call sites, not over-abstraction.
- **No error-handling, resource-cleanup or type-safety issues.** The change adds no I/O,
  no allocation that outlives a call, no `any`, and no new `unknown` casts beyond the
  file's existing structural-introspection idiom.
- **Behaviour the implementer flagged and deliberately left**: the column-vs-column
  `where x = y` single-table case still models "x equals a constant" (pre-existing, has
  its own `NOTE:`); `distinctValues` stays name-keyed by contract; the resolver closure
  allocated in `crossRelationConjunct`'s inequality branch is one closure per conjunct
  and reordering the branch for it would cost more readability than it saves. All three
  confirmed as correct calls — no action.

### Validation

- `yarn workspace @quereus/quereus run lint` (eslint + `tsc -p tsconfig.test.json`) —
  clean.
- `yarn build` — clean.
- `yarn test` (all workspaces) — **quereus 8130 passing, 13 pending, 0 failing**; every
  other package green. 8124 → 8130 is exactly the 6 tests added in review.
- No pre-existing failures surfaced, so `tickets/.pre-existing-error.md` was not written.
