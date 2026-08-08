---
description: Date and time arithmetic re-discovers what kind of values it has on every row — running several pattern matches per value — even though the query compiler already knows the types; decide the operation once when the query is compiled.
prereq: runtime-scalar-op-emit-time-specialization
files:
  - packages/quereus/src/runtime/emit/temporal-arithmetic.ts  # tryTemporalArithmetic — the per-row 15-branch cascade with 8 regex probes
  - packages/quereus/src/runtime/emit/binary.ts               # emitNumericOp temporal + generic paths — the callers
  - packages/quereus/src/types/temporal-types.ts              # DATE/TIME/DATETIME/TIMESPAN logical types — the plan-time facts to consume
  - packages/quereus/test/logic/                              # temporal arithmetic logic tests
difficulty: medium
---

# Specialize temporal arithmetic at emit time

`tryTemporalArithmetic` (`runtime/emit/temporal-arithmetic.ts:144+`) is called per row by
both the `(temporal)` and generic arithmetic paths in `emit/binary.ts`. Per invocation it
runs **four regex/prefix probes on each operand** (date, time, datetime, timespan shape
checks) and then walks a ~15-branch `if (operator === X && isV1Date && isV2Timespan)`
cascade to find the one applicable case.

But when `emitNumericOp` selects the temporal path, it already holds both operands'
logical types (`leftLogical.isTemporal || rightLogical.isTemporal`). For statically-typed
temporal operands the `(operator, leftType, rightType)` triple picks the case at emit
time: the run function becomes one parse + one Temporal call (e.g. DATE + TIMESPAN →
`PlainDate.from(v1).add(Duration.from(v2)).toString()`), with the null check in front.
The 15-branch cascade and all 8 probes disappear from the per-row path.

## Design questions to resolve in this plan pass

1. **Case table shape.** A keyed dispatch (map from `op:leftKind:rightKind` to a run
   builder) vs. nested switch at emit. Enumerate the supported combinations from the
   current cascade (DATE−DATE, DATETIME−DATE mixes, TIME−TIME, ±TIMESPAN on each,
   TIMESPAN±TIMESPAN, TIMESPAN×÷NUMBER, TIMESPAN÷TIMESPAN) and the unsupported-combination
   behavior (today: throws UNSUPPORTED at runtime; specialized: should throw at **plan or
   emit time** — decide which, and whether that changes any currently-passing query that
   never executes the bad branch).

2. **Value/type drift.** A DATE-typed column's runtime value should always be a valid date
   string (write-side coercion enforces declared logical types), but defensive behavior
   for a malformed value must be pinned: today an invalid parse returns null (the
   try/catch in the cascade). Specialized runs should preserve exactly that (per-case
   try/catch → null), not throw.

3. **The generic path keeps its probes.** When either operand is TEXT/ANY (e.g.
   `text_col - date_col`, or a TEXT literal holding 'P1D'), runtime sniffing is the
   defined semantics and must remain. Scope precisely: specialization applies only when
   BOTH operand logical types are temporal or (for the × ÷ cases) temporal × numeric.
   Mixed temporal-vs-TEXT falls back to today's `tryTemporalArithmetic` unchanged.

4. **Comparison twin.** `tryTemporalComparison` / `tryTemporalCompare` have the same
   shape but are already cheap (one prefix check per operand, TIMESPAN-only). Decide
   whether to fold them into the same case-table treatment or explicitly leave them
   (likely leave; state why in the implement ticket).

5. **Shared parse helpers.** Each specialized run parses its operand(s) every row.
   Out of scope to cache parses across rows (values differ per row), but the parse
   helpers should be shared functions, not re-declared closures, so the emit stays small.

## Expected outputs

One or more implement tickets specifying: the case table, the emit-time selection in
`emitNumericOp`, fallback wiring, unsupported-combination error timing, and a test list
covering every (op, type, type) case plus malformed-value null behavior and the
TEXT-operand fallback. Include a bench note: temporal arithmetic over a scan should show
measurable per-row win (regex elimination); wire into `yarn bench` if a suitable
benchmark exists, otherwise state how it was measured.
