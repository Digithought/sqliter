---
description: |
  An "insert … on conflict (column) do update/nothing" that collides with an existing row only
  because of collation ('abc' vs stored 'ABC' under case-insensitive comparison) or affinity ('1'
  vs stored integer 1) now runs the update/skip instead of wrongly aborting with a uniqueness
  error. Implemented and reviewed.
files:
  - packages/quereus/src/runtime/emit/dml-executor.ts        # matchUpsertClause rewrite + conflictTargetValuesMatch helper + RuntimeUpsertClause fields + emit-time collation resolution
  - packages/quereus/src/planner/building/insert.ts           # resolveConflictTargetEnforcement + buildUpsertClausePlans wiring
  - packages/quereus/src/planner/nodes/dml-executor-node.ts   # UpsertClausePlan.conflictTargetCollations / conflictTargetTypes
  - packages/quereus/src/schema/unique-enforcement.ts         # uniqueEnforcementCollations (used, unchanged)
  - packages/quereus/src/util/comparison.ts                   # compareSqlValuesFast / sqlValueIdentical / BINARY_COLLATION (reviewed, unchanged)
  - packages/quereus/src/types/validation.ts                  # validateAndParse — storage-layer coercion reused for proposed-value affinity
  - packages/quereus/test/logic/47.3-upsert-conflict-target-collation.sqllogic   # collation-variant coverage (BOTH modes); review added WHERE-guard + multi-row cases
  - packages/quereus/test/logic/47.4-upsert-conflict-target-affinity.sqllogic    # affinity coverage (memory-only)
  - packages/quereus/test/logic.spec.ts                       # MEMORY_ONLY_FILES entry for 47.4
  - docs/sql.md                                               # Conflict-target matching note
---

# ON CONFLICT (cols) DO UPDATE/NOTHING matches collation-equal & affinity-coerced conflicts

## Summary of the shipped change

`matchUpsertClause` (`runtime/emit/dml-executor.ts`) decided whether a UNIQUE violation matched a
statement's `on conflict (cols)` target by comparing the proposed row against the stored row with
`sqlValueIdentical` (byte/identity semantics). A conflict that existed only under the constraint's
*enforcement* comparison (a NOCASE case-variant, an RTRIM trailing-space variant, or a pre-affinity
value like text `'1'` vs stored integer `1`) reported "not equal", so the insert aborted with
`UNIQUE constraint failed` instead of running the DO UPDATE / DO NOTHING arm.

The fix compares the way the constraint enforces:
- **Planner** (`insert.ts`, `resolveConflictTargetEnforcement`) resolves per-target-column affinity
  (`logicalType`) + enforcement collation NAME (PK column def's collation, or
  `uniqueEnforcementCollations` for a UNIQUE target — which prefers an index-derived per-column
  `COLLATE`), attaching two index-aligned arrays to `UpsertClausePlan`. Each target index maps back
  to its own column's collation, never positionally.
- **Emit** resolves the collation NAMES to functions once via `ctx.resolveCollation` (recording the
  collation dependency), carrying types + collation fns on `RuntimeUpsertClause`.
- **Match** (`conflictTargetValuesMatch`) applies the column affinity to the proposed value with
  `validateAndParse`, then compares against the already-coerced stored value via
  `compareSqlValuesFast` under the enforcement collation. Absent metadata degrades to BINARY with no
  coercion — byte-for-byte identical to the old `sqlValueIdentical` path, so seed idempotency and
  every prior passing case are unaffected.

## Review findings

**Method.** Read the implement diff (`b8346aa6`) fresh before the handoff summary. Traced the
three-stage path end-to-end (planner → emit → runtime), read `validateAndParse`,
`compareSqlValuesFast`/`sqlValueIdentical`/`BINARY_COLLATION`, and `uniqueEnforcementCollations`.
Ran `yarn lint` (clean) and the full memory suite (**6879 passing, 9 pending, 0 failing**), plus the
two upsert files in **store** mode (47.3 passes, 47.4 correctly skipped).

**Correctness — confirmed sound.**
- Regression-safety of the fallback verified at the source: `sqlValueIdentical(a,b)` *is*
  `compareSqlValuesFast(a,b,BINARY_COLLATION)===0` (`util/comparison.ts:342`), so a plan without the
  new metadata, and any BINARY byte-identical key, matches exactly as before.
- Scenario 6 (index-derived UNIQUE with per-column `COLLATE NOCASE` on a declared-BINARY column):
  confirmed an index-derived UNIQUE lands in `tableSchema.uniqueConstraints` carrying
  `derivedFromIndex`, so `resolveConflictTargetEnforcement` finds it and `uniqueEnforcementCollations`
  resolves the index's collation, not the column's declared BINARY.
- No conflict-target matcher was missed: the other `sqlValueIdentical` call sites (dml-executor
  790/829/1042, constraint-check 341, mutation single/multi-source) are row-changed / FK-cascade /
  constraint-no-op detection — comparing post-coercion old-vs-new, where byte identity is correct.
  None participate in conflict-target matching.
- Bare `ON CONFLICT` (no target columns) path is untouched (`dml-executor.ts:381`).

**Test coverage — extended inline (minor).** The implementer flagged three probing gaps. Two that
run same-storage-class (so valid in BOTH modes) were added to `47.3` and verified passing in memory
**and** store:
- WHERE guard on DO UPDATE combined with a collation-variant conflict — false guard skips (no insert,
  no abort), true guard updates.
- Multi-row INSERT mixing a collation-variant conflict row with clean rows under one statement.

**Test coverage — deliberately not filed (residual, low-risk).** REAL/NUMERIC affinity variants and
BLOB/JSON target columns remain unpinned. They travel the same `validateAndParse` coercion path as
the tested INTEGER case, so behavior follows the storage layer; a dedicated test would have to be
memory-only (the store-mode isolation defect below bites any cross-storage-class conflict). Judged
not worth a ticket — recorded here so a future reader knows it was a conscious omission, not an
oversight.

**Major finding — already filed during implement (verified honest).**
`fix/bug-store-isolation-upsert-affinity-coerced-pk`: under the isolation overlay
(`createIsolatedStoreModule`), a cross-storage-class proposed PK value ('1' vs stored INTEGER 1)
loses the existing row. Confirmed this is a genuine *isolation-layer* defect the engine fix merely
exposes, **not** an engine miscompute: the memory backend routes the same conflict to DO NOTHING /
DO UPDATE and produces the correct result (`47.4` asserts existing-row-preserved and passes in
memory), which proves the engine logic is right. `47.4` is therefore in `MEMORY_ONLY_FILES`; the fix
ticket's acceptance is to remove that entry and pass in store mode. Split is clean and correctly
dispositioned as a new ticket.

**Out of scope (documented at the site, not a ticket).** Multi-constraint coincidence — if an insert
violates the targeted constraint AND another unique constraint at once and the vtab returns the
targeted constraint's existingRow, the row is still suppressed though the uncovered conflict should
abort. Value comparison cannot disambiguate this; the vtab short-circuits on the first violation. The
`NOTE` in `matchUpsertClause` documents it.

**Tripwire (already parked by implementer).** `conflictTargetValuesMatch` re-runs `validateAndParse`
per conflicting row on the cold UNIQUE-violation-with-upsert path (off the happy-path insert). A
`// NOTE:` at the site says: if a workload ever hammers ON CONFLICT on a wide composite target,
precompute per-target coercion closures at emit. Reviewed and agree it is correctly a tripwire, not
work — the path is cold and the concern is purely conditional.

**Cross-repo coordination (not chainable via `prereq:`).** The Lamina-side test currently pins the
old abort with a `rejects` assertion that should become a successful update; tracked by the Lamina
ticket `bug-upsert-conflict-target-collation-match`. Flip it when this lands.

## Validation performed

- `yarn lint` (packages/quereus) — clean.
- `yarn test` (memory) — 6879 passing, 9 pending, 0 failing.
- `47.3-upsert` — passing in memory and store.
- `47.4-upsert` — passing in memory, correctly skipped in store.
