---
description: The nullif, greatest, and least functions now compare values the same way the rest of the engine does — honoring case-insensitive collations, duration columns, and JSON documents — instead of comparing raw bytes.
files:
  - packages/quereus/src/planner/building/coercion.ts          # NEW — shared plan-build coercion (moved out of expression.ts) + coerceComparisonGroup
  - packages/quereus/src/planner/building/expression.ts        # re-pointed at coercion.ts; no behavior change
  - packages/quereus/src/planner/building/function-call.ts     # applies coerceComparisonGroup before inferReturnType
  - packages/quereus/src/schema/function.ts                    # BaseFunctionSchema.comparesArgs declaration
  - packages/quereus/src/func/registration.ts                  # comparesArgs passthrough in createScalarFunction
  - packages/quereus/src/planner/analysis/comparison-collation.ts  # N-ary resolveGroupCollation / effectiveGroupCollation
  - packages/quereus/src/func/builtins/scalar.ts               # emitNullif + emitExtremum custom emitters; comparesArgs on all three
  - packages/quereus/test/planner/comparison-collation.spec.ts # unit net for the N-ary merge
  - packages/quereus/test/logic/06.4.2-collation-extras.sqllogic
  - packages/quereus/test/logic/15.1-semantic-ordering.sqllogic
  - docs/types.md                                              # semantic-ordering + collation-resolution sections updated
---

# Review: `nullif` / `greatest` / `least` comparison seam

## What was built

All three builtins previously compared with bare `compareSqlValues` (storage
class + BINARY), disagreeing with `=` on NOCASE/RTRIM columns, TIMESPAN
columns, and JSON-vs-text-literal operands. Now:

1. **Shared coercion module.** `insertCrossTypeCoercion`,
   `coerceObjectPhysicalSet`, and `wrapInCast` moved verbatim from
   `planner/building/expression.ts` (where they were private) into
   `planner/building/coercion.ts`; the `=`, IN, simple-CASE, and BETWEEN call
   sites re-pointed. Behavior-neutral move, validated by a green full suite
   before the rest was layered on.

2. **`comparesArgs` declaration** (`BaseFunctionSchema`): the argument
   positions a function compares against one another — `[0, 1]` on `nullif`,
   `'all'` on `greatest`/`least`. One declaration drives both halves of the
   fix, so they cannot disagree about which operands form a comparison group:
   - **Plan time**: `coerceComparisonGroup` (in coercion.ts) applies the
     object-physical arm across the group before `inferReturnType` runs, so
     `nullif(json_col, '<text>')` compares JSON against JSON.
   - **Emit time**: custom emitters resolve the group's collation + comparator
     once per call site, never per row.

3. **N-ary lattice entry point**: `resolveGroupCollation` /
   `effectiveGroupCollation` in `comparison-collation.ts`, built on the
   existing `mergeContributions` (the same merge `resolveInCollation` uses),
   so an N-operand conflict is resolved in the lattice's one home and reported
   once. Reduces exactly to `resolveComparisonCollation` for two operands
   (unit-tested).

4. **Custom emitters** (`func/builtins/scalar.ts`, same post-hoc
   `customEmitter` assignment pattern as `mutation_ordinal` / `json_schema`):
   - `nullif`: pairwise `effectiveComparisonCollation` + the shared
     `makeOperandComparator` — byte-identical routing to `=` (typed fast path,
     same-category fast path, runtime temporal check).
   - `greatest`/`least`: one `emitExtremum(direction)` factory sharing one
     comparator between both directions. All-same declared semantic-ordering
     type ⇒ that type's compare under the resolved collation
     (`createSemanticValueComparator`); otherwise storage class + resolved
     collation.
   - Each `implementation` stays in place as the unemitted BINARY default
     (mirrors the min/max aggregate's default alongside `bindArgs`).
   - Instruction notes carry the resolved collation when non-BINARY
     (`formatOperandCollationNote`).

## Decisions the reviewer should weigh

- **`comparesArgs` chosen over a scalar `bindArgs` hook**, as the ticket
  preferred: the plan-build coercion step needs the same group declaration,
  and a bind-style hook would have required a second, separately-maintained
  plan-time signal. No case surfaced during implementation where a hook fit
  better.

- **NEW error surface**: an explicit-COLLATE conflict inside a call
  (`nullif(a collate nocase, b collate rtrim)`) or a declared-collation
  conflict between column operands now raises the same
  `conflicting COLLATE clauses` / `ambiguous collation` errors `=` raises,
  instead of silently comparing under BINARY. Asserted in
  06.4.2-collation-extras.sqllogic next to the identical `=` errors. The
  throw happens at emit time, which — as with simple CASE — still surfaces
  inside `db.prepare` today.

- **Tie representatives deliberately unpinned**: which raw value
  `greatest`/`least` return for comparator-equal operands ('a' vs 'A' under
  NOCASE, 'PT1H' vs 'PT60M') is unspecified; all new assertions use
  semantically distinct values. Same latitude as the min/max aggregate,
  DISTINCT, GROUP BY.

- **Numeric ↔ textual coercion arm still NOT applied** at any of these sites
  (`nullif(int_col, '1')` stays a storage-class mismatch), matching IN and
  simple CASE, tracked by `bug-numeric-text-coercion-skips-in-and-case`. Only
  the object-physical arm runs through `coerceComparisonGroup`.

- **Mixed-type `greatest`/`least` groups have no runtime temporal check.**
  Per the ticket's design, a group whose declared types differ falls back to
  storage class + resolved collation — so `greatest(timespan_col, 'PT120M')`
  (TIMESPAN column + TEXT literal) ranks as text, while `nullif` on the same
  pair does use the temporal check (via `makeOperandComparator`'s pair
  routing, matching `=`). The new sqllogic coverage exercises
  `greatest`/`least` only over same-type groups; if pairwise-vs-N-ary parity
  on mixed groups is wanted later, the fold comparator is the one place to
  change.

- **Probe-side JSON coercion returns the cast value**: in the flipped
  orientation `nullif('<json text>', json_col)`, the first argument is the
  group's probe and gets the synthetic cast, so on a non-match the call
  returns the *parsed JSON document* (and declares a JSON return type), not
  the original text spelling. Consequence of reusing `coerceObjectPhysicalSet`
  probe semantics (IN / simple CASE cast their probe identically); the
  common orientation `nullif(json_col, '<text>')` is unaffected.

## Pre-existing oddity, deliberately preserved

`least`'s NULL handling is asymmetric and order-dependent — today (and still):
`least(1, null)` → NULL (NULL ranks lowest, so the fold picks it) but
`least(null, 1)` → 1 (a NULL accumulator is unconditionally replaced);
`greatest` skips NULLs entirely. The emitters reproduce the default fold
byte-for-byte with only the comparator swapped (every comparator route ranks
NULL first, matching `compareSqlValues`), per the ticket's instruction not to
fold a NULL-semantics change into this work. If standard-SQL NULL propagation
(any NULL argument ⇒ NULL result) is wanted for `greatest`/`least`, that is a
separate behavioral decision — flagging here rather than filing, since the
current behavior may be intentional.

## Validation performed

- `yarn workspace @quereus/quereus run test` — 7434 passing, 0 failing
  (includes the new sqllogic assertions and unit specs).
- Root `yarn test` (all workspaces) — green.
- `yarn workspace @quereus/quereus run lint` — clean (eslint + test-file tsc).
- `test/logic/06.5.2-scalar-minmax.sqllogic` unchanged; its
  `min/2` / `max/2` "Function not found" pins re-confirmed green.
- New unit specs: `resolveGroupCollation` (10 cases: floor, explicit-wins,
  equal-rank conflicts, rank-1 silent floor, order independence, two-operand
  equivalence, throwing-wrapper messages).
- New sqllogic: NOCASE columns + explicit-COLLATE forms + both conflict errors
  (06.4.2); TIMESPAN column repro, JSON column/literal repro, bare-text-literal
  negative controls (15.1) — each next to the corresponding `=` assertion.

## Suggested review focus

- The in-place mutation contract of `coerceComparisonGroup` (it replaces
  members of the caller's `args` array) and its probe-is-first-group-member
  convention.
- Whether the emit-time conflict throw for these builtins should be forced at
  plan-build time instead (simple CASE has the same deferral, documented in
  `runtime/emit/case.ts` — both surface inside prepare today, so this is
  about future-proofing against rules that rewrite nodes away before emit).
- The mixed-group fallback choice for `greatest`/`least` (no temporal check),
  above.
