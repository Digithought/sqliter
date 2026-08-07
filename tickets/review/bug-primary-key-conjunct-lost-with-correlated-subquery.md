---
description: A WHERE condition on a table's primary key was silently ignored when the query also had a sub-select referring back to the outer table plus at least one other condition — SELECT returned rows it should have excluded and DELETE destroyed them. Fixed, with tests pinning the general rule that adding a condition can never return more rows.
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

Reproduced in this working tree before the change (plain in-memory `Database`, memory
tables, no plugins): the emitted program was `filter(flag = 1)(IndexScan o)` — `id = 2`
appeared nowhere. After the change it is `filter(flag = 1)(IndexSeek o [literal 2])`.

# The one site that changed

`fallbackIndexSupports` in `src/planner/rules/retrieve/rule-grow-retrieve.ts`.

Background in two sentences: a `RetrieveNode` can carry an `IndexStyleContext` on its
`moduleCtx`, and once it does, that context is the **sole authority** for what the table
access enforces — `ruleSelectAccessPath` builds the physical leaf from
`moduleCtx.accessPlan` + `moduleCtx.residualPredicate` and never reads `Retrieve.source`.
`ruleGrowRetrieve` can fire a **second** time on the same Retrieve (a later rule drops a
fresh `Filter` on top of one that is already equipped), and its re-probe returned a fresh
context that *replaced* the committed one wholesale — dropping the displaced context's
seek keys and residual on the floor.

Four changes:

- **Union the committed constraints into the re-probe.** `committedConstraints` /
  `committedResidual` are captured from `existingCtx`; the `Filter` arm unions them with
  its own extraction, the `Sort` / `LimitOffset` arms inherit them from the initializer,
  and `request.filters` is assigned once after the arm chain. Because the residual is
  recomputed from the new plan's `handledFilters` over the **full** union, correctness does
  not depend on the module answering the second probe the way it answered the first —
  anything it declines is residualized.
- **`dedupeConstraints`,** keyed on `(sourceExpression, columnIndex, op)`.
- **Fold `committedResidual` into the recomputed residual.**
- **New gate: growing a `Sort` or `LimitOffset` requires the plan to provide the requested
  ordering.** This is NOT in the original ticket's prototype and is the one place I
  deviated — see *Deviations* below.

Also: doc comments on `fallbackIndexSupports` and `rules/shared/index-style-context.ts`
now state the superset invariant; `docs/optimizer-retrieve.md` gained a
*Re-probing a committed access path* section and `docs/invariants.md` gained **OPT-026**
(cross-linked from its sibling OPT-023, which covers the same seam in the other direction).

# Deviations from the ticket's prototype — read this first

The ticket supplied a prototype diff and said to land it "as the starting point, not
verbatim gospel". I added one thing it did not have, and a reviewer should check my
reasoning:

**The `Sort` / `LimitOffset` arms needed a companion guard.** Growing a `Sort` or a
`LimitOffset` **swallows** it: the node lands in `Retrieve.source`, which the index-style
branch of `ruleSelectAccessPath` never reads, so the operation is dropped and the access
plan is expected to have honoured it. Before this change those two arms sent
`request.filters = []`, so `handlesAnyFilter` was structurally always `false` for them and
the benefit gate (`!handlesAnyFilter && !providesOrdering`) reduced to "the plan must
provide the ordering". Seeding them with `committedConstraints` breaks that reduction: a
module could claim a committed filter and the grow would be accepted with
`providesOrdering === false`, silently dropping an `ORDER BY`. I added

```ts
if (!(node instanceof FilterNode) && !providesOrdering) return undefined;
```

which restores exactly the prior acceptance condition for those arms. It is redundant with
the existing `equippedOrdering` no-clobber guard in the case where an equipped ordering
exists, but not in the case where the Retrieve is equipped with a **seek and no ordering**
and a `Sort` is grown over it — there the old guard does not fire.

I did not find a failing test for this hazard (the whole suite is green with and without
the guard). It is reasoning from the code, not an observed failure. If a reviewer thinks
the guard is over-tight — it can only cause a missed optimization, never a wrong answer —
that is the thing to argue with.

# How to validate

```bash
yarn lint                       # exit 0
yarn test                       # 9029 passing, 16 pending, 0 failing (quereus)
                                # + all other workspaces green
yarn docs:check                 # "Docs OK"
```

Targeted:

```bash
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus/test/primary-key-conjunct-lost-with-correlated-subquery.spec.ts"
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus/test/logic.spec.ts" --grep "07.7.9"
```

## Tests added

**`test/logic/07.7.9-conjunct-monotonicity.sqllogic`** — the rung above a point regression
test, as the ticket asked. Four sections:

- *The sweep.* Conjuncts K (`id = 2`), N (`flag = 1`), S (correlated sub-select), each
  discriminating over a 4-row table, with all seven non-empty subsets enumerated and the
  triple written in four different conjunct orders. Every superset's expected rows are
  contained in every subset's, so the monotonicity property is pinned by construction.
- *The reported shapes, verbatim* — correlated `EXISTS` on the key column and on the
  non-key column, correlated scalar sub-select, `id in (2)`, sub-select written first,
  `between`, `>=`, aliased/qualified form.
- *Controls that were already correct* — two conjuncts, constant conjunct, **uncorrelated**
  sub-select, `order by` / `order by desc` / `limit` over the fixed shape.
- *`delete` and `update`* with the failing shape, which is what makes this data loss rather
  than a wrong read.

**`test/primary-key-conjunct-lost-with-correlated-subquery.spec.ts`** — plan-shape spec
mirroring `test/filter-lost-under-index-order.spec.ts`. Asserts `id = 2` survives in the
emitted program (as an `IndexSeek` **or** a `filter(id = 2)` instruction — either is
correct, and matching the disjunction keeps the test from failing merely because the
planner got better), that `flag = 1` also survives, that the decorrelation precondition
still holds, plus row-set/DELETE/UPDATE/BETWEEN arms and a programmatic monotonicity check
over all conjunct subsets.

## Validation actually performed

- Repro observed failing before the change and passing after (row set **and** program).
- **The BETWEEN dedupe tripwire was verified to bite.** I temporarily weakened
  `dedupeConstraints` to key on `sourceExpression` alone and re-ran 07.7.9: it failed at
  `07.7.9:116`, `id between 2 and 2` returning 2 rows. Restored and re-verified. So that
  test genuinely guards the mistake its comment warns about.
- `yarn test` — 9029 passing / 0 failing in quereus; every other workspace green.
- `yarn test:store` — 9021 passing / 24 pending / 0 failing. Run because this change alters
  what requests modules see, and the LevelDB store has an independent
  `getBestAccessPlan`. 07.7.9 was additionally run explicitly under
  `QUEREUS_TEST_STORE=true` and passes there.
- `yarn lint` (eslint + `tsc -p tsconfig.test.json --noEmit`) exit 0; `yarn docs:check` OK.

# Known gaps — treat the tests as a floor

- **The `Sort` / `LimitOffset` arms have no test that reaches them over an already-equipped
  Retrieve.** The ticket said they are "not known to be reachable" today (the structural
  pass is top-down, so a `LimitOffset` above a `Filter` is visited before the Filter grows),
  and I did not find a query that reaches them either. So the committed-constraint seeding
  on those two arms and my new ordering guard are both **untested by construction** —
  written for symmetry, on the reasoning that leaving them asymmetric is how this bug got
  written twice. A reviewer who can construct a reaching query would turn two arguments
  into two tests. The `order by` / `limit` cases in 07.7.9 exercise the arms, but the log
  line shows them declining, not growing.
- **`committedResidual` is never non-undefined in any test I could construct.** In the
  reported trace the committed residual has already been cleared and hoisted above the
  Retrieve (it contains a subquery, so `predicateContainsSubquery` moves it out). The
  fold-forward is therefore correct-by-reasoning and dead in practice today. If it is ever
  live and the committed residual overlaps the incoming Filter's predicate, the result is a
  redundant `Filter`, not a wrong answer — but I have not seen it run.
- **Dedupe identity relies on `sourceExpression` object identity** across two separate
  `extractConstraints` calls. Sound because plan nodes are immutable and shared, so the same
  predicate yields the same node object — but it is identity, not structural equality. A
  future rule that *rebuilds* an equivalent predicate node would slip a duplicate past the
  dedupe. That degrades to a redundant residual `Filter` plus a cost shift (the exact thing
  that broke `test/optimizer/key-set-seek.spec.ts` in the ticket's prototype), never a
  wrong answer.
- **No cross-repo run.** The header comment on the ordering no-clobber guard says the
  end-to-end regression proving it is load-bearing lives in Lamina's suite
  (`ordinal-seek-range-bounds.test.ts`), not here. I touched the function that guard lives
  in — I did not re-order or alter the guard itself, but I did not run Lamina either.
- **The monotonicity property is pinned by enumerated expectations, not generated.** A true
  property test (generate conjunct subsets, assert containment) would cover shapes I did not
  think to write down. The `.spec.ts` does compute containment programmatically, but only
  over the seven subsets of one hand-picked conjunct triple.
- SiteCAD (`../SiteCAD_branch`) carries a workaround for this and tracks it as
  `tickets/blocked/quereus-primary-key-conjunct-lost-with-correlated-subquery.md`. Out of
  scope here; someone should tell it the fix landed.

# Suggested review focus

- The `!(node instanceof FilterNode) && !providesOrdering` gate — is the reasoning right,
  and is it too tight?
- Whether folding `committedResidual` in unconditionally can double-apply a predicate in
  some shape I did not reach.
- Whether `dedupeConstraints`'s `(expression, column, op)` key is the right granularity —
  in particular whether two genuinely distinct constraints could ever collide on it (I
  believe not: the extractor emits at most one constraint per source node per column/op
  role, and `BETWEEN` is the case that forced the role into the key).
