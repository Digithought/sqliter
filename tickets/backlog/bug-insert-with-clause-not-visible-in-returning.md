---
description: An INSERT statement that declares a named temporary result set up front can use it in the rows being inserted, but not in the clause that reports back what was inserted — that fails with "table not found".
files:
  - packages/quereus/src/planner/building/insert.ts        # buildWithContext at ~535 (CTE-target path only); buildWithClause at ~672 feeds only the source
  - packages/quereus/src/planner/building/update.ts        # ~71 — threads CTEs into the whole statement context
  - packages/quereus/src/planner/building/delete.ts        # ~71 — same
difficulty: medium
---

# A leading `with` clause is invisible to `insert ... returning`

## What happens

```sql
with c as (select id, v from p)
insert into q values (5, 'e') returning id, (select count(*) from c) as n;
-- QuereusError: Table 'c' not found in schema path: main
```

The same shape works for `update` and `delete`:

```sql
with c as (select id, v from p)
update q set w = 'k' returning id, (select count(*) from c) as n;   -- fine
```

It also works for `insert` when the common table expression is used by the *source*
of the insert rather than the `returning` clause:

```sql
with c as (select id, v from p)
insert into q select id, v from c;   -- fine
```

## Why

`buildUpdateStmt` and `buildDeleteStmt` both call `buildWithContext` once at the top,
so the definitions the `with` clause introduces are attached to the planning context
for the whole statement — target, predicate, `set` list, and `returning` alike.

`buildInsertStmt` does not. It calls `buildWithContext` only on the branch where the
insert *target itself* names a common table expression, and otherwise calls
`buildWithClause` late, passing the resulting definitions down as `parentCtes` to the
build of the insert **source** only. Nothing hands them to the `returning` clause's
expression build, so a table reference there falls through to ordinary schema lookup
and reports the name as a missing table.

## Expected

A leading `with` clause on an `insert` should be visible everywhere in that statement,
matching `update` / `delete` and matching what the insert's own source already gets.

## Notes

Found during review of `bug-cte-reference-as-second-join-source-fails-at-runtime`, but
unrelated to it: that ticket changed how *column* names resolve inside a scope, whereas
this is about which *table* names a clause can see. Confirmed present before that
ticket's changes as well.
