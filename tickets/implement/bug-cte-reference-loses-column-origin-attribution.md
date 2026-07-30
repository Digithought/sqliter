---
description: A query that reads from a `with` clause now uses the real collected statistics to guess how many rows a filter keeps, matching what the same query written as a subquery already did. The engine change is written and passing; what is left is the regression tests that pin it.
files:
  - packages/quereus/src/planner/util/column-origins.ts                      # the walk — changed
  - packages/quereus/src/planner/rules/predicate/rule-filter-selectivity.ts  # the consumer — changed
  - packages/quereus/src/planner/nodes/cte-reference-node.ts                 # unchanged; mints fresh attribute ids (line ~38)
  - packages/quereus/src/planner/nodes/cte-node.ts                           # unchanged; forwards its source's ids (line ~69)
  - packages/quereus/test/optimizer/column-origins.spec.ts                   # helper updated; needs new cases
  - packages/quereus/test/optimizer/filter-selectivity.spec.ts               # needs new cases
  - docs/optimizer.md                                                        # updated
difficulty: medium
---

# CTE columns keep their base-table attribution

## What was wrong

When the planner estimates how many rows a `where` clause keeps, it looks up the
filtered column's collected statistics. To do that it has to know which real table
column an output column came from — `collectColumnOrigins`
(`planner/util/column-origins.ts`) answers that by walking down the plan.

`CTEReferenceNode` re-publishes its body's columns under brand-new internal column
ids, so the walk lost the trail at every `with` clause. The same filter written as a
subquery or a view kept its estimate; written as a `with`, it fell back to a flat
guess. Results were always correct — only the row estimate, and therefore possibly
the chosen plan, differed.

Reproduced against `o(id integer primary key, cat text, qty integer)`, 100 rows,
`qty` with 7 distinct values, ANALYZEd:

| query | before | after |
| --- | --- | --- |
| `select * from o where qty = 3` | 0.142857 | 0.142857 |
| `select * from (select cat, qty from o) x where x.qty = 3` | 0.142857 | 0.142857 |
| `with c as (select cat, qty from o) select * from c where c.qty = 3` | **0.1** | 0.142857 |
| `with c as (select * from o) select * from c where c.qty = 3` | **0.1** | 0.142857 |

## The change already in the working tree

Both source edits are written, and `yarn test` (all workspaces) plus
`yarn workspace @quereus/quereus run lint` are green with them in place. Read them
before writing tests — the reasoning lives in the file doc-comments.

**`column-origins.ts`** — `ColumnOrigin.ref` (a `TableReferenceNode`) was doing two
jobs at once: standing for *which relation* an attribute came from, and providing the
`TableSchema` to look statistics up in. Those are now split:

```ts
/** Identity of one *instance* of a relation in the plan — compared by reference,
 *  never dereferenced. */
export type RelationInstance = object;

export interface ColumnOrigin {
	readonly relation: RelationInstance;   // was: ref: TableReferenceNode
	readonly table: TableSchema;           // unchanged — the schema role
	readonly columnIndex: number;
	readonly columnName: string;
}
```

A `TableReferenceNode` is its own `RelationInstance`. The walk no longer descends
through a `CTEReferenceNode`; it maps the body's origins positionally onto the
reference's own attribute ids (`CTEReferenceNode` builds its list one-for-one from
`CTENode`'s, and `CTENode` forwards its source's ids verbatim), and mints a **fresh
`RelationInstance` per reference, one per underlying relation**. That last part is
the whole reason a plain positional remap would not do: two references to one `with`
clause share a single body subtree (confirmed — the plan for a CTE self-join holds two
`CTEReference` nodes, one `CTE` node and one `TableReference`), so re-using the body's
instances would collapse both arms into one relation.

Body origin maps are memoized per `collectColumnOrigins` call, so a CTE referenced N
times walks its body once.

**`rule-filter-selectivity.ts`** — identity comparisons moved from `origin.ref` to
`origin.relation`; `conjunctRelations` now returns `Map<RelationInstance, TableSchema>`
instead of `Set<TableReferenceNode>` so the single-relation branch still has a schema
to hand the provider.

**`docs/optimizer.md`** — the "currently estimates nothing" note is replaced by a
"A CTE reference publishes its own relation instances" paragraph, and the two places
that said origins are keyed on the `TableReferenceNode` instance now say relation
instance.

## Behaviour verified by hand (needs to become tests)

Against `o(id, cat, qty, rid)` — ndv cat 4, qty 7, rid 20 — and `r(id, cat, qty)` —
ndv cat 3, qty 5 — both ANALYZEd:

| shape | stamped selectivity | why |
| --- | --- | --- |
| `with c as (select cat, qty from o) select * from c where c.qty = 3` | `1/7` | plain base column through a CTE |
| `with c(x, y) as (select cat, qty from o) … where c.y = 3` | `1/7` | CTE column-alias list |
| `with a as (…), b as (select * from a) … where b.qty = 3` | `1/7` | nested CTEs |
| `with c as materialized (…)` / `not materialized (…)` | `1/7` | hint is irrelevant |
| `with c as (select cat, id * 7 as qty from o) … where c.qty = 3` | naive `0.1` | computed column, *same* answer as the `as zz` spelling |
| `with c as (select * from o) select … from c a join c b on a.id = b.id where a.qty > b.qty` | `1/3` | cross-relation inequality — the two arms stayed distinct |
| same, `where a.qty = b.rid` | `1/max(7,20) = 0.05` | cross-relation equi, specifically **not** `1/7` |
| same, `where a.cat = 'a' and a.qty > b.qty` | `combineConjunctive([1/4, 1/3])` | one single-relation conjunct plus one cross-relation |
| CTE body is itself a join, `where c.ocat = 'a' and c.rcat = 'x'` | `combineConjunctive([1/4, 1/3])` | two relations inside one reference stay distinct |
| CTE body is a join, `where c.oqty = c.rqty` | `1/max(7,5) = 1/7` | cross-relation *within* one CTE reference |
| `with c as (select cat, qty, rid from o) select … from c join r on c.rid = r.id where c.cat = 'a' and r.cat = 'x'` | `combineConjunctive([1/4, 1/3])` | CTE joined to a real table |
| `with c as (select id, cat from o union all select id, cat from r) … where c.cat = 'a'` | unstamped | set operation in the body stays opaque |
| `with c as (select cat, count(*) as ct from o group by cat) … where c.ct > 2` | unstamped | aggregate output has no base-table origin |
| `with recursive c(qty) as (select qty from o union all select qty + 1 from c where qty < 50) select * from c where qty = 3` | unstamped | already covered by an existing test, still passing |

## What is left

Regression coverage only — none of the above is pinned by a test yet, and the one
existing CTE case in `column-origins.spec.ts` ("dedupes shared subtrees rather than
walking them twice") is a consistency check that passes either way. Without new tests
the next refactor silently reverts this.

Note also that `column-origins.spec.ts`'s `distinctRefs` helper was retyped to read
`o.relation`; nothing else in the tree referenced `ColumnOrigin.ref`.

## TODO

- Re-read `packages/quereus/src/planner/util/column-origins.ts` and
  `rule-filter-selectivity.ts` as they now stand; confirm the doc-comments match the
  code before adding tests around them.

- Add cases to `packages/quereus/test/optimizer/filter-selectivity.spec.ts`. The
  existing `describe('single-table selectivity matches columns by identity, not by
  name')` block already has the right fixture (`o` with cat 4 / qty 7 distinct) for
  the single-relation ones; the `describe('multi-relation filter selectivity (filter
  over a join)')` block has `o` + `r` for the rest.
  - a filter over a CTE column that is a plain base column stamps `1/ndv(qty)`, and
    equals what the same query written as a subquery stamps — assert the two are
    equal rather than only pinning the constant
  - a filter over a column *computed* inside the CTE body stamps the same value under
    two different alias spellings (`as qty` colliding with a real column vs `as zz`),
    and specifically not `1/ndv(o.qty)` — mirror the existing computed-projection test
  - the CTE self-join `a.qty = b.rid` stamps `1/max(ndv(qty), ndv(rid))` and
    specifically **not** `1/ndv(qty)`; this is the assertion that fails if the
    per-reference relation instance is dropped
  - the CTE self-join `a.cat = 'a' and a.qty > b.qty` stamps
    `combineConjunctive([1/ndv(cat), CROSS_RELATION_INEQUALITY_SELECTIVITY])`
  - a CTE whose body is itself a join keeps its two sides distinct
  - a CTE body containing `union all`, and one containing `group by`, leave the filter
    unstamped
  - the CTE column-alias list form (`with c(x, y) as …`) still resolves

- Add cases to `packages/quereus/test/optimizer/column-origins.spec.ts` at the level
  of the map itself, so a failure points at the walk rather than at the estimate:
  - a single CTE reference contributes one relation instance and one entry per
    republished base column, each `columnIndex` addressing its own `columnName`
  - two references to one CTE contribute **two** distinct relation instances sharing
    one `TableSchema` — the CTE analogue of the existing self-join test
  - a column computed inside the CTE body has no entry
  - a recursive CTE reference contributes nothing (guards the `isRowMerging(body)`
    early return; the ticket that raised this asked specifically that the fix not
    reach through a recursive CTE)

- Run `yarn test` and `yarn workspace @quereus/quereus run lint` from the repo root
  (the lint script also type-checks the spec files, which the ts-node test runner does
  not).
