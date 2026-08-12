---
description: A query that both groups rows and uses a window function fails with a confusing internal error whenever the select list writes a grouping column with its table name in front of it, even though the exact same query works without the table name.
files:
  - packages/quereus/src/planner/building/select-aggregates.ts   # createAggregateOutputScope registers the qualified name only when GROUP BY wrote one; buildFinalAggregateProjections resolves the select list through that scope
  - packages/quereus/src/planner/building/select.ts              # the grouped+windowed branch: the select-list projection is placed above the WindowNode
  - packages/quereus/test/logic/07.5-window.sqllogic             # grouped-window coverage lives here (~line 925 onward)
repro: verified
severity: edge-case
likelihood: unusual
tradeoffs: The workaround is to drop the table name from the select list, and the failure is loud rather than silent, so a maintainer may rank this below work that produces wrong answers — but the error text names an internal concept ("row context") and reads like an engine bug to the person hitting it.
---

# A table-qualified grouping column in the select list breaks a grouped window query

## What happens

Verified at HEAD (373732b3) with a scratch mocha spec, and again against the file
as it stands before this ticket's sibling work — neither the alias work nor
anything else in the current diff is involved (the failing queries below contain
no aliases at all).

```sql
create table wg (a text, b text);
insert into wg values ('x','1'),('y','2'),('x','3');

-- works: select list writes the grouping column bare
select a, row_number() over (order by a) as rn from wg group by a;
-- => [{"a":"x","rn":1},{"a":"y","rn":2}]

-- works: no window function, select list qualified
select wg.a, count(*) as c from wg group by a;
-- => [{"a":"x","c":2},{"a":"y","c":1}]

-- FAILS: both together
select wg.a, row_number() over (order by a) as rn from wg group by a;
-- QuereusError: No row context found for column a. The column reference must be
-- evaluated within the context of its source relation.
```

The failure is at run time, not plan time, and the message names an engine-internal
concept. Every variation of the third query fails the same way — with or without an
alias on the qualified column, with the window spec written bare or qualified, with
an aggregate also present:

```sql
select wg.a, row_number() over (order by wg.a) as rn from wg group by a;
select wg.a as k, row_number() over (order by a) as rn from wg group by a;
select wg.a, count(*) as c, row_number() over (order by c) as rn from wg group by a;
```

Writing the qualifier in the `group by` too makes them all work:

```sql
select wg.a, row_number() over (order by wg.a) as rn from wg group by wg.a;   -- fine
```

## Why it happens (as far as the investigation went)

The scope a grouped query's output row is named through
(`createAggregateOutputScope`) registers a grouping key's **qualified** name only when
the `group by` itself wrote a qualifier. So under `group by a`, the name `wg.a` is not
registered, and a select-list `wg.a` falls through to the base-table column instead of
binding to the aggregate's own group output column.

What is NOT yet understood — and is the real question for whoever picks this up — is
why the same unbound reference is harmless without a window function. `select wg.a,
count(*) from wg group by a` builds the same base-table reference and still returns the
right answer, apparently because something in the runtime still has a source row in
context at that point. With a `WindowNode` between the aggregate and the projection,
that no longer holds and the reference dies.

So there are two candidate fixes and they are not equivalent:

- register the implicit qualified name (`<relation>.<column>`) for every bare grouping
  key, so the select-list reference binds to the group output column — small, but only
  fixes the symptom if the fallthrough is the whole story;
- work out why a projection over an AggregateNode can read a pre-aggregate attribute at
  all, and whether that fallback should exist. If it should not, this query shape is one
  symptom of a wider gap and the fix belongs there.

Confirming which is right means tracing where a plain grouped projection gets its row
context at run time.

## Expected behavior

`select wg.a, row_number() over (order by a) as rn from wg group by a` returns the same
rows as the unqualified spelling. A table qualifier is not part of a grouping key's
identity anywhere else in the engine — the window phase already redirects a qualified
window-spec reference onto the group key regardless of how the `group by` spelled it —
so the select list should not be the one place it matters.
