---
description: The persistent storage backend never tells the planner that reading through one of its secondary indexes returns rows already in sorted order. So a query that sorts by an indexed column re-sorts the entire table instead of just reading the index — measured at 70 times slower than the in-memory backend doing the same query.
files:
  - packages/quereus-store/src/common/store-module-access-plan.ts   # buildPkOrderingAdvertisement (primary key only); tryIndexAccessPlan (secondary — advertises no ordering)
  - packages/quereus-store/src/common/store-table-scan.ts           # the scan arms that would have to honour the claim, including batched row resolution
  - packages/quereus/src/vtab/best-access-plan.ts                   # providesOrdering / orderingIndexName / monotonicOn — the fields to fill in
  - packages/quereus/src/vtab/memory/module.ts                      # the backend that already does this correctly, as the reference
  - packages/quereus-store/test/pushdown.spec.ts                    # where the store's access-plan assertions live
---

# The store backend advertises ordering for its primary key only

## What is missing

When the planner asks a virtual-table module for an access plan, the module may answer with
`providesOrdering` — "the rows I hand back are already sorted this way". The planner uses
that to delete a sort it would otherwise have to perform.

The store backend fills that field in exactly one place: `buildPkOrderingAdvertisement`,
which describes primary-key order and is called only from the primary-key arms.
`tryIndexAccessPlan`, which serves every **secondary** index, returns no ordering claim at
all — even though a secondary index is by construction a structure whose entries are stored
in the indexed column's order, and the scan walks it in that order.

The in-memory backend does make the claim. So the two shipped backends disagree on a
capability, and the store is the one used for persistence.

## What it costs

Measured: table of 10,000 rows, integer column `n`, `create index idx_n on entry(n)`,
`ANALYZE` run, query `select n from entry order by n limit 1`.

| backend | plan | time |
|---|---|---|
| memory | `IndexScan idx_n` — walks the index, stops at the first row | **0.9 ms** |
| store | `IndexScan _primary_` then `Sort` over all 10,000 rows | 62.9 ms |

70x, on a query that needs to read one row. The column is an integer, so this is not about
text collation.

It is not limited to sort-only queries. `select n from entry where n > 900 order by n limit 1`
on the store picks `IndexSeek idx_n` — the index *is* chosen for the filter — and then stacks
a `Sort` on top of it, because the seek that just walked the index in order did not say so.

Every `order by <secondary-indexed-column>` on a store-backed table pays this, as does
anything the planner builds on an ordering claim: sort elision, merge join, and streaming
aggregation.

## What the claim has to respect

The primary-key version of this is the specification to mirror, and it is careful for
reasons that apply here unchanged:

- **Collation.** The claim is about the physical byte order the store iterates in, while
  every consumer reasons in the column's collation order. `buildPkOrderingAdvertisement`
  truncates its claim to the leading run of key members whose byte order and collation order
  provably agree, and voids the claim entirely when even the first member disagrees. A
  secondary-index claim needs the same treatment against the indexed columns' collations.
- **Claim only what was asked for.** When the request carries a required ordering, the
  primary-key version claims it only if the requested keys are a matching-direction prefix of
  the key, and declines when an explicit nulls-first/nulls-last was requested. Same rule.
- **Composite indexes** advertise a prefix, not the whole key, when only a prefix is ordered.
- **A false claim is a wrong answer, not a slow one.** The sort-elision rule deletes the sort
  on the strength of this field. That makes this the one part of the access plan where being
  approximately right is not acceptable — an over-claim returns rows in the wrong order with
  no error. `debt-nothing-checks-advertised-row-order` (backlog) is the ticket for a general
  guard against exactly this class; this work is a good reason to want it.

## Two things to settle during planning

**Does row resolution preserve index order?** A secondary-index read walks index entries and
then fetches the rows they name, batched 256 at a time
(`ROW_RESOLUTION_BATCH`, shipped in `2.5-store-index-seek-batched-scan`). Whether the batched
fetch re-emits in index-entry order or in whatever order the batch returns decides whether the
claim is true at all. Confirm from `store-table-scan.ts` before designing anything else; if
batching does not preserve order, the claim must be scoped to the arms that do, or the batch
must be made order-preserving.

**Read-your-own-writes.** The scan merges uncommitted changes from the pending-operation view
over the committed store. An ordering claim has to hold for the merged stream, not just the
committed one.

## Related

- `bug-store-pk-range-preempts-cheaper-index` (backlog) touches the same file and also
  concerns primary-key-versus-secondary-index choice, but it is about the arms not competing
  on cost — a different defect at a different site.
- `feat-minmax-index-boundary` (backlog) wants to answer `MIN` / `MAX` by reading one index
  entry. On the store that optimisation is unreachable until this lands.

## Where this came from

A user running the IndexedDB store backend reported `MAX(date)` over an indexed column
costing 450–900 ms on a 20,000-row table, and works around it by denormalising the value onto
another table. Investigating that report surfaced this as the underlying capability gap.
