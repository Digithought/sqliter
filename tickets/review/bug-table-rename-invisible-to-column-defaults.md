---
description: Renaming a table used to break any other table whose column default or computed-column expression read it, leaving that table unable to accept new rows; the rename now follows those expressions the same way it already followed CHECK rules.
files:
  - packages/quereus/src/schema/rename-rewriter.ts                      # new renameTableInColumnExpressions (~377)
  - packages/quereus/src/index.ts                                       # ~223 re-export
  - packages/quereus/src/runtime/emit/alter-table.ts                    # rewriteTableForTableRename columns arm (~2222)
  - packages/quereus-store/src/common/store-module-rename.ts            # rewriteTable arm (~213) + amended reverse-pass NOTE
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic  # new §38-41
  - packages/quereus-store/test/rename-table-default-reopen.spec.ts     # new store-side reopen spec
repro: verified
---

# `ALTER TABLE … RENAME TO` now follows column DEFAULT / generated expressions

## What was wrong

A column default or a generated column's body may read another table through a
subquery. The table-rename propagation walked a table's CHECK constraints, foreign
keys, and partial-index predicates, but never `table.columns` — so the two
expressions a column carries (`defaultValue`, `generatedExpr`) were invisible to it.
After `alter table u rename to u2`, a table `t` whose default read `u` accepted no
rows at all and reported `Table 'u' not found in schema path: main`, naming a table
the user had renamed in a different statement.

## What changed

One new rewriter entry point, wired at three call sites, mirroring how the CHECK arm
was already wired.

**`renameTableInColumnExpressions`** (`rename-rewriter.ts`, next to
`renameTableInCheckConstraints`): runs `renameTableInAst` over each column's
`defaultValue` and `generatedExpr` via the shared `rewriteEach` helper, both walks
always running (`||` on the results, never short-circuited). Structurally typed, so
the module stays free of catalog imports. Unlike the column verb there is **no
seeded/unseeded split** — `renameTableInAst` resolves nothing against an implicit
owning table — so one entry point covers the renamed table's own columns and every
other table's.

**`rewriteTableForTableRename`** (`alter-table.ts`) gained a columns arm after the
index-predicate arm. No per-item shallow copy (the rewrite is in place; flipping
`changed` is what re-registers the table and fires `table_modified`). That single edit
covers both callers: `propagateTableRenameInSchema` (every table in every schema) and
`runRenameTable` (the renamed table's own schema, before the catalog swap, so no
listener ever sees a self-referencing default naming the vanished old name). It also
extends the pre-flight persistability probe for free — `cloneTableRewritableAsts`
already spine-clones column expressions, so `catalog-persistability.ts` needed no
change.

**`store-module-rename.ts`** gained the same arm inside its existing `rewriteTable`
closure, which runs before `saveTableDDL` so no bundle naming the old table is ever
written. The reverse-on-throw pass picks it up automatically.

## Known gaps / things a reviewer should push on

- **The reverse-on-throw pass got weaker, deliberately.** The existing NOTE argued no
  expression could legitimately have named the new name before the rename. That does
  not hold for a default: a default naming a *nonexistent* table is accepted at create
  time (the reference is only resolved when a row is written). So `create table u (…,
  v integer default ((select 1 from u2)))` then `alter table u rename to u2` has a
  forward pass matching nothing and a reverse pass — reached only if `saveTableDDL`
  throws — that would clobber that `u2` back to `u`. Recorded in an amended NOTE above
  the closure rather than closed; closing it needs a per-walk changed-set threaded
  through every arm. **Not tested** (needs a `saveTableDDL` fault injection).
- **The CTE / alias blind spot is inherited, not introduced.** The table walker keeps
  no scope frame at all, so a subquery source *aliased* to the renamed table's name
  gets false-rewritten in a default exactly as it already does in a CHECK. Tracked as
  `bug-table-rename-rewrites-cte-references`; the fix belongs in the walker and lands
  for all four arms at once. The new sqllogic §41 therefore pins only the
  **schema-qualified** negative case (a same-named table in `temp`), and says in its
  comment why the alias shape is not pinned. A reviewer may reasonably judge that too
  thin a negative.
- **`DROP TABLE u` in this shape is still unguarded** (verified before this ticket): it
  succeeds and leaves the dependent unwritable. Equally true for a CHECK reference, so
  it is a `DROP TABLE` guard gap, not a defaults gap. Left alone per the fix ticket.
- **`schema-differ.ts` was deliberately not touched.** Its column-default compare is
  not inverse-reconciled against pending renames, so a declared default naming the new
  name against an actual still naming the old one emits one redundant `ALTER COLUMN …
  SET DEFAULT` alongside the `RENAME TO`. Harmless — the emitter orders the rename
  first, so the redundant statement re-sets the column to exactly what propagation
  already produced and the follow-up diff is empty. Not covered by a new test.
- **The memory module needs no arm** (its `renameTable` only re-keys its registration
  and emits an event; it compiles no default at rename time). Same reasoning that kept
  the column verb out of it. Unchanged, untested by anything new.

## Test coverage added (treat as a floor)

`packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic` §38-41 — runs on
both the memory leg (`yarn test`) and the LevelDB leg (`yarn test:store`):

- **§38** another table's DEFAULT with a cross-table subquery survives `rename to` and
  reads the renamed table; a second insert after mutating the renamed table confirms it
  is really reading the new name, not a stale cached value.
- **§39** self-referencing default (`default ((select count(*) from t))`) survives
  `rename t to t9`.
- **§40** generated column with a **qualified** cross-table subquery
  (`generated always as ((select min(u.v) from u) + id)`). The qualifier is forced: the
  generated-column dependency check rejects an unqualified foreign ref at create time
  (`Column 'v' referenced by generated column 'gg' not found in table 'g_tgen'`), so
  only the qualified shape is reachable.
- **§41** negative — a default whose subquery reads `temp.<name>` is untouched when
  `main.<name>` is renamed.

`packages/quereus-store/test/rename-table-default-reopen.spec.ts` — two cases:

- **self-reference**: asserts no catalog bundle *ever* names the old table inside a
  default (the crash-window half only the in-hook rewrite buys), plus the reopen
  round-trip and a post-reopen insert.
- **other table**: reopen round-trip only — that bundle is written by the post-hook
  propagation pass, so the crash-window assertion does not apply.

Both halves were **verified to fail without the fix**, not just to pass with it:

- Disabling the `alter-table.ts` arm → sqllogic §38 fails with
  `RelationNotFoundError: Table 'u_tdef' not found in schema path: main`; an
  in-process probe confirmed the §39 (self-reference) and §40 (generated) shapes fail
  the same way independently, since sqllogic stops at the first failure.
- Disabling the `store-module-rename.ts` arm → the self-reference spec fails on the
  catalog-write assertion, with the recorded bundle
  `CREATE TABLE "main"."rts9" (… DEFAULT (select count(*) from rts)) USING store`.

**Harness note worth a reviewer's eye:** the new store spec's provider had to implement
`renameTableStores`. Without it the renamed table's data stays keyed under the old
store name and reads empty, which would have made every assertion measure the harness
instead of the rewrite — the first draft passed vacuously for exactly that reason. The
sibling `rename-column-default-reopen.spec.ts` does not need it (a column rename moves
no store), so this is not copy-paste-able from there. There is no reverse-direction
guard: nothing asserts the spec would fail if `renameTableStores` were removed again.

## Validation run

- `yarn build` — clean.
- `yarn test` — full workspace, green (includes the new §38-41 and the new store spec).
- `yarn test:store` — 8689 passing, 21 pending, 0 failing (LevelDB leg of the sqllogic
  file).
- `yarn lint` — clean. `yarn typecheck` — clean.

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.
