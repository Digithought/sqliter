---
description: The per-row index lookup used for joins gives up whenever the table being looked up is also filtered by another indexed column; teach the two filters to cooperate instead.
prereq: feat-index-nested-loop-seek-side-election
files:
  - packages/quereus/src/planner/rules/join/index-nested-loop.ts             # admitLeaf / probeModule — the two gates that change
  - packages/quereus/src/planner/rules/shared/access-leaf.ts                 # peelToSeekableAccessLeaf — already admits seek leaves
  - packages/quereus/src/planner/nodes/table-access-nodes.ts                 # IndexSeekNode.pushedConstraints (read-only reference)
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts     # selectPhysicalNode / reattachUnconsumedConstraints (read-only reference)
  - packages/quereus/src/planner/rules/access/rule-key-set-seek.ts           # the same problem, already solved for the key-set rewrite — copy its shape
  - packages/quereus/src/planner/analysis/scalar-subqueries.ts               # hasRelationalDescendant, reused as a gate
  - packages/quereus/test/optimizer/index-nested-loop.spec.ts
  - packages/quereus/test/logic/11.3-index-nested-loop-join.sqllogic
  - docs/optimizer-joins.md
  - docs/optimizer-rules.md
difficulty: hard
---

# Combine a join-key seek with the filters the storage module already claimed

## What declines today, and why

`index-nested-loop.ts`'s `admitLeaf` requires the join's inner side to bottom out in an
*unconstrained* every-row walk — a plain full scan, or an index walk used only for its
ordering. Given

```sql
select … from small s join big b on b.id = s.k where b.status = 'x'
```

with `status` indexed and the storage module willing to seek on it, the module has already
claimed `status = 'x'`; the leaf is an `IndexSeekNode` and the predicate no longer appears
as a filter above it. `peelToAccessLeaf` deliberately returns null for that leaf and the
rewrite is declined.

The decline is a correctness decision, not caution about speed. A leaf's `FilterInfo` is
the **sole enforcer** of the predicates the module claimed; replacing it wholesale with a
join-key seek would silently drop `status = 'x'` and the query would return rows it should
have filtered out.

## Why this is now much cheaper than the parent ticket assumed

The parent ticket said the already-claimed constraints survive at the leaf "only in their
low-level encoded form — column index and operator — not as the planner-level constraint
objects carrying the value expressions a fresh access-plan request needs". **That is no
longer true.** `feat-key-set-seek-over-pushed-constraints` has since shipped
`IndexSeekNode.pushedConstraints`: the exact planner-level `PredicateConstraint[]` — with
`sourceExpression`, `value` / `valueExpr` and `bindingKind` — that the leaf's `FilterInfo`
enforces, stamped by `selectPhysicalNode` from the very `consumed` set it built the
`FilterInfo` from. `peelToSeekableAccessLeaf` (same file, `access-leaf.ts`) already admits
a seek leaf; `peelToAccessLeaf` is just that function with the seek case rejected.

So the work is a re-probe, not an archaeology project.

## The change

Add a second admission arm for an `IndexSeekNode` inner leaf, and combine rather than
replace.

1. **Peel with `peelToSeekableAccessLeaf`.** When the leaf is an `IndexSeekNode`, run the
   seek-arm gates (each an early `return null`, logged):
   - `pushedConstraints` is present and non-empty. A seek whose enforced predicate we
     cannot describe is a seek we cannot safely re-plan.
   - No pushed `limit` / `offset` on the leaf's `FilterInfo` (unchanged from today — a
     pushed limit is a directive a re-planned seek would not honour).
   - `orderingLoadBearing === false`.
   - No recorded constraint is `correlated`. A correlated pushed constraint means the leaf
     is already somebody else's per-outer-row seek; re-planning it would re-plan their
     correlation. (The rule's sibling-reference guard already blocks this rule's *own*
     output, so this gate is about lateral seeks correlated to an enclosing scope.)
   - No recorded constraint's `sourceExpression` has a relational descendant
     (`hasRelationalDescendant`, `planner/analysis/scalar-subqueries.ts`). A
     subquery-bearing predicate that gets reattached as a `Filter` inside the inner
     pipeline would re-execute per outer row. Same gate `rule-key-set-seek`'s seek arm
     carries, for the same reason.
2. **Combine.** `combined = [...leaf.pushedConstraints, ...joinKeyConstraints]`, where the
   join-key constraints are what the rule already synthesizes and extracts today. Both
   lists are the same `PredicateConstraint` type `selectPhysicalNode` consumes.
3. **Re-probe with the combined set.** The seek probe becomes `ask(combined)`. The
   *baseline* is no longer `ask([])` — it must be the **displaced plan**, i.e. what the
   leaf costs today: `leaf.filterInfo.indexInfoOutput.estimatedCost` and
   `Number(leaf.filterInfo.indexInfoOutput.estimatedRows)`. Comparing against a bare scan
   would let a combined plan that is *worse than the existing seek* win. This is exactly
   the third-probe change `rule-key-set-seek` made; read `probeModuleCosts` there first.
   The existing walk arm keeps `ask([])` as its baseline, unchanged.
4. **Tighten the seek-column checks for the combined set.**
   - Every column in `seekPlan.seekColumnIndexes` must belong to some constraint in
     `combined` (today: to the join constraints only).
   - At least one seek column must come from a **join-key** constraint. Without this the
     module can answer with the seek it already had, nothing is gained, and the rule
     rebuilds an identical leaf on every visit.
   - The handled-filter check (`seekPlan.handledFilters[i] === true` for every consumed
     seek column) is applied over `combined`, positionally.
   - A module-supplied `residualFilter` still declines.
5. **Rebuild via `selectPhysicalNode(leaf.source, seekPlan, combined)`** — unchanged call
   shape, wider constraint list. Then re-verify, as today, that an `IndexSeekNode` came
   back (peeling through the collation-residual `FilterNode`), and additionally that its
   `pushedConstraints` include at least one of the join-key constraints — proof the seek
   really is correlated and not the old one re-minted.

### The correctness argument, in one paragraph

Every constraint in `combined` ends up in exactly one of two places:
`selectPhysicalNode` records the ones the module consumed on the new leaf's
`pushedConstraints` (the module re-promises to enforce them), and hands the rest to
`reattachUnconsumedConstraints`, which wraps the new leaf in a `Filter` carrying their
`sourceExpression`s. Because `combined ⊇ leaf.pushedConstraints`, and because
`pushedConstraints` is by construction the exact set the displaced leaf's `FilterInfo`
enforced, no predicate can be lost — it is either re-promised or re-applied. That is a
structural property of `selectPhysicalNode`, not a convention this rule has to trust.

## Edge cases & interactions

- **The module keeps its original seek and refuses the join key.** Gate 4's
  "at least one join-key seek column" check declines; the plan is unchanged and the rule
  must be idempotent on the next visit.
- **The module takes the join key and drops the original filter.** The dropped filter
  comes back as a `Filter` above the new seek, inside the peeled wrapper chain. Pin this
  with a row-level test whose predicate actually excludes rows the seek returns — a test
  where the filter is redundant proves nothing.
- **Both consumed** (e.g. a composite index on `(status, id)`). No reattached filter; the
  seek carries both.
- **`between` / two constraints sharing one `sourceExpression`.** `reattachUnconsumedConstraints`
  and `combineResidualExpressions` de-duplicate by node identity, so a `between` comes back
  as its single `BetweenNode`. Cover it — `rule-key-set-seek`'s review added exactly this
  case after the first implementation missed it.
- **Duplicate columns between the two lists.** A pushed `b.id > 10` plus a join key on
  `b.id`: `combined` then carries two constraints on the same column. Confirm the module
  probe and `selectPhysicalNode` handle that (they do for user predicates today), and that
  whichever is unconsumed reattaches.
- **Impossible combination.** `selectPhysicalNode` folds `rows === 0` with all filters
  handled into an `EmptyResultNode`. As today, that must **not** be adopted — a
  per-outer-row binding is never provably unsatisfiable at plan time. The existing
  "an `IndexSeekNode` must have come back" check already rejects it; keep it and keep the
  comment explaining why.
- **Collation decline.** `MISMATCH_UNSAFE` degrades to a `SeqScan` + residual; the same
  check rejects it. `COARSER_SAFE` wraps the seek in a `Filter` — the verification must
  peel through it (it already does).
- **LEFT / SEMI / ANTI inner sides.** The reattached `Filter` sits *inside* the inner
  pipeline, so a row it rejects makes the seek look empty for that outer row — which is
  the correct semantics for all four admitted join types (null-pad, drop, keep). Assert it
  for `left` and `anti` specifically, where "no inner row" is observable.
- **Interaction with the mirrored orientation** (`feat-index-nested-loop-seek-side-election`,
  the prereq). Both orientations must run the new arm, so a join with pushed constraints on
  *both* sides can still elect the cheaper. The prereq refactors `tryIndexNestedLoop` to
  take `outer` / `inner` explicitly; build on that signature rather than reverting it.
- **Probe volume.** This adds no probe — the seek probe's argument widens and the baseline
  becomes a field read instead of a second probe call, so the walk arm's two-probe cost is
  actually one probe plus a field read on the seek arm. Note it in the header comment next
  to the existing probe-volume `NOTE:`.

## Tests

Plan shape, in `test/optimizer/index-nested-loop.spec.ts`:

- `small s join big b on b.id = s.k where b.status = 'x'`, `status` indexed, produces a
  `JoinNode` whose right subtree contains a correlated `IndexSeek` on `b.id`, with the
  `status` predicate present as a `Filter` above it (or as a second seek column when the
  module takes both — assert on *which*, so the test says what the module actually did).
- The module declining the join key leaves the plan byte-for-byte unchanged.
- Idempotence on the rewritten plan.
- Each seek-arm gate declines: correlated pushed constraint, subquery-bearing pushed
  constraint, pushed limit, `orderingLoadBearing`.

Rows, in `test/logic/11.3-index-nested-loop-join.sqllogic`: a filter that genuinely
excludes rows the join-key seek returns, over `inner`, `left` and `anti`, with `order by`.
Run these in store mode too (`yarn test:store`) — the store module pushes equality filters
into secondary indexes where the memory module does not, so the store run is what actually
exercises the seek arm end to end.

## TODO

- Read `rule-key-set-seek.ts`'s `admitSeekLeaf` and `probeModuleCosts` first — this ticket
  is the same problem, already solved once, on a different rewrite. Reuse its structure and
  its vocabulary rather than inventing a parallel one.
- Split `admitLeaf` into the unchanged every-row-walk arm and a new `admitSeekLeaf`, one
  guarded return per gate.
- Widen the probe to the combined constraint set; switch the seek arm's baseline to the
  displaced plan's cost and rows.
- Tighten the seek-column checks (belongs-to-combined, at-least-one-join-key,
  handled-filters over `combined`).
- Rebuild through `selectPhysicalNode` with the combined list; verify the returned seek is
  correlated.
- Confirm empirically, against the memory module *and* the store module, that a query with
  both a pushed filter and a join key plans and answers correctly. Record which module took
  which constraints.
- `yarn test`, `yarn test:store`, `yarn lint`, `yarn typecheck`, `yarn build`,
  `node scripts/check-docs.mjs` — all in the foreground.
- Update `docs/optimizer-joins.md` and `docs/optimizer-rules.md`: the decline list for
  index-nested-loop currently says "pushed constraints on the leaf" outright; replace it
  with the seek arm and its gates.
