---
description: A query can name a block that inserts, updates or deletes rows; previously, if the rest of the query never mentioned that block, the write was silently skipped. The write now always happens, matching SQLite and PostgreSQL.
files:
  - packages/quereus/src/planner/planning-context.ts        # cteDescriptors memo (per-statement CTE runtime identity)
  - packages/quereus/src/core/database.ts                   # _buildProbeContext seeds the memo
  - packages/quereus/src/planner/building/with.ts            # buildCommonTableExpr reads/fills memo; isDataModifyingCte exported
  - packages/quereus/src/planner/building/block.ts           # buildStatement split + attachUnreferencedDmlCtes (the one attach site)
  - packages/quereus/src/planner/nodes/plan-node-type.ts     # PlanNodeType.Sequence
  - packages/quereus/src/planner/nodes/sequence-node.ts      # NEW: SequenceNode (effects prelude + main)
  - packages/quereus/src/runtime/emit/sequence.ts            # NEW: sequential effects-then-main emitter
  - packages/quereus/src/runtime/register.ts                 # emitter registration
  - packages/quereus/src/runtime/emit/block.ts               # block result selection recurses into a Sequence's main
  - packages/quereus/src/planner/analysis/change-scope.ts    # isDmlWithoutReturning classifies by the Sequence's main child
  - packages/quereus/test/logic/13.6-cte-dml-runs-once.sqllogic   # zero-reference guard flipped to expect the write
  - packages/quereus/test/logic/13.7-unreferenced-dml-cte.sqllogic # NEW: full unreferenced-arm coverage
  - packages/quereus/test/plan/cte-dml-plan-shape.spec.ts    # descriptor-sharing + Sequence-shape invariants, prepared 3× behavioral test
  - docs/runtime-caching.md                                  # § Shared CTE materialization updated
repro: verified
---

# Review: an unreferenced data-modifying `with` block now runs

## What was built

`with c as (insert into t (k) values (1) returning k) select 42 as x` now inserts the row
(previously `t` stayed empty — the planner only attached a CTE when something read it).
Applies to all three writing forms (`insert`/`update`/`delete`) and to any outer statement
kind (select / insert / update / delete / view-targeted DML). Two arms, per the implement
ticket's design, both landed:

**Arm A — one runtime identity per source `with` member.** `PlanningContext.cteDescriptors`
(`Map<AST.CommonTableExpr, TableDescriptor>`, seeded in `Database._buildProbeContext`) memoizes
the descriptor `buildCommonTableExpr` hands to `CTENode` — keyed on the member's AST object, so
however many times the builders re-plan one member within a statement (view write-through,
multi-source decomposition, the Arm-B rebuild), every `CTENode` shares one descriptor and
therefore one `emitCTE` per-execution buffer. One write per statement execution by construction.

**Arm B — sink the unreferenced members ahead of the statement.** `buildBlock` (only there —
every per-builder site is re-entered by view write-through) was split into `buildStatement` +
`attachUnreferencedDmlCtes`. Per top-level statement with a `with` clause: collect the plan's
reachable `CTENode` descriptors (walking `getChildren` AND `getRelations`, mirroring
`collectTableRefs`); a data-modifying member whose memoized descriptor is absent is unreferenced;
rebuild the clause (`buildWithClause` — needed because a member may read an earlier sibling; safe
because of Arm A), wrap each unreferenced member in a `SinkNode`, and sequence them ahead of the
statement under the new `SequenceNode`. The statement's own `WITH SCHEMA` path is mirrored onto
the rebuild context (`stmt.schemaPath`), matching the statement builders.

**SequenceNode / emitSequence.** Not a `BlockNode` (that erases result column names and its
bare-param statements run concurrently — both failures observed on the ticket's prototype).
`SequenceNode` delegates `getType`/`getAttributes`/`estimatedRows` to the main child; its emitter
follows `emitViewMutation`'s callback pattern: each effect emitted via `emitCallFromPlan`, driven
to completion sequentially in `run`, then the main child's sub-program result is returned
un-drained (streaming main still streams). Effects-first so an early-abandoned main (`limit 0`)
cannot skip a write.

**Downstream consumers taught the node:**
- `change-scope.ts` `isDmlWithoutReturning` classifies a Sequence by its **main** child (the
  effects' internal RETURNING clauses are not the statement's, and 2+ children would stop the
  single-child descent).
- `emitBlock`'s result selection recurses into a Sequence's main, so a Sequence over a
  Sink-topped void DML stays void instead of promoting the sink's row count to the block result.

## Validation performed

- `yarn build` green; `yarn lint` clean; `yarn test` (all workspaces) green —
  quereus suite 9220 passing / 0 failing / 25 pending (pending are pre-existing skips).
- `test/logic/13.7-unreferenced-dml-cte.sqllogic` (new) covers: all three writing forms
  unreferenced; unreferenced member under outer insert/update/delete (the shape that crashed the
  BlockNode prototype with a savepoint error); two unreferenced members; referenced +
  unreferenced (exactly one write each); an unreferenced writing member reading a referenced
  sibling (buffer replay, no double write); transitively-unreferenced (write member read only by
  an unreferenced select member); two unreferenced writers chained; `limit 0` main still writes;
  outer-visibility divergence pin; single- and multi-source view-targeted outer writes (clause
  built 2+ times, one write, no double-sink); rollback undoing a sunk write; unreferenced
  read-only member still dropped; result column names survive the wrapper (`x`, not `col_0`).
- `test/logic/13.6` t11 flipped from `cnt = 0` (pinned-broken) to `cnt = 1`; its t16 comment
  updated for the descriptor memo.
- `test/plan/cte-dml-plan-shape.spec.ts` new describe: exactly one SequenceNode with Sink
  effects; one descriptor per member across all copies (including the view write-through double
  build — the Arm-A invariant); no wrapper for fully-referenced or read-only-unreferenced
  clauses; prepared statement re-executed 3× writes 3 rows.

## Known gaps and honest notes for the reviewer

- **Change-scope over-reporting (sound, untested).** `analyzeChangeScope`'s table/column walks
  still traverse the whole tree, so for a SELECT main with a sunk effect the watches now include
  the effect's table refs. Over-counting only costs an extra wakeup (the file's stated
  contract); only the DML-without-RETURNING *classification* was scoped to the main child. No
  test pins either behaviour for Sequence-wrapped plans.
- **`WITH SCHEMA` + unreferenced member is untested.** The rebuild context mirrors
  `stmt.schemaPath`, but no test combines a statement-level schema path with an unreferenced
  writing member.
- **PostgreSQL divergence (deliberate, documented).** The outer statement can observe the sunk
  write (`select count(*)` sees the inserted row) because effects run first. Consistent with
  Quereus's existing visibility for *referenced* members; documented in `docs/runtime-caching.md`
  § Shared CTE materialization and pinned in 13.7.
- **Read-only sibling evaluation count can drop from 2 to 1.** When a sunk member reads a
  read-only sibling that the main statement also reads, the rebuild gives that sibling a second
  `CTENode` sharing one descriptor; the materialization-advisory pass then sees 2+ parents and
  buffers it, so the body evaluates once (consistent view) where two independent evaluations
  happened before. Semantically fine (row-set identical for deterministic bodies; arguably better
  for non-deterministic ones), noted here because it is an observable plan change.
- **Nested clauses untouched (per ticket scope).** A `with` on a sub-select or stored view body
  keeps the old behaviour; PostgreSQL rejects data-modifying members there, so top-level was the
  whole obligation. The correlated-subquery DML-CTE gap in `docs/runtime-caching.md` is likewise
  unchanged (still listed as open).
- **Cross-statement concurrency unchanged.** `emitBlock` still starts sibling statements
  concurrently (pre-existing); a Sequence orders only within its own statement.
