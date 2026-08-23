---
description: A table whose rows the engine derives automatically can no longer declare per-statement parameters that nothing could ever supply — declaring one is now rejected where the table is declared, instead of failing later with a confusing error.
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # assertNoMutationContextOnMaintainedTable (~1605), call site in createMaintainedTable (~1699), tripwire NOTE on attachMaintainedDerivation (~1220)
  - packages/quereus/src/runtime/emit/alter-table.ts                 # call site in runSetMaintained (~2111)
  - packages/quereus/test/logic/51.8-maintained-table-declared-constraints.sqllogic  # § 14
  - docs/sql-ddl.md            # § 2.6.2 "Which variables a statement must supply" bullet
  - docs/materialized-views.md # "DDL statements" callout
  - docs/sql-alter.md          # § SET MAINTAINED / DROP MAINTAINED
---

# What shipped

A **maintained table** — one whose rows the engine derives from a query and keeps up to
date — may no longer declare **mutation-context variables** (the per-statement parameters
a table's CHECK constraints and DEFAULT expressions read by name, supplied per write with
`with context <name> = …`). Nobody writes to a maintained table directly, so no statement
could ever supply such a value; the declaration is unsatisfiable by construction. It used
to be accepted and then failed at DDL time with `Column not found: cap`, raised from
ordinary column resolution while the derived-row validator compiled the table's declared
constraints.

One shared guard, `assertNoMutationContextOnMaintainedTable(table, verb, loc?)` in
`runtime/emit/materialized-view-helpers.ts`, throws `StatusCode.ERROR` naming the table
and every declared variable, in two message shapes:

- `create` → `cannot create maintained table '<schema>.<table>': a maintained table's rows
  are derived by the engine, so no statement can supply its mutation context variables
  (<names>); remove the 'with context' clause`
- `alter` → `cannot make table '<schema>.<table>' maintained: it declares mutation context
  variables (<names>) that no statement can supply, because a maintained table's rows are
  derived by the engine`

Called from `createMaintainedTable` (on the declared schema, before the table registers —
sited at the table name) and from `runSetMaintained` (on the live table, before the
derivation attaches). Any declaration is rejected, including one no constraint reads: the
"declared but unread" distinction is invisible to the author and would drift the moment a
constraint is added.

Docs updated in `sql-ddl.md` § 2.6.2, `materialized-views.md`, and `sql-alter.md`.

## Review findings

### Verified

- **Read the implement diff first**, then the handoff. The implementation matches the
  ticket's specified design (shared guard, two call sites, message shapes, `StatusCode`).
- **No unguarded route into the bad state.** `attachMaintainedDerivation` — the shared
  attach core — has exactly two callers repo-wide, both guarded. The other three routes
  that produce a maintained table (`materializeView`, `adoptMaterializedView` for the
  `create materialized view` sugar and catalog import) build their table from
  `buildBackingTableSchema`, which carries no mutation context at all. A maintained table
  cannot gain context afterwards either: there is no `ALTER` surface that adds or changes
  a context declaration, and `TableSchema.mutationContext` is written at exactly one site
  (`schema/manager.ts` `buildTableSchemaFromAST`).
- **A third authoring surface the ticket never named is covered.** `declare schema` parses
  `maintained as …` and `with context (…)` on the *same* declared-table item
  (`parser.ts` `declareTableItem`), and the differ stringifies its own create text. Ran it:
  `apply schema` of such a declaration lands on the same create-arm rejection
  (`cannot create maintained table 'main.ctxdmt': …`). No code change needed.
- **The red/green cycle the implementer flagged as missing.** Neutered the guard and ran
  the new § 14 assertions: each of the three fails independently without it — the
  CHECK-reading create arm and the ALTER arm both fail with the old `Column not found: cap`,
  and the declared-but-unread arm fails with "Expected error … but SQL block executed
  successfully" (the case that was accepted before this change). Restored, all green. The
  new tests do catch a regression to the old behavior.
- **Full validation on the reviewed tree**: `yarn workspace @quereus/quereus test` →
  **10173 passing, 25 pending, 0 failing**; `yarn workspace @quereus/quereus run lint`
  (eslint + `tsc -p tsconfig.test.json --noEmit`) clean; `node scripts/check-docs.mjs`
  clean. No pre-existing failures surfaced.

### Fixed in this pass (minor)

- `docs/sql-ddl.md` § 2.6.2 said both arms raise a **sited** error. Only the CREATE arm is
  sited; the ALTER arm is raised from the runtime path, which carries no location to that
  call site. Reworded to say which arm is which rather than overclaiming.
- `{@link ../../planner/resolve.ts}` in the guard's doc comment — a file path inside a
  TSDoc link, the only occurrence of that form in the repo, and it resolves to nothing.
  Replaced with a plain backticked path.

### Filed (major)

- **A table's mutation-context declaration is silently dropped when its definition is
  persisted.** `schema/ddl-generator.ts` (the canonical generator, whose own header says
  its output is "safe to persist and re-parse in any session") emits no `with context (…)`
  clause. Verified end-to-end: a table declaring `with context (cap integer)` with
  `check (v <= cap)` generates DDL without the clause; that text re-parses cleanly into a
  fresh database, and then **every write fails** with `Column not found: cap` — the same
  message this ticket set out to retire, arriving through the persistence door for an
  *ordinary* table. `emit/ast-stringify.ts` does emit the clause, so the two emitters
  disagree.
  Recorded as **arm 2 of the existing backlog ticket
  `bug-non-key-column-conflict-action-dropped-from-ddl`** rather than as a new ticket: same
  site, same class (a declaration `generateTableDDL` never writes, lost across a
  save/reopen), and one emission pass fixes both. The ticket's `description`, `files`, and
  `severity` note were updated to cover both arms.

### Tripwire (conditional — not a ticket)

- The guard is asserted at the two authoring call sites but **not** inside
  `attachMaintainedDerivation`, the shared core both funnel through. That is fine today
  (both callers check first, and a third assert would need a third message verb for a case
  that cannot fire), but a future third caller of the core would bypass it. Parked as a
  `NOTE:` immediately above `attachMaintainedDerivation` in
  `runtime/emit/materialized-view-helpers.ts` — where the author of that third caller will
  actually read it.

### Weighed and left alone

- **Guard ordering in `createMaintainedTable`.** It runs after the declared-shape mismatch
  check, so a create that is *both* mis-shaped and context-declaring reports the shape
  error. Moving it earlier would also skip planning the body. Both orderings are
  defensible and the ticket asked for this placement; not worth the churn.
- **The ALTER arm's error is unsited.** Threading a source location there means adding a
  field to the `AlterTableAction` union purely for this message, and every neighbouring
  error in `runSetMaintained` / `runDropMaintained` is unsited too. Left as-is; the doc now
  states it accurately instead.
- **A type-level ban** (`MaintainedTableSchema` forbidding `mutationContext`) would be the
  higher rung, but the type is an intersection (`TableSchema & { derivation }`) built by
  spreading a `TableSchema`, and the attach core's *input* is a not-yet-maintained table —
  so the constraint cannot be expressed without a branded input type, and the practical
  result would be a cast at each site rather than a compile-time guarantee.
- **No declarative-surface sqllogic test.** The declarative route is verified above by
  hand, but pinning it in `51.8-…` would need an `apply schema main` at the tail of a file
  whose `main` already holds a dozen unrelated tables — the apply would reconcile (drop)
  every table the block does not declare. A fragile test for a surface that shares the
  create path already under test; recorded here instead.

### Evidence appended elsewhere

- `tickets/backlog/debt-oversized-source-files.md`: re-measured
  `runtime/emit/materialized-view-helpers.ts` at **3,442 lines** (`wc -l`, 2026-08-23; was
  listed at 3,404) — this ticket's guard added 38 of them. No new size ticket; the theme
  already owns the file.

### Checked and clean, explicitly

- **Test coverage.** § 14 covers all four cases the ticket asked for plus the
  declared-but-unread narrowing, and asserts the rollback posture on both arms (the failed
  create leaves the name free; the failed alter leaves the table plain and still writable
  with a `with context` value). Nothing further was needed beyond the red/green check
  above.
- **Docs.** Read every doc that mentions `with context`
  (`sql-ddl.md`, `sql-dml.md`, `vu-mutation-context.md`, `materialized-views.md`,
  `determinism.md`, `architecture.md`, `module-authoring.md`). Only the three the
  implementer edited state per-table declaration rules; `vu-mutation-context.md` already
  defers to `sql-ddl.md` § 2.6.2 for them, so it inherits the new bullet. No stale text
  left behind.
- **Resource cleanup / error handling.** The guard is a pure precondition check that throws
  before any module, catalog, or storage mutation on both arms — nothing to release, and
  the existing rollback paths are untouched.
