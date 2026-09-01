description: A summary query written inside another query is refused if it also selects a column belonging to the outer query, even though that column is a fixed value from the inner query's point of view and other databases accept it.
files:
  - packages/quereus/src/planner/building/select-aggregates.ts   # validateAggregateProjections / findUngroupedColumnRef / buildGroupByCoverage — the select-list walk that rejects; findUngroupedPostAggregateRef / isPreGroupingReference — the level-aware walk that gets it right
  - packages/quereus/test/logic/25.5-ungrouped-aggregate-column-free-select-item.sqllogic  # "KNOWN DIVERGENCE" block pins today's rejection; flips to result rows when this lands
  - docs/sql-select.md                                            # §3.3 (the coverage rule), §3.4 ("The restriction is about this query's own columns")
difficulty: medium
repro: verified
severity: edge-case
likelihood: unusual
tradeoffs: The rejected spellings are odd SQL — selecting an outer query's column from inside a subquery that also aggregates — and the fix widens a check that guards a much more common error, so the risk of loosening it too far may outweigh accepting a query nobody writes on purpose.
----

# A subquery that aggregates may not select a column of the query around it

When a query is aggregated — it has a `group by`, or it names an aggregate function,
or it has a `having` — every column in its select list has to be one it grouped by or
one wrapped in an aggregate. That rule is about **the aggregating query's own
columns**. A column belonging to an *enclosing* query is a single fixed value for the
whole inner query, so it is exempt: there is nothing to group it by.

Quereus applies the rule to outer columns too, and rejects them:

```sql
create table uac (id integer primary key, a text, n integer);
insert into uac values (1, 'x', 10), (2, 'y', 20);

select a from uac where exists (select uac.a, count(*) from uac t);
-- Column 'uac.a' must appear in the GROUP BY clause or be used in an aggregate function

select a from uac where exists (select uac.a, count(*) from uac t group by t.a);
-- same error

select (select uac.a from uac t group by t.a) as x from uac;
-- same error
```

SQLite accepts all three (the first two return `x` and `y`). PostgreSQL does too, and
the SQL standard exempts outer references from the grouping requirement explicitly.

## Where the rule is applied twice, two different ways

Quereus checks the grouping rule at two seams, and only one of them knows which query a
column reference belongs to:

- **The select-list walk** (`validateAggregateProjections` → `findUngroupedColumnRef`,
  in `select-aggregates.ts`) compares each column reference against a flat set of
  grouping-key attribute ids. Anything not in that set is reported as uncovered. An
  outer column is never in the set — no query groups by another query's column — so it
  is reported, and the error text even names it correctly (`uac.a`) while claiming it
  belongs here.
- **The finished-plan walk** (`assertGroupedPlanCoverage` →
  `findUngroupedPostAggregateRef` → `isPreGroupingReference`) asks the right question:
  it flags a reference only when the attribute id is one of *this* query's own
  pre-grouping columns, and leaves everything else — the subquery's own columns, and
  correlated references to an enclosing query — alone.

So the same principle is already modelled correctly a few hundred lines away. The two
walks disagree, and the wrong one runs first.

## Why it surfaced now

For the *ungrouped* shape (`select uac.a, count(*) from uac t`) the rejection is not
new: until `bug-ungrouped-aggregate-rejects-constant-select-item` landed, a blanket
"cannot mix aggregate and non-aggregate columns" throw rejected every select item of an
ungrouped aggregate query, outer references included. Removing that throw handed the
question to the coverage walk, which rejects them for its own reason. The *grouped*
shape has behaved this way for as long as the walk has existed.

## Expected behaviour

A column reference that resolves to an enclosing query is accepted in an aggregating
query's select list, grouped or not — the same exemption `where` and `having` already
get (`select uac.a from uac where exists (select max(t.n) from uac t having uac.a =
'x')` is accepted today). A reference to *this* query's own ungrouped column keeps
being rejected, with the message and source position it has now.

The two walks should end up asking the same question through the same predicate rather
than each carrying its own notion of "a column this query cannot supply"; the
select-list walk needs the set of attribute ids the aggregate's input actually defines,
which `collectDefinedAttrIds` already computes for the other walk.

## Related

`debt-group-key-match-by-attribute-identity` touches the same coverage machinery from a
different angle — it is about *how a grouping key is recognised* (rendered text versus
resolved identity), not about *whose column a reference is*. Its second bullet notes a
mirror-image level-blindness in the redirect, so the two are worth sequencing together
if either is picked up.
