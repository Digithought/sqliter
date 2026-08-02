---
description: Renaming a table only fixes up the views and rules that live in the same schema as that table. Anything in another schema that referred to it keeps pointing at the old name and quietly stops working.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts               # propagateTableRenameInSchema (~2038) / propagateColumnRenameInSchema (~2179) — the schema-name guard that scopes the walk
  - packages/quereus/src/schema/rename-rewriter.ts                 # renameTableInAst / renameColumnInAst — where an "explicitly-qualified references only" mode would go
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts # propagateTableRenameToMaterializedViews / propagateColumnRenameToMaterializedViews
  - packages/quereus/src/schema/catalog-persistability.ts          # assertRenameDependentsPersistable — its view arm is scoped the same way and would widen with the fix
  - docs/sql-alter.md                                              # lines 19 / 29 enumerate what a rename propagates into
repro: verified
---

# A rename does not reach dependents in other schemas

## What happens

`ALTER TABLE … RENAME` (and `RENAME COLUMN`) rewrite the old name into dependent
schema objects so those keep working. Two of those walks are scoped to the renamed
table's **own** schema:

- view bodies,
- materialized-view bodies,

and — once `implement/bug-table-rename-breaks-dependent-assertions` lands — a third:

- assertion (integrity-rule) bodies.

Foreign keys, CHECK expressions and partial-index predicates are *not* affected:
their walk already runs over every schema.

So an object in schema A that refers to a table in schema B keeps naming the old
table after B's rename, and silently stops working.

## Reproduction (verified)

View, cross-schema:

```
create table temp.u ( x integer primary key );
create view vu as select x from temp.u;          -- view lives in main
alter table temp.u rename to u2;                 -- succeeds

select * from vu;
-- Table not found: temp.u
```

The stored view body is unchanged: `create view vu as select x from "temp".u`.

Assertion, cross-schema (same shape, worse blast radius — an assertion is
evaluated at every commit, so this breaks writes to the *whole* database, not just
reads of one view):

```
create table temp.u ( x integer primary key );
create assertion a1 check (not exists (select 1 from temp.u where x < 0));
alter table temp.u rename to u2;                 -- succeeds

insert into temp.u2 values (1);
-- Table not found: temp.u
```

Control (same schema) works correctly in both cases.

## Why the walks are scoped this way

A stored body resolves *unqualified* names against its own schema first
(`Database._homeSchemaPath`). So an unqualified `u` inside an object living in
schema A does not necessarily mean the renamed `B.u`, and rewriting it would be a
false positive — silently rebinding a body to a table it never named. Restricting
the walk to the renamed table's own schema avoids that, at the cost of missing the
explicitly-qualified cross-schema case entirely.

## Shape of the fix

Both halves can be had: walk the dependents of **every** schema, and when the
dependent's home schema differs from the renamed table's, match only references
that carry an *explicit* schema qualifier. That means an opt-in mode on the
walkers in `rename-rewriter.ts`:

- **Table rename** — the smaller half. The walk's `schemaMatches` helper currently
  treats an absent qualifier as a match; under the mode it would require the
  qualifier to be present and equal. Affects the `table` and `column` cases of
  `visitTableRename` plus `rewriteIdentifierIfTable`.
- **Column rename** — larger. The scope machinery binds a FROM source as "the
  renamed table" partly on an absent qualifier (`collectFromBindings`), and the
  qualified-column path (`directHit` in the `column` case) checks the qualifier
  against the renamed table without consulting what the FROM actually bound. Both
  need to become qualifier-aware together, or the mode will either miss
  `from temp.u where u.x < 0` or falsely rewrite `from u where u.x < 0`.

One mode, applied at three call sites (view loop, MV pass, assertion pass) in both
propagation functions. `assertRenameDependentsPersistable`'s view/MV arm is scoped
to the same single schema and would widen alongside, so a store-backed
cross-schema dependent still gets its persistability veto.

## Known sub-case that stays open even then

An object in schema A whose **unqualified** reference resolves to a table in
schema B through the session search path (verified reachable: an assertion in
`temp` whose bare `t` binds to `main.t`, and which does correctly enforce against
`main.t`). Nothing in the stored body records which schema the name bound to, and
the search path is mutable session state, so this is not decidable after the fact.
Deciding it would need the binding to be recorded at create time — a larger change
than this ticket, and worth stating as a limitation rather than guessing.
