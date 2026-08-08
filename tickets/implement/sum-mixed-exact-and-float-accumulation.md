---
description: Adding up a column that mixes very large numbers with decimals gives wrong answers — sometimes values are silently thrown away, sometimes the total comes back as a huge exact whole number that was never in the data — and the answer changes with the order the rows happen to be read.
files:
  - packages/quereus/src/func/builtins/aggregate.ts        # addWithPromotion (~line 16), SumAccumulator + sum step/merge/negate/decode/finalize (~lines 56-120)
  - packages/quereus/src/runtime/emit/binary.ts            # mixedBigIntArithmetic (~line 62) — binary `+`'s rule for the same pair, the comparison anchor
  - packages/quereus/src/util/numeric-canonical.ts         # canonicalizeInteger, R1
  - packages/quereus/test/util/aggregate-algebra-laws.ts   # assertAggregateAlgebraLaws — needs a narrower domain for the decode laws
  - packages/quereus/test/incremental/aggregate-algebra.spec.ts  # sumDomain (~line 24) — the integer-only domain that hides this
  - packages/quereus/test/numeric-canonical.spec.ts        # 'sum() narrows a promote-then-retract fold' (~line 298) — must stay green
  - packages/quereus/src/core/database-materialized-views-plan-builders.ts  # ~line 847 exact-domain gate — do NOT relax
  - docs/types.md                                          # § Physical representation, "Arithmetic and aggregation results" bullet
difficulty: medium
repro: verified
---

# `sum()` — separate the exact-integer part from the floating-point part

## Three verified wrong answers, one code site

All three come out of `addWithPromotion` in
`packages/quereus/src/func/builtins/aggregate.ts`. Reproduced by running the queries
below against a plain in-memory `Database` (no store plugin).

**1. Values are silently dropped.** `sum` over `0.5` and `9007199254740993` returns
`0.5` — the large value vanishes. Reverse the two rows and `0.5` vanishes instead
(result `9007199254740993`). With `0.5, 0.25, 9007199254740993` the answer is `0.75`.
No error, no NULL, only a debug-level log line: a caller cannot tell a dropped value
from a real total, and which value survives depends on scan order.

**2. A `real` column's total comes back as a huge exact integer.** This one needs no
large-integer values at all:

```sql
create table r (id integer primary key, v real);
insert into r values (1, 1e308), (2, 1e308);
select sum(v), typeof(sum(v)) from r;
-- returns a 309-digit exact integer, typeof 'integer'
-- `select 1e308 + 1e308` returns NULL; `total(v)` returns NULL
```

Two `real` values whose float sum overflows are converted to exact arbitrary-precision
integers and added exactly. Besides being a different answer from both binary `+` and
`total()`, a `bigint` in a REAL-typed result violates R2 in `docs/types.md`
§ "Physical representation" (REAL admits `number` only). Reversing the rows gives yet
another spelling: `1e308, 0.5` in that order returns a different 309-digit integer
than `0.5, 1e308` (which returns `0.5` — arm 1).

**3. Materialized-view maintenance raises `RangeError` instead.** `algebra.merge` and
`algebra.negate` call the same helper with no `try`/`catch`. Verified directly:
`sumFunc.algebra.merge({sum: 0.5, count: 1}, {sum: 9007199254740993n, count: 1})`
throws `RangeError: The number 0.5 cannot be converted to a BigInt because it is not
an integer`. **Dormant through SQL today**: the delta-aggregate arm only delta-maintains
`sum` when the argument column is INTEGER-physical
(`database-materialized-views-plan-builders.ts` ~line 847, "exact numeric domain"
gate), and an INTEGER column cannot hold a fraction. Verified: a materialized view
`select k, count(*), sum(v) from t group by k` over a `numeric` column registers with
no delta descriptor and stays on the residual. So this arm is a latent defect on a
gated path, fixed by the same change — not a separate ticket, and not something to
prove through SQL.

## Root cause

```ts
function addWithPromotion(a: number | bigint, b: number | bigint): number | bigint {
	if (typeof a === 'bigint' || typeof b === 'bigint') {
		return canonicalizeInteger(BigInt(a) + BigInt(b));   // throws on a fractional side
	}
	const sum = a + b;
	if (sum > Number.MAX_SAFE_INTEGER || sum < Number.MIN_SAFE_INTEGER) {
		return BigInt(a) + BigInt(b);                        // arm 2 lives here
	}
	return sum;
}
```

The function has one accumulator slot and tries to decide *per addition* whether the
running total is an exact integer or a float. Both branches are wrong outside the
all-integer case:

- the first branch promotes *both* sides to exact integers because *one* side already
  is; `BigInt(0.5)` throws, and the `sum` step's `try`/`catch` turns that throw into
  `return acc` — the dropped value;
- the second branch's stated premise ("two safe integers whose float sum left the safe
  range have an exact sum outside it") is false, because the operands are not
  necessarily safe integers. `1e308` is a whole `number` outside the safe range (legal
  under R1) and `0.5` is not an integer at all, so a *float* sum that overflows the
  safe range gets reinterpreted as an exact integer computation.

The engine's own rule for the mixed pair, one directory over
(`mixedBigIntArithmetic`, `runtime/emit/binary.ts`), demotes the exact side to float
when the other side is fractional. Mirroring it fixes the drops — **but it does not
fix fold-order dependence**, which was measured, not assumed: a mirrored
`addWithPromotion` fails `merge`-associativity in the existing law harness within a
few hundred fast-check runs (shrunk counterexample: `[0.25]` vs
`[-9007199253772755n, -968237, 0.25]` vs `[]` re-associate to different totals).
Mirroring alone is therefore not enough.

## The fix — a split accumulator

Give `sum` two accumulator slots and never mix the two number domains until finalize:

```ts
type SumAccumulator = {
	/** Exact integer part: every safe-integer `number` and every `bigint` contribution. */
	exact: number | bigint;
	/** Floating-point part: every other numeric contribution (fractions, whole numbers
	 *  outside the safe-integer range, ±Infinity, NaN). */
	approx: number;
	count: number;
} | null;
```

Routing rule, applied identically in `step`, `merge`, `negate` and `decode`:

> A contribution joins the **exact** part iff it is a `bigint` or
> `Number.isSafeInteger(v)`. Everything else joins the **approx** part.

The predicate is deliberately `Number.isSafeInteger`, **not** `Number.isInteger` —
`1e308` is a whole `number` that is not exact in the integer sense, and routing it to
the exact part is exactly what produces arm 2.

- `step` / `merge`: add exact parts with the existing safe-integer→bigint widening
  (this part keeps `addWithPromotion` unchanged in spirit, now only ever called with
  two integer-domain values, so it can no longer throw); add `approx` parts with `+`;
  add counts.
- `negate`: negate all three fields.
- `finalize`: `count === 0` → NULL (unchanged); `approx === 0` → the exact part
  (unchanged for every all-integer fold); otherwise `Number(exact) + approx`.
- `decode`: route the single stored value by the same predicate.

### What this buys, measured

A prototype of exactly this shape was run against the existing law harness
(`test/util/aggregate-algebra-laws.ts`) over a widened domain — NULL, small integers,
`bigint`s up to ±2^70, and dyadic fractions (multiples of `0.25`, so float addition
over them stays exact):

- `merge`-associative, `merge`-commutative and step/merge coherence: **pass**, 3000
  runs each. The current code and the mirror-`+` variant both **fail** associativity
  on the same domain.
- Anchor values: `[0.5, huge]` and `[huge, 0.5]` both give `9007199254740992`, which
  is what `select 9007199254740993 + 0.5` returns. `[0.5, 1e308]` and `[1e308, 0.5]`
  both give `1e308`, matching `select 0.5 + 1e308` and `total()`.
  `[9007199254740991, 2]` still gives the exact `9007199254740993n`, and `[0.1, 0.2]`
  still gives `0.30000000000000004`.

### The one law that cannot hold, and why that is fine

`decode`-observational (law 4) **fails** for the split accumulator over a mixed
domain, and no single-slot representation can fix it: the backing table stores one
finalized value per group, which cannot carry the split apart. This is not a
regression — today the same case throws instead.

The write side already guards this: `sum` is delta-maintained only over an
INTEGER-physical argument column, where the approx part is always empty and `decode`
is exactly observational. So:

- run the decode laws (4 and 4b) over the **exact integer domain only**;
- run the merge/step laws over the **widened mixed domain**;
- leave the plan-builder's exact-domain gate alone, and leave a `NOTE:` at
  `sum`'s `decode` recording that its observational domain is the integer part only,
  pointing at that gate.

### Behavior changes to accept and pin

- `sum` over a `real` column that overflows to `Infinity` follows binary `+` /
  `total()` (both currently NULL) instead of returning a 309-digit integer. Confirm
  where the non-finite→NULL conversion happens for `total()` and pin the same
  expectation for `sum`.
- `select sum(1e20)` currently returns the `bigint` `100000000000000000000n`
  (`typeof` 'integer'); it becomes the `number` `1e20`. `select 1e20 + 0` already
  returns a `number`, and an INTEGER *column* holding 1e20 stores a `bigint` (R2), so
  the exact path still covers real integer data. State this in the ticket's handoff.
- `sum` of a single `Infinity` currently returns NULL (a swallowed drop); afterwards
  it follows the float domain. Pin whatever it lands on.
- Unchanged: every all-integer fold, including the promote-then-retract narrowing
  pinned by `test/numeric-canonical.spec.ts` ~line 298, and every all-float fold
  (bit-identical: the approx part accumulates in the same order and
  `Number(0) + approx === approx`).

### Arm 2 of the original ticket — the silent swallow

Once the routing rule is in place, `addWithPromotion` receives only integer-domain
values and cannot throw, so the `try`/`catch` in the `sum` step has nothing left to
catch. Delete it rather than keeping a blanket catch that hides real bugs (AGENTS.md:
"Don't eat exceptions silent"). The two *deliberate* skips stay and become explicit,
each with a one-line comment saying it is a documented skip, not a failure:

- a non-numeric storage class (`Uint8Array`, JSON object) contributes nothing;
- a string that does not parse as a number contributes nothing. (How text becomes a
  number is `backlog/bug-text-coercion-in-arithmetic-and-aggregates` — do not change
  the conversion here, only stop hiding it.)

## Tests

- Widen `sumDomain` in `test/incremental/aggregate-algebra.spec.ts` to include exact
  dyadic fractions, and add a `decodeValueArb` (or equivalently named) option to
  `assertAggregateAlgebraLaws` so laws 4/4b run over the narrower integer domain
  while laws 1–3 run over the widened one. This widened domain is the real guard —
  it is what caught the mirror-`+` variant's order dependence.
- A `.sqllogic` regression covering the three verified symptoms: both fold orders of
  `0.5` + `9007199254740993` producing the same answer, the three-value
  `0.5, 0.25, 9007199254740993` case, and the `real` `1e308` arm with its `typeof`.
  Assert fold-order independence by summing the same rows in both orders and
  requiring equality, not just the literal expected values.
- Keep `test/numeric-canonical.spec.ts`'s `sum()` narrowing test green unmodified.

## Docs

`docs/types.md` § "Physical representation" — the "Arithmetic and aggregation results"
bullet currently says only that the bigint arms "narrow a result that lands back
inside the safe range". Extend it to state the split rule: `sum` accumulates
safe-integer and `bigint` contributions exactly and everything else in floating point,
combining only at finalize; a fold that saw any non-exact contribution finalizes to a
`number`.

## TODO

- Replace `SumAccumulator` with the exact/approx/count shape and implement the
  `Number.isSafeInteger`-based routing in `step`, `merge`, `negate` and `decode` in
  `packages/quereus/src/func/builtins/aggregate.ts`.
- Keep `addWithPromotion` as the exact-part adder; tighten its doc comment to state
  its precondition (both operands integer-domain) and drop the false "two safe
  integers" premise from the widening branch's comment.
- Implement `finalize`: NULL on `count === 0`, exact part when the approx part is
  zero, `Number(exact) + approx` otherwise.
- Delete the swallowing `try`/`catch` in the `sum` step; keep the non-numeric and
  unparseable-string skips with explicit one-line comments.
- Add a `NOTE:` at `sum`'s `decode` recording that its observational domain is the
  integer part only, referencing the delta-aggregate exact-domain gate in
  `database-materialized-views-plan-builders.ts`. Do not relax that gate.
- Add the decode-law domain option to `test/util/aggregate-algebra-laws.ts` and widen
  `sumDomain` in `test/incremental/aggregate-algebra.spec.ts`.
- Add the `.sqllogic` regression (both fold orders, three-value case, `real` `1e308`
  arm with `typeof`).
- Update `docs/types.md` § "Physical representation".
- Run `yarn workspace @quereus/quereus run test` and `yarn lint`; note in the handoff
  which of the listed behavior changes actually landed and how they are pinned.
