description: The query planner works out how many rows a WHERE clause will keep, and a late planning step used to throw that number away for some queries. A final re-derivation step now runs at the end of planning so the number always survives.
files: packages/quereus/src/planner/framework/pass.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/src/planner/rules/predicate/rule-filter-selectivity.ts, packages/quereus/src/planner/nodes/filter.ts, packages/quereus/test/optimizer/filter-selectivity.spec.ts, packages/quereus/test/optimizer/rule-manifest.spec.ts, docs/optimizer.md, docs/optimizer-rules.md, docs/progressive-optimizer.md
----

## What shipped

A new optimization pass, `PassId.FinalEstimates` ('final-estimates', order 37,
bottom-up), between the Materialization advisory (35) and Validation (40).
`rule-filter-selectivity` is registered into it a third time as
`filter-selectivity-final`.

```
ConstantFolding 0 → Structural 10 → Physical 20 → PostOptimization 30
                 → Materialization 35 → FinalEstimates 37 → Validation 40
```

`FilterNode.withChildren` carries a stamped `selectivity` forward only when the
predicate child is the same object, so any pass that rewrites inside a predicate erases
the estimate and `estimatedRows` falls back to the flat `DEFAULT_FILTER_SELECTIVITY`
(0.5). The Materialization advisory runs after both earlier registrations and rebuilds
every path on which it marks a `with` clause for shared materialization or injects a
`CacheNode`; when that path ran through a Filter's predicate, nothing was left to
restore the number. The new pass is the re-derivation point behind every plan-mutating
pass.

Observable change: a `MATERIALIZED`-hinted (or twice-referenced) CTE read from a scalar
subquery in a `where` now stamps the same estimate as the un-hinted spelling of the same
query, instead of reaching emission unstamped.

## Review findings

### Checked and clean

- **Diff read before the handoff summary.** `git show 5e668bac` — pass registration,
  manifest entry, three comment rewrites, tests, docs. No behaviour outside the stamp.
- **Sharing / DAG safety of re-minting after the advisory (the novel risk here — no
  pass previously rewrote the plan behind the materialization advisory).** Traced it:
  a re-stamp mints a new `FilterNode` with the *same* predicate object, so only the
  root-path ancestors are rebuilt, never anything below the Filter. `traverseBottomUp`
  memoizes on the original node id in `context.optimizedNodes`, so a node reached from
  two parents is rebuilt once and stays shared. Confirmed by reading the withChildren
  of every node the advisory's decisions ride on: `CTENode` (`materialize`),
  `RecursiveCTENode` (`materialize`, `tableDescriptor`) and `CacheNode`
  (`strategy`/`threshold`/`eager`) all thread their state through a rebuild, so a
  path rebuilt at pass 37 cannot silently drop a materialization mark.
- **Scope of the fix's effect.** Every cost reader of the stamp — `join-physical-selection`,
  `key-set-seek`, `monotonic-limit-pushdown`, the advisory itself — runs at or before
  pass 35. Nothing between pass 37 and emission reads a Filter's estimate except plan
  reporting (`func/builtins/explain.ts`, `planner/debug.ts`). So the fix buys estimate
  *consistency and reporting accuracy*, not different cost decisions — which is what the
  code comments and `docs/optimizer.md` already say ("its stamp is read only at
  emission", "rules here must be fill-in-only"). The source `fix/` ticket's claim that
  the error "propagates into every cost decision made above it" was the one overstatement;
  it is not repeated anywhere in the shipped code or docs.
- **Progressive/Tier-0 path.** `executeUpTo` is only ever called with `PassId.Structural`
  (`optimizer.ts:1414`), so the new pass does not run in the structural-only tier.
- **No stale pass inventory elsewhere.** `PassId` is referenced outside `pass.ts` /
  `optimizer.ts` only in comments; no other package or doc enumerates the passes.
- **Test-pollution check on the two `updateTuning` negative controls.** `db` is rebuilt
  per test by `beforeEach`, so the disabled-rule sets do not leak to later cases.
- **The `.to.equal(plain.selectivity)` assertion cannot pass vacuously** on two
  `undefined`s — the preceding assertion pins the plain spelling to a number.
- **Lint + tests.** `yarn lint` clean. `yarn test` green: `packages/quereus` 8393
  passing / 13 pending (pre-existing skips, untouched), every other workspace green,
  0 failures. No pre-existing failures surfaced, so no `.pre-existing-error.md` filed.

### Found and fixed in this pass (minor)

- **The static guard was blind to the exact pass shape that caused the bug.** It read
  `RULE_MANIFEST` only, so a plan-mutating *custom-`execute`* pass ordered after 37 —
  the shape `PassId.Materialization` has, with no rule slots for the manifest to show —
  would re-open the hole with the test still green. The implementer left this as a
  tripwire; it is four lines, so it is now built:
  `test/optimizer/rule-manifest.spec.ts` asserts no `STANDARD_PASSES` entry carrying an
  `execute` is ordered after `PassId.FinalEstimates`. Verified the guard actually bites
  by temporarily moving the pass to order 25 — both arms failed with their intended
  messages — then restoring 37.
- **Guard robustness.** `orderOf.get(e.pass) as number` silently classified an unknown
  pass as "not behind" (`NaN > n` is false). Replaced the cast with an
  unknown-means-behind lookup, and split the "FinalEstimates exists" precondition into
  its own case so a missing pass fails loudly rather than neutering the comparison.
- **Comment contradicted the test it cited.** `pass.ts` said "nothing may be registered
  after this pass except read-only checks"; the test rejects *every* entry, read-only or
  not. Reworded to state what is actually enforced and why the bluntness is deliberate.
- **Coverage gap on the multi-relation estimator path.** All three new positive cases
  drive the single-table path over `o`; nothing exercised `collectColumnOrigins` — the
  join path — after a materialization re-mint, even though the rule's header comment
  makes a claim about that walk descending the advisory's new wrappers. Added
  "re-stamps a filter over a JOIN whose predicate the materialization pass re-minted"
  plus its arm in the existing final-only negative control (it goes `undefined` with
  `filter-selectivity-final` disabled, so the new case is pinned to the new mechanism).
- **Docs.** `docs/optimizer.md` Pass 3.7 now states both halves of the guard.
  `docs/progressive-optimizer.md` still said the full optimizer "runs all 5 passes" in
  its rejected-alternatives section — stale since the Materialization pass landed, let
  alone this one; now says "every pass".

### Measured, not left as an assertion

The handoff flagged the extra traversal as "reasoned, not profiled". Measured it: a
scratch spec disabled the pass via `STANDARD_PASSES[…].enabled` before constructing a
`Database`, then timed 2000 `getPlan()` calls per arm, interleaved, after a 200-call
warmup — on (a) the materialization-marked CTE-over-join repro and (b) a worst case
where every Filter is permanently unstampable (un-analyzed table, computed projections),
which is the "fourth `collectColumnOrigins` walk" regression the handoff worried about.
Across three runs the delta ranged −13.6% to +8.6% with no consistent sign, against
~0.9–1.4 ms per optimize. **The pass's cost is below this harness's run-to-run noise
floor (roughly ±10%);** resolving it would need an isolated benchmark, which the repo
has no harness for. The scratch spec was deleted. The existing `NOTE:` in
`rule-filter-selectivity.ts` (memoize the origin map per pass on `OptContext`) remains
the fix if it ever does show up in a profile.

### Filed as tickets

None. Nothing found needed more than the inline fixes above.

### Tripwires (recorded in place, not filed)

- Pre-existing and still live, unchanged by this work: `nodes/filter.ts`
  `NOTE (tripwire)` — a *carried* selectivity was computed against that source's table,
  so a pass that re-sources a stamped Filter (same predicate object, different source)
  would carry a stale estimate, and no re-stamp fires because all three registrations
  decline on an already-stamped Filter. The new pass does not close it; the note says to
  also drop the stamp on `newSource !== this.source` if that shape ever appears.
- `NOTE:` in `rule-filter-selectivity.ts` on the repeated `collectColumnOrigins` walks
  (now up to four for a permanently-unstampable Filter) — kept, with the measurement
  above as its context.

### Judgement calls left as-is

- **`RULE_MANIFEST` is exported solely for the guard test.** The implementer asked for a
  second look. Agreed with the call: the alternatives are exposing `Optimizer.passManager`
  or asserting against the shared-mutable `STANDARD_PASSES` after building a `Database`,
  both of which widen more surface than a read-only manifest export. The export carries a
  comment saying it is for static auditing.
- **The pass holds exactly one rule and nothing enforces that a future context-derived
  cached estimate registers here.** Correct as stated, and not worth a mechanism today —
  `FilterNode.selectivity` is the only such estimate in the tree.
- **Test values are written as compositions (`1/ndv[…]`, `combineConjunctive([…])`)
  rather than pinned literals**, so a bug inside `combineConjunctive` would not be caught
  by these cases. Deliberate and consistent with the rest of the file, which has its own
  direct coverage of the combiner.
- **File sizes** (measured, `wc -l`): `optimizer.ts` 1433, `filter-selectivity.spec.ts`
  1246. Both grew ~25 lines here and both are list-shaped (a manifest; a flat spec), not
  tangled logic. No split warranted by this change.
