---
description: A query that reads from a `with` clause now guesses how many rows a filter keeps using the real collected statistics, matching what the same query written as a subquery already did. Engine change plus the regression tests that pin it are done.
files:
  - packages/quereus/src/planner/util/column-origins.ts                      # the walk — changed (landed in the fix-stage commit)
  - packages/quereus/src/planner/rules/predicate/rule-filter-selectivity.ts  # the consumer — changed (same commit)
  - packages/quereus/src/planner/nodes/cte-reference-node.ts                 # unchanged; mints fresh attribute ids (buildAttributes, ~line 38)
  - packages/quereus/src/planner/nodes/cte-node.ts                           # unchanged; forwards its source's ids (buildAttributes, ~line 69)
  - packages/quereus/test/optimizer/column-origins.spec.ts                   # +4 cases (this ticket)
  - packages/quereus/test/optimizer/filter-selectivity.spec.ts               # +9 cases (this ticket)
  - docs/optimizer.md                                                        # updated (fix-stage commit)
difficulty: medium
---

# CTE columns keep their base-table attribution

## What this is

When the planner estimates how many rows a `where` clause keeps, it looks up the
filtered column's collected statistics. To do that it has to know which real table
column an output column came from — `collectColumnOrigins`
(`planner/util/column-origins.ts`) answers that by walking down the plan.

`CTEReferenceNode` re-publishes its body's columns under brand-new internal column
ids, so the walk lost the trail at every `with` clause. The same filter written as a
subquery or a view kept its estimate; written as a `with`, it fell back to a flat
0.1 guess. Query results were always correct — only the row estimate, and therefore
possibly the chosen plan, differed.

## What landed

**Engine (already committed by the fix stage, unchanged by this ticket).**

`ColumnOrigin.ref` (a `TableReferenceNode`) was doing two jobs: standing for *which
relation* an attribute came from, and supplying the `TableSchema` to look statistics
up in. Those are now split — `ColumnOrigin.relation` is an opaque `RelationInstance`
token compared by reference and never dereferenced, `ColumnOrigin.table` keeps the
schema role.

The walk does not descend through a `CTEReferenceNode`. It maps the body's origins
positionally onto the reference's own attribute ids, and mints a **fresh
`RelationInstance` per (reference, underlying relation) pair**. That last part is the
crux: two references to one `with` clause share a single body subtree, so re-using the
body's instances would collapse both arms of a CTE self-join into one relation and
`rule-filter-selectivity` would read `a.qty > b.qty` as "a column compared to a
constant". Body origin maps are memoized per `collectColumnOrigins` call.

`rule-filter-selectivity.ts` moved its identity comparisons from `origin.ref` to
`origin.relation`; `conjunctRelations` returns `Map<RelationInstance, TableSchema>`
instead of `Set<TableReferenceNode>`.

**Tests (this ticket).** 13 new cases, all passing.

`test/optimizer/column-origins.spec.ts` — at the level of the origin map itself, so a
failure points at the walk rather than at the estimate:

- a CTE reference contributes one relation instance and one entry per republished base
  column, keyed by the **reference's own** attribute ids, each `columnIndex` addressing
  its own `columnName`
- two references to one CTE contribute **two** distinct relation instances sharing one
  `TableSchema` (this replaced the old `dedupes shared subtrees` case, which used the
  same query but asserted nothing that could fail)
- a column computed inside the CTE body has no entry
- a recursive CTE reference contributes nothing

`test/optimizer/filter-selectivity.spec.ts` — end-to-end stamped selectivity:

- a filter over a plain CTE column stamps `1/ndv(o.qty)` **and equals** what the same
  query spelled as a subquery stamps
- five CTE spellings that only vary the column list all stamp `1/ndv(o.qty)`:
  `select *` body, column-alias list `with c(x, y) as …`, nested CTEs, `as materialized`,
  `as not materialized`
- a column computed inside the CTE body stamps the same value under two alias
  spellings (`as qty` colliding with a real column vs `as zz`), and not `1/ndv(o.qty)`
- CTE self-join `a.qty = b.rid` stamps `1/max(ndv(qty), ndv(rid))`, explicitly not
  `1/ndv(qty)`
- CTE self-join `a.cat = 'a' and a.qty > b.qty` stamps
  `combineConjunctive([1/ndv(cat), CROSS_RELATION_INEQUALITY_SELECTIVITY])`
- a CTE body that is itself a join keeps its two sides distinct (`c.ocat` / `c.rcat`),
  and a cross-relation equality *within* one reference (`c.oqty = c.rqty`) estimates
  from `joinSelectivity`
- a CTE joined to a real table combines both sides
- a CTE body containing `union all`, and one containing `group by`, leave the filter
  unstamped

## Validation performed

- `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js
  "packages/quereus/test/optimizer/column-origins.spec.ts"
  "packages/quereus/test/optimizer/filter-selectivity.spec.ts"` — 77 passing.
- `yarn test` (all workspaces, from repo root) — green; quereus core 8142 passing,
  13 pending. No failures anywhere.
- `yarn workspace @quereus/quereus run lint` — exit 0 (eslint + `tsc -p
  tsconfig.test.json --noEmit`).

**Two negative controls were run against a temporarily-broken engine, then reverted**
(`git diff -- packages/quereus/src/` confirmed byte-identical afterwards):

| control | new tests that failed |
| --- | --- |
| CTE branch removed from the walk (pre-fix behaviour) | 10 of 13 |
| positional remap kept, but the body's own relation instances re-used instead of minting per-reference ones | 2 of 13 — `gives two references to one CTE distinct relation instances sharing one schema` and `treats the two arms of a CTE self-join as distinct relations` |

## Known gaps — read before signing off

- **`still estimates a single-relation conjunct over one arm of a CTE self-join`
  survives the shared-instance control.** With shared instances `a.qty > b.qty` becomes
  a single-relation conjunct, and the catalog provider apparently answers a `>` between
  two bare columns with the same 1/3 the cross-relation path uses — so the combined
  number is unchanged. The case still documents that the single-relation resolver
  accepts a column of one arm, but it is **not** a discriminator for the per-reference
  instance. `treats the two arms of a CTE self-join as distinct relations` is the one
  that binds. Worth deciding whether that coincidence deserves its own assertion.
- **Memoization is not pinned.** `BodyOriginCache` is what stops a CTE referenced N
  times from walking its body N times, and no test observes it — a refactor could drop
  it and stay green. It is a performance property only; correctness is unaffected.
  Note the cache lives *inside* one `collectColumnOrigins` call, so a stack of N
  filters over one CTE still re-walks the body N times; that is the same O(N·subtree)
  already flagged in the `NOTE:` at `rule-filter-selectivity.ts` (~line 100).
- **No end-to-end result-correctness tests were added** (no `.sqllogic`). The change
  moves estimates only, never rows, and existing logic tests already cover CTE results —
  but that is an argument, not a check.
- **Shapes not covered:** a CTE reference inside a correlated subquery; a `with` clause
  attached to `insert`/`update`/`delete`; a CTE whose body reads a view or a
  materialized view; a CTE referenced 3+ times. Nothing suggests these are broken; they
  are simply unexercised.
- **Pre-existing, unchanged by this ticket:** a stamped selectivity above a join still
  does not move `estimatedRows`, because `JoinNode.computePhysical` reads its children's
  *logical* `estimatedRows` and a physical access node exposes none. Documented in the
  `NOTE:` at `rule-filter-selectivity.ts` (~line 185) and tracked in backlog
  `debt-join-rows-from-physical-children`.
- **SQL casing.** New cases in `filter-selectivity.spec.ts` are uppercase to match the
  ~60 existing statements in that file; new cases in `column-origins.spec.ts` are
  lowercase to match that file. AGENTS.md prefers lowercase throughout — file-local
  consistency was chosen over a mixed-case describe block. Flagging in case the
  reviewer wants the whole file converted instead.
