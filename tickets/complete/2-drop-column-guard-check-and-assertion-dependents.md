---
description: Dropping a column is now refused when a CHECK constraint on that table, or a database-wide integrity rule, still mentions the column — instead of being accepted and leaving the table (or the whole database) unwritable.
files:
  - packages/quereus/src/runtime/emit/drop-column-guards.ts          # the two guards
  - packages/quereus/src/schema/column-source-resolver.ts            # buildColumnSourceResolver (moved here during review; was runtime/emit/)
  - packages/quereus/src/runtime/emit/alter-table.ts                 # runDropColumn call site
  - packages/quereus/src/planner/building/constraint-builder.ts      # now uses the shared resolver
  - packages/quereus/src/schema/rename-rewriter.ts                   # columnReferencedInAst / columnReferencedInCheckExpression
  - packages/quereus/src/schema/schema-differ.ts                     # stale NOTE replaced (comment only)
  - packages/quereus/test/logic/41.10.2-alter-drop-column-check-and-assertion.sqllogic
  - docs/sql-alter.md
  - docs/sql-ddl.md
---

# DROP COLUMN refuses a CHECK / assertion dependent

## What shipped

`ALTER TABLE … DROP COLUMN` previously validated a fixed list of dependents — primary key,
generated-column expressions, partial-index `WHERE` predicates. Two more survived the drop
verbatim and then failed while a *write statement was being planned*: a CHECK constraint on the
same table (that table becomes unwritable) and an assertion whose body names the column (the
whole database becomes unwritable, because the assertion evaluator recompiles every live
assertion on any commit that touched any table).

Both are now refused with `StatusCode.CONSTRAINT`, ahead of `module.alterTable`, so a refused
statement persists nothing.

The rule the change settles, now stated in `docs/sql-alter.md`: DROP COLUMN's dependents split
into **structural** (defined by a column set — UNIQUE, the table's own FK — so the modules
remove them with the column) and **expression** (arbitrary logic with no narrowed form —
generated column, partial-index `WHERE`, CHECK, assertion body — so the engine refuses).

Detection runs a real rename to a sentinel name over a throwaway `spineCloneAst` copy, through
the scope-aware rename walker, so "refers to" cannot drift from "would have been rewritten by
RENAME COLUMN". Both probes are passed the catalog-backed `ResolveColumnInSource`; without it
the subquery cases false-refuse.

## Review findings

### Checked

Read the implement diff (`1bde504c`) before the handoff summary. Reviewed the two guards, the
two new probes in `rename-rewriter.ts`, the resolver extraction, the `schema-differ.ts` comment
replacement, both doc files, and the 11-section sqllogic file. Traced the guard against both
vtab modules' `dropColumn` arms (neither prunes `checkConstraints`, so the refuse policy is
what keeps a stale CHECK from surviving) and confirmed `runDropColumn` is the only engine
caller of the `dropColumn` module arm — no path bypasses the guard. Ran adversarial in-process
probes for spellings the sqllogic file does not cover.

`yarn build`, `yarn lint`, `yarn typecheck`, `yarn docs:check` all pass. `yarn test`: 8694
passing, 13 pending, **0 failing**. `41.10.2` targeted under both legs: memory 1 passing, store
1 passing. (Full `yarn test:store` still not run — slow; unchanged from the implement handoff.)
The five near-cap word-count warnings from `docs:check` are pre-existing on files this ticket
never touched.

### Major — filed as a ticket

- **A CHECK using the `new.` / `old.` row-image qualifier is invisible to the guard, and to
  RENAME COLUMN.** `check (new.a > 0)` is a documented spelling (`docs/sql-ddl.md` § CHECK
  Constraints), and `alter table T drop column a` is *accepted* against it; the next insert
  fails `new.a isn't a column`, i.e. exactly the unwritable-table state this ticket set out to
  prevent. `check on delete (old.a > 0)` fails identically. Root cause is one site —
  `visitColumnRename`'s `column` case resolves a qualifier against FROM scopes, and `new` /
  `old` bind to neither — so `ALTER TABLE … RENAME COLUMN` misses the same references and
  leaves the constraint broken too. Both repros verified in-process. Filed as
  `tickets/fix/bug-check-constraint-new-old-qualifier-invisible-to-column-rename.md`
  (`repro: verified`), and flagged as a KNOWN GAP in `drop-column-guards.ts` at the guard that
  inherits it.

### Minor — fixed in this pass

- **The resolver was duplicated, not shared.** `planner/building/constraint-builder.ts` hand-
  rolled the same two-line catalog lookup that the new `column-source-resolver.ts` owned. The
  handoff flagged this and declined it on layering grounds (a `planner/` → `runtime/emit/`
  import). Resolved by moving the module to `packages/quereus/src/schema/column-source-resolver.ts`
  and parameterizing it on `SchemaManager` instead of `Database`; all three callers — the
  rename pre-flight, the two DROP COLUMN guards, and the constraint planner's self-qualifier
  strip — now share one definition, and no import crosses a layer boundary the wrong way.
- **Column-level inline CHECKs had no test coverage,** and the handoff asked for the asymmetry
  to be confirmed. Verified: `a integer check (a > 0)` is auto-named `_check_a` at declaration
  (`schema/constraint-builder.ts`), so unlike an unnamed *table-level* CHECK it reports a name
  and `alter table … drop constraint _check_a` resolves it — the escape hatch works. Pinned as
  §2b of the sqllogic file (refusal quotes `_check_a`, the CHECK still enforces after the
  refusal, and the drop-constraint-then-drop-column path succeeds).
- **`docs/sql-alter.md` implied every unnamed CHECK is undroppable.** Corrected: only the
  unnamed *table-level* form has no name to address; the inline column-level form is auto-named
  and droppable.

### Checked and found sound — no action

- **The clone-and-sentinel probe cannot corrupt the caller's AST.** Every mutation point in
  `visitColumnRename` (`col.name`, `a.column`, `d.column`, `stmt.columns` / `conflictTarget`
  array replacement, `new.`-qualified refs) writes into a plain object or array, all of which
  `spineCloneAst` deep-copies; the leaves it shares by reference are never written.
- **The probe's omission of `identifier` nodes is not a false-negative.** The neighbouring
  partial-index guard also matches `type: 'identifier'`, which the rename walker does not.
  Checked the parser: `identifier` expression nodes are only produced for table / index / view
  names and pragma values — a bare column reference inside an expression always parses as
  `column`.
- **Guard ordering and placement.** Both run before `requireVtabModule`, so a refused drop
  never reaches a persisting module — §1 of the test file proves the table is untouched
  afterwards on the store leg too. CHECK-before-assertion (widening blast radius) is pinned by
  §10, and the pre-existing generated-column guard still wins over both (§11).
- **The `schema-differ.ts` reasoning holds.** The only declaration shape the guard now rejects
  is the self-inconsistent one (removes a column, leaves an unchanged assertion body naming
  it), which previously applied cleanly and bricked the database. Widening `namesDroppedObject`
  would still fail, later, with the assertion already gone.

### Conditional concerns — parked as tripwires, not tickets

- Each probe costs one spine clone plus one walk, and the assertion guard probes every live
  assertion on every DROP COLUMN. Fine at the handful-of-assertions scale schemas have, and it
  only runs on DDL. Parked as a `NOTE:` on `columnReferencedInAst` in
  `packages/quereus/src/schema/rename-rewriter.ts`, naming the cheap pre-filter
  (`tableReferencedInAst`, no clone) to reach for if a schema ever carries assertions by the
  hundred.

### Known gaps carried forward — deliberately not re-filed

- **A CHECK on a *different* table reaching this column through a subquery is not guarded** —
  filed by the implementer as `backlog/bug-drop-column-skips-check-on-another-table`, repro
  re-verified during this review.
- **Cross-schema references are not caught** — inherited from `assertNoAssertionDependsOn`'s
  documented gap, tracked by `bug-rename-not-propagated-across-schemas`.
- **Views break the same way and are not guarded** — `alter table V drop column x` under
  `create view VW as select x from V` is accepted, and `select * from VW` then fails
  `Column not found: x`. Verified, but deliberately *not* filed here: it is pre-existing
  behaviour outside this ticket's scope (the plan scoped the change to CHECKs and assertions),
  it is the same tolerated-broken-view policy `assertNoAssertionDependsOn` documents for
  `DROP TABLE`, and its blast radius is one view rather than a whole table or database.
  `backlog/bug-drop-table-under-view-an-assertion-names` and
  `backlog/bug-rename-column-breaks-objects-reading-a-view` already sit on that policy
  question; whether views should be guarded belongs there, not in a fresh ticket.
- **The partial-index DROP COLUMN guard still has no sqllogic coverage anywhere.** The
  implementer flagged this for a reviewer's decision. Left uncovered here, and §11's comment
  says so at the site: adding it needs `create index … where`, which forces
  `requires-capability: standalone-index-ddl` and would drop this whole file out of the store
  leg — the leg that matters most for a persisted CHECK. It belongs in a partial-index test
  file, not this one, and is not this ticket's regression risk.
