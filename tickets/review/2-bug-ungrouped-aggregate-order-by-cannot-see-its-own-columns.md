---
description: A query that only summarizes (e.g. counts rows) and then sorts by the summary's own column name used to fail with "Column not found"; it now returns the single row.
files:
  - packages/quereus/src/planner/building/select-aggregates.ts   # orderByNeedsPostAggregateSort + mentionsSelectListAlias — the routing decision
  - packages/quereus/src/planner/building/select-ordinal.ts      # SelectListEntry.alias
  - packages/quereus/src/planner/building/select.ts              # the "apply ORDER BY early" gate in buildSelectStmt
  - packages/quereus/test/logic/28.2-orderby-expression-extras.sqllogic  # new coverage (last section, table `g`)
  - docs/sql-select.md                                            # § 3.5 ORDER BY — alias precedence + pre-aggregate sort extension
difficulty: medium
---

# Implemented: ungrouped aggregate ORDER BY can name its own output columns

`select count(*) as c from g order by c` (and six sibling spellings) raised
`QuereusError: Column not found: c`. They now return the single row.

## What changed

**Arm 1 — routing** (`select-aggregates.ts`). `orderByContainsAggregates` was renamed
`orderByNeedsPostAggregateSort` — it no longer answers only about aggregates. It now
also answers true when an ORDER BY term mentions a bare (unqualified) column name that
is a SELECT-list alias. True routes the sort ABOVE the `AggregateNode`, where the
alias is in scope; false keeps the pre-aggregate sort extension (a `SortNode` BELOW the
aggregate, which is what makes `select group_concat(b) from g order by a` concatenate
in `a` order). The result field `orderByHasAggregates` was renamed to match.

The alias scan (`mentionsSelectListAlias`) uses `walkAstNodes` from
`planner/analysis/predicate-shape.ts` — reflective child discovery, so it cannot
silently miss a node kind the way a hand-written `switch` can.

**Arm 2 — placement** (`select.ts`). The early `applyOrderBy` block is now gated on
`hasOrderByOnlyAggregates` as well. Applying ORDER BY before the stripping final
projection is required only when ORDER BY introduced aggregates the select list does
not have; when it fired unconditionally it robbed ORDER BY of the projection's output
scope, which is the only place the alias of a *wrapped* aggregate (`count(*) + 1 as c`,
whose aggregate entry is aliased `count(*)`) is ever named. Everything else falls
through to the `applyOrderBy` at the bottom of the aggregate branch, which already
receives `aggregateProjectionScope`.

**Supporting.** `SelectListEntry` gained `readonly alias?: string`, populated from
`column.alias` in `buildSelectListEntries`. Star-expanded entries deliberately carry
none, so a star column's name cannot shadow a source column in this scan.

## Deviation from the ticket's prototype diff

The prototype's crude alias walk matched `type === 'column'` and read `.name`. That
**crashes** on any ORDER BY containing a subquery: `AST.ResultColumnExpr` (one item of
a SELECT list) is tagged `type: 'column'` too and has no `name`, and the reflective
walk reaches it. `select count(*) as zz from g order by (select 1)` died with
`Planning error: Cannot read properties of undefined (reading 'toLowerCase')`.

The shipped scan guards with `typeof col.name !== 'string'` and says why at the site.
The underlying AST tag collision is filed as
`backlog/debt-ast-result-column-shares-column-tag` (rung-1 fix: give the SELECT-list
node its own tag so the confusion is unrepresentable). It names a second, unconfirmed
site with the same shape — `predicateReferencesForeignColumns` in
`assertion-classifier.ts` — and says exactly what would confirm it.

## Behaviour change

A SELECT-list alias now outranks a same-named source column in an ungrouped
aggregate's ORDER BY, matching SQLite and what the non-aggregate and grouped paths
already do. Observable through an order-sensitive aggregate:

```sql
select group_concat(b) as a from g order by a desc;
-- before: "1,1,2"  (input sorted by column g.a desc, then concatenated)
-- after:  "1,2,1"  (alias `a` names the output column; sorting one row is a no-op)
```

Qualifying the name (`order by g.a desc`) keeps the pre-aggregate sort. Documented in
`docs/sql-select.md` § 3.5 as two new bullets — the pre-aggregate sort extension had
no prose anywhere in `docs/` before this, so the bullet introduces it as well as the
new precedence.

## Validation

- `yarn test` (whole workspace): **9396 passing, 0 failing, 25 pending** in
  `@quereus/quereus`; every other package green.
- `yarn lint`: clean. `yarn build`: clean.
- Single-file re-run after the last test edit:
  `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js
  "packages/quereus/test/logic.spec.ts" --grep "28.2-orderby"` → passing.

### New coverage — `test/logic/28.2-orderby-expression-extras.sqllogic`, final section

Table `g (id integer primary key, a text, b text)` with `(1,'p','1'), (2,'p','2'),
(3,'q','1')`. All seven originally-failing spellings, plus:

| case | pins |
|---|---|
| `order by c` / `order by c desc` | the base bug |
| `count(*) as c, max(a) as m … order by m` | the *second* aggregate's alias |
| `count(*) + 1 as c … order by c` | arm 2 (wrapped aggregate; alias only exists on the final projection) |
| `order by c + 1`, `order by c collate nocase` | alias inside a larger term |
| `count(*) as "C" … order by c` | case-insensitive alias match |
| `order by c, id`, `order by c limit 1`, `having count(*) > 0 order by c` | composition with a second key / LIMIT / HAVING |
| `group_concat(b) as a … order by a desc` | the new precedence |
| `group_concat(b) as gc … order by a desc, id` and `order by a, id` | the pre-aggregate sort extension is untouched |
| `group_concat(b) as a … order by g.a desc, id` | a qualifier defeats the alias |
| `select (select count(*) + 1 as c from g order by c) as v` and `… order by count(*)) as v` | scalar subquery, whose `ProjectNode` uses `preserveInputColumns: false` |
| `order by (select 1)` | the `ResultColumnExpr` guard (crashed before it) |
| `order by count(*)`, `order by 1`, `order by g.a` | non-regressions on the three pre-existing paths |
| `group by a order by c` and `order by c + 1` | grouped non-regressions |

## Known gaps — treat these as the floor, not the finish line

- **Ambiguous alias untested.** Two select-list columns aliased the same name
  (`select count(*) as c, max(a) as c from g order by c`) is not covered. The routing
  predicate deliberately does not arbitrate — it only asks "is this name mentioned" —
  and leaves resolution to the scope, which has its own ambiguity handling. Whether
  that produces a sensible error or silently picks one is unverified.
- **Compound / DISTINCT spellings probed but not pinned.**
  `select count(*) as c from g union all select count(*) from g order by c` and
  `select distinct count(*) as c from g order by c` were both checked by hand and
  return the expected rows; neither made it into the sqllogic file.
- **`order by c, id` binds `id` to something unexamined.** The query returns
  `[{"c":3}]`, which is right (one row, so any sort is a no-op), but I did not trace
  what `id` — an ungrouped bare column in an aggregate query — actually resolves to
  after the sort moved above the aggregate, nor compare against SQLite, which allows
  bare columns there with arbitrary-row semantics.
- **Over-approximation through subqueries** is deliberate and marked with a `NOTE:` on
  `mentionsSelectListAlias`: `order by (select … where x = c)` counts as mentioning `c`
  even when that `c` is the subquery's own column. The only consequence is losing the
  pre-aggregate ordering extension on a one-row result. Not covered by a test.
- **The renamed field has no compile-time story for external callers.**
  `orderByHasAggregates` → `orderByNeedsPostAggregateSort` is on an inline return-type
  literal, so a stale reader would be a type error; grep confirms `select.ts` was the
  only one.
- **Every expected row in the new coverage came from running the engine**, not from a
  SQLite cross-check. The values match what the ticket predicted where it predicted
  them, but a reviewer wanting SQLite parity should re-derive them independently.

## Review findings

- Tripwire parked as a `NOTE:` in the doc comment of `mentionsSelectListAlias`
  (`select-aggregates.ts`): the alias scan descends into subquery operands and
  over-approximates; harmless today, revisit if the lost pre-aggregate ordering ever
  matters for a shape that is not one row.
- The `AST.ResultColumnExpr` / `AST.ColumnExpr` tag collision is filed as
  `backlog/debt-ast-result-column-shares-column-tag` with a verified instance (this
  ticket) and one static, unconfirmed instance in `assertion-classifier.ts`.
