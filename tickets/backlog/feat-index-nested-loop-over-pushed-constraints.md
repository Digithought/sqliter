---
description: The engine's index-lookup join strategy backs off entirely when the looked-up table already has a filter of its own pushed into it, so a query that both joins and filters that table loses the speedup.
prereq: feat-index-nested-loop-join
files:
  - packages/quereus/src/planner/rules/join/index-nested-loop.ts
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts
  - packages/quereus/src/vtab/filter-info.ts
---

# Index-nested-loop join over an inner side that already has pushed constraints

The index-nested-loop join requires the inner side to bottom out in an *unconstrained*
table walk — a plain full scan, or an ordering-only index walk. If the storage module
has already claimed a predicate of its own on that table (`select … from small s join
big b on b.id = s.k where b.status = 'x'`, with `status` indexed), the leaf carries
those claimed constraints, and the rule declines.

The reason it declines is not caution about performance: the leaf's constraint set is
the module's *promise* that it will enforce those predicates itself, which is why the
predicate no longer appears as a filter above the scan. Replacing that leaf's access
description with a join-key seek would silently drop the promise, and the query would
return rows it should have filtered out.

The fix is to combine rather than replace: re-ask the module for an access plan over
the union of the constraints it already claimed and the new join-key equality, and
rebuild the leaf from that combined answer. The obstacle is that the already-claimed
constraints are only retained at the leaf in their low-level encoded form — column
index and operator — not as the planner-level constraint objects carrying the value
expressions that a fresh access-plan request needs. Recovering them means either
threading the planner-level objects onto the physical node or re-deriving them, and
picking between those is the real design question here.

`backlog/feat-key-set-seek-over-pushed-constraints` is the same limitation at a
different site (the key-set semi join). If both get solved, they likely want the same
mechanism.

How much this costs in practice is mild: it only bites when the module actually claims
the local predicate, and in that case the inner side already has *an* index seek. It is
worth doing when a real query is measured losing the join-key seek to a less selective
local one.
