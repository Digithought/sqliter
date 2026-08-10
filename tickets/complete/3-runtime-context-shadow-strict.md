description: Added an off-by-default debug check (QUEREUS_CONTEXT_STRICT) that catches silent wrong-row bugs where a streaming query operator forgets to release its "current row" bookkeeping and a later read quietly returns a stale row.
prereq:
files: packages/quereus/src/runtime/strict-flags.ts, packages/quereus/src/runtime/strict-fork.ts, packages/quereus/src/runtime/context-helpers.ts, packages/quereus/src/runtime/parallel-driver.ts, packages/quereus/src/runtime/emit/aggregate.ts, packages/quereus/src/runtime/emit/hash-aggregate.ts, packages/quereus/src/runtime/emit/window.ts, packages/quereus/src/runtime/emit/asof-scan.ts, packages/quereus/test/runtime/fork-contract.spec.ts, packages/quereus/test/plan/streaming-window-filter-shadow.spec.ts, packages/quereus/test-runner.mjs, packages/quereus/package.json, package.json, docs/runtime.md
----

# What shipped

Env-gated, off-by-default runtime assertion `QUEREUS_CONTEXT_STRICT` that detects the
**operator-shadows-child stale-shadow** bug: a streaming operator leaves a row context built
from its source's attribute IDs winning the shared `attributeIndex` while a child sets a newer
row for the same IDs, so a downstream column read silently resolves the operator's stale row.
Modeled on the existing `QUEREUS_FORK_STRICT` harness; both concerns now share one
`StrictRowContextMap` subclass and the `createStrictRowContextMap()` factory. See the implement
commit (`git show 76d98ade`) for the full shape; the design is documented in
`docs/runtime.md § Strict context-shadow test mode`.

The one design divergence from the plan — asserting on **observable wrong-row** (value at the
resolved column differs) rather than **pure recency** (any strictly-newer same-attr context) —
was reviewed and **accepted** (see findings).

# Review findings

Adversarial pass over the implement diff (`76d98ade`), read before the handoff summary.

## Checked & clean (no defects found)

- **Core logic — `winnerByAttr` / `attributeIndex` lockstep.** Verified the two stay
  consistent across `set` (both updated to the same descriptor per attr), `delete` (both rebuilt
  by the same forward last-wins iteration of the remaining map), and `reactivate` (routes through
  `set`, re-winning + bumping epoch). The strict `delete`'s winner rebuild mirrors
  `super.delete`'s `attributeIndex` rebuild exactly (same map, same order) — no divergence at the
  delete boundary, contrary to the handoff's worry.
- **Flag-combo guards.** `set`/`delete` run the fork-strict guard first, then gate the
  context-strict bookkeeping on `CONTEXT_STRICT`; fork-strict-only, context-strict-only, and
  both-on all behave correctly. `createStrictRowContextMap()` returns a vanilla map only when
  both flags are off. Zero cost when off (base map carries no epoch tables; single `if
  (CONTEXT_STRICT)` branch in the hot paths).
- **Epoch monotonicity.** `++clock` is globally unique, so the winner is unambiguously the
  max-epoch live context; no two live descriptors collide on their last-touch epoch.
- **Unpopulated-winner skip.** Correct: when the index winner's row is unpopulated,
  `resolveAttribute` falls back to a newest→oldest scan and the winner is not actually read, so
  skipping the assert is sound.

## Verified working (the handoff's own "not yet done" items)

- **Negative control — detector is NOT vacuous (end-to-end).** Temporarily disabled `demote()`
  (the tear-down-before-pull) in `emit/window.ts` and re-ran the full context-strict suite: it
  tripped `context-strict: stale-shadow on column val` via the real query in
  `test/plan/streaming-window-filter-shadow.spec.ts`, with a well-formed diagnostic naming the
  stale `Window#…` winner and the shadowing child scan. Reverted the mutation. This was the
  highest-value confirmation the implementer flagged but hadn't run; it now passes.
- **No false positives.** Full logic suite under the flag: **6886 passing, 10 pending, EXIT 0**
  (spec-reporter count, not just dots). Matches the normal run. The value-comparison refinement
  holds across the whole suite.

## Design decision — ACCEPTED

The value-comparison-over-recency divergence (throw only when a strictly-newer same-attr context
resolves a *differing* value) is the precise "observable wrong-row" condition and correctly
tolerates wider projections that legitimately re-carry a source attr with the same value. The
mild detection weakening (a stale shadow whose stale/current values happen to coincide *for that
read* is benign and not flagged; a differing-value read of the same bug trips it) is sound.

## Minor — fixed inline this pass

- **Blob reference-equality false positive** (tripwire). The shared-column `row[col] ===
  winnerVal` is reference equality for `Uint8Array`, so two distinct blob objects with identical
  bytes would false-positive (test-mode only, never observed). Per tripwire rules, recorded as a
  `NOTE:` at the exact comparison site in `strict-fork.ts` pointing at `compareSqlValues` as the
  fix if it ever trips — not filed as a ticket.
- **Doc field-name drift.** `docs/runtime.md` called the per-descriptor epoch `lastTouchEpoch`;
  the code field is `epoch` (ungreppable mismatch). Aligned the doc to `epoch`.

## Major — none

No findings warranting a new fix/plan/backlog ticket. The mirror **child-shadows-operator**
direction remains deliberately out of scope (recency can't distinguish a forgotten `reactivate()`
from a correct newest write) and is already tracked in
`backlog/debt-context-shadow-reactivate-direction.md` (confirmed present).

## Tripwires recorded

- Blob `===` false-positive → `NOTE:` at the comparison site in `strict-fork.ts` (added this pass).
- Per-read cost is O(live contexts carrying the attr) → `NOTE:` already present at the
  `resolveAttribute` call site by the implementer.

## Gates

- `yarn lint` (eslint + test-file typecheck) — clean.
- `yarn test:context-strict` — 6886 passing, EXIT 0.
- `yarn docs:check` — passes (the pre-existing `docs/sql.md` over-ratchet the implementer flagged
  was resolved by the triage commit `b0f5dcdd`; `.pre-existing-error.md` consumed and removed).
- Negative control — tripped as expected then reverted; working tree clean apart from the two
  minor review fixes.
