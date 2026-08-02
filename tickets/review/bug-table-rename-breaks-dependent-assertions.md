---
description: Renaming a table or column used to silently break every integrity-check rule that mentioned it, so all later writes failed with a confusing "table not found" error; renames now rewrite those rules the same way they already rewrite views.
files:
  - packages/quereus/src/runtime/emit/assertion-rename-helpers.ts        # NEW — the propagation pass (both arms)
  - packages/quereus/src/runtime/emit/alter-table.ts                     # two call sites, in the same-schema block after the view loop
  - packages/quereus/src/schema/assertion.ts                             # NEW buildAssertionViolationSql (shared builder)
  - packages/quereus/src/runtime/emit/create-assertion.ts                # now calls the shared builder
  - packages/quereus/src/schema/schema-differ.ts                         # corrected NOTE on the assertion loop
  - packages/quereus/test/assertion-rename-propagation.spec.ts           # NEW — catalog-level invariants
  - packages/quereus/test/logic/95-assertions.sqllogic                   # NEW end-to-end rename section (tail of file)
  - docs/sql-alter.md                                                    # RENAME TABLE / RENAME COLUMN propagation lists
  - docs/schema.md                                                       # § Assertion body-change detection
difficulty: medium
repro: verified
---

# `ALTER TABLE … RENAME` now follows into assertion bodies

## What changed

Before: an assertion (`create assertion a1 check (not exists (select 1 from t where x < 0))`)
kept its CHECK expression exactly as written. `ALTER TABLE t RENAME TO t2` rewrote
every other dependent the catalog knows about — table CHECK expressions, foreign-key
targets, partial-index predicates, view bodies, materialized-view bodies — but not
assertion bodies. Since assertions are evaluated at COMMIT over the tables that
changed, **every** subsequent write to the renamed table failed with
`Table 't' not found in schema path: main` (or, for a column rename,
`Column not found: x`) — an error naming something the user had just renamed away,
with no mention of the assertion.

After: a rename rewrites the assertion's stored CHECK-expression AST in place and
regenerates the derived `violationSql` (the text the commit-time evaluator re-parses
and re-plans), then re-registers the assertion so dependent caches invalidate. The
rule keeps enforcing, against the new name.

### Shape of the implementation

**Shared violation-SQL builder.** `buildAssertionViolationSql(check)` moved into
`src/schema/assertion.ts`; `emitCreateAssertion` and the new propagation both call
it, so a rewritten body regenerates byte-identically to what a fresh
`CREATE ASSERTION` would have produced. `emitCreateAssertion` keeps its existing
error wrapping.

**The pass** lives in a new `src/runtime/emit/assertion-rename-helpers.ts` (not
inside `alter-table.ts`, which was already 2347 lines and is named in
`backlog/debt-emit-source-files-too-large`). It exports
`propagateTableRenameToAssertions` and `propagateColumnRenameToAssertions`. Both are
called from the `schema.name === renamedSchema` block of
`propagateTableRenameInSchema` / `propagateColumnRenameInSchema`, right after the
view loop and before the materialized-view pass.

Per assertion:

- `checkExpression` is rewritten in place via `renameTableInAst` (table arm) or
  `renameColumnInAst` + the statement's shared `resolveColumnInSource` (column arm).
  The **unseeded** column walker is the right one — an assertion body owns its own
  FROM scopes (`not exists (select … from t …)`), so there is no owning table to
  seed an implicit binding for.
- On no change, the assertion is skipped entirely: no re-register, no event.
- On change: `violationSql` regenerated, `dependentTables` string-mapped old base →
  new base (table arm only — it is keyed by base table, so a column rename does not
  touch it), record re-registered through `SchemaManager.addAssertion`, which is what
  fires `assertion_modified` and invalidates the optimizer's assertion-hoist cache.

## Use cases to exercise when reviewing

Both original repros, now green:

```sql
create table t (x integer primary key);
create assertion a1 check (not exists (select 1 from t where x < 0));
alter table t rename to t2;
insert into t2 values (7);      -- was: Table 't' not found. Now: commits.
insert into t2 values (-1);     -- Integrity assertion failed: a1
```

```sql
create table u (id integer primary key, x integer);
create assertion a2 check (not exists (select 1 from u where x < 0));
alter table u rename column x to y;
insert into u values (1, 3);    -- was: Column not found: x. Now: commits.
insert into u values (2, -3);   -- Integrity assertion failed: a2
```

Worth poking at by hand beyond what the tests cover:

- An assertion whose body joins **two** tables, one of which is renamed.
- A rename inside an explicit transaction that also writes rows (the assertion fires
  at that COMMIT, against the just-rewritten body).
- An assertion body using a CTE, an alias (`from t as tt where tt.x < 0`), or a
  correlated subquery — the walkers are shared with the view-body path, so these
  should behave identically to a view, but they are untested here specifically.
- `apply schema` round-trip: declare a `quereus.previous_name` rename hint **and**
  update the declared assertion body to the new name. Second `diff` should be empty.
- Renaming a table an assertion does NOT mention, in a database that has assertions —
  should produce no `assertion_modified` at all.

## Validation run

- `yarn test` (all workspaces) — **8411 passing** in `packages/quereus`, every other
  workspace green, 0 failing, 13 pending (pre-existing).
- `yarn lint` (all workspaces; for `packages/quereus` this is eslint **plus**
  `tsc -p tsconfig.test.json --noEmit`) — clean.
- `tsc -p tsconfig.json --noEmit` on `packages/quereus` — clean.

New tests:

- `test/assertion-rename-propagation.spec.ts` (6 cases): stored `violationSql` and
  rewritten AST after each rename kind; `dependentTables` re-key consistency;
  `assertion_modified` fires for the rewritten assertion and **not** for an untouched
  one; a `temp`-schema assertion tracks a `temp` rename; a `temp`-schema assertion is
  left alone when a like-named `main` table is renamed.
- `test/logic/95-assertions.sqllogic` (tail): end-to-end rename section for both arms
  — benign write commits, violating write still raises
  `Integrity assertion failed: …`, plus an `assertion_info()` check pinning the exact
  rewritten `violation_sql`. The table arm's body carries a table-qualified
  self-reference (`… where ren_t.x < 0`) to prove the qualifier follows too.

## Known gaps — treat these as the review's starting points

**Cross-schema references are still broken** (deliberately out of scope). An
assertion in `main` whose body names `temp.u` with an explicit qualifier is not
rewritten when `temp.u` is renamed; every later write then fails. This is not
assertion-specific — a **view** in `main` over `temp.u` breaks identically, and
materialized views share the shape. Fixing it means teaching the rename walkers an
"only match an explicitly schema-qualified reference" mode and running the view / MV /
assertion loops over every schema under it. Tracked by
`backlog/bug-rename-not-propagated-across-schemas`. Per the ticket, **no test asserts
the broken behavior** — it is a defect, not a contract.

**The declarative story is only half fixed.** An `apply schema` whose declared
assertion body was left on the *pre*-rename name still converges the diff while
recreating the assertion against a table that no longer exists, because
`CREATE ASSERTION` accepts a body naming a missing table. That is
`fix/bug-assertion-body-can-name-missing-table`, not this ticket. The `schema-differ`
NOTE and `docs/schema.md` were updated to point there rather than here.

**`dependentTables` is cosmetic and independently broken.** It feeds only
`assertion_info().dependent_tables`; the evaluator recomputes its own base set when
it compiles. Discovery at create time already misses base tables reached through a
subquery — which is every realistic assertion body
(`backlog/bug-assertion-info-dependent-tables-always-empty`) — so in practice the
array is usually empty and the re-key is a no-op. The spec case therefore asserts the
mapping is *consistent* (no entry left on the old base, `<base>#<nodeId>` shape
preserved) rather than that any particular entry exists. A reviewer wanting real
coverage of the re-key needs the discovery bug fixed first.

**No `try`/`catch` around the per-assertion rewrite.** The MV pass catches per object
and marks the MV stale; this pass lets a failure propagate. Rationale: the only
plausible throw is `expressionToString` on an AST that already stringified
successfully at create time (a rename only swaps identifier strings), and catching
would leave `checkExpression` rewritten while `violationSql` still named the old
table — enforcement would break in exactly the way this ticket fixes, but silently.
If a reviewer disagrees, the alternative is failing the whole `ALTER` before any
mutation, which needs a dry-run probe like `assertRenameDependentsPersistable`'s.

**Store path not exercised.** `yarn test:store` (LevelDB-backed re-run of the logic
tests) was not run — it is out of the default agent test scope. The propagation is
engine-level and runs identically for both backends, and the persistence pre-flight
was confirmed to need no assertion arm (verified: `CatalogObjectKind` is
`'view' | 'materializedView' | 'table'`, no store module has an assertion catalog
path, and nothing outside `packages/quereus/src/schema/` subscribes to `assertion_*`
except the optimizer's hoist cache). Still, nobody ran it.

**Untested walker behaviors** inherited from the view path: CTEs, aliases, and
correlated subqueries inside an assertion body. Shared code, so likely fine — but no
assertion-specific test pins them.

## Tripwires parked in code

- `assertion-rename-helpers.ts` (module-level `NOTE:`): the walk is scoped to the
  renamed object's own schema, why (an assertion resolves unqualified names against
  its own schema first, so rewriting an unqualified `t` in another schema's assertion
  would be a false positive), and that the cross-schema gap is
  `bug-rename-not-propagated-across-schemas`. Also records the related sub-case still
  open there: an assertion in `temp` whose unqualified `t` resolves to `main.t`
  through the session search path — not decidable from the stored body alone, since
  the search path is mutable session state.
- `reregisterRewrittenAssertion` (`NOTE:`): an assertion with no `checkExpression`
  (the schema field is optional, for assertions reconstructed from persisted
  `violationSql` alone) is skipped by both arms — there is no AST to walk.
  Unreachable today because nothing persists assertions; **if** an assertion
  reconstruction path is ever added, this pass needs a re-parse arm or those
  assertions break on rename.
