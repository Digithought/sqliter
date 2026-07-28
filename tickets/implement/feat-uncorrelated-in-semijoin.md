---
description: A WHERE clause that tests a column against the results of a self-contained subquery is currently checked row by row against a lookup set; turn it into a real join instead, so it benefits from the engine's join strategies and cost model.
files:
  - packages/quereus/src/planner/rules/subquery/rule-subquery-decorrelation.ts   # the rule to extend
  - packages/quereus/src/planner/rules/join/equi-pair-extractor.ts               # extractEquiPairs — the hash-ability gate
  - packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts      # picks hash/merge/nested-loop for the new semi join
  - packages/quereus/src/planner/analysis/comparison-collation.ts                # resolveInCollationForNode / resolveComparisonCollation
  - packages/quereus/src/planner/cache/correlation-detector.ts                   # isCorrelatedSubquery, collectExternalReferences
  - packages/quereus/src/runtime/emit/subquery.ts                                # the set-probe path that stays as the fallback
  - packages/quereus/test/plan/subquery-decorrelation.spec.ts                    # plan-shape assertions (currently tautological)
  - packages/quereus/test/vtab/in-subquery-cache-scan-count.spec.ts              # scan-once guarantee
  - packages/quereus/test/logic/07.7-in-subquery-caching.sqllogic                # result assertions that must not move
  - packages/quereus/test/logic/08.1-semi-anti-join.sqllogic
  - docs/optimizer-rules.md
  - docs/optimizer.md
difficulty: hard
---

# Uncorrelated `IN (subquery)` in a WHERE clause becomes a semi join

## Background

`ruleSubqueryDecorrelation` (anchored on `FilterNode`) already turns *correlated*
`EXISTS` / `NOT EXISTS` / `IN` into semi/anti joins. Its `identifyCandidate` gates every
arm on `isCorrelatedSubquery`, so an **uncorrelated** `where col in (select …)` never
matches and stays an `InNode`. At runtime that node takes the set-probe path added by
`quereus-in-subquery-set-probe`: the inner result is materialized once into a `BTree` and
probed per outer row — O(K + N·log K), no statistics required.

That floor is good; it is not the best plan. On the join spine the same shape gets hash /
bloom / merge selection, join reordering, functional-dependency and inclusion-dependency
propagation, and the FK-based semi-join folders (`rule-semi-join-fk-trivial`,
`rule-anti-join-fk-empty`) — none of which an `InNode` can reach.

Verified current behavior (planner probe, memory vtab):

```
SELECT * FROM a WHERE a.x IN (SELECT b.x FROM b)
  FILTER  WHERE a.x in (select b.x from b)
    INDEXSCAN a
    IN  a.x IN (subquery)
      PROJECT SELECT b.x → INDEXSCAN b

SELECT * FROM a WHERE EXISTS (SELECT 1 FROM b WHERE b.x = a.x)   -- correlated, for contrast
  HASHJOIN  SEMI HASH JOIN on [73=76]
    INDEXSCAN a
    INDEXSCAN b
```

The first plan is what this ticket changes into the second.

## Why the rewrite is sound in WHERE position only

`x IN S` is three-valued: it yields NULL (not FALSE) when `x` is NULL, or when there is no
match and `S` contains a NULL. A `FilterNode` predicate collapses NULL to "drop the row",
and a semi join also drops a row with no match. So under WHERE — and **only** under
WHERE — semi join ≡ IN:

| case | `IN` result | filter keeps? | semi join keeps? |
|---|---|---|---|
| `x` matches a member | true | yes | yes |
| no match, no NULLs anywhere | false | no | no |
| no match, `S` has a NULL | NULL | no | no (NULL never equals) |
| `x` is NULL | NULL | no | no |

Projection-position `IN` (`select x in (select …) …`) must keep its three-valued answer and
therefore stays on the set-probe path — this ticket does not touch it. Neither does it touch
`NOT IN`: the parser builds that as `UnaryOp(NOT)` wrapping the `InNode`, so it never
matches the top-level-conjunct shape, and the enclosing NOT over a semi join's two-valued
result would be wrong for NULL-bearing inputs anyway.

## Design

### Do not reuse `extractInCorrelation`

The existing IN arm descends through `Project` / `Alias` nodes to find the inner
`FilterNode`, uses the node *underneath* as the join's right side, and builds the join
condition from `subqueryRoot.getAttributes()[0]`. That descent is what the correlated case
needs (the correlation predicate must be lifted out of the subquery), and it carries two
live defects — filed separately as `backlog/bug-in-decorrelation-inner-shape-unchecked`.

For an uncorrelated `IN` there is **nothing to extract**: the whole join predicate is
`outer.col = innerRoot.col0`. So add a separate, much simpler extraction that uses
`inNode.source` **verbatim** as the join's right side. No descent means the first output
attribute is exposed by construction, no inner predicate can be dropped, and an inner
`LIMIT` / `DISTINCT` / set-op / CTE body is preserved as-is (each of which the descent
would mishandle).

### New extraction

```ts
interface UncorrelatedInRewrite {
  right: RelationalPlanNode;         // inNode.source, verbatim
  condition: ScalarPlanNode;         // outer.col = right.col0
}
```

- `inNode.condition` must be a `ColumnReferenceNode` whose `attributeId` is in the outer
  source's attribute set. (A non-column left side would fail the hash-ability gate below
  anyway, so requiring it up front keeps the decline reason in one place.)
- `right = inNode.source`; take `innerAttr = right.getAttributes()[0]`; bail if absent.
  Build-time validation already guarantees an IN subquery has exactly one column.
- Build the inner reference with its **own** AST — `{ type: 'column', name: innerAttr.name }`
  — not by reusing the outer column's expression. (The correlated arm reuses the outer's
  expression, which is why `EXPLAIN` renders its condition as the nonsense `a.x = a.x`.
  Leave that arm alone; changing it churns golden plans and belongs to the bug ticket.)
- Result node: `new JoinNode(outer.scope, outer, right, 'semi', condition)`. Remaining
  conjuncts of the original filter are re-wrapped in a `FilterNode` above the join, exactly
  as the existing rule does.

Semi/anti joins expose exactly the left side's attributes with unchanged ids
(`buildJoinAttributes` in `planner/nodes/join-utils.ts`), so nothing above the filter needs
to be rebuilt.

### Gates — every one declines to `null`, leaving the set-probe path intact

The set-probe path is the safety net. Whenever a gate fails, the query still runs with the
O(K + N·log K) floor; the only loss is the better plan.

- **Uncorrelated.** `isCorrelatedSubquery(inNode.source) === false`. A correlated source
  keeps taking the existing correlated arm.
- **Pure and deterministic.** Mirror the runtime set-probe's own admission test so the two
  paths accept the same shapes: no side effects (`PlanNodeCharacteristics.subtreeHasSideEffects`
  — the rule already checks this) and `isDeterministic`. A non-deterministic inner must keep
  its per-outer-row evaluation semantics.
- **Hash-ability (the floor guardrail).** Run the synthesized condition through
  `extractEquiPairs(condition, leftAttrIds, rightAttrIds)` — the same helper
  `rule-join-physical-selection` will use — and require a non-null result with exactly one
  pair and no residual. This is what guarantees the inner side is materialized once rather
  than re-driven per outer row (see the guardrail note below).
- **Collation agreement.** `resolveInCollationForNode(inNode)` and
  `resolveComparisonCollation(condition.getType(), innerAttr.type)` must both resolve (not
  `conflict`) and must resolve to the **same** collation name. `inRhsTypes` already reduces
  an IN-subquery's right-hand side to `[source.columns[0].type]`, so the two calls see the
  same operand pair and should always agree; assert it rather than assume it, because a
  divergence would silently change which rows match.

### Guardrail: the O(N×K) shape must stay unreachable

`ticket quereus-in-subquery-set-probe` bought a worst-case floor; this rewrite must not sell
it back. Two facts make that hold, and the implementation should encode both:

1. The hash-ability gate guarantees `ruleJoinPhysicalSelection` reaches its cost comparison
   with a usable equi-pair (`extractEquiPairs` non-null is that rule's only structural
   precondition).
2. With the current constants (`COST_CONSTANTS.NL_JOIN_PER_OUTER_ROW = 1.0`,
   `NL_JOIN_PER_INNER_ROW = 0.1`, `HASH_JOIN_BUILD_PER_ROW = 0.8`,
   `HASH_JOIN_PROBE_PER_ROW = 0.4`), nested loop can only win when the **outer** is tiny:
   `nl = L + 0.1·L·K` beats `hash = 0.8·min + 0.4·max` only around `L ≤ 2`. A one-row outer
   scanning the inner once is not a cliff. The dangerous quadrant — large N *and* large K —
   is always won by hash by a wide margin (at 100 × 100: 1100 vs 120).

Fact 2 is a property of tuning constants, not a structural guarantee, so pin it with a test
(below) rather than trusting the arithmetic to survive future retuning. Do **not** try to
force the physical algorithm from the decorrelation rule; that would duplicate cost
authority in two places.

Note also that if nested loop *is* chosen, `rule-nested-loop-right-cache` wraps the
uncorrelated right in a `CacheNode` whose abandon threshold is the subject of
`backlog/bug-cache-threshold-abandon-cliff`. That is only reachable in the tiny-outer
quadrant here; record it as a `NOTE:` at the gate, not as a new ticket.

## Edge cases & interactions

Each of these needs a test; a case named here is a test written up front.

**NULL and emptiness**
- `x` NULL, inner non-empty → row dropped (matches `IN`).
- inner contains NULLs, `x` matches a non-NULL member → row kept.
- inner contains NULLs, `x` matches nothing → row dropped.
- inner empty → no rows survive.
- inner all-NULL → no rows survive.

**Shape**
- Duplicate values in the inner must not fan the outer out — semi join emits each left row
  at most once. Assert row counts, not just membership.
- Inner with its own `WHERE`, with `DISTINCT`, with `LIMIT`, with `ORDER BY`, a `VALUES`
  list, a set-op (`union` / `union all`), and a CTE reference — all used verbatim as the
  right side; results must equal today's.
- Inner whose single output column is computed (`select b.x + 1 from b`) — the verbatim
  right side handles this; assert it rewrites *and* returns the right rows. (This is the
  exact shape that crashes on the correlated arm today.)
- Two IN conjuncts in one WHERE (`where x in (S1) and y in (S2)`) — the rule rewrites the
  first and re-wraps the rest in a `FilterNode` above the join; the pass must then rewrite
  the second against the join as its outer. Assert two semi joins.
- Mixed correlated + uncorrelated IN conjuncts in one WHERE.
- Shapes that must **not** rewrite: `where not (x in (select …))`, `where x not in (select …)`,
  `where (x in (select …)) or z = 1`, `where (x in (select …)) is null`,
  `select x in (select …) from a` (projection position), a non-column left side
  (`where x + 1 in (select …)`).

**Types and collation**
- `NOCASE` outer column against a `BINARY` inner column and the reverse — same rows as
  before the rewrite (the lattice resolves one collation for both paths).
- Integer outer against REAL inner: `a.i IN (select b.r …)` currently matches `1` against
  `1.0`; verified that the hash-join key path agrees (both normalize numerics). Pin it.
- Text inner against integer outer (`a.i IN (select t.s …)` where `t.s` holds `'1'`)
  currently returns **no rows** — a known engine-wide divergence between `IN` and `=`
  (`backlog/bug-numeric-text-coercion-skips-in-and-case`). The synthesized `=` is built in
  the optimizer and so does **not** get the build-time cross-type cast that a written `=`
  gets, which is why the rewrite preserves the current answer. Pin the current answer so a
  future coercion fix moves both paths together rather than silently splitting them.
- Semantic-ordering types (`TIMESPAN` on both sides): `extractEquiPairs` admits the pair
  only when both sides declare the same semantic-ordering logical type, and `emitBloomJoin`
  canonicalises those keys with the same `semanticKeyTransform` the set probe uses. Assert
  `'PT1H'` still matches `'PT60M'`. A mixed pair (one side `TIMESPAN`, one side `TEXT`) is
  declined by the gate and keeps the set-probe path.

**DML**
- `DELETE … WHERE x IN (SELECT …)` and `UPDATE … WHERE x IN (SELECT …)` — the semi join
  becomes the mutation's source; the correlated arm already produces this shape under DML,
  so the mutation machinery handles it, but assert row counts and surviving rows.
- Self-referencing `DELETE FROM a WHERE x IN (SELECT y FROM a)`. Today the set probe
  materializes once, giving pre-statement-snapshot semantics (recorded in
  `quereus-in-subquery-set-probe`'s handoff and pinned in
  `test/logic/07.7-in-subquery-caching.sqllogic`). A hash semi join drains its build side
  fully before probing, so the snapshot survives. **Result assertions in that sqllogic file
  must not change.** If they do, the rewrite is wrong — do not edit them to match.

**Rule interactions**
- `rule-semi-join-fk-trivial` and `rule-anti-join-fk-empty` are Join-typed and registered
  after `subquery-decorrelation`, so a newly minted uncorrelated semi join now reaches them.
  Add a case with an FK-backed `IN` and check the fold is correct (this is a plan
  improvement, but verify the answer).
- `rule-join-elimination`, `rule-quickpick-enumeration`, `rule-join-greedy-commute`: a semi
  join's left must remain the driver. Confirm no reordering swaps the sides.
- Attribute-id stability: the rewrite must leave the outer attribute ids untouched
  (`test/optimizer/attribute-id-stability.spec.ts`).

## Tests

- **sqllogic** — extend `test/logic/08.1-semi-anti-join.sqllogic` (or add a sibling
  `08.1.x-uncorrelated-in-semijoin.sqllogic`) with the NULL / shape / type / DML cases above.
  `test/logic/07.7-in-subquery-caching.sqllogic` must pass **unmodified**.
- **Plan shape** — `test/plan/subquery-decorrelation.spec.ts` currently asserts
  `hasJoin || hasIn`, which passes no matter what the planner does. Replace the IN block with
  real assertions: uncorrelated filter-position IN produces a `HashJoin` whose detail says
  `SEMI`; `NOT IN`, projection-position IN, and the OR shape keep an `In` node.
- **Scan-once** — extend `test/vtab/in-subquery-cache-scan-count.spec.ts` (counting module)
  so the rewritten shape still scans the inner source exactly once, including across
  re-executions of a prepared statement.
- **Cost-quadrant guard** — a focused test that the large-N × large-K shape plans as a hash
  (not nested-loop) semi join. This is what protects the floor if the cost constants are
  ever retuned.
- **Perf sentinel** — the existing 10k × 5k SELECT+DELETE case in
  `test/performance-sentinels.spec.ts` must stay inside its bound.
- Regenerate any golden plan JSON under `test/plan/` that contains an uncorrelated
  filter-position IN, and re-check `test/optimizer/cache-rules.spec.ts`.

## Docs

- Rule header comment in `rule-subquery-decorrelation.ts`: it currently states the rule
  handles correlated subqueries only. Rewrite the applicability list and state the
  WHERE-only NULL-collapse argument.
- `docs/optimizer-rules.md` — the `subquery-decorrelation` entry.
- `docs/optimizer.md` and `docs/runtime.md` / `docs/runtime-caching.md` wherever the
  IN set-probe path is described: say which shapes now leave that path and which keep it
  (projection position, `NOT IN`, correlated, non-deterministic, gate declines).

## TODO

- [ ] Add `extractUncorrelatedIn` to `rule-subquery-decorrelation.ts`: bare-column left side
      in the outer, `inNode.source` verbatim as the right side, synthesized `=` with its own
      inner-column AST.
- [ ] Extend `identifyCandidate` to admit an uncorrelated subquery-variant `InNode`,
      distinguishing it from the correlated arm so the two extractions do not mix.
- [ ] Implement the gates: uncorrelated, deterministic, side-effect-free, `extractEquiPairs`
      yields exactly one pair with no residual, and the IN / `=` collation resolutions agree.
- [ ] Wire the new arm into `ruleSubqueryDecorrelation`'s candidate loop; keep the residual
      conjunct re-wrapping unchanged.
- [ ] `NOTE:` at the gate recording the nested-loop / `bug-cache-threshold-abandon-cliff`
      interaction and why it is confined to the tiny-outer quadrant.
- [ ] Tests per the section above, written before the rule change where practical.
- [ ] Update the rule header comment and the four doc files.
- [ ] `yarn lint`, `yarn build`, `yarn test` (memory) all green; regenerate affected goldens.
      `yarn test:store` is optional here — this ticket changes no module-facing contract.
