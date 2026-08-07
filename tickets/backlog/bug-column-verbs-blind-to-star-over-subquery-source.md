---
description: A saved view that copies every column out of a nested query is not recognised as passing those columns along, so renaming a column upstream silently breaks the view, and dropping the column is allowed even when a rule still depends on it.
prereq: column-scope-walk-binds-aliased-sources
files:
  - packages/quereus/src/schema/rename/column-rename.ts       # ScopeFrame.realSources / bodyPublishesColumnNamed — where the column set is unaskable
  - packages/quereus/src/schema/column-republication.ts       # the republication fixpoint that consumes the answer
  - packages/quereus/src/runtime/emit/drop-column-guards.ts   # DROP COLUMN guards on the same lineage
difficulty: hard
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: Fixing it means teaching the rename/drop walk to infer the output column set of an arbitrary nested query body — real machinery for a spelling most schemas never use, and the walk is deliberately catalog-only today; a maintainer may prefer to keep the limit documented until someone actually hits it.
---

# A `*` over a subquery source republishes columns nothing can see

`ALTER TABLE … RENAME COLUMN` and `ALTER TABLE … DROP COLUMN` both work out which
views and materialized views pass a table's column through to their own output —
that lineage is what the rename cascade re-targets on and what the drop guards
probe. The lineage walk answers "does this `*` cover the column?" by asking the
catalog for the column set of each FROM source. A **real table** source can be
asked. A **subquery source** (`from (select …) s`) and a **function source**
cannot: the walk would have to infer the inner body's output columns
recursively, which it does not do.

So a view whose only path to the column is a star over a subquery source is not
seen as a republisher, and neither verb follows it.

## Verified

Both blocks were run against the engine as it stands.

**Rename breaks a downstream view, silently:**

```sql
create table t (id integer primary key, x integer);
create view v as select * from (select * from t) s;
create view w as select x from v;

alter table t rename column x to z;
select * from w;                  -- ERROR: Column not found: x
```

**Drop is accepted while a rule still reads the column through the view:**

```sql
create table t (id integer primary key, x integer);
create view v as select * from (select * from t) s;
create assertion a1 check (not exists (select 1 from v where x < 0));

alter table t drop column x;      -- accepted; should be refused
```

Assertions are recompiled on any commit that touched any table, so the orphaned
assertion then blocks writes to tables it has nothing to do with.

## Second arm — a bare column ref over a subquery source (RENAME only)

Found while writing the spelling matrix for `column-scope-walk-binds-aliased-sources`
(`packages/quereus/test/schema/column-scope-body-spellings.spec.ts`). Same root
site, same fix; recorded here rather than as its own ticket.

A star is not required. An **outer bare column reference** whose only binding is
a subquery source is equally invisible, because the source registers no
qualifier:

```sql
create table t (id integer primary key, x integer);
create view v as select id, x from (select id, x from t) s;

alter table t rename column x to z;
select * from v;                  -- ERROR: Column not found: x
```

The rename rewrites the INNER `select id, x from t` (that select gets its own
scope frame, where `t` is bound normally) but leaves the OUTER `x` alone, so the
view is left projecting a name its own source no longer publishes.

The two verbs part company on this shape, which is worth knowing when the fix
lands: the DROP guard **does** refuse here, because the inner select spells the
column in a frame the walk can see. So it is only `RENAME COLUMN` that is blind.
Pinned as a pending rename-arm cell in the spec above.

## Not affected

A star over a **CTE** source is already correct — the CTE exposure analysis
answers the same question for CTEs — so this is narrower than it first looks:

```sql
create view v as with c as (select * from t) select * from c;   -- follows the rename correctly
```

A star over an **aliased real table** (`select * from t a`) is the separate,
already-scoped `column-scope-walk-binds-aliased-sources`; this ticket is only
about sources whose column set is unaskable at all.

## Where it lives

The limit is already recorded in the code, on `ScopeFrame.realSources` and in
`bodyPublishesColumnNamed`'s doc comment in
`packages/quereus/src/schema/rename/column-rename.ts`. The shape of a fix is
recursive output-column inference on a subquery source's body — the same
analysis the CTE arm already performs for CTEs, generalized to an inline
subquery — after which the source can be recorded alongside the real ones and
every existing consumer answers correctly with no further change.
