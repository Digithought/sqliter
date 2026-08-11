description: |
  When a row is updated through a deployed logical schema, the engine used to re-read the whole
  finished row once for every required-value rule the table declares. It now re-reads once per
  write, whatever the rule count. Reviewed and complete.
files:
  - packages/quereus/src/planner/mutation/lens-enforcement.ts # synthesizeLensRowLocalDeferredConstraint (list of rules → one message-valued CASE probe); LENS_ROW_LOCAL_DEFERRED_NAME
  - packages/quereus/src/planner/building/view-mutation-builder.ts # lensRowLocalDecompositionUpdateConstraints + buildDecompositionRowLocalChecks (both seams collapsed); review NOTE on per-row commit cost
  - packages/quereus/src/schema/table.ts # RowConstraintSchema.messageValued
  - packages/quereus/src/planner/nodes/constraint-check-node.ts # ConstraintCheck.messageValued
  - packages/quereus/src/planner/building/constraint-builder.ts # threads the flag
  - packages/quereus/src/runtime/row-constraints.ts # constraintFailed + constraintViolationMessage(value)
  - packages/quereus/src/core/derived-row-validator.ts # review NOTE: this validator ignores messageValued
  - packages/quereus/test/lens-rowlocal-grouped-probe.spec.ts # +3 review tests (multi-violation order, grouped INSERT seam ×2)
  - docs/lens.md # § Constraint Attachment
  - docs/schema.md # § RowConstraintSchema — the inverted pass rule
----

# Complete: one deferred logical-row re-read per write, not per rule

A lens decomposition stores each column of a logical table in its own member store; a rule about
the whole logical row (an authored `check`, or a `not null`) is enforced by re-reading the
finished row out of the logical view at commit. The planner used to build **one such re-read per
rule per touched member relation**, so a table where every column carries a `not null` paid one
probe per column per written row. It now builds **one** probe per `(member relation, NEW/OLD
correlation)` group, whatever the rule count.

## What shipped

**The grouped probe.** `synthesizeLensRowLocalDeferredConstraint` takes the full rule list and
emits one constraint per group:

```sql
(select case when not (<rule 1 over _lr.*>) then '<rule 1 message>'
             …
             else null end
   from <logical view> _lr
  where <row address over <CORR>.<memberKey>>)
```

NULL when every rule holds (and when the address matches no row — the old `not exists` pass on an
untouched row); the FIRST violated rule's verbatim message otherwise. Per-rule NULL semantics
survive: a NULL rule leaves its `when not (…)` branch untaken and passes.

**The `messageValued` flag.** New transient opt-in on `RowConstraintSchema`, threaded through
`ConstraintCheck` → `ConstraintMetadataEntry`. `runtime/row-constraints.ts` inverts its pass test
for such a constraint (failure iff non-NULL) and reports the evaluated value verbatim, on both
the immediate and the deferred path.

**Both decomposition seams collapsed** — the UPDATE fan-out (the measured cost) and the INSERT
subquery-bearing deferred branch. The `(relation, correlation)` dedupe, the per-op
`constraintsForOp` gate, and the whole-row grandfathering semantics are unchanged.

## Review findings

Implement diff read first (`git show 249d777d`), then the handoff.

### Verified sound (no change needed)

- **Semantic equivalence of the collapse.** Old `not exists (… where addr and not rule)` vs new
  scalar CASE subquery agree on all three cases: address matches no row (both pass), rule
  evaluates NULL (both pass), rule definitely false (both fail). The address is an equality on
  the logical primary key, so the scalar subquery's single-row assumption holds.
- **Auto-deferral still fires.** `constraint-builder.ts:197` gates on
  `hasRelationalDescendant(expression)`, not on the `exists` shape, so swapping `ExistsExpr` for
  `SubqueryExpr` keeps the probe commit-time. Confirmed by the existing
  "made legal later in the same transaction" tests still passing.
- **The fixed constraint name is safe.** Every group now enqueues under the same name
  `lens:rowlocal`. `DeferredConstraintQueue.enqueue` buckets by `(table, name)` into an **array**
  with no dedupe (`runtime/deferred-constraint-queue.ts:40`), so no entry is lost. The queue's own
  generic name-only fallback (`:197`) is unreachable here — a message-valued pass IS NULL, which
  that fallback treats as a pass.
- **Shared rewrite scope.** The synthesizer now reuses one `makeLogicalRowRewriteScope(slot)`
  across all rules instead of one per rule. That scope is a pure closure over the column-name map
  (`lens-enforcement.ts:536`) with no per-call state, so sharing is correct — and arguably more
  correct, since all rules land in the same subquery scope.
- **The envelope seam is untouched by the flag.** `runtime/emit/view-mutation.ts:204` keeps its
  own truthy-or-NULL test and its own per-check message; it only ever sees subquery-free
  `EnvelopeRowCheck`s, which are never message-valued.
- **No non-ABORT hole was opened on UPDATE.** The INSERT seam refuses a non-ABORT conflict clause;
  the UPDATE seam has no such refusal, but `update or ignore …` does not parse in Quereus at all
  (`Expected table name. (at line 1, column 8)`), so the row-time-forcing path is unreachable
  from UPDATE. Verified by running it.
- **`undefined` handling.** `constraintFailed` treats `undefined` as a pass for a message-valued
  constraint, matching the NULL case, so an evaluator returning `undefined` for an empty scalar
  subquery cannot spuriously fail.

### Minor — fixed in this pass

- **Multi-violation ordering was unpinned** (called out in the handoff). Added a test: two rules
  violated on one row reports the first in obligation order (`CHECK constraint failed: lens:r_name`).
- **The grouped INSERT seam had no grouped coverage at all.** The existing subquery-bearing
  INSERT tests all declare exactly ONE such check, so the change from per-check to grouped on that
  seam was untested. Added two tests over a table with two subquery-bearing checks: the satisfying
  row inserts, and either rule violated alone rejects with its own message
  (`lens:a_rule` / `lens:b_rule`).
  - Test-authoring hazard found while writing them, and commented into the spec: an allow-list
    table whose column is also named `name`/`tag` makes the check vacuous, because the bare
    reference inside the subquery resolves to the inner relation's own column rather than the
    logical row's. The allow-list columns are deliberately named `av`/`bv`.
- **`docs/schema.md` § RowConstraintSchema was stale** — it still stated only the ordinary
  truthy-or-NULL pass rule, with no mention that a constraint can now invert it. Added one
  sentence naming `messageValued`, its transience, and a pointer to `docs/lens.md`.
  (`docs/lens.md` § Constraint Attachment was already updated correctly by the implementer and
  matches the shipped shape.)

### Tripwires recorded (not tickets)

- `core/derived-row-validator.ts` — `compileDerivedRowCheck` ignores `messageValued`. Unreachable
  today (the flag is set only on write-plan-time lens constraints; this validator compiles
  persisted declarations), and if one ever arrived it would still REJECT — a message string
  coerces falsy — but would report the generic message instead of the rule's own. `NOTE:` at the
  site says so and says to teach the evaluator the flag if that path opens. This is the
  "`messageValued` blast radius" gap the handoff flagged; it is a wrong *message*, not a wrong
  *verdict*, and only on a future change, so it is a tripwire rather than a latent defect.
- `planner/building/view-mutation-builder.ts` — the collapse is per WRITTEN ROW: each row still
  enqueues one probe per touched member relation, so a bulk update pays O(rows) point re-reads at
  commit. `NOTE:` at the collapse site (replacing the retired per-rule NOTE) says the next step,
  if bulk lens writes ever profile hot, is a set-level probe over the written keys.

### Considered and left alone

- **`String(value)` in `constraintViolationMessage`.** Flagged in the handoff. The CASE arms are
  always plan-time text literals, so the coercion is a formality and the site already documents
  it. Not worth a guard.
- **The `lens:rowlocal` name in the "constraint rode no base op" trace log**
  (`view-mutation-builder.ts:363`) is now less specific than the old per-rule name. Diagnostic-only
  and already documented at `LENS_ROW_LOCAL_DEFERRED_NAME`; not worth re-splitting the constraint.
- **Source file size.** `view-mutation-builder.ts` is 1737 lines and `lens-enforcement.ts` 1389
  (`wc -l`). Both are pre-existing and this diff is net ~+30 lines across them; not this ticket's
  to split.

### No major findings, no new tickets

Nothing in the diff resolves at a code site that needed a follow-up ticket: the two structural
concerns worth keeping are conditional on future changes and are recorded as `NOTE:` tripwires at
their sites per the tripwire rule, and the two coverage gaps were small enough to close here.
The perf claim itself is not re-measured in this repo — it rests on the ticket's original
measurements plus the structural constant-plan-count pin; the lamina board's companion ticket
(`lens-decomposition-update-probe-collapse`) owns the bench gate.

## Validation

- `packages/quereus` → `node test-runner.mjs`: **9323 passing / 25 pending / 0 failing**
  (was 9320 at handoff; +3 from the review tests).
- `yarn lint` (full fan-out, incl. the quereus eslint + `tsconfig.test.json` type pass): clean.
- Lens suites run together (`lens-rowlocal-grouped-probe`, `lens-row-local-null-write`,
  `lens-put-fanout`, `lens-enforcement`): 327 passing.
- No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.
