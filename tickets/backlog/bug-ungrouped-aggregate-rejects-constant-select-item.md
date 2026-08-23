---
description: A summary query that puts a fixed label next to its total — like asking for the word "total" alongside a row count — is rejected with an error instead of returning the row. Other databases accept it.
files:
  - packages/quereus/src/planner/building/select-aggregates.ts   # validateAggregateProjections, ~line 749-761 — the blanket throw
  - packages/quereus/test/logic/28.2-orderby-expression-extras.sqllogic  # ~line 500 comment referencing this slug
repro: verified
severity: edge-case
likelihood: normal-use
tradeoffs: The current check is a deliberately strict one-liner and loosening it means teaching it to distinguish column-free expressions from column references, which is new logic in a validation path that is currently trivially correct.
---

# An aggregate query with no GROUP BY rejects every non-aggregate select item, constants included

## What is wrong

`validateAggregateProjections` in
`packages/quereus/src/planner/building/select-aggregates.ts` (~lines 749-761)
throws for *any* non-aggregate item in the select list when the query has
aggregates and no `GROUP BY`:

```ts
if (hasAggregates && !hasGroupBy) {
    throw new QuereusError(
        'Cannot mix aggregate and non-aggregate columns in SELECT list without GROUP BY',
        StatusCode.ERROR
    );
}
```

The check does not ask whether the item actually references a column. A constant
does not, and is legal in standard SQL and accepted by SQLite. Verified against
a table `t (id integer primary key, a text)` holding `(1,'x'),(2,'y')`:

```sql
select 'total' as label, count(*) as c from t;   -- SQLite: total|2   Quereus: error
select 1 as one,         count(*) as c from t;   -- SQLite: 1|2       Quereus: error
select 1 + 1 as two,     count(*) as c from t;   -- SQLite: 2|2       Quereus: error
select abs(-1) as k,     count(*) as c from t;   -- SQLite: 1|2       Quereus: error
```

Adding a `group by 1` makes each of them work, which is a workaround, not a
reason the plain form should fail.

## What is *not* wrong

`select a, count(*) from t` — a bare column reference with no `GROUP BY` — is
rejected on purpose. The doc comment above the function says so: Quereus
deliberately does not import SQLite's permissive "bare columns" rule, which
picks an arbitrary row of the group. That decision stands and this ticket does
not ask to revisit it.

The distinction the check is missing is **column-free expression** versus
**column reference** — not "aggregate" versus "non-aggregate".

## Expected behaviour

An ungrouped aggregate query accepts a select-list item that references no
column of the query's input, and evaluates it once for the single output row.
It keeps rejecting an item that does reference such a column.

The same predicate should apply wherever this constraint is spelled — the
grouped branch of the same function already resolves non-aggregate items against
the GROUP BY list, so a column-free item there is covered trivially and should
stay accepted.

## Use cases

- Labelling a summary row: `select 'grand total' as label, sum(amount) from sales`.
- A literal discriminator in a branch of a `union all` whose other branches are
  grouped: `select 0 as kind, count(*) from a union all select 1, count(*) from b`.
- Any generated summary SQL that emits a constant column for the client to key on.

## How it was found

While implementing `bug-order-by-alias-lost-when-order-by-adds-its-own-aggregate`.
That ticket's coverage matrix wanted an ungrouped counterpart of its
"grouping-key alias" case; a constant is the natural stand-in, and it turned out
not to plan. The matrix records the gap in a comment in
`packages/quereus/test/logic/28.2-orderby-expression-extras.sqllogic` naming this
slug — update that comment when this lands.
