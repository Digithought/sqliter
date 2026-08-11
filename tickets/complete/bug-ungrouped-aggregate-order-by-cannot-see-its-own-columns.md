---
description: A query that only summarizes (e.g. counts rows) and then sorts by the summary's own column name used to fail with "Column not found"; it now returns the single row.
files:
  - packages/quereus/src/planner/building/select-aggregates.ts   # orderByNeedsPostAggregateSort + mentionsSelectListAlias — the routing decision
  - packages/quereus/src/planner/building/select-ordinal.ts      # SelectListEntry.alias
  - packages/quereus/src/planner/building/select.ts              # the "apply ORDER BY early" gate in buildSelectStmt
  - packages/quereus/test/logic/28.2-orderby-expression-extras.sqllogic  # coverage (last section, table `g`)
  - docs/sql-select.md                                           # § 3.5 ORDER BY — alias precedence + pre-aggregate sort extension
---

# Complete: ungrouped aggregate ORDER BY can name its own output columns

`select count(*) as c from g order by c` (and its sibling spellings) raised
`QuereusError: Column not found: c`. They now return the single row.

## What shipped

**Routing** (`select-aggregates.ts`). `orderByContainsAggregates` became
`orderByNeedsPostAggregateSort`: it answers true for a spelled-out aggregate, for a
positional reference standing for one, and — new — for an ORDER BY term that mentions a
bare (unqualified) column name that is a SELECT-list alias. True routes the sort ABOVE
the `AggregateNode`, where the alias is in scope; false keeps the pre-aggregate sort
extension (a `SortNode` BELOW the aggregate, which is what makes
`select group_concat(b) from g order by a` concatenate in `a` order).

The alias scan (`mentionsSelectListAlias`) walks with `walkAstNodes` from
`planner/analysis/predicate-shape.ts` — reflective child discovery, so it cannot
silently miss a node kind a hand-written `switch` would.

**Placement** (`select.ts`). The early `applyOrderBy` block is now also gated on
`hasOrderByOnlyAggregates`. Applying ORDER BY before the stripping final projection is
required only when ORDER BY introduced aggregates the select list does not have; firing
unconditionally robbed ORDER BY of the projection's output scope, the only place the
alias of a *wrapped* aggregate (`count(*) + 1 as c`) is ever named.

**Supporting.** `SelectListEntry` gained `readonly alias?: string`. Star-expanded
entries deliberately carry none, so a star column's name cannot shadow a source column
in the scan.

## Behaviour change

A SELECT-list alias now outranks a same-named source column in an ungrouped aggregate's
ORDER BY, matching SQLite and the non-aggregate and grouped paths. Cross-checked
against `sqlite3` during review: `select group_concat(b) as a from g order by a desc`
returns `1,2,1` in both engines now (it returned `1,1,2` before). Qualifying the name
(`order by g.a desc`) keeps the pre-aggregate sort. Documented in `docs/sql-select.md`
§ 3.5.

## Validation (review pass)

- `yarn lint` — clean (whole workspace, and `@quereus/quereus` alone after the review
  edits).
- `yarn test` — **9396 passing, 0 failing, 25 pending** in `@quereus/quereus`; every
  other package green. Re-run after every review edit.
- `yarn build` — clean.
- Cross-checked five representative queries against the `sqlite3` CLI rather than
  trusting the engine's own output (see findings).

## Review findings

### Checked

Read the implement diff before the handoff. Scrutinized the routing predicate, the
placement fork in `select.ts`, the AST walk's node-kind guards, `SelectListEntry.alias`
population, the doc bullets, and the new sqllogic section. Probed 35+ ORDER BY
spellings against the engine directly (alias + ordinal + qualified + wrapped +
subquery + DISTINCT + compound + grouped + HAVING + LIMIT + COLLATE combinations), and
cross-checked the interesting ones against the `sqlite3` CLI.

### Major — filed

- **ORDER BY can see the query's aggregates or its own aliases, never both.**
  `select count(*) + 1 as c from g order by max(a), c` still fails with
  `Column not found: c` (also `select length(max(a)) as c from g order by min(b), c`
  and the grouped `select a, count(*) + 1 as c from g group by a order by max(b), c`).
  SQLite accepts all three. The early placement (needed for aggregates the SELECT list
  lacks) and the late placement (needed for select-list aliases) are mutually
  exclusive, and an ORDER BY needing both loses. **Not a regression** — the code path
  is unchanged from before this ticket, which only made the late placement the default.
  Filed as `backlog/bug-order-by-alias-lost-when-order-by-adds-its-own-aggregate`,
  framed at the invariant rung (always sort above the final projection; carry
  sort-only columns through it and strip above the sort) rather than as a point patch.
  A `NOTE:`-style pointer sits at the fork in `select.ts` so the next reader meets it.

### Minor — fixed in this pass

- **Duplicated placement predicate.** `handlePreAggregateSort` re-derived the exact
  boolean its caller had just computed into `preAggregateSort`, so the condition lived
  in two places and both had to be edited in step. It now takes the boolean; four
  parameters dropped.
- **Wrong `{@link}` target** in `mentionsSelectListAlias`'s doc comment
  (`AST.ResultColumn`, the union, where `AST.ResultColumnExpr` is the node that shares
  the `'column'` tag).
- **Coverage for the handoff's own stated gaps.** Added to the sqllogic file: the
  ambiguous duplicate-alias case, an unknown name (`order by cc`), `select distinct`,
  and the `union all` compound. The handoff listed all four as probed-but-unpinned.
- **Stale line count** for `select-aggregates.ts` in
  `backlog/debt-oversized-source-files.md` (1,400 → 1,451, `wc -l`, today). That ticket
  already claims this file's size, so no new size ticket was filed.

### Found and deliberately not filed

- **Duplicate select-list alias is ambiguous only in the aggregate path.**
  `select count(*) as c, max(a) as c from g order by c` errors with
  `ambiguous column name: c`, while `select id as c, a as c from g order by c` and the
  grouped equivalent both bind the first match (as SQLite does — it returns `3|q` for
  the aggregate spelling). Erroring on a genuinely ambiguous name is the better
  behaviour of the two, the shape is contrived, and unifying duplicate-name policy is a
  whole-planner decision, not this ticket's. Pinned as an expected error in the sqllogic
  file with a comment recording the divergence, so a future change to it is a decision
  rather than an accident.

### Tripwires

- The alias scan's over-approximation through subqueries already carries a `NOTE:` on
  `mentionsSelectListAlias` (from the implement pass); re-read and left as is — it
  states the condition and the (nil) cost correctly.
- No new tripwires. Every conditional concern this pass turned up was either already
  parked at its site or was a live defect, filed above.

### Docs

Read `docs/sql-select.md` § 3.5 against the shipped behaviour — the two new bullets are
accurate, including the claim that the pre-aggregate input sort is a Quereus extension
(confirmed against `sqlite3`: SQLite returns `1,2,1` for
`select group_concat(b) as gc from g order by a desc` where Quereus returns `1,1,2`).
No other doc describes ORDER BY placement in aggregate queries; `docs/sql.md` § 11.2
covers type system and architecture differences only, so nothing there went stale.

### Not found

- No resource-cleanup, error-swallowing, or `any`-typing issues in the diff; the one
  cast (`Partial<AST.ColumnExpr>`) is the workaround for the AST tag collision already
  filed as `backlog/debt-ast-result-column-shares-column-tag`, which the review read
  and found accurate (including its unconfirmed second site).
- No stale references to the renamed `orderByHasAggregates` anywhere in source or docs.
- No performance concern: the alias scan runs once per ORDER BY term at plan time, and
  only when the select list wrote at least one alias.
