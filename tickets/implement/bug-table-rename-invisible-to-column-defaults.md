---
description: Renaming a table breaks any table whose column default or computed-column expression reads it, leaving that table unable to accept new rows; the same reference written as a CHECK rule is already fixed up by the rename, so only column expressions are missed.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts             # rewriteTableForTableRename (~2188) — add the columns arm; model is the column verb's arm at ~2388-2403
  - packages/quereus/src/schema/rename-rewriter.ts               # add renameTableInColumnExpressions next to renameTableInCheckConstraints (~367-375)
  - packages/quereus/src/index.ts                                # ~221-223 — re-export barrel for the rename walkers
  - packages/quereus-store/src/common/store-module-rename.ts     # ~197-200 rewriteTable — add the columns arm before saveTableDDL
  - packages/quereus/src/schema/catalog-persistability.ts        # cloneTableRewritableAsts already spine-clones column exprs — no change needed
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic  # engine-side coverage
  - packages/quereus-store/test/rename-column-default-reopen.spec.ts    # shape to mirror for the store-side test
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

The identical reference written as a **CHECK** constraint *is* rewritten, because
the table-rename pass walks `checkConstraints` and index predicates. It never walks
`table.columns`, so the two expressions a column carries — `defaultValue` and
`generatedExpr` — are invisible to it. Same blind spot the column-rename verb had
until `bug-column-default-new-qualifier-invisible-to-column-rename` landed; this is
the table verb's half of it, which that ticket did not touch.

## Repro state (verified in-process at `ee58ef1f`, memory backend)

Three distinct arms confirmed broken, one confirmed already-working:

| shape | after `alter table u rename to u2` |
| --- | --- |
| `t.w integer default ((select min(v) from u))` | `insert into t` → `Table 'u' not found` |
| `g.gg integer generated always as ((select min(u.v) from u) + id)` | `insert into g` → `Table 'u' not found` |
| self-reference: `t.w integer default ((select count(*) from t))`, then `rename t to t9` | `insert into t9` → `Table 't' not found` |
| `check ((select min(v) from u) < 100)` on another table | works (already covered) |

Notes from probing the shapes:

- A **generated** column cannot carry an *unqualified* cross-table subquery ref —
  `generated always as ((select min(v) from u) + id)` is refused at create time by the
  generated-column dependency check ("Column 'v' referenced by generated column 'gg' not
  found in table 'g'"). The **qualified** form `(select min(u.v) from u)` is accepted, so
  the generated arm is reachable and must be covered.
- The **self-reference** row is what makes the store hook load-bearing: the renamed
  table's own default names the renamed table, and `formatColumnDef` renders a DEFAULT
  (and, since `bug-store-reopen-loses-computed-columns` landed, a `GENERATED ALWAYS AS`
  clause too) into the persisted DDL bundle.

## Expected behavior

`ALTER TABLE u RENAME TO u2` rewrites the renamed table's name inside every column
default and generated expression that names it — the renamed table's own columns and
every other table's — on the same terms as a CHECK expression. After the rename, `t`
keeps accepting rows and reads `u2`, and a store-backed database persists a bundle
naming `u2`.

## Design

Three call sites, mirroring exactly how the CHECK arm is already wired. Unlike the
column verb, the table walker has **no seeded/unseeded split** — `renameTableInAst` is
uniform over any expression — so one entry point covers both the renamed table's own
columns and every other table's.

### `rename-rewriter.ts` — new entry point

```ts
export function renameTableInColumnExpressions(
	columns: ReadonlyArray<{
		readonly defaultValue?: AST.Expression | null;
		readonly generatedExpr?: AST.Expression;
	}> | undefined,
	oldName: string,
	newName: string,
	defaultSchemaName: string,
): boolean
```

Structurally typed (no catalog import), backed by the existing `rewriteEach` helper, run
once over `defaultValue` and once over `generatedExpr` with **both walks always running**
(`||` on the two results, not short-circuited) — the same shape
`renameColumnInColumnExpressions` (~656) uses. Same sharing/idempotence story as
`renameTableInCheckConstraints`: the `Expression` is the catalog's own node, so one
in-place rewrite reaches every holder and a second call finds nothing naming `oldName`.

Re-export from `packages/quereus/src/index.ts` alongside the other rename walkers
(~221-223) — the store package consumes it from there.

### `alter-table.ts` — `rewriteTableForTableRename` columns arm

Add after the index-predicate arm (~2220):

```ts
const columnsRewritten = renameTableInColumnExpressions(
	table.columns, oldName, newName, renamedSchemaLower);
if (columnsRewritten) changed = true;
```

No per-item shallow copy — same reasoning as the column verb's arm (~2395-2399): the
rewrite is in place and a `ColumnSchema`'s own fields are untouched, so flipping
`changed` (which re-registers the table and fires `table_modified`) is all a copy would
have achieved.

This one edit covers **both** call sites that matter, because both already route through
this function:

- `propagateTableRenameInSchema` (~2136) — every table in every schema.
- `runRenameTable` (~281) — the renamed table's own schema, before the catalog swap, so
  no listener observes a self-referencing default naming the vanished old name.

It also extends the pre-flight persistability probe for free:
`assertRenameDependentsPersistable` (~231-233) is handed this same function, and
`cloneTableRewritableAsts` already spine-clones each column's default / generated
expression, so a vetoed statement cannot leave a rewritten live AST behind. **No change
needed in `catalog-persistability.ts`.**

### `store-module-rename.ts` — hook arm

Extend the existing `rewriteTable` closure (~197-200), which rewrites in place *before*
`saveTableDDL` for the crash-window reason documented above it:

```ts
const rewriteTable = (from: string, to: string): void => {
	renameTableInIndexPredicates(currentSchema.indexes, from, to, schemaName);
	renameTableInCheckConstraints(currentSchema.checkConstraints, from, to, schemaName);
	renameTableInColumnExpressions(currentSchema.columns, from, to, schemaName);
};
```

The reverse-on-throw pass picks the new arm up automatically.

**The reverse pass's stated assumption gets weaker here, and the code comment above it
must say so.** The existing NOTE (~190-196) argues that no expression can legitimately
have named `newName` before the rename, because the rename-target guard rejects an
existing table and `compilePredicate` rejects a foreign qualifier in a predicate. Neither
argument covers a default: a default naming a **nonexistent** table is accepted at create
time (verified — `create table t (… default ((select v from nosuch)))` succeeds; the ref
only fails when a row is written). So `create table u (…, v integer default ((select 1
from u2)))` followed by `alter table u rename to u2` has a forward pass that matches
nothing and a reverse pass — reached only if `saveTableDDL` throws — that would clobber
`u2` back to `u`. Update the NOTE to record the residual rather than trying to close it;
closing it needs a per-walk changed-set, which is not worth it for a
failed-persist-only path.

### Deliberately out of scope

- **The memory module** needs no arm: its `renameTable` (`vtab/memory/module.ts` ~945)
  only re-keys its internal registration and emits an event — it compiles no default at
  rename time. Same reasoning that kept the column verb out of it.
- **`schema-differ.ts`** needs no arm. Its column-default compare
  (`computeColumnAttributeChange` ~2429-2452) already documents that it is *not*
  inverse-reconciled against pending renames: a declared default naming `u2` against an
  actual still naming `u` emits one redundant `ALTER COLUMN … SET DEFAULT` alongside the
  `RENAME TO`. Harmless for the table verb for the same reason it is for the column verb —
  the emitter orders the rename first, so the redundant statement re-sets the column to
  exactly what the propagation already produced, and the follow-up diff is empty. Do not
  extend the reconcile.
- **`DROP TABLE u`** in this shape is also unguarded (verified): it succeeds and leaves
  `t` unwritable. Equally true for a CHECK reference today, so it is a gap in `DROP
  TABLE`'s guard posture rather than a defaults-specific one — see the backlog ticket
  `bug-drop-column-skips-check-on-another-table` for the DROP COLUMN analogue. Leave it.
- The table walker's CTE blind spot (`bug-table-rename-rewrites-cte-references`, backlog):
  the new entry point inherits it, since it runs the same `visitTableRename`. Don't fix it
  here; the fix belongs in the walker and lands for all four arms at once.

## TODO

- Add `renameTableInColumnExpressions` to `packages/quereus/src/schema/rename-rewriter.ts`,
  next to `renameTableInCheckConstraints`, with a doc comment covering the two fields, the
  no-seed-split reason, the sharing/idempotence story, and the structural typing.
- Re-export it from `packages/quereus/src/index.ts` next to the other rename walkers.
- Add the columns arm to `rewriteTableForTableRename` in
  `packages/quereus/src/runtime/emit/alter-table.ts`, with the no-shallow-copy note.
- Add the columns arm to `rewriteTable` in
  `packages/quereus-store/src/common/store-module-rename.ts`, and amend the reverse-pass
  NOTE above it to record that a default may name a not-yet-existing table, so the
  "nothing legitimately named `newName`" argument does not hold for the column arm.
- Extend `packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic` (append a new
  numbered section, matching the file's existing section style):
  - default with a cross-table subquery survives `rename to` and reads the renamed table;
  - self-referencing default (`default ((select count(*) from t))`) survives `rename t to t9`;
  - generated column with a **qualified** cross-table subquery
    (`generated always as ((select min(u.v) from u) + id)`) survives the rename and
    computes against the renamed table;
  - negative case: a subquery inside a default whose own FROM binds a like-named *source*
    is untouched — mirror the existing `t_xnest` / `u_xnest` section at the file's tail,
    which does this for the column verb.
- Add `packages/quereus-store/test/rename-table-default-reopen.spec.ts`, mirroring
  `rename-column-default-reopen.spec.ts`: a store-backed table whose default names the
  renamed table (both the self-reference and the other-table shape), renamed, then
  **reopened**, asserting the persisted DDL names the new table and an insert still
  resolves it.
- Run `yarn build`, `yarn test`, `yarn lint`. Run `yarn test:store` too — the store hook
  arm and the reopen spec are only exercised there.
