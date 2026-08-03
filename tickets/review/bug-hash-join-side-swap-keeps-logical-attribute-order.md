---
description: A hash join that internally reverses which of its two inputs it processes first now also reports its output columns in that reversed order, so grouped queries above it stop reading the wrong column and return correct totals. Tests and docs pin the rule.
files:
  - packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts   # THE fix, in the swap branch (~line 279)
  - packages/quereus/test/optimizer/hash-join-side-swap.spec.ts               # new — plan-level invariant, swapped and unswapped
  - packages/quereus/test/logic/11.4-hash-join-side-swap.sqllogic             # new — row equality
  - docs/optimizer-joins.md                                                   # § Bloom (Hash) Join → new "Row layout invariant" bullet
  - packages/quereus/src/runtime/emit/bloom-join.ts                           # the emitter the invariant is stated against
  - packages/quereus/src/runtime/emit/hash-aggregate.ts                       # the consumer that surfaced the bug
difficulty: medium
---

# Hash join side swap now permutes the preserved attributes

## What changed

One behavioural change, in the INNER-join build/probe swap branch of
`ruleJoinPhysicalSelection`:

```ts
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

Same attribute **ids**, permuted **order**. `preserveAttributeIds` only ever promised id
stability, not position stability, so nothing above the join is disturbed — consumers up
there resolve by id, and `select *` is expanded into an explicit `ProjectNode` at build
time, before optimization, so user-visible column order does not move.

This is the direction the ticket recommended. The `buildSide: 'left' | 'right'` flag
alternative was not needed — nothing fought the chosen fix — and the swap branch is left
in the shape `feat-index-nested-loop-commute-drive-side` was told to expect.

Also added, non-behavioural:

- A comment at the swap site stating the invariant and naming `emitBloomJoin`'s
  `[...leftRow, ...rightRow]` as the thing it must agree with.
- A `NOTE:` at the `MergeJoinNode` construction site (same function) recording why merge
  takes `preserveAttrs` unpermuted — it never swaps — and that it would need the same
  permutation if it ever did.
- A "Row layout invariant" bullet in `docs/optimizer-joins.md` § Bloom (Hash) Join, plus
  one clause on the existing side-selection bullet about the side-effect refusal, which
  the code had and the doc did not.

## The invariant, in one line

> A physical join's advertised attribute order **is** its emitted row layout.

`join.getAttributes()` must equal `[...join.left.getAttributes(), ...join.right.getAttributes()]`
by id, in order. On a swapped node `getAttributes()` was the only thing in `BloomJoinNode`
still speaking logical order — `getType()`, `combineJoinKeys` and `computePhysical`'s FD
shift were already probe-then-build.

## How to validate

### The original wrong answer

```sql
create table s (id integer primary key, k integer);
create table b (id integer primary key, k integer, v integer);
insert into s values (1,2),(2,1),(3,2),(4,1);
insert into b values (1,2,1),(2,1,2),(3,2,3),(4,1,4),(5,2,5),(6,1,6),(7,2,7),(8,1,8);
analyze;
select s.k as gk, sum(b.v) as sv from s join b on b.k = s.k group by s.k order by s.k;
```

`[{gk:1,sv:40},{gk:2,sv:32}]` now; `[{gk:1,sv:8},{gk:2,sv:16}]` before (which is
`sum(s.k)` per group — the value sitting at `b.v`'s advertised index in the emitted row).

**Run the `analyze` through `db.eval` / `db.prepare`, not `db.exec`** — see the gap noted
below. Without live statistics the swap never fires and the query looks fine either way.

### New tests

`packages/quereus/test/optimizer/hash-join-side-swap.spec.ts` — 5 specs. Asserts the
invariant on ids and on `getType().columns` names, for:

- the swapped path (4×8 + per-table `analyze`; also asserts the swap actually fired, by
  checking the probe side is the larger table);
- the plain projection over the same join — passes with or without the fix, and is there
  to say *which* consumer style broke if this goes red again;
- the unswapped path (larger table written as the logical left, so the branch does not
  run) — same equality must hold, and there it means logical-left-then-right;
- a three-table spine, every hash join in the plan.

`packages/quereus/test/logic/11.4-hash-join-side-swap.sqllogic` — pure row equality, so it
also runs under `yarn test:store`. Grouped aggregate (the failing shape), aggregate over
the probe side, grouping on the build-side column, `count(*)` / `min` / `max`, ungrouped
aggregate, plain projection, `order by` + `limit`, `distinct`, a three-table join with the
aggregate on top, and `having`.

Both layers were confirmed to **fail** with the fix reverted and pass with it applied —
the optimizer spec on 3 of its 5 cases, the sqllogic on its first grouped aggregate
(`sv: 8` vs `sv: 40`).

### Suite state

- `yarn test`: **8607 passing, 0 failing, 13 pending** across all workspaces (8601 before,
  plus the 5 new optimizer specs and 1 new sqllogic file).
- `yarn lint`: clean.
- `yarn test:store` was **not** run (it is the slow leg and outside the agent-runnable
  window). The new sqllogic file is pure row equality with no memory-module dependency, so
  it is expected to pass there, but that is an expectation and not a measurement — worth a
  reviewer's run if convenient.

## Things a reviewer should push on

**A side finding, filed separately: `db.exec('analyze')` collects nothing.**
`emitAnalyze` is an async generator and `Database.exec` never drains the block's result, so
`await db.exec('analyze')` succeeds and does no work. This is why the sqllogic file writes
each `ANALYZE` as its own block with an expected result — that forces the harness to drain
it, and doubles as an assertion that the statistics the whole file depends on actually
landed. Without that trick the file passes vacuously (verified: it did, on the first draft,
even with the fix reverted). Filed as `tickets/fix/bug-analyze-via-exec-is-a-no-op.md`,
which also lists four existing sqllogic files whose `ANALYZE;` lines are currently inert.
**Do not "clean up" the ANALYZE blocks in 11.4 until that lands.**

**Coverage the new tests do not have.** The optimizer spec asserts the invariant on
`BloomJoinNode` only, at plan level. It does not prove that the emitted row actually
matches — that link is asserted indirectly, by the sqllogic rows. A direct
emitted-row-vs-`getAttributes()` check across *every* physical emitter is what
`tickets/backlog/debt-physical-node-row-layout-matches-attributes.md` is for; it was
explicitly waiting on which direction this fix took, and the answer is now "the swapped
hash join re-derives its attribute order to probe-then-build". That ticket is unblocked;
it was deliberately not built here.

**Cost-model fragility of the fixture.** The 4×8 sizing sits close to the crossover
(`nl = 7.2` vs `hash = 6.4`). The ticket reported 4×12, 5×20, 6×24 and 10×100 firing the
same way, so there is headroom, but if a cost constant in `planner/cost/index.ts` moves,
the optimizer spec's "swap fired" assertion is the thing that will notice — and the
sqllogic file would then silently stop exercising the swap while still passing. Worth
deciding whether that is acceptable or whether the sqllogic file should also assert the
plan shape.

**Other emitters, checked lightly.** `emitMergeJoin` builds `[...leftRow, ...rightRow]`
the same way, and its children are `node.left` / `node.right` (possibly `SortNode`-wrapped,
which preserves attribute order) with no swap — so it is consistent today; that is what the
new `NOTE:` at its construction site records. `emitFanoutLookupJoin` does not build a
left++right row at all (wide-row branch layout, its own rule) and was not examined further.
Neither was widened into this fix.
