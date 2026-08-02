---
description: A database-wide integrity rule could be created naming a table or column that does not exist, and dropping a table or view a rule still used was allowed — either way every later write to the whole database failed. Both are now refused up front.
files:
  - packages/quereus/src/planner/building/create-assertion.ts       # Arm 1 — body planned at build time
  - packages/quereus/src/runtime/emit/create-assertion.ts           # comment only; discovery try/catch unchanged
  - packages/quereus/src/schema/rename-rewriter.ts                  # Arm 2 — tableReferencedInAst (dry run)
  - packages/quereus/src/runtime/emit/assertion-drop-guard.ts       # Arm 2 — NEW shared guard
  - packages/quereus/src/runtime/emit/drop-table.ts                 # Arm 2 call site
  - packages/quereus/src/runtime/emit/drop-view.ts                  # Arm 2 call site
  - packages/quereus/src/runtime/emit/materialized-view.ts          # Arm 2 call site (emitDropMaterializedView)
  - packages/quereus/src/schema/schema-differ.ts                    # Arm 3 — DDL ordering + forced assertion recreate
  - packages/quereus/test/logic/95-assertions.sqllogic              # arms 1+2 end to end (appended)
  - packages/quereus/test/assertion-body-resolves.spec.ts           # NEW — declarative arms + ordering
  - packages/quereus/test/logic/50-declarative-schema.sqllogic      # updated expectation (ordering changed)
  - packages/quereus/test/logic/102-schema-catalog-edge-cases.sqllogic # updated cleanup (drop guard fired)
  - docs/sql-ddl.md                                                 # § 2.6.1
  - docs/schema.md                                                  # § Assertion body-change detection
difficulty: medium
---

# What shipped

The invariant established: **an assertion's stored CHECK body always resolves
against the live catalog.** A Quereus assertion (`create assertion <name> check
(<expr>)`) is evaluated at COMMIT, and the evaluator recompiles *every* live
assertion on any commit that touched any table — so one unresolvable body used
to block writes to the entire database, surfacing at an unrelated later
statement with an error that named neither the assertion nor the cause.

Three arms, all landed.

## Arm 1 — `CREATE ASSERTION` validates its body

`buildCreateAssertionStmt` now calls `planAssertionBody` before returning the
node. That renders the body's violation SQL via `buildAssertionViolationSql`,
**re-parses it**, and builds it with `buildSelectStmt` under the assertion's
home-schema path (`db._homeSchemaPath`).

- **Round trip is deliberate**, not incidental: the parsed text is exactly what
  the emitter stores and what the commit-time evaluator re-parses, so a
  stringify/parse round trip that mangles the expression is caught too.
  Planning the AST in hand would miss that.
- **Build, not optimize** — same as `planViewBody`. Consequence: no
  assertion-hoist suppression is needed (hoisting is an optimizer pass).
- **Strictness is the `CREATE VIEW` precedent, exactly.** Measured, both before
  and after:

  | body problem | `create view` | `create assertion` (now) |
  | --- | --- | --- |
  | missing table | fails | fails |
  | missing column | fails | fails |
  | unknown function | fails | fails |
  | type mismatch (`x + 'abc'`) | succeeds | succeeds |

- Message keeps the underlying cause and prefixes the assertion:
  `Cannot create assertion 'ax': Table 'nope' not found in schema path: main`.
- `emitCreateAssertion` is **unchanged** apart from a comment. Its `try/catch`
  is dependency *discovery* for `assertion_info().dependent_tables` and still
  warns-and-continues (see `backlog/bug-assertion-info-dependent-tables-always-empty`).

## Arm 2 — dropping an object an assertion names is refused

New `runtime/emit/assertion-drop-guard.ts` exports
`assertNoAssertionDependsOn(db, schemaName, objectName, kind)`. It throws
`StatusCode.CONSTRAINT`:

```
cannot drop table 'main.t': assertion 'a1' still refers to it — drop or redefine the assertion first
```

- **"Refers to" reuses the rename walker.** New `tableReferencedInAst` in
  `schema/rename-rewriter.ts` runs the *same* `visitTableRename` traversal with
  a `dryRun` flag threaded through the three assignment sites, so it can never
  drift from "what `ALTER TABLE … RENAME` would have rewritten". Dry runs
  early-out once a match is found; the rewriting path is behaviourally
  unchanged.
- **Call sites are the three user-facing DDL emitters** — `emitDropTable`
  (before the maintained-table branch, so `DROP TABLE` on a materialized view
  is covered), `emitDropView`, `emitDropMaterializedView`. Deliberately **not**
  `SchemaManager.dropTable`, which internal rollback and catalog-import cleanup
  also drive.
- **Scoped to the dropped object's own schema**, matching
  `propagateTableRenameToAssertions`. Verified both ways: dropping `main.dg_s`
  does not trip a `temp` assertion whose unqualified body says `dg_s`; dropping
  `temp.dg_s` does.
- `IF EXISTS` does not weaken it. The guard *is* gated on the object existing —
  see Known gaps.

## Arm 3 — declarative migration ordering

`generateMigrationDDL` now pushes `assertionsToCreate` **last** (after the
table-alter block and the maintained re-attach loop) instead of in the create
block. Assertion drops still lead the whole migration.

`computeSchemaDiff`'s assertion loop force-drops-and-recreates any declared
assertion whose body names something in `tablesToDrop` / `viewsToDrop`, even
when the body is byte-identical — otherwise arm 2's guard would refuse the
`DROP TABLE` and kill the migration.

# How to exercise it

## Statement level (`test/logic/95-assertions.sqllogic`, appended sections)

- **Body validation at CREATE (arm 1)** — missing table / missing column /
  unknown function each fail at the `create assertion`; `assertion_info()`
  shows none were registered; an unrelated table still commits afterwards
  (proving the database was never poisoned).
- **DROP refused (arm 2)** — `DROP TABLE`, `DROP TABLE IF EXISTS`, `DROP VIEW`,
  `DROP MATERIALIZED VIEW`, and `DROP TABLE` on a maintained table each refused
  with a message naming both objects; the refusal is a clean no-op (table still
  present, still enforced); `DROP ASSERTION` then lets the drop through.
- **Same-schema scoping** — `temp` assertion vs like-named `main` table.

## Declarative (`test/assertion-body-resolves.spec.ts`, new)

- Declaration adds a column **and** an assertion over it in one round →
  migration puts `ADD COLUMN` before `create assertion`, apply succeeds, rule
  enforces.
- Assertion creates are last: nothing structural follows them in the emitted
  DDL.
- Declaration drops a table but keeps an assertion naming it → the diff
  force-drops the unchanged assertion, and the apply **fails loudly** at the
  recreate with arm 1's error. Other tables stay writable.
- Rename hint `t → t2` with the declared assertion body left on `t` → first
  apply converges (the diff is computed before any DDL runs, and the rename
  rewrites the stored body); a **second** apply of the same stale declaration
  fails at the recreate. This is the case `docs/schema.md` previously pointed
  at this ticket for.

## Manual smoke

```sql
create table t (x integer primary key);
create assertion a1 check (not exists (select 1 from t where x < 0));
drop table t;                 -- refused, names a1
drop assertion a1; drop table t;   -- fine

create assertion ax check (not exists (select 1 from nope where q < 0));
-- Cannot create assertion 'ax': Table 'nope' not found in schema path: main
```

# Validation run

- `yarn build` — clean.
- `yarn lint` — clean (includes the quereus `tsc -p tsconfig.test.json` pass
  over the new spec).
- `yarn typecheck` — clean.
- `yarn test` (root, all workspaces) — **0 failing**; quereus 8422 passing / 13
  pending.
- `yarn test:store` (full LevelDB run, not just the touched files) — **0
  failing**; 8414 passing / 21 pending.

No pre-existing failures were encountered, so `tickets/.pre-existing-error.md`
was not written.

## Two existing tests changed, both because behaviour intentionally changed

- `102-schema-catalog-edge-cases.sqllogic` — its cleanup dropped
  `validated.accounts` while `validated.positive_balance` still named it. Now
  refused; added `DROP ASSERTION validated.positive_balance` before the table
  drop. **The guard doing its job, not a workaround.**
- `50-declarative-schema.sqllogic` — asserted the *old* ordering
  (`create assertion` before `ADD COLUMN`) and carried a comment claiming an
  assertion body "binds at enforcement time, not at create time". Both updated;
  that claim is no longer true, which is the point of arm 1.

# Known gaps — please poke at these

1. **Transitive references are not seen.** An assertion over a *view* whose
   base table is dropped still bricks the database. Verified at HEAD *with this
   fix in place*:

   ```
   create table t (x integer primary key);
   create view v as select * from t;
   create assertion av check (not exists (select 1 from v where x < 0));
   drop table t;                 -- allowed: the assertion names `v`, not `t`
   insert into other values (1); -- Table 't' not found in schema path: main
   ```

   `drop view v` *is* refused. Filed as
   `backlog/bug-drop-table-under-view-an-assertion-names` (design questions
   about walk depth and cost are in that ticket) rather than fixed here — the
   root cause is a different one (reachability through the view graph), and the
   fix has policy and cost questions the implement ticket did not settle.

2. **The maintained-table backing-module recreate is not covered end to end.**
   Arm 3's second half exists for `maintainedModuleRecreates` (a maintained
   table whose `using <module>(…)` changed emits `DROP TABLE IF EXISTS x` plus a
   recreate of `x`). Building that needs a second registered vtab module; the
   in-process default catalog only has `memory`/`mem`, so I could not trigger it
   cheaply. The **same new code path** is covered via the table-*removal* route
   (`assertion-body-resolves.spec.ts`, "fails the apply … drops a table an
   assertion still names" asserts the forced `assertionsToDrop`), but the
   module-move trigger itself is untested. Worth a store-backed test if one is
   cheap to build.

3. **A failed declarative apply leaves the assertion dropped.** Assertion drops
   run first, the recreate runs last; when the recreate fails (gap-2 scenario or
   a genuinely removed table) the migration stops with the table gone *and* the
   assertion gone. The database is writable and the failure is loud — strictly
   better than the previous silent brick — but it is a partial application.
   Worth deciding whether that is the contract we want to document.

4. **The guard is gated on the dropped object existing.** `drop table if exists
   nope` succeeds even if an assertion names `nope`. Intentional: that
   assertion is already broken and nothing is being destroyed. Says so in a
   comment at `drop-table.ts`.

5. **Cross-schema references are still not caught** — an assertion in schema A
   naming `B.t` explicitly is invisible to both the rename propagation and this
   guard. Left as-is on purpose; tracked by
   `backlog/bug-rename-not-propagated-across-schemas`, which fixes all three
   object kinds at once.

6. **Assertions with no `checkExpression`** are skipped by the guard (no AST to
   scan), same as the rename propagation. Unreachable today —
   `SchemaManager.importDDL` has no assertion arm — and carries the same NOTE.

## Review findings (tripwires parked in code)

- `CREATE ASSERTION` now plans its body **twice**: once at build (validation)
  and once at emit (dependency discovery). Immaterial today; parked as a `NOTE:`
  in `planner/building/create-assertion.ts` with the fix if creates ever go hot
  (hang the built node on `CreateAssertionNode`).
- Arm 2's refusal is **stricter than the nearest precedents** — dropping a table
  under a plain view is allowed and leaves the view broken, and the FK drop
  guard only refuses when referencing rows exist. The justification (blast
  radius: a broken view breaks queries of that view; a broken assertion breaks
  every write in the database) is written out at the top of
  `runtime/emit/assertion-drop-guard.ts`, not just in this ticket.
