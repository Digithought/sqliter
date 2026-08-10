description: Aggregate functions can now declare, once on their schema, how their values combine and reverse — groundwork for maintaining and rolling up aggregate materialized views. Reviewed and accepted; metadata only, no consumers yet.
prereq:
files: packages/quereus/src/schema/function.ts, packages/quereus/src/func/registration.ts, packages/quereus/src/func/builtins/aggregate.ts, packages/quereus/test/util/aggregate-algebra-laws.ts, packages/quereus/test/incremental/aggregate-algebra.spec.ts, docs/schema.md, docs/mv-maintenance.md
difficulty: medium
----
## What shipped

Optional `algebra` declaration (`merge` / `negate?` / `decode?` / `decompose?`) on
`AggregateFunctionSchema`, threaded through `createAggregateFunction`, declared on the
incremental-capable builtins (count/sum/min/max/avg), and validated by a fast-check law
harness (`assertAggregateAlgebraLaws`). Pure metadata — nothing reads `algebra` yet; the
two consumers live in `tickets/implement/` (`feat-mv-agg-rollup-retarget` read-side,
`feat-mv-agg-delta-arm` write-side) and `prereq` on this work.

Deliberate spec deviation (implementer flagged, reviewer confirmed sound): sum's
accumulator is `{sum, count}` not `{sum}`, so retraction can observationally return to the
empty group (`count === 0` finalizes NULL). External step/finalize behavior is byte-for-byte
unchanged.

## Review findings

Read the implement diff (`2ccbccf6`) first, then the handoff. Adversarial pass over every
angle below.

**Correctness — laws.** Hand-verified each declared law against every builtin, focusing on
the finalize-then-byte-compare equivalence that lets cross-storage-class ties (`5` ≡ `5n`,
first-wins min/max tie-break) pass commutativity. Confirmed via `sqlValueIdentical` →
`compareSqlValuesFast`: number/bigint compare equal, so structurally-different-but-
equivalent merge results finalize identically. Sum's decode-observational law holds because
folds only ever produce `count ≥ 1` for non-empty groups, so `viaStore` count (`1 + …`) and
`direct` count both stay non-zero. No law defect found.

**Correctness — sum accumulator change (the deviation).** Verified the `{sum}` → `{sum, count}`
shape is private to `aggregate.ts`: grepped every `.sum` consumer — the only others are the
window-function emitters (`builtin-window-functions.ts`, `runtime/emit/window.ts`), which
carry their own accumulators (window-sum already uses this exact `{sum, count}` pattern). No
external caller reads the shape. External behavior preserved (a fold that counted nothing
finalized NULL before and after). Accepted.

**DRY / hygiene.** `addWithPromotion` extraction shares the overflow-promote logic between
step and merge — good. `cloneInitialValue`'s shallow object clone is sufficient (accumulators
hold only primitives). Comments are on the verbose side but accurate; not worth churning.

**Tests.** Positive laws over domain-appropriate arbitraries, shape pins, and two negative
twins (broken negate → `negate-inverse`; fabricating decode → `decode-observational`).
Re-examined the "unpinned seed → flaky" worry the handoff raised: both twins fail with
effectively certainty (the broken decode fails even on the empty-array case, which fast-check
generates constantly; the broken negate fails on any run containing ≥1 non-null value). The
theoretical flake is not a practical risk — left as-is, no seed pin added.

**Docs.** Read `docs/schema.md` § Aggregate Function Algebra and `docs/mv-maintenance.md`
forward-reference in full. Both accurate against the code; the two consumer ticket slugs
named in the docs (`feat-mv-agg-rollup-retarget`, `feat-mv-agg-delta-arm`) match real tickets
in `tickets/implement/`. No stale doc found.

**Fixed inline (minor).** Added a greppable `NOTE:` at sum's `decode` site flagging that it
type-trusts its stored input (a non-numeric value would poison the accumulator) — the
handoff noted this only in prose; pinned it at the code site where the future delta-arm
author will meet it.

**Tripwires recorded (not tickets).**
- Sum `decode` type-trust → `NOTE:` at `aggregate.ts` decode site; validation is the
  `feat-mv-agg-delta-arm`'s job when it becomes the first caller.
- `count` decode uses `Number(stored)` — precision-lossy above 2^53. Unreachable count
  magnitude; noted in the implement handoff, no guard.
- Negative-count accumulators (unbalanced retraction) finalize as non-empty. The laws never
  produce them; the write-side arm must keep retractions balanced — already flagged for the
  `feat-mv-agg-delta-arm` design in that ticket's edge cases.

**Major findings.** None — no new tickets filed. The design is sound and self-contained;
the risky surface (decode type-trust, negate under float drift, unbalanced retraction) is all
dormant until a consumer lands, and each consumer ticket already owns its slice.

## Validation

- `yarn workspace @quereus/quereus run lint` — exit 0 (eslint + tsc test typecheck).
- Full quereus suite (`test-runner.mjs`) — **7110 passing, 13 pending**, exit 0.
- `test/incremental/aggregate-algebra.spec.ts` — 12/12 passing.
- The added `NOTE:` is comment-only (no logic change).
