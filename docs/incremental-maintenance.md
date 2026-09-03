# Incremental Maintenance

> **Stability: Internal** — see [Stability Tiers](stability.md#tiers).

Quereus exposes a single, reusable **change-driven delta kernel** that runs at
transaction boundaries. Given the rows a transaction changed, it decides — per
registered consumer — what slice to recompute, how to bind it, and when to fall
back to a full re-evaluation. This document is the **definitive description of the
kernel** and its plug-in contract; the optimizer-side *analysis* that feeds it
(`analyzeRowSpecific` / `extractBindings`) is detailed in
[Optimizer Assertion Analysis § Binding-aware Delta Planning](optimizer-assertions.md#binding-aware-delta-planning-reusable),
and the public projection of that analysis is the
[`ChangeScope` data contract](change-scope.md).

Two consumers are **live** today:

- **Assertions** — a `CREATE ASSERTION` predicate re-checked at COMMIT against only
  the rows that changed (pre-commit; a violation rolls the COMMIT back).
- **`Database.watch`** — reactive callbacks fired post-commit when matching rows
  change (fire-and-forget; a throwing handler is logged, never fatal).

Engineered to plug in next on the same surface: reactive signals and triggers, and
the [lens layer](lens.md)'s set-level constraint maintenance/enforcement where no
covering structure answers it.

> **Materialized views are *not* a kernel consumer.** An earlier design maintained
> `on-commit-incremental` materialized views through this post-commit kernel.
> Materialized views are now **row-time only**: their backing tables are maintained
> synchronously at the DML write boundary, inside the writing transaction, by a
> bounded per-row projection — not by this post-commit delta path. See
> [Materialized Views](materialized-views.md). Materialized views still use
> *change-scope* analysis for `Database.watch` source projection (the cached
> `sourceScope`); they just do not ride the delta-execution kernel.
>
> A design-spike (`incremental-maintenance-substrate-spike`) named two convergence
> points: a shared `MaintenancePlan` abstraction and a backward (maintenance-direction)
> cost gate. The synchronous, in-transaction *application policy* for materialized
> views is **not** in question; only the shared representation and cost model are. Both
> named convergence points have now landed: `incremental-maintenance-plan-abstraction`
> introduced the `MaintenancePlan` union, and `incremental-maintenance-cost-gate` added the
> backward `maintenanceCost(...)` surface (`planner/cost/index.ts`) — MV eligibility is now
> a cost choice among structurally-sound strategies (`selectMaintenanceStrategy`), not a hard
> shape allowlist.
>
> **MV-over-MV cascade.** A materialized view whose source is another MV's backing table
> is maintained synchronously in the same row-time pass, *not* through this kernel. A
> backing write is itself a row-write, so each MV's per-row maintenance reports the
> **effective** backing changes it applied (`applyMaintenancePlan` → the backing
> host's `applyMaintenance` returns a `BackingRowChange[]`), and the manager routes
> those onward to any MV reading that backing — `maintainRowTime` recurses, DAG-ordered
> and atomic within the statement. This path is *arm-agnostic*: it routes whatever
> per-row backing delta a maintenance plan produces, so a chain may mix maintenance arms
> uniformly. (`incremental-maintenance-plan-abstraction` landed the first step of the
> fold: `applyRowTimeChange` is now `applyMaintenancePlan`, which dispatches on
> `MaintenancePlan.kind`; the cascade flow is unchanged: `applyMaintenancePlan` →
> the backing host's `applyMaintenance` → `BackingRowChange[]` → `maintainRowTime`. Five arms are
> wired today: `'inverse-projection'` (the covering-index shape), `'residual-recompute'`
> (single-source aggregates, below), `'prefix-delete'` (single-source lateral-TVF
> fan-out, below), `'join-residual'` (1:1 inner/cross join, below), and `'full-rebuild'` (the
> always-correct floor — re-evaluate the whole body and `'replace-all'` the backing, below).
> All are gated by the maintenance-equivalence property harness
> `test/incremental/maintenance-equivalence.spec.ts`.)
>
> **Parent-side referential enforcement.** For each backing change a maintenance pass
> *removes or re-keys*, the manager also fires the shared parent-side FK engine
> (`enforceParentSideReferentialActions` → `assertTransitiveRestrictsForParentMutation` then
> `executeForeignKeyActionsAndLens`), so an FK declared on an *ordinary* table that references
> the maintained table sees its declared RESTRICT / CASCADE / SET NULL / SET DEFAULT instead of
> being silently orphaned. The per-change order mirrors the DML executor's
> (capture → MV maintenance → FK actions) and the external-change seam: child-side derived-row
> validation first, then parent-side actions, then the MV-over-MV cascade — at both the
> bounded-delta site (`maintainRowTime`) and the full-rebuild flush (`flushDeferredRebuilds`,
> inside the statement-atomicity savepoint). A surviving RESTRICT throws (attributed to the
> maintained table) and rolls the **source** write back. See `docs/materialized-views.md`
> § Parent-side referential enforcement.
>
> **The `'residual-recompute'` arm — the synchronous analogue of the assertion
> residual path.** A single-source aggregate body (`select g1,…, agg(…) from T [where
> P] group by g1,…` over **bare** group columns) is maintained by re-running a
> *key-filtered residual* of the body, exactly the primitive the assertion consumer
> uses — only synchronously, in-transaction, rather than at COMMIT. At create the body
> is rewritten with `injectKeyFilter(body, T, groupColumns, 'gk')` (the shared
> primitive in `key-filter.ts`) and compiled once. Per source change the manager
> derives the affected group key(s) from the changed row (the `BindingMode`'s
> `{ kind: 'group'; groupColumns }`, built directly from the aggregate's bare GROUP BY
> — *not* via `extractBindings`, whose `'group'` classification additionally demands the
> group key cover a *source* unique key and so reports `'global'` for the common
> `group by <non-key>` body), runs the residual bound to the affected key against **live
> mid-transaction source state** (reads-own-writes, the same emit → `Scheduler` path the
> assertion evaluator uses), and upserts the recomputed group row — the backing key IS
> the group key, so the upsert replaces the old row wholesale (no delete-first), and a
> value-identical recompute is suppressed by the host's skip-identical upsert
> ([mv-maintenance.md § no-op suppression](mv-maintenance.md#value-identical-no-op-write-suppression)).
> A group-key-changing UPDATE recomputes both the OLD and NEW groups; an emptied group's
> residual returns zero rows, which maps to the point delete that removes its backing
> row. Per-row recompute is correct without per-statement batching — every change to a
> group recomputes it from live state, so the last write wins.
>
> **The `'join-residual'` arm — the same kernel with a `'row'`/`'pk'` binding, plus a
> reverse residual for the lookup side.** A **1:1 row-preserving inner/cross join** body
> (`select … from T join P on T.fk = P.id`, where `T` contributes *exactly one* MV row per
> governed `T` row — proven by the coverage prover's shared `proveOneToOneJoin`: no row loss
> via NOT-NULL FK→PK referential integrity, no fan-out via `isUnique(T.pk)` at the join
> frame) is maintained on the **same residual kernel** as the aggregate arm, with the binding
> set to `T`'s PK (`'row'`/`'pk'`). The 1:1 join collapses the composite product key `keysOf`
> advertises to `T`'s PK, so the backing is keyed on `T`'s PK and each changed `T` row maps to
> one backing row. A write to `T` (the **driving** side) is therefore identical to a size-1
> group: run the `T`-keyed residual (`… where T.pk = :pk0`, ≤1 joined row), upsert the
> recomputed row (or delete the key when it returns nothing) — driven by the *same*
> `applyForwardResidual` the aggregate arm uses.
>
> The join arm's distinct problem is the **lookup side (`P`)**: the MV's `sourceTables`
> includes `P`, so a write to `P` fires maintenance too, but the forward residual is keyed on
> `T`'s PK and one `P` row joins *many* `T` rows. The plan therefore carries a **second
> residual keyed on `P`'s PK** (the body with `injectKeyFilter` applied on `P` instead of
> `T`): for a `P` change it runs `… where P.pk = :pk0` against live state, returning every
> currently in-scope joined row — each carrying its `T.pk` backing key — and **upserts** each.
> For a no-`WHERE` (or `T`-only-`WHERE`) body **no delete is needed**, and that is the soundness
> crux: with an inner/cross join + enforced RI and a predicate that cannot reference `P`, the
> *set* of `T` rows joined to a given `P` row is `{ T : T.fk = P.pk }`, determined entirely by
> `T.fk` (a `T` column a `P` write cannot change). So a `P` change only re-derives the
> lookup-projected columns of existing backing rows (an upsert at the unchanged `T.pk`), never
> adds or removes one. A `T`-side membership change is the forward path's job. The plan is
> registered under **both** source bases (`rowTimeBySource[T]` *and* `rowTimeBySource[P]`), and
> `maintainRowTime` passes the changed base to `applyMaintenancePlan` so it routes to the
> forward (`T`) or reverse (`P`) path.
>
> **A partial `WHERE` is supported (`mv-join-where-widening`).** The body `WHERE` is classified
> at build by which base table(s) its columns reference. A predicate over the **driving `T`
> only** needs nothing extra: the forward residual already injects + applies it (an out-of-scope
> `T` row recomputes to zero rows ⇒ its delete-without-upsert removes the backing row), and a
> `T`-column predicate cannot move the membership set above, so the lookup side stays upsert-only.
> A predicate referencing the **lookup `P`** (or both sides) *can* flip a row's `WHERE` truth on a
> `P` write — adding or removing a backing row the upsert-only path could never delete — so the
> reverse path becomes **delete-capable**: the plan carries a third residual, the body with the
> `WHERE` **stripped** and `injectKeyFilter` on `P` (membership only). Per affected `P` key it runs
> both residuals against the same live state and applies the keyed diff: `delete` only the
> membership `T.pk` backing keys the in-scope recompute no longer produces (rows that left scope —
> the delete keys come from live `T` via the join, so they match existing backing keys and never
> touch another `P`'s rows), and `upsert` every in-scope row (`WHERE` retained; an unchanged row's
> upsert is suppressed by the host's skip-identical contract) — converging the membership both ways
> without churning the unchanged members. The membership residual **must** ignore the `WHERE`,
> else a row leaving scope would never be deleted. Outer joins are
> still declined (filtering `P` for the reverse residual would drop their null-extended rows), and a
> **fanning** (non-1:1) keyed join is declined too — the builder returns `null` and the body falls
> to the full-rebuild floor.
>
> **The `'prefix-delete'` arm — point-keyed vs prefix-keyed slice replacement.** A
> single-source lateral-TVF fan-out body (`select T.pk…, f.* from T cross join lateral
> tvf(<args over T>) f`) fans each base row out to **N** backing rows. The residual-
> recompute arm replaces a **point-keyed** slice — one group / one 1:1 row, deleted by a
> single backing key (`'delete-key'`). The lateral-TVF arm replaces a **prefix-keyed**
> slice of unknown cardinality — a base row's whole fan-out, every backing row whose
> leading PK columns equal the base PK — so it needs (1) a **by-prefix delete** primitive
> the point arm lacks and (2) an N-row residual whose rows all share the base-PK prefix but
> are distinguished by the TVF-key tail. Everything else is the residual kernel above,
> consumed unchanged: the affected-key derivation (here the base PK), the
> `injectKeyFilter(body, T, basePkColumns, 'pk')` residual pinned to the base
> `TableReferenceNode`, the per-statement batched accumulator, the cost gate, reads-own-
> writes execution. The backing PK is the **composite product key** `(T.pk ∪ tvf-key)`
> that `keysOf` advertises across the lateral join (`optimizer-keyed-cross-product-join-
> keys`), with the base PK as its leading prefix (asserted at build). Per source change
> (OLD ∪ NEW base keys, deduped): re-run the residual for the affected base PK and apply
> the keyed diff against the existing effective slice (read via the host's `scanEffective`
> with the base prefix) — delete only the existing keys the recompute no longer produces,
> upsert each fanned row (value-identical upserts suppressed by the host); the body's
> WHERE is part of the residual, so an out-of-scope base row fans out to zero rows (an
> all-deletes diff).
> (The natural next consumer is a **fanning keyed join** — a non-1:1 inner/cross join — that
> reuses this same by-prefix delete + product key, the join standing in for the TVF fan-out;
> deferred to a follow-on ticket.)
>
> **The re-added `delete-by-prefix` `MaintenanceOp`.** The row-time consolidation had
> removed an old by-prefix delete op; the prefix-delete arm re-introduces it on the shared
> substrate. `applyMaintenanceToLayer` (`vtab/memory/layer/manager.ts`) gains a
> `'delete-by-prefix'` arm: it range-scans the backing primary btree over the half-open
> interval whose leading columns equal `keyPrefix` (the btree is ordered by the composite
> PK, base-PK columns leading, so the slice is contiguous and the scan seeks to it and
> early-terminates on a prefix mismatch), then `recordDelete`s each matched row with the
> **same** per-row bookkeeping (secondary indexes, change tracking) the point `delete-key`
> arm uses. The op is therefore the prefix-keyed analogue of `delete-key` — one base row's
> fan-out replaced as a unit. (Since `mv-noop-upsert-suppression` converted the
> prefix-delete arm to a keyed diff over the same prefix range, the engine no longer
> *produces* this op; it remains part of the host contract — implemented by both hosts and
> pinned by `test/vtab/maintenance-prefix-delete.spec.ts` — available to future consumers
> such as the fanning-keyed-join arm.)
>
> **The `replace-all` `MaintenanceOp` — the whole-table primitive for the full-rebuild arm.**
> Where `delete-key` replaces a point-keyed slice and `delete-by-prefix` a prefix-keyed slice,
> `replace-all` replaces the backing's **entire** pending-effective contents with a supplied
> `rows: Row[]`. It is the transactional backing replacement the always-correct
> **full-rebuild** maintenance arm consumes: a body for which no incremental arm is sound is
> maintained by recomputing it wholesale per writing statement. That replacement must commit/roll-back in lockstep with the source write, so it
> targets the backing's **pending** `TransactionLayer` — it cannot use the CREATE/REFRESH
> `replaceBaseLayer` primitive, which swaps the committed *base* layer and would not roll back
> on an aborted statement. `applyMaintenanceToLayer` (`vtab/memory/layer/manager.ts`) realizes
> it as a **keyed diff by backing PK** against the layer's current rows: it snapshots the old
> rows (the same whole-table effective scan, unscoped) into a PK-keyed btree, then for each new
> row emits `insert` (key absent), `update` (key present, row differs), or **nothing** when the
> row is unchanged — skipping an identical row so a no-op rebuild produces no btree churn and no
> downstream cascade work — and emits `delete` for every old key absent from the new set. The
> diff drives `recordUpsert`/`recordDelete` (so secondary-index + change-tracking bookkeeping
> stay correct, exactly as the point ops do), and the returned `BackingRowChange[]` is the
> realized minimal delta the MV-over-MV cascade consumes unchanged. Collation governs **key
> pairing** only: key matching uses the backing PK comparator (honoring PK-column collation),
> so a new row whose key only differs by collation (`'apple'` vs a stored `'APPLE'` under a
> NOCASE PK) pairs with its old row and resolves to an `update` rather than a spurious insert +
> delete that would leak index bookkeeping. The skip-identical **value** comparison is instead
> byte-faithful (`rowsValueIdentical`, BINARY per column — numeric-storage-class tolerant but
> byte-exact for text), the SAME discipline as the point-op upsert skip: a paired row is skipped
> only when byte-identical, so a collation-equal / byte-different paired row (a case-only PK
> rewrite under NOCASE) is an `update` that re-keys the stored bytes. There is
> no row cap — the floor's unbounded cost is by design, bounded instead by the upstream
> cost-gate / size-threshold reject. Covered by `test/vtab/maintenance-replace-all.spec.ts`.
>
> **The `'full-rebuild'` arm — the always-correct floor.** A body that matches no bounded-delta
> shape is maintained by re-evaluating it in full. `buildFullRebuildPlan` is the fall-through
> builder: it derives the backing key from the body's **provable unique key** (`keysOf` over the
> optimized body root — a `union`, a multi-way 1:1 join, a `distinct`, … all carry one) and
> **rejects a bag** (no provable key — a key-dropping projection, a `union all` of overlapping
> inputs) with the relational *no-provable-unique-key / must-be-a-set* diagnostic; an all-columns
> pseudo-key counts only when the body is provably a set (`keysOf` gates it on `isSet`), so a bag
> still rejects rather than colliding duplicates on insert. (The bag reject is only as sound as the
> optimizer's `isSet` inference: a **fanning** (non-1:1) inner/cross join must not be over-claimed a
> set, or the floor would accept it and silently collapse the duplicates its all-columns backing key
> cannot hold. `join-fanning-isset-overclaim` closed that — `buildJoinRelationType` (`join-utils.ts`)
> no longer derives an inner/cross join's `isSet` from `leftType.isSet && rightType.isSet` without
> proving row-preservation, so a fanning join now correctly carries no provable key and routes to
> this very bag reject, pinned as a reject in `materialized-view-diagnostics.spec.ts`.) It runs a
> **whole-body determinism**
> check (hard-reject unless `pragma nondeterministic_schema`, mirroring the per-arm rejects), and
> collects **every** source the body reads into `sourceBases` so `planSourceBases` indexes the plan
> under each — a write to *any* of them dirties the MV. The optimized body (read-side MV rewrite
> suppressed) is compiled once into `bodyScheduler`. Per source change, `applyFullRebuild` runs that
> scheduler to completion against **live mid-transaction source state** (reads-own-writes, the same
> fresh-context `runScheduler` path the residual arms use, but with no params — it runs the whole
> body, not a key-filtered slice), collects the rows, and applies a single `'replace-all'`
> {@link MaintenanceOp}; the effective `BackingRowChange[]` drives the MV-over-MV cascade unchanged.
> **Eligibility is cost-gated with a floor, never a shape allowlist.** `buildMaintenancePlan` tries
> a bounded-delta arm (`tryBuildBoundedDeltaArm`); a body whose shape fits **none** falls through to
> `buildFullRebuildPlan`. Each arm builder likewise returns `null` (not a reject) on a sub-shape
> mismatch and falls through. **No body is rejected for its shape** — the only four create-time
> rejections are all *non-shape*: a **non-deterministic** body (hard-rejected in the matched arm so
> its arm-specific diagnostic survives, or in the floor's whole-body determinism check), a **bag**
> (no provable unique key — the floor's `keysOf` reject), a body with **no relational output**, and
> the **size** reject below. The bounded-delta arms stay preferred by the argmin cost gate
> (`selectMaintenanceStrategy`); full-rebuild is chosen exactly when no bounded-delta arm is sound
> (an empty sound set resolves to the floor), so an existing eligible shape is unaffected.
>
> **The size reject — the one create-time gate the floor adds.** When full-rebuild is a body's
> *only* sound strategy, every source write re-scans the whole body, so a large source makes each
> write pathological. `buildFullRebuildPlan` reads the live row count of **every** participating
> source from the `StatsProvider` and gates on the **largest** (a tiny driving table joined to a
> huge lookup gates on the lookup), rejecting when it exceeds the configurable
> `materialized_view_rebuild_row_threshold` option (default `MAINTENANCE_REBUILD_ROW_THRESHOLD` =
> 10 000; reachable via `pragma materialized_view_rebuild_row_threshold = N`). The threshold is
> threaded into `isFullRebuildPathological(stats, threshold)` (`planner/cost/index.ts`); a value of
> `0` **disables** the reject (accept any size). The diagnostic names the offending source, its
> estimated row count, the threshold, and how to raise/disable it.
>
> The arm is exercised in `maintenance-equivalence.spec.ts` § full-rebuild floor (isolation +
> deferral) and end-to-end through `buildMaintenancePlan`'s routing in
> `materialized-view-diagnostics.spec.ts` (the four non-shape rejects, the size reject + pragma
> disable, largest-source gating) and `53-materialized-views-rowtime.sqllogic` § 7 (the flipped
> shape acceptances).
>
> **The end-of-statement flush — full-rebuild is the one deferred arm.** Re-evaluating the whole
> body per source row would be O(rows × body), so the full-rebuild arm is **deferred to a single
> per-statement flush** rather than run per row. `maintainRowTime` takes an optional per-statement
> `deferred: Set<string>` (MV keys): a `'full-rebuild'` plan is **marked dirty** there (no per-row
> apply) instead of rebuilt, while the bounded-delta arms stay **per-row-immediate** (cheap, and the
> covering-UNIQUE enforcement scan depends on their per-row backing visibility — a full-rebuild MV is
> never used as a covering structure, so deferring it cannot starve that scan). That invariant is
> enforced at the lookup: `findRowTimeCoveringStructure` skips any plan whose `chosenStrategy` is
> `'full-rebuild'`, so a join/`distinct`/… body that the coverage prover admits (now SQL-reachable
> after the eligibility flip) and which falls to the floor still does **not** answer enforcement —
> the auto-index does. (The eager `coveringStructureName` link the prover stamps is informational
> only; the strategy skip is the authoritative gate.) The DML executor
> (`runtime/emit/dml-executor.ts`) owns one `deferred` set per statement alongside the
> `BackingConnectionCache`, threads it through every `maintainRowTimeStructures` call, and drains it
> via `Database._flushDeferredRebuilds` → `MaterializedViewManager.flushDeferredRebuilds` at the
> **end-of-statement savepoint boundary** — after the row loop (so each rebuild reads *all* the
> statement's source writes, reads-own-writes) and before the statement-atomicity savepoint releases
> (so a failed rebuild rolls the whole statement back, and an `ABORT`-class statement that only
> *dirtied* an MV before aborting unwinds with the whole statement — its dirtied MVs revert, no flush
> needed). A bare autocommit write flushes and commits the rebuild in lockstep with the source write.
> **`OR FAIL` is the exception:** it runs with *no* statement-scope savepoint (prior rows survive), so
> the generator also drains the deferred set on the FAIL throw path — before re-raising the conflict
> error — so the floor backing reflects the surviving rows instead of lagging them (the failing row's
> own per-row savepoint already reverted its writes, so the rebuild re-evaluates over just the
> survivors). Without this, a `read(MV)` after an `OR FAIL` abort would diverge from the live body. The flush is a **worklist drain** over the
> producer→consumer DAG: each rebuild calls `applyFullRebuild` and routes the realized
> `BackingRowChange[]` back through `maintainRowTime` with the *same* `deferred` set — an incremental
> consumer applies inline, a full-rebuild consumer re-dirties into the drain. It proceeds in **rounds**
> (snapshot the dirty set, clear it, rebuild each member, collect re-dirties for the next round), so a
> consumer is never left stale by a producer rebuilt in the same round; convergence takes at most one
> round per level of the full-rebuild sub-DAG. The DAG is acyclic (a consumer MV requires its producer
> to pre-exist), so the round count is bounded by the registered-row-time-MV count — exceeding it is a
> structurally-impossible cycle and fails loud (`assertFlushRounds`, the worklist analogue of the
> cascade's `assertCascadeDepth`). Cold callers (enforcement/eviction) pass no `deferred` set; a
> full-rebuild plan they reach (they never do — not a covering structure) falls through to a safe inline
> rebuild. Deferral is exercised in `maintenance-equivalence.spec.ts` § full-rebuild floor, per-statement
> flush (one rebuild per bulk statement via an instrumented rebuild counter, atomic rollback, autocommit,
> mixed-arm, and MV-over-MV mixed-arm). Since the eligibility flip made the floor SQL-reachable, the
> *comprehensive coverage net* (`mv-comprehensive-coverage-net`) adds, over real `create materialized
> view` bodies: the formerly-rejected floor shapes (DISTINCT / set-op / recursive CTE / outer / >2-source
> join / scalar aggregate) under random mutation + rollback; the full-rebuild→full-rebuild chain and
> diamond that drive the worklist **past round 1** (the multi-round convergence + `assertFlushRounds`
> bound, unverifiable while single-round drains were all that was buildable); and the `OR FAIL`
> abort-path flush above. The fanning (non-1:1) join is pinned as a *bag reject*, not an equivalence
> case (`materialized-view-diagnostics.spec.ts`).
>
> **Non-binary base-PK collation soundness.** `delete-by-prefix` early-terminates its prefix
> scan on a **binary** value compare (`scan-layer.ts` / `plan-filter.ts`), but the backing
> btree orders the base-PK prefix by the column's **declared collation**. These agree for the
> default `BINARY` collation; for a non-binary base PK (e.g. `text collate nocase`) they only
> agree because of two facts: (1) the backing base-PK column **inherits** the source PK
> column's collation (`deriveBackingShape` carries the body relation's `collationName`
> through), so the btree orders the prefix exactly as the value the delete is built from; and
> (2) source-PK **uniqueness** under that collation collapses each collation class to a single
> binary value, so all of a base row's fan-out rows carry a byte-identical leading value and
> form one contiguous, binary-homogeneous slice — no collation-equal/binary-different base
> rows can interleave. (This is why the arm does **not** gate off non-binary collation the way
> `lookupCoveringConflicts`/`tryBuildCoveringPrefix` does: that fast path keys off a UNIQUE
> constraint, which *can* hold collation-equal/binary-different rows, whereas the base PK
> cannot.) `applyPrefixDelete` always builds the delete prefix from the changed row's exact
> stored value (`row[sc]`), never a case-folded variant, so it stays within the safe case;
> `buildLateralTvfPrefixDeletePlan` asserts fact (1) at plan-build (backing base-PK collation
> == source PK collation) so a future derivation regression fails loud rather than silently
> under-/over-deleting. Locked in by `prefix-delete-noncase-collation-regression-test`
> (layer-level unit cases + a NOCASE-base-PK equivalence suite + `53-…-rowtime.sqllogic`
> §23.5).

> **External writes.** The DML executor is not the only driver of this pipeline: a host that
> applies row changes directly to module storage (bypassing the executor entirely) reports them
> through `Database.ingestExternalRowChanges`, whose batch replays the same facets — change
> capture, batch-amortized row-time maintenance (one `BackingConnectionCache` + one deferred
> full-rebuild set + one flush per batch), and opt-in FK actions — inside the coordinated
> transaction. See [External row-change ingestion](mv-ingestion.md#external-row-change-ingestion).

## Pipeline at a glance

```
DML emitter ──recordInsert/Update/Delete(row, pkIndices)──► TransactionManager
                                                              │
                                                  per-base capture demand
                                                  registered by consumers
                                                              ▼
                                                       ChangeCapture
                                                  (PK + projected cols,
                                                   savepoint-layered)
                                                              │
                                          at top-level COMMIT (phase per consumer:
                                           assertions pre-commit, watch post-commit)
                                                              ▼
                                                       DeltaExecutor
                                                              │
                                        ┌─────────────────────┴─────────────────────┐
                                        ▼                                           ▼
                              AssertionEvaluator                          Database.watch
                              (residual scheduler per                     (post-commit
                               tuple, pre-commit,                          reactive signals)
                               early-exit on violation)
```

The kernel is decoupled from any specific consumer. A `DeltaSubscription` carries:

- `dependencies` — the set of base tables the subscription cares about.
- `bindings` — a `BindingMode` per `TableReferenceNode` instance (from
  `extractBindings`, or built directly by the consumer).
- `apply(input)` — invoked at COMMIT with per-relation binding-tuple batches and a
  set of relations flagged for global re-evaluation.

## Lifecycle

### Registering capture demand

A consumer that needs non-PK column values calls
`Database.registerCaptureSpec(baseTable, { extraColumns })` (typically at
plan-compile / DDL time). PK columns are always retained; `extraColumns` is the
union of non-PK columns any active spec needs. The returned dispose handle removes
that spec from the union; capture demand for a table is fully released once all
specs are disposed.

A `'row'` binding whose chosen key is the table's primary key needs no extra
capture — PK is always present. A `'row'` binding picked from a covered non-PK
unique key (and any `'group'` binding) registers the non-PK columns it cares about
so the values needed to bind at COMMIT are preserved. The shared merge state
machine in `TransactionManager` keeps the earliest `oldProjection` for the row
across both intra-layer activity and savepoint RELEASE — per-group dispatch always
sees a row's pre-transaction state, even after a chain of updates inside savepoints.

### Recording changes

The DML emitter passes the full pre- and post-image rows plus PK indices to
`TransactionManager.recordInsert/Update/Delete`. The manager:

- Always retains the PK projection.
- Retains the registered `extraColumns` projection if any consumer has demand on
  that table.
- For UPDATEs, retains both OLD and NEW projections when any captured column changed
  value — making group-membership transitions visible to per-group dispatch.

The change log is layered for savepoints: SAVEPOINT pushes a new layer, ROLLBACK TO
discards the top layer, RELEASE merges with last-write-wins (delete-after-insert
collapses to no entry, insert-then-update keeps INSERT semantics with the refreshed
projection, etc.). So changes rolled back via a savepoint are never visible to
COMMIT-time evaluation.

**Realized maintenance writes are recorded too.** User DML is not the only writer:
row-time materialized-view maintenance writes a backing table through the privileged
`BackingHost` surface, which bypasses the change log. `MaterializedViewManager.postApplyBackingChanges`
therefore records each realized `BackingRowChange` through the same
`recordInsert/Update/Delete` surface (`recordMaintenanceChanges`), keyed on the
maintained table's own **logical** `primaryKeyDefinition` — not the physical backing key,
which can differ under a collation-coarsened key.

This is what makes a maintained table a first-class *changed base*. Two consumers depend
on it:

- **Assertions.** A maintained table is a table, so `create assertion … check (… from mv …)`
  compiles to a plan reading `main.mv`. `DeltaExecutor` dispatches an assertion only when
  its plan's base tables overlap `getChangedBaseTables()`; without the recording the
  changed set after a source write names only the source, and the assertion silently never
  runs.
- **Watchers over MV-over-MV chains.** `analyzeChangeScope` projects an MV reference to its
  *direct* sources only, so a watch on `mv2` (over `mv1` over `w`) lands on `main.mv1`.

Recording is bounded by the realized per-statement delta, exactly like user DML: the bulk
fills (`materializeView` create-fill, `rebuildBacking` refresh) call the host directly and
never route through `postApplyBackingChanges`, and a value-identical upsert reports no
`BackingRowChange` at all. Savepoints need no special handling — the records land in the
current layer and are discarded by `ROLLBACK TO` along with the backing write they describe.

`attachMaintainedDerivation` (`alter table … set maintained as …`) is the one DDL-scale
exception: it writes the attached table directly, but deliberately cascades its whole-set
reconcile delta to consumer maintained tables, so a consumer records one entry per
reconciled row in that single statement. Intended — the consumer's content really did
change — but O(consumer rows) in one transaction.

One gap this does **not** close: `REFRESH MATERIALIZED VIEW` swaps committed contents via
`replaceContents` (or a direct `applyMaintenance('replace-all')` on the constraint-bearing
branch) without routing through `postApplyBackingChanges`, so a refresh that re-derives
violating content does not trip an assertion at that commit.

### Reading changes at COMMIT

`DeltaExecutor` iterates registered subscriptions, computes the per-relation binding
tuples via `getChangedTuples(base, columnIndices, pkIndices)`, and calls each
subscription's `apply`. **Cost fallback (detection kernel only):** if the number of
distinct binding tuples exceeds `tuning.deltaPerRowFallbackRatio × rowCount(base)`
(the catalog row count from the last `ANALYZE`; a never-analyzed table has no count and
is never demoted), the kernel demotes that relation to global re-evaluation (always
correct — it just recomputes more than the minimum). This ratio governs the
**detection kernel** (assertions and watchers) only; row-time materialized-view
maintenance instead uses the backward `maintenanceCost(...)` surface
(`planner/cost/index.ts`): the arm builders stamp the compiled key-filtered residual's
own plan cost (`MaintenanceSourceStats.residualExecutionCost`) so the per-statement
residual↔rebuild crossover is judged against what a residual run actually does (a
seek when the binding key is indexed, a whole-source scan otherwise), with this ratio
kept only as the stats-absent fallback multiplier. Statements touching fewer than
three distinct keys never demote — a `'replace-all'` rebuild rewrites the whole
backing, write amplification the cost formulas do not carry.

The kernel runs only at top-level COMMIT — savepoints are seen indirectly via the
merged change log. How an `apply` exception is handled is the **consumer's** choice,
not the kernel's: the kernel surfaces it unchanged. The assertion consumer registers
on the pre-commit path, so a thrown violation propagates and rolls the COMMIT back;
the `Database.watch` consumer runs *after* commit and swallows handler errors
(logged, never fatal) — the transaction has already durably committed by then.

## BindingMode

`extractBindings(plan)` walks a plan and emits a `PlanBindings` describing, per
`TableReferenceNode` instance, how the plan binds to changes on its underlying base
table (full analysis in
[Optimizer Assertion Analysis § Binding-aware Delta Planning](optimizer-assertions.md#binding-aware-delta-planning-reusable)):

```ts
type BindingMode =
  | { kind: 'global' }
  | { kind: 'row'; keyColumns: number[] }      // output-column indices
  | { kind: 'group'; groupColumns: number[] }; // output-column indices
```

- `'row'` picks the table's primary key when it's among the covered keys, else the
  lex-min covered key (by length then joined indices). Candidate keys come from the
  unified `keysOf` surface (`planner/util/fd-utils.ts`) — declared
  `RelationType.keys`, FD-derived keys, the `∅ → all_cols` ≤1-row empty key `[]`,
  and the all-columns set key.
  - An **empty `keyColumns`** (`{ kind: 'row'; keyColumns: [] }`) means "≤1 row, no
    key filter needed". Downstream consumers treat it as a sound full/global scan:
    the delta executor re-evaluates that relation globally, `change-scope` reports a
    `full` watch scope, and the assertion residual leaves the `TableReferenceNode`
    unwrapped. All three are equivalent for a ≤1-row table.
- `'group'` reads the minimal `GROUP BY` column subset from
  `analyzeRowSpecific.groupKeys`. It already lives in the table reference's
  output-column space.
- `'global'` means the kernel has no safe binding to parameterize on; the consumer
  evaluates its full plan once when any dependency changes.

## First consumer: AssertionEvaluator

On first reference to an assertion at COMMIT time:

1. Parse and optimize the violation SQL for analysis (pre-physical).
2. Run `extractBindings` to get `PlanBindings`.
3. Register projection capture for the union of group-key columns per base table
   (`'row'` bindings need no extra capture).
4. For each `'row'`/`'group'` binding, inject a key-equality filter on the
   `TableReferenceNode` (`injectKeyFilter`) and pre-compile the residual scheduler.
   Parameter prefix is `pk` for row bindings, `gk` for group. Per-column NULL safety:
   each nullable key column emits the NULL-safe form
   (`(col IS NULL AND :prefix_i IS NULL) OR col = :prefix_i`) so a changed
   NULL-keyed tuple is re-evaluated rather than silently skipped; NOT NULL columns
   keep the plain `col = :prefix_i` form to avoid disjunctive predicates on the hot
   path.
5. Register a `DeltaSubscription` whose `apply`:
   - For each per-relation tuple batch, runs the cached residual scheduler once per
     tuple (early-exiting on the first violating row).
   - For any `globalRelations` entry, runs the full violation SQL once.

`DROP ASSERTION` or schema changes invalidate the cached entry — dispatch handle,
capture demand, and residual schedulers.

## Second consumer: Database.watch

`Database.watch(scope, handler)` registers a post-commit reactive callback against a
public, JSON-serializable `ChangeScope` (see
[Change-scope Documentation](change-scope.md)). The watcher manager
(`src/core/database-watchers.ts`) owns its own `DeltaExecutor` and is the reference
example of the plug-in pattern below:

- `subscriptionFromChangeScope` (in `delta-executor.ts`) translates the public
  `ChangeScope` into a `DeltaSubscription`, mapping each watch to a `BindingMode`
  (`full` → `global`, `rows`/`rowsByGroup` → `row`/`group` with literal-value
  narrowing, `groups` → `group`) and registering capture demand for any non-PK
  key/group columns.
- The manager runs its executor **after** commit, so a throwing handler is logged
  and dropped rather than rolling anything back.
- Schema changes (`table_removed` / `table_modified`) invalidate affected
  subscriptions; `unsubscribe()` releases the kernel registration and all
  capture-spec demand.

Watchers prove the kernel is genuinely consumer-neutral: same binding extraction,
same capture demand, same cost fallback — only the commit-phase placement and error
policy differ from assertions.

## Plug-in pattern for future consumers

A new consumer follows the same shape — `Database.watch` is the live template, and
it surfaces its registration path on `Database`:

```ts
// 1. Analyze the consumer's plan.
const bindings = extractBindings(plan);

// 2. Register projection capture demand for non-PK columns.
const disposers: Array<() => void> = [];
for (const [relKey, mode] of bindings.perRelation) {
  if (mode.kind === 'group') {
    const base = bindings.relationToBase.get(relKey)!;
    disposers.push(db.registerCaptureSpec(base, {
      extraColumns: new Set(mode.groupColumns),
    }));
  }
}

// 3. Build a residual scheduler per binding via injectKeyFilter.

// 4. Register a DeltaSubscription with the kernel.
const dispose = deltaExecutor.register({
  id: 'signal:my_signal',
  dependencies: /* set of base tables in plan */,
  bindings: bindings.perRelation,
  relationToBase: bindings.relationToBase,
  pkIndicesByBase: /* PK indices per base table */,
  async apply(input) {
    // Per-relation: bind tuples, run the residual, act on results.
    for (const [relKey, tuples] of input.perRelationTuples) { /* ... */ }
    // Global: re-run the full plan once.
    if (input.globalRelations.size > 0) { /* ... */ }
  },
  dispose() { for (const d of disposers) d(); },
});
```

### Design decisions worth knowing

- **Projection capture, not full-row capture.** Workloads without any active
  consumer pay only PK capture. Adding a consumer mid-transaction can't see
  retroactive projections — mid-transaction subscription registration is forbidden
  (today's consumers register at plan-compile / DDL time, not at run time).
- **Per-subscription residual cache.** Plan-shape generation is consumer-specific
  (violation-query SQL vs. a watch residual). A shared cache would have to negotiate
  eviction.
- **Cost fallback by ratio (detection kernel).** The threshold (`0.5`) is a first cut
  for the assertion/watcher kernel. The materialized-view maintenance "real cost
  comparator" has since landed (`incremental-maintenance-cost-gate`): the backward
  `maintenanceCost(...)` surface (`planner/cost/index.ts`) chooses among structurally
  sound strategies and reuses this ratio only as the stats-absent fallback. The kernel
  keeping the ratio is deliberate — a full cost comparator there is still a follow-up.

## Cross-references

- Analysis surface ("what to bind"): [Optimizer Assertion Analysis § Binding-aware Delta Planning](optimizer-assertions.md#binding-aware-delta-planning-reusable)
- Public reactive API / `ChangeScope`: [Change-scope Documentation](change-scope.md)
- Synchronous (off-kernel) materialization: [Materialized Views](materialized-views.md)
- Externally-applied writes → this pipeline: [External row-change ingestion](mv-ingestion.md#external-row-change-ingestion)
- Layered schemas / lenses: [Lenses and Layered Schemas](lens.md)
- Source: `src/planner/analysis/binding-extractor.ts`,
  `src/planner/analysis/relation-key.ts` (the one owner of the `relationKey` label
  every map in this pipeline is keyed by), `src/planner/analysis/key-filter.ts`,
  `src/runtime/delta-executor.ts`,
  `src/core/database-transaction.ts`, `src/core/database-assertions.ts`,
  `src/core/database-watchers.ts`
- Cross-process reactive transport: out of scope here; see the sync packages under
  `packages/quereus-sync-*`.
