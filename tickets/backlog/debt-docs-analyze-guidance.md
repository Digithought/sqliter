---
description: Nothing in the documentation tells anyone to gather table statistics, or what happens if they never do — so users build an application, never run the one command that makes the query planner work properly, and report the resulting slow queries as planner bugs.
files:
  - docs/usage.md                          # the user-facing guide; no mention of ANALYZE today
  - docs/optimizer-costing.md              # where the consequences are described, for a reader who already knows to look
  - packages/quereus/README.md             # quick start
  - packages/quereus-store/README.md       # the persistent backend's own guidance; statistics persist here and that is worth saying
  - packages/quereus/src/planner/stats/table-cardinality.ts   # the "0 means nobody knows" convention this documents
tradeoffs: Documentation does not make a single query faster, and the underlying representation problem is already tracked (`bug-row-estimate-conflates-unknown-and-zero`), so a maintainer could reasonably wait and let that fix reduce how much the guidance matters.
severity: cosmetic
likelihood: normal-use
---

# Nobody is told to run ANALYZE

## What is missing

`ANALYZE` collects the row counts and per-column value distributions the query planner costs
plans from. Without it, a table reports zero rows — a value that means "nobody has looked",
which the cost model then substitutes a fixed placeholder for. Plans chosen from that
placeholder can be dramatically worse than plans chosen from real numbers.

No user-facing document says this. `docs/usage.md` does not mention `ANALYZE` at all. A
developer building an application on Quereus has no way to learn, short of reading the
optimizer source, that there is a command they are supposed to run.

## Evidence that it matters

A user running the IndexedDB store backend filed four performance reports. Three of them were
about plan choices; all three resolved to statistics never having been collected. Measured
on reconstructions of their queries, with `analyze` as the only variable:

- a selective join planned as a hash join over a full scan of the other table (47.3 ms)
  instead of an index lookup per row (17.8 ms);
- a range read matching 55% of a table planned as an index seek resolving 11,000 scattered
  rows (96.7 ms) instead of one batched scan (43.8 ms).

They had built application-level workarounds for both, and asked whether the engine's
index-lookup-join feature was broken. It was not.

## What the documentation should say

- That `ANALYZE` exists, what it collects, and that the planner's choices depend on it.
- When to run it: after a bulk load, and periodically as the data changes shape. The
  statistics are a snapshot — rows written afterwards are invisible until the next run.
- That on the persistent store backend the results **survive a database reopen**. They are
  written to a dedicated statistics store and reloaded when the catalog is rehydrated, one
  small read per table. Verified on a real LevelDB directory: after closing and reopening
  with a fresh `Database`, the table's statistics came back with the original collection
  timestamp intact and no re-analysis. This is the fact that makes the advice cheap to
  follow in a browser application — analyze once, not on every page load — and it is
  currently written down nowhere a user would find it.
- What it costs to run: a full scan of each table.

## Scope note

This is guidance for users, not a description of internals. `docs/optimizer-costing.md`
already explains the cost model to someone who knows to open it; the gap is that a user with
a slow query has no signpost pointing there. Keep the new text in the user-facing documents
and link inward, rather than moving internals outward.
