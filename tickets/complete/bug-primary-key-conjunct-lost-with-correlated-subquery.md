---
description: A WHERE condition on a table's primary key was silently ignored when the query also had a sub-select referring back to the outer table plus at least one other condition — SELECT returned rows it should have excluded and DELETE destroyed them. Fixed, reviewed, and pinned with tests for the general rule that adding a condition can never return more rows.
prereq:
files:
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts
  - packages/quereus/src/planner/rules/shared/index-style-context.ts
  - packages/quereus/test/logic/07.7.9-conjunct-monotonicity.sqllogic
  - packages/quereus/test/primary-key-conjunct-lost-with-correlated-subquery.spec.ts
  - docs/optimizer-retrieve.md
  - docs/invariants.md
repro: verified
difficulty: medium
---

# What was wrong

```sql
create table o (id integer primary key, flag integer);
insert into o values (1, 1), (2, 1), (3, 1);

select id from o where flag = 1 and id = 2
  and exists (select 1 from o o2 where o2.id = o.id);
-- WAS: [1, 2, 3]   NOW: [2]
```

The emitted program was `filter(flag = 1)(IndexScan o)` — `id = 2` appeared nowhere.
It is now `filter(flag = 1)(IndexSeek o [literal 2])`.

# The fix

One site: `fallbackIndexSupports` in
`src/planner/rules/retrieve/rule-grow-retrieve.ts`.

A `RetrieveNode` can carry an `IndexStyleContext` on its `moduleCtx`, and once it does,
that context is the **sole authority** for what the table access enforces —
`ruleSelectAccessPath` builds the physical leaf from `moduleCtx.accessPlan` +
`moduleCtx.residualPredicate` and never reads `Retrieve.source`. `ruleGrowRetrieve` can
fire a **second** time on the same Retrieve (a later rule drops a fresh `Filter` on top of
one that is already equipped), and its re-probe returned a fresh context that *replaced*
the committed one wholesale — dropping the displaced context's seek keys and residual on
the floor.

Landed in implement:

- **Union the committed constraints into the re-probe.** The `Filter` arm unions
  `existingCtx.originalConstraints` with its own extraction; the `Sort` / `LimitOffset`
  arms inherit them. The residual is recomputed from the new plan's `handledFilters` over
  the full union, so correctness does not depend on the module answering the second probe
  the way it answered the first — anything it declines is residualized.
- **`dedupeConstraints`,** keyed on `(sourceExpression, columnIndex, op)` — not on the
  expression alone, which would collapse a `BETWEEN`'s two bounds into one.
- **Fold the committed residual into the recomputed residual.**
- **New gate:** growing a `Sort` or `LimitOffset` requires the plan to provide the
  requested ordering, since growing those nodes *swallows* them.

Added in review (see findings below): the committed residual is now folded in
conjunct-by-conjunct with de-duplication, and both residual builders in the file share one
`assembleResidual` helper.

Docs: `docs/optimizer-retrieve.md` gained a *Re-probing a committed access path* section
and `docs/invariants.md` gained **OPT-026**, cross-linked from OPT-023, which covers the
same seam in the other direction.

# Tests

**`test/logic/07.7.9-conjunct-monotonicity.sqllogic`** — the property above the point
regression test. Four sections: a sweep of conjuncts K (`id = 2`), N (`flag = 1`), S
(correlated sub-select) over all seven non-empty subsets plus the triple in four conjunct
orders, so every superset's expected rows are contained in every subset's by construction;
the reported shapes verbatim (`EXISTS` on key and non-key columns, correlated scalar
sub-select, `id in (2)`, `between`, `>=`, aliased/qualified); controls that were already
correct (two conjuncts, constant conjunct, uncorrelated sub-select, `order by`, `limit`);
and `delete` / `update` arms, which are what make this data loss rather than a wrong read.

**`test/primary-key-conjunct-lost-with-correlated-subquery.spec.ts`** — plan-shape spec.
`id = 2` must survive in the emitted program as an `IndexSeek` **or** a `filter(id = 2)`
(matching the disjunction keeps it from failing merely because the planner got better),
`flag = 1` must survive too, the decorrelation precondition still holds, plus
row-set/DELETE/UPDATE/BETWEEN arms, a programmatic monotonicity check over all conjunct
subsets, and (added in review) an assertion that the carried residual appears exactly once.

# Review findings

Reviewed the implement diff first, then the ticket. Everything below was checked against
the code and, where a claim was behavioural, measured by running it.

## Fixed in this pass

- **The displaced context's residual was applied twice.** `assembleResidual` (new helper)
  now contributes the committed residual conjunct-by-conjunct, skipping conjuncts the
  constraint union already covers, and combines through the existing
  `combineResidualExpressions` (which de-duplicates by node identity).
  `rule-grow-retrieve.ts:284`.

  The handoff listed "`committedResidual` is never non-undefined in any test I could
  construct" as a known gap. It is: `select id from o where flag = 1 order by id` reaches
  it. The `order by` equips the Retrieve with an ordering plan whose residual is the
  declined `flag = 1`; the re-probe over the `Filter` re-derives that same conjunct from
  the union and then appended the committed copy on top, emitting
  `filter(flag = 1 AND flag = 1)` — a correct answer, but a predicate evaluated twice per
  row and a cost shift of exactly the kind `dedupeConstraints` exists to prevent. Confirmed
  by the rule's own log ("Added 2 unhandled/carried constraint expressions to residual")
  before the fix, one conjunct after. Pinned by a new spec arm, *carries the displaced
  context's residual forward exactly once*.

- **Two hand-rolled AND-tree builders, neither de-duplicating.** `fallbackIndexSupports`
  and `trySortAbsorbViaIndexOrdering` each built the residual inline; both now call
  `assembleResidual`. This also gives `trySortAbsorbViaIndexOrdering` the identity
  de-duplication it lacked, so a declined `BETWEEN` there no longer doubles its source
  expression. Net −8 lines despite the added helper.

- **Dead defensiveness.** `PredicateConstraint.sourceExpression` is non-optional
  (`constraint-extractor.ts:45`), so the `if (constraint.sourceExpression)` guards added
  around it were unreachable branches; removed, and `dedupeConstraints` reduced to a
  `filter`.

## Checked and found correct

- **The `!(node instanceof FilterNode) && !providesOrdering` gate** (the implementer's one
  deviation, flagged for review). The reasoning holds: before the union those arms sent
  `request.filters = []`, so `handlesAnyFilter` was structurally always `false` for them
  and the benefit gate reduced to "the plan must provide the ordering". Seeding them with
  committed constraints breaks that reduction, and the gate restores exactly the prior
  acceptance condition. It can only cost a missed optimization, never a wrong answer. Not
  too tight.
- **`dedupeConstraints`'s `(expression, column, op)` key.** No two genuinely distinct
  constraints can collide: the extractor emits at most one constraint per source node per
  column/op role, and a single node yields two constraints only for `BETWEEN`, whose bounds
  differ in `op`. The implementer verified the `BETWEEN` case bites by weakening the key
  and watching `07.7.9:116` fail; I did not repeat that.
- **Union soundness across arms.** `request.filters` is assigned once after the arm chain,
  so `handledFilters` stays positional against the same array the residual walks. A module
  returning a short `handledFilters` array yields `undefined` → falsy → treated as
  unhandled → residualized. Safe in the conservative direction.
- **Subquery hoisting still covers the widened residual.** The `predicateContainsSubquery`
  hoist above the grown Retrieve applies to the whole residual, so a carried conjunct
  containing a subquery lands above the boundary with the rest, not buried in `moduleCtx`.

## Checked, deliberately not changed

- **The `Sort` arm drops a `Sort` without setting `orderingLoadBearing`.** The handoff
  called both non-Filter arms unreachable; the `Sort` arm is in fact reachable —
  `select * from t order by id` grows through it (log: `TableReference → Sort`), with no
  `Project` or `Filter` between the `Sort` and the `Retrieve` to divert it to
  `trySortAbsorbViaIndexOrdering`. So the marker that tells later rewrites "an ORDER BY
  now rides on this leaf's emission order" is absent where a `Sort` was in fact dropped.

  I implemented the marker, and it broke
  `test/optimizer/index-nested-loop.spec.ts` — *a bare derived-table ORDER BY is pruned
  upstream, so the seek fires soundly* — by declining a correlated seek that test pins as
  firing. Reverted: the omission is sound, because the two conditions never coincide. An
  ordering a consumer actually observes has no emission-order-changing rewrite above it
  (nothing sits above a top-level ordered scan), and the shapes that do have one are
  subquery `ORDER BY`s, which SQL does not guarantee through a join — and the `LIMIT` that
  would make such an `ORDER BY` meaningful is already refused by the peel gate in
  `rules/join/index-nested-loop.ts`. Recorded as an accepted-tradeoff `NOTE:` at the site
  (`rule-grow-retrieve.ts`, above the `indexCtx` construction) with that revisit condition,
  so the next reviewer does not re-discover and "fix" it as I did.

- **Comment density / four-way restatement of OPT-026** (function doc-comment,
  `index-style-context.ts`, `docs/optimizer-retrieve.md`, `docs/invariants.md`). Left as
  is: it matches the surrounding file's established style, and the code-site copy is the
  one a future editor actually meets. `rule-grow-retrieve.ts` is 724 lines, below any
  split threshold applied elsewhere in `rules/`.

## Tripwires (parked, not ticketed)

- **A bare `LIMIT n` is refused by the `LimitOffset` arm for the wrong reason.** The
  builder materializes an absent OFFSET as `Literal(null)`, which the arm reads as
  "non-numeric OFFSET, cannot compute `limit + offset`" and refuses — so no module ever
  receives `request.limit` by this route, despite `best-access-plan.ts` documenting that
  contract at length. Measured: `select * from t limit 2` yields
  `limit=2:number offset=null:object`, and the rule logs "No usable constant LIMIT".
  Inert today — the arm is unreached in every shape I could build (no `LimitOffset` sits
  directly above a `Retrieve` once a `Filter`/`Project` intervenes, and the benefit gate
  needs a requested ordering regardless), and leaf-level LIMIT pushdown is served by
  `rule-monotonic-limit-pushdown` instead. `NOTE:` at the site with the condition and the
  one-line fix.

## Not re-checked

- **No cross-repo Lamina run.** The header comment on the ordering no-clobber guard says
  the end-to-end regression proving it load-bearing lives in Lamina's
  `ordinal-seek-range-bounds.test.ts`. I did not alter that guard, and did not run Lamina.
- **Constraint dedupe still relies on `sourceExpression` object identity** across two
  `extractConstraints` calls. Sound because plan nodes are immutable and shared, but a
  future rule that *rebuilds* an equivalent predicate node would slip a duplicate past it —
  degrading to a redundant residual `Filter` plus a cost shift, never a wrong answer. Left
  as the implementer documented it.
- **The monotonicity property is pinned by enumerated expectations, not generated.** A true
  generator over conjunct subsets would cover shapes nobody wrote down. Unchanged.
- **SiteCAD** (`../SiteCAD_branch`) carries a workaround and tracks this as
  `tickets/blocked/quereus-primary-key-conjunct-lost-with-correlated-subquery.md`. Outside
  this repo; someone should tell it the fix landed.

## New tickets filed

None. Every finding was either fixed in this pass, parked as a `NOTE:` at its site with a
revisit condition, or is a documented limitation the implementer already recorded and that
does not change behaviour.

# Validation

```
yarn lint        exit 0 (eslint + tsc -p tsconfig.test.json --noEmit)
yarn test        9030 passing, 16 pending, 0 failing (quereus); every other workspace green
yarn test:store  9022 passing, 24 pending, 0 failing
yarn docs:check  Docs OK
```

`yarn test:store` was run because this change alters what requests modules see and the
LevelDB store has an independent `getBestAccessPlan`.
