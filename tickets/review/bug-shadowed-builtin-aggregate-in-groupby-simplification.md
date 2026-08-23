description: Fixed a bug where registering your own SQL function named "min" could make an unrelated GROUP BY query silently return wrong values, because an optimizer rewrite assumed "min" always meant the built-in.
files:
  - packages/quereus/src/core/database.ts                                            # ~2356 new `_findBuiltinFunction(funcName, nArg)`, right after `_findFunction`
  - packages/quereus/src/planner/rules/aggregate/rule-groupby-fd-simplification.ts    # ~142 lookup now gated on built-in identity; header comment + log line reworded
  - packages/quereus/test/optimizer/rule-groupby-fd-simplification.spec.ts            # two new tests: shadowed-min regression + un-shadowed control
  - packages/quereus/src/planner/rules/aggregate/rule-minmax-index-boundary.ts        # unchanged — sibling site already gated on `_isBuiltinFunction`, nothing to migrate
  - packages/quereus/test/optimizer/minmax-index-boundary.spec.ts                     # unchanged — reference test at ~314 that the new tests mirror
---

# Fix landed: `min/1` picker now gates on built-in identity, not name

## What was wrong

`ruleGroupByFdSimplification` (the optimizer rule that drops `GROUP BY` columns
already determined by the remaining grouping columns) re-emits each dropped column
as a `min(<column>)` "picker" aggregate — sound only because the *built-in* `min`
returns any value from a group of identical rows. The rule resolved that picker with
a plain name lookup (`context.db._findFunction('min', 1)`), so once an application
registered its own `min` (`db.createAggregateFunction('min', …)`, which overwrites by
name/arity), the rewrite silently used the shadow instead, and affected queries
returned whatever the shadow's aggregate computed rather than the true column value.
No error, no warning — see the ticket's before/after table for a concrete repro
(PK `id`, dropped `v` column, correct `[100, 200]` vs. shadowed `[1, 1]`).

## Fix

Added `Database._findBuiltinFunction(funcName, nArg)` next to the existing
`_findFunction`, implemented as `_findFunction` filtered through the pre-existing
`_isBuiltinFunction` (schema-identity check against the database's built-in
registration set — the same gate `rule-minmax-index-boundary` already used for the
identical class of bug). The GROUP BY rule now calls
`context.db._findBuiltinFunction('min', 1)`; when a user has taken over the name, the
lookup returns `undefined` and the rewrite declines, falling back to the ordinary
(correct, slightly slower) grouped aggregate. Reworded the declined-rewrite log line
and the rule's file-header doc comment to say the picker relies on **built-in** `min`
semantics specifically.

`rule-minmax-index-boundary` needed no change — it already gates a schema handed to
it on the plan node via `_isBuiltinFunction` directly, so there was nothing to
migrate there. Ticket's own sweep of every other by-name function lookup in the
codebase found no further instances of this bug class (materialized-view rewrite,
lens-prover, schema manager, mutation decomposition all read declared schema
properties, which is correct behavior under shadowing; window functions have no
public registration API so every name reaching that dispatch is a built-in). No
tripwire needed — that sweep is documented in the ticket body for anyone who adds
user-registrable window functions later.

## Tests for validation

- `packages/quereus/test/optimizer/rule-groupby-fd-simplification.spec.ts`:
  - **`a user-defined aggregate that shadows the builtin min`** — registers a
    counting `min/1` aggregate on a table keyed by `id` with a determined column `v`;
    asserts the aggregate node's `groupBy` still carries *both* columns (rewrite
    declined) and that `SELECT id, v FROM pk GROUP BY id, v` returns the true values
    `100`/`200`, not the shadow's row-count output.
  - **`control: the same query still collapses GROUP BY when min is un-shadowed`** —
    same query shape on a fresh, un-shadowed `Database`; proves the rewrite still
    fires normally (collapses to 1 `GROUP BY` column) so the shadow test isn't just
    exercising a rule that never fires at all.
- Full targeted run: `node test-runner.mjs --grep "ruleGroupByFdSimplification|minmax-index-boundary"` → 32 passing (includes all pre-existing cases in both specs, unaffected).
- Full suite: `yarn workspace @quereus/quereus test` → 10206 passing, 25 pending (pre-existing skips, unrelated).
- `yarn workspace @quereus/quereus lint` → clean (eslint + test-file typecheck).

## Gaps / things the reviewer should know

- No test exercises `max` shadowing on this rule's path — the rule only ever
  synthesizes `min` pickers (never `max`), so there is nothing else to shadow here;
  `rule-minmax-index-boundary`'s own spec already covers `max` shadowing separately
  for its own rewrite.
- Did not add a test for shadowing a *different* arity (`min/2` or similar) — the
  arity is hardcoded to `1` in both the rule and the fix, and `_findBuiltinFunction`
  takes `nArg` generically, so this is believed to generalize but wasn't separately
  exercised.
- The ticket's own throwaway repro script (used to confirm the bug pre-fix) was
  removed per the ticket's instructions; the permanent regression coverage is the two
  spec tests listed above.
