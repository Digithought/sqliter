description: The optimizer fuzz-test suite has five rules that never actually rewrite the queries it generates, so their "disabling the rule doesn't change results" check proves nothing. Reshape the generated queries so each rule fires, and turn the silent warning into a hard failure so this can't rot again.
files: packages/quereus/test/property-planner.spec.ts, packages/quereus/src/planner/rules/predicate/rule-predicate-pushdown.ts, packages/quereus/src/planner/rules/retrieve/rule-projection-pruning.ts, packages/quereus/src/planner/rules/join/rule-join-greedy-commute.ts, packages/quereus/src/planner/rules/subquery/rule-subquery-decorrelation.ts, packages/quereus/src/planner/rules/join/rule-join-key-inference.ts, packages/quereus/src/planner/optimizer.ts
difficulty: medium

## Background

`test/property-planner.spec.ts` → `describe('Semantic equivalence under optimizer rules')`
builds, for each optimizer rule, a fuzzed query and asserts that the result set is the
same whether the rule is enabled or disabled. It counts a rule as *fired* when the enabled
and disabled **plans** differ (`query_plan` op/node_type strings), and `console.warn`s when
a rule fires zero times across 30 runs. Five rules warn today:

```
predicate-pushdown, projection-pruning, join-key-inference,
join-greedy-commute, subquery-decorrelation
```

The equivalence assertion still passes for these — but only *vacuously*, because the plans
are identical either way, so the suite gives them no coverage. `filter-merge`,
`distinct-elimination`, and `scalar-cse` already fire and are genuinely exercised.

The root causes were traced by reading each rule. **Four are query-generator problems** (the
generated shape never satisfies the rule's firing precondition). **One —
`join-key-inference` — is not fixable this way at all** and must be handled separately (see
its section).

## Firing preconditions (verified against rule source)

**`predicate-pushdown`** (`rule-predicate-pushdown.ts`) — anchors on a `FilterNode` and
pushes the predicate *below* a commuting child: `SortNode`, `DistinctNode`, `AliasNode`,
an eligible `ProjectNode`, or into a `RetrieveNode` pipeline. The current shape
`SELECT * FROM t1 WHERE a IS NOT NULL AND id > 0` puts the Filter directly on the Retrieve
boundary, and the predicate is already landed into the Retrieve pipeline during *building*
(grow-retrieve), so enabled and disabled plans are identical. **Fix:** interpose a commuting
node the rule must visibly move the Filter across. Recommended (robust — structural, no data
dependence):

```sql
SELECT * FROM (SELECT DISTINCT a, b FROM t1) sub WHERE a IS NOT NULL
```

Enabled: Filter pushed below the Distinct. Disabled: Filter stays above it → plans differ.
(Distinct is more reliable than an inner `ORDER BY`, which a subquery can strip.)

**`projection-pruning`** (`rule-projection-pruning.ts`) — fires **only** when a `ProjectNode`'s
source is *also* a `ProjectNode` and the outer references a strict subset of the inner's
output attributes. The current shape `SELECT a FROM (SELECT a, b FROM t1) sub` collapses the
inner `SELECT a, b` into the Retrieve during building (grow-retrieve absorbs pass-through
projections), so there is no inner `ProjectNode` for the rule to match. **Fix:** give the
inner projection a *computed* column, which cannot be absorbed into a scan, so the inner
`ProjectNode` survives; have the outer select a strict subset that omits the computed column:

```sql
SELECT a FROM (SELECT a, id + 1 AS e FROM t1) sub
```

Inner Project = {a, e}; outer references only {a} → `e` is pruned. Use `id` (always INTEGER)
for the computed column so it never depends on a randomly-typed extra column.

**`join-greedy-commute`** (`rule-join-greedy-commute.ts`) — swaps an inner join's children
when the right side is the better nested-loop driver: `rightIsSingleton && !leftIsSingleton`,
or `!leftIsSingleton && !rightIsSingleton && rightRows < leftRows` (children `estimatedRows`).
The current generator loads both tables with 20–100 random rows (symmetric), so neither side
is reliably smaller and no swap happens. **Fix:** give the join sides **disjoint** row-count
ranges so the right (`t2`) is always the smaller driver. Add a dedicated data arb for this
rule (do not reuse `singleTableDataArb`, which is 20–100 for both):

- `t1`: many rows (e.g. `minLength: 40, maxLength: 100`)
- `t2`: few rows (e.g. `minLength: 1, maxLength: 6`)

Query stays `SELECT * FROM t1 JOIN t2 ON t1.id = t2.<col>`. With `t2` strictly smaller, the
rule swaps children on every run → plans differ. Result equivalence holds (inner join is
commutative). **Verification checkpoint (see Edge cases):** confirm the swap is *observable*
in `query_plan` op/node_type ordering and isn't normalized away downstream by physical join
selection. If it is not observable, `join-greedy-commute` falls into the same bucket as
`join-key-inference` below — document it and keep it as an equivalence-only check rather than
forcing a plan diff.

**`subquery-decorrelation`** (`rule-subquery-decorrelation.ts`) — anchors on a `FilterNode`
whose predicate has a top-level **correlated** `EXISTS` / `NOT EXISTS` / `IN (subquery)` and
rewrites it into a semi/anti join. The current shape `a IN (SELECT b FROM t2)` is
*uncorrelated*, so `isCorrelatedSubquery` is false and the rule bails. **Fix:** generate a
correlated `EXISTS`. Both tables always have column `a` (extra-col count min is 2, so `a`
always exists) and always have `id`:

```sql
SELECT * FROM t1 WHERE EXISTS (SELECT 1 FROM t2 WHERE t2.a = t1.a)
```

Fires → Filter/Exists collapses to a semi-join → plans differ. Equivalence holds.

**`join-key-inference`** (`rule-join-key-inference.ts`) — **cannot be made to fire by any
generator.** The rule is registered `// Diagnostic-only: never returns a transformed node`
and its body `return null`s unconditionally; it only `log()`s FK→PK detection. Its real
effect flows through `computePhysical` / `CatalogStatsProvider.joinSelectivity` (cost and key
propagation), **not** through the plan tree — so enabling vs. disabling it produces an
identical plan by construction, and the plan-diff "fired" signal can never be non-zero. That
effect is already covered by `test/optimizer/keys-propagation.spec.ts`. **Fix:** remove
`join-key-inference` from the `twoTableRules` disabled-equivalence set entirely, with a code
comment stating *why* (diagnostic-only rule, no plan-observable effect, covered by
keys-propagation.spec.ts). Do **not** leave it in with a suppressed assertion — that reads as
"we forgot", whereas a documented removal is honest.

## Promote the warning to a failure

Once the seven *plan-mutating* covered rules reliably fire (predicate-pushdown, filter-merge,
distinct-elimination, projection-pruning, scalar-cse, join-greedy-commute,
subquery-decorrelation), replace the `console.warn(ruleFireCount === 0)` block with a hard
assertion so future generator drift can't silently re-vacuate the suite:

```ts
expect(ruleFireCount, `Rule '${ruleDef.id}' never fired across ${numRuns} runs — ` +
	`the disabled-rule equivalence check is vacuous for it`).to.be.greaterThan(0);
```

This assertion applies to every rule *remaining* in the two rule arrays. Because
`join-key-inference` is removed (not merely un-asserted), the assertion is uniform — no
per-rule special-casing in the loop. If the `join-greedy-commute` verification checkpoint
shows its swap is not plan-observable, exclude it the same documented way and note it in the
handoff.

## Edge cases & interactions

- **Firing must be deterministic across all 30 runs, not just some.** The `greaterThan(0)`
  assertion tolerates a rule that fires on *any* run, but prefer shapes that fire on *every*
  generated instance so the suite isn't flaky under fast-check's shrinking/seeding. The four
  recommended shapes are structural (predicate-pushdown, projection-pruning,
  subquery-decorrelation) or use disjoint data ranges (join-greedy-commute) precisely so they
  fire unconditionally. Confirm none depends on a randomly-chosen column type or a coin-flip
  row count.
- **grow-retrieve races the rule.** The reason the old shapes were vacuous: building-time
  grow-retrieve absorbs pass-through Filters and Projects into the Retrieve pipeline before
  the rule's pass runs. The computed-column (projection-pruning) and interposed-Distinct
  (predicate-pushdown) shapes exist specifically to defeat that absorption — verify by
  eyeballing one enabled `query_plan` that the inner `ProjectNode` / the above-Distinct
  `FilterNode` actually survives to the rule's pass.
- **filter-merge vs predicate-pushdown.** Two stacked Filters can be merged before pushdown
  runs. The Distinct interposed between the outer Filter and the scan prevents a merge from
  erasing the pushdown opportunity; don't collapse the subquery.
- **Column availability.** `a` exists on every generated table only because `tableSpecArb`'s
  extra-col count is `min: 2`. If a future edit lowers that minimum, the EXISTS/decorrelation
  and Distinct shapes break — keep the shapes on `a`/`id`, or guard on `cols.length`.
- **join-greedy-commute swap observability** (verification checkpoint above): a swapped child
  order must show up in the `query_plan` op/node_type stream. If physical join selection
  re-canonicalizes child order so the diff vanishes, the plan-diff signal is a false negative
  for this rule — handle it the documented-exclusion way, don't loosen the assertion for
  everyone.
- **NULL data.** `DISTINCT a, b` and `EXISTS ... t2.a = t1.a` run over columns that can be
  NULL (extra columns are declared `null`). Equivalence must still hold — the rules commute
  with NULL selection / two-valued EXISTS semantics — but sanity-check the result sets match
  on a NULL-heavy generated instance.
- **Skewed-data sub-suite** (`describe('Semantic equivalence with skewed data')`) only covers
  `predicate-pushdown` and `distinct-elimination` and does **not** track fire counts — leave
  it as-is; it's an equivalence-only check, not part of the fire-coverage contract. Just make
  sure the `predicate-pushdown` shape change (if the skewed suite shares a `queryFn`) doesn't
  break its query. The skewed suite defines its own `queryFn`s inline, so it's independent —
  confirm you're only editing the first `describe` block's rule arrays.

## TODO

- Add a dedicated asymmetric two-table data arb for `join-greedy-commute` (t1 large, t2
  small, disjoint ranges); keep the existing symmetric arb for any other two-table rule.
- Rewrite the four generator `queryFn`s (and the join-greedy `dataArb`) per the shapes above:
  - `predicate-pushdown` → `SELECT * FROM (SELECT DISTINCT a, b FROM t1) sub WHERE a IS NOT NULL`
  - `projection-pruning` → `SELECT a FROM (SELECT a, id + 1 AS e FROM t1) sub`
  - `join-greedy-commute` → keep the join query, swap in the asymmetric data arb
  - `subquery-decorrelation` → `SELECT * FROM t1 WHERE EXISTS (SELECT 1 FROM t2 WHERE t2.a = t1.a)`
  - (use the first non-id column names via the existing `cols`/`cols2` helpers where a shape
    references a second column, but the shapes above deliberately lean on `a`/`id`/`b`, which
    always exist for the min-2-extra-col specs — pick real column names, don't hardcode past
    the guaranteed set)
- Remove `join-key-inference` from `twoTableRules` with an explanatory comment (diagnostic-only;
  no plan-observable effect; covered by `test/optimizer/keys-propagation.spec.ts`).
- Replace the `console.warn` fire-count block with `expect(ruleFireCount).to.be.greaterThan(0)`.
- Run `yarn workspace @quereus/quereus test --grep "Property-Based Planner"` (stream with
  `2>&1 | tee /tmp/prop.log`) and confirm: zero warnings, every remaining rule asserts
  `ruleFireCount > 0`, all equivalence assertions green.
- Run `yarn lint` (the quereus lint type-checks the spec file too) to catch signature drift.
- If the `join-greedy-commute` swap turns out not to be plan-observable, exclude it the same
  documented way and record it in the review handoff's gaps section.
