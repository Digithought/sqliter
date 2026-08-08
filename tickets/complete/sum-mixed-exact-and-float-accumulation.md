---
description: Adding up a column that mixes very large whole numbers with decimals now gives one stable, correct answer regardless of the order rows are read; previously values were silently dropped or the total came back as a huge exact integer that was never in the data.
files:
  - packages/quereus/src/func/builtins/aggregate.ts               # split accumulator, routing rule, finalize
  - packages/quereus/test/incremental/aggregate-algebra.spec.ts   # law suite, routing pin, mirror-`+` negative twin, skip/non-finite pins
  - packages/quereus/test/util/aggregate-algebra-laws.ts          # decodeValueArb option
  - packages/quereus/test/logic/07.5-sum-mixed-exact-and-float.sqllogic
  - docs/types.md, docs/aggregate-algebra.md, docs/functions.md
---

# `sum()` accumulates exact integers and floats separately — shipped

## What landed

`sum()` keeps two accumulator slots and never mixes the two number domains until
finalize:

```ts
type SumAccumulator = {
	exact: number | bigint;   // bigints and safe-integer numbers
	approx: number;           // everything else
	count: number;
} | null;
```

A contribution joins **exact** iff it is a `bigint` or satisfies
`Number.isSafeInteger`; every other numeric contribution — fractions, whole `number`s
past the safe boundary (`1e308`), `±Infinity`, `NaN` — joins **approx**. The same rule
(`isExactIntegerDomain`) applies in `step`, `merge`, `negate` and `decode`. Finalize:
`count === 0` → NULL; `approx === 0` → the exact part unchanged; otherwise
`Number(exact) + approx`.

Behavioral results, all pinned in `test/logic/07.5-sum-mixed-exact-and-float.sqllogic`:

| case | before | after |
| --- | --- | --- |
| `sum` of `0.5, 9007199254740993` | `0.5` (large value dropped) | `9007199254740992` |
| same rows, reverse order | `9007199254740993` (fraction dropped) | `9007199254740992` |
| `sum` of `0.5, 0.25, 9007199254740993` | `0.75` | `9007199254740992` |
| `sum` of two `real` `1e308` | 309-digit `bigint`, `typeof` `integer` | `Infinity`, `typeof` `real` |
| `merge({0.5}, {9007199254740993n})` | throws `RangeError` | `9007199254740992` |
| `sum(1e20)` | `bigint` `100000000000000000000n` | `number` `1e20` |
| `sum` of a single `Infinity` | NULL (swallowed `RangeError`) | `Infinity` |

The swallowing `try`/`catch` in the step is gone; nothing routed into the split
accumulator can throw. Two deliberate skips remain (non-numeric storage class, text
that names no number), each now covered by a test.

The delta-aggregate exact-domain gate in
`core/database-materialized-views-plan-builders.ts` was deliberately **not** touched.

## Review findings

### Checked, nothing wrong

- **Read the implement diff before the handoff summary**, as required.
- **`addWithPromotion`'s soundness under its new precondition.** Re-derived both
  directions of its float-overflow test independently: two safe integers whose true sum
  is inside the safe range always sum *exactly* in float (so the test never fires
  spuriously), and a true sum at or past 2^53 always rounds to something still past
  `MAX_SAFE_INTEGER` (so the test never misses). The missing `canonicalizeInteger` on
  that branch is correct, not an oversight — the branch fires only when the true sum is
  outside the safe range, where `bigint` *is* the R1-canonical form.
- **Exact-part associativity including representation.** Promote-then-narrow gives the
  same storage class under any re-association, because the bigint arm always
  canonicalizes. Checked by hand against the existing pin in
  `test/numeric-canonical.spec.ts`.
- **Routing totality.** `Number.isSafeInteger` is total over `number`; `-0`, `NaN` and
  `±Infinity` all land in `approx` and none of them reaches `BigInt()`.
- **Non-finite results are legal values, not a new failure mode.** `REAL_TYPE.validate`
  accepts any `number` including `Infinity`/`NaN`, and `total()` already produces both
  over the same rows, so the ticket's "sum returns Infinity" decision introduces no new
  storage or validation hazard. This was the thing most likely to bite and it does not.
- **The MV exact-domain gate.** Read it (untouched). It does bound `sum`'s delta path to
  a bare INTEGER-physical *source column*, which is exactly what the new `decode` NOTE
  claims, so the NOTE is accurate rather than aspirational.
- **Board site-claim grep** over `func/builtins/aggregate` across all open stages: only
  the window ticket and this one.

### Two open questions the handoff asked the reviewer to settle

- **Keeping `addWithPromotion`'s "two safe integers" claim with the precondition spelled
  out** — agreed with the implementer, kept. The claim is load-bearing for anyone
  reading that branch; deleting it would leave an unexplained `BigInt()` call.
- **`sum` following `total()`/`avg()` (Infinity) rather than binary `+` (NULL)** — agreed,
  kept. The aggregate family should be self-consistent, and `total()` over identical
  rows is the closer neighbour. The decision now lives at the code site as a `NOTE:` at
  `finalize`, not only in a ticket and a `.sqllogic` comment, so the next person to
  wonder finds it where they are standing.

### Minor — fixed in this pass

1. **`docs/aggregate-algebra.md` was stale in four places.** The implement stage updated
   `docs/types.md` only. Fixed: the decode shape (documented as `{sum: stored, count:
   Infinity}`, a field that no longer exists); the law-3 prose about "the running sum";
   the harness signature, which grew a `numRuns`/`decodeValueArb` options object that was
   entirely undocumented; and the builtin declarations table's `sum` row. Also added the
   *reason* laws 1–3/5 and laws 4/4b now run over different domains, and why the
   fractions in the domain are dyadic — that reasoning existed only in test comments.
2. **`docs/functions.md`'s SQLite-difference line** said sum falls back to REAL "only
   when types are mixed", which never covered a whole `number` past the safe boundary
   and predates the Infinity decision. Rewritten.
3. **The step's skip branches had no tests.** Removing the `try`/`catch` restructured
   exactly those branches, and nothing exercised them. Added coverage for text naming no
   number, empty text (which coerces to `0` and *does* count — easy to get backwards),
   blob, JSON object, and both booleans, plus the assertion that a skip returns the
   *identical* accumulator, so a skip can never bump the count that decides
   NULL-on-empty.
4. **Non-finite behavior was pinned through SQL for one case only.** Added function-level
   pins for overflow to `+Infinity` and `-Infinity`, `Infinity + -Infinity` → NaN (the
   case nobody had written down), and an exact contribution being absorbed by a
   non-finite rather than lost.

### Major — filed

5. **`avg()` disagrees with its own declared decomposition.** `avg` tells the engine it
   can be computed either directly or as `sum(x)/count(x)`; a materialized view uses the
   second, a plain query the first. Over `9007199254740993, 1` they return
   `4503599627370496` and `4503599627370497`. `avg`'s merge law also fails outright over
   large integers. **Verified** by running both registered builtins against each other in
   a throwaway spec (since removed); *not* yet verified end-to-end through a maintained
   view, and the arm says so. Root cause: `avg`'s step converts every value to float
   before adding, while `sum` now does not — and nothing caught it because `avg` is
   property-checked only over integers between −1000 and 1000, where float is exact.

   Filed as **arm 2 of the existing `bug-window-sum-loses-exactness-vs-grouped-sum`**
   rather than as a new ticket: same class (one aggregate, two computation paths that
   disagree on exact-integer data), and that ticket is already written at the class
   level. The arm carries its own guard, since arm 1's `f(x) over () == f(x)` test would
   not catch it — the durable guard here is checking each aggregate over the domain it
   *claims*, not a domain chosen so the check passes. Pre-existing; not caused by this
   diff.

### Tripwires — parked at the site, not filed

- **The `.sqllogic` fold-order arms lean on the planner preserving an inner `order by`.**
  If that optimization ever lands, both arms silently degrade to two identical scans and
  keep passing. `NOTE:` at the top of the file, with what to do instead.
- **The `approx` slot is uncompensated (non-Kahan) float**, so a long REAL fold carries
  ordinary rounding error and re-association can shift the last digits. Fine now — the
  delta-maintenance gate already refuses that domain. `NOTE:` at the field.

### Considered and deliberately not filed

- **`merge`-associativity still fails over non-dyadic floats.** Inherent to IEEE-754; no
  accumulator shape fixes it, and the write side gates on it. Not a defect.
- **`decode` type-trusts its input**, and the new routing means a non-numeric stored value
  now lands in `approx` instead of being caught. Carries a pre-existing `NOTE:`; the only
  caller is the delta arm reading back a value this aggregate wrote.
- **`sum` declares `REAL_RETURN` but can return a `bigint`.** Pre-existing and load-bearing
  for exact integer sums; unchanged by this diff.
- **Comment density in the `sum` block.** The `decode` invariant now carries three stacked
  `NOTE:` paragraphs, which is dense — but each states a distinct, non-obvious obligation
  (absorbing witness / type-trust / observational domain), so this is documentation
  earning its keep rather than commentary. `aggregate.ts` is 459 lines (`wc -l`), well
  inside the size norms, so no split is warranted.

## Validation

- `yarn lint` — clean across all workspaces.
- `yarn workspace @quereus/quereus run test` — **9087 passing, 25 pending, 0 failing**
  (9085 before; +2 from this review's additions).
- No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.
- `yarn test:store` not run — nothing here touches a storage path.

## Known gaps carried forward, unresolved by design

- Nothing tests `sum` over a domain where float addition is *inexact* — deliberate, since
  no accumulator shape can make that associative. The law suite therefore says nothing
  about ordinary decimal data like `0.1`.
- Materialized-view arm 3 (`merge`/`negate` no longer throwing) is verified at the
  function level only. The SQL path to it is gated off, so there is no SQL test to write
  without first relaxing the gate.
