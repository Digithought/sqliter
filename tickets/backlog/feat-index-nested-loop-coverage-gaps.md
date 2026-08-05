description: The engine's index-lookup join strategy ships with three deliberate restrictions that each cost it the speed-up on an ordinary query shape; lift them.
prereq: feat-index-nested-loop-join
files:
  - packages/quereus/src/planner/rules/join/index-nested-loop.ts
  - packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts
  - packages/quereus/src/planner/rules/join/rule-join-greedy-commute.ts
  - packages/quereus/src/planner/rules/join/rule-quickpick-enumeration.ts
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts
  - packages/quereus/src/planner/rules/parallel/rule-fanout-batched-outer.ts
  - packages/quereus/src/planner/nodes/key-set-semi-join-node.ts
  - packages/quereus/src/runtime/emit/key-set-semi-join.ts
  - packages/quereus/src/vtab/best-access-plan.ts
  - packages/quereus/src/vtab/filter-info.ts
tradeoffs: All three arms are performance-only — every affected query returns the right answer today, just slower — and two of them need a correctness proof (row-layout rebuild, constraint-promise preservation) before any speed is gained, so a maintainer may reasonably wait for a query that actually hurts.
----

# Three v1 restrictions on the index-nested-loop join

`feat-index-nested-loop-join` shipped the strategy with three explicit restrictions. Each
was filed separately; they are one ticket because they are the same rule
(`rules/join/index-nested-loop.ts`), the same decision point, and whoever lifts one has
already paid the cost of learning the other two. They are independently landable, and
Arm A is the cheapest first cut.

## Arm A — the rule only ever seeks the right input

The nested-loop runtime drives from the left for every join type the rule admits, so the
rule only considers seeking the **right** side. Swapping the inputs inside a
physical-selection rule would reshuffle the output row layout that the emitter's
`[...leftRow, ...rightRow]` depends on — which is why v1 did not.

In practice the restriction is usually harmless because `rule-join-greedy-commute` runs
earlier and puts the smaller input on the left, landing the large indexed table on the
right. But that heuristic decides on row-count estimates alone: it knows nothing about
which side has a usable index, so it can commute a join into exactly the orientation that
loses the seek.

Two improvements, not the same size:

- **Cheap:** have the physical-selection rule ask the *left* side whether it could seek
  too, and prefer the orientation that can, for `inner` joins only (the one join type
  where commuting is unconditionally sound). The real work is proving the row-layout
  rebuild is safe.
- **Fuller:** teach the earlier commute/enumeration rules
  (`rule-join-greedy-commute.ts`, `rule-quickpick-enumeration.ts`) that a usable index on
  one side is an input to the ordering decision, not something discovered afterwards.

## Arm B — the rule declines when the inner side already has pushed constraints

The rule requires the inner side to bottom out in an *unconstrained* table walk — a plain
full scan or an ordering-only index walk. Given `select … from small s join big b on
b.id = s.k where b.status = 'x'` with `status` indexed, the storage module has already
claimed `status = 'x'`, the leaf carries those constraints, and the rule backs off.

The decline is not caution about performance: the leaf's constraint set is the module's
**promise** that it will enforce those predicates itself, which is why the predicate no
longer appears as a filter above the scan. Replacing the leaf's access description with a
join-key seek would silently drop the promise and the query would return rows it should
have filtered out.

The fix is to *combine* rather than replace: re-ask the module for an access plan over the
union of the constraints it already claimed and the new join-key equality, and rebuild the
leaf from that combined answer. The obstacle is that the already-claimed constraints are
retained at the leaf only in their low-level encoded form — column index and operator —
not as the planner-level constraint objects carrying the value expressions a fresh
access-plan request needs. Recovering them means threading the planner-level objects onto
the physical node or re-deriving them.

## Arm C — one seek per outer row is one round trip per outer row

On an in-process table, a seek per outer row is the right shape. On a store reached over a
network — the IndexedDB and sync-backed plugins, or any module declaring a non-zero
`expectedLatencyMs` — it means one round trip per outer row, and a plain scan of the whole
inner table can beat it even though it reads far more rows.

The v1 rule handles this only by **pricing** it: per-seek latency is folded into the cost
so a high-latency inner side makes index-nested-loop lose to a hash join. Correct, but
blunt — it gives up the strategy entirely instead of making it cheap.

Both halves of the better answer already exist in the engine:

- `rule-fanout-batched-outer` buffers a window of outer rows and issues their work
  concurrently, gated on the slowest branch's declared latency;
- `KeySetSemiJoinNode` passes a whole set of seek keys to a module in one call, via the
  `runtimeSet` field on a predicate constraint that modules already understand.

Combining them turns one round trip per row into one per batch.

## Notes for whoever picks this up

- Arm B is the only arm with a *correctness* trap (dropping the module's constraint
  promise); the others are purely about not leaving speed on the table.
- Arms A and C interact: batching amplifies whichever orientation Arm A settles on, so
  landing A first makes C's benchmark easier to read.
