---
description: A query can name a block that inserts, updates or deletes rows; previously, if the rest of the query never mentioned that block, the write was silently skipped. The write now always happens, matching SQLite and PostgreSQL.
files:
  - packages/quereus/src/planner/planning-context.ts        # cteDescriptors memo (now a REQUIRED field)
  - packages/quereus/src/core/database.ts                   # _buildProbeContext seeds the memo
  - packages/quereus/src/core/derived-row-validator.ts      # context factory seeds the memo (review)
  - packages/quereus/src/schema/manager.ts                  # DDL-validation context seeds the memo (review)
  - packages/quereus/src/planner/building/with.ts           # buildCommonTableExpr reads/fills memo; isDataModifyingCte exported
  - packages/quereus/src/planner/building/block.ts          # buildStatement split + attachUnreferencedDmlCtes (the one attach site)
  - packages/quereus/src/planner/nodes/sequence-node.ts     # SequenceNode (effects prelude + main)
  - packages/quereus/src/runtime/emit/sequence.ts           # sequential effects-then-main emitter
  - packages/quereus/src/runtime/emit/block.ts              # block result selection recurses into a Sequence's main
  - packages/quereus/src/planner/analysis/change-scope.ts   # isDmlWithoutReturning classifies by the Sequence's main child
  - packages/quereus/test/logic/13.11-unreferenced-dml-cte.sqllogic  # full unreferenced-arm coverage (renamed from a colliding 13.7)
  - packages/quereus/test/logic/13.6-cte-dml-runs-once.sqllogic      # zero-reference guard flipped to expect the write
  - packages/quereus/test/plan/cte-dml-plan-shape.spec.ts   # descriptor-sharing + Sequence-shape invariants
  - docs/runtime-caching.md                                 # § Shared CTE materialization
  - docs/change-scope.md                                    # § Known imprecisions — sunk-effect watch widening
---

# Complete: an unreferenced data-modifying `with` block now runs

## What shipped

`with c as (insert into t (k) values (1) returning k) select 42 as x` now performs the
insert (previously the planner dropped the member because nothing read it). Covers all
three writing forms and every outer statement kind, including view-targeted writes.

Two mechanisms, both from the implement stage and both verified in review:

- **One runtime identity per source `with` member.** `PlanningContext.cteDescriptors`
  memoizes the `TableDescriptor` handed to each `CTENode`, keyed on the member's AST
  object. However many times the builders re-plan one member within a statement (view
  write-through, multi-source decomposition, the sink rebuild), every copy shares one
  descriptor and therefore one `emitCTE` per-execution buffer — one write per execution
  by construction.
- **Unreferenced members sunk ahead of the statement.** `buildBlock` collects the
  descriptors reachable from the built plan, rebuilds the clause for any data-modifying
  member whose descriptor is absent, wraps each in a `SinkNode`, and sequences them
  before the statement under the new `SequenceNode` (emitted by `runtime/emit/sequence.ts`,
  which drives each effect to completion in order and then delegates to the main child).
  Effects-first, so a main abandoned early (`limit 0`) cannot skip a write.

## Review findings

**Read first:** the implement diff (`9da96df8`, all 16 files) before the handoff summary,
then the surrounding consumers of statement-level plan shape and the runtime behaviour
under 13 hand-run probe queries against the built package.

### Fixed in this pass (minor)

- **Test file name collision.** The new sqllogic file was added as
  `13.7-unreferenced-dml-cte.sqllogic` while `13.7-cte-sibling-visibility.sqllogic`
  already existed — two files sharing one sequence number. Renamed to
  `13.11-unreferenced-dml-cte.sqllogic` (13.10 was the highest in use) and updated the
  four references to it (13.6's comment, the plan spec's doc block, `docs/runtime-caching.md`,
  and the file's own header).
- **`cteDescriptors` was optional, so a context could silently lose the invariant.**
  Every read used `ctx.cteDescriptors?.`, and two of the three context factories in `src/`
  (`derived-row-validator.ts`, `schema/manager.ts`) never supplied the map. A context
  without it mints a fresh descriptor per build — which both doubles a re-planned member's
  write and blinds the unreferenced-member scan, with no error. Since the write-once
  guarantee is a correctness invariant rather than scope plumbing (unlike the optional
  `cteNodes` / `cteReferenceCache` siblings), the field is now **required**: the two `src/`
  factories and the ten hand-built test contexts each seed a fresh map, and the four
  optional-chaining reads are gone. The bad state is now unrepresentable instead of
  silently tolerated.
- **`buildStatement` kept the old body indentation.** Splitting it out of `buildBlock`'s
  map callback left its 87-line `switch` one tab too deep. Re-indented.
- **Two `as unknown as` casts.** `block.ts` cast the rebuilt member straight to
  `RelationalPlanNode`; it now narrows with `isRelationalNode` and falls into the existing
  internal-error path otherwise. `change-scope.ts` reached `.main` through
  `as unknown as { main: PlanNode }`; it now uses `instanceof SequenceNode`.

### Test gaps closed (minor)

The implementer's 13.11 covered the shape matrix well; these paths had no coverage. All
six added there, and the file's assertions were negative-checked (mutating one expectation
does fail the run, so the new blocks genuinely execute):

- **Compound (`union all`) main statement** — the attach site reads the clause off the top
  statement node; a compound main must not hide it on an arm. Verified it writes.
- **Bind parameter inside the sunk member's body** — the member is rebuilt *after* the
  statement is planned, so the rebuild must reach the same parameter. `-- params: [7]`
  lands 7.
- **A failing sunk write surfaces its error** rather than being swallowed by the sink.
- **A failing main statement rolls the prelude write back with it** — the prelude is part
  of the statement, and one statement savepoint covers both. This was the shape the
  implement notes flagged as savepoint-sensitive; now pinned.
- **`WITH SCHEMA` on the statement steers the sunk member's write**, plus a control
  showing the session `schema_path` takes it when the statement declares none. This was
  the implement stage's explicitly-untested gap: the rebuild context mirrors
  `stmt.schemaPath`, and the pair of tests now distinguishes the two paths.

### Major — filed as a ticket

- **A data-modifying `with` member outside a top-level statement is still silently
  dropped.** Verified: inside a FROM sub-query, inside a scalar sub-query, and stored in a
  view body (accepted by `create view`, dead forever), the write never runs and nothing is
  reported. The implement ticket scoped nested clauses out, which was right for its
  obligation, but "accepted and silently skipped" is the same failure mode this ticket
  just fixed one level up. Filed as `tickets/backlog/bug-nested-dml-cte-silently-dropped.md`
  (severity wrong-result, likelihood unusual, repro verified). Per the architecture-first
  ladder it is filed at the seam, not per-position: nothing records *where* a member is
  being built, so `buildCommonTableExpr` cannot distinguish a top-level clause from a
  nested one — making position part of the build and rejecting there covers all three
  shapes and any future nesting position at once. No open ticket claimed those files.
  (`values` as a main statement is the one position already handled loudly — the parser
  rejects it — which is the model the ticket recommends.)

### Tripwires (recorded, not ticketed)

- **Change-scope over-reports watches for a Sequence-wrapped plan.** The table walk
  descends the whole node, so a sunk effect's tables join a SELECT's `watches`. Sound
  (over-reporting only costs a wakeup) and the file's stated contract allows it; only the
  DML-without-`RETURNING` classification was scoped to the main child. Parked as a bullet
  with a `NOTE:` in `docs/change-scope.md` § Known imprecisions — it is architectural, with
  no single code site to hang it on.
- **Descriptor sharing can drop a read-only member's evaluation count from N to 1** when
  the materialization advisory buffers it (two builds now feed one buffer). Row-identical
  for a deterministic body. `NOTE:` at the memo site in `building/with.ts`, with the
  condition that would force the memo to become `isDataModifyingCte`-conditional.

### Checked and clean

- **Every other consumer of statement-level plan shape.** `Statement.isQuery()` /
  `getColumnDefs()` read the last statement's `getType()`, which the Sequence delegates to
  its main child; `Database._isConcurrentReadEligible` rejects the node through the normal
  side-effect gate (`physical.readonly` is false); `emitBlock`'s result selection recurses
  into the main. `Sink` and `ViewMutation` are special-cased in exactly one place each
  (`emitBlock`), and that place was updated — no other site needed teaching.
- **Statement atomicity and rollback.** Probed and now pinned: a prelude write rolls back
  with a failing main statement and with an explicit `rollback`.
- **Referenced members whose rows are never pulled still write** (`limit 0` over the CTE,
  `where 1=0`) — probed, so the fix did not create an inconsistency where the unreferenced
  path is more reliable than the referenced one.
- **Multi-statement batches.** Each statement's members are keyed by their own AST
  objects; both writes land.
- **Docs.** `docs/runtime-caching.md` § Shared CTE materialization was read end-to-end and
  matches the shipped behaviour (including the accepted PostgreSQL visibility divergence,
  and the correlated-subquery gap correctly left listed as open). `docs/change-scope.md`
  was stale — it described neither the Sequence classification nor the watch widening;
  fixed above. `docs/architecture.md`'s node inventory lists notable *physical* nodes only,
  so `SequenceNode` does not belong there.

### Not re-filed

- `emitBlock` still starts sibling statements in a batch concurrently. Pre-existing,
  untouched by this change, and a Sequence orders only within its own statement — out of
  scope here rather than a finding against this work.

## Validation

- `yarn build` green; `yarn lint` clean (all workspaces, including the quereus test-file
  `tsc` pass that type-checks the ten edited spec contexts).
- `yarn test` (all workspaces) green after the review edits — 13 packages, no failures;
  quereus 9220 passing / 0 failing / 25 pending (pre-existing skips).
- `13.11-unreferenced-dml-cte.sqllogic` re-run in isolation after each edit, plus a
  deliberate expectation mutation to prove the new assertions bite.
