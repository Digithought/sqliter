---
description: Updating one column of a decomposed view got roughly 400x slower once its columns were declared `not null` — each declared-not-null column adds its own separate re-read of the same row at commit, and a ten-column table pays ten of them per write instead of one.
files:
  - packages/quereus/src/planner/building/view-mutation-builder.ts  # lensRowLocalDecompositionUpdateConstraints — the per-check loop, NOTE at the site
  - packages/quereus/src/planner/mutation/lens-enforcement.ts       # synthesizeLensRowLocalDeferredConstraint, collectLensRowLocalLogicalChecks, resolveLensLogicalRowAddress
  - packages/quereus/test/logic/lens-decomposition-checks.sqllogic  # existing row-local CHECK coverage over decompositions
severity: performance
likelihood: certain
measured: yes
---

# Row-local decomposition CHECKs probe once per check instead of once per row

## What happens today

`lensRowLocalDecompositionUpdateConstraints` synthesizes one deferred constraint per
`(touched member relation, correlation, check)`. Each of those constraints is a
deferred re-read: at commit it probes the logical view for the written row and
evaluates its one check against the result.

The relation/correlation part is already deduped (`seen`). The `checks` loop is not —
it multiplies. A write that touches one member relation with `k` row-local logical
checks issues `k` probes of the *same* row at the *same* address, each re-reading the
whole logical row to evaluate one predicate over it.

## Why it started mattering

Row-local checks used to mean explicit logical `CHECK` clauses, of which a typical
lens has none, so `k` was 0 or 1 and the multiplication was invisible. Since
`68a04b91` ("evaluate row-local CHECKs on the logical row for decomposition writes")
every undefaulted `not null` logical column contributes a row-local check. `k` is now
"how many not-null columns the view declares", and the probe count per written row
scales with the table's width.

## Measurement

Single-column `UPDATE` against a per-column decomposition, 10-column logical table
(measured by a downstream consumer, recorded in the `NOTE:` at the site):

| logical columns declared | time per update |
|---|---|
| nullable | 38.7 ms |
| `not null` | 16694.6 ms |

~430x, on a shape (per-column decomposition, narrow update, ten columns) that is the
normal case for the generated lenses this path exists to serve — not a corner.

## The fix this wants

Collapse the per-check probes into **one probe per `(relation, correlation)`** whose
predicate is the conjunction of that group's checks. One re-read of the logical row,
`k` predicates evaluated against the row already in hand.

Per-check attribution is the only thing the current shape buys, and it is only needed
on failure: when the conjunction fails, re-evaluate the group's checks individually
against the probed row to name the one that failed, so the error message and the
violated constraint's name stay exactly what they are today.

Do **not** reach for trimming the per-op threading instead — the per-op walk is what
makes the seam total over the ops a decomposition write fans into, and narrowing it
reopens the holes `1dec0513` closed.

## What "done" looks like

- One deferred probe per `(relation, correlation)` per written row, independent of how
  many row-local checks the logical table declares.
- Failure messages and reported constraint names unchanged — a violated `not null` on
  a decomposed view still names that column's constraint, not the conjunction.
- A test that pins the probe count: a decomposition with `k` not-null columns issues a
  probe count that does not grow with `k` (the store-side counting doubles in
  `packages/quereus-store/test/pushdown.spec.ts` are the idiom to copy, if the probe is
  observable from there; otherwise count deferred constraints on the plan).
- The `NOTE:` at the site comes out with the fix.

## Coordination

The downstream project that measured this tracks it as its own ticket
(`lens-decomposition-update-probe-cost`) and has been editing these two files directly.
Check the working tree and recent history before starting — this may already be in
flight, in which case close this rather than doing it twice.
