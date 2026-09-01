description: A summary query that puts a fixed label next to its total — like asking for the word "total" alongside a row count — is rejected with an error instead of returning the row. Other databases accept it. The fix also lets a query that filters on a total sort by one.
files:
  - packages/quereus/src/planner/building/select-aggregates.ts   # the blanket throw in validateAggregateProjections; the ORDER BY collection gate in buildAggregatePhase
  - packages/quereus/src/planner/building/select.ts               # `allowAggregates: hasAggregates` at the applyOrderBy call in the aggregate branch; the tripwire NOTE above buildWindowPhase
  - packages/quereus/test/logic/25.3-aggregate-isnull-empty.sqllogic       # corpus assertion pinned on the old message
  - packages/quereus/test/logic/07.5-window.sqllogic                       # ~line 864: a shape that now succeeds
  - packages/quereus/test/logic/28.2-orderby-expression-extras.sqllogic    # ~line 517: comment recording this gap
  - docs/sql-select.md                                            # §3.3 implicit-group bullet, §3.4 having paragraph
repro: verified
difficulty: medium
----

# An ungrouped aggregate query must accept a column-free select-list item

## What is wrong

`validateAggregateProjections` in
`packages/quereus/src/planner/building/select-aggregates.ts` throws for *any*
non-aggregate select-list item when the query has aggregates and no `group by`:

```ts
if (hasAggregates && !hasGroupBy) {
	throw new QuereusError(
		'Cannot mix aggregate and non-aggregate columns in SELECT list without GROUP BY',
		StatusCode.ERROR
	);
}
```

It never asks whether the item references a column. A constant does not, and is
legal in standard SQL and accepted by SQLite. Verified on the current build
against `t (id integer primary key, a text)` holding `(1,'x'),(2,'y')` — all
four of these error today:

```sql
select 'total' as label, count(*) as c from t;   -- SQLite: total|2
select 1 as one,         count(*) as c from t;   -- SQLite: 1|2
select 1 + 1 as two,     count(*) as c from t;   -- SQLite: 2|2
select abs(-1) as k,     count(*) as c from t;   -- SQLite: 1|2
```

`select a, count(*) from t` — a bare *column* reference with no `group by` — is
rejected on purpose and must stay rejected. Quereus deliberately does not import
SQLite's permissive "bare columns" rule, which picks an arbitrary row of the
group. The distinction the check is missing is **column-free expression** versus
**column reference**, not "aggregate" versus "non-aggregate".

## Arm: a `having`-only query cannot name an aggregate in its `order by`

```sql
select 1 as one from t having 1 = 1 order by count(*);
-- Aggregate function count not allowed in this context
select 1 as one from t having count(*) > 1;
-- Cannot mix aggregate and non-aggregate columns in SELECT list without GROUP BY
```

Both are legal aggregate queries — a `having` makes the query an aggregate query
over one implicit group, which `docs/sql-select.md` §3.4 already documents. Two
separate "is this an aggregate query?" tests still read `hasAggregates ||
hasGroupBy`, which the `having`-only shape does not satisfy, so the ORDER BY
aggregate is never collected and `applyOrderBy` rejects it. Both arms resolve at
the same site and must land together.

## Root cause and verified fix

The blanket throw is **redundant**, not merely too strict. The coverage walk
immediately below it already does the right thing for the ungrouped shape: with
no `group by` the coverage set is empty, so every bare column reference is
rejected and every column-free expression passes. The function's own doc comment
already says as much. Deleting the throw is the whole select-list fix.

The following three-part patch was applied and exercised against the full
`packages/quereus` suite (10286 passing, 2 failures, both corpus assertions
covered under *Corpus assertions that must change* below). It is a validated
starting point, not a mandate — clean it up as noted.

```
select-aggregates.ts — in validateAggregateProjections, delete:

-	if (hasAggregates && !hasGroupBy) {
-		throw new QuereusError(
-			'Cannot mix aggregate and non-aggregate columns in SELECT list without GROUP BY',
-			StatusCode.ERROR
-		);
-	}

select-aggregates.ts — in buildAggregatePhase, hoist isAggregateQuery above the
ORDER BY aggregate collection and gate on it:

-	if (needsPostAggregateSort && (hasAggregates || hasGroupBy)) {
+	const isAggregateQuery = hasAggregates || hasGroupBy || Boolean(stmt.having);
+	if (needsPostAggregateSort && isAggregateQuery) {
   ...
-	const isAggregateQuery = hasAggregates || hasGroupBy || Boolean(stmt.having);
-
 	if (!isAggregateQuery) {

select.ts — at the applyOrderBy call in the aggregate branch, widen:

-			allowAggregates: hasAggregates,
+			allowAggregates: <the query is an aggregate query>,
```

Two follow-ons the patch above left undone, both worth doing properly:

- Once the throw is gone, `validateAggregateProjections`' `hasAggregates` and
  `hasGroupBy` parameters are dead — nothing else in the body reads them. Drop
  both from the signature and the call site rather than `_`-prefixing them, and
  rewrite the function's doc comment, whose first paragraph still describes
  itself as the aggregate/non-aggregate mixing check.
- For `select.ts`, re-deriving "is this an aggregate query?" from `stmt` at the
  `applyOrderBy` call duplicates the predicate. Prefer returning
  `isAggregateQuery` from `buildAggregatePhase` — it already computes it — and
  reading it there.

## Behaviour after the fix (all verified against the patched build)

| query | before | after |
| --- | --- | --- |
| `select 'total' as label, count(*) as c from t` | error | `total\|2` |
| `select 1 + 1 as two, count(*) as c from t` | error | `2\|2` |
| `select abs(-1) as k, count(*) as c from t` | error | `1\|2` |
| `select case when count(*) > 1 then 'many' else 'few' end as k, count(*) c from t` | error | `many\|2` |
| `select (select count(*) from t) as sub, count(*) as c from t` | error | `2\|2` |
| `select 1 as one from t having 1 = 1 order by count(*)` | error | `1` |
| `select 1 as one from t having count(*) > 1` | error | `1` |
| `select a, count(*) from t` | old message | `Column 'a' must appear in the GROUP BY clause or be used in an aggregate function` |

The last row is a **user-visible message change**, and an improvement: the
ungrouped rejection now carries the same wording and source position as the
grouped one, and names the offending column. It is what breaks the two corpus
assertions below.

## The window tripwire has tripped

`select.ts` carries a `NOTE:` above the `buildWindowPhase` call saying a window
function above an *ungrouped* aggregate is unreachable only because this mixing
check rejects the select list that would spell it, and asking whoever loosens
the check to pin the shape. That condition is now met, so the note must be
rewritten to describe what actually happens and the shape must get corpus
coverage. Probed under the patch, against `wg (a text, b text)` holding
`('x','1'),('y','2'),('x','3')`:

```sql
select count(*) as c, row_number() over (order by count(*)) as rn from wg;
-- was: the mixing error.  now: c=3, rn=1 — which is what PostgreSQL returns.
select count(*) as c, row_number() over (order by a) as rn from wg;
-- Column 'a' must appear in the GROUP BY clause or be used in an aggregate function
select count(*) as c, sum(b) over () as s from wg;
-- Column 'b' must appear in the GROUP BY clause or be used in an aggregate function
select count(*) as c, sum(count(*)) over () as s from wg;
-- Aggregate function count not allowed in this context
```

So the coverage walk does cover the newly-reachable window shapes, and the
ungrouped redirect the note worried about is genuinely not needed (an ungrouped
query has no grouping keys to redirect onto). The remaining job is to say that
in the note and pin all four rows above in the corpus.

## Corpus assertions that must change

Both failed under the patch; neither is collateral damage to route around.

- `packages/quereus/test/logic/25.3-aggregate-isnull-empty.sqllogic:10` —
  `-- error: aggregate and non-aggregate`. The query
  (`select a is null, a is not null, count(*) from ag_t`) is still rejected;
  only the message changed. Update the expected text and the file's header
  comment, which explains the rejection in terms of the old mixing rule.
- `packages/quereus/test/logic/07.5-window.sqllogic:864` —
  `select count(*) as c, row_number() over (order by count(*)) as rn from wg`
  is asserted to error and now succeeds. Its four-line lead-in comment
  ("The shape is rejected earlier, by the select-list aggregate/non-aggregate
  mixing rule, so it never reaches the window phase") is now false. Replace the
  assertion with the `c=3, rn=1` result and rewrite the comment.

`packages/quereus/test/logic/28.2-orderby-expression-extras.sqllogic:517-522`
holds a parenthetical recording this gap and naming this ticket's slug. With the
fix in, the ungrouped counterpart of its grouping-key-alias case can be written
(a constant stands in for the grouping key), so replace the parenthetical with
the actual case rather than merely deleting it.

## Docs

- `docs/sql-select.md` §3.3, the implicit-group bullet (~line 650): "every
  clause above the aggregation may name aggregates only" is now wrong — it may
  also name expressions that reference no column of the query's input. State the
  column-free-versus-column-reference line explicitly; it is the rule the engine
  now enforces, and it is the part a reader is most likely to get wrong.
- `docs/sql-select.md` §3.4, the "A `having` makes the query an aggregate query
  on its own" paragraph, already says the implicit group carries no base-table
  columns. Add that such a query's `order by` may name aggregates —
  `select 1 from t having 1 = 1 order by count(*)` — since that is exactly what
  was rejected before and the paragraph is where a reader will look.

## How to run the repro

The package test runner globs the whole suite, so during development drive Mocha
directly on one file (from the repo root):

```
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js packages/quereus/test/logic.spec.ts --reporter spec
```

Full package suite before handoff: `yarn workspace @quereus/quereus test`.

## TODO

- Delete the `hasAggregates && !hasGroupBy` throw from
  `validateAggregateProjections`; drop the now-dead `hasAggregates` and
  `hasGroupBy` parameters and update the call site.
- Rewrite `validateAggregateProjections`' doc comment: it is now purely the
  GROUP BY coverage check, and for an ungrouped aggregate query the empty
  coverage set is what rejects bare columns while admitting column-free items.
- Hoist `isAggregateQuery` in `buildAggregatePhase` above the ORDER BY aggregate
  collection and gate that collection on it instead of `hasAggregates ||
  hasGroupBy`; return it from the function.
- Use that returned flag for `allowAggregates` at the aggregate branch's
  `applyOrderBy` call in `select.ts`.
- Rewrite the `NOTE:` above `buildWindowPhase` in `select.ts` — a window
  function above an ungrouped aggregate is now reachable, is covered by the
  coverage walk, and needs no redirect context.
- New corpus file `packages/quereus/test/logic/25.5-ungrouped-aggregate-column-free-select-item.sqllogic`
  covering: the four constant/expression shapes from *What is wrong*; `case`
  over an aggregate; a scalar subquery beside an aggregate; a column-free item
  surviving `distinct` and `limit`; and the still-rejected `select a, count(*)`
  with its new message and column position.
- Extend `packages/quereus/test/logic/25.2-having-edge-cases.sqllogic` with the
  two `having`-only arms: `order by count(*)` (and a two-key `order by count(*),
  max(a)`), and `having count(*) > 1` beside a constant select list.
- Update `07.5-window.sqllogic:864` to the succeeding result plus its lead-in
  comment, and add the three neighbouring window-over-ungrouped-aggregate error
  shapes listed above.
- Update the expected error text and header comment in
  `25.3-aggregate-isnull-empty.sqllogic`.
- Replace the parenthetical at `28.2-orderby-expression-extras.sqllogic:517`
  with the ungrouped counterpart case it says is missing.
- Update `docs/sql-select.md` §3.3 and §3.4 as described.
- Run `yarn workspace @quereus/quereus test` and `yarn lint`; confirm the only
  behaviour deltas are the ones tabulated above.
