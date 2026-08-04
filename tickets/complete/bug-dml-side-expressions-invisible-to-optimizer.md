---
description: A subquery written inside a conflict-handling clause, or inside the clause that supplies extra values to a write, used to crash the query; it now runs correctly.
files:
  - packages/quereus/src/planner/nodes/dml-executor-node.ts        # ON CONFLICT + context expressions exposed as children
  - packages/quereus/src/planner/nodes/constraint-check-node.ts    # context expressions exposed as children
  - packages/quereus/src/planner/nodes/plan-node.ts                # review: shared `asScalarNodes` child-narrowing helper
  - packages/quereus/src/planner/nodes/{insert,update,delete}-node.ts # review: OPT-009 exemption NOTEs
  - packages/quereus/src/runtime/emit/constraint-check.ts          # NOTE at the skip-if-no-value branch
  - packages/quereus/test/optimizer/dml-child-exposure.spec.ts     # structural guard (7 tests)
  - packages/quereus/test/logic/13.8-insert-with-clause-visibility.sqllogic
  - packages/quereus/test/logic/06.4-schema-search-path.sqllogic
  - packages/quereus/test/logic/46-mutation-context.sqllogic
  - packages/quereus/test/logic/47-upsert.sqllogic
  - docs/invariants.md                                             # OPT-009
  - docs/optimizer.md                                              # Plan Node Hierarchy → Key Methods
repro: verified
---

# DML side expressions are now visible to the optimizer — complete

## What shipped

`PlanNode.getChildren()` is the only channel the optimizer rewrites subtrees through. Two
plan nodes held user-written expressions outside it, so a *simple* expression in those
positions worked (nothing to rewrite) but a **subquery** always crashed at runtime with an
internal-looking error (`No emitter registered for Aggregate`, or an un-physicalized
`RetrieveNode`):

- `DmlExecutorNode` — every `on conflict … do update` assignment value, each clause's
  optional `where` condition, and `with context <var> = <expr>` values.
- `ConstraintCheckNode` — the same `with context` values.

Both nodes now expose those expressions through `getChildren()` in a canonical order, and
`withChildren()` slices the rewritten children back into the same slots, rebuilding the
`upsertClauses` / `mutationContextValues` structures rather than passing the stale ones
through from `this`. Recorded as invariant **OPT-009** in `docs/invariants.md`, cross-linked
from `docs/optimizer.md`.

Coverage: a structural guard spec plus end-to-end SQL logic tests for upsert subqueries
(assignment, clause `WHERE` both branches, correlation to `excluded.<col>` and to the
existing row, and a two-target multi-clause `ON CONFLICT`) and for subquery `WITH CONTEXT`
values feeding CHECK constraints on INSERT / UPDATE / DELETE.

## Review findings

Reviewed the implement diff (`ca3e8a3f`) before the handoff summary.

**Verified correct, no change needed**

- **Slice/cursor math** in both `withChildren` implementations: `getChildren()` and the
  rebuild walk the same order, and JS `Map` iteration order is insertion order, so
  `keys()`/`values()` stay aligned. The `ConstraintCheckNode` default-slice now has an
  upper bound, so the context tail is no longer swallowed.
- **Third-site claim** re-checked independently: `grep` over `src` confirms
  `mutationContextValues` is read only by `runtime/emit/constraint-check.ts` and
  `runtime/emit/dml-executor.ts`. `InsertNode` / `UpdateNode` / `DeleteNode` carry the map
  but nothing reads it from them — not a third fix site (see tripwire below).
- **`upsertClauses`** is likewise read from only `emit/dml-executor.ts`; assignment map
  keys are column indices and are preserved verbatim by the rebuild (now asserted).
- **Docs** (`invariants.md`, `optimizer.md`) match the shipped code.

**Fixed in this pass (minor)**

- `DmlExecutorNode.withChildren` cast rewritten children with `as ScalarPlanNode` instead
  of checking them — an unchecked assertion in exactly the slot most likely to receive a
  wrong node from a misbehaving rule, and inconsistent with `ConstraintCheckNode`, which
  hand-rolled two near-identical validation loops. Extracted `asScalarNodes(nodes, label)`
  into `plan-node.ts`; both nodes now use it for every scalar slot (context slots included,
  which previously had no check in either node), and the redundant downstream casts are gone.
- Both nodes compared context children via `this.mutationContextValues!.get(...)` — a
  non-null assertion that is only safe because the array is empty when the map is absent.
  Replaced with a positional compare against a `values()` snapshot; no `!` left.
- The guard spec only round-tripped `withChildren(getChildren())`, which takes the
  identity short-circuit and therefore never executed the slice-back code at all — a
  cross-wired clause slot would have passed. Added three tests: substituting a distinct
  node into one slot for each node type and asserting every slot (plus assignment map keys)
  lands where `getChildren()` laid it out, and a wrong-child-count rejection test.
  Spec is now 7 tests, all passing.
- Compressed the OPT-009 body: adding the exemption note pushed it past the 120-word
  per-invariant cap enforced by `scripts/check-docs.mjs`.

**Tripwires recorded (not tickets)**

- `InsertNode` / `UpdateNode` / `DeleteNode` each hold a `mutationContextValues` reference
  that is inert today but goes **stale** (pre-rewrite subtrees) once the optimizer rebuilds
  the consuming nodes. `NOTE:` added at each field declaration, plus an "Exempt" paragraph
  in OPT-009: expose it as a child the moment anything starts reading it there.
- The implementer's `NOTE:` in `runtime/emit/constraint-check.ts` (a declared context var
  with no value would silently shift later values out of alignment; unreachable because
  `emitDmlExecutor` throws first) was reviewed and left as-is — correct call.

**Known limits, deliberately not chased**

- `06.4` Test 17b remains a coarse assertion (proves the ON CONFLICT subquery executes and
  returns a plausible value under `WITH SCHEMA`); `47-upsert.sqllogic` covers the subquery
  shapes thoroughly without `WITH SCHEMA` in the mix, so the residual risk is only in the
  interaction, not the fix.
- `47-upsert`'s "correlated to the unqualified (existing-row) column" case asserts a value
  equal to the row's prior value, so it distinguishes existing-row from `excluded` binding
  (the failure mode under test) but not from a no-op update. The neighbouring cases pin the
  update firing.
- `yarn test:store` (LevelDB path) not run — the diff is planner/runtime plan-node logic
  only, no vtab/store code.

**Validation**

- `yarn test` (full workspace): 8656 passing, 13 pending (pre-existing skips), 0 failing.
- `yarn workspace @quereus/quereus run lint` (eslint + `tsc -p tsconfig.test.json --noEmit`):
  clean.
- `node scripts/check-docs.mjs`: only the two pre-existing over-ratchet files
  (`docs/schema.md`, `docs/sync.md`), already tracked in `tickets/.pre-existing-known.md`
  under `debt-docs-size-ratchet-red-again`. Nothing new from this ticket.
