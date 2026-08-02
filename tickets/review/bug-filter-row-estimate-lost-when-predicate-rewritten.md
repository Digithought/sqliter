description: The query planner worked out how many rows a WHERE clause would keep, then threw that number away when a later step rewrote the condition — so any query with a subquery in its WHERE ended up planned on a crude 50% guess. The planner now works the number out again after the rewrite.
files: packages/quereus/src/planner/optimizer.ts, packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/planner/rules/predicate/rule-filter-selectivity.ts, packages/quereus/test/optimizer/filter-selectivity.spec.ts, docs/optimizer.md, docs/optimizer-rules.md
difficulty: medium
----

## What changed

`FilterNode` carries an optional `selectivity` — the fraction of source rows the `where`
clause is expected to keep. It was stamped once, by `rule-filter-selectivity` in the
Physical pass. `FilterNode.withChildren` drops that stamp whenever the predicate child is a
different object, and the PostOptimization pass routinely re-mints predicates:
`scalar-subquery-cache` wraps an uncorrelated scalar subquery's inner in a `CacheNode`,
which (bottom-up) re-mints every scalar ancestor up to the Filter's predicate. Nothing
re-stamped afterwards, so any plan with a subquery in a `where` reached emission unstamped
and every consumer fell back to `DEFAULT_FILTER_SELECTIVITY` (0.5).

The fix registers the **same rule function a second time**, in `PassId.PostOptimization`
under the distinct id `filter-selectivity-restamp`, placed **first** in that pass's block so
it precedes `filter-conjunct-ordering` (which copies the stamp forward). The Physical
registration is untouched — its stamp is what the physical / PostOptimization cost readers
(`join-physical-selection`, `monotonic-limit-pushdown`, `key-set-seek`, the materialization
advisory) consult, so this is an addition, not a move. The rule's first line
(`if (filter.selectivity !== undefined) return null`) makes the second registration a pure
fill-in: it never overwrites a surviving stamp, and costs one declined call per Filter that
kept one.

Also done:
- Rewrote the stale invariant comment in `FilterNode.withChildren` (it claimed the Physical
  pass was the last rule-bearing pass over Filters). The separate tripwire it carried — a
  *carried* stamp going stale if some pass ever re-sources a stamped Filter without changing
  its predicate — is preserved.
- Rewrote the header doc-comment of `rule-filter-selectivity.ts` to describe both
  registrations.
- `docs/optimizer.md` § "Filter row estimates" now describes the two-pass registration.
- `docs/optimizer-rules.md` gained a full catalogue entry for `ruleFilterSelectivity`
  (both ids, both estimation paths), and the `ruleFilterConjunctOrdering` entry's ordering
  sentence now mentions that the re-stamp is registered ahead of it in the same pass.

## Sequencing note for the reviewer

Most of this landed in commit `74a20a59` ("ticket(fix): bug-fk-alignment-derived-table-indices")
— a prior, interrupted run of this ticket whose tree was swept up by another ticket's commit.
When this run started, `optimizer.ts`, `filter.ts`, `rule-filter-selectivity.ts`,
`filter-selectivity.spec.ts` and `docs/optimizer.md` were already at their final state and
the tree was clean. This run added the `docs/optimizer-rules.md` catalogue entry and ran
validation. **Reviewing the diff of the working tree alone will show only the docs change** —
review `74a20a59` alongside it (`git show 74a20a59 -- packages/quereus/src/planner packages/quereus/test/optimizer/filter-selectivity.spec.ts docs/optimizer.md`).

## Use cases to validate

Fixture (already in `test/optimizer/filter-selectivity.spec.ts`): tables `o` (100 rows) and
`r` (20 rows), both `ANALYZE`d. `ndv` in the spec holds the per-column distinct counts.

- **Filter over a join, subquery conjunct** —
  `select * from o full join r on o.rid = r.id where o.qty = (select max(qty) from r r2) and o.cat = 'a'`.
  The residual Filter must carry `selectivity === combineConjunctive([1 / ndv['o.cat']])` on
  the **first** `optimize()`. The subquery conjunct references an attribute minted *inside*
  the subquery, so `collectColumnOrigins` cannot attribute it — `o.cat = 'a'` is the only
  estimable conjunct.
- **Negative control** — the same query with `filter-selectivity-restamp` in
  `tuning.disabledRules` must leave that Filter's `selectivity` `undefined`. This is what
  pins the assertion to the new registration rather than to some other path.
- **Single-table, stacked Filters** —
  `select * from o where o.qty = (select max(qty) from r r2) and o.cat = 'a'` plans as two
  stacked Filters. The upper one (subquery conjunct) must be re-stamped at `1 / ndv['o.qty']`;
  the lower one (`o.cat` only, never re-minted) must still carry its Physical-pass stamp of
  `1 / ndv['o.cat']`. This is the fill-in-never-clobber regression guard.
- **Idempotence** — re-running `optimize()` on an already-stamped plan must not change the
  stamp.
- **No-subquery plans unchanged** — every pre-existing case in the spec (single-table,
  multi-relation, CTE, view, function-wrapped column, existence-flag join) still passes
  unchanged; the second registration declines on all of them.

## Validation run

- `yarn workspace @quereus/quereus run test --no-bail` → **8322 passing, 13 pending, 2 failing**.
  Both failures are pre-existing and unrelated; see below.
- `yarn lint` → clean (all workspaces).
- `yarn docs:check` → passes (`docs/sync.md` sits inside its grace band, unrelated to this
  ticket; that one is the already-tracked `debt-doc-size-ratchet-red-at-head`).
- No golden plan JSON under `test/plan/` needed regeneration — no current golden query has a
  subquery predicate.

## Known gaps / things a reviewer should push on

- **Two pre-existing failures, recorded in `tickets/.pre-existing-error.md`**:
  `rule-predicate-inference-equivalence.spec.ts:232` (INDEXSEEK delta assertion, `with=2,
  without=2`) and `scalar-agg-decorrelation.spec.ts:393` (HAVING decorrelation produces a
  logical `JOIN` rather than `HASHJOIN`/`MERGEJOIN`). Both were proven independent of this
  ticket by re-planning the exact failing queries with `filter-selectivity` and
  `filter-selectivity-restamp` disabled in every combination — the plans came out
  character-identical. Neither was skipped or loosened. Worth an independent look: the second
  one in particular is a physical-join-selection regression that nobody currently owns.
- **`test-runner.mjs` hardcodes `--bail`**, so the default `yarn test` stops at the first
  failure and hides the rest. Both failures above only surfaced with `--no-bail` appended.
  Anyone validating this branch should use `--no-bail`.
- **Tripwire (parked, not a ticket):** a pass running *after* PostOptimization that re-mints
  a Filter's predicate would drop the stamp again — `PassId.Materialization` (order 35) walks
  `getChildren()`, which includes scalar children, and can wrap a relational node sitting
  inside a Filter's predicate. No query exhibiting this was found; the obvious candidate (a
  CTE shared between two scalar subqueries in one `where`) has nothing estimable to stamp in
  the first place, traced with `DEBUG=quereus:optimizer:rule:filter-selectivity`. Parked as a
  `NOTE:` at the new manifest entry in `planner/optimizer.ts` (~line 911), which also states
  the fix if it ever bites: move the re-stamp behind the materialization pass. If the
  reviewer *finds* such a query, that is a real defect, not a tripwire.
- **The re-stamp re-derives rather than preserves.** The rejected alternative was making
  `withChildren` keep the stamp when the predicate is only cosmetically re-minted; it was
  rejected because `fingerprintExpression` deliberately returns a unique `_SQ:<node id>` for
  subquery-bearing nodes, and because a "skeleton equality" test would have to assume no
  estimator ever reads inside a subquery — not obviously true of `conjunctRelations` for a
  *correlated* subquery. Re-deriving cannot be subtly stale. If the reviewer disagrees, the
  tradeoff is order-independence vs. freshness.
- **`optimize()` is not a fixpoint on these queries** — re-running it on an already-optimized
  plan merges two stacked Filters into one, so tests must not assert "what a second
  `optimize()` produces" as the expected first-pass output. Filed separately as backlog
  `debt-optimize-not-fixpoint-stacked-filters`. The specs here assert against directly
  computed expectations (`combineConjunctive([...])`, `1/ndv`) for exactly this reason.
- **Cost of the second registration is one declined rule call per Filter per plan.** Measured
  only as "the rule's first line returns null"; no profiling was done. The existing `NOTE:` in
  `rule-filter-selectivity.ts` about `collectColumnOrigins` being an O(N·subtree) walk per
  Filter still stands and is untouched — the re-stamp only pays it on Filters that were
  actually re-minted.
