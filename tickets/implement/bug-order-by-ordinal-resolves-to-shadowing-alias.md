---
description: Sorting by column number (`order by 2`) can sort by the wrong column, and in a few shapes fails outright, because the number is turned back into a column name instead of pointing at an output position.
files:
  - packages/quereus/src/planner/building/select-ordinal.ts       # resolveOrdinalReference / resolveCompoundOrdinalColumn — the site that must change
  - packages/quereus/src/planner/building/select-modifiers.ts     # applyOrderBy (post-projection sort), buildFinalProjections (pre-projection sort)
  - packages/quereus/src/planner/building/select-aggregates.ts    # GROUP BY ordinals, handlePreAggregateSort, orderByContainsAggregates
  - packages/quereus/src/planner/building/select.ts               # builds the select list, owns every ordinal call site's plumbing
  - packages/quereus/src/planner/nodes/project-node.ts            # attribute derivation: one output attribute per projection, in order
  - packages/quereus/test/logic/28.2-orderby-expression-extras.sqllogic  # existing ordinal ORDER BY coverage; regression cases belong here
  - docs/sql-select.md                                            # lines 603 / 686 — the GROUP BY and ORDER BY positional-reference bullets
difficulty: medium
repro: verified
---

# `order by <number>` must bind to an output position, not to a name

## What is wrong

A positional reference (`order by 2`, `group by 1`) is supposed to mean "the
second/first column of the select list". Quereus instead maps the number back to
the *text* of the expression that produced that column and re-plans that text.
Re-planning happens in a scope where select-list aliases and same-named columns
from other tables are all visible, so the number can land on a different column
than the one it points at — and in some shapes it lands on something that cannot
be planned there at all, producing an internal error.

Everything below was run against the current tree (`main`, clean) via a scratch
mocha spec using `Database.eval`.

### Arm 1 — an alias shadows the target column (silent wrong order)

```sql
create table nk (a text primary key, b text);
insert into nk values ('x','1'), ('w','9');

select b as a, a as z from nk order by 2;
```

Position 2 is `z` (= `nk.a`), so `'w'` sorts first. Actual output puts the
`'x'` row first — it sorted by the *first* result column, because the ordinal
resolved to the AST `a`, and the select list's alias `a` (over `nk.b`) shadows
`nk.a` in the ORDER BY scope. Control `order by z` gives the correct order.

Same with a star: `select b as a, * from nk order by 2` sorts by the aliased
`b`, not by the star's `a` at output position 2.

Same under DISTINCT (same code path): `select distinct b as a, a as z from g
order by 2`.

### Arm 2 — two tables expose the same column name under `*` (silent wrong order)

```sql
create table t1 (k integer primary key, v text);
create table t2 (k integer primary key, v text);
insert into t1 values (1,'a1'), (2,'b1');
insert into t2 values (1,'z2'), (2,'y2');

select * from t1 join t2 on t1.k = t2.k order by 4;
```

Output column 4 is `t2.v`, so the `k=2` row (`'y2'`) sorts first. Actual output
puts `k=1` first — it sorted by `t1.v`. `buildSelectListAsts` synthesizes an
*unqualified* `{type:'column', name:'v'}` for each star-expanded column, and the
re-resolution picks the first `v` in scope. Controls `order by t2.v` and
`order by t1.v` differ from each other and confirm which one was used.

Note this arm is not fixed by merely dropping the alias scope from the ORDER BY
context — the two candidates are both base-table columns. Only positional
binding fixes it.

### Arm 3 — the ordinal points at a window function (internal error)

```sql
select b as a, row_number() over (order by a) as z from g order by 2;
-- QuereusError: No emitter registered for WindowFunctionCall
```

The ordinal re-plans `row_number() over (...)` as a fresh window-function
expression inside the sort, below/aside the node that actually computes window
results, and nothing rewrites that copy. `order by z` (same query, alias form)
works.

### Arm 4 — the ordinal points at an aggregate with no GROUP BY (error)

```sql
select count(*) as c from g order by 1;
-- QuereusError: Aggregate function count not allowed in this context
select count(*) as c, max(a) as m from g order by 2;
-- QuereusError: Aggregate function max not allowed in this context
```

`orderByContainsAggregates` (select-aggregates.ts) inspects the raw ORDER BY AST
— a bare literal `1` contains no aggregate — so the query takes the
*pre-aggregate* sort path, which re-plans the ordinal's target with
`allowAggregates = false`. The equivalent explicit form `order by count(*)`
works today and returns the row.

### What already works (do not regress)

- `select a from ob order by 1`, `select c, a from ob order by 1, 2 desc`,
  `select abs(x - 5) as dist from many order by 1`
  (`test/logic/28.2-orderby-expression-extras.sqllogic:17,21,80`).
- Out-of-range / zero / negative ordinals still raise
  `ORDER BY position N is not in the SELECT list (1..M)` at prepare time.
- `group by <number>` binds to the right expression:
  `select b as a, count(*) as c from g group by 1` groups by `b`, matching
  `group by b`. The "must appear in the GROUP BY clause" error the fix-stage
  ticket flagged as unsettled is **correct** — it comes from
  `select b as a, a as z from g group by 1`, where `z` genuinely is not grouped.
  GROUP BY's only defect is Arm 2's star ambiguity (an unqualified synthesized
  name for a star-expanded column).
- Compound (`union` / `intersect` / `except`) ORDER BY ordinals are already
  positional via `resolveCompoundOrdinalColumn` and are correct
  (`select b as a, a as z from g union all ... order by 2`).
- ORDER BY ordinals in a *pre-projection* sort are already correct, because that
  sort is built against the input scope with no alias scope merged in:
  `select b as a, a as z from nk order by 2, id` sorts by `z`. The fix must keep
  that.

## Root cause

`resolveOrdinalReference` (`select-ordinal.ts`) returns an `AST.Expression`, and
every caller feeds it to `buildExpression` in whatever scope is current at that
call site. Name resolution therefore runs a second time, against a scope that was
never the one the select-list item was planned in.

The compound sibling in the same file, `resolveCompoundOrdinalColumn`, already
does the right thing: it maps the ordinal onto the Nth **output attribute** of
the set node and returns a `ColumnReferenceNode` — no re-resolution. Single-select
ordinals should reach the same guarantee.

Two facts make positional binding straightforward:

- `ProjectNode.getAttributes()` returns exactly one attribute per projection, in
  projection order, on both the `preserveInputColumns` and non-preserve branches
  (`project-node.ts:162-222`). So attribute index `n-1` *is* output column `n`.
- `emitColumnReference` resolves purely by `attributeId`
  (`runtime/emit/column-reference.ts`); `columnIndex` is metadata. Binding by
  attribute is exact even when two output columns share a name.

## Design

Ordinals get two binding modes, chosen by where the sort or grouping sits
relative to the projection that produces the select-list columns.

### Mode A — output-position binding (ORDER BY above the projection)

Generalize `resolveCompoundOrdinalColumn` into a shared helper — one function,
used by both the compound path and the single-select path:

```ts
export function resolveOrdinalOutputColumn(
  expr: AST.Expression,
  outputRelation: RelationalPlanNode,   // attributes ARE the select-list columns
  scope: Scope,
  clauseName: 'ORDER BY',
): ColumnReferenceNode | null
```

Behavior is exactly today's `resolveCompoundOrdinalColumn`: null for a
non-ordinal shape, the existing prepare-time error for out of range, otherwise a
`ColumnReferenceNode` over `outputRelation.getType().columns[n-1]` /
`getAttributes()[n-1]`.

`applyOrderBy` (select-modifiers.ts) takes a new optional
`outputRelation?: RelationalPlanNode` and prefers this helper over
`resolveOrdinalReference` when it is supplied. Call sites in `select.ts`:

| branch | relation to pass |
|---|---|
| non-grouped, non-window (`select.ts:315-323`) | `finalResult.output` — the `ProjectNode`, or the identity-projection passthrough (a `select *`, where source attributes already are the select list) |
| grouped (`select.ts:242-246`) | the final `ProjectNode` built there — only when it was built (`aggregateResult.needsFinalProjection`), i.e. exactly when `aggregateProjectionScope` is set |
| window (`select.ts:286`) | the node `buildWindowPhase` returns — it ends in a `ProjectNode` over `stmt.columns` |

**Alignment guard.** Use Mode A only when
`outputRelation.getAttributes().length === selectListEntries.length`; otherwise
fall back to Mode B. Two known shapes fail alignment today: the window path drops
`*` entries entirely (second arm of `fix/bug-window-function-over-grouped-query-crashes`),
and the grouped path may skip the final projection. The guard keeps those shapes
at today's behavior instead of turning a wrong sort into a spurious out-of-range
error, and it becomes a no-op once that ticket lands.

Note the semantic this locks in: `order by 1` becomes *identical* to
`order by <alias of column 1>` — the sort reads the computed output value rather
than recomputing the expression. That is the SQL semantic, matches what
`order by dist` already does for `select abs(x-5) as dist ... `, and removes a
double evaluation.

### Mode B — pre-projection binding (GROUP BY, and sorts below the projection)

These sites have no output attributes yet, so they keep re-planning the AST — but
star-expanded entries must stop going through a name.

Replace `buildSelectListAsts` with an entry list that keeps the star's source
attribute:

```ts
export interface SelectListEntry {
  /** The AST that produced this output column (authored, or synthesized for a star). */
  expr: AST.Expression;
  /** Star-expanded entries only: the exact input attribute this column came from. */
  sourceAttribute?: { attr: Attribute; index: number };
}
```

`resolveOrdinalReference` returns the matching `SelectListEntry` (or null).
Callers that get a `sourceAttribute` build a `ColumnReferenceNode` directly;
otherwise they `buildExpression` the `expr` as they do now. Mode B sites:

- `buildFinalProjections` pre-projection sort (`select-modifiers.ts:52-60`)
- `handlePreAggregateSort` (`select-aggregates.ts`)
- GROUP BY expression build (`select-aggregates.ts`, the `stmt.groupBy.map`)
- pre-window sort (`select.ts:270-277`)

### Mode C — ordinal-aware aggregate detection

`orderByContainsAggregates` (`select-aggregates.ts`) must resolve each ORDER BY
term's ordinal against the select-list entries *before* testing for aggregates.
With that, Arm 4's `select count(*) as c from g order by 1` routes to the
post-aggregate ORDER BY path (`allowAggregates = true`), which already handles
`order by count(*)` correctly.

## Regression cases

Add to `packages/quereus/test/logic/28.2-orderby-expression-extras.sqllogic`
(the ordinal cases already live there). Each is a strict discriminator — the
control query in the same block must produce a *different* row order than the
buggy one, so a name-based regression cannot pass:

| case | query | must equal |
|---|---|---|
| alias shadows target | `select b as a, a as z from nk order by 2` | `order by z` |
| alias shadows, star | `select b as a, * from nk order by 2` | `order by nk.a` |
| alias shadows, distinct | `select distinct b as a, a as z from g order by 2` | `order by z` |
| duplicate name under star | `select * from t1 join t2 on t1.k=t2.k order by 4` | `order by t2.v` (and differ from `order by t1.v`) |
| window column ordinal | `select b as a, row_number() over (order by a) as z from g order by 2` | `order by z` |
| ungrouped aggregate ordinal | `select count(*) as c from g order by 1` | `order by count(*)` |
| grouped, ordinal on aggregate | `select b as q, count(*) as c from g group by b order by 2 desc, 1` | unchanged from today |
| mixed pre-projection sort | `select b as a, a as z from nk order by 2, <non-projected col>` | `order by z, <col>` |
| expression ordinal (existing) | `select abs(x-5) as dist from many order by 1` | unchanged |
| out of range (existing) | `select a from nk order by 3` | still errors `ORDER BY position 3 is not in the SELECT list (1..1)` |
| GROUP BY star ambiguity | `select * from t1 join t2 on t1.k=t2.k group by 4` (or the nearest legal grouped form) | groups by `t2.v` |

Also confirm `test/logic/07.3-group-by-extras.sqllogic` (ordinal `group by`
cases) and `28.2-set-op-branch-types.sqllogic` / `09.1-set-op-cross-collation.sqllogic`
(compound ordinals) stay green.

## Not in scope

- **`*` dropped from any window query.** `buildWindowProjections` skips
  `column.type === 'all'`, so `select *, row_number() over (…) w from gk`
  returns only `w`. Already filed as the second arm of
  `fix/bug-window-function-over-grouped-query-crashes`. This ticket's alignment
  guard exists precisely to coexist with it.
- **`select count(*) as c from t order by c` → `Column not found: c`.** The
  alias form of Arm 4; an ungrouped aggregate query never exposes an output
  scope to ORDER BY. Different site, filed as
  `backlog/bug-ungrouped-aggregate-order-by-cannot-see-its-own-columns`.
- **`select count(*) as b, b as q from g group by b` → `ambiguous column name: b`.**
  Fails at select-list build time, with or without an ordinal — unrelated to
  ordinal binding. Recorded here so it is not mistaken for a regression while
  writing grouped test cases.

## TODO

Phase 1 — positional binding

- Rename/generalize `resolveCompoundOrdinalColumn` into
  `resolveOrdinalOutputColumn(expr, outputRelation, scope, clauseName)`; keep the
  compound call site working through it unchanged.
- Add the optional `outputRelation` parameter to `applyOrderBy` and prefer the
  new helper, with the attribute-count alignment guard and a comment stating why
  the guard exists.
- Thread the right relation from all three `select.ts` branches (non-grouped,
  grouped-with-final-projection, window).

Phase 2 — pre-projection binding

- Introduce `SelectListEntry` and convert `buildSelectListAsts` to return
  entries carrying the star's source attribute; update the type of every
  `selectListAsts` parameter that threads through `select.ts`,
  `select-modifiers.ts`, `select-aggregates.ts`.
- Have `resolveOrdinalReference` return an entry, and update the four Mode B call
  sites to build a `ColumnReferenceNode` when `sourceAttribute` is present.
- Make `orderByContainsAggregates` resolve ordinals before testing.

Phase 3 — tests and docs

- Add the regression block(s) to `28.2-orderby-expression-extras.sqllogic`, each
  paired with its discriminating control query.
- Update `docs/sql-select.md:686` (the ORDER BY positional bullet) and
  `docs/sql-select.md:603` (the GROUP BY one) to state that a positional
  reference binds to the select list's Nth **output column** — not to a name — so
  a select-list alias or a same-named column from another table cannot capture
  it.
- Run `yarn test 2>&1 | tee /tmp/test.log` and `yarn lint` from the repo root.
