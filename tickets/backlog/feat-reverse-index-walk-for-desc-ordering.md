---
description: An index sorted smallest-to-largest can be read largest-to-smallest simply by walking it backwards, but neither storage backend will do that — so a query that asks for descending order sorts the whole table unless someone created a second index specifically declared descending.
files:
  - packages/quereus/src/vtab/memory/module.ts                      # indexSatisfiesOrdering (~line 1060) — requires required.desc === indexCol.desc
  - packages/quereus/src/vtab/memory/layer/scan-plan.ts             # the memory backend already has a descending scan plan
  - packages/quereus/src/vtab/memory/layer/scan-layer.ts            # the walk itself
  - packages/quereus/src/vtab/best-access-plan.ts                   # nullSafeOrderingPrefixLength — NULL placement gate, judged on effective direction
  - packages/quereus-store/src/common/store-module-access-plan.ts   # buildIndexOrderingAdvertisement / chooseOrderingPlan — same direction equality (~line 1554)
  - packages/quereus-store/src/common/store-table-scan.ts           # would need a backwards key-range walk
  - docs/module-authoring.md                                        # the providesOrdering contract modules implement
severity: cosmetic
likelihood: normal-use
tradeoffs: A user can get the same speed today by declaring a second index in the direction they need, so this buys convenience and index-count rather than a capability that is otherwise unreachable; and the change has to be made twice, once per backend, with the store half needing a backwards key-range walk it does not have.
---

# Serve descending order from an ascending index by walking it backwards

## What happens today

Both shipped backends decide whether an index can supply a requested ordering by
comparing directions for equality — the requested direction must be the direction the
index column was declared with. Neither will read an index in reverse.

Measured on the memory backend at HEAD, table with `create index t_c on t(c)`:

```
select c from t order by c desc limit 1
  LIMITOFFSET
    SORT ORDER BY c DESC          <- the whole table is sorted
      PROJECT
        INDEXSCAN t USING _primary_
```

Add `create index t_c_desc on t(c desc)` and the same query plans as a one-row index
walk. So the capability is entirely there — it is the *direction* of the stored index
that the planner insists on, not anything about the walk.

## Why it matters

Every `order by x desc limit n` shape pays for this, and so does `max(x)` once
`feat-minmax-index-boundary` lands: that rule turns `max(c)` into "walk `c` descending,
take one row", which today only fires when a descending index happens to exist. The
user report behind that work — `MAX(date)` on a 20,000-row table at 450–900 ms under
the browser storage backend — is exactly this shape. They can fix it by adding a
descending index; they should not have to.

## What "done" looks like

A module may satisfy a requested ordering by walking a matching index backwards, and
says so through the ordering claim it already returns. Concretely that means, per
backend:

- recognizing that a required ordering is the exact element-wise reverse of an index's
  own ordering (all columns flipped — a partial flip is not a reverse walk);
- returning a plan whose scan runs backwards;
- getting NULL placement right. This engine's `ORDER BY` places NULLs **first in both
  directions**. A backwards walk of an ascending index emits NULLs **last**, which is
  the mirror image of the bug `bug-desc-index-ordering-claims-misplace-nulls` already
  fixed for declared-descending indexes. The existing gate,
  `nullSafeOrderingPrefixLength`, is the right place to enforce it — but it has to be
  asked about the *effective* walk direction, not the declared column direction.

## Known hazard before turning this on

`debt-memory-reverse-secondary-pk-order` (backlog) records that the in-memory table's
backwards secondary-index read emits rows *within* one indexed value in forward
primary-key order, while the transaction-isolation layer's merge expects the whole
composite ordering reversed. Nothing requests a backwards read today, so it is dormant
— this ticket is what would wake it. It should land first, or as the first arm of this
work.

## Scope note

This is a two-backend change plus an engine-side contract clarification, and the store
half needs a backwards key-range walk it does not currently have. It is very likely
more than one implement ticket; whoever promotes it should expect to split by backend.
