---
description: Dropping a table is still allowed in two cases where a database-wide integrity rule depends on it — when the rule reaches the table through a view, and when the rule lives in a different schema — and afterwards every write to the whole database fails with an error that mentions the rule nowhere.
files:
  - packages/quereus/src/runtime/emit/assertion-drop-guard.ts   # the guard; only sees direct references today
  - packages/quereus/src/runtime/emit/drop-table.ts             # call site
  - packages/quereus/src/schema/rename-rewriter.ts              # tableReferencedInAst — the "refers to" walk
  - packages/quereus/src/core/database.ts                       # _homeSchemaPath — what arm 2's bare name resolves against
  - packages/quereus/test/logic/95-assertions.sqllogic          # direct-reference coverage + the "same-schema scoping" case arm 2 widens
repro: verified
---

# The assertion drop guard misses two kinds of reference

Two arms, both resolving at `assertNoAssertionDependsOn`: the guard does not
follow a reference **through a view**, and it does not look at assertions
**living in another schema**.

## Arm 1 — a view sitting between an assertion and a table

`bug-assertion-body-can-name-missing-table` made `DROP TABLE` / `DROP VIEW` /
`DROP MATERIALIZED VIEW` refuse when an assertion's stored CHECK body **names
the dropped object directly**. One indirection defeats that check.

Reproduced in-process at HEAD (memory module), after that fix landed:

```
create table t (x integer primary key);
create view v as select * from t;
create assertion av check (not exists (select 1 from v where x < 0));
create table other (i integer primary key);
drop table t;                     -- OK — the assertion names `v`, not `t`
insert into other values (1);
-- Table 't' not found in schema path: main
```

`drop view v` **is** refused (the assertion names `v`). `drop table t` is not,
because the guard scans assertion bodies only — it never opens the view body
that stands between them.

## Why it matters more than a plain broken view

Dropping a table under a plain view is long-standing accepted behaviour: the
view breaks, and queries *of that view* fail. That trade is deliberate. What is
different here is blast radius. The commit-time evaluator recompiles **every**
live assertion on any commit that touched any table, so an assertion that cannot
be planned blocks writes to the **entire database** — at some unrelated later
statement, with an error naming neither the assertion nor the view. That is the
exact failure mode the drop guard exists to prevent; a view in the middle simply
routes around it.

Recovery works and is the same as the direct case: `drop assertion av` restores
writes. So this traps nobody permanently — it is a bad failure mode, not a dead
end.

## What "refers to" would have to become

Today the guard asks `tableReferencedInAst(assertionBody, droppedName, schema)` —
a read-only run of the walker `ALTER TABLE … RENAME` uses. The question it does
not ask is whether any object the assertion names *transitively* reaches the
dropped table: view bodies, materialized-view bodies, and (recursively) views
those name.

Open design questions for whoever picks this up — this is why it is filed rather
than fixed inline:

- **How deep?** One level of view indirection covers the common case; arbitrary
  depth needs cycle handling and a bounded walk.
- **Should the same reachability rule apply to plain `DROP VIEW` under a view?**
  Being stricter for assertion-reachable objects than for view-reachable ones is
  defensible (blast radius) but should be a stated policy, not an accident.
- **Cost.** The guard runs on every user-facing drop. Walking view bodies makes
  it proportional to the view graph rather than to the assertion count. Measure
  before assuming it is free.
- Consider whether the answer is instead a general "what depends on this object"
  service, since `bug-drop-column-skips-dependent-checks` and the cross-schema
  rename gap (`bug-rename-not-propagated-across-schemas`) are asking related
  questions about the same graph.

## Arm 2 — an assertion in another schema whose bare name binds to the dropped table

Same site, same "the guard's reach is too narrow" shape, different axis: the
guard only looks at assertions living in the **dropped object's own schema**.

An assertion resolves its unqualified names against its own schema first and
then the rest of the path, so an assertion in `temp` naming a bare `mt` binds to
`main.mt` whenever `temp` has no `mt` of its own — and does correctly enforce
against `main.mt`. Dropping `main.mt` is allowed, and the database is then
unwritable.

Reproduced in-process at commit `4e66323f`, right after the guard landed:

```sql
create table mt (k integer primary key, x integer);     -- main
create table other (k integer primary key);
create assertion temp.ta check (not exists (select 1 from mt where x < 0));

drop table mt;                  -- allowed
insert into other values (1);
-- Table 'mt' not found in schema path: temp, main
```

The existing `95-assertions.sqllogic` "same-schema scoping" case does not catch
this: it creates a `temp.mt` as well, which shadows `main.mt`, so there the
refusal genuinely should not fire. Remove the shadow and the hole opens.

`bug-rename-not-propagated-across-schemas` lists this same binding as a sub-case
it cannot solve, and for **renames** that is right — a rename has to guess which
schema a stored bare name meant, and nothing records the binding. A **drop** is
easier: the catalog is live at drop time, so the guard can ask each assertion's
home schema path what a bare `mt` resolves to right now, and refuse only on an
actual hit. Explicitly-qualified `B.t` from schema A stays with the rename
ticket, since answering it needs no resolution at all — just widening the loop
to every schema.

Deciding factor for whoever picks this up: whether the guard should resolve
names (accurate, costs a catalog lookup per referenced name per assertion) or
just widen the loop and match bare names in every schema (cheap, but refuses
drops that no assertion actually depends on).

## Not in scope

The direct-reference guard itself works and is covered
(`95-assertions.sqllogic`, sections "DROP refused while an assertion refers to
the object"). `ALTER TABLE … DROP COLUMN` under an assertion is a separate arm,
already claimed as "Arm C" of `bug-drop-column-skips-dependent-checks`.
