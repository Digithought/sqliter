---
description: Comparing a number against a quoted number now gives the same answer whichever way it is written; what remains is dedicated regression tests for it, because so far only the fixtures that pinned the old wrong answers were updated.
files:
  - packages/quereus/src/planner/building/coercion.ts                        # coerceComparisonSet (was coerceObjectPhysicalSet)
  - packages/quereus/src/planner/building/expression.ts                      # IN value-list + simple-CASE build arms
  - packages/quereus/src/planner/rules/subquery/rule-subquery-decorrelation.ts  # both IN decorrelation arms
  - packages/quereus/src/runtime/emit/subquery.ts                            # inMembershipKeys arm 1b
  - packages/quereus/test/logic/06.9.2-json-structural-equality.sqllogic     # § 5.2 updated
  - packages/quereus/test/logic/08.1.1-uncorrelated-in-semijoin.sqllogic     # TEXT-inner case updated
  - packages/quereus/test/plan/subquery-decorrelation.spec.ts                # FK-alignment test re-based
  - docs/types.md, docs/runtime.md, docs/functions.md, docs/optimizer-rules.md
difficulty: easy
---

# Regression coverage for one comparison rule across every comparison form

## State of the work

The fix is **already applied in the working tree** and the whole workspace test
suite passes (`yarn test`: 8081 passing in `packages/quereus`, 0 failing across
all workspaces; `yarn workspace @quereus/quereus run lint` clean). What is NOT
done is dedicated regression coverage: the only test changes so far were to the
three existing fixtures that explicitly pinned the old, wrong answers and named
this ticket as the thing that would change them. Nothing yet pins the *new*
contract on purpose.

Do not redesign the fix. Read it, satisfy yourself it is right, and pin it.

## What the fix does

Before: the planner inserted a cast when one side of a comparison was numeric and
the other textual, but only at the `=` and `BETWEEN` build sites. `IN` value
lists, simple `CASE`, `nullif`/`greatest`/`least`, the `IN`-subquery runtime path
and both `IN` decorrelation rewrites all skipped it, so the same comparison
answered differently depending on how it was spelled.

Now every one of those sites shares the `=` rule.

**`planner/building/coercion.ts`** — `coerceObjectPhysicalSet` became
`coerceComparisonSet` and applies both arms of `insertCrossTypeCoercion`, not
only the JSON one. Three cases, in order:

- Either side JSON-shaped → unchanged from before.
- **Numeric probe** → each textual value casts to the probe's numeric type,
  independently. The probe is untouched, so a mixed value list gets a per-value
  decision for free.
- **Textual probe against an all-numeric value list** → one hoisted cast on the
  probe. Target is the shared numeric type name, or `NUMERIC` when the values'
  numeric types differ (its value space covers `number` and `bigint` together).

The probe is a single plan node shared by every value, so a probe-side cast can
only be applied once. That is safe for the JSON arm because a cast to JSON is
lenient — a textual value that is not JSON source survives as itself. It is NOT
safe for the numeric arm, because `cast('abc' as real)` is `0`: hoisting over a
mixed list would make `text_col in (1, 'abc')` true for the stored text `'0'`,
which `text_col = 1 or text_col = 'abc'` is not. Hence the all-numeric gate, and
hence the one **remaining known gap** (see below).

**`runtime/emit/subquery.ts`** — `inMembershipKeys` gained a numeric ↔ textual
arm alongside the JSON one, for the `IN`-subquery form which has no fixed operand
list to wrap at plan time. It is gated on a *uniform* right-hand side (every
non-NULL member type numeric, or every one textual). A subquery right-hand side
always is; a value list has been reconciled at plan time except for the one shape
`coerceComparisonSet` deliberately declines — the uniformity gate is what keeps
that shape out, so the two paths cannot disagree about it.

**`rules/subquery/rule-subquery-decorrelation.ts`** — both `IN` arms now build
their synthesized `=` through `coerceComparisonSet`. `extractInCorrelation`
already did (JSON only); `extractUncorrelatedIn` did not at all, and was the
reason `int_col in (select text_col …)` still returned nothing after the build-time
fix: it rewrote to a hash semi join keyed on raw values. The cast wrapper fails
that arm's own equi-pair gate, so the conjunct declines the rewrite and stays on
the runtime set probe, which now answers it correctly.

## The one remaining gap, deliberately left

A **textual** probe against a value list mixing numeric and textual values —
`text_col in (1, 'abc')`, `case text_col when 1 when 'abc'` — is left uncoerced
and still disagrees with the `=` disjunction on the numeric member. Closing it
needs a per-value probe, which `IN` cannot express: its members live in one key
space (a BTree keyed under one collation, `runtime/emit/subquery.ts`). If it ever
matters, the move is to desugar a mixed `IN` list into an `OR` of `=` comparisons
at build time, not to widen the hoist. This is recorded as a `NOTE:` on
`coerceComparisonSet` and in `docs/types.md`; do not file it as a separate ticket
unless a real query hits it.

## Behavior that changed, for the test author

All verified against a live database. Table `nn (i integer, r real)` holding
`(1, 2.5)`; `tt (t text)` holding `'1'`.

| query | before | after |
|---|---|---|
| `select i in ('1') from nn` | `false` | `true` |
| `select case i when '1' then 'hit' else 'miss' end from nn` | `'miss'` | `'hit'` |
| `select r in ('2.5') from nn` | `false` | `true` |
| `select case r when '2.5' then 'hit' else 'miss' end from nn` | `'miss'` | `'hit'` |
| `select nullif(i, '1') from nn` | `1` | `null` |
| `select greatest(i, '2') from nn` | `'2'` | `2` |
| `select t in (1) from tt` | `false` | `true` |
| `select case t when 1 then 'hit' else 'miss' end from tt` | `'miss'` | `'hit'` |
| `select i in (select t from tt) from nn` | `false` | `true` |
| `select t in (select i from nn) from tt` | `false` | `true` |
| `select id from jse_num where n in (select s from jse_numtxt)` (uncorrelated, decorrelating) | `[]` | matches |

Unchanged, and worth keeping unchanged: `select i = '1'`, `select i between '0'
and '2'`, `select least(i, '2')` (`1` either way), `select i in ('abc')`
(`false`), `select t in (1, 'abc')` over the stored text `'0'` (`false`, which is
also what the `=` disjunction gives).

Note the engine's `=` truncates on an INTEGER target: `i = '1.9'` is **true** for
`i = 1`, because the textual side casts to INTEGER. Every form now agrees on that
too. It is the existing `=` semantics, not something this work introduced — pin
it as-is rather than "fixing" it here.

## Fixtures already updated (review, do not redo)

Each of these existed specifically to pin the old answer until this ticket landed;
their prose has been rewritten to describe the new contract.

- `test/logic/06.9.2-json-structural-equality.sqllogic` § 5.2 — was titled "the
  numeric ↔ textual pairing was NOT widened"; five expectations flipped.
- `test/logic/08.1.1-uncorrelated-in-semijoin.sqllogic` — the "TEXT inner against
  INTEGER outer currently matches nothing" case.
- `test/plan/subquery-decorrelation.spec.ts` — the FK-alignment test
  "keeps the semi join when the equi column is not the referenced parent column"
  used an INTEGER-vs-TEXT pair as its vehicle, which no longer decorrelates at
  all. It was re-based onto its own INTEGER table pair (matching what the
  anti-join sibling right below it already does, and for the same stated reason),
  and the INTEGER-vs-TEXT shape became a separate test asserting the decline.

## TODO

- Read the four source diffs and confirm the reasoning above holds, particularly
  the two gates: the all-numeric gate in `coerceComparisonSet` and the uniform-RHS
  gate in `inMembershipKeys`. They are what keep the plan-time and runtime paths
  from splitting; if either is wrong the split is silent.

- Add a `.sqllogic` fixture covering the agreement contract end to end. It has no
  home today — the behavior is currently only pinned incidentally, inside a JSON
  fixture and a semi-join fixture. Cover, for an integer column, a real column and
  a text column: `=`, `BETWEEN`, `IN` value list, `IN` subquery, simple `CASE`,
  `nullif`, `greatest`, `least`. Assert they agree with each other, not just that
  each returns a particular constant.

- Pin the negative controls in the same fixture, since they are the things a
  future "simplification" would break: a non-numeric textual value
  (`i in ('abc')`), the mixed-list gap (`text_col in (1, 'abc')` against a stored
  `'0'` AND against a stored `'1'` — the second is where the gap is visible, and
  the fixture should say so in prose rather than look like a typo), `IN` with a
  NULL member (`i in (null)` is NULL, not false), and `NOT IN`.

- Pin the mixed-WHEN simple `CASE` (`case i when 'abc' then … when '1' then …`),
  which is the shape the original ticket worried about and which the per-value
  path handles. Note the parser requires a `THEN` per `WHEN`, so
  `case i when '1' when 2 …` is a syntax error, not a shape to test.

- Add plan-shape coverage for the decorrelation decline: an uncorrelated
  `int_col in (select text_col …)` must produce no semi join and must still return
  the rows the set probe finds. One assertion exists now in
  `test/plan/subquery-decorrelation.spec.ts`; consider whether the correlated arm
  (which keeps its join, with the cast in the residual) deserves the same.

- Check whether casting `IN`-list values blocks an index seek that used to fire.
  `int_col in ('1','2')` casts the *values*, not the probe, and the casts are
  constant-foldable — confirm the folder collapses them before access-path
  selection so the seek survives, and pin it in `test/plan/` if it does. The
  reverse (`text_col in (1,2)`) casts the probe and correctly blocks the seek, the
  same way `text_col = 1` already does (`test/plan/cast-seek-blocking.spec.ts`).

- Run `yarn test` (root) and `yarn workspace @quereus/quereus run lint`. Consider
  `yarn test:store` once — nothing here touches storage, but `IN` over a
  store-backed table exercises a different access path and the run is cheap
  relative to the risk.

- Docs were updated alongside the fix (`docs/types.md` § Type Coercion in
  Comparisons gained a "one probe against many values" subsection;
  `docs/runtime.md`, `docs/functions.md`, `docs/optimizer-rules.md` each had a
  sentence corrected). Re-read them against the final code and fix anything that
  drifted; do not add a new summary doc.
