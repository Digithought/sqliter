---
description: Sorting or grouping by column number (`order by 2`, `group by 1`) now points at the numbered result column instead of being turned back into a column name, so a column alias or a same-named column from another table can no longer hijack it.
files:
  - packages/quereus/src/planner/building/select-ordinal.ts       # rewritten — SelectListEntry, the two binding helpers
  - packages/quereus/src/planner/building/select-modifiers.ts     # applyOrderBy gained `outputRelation` + alignment guard
  - packages/quereus/src/planner/building/select.ts               # threads the output relation from all three branches
  - packages/quereus/src/planner/building/select-aggregates.ts    # GROUP BY / pre-aggregate sort / ordinal-aware aggregate detection
  - packages/quereus/src/planner/building/select-compound.ts      # compound call site renamed onto the shared helper
  - packages/quereus/test/logic/28.2-orderby-expression-extras.sqllogic  # regression block, ~120 new lines
  - docs/sql-select.md                                            # GROUP BY + ORDER BY positional bullets
difficulty: medium
repro: verified
---

# `order by <number>` binds to an output position, not to a name

## What changed and why

A positional reference (`order by 2`, `group by 1`) means "the second / first
column of the select list". The planner used to map the number back to the AST
*text* of the expression that produced that column and re-plan that text in
whatever scope the sort happened to be built in. Because select-list aliases and
same-named columns from other FROM sources are visible in that scope, the number
could land on a different column than it points at — and in some shapes on
something that could not be planned there at all.

Positional references now bind two ways, chosen by where the sort/grouping sits
relative to the projection that produces the select list:

- **Above the projection** (the common `order by N`): bind to the Nth *output
  attribute* of the relation whose attributes ARE the result columns. This is the
  same mechanism compound (`union`/`intersect`/`except`) ORDER BY already used;
  that helper was generalized into `resolveOrdinalOutputColumn` and both paths now
  share it.
- **Below/beside the projection** (GROUP BY, pre-projection sorts, pre-aggregate
  sorts, pre-window sorts): no output attributes exist yet, so the authored
  expression is still re-planned — *except* for a column that came from a star,
  which now carries its exact source attribute and is referenced directly instead
  of through the star's unqualified synthesized name.

Plus one detection fix: `orderByContainsAggregates` resolves a positional
reference against the select list before testing for aggregates, so
`select count(*) as c from t order by 1` routes to the post-aggregate ORDER BY
path exactly like the spelled-out `order by count(*)`.

### New shared type

```ts
// select-ordinal.ts
export interface SelectListEntry {
	/** The AST that produced this output column (authored, or synthesized for a star). */
	readonly expr: AST.Expression;
	/** Star-expanded entries only: the exact input attribute this column came from. */
	readonly sourceAttribute?: { readonly attr: Attribute; readonly index: number };
}
```

`buildSelectListAsts` → `buildSelectListEntries` (returns these);
`resolveOrdinalReference` returns an entry rather than an AST;
`buildOrdinalAwareExpression` is the single below-the-projection call site
helper; `resolveCompoundOrdinalColumn` → `resolveOrdinalOutputColumn`.

### Semantic this locks in

`order by 1` is now *identical* to `order by <alias of column 1>`: the sort reads
the computed output value rather than recomputing the expression. That is the SQL
semantic, it matches what `order by dist` already did for
`select abs(x-5) as dist …`, and it removes a double evaluation of the expression.

## Use cases to validate

All of these were confirmed by hand against a live `Database.eval` before and
after, and are now in `28.2-orderby-expression-extras.sqllogic`. Each is paired
with a control query that a name-based resolution could not satisfy.

Setup for the first group:
```sql
create table nk (a text primary key, b text);
insert into nk values ('x','1'), ('w','9');
```

| shape | query | expectation |
|---|---|---|
| alias shadows target | `select b as a, a as z from nk order by 2` | sorts by `z` (`'w'` row first); `order by 1` gives the OPPOSITE order |
| alias shadows, star | `select b as a, * from nk order by 2` | same as `order by nk.a` |
| alias shadows, distinct | `select distinct b as a, a as z from g order by 2` | same as `order by z` |
| duplicate name under star | `select * from ot1 join ot2 on ot1.k=ot2.k order by 4` | same as `order by ot2.v`; `order by ot1.v` gives the opposite order |
| window column ordinal | `select b as a, row_number() over (order by a) as z from g order by 2` | same as `order by z` — used to raise `No emitter registered for WindowFunctionCall` |
| ungrouped aggregate ordinal | `select count(*) as c from g order by 1` | returns the row — used to raise `Aggregate function count not allowed in this context` |
| two ungrouped aggregates | `select count(*) as c, max(a) as m from g order by 2` | returns the row |
| grouped, ordinal on aggregate | `select b as q, count(*) as c from g group by b order by 2 desc, 1` | unchanged from before |
| GROUP BY ordinal on alias | `select b as a, count(*) as c from g group by 1` | groups by `b`, same as `group by b` |
| GROUP BY ordinal onto star column | `select jt2.*, count(*) as n from jt1 join jt2 on jt1.k=jt2.k group by 1, 2` | groups by `jt2`'s columns; used to fail the GROUP BY coverage check because the ordinals resolved to `jt1`'s same-named columns |
| pre-projection sort (unchanged) | `select b as a, a as z from nk order by 2, a` | still sorts by `z` then `a` |
| out of range (unchanged) | `select a from nk order by 3` | still `ORDER BY position 3 is not in the SELECT list (1..1)` at prepare time |
| constant expression (unchanged) | `select a from t order by 1 + 0` | still a constant, still no reordering |
| signed ordinals (unchanged) | `order by +1` sorts; `order by -1` errors | |

## Known gaps — please probe these

**The alignment guard is doing real work and is the main risk surface.**
`applyOrderBy` only uses output-position binding when
`outputRelation.getAttributes().length === selectList.length`. Two shapes fail
that check today and silently keep the old select-list behavior:

1. A window query containing `*`. `buildWindowProjections` skips
   `column.type === 'all'` entirely, so `select *, row_number() over (…) w from t`
   returns only `w` — filed as the second arm of
   `fix/bug-window-function-over-grouped-query-crashes`, explicitly out of scope
   here. I verified `select *, row_number() over (order by a) as w from og order
   by 1` behaves the same before and after this change (falls back, resolves the
   star entry's source attribute, sorts correctly by `id`), but the *query itself*
   is still wrong in that it drops the star columns. When that ticket lands, the
   guard becomes a no-op for this shape and the ordinal will start binding to the
   window projection instead — worth re-checking then.
2. A grouped query where `needsFinalProjection` came out false (no final
   `ProjectNode` was built), so `orderByOutputRelation` stays undefined and the
   select-list path is used. `select count(*) as c from g group by b order by 1`
   was spot-checked and is correct, but I did not enumerate every
   `needsFinalProjection === false` shape.

**Other things I did not exhaust:**

- I did not audit whether any optimizer rule reshapes the final `ProjectNode` in
  a way that invalidates a sort key bound to its attribute id. The full suite
  (8662 quereus tests, plus `test/plan` and `test/optimizer`) is green, which is
  evidence but not proof. `rule-groupby-fd-simplification` is the rule most
  likely to matter — it already caps its rewrite with an order-restoring
  `Project` for a related build-time agreement.
- `order by 2 collate nocase` still parses as a collate over the literal `2`, so
  it is a constant expression and does not sort. That is unchanged pre-existing
  behavior (the ordinal extractor never handled `collate`), not something this
  ticket introduced — but it is arguably wrong and nobody has filed it.
- Qualified-star ordinals across more than two sources (`select a.*, b.*, c.*
  … order by N`) are covered only by the two-table case.
- The GROUP BY star-ambiguity regression discriminates by error-vs-rows, not by
  differing row values. I could not construct a shape where the buggy binding
  produced a silently *wrong* grouping rather than tripping the coverage check —
  if the reviewer can, that is a stronger test.

**Nothing was skipped or disabled.** `yarn test` (whole monorepo), `yarn lint`,
and `yarn build` all pass on a clean tree; no pre-existing failures surfaced.

## Explicitly out of scope (unchanged, still open elsewhere)

- `*` dropped from any window query — `fix/bug-window-function-over-grouped-query-crashes`.
- `select count(*) as c from t order by c` → `Column not found: c` (the alias
  form of the ungrouped-aggregate case) —
  `backlog/bug-ungrouped-aggregate-order-by-cannot-see-its-own-columns`.
- `select count(*) as b, b as q from g group by b` → `ambiguous column name: b`.
  Fails at select-list build time with or without an ordinal; unrelated.
