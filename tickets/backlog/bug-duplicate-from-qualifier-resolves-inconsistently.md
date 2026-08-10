---
description: A query can name two of its data sources the same thing, and the engine then disagrees with itself about which one is meant — a column picks one source while a "give me all of that source's columns" star picks both — so a saved view built that way can silently break when a column is renamed.
files:
  - packages/quereus/src/planner/building/select.ts               # buildFrom / buildJoin — where FROM sources are registered; the natural site for a uniqueness check
  - packages/quereus/src/planner/building/select-projections.ts   # buildStarProjections (~57) — filters attributes by relation NAME, so every same-named source matches
  - packages/quereus/src/schema/rename/column-rename.ts           # bindQualifier / resolveQualifierBinding — the rename walk models one qualifier → one source
repro: verified
severity: wrong-result
likelihood: contrived
tradeoffs: You have to write two sources with the same name in one FROM to hit any of this, which no real schema does on purpose; a maintainer may reasonably decide the whole class is not worth a build-time check, especially if rejecting it breaks somebody's generated SQL.
---

# Two FROM sources may share one name, and nothing decides what that name means

SQL's own rule is that the names a query gives its data sources — a table's own name,
or an `as`-alias — must be **distinct within one FROM clause**. Quereus does not
enforce that, and three parts of the engine then answer "which source is `t`?"
differently.

## What was measured

Two tables, `t(id, x)` and `u(id, y)`, and a FROM that names both of them `t`:

```sql
select t.x from t join u as t on 1=1;    -- reads t.x   (the FIRST source)
select t.x from u as t join t on 1=1;    -- reads u.x   (the FIRST source)
select x    from t join u as t on 1=1;   -- rejected: ambiguous column name: x
```

So a **qualified column** resolves to the first source in FROM order — that falls out
of the scope chain's first-match lookup, and it is at least a rule.

A **qualified star** does not follow it. `buildStarProjections` filters the source's
attributes by relation *name*, so every same-named source matches:

```sql
select t.* from t join u as t on 1=1;
-- yields FOUR columns: t.id, t.x, u.id, u.y
-- (and two of them collide, surfacing as the synthesised name `id:1`)
```

`t.*` should be the columns of whichever source `t.x` would have read. It is instead
the columns of all of them.

## Why it is more than a curiosity — a view silently breaks

`ALTER TABLE … RENAME COLUMN` decides which views republish a renamed column by
modelling one qualifier as binding one source (first in FROM order, matching the
qualified-column rule). Where the star disagrees, the cascade misses a republisher:

```sql
create table t (id integer primary key, x integer);
create table u (id integer primary key, y integer);
create view v as select t.* from u as t join t on 1=1;   -- v publishes u.id, u.y, t.id, t.x
create view w as select x from v;

select * from w;                       -- {"x": 5}
alter table t rename column x to z;    -- accepted
select * from w;                       -- ERROR: Column not found: x
```

`v`'s published `x` did shift to `z` (the star re-expands at plan time), but the
rename walk did not see `v` as a republisher, so `w` was never re-targeted. Verified
against the engine as it stands.

## The invariant that retires the class

Reject a duplicated source name at build time — one check where a FROM clause's
sources are collected (`buildFrom` / `buildJoin` in `planner/building/select.ts`),
erroring the way an ambiguous column reference already does and naming the repeated
qualifier. That makes the disagreement unrepresentable rather than reconciling three
call sites and hoping a fourth never appears: no first-vs-all divergence, no
rename-walk mismatch, and no duplicate output column names out of a qualified star.

Aligning `buildStarProjections` with first-match instead would fix the instance above
and leave the class open. Note also that a duplicate qualifier shared between a CTE
and a real table resolves to the real table even when the CTE is written first
(`with c as (…) select a.x from c a join t a on 1=1` reads `t`), which is a third
answer again — more evidence that nothing today owns the question.

## Related

`bug-cte-shadow-precedence-scope-transform` is the neighbouring theme — two passes
disagreeing about which relation a *bare* FROM name denotes when a CTE shadows a real
table. Different site (that one is about shadowing across scopes; this one is about
two sources inside one FROM), but the same underlying shape: name resolution rules
that are re-derived per call site instead of stated once.
