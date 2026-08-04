---
description: Writing the database name in front of a table (for example `main.orders`) is supposed to mean the real table, but a query that also defines a temporary named result set called `orders` reads that instead — silently returning the wrong rows.
files:
  - packages/quereus/src/planner/building/select.ts        # buildFrom — the CTE name match that ignores the qualifier
  - packages/quereus/src/planner/building/dml-target.ts    # resolveCteTarget — the write path, which already declines on a qualifier
  - packages/quereus/src/planner/mutation/scope-transform.ts # sourceColumnNames — already declines on a qualifier; its comment claims buildFrom agrees
repro: verified
---

# A schema-qualified `from` name still matches a common table expression

## What happens

```sql
create table c (k integer primary key);
insert into c values (1), (2), (3);
create table p (id integer primary key);
insert into p values (10);

with c as (select id as k from p) select count(*) as n from main.c;
```

Returns `n = 1` — the one row of the `with` block. It should return `n = 3`, the real
table `main.c`. No error, no warning.

Verified on `main` at `bd71b3c9` by running exactly the statements above through the
sqllogic runner.

## Why

`buildFrom` (`planner/building/select.ts`, the `fromClause.type === 'table'` branch)
looks the FROM name up in the statement's common-table-expression map by **bare name**
and never inspects `fromClause.table.schema`. A qualified name therefore matches an
unqualified `with` definition.

The rest of the engine already takes the opposite position, so this is an internal
inconsistency, not an open design question:

- The **write** path declines on a qualifier: `resolveCteTarget`
  (`planner/building/dml-target.ts`) returns `undefined` the moment `table.schema` is
  set, with the comment "a bare CTE reference can never be schema-qualified". So
  `with c as (…) insert into main.c …` correctly writes the real table while
  `select … from main.c` in the same session reads the `with` block.
- The view-write **scope analysis** declines the same way: `sourceColumnNames`
  (`planner/mutation/scope-transform.ts`) gates its CTE lookup on `!schemaName` — and
  its comment asserts "`buildFrom` resolves such a name the same way … so the static
  shadow set matches the plan-time binding". For a qualified name that assertion is
  currently false, so the analysis and the plan-time binding disagree.

SQLite and PostgreSQL both resolve a qualified name against schema objects only; a
`with` definition is matched by bare name.

## Expected behaviour

A FROM source that carries a schema qualifier resolves against schema objects only,
whatever the statement's `with` clause declares. `from main.c` reads the table `c` in
schema `main`; if no such table exists, the statement fails with the ordinary
table-not-found error rather than silently reading the `with` block. An unqualified
name keeps today's behaviour exactly — the `with` definition shadows a same-named
schema object.

The write path and the view-write scope analysis need no behaviour change; the fix
makes the read path agree with them, and lets the `scope-transform.ts` comment become
true.

## Notes

- This is a different site from the backlog ticket `bug-unreferenced-dml-cte-never-runs`,
  which also names `buildFrom`: that one is about a `with` block never being pulled into
  the plan at all, this one is about which relation a name that *is* pulled binds to.
- Worth checking while in there: the recursive-CTE branch of the same lookup, aliasing
  (`from main.c as x`), and whether any existing test or view/lens body relies on a
  qualified name reaching a `with` definition. `docs/lens.md` § body checks describes a
  *flat* CTE shadow set over a lens body — confirm that description still holds, or
  update it, once the qualifier is honoured.
- Related but deliberately out of scope: schema-authored expressions (column defaults,
  `check` constraints, foreign-key probes) no longer see any statement's `with` clause at
  all — see `tickets/complete/bug-schema-defaults-bind-callers-cte`. That change makes
  this asymmetry unreachable *from schema-authored SQL*; it is still fully reachable from
  ordinary queries, as the repro above shows.
