---
description: An integrity rule written against a materialized view used to be silently never checked; it is now enforced at commit, and watchers over chained materialized views now fire.
files:
  - packages/quereus/src/core/database-materialized-views.ts        # recordMaintenanceChanges + call site in postApplyBackingChanges
  - packages/quereus/src/core/database-materialized-views-plans.ts  # MaterializedViewManagerContext gained _recordInsert/_recordDelete/_recordUpdate
  - packages/quereus/src/core/database-internal.ts                  # IngestExternalChangesOptions.captureChanges doc (review)
  - packages/quereus/src/planner/analysis/change-scope.ts           # stale comments corrected
  - packages/quereus/src/core/statement.ts                          # stale comment corrected
  - packages/quereus/test/logic/95-assertions.sqllogic              # assertions over maintained tables + partial-WHERE delete case (review)
  - packages/quereus/test/incremental/mv-chain-watch.spec.ts        # pins the MV-over-MV watch case
  - docs/change-scope.md
  - docs/incremental-maintenance.md
  - docs/materialized-views.md                                      # § Change-scope projection (review)
  - docs/mv-ingestion.md                                            # § Facets (review)
  - docs/mv-maintenance.md
repro: verified
---

# What shipped

One behaviour change at one code site.

A materialized view **is** a table, so `create assertion a check (not exists (select 1 from
mv where x < 0))` compiles to a plan that reads `main.mv`. The commit-time evaluator runs an
assertion only when the base tables its plan reads overlap the set of base tables the
transaction changed. Row-time maintenance writes an MV's backing through the privileged
`BackingHost` surface, which never touched the transaction change log — so `main.mv` was
never a *changed* base, the overlap test never matched, and the assertion silently never
ran. The identical rule over a **plain** view worked, because a plain view is expanded
during planning and its plan reads the source table directly.

`MaterializedViewManager.postApplyBackingChanges` — the choke point every realized
maintenance delta passes through, for both the per-row inline path and the end-of-statement
flush — now records each `BackingRowChange` into the change log via the same
`Database._recordInsert/_recordUpdate/_recordDelete` surface the user-DML boundary uses
(`recordMaintenanceChanges`). Three method declarations were added to
`MaterializedViewManagerContext`; `Database` already implemented all three.

Second symptom, same site: `analyzeChangeScope` projects a materialized-view reference to
the view's **direct** source union — one level deep. For `mv2` over `mv1` over `w` the
projected scope is a watch on `main.mv1`, which was itself never change-logged, so `mv2`'s
watcher never fired. Recording makes `main.mv1` a real changed base and the consumer fires.
The projection itself is unchanged; it is now a granularity-widening device rather than
load-bearing.

`REFRESH MATERIALIZED VIEW` remains outside all of this — see *Review findings*, which
turned that carve-out into a filed ticket.

# Review findings

## Checked

- **Choke-point coverage.** Enumerated every call site of `postApplyBackingChanges` and
  walked `maintainRowTime`'s dispatch: all five maintenance arms (`inverse-projection`
  inline, and `residual-recompute` / `prefix-delete` / `join-residual` / `full-rebuild`
  through the end-of-statement flush) funnel through it. The recording is reached by
  construction for every arm, including the two the implementer left untested.
- **Bulk paths.** Read `materializeView`, `rebuildBacking`, and
  `attachMaintainedDerivation` to check the "recording is bounded by the realized delta"
  claim. Two of three hold; the third did not (below).
- **Key choice.** Traced `plan.mv.primaryKeyDefinition` vs `plan.backingPkDefinition` to
  their sources. Same indices, always (below).
- **Change-log consumers.** Only `AssertionEvaluator` and `Database.watch` read the change
  log, both via `DeltaExecutor`. No sync / CDC / event channel consumes it, so recording
  maintenance writes cannot leak engine-managed covering structures into a user-visible
  change stream.
- **Savepoints.** `_record*` writes the current layer; the sqllogic savepoint case pins that
  `rollback to` discards the record along with the backing write.
- **Docs.** Read every file the diff touched, plus the ones it links to and the ones that
  restate the falsified invariant.
- **Lint / typecheck / tests.** `yarn lint` clean, `yarn typecheck` clean, `yarn test`
  8678 passing / 13 pending / 0 failing.

## Found and fixed in this pass

- **`docs/materialized-views.md` § Change-scope projection still asserted the falsified
  invariant** — "a maintained table is never written through the user change log … so a
  `Database.watch` on it would never fire". That is the exact claim this ticket disproved,
  in the document `docs/change-scope.md` links to for this topic. Rewritten, with the
  one-level-deep chain consequence spelled out.
- **Three stale symbol names in the `docs/change-scope.md` paragraph the diff rewrote** —
  the backing table named `_mv_<name>` (it is registered under the user's own name; no
  `_mv_` prefix exists anywhere in the source), `SchemaManager.getMaterializedViewByBackingTable`
  (now `getMaintainedTable`), and `MaterializedViewSchema.sourceScope` (that record type was
  deleted; it is `TableDerivation.sourceScope`). Corrected. The same `_mv_<name>` fiction
  survives in `docs/module-authoring.md` and `docs/optimizer-rule-families.md`, outside this
  ticket's reach — left alone rather than widening the diff.
- **The stated reason for keying on the logical PK was wrong.** The comment claimed
  `plan.backingPkDefinition` "is the physical backing key and can differ (collation-coarsened
  keys)". It cannot differ in *indices*: `resolveBackingPkColumns` maps
  `backing.primaryKeyDefinition` one-to-one and only adds the resolved collation *function*,
  and `backing` is the same schema record as `plan.mv`. Reworded to the true reason — it is
  the same object `AssertionEvaluator` reads, so the agreement is structural rather than
  coincidental. This also dissolves the implementer's "no test covers a collation-coarsened
  backing key" gap: there is nothing left for such a test to distinguish.
- **The "bulk paths never route through `postApplyBackingChanges`" claim was wrong for one
  of the three.** `attachMaintainedDerivation` (`alter table … set maintained as …`)
  deliberately cascades its whole-set reconcile delta onward through
  `_maintainRowTimeCoveringStructures`, so a **consumer** maintained table now records one
  change-log entry per reconciled row within that single DDL statement. That is the right
  behaviour — the consumer's content genuinely changed — but it is O(consumer rows) in one
  transaction, not the bounded per-statement delta the comment promised. Corrected in the
  code comment and in `docs/incremental-maintenance.md`.
- **The external-ingestion seam's `captureChanges` facet is no longer honoured end to end.**
  `ingestExternalRowChanges({captureChanges: false})` documented "assertions never run and
  the result is empty regardless of mode"; maintenance now records derived deltas
  unconditionally, so an assertion naming a maintained table the batch drove *does* fire at
  the owning commit. Judged correct rather than a regression — the flag governs the rows the
  *caller* reports (already accounted for at the origin), while these are the engine's own
  derived writes, which no external caller can have captured — but it was undocumented and
  directly contradicted two places in `docs/mv-ingestion.md`. Documented at the option
  declaration, in the facet list (including how to suppress both: turn
  `maintainMaterializedViews` off too), at the `assertionFailureMode` bullet, and at the
  recording site.
- **The `delete` arm of `recordMaintenanceChanges` had no test that required it.** Every
  existing delete case sat on a *passing* commit, so stubbing the recording out left them
  green. Added a partial-WHERE MV case to `95-assertions.sqllogic`: rows leaving the body's
  `where active = 1` scope are evicted from the backing, and an assertion that the view is
  non-empty must trip. **Verified by stubbing out the `recordMaintenanceChanges(...)` call
  and re-running in isolation** — the new case fails without the fix, passes with it — then
  restoring the source byte-for-byte.

## Found and filed

- **`tickets/backlog/bug-refresh-materialized-view-skips-everything-downstream.md`** —
  `refresh materialized view` announces nothing. `rebuildBacking` discards the change list
  `applyMaintenance` returns (and its fast branch calls `replaceContents`, which reports
  nothing), and `refreshMaintainedTable` never cascades. Two arms at one site: a
  materialized view built over a refreshed one keeps serving stale contents, and assertions
  cannot see a refresh. The implementer documented the assertion half as a known carve-out;
  the stale-consumer half is the more serious one and was not noticed. `repro: static` — the
  omission is visible by direct comparison with the sibling `attachMaintainedDerivation`
  path, which does cascade with a comment saying why; the ticket names the setup that would
  confirm it dynamically (a refresh whose recomputed contents actually differ, which needs a
  drifted/stale view).

## Tripwires parked

- No new ones. The implementer's existing `NOTE:` above `recordMaintenanceChanges` (change-log
  volume for the `'full-rebuild'` arm, with the table-granular-invalidation escape named)
  survives review as written. The `attachMaintainedDerivation` O(consumer rows) exception
  found above is recorded at the same code site and in `docs/incremental-maintenance.md`
  rather than as a separate note.

## Deliberately not closed

- **`join-residual` and `prefix-delete` still have no direct assertion coverage.** Left as
  is: the choke-point enumeration above establishes they route through the same recording,
  and a test for each would pin the arm's *own* delta shape rather than this ticket's change.
- **No test asserts change-log volume.** Unchanged from the handoff. A `create materialized
  view` over a large table adding change-log entries would still be a silent regression; the
  bounded-ness argument now rests on a read that also *corrected* one of its three claims,
  which is a mild argument for pinning it eventually.
- **`yarn test:store` (LevelDB) not run** — exceeds the agent-runnable wall-clock budget. The
  new sqllogic sections run under it and touch transaction/savepoint machinery, so they
  remain a reasonable candidate for an out-of-band store-path check.

# Verification

```
yarn lint       → clean
yarn typecheck  → clean
yarn test       → 8678 passing, 13 pending, 0 failing
```

Both the implementer's new tests and the review's added case were confirmed to fail with
`this.recordMaintenanceChanges(...)` stubbed out and to pass with it restored.
