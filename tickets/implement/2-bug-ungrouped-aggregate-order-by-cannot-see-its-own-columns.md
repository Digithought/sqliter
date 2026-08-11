---
description: A query that only summarizes (e.g. counts rows) and then asks to sort by the summary's own column name fails with "Column not found" instead of returning the single row.
files:
  - packages/quereus/src/planner/building/select-aggregates.ts   # orderByContainsAggregates — the routing decision
  - packages/quereus/src/planner/building/select-ordinal.ts      # SelectListEntry — needs the `as` alias
  - packages/quereus/src/planner/building/select.ts              # the "apply ORDER BY early" gate in buildSelectStmt
  - packages/quereus/src/planner/analysis/predicate-shape.ts     # walkAstNodes — reflective AST walk to reuse
  - packages/quereus/test/logic/28.2-orderby-expression-extras.sqllogic  # where the new coverage goes
difficulty: medium
repro: verified
---

# `select count(*) as c from t order by c` fails with "Column not found: c"

## What happens

An aggregate query with no `GROUP BY` produces exactly one row. Naming one of its
own output columns in `ORDER BY` is legal SQL and SQLite returns the row. Quereus
errors:

```sql
create table g (id integer primary key, a text, b text);
insert into g values (1,'p','1'), (2,'p','2'), (3,'q','1');

select count(*) as c from g order by c;
-- QuereusError: Column not found: c
```

Re-verified at HEAD `d4405852` (after `bug-order-by-ordinal-resolves-to-shadowing-alias`
landed — that fix covered `order by 1` and did not move this).

Failing today, all with `Column not found`:

| query | today |
|---|---|
| `select count(*) as c from g order by c` | error |
| `select count(*) as c from g order by c desc` | error |
| `select count(*) as c, max(a) as m from g order by m` | error |
| `select count(*) + 1 as c from g order by c` | error |
| `select count(*) as c from g order by c + 1` | error |
| `select max(a) as c from g order by c collate nocase` | error |
| `select count(*) as "C" from g order by c` | error |

Already working, and must stay working: `order by count(*)` (spelled-out
aggregate), `order by 1` (ordinal), and every grouped form
(`select a, count(*) as c from g group by a order by c`).

## Root cause

One decision site: `orderByContainsAggregates` in
`packages/quereus/src/planner/building/select-aggregates.ts` (~line 1217).

That predicate decides how an ungrouped aggregate query's `ORDER BY` is planned:

- **false** → `preAggregateSort` — a `SortNode` is placed *below* the
  `AggregateNode`, and its keys are built against the **pre-aggregate** scope
  (the FROM sources' columns). This is a deliberate Quereus extension: it is what
  makes `select group_concat(b) from g order by a` produce a deterministic
  concatenation order.
- **true** → the sort runs *above* the aggregate, where the `AggregateNode`'s
  output scope (built by `createAggregateOutputScope`) registers each aggregate
  under its SELECT-list alias — which is exactly where `c` lives.

Today the predicate answers "does this term contain an aggregate function call",
after first resolving an ordinal through the select list. A bare `c` contains no
aggregate call, so the query takes the pre-aggregate path and `c` is looked up in
a scope that has never heard of it. The grouped form works only because
`hasGroupBy` disables the pre-aggregate path outright, so it always lands in the
aggregate output scope.

There is a second, smaller site. In `buildSelectStmt`
(`packages/quereus/src/planner/building/select.ts`, the `if
(aggregateResult.orderByHasAggregates && …)` block ~line 224) the aggregate
`ORDER BY` is applied **early**, before the final projection is built. That is
required only when `ORDER BY` introduced aggregates the select list does not have
(`hasOrderByOnlyAggregates`) — they exist solely for the sort and the projection
strips them. When it fires unconditionally it also robs `ORDER BY` of the
projection's output scope, which is the only place an alias of a *wrapped*
aggregate (`count(*) + 1 as c`, whose aggregate entry is aliased `count(*)`, not
`c`) is ever named.

## Fix, validated

Both arms were prototyped together and the **whole workspace suite passed**
(`yarn test` — 9397 passing in `@quereus/quereus`, 0 failing), with all seven
failing rows above returning their row.

**Arm 1 — routing.** `orderByContainsAggregates` also answers true when an
`ORDER BY` term mentions a bare (unqualified) column name that is a SELECT-list
alias. Rename it to something honest — it no longer answers only about aggregates;
`orderByNeedsPostAggregateSort` or similar — and rename the
`orderByHasAggregates` result field with it.

**Arm 2 — placement.** Gate the early-apply block in `buildSelectStmt` on
`aggregateResult.hasOrderByOnlyAggregates` as well. Everything else falls through
to the existing `applyOrderBy` call at the bottom of the aggregate branch, which
already receives `aggregateProjectionScope` — the final projection's output names.

Nothing else changes. `SelectListEntry` (in `select-ordinal.ts`) needs a new
`readonly alias?: string`, populated from `column.alias` in
`buildSelectListEntries`; star-expanded entries keep no alias, so a star column's
name never shadows a source column here.

The full prototype diff is reproduced at the bottom of this ticket.

### Rejected alternative — do not re-plan the aliased expression

The first prototype resolved `order by c` by *substituting* the select-list
expression for the alias inside `buildOrdinalAwareExpression`, the way an ordinal
already resolves. It broke `07.5-window.sqllogic` with
`No emitter registered for WindowFunctionCall`: in a grouped **and windowed**
query (`select …, row_number() over (…) as rn from wg group by a order by rn`)
the substitution re-planned a window function into a `SortNode`, where no window
machinery exists. Resolve the alias through a **scope**, never by re-planning the
select-list AST.

## Behaviour change to be explicit about

When a select-list alias collides with a source column name, the alias now wins in
`ORDER BY` — matching SQLite and the SQL standard, and matching what Quereus
already does in the non-aggregate and grouped paths. For an *order-sensitive*
aggregate that is observable:

```sql
select group_concat(b) as a from g order by a desc;
-- before: "1,1,2"  (input sorted by column g.a desc, then concatenated)
-- after:  "1,2,1"  (alias `a` names the output column; sorting one row is a no-op)
```

`select group_concat(b) as gc from g order by a desc` is untouched — `a` is not an
alias there, so the pre-aggregate sort extension still applies. Document the
precedence in `packages/quereus/docs/sql.md` next to whatever describes the
pre-aggregate sort behaviour (search for `group_concat` / ordering), and cover
both spellings in the sqllogic file.

## Notes for the implementer

- **Reuse `walkAstNodes`** from
  `packages/quereus/src/planner/analysis/predicate-shape.ts` for the alias scan.
  It discovers children reflectively, so it cannot silently miss a node kind the
  way a hand-written `switch` can (that failure mode already has a backlog ticket,
  `bug-ast-traversal-misses-expression-subtrees`). The crude walk in the prototype
  below is a stand-in for it.
- `walkAstNodes` descends into subquery operands, so
  `order by (select … where x = c)` counts as mentioning `c` even when that `c` is
  the subquery's own column. That over-approximates: the only consequence is the
  sort moving above the aggregate, i.e. losing the pre-aggregate ordering extension
  for a one-row result. Leave a `NOTE:` at the scan site saying so rather than
  hand-rolling a subquery-aware walk.
- Only unqualified names participate. `order by t.c` must keep resolving to the
  table's column.
- An alias claimed by more than one select-list column is still just "mentioned" —
  the routing predicate does not need to arbitrate, because resolution happens in
  the scope afterwards, which already has its own ambiguity handling.
- One case works today for a reason worth a regression test rather than trust:
  `select (select count(*) + 1 as c from g order by count(*))` is a scalar subquery,
  so its `ProjectNode` is built with `preserveInputColumns: false` and does not
  forward the aggregate's own output column — yet the post-projection sort over
  `count(*)` still resolves and returns 4. Pin it.

## Tests

Add to `packages/quereus/test/logic/28.2-orderby-expression-extras.sqllogic`
(its stated scope is "ORDER BY targets that aren't bare column names … and
expression-derived ORDER BY in the absence of GROUP BY"):

- every row of the failing table above, asserting the single row;
- `select count(*) as c from g order by c, id` and
  `select count(*) as c from g order by c limit 1`;
- `select count(*) as c from g having count(*) > 0 order by c`;
- the two `group_concat` spellings from the behaviour-change section, pinning the
  new precedence and the untouched pre-aggregate sort;
- the scalar-subquery form
  `select (select count(*) + 1 as c from g order by c)`;
- the grouped forms as non-regressions:
  `select a, count(*) as c from g group by a order by c` and `… order by c + 1`.

## Relationship to other tickets

- `complete/bug-order-by-ordinal-resolves-to-shadowing-alias` taught the same
  predicate to see through ordinals. This is the alias arm of that same site; the
  ordinal resolution stays exactly as it is.
- `backlog/bug-order-by-ordinal-with-collate-ignored` also names
  `select-ordinal.ts`, but its site is `extractOrdinalValue` (a collation wrapper
  hides the ordinal). Unrelated; do not merge.

## TODO

Phase 1 — routing and placement

- Add `readonly alias?: string` to `SelectListEntry` in `select-ordinal.ts` and
  populate it from `column.alias` in `buildSelectListEntries`.
- Extend `orderByContainsAggregates` in `select-aggregates.ts` to also answer true
  when a term mentions a bare column name matching a SELECT-list alias, using
  `walkAstNodes`; rename the function and the `orderByHasAggregates` result field
  to say what they now decide, and update the doc comment (which currently
  explains only the ordinal case).
- Add the `NOTE:` about subquery descent at the scan site.
- Gate the early `applyOrderBy` block in `buildSelectStmt` (`select.ts`) on
  `aggregateResult.hasOrderByOnlyAggregates`, and update the comment above it to
  say why early application is now the exception rather than the rule.

Phase 2 — coverage and docs

- Add the sqllogic cases listed above.
- Document the alias-outranks-source-column precedence for aggregate `ORDER BY`
  in `packages/quereus/docs/sql.md`, next to the pre-aggregate sort behaviour.
- Run `yarn test` and `yarn lint` from the repo root.

## Appendix — validated prototype diff

Reference only: the crude alias walk must be replaced by `walkAstNodes`, the
rename in arm 1 is not applied here, and `resolveSelectListAlias` /
`buildOrdinalAwareExpression`'s `resolveAliases` parameter are leftovers from the
rejected substitution approach and are **not** needed.

```diff
--- a/packages/quereus/src/planner/building/select-ordinal.ts
+++ b/packages/quereus/src/planner/building/select-ordinal.ts
@@ SelectListEntry
 	readonly sourceAttribute?: { readonly attr: Attribute; readonly index: number };
+	/** The `as` alias this column was written with, if any. */
+	readonly alias?: string;
 }
@@ buildSelectListEntries
 		} else if (column.type === 'column') {
-			result.push({ expr: column.expr });
+			result.push({ expr: column.expr, alias: column.alias });
 		}

--- a/packages/quereus/src/planner/building/select-aggregates.ts
+++ b/packages/quereus/src/planner/building/select-aggregates.ts
@@ orderByContainsAggregates
 	if (!orderBy || orderBy.length === 0) return false;
+	// crude stand-in for walkAstNodes
+	const aliasNames = new Set(selectList.map(e => e.alias?.toLowerCase()).filter(Boolean) as string[]);
+	const mentionsAlias = (node: unknown): boolean => {
+		if (!node || typeof node !== 'object') return false;
+		const rec = node as Record<string, unknown>;
+		if (rec.type === 'column' && !rec.table && typeof rec.name === 'string'
+			&& aliasNames.has(rec.name.toLowerCase())) return true;
+		for (const value of Object.values(rec)) {
+			if (Array.isArray(value)) {
+				if (value.some(mentionsAlias)) return true;
+			} else if (mentionsAlias(value)) return true;
+		}
+		return false;
+	};
+
 	return orderBy.some(clause => {
 		const entry = resolveOrdinalReference(clause.expr, selectList, 'ORDER BY');
-		return containsAggregateFunction(entry?.expr ?? clause.expr, selectContext);
+		if (containsAggregateFunction(entry?.expr ?? clause.expr, selectContext)) return true;
+		return mentionsAlias(clause.expr);
 	});

--- a/packages/quereus/src/planner/building/select.ts
+++ b/packages/quereus/src/planner/building/select.ts
@@ buildSelectStmt — early ORDER BY apply
 		if (
 			aggregateResult.orderByHasAggregates &&
+			aggregateResult.hasOrderByOnlyAggregates &&
 			!preAggregateSort &&
 			!hasWindowFunctions &&
 			stmt.orderBy && stmt.orderBy.length > 0
 		) {
```
