description: When a table has been measured and found to hold zero rows, one spot in the planner still prices reading it as though it held a thousand rows, so the optimizer treats a table it knows is empty as one of the more expensive things in the query.
files:
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts  # ~1235 — `createSeqScan`, the single site
  - packages/quereus/src/planner/stats/table-cardinality.ts               # catalogRowCount — where the 0 comes from
  - docs/optimizer-costing.md                                             # § Base-table row estimates — the contract
repro: static
severity: cosmetic
likelihood: unusual
tradeoffs: The wrong number only ever picks a plan, never a row, and the plans it picks over a genuinely empty table all finish instantly — so a maintainer could reasonably say the fix buys nothing measurable and risks giving empty tables a zero cost that makes the optimizer prefer them for the wrong reasons.

# One site still reads a measured zero as "no measurement"

## The three spellings

A table's row count has three distinct meanings in this codebase, and
`docs/optimizer-costing.md` § *Base-table row estimates* states them: `undefined` means
nobody has measured the table, `0` means it was measured and is empty, and a positive
number is a measurement. Consumers are supposed to apply a default **only** on `undefined`.

## Where it is broken

`createSeqScan` reads the count with `||`, which cannot tell `0` from `undefined`:

```ts
// packages/quereus/src/planner/rules/access/rule-select-access-path.ts ~1235
const tableRows = tableRef.estimatedRows || 1000;
const scanCost = cost ?? seqScanCost(tableRows);
```

So a table that `ANALYZE` measured and found empty is costed as if it held a thousand rows.
That number is used twice: it prices the sequential scan, and it is stamped into the scan's
`FilterInfo` row estimate.

Reachable today, with no unusual setup: create a table, run `ANALYZE` on it before
inserting anything, and query it. The catalog then holds `rowCount: 0` and this site turns
it into 1000.

## What goes wrong as a result

Nothing about the answer — the rows returned are identical either way. What moves is plan
*choice*: an empty table looks like one of the larger inputs in a join, so join ordering may
put it late instead of first, and cost comparisons elsewhere in the plan are made against a
figure a thousand times too big.

`repro: static` — read from the code and from the `catalogRowCount` contract, not observed
in a failing query. Confirming it would mean planning a join between an `ANALYZE`d-empty
table and a small non-empty one and checking the join order and the reported `est_cost`.

## The judgment the fix has to make

The obvious change is `||` → `??`, and it is not obviously right on its own: that gives an
empty table `seqScanCost(0)`, likely zero, and a zero-cost input can distort comparisons in
the other direction. Whoever takes this should decide what an empty table's scan *should*
cost — most likely a floor of one row, matching what other estimate consumers already clamp
to — rather than mechanically swapping the operator.

Noted at the site during the review of `ask-the-backend-before-guessing-its-size`, which
fixed the same `||`-swallows-zero mistake at the four sites that build a request for a
storage backend. This one was deliberately left alone there because it feeds the engine's
own cost model rather than a backend request, and that is a different question.
