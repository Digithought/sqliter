---
description: A database-wide integrity rule could be created naming a table or column that does not exist, and dropping a table or view a rule still used was allowed — either way every later write to the whole database failed. Both are now refused up front.
files:
  - packages/quereus/src/planner/building/create-assertion.ts       # Arm 1 — body planned at build time
  - packages/quereus/src/runtime/emit/create-assertion.ts           # comment only; discovery try/catch unchanged
  - packages/quereus/src/schema/rename-rewriter.ts                  # Arm 2 — tableReferencedInAst (dry run)
  - packages/quereus/src/runtime/emit/assertion-drop-guard.ts       # Arm 2 — shared guard
  - packages/quereus/src/runtime/emit/drop-table.ts                 # Arm 2 call site
  - packages/quereus/src/runtime/emit/drop-view.ts                  # Arm 2 call site
  - packages/quereus/src/runtime/emit/materialized-view.ts          # Arm 2 call site (emitDropMaterializedView)
  - packages/quereus/src/schema/schema-differ.ts                    # Arm 3 — DDL ordering + forced assertion recreate
  - packages/quereus/test/logic/95-assertions.sqllogic              # arms 1+2 end to end
  - packages/quereus/test/assertion-body-resolves.spec.ts           # declarative arms + ordering
  - packages/quereus/test/logic/50-declarative-schema.sqllogic      # updated expectation (ordering changed)
  - packages/quereus/test/logic/102-schema-catalog-edge-cases.sqllogic # updated cleanup (drop guard fired)
  - docs/sql-ddl.md                                                 # § 2.6.1
  - docs/schema.md                                                  # § Assertion body-change detection
  - docs/sql-views.md                                               # drop view — refusal cross-reference
  - docs/materialized-views.md                                      # § DROP MATERIALIZED VIEW — refusal cross-reference
---

# What shipped

The invariant established: **an assertion's stored CHECK body always resolves
against the live catalog.** A Quereus assertion (`create assertion <name> check
(<expr>)`) is evaluated at COMMIT, and the evaluator recompiles *every* live
assertion on any commit that touched any table — so one unresolvable body used
to block writes to the entire database, surfacing at an unrelated later
statement with an error that named neither the assertion nor the cause.

## Arm 1 — `CREATE ASSERTION` validates its body

`buildCreateAssertionStmt` calls `planAssertionBody` before returning the node.
That renders the body's violation SQL via `buildAssertionViolationSql`,
**re-parses it**, and builds it with `buildSelectStmt` under the assertion's
home-schema path.

The round trip is deliberate: the parsed text is exactly what the emitter stores
and what the commit-time evaluator re-parses, so a stringify/parse round trip
that mangles the expression is caught too. Build, not optimize — same as
`planViewBody`, so no assertion-hoist suppression is needed.

Strictness is the `CREATE VIEW` precedent exactly: missing table, missing column
and unknown function fail; a type mismatch such as `x + 'abc'` is not a planner
error and still creates. Message keeps the underlying cause and prefixes the
assertion: `Cannot create assertion 'ax': Table 'nope' not found in schema path:
main`.

`emitCreateAssertion` is unchanged apart from a comment. Its `try/catch` is
dependency *discovery* for `assertion_info().dependent_tables` and still
warns-and-continues (see `backlog/bug-assertion-info-dependent-tables-always-empty`).

## Arm 2 — dropping an object an assertion names is refused

`runtime/emit/assertion-drop-guard.ts` exports
`assertNoAssertionDependsOn(db, schemaName, objectName, kind)`, throwing
`StatusCode.CONSTRAINT`:

```
cannot drop table 'main.t': assertion 'a1' still refers to it — drop or redefine the assertion first
```

"Refers to" reuses the rename walker: `tableReferencedInAst` runs the same
`visitTableRename` traversal with a `dryRun` flag, so it can never drift from
"what `ALTER TABLE … RENAME` would have rewritten". Call sites are the three
user-facing DDL emitters (`emitDropTable` — before the maintained-table branch,
so `DROP TABLE` on a materialized view is covered — `emitDropView`,
`emitDropMaterializedView`), deliberately not `SchemaManager.dropTable`, which
internal rollback and catalog-import cleanup also drive. `IF EXISTS` does not
weaken it, but the guard is gated on the object existing.

## Arm 3 — declarative migration ordering

`generateMigrationDDL` pushes `assertionsToCreate` **last** (after the
table-alter block and the maintained re-attach loop). Assertion drops still lead
the whole migration. `computeSchemaDiff` force-drops-and-recreates any declared
assertion whose body names something in `tablesToDrop` / `viewsToDrop`, even when
the body is byte-identical — otherwise arm 2's guard would refuse the
`DROP TABLE` and kill the migration.

# Validation

- `yarn build` — clean. `yarn lint` — clean (includes the `tsc -p
  tsconfig.test.json` pass over the specs). `yarn typecheck` — clean.
- `yarn test` (root, all workspaces) — **0 failing**; quereus 8422 passing / 13
  pending.
- `yarn test:store` (full LevelDB run) — **0 failing**; 8414 passing / 21
  pending.

Two existing tests changed during implement, both because behaviour
intentionally changed: `102-schema-catalog-edge-cases.sqllogic` cleanup now
drops the assertion before the table (the guard doing its job), and
`50-declarative-schema.sqllogic` asserted the old ordering and carried a comment
claiming an assertion body "binds at enforcement time, not at create time" —
which arm 1 makes false.

# Review findings

## Ran

Read the implement diff first, then the handoff. Probed the three arms
in-process against a scratch spec (deleted afterwards): 17 scenarios across
build-time validation, multi-statement and in-transaction scripts, the guard's
true and false directions, cross-schema binding, declarative column drops, and
rename regressions. Ran `yarn lint`, `yarn build`, `yarn test` and
`yarn test:store` — all green, numbers above. Read every doc the change touched
plus the view/materialized-view docs it should have.

## Fixed in this pass (minor)

- **Guard message echoed the caller's schema spelling.** `drop table MAIN.t`
  reported `cannot drop table 'MAIN.t'` — a schema spelling that appears nowhere
  in the catalog. Now reports `schema.name`
  (`runtime/emit/assertion-drop-guard.ts`).
- **No test proved the guard refuses *only* what an assertion names.** Every
  case asserted a refusal; an over-broad predicate would have passed all of
  them. Added a section to `95-assertions.sqllogic`: an unrelated table and view
  drop cleanly while an assertion is live, plus the canonicalized-message case.
- **`DROP VIEW` / `DROP MATERIALIZED VIEW` refusal was documented only under the
  assertion section of `sql-ddl.md`.** A reader of the view docs would not find
  it. Added cross-references in `docs/sql-views.md` and
  `docs/materialized-views.md`.
- **The "same-schema scoping" test comment was misleading** — it passes only
  because a shadowing `temp` table exists. Comment now says so and points at the
  ticket that covers the unshadowed case.

## Filed (major)

- **NEW `backlog/bug-table-rename-rewrites-cte-references`.** `visitTableRename`
  has no scope tracking, so `ALTER TABLE zap RENAME TO zap2` rewrites references
  that bind to a `with`-clause name `zap` inside a stored view or assertion body.
  Verified: a view that returned `[{k:1}]` returns `[]` after the rename, and an
  assertion's stored violation SQL visibly flips from the CTE to the renamed
  table. Pre-existing (the column rename walker already carries the scope
  machinery the table walker lacks), but this diff gives it a second symptom —
  the drop guard inherits the over-match and spuriously refuses `drop table zap`.
- **Appended arm 2 to `backlog/bug-drop-table-under-view-an-assertion-names`.**
  The guard scans only assertions in the dropped object's own schema, but an
  assertion in `temp` naming a bare `mt` binds to `main.mt` whenever `temp` has
  no `mt`. Verified: `drop table mt` is allowed and every later write fails with
  `Table 'mt' not found in schema path: temp, main`. Same site as the view arm,
  so it went there rather than to a new ticket; the description and title were
  widened to two arms. Unlike the rename case (which cannot know which schema a
  stored bare name meant), a drop can resolve it — the catalog is live.
- **Appended to `backlog/bug-drop-column-skips-dependent-checks`.** Re-verified
  arm C is still open at this commit (`alter table t drop column x` under an
  assertion is accepted, then a *different* table is unwritable), and recorded
  that the differ's new `namesDroppedObject` has no column equivalent — so once
  that arm refuses the drop, a declaration removing a column an unchanged
  assertion still names will abort the migration instead of bricking it. Both
  resolve at `runDropColumn`.

## Checked, nothing found

- **Build-time planning vs. script boundaries.** The worry was that validating
  at build time breaks a script whose earlier statements create the table.
  Verified `create table` + `create assertion` in a single `exec`, and the same
  inside `begin; … commit;` — both work; statements build one at a time.
- **A failed create leaves no residue.** `assertion_info()` empty afterwards,
  unrelated writes still commit, no transaction left open.
- **Guard true-positive breadth.** Aliased sources (`from t as z where z.x < 0`)
  and bodies referencing a table only from a scalar subquery are both caught;
  a body naming two tables refuses on either.
- **Rename regression.** An assertion still enforces after `alter table … rename
  to` (fails the violating insert under the new name).
- **`create assertion if not exists`** — not in the grammar, so there is no
  IF-NOT-EXISTS/validation interaction to get wrong.
- **Arm 3 ordering and the forced recreate** behave as described; the declarative
  spec covers them.

## Handoff's own "known gaps" — dispositions

- **Transitive reference through a view** — confirmed the repro; it is now arm 1
  of the two-arm guard ticket. Correctly filed rather than fixed.
- **Maintained-table backing-module recreate untested end to end** — accepted as
  stated. It needs a second registered vtab module, which the in-process default
  catalog does not have; the same code path is covered via the table-removal
  route. Not filed: this is missing coverage of a path that *is* exercised, not
  a defect.
- **A failed declarative apply leaves the assertion dropped** — accepted. Loud
  partial application beats the silent brick it replaced, and nothing in a
  migration depends on an assertion existing. Not filed; the contract is now
  stated in `docs/schema.md`.
- **`drop table if exists nope` succeeds** — agreed, and the comment at the call
  site says why (nothing is destroyed; any assertion naming it is already broken).
- **Cross-schema explicit `B.t`** — stays with
  `bug-rename-not-propagated-across-schemas`. The *unqualified* variant is worse
  and is now the guard ticket's arm 2.
- **Assertions with no `checkExpression`** — confirmed unreachable
  (`SchemaManager.importDDL` has no assertion arm) and the NOTE is at the site.

## Tripwires parked

- `schema/schema-differ.ts`, at `namesDroppedObject`: one AST walk per declared
  assertion per dropped object. Trivial at today's scale; index bodies by
  referenced name if a large schema ever drops many objects at once. `NOTE:` at
  the site.
- Same site, second `NOTE:`: dropped *columns* have no equivalent in this
  predicate, and will need one once `runDropColumn` guards assertions. (Also
  written into that ticket, since that is where someone will act on it.)
- The implementer's own tripwire — `CREATE ASSERTION` plans its body twice
  (build-time validation, emit-time discovery) — is parked as a `NOTE:` in
  `planner/building/create-assertion.ts` with the fix if creates go hot.
  Reviewed and agreed: immaterial, creates are rare and the body is one small
  query.

## Pre-existing, not this ticket

- `yarn docs:check` is red on `docs/schema.md` (12812 words vs a ratchet of
  12109). Already listed in `tickets/.pre-existing-known.md` against
  `debt-doc-size-ratchet-red-at-head`, so not re-reported — but noting that the
  implement commit added roughly 130 words to that file and deepened the
  overage. `docs/sql-views.md` and `docs/materialized-views.md`, which this
  review edited, are not ratcheted red.
- The first `yarn test` run hit a 120 s timeout in `fuzz.spec.ts` ("SELECT
  queries do not crash"). It did **not** reproduce: re-running that spec alone
  with the seed the run printed (`QUEREUS_FUZZ_SEED=3323715965`) finished in 8 s,
  and two later full runs were clean. Machine contention, not a defect — no
  `.pre-existing-error.md` written.
