---
description: Comparing a number against a quoted number now gives the same answer whichever way it is written — equals, IN, CASE, subquery IN, and the min/max style builtins all agree; regression tests pin that agreement, and a value-corruption side effect found during review was filed separately.
files:
  - packages/quereus/src/planner/building/coercion.ts
  - packages/quereus/src/planner/building/expression.ts
  - packages/quereus/src/planner/rules/subquery/rule-subquery-decorrelation.ts
  - packages/quereus/src/runtime/emit/subquery.ts
  - packages/quereus/test/logic/03.6.1-numeric-text-comparison-coercion.sqllogic
  - packages/quereus/test/plan/subquery-decorrelation.spec.ts
  - packages/quereus/test/plan/cast-seek-blocking.spec.ts
  - docs/types.md
  - docs/runtime.md
  - docs/functions.md
  - docs/optimizer-rules.md
---

# Numeric ↔ textual comparison coercion now agrees across every comparison form

## What shipped

The engine converts the textual side of a number-vs-text comparison so
`int_col = '1'` is true. That rule used to be applied only at the `=` and
`BETWEEN` build sites. `IN` value lists, simple `CASE`, `nullif`/`greatest`/`least`,
the `IN`-subquery runtime membership path and both `IN` decorrelation rewrites all
skipped it, so the same comparison answered differently depending on how it was
spelled.

All of those sites now share one rule:

- `coerceComparisonSet` (`planner/building/coercion.ts`) — the plan-time helper for
  the one-probe-against-many-values shape (`IN` value list, simple `CASE`, and the
  builtins that declare a comparison group). Value-side casts are per value; a
  probe-side cast is hoisted and therefore applied only when unambiguous (every
  non-NULL value numeric).
- `inMembershipKeys` (`runtime/emit/subquery.ts`) — the per-row equivalent for an
  `IN` whose right-hand side is a subquery, which has no operand list to wrap.
  Gated on a uniform right-hand side so it cannot pick up the one shape the
  plan-time helper declines.
- Both arms of `rule-subquery-decorrelation.ts` — the synthesized `=` a
  decorrelated `IN` produces is reconciled the same way a hand-written one is.

### Deliberate remaining gap

A **textual** probe against a value list mixing numeric and textual values
(`text_col in (1, 'abc')`) is left uncoerced and still disagrees with the
equivalent `=` disjunction on the numeric member. Hoisting a probe cast over a
mixed list would be worse — `cast('abc' as real)` is `0`, so `'0' in (1, 'abc')`
would become true. Closing it properly needs a per-value probe, which `IN` cannot
express (its members share one key space). Pinned by the fixture's section 5 and
documented in the `coerceComparisonSet` NOTE and `docs/types.md`.

### Tests

- `test/logic/03.6.1-numeric-text-comparison-coercion.sqllogic` — agreement matrix
  over an INTEGER column, a REAL column and a TEXT column against the opposite-category
  operand across `=`, `BETWEEN`, `IN` value list, `IN` subquery, simple `CASE`,
  `nullif`, `greatest`, `least`; INTEGER-target truncation pinned uniformly; negative
  controls (non-numeric text, NULL member, `NOT IN`, mixed-WHEN `CASE`); and the known
  gap pinned explicitly as a divergence rather than left silently absent.
- `test/plan/subquery-decorrelation.spec.ts` — uncorrelated cross-type `IN` declines
  decorrelation and keeps the `In` node; correlated cross-type `IN` still builds one
  semi join with the cast riding in the residual. Both assert the row set too.
- `test/plan/cast-seek-blocking.spec.ts` — numeric probe against textual `IN`-list
  values keeps its index seek (per-value casts fold away); textual probe against
  numeric values loses it, same as `x = 1` already does.

### Docs

`docs/types.md` ("One probe against many values" subsection), `docs/runtime.md`
(Comparison Context), `docs/functions.md`, `docs/optimizer-rules.md` all reflect
the new behavior.

## Review findings

### Checked

Read the production diff (`5549091c`) and the test-only diff (`07e47086`) fresh
before the handoff summary. Re-derived `coerceComparisonSet`'s arm ordering and gate
conditions by hand against `inMembershipKeys`' arms to confirm the two paths cannot
disagree: the object arm returns before the numeric arm in both; a value list is
always reconciled at plan time so the runtime numeric arm only ever sees a subquery
right-hand side or the declined mixed shape, which its uniformity gate excludes.
Exercised the behavior directly against the built engine, not only through the
fixtures. Re-read all four touched doc files against the final code. Lint and the
full workspace suite run clean.

### Major — filed as a new ticket

**Comparison coercion leaks into the value that `nullif`/`greatest`/`least`
return.** These three builtins do not merely compare their arguments, they return
one of them — so rewriting an argument into its cast form makes the cast form the
answer. Verified against the current tree: `nullif('3', 1)` returns the integer `3`
instead of the text `'3'`; `nullif('abc', 1)` returns `0`; `least('abc', 1)` and
`least(1, 'abc')` both return `0`, a value that was never an argument. Confirmed a
regression from this work, not pre-existing: the pre-fix helper
(`coerceObjectPhysicalSet`) had no numeric arm, so these argument shapes were left
alone. Affects both the hoisted-probe and per-value directions, so a fix touching
only one is incomplete. Filed as `tickets/fix/bug-comparison-coercion-corrupts-returned-value`
with the reproduction table; `docs/functions.md` now states the caveat, and the
fixture's `greatest(i, '2')` expectation carries a NOTE saying it flips when that
ticket lands.

### Minor — fixed in this pass

Test gaps around the hoisted probe cast, all in
`03.6.1-numeric-text-comparison-coercion.sqllogic`, none of which were exercised
anywhere: a NULL member alongside numeric members (the NULL is filtered out of the
all-numeric test, so the cast still applies — and the three-valued result must still
hold on a miss), `NOT IN` in the textual-probe direction (only the numeric-probe
direction was covered), and a mixed INTEGER/REAL member list, which is the only case
that exercises `commonNumericTypeName`'s widen-to-NUMERIC fallback — previously
untested in either the plan-time helper or its `inMembershipKeys` twin. Each verified
against the engine independently before being pinned.

### Tripwire — recorded, not ticketed

A cross-type uncorrelated `IN` subquery now declines decorrelation (the cast wrapper
fails the equi-pair gate) and falls back to the set probe, giving up the hash-join
shape. Correct and fine at current inner sizes; only becomes work if such a query
over a large inner relation shows up as slow. Parked as a `NOTE:` at the decline site
in `rule-subquery-decorrelation.ts`, next to the comment explaining the decline, with
the remedy named (a coercion-aware equi-pair keyed on the cast result — not reverting
the coercion).

### Not found

No correctness defect in the coercion logic itself, no resource-cleanup or
error-handling issue (the change adds no I/O, no state, and no new failure mode — the
casts are lenient by construction), and no source-hygiene concern: `coercion.ts` is
211 lines of small single-purpose functions whose comments explain the non-obvious
gate choices rather than restating the code. The docs were already accurate before
this review; the only doc edit made was the new `functions.md` caveat, which
documents the defect above.

### Deliberately not done

The handoff floated adding a mirror of the correlated-decorrelation test with the
column types swapped (child-side TEXT against parent-side INTEGER). Skipped: the
`.sqllogic` fixture covers both directions end-to-end and
`08.1.1-uncorrelated-in-semijoin.sqllogic` already covers the swapped shape's plan;
a second plan-shape spec would assert the same rule twice.

## Validation

- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus run test` — 8086 passing, 13 pending, 0 failing.
- `yarn test:store` was run during `implement` and passed (8077 passing, 0 failing).
  Its run logs pre-existing `[TransactionCoordinator] … savepoint out of range`
  console warnings unrelated to this change; no test asserts on them.
