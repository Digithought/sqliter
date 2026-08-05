---
description: Renaming a table also rewrites anything else that happens to share its name inside stored views and rules — a local temporary result set, or the "new"/"old" prefix that names the row being written — so those objects silently read the wrong thing, return wrong answers, or stop accepting writes at all.
files:
  - packages/quereus/src/schema/rename-rewriter.ts   # visitTableRename — the walk; no scope tracking at all
  - packages/quereus/src/runtime/emit/alter-table.ts # propagateTableRenameInSchema — the caller for views/MVs/assertions
  - packages/quereus/src/runtime/emit/assertion-drop-guard.ts # inherits the same over-match as a false refusal
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic # where rename-dependent coverage lives
  - packages/quereus/test/logic/53.2-materialized-view-rename-propagation.sqllogic
  - packages/quereus/test/logic/95-assertions.sqllogic # assertion rename + drop-guard coverage
  - packages/quereus/test/logic/41.10.2-alter-drop-column-check-and-assertion.sqllogic # §13/§14 — the row-image scope cases the column walker already covers
repro: verified
---

# A table rename rewrites `with`-clause names that merely share the table's name

## What happens

A `with` clause (common table expression, "CTE") defines a temporary,
statement-local result set. Inside a stored view body or an assertion CHECK
body, a CTE named `zap` shadows any real table also called `zap` — references
after the `with` bind to the CTE, not to the table.

`ALTER TABLE zap RENAME TO zap2` walks every dependent body and rewrites
references to `zap`. That walk does not know what a CTE is: it rewrites the
shadowed reference too. The body is left reading the *real* table under its new
name, and the CTE it declared goes unused.

## Reproduction (verified, memory module, at commit `4e66323f`)

View:

```sql
create table zap (k integer primary key);
create view vz as with zap as (select 1 as k) select k from zap;

select * from vz;                    -- [{k: 1}]  — reads the CTE
alter table zap rename to zap2;      -- succeeds
select * from vz;                    -- []        — now reads the empty table
```

Assertion (same rewrite, and the stored text is directly observable):

```sql
create table zap (k integer primary key);
create assertion az check (not exists (with zap as (select 1 as k where 1=0) select k from zap));
alter table zap rename to zap2;

select violation_sql from assertion_info();
-- select 1 where not (not exists (with zap as (...) select k from zap2))
--                                                              ^^^^ was the CTE
```

No error is raised at any point. The view/assertion keeps working — it just
answers a different question than the one that was written.

## Root cause

`visitTableRename` in `packages/quereus/src/schema/rename-rewriter.ts` is
scope-blind. It descends into `withClause.ctes` and into the body, and matches
every `table` source and every qualified `column` by bare name, with no record
of which names the enclosing `with` has bound.

The *column* rename walker in the same file already carries this machinery — its
`ScopeFrame` tracks `ctesInScope`, `ctesExposingRenamed` and
`ctesShadowingSource` precisely to avoid the analogous mistake. The table walker
having none of it looks like an oversight rather than a decision.

## Second symptom: a spurious `DROP TABLE` refusal

`bug-assertion-body-can-name-missing-table` added a guard that refuses
`DROP TABLE` / `DROP VIEW` / `DROP MATERIALIZED VIEW` while an assertion body
still names the object, and it decides "names" by running this same walk
read-only (`tableReferencedInAst`). So an assertion that only ever mentions a
CTE called `zap` blocks `drop table zap`:

```
cannot drop table 'main.zap': assertion 'az' still refers to it — drop or redefine the assertion first
```

That direction is merely annoying (the user can drop the assertion, and nothing
is corrupted), but it is the same over-match and it disappears with the same
fix. Keeping the guard and the rename walk on one shared definition of "refers
to" is deliberate — see the comment on `tableReferencedInAst` — so the fix
should stay in the walker, not be special-cased in the guard.

## Third symptom: a table called `new` or `old`, renamed, breaks other tables' CHECKs

Found during review of `bug-check-constraint-new-old-qualifier-invisible-to-column-rename`
(memory module, at commit `3bd01d40`). Same scope-blind walk, different shadowed
namespace.

A CHECK constraint may name the row being written explicitly — `check (new.a > 0)`,
`check on delete (old.a > 0)`. `new` and `old` are not reserved words here, so a real
table may also be called `new`. Renaming that table rewrites the row-image qualifier in
every *other* table's CHECK, and those tables become unwritable:

```sql
create table "new" (a integer primary key);
create table T (id integer primary key, a integer, constraint ck check (new.a > 0));
insert into T values (1, 5);                 -- OK

alter table "new" rename to "renamed";       -- succeeds

insert into T values (2, 7);                 -- ERROR: renamed.a isn't a column
```

`T`'s CHECK never referred to the `new` table at all — `new.a` named `T`'s own written
row. The walk matched it by bare name.

The mirror direction (RENAME COLUMN / DROP COLUMN failing to see `new.a`) was the
column walker's version of this and is already fixed; the fix taught the *column* walker
that a `new.` / `old.` qualifier in a CHECK names the row image unless an inner FROM
rebinds it. `visitTableRename` needs the complementary rule: a `new.` / `old.` qualifier
in a CHECK expression of the table that owns it is a row image, not a table reference,
and must not be rewritten by a table rename — again unless an inner FROM rebinds the
name, which is exactly the CTE/alias scope tracking the rest of this ticket is about.

Note this arm needs the walk to know *whose* CHECK it is walking, which the column
walker gets from a seeded entry point (`renameColumnInCheckExpression`) and the table
walker currently has no equivalent of.

## Expected behaviour

A reference that binds to a `with`-clause name is not a reference to the table,
and must be left alone by both the rewrite and the read-only guard. A reference
that binds to the real table (including one appearing *before* the shadowing
`with`, or in a sibling scope where the CTE is not visible) must still be
rewritten as it is today.

Worth deciding as part of this: whether a CTE that shadows a real table name
inside a *stored* body should be accepted at create time at all, or warned
about. The existing behaviour (accept, shadow) is the SQL-standard reading and
is probably right; the point is that the rename walk must respect it.

## Coverage

Needs cases for: CTE shadowing in a view body, in an assertion body, and in a
materialized-view body; a reference outside the CTE's scope still rewriting; a
CTE whose name does *not* collide staying untouched; and the drop-guard
direction (a CTE-only mention must not block the drop).
