---
description: Asking for the largest or smallest value in an indexed column reads every row of the table, even though the answer is sitting at one end of the index and could be read directly. On a twenty-thousand-row table that is the difference between about a tenth of a second and no measurable time at all.
files:
  - packages/quereus/src/planner/rules/aggregate/               # where the new rule would live (alongside rule-aggregate-streaming)
  - packages/quereus/src/planner/optimizer.ts                   # RULE_MANIFEST — array order is execution order
  - packages/quereus/src/planner/nodes/table-access-nodes.ts    # IndexScanNode / IndexSeekNode — the ordered access the rule would build on
  - packages/quereus/src/planner/rules/access/rule-monotonic-limit-pushdown.ts  # the closest existing rule; pushes a limit into an ordered access
  - packages/quereus/src/func/builtins/aggregate.ts             # min / max — the comparator the rule must agree with
  - packages/quereus/src/planner/util/fd-utils.ts               # keysOf / isUnique, for the grouped case
tradeoffs: Every affected query already returns the right answer, and a user can rewrite `max(c)` as `order by c desc limit 1` by hand today — so a maintainer may reasonably rank this below work that fixes wrong plans rather than adding a new fast path. It also only pays off on backends that advertise ordering for the index in question, which the store backend currently does not.
severity: cosmetic
likelihood: normal-use
---

# Answer MIN / MAX from the index boundary instead of scanning

## What happens now

`MIN(c)` and `MAX(c)` always stream the whole input through the aggregate, even when `c` is
indexed and the answer is the first or last entry of that index.

Measured, 20,000-row table, `date` indexed, `ANALYZE` run, store backend:

```
select max(date) from entry
  StreamAggregate [max(date)]
    IndexScan [entry USING _primary_]     <- reads all 20,000 rows
```
106 ms. The same query on the in-memory backend reads the whole table too (42 ms on 10,000
rows) — so this is an engine-level gap, not a backend one.

## What it should do

An ungrouped `MIN(c)` or `MAX(c)` over a relation whose access can produce rows ordered by
`c` should read one row: walk the index in the appropriate direction and stop. That turns a
read proportional to the table into a read proportional to nothing.

This is the standard index-boundary optimisation and there is a close precedent in the tree:
`rule-monotonic-limit-pushdown` already pushes a limit into an ordered access. `MIN`/`MAX`
is the same shape wearing an aggregate — `max(c)` is `c order by c desc limit 1` — which
suggests the rule may be able to reuse that machinery rather than introduce new access.

## What has to be got right

- **NULLs.** `MIN`/`MAX` ignore NULLs; index order does not. Whichever end of the index the
  NULLs live at has to be skipped, not returned.
- **The empty relation.** `MIN`/`MAX` over no rows is NULL, not "no row". A rewrite that
  becomes a limit-1 must still produce one row containing NULL.
- **The comparator.** The aggregate ranks under the argument's semantic comparator — elapsed
  time for durations, structural order for JSON, the declared collation for text — whereas
  index order is the index's. The rule must fire only where those two provably agree, or it
  will return a value that is not the maximum. `func/builtins/aggregate.ts` documents the
  binding that decides this.
- **`MIN` and `MAX` together** in one query need both ends; whether that is two accesses or
  one is a design question, not a given.
- **Grouped `MIN`/`MAX`** (`select g, max(c) from t group by g`) is the more valuable case and
  a much harder one — it wants one boundary read per group. Treat it as out of scope for a
  first cut and say so explicitly rather than half-doing it.

## Backend dependency

The rule needs an access path that advertises ordering on the aggregated column. The
in-memory backend advertises that for its secondary indexes; the store backend does **not**
(`feat-store-secondary-index-ordering`, plan stage). So this rule as written would fire on
memory and silently decline on store — which is the backend the reporting user runs. Landing
it in that state is defensible as long as it is deliberate and stated; landing it while
believing it helps store users would not be.

## Also worth measuring

`select distinct <indexed-col>` has the same shape — 28 distinct values recovered by scanning
20,000 rows and de-duplicating. The reporting user denormalises that too. It is not the same
rule, but it is the same disappointment, and whoever picks this up should check whether
distinct elimination already has a path to an ordered access.

## Where this came from

A user running the IndexedDB store backend reported `MAX(date)` on a 20,000-row table at
450–900 ms, and works around it by maintaining the value on another table by hand — one of
several such workarounds they carry.
