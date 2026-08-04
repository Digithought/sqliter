---
description: An integrity rule written against a materialized view used to be silently never checked; it is now enforced at commit, and watchers over chained materialized views now fire.
files:
  - packages/quereus/src/core/database-materialized-views.ts        # recordMaintenanceChanges (~line 724) + call site in postApplyBackingChanges (~685); stale comment at ~310 corrected
  - packages/quereus/src/core/database-materialized-views-plans.ts  # MaterializedViewManagerContext gained _recordInsert/_recordDelete/_recordUpdate
  - packages/quereus/src/planner/analysis/change-scope.ts           # two stale comments corrected (~206, ~256)
  - packages/quereus/src/core/statement.ts                          # stale comment corrected (~801)
  - packages/quereus/test/logic/95-assertions.sqllogic              # new section: assertions over maintained tables (appended at EOF)
  - packages/quereus/test/incremental/mv-chain-watch.spec.ts        # NEW — pins the MV-over-MV watch case
  - docs/change-scope.md                                            # § Materialized-view reference projection rewritten
  - docs/incremental-maintenance.md                                 # § Recording changes — new subsection
  - docs/mv-maintenance.md                                          # ~line 238
repro: verified
---

# What changed

One behaviour change, one code site.

A materialized view **is** a table, so `create assertion a check (not exists (select 1
from mv where x < 0))` compiles to a plan that reads `main.mv`. The commit-time evaluator
runs an assertion only when the base tables its plan reads overlap the set of base tables
the transaction changed. Row-time maintenance writes an MV's backing through the
privileged `BackingHost` surface, which never touched the transaction change log — so
`main.mv` was never a *changed* base, the overlap test never matched, and the assertion
silently never ran. The identical rule over a **plain** view worked, because a plain view
is expanded during planning and its plan reads the source table directly.

Fix: `MaterializedViewManager.postApplyBackingChanges` — the single choke point every
realized maintenance delta passes through, for both the per-row inline path and the
end-of-statement flush — now records each `BackingRowChange` into the change log via the
same `Database._recordInsert/_recordUpdate/_recordDelete` surface the user-DML boundary
uses. Extracted as a private `recordMaintenanceChanges`. Three method declarations were
added to `MaterializedViewManagerContext`; `Database` already implemented all three and
is already the context, so there was no other wiring.

Keyed on the maintained table's own **logical** `primaryKeyDefinition`, deliberately not
`plan.backingPkDefinition` (the *physical* backing key, which can differ under a
collation-coarsened key) — this is the same key `AssertionEvaluator` derives via
`_findTable(...).primaryKeyDefinition`, so the two agree.

Placed **before** the `if (!this.rowTimeBySource.has(backingBase)) return;` leaf fast
path, so a non-chained MV records too.

## Second symptom, same site — MV-over-MV watchers

`analyzeChangeScope` projects a materialized-view reference to the view's **direct**
source union. That is one level deep: for `mv2` over `mv1` over `w`, the projected scope
is a watch on `main.mv1`, which was itself never change-logged, so `mv2`'s watcher never
fired on an insert into `w`. Recording maintenance writes makes `main.mv1` a real changed
base and the consumer fires. No change to the projection itself — it stays as a
granularity-widening device, now conservative rather than load-bearing.

## What did NOT change

- `AssertionEvaluator` — untouched, and confirmed to need no change. Per-key residual
  dispatch over a maintained-table relation behaves; every new case passes without
  forcing global re-evaluation.
- `resolveMaterializedViewSource` / `buildSourceUnionScope` — untouched by design.
- **`REFRESH MATERIALIZED VIEW` is still invisible to assertions.** Confirmed
  statically: `rebuildBacking` (materialized-view-helpers.ts:1537) calls
  `host.replaceContents` on the fast path, or `host.applyMaintenance('replace-all')`
  directly on the constraint-bearing branch — neither routes through
  `postApplyBackingChanges`, so nothing here touches it. A refresh that re-derives
  violating content still commits. Pre-existing, out of scope, documented in
  `docs/incremental-maintenance.md` and in a comment in the new sqllogic section.

# Verification

```
yarn workspace @quereus/quereus run test   → 8678 passing, 13 pending, 0 failing
yarn lint                                  → clean
yarn typecheck                             → clean
```

**Every new test was confirmed to fail without the fix.** The single line
`this.recordMaintenanceChanges(...)` was temporarily stubbed out and the new sqllogic
section plus the new spec were re-run: the sqllogic file failed on the first violating
commit (it succeeded silently), and 2 of 3 spec cases failed (`expected [ 'mv1' ] to have
the same members as [ 'mv1', 'mv2' ]`). Restored and re-run green.

## Use cases to exercise

New sqllogic section at the end of `packages/quereus/test/logic/95-assertions.sqllogic`
(prefix `amv_`). Runs under both the memory module and, via `yarn test:store`, LevelDB.

- **Projection MV, source write** — `insert into amv_w values (-1)` now raises
  `Integrity assertion failed: amv_nonneg`, and the rollback leaves both the source and
  the view empty.
- **Later commit, not only the first** — the first COMMIT after `CREATE ASSERTION`
  registers the assertion's projection capture demand too late for that transaction and
  falls back to global re-evaluation (pre-existing, shared with ordinary tables). A later
  commit takes the ordinary keyed-dispatch path; asserted separately so the fix is not
  silently only-first-commit.
- **Write-through to the MV itself** — `insert into amv_mv values (-3)`, routed to the
  source by the view-mutation rewrite.
- **Aggregate MV** (`select g, sum(amt) … group by g`) — the residual / delta-aggregate
  arm, flushed at end-of-statement. Each individual row is under the cap; only the
  maintained SUM crosses it, so this cannot pass by accident via a source-table read.
  Covers both an insert and an update that pushes an existing group over.
- **MV over MV** — assertion names the chain's tail; needs recording at *both* levels.
- **`create table … maintained as …`** — the explicitly-declared maintained table shares
  one maintenance path with MV sugar.
- **Negative cases** — clean insert / update / delete still commit, with the view's
  contents asserted afterward.
- **Savepoint discard** — a violating insert inside a savepoint, `rollback to`, then a
  clean insert and COMMIT. Must not trip: `_record*` writes the current change-log layer,
  which `ROLLBACK TO` discards along with the backing write it describes.

New spec `packages/quereus/test/incremental/mv-chain-watch.spec.ts` — `mv2` over `mv1`
over `w`: the consumer's watcher fires on insert, on update, and on delete into the chain
root, and the chain's contents propagate end-to-end.

## Honest gaps — where a reviewer should push

- **No test asserts change-log *volume*.** The claim that recording is bounded by the
  realized per-statement delta rests on reading the bulk paths (`materializeView`,
  `rebuildBacking`, `attachMaintainedDerivation` all call the host directly) plus the
  backing-host contract that a value-identical upsert reports no `BackingRowChange`. Both
  were read, neither is pinned by a test. A `create materialized view` over a large table
  adding change-log entries would be a silent regression.
- **The `join-residual` lookup-side arm and the `prefix-delete` (lateral-TVF fan-out) arm
  have no assertion coverage.** They route through the same `postApplyBackingChanges`, so
  they are covered by construction, but not by a test. The `inverse-projection`,
  `residual-recompute`/delta-aggregate, and cascade paths *are* exercised. A reviewer
  wanting more could add an assertion over a 1:1-join MV.
- **No test covers a collation-coarsened backing key.** The choice of logical
  `primaryKeyDefinition` over physical `backingPkDefinition` is exactly the case where the
  two diverge, and it is argued from the `AssertionEvaluator` key derivation rather than
  demonstrated. `packages/quereus/test/coarsened-backing-key.spec.ts` is the natural home
  for a case that pins it.
- **Partial-WHERE MVs are untested here.** A row leaving the MV's WHERE scope should
  record a delete; asserted nowhere.
- **`--store` (LevelDB) run not executed.** Only `yarn test` (memory) was run, per the
  agent-runnable time budget. The new sqllogic section runs under `yarn test:store` too
  and touches transaction/savepoint machinery, so it is a reasonable candidate for a
  store-path check.

## Tripwires parked (not tickets)

- `packages/quereus/src/core/database-materialized-views.ts`, above
  `recordMaintenanceChanges` — a `NOTE:` on change-log volume for the `'full-rebuild'`
  arm: a body that reshuffles many rows on a small source write (a window-function
  ranking, say) realizes a wide diff and records a wide change-log slice per statement.
  Fine at current shapes; the escape (a single table-granular invalidation for that arm)
  is named at the site.
- `docs/change-scope.md` § Materialized-view reference projection — the one-level-deep
  nature of the projection is now written down explicitly, since it is the reason the
  chain case depended on this fix and would be easy to re-break.

## Docs

- `docs/incremental-maintenance.md` § Recording changes — new subsection covering what is
  recorded, why (both consumers), the key choice, the bounded-ness argument, and the
  REFRESH carve-out.
- `docs/change-scope.md` § Materialized-view reference projection — rewritten: the
  projection is granularity-widening, not what makes a watch fire; the one-level-deep
  consequence spelled out.
- `docs/mv-maintenance.md` ~line 238 — the "written off the user change log" claim
  corrected.
- `docs/sql-ddl.md` § 2.6.1 unchanged — it already promised COMMIT-time enforcement with
  no materialized-view carve-out. The code now meets the doc.
- Four source comments asserting the now-false invariant corrected:
  `planner/analysis/change-scope.ts` (×2), `core/statement.ts`,
  `core/database-materialized-views.ts`.
