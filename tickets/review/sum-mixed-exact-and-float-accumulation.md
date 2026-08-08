---
description: Adding up a column that mixes very large whole numbers with decimals now gives one stable, correct answer regardless of the order rows are read; previously values were silently dropped or the total came back as a huge exact integer that was never in the data.
files:
  - packages/quereus/src/func/builtins/aggregate.ts        # addWithPromotion, isExactIntegerDomain, SumAccumulator, addSumContribution, sum step/merge/negate/decode/finalize
  - packages/quereus/test/util/aggregate-algebra-laws.ts   # new decodeValueArb option
  - packages/quereus/test/incremental/aggregate-algebra.spec.ts  # sumExactDomain / sumDomain, routing pin, mirror-`+` negative twin
  - packages/quereus/test/logic/07.5-sum-mixed-exact-and-float.sqllogic  # new regression
  - packages/quereus/src/core/database-materialized-views-plan-builders.ts  # ~line 855 exact-domain gate — read only, deliberately untouched
  - docs/types.md                                          # § Physical representation
difficulty: medium
---

# `sum()` split accumulator — what landed, and where to push on it

## What changed

`sum()` now keeps **two accumulator slots** and never mixes the two number domains
until finalize:

```ts
type SumAccumulator = {
	exact: number | bigint;   // bigints and safe-integer numbers
	approx: number;           // everything else
	count: number;
} | null;
```

Routing rule, applied identically in `step`, `merge`, `negate` and `decode`
(`isExactIntegerDomain` in `func/builtins/aggregate.ts`):

> a contribution joins **exact** iff it is a `bigint` or `Number.isSafeInteger(v)`;
> everything else (fractions, whole `number`s past the safe boundary such as `1e308`,
> `±Infinity`, `NaN`) joins **approx**.

`finalize`: `count === 0` → NULL; `approx === 0` → the exact part unchanged;
otherwise `Number(exact) + approx`.

`addWithPromotion` survives as the exact-part adder only. Its doc comment now states
the precondition (both operands integer-domain) that makes its widening branch sound —
the branch's original "two safe integers" premise is **true given the precondition**
and false without it, so the comment explains the dependency rather than dropping the
claim. (The source ticket asked to drop it; keeping it with the precondition spelled
out is the better documentation — reviewer's call if they disagree.)

The swallowing `try`/`catch` in the `sum` step is **gone**. Nothing routed into the
split accumulator can throw. The two deliberate skips remain, each with a one-line
comment saying it is a documented skip: a non-numeric storage class (`Uint8Array`,
JSON object) and a string that does not parse as a number.

A `NOTE:` at `sum`'s `decode` records that its observational domain is the
exact-integer part only, and points at the delta-aggregate exact-domain gate in
`core/database-materialized-views-plan-builders.ts` (~line 855). **That gate was not
touched.**

## The three original symptoms, before → after (all re-run)

| case | before | after |
| --- | --- | --- |
| `sum` of `0.5, 9007199254740993` | `0.5` (large value dropped) | `9007199254740992` |
| same rows, reverse order | `9007199254740993` (fraction dropped) | `9007199254740992` |
| `sum` of `0.5, 0.25, 9007199254740993` | `0.75` | `9007199254740992` |
| `sum` of two `real` `1e308` | 309-digit `bigint`, `typeof` `integer` | `Infinity`, `typeof` `real` |
| `sumFunc.algebra.merge({0.5}, {9007199254740993n})` | throws `RangeError` | `9007199254740992` |

## One ticket premise was wrong — verify this yourself

The source ticket said `select 1e308 + 1e308` and `total(v)` are **both NULL**, and
asked to pin `sum` to match. Only the first is true:

- `select 1e308 + 1e308` → **NULL** (`runtime/emit/binary.ts` explicitly nulls a
  non-finite result)
- `select total(v)` over two `1e308` → **`Infinity`**
- `select avg(v)` over two `1e308` → **`Infinity`**
- `select 1e400` → **`Infinity`**

(The ticket's NULL reading is what you get if you observe results through
`JSON.stringify`, which renders `Infinity` as `null` — worth knowing when checking
this by hand.)

So the two candidate anchors disagree and one had to be chosen. **`sum` now follows
`total()`/`avg()` and returns `Infinity`**, on the grounds that it is an aggregate and
the aggregate family is self-consistent; binary `+` is the outlier. This is a real
behavioral decision, is pinned in `07.5-sum-mixed-exact-and-float.sqllogic` § 4, and
is the thing to argue with if you think `sum` should have followed binary `+` instead.
Reversing it would mean nulling a non-finite in `sum`'s finalize — cheap to do, but it
would then diverge from `total()` over identical data.

## Other behavior changes, all pinned

- `select sum(1e20)` was the `bigint` `100000000000000000000n` (`typeof` `integer`);
  it is now the `number` `1e20`. Real INTEGER *column* data is unaffected — R2 stores
  `1e20` in an INTEGER column as a `bigint`, which routes to the exact part.
- `sum` of a single `Infinity` was NULL (a swallowed `RangeError`); it is now
  `Infinity`.
- Unchanged and re-verified: every all-integer fold, including the promote-then-retract
  narrowing pinned by `test/numeric-canonical.spec.ts` ~line 298 (untouched, green),
  and every all-float fold (`0.1 + 0.2` still `0.30000000000000004`).

## Tests — treat these as a floor

**`test/incremental/aggregate-algebra.spec.ts`**

- `sumDomain` widened: NULL, integers ±1e6, bigints to ±2^70, **and dyadic fractions**
  (multiples of `0.25`, |v| ≤ 1000, so float addition over them is itself exact and the
  laws test sum's routing rather than IEEE-754 rounding order). Split out of
  `sumExactDomain`, which is the old integer-only domain.
- Laws 1–3 and 5 run over the mixed domain at **1000 runs**; laws 4/4b (decode) run
  over `sumExactDomain` via a new `decodeValueArb` option on
  `assertAggregateAlgebraLaws`.
- **New negative twin**: the single-slot "mirror binary `+`" design — the obvious
  alternative fix — is built inline and asserted to **fail** `merge-associative` on the
  mixed domain at 3000 runs. This is the test that justifies the whole split; over
  integers alone the mirror variant passes every law.
- **New shape pin**: `sum`'s routing splits on `Number.isSafeInteger`, not
  `Number.isInteger` — `0.5` and `1e308` both go to approx, `9007199254740993n` and `5`
  both go to exact, and `decode` applies the same rule.

**`test/logic/07.5-sum-mixed-exact-and-float.sqllogic`** (new, 6 sections): both fold
orders of `0.5` + `9007199254740993`; the three-value case; fold-order independence
asserted as an *equality between the two orders*, not just two matching literals;
anchoring to `9007199254740993 + 0.5` and `0.5 + 1e308`; the `real` overflow arm
(asserted through `typeof` and `cast(... as text)` = `'Infinity'`, since JSON has no
infinity spelling, plus `sum(v) = total(v)`); unchanged all-integer / all-float /
all-NULL folds; and a GROUP BY case where three groups take three different paths.

**Known gaps in the tests — start here:**

- The `.sqllogic` file forces scan order with `order by id desc` in a subquery. If the
  planner is ever free to reorder that, the fold-order arms weaken silently. There is
  no assertion that the two subqueries actually scanned in different orders.
- The dyadic-fraction domain deliberately avoids float rounding. Nothing tests sum over
  a domain where float addition is *inexact* — by design (no accumulator shape can make
  that associative), but it means the law suite says nothing about ordinary decimal data
  like `0.1`.
- The `approx` part is a plain float, so `sum` over many REAL values still has ordinary
  floating-point error. This is not a regression and the delta-maintenance gate already
  refuses that domain, but no test states it.
- Materialized-view arm 3 (`merge`/`negate` no longer throwing) is verified only at the
  function level, not through SQL — the SQL path to it is gated off, as the source
  ticket established. No new MV test was added.
- `decode` still type-trusts its input (a pre-existing `NOTE:`); the new routing calls
  `Number.isSafeInteger` on it, which is total, so a non-numeric stored value now lands
  in `approx` instead of `exact` rather than being caught. Still poison, differently
  spelled.

## Validation run

- `yarn workspace @quereus/quereus run test` — **9085 passing, 25 pending, 0 failing**.
- `yarn lint` — clean across all workspaces.
- No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.
- Store mode (`yarn test:store`) was **not** run — this change is in the function layer
  and touches no storage path.

## Docs

`docs/types.md` § "Physical representation", the "Arithmetic and aggregation results"
bullet now states the split rule, the `Number.isSafeInteger`-not-`Number.isInteger`
reason, and that `sum`'s `decode` is observational over the exact-integer part only.

## Filed separately

`tickets/backlog/bug-window-sum-loses-exactness-vs-grouped-sum.md` — **verified,
pre-existing, not caused by this diff**: the window runtime
(`runtime/emit/window.ts`) reimplements `sum`/`avg` with its own float-only
accumulator, so `sum(v) over ()` returns `9007199254740996` where grouped `sum(v)`
returns the exact `9007199254740998` over the same two rows. Filed at the class level
(the window runtime reimplements builtin aggregates rather than reusing them) with a
generalized test — "`f(x) over ()` equals `f(x)` over the same rows" — as the proposed
guard. No open ticket claimed that site.
