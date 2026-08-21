---
description: The persistent-storage backend can tell the planner "these rows arrive already sorted", but it only ever makes the stronger, more useful version of that statement — the one that unlocks merge joins and gap-free range reasoning — for the primary key, never for a secondary index.
files:
  - packages/quereus-store/src/common/store-module-access-plan.ts   # buildPkOrderingAdvertisement sets monotonicOn + supportsAsofRight; the secondary-index arms set neither
  - packages/quereus/src/vtab/best-access-plan.ts                   # monotonicOn / supportsAsofRight / supportsOrdinalSeek — what each claim promises
  - packages/quereus/src/vtab/memory/module.ts                      # buildMonotonicAdvertisement (~line 582) — the reference
  - packages/quereus/src/planner/rules/join/rule-lateral-top1-asof.ts # a consumer that only fires on the stronger claim
tradeoffs: Sort elision — by far the biggest win — comes from the plain ordering claim, which `feat-store-index-seek-ordering` already delivers; what is left here benefits a narrower set of join and range shapes, and one of the two flags (`supportsAsofRight`) promises a cursor-repositioning capability that would need to be checked against what the store's index scan can actually do rather than simply copied from the primary-key arm.
---

# Secondary-index plans make the weak ordering claim but never the strong one

Depends on `feat-store-index-seek-ordering` (in `implement/`) landing first — that ticket
introduces the collation gate a secondary-index ordering claim has to pass, and this work
is meaningless without it. Not recorded as a `prereq:` header because that is a signal to
the automated runner, which does not pick up backlog tickets.

## Two claims, not one

An access plan can say two different things about the order its rows arrive in.

`providesOrdering` is the weak one: "these rows are sorted this way". It is enough to
delete a `Sort`, and `feat-store-index-seek-ordering` gives the store's secondary-index
plans the ability to make it.

`monotonicOn` is the strong one, and it says more: the order is a property of how the data
is physically stored, the named column's values are totally ordered with no gaps in
coverage, and downstream rules may reason about ranges over it. `strict: true` adds "no
two rows share a value". Two further flags build on it — `supportsAsofRight` (the scan can
reposition its cursor to the largest row at or below a given key and then move forward
without re-seeking) and `supportsOrdinalSeek` (it can jump to the *k*th row directly).

The store makes the strong claim in exactly one place, `buildPkOrderingAdvertisement`,
which advertises the leading primary-key column and sets `supportsAsofRight`. Its
secondary-index plans set none of the three, so rules gated on the strong claim — merge
joins, the lateral-top-1 asof rewrite, gap-free range reasoning — never fire over a
store-backed secondary index, even where they would over the same table's primary key and
over the equivalent in-memory table.

## What is unresolved, and why it is not simply "copy the primary-key version"

Each flag needs its own answer, and at least one of them is not obviously true:

- **Which column to name.** For an index range scan the leading index column is the
  obvious answer. For a prefix-equality seek the leading columns are pinned to one value
  each and carry no information; the first *useful* column is the one after the pinned
  prefix. The in-memory backend's `buildMonotonicAdvertisement` picks one; whether the
  store should follow it needs checking rather than assuming.
- **Whether `strict` is ever true.** A secondary index is not unique unless declared so,
  and even a `UNIQUE` index admits multiple NULLs. The safe answer is always `false`; the
  useful answer may be narrower.
- **Whether `supportsAsofRight` is honestly true.** It promises the module can position a
  cursor at the largest row at or below a given key and advance from there. The store's
  primary-key arm claims it; nobody has established that the secondary-index scan path can
  do it, and copying the flag across without checking would be a promise the scan layer
  does not keep.

That third point is why this is filed as work rather than done inline with the ordering
ticket: it is a capability question about `store-table-scan.ts`, not a one-line addition
to the access plan.

## Evidence it matters

None measured. This is filed on the strength of the capability gap between the two shipped
backends, not on an observed slow query — which is a fair reason to defer it, and is
recorded in `tradeoffs:` above. If a merge join or an asof scan over a store-backed
secondary index ever shows up as a plan that should have fired and did not, that is the
evidence this ticket is currently missing.
