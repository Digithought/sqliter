description: The default in-memory storage backend already knows exactly how many rows each table holds, but when the query planner asks it how expensive a query would be, it answers using a flat guess of 1000 rows instead of the number it has on hand.
files:
  - packages/quereus/src/vtab/memory/module.ts               # ~452 — `request.estimatedRows || 1000`, the site
  - packages/quereus/src/vtab/memory/layer/manager.ts        # ~493 — `getBaseLayerStats()`, the O(1) count
  - packages/quereus/src/vtab/memory/table.ts                # ~207 — `getStatistics()`, the existing reader
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts  # the planner side, already sends "unknown"
  - packages/quereus/test/optimizer/access-plan-request-row-count.spec.ts # pins today's behavior; would flip
  - docs/module-authoring.md                                 # ~216 — the contract this would make the memory module follow
difficulty: hard
tradeoffs: Re-pricing every un-analyzed memory table from a flat 1000 to its real size moves plan shapes under the default backend, which is what almost the entire test suite runs on — a maintainer could reasonably say the churn is not worth it until someone shows a real query the current guess plans badly.

# The default backend declines the offer the planner now makes it

## Background, in plain terms

Before a query runs, the planner asks each storage backend a question of the form
*"if I asked you for these rows, how would you get them and roughly what would that
cost?"*. Part of that question is a hint: how many rows the table holds. The hint comes
from `ANALYZE`, the command that measures a table. For a table nobody has run `ANALYZE`
on, there is no hint — and until recently the planner filled in a made-up 1000.

`ask-the-backend-before-guessing-its-size` stopped that. The planner now says "unknown"
when it means unknown, precisely so a backend that already knows its own size can answer
with the truth. The persistent store backend (`quereus-store`) does exactly that: it keeps
a running row count as it writes and supplies it.

## What this ticket is

The in-memory backend — the default, the one nearly every test and most embedded use runs
on — does not, even though it can. It substitutes a flat `1000`:

```ts
// packages/quereus/src/vtab/memory/module.ts ~452
const estimatedTableSize = request.estimatedRows || 1000;
```

The number is already there and already cheap to read. `MemoryTableManager.getBaseLayerStats()`
returns the committed primary B-tree's node count with no scan at all, and
`MemoryTable.getStatistics()` — the method `ANALYZE` calls — already reads it. The module
holds every table's manager in its public `tables` map. So the fix is to consult that count
where the constant is today, keeping the same precedence the store backend uses:

1. a supplied hint (`ANALYZE` ran) wins — the rest of the plan was costed from the same
   catalog snapshot, and an access path priced against a different number disagrees with
   the plan around it;
2. otherwise the module's own live count;
3. only if neither is available, a constant.

## Expected behavior

- A never-analyzed 10-row memory table and a never-analyzed 10,000-row one no longer cost
  the same. Today they do.
- An `ANALYZE`d table plans exactly as it does now — the hint still wins.
- Query *answers* never change. A row estimate only picks between plans that all return the
  same rows.

## Why it is not a small change

The flat 1000 has been the memory backend's costing input since the beginning, and the
constants around it were calibrated with it in place. Feeding real sizes will move plan
shapes — most visibly on very small tables, where seeking into an index costs more than
reading the whole table and the planner will correctly stop seeking. The store backend went
through exactly this when it started supplying its live count, and four of its tests needed
their fixtures resized (see `complete/5.5-ask-the-backend-before-guessing-its-size`). The
memory backend is a much larger blast radius: it is what `yarn test` runs on.

Whoever takes this should expect the bulk of the work to be triaging plan churn — deciding
case by case whether each moved plan is the arithmetically correct one for the table's real
size (keep, resize the fixture) or evidence of a miscalibrated constant (fix the constant).

## One thing to settle first

`getBaseLayerStats()` reports the **committed** rows only; a connection's uncommitted rows
sit in its own pending layer. The store backend's count includes the open transaction's
buffered writes, so a statement reading what its own transaction just wrote is costed
against the size it will really see. Decide whether the memory backend should match that
(it would need to reach the connection's pending layer, which `getBestAccessPlan` does not
have in hand today) or whether the committed count is good enough — and say which, in the
implementation.
