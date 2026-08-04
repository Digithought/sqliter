---
description: Renaming a column updates the views that read that column, but not anything reading those views — so a second view, or an integrity rule, that used the old column name silently stops working, and in the rule's case every later write to the database fails.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts   # propagateColumnRenameInSchema — the single-pass view / MV / assertion loops
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts  # propagateColumnRenameToMaterializedViews — carries the shifted output name onto the backing table
  - packages/quereus/src/runtime/emit/assertion-rename-helpers.ts   # propagateColumnRenameToAssertions
  - packages/quereus/src/schema/rename-rewriter.ts     # renameColumnInAst — rewrites against ONE renamed table, not a chain
  - docs/sql-alter.md                                  # § RENAME COLUMN — enumerates what a rename propagates into
repro: verified
---

# RENAME COLUMN stops one level deep

## What happens

`ALTER TABLE t RENAME COLUMN x TO y` rewrites the body of every view and
materialized view that reads `t.x`. For a view like `select id, x from t`, that
rewrite also changes the **name the view exposes** — it now publishes `y`, not
`x`. Nothing then revisits the objects that were reading `x` *from the view*.
They keep naming a column that no longer exists.

Verified in-process at HEAD, memory module.

View over a view:

```sql
create table w3 (id integer primary key, x integer);
create view v1 as select id, x from w3;
create view v2 as select id, x from v1;
alter table w3 rename column x to y;      -- succeeds

-- v1 body became: select id, y from w3     (correct)
-- v2 body is unchanged: select id, x from v1
select * from v2;
-- Column not found: x
```

Integrity rule over a view — same cause, much larger blast radius:

```sql
create table w2 (id integer primary key, x integer);
create view v as select id, x from w2;
create assertion m2 check (not exists (select 1 from v where x < 0));
alter table w2 rename column x to y;      -- succeeds

insert into w2 values (1, 5);
-- Column not found: x
```

The rule is re-planned on every commit that touched any table, so once its body
names a column that no longer exists, **every write to the whole database fails**
— with an error that names neither the rule nor the view.

A materialized view behaves identically (its shifted output name is carried onto
its backing table, and readers of the old name break the same way).

`RENAME TABLE` does **not** have this problem: renaming a table changes no
dependent's exposed names, so one pass is enough.

## Why it is one pass today

`propagateColumnRenameInSchema` walks the catalog once, rewriting each dependent
body against *the one renamed table*. A dependent whose own exposed name shifted
as a result is not itself treated as a renamed source, so the walk never reaches
its readers.

## What a fix has to settle

- **How far to cascade.** A view whose output name shifted is, for its readers,
  exactly a `RENAME COLUMN` on that view — so the honest fix is to iterate the
  propagation to a fixpoint over the dependency graph. That needs cycle handling
  and a bound.
- **When the name does *not* shift.** `select x as label from t` exposes `label`
  regardless; only a passthrough projection shifts. The existing materialized-view
  pass already decides this question for its own output (bare passthrough only) —
  the same predicate should drive the cascade rather than a second, drifting copy.
- **Whether to refuse instead of cascade.** Failing the `ALTER` when a dependent
  cannot be followed is a defensible alternative and matches how the assertion
  drop guard treats the same blast radius. It is a policy call, not a detail.
- **Interaction with the drop-side work.** `bug-drop-table-under-view-an-assertion-names`
  and `bug-drop-column-skips-dependent-checks` are asking the same question about
  the same graph ("what transitively depends on this object"). Whoever picks any of
  the three up should look at whether one reachability service answers all of them.

## Relationship to the other rename ticket

`bug-rename-not-propagated-across-schemas` is a different axis at the same call
sites: it widens the walk *sideways* (to dependents in other schemas), this one
widens it *downward* (to dependents of a dependent). Neither fix delivers the
other; they can land in either order.
