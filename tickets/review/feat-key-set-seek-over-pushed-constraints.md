---
description: The subquery-driven index lookup used to give up whenever the same query also filtered the table by another indexed column; now the two filters cooperate — the lookup keeps the other filter's seek as its target and re-applies that filter above the join.
files:
  - packages/quereus/src/planner/rules/access/rule-key-set-seek.ts
  - packages/quereus/src/planner/rules/shared/access-leaf.ts
  - packages/quereus/src/planner/nodes/key-set-semi-join-node.ts
  - packages/quereus/src/planner/optimizer.ts
  - packages/quereus/test/optimizer/key-set-seek.spec.ts
  - packages/quereus/test/vtab/key-set-semi-join-runtime.spec.ts
  - packages/quereus/test/logic/08.4-key-set-semi-join.sqllogic
  - docs/optimizer.md
  - docs/optimizer-rules.md
  - docs/optimizer-retrieve.md
difficulty: hard
---

## What landed

`rule-key-set-seek` now admits an `IndexSeekNode` as the semi join's target — the shape
`where s = 'x' and v in (select …)` with both columns indexed, previously a blanket
decline. The seek is kept as the target UNCHANGED and the predicate its `FilterInfo`
enforces (recorded in `pushedConstraints` by the prereq ticket) is re-applied as a
`Filter` directly above the new `KeySetSemiJoinNode`, inside the peeled wrappers:

```
HashJoin(semi, Project(IndexSeek[s='x']), keySource)
  →  Project(Filter[s='x'](KeySetSemiJoin(IndexSeek[s='x'], keySource)))
```

Runtime: the scan branch runs the leaf's own FilterInfo untouched (the pushed seek,
byte-for-byte today's plan; the Filter is redundant there), the seek branch stamps the
multi-seek over it (the module ignores `s`; the Filter re-applies it). Verified end to
end — see the test inventory below.

### Code changes, by file

- **`rules/shared/access-leaf.ts`** — new `peelToSeekableAccessLeaf` (admits
  `IndexSeekNode`); `peelToAccessLeaf` re-implemented on top of it by rejecting the seek
  case, so `index-nested-loop.ts` keeps declining on seeks with zero behaviour change.
- **`nodes/key-set-semi-join-node.ts`** — `KeySetTargetNode` widened to include
  `IndexSeekNode`; `withChildren` guard matches; `seekPreservesTargetOrder` doc states
  why a seek target is always false (no code change needed — the `instanceof
  IndexScanNode` test already returns false).
- **`rules/access/rule-key-set-seek.ts`** — `admitLeaf` split into the unchanged
  every-row-walk arm and a new `admitSeekLeaf` arm carrying the five ticket gates
  (limit/offset, non-empty `pushedConstraints` combining to a predicate via the exported
  `combineResidualExpressions`, no relational node in that predicate, uncorrelated
  subtree, `orderingLoadBearing === false`). Returns `{ leaf, residual? }`; the rule
  wraps the new node in `new FilterNode(leaf.scope, keySetJoin, residual)` before
  `rebuildChain` when a residual exists. `probeModuleCosts`' third probe replaced by the
  displaced-plan baseline (`leaf.filterInfo.indexInfoOutput.estimatedCost` for a seek,
  `ask([])` for a walk — existing arms keep today's numbers exactly);
  `interpolateBreakEven` renamed its parameter to `baselineCost` and carries the ticket's
  approximation `NOTE:` (re-applied predicate's per-row cost uncharged, bounded by key
  count). Header decline list rewritten.
- **`optimizer.ts`** — `key-set-seek` registration comment updated ("over an
  every-row-walk leaf — or over an IndexSeek whose pushed predicate the rule re-applies").
- **Docs** — `optimizer.md` (IN-pipeline paragraph), `optimizer-rules.md` (rule bullet:
  seek-arm gates + seek-baseline break-even), `optimizer-retrieve.md` (Seek provenance
  now names this rule as the first consumer).
- **No emit changes**, as the ticket predicted: `emitSeqScan` already accepts
  `IndexSeekNode` (seek keys ride as instruction params, resolved into `args` before the
  override hook runs) and `stampMultiSeek` needed no sanitizing — verified by test, not
  by reading (below).

## Deviation from the ticket: a floating-point epsilon in the break-even

The ticket's reachability claim ("the motivating query fires on the memory module")
**did not hold as written**, for a reason worth understanding: the memory module prices
a k-key runtime-set seek and a k-row literal equality seek with ONE formula
(`AccessPlanBuilder.eqMatch`: `0.5 + 0.3k`), so a pushed single-row equality baseline
(cost 0.8) lands EXACTLY on the interpolation line at k = 1. Exact arithmetic gives
break-even exactly 1 (accept at the tie); IEEE subtract-then-divide produced
0.9999999999999998, floored to 0 — decline. Added `BREAK_EVEN_EPSILON = 1e-9` inside
`interpolateBreakEven` before the floor, with a comment explaining exactly this tie. It
changes existing walk-arm behaviour only when the true break-even sits within 1e-9 below
an integer, i.e. only at ties, where taking the cost-equal seek is harmless. Reviewer
should sanity-check they agree this is tie-restoration, not gate-widening.

Consequence: with stock memory costs an equality-pushed target accepts with
`breakEvenKeys = 1` (runtime seeks only a 1-key set; larger sets take the scan branch =
the pushed seek). A range-pushed target (`pk > 1`) gets break-even ≈ 416 and seeks
realistically. The plan-shape rewrite is what matters for the motivating query; the
runtime seek branch is exercised with doctored costs in the runtime spec.

## The four "if constructible" decline cases

- **Pushed limit/offset on a seek leaf** — NOT constructible, as the ticket suspected:
  `monotonic-limit-pushdown`'s peel cannot cross a join, so no leaf under a semi join
  carries one. Gate 1 is defensive and has no direct test.
- **Absorbed-Sort seek leaf (`orderingLoadBearing`)** — CONSTRUCTIBLE, and tested:
  `select pk, s from big where s >= 'a' and v in (select id from small) order by s`
  plans a range seek on `idx_s` with the Sort absorbed (no SortNode in the plan,
  `orderingLoadBearing === true` asserted). The rule declines, the hash semi join
  survives, and rows arrive in the absorbed order. The fixture problem the ticket
  flagged as shared with the prereq did not materialize.
- **`breakEvenKeys < 1`** — NOT producible by stock memory costs (the equality baseline
  is a tie, see above; range baselines are expensive). Built with a doctored module in
  the runtime spec (`SeekWinsModule`: pushed-seek cost 5 vs two-key seek 502) — the same
  doctoring idiom the file already used, not a new stub pattern.
- **Correlated seek leaf (gate 4)** — NOT built. Constructing a semi join whose probe
  side peels to an `index-nested-loop`-minted correlated seek requires a lateral-shaped
  outer join around the semi join and I could not produce it from SQL in reasonable
  time. The gate is exercised by no test; it is one `isCorrelatedSubquery` call, the
  same predicate `admitJoin` already applies to the key source.

## Memory-module reachability (the ticket's two claims)

- `where s = 'x' and v in (…)` (single-column secondary equality) **fires** — with the
  epsilon; see the deviation section. `orderingLoadBearing` is false as predicted.
- `where pk > 1 and v in (…)` (primary-key range) **fires** as predicted; the existing
  spec case *"declines when the leaf already carries a pushed constraint"* was rewritten
  into an acceptance with structural assertions (target is the range `IndexSeek`, a
  `Filter` sits with `filter.source === keySetJoin`, and the Filter's predicate is the
  exact recorded `sourceExpression` object).
- Bonus shape pinned: `where pk > 1 and pk in (…)` arrives as a MERGE semi join and
  declines (seek target can never satisfy `seekPreservesTargetOrder`) — the streaming
  merge join survives. Tested.

## Test inventory

`test/optimizer/key-set-seek.spec.ts` (+8 cases, 1 rewritten):
- Motivating acceptance (`s`/`v` both indexed): one KeySetSemiJoin, zero hash joins,
  target is the `idx_s` seek, Filter directly above the node carrying the recorded
  predicate; pushdown on `idx_v`.
- Delete + update forms of the same shape (Filter present in both).
- Absorbed-Sort seek decline (see above), merge-arm seek decline, seek-column ==
  pushed-column row correctness.
- `stampMultiSeek` extended with a seek-derived base: fields the module runtimes read
  (`idxStr`, `constraints`, `args`, `accessPath`, `aConstraintUsage`, `orderByConsumed`)
  equal the literal-IN arm; every stamped field additionally equals the
  full-scan-base stamp (base independence — no seek residue). **Nuance for review:**
  `indexInfoOutput.nConstraint`/`aConstraint` could NOT be asserted against the literal
  arm because `makeIndexFilterInfo` leaves them at the full-scan base's `0`/`[]` while
  `stampMultiSeek` populates them — a pre-existing, base-independent divergence in
  fields no module runtime reads. Asserted base-independence instead.
- Rewritten acceptance for `pk > 1 and v in (…)`.

`test/vtab/key-set-semi-join-runtime.spec.ts` (+5 cases, doctored `SeekBaselineModule`
with break-even pinned at 6 against the seek baseline; the eq-cost doctor is scoped to
the `s` column so index-nested-loop's synthesized join-key probes see stock costs):
- **The regression guard**: seek branch forced (3 keys), a row whose key IS in the set
  but whose `s` fails must NOT come back — fails without the re-applied Filter.
- Break-even boundary: 6 keys seek / 7 keys scan (idxStr proves the branch; the scan
  branch's idxStr is the pushed `idx_s` seek, not a full scan), identical rows.
- Scan-count: seek branch pulls ≤ 3 target rows vs the scan branch's 20 (every
  `s='x'` row), same result rows.
- Empty key set: zero rows, target `query()` never called.
- `breakEvenKeys < 1` decline (`SeekWinsModule`), hash semi join survives and answers.

`test/logic/08.4-key-set-semi-join.sqllogic` (new section, runs under memory AND store):
select / delete / update of `s = 'x' and v in (select …)` seeded with a key-set member
that fails `s` and an `s` match outside the key set — both excluded / untouched — plus a
primary-key-range variant. Results-only, no plan assertions.

## Validation

- `yarn build` — clean.
- `yarn lint` — clean (eslint + `tsc -p tsconfig.test.json`).
- `yarn test` (repo root, all workspaces) — green: **8599 passing / 13 pending** in
  `packages/quereus` (up from 8588 at the prereq), all other packages unchanged green.
- **`yarn test:store` WAS run** — green, 8591 passing / 21 pending. (The
  `TransactionCoordinator` savepoint warnings in its output are pre-existing store-mode
  log noise, present before this diff; the suite passes.)

## Known gaps / notes for the reviewer

- Gate 4 (correlated seek) has no test — see above. If you can construct the shape from
  SQL, add it; otherwise the gate stays defensive.
- Gate 1 (pushed limit/offset) unreachable today, untested, kept per ticket.
- The break-even epsilon is the one place this diff touches existing walk-arm numerics.
  All pre-existing break-even tests (doctored `BreakEvenModule`, flat/scan-wins arms)
  pass unchanged; only exact ties behave differently (decline → accept).
- With stock memory costs an equality-pushed target gets `breakEvenKeys = 1`, so the
  runtime seek branch on that shape fires only for 1-key sets. Not wrong — the module's
  own numbers say the pushed seek is nearly free — but if a module with realistic
  equality-seek costs (rows × cost, like the store) shows up, the seek branch fires more
  often. No action needed; recording so the review doesn't rediscover it.
