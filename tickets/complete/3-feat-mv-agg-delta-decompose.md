description: An "average" column in an aggregate materialized view (and any aggregate defined as a formula over simpler ones) is kept current by arithmetic on its stored building-block columns instead of re-running the query — but only when those building blocks are themselves stored columns of the same view.
files: packages/quereus/src/core/database-materialized-views-plans.ts, packages/quereus/src/core/database-materialized-views-plan-builders.ts, packages/quereus/src/core/database-materialized-views-apply.ts, packages/quereus/test/incremental/maintenance-equivalence.spec.ts, docs/mv-maintenance.md
difficulty: medium
----
## What shipped

The **decomposition-maintained** class of delta-aggregate column, layered onto
`DeltaAggregateDescriptor`. A stored aggregate column whose value is a scalar formula over
sibling *partial* aggregates (`AggregateAlgebra.decompose`) — `avg(x) ≡ sum(x)/count(x)`,
and any UDAF declaring `decompose` — is delta-maintained by delta-maintaining its partials
and re-evaluating `decompose.combine` per affected group at end-of-statement flush. `avg` is
the first client of the class, not a special case; nothing is aggregate-name-driven. The
column is maintainable only when every partial it names is also stored as a sibling column
of the same MV body and is itself delta-maintainable; otherwise the whole MV falls to the
residual (correct, just not incremental).

Design/behaviour details are unchanged from the implement handoff — see the commit
`ticket(implement): feat-mv-agg-delta-decompose` (d6ac58ff). This ticket is the review pass.

## Review findings

Adversarial read of the implement diff (d6ac58ff) with fresh eyes, then the handoff. Verdict:
**sound and well-built.** Two minor items fixed inline; one tripwire recorded; no major
findings, no new tickets.

### Checked

- **Class routing / soundness.** Routing is declaration-driven (`merge`+`negate`+`decode` →
  accumulate; else `decompose` → defer; else residual), never a name list. The DISTINCT /
  FILTER / ORDER BY / multi-arg / bare-column gates sit *before* routing, so both classes
  inherit them. The two-pass partial binding (`resolveDecomposePartial`) correctly resolves
  partials that project before *or* after the decompose column. Confirmed.
- **count(\*) vs count(x) lockstep.** `resolveDecomposePartial`'s count(\*) fallback
  (`notNull === true` gate) is byte-identical in rule to the read-side
  `resolveMergeablePartial` in `query-rewrite-matcher.ts`. Verified the two match. Confirmed.
- **Retraction / empty-group / divide-by-zero.** Descriptor `retractionSafe` is
  `aggColumns.every(...)` — decompose columns add no accumulation, so they don't affect it;
  retracted-unsafe groups fall to the residual, which recomputes the whole row (avg included)
  live. Empty groups are deleted via the multiplicity witness *before* `combine` runs; a
  non-empty all-NULL-arg group finalizes count(x)=0 → `combine` yields NULL. A decompose
  column is never the multiplicity witness (accumulates nothing). All confirmed against the
  flush path in `computeDeltaAggregateOps`.
- **Float-drift gate (the implementer's flagged subtlest claim).** Verified: a partial
  resolves only to an `aggColumns` entry, which already passed the bare-column-arg +
  INTEGER-domain gate. A float-producing partial (`sum(log x)`) has a non-bare argument, so
  it can never be a stored delta-maintainable sibling — a true geometric mean correctly falls
  to the residual. The gate does close every float-drift path a decompose UDAF opens.
  Confirmed; the UDAF test's use of an integer-exact `wsum` (not a real geomean) is the right
  call for a byte-exact oracle.
- **Source hygiene.** Dedicated `DeltaDecomposeColumn` type (not folded into
  `DeltaAggregateColumn`) keeps the hot accumulate/finalize loop untouched — a good call.
  Short functions, precise comments, no dead code. Fine.
- **Docs.** `docs/mv-maintenance.md` "Decomposition-maintained columns (the avg class)"
  section is accurate against the code (routing, count(\*) relaxation, float gate,
  empty-group handling). Read every touched file; docs reflect the new reality.

### Found & fixed inline (minor)

- **Tripwire — avg byte-exactness above 2^53.** `avg`'s *live* finalize accumulates its
  internal sum as a **float** (`aggregate.ts:148`, `acc.sum + Number(numValue)`), while the
  decompose recombine reads the **exact (bigint-capable) `sum` partial**. For any group whose
  integer sum stays ≤ 2^53 these agree byte-for-byte (integer float-adds are exact there);
  only once a group sum exceeds the double safe-integer range do they round differently
  (per-add float rounding vs a single `Number()` of the exact bigint). This is
  magnitude-gated and astronomically unlikely, and it is a property of `avg`'s builtin
  finalize, not of this ticket's code — a genuine **tripwire**, not a reachable defect. If it
  ever becomes reachable, the fix is bigint accumulation in `avg`'s finalize (`aggregate.ts`),
  not here. Recorded as a greppable `NOTE:` at the combine site in
  `database-materialized-views-apply.ts`.
- **Test gap — decompose column projected before its partials.** The two-pass binding exists
  precisely because a partial can project after the decompose column, but every shipped test
  put `avg`/`wsum` last. Added a regression guard (`avg projected BEFORE its stored
  partials …`) asserting the delta strategy is still chosen, the decompose column is bound,
  and read(MV) == live body after a mutation. (While writing it I hit — and fixed in the test
  — the fact that the `assertEquivalent` oracle is hardwired to the view literally named
  `mv`; the guard drops and recreates `mv` with the avg-first body rather than a new name.)

### Major / new tickets

None. No behaviour was wrong; the two items above are a doc-level tripwire and a coverage
guard.

### Not covered (explicit)

- **One-level-deep decomposition** (a partial that is itself only decompose-maintainable →
  residual) is structurally enforced (partials resolve only against `aggColumns`, never
  `decomposeColumns`) and matches the `AggregateDecomposition` "kept one level deep" contract,
  but has no dedicated test. No builtin exercises it and it is a defensive property, so I left
  it unguarded rather than manufacture a UDAF for it.

## Validation performed

- `yarn workspace @quereus/quereus run lint` — clean (eslint + `tsc -p tsconfig.test.json`).
- `yarn workspace @quereus/quereus run test` — green, exit 0: **7143 passing** (7142 prior +
  1 new ordering guard), 13 pending, zero failing. Decompose-class subset = 12 passing.
- No `.pre-existing-error.md` written — no unrelated failures surfaced.
