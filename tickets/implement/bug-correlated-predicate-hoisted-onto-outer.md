---
description: Adding an ORDER BY to a query whose EXISTS subquery compares columns of different types makes the query fail with a "no row context" error; without the ORDER BY the same query returns the right rows. Root cause found and a fix verified against the full suite.
files:
  - packages/quereus/src/planner/analysis/constraint-extractor.ts          # the fix — extractConstraintsForTable / walkPlanForPredicates
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts      # trySortAbsorbViaIndexOrdering — the caller that turns the bad constraint into a residual
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts   # index-style branch — attaches moduleCtx.residualPredicate as a Filter over the scan
  - packages/quereus/src/planner/building/coercion.ts                      # wrapInCast — the cosmetic `cast(null as integer)` render
  - packages/quereus/test/logic/07.7.5-filter-lost-under-index-order.sqllogic  # pattern to copy for the new sqllogic
  - packages/quereus/test/filter-lost-under-index-order.spec.ts            # pattern to copy for the new plan-shape spec
  - docs/invariants.md                                                     # new OPT-025 entry
  - docs/optimizer-retrieve.md                                             # topic-doc section the invariant links to
difficulty: medium
---

# A correlated subquery's predicate is copied onto the outer relation

## Repro (confirmed at HEAD `2bfe6e89`)

```sql
create table a (id integer primary key, i integer) using memory;
create table t (id integer primary key, s text)    using memory;
insert into a values (1, 1), (2, 2), (3, 3);
insert into t values (1, '1'), (2, '2');

-- works, returns {1, 2}
select a.id from a where exists (select 1 from t where t.s = a.i);

-- same query plus ORDER BY: fails
select a.id from a where exists (select 1 from t where t.s = a.i) order by a.id;
-- Error: No row context found for column s. The column reference must be evaluated
--        within the context of its source relation.
```

## Root cause

The engine's constraint sweep attributes a predicate found *anywhere* in a subtree to
the table it is asked about, without checking that the predicate's own relational input
actually contains that table. A subquery body hangs off a scalar predicate, so the outer
`Filter`'s subtree contains the inner `t.s = a.i`. Asked for constraints on `a`, the sweep
returns that inner predicate as an equality constraint on `a.i` whose value side is
`cast(t.s as integer)`.

Chain of events for the failing query:

1. `ORDER BY a.id` is satisfied by `a`'s primary-key walk, so `ruleGrowRetrieve` takes
   the `trySortAbsorbViaIndexOrdering` path (`rule-grow-retrieve.ts:494`). That path is
   the only caller that sweeps constraints out of a whole subtree rather than out of one
   `Filter`'s own predicate — which is why the bug needs an `ORDER BY`.
2. Its sweep (`extractConstraintsForTable(sort.source, <key of a>)`,
   `rule-grow-retrieve.ts:545`) crosses into the EXISTS body and returns
   `{column: i, op: '=', sourceExpression: cast(t.s as integer) = a.i}`.
   Verified by instrumentation:
   `[DBG] absorb constraints for main.a#43 [ { col: 1, op: '=', src: 'cast(null as integer) = a.i' } ]`
3. The memory module cannot handle that constraint, so the unhandled-constraint loop
   (`rule-grow-retrieve.ts:576-592`) turns its `sourceExpression` back into
   `indexCtx.residualPredicate` on the `Retrieve` over `a`.
4. `ruleSelectAccessPath`'s index-style branch attaches that residual as
   `new FilterNode(scope, physicalLeaf, residualPredicate)`
   (`rule-select-access-path.ts:173-175`) — a `Filter` reading column `s` sitting over
   the scan of `a`, which has no such column. Hence the runtime error.

The cross-type coercion is only how the query *reaches* this path: with matching types
(`t.id = a.i`) `ruleSubqueryDecorrelation` recognises the equi-correlation, rewrites the
EXISTS into a semi join, and no correlated conjunct is left inside a subquery for the
sweep to find. The decorrelation rule is not at fault and needs no change.

Note what is *not* wrong: a constraint whose value side references an outer attribute is
a deliberate, supported feature (`PredicateConstraint.correlated`, used for correlated
seek pushdown into an inner scan). The defect is purely one of attribution — an inner
scope's predicate being attributed to an outer table.

## The fix (prototyped and verified, then reverted — apply it fresh)

Gate the sweep on scope: only visit a predicate if the target table reference sits in
that predicate's own **relational input**. The relational spine is the input; a
relational node reached through a scalar expression is a subquery body, i.e. a different
scope. An inner scan of the target still collects its own correlated predicates, because
the recursion still descends into subquery bodies — it just refuses to let what it finds
there mark an enclosing node's input.

Exact patch that was validated (`packages/quereus/src/planner/analysis/constraint-extractor.ts`):

```ts
import { isRelationalNode } from '../nodes/plan-node.js';   // add to the existing type-only import line

export function extractConstraintsForTable(
	plan: RelationalPlanNode,
	targetTableRelationKey: string
): PredicateConstraint[] {
	const constraints: PredicateConstraint[] = [];
	const tableInfos = createTableInfosFromPlan(plan).filter(
		info => info.relationKey === targetTableRelationKey
	);
	if (tableInfos.length === 0) return constraints;

	walkPredicatesConstraining(plan, targetTableRelationKey, predicate => {
		const result = extractConstraints(predicate, tableInfos);
		const tableConstraints = result.constraintsByTable.get(targetTableRelationKey);
		if (tableConstraints) {
			constraints.push(...tableConstraints);
			log('Found %d constraints for table %s', tableConstraints.length, targetTableRelationKey);
		}
	});

	return constraints;
}

/**
 * Visit every predicate in `plan` that can constrain the table instance
 * `targetTableRelationKey` — i.e. every predicate whose own relational INPUT
 * contains that table reference.
 *
 * A plain "walk everything" sweep is unsound here: a subquery body hangs off a
 * scalar predicate, so `where exists (select 1 from t where t.s = a.i)` puts the
 * inner `t.s = a.i` inside the outer Filter's subtree. Attributing it to `a`
 * turns it into a constraint (and then a residual predicate) on `a`'s access
 * path, which hoists a predicate reading column `s` over a relation that has no
 * such column. The subquery's own scans stay reachable — an inner scan of the
 * target legitimately collects its own correlated predicate — but a predicate is
 * never attributed to a table outside its input.
 *
 * The target is matched on the instance-unique `#<nodeId>` suffix that
 * {@link createTableInfoFromNode} appends, so callers that build the key with a
 * bare table name and callers that schema-qualify it both work.
 *
 * @returns whether the target table reference sits in this node's relational input
 */
function walkPredicatesConstraining(
	plan: PlanNode,
	targetTableRelationKey: string,
	callback: (predicate: ScalarPlanNode) => void,
): boolean {
	if (!plan) return false;

	const idSuffix = `#${plan.id ?? 'unknown'}`;
	let inScope = plan instanceof TableReferenceNode && targetTableRelationKey.endsWith(idSuffix);

	for (const child of plan.getChildren()) {
		const foundBelow = walkPredicatesConstraining(child as unknown as PlanNode, targetTableRelationKey, callback);
		// Only a RELATIONAL child of a RELATIONAL node feeds that node's input. A
		// relational node reached through a scalar expression is a subquery body —
		// a different scope — so what it contains must not put the target in scope
		// here (its own predicates were already collected inside the recursion).
		if (foundBelow && isRelationalNode(child) && isRelationalNode(plan)) inScope = true;
	}

	if (inScope && CapabilityDetectors.isPredicateSource(plan)) {
		for (const predicate of plan.getPredicates() as ReadonlyArray<ScalarPlanNode>) {
			callback(predicate);
		}
	}

	return inScope;
}
```

Two incidental points about this shape:

- Matching the target on the `#<nodeId>` suffix rather than on the whole relation key
  keeps it agnostic to how the caller spelled the relation name — `rule-grow-retrieve`
  and `rule-select-access-path` schema-qualify (`main.a#43`), other sites use the bare
  name (`a#43`). The `#` is included in the compared suffix, so `#4` cannot match `#14`.
- Hoisting `createTableInfosFromPlan(...)` out of the per-predicate callback is a
  by-product: the old code rebuilt the whole table-info list for every predicate visited.

### Blast radius

`extractCoveredKeysForTable` (→ `binding-extractor`) and the two `change-scope` call
sites route through `extractConstraintsForTable`, so they inherit the fix. That closes a
second latent unsoundness in the same spot: a subquery's inner `a.id = 5` could
previously be counted as covering the *outer* `a`'s primary key, claiming ≤1 row for a
relation that has many. It happens to be true for a plain positive `EXISTS` and false
for `NOT EXISTS`, so it was a real (if unreported) wrong-answer risk.

`extractConstraintsAndResidualForTable` (same file) still calls the unguarded
`walkPlanForPredicates` and has the same defect, but it has **no callers anywhere in the
repo**. Either give it the same gate or delete it — do not leave a second unguarded
sweep sitting there. After that, `walkPlanForPredicates` has no remaining callers and
should go too.

### Verification already done

- Repro query returns `{1, 2}` and the `Sort` is still absorbed (plan keeps
  `IndexScan a USING _primary_ ORDER BY 0`, no `sort(` instruction) — so the fix does not
  cost the optimization the absorb path exists for.
- `yarn test` from the repo root: **7981 + 2611 passing, 0 failing, 13 pending** — no
  fallout anywhere, including the plan/golden and optimizer suites.

## Second, separate item: `cast(null as integer)` in EXPLAIN

Confirmed **cosmetic only**, as the fix ticket suspected. `wrapInCast`
(`coercion.ts:153`) synthesizes its `AST.CastExpr` with a `literal null` placeholder for
the `expr` field, and `formatExpression` renders a node from its AST rather than from its
children — so a coerced operand prints as `cast(null as integer)` while the real operand
child is intact. Nothing const-folds a column-dependent `CAST`. Fix by carrying the
operand's own AST:

```ts
	const syntheticExpr: AST.CastExpr = {
		type: 'cast',
		expr: operand.expression,
		targetType,
	};
```

Verified: `BinaryOp#84` then renders `cast(t.s as integer) = a.i`, and `yarn test` stays
fully green with this change applied alongside the main fix (both were validated
together in one run).

## Expected behavior

Both repro queries return `{1, 2}`. More generally: a predicate may only be attributed
to, or placed over, a relation whose input it belongs to. Cross-type comparison semantics
are not at issue — the no-`ORDER BY` form already gets them right.

## TODO

- Apply the `constraint-extractor.ts` patch above (scope-gated `walkPredicatesConstraining`,
  hoisted `createTableInfosFromPlan`).
- Resolve `extractConstraintsAndResidualForTable`: gate it the same way or delete it (no
  callers). Then delete `walkPlanForPredicates` if nothing else uses it.
- Apply the `wrapInCast` AST fix in `coercion.ts`.
- Add `packages/quereus/test/logic/07.7.6-correlated-predicate-scope.sqllogic` — copy the
  header style of `07.7.5-filter-lost-under-index-order.sqllogic`. Cover, each with and
  without `order by` (and `order by ... desc`), asserting equal row sets:
  - the repro's cross-type `exists (select 1 from t where t.s = a.i)`
  - `not exists (...)` over the same shape (the case where hoisting would give a wrong
    answer rather than an error)
  - `a.i in (select ... where <cross-type correlated compare>)`
  - a correlated inner predicate the module *can* handle (`t.id = a.i`) so the
    decorrelating path stays covered
- Add a plan-shape spec (suggest
  `packages/quereus/test/plan/correlated-predicate-scope.spec.ts`, or extend
  `test/plan/subquery-decorrelation.spec.ts`) pinning that the outer scan carries **no**
  `Filter` referencing an inner column, and that the `Sort` is still absorbed. Row-set
  coverage alone would pass again if a later rewrite merely moved the duplicate.
- Add invariant **OPT-025 — A predicate constrains only tables in its own relational
  input** to `docs/invariants.md` (insert between OPT-024 and OPT-030; IDs are never
  reused). `code:` → `constraint-extractor.ts` — `walkPredicatesConstraining`;
  `guard:` → the new plan-shape spec; `doc:` → the new section below. Keep it under 120
  words.
- Add the topic-doc section the invariant links to: a short subsection in
  `docs/optimizer-retrieve.md` near *Supported-only placement policy* explaining the
  constraint sweep's scope boundary and why a correlated value side is fine while a
  foreign-scope predicate is not.
- Run `yarn lint` and `yarn typecheck` (the prototype was validated with `yarn test`
  only), then `yarn test`.
