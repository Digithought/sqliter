----
description: The subquery-to-join decorrelation rewrites always fire; add a cost/statistics gate so a query with very few outer rows and a huge indexed inner table can keep the cheaper per-row plan.
files: packages/quereus/src/planner/rules/subquery/rule-subquery-decorrelation.ts, packages/quereus/src/planner/rules/subquery/rule-scalar-agg-decorrelation.ts, packages/quereus/src/planner/cost/, packages/quereus/src/planner/stats/
tradeoffs: No report of the inverse case in practice - the ratio only matters at extreme outer/inner skew - and the ticket asks to land after feat-decorrelate-remaining-subquery-sites so the gate is not designed against a moving target.
----

# Cost gate for subquery decorrelation rules

Both the existing EXISTS/IN decorrelation and the scalar-aggregate grouped-join
decorrelation fire unconditionally. The grouped-join form scans and aggregates
the **entire** inner table; the per-row correlated form probes it once per
outer row, potentially via an index seek pushed into a `Retrieve`.

For the common case (outer rows ≳ tens, inner scan is cheap or remote reads are
per-row expensive) set-based wins decisively — the motivating benchmark showed
~26×. But the inverse exists: one outer row against a hundred-million-row inner
with a covering index makes the unconditional rewrite a regression.

Desired behavior: use row estimates (`physical.estimatedRows`, stats pass) and
access-path information (seekable correlation key vs full scan, remote
`expectedLatencyMs`) to choose between the correlated per-row plan and the
grouped-join plan, rather than always rewriting. Should cover both rule
families consistently, with a tuning escape hatch.

Not urgent: no report of the inverse case in practice; the ratio only matters
at extreme outer/inner skew.
