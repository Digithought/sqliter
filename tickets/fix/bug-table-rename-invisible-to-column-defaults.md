---
description: Renaming a table breaks any other table whose column default reads it, leaving that other table unable to accept new rows; the same rename already fixes up the equivalent reference written as a CHECK rule, so only defaults are missed.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts        # rewriteTableForTableRename (~2188) — rewrites checkConstraints + index predicates, never table.columns
  - packages/quereus/src/schema/rename-rewriter.ts          # renameTableInCheckConstraints / renameTableInIndexPredicates (~348-375) — the shape a columns entry point would follow
  - packages/quereus/src/schema/catalog-persistability.ts   # cloneTableRewritableAsts already spine-clones the column expressions
  - packages/quereus-store/src/common/store-module-rename.ts # ~198 — the in-hook arm that rewrites predicates + CHECKs before persisting the DDL bundle
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic # where rename-propagation coverage lives
repro: verified
---

# `ALTER TABLE … RENAME TO` does not follow column DEFAULT / generated expressions

## What happens

A column default may read another table through a subquery:

```sql
create table u (k integer primary key, v integer);
insert into u values (1, 42);
create table t (id integer primary key, w integer default ((select min(v) from u)));

alter table u rename to u2;

insert into t (id) values (1);
-- ERR: Table 'u' not found in schema path: main
```

`t` now accepts no rows at all, and the error names a table the user renamed
somewhere else — nothing points back at the statement that caused it.

Verified in-process at `ccdcf8f9` + this review's fixes.

The identical reference written as a **CHECK** constraint *is* rewritten, because
the table-rename pass walks `checkConstraints` and index predicates. It never walks
`table.columns`, so the two expressions a column carries — `defaultValue` and
`generatedExpr` — are invisible to it. That is the same blind spot the column-rename
verb had until `bug-column-default-new-qualifier-invisible-to-column-rename` landed;
this is the table verb's half of it, which that ticket did not touch.

## Expected behavior

`ALTER TABLE u RENAME TO u2` should rewrite the renamed table's name inside every
column default and generated expression that names it, on the same terms as a CHECK
expression — after which `t` keeps accepting rows and reading `u2`.

## Where the work sits

Three call sites, mirroring how the CHECK arm is already wired:

- `rewriteTableForTableRename` needs a columns arm. The pre-flight persistability probe
  (`cloneTableRewritableAsts`) already spine-clones the column expressions, so a
  vetoed statement is already safe — that half needs nothing.
- `rename-rewriter.ts` needs a `renameTableInColumnExpressions` entry point next to
  `renameTableInCheckConstraints`, structurally typed the same way.
- The store module's rename hook (`store-module-rename.ts` ~198) rewrites predicates and
  CHECKs *in place before persisting the bundle*, for the crash-window reason documented
  there; the columns arm belongs in the same place, since `formatColumnDef` renders a
  DEFAULT into the persisted DDL. Without it a store-backed database can persist a bundle
  naming the pre-rename table.

The memory module needs no arm (it compiles no default at rename time — same reasoning
that kept the column verb out of it).

## Related — not this ticket

- `DROP TABLE u` in the same shape is also unguarded: it succeeds and leaves `t`
  unwritable (verified). That is equally true for a CHECK reference today, so it is a
  gap in `DROP TABLE`'s guard posture rather than a defaults-specific one — see
  `bug-drop-column-skips-check-on-another-table` for the DROP COLUMN analogue.
- `bug-table-rename-rewrites-cte-references` — the opposite failure (the table walker
  over-rewriting) in the same walker family.
