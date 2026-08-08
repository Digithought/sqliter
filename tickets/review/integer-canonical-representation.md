---
description: Whole numbers used to arrive in the engine in either of two JavaScript forms depending on how they got there; now every integer value has exactly one form, converted at the points where values enter, with the rule documented and property-tested.
files:
  - packages/quereus/src/util/numeric-canonical.ts     # NEW — canonicalizeInteger / canonicalizeSqlValue / isCanonicalNumeric, R1/R2 doc comment
  - packages/quereus/src/types/builtin-types.ts        # INTEGER_TYPE.parse (number+bigint+string arms), NUMERIC_TYPE.parse (bigint+string arms)
  - packages/quereus/src/runtime/emit/binary.ts        # mixedBigIntArithmetic — success-path narrowing, both arms
  - packages/quereus/src/runtime/emit/unary.ts         # '-' and '~' bigint arms (fast + generic paths)
  - packages/quereus/src/func/builtins/aggregate.ts    # addWithPromotion narrows its bigint arm
  - packages/quereus/src/core/statement.ts             # constructor / bind / bindAll canonicalize into boundArgs
  - packages/quereus/src/util/key-tuple-codec.ts       # NOTE now cites R1 instead of "not reachable today"
  - docs/types.md                                      # NEW § Physical representation; INTEGER/NUMERIC bullets + param-binding bullet updated
  - packages/quereus/test/numeric-canonical.spec.ts    # NEW — unit tables + engine round-trips (runs against BOTH backends)
  - packages/quereus/test/property.spec.ts             # NEW fast-check property "Canonical Numeric Representation (R1)"
  - packages/quereus/test/parameter-types.spec.ts      # one expectation updated to the new bind contract (100n → 100)
prereq:
---

# Review: one JavaScript form per integer value

Implements `implement/integer-canonical-representation`. The rule (now in
docs/types.md § "Physical representation"):

- **R1** — a `SqlValue` is a JS `bigint` only when its magnitude exceeds the
  safe-integer range (|v| > 2^53 − 1); every integer value inside that range is a JS
  `number`. Numbers are never constrained by R1 (`1e20` as a `number` is legal; `-0`
  stays `-0`).
- **R2** — per-declared-type value spaces (table in the doc). Probe values handed to
  comparators are exempt.

## What changed, by ingress

- **`util/numeric-canonical.ts` (new)**: `canonicalizeInteger` (narrow safe-range
  bigint / widen finite whole number; fractionals, NaN, ±Infinity pass through),
  `canonicalizeSqlValue` (bind-seam variant: narrows bigints only, never widens
  numbers — a bound `1e20` may be a REAL parameter), `isCanonicalNumeric` (for the
  follow-on `representation-strict-checker`).
- **Conversion**: `INTEGER_TYPE.parse` number arm now truncates then canonicalizes, so
  `1e20` widens to the exact bigint — this **fixes and subsumes
  `backlog/bug-integer-column-rejects-large-real`** (file deleted; repro is now a spec
  test, and `cast(1e20 as integer)` returns the exact integer). Its bigint arm narrows.
  `NUMERIC_TYPE.parse` narrows its bigint arm; its number arm is deliberately untouched
  (so `cast(1e20 as numeric)` stays a `number` — per the ticket's TODO).
- **Bound parameters**: all three `boundArgs` write sites (constructor, `bind`,
  `bindAll`) canonicalize per-bind. `bindAll`'s object arm now validates every entry
  before assigning any (was `Object.assign` after a validate loop — atomicity kept).
- **Arithmetic/aggregation**: `mixedBigIntArithmetic` narrows on both success paths
  (catch arms still return null); unary `-`/`~` bigint arms narrow (`~(-2^53)` lands
  exactly on 2^53−1, so `~` genuinely needs it); `addWithPromotion`'s bigint arm
  narrows (shared by the SUM step and merge/negate maintenance). Its number-overflow
  arm is provably out-of-range and left unwrapped (comment explains).
- **Literals**: verified already canonical (lexer test at the boundary); no code change.
- **Docs**: R1/R2, the safe-integer-boundary rationale, the BOOLEAN stays-first-class
  decision, "these `typeof` branches are not debt" (the accepted-tradeoff `NOTE:`s in
  `util/comparison.ts` and `runtime/emit/binary.ts` were left in place per the ticket),
  and the API surface change.

## API surface change (intentional, documented)

Two `typeof` changes, no value changes: a safe-range bigint parameter
(`stmt.bind(1, 5n)`) round-trips as the `number` `5`; a bigint arithmetic or `sum()`
result landing back inside the safe range is a `number`. One pre-existing test
expectation updated accordingly (`parameter-types.spec.ts`: bound `100n` now returns
`100`).

## Validation run

- `yarn build` ✓; `yarn lint` ✓ (includes tsc over quereus test files)
- `packages/quereus` `yarn test`: 9063 passing, 0 failing
- All other workspace tests: passing (`workspaces foreach --exclude @quereus/quereus`)
- Store parity: `numeric-canonical.spec.ts` under `QUEREUS_TEST_STORE=true` (19
  passing — the same representation assertions run against LevelDB, exercising
  `serializeRow`'s `$bigint` round-trip) and the full store-mode `logic.spec.ts` (345
  passing). Note `yarn test:store` re-runs *all* specs; only `logic.spec.ts` and the
  new spec consult the env var, so this split is complete coverage of the env-sensitive
  parts.

## Key test cases (for review anchoring)

- Unit tables over both `parse`s: `5`/`5n`/`1e20`/`±(2^53−1)`/`±2^53` (both JS forms)/
  `'9007199254740993'`/`-0`/`1.9`/`NaN`/`Infinity` → value **and** `typeof`.
- Engine: `insert 1e20 into integer col` (three spellings all store the exact bigint);
  bind `5n` → `select` returns `number`; `9007199254740993 - 3` → `number`, `+ 1` →
  `bigint`; truncating bigint division `9007199254740995 / 2` → `4503599627370497`
  `number`; `~(-9007199254740992)` → 2^53−1 `number`; sum promote-then-retract →
  `number`, promote-and-stay → `bigint`; min/max pass values through unchanged.
- fast-check property (`property.spec.ts`): arbitrary bigints spanning ±2^60 with dense
  boundary constants, bound as parameters → insert → select → R1 + exact value equality.

## Known gaps / honest notes for the reviewer

- **Vtab `query()` rows and UDF return values are NOT coerced** — held to R1 by
  contract only, per the ticket (the follow-on `representation-strict-checker` ticket
  is where assertions land). A UDF returning `5n` today silently violates R1 downstream.
- **Narrowing scope**: audited `func/builtins` for other bigint producers — `abs`
  preserves magnitude (canonical in → canonical out), `generate_series` iterates via
  `Number()` (always numbers). No other builtin mints in-range bigints that I found;
  a reviewer sweep of `typeof === 'bigint'` sites would double-check.
- **Promote-then-retract for maintained views** is covered only via the shared
  `addWithPromotion` (the SUM-step test); no end-to-end materialized-view retraction
  test asserts the stored partial's representation.
- **Sum fold-order dependence**: the promote-then-retract engine test relies on PK scan
  order (deterministic for both backends' BTrees) to make promotion actually occur
  mid-fold; any-order folds still produce the same value/typeof, but promotion coverage
  depends on that order.
- **Pre-existing, untouched**: `addWithPromotion` still throws (caught + value ignored
  in the SUM step; uncaught in `merge`) if a fractional float sum crosses the promotion
  boundary while the other side is bigint (`BigInt(0.5)` RangeError) — pre-existing,
  outside this ticket's scope, noted here rather than fixed.
- `backlog/bug-text-coercion-in-arithmetic-and-aggregates` arm A now has its target
  form defined by R1 (that ticket remains open and untouched).
