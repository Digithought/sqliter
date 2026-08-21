----
description: When gathering statistics, the engine decides whether two column values are "the same" by turning each into text, which is not how the database itself decides. So the count of different values it records for a column can disagree with what a plain query over the same column reports.
files:
  - packages/quereus/src/planner/stats/analyze.ts     # collectStatisticsFromScan — distinctSets keyed by String(val)
  - packages/quereus/src/planner/stats/histogram.ts   # buildHistogram — per-bucket distinct keyed by typeof + ':' + String(val)
  - packages/quereus/src/util/value-set.ts            # createValueSet — the engine's own DISTINCT set, the intended replacement
  - packages/quereus/src/util/comparison.ts           # compareSqlValues / sqlValueIdentical — the value-identity that should govern
  - packages/quereus/test/optimizer/analyze-stats-equivalence.spec.ts  # the general test to extend with a mixed-type column
repro: static
severity: edge-case
likelihood: unusual
tradeoffs: These numbers only ever feed cost estimates and never a query result, so a maintainer can reasonably say a slightly-off count on an unusual column is not worth making ANALYZE's inner loop do ordered comparisons instead of hash lookups.
----

# Statistics decide value identity by stringifying, and the database does not

## What is wrong

`ANALYZE` records, for each column, how many different values it holds. To count them it
puts each value into a JavaScript `Set` keyed by `String(value)`. That is a different notion
of "same value" than the one the database uses everywhere else, so the recorded number can
disagree with what `select count(distinct c) from t` reports over the identical column:

- A column holding both the number `1` and the text `'1'` stringifies both to `"1"` and is
  counted as **one** value. A query counts **two**.
- A column holding binary (blob) values stringifies every one of them to the same text, so a
  column of a million distinct blobs is counted as holding **one** value.
- A column holding structured (JSON) values has the same problem, for the same reason.

The histogram builder in `histogram.ts` has its own, *different* key — it prefixes the value's
JavaScript type — which fixes the number-versus-text case but still collapses every blob and
every JSON value, and additionally splits a large integer from a small one that the database
considers equal. So the two halves of one statistics record disagree with each other as well
as with the database.

None of this can produce a wrong query result: these numbers are read only by the query
planner, to guess how many rows a step will produce. The visible effect is a bad guess, and
therefore possibly a slower plan, on a table with a column of the kinds above.

## Root cause

Both sites invent an ad-hoc text key for a question the engine already answers. The database's
value identity lives in `compareSqlValues` (`util/comparison.ts`) — it treats a large and a
small integer representation of the same number as equal, compares binary values byte by byte,
and compares structured values by their canonical form — and the engine's own `DISTINCT`
aggregate and `IN` membership already use it, through `createValueSet` (`util/value-set.ts`).
Statistics collection is the one place that does not.

## What "fixed" looks like

One shared notion of value identity for statistics — the engine's — reached through
`createValueSet`, at both sites, so no third key can drift in later. The invariant to hold is
the one the existing equivalence spec already states for every other recorded figure:

> the number of different values `ANALYZE` records for a column equals
> `select count(distinct c)` over that column.

`packages/quereus/test/optimizer/analyze-stats-equivalence.spec.ts` is the general test for
that invariant. It currently generates single-typed columns only, and says so in its header,
precisely because this case is open. Closing this ticket means adding a mixed-type column
(and a blob column) to its generated shapes, at which point the class is covered for good
rather than one instance of it.

## Cost to weigh

An ordered set costs a comparison per value per column, against a hash lookup today. Nobody
has measured what that does to `ANALYZE`'s wall clock on a wide, high-cardinality table; that
measurement is part of the work, not an assumption to make up front. If it turns out to
matter, a reasonable middle is to keep the hash for the storage classes where stringifying is
already faithful and fall back to the ordered set only for the rest — but that reintroduces
two notions of identity, which is what this ticket exists to remove, so it should be a
measured decision and not a default.

## How this was found

Reviewing `bug-analyze-stats-wrong-past-1000-rows`, which made the memory backend stop
inventing column statistics from a sample and route through this shared scan collector
instead. That fix made the collector the single path both shipped backends depend on, which
is what makes this pre-existing inconsistency worth naming. Nothing in that fix caused it and
nothing in that fix is wrong because of it.
