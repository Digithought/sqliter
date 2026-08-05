---
description: Renaming a table used to break any other table whose column default or computed-column expression read it, leaving that table unable to accept new rows; the rename now follows those expressions the same way it already followed CHECK rules.
files:
  - packages/quereus/src/schema/rename-rewriter.ts                      # renameTableInColumnExpressions (~399)
  - packages/quereus/src/index.ts                                       # ~223 re-export
  - packages/quereus/src/runtime/emit/alter-table.ts                    # rewriteTableForTableRename columns arm (~2222)
  - packages/quereus/src/schema/catalog-persistability.ts               # pre-flight probe doc (~117)
  - packages/quereus/src/schema/schema-differ.ts                        # default-compare NOTE (~2431)
  - packages/quereus-store/src/common/store-module-rename.ts            # rewriteTable arm (~213)
  - packages/quereus-store/src/common/store-module-alter.ts             # corrected stale generated-render comment (~413)
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic  # §38-41
  - packages/quereus/test/logic/50.2-declare-schema-renames.sqllogic    # §24 (added in review)
  - packages/quereus-store/test/rename-table-default-reopen.spec.ts     # 3 cases (third added in review)
  - docs/sql-alter.md, docs/sql-ddl.md, docs/store.md, docs/view-persistence.md
repro: verified
---

# `ALTER TABLE … RENAME TO` follows column DEFAULT / generated expressions

## What was wrong

A column default or a generated column's body may read another table through a
subquery. The table-rename propagation walked a table's CHECK constraints, foreign
keys, and partial-index predicates, but never `table.columns` — so the two
expressions a column carries (`defaultValue`, `generatedExpr`) were invisible to it.
After `alter table u rename to u2`, a table `t` whose default read `u` accepted no
rows at all and reported `Table 'u' not found in schema path: main`, naming a table
the user had renamed in a different statement.

## What shipped

One new rewriter entry point, wired at three call sites, mirroring how the CHECK arm
was already wired.

**`renameTableInColumnExpressions`** (`rename-rewriter.ts`, next to
`renameTableInCheckConstraints`): runs `renameTableInAst` over each column's
`defaultValue` and `generatedExpr` via the shared `rewriteEach` helper, both walks
always running. Structurally typed, so the module stays free of catalog imports.
Unlike the column verb there is **no seeded/unseeded split** — `renameTableInAst`
resolves nothing against an implicit owning table — so one entry point covers the
renamed table's own columns and every other table's.

**`rewriteTableForTableRename`** (`alter-table.ts`) gained a columns arm. The rewrite
is in place, so no per-item shallow copy; flipping `changed` is what re-registers the
table and fires `table_modified`. That single edit covers both callers:
`propagateTableRenameInSchema` (every table in every schema) and `runRenameTable` (the
renamed table's own schema, before the catalog swap, so no listener ever sees a
self-referencing default naming the vanished old name). It also extends the pre-flight
persistability probe for free — `cloneTableRewritableAsts` already spine-clones column
expressions.

**`store-module-rename.ts`** gained the same arm inside its `rewriteTable` closure,
which runs before `saveTableDDL`, so no bundle naming the old table is ever written.

## Review findings

### Checked, nothing wrong

- **Rewriter completeness.** `ColumnSchema` carries exactly two expression fields
  (`defaultValue`, `generatedExpr`); both are covered and there is no third site.
  Every `AST.Expression` variant that can nest a table reference is handled by
  `visitTableRename` (walked the full union in `parser/ast.ts` against the switch).
- **Call-site completeness.** Grepped every caller of the sibling `renameTableIn*`
  entry points: three sites total (the propagation pass, the pre-catalog-swap call,
  the store hook). All three are wired.
- **Pre-flight probe safety.** `cloneTableRewritableAsts` spine-clones column
  expressions, so a vetoed rename cannot leave the live catalog rewritten. Confirmed
  by reading the clone, not by trusting the handoff.
- **The "memory module needs no arm" claim holds.** `MemoryTableManager.renameTable`
  shallow-copies the schema and keeps the *same* `columns` array, so the engine's
  in-place AST rewrite reaches the manager's copy by reference.
- **The "`DROP TABLE` is equally unguarded for a CHECK" claim holds.**
  `assertNoAssertionDependsOn` guards assertions only; a CHECK on another table naming
  the dropped table is unguarded in exactly the same way. Not a defaults-specific gap,
  so no ticket.
- **The differ-ordering claim holds.** `generateMigrationDDL` emits table renames in
  its first loop, ahead of every table-alter statement.
- **No resource / error-handling / type-safety issue.** The change adds no async work,
  no handles, no `any`, and no new failure path beyond the reverse-on-throw residual
  below. `rename-rewriter.ts` grew ~40 lines (to ~1740) and already carries its own
  size NOTE with a stated split seam.

### Found and fixed in this pass

- **Docs were stale in four files.** Every list of what `RENAME TO` propagates into
  omitted column `DEFAULT` / `GENERATED ALWAYS AS` bodies: `docs/sql-alter.md` (the
  RENAME TABLE paragraph *and* the cross-schema sentence — the sibling column-rename
  ticket had updated the RENAME COLUMN prose and left the table verb behind),
  `docs/sql-ddl.md` § renames, `docs/store.md` (the `assertRenameDependentsPersistable`
  description), `docs/view-persistence.md` (the dependent-table list). All four updated.
- **Two in-code doc comments were stale.**
  `assertRenameDependentTablesPersistable` (`catalog-persistability.ts`) still listed
  only FK targets / CHECK / predicates; the `computeColumnAttributeChange` NOTE
  (`schema-differ.ts`) covered only column renames when the same non-reconciliation
  applies to table renames. Both corrected.
- **A comment in `store-module-alter.ts` was factually wrong.** It claimed a generated
  expression "is not rendered at all today"; `formatColumnDef` has rendered
  `GENERATED ALWAYS AS (…)` since `bug-store-reopen-loses-computed-columns` landed.
  Corrected — and this is what surfaced the next finding.
- **Test gap: the generated-column half of the STORE hook was untested.** Because
  generated bodies *are* persisted now, a self-referencing generated body is a live
  crash-window shape identical to the self-referencing DEFAULT the spec already
  covered — and a self-referencing generated body is reachable (verified: `create
  table t (id integer primary key, g integer generated always as ((select count(*)
  from t)) virtual)` is accepted). Added a third case to
  `rename-table-default-reopen.spec.ts` and **verified it fails without the store
  arm**, recording the bad bundle
  `CREATE TABLE "main"."rtg9" (… GENERATED ALWAYS AS ((select count(*) from rtg))
  VIRTUAL) USING store`.
- **Test gap: the differ claim was asserted, not measured.** The handoff argued the
  redundant `ALTER COLUMN … SET DEFAULT` is harmless and the follow-up diff empties,
  with no test. Added §24 to `50.2-declare-schema-renames.sqllogic`, pinning the exact
  two-statement diff (`ALTER TABLE dt_u RENAME TO dt_u2`, then
  `ALTER TABLE dt_t ALTER COLUMN w SET DEFAULT (select min(v) from dt_u2)`) and the
  empty re-diff. **Honest limit, stated in the test:** this route converges even with
  the propagation disabled, because the redundant SET DEFAULT repairs the default on
  its own — so it is a differ-behaviour guard, not a second copy of the propagation
  guard. Checked by disabling the `alter-table.ts` arm and re-running.

### Tripwires (parked in code, not filed)

- **Reverse-on-throw over-reach in `store-module-rename.ts`.** A DEFAULT may name a
  table that does not exist yet (the reference resolves only when a row is written),
  so `create table u (…, default ((select 1 from u2)))` then `rename u to u2` has a
  forward pass matching nothing and a reverse pass — reached only if `saveTableDDL`
  throws — that would clobber that `u2` back to `u`. Reviewed and agreed with the
  implementer's disposition: it sits on a path the same file already documents as
  leaving the physical relocation un-undone, and closing it needs a per-walk
  changed-set threaded through every arm. Parked as the amended `NOTE:` at the exact
  site in `store-module-rename.ts`; no ticket.

### Deliberately not turned into tickets

- **CTE / alias blind spot.** Confirmed inherited, not introduced: the table walker
  keeps no `ScopeFrame` at all (`visitTableRename` has no scope state), so the fix
  belongs in the walker and lands for all four arms at once. Already tracked as
  `bug-table-rename-rewrites-cte-references`; the new sqllogic §41 pins only the
  schema-qualified negative and says why.
- **Cross-schema unqualified false-rewrite.** `rewriteTableForTableRename` passes the
  renamed table's schema as the default schema for tables in *every* schema, so a temp
  table's unqualified reference can be false-rewritten. Identical for the CHECK arm
  today; tracked by `bug-rename-not-propagated-across-schemas`.
- **`DROP TABLE` under a dependent default.** Unguarded, but equally unguarded for a
  CHECK reference (verified above) — a `DROP TABLE` guard gap, not a defaults gap.

Nothing rose to "major": every finding was either a doc/test gap closed in this pass
or already tracked by an open ticket. No new tickets filed.

## Test coverage (final state)

`packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic` §38-41 — runs on
both the memory leg (`yarn test`) and the LevelDB leg (`yarn test:store`):

- **§38** another table's DEFAULT with a cross-table subquery survives `rename to`, and
  a second insert after mutating the renamed table confirms it reads the new name.
- **§39** self-referencing default survives `rename t to t9`.
- **§40** generated column with a **qualified** cross-table subquery (the unqualified
  shape is rejected at create time by the generated-column dependency check).
- **§41** negative — a default reading `temp.<name>` is untouched when `main.<name>` is
  renamed.

`packages/quereus/test/logic/50.2-declare-schema-renames.sqllogic` §24 (added in
review) — declarative table rename carrying a dependent DEFAULT: exact diff DDL,
behavioural insert, empty re-diff.

`packages/quereus-store/test/rename-table-default-reopen.spec.ts` — three cases:
self-referencing DEFAULT (crash-window catalog-write assertion + reopen round-trip),
another table's DEFAULT (round-trip only — that bundle is written by the post-hook
propagation), and self-referencing GENERATED body (added in review; crash-window +
round-trip).

Every crash-window assertion was verified to fail with its arm disabled — the two
DEFAULT/GENERATED store cases against `store-module-rename.ts`, sqllogic §38 against
`alter-table.ts` (`RelationNotFoundError: Table 'u_tdef' not found in schema path:
main`).

**Harness note.** The store spec's provider must implement `renameTableStores` or the
renamed table's data stays keyed under the old store name and reads empty, which would
make every assertion measure the harness. The sibling `rename-column-default-reopen.spec.ts`
does not need it (a column rename moves no store). The value assertions (`w = 0`,
`g = 1` on pre-rename rows) do fail if the data goes missing, so the guard is implicit
rather than absent.

## Validation run

- `yarn build` — clean.
- `yarn docs:check` — OK (pre-existing `lens.md` grace-band notice untouched).
- `yarn lint` — clean. `yarn typecheck` — clean.
- `yarn test` — full workspace green (quereus 8697 passing; quereus-store 1372).
- `yarn test:store` — 8689 passing, 21 pending, 0 failing.

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.
