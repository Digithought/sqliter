---
description: A grouped query that sorted by an aggregate subquery (like "order by (select count(*) from other)") used to crash; the fix was written by a triage run, and this review pass confirmed it and hardened confidence in it.
files: packages/quereus/src/planner/building/select.ts, packages/quereus/src/planner/building/function-call.ts, packages/quereus/test/logic/07.7-scalar-agg-decorrelation.sqllogic
---

# Review complete: ORDER BY aggregate subquery scope-leak fix

## Summary

The fix (triage commit `5167519f`) is **correct and lands cleanly**. It drops
the enclosing query's `aggregates` context from a nested SELECT after that
nested SELECT's WHERE is built, so a subquery's own `count(*)` in the outer
query's ORDER BY is no longer fingerprint-matched against the outer aggregate
and degenerated into a multi-row column read.

Full suite `yarn workspace @quereus/quereus run test` → **7098 passing**, 13
pending. `yarn workspace @quereus/quereus run lint` → exit 0. Both green with the
fix in place.

Independent adversarial probing confirmed the fix and, separately, surfaced one
**unrelated pre-existing parser bug** (filed to backlog).

## The fix under review

`packages/quereus/src/planner/building/select.ts:114-125` — after WHERE is built,
`selectContext.aggregates` is set to `undefined` before this SELECT collects its
own aggregates. WHERE is deliberately built *first* so a correlated
outer-aggregate reference in a subquery's WHERE still resolves. The level
repopulates `aggregates` for its own HAVING/ORDER BY at `select.ts:174-178` once
`buildAggregatePhase` has built them.

Root cause is the shape-only fingerprint match in
`function-call.ts:17-63` (matches an aggregate by name + arg count + arg names,
with no scope identity). The fix scopes *which* aggregate set is visible rather
than reworking the match. Acceptable: within a single query level the shape
match is the intended aggregate dedup; the defect was purely the cross-level
leak, which the scope-drop eliminates. See tripwire below.

## Review findings

**Correctness — verified by independent probes (own memory DB, not the ticket's
assertions):**
- Uncorrelated `order by (select count(*) from c), o.k` over a GROUP BY — **fixed**.
- Correlated `order by (select count(*) from c where c.fk=o.k), o.k` — **fixed**.
- 3-level nested aggregate subquery in ORDER BY — **OK**.
- WHERE of an ORDER BY subquery correlating to an outer aggregate the outer query
  actually computes (`… where c.amount < sum(o.amt)` with outer `sum(o.amt)`) —
  **OK**. This is the fix's core justification (WHERE built before the drop) and
  it holds.
- HAVING subquery correlating to an outer `sum` — **OK**.

**Correction to the review-ticket's own probe notes (minor, no code impact):**
The handoff claimed `order by (select count(*) from c where c.amount < sum(o.id))`
is "OK" unconditionally. It is OK **only when the outer query actually computes
that `sum`**. When the outer query does not, it correctly errors
(`Aggregate function sum not allowed in this context`) — `sum(o.amt)` there is
an illegal aggregate in a WHERE, not a correlation to any existing outer
aggregate. The fix's conclusion is unaffected; the ticket's phrasing was just
imprecise.

**Comment accuracy (select.ts:114-125):** re-verified against actual behavior —
accurate. The claim that a subquery-WHERE outer-aggregate correlation resolves
because WHERE is built before the drop is empirically true. Comment is on the
long side (~10 lines) but the subtlety warrants it; left as-is.

**Source hygiene / scope / cleanup:** fix is 3 functional lines. No resource,
type-safety, or error-handling concerns. Lint clean.

**Docs:** no doc file describes the aggregate-context threading; the in-code
comment is the documentation and it is correct. Nothing stale to update.

**New issue found (major, unrelated) → filed to backlog:**
`bug-window-fn-breaks-earlier-column-alias-parse` — a `select` list with a window
function plus a *bare* (no-`as`) alias on an earlier column fails to **parse**
(`Expected statement type … got '<alias>'`). Reproduces at parse time with no
aggregates/subqueries, so it is entirely separate from this planner fix and
pre-existing. Filed rather than fixed inline (different subsystem, its own repro
and test needs).

## Tripwires (recorded, not filed)

- **Repopulation is conditional (select.ts:174-178).** A subquery that has *no
  aggregates of its own* but references an outer aggregate from its own
  ORDER BY/HAVING (not WHERE) would keep `aggregates: undefined` and fail to
  resolve that outer aggregate. Confirmed niche — WHERE-position correlation (the
  common case) works because WHERE is built before the drop; correlating an outer
  aggregate into a subquery's *own* HAVING/ORDER BY is an exotic construct. If a
  real workload needs it, repopulate the parent aggregate context for the
  subquery's post-aggregate clauses instead of leaving it undefined.
- **SELECT-list forward-reference to an outer aggregate** (e.g.
  `select o.k, sum(o.amt) s, (select … where c.amt < sum(o.amt)) from o group by o.k`)
  errors, because SELECT-list scalar subqueries are built (select.ts:138) before
  `buildAggregatePhase` (select.ts:160) populates the outer aggregate context.
  Pre-existing ordering limitation, independent of this fix. If needed, build
  SELECT-list subqueries after the aggregate phase.
- **Fingerprint fragility** (function-call.ts:17-63) — the shape-only aggregate
  match has no scope identity; the scope-drop is what now keeps it from matching
  across query levels. Within a level it is the intended dedup. Only revisit if a
  future scenario needs to distinguish same-shaped aggregates within one level.
