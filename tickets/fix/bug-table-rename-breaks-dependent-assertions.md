---
description: Renaming a table silently breaks any integrity-check rule that refers to it — afterwards every write to the renamed table fails with "table not found", and the schema comparison tool reports everything is fine.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts        # rename propagation walks views, materialized views, CHECK constraints, index predicates — never assertions
  - packages/quereus/src/schema/rename-rewriter.ts          # the AST rewriters the propagation uses (renameTableInAst / renameColumnInAst)
  - packages/quereus/src/schema/assertion.ts                # IntegrityAssertionSchema: checkExpression + violationSql, both captured verbatim at create
  - packages/quereus/src/schema/schema-differ.ts            # assertion loop (~841) — sees no drift, so `diff schema` reports converged
difficulty: medium
repro: verified
---

# `ALTER TABLE … RENAME` does not follow into assertion bodies

## What happens

An assertion (`create assertion a1 check (not exists (select 1 from t where x < 0))`)
stores its CHECK expression as written. When the table it names is renamed —
whether by an explicit `alter table t rename to t2` or by a declarative
`apply schema` that carries a rename hint — the engine rewrites the rename into
every other dependent object it knows about (view bodies, materialized-view
bodies, CHECK constraints on any table, partial-index predicates) but **not** into
assertion bodies. The assertion stays bound to the old name.

The consequences are two, and the second is why this is worse than an ordinary
stale-reference bug:

- **Every write to the renamed table fails.** Assertions are evaluated at commit
  over the tables that changed, so an insert into `t2` raises
  `Table 't' not found in schema path: main` — an error that names a table the
  user just renamed away and never mentions the assertion.
- **The schema comparison reports converged.** The declared assertion body and
  the stored assertion body both still say `t`, so `diff schema` returns `[]`.
  Nothing in the tooling surfaces the broken state; re-applying does not repair it.

## Reproduction (verified)

```sql
declare schema main {
  table t ( x integer primary key )
  assertion a1 check (not exists (select 1 from t where x < 0))
}
apply schema main;

-- rename the table, leave the assertion body naming the old table
declare schema main {
  table t2 ( x integer primary key ) with tags ("quereus.previous_name" = 't')
  assertion a1 check (not exists (select 1 from t where x < 0))
}
diff schema main;   -- → [ALTER TABLE t RENAME TO t2]   (assertion looks fine)
apply schema main;  -- succeeds
diff schema main;   -- → []                             (reports converged)

insert into t2 values (-5);
-- Table 't' not found in schema path: main
```

The imperative path reproduces the same way (`create table` / `create assertion`
/ `alter table t rename to t2` / `insert into t2 …`) — the declarative wrapper is
not required, it just makes the "reports converged" half visible.

## Expected behavior

A table (or column) rename should carry into every live assertion the same way it
carries into view bodies and CHECK constraints: the stored CHECK expression is
rewritten to the new name, and whatever derived form the assertion evaluator uses
(the violation query, the dependent-table list, any cached plan) is rebuilt from
it. After the rename the assertion enforces the same rule against the renamed
table, and a re-diff stays empty for the right reason.

Scope worth settling while investigating:

- **Column renames**, not only table renames — the same walkers exist for both, and
  an assertion body naming a renamed column has the same failure.
- **Cross-schema assertions.** An assertion resolves unqualified names against its
  own schema first, so the propagation must walk assertions in every schema and
  compare against the renamed table's schema, as the view walk already does.
- **The declarative side, once propagation lands.** Today the differ deliberately
  does no rename reconciliation for assertions: a rename plus a body updated to the
  new name churns a harmless drop+recreate. If propagation makes stored bodies track
  renames, that reconciliation becomes worth adding for symmetry with the view and
  index paths — decide whether it belongs in this ticket or a follow-up.

## Notes

Not caused by, and not in scope of, `bug-assertion-body-drift-invisible-to-diff`
(which made a *changed* assertion body visible to the diff). That ticket's review
found this one and left a pointer comment at the differ's assertion loop and in
`docs/schema.md` § "Assertion body-change detection".
