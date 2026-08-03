---
description: When the planner feeds the two sides of a join into the hash-join operator in the opposite order, it forgets to tell the rest of the query, so a grouped query above that join reads every value out of the wrong column and silently returns wrong totals. Fix the ordering and add tests that pin it.
files:
  - packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts   # THE fix site — the swap branch, ~line 266
  - packages/quereus/src/planner/nodes/bloom-join-node.ts                     # already probe-then-build everywhere except the preserved attrs
  - packages/quereus/src/runtime/emit/bloom-join.ts                           # emits [...leftRow, ...rightRow] = probe-then-build
  - packages/quereus/src/runtime/emit/hash-aggregate.ts                       # the positional consumer that surfaces the mismatch
  - packages/quereus/test/optimizer/index-nested-loop.spec.ts                 # model for the new optimizer spec
  - packages/quereus/test/logic/11.3-index-nested-loop-join.sqllogic          # model for the new sqllogic file
  - docs/optimizer-joins.md                                                   # line ~97 documents side selection; add the row-layout invariant
difficulty: medium
repro: verified
---

# Hash join swaps build/probe sides but keeps the logical attribute order

## What is wrong

`rule-join-physical-selection.ts` builds a `BloomJoinNode` (hash join). For an INNER
join whose left input is estimated smaller than its right, it **swaps** the two inputs
so the smaller one becomes the hash build side:

```ts
const preserveAttrs = node.getAttributes().slice();   // logical left, then logical right
...
if (joinType === 'inner' && leftRows < rightRows && !sideEffects) {
    probeSource = node.right;      // sides swap
    buildSource = node.left;
    equiPairs   = /* flipped */;
}
return new BloomJoinNode(node.scope, probeSource, buildSource, joinType, equiPairs,
                         extracted.residual, preserveAttrs);   // ← order NOT flipped
```

`buildJoinAttributes` returns `preserveAttributeIds` verbatim, so after a swap the node
**advertises** logical-left-then-logical-right while `emitBloomJoin` **yields**
`[...leftRow, ...rightRow]` — that is, probe-then-build. Any consumer that turns an
attribute id into a column index via `plan.source.getAttributes()` and then indexes the
row array positionally reads the wrong slot.

`emitHashAggregate` is such a consumer: it builds `scanRowDescriptor` over
`plan.source.getAttributes()` and `context.set`s it against each source row *after* the
join has already installed its own per-side slots, so its (wrong) descriptor wins. A
plain `select` over the same join is unaffected because column references above the join
resolve through the join emitter's own `leftSlot` / `rightSlot`, each built from its own
child's attributes and therefore correct by construction.

## Reproduction — memory module, no plugin needed

The original report needed the LevelDB/IndexedDB store module, but that was an artifact
of missing statistics, not of the backend: after `ANALYZE` the memory module reports
exact per-table row counts too, and the swap fires. Verified at HEAD:

```sql
create table s (id integer primary key, k integer);
create table b (id integer primary key, k integer, v integer);
insert into s values (1,2),(2,1),(3,2),(4,1);
insert into b values (1,2,1),(2,1,2),(3,2,3),(4,1,4),(5,2,5),(6,1,6),(7,2,7),(8,1,8);
analyze;

select s.k as gk, sum(b.v) as s from s join b on b.k = s.k group by s.k order by s.k;
```

Expected `[{gk:1,s:40},{gk:2,s:32}]`; **actual at HEAD** `[{gk:1,s:8},{gk:2,s:16}]`.

The observed numbers are exactly `sum(s.k)` per group, which is what index 4
(`b.v`'s advertised position) lands on in the emitted row — the mis-index is confirmed
arithmetically, not just by "the answer looks wrong".

Why these sizes: the swap fires when `leftRows < rightRows` **and** hash beats nested
loop. With `nlCost = L + 0.1·L·R` and `hashCost = 0.8·min + 0.4·max`
(`planner/cost/index.ts`), 4×8 gives nl=7.2 vs hash=6.4 — hash wins, left is smaller,
swap fires. Sizes 4×12, 5×20, 6×24 and 10×100 were all verified to fire the same way, so
there is headroom if a cost constant shifts.

Direct plan-level evidence at HEAD for the same query:

```
advertised getAttributes(): [s.id, s.k, b.id, b.k, b.v]
emitted   left++right     : [b.id, b.k, b.v, s.id, s.k]
getType().columns         : [b.id, b.k, b.v, s.id, s.k]
```

Note the third line: `getType()` **already** describes the row as probe-then-build (it
calls `buildJoinRelationType(leftType, rightType, …)` on the physical children), and so
do `combineJoinKeys` and `computePhysical`'s `leftAttrs.length` FD shift. On a swapped
node `getAttributes()` is the **only** thing in `BloomJoinNode` still speaking logical
order — it is the outlier, not the reference.

## The fix

Reorder the preserved attributes to probe-then-build inside the swap branch, so the node
advertises what its emitter yields and what the rest of the node already assumes:

```ts
let equiPairs = extracted.equiPairs;
let hashAttrs = preserveAttrs;

if (joinType === 'inner' && leftRows < rightRows && !sideEffects) {
    probeSource = node.right;
    buildSource = node.left;
    equiPairs   = /* flipped, unchanged */;
    hashAttrs   = [...preserveAttrs.slice(leftAttrs.length),
                   ...preserveAttrs.slice(0, leftAttrs.length)];
}

return new BloomJoinNode(..., equiPairs, extracted.residual, hashAttrs);
```

Same attribute **ids**, permuted **order** — which is exactly what `preserveAttributeIds`
was for (id stability, not position stability). This was applied experimentally and:

- the repro above returns the correct `40 / 32`,
- `yarn test` was fully green — **8601 passing** in `packages/quereus`, zero failures
  across every workspace.

The experiment was then reverted; the tree is clean and the change is yours to (re-)apply.

### Why this direction and not the others

- **Make the emitter yield in logical order instead.** Would also require rewriting
  `getType()`, `combineJoinKeys`'s key positions and `computePhysical`'s
  `leftAttrs.length` FD shift, all of which are probe-then-build today, plus a per-row
  permutation. Strictly more code and more risk for the same invariant.
- **Keep children in logical order and add a `buildSide: 'left' | 'right'` flag the
  emitter reads.** Cleanest in principle — the physical choice would stop leaking into
  the plan's column order at all, and `JoinCapable.getLeftSource()` would stop lying
  about which side is the logical left. But it means branching the build/probe loop and
  the `joinOutputRow` null-padding / semi-anti path in `emitBloomJoin`, for a case that
  only ever arises on INNER joins. Not worth it for a live wrong-answer bug; **if you
  find yourself fighting the chosen fix, this is the fallback**, and it is also the shape
  `feat-index-nested-loop-commute-drive-side` would want.

Only the hash-join branch swaps; `MergeJoinNode` takes `preserveAttrs` from the same site
but never reorders its sides, so it needs no change.

### Blast radius of permuting the attributes

Every other positional consumer of a swapped hash join's row (sort/distinct key
extraction, set-op alignment, cache keys) reads through `getAttributes()` or `getType()`,
so aligning those with the emitter fixes them in the same stroke — there is no second
site to chase. Consumers above the join resolve by attribute id, and `select *` is
expanded into an explicit `ProjectNode` at build time (before optimization), so the
user-visible column order does not move. The green full-suite run is the evidence.

## Tests to add

Two layers, because each catches what the other cannot.

**Optimizer spec** — `packages/quereus/test/optimizer/hash-join-side-swap.spec.ts` (new;
model it on `test/optimizer/index-nested-loop.spec.ts`, which already sets up asymmetric
tables + `ANALYZE` and walks the plan). Assert the *invariant*, on both paths:

- swapped path (4×8 + `ANALYZE` fixture above): a `BloomJoinNode` exists, its
  `left` is the larger table (swap fired), and
  `join.getAttributes().map(a => a.id)` equals
  `[...join.left.getAttributes(), ...join.right.getAttributes()].map(a => a.id)`;
- same equality on `getType().columns` (names/arity line up with `getAttributes()`);
- unswapped path (make the left side the larger one so the branch does not fire) —
  the same equality must hold there too, and the advertised order must still be
  logical-left-then-right.

**sqllogic** — `packages/quereus/test/logic/11.4-hash-join-side-swap.sqllogic` (new).
Pure row equality so it holds whichever physical join is chosen, and it also runs under
`yarn test:store`. Cover: the grouped aggregate above the join (the failing shape), the
plain projection over the same join (passes today — include it so a future regression
tells you *which* consumer style broke), a three-or-more-table join with the aggregate on
top, and `count(*)` / `min` / `max` over the swapped join. The plain-projection form
passing today is exactly why a regression test written only over projections would not
have caught this.

## Docs

`docs/optimizer-joins.md` line ~97 documents side selection ("For INNER JOINs, the
smaller input is the build side…"). Extend it with the invariant this bug violated: a
physical join's advertised attribute order **is** its emitted row layout, so swapping
build/probe must permute the preserved attributes with it.

## Related tickets — do not fold in

- `tickets/backlog/debt-physical-node-row-layout-matches-attributes.md` — the
  cross-cutting property-test guard over *every* physical emitter. It is already filed
  with `prereq: bug-hash-join-side-swap-keeps-logical-attribute-order` and explicitly
  waits on which direction this fix picks. Do not build that guard here; the answer it
  needs is "the swapped hash join re-derives its attribute order to probe-then-build".
- `tickets/backlog/feat-index-nested-loop-commute-drive-side.md` — a feature about which
  side to seek, which names this exact hazard for the index-nested-loop path. Leave the
  swap branch in a state that feature can build on (the `buildSide` flag sketched above
  is what it would want); do not implement it here.

## TODO

- Apply the `hashAttrs` permutation in the swap branch of
  `rule-join-physical-selection.ts`, with a comment stating the invariant (advertised
  order == emitted row layout) and pointing at `emitBloomJoin`'s
  `[...leftRow, ...rightRow]`.
- Add `test/optimizer/hash-join-side-swap.spec.ts` with the swapped and unswapped
  invariant assertions described above.
- Add `test/logic/11.4-hash-join-side-swap.sqllogic` with the grouped-aggregate,
  plain-projection, multi-table and other-aggregate cases.
- Extend `docs/optimizer-joins.md` § side selection with the row-layout invariant.
- Run `yarn test` (expect ~8601 passing in `packages/quereus`) and `yarn lint`.
- Optional, only if cheap: check whether `emitMergeJoin` / `emitFanoutLookupJoin` build
  their output rows on the same probe-then-build assumption; if either has a latent
  disagreement, note it in the review handoff rather than widening this fix.
