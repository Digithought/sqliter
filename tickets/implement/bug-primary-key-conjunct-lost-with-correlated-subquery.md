---
description: A WHERE condition on a table's primary key is silently ignored when the query also has a sub-select that refers back to the outer table and at least one other condition — a SELECT returns rows it should have excluded, and a DELETE with the same WHERE destroys them.
prereq:
files:
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts
  - packages/quereus/src/planner/rules/shared/index-style-context.ts
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts
  - packages/quereus/src/planner/rules/predicate/rule-predicate-pushdown.ts
  - packages/quereus/test/logic/07.7.5-filter-lost-under-index-order.sqllogic
  - packages/quereus/test/plan/predicate-pushdown.spec.ts
  - packages/quereus/docs/optimizer.md
repro: verified
difficulty: medium
---

**Filed from downstream 2026-08-07**, reproduced and root-caused in this repo on 2026-08-07.
SiteCAD (`../SiteCAD_branch`) carries a workaround and tracks this as
`tickets/blocked/quereus-primary-key-conjunct-lost-with-correlated-subquery.md`.

# Symptom

```sql
create table o (id integer primary key, flag integer);
insert into o values (1, 1), (2, 1), (3, 1);

select id from o where flag = 1 and id = 2
  and exists (select 1 from o o2 where o2.id = o.id);
-- WRONG: [1, 2, 3]. `id = 2` never runs. Correct answer is [2].

delete from o where flag = 1 and id = 2
  and exists (select 1 from o o2 where o2.id = o.id);
-- WRONG: deletes every row.
```

Verified against the working tree (plain in-memory `Database`, memory tables, no plugins,
no parameters). The same shape under `update` corrupts rows the `where` excluded.

# Root cause — one site

`fallbackIndexSupports` in `packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts`.

A `RetrieveNode` can carry an `IndexStyleContext` on its `moduleCtx` (see
`planner/rules/shared/index-style-context.ts`). Once it does, that context is the **sole
authority** for what the table access enforces — `ruleSelectAccessPath` builds the physical
leaf from `moduleCtx.accessPlan` + `moduleCtx.residualPredicate` and never reads
`RetrieveNode.source`. Both of those files say so explicitly.

`ruleGrowRetrieve` may fire a **second** time on the same Retrieve, when a later rule drops a
new `Filter` on top of one that is already equipped. It calls `fallbackIndexSupports`, which
builds a **fresh** `BestAccessPlanRequest` from the incoming node alone, and returns a **fresh**
`IndexStyleContext` that *replaces* the committed one wholesale. Anything the displaced context
was enforcing — its seek keys (`originalConstraints`) and its `residualPredicate` — is dropped
on the floor, because `source` cannot make up the difference.

Today the request is seeded like this (the `Sort` / `LimitOffset` arms leave `filters` empty
entirely):

```ts
plannerConstraints = extraction.allConstraints;   // ← the NEW Filter only
request.filters = plannerConstraints;
```

The re-probe is nevertheless *accepted*, because the existing no-clobber guard re-requests the
committed plan's ordering (`equippedOrdering` → `request.requiredOrdering`), and the module
happily returns an ordering-only index walk that satisfies it. `providesOrdering` alone is
enough to pass the benefit gate, so a plan that handles **zero** filters replaces a plan that
was seeking a primary key.

There is already a no-clobber guard for the **ordering** channel of the same context
(lines ~374-388, `orderingMatches`, from `fix/quereus-reverse-order-sort-absorb-desync`).
The **constraints** channel never got one. That is the whole defect.

## The observed rule sequence (traced, memory module)

For `where flag = 1 and id = 2 and exists (select 1 from o o2 where o2.id = o.id)`:

| # | rule | effect |
|---|---|---|
| 1 | `grow-retrieve-Filter` | equips Retrieve with an **eqSeek on `id = 2`**; residual `exists(…) and flag = 1` is hoisted **above** the Retrieve (it contains a subquery, so `predicateContainsSubquery` moves it out of the ctx) |
| 2 | `subquery-decorrelation` | rewrites `exists(…)` into a SEMI JOIN, leaving `Filter(flag = 1)` above the join |
| 3 | `join-predicate-pushdown` | pushes `flag = 1` down onto the join's left branch — landing it **directly above the already-equipped Retrieve** |
| 4 | `grow-retrieve-Filter` | re-probes with `filters = [flag = 1]` only → new ctx = ordering-only `IndexScan`, residual `flag = 1`. **`id = 2` is gone.** |
| 5 | `select-access-path` | physicalizes from the new ctx: `Filter(flag = 1)(IndexScan o USING _primary_)` |

Step 1 is what makes a correlated sub-select necessary to trigger this: an *uncorrelated*
sub-select leaves the residual as one `Filter` that still holds `flag = 1`, so no bare
`Filter(flag = 1)` is ever created directly over the Retrieve and step 4 never happens. Two
conjuncts likewise never produce a leftover non-subquery conjunct to push back down.

## Relationship to `bug-filter-conjunct-lost-under-index-order` (complete)

Same observable class — a conjunct silently dropped, every row returned — and the same two
mutually-exclusive channels. That ticket closed the `rule-predicate-pushdown` hole (a rule
writing a predicate into a committed Retrieve's `source`, where it never executes). This is the
sibling hole in the *other* direction: `ruleGrowRetrieve` **replacing** the committed context
without carrying its contents forward. The existing `isIndexStyleContext` guard in
`rule-predicate-pushdown` is reached and does its job here — it is simply not the leak.

# Fix (prototyped and verified in this repo, then reverted for you to land properly)

Union the committed context's constraints into the re-probe, and carry its residual forward.
Because the residual is recomputed from the new plan's `handledFilters` over the **full** union,
correctness does not depend on the module answering the second probe the same way it answered
the first: anything the new plan declines is residualized instead.

The patch below is the exact prototype that turned the whole probe matrix green and passed
`yarn test` (9020 + all workspaces, zero failures). Land it as the starting point, not
verbatim gospel — reviewer notes below.

```diff
@@ function canTranslateToIndexConstraints ... (add helper above fallbackIndexSupports)
+/**
+ * Drop constraints that repeat one already present. A re-grow unions the committed
+ * context's constraints with those re-extracted from the incoming Filter, and the
+ * same predicate node commonly appears in both.
+ *
+ * Identity is (sourceExpression, columnIndex, op) — NOT `sourceExpression` alone:
+ * a BETWEEN decomposes into a lower and an upper bound that share one source node,
+ * and collapsing those to a single constraint would drop half the range.
+ */
+function dedupeConstraints(constraints: PredicateConstraint[]): PredicateConstraint[] {
+	const seen = new Map<ScalarPlanNode, Set<string>>();
+	const out: PredicateConstraint[] = [];
+	for (const c of constraints) {
+		if (c.sourceExpression) {
+			const key = `${c.columnIndex}:${c.op}`;
+			let roles = seen.get(c.sourceExpression);
+			if (!roles) {
+				roles = new Set();
+				seen.set(c.sourceExpression, roles);
+			}
+			if (roles.has(key)) continue;
+			roles.add(key);
+		}
+		out.push(c);
+	}
+	return out;
+}

@@ fallbackIndexSupports, just before `const request: BestAccessPlanRequest = {`
+	// Constraints the CURRENTLY COMMITTED plan is enforcing. A re-probe replaces
+	// moduleCtx wholesale, so any of these left out of the new request is silently
+	// dropped (`Retrieve.source` is not an execution channel once a ctx exists).
+	const committedConstraints: PredicateConstraint[] =
+		isIndexStyleContext(existingCtx) ? [...existingCtx.originalConstraints] : [];
+	const committedResidual: ScalarPlanNode | undefined =
+		isIndexStyleContext(existingCtx) ? existingCtx.residualPredicate : undefined;

@@ the Filter arm
-		plannerConstraints = extraction.allConstraints;
+		plannerConstraints = dedupeConstraints([...committedConstraints, ...extraction.allConstraints]);
 		request.filters = plannerConstraints;
 		residualPredicate = extraction.residualPredicate;
-		log('Extracted %d constraints from Filter', plannerConstraints.length);
+		log('Extracted %d constraints from Filter', extraction.allConstraints.length);

@@ the Sort arm, after request.requiredOrdering is set
+		plannerConstraints = committedConstraints;
+		request.filters = plannerConstraints;

@@ the LimitOffset arm, after request.limit / request.offset are set
+		plannerConstraints = committedConstraints;
+		request.filters = plannerConstraints;

@@ the residual-assembly block
-	if (plannerConstraints && plannerConstraints.length > 0) {
+	{
 		const unhandledExprs: ScalarPlanNode[] = [];
-		for (let i = 0; i < plannerConstraints.length; i++) {
-			if (!accessPlan.handledFilters[i] && plannerConstraints[i].sourceExpression) {
-				unhandledExprs.push(plannerConstraints[i].sourceExpression);
+		for (let i = 0; i < (plannerConstraints?.length ?? 0); i++) {
+			if (!accessPlan.handledFilters[i] && plannerConstraints![i].sourceExpression) {
+				unhandledExprs.push(plannerConstraints![i].sourceExpression);
 			}
 		}
+		if (committedResidual) unhandledExprs.push(committedResidual);
```

## Things the prototype learned the hard way

- **De-duplication is required, not cosmetic.** Without it the union double-lists a constraint
  the committed context and the new Filter both mention. The module claims the first and the
  duplicate falls through to `reattachUnconsumedConstraints`, producing `s >= 'a' and s >= 'a'`
  — harmless for rows, but it shifted a cost estimate enough to flip a hash semi join into an
  index-nested-loop and broke `test/optimizer/key-set-seek.spec.ts` →
  *"declines an absorbed-Sort seek leaf (orderingLoadBearing)"*.
- **De-duplicating on `sourceExpression` alone is wrong.** A `BETWEEN` decomposes into two
  constraints that share one source node; collapsing them dropped the upper bound and
  `delete from cow_band where id between 51 and 150` deleted everything from 51 up
  (`test/logic/01.8.1-delete-range-cow.sqllogic:71`). Key on `(sourceExpression, columnIndex, op)`.
- The `Sort` / `LimitOffset` arms need the same treatment as `Filter`. They are not known to be
  reachable over an already-equipped Retrieve today (the structural pass is top-down, so a
  `LimitOffset` above a `Filter` is visited before the Filter grows), but they clobber
  identically if they ever are — and leaving them asymmetric is how this bug got written twice.

# Expected behaviour to pin

- A `where` conjunct constraining the primary key applies regardless of how many other conjuncts
  there are and whether any of them contains a correlated sub-select.
- The same `where` under `delete` / `update` touches exactly the rows the `select` returns.
- General invariant, since this is the second instance of the class: **adding a conjunct must
  never widen the result set.**

# Test surface

`test/logic/07.7.5-filter-lost-under-index-order.sqllogic` pins the sibling instance by
comparing each `order by` variant against the same query without one. The analogue here is a
**conjunct-monotonicity sweep**: build a `where` from a key conjunct, a non-key conjunct and a
correlated-sub-select conjunct, and assert every superset's result is contained in every
subset's. That covers both instances and every shape between them, and it is the rung of the
ladder above a point regression test — file it as a real test, not just the specific query.

Shapes verified failing before the fix and passing after (all against `o(id integer primary
key, flag integer)` seeded `(1,1),(2,1),(3,1)`, expecting `[2]` unless noted):

```
flag = 1 and id = 2 and exists (select 1 from o o2 where o2.id = o.id)
flag = 1 and id = 2 and exists (select 1 from o o2 where o2.flag = o.flag)
flag = 1 and id = 2 and (select count(*) from o o2 where o2.id = o.id) = 1
flag = 1 and id in (2) and exists (…)
exists (…) and flag = 1 and id = 2                      -- sub-select written first
flag = 1 and id between 2 and 2 and exists (…)
flag = 1 and id >= 2 and exists (…)                     -- expects [2,3]
E.flag = 1 and E.id = 2 and (select count(*) from o T where T.id = E.id) = 1
delete / update with the first shape                    -- must touch only id 2
```

Already-correct control shapes that must stay correct (they exercise the neighbouring paths):
`id = 2 and exists (…)` (two conjuncts), `flag = 1 and id = 2 and 1 = 1`,
`flag = 1 and id = 2 and (select count(*) from o o2) = 3` (uncorrelated),
`id = 2 order by id [desc]`, `id = 2 limit 5`, `flag = 1 and id = 2 order by id`.

# TODO

- Apply the `fallbackIndexSupports` change above: capture `committedConstraints` /
  `committedResidual` from `existingCtx`, union + dedupe them into `request.filters` on all
  three node arms, and fold `committedResidual` into the recomputed residual.
- Add `dedupeConstraints` keyed on `(sourceExpression, columnIndex, op)`, with the BETWEEN
  reasoning in its doc comment so nobody "simplifies" it back to expression identity.
- Update the header comment of `fallbackIndexSupports` (and the note in
  `rules/shared/index-style-context.ts`) to state the invariant plainly: **a re-probe must
  request at least the constraints the committed context already claims, and must carry its
  residual forward — an `IndexStyleContext` may only be replaced by one that enforces a superset
  of what it enforced.** The file already documents the ordering half of this; say the
  constraints half next to it.
- Add the conjunct-monotonicity sweep as a new `.sqllogic` file next to
  `07.7.5-filter-lost-under-index-order.sqllogic` (suggest `07.7.6-conjunct-monotonicity.sqllogic`),
  covering the shapes listed above plus the `delete` / `update` forms.
- Add a plan-shape spec (mirroring `test/filter-lost-under-index-order.spec.ts`) asserting the
  `id = 2` conjunct survives as a seek or a filter instruction in the emitted program — a
  row-set-only test would start passing again if a future rewrite happened to reorder conjuncts.
- Run `yarn test` and `yarn lint` from the repo root. Expect the two regressions described under
  *"Things the prototype learned the hard way"* if the dedupe is wrong; both are precise
  tripwires for the two mistakes.
- Consider whether `docs/optimizer.md` should carry the two-channel rule (`moduleCtx` vs
  `Retrieve.source`) as a stated invariant rather than only as comments in three rule files.
