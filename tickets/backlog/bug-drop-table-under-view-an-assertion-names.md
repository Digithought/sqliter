---
description: Dropping a table that a view is built on is allowed even when a database-wide integrity rule uses that view, and afterwards every write to the whole database fails with an error that mentions neither the rule nor the view.
files:
  - packages/quereus/src/runtime/emit/assertion-drop-guard.ts   # the guard; only sees direct references today
  - packages/quereus/src/runtime/emit/drop-table.ts             # call site
  - packages/quereus/src/schema/rename-rewriter.ts              # tableReferencedInAst — the "refers to" walk
  - packages/quereus/test/logic/95-assertions.sqllogic          # where the direct-reference coverage lives
repro: verified
---

# A view sitting between an assertion and a table defeats the drop guard

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

## Not in scope

The direct-reference guard itself works and is covered
(`95-assertions.sqllogic`, sections "DROP refused while an assertion refers to
the object"). `ALTER TABLE … DROP COLUMN` under an assertion is a separate arm,
already claimed as "Arm C" of `bug-drop-column-skips-dependent-checks`.
