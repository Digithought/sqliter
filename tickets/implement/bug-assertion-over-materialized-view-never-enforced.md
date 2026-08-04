---
description: A database-wide integrity rule written against a materialized view is silently never checked — violating rows commit without error, even though the same rule written against a plain view is enforced correctly.
files:
  - packages/quereus/src/core/database-materialized-views.ts        # postApplyBackingChanges (~line 669-690) — THE fix site
  - packages/quereus/src/core/database-materialized-views-plans.ts  # MaterializedViewManagerContext (~line 35) — needs the three record* methods
  - packages/quereus/src/core/database.ts                           # _recordInsert/_recordDelete/_recordUpdate (~line 1696) — already public, already on Database
  - packages/quereus/src/core/database-transaction.ts               # TransactionManager change log — recordInsert/Update/Delete (~567-621), getChangedBaseTables (~624)
  - packages/quereus/src/core/database-assertions.ts                # AssertionEvaluator — no change expected; verify
  - packages/quereus/src/runtime/delta-executor.ts                   # the kernel that walks live subscriptions on overlap
  - packages/quereus/src/planner/analysis/change-scope.ts           # stale comments at ~206-213 and ~256-259
  - packages/quereus/src/core/statement.ts                          # stale comment at ~801-806
  - packages/quereus/test/logic/95-assertions.sqllogic              # assertion coverage; MV cases here only exercise the DROP guard
  - packages/quereus/test/incremental/                              # home for the watch-firing spec
  - docs/change-scope.md                                            # § Materialized-view reference projection (~225-253)
  - docs/incremental-maintenance.md                                 # § Recording changes (~394-408)
  - docs/mv-maintenance.md                                          # line 238
difficulty: medium
repro: verified
---

# An assertion whose body names a materialized view never runs

## Root cause — one site

The commit-time assertion evaluator runs an assertion only when the base tables
its compiled plan reads overlap the set of base tables the transaction changed
(`AssertionEvaluator.runGlobalAssertions` → `DeltaExecutor.runAll`, dispatching
on `TransactionManager.getChangedBaseTables()`).

A materialized view **is a table**, so an assertion body naming `mv` compiles to
a plan reading `main.mv`. But `main.mv` is never entered into the transaction
change log: the change log is written only at the user-DML boundary
(`runtime/emit/dml-executor.ts` calls `db._recordInsert/_recordUpdate/_recordDelete`
for the table the statement targets). The row-time maintenance that keeps `mv`
consistent with `w` writes the backing through the privileged
`BackingHost.applyMaintenance` surface, which never touches the change log. So
after `insert into w values (-1)` the changed set is `main.w` alone, there is no
overlap with `{main.mv}`, and the assertion is never dispatched.

That single omission — realized maintenance writes are not recorded as changes —
is the whole bug. Everything else about assertions over materialized views
already works: create-time validation, the `DROP` dependency guard, and
`ALTER TABLE … RENAME` body rewriting all treat the dependency as real.

## Reproduction (verified in-process at HEAD, memory module)

```sql
create table w (x integer primary key);
create materialized view mv as select x from w;
create assertion m1 check (not exists (select 1 from mv where x < 0));

insert into w values (-1);   -- commits, no error; mv now holds the violating row
```

Control — the identical rule over a **plain** view raises
`Integrity assertion failed: m2`, because a plain view is expanded during
planning, so the assertion's plan reads `main.w` directly.

## Second symptom at the same site: `Database.watch` over an MV-over-MV chain

The watcher layer hit this same asymmetry earlier and worked around it in the
*planner* rather than at the change log: `analyzeChangeScope` replaces a
materialized-view reference with the view's **source-union** scope
(`buildSourceUnionScope`, cached as `derivation.sourceScope` at registration),
precisely because "the backing table is row-time maintained off the user change
log, so a watch on it would never fire."

That projection is **one level deep** — `derivation.sourceTables` holds the
tables the body directly reads, not the transitive source closure. So for
`mv2` defined over `mv1` defined over `w`, the projected scope is a `full` watch
on `main.mv1`, which is itself never change-logged. Verified at HEAD:

```
scope(mv1) = watch main.w   (full)
scope(mv2) = watch main.mv1 (full)
insert into w values (1)  →  fired = ["mv1"]        -- mv2's watcher never fires
```

Same root cause, same fix site. Recording maintenance writes makes `main.mv1` a
real changed base and the `mv2` watcher fires (verified with the prototype below:
`fired = ["mv1","mv2"]`).

## Chosen approach

Record each realized maintenance write into the transaction change log, at
`MaterializedViewManager.postApplyBackingChanges` in
`packages/quereus/src/core/database-materialized-views.ts`.

That method is the single choke point every realized maintenance delta passes
through — both the per-row inline path (`maintainRowTime`) and the
end-of-statement flush (`flushDeferredMaintenance`) call it, for every
maintenance arm. It already computes `backingBase` (`plan.backingSchema` +
`plan.backingTableName`, which for both `create materialized view` and
`create table … maintained as` **is the maintained table itself** — the same
name the assertion's plan reads).

The prototype (measured, see below) is:

```ts
// in postApplyBackingChanges, after `backingBase` is computed and BEFORE the
// `if (!this.rowTimeBySource.has(backingBase)) return;` leaf fast path
const pkIndices = plan.mv.primaryKeyDefinition.map(d => d.index);
for (const bc of backingChanges) {
  switch (bc.op) {
    case 'insert': this.ctx._recordInsert(backingBase, bc.newRow, pkIndices); break;
    case 'delete': this.ctx._recordDelete(backingBase, bc.oldRow, pkIndices); break;
    case 'update': this.ctx._recordUpdate(backingBase, bc.oldRow, bc.newRow, pkIndices); break;
  }
}
```

plus three method declarations added to `MaterializedViewManagerContext` in
`database-materialized-views-plans.ts` (`Database` already implements them and is
already passed as the context, so no wiring beyond the interface).

### Why this rather than expanding the assertion's dependency set

Expanding a maintained table to its sources when computing an assertion's
dependency set is what the watcher layer already does, and it is exactly what
leaves the MV-over-MV case broken above: it needs the transitive source closure
of a derivation chain, and the existing helper only has the direct sources.
Reproducing that shape in the evaluator would import the same gap and would also
re-run the assertion on any source write even when maintenance changed nothing in
the view. Recording the truth once fixes both consumers and needs no closure walk.

### Measured blast radius

Prototype applied at HEAD:

- `yarn workspace @quereus/quereus run test` → **8677 passing, 13 pending, 0 failing**
  (baseline shape unchanged); `yarn test` across all workspaces green.
- Eight hand-written assertion scenarios all pass with the prototype and fail
  without it (see the TODO list — they are the tests to write).
- No new consumer: `getChangedBaseTables` / `getChangedTuples` / the change log
  are read only by `AssertionEvaluator` and `WatcherManager` (plus the external
  ingestion seam that *writes* it). Nothing else in the repo reads the change log.
- No DDL-scale growth. The bulk paths — `materializeView` (create-fill),
  `rebuildBacking` (refresh), `attachMaintainedDerivation` — call
  `host.replaceContents` / `host.applyMaintenance` **directly** and never route
  through `postApplyBackingChanges`, so a `create materialized view` over a large
  table adds nothing to the change log. Recording is bounded by the realized
  per-statement delta, exactly like user DML. A value-identical `upsert` reports
  no `BackingRowChange` at all (backing-host contract), so no-op maintenance adds
  no entries.
- Savepoints already work: `_record*` writes the current change-log layer, which
  `ROLLBACK TO` discards. Verified — a rolled-back MV delta does not leak into the
  next commit.

## Known behaviours to preserve / verify, not to chase

- **First-commit capture-spec fallback.** An assertion registers its projection
  capture demand when its plan is first compiled, which happens at COMMIT — after
  that transaction's writes were already recorded. So on the first commit after
  `CREATE ASSERTION`, `getChangedTuples` may throw "column N was not registered
  for capture" and `DeltaExecutor` falls back to global re-evaluation
  (`runtime/delta-executor.ts` ~219-223). Correct, just unoptimized, and it is
  pre-existing behaviour shared with ordinary tables. Do not try to fix it here.
- **PK indices source.** Use the maintained table's `primaryKeyDefinition`
  (logical, the table's own column space) — the same thing `AssertionEvaluator`
  derives via `_findTable(...).primaryKeyDefinition`. **Not**
  `plan.backingPkDefinition`, which is the physical backing key and can differ
  (collation-coarsened keys).
- **`REFRESH MATERIALIZED VIEW` stays invisible to assertions.** It swaps
  committed contents via `replaceContents` (or a direct
  `applyMaintenance('replace-all')` in the constraint-bearing branch) without
  going through `postApplyBackingChanges`, so a refresh that re-derives violating
  content does not trip an assertion at that commit. This is a pre-existing,
  separate gap. Confirm it is still the behaviour after the change, note it, and
  do **not** widen scope to fix it here.
- **Do not touch the change-scope projection.** `resolveMaterializedViewSource` /
  `buildSourceUnionScope` remain correct after this change (source watches still
  fire); they simply become conservative rather than load-bearing. Removing them
  would change watch granularity and is out of scope.

## Docs

`docs/sql-ddl.md` § 2.6.1 already promises COMMIT-time enforcement with no
materialized-view carve-out, so it needs no change — the code should meet the
doc. Three other places assert the now-false invariant "a maintained table is
never written through the user change log" and must be corrected:

- `docs/change-scope.md` § Materialized-view reference projection (~lines 225-253)
- `docs/incremental-maintenance.md` § Recording changes (~394-408) — add that
  realized row-time maintenance writes are recorded too
- `docs/mv-maintenance.md` line 238

The same claim appears as source comments in
`planner/analysis/change-scope.ts` (~206-213, ~256-259), `core/statement.ts`
(~801-806) and `core/database-materialized-views.ts` (~310-315).

# TODO

- Add `_recordInsert` / `_recordDelete` / `_recordUpdate` to
  `MaterializedViewManagerContext` in `database-materialized-views-plans.ts`
  (import `Row` is already present). `Database` already implements all three.
- Record each `BackingRowChange` into the change log in
  `MaterializedViewManager.postApplyBackingChanges`, keyed on `backingBase`, using
  `plan.mv.primaryKeyDefinition`. Place it **before** the
  `if (!this.rowTimeBySource.has(backingBase)) return;` leaf fast path, so a
  non-chained MV records too. Prefer a small named private method over an inline
  block, and document at the site that this is what makes a maintained table a
  first-class changed base for the commit-time detection kernel.
- Add sqllogic coverage in `packages/quereus/test/logic/95-assertions.sqllogic`
  for the enforcement cases — all currently fail, all pass with the change:
  - assertion over a projection MV fires on a source write
  - assertion over a projection MV fires on a write-through to the MV itself
    (`insert into mv values (-3)` — routed to the source by the view-mutation rewrite)
  - assertion over a projection MV fires on a *later* commit, not only the first
  - assertion over an aggregate MV (`select g, sum(amt) … group by g`) fires
  - assertion over an MV-over-MV chain fires
  - assertion over a `create table … maintained as …` table fires
  - negative case: writes that keep the MV clean (insert / update / delete) still commit
  - a savepoint/`rollback`-discarded MV delta does not trip the assertion on the
    next, clean commit
- Add a spec (suggested `packages/quereus/test/incremental/mv-chain-watch.spec.ts`)
  pinning that `db.watch(db.prepare('select * from mv2').getChangeScope(), …)`
  fires on an `insert` into the chain's root source, for `mv2` over `mv1` over `w`.
  Without this the transitive watch gap silently regresses.
- Confirm `AssertionEvaluator` itself needs no change (it should not — the
  dispatch overlap is now satisfied by real data). If per-key residual dispatch on
  a maintained-table relation turns out to misbehave, prefer forcing that relation
  to global re-evaluation over widening the change; note it in the handoff.
- Verify `REFRESH MATERIALIZED VIEW` behaviour is unchanged (still not
  assertion-checked) and state it in the review handoff.
- Update the three doc sections and the four source comments listed above.
- Run `yarn workspace @quereus/quereus run test` (expect ≥8677 passing, 0 failing),
  then `yarn lint` and `yarn typecheck`.
