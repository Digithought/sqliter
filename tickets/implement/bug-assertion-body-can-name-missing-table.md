---
description: A database-wide integrity rule can be created that names a table or column which does not exist, and dropping a table or view does not check whether a rule still names it. Either way every later write to the whole database fails with an error that never mentions the rule.
files:
  - packages/quereus/src/planner/building/create-assertion.ts     # Arm 1 — builder does no validation at all; the fix site
  - packages/quereus/src/planner/building/create-view.ts          # the precedent to mirror (planViewBody)
  - packages/quereus/src/runtime/emit/create-assertion.ts         # emitter: dependency-discovery try/catch stays as-is
  - packages/quereus/src/schema/rename-rewriter.ts                # Arm 2 — host for the read-only "does this AST name X" walk
  - packages/quereus/src/runtime/emit/drop-table.ts               # Arm 2 call site
  - packages/quereus/src/runtime/emit/drop-view.ts                # Arm 2 call site
  - packages/quereus/src/runtime/emit/materialized-view.ts        # Arm 2 call site (emitDropMaterializedView)
  - packages/quereus/src/schema/schema-differ.ts                  # Arm 3 — generateMigrationDDL ordering + assertion diff loop
  - packages/quereus/src/runtime/emit/assertion-rename-helpers.ts # same-schema scoping rule the drop guard must copy
  - packages/quereus/test/logic/95-assertions.sqllogic            # end-to-end coverage (append sections)
  - packages/quereus/test/assertion-rename-propagation.spec.ts    # catalog-level assertion invariants live here
  - docs/sql-ddl.md                                               # § 2.6.1 CREATE/DROP ASSERTION
  - docs/schema.md                                                # § Assertion body-change detection (migration ordering)
difficulty: medium
repro: verified
---

# An assertion body must always resolve, and nothing may silently make it stop resolving

## The invariant

A Quereus assertion (`create assertion <name> check (<expr>)`) is a database-wide
rule evaluated at COMMIT. `AssertionEvaluator` recompiles **every** live assertion
on any commit that touched any table, so one assertion whose body cannot be planned
blocks writes to the **entire database** — not just to the tables it mentions. The
error surfaces at some unrelated later statement and never names the assertion.

The invariant to establish: *an assertion's stored body always resolves against the
live catalog.* Two DDL surfaces can break it today, and one migration-ordering
detail would break it in a new way once the first is fixed.

## What was reproduced (all in-process at HEAD, memory module)

**Arm 1 — creating an assertion over a missing table / column / function succeeds.**

```
create assertion ax check (not exists (select 1 from nope where q < 0));   -- OK
create table other (i integer primary key);                                -- OK
insert into other values (1);
-- Table 'nope' not found in schema path: main
```

Same for a missing column (`Column not found: zzz`) and an unknown function
(`Function not found: nosuchfn/1`) — each accepted at create, each fatal to every
subsequent write.

**Arm 2 — dropping a table *or a view* an assertion still names succeeds.**

```
create table t (x integer primary key);
create assertion a1 check (not exists (select 1 from t where x < 0));
create table other (i integer primary key);
drop table t;                     -- OK
insert into other values (1);
-- Table 't' not found in schema path: main
```

The **view** arm is not in the source ticket but reproduces identically and must be
covered:

```
create table t (x integer primary key);
create view v as select * from t;
create assertion av check (not exists (select 1 from v where x < 0));
drop view v;                      -- OK
insert into t values (2);
-- Table 'v' not found in schema path: main
```

**Declarative routes to the same state**, both reproduced end to end:

- A declaration that stops declaring table `t` while still declaring an assertion
  naming `t`: `apply schema main` succeeds, drops `t`, keeps the assertion, and the
  database is unwritable afterwards.
- A declaration that renames `t → t2` (via the `quereus.renamed_from` hint) but
  leaves the declared assertion body on `t`: the rename rewrites the *stored* body
  to `t2`, the differ then sees drift against the stale declaration, and recreates
  the assertion naming the vanished `t`. Unwritable again. This is the case
  `schema-differ.ts:857-860` and `docs/schema.md:551` already point at this ticket
  for.

## The boundary question, answered by precedent

The source ticket asks which planner errors should be fatal. `CREATE VIEW` already
answers it: `buildCreateViewStmt` calls `planViewBody` unconditionally
(`create-view.ts:74-78`), so a view body is planned at **build** time and *any*
resolution failure fails the statement. Measured behaviour of that path:

| body problem | `create view` today |
| --- | --- |
| missing table | fails — `Table 'nope' not found in schema path: main` |
| missing column | fails — `Column not found: zzz` |
| unknown function | fails — `Function not found: nosuchfn/1` |
| type mismatch (`x + 'abc'`) | succeeds (not a planner error) |

So the rule needs no bespoke error classification: **whatever the planner rejects
for a view body, reject for an assertion body.** Assertions become as strict as
views, no stricter.

`buildCreateAssertionStmt` (`planner/building/create-assertion.ts`) is eleven lines
and validates nothing. That is the single root-cause site for arm 1.

**Build time is the right place, not emit time.** Statements execute one at a time
— `create table t (…); create view v as select * from t;` in a single `db.exec`
works today, and `apply schema` runs each migration statement through its own
`db._execWithinTransaction(ddl)` (`schema-declarative.ts:429-432`). So a build-time
check sees the catalog left by every preceding statement. Doing it at build also
means the check runs before any transaction is started or any catalog mutation
happens, so a rejection is a clean no-op.

**The emitter's `try/catch` stays exactly as it is.** Its job is dependency
*discovery* for the informational `assertion_info().dependent_tables` column, and
it must keep tolerating a discovery that yields nothing (see
`backlog/bug-assertion-info-dependent-tables-always-empty`). Once the builder has
proven the body plans, a failure there is genuinely only a discovery failure and
the existing warn-and-continue is correct. Nothing in `create-assertion.ts` (the
emitter) needs to change; if the second plan feels wasteful, the alternative is to
hang the builder's planned node on `CreateAssertionNode` and have the emitter walk
that instead — optional, and a measurable-cost decision, not a correctness one.

## Arm 2 design — refuse the drop, name both objects

**Policy: refuse.** A cascade would silently delete a user's integrity rule. Note
honestly that this is *stricter* than the nearest precedent rather than matching
it: `drop table` under a plain **view** is allowed today and leaves the view broken
(measured), and the FK drop guard only refuses when referencing *rows* exist
(`manager.ts:1447`). The justification for being stricter is blast radius — a
broken view breaks queries of that view, a broken assertion breaks every write to
the database. Recovery is already available and works: `drop assertion a1` after
the drop restores writes (measured), so refusal never traps a user.

**Detection: reuse the rename walker.** The guard should refuse exactly when
`ALTER TABLE … RENAME` *would have rewritten* the body — same definition of "refers
to", by construction, so the two can never drift. `renameTableInAst`
(`schema/rename-rewriter.ts:70`) is that walker. Add a read-only sibling to the
same module, e.g.

```ts
export function tableReferencedInAst(
  node: AST.AstNode | undefined,
  name: string,
  defaultSchemaName: string,
): boolean
```

implemented by threading a dry-run flag through the existing `visitTableRename` /
`rewriteIdentifierIfTable` pair (set `ctx.changed`, skip the assignment, early
out). Do **not** fork a second traversal, and do not fake it by calling
`renameTableInAst(clone, name, name, …)`.

**Scope: the dropped object's own schema**, matching
`propagateTableRenameToAssertions` — an assertion's unqualified names resolve
against its own home schema first (`Database._homeSchemaPath`), so an unqualified
`t` in an assertion living elsewhere is not necessarily this table. The symmetric
gap (an assertion in schema A naming `B.t` explicitly is not caught) is the same
one views, materialized views and assertions already share on rename; it is
tracked by `backlog/bug-rename-not-propagated-across-schemas`. Leave it, note it.

**Call sites: the three user-facing drop emitters**, not `SchemaManager.dropTable`.
The FK guard lives in the manager, but `dropTable` is also called from internal
rollback and catalog-import cleanup paths (`materialized-view-helpers.ts:520`,
`:558`, `:1486`; `manager.ts:3194`) which must not be vetoed. The DDL emitters are
the correct seam — the same "DDL path, not catalog load" carve-out the source
ticket asks for. One shared helper, three callers:

- `emitDropTable` — at the top of `run`, before the maintained-table branch, so
  both the plain and materialized arms are covered.
- `emitDropView`
- `emitDropMaterializedView`

`IF EXISTS` does not weaken the guard: it governs absence, not dependency. The
message must name both objects and the way out, e.g.
`cannot drop table 'main.t': assertion 'a1' still refers to it — drop or redefine the assertion first`.
Use `StatusCode.CONSTRAINT`, matching the FK drop guard and the existing
`Assertion … already exists` error.

**Assertions with no `checkExpression`** (the field is optional, for records
reconstructed from `violationSql` alone) have no AST to scan. This is unreachable
today — verified: `SchemaManager.importDDL` accepts only createTable / createIndex
/ createView / createMaterializedView / alterIndex and throws on anything else
(`manager.ts:3008`), so no assertion persistence path exists and every live
assertion came from `CREATE ASSERTION`. Skip them, with the same NOTE
`assertion-rename-helpers.ts:95-101` already carries.

## Arm 3 — declarative migration ordering (this is a *new* break arm 1 creates)

`generateMigrationDDL` currently emits, in order: renames → assertion drops →
detaches → table/view/index drops → **table/view/index/assertion creates** → table
alters. Assertion creates land *before* the `tablesToAlter` phase.

Verified with `diff schema` against a declaration that adds a column and an
assertion over it in the same round:

```
create assertion a_flag check (not exists (select 1 from t where flag < 0))
ALTER TABLE t ADD COLUMN flag integer
```

Harmless today (the create validates nothing). With arm 1 landed, that migration
fails: the assertion is created against a column the next statement adds. **Move
`statements.push(...diff.assertionsToCreate)` out of the create block and to the
end, after the `tablesToAlter` loop.** Assertion drops stay where they are (first).
Nothing in a migration depends on an assertion existing, so creating them last is
strictly safer — they then see the final shape of every table.

Second ordering hazard, same file: a table that is **dropped and recreated in one
migration** would be falsely refused by arm 2. This happens for a maintained table
whose backing module changed (`maintainedModuleRecreates`, `schema-differ.ts:643`),
which emits `DROP TABLE IF EXISTS x` followed by a recreate of `x`. An unchanged
assertion naming `x` is not in `assertionsToDrop` (the diff loop `continue`s on a
body match, `schema-differ.ts:866`) so the drop is refused and the migration dies.
Fix in the same assertion diff loop: force a drop+recreate for any declared
assertion whose body names something in `tablesToDrop` / `viewsToDrop` (reuse
`tableReferencedInAst` on the declared AST). With drops emitted first and creates
last, a dropped-and-recreated object converges cleanly, while a genuinely removed
one makes the assertion *recreate* fail loudly with arm 1's error instead of
silently bricking every write.

This second hazard is reasoned from the diff code, not reproduced end to end —
building a backing-module move takes a store-backed setup. Confirm it with a test
if one can be built cheaply; if not, land the differ change anyway (it is correct
regardless) and say so in the handoff.

## Out of scope

`ALTER TABLE … DROP COLUMN` under an assertion breaks writes the same way. That is
already claimed as "Arm C" of `backlog/bug-drop-column-skips-dependent-checks`,
which names `database-assertions.ts` and `95-assertions.sqllogic` for it — do not
duplicate it here. Only cross-reference.

`DROP INDEX` needs no arm: an assertion body cannot name an index.

## TODO

### Arm 1 — validate the body at create

- In `buildCreateAssertionStmt`, plan the assertion's violation body under the
  assertion's home-schema path (`ctx.db._homeSchemaPath(schemaName)`), mirroring
  how `planViewBody` overrides `ctx.schemaPath`. Let any planner error propagate,
  wrapped so the message names the assertion (keep the underlying cause text — it
  is what tells the user *which* table/column/function is missing).
- Decide and document whether to plan the CHECK expression directly in the home
  scope or to round-trip through `buildAssertionViolationSql` the way the emitter's
  discovery does. The round-trip is what commit-time enforcement actually runs, so
  it is the honest thing to validate; if you plan the expression directly instead,
  state why the two cannot diverge.
- No optimizer/hoist suppression is needed at build time (hoisting is an optimizer
  pass and the new assertion is not registered yet) — confirm this and leave a
  short NOTE saying so, since the emitter's neighbouring code does suppress.
- Leave `emitCreateAssertion`'s discovery `try/catch` alone; update its comment to
  say the body is now known to plan, so a failure there is discovery-only.

### Arm 2 — guard the drops

- Add `tableReferencedInAst` (read-only dry run) to `schema/rename-rewriter.ts`,
  sharing the existing `visitTableRename` traversal.
- Add one shared helper (near `assertion-rename-helpers.ts`, or a sibling) that
  scans the dropped object's own schema for assertions whose `checkExpression`
  names it, and throws a `CONSTRAINT` error naming the dropped object, the
  assertion, and the remedy.
- Call it from `emitDropTable` (before the maintained branch), `emitDropView`, and
  `emitDropMaterializedView`.

### Arm 3 — migration ordering

- Move `assertionsToCreate` emission to the end of `generateMigrationDDL`, after
  the `tablesToAlter` loop.
- In `computeSchemaDiff`'s assertion loop, force drop+recreate for a declared
  assertion whose body names a table or view being dropped in the same diff.

### Tests

- `95-assertions.sqllogic`: create over a missing table / missing column / unknown
  function each fails at the `create assertion` statement, and a subsequent write
  to an unrelated table still commits (proving the database was never poisoned).
- `95-assertions.sqllogic`: `drop table` / `drop view` / `drop materialized view`
  under a referring assertion is refused with a message naming both; `drop
  assertion` then lets the drop succeed.
- `95-assertions.sqllogic`: an assertion in another schema is *not* falsely
  tripped by an unqualified same-name table drop in `main` (the same-schema scope
  rule).
- Declarative: `apply schema` where the declaration adds a column and an assertion
  over it in one round now succeeds (arm 3 ordering).
- Declarative: `apply schema` where the declaration drops a table but keeps an
  assertion naming it fails with the arm 2 message instead of silently bricking
  writes.
- Declarative: `apply schema` that renames a table but leaves the declared
  assertion body on the old name fails at the assertion recreate with arm 1's
  error (this is the case `docs/schema.md:551` promises this ticket resolves).

### Docs

- `docs/sql-ddl.md` § 2.6.1: state that the CHECK body is validated at create time
  (same strictness as a view body), and that dropping a table / view / materialized
  view a live assertion names is refused.
- `docs/schema.md` § Assertion body-change detection: correct the ordering
  sentence — assertion creates now run **last**, after the table alters, not after
  the table/view/index creates. Replace the trailing "that is a separate defect …
  tracked by `bug-assertion-body-can-name-missing-table`" paragraph with what
  actually happens now.
- `docs/schema.md:551` and `packages/quereus/src/schema/schema-differ.ts:857-860`
  both name this ticket by slug — update both.

### Validation

- `yarn build`, `yarn lint`, `yarn test` from the repo root. `yarn test:store` is
  worth one run for the drop guard (ALTER/DDL paths differ under the store module),
  but it is slow — skip it and say so if it does not fit.
