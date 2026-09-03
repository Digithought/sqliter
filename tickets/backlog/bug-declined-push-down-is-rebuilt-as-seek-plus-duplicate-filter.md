---
description: When the query planner decides an index lookup is not worth it and backs out, it does not fall back to reading the table plainly the way it believes it does — a later step rebuilds the very same index lookup and then re-checks the condition on top of it, so backing out costs more than going ahead would have.
files:
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts        # fallbackIndexSupports — the veto that declines (see the NOTE at the `!providesOrdering` branch)
  - packages/quereus/src/planner/rules/predicate/rule-predicate-pushdown.ts  # tryPushDown — pushes into a Retrieve that carries no index-style context
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts     # the no-context branch (~248) and rebuildPipelineWithNewLeaf (~285)
  - packages/quereus/test/optimizer/seek-vs-scan-baseline.spec.ts            # "declines the push-down when the module prices its seek above its own scan" pins today's wrong shape
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: The plans this produces are correct — only wasteful — and the waste is one extra predicate evaluation per surviving row on a query the planner already judged unprofitable, so a maintainer may reasonably rank it below anything that returns wrong answers; the fix also forces a decision about whether the cost check should exist at all, which is more thought than the symptom alone seems to warrant.
---

# Backing out of an index push-down costs more than going ahead

## What happens

Two independent parts of the planner disagree about what "decline this index
push-down" means.

The retrieve-growth rule (`fallbackIndexSupports`) decides whether to hand a `WHERE`
condition to a storage backend's index. It compares what the backend says the index
lookup costs against what the backend says reading the whole table costs, and when the
lookup does not win it declines — on the understanding that the query will then read the
table plainly instead.

It will not. Declining leaves the table access with no committed index plan, and that is
exactly the state in which two later steps re-derive the lookup anyway:

- `rule-predicate-pushdown` pushes the same condition down into the table access,
  because nothing there says a decision has already been made about it;
- `ruleSelectAccessPath`'s no-plan branch then asks the backend again, gets the same
  index lookup, builds it, and rebuilds the pushed-down condition as a filter step *on
  top of* the lookup that already applied it.

So the query ends up paying for the index lookup the planner refused, plus a second
evaluation of the condition for every row that lookup returns. Declining is strictly
worse than accepting would have been. The answer is correct throughout; only the work is
wasted.

## How to see it

Against the default in-memory backend, no test double involved:

```sql
create table t (id integer primary key, val integer);
-- insert 10 rows
analyze t;
select * from t where id in (1, 2, /* … 60 keys total … */ 60);
```

The backend prices a 60-key lookup over a 10-row table at 18.5 and a plain read of that
table at 10, so the lookup loses and the growth rule declines. The resulting plan is:

```
FILTER (id in (…))          est_cost 0.2
  INDEXSEEK t USING primary est_cost 18.5
```

Both halves of the redundancy are visible: the seek the planner refused, and the `IN`
test re-run above it. With a 3-key list the lookup wins, the growth rule accepts, and the
plan is a bare `INDEXSEEK` with no filter — the shape the 60-key case should also reach
one way or the other.

Reaching it needs a lookup the backend prices above its own whole-table read. A long `IN`
list over a small table that has been `ANALYZE`d is the reproducible case; the same
arithmetic applies to any backend whose per-key cost can outgrow its per-row cost.

## Why it is worth fixing beyond the wasted work

The cost check reads as a safety valve, and it is not one. Anyone adding a cost gate to
this rule, or tuning the constants behind it, will reason about a fallback that does not
exist. That is the durable hazard here, more than the per-row cost of the queries that
hit it today.

## What "fixed" should look like

Either outcome is acceptable; picking between them is the work.

- **The decline sticks.** A refused push-down leaves a mark the later steps read, so the
  condition is not pushed down again and the query genuinely reads the table plainly.
  This makes the cost check mean what it says. It needs somewhere to record "this table
  access considered an index plan and rejected it" that survives from the growth rule to
  access-path selection — the existing index-style context is the natural place, but it
  currently only ever represents an *accepted* plan.
- **The check goes away.** If a backend's own numbers say the lookup is worse, and the
  engine is going to build that lookup regardless, then refusing it buys nothing and
  costs a duplicate filter. Removing the comparison makes the growth rule purely
  structural for this arm, which is what
  [`docs/optimizer-retrieve.md`](../../docs/optimizer-retrieve.md) claimed it was until
  recently. The risk is that some plan today depends on the decline; the bench gate and
  the plan tests would say.

Whichever is chosen, the redundant rebuild deserves attention on its own: when the
no-plan branch builds a seek that consumes a condition, the copy of that condition inside
`Retrieve.source` should not be rebuilt above it. `rule-select-access-path` already
carries a `NOTE` acknowledging a related redundancy on the same branch and asserting it
is "only reachable for a module exposing BOTH `supports()` and `getBestAccessPlan()`";
the reproduction above shows that reachability claim is too narrow, so that note needs
correcting as part of this.

## Expected behaviour

For the reproduction above, the plan carries the condition exactly once — either as a
bare index seek with no filter above it, or as a plain table read with the filter above
it and no seek. Not both.

## Related

- `debt-optimize-not-fixpoint-stacked-filters` also concerns duplicate filter steps
  surviving into the final plan, but from a different cause (the optimizer not running to
  a fixpoint). Separate root cause, same family of symptom.
- The cost comparison itself was corrected in `seek-vs-scan-baseline-quoted-by-the-module`,
  which made both sides of it come from the same backend. That fix is what makes the
  decline branch rare rather than routine; it does not make it correct.
