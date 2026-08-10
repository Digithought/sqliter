---
description: Investigated whether comparisons could skip re-inspecting what kind of value they got on each row when the compiler already knew; measured it, found the saving too small to matter today, and wrote the numbers into the code instead of building it.
files:
  - packages/quereus/src/util/comparison.ts        # compareSqlValuesFast — the accepted-tradeoff NOTE with the full measurement lives here
  - packages/quereus/src/runtime/emit/binary.ts    # compare-fast + numeric-fast branches — pointer NOTEs
---

# Guarded specialization for comparison / arithmetic hot paths — measured and declined

Plan pass on `runtime-guarded-comparison-specialization`. Outcome: **no implement
ticket.** The proposed optimization is real but its payoff is roughly two orders of
magnitude smaller than the cost that actually dominates a row, so building it would add a
branch pair and a fallback path to the engine's most semantically load-bearing functions
for a change no benchmark could see. The decision, the numbers, and the condition that
would reverse it are recorded at the code sites (see *Where it is written down*).

## What was proposed

After the emit-time path selection that `runtime-scalar-op-emit-time-specialization`
landed, the `compare-fast` path in `runtime/emit/binary.ts` still calls
`compareSqlValuesFast`, which classifies both operands with `getStorageClass` on every
row even when the emitter statically knew both were text (or both numeric). The proposal
was to bet on the static type with a cheap `typeof` guard and fall back to
`compareSqlValuesFast` on a miss — the shape `createTypedComparator` already uses for
storage-class drift. Three arms: both-TEXT, both-numeric, and the arithmetic
`numeric-fast` path's bigint dispatch.

## What was measured

Two experiments, both with **one shape per node process** — an early single-process run
gave badly misleading numbers because the shared call sites go megamorphic and whichever
candidate ran last looked slow. Node 24.2, Windows.

**1. Comparator microbench** (65536 pairs per pass, 300 passes, median, scratch script
against `dist/src/util/comparison.js`):

| operand shape | today (`compareSqlValuesFast`) | guarded | note |
|---|---|---|---|
| text (`key_NNNNN`) | 25.5 ns | 23.0 ns | bare `BINARY_COLLATION(a,b)` alone = 20.2 ns |
| text, 40-char shared prefix | 26.5 ns | 25.9 ns | within noise |
| numeric | 3.14 ns | 1.17 ns | 2.7×, but 2 ns absolute |
| text with 5% NULLs | 23.0 ns | 19.8 ns | fallback is cheap, not a cliff |
| arithmetic (`numeric-fast` shape) | 1.19 ns | 1.22 ns | no difference |

The both-TEXT arm — the ticket's predicted payoff, on the strength of BINARY being the
engine's hottest comparator — is the *weakest* arm. The collation call itself is 20.2 ns
of the 25.5 ns, so classification is only ~5 ns of the total and the guard costs ~3 ns of
that back. Whatever is expensive about BINARY comparison is `compareCodePoints`, not the
storage-class dispatch in front of it.

**2. End-to-end marginal instruction cost.** A 1→8-column projection ladder over a 10k-row
table (projections, not predicates, so nothing is pushed into the vtab), each ladder rung
in its own process; the slope is the per-added-expression cost:

| projection | ns/row per added expression |
|---|---|
| bare column reference (`n`) | 143 |
| numeric comparison (`n > k`) | 226 |
| text comparison (`s > 'key_…'`) | 210 |
| arithmetic (`n + k`) | 225 |

A bare column reference — one instruction that does nothing but read an attribute — costs
143 ns/row. Per-instruction scheduler dispatch, not comparison logic, is where the time
goes. Against that, a ≤9 ns guard saving is ~4% of a single comparison expression and
~0.3% of a whole row (whole-row cost measured at 1400-3000 ns depending on width). The
bench harness flags regressions at 20%; this is invisible.

Sort and BTree comparators are not a better target either, despite running in tight loops
with no instruction dispatch: `order by` over 10k text rows is ~n·log2(n) ≈ 133k
comparisons, which at the measured 25 ns is ~3 ms against the `order-by-text-10k`
benchmark's 260 ms median — about 1%.

## Design questions, as resolved

The four questions the plan ticket raised were answered along the way; recording them so a
future pass does not re-derive them:

1. **Helper shape** — a shared factory (`createCategoryComparator(category, collationFunc)`
   in `util/comparison.ts`, returning a closure that guards on `typeof` and falls back to
   `compareSqlValuesFast`) measured *no worse* than a hand-written per-site guard, and on
   text slightly better (23.0 vs 24.4 ns). V8 inlines the small monomorphic closure. If
   this is ever built, build the factory, not per-site guards.
2. **Deopt caching** — unnecessary, and now measured rather than assumed. A guard miss
   falls straight into `compareSqlValuesFast`, and at 5% NULL drift the guarded form was
   still *faster* than the unguarded baseline (19.8 vs 23.0 ns). There is no drift rate at
   which an inline-cache-style swap-to-generic would pay for the mutability it costs.
3. **Where the guard belongs** — `util/comparison.ts`, next to the existing comparator
   factories, per (1); the emitters and `makeGroupComparator` would call it.
4. **Which sites are hot** — none of the candidates, at the current dispatch cost. Answered
   by experiment 2 above.
5. **Dependency on `runtime-physical-representation-invariant`** — moot, and it was never
   needed. The arithmetic arm can be written soundly today (guard `typeof number` on both
   operands, fall back for null/bigint), which also collapses four branches to two — and it
   still measured as zero. That arm is dead on its own merits, not blocked.

## Where it is written down

- `packages/quereus/src/util/comparison.ts`, on `compareSqlValuesFast` — the full
  accepted-tradeoff `NOTE:` with every number above and the revisit condition.
- `packages/quereus/src/runtime/emit/binary.ts`, at the `compare-fast` branch and at the
  `numeric-fast` arithmetic branch — one-line `NOTE:` pointers back to it.

## Review findings

- **The revisit condition is `runtime-scalar-expression-fusion` (plan/), not a date.**
  Fusion exists to delete exactly the per-instruction dispatch that swamps this
  measurement. Once a pure scalar subtree runs as one closure chain, the ~143 ns/instruction
  floor goes away and the numeric guard's 2 ns becomes a double-digit percentage of what is
  left of a numeric comparison. Parked as the revisit trigger in the `compareSqlValuesFast`
  NOTE rather than as a ticket, since it is conditional on work that may change the shape of
  the answer.
- **The methodology gap is filed, the optimization is not.** There is no benchmark that
  isolates per-instruction cost, which is the number fusion will live or die by; filed as
  `debt-bench-per-instruction-scalar-cost` in backlog/.
- No behavior changed. Comment-only edits; `yarn workspace @quereus/quereus run typecheck`
  clean. The scratch measurement scripts were written under the gitignored `.tmp/` and are
  not part of the tree's contract — the ladder is described precisely enough above to
  rebuild, and `debt-bench-per-instruction-scalar-cost` proposes making it permanent.
