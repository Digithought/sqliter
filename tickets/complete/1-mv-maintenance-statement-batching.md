description: Bulk inserts into tables with aggregate materialized views were 25-90x slower than needed because view maintenance recomputed per source row; maintenance is now batched per statement (implemented and reviewed).
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/core/database-materialized-views-apply.ts, packages/quereus/src/core/database-materialized-views-plans.ts, packages/quereus/src/core/database-materialized-views-plan-builders.ts, packages/quereus/src/core/database.ts, packages/quereus/src/core/database-external-changes.ts, packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/runtime/emit/materialized-view-helpers.ts, packages/quereus/test/incremental/maintenance-equivalence.spec.ts, packages/quereus/test/performance-sentinels.spec.ts, docs/mv-maintenance.md, docs/invariants.md, docs/todo.md
----
## What shipped

The three **residual** maintenance arms (`'residual-recompute'`, `'prefix-delete'`,
`'join-residual'`) no longer recompute per source row. Affected binding keys accumulate —
deduped on canonical key values — in a per-statement `ResidualKeyBatch` owned by the DML
generator, and each distinct key's residual runs once at the end-of-statement flush.
`'inverse-projection'` stays per-row-immediate (covering-UNIQUE enforcement reads its
backing mid-statement). The existing full-rebuild deferral unified into the same flush
(`flushDeferredMaintenance`, renamed from `flushDeferredRebuilds`), draining both
structures in worklist rounds over the MV-over-MV DAG. A per-statement
`shouldDegradeToRebuild` demotion runs one whole-body `'replace-all'` when a statement's
distinct-key count crosses the residual↔rebuild crossover.

Measured: repro workload (memory vtab, N=1000, 40 accounts, 24 periods, 100-row
statements, two aggregate MVs) dropped from ~25x to ~3.0x a plain bulk insert. Guarded by
a ratio-bound performance sentinel (12x).

Semantics change (documented): residual-arm backing state is now visible at
end-of-statement, not mid-statement — matching the full-rebuild floor's already-shipped
semantics. Between-statement reads-own-writes inside a transaction unchanged.

See the implement commit `6426a88a` for the full mechanics; the design writeup lives in
`docs/mv-maintenance.md` § Synchronous, transactional, per-statement and invariants
MV-003 / MV-004.

## Review findings

**Verdict: accept.** Thorough, well-decomposed implementation with excellent doc/comment
discipline. Lint clean; full quereus suite **7098 passing / 0 failing** (7096 from the
implementer + 2 added this pass); test typecheck clean.

### Checked — correctness

- **Deferral soundness (the claim the whole cut rests on).** Verified no mid-statement
  reader of a residual/full-rebuild backing exists beyond enforcement. Both gates are in
  place and belt-and-suspenders: `findRowTimeCoveringStructure` now declines every
  non-`'inverse-projection'` kind (`plan.kind !== 'inverse-projection' → undefined`), and
  `lookupCoveringConflicts` independently hard-returns `[]` for a non-inverse-projection
  plan (`database-materialized-views.ts:1044`). Docs (MV-003/MV-004,
  `mv-maintenance.md`) match the code exactly.
- **Cascade depth accounting.** `postApplyBackingChanges` extraction preserves the original
  `assertCascadeDepth` semantics: per-row path passes `depth+1`, guards `if (depth > 0)`,
  recurses with the same `depth` — traced equivalent to the pre-refactor inline loop. The
  flush enters at depth 0 and relies on `assertFlushRounds` (round bound `rowTime.size+1`,
  unchanged) instead. Sound.
- **Flush round mechanics.** `residuals`/`rebuilds` snapshotted then both structures
  `.clear()`ed at round start; the snapshot holds live entry-object references (clearing
  the outer Map does not clear the entry Maps), re-accumulations route to the fresh
  structures and drain next round. Residuals-before-rebuilds within a round is an
  optimization, not a correctness dependency (every apply reads live state); round bound
  remains an upper bound for mixed chains.
- **ForwardResidualKey / PrefixDeleteKey cross-statement dedup.** `keyTuple` and `keyVals`
  are both functionally determined by the same logical key for every arm (aggregate group
  key; join `T`-PK; prefix base-PK leads backing-PK), so extending the per-change dedup
  across a whole statement introduces no divergence. No bug.
- **join-residual forward+lookup in one statement / op ordering.** `computeResidualBatchOps`
  concatenates forward then lookup ops into one `applyMaintenance`; both variants read the
  same post-statement live state, so an overlapping backing row is recomputed
  value-identically (host suppresses the dup) and no forward-delete/lookup-upsert can
  disagree on a key's membership. Sound.
- **Error paths.** OR FAIL / OR IGNORE / OR REPLACE drains verified; a reverted per-row
  savepoint leaves a harmless accumulated key (recompute value-identical, suppressed).
  Statement-savepoint rollback discards the in-memory batch — no flush, correct.

### Found + done — test coverage (minor, fixed inline)

The implementer honestly flagged that the genuinely-multi-key join-residual batch (several
distinct keys of one variant in a single statement) was exercised only indirectly. Added a
dedicated `join-residual arm — multi-key statement batch` sub-describe pinning both:
lookup-side (`update p ... where id <= 3` → 3 distinct P keys, one flush, no per-row
dispatch) and forward-side (`update t set fk=4 where fk=1` → 2 distinct T keys, one flush).
Both pass; equivalence asserted. This closes the most notable gap.

### Reviewed — no action (accepted as-is)

- **Degrade demotion tested only on the aggregate arm; `shouldDegradeToRebuild` costs
  prefix-delete/join-residual identically to `'residual-recompute'`.** An approximation the
  handoff called out — a fan-out/two-variant-aware residual cost would be a cost-model
  refinement, not a correctness issue (degrade always resolves to a correct whole-body
  replace-all). Left as documented. **Tripwire:** if a future cost-model pass revisits
  residual calibration, extend it to fan-out arms; parked here in findings (no code site
  owns it, and the existing plan-builder NOTE covers the compile-cost angle).
- **OR FAIL + a flush-time validation/RESTRICT failure** leaves the already-applied flush
  ops in the pending transaction layer while the error propagates (no statement savepoint).
  This is the full-rebuild floor's pre-existing OR FAIL semantics extended to residual
  arms — not new in kind. Backing content is correct (recomputed from survivors); the
  transaction stays open and a subsequent rollback discards everything. Accepted.
- **Registration compile cost** — one extra whole-body scheduler per residual-MV
  (re)registration. Tripwire already recorded as a `NOTE:` at
  `database-materialized-views-plan-builders.ts` § `buildMaintenancePlan` (compile lazily
  on first degrade if bulk catalog import ever makes registration latency matter). Correct
  disposition; left in place.
- **Nested-statement (FK cascade DML) double-recompute** — a nested statement flushes its
  own batch, and an outer flush may recompute the same keys again (correct, mildly
  redundant). Consistent with prior `deferredRebuilds` behavior. Accepted.

### Docs

Read every touched doc against the code. `mv-maintenance.md`, `invariants.md`
(MV-003 narrowed to inverse-projection, MV-004 broadened), and `todo.md` (op-coalescing
item marked landed) all reflect the shipped reality. No stale references to the removed
`degradeToRebuild` field or the old `flushDeferredRebuilds` name remain.

### Not filed

No major findings → no new fix/plan/backlog tickets. No security surface. No pre-existing
test failures surfaced.
