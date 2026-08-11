----
description: |
  When a row is updated through a deployed logical schema, the engine used to re-read the whole
  finished row once for every required-value rule the table declares. It now re-reads once per
  write, whatever the rule count — this ticket reviews that collapse.
files:
  - packages/quereus/src/planner/mutation/lens-enforcement.ts # synthesizeLensRowLocalDeferredConstraint — now takes a LIST of rules, builds the grouped message-valued CASE probe; LENS_ROW_LOCAL_DEFERRED_NAME
  - packages/quereus/src/planner/building/view-mutation-builder.ts # lensRowLocalDecompositionUpdateConstraints (collapsed loop, NOTE removed) + buildDecompositionRowLocalChecks (insert deferred branch also grouped)
  - packages/quereus/src/schema/table.ts # RowConstraintSchema.messageValued — the new opt-in flag
  - packages/quereus/src/planner/nodes/constraint-check-node.ts # ConstraintCheck.messageValued
  - packages/quereus/src/planner/building/constraint-builder.ts # threads the flag onto the built check
  - packages/quereus/src/runtime/row-constraints.ts # constraintFailed + constraintViolationMessage(value) — immediate and deferred paths
  - packages/quereus/test/lens-rowlocal-grouped-probe.spec.ts # NEW — exact messages + constant plan count
  - docs/lens.md # § Constraint Attachment updated to the collapsed shape
difficulty: medium
----

# Review: one deferred logical-row re-read per write, not per rule

Implements `perf-lens-decomposition-update-probe-per-check` (from the lamina board). A lens
decomposition stores each column of a logical table in its own member store; a rule about the
whole logical row (an authored `check`, or a `not null`) is enforced by re-reading the finished
row out of the logical view at commit. Previously the planner built **one such re-read per rule
per touched member relation** — linear plan-construction cost in the rule count, and since
columns default to `not null`, roughly one rule per column (measured ~23 ms per rule per update).

## What was built

**The grouped probe.** `synthesizeLensRowLocalDeferredConstraint` (lens-enforcement.ts) now takes
the full list of row-local rules and emits ONE constraint per `(member relation, NEW/OLD
correlation)` group:

```sql
(select case when not (<rule 1 over _lr.*>) then '<rule 1 message>'
             …
             else null end
   from <logical view> _lr
  where <row address over <CORR>.<memberKey>>)
```

It evaluates to NULL when every rule holds (also when the address matches no row — the old
`not exists` pass on an untouched row) and to the FIRST violated rule's verbatim message
otherwise. Per-rule NULL semantics survive: a NULL rule leaves its `when not (…)` branch untaken
and passes, per SQL's NULL-passes-a-CHECK convention.

**The `messageValued` flag.** New opt-in on `RowConstraintSchema`, threaded through
`ConstraintCheck` → `ConstraintMetadataEntry`: the expression yields NULL when satisfied and the
violation message when violated. `runtime/row-constraints.ts` inverts its pass test for such a
constraint (failure iff non-NULL) and reports the evaluated value verbatim — on both the
immediate and the deferred path (the deferred wrapper now computes its message at evaluation
time instead of up front). The deferred queue's own generic fallback treats NULL as a pass, so
nothing there changed.

**Both decomposition seams collapsed.** The UPDATE fan-out loop (the measured cost) AND the
INSERT subquery-bearing deferred branch now emit one grouped constraint each — the latter was
not strictly required by the ticket but uses the identical synthesizer, so the per-rule variant
could be deleted outright rather than kept alongside. The `(relation, correlation)` dedupe, the
per-op `constraintsForOp` gate, and the whole-row semantics (grandfathered rows reject on
sibling-column updates) are untouched. The performance NOTE at the collapse site is removed.

**Naming.** The grouped constraint is named `lens:rowlocal` (`LENS_ROW_LOCAL_DEFERRED_NAME`) for
deferred-queue bookkeeping and trace logs only; it cannot reach a user-visible message because
the message always comes from the evaluated CASE value.

## Validation

- `node test-runner.mjs` in `packages/quereus`: **9320 passing / 25 pending / 0 failing**
  (baseline 9315 / 25; +5 from the new spec). `yarn lint` and full `yarn build` clean.
- New `test/lens-rowlocal-grouped-probe.spec.ts` pins:
  - exact literal `CHECK constraint failed: lens:name_rule` on an authored-check violation;
  - exact literal `NOT NULL constraint failed: W.tag` on a not-null violation (via the
    OLD-correlated member-DELETE lowering, the trickiest correlation);
  - a NULL rule passes its branch while siblings still enforce;
  - planned `lens:rowlocal` constraint count for a 1-rule table **equals** the 4-rule table's
    (walks the plan tree counting `ConstraintCheckNode` entries).
- Existing behavior matrices all pass unchanged: `lens-row-local-null-write.spec.ts` (NULL-write
  shapes × insert/update, member-hop addressing, grandfathering), `lens-put-fanout.spec.ts`
  (cross-member checks `lens:xmember`/`lens:xallow`, rename rewrites), `lens-enforcement.spec.ts`.

## Reviewer starting points / known gaps

- **Multi-violation ordering**: when several rules fail on one row, the FIRST in obligation
  order is reported — same as the old per-constraint iteration order, but no test pins the
  multi-violation case specifically.
- **`messageValued` blast radius**: the flag is honored only in `runtime/row-constraints.ts`.
  `core/derived-row-validator.ts` (maintained tables) and the declarative differ never see a
  message-valued constraint today — it is set only on write-plan-time lens constraints, and the
  schema doc marks it transient/never-persisted — but nothing type-level prevents a future
  caller from setting it on a persisted constraint those paths consume.
- **`String(value)` in `constraintViolationMessage`**: the CASE branches are always text
  literals, so the coercion is a formality; a future message-valued synthesizer yielding a
  non-text value would get JS stringification.
- **No re-measurement in this repo**: the perf claim rests on the ticket's measurements and the
  structural constant-plan-count pin. The lamina board's companion ticket
  (`lens-decomposition-update-probe-collapse`) arms its bench gate (~1.5x bound for 10 rules vs
  1) now that this has landed — lamina's suite reads this repo's `src/` directly, no rebuild
  needed.
- The single-source spine's routed basis-term form and the INSERT envelope seam are
  intentionally untouched (per-rule there is one plan per rule but no re-read — inserts evaluate
  rules on the proposed row).
