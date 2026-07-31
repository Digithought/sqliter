---
description: Joining two tables with the short `using (col)` syntax used to return no rows in cases where writing the join out longhand returned rows, whenever the two columns held different kinds of data. The short form now builds the exact same comparison the longhand form builds, so the two always agree.
files:
  - packages/quereus/src/planner/building/select.ts                          # buildUsingCondition — the desugar; validateUsingCollations deleted
  - packages/quereus/src/planner/nodes/join-node.ts                          # toString prefers USING; usingColumns field doc
  - packages/quereus/src/runtime/emit/join.ts                                # usingResolved + evaluateUsingCondition deleted
  - packages/quereus/src/planner/rules/join/equi-pair-extractor.ts           # extractEquiPairsFromUsing + UsingAttr deleted
  - packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts  # USING branch dropped
  - packages/quereus/src/planner/rules/join/rule-monotonic-merge-join.ts     # USING branch dropped
  - packages/quereus/src/planner/analysis/comparison-collation.ts            # isValueDiscriminatingTypePair + TypeSlice deleted (last caller was the USING extractor)
  - packages/quereus/test/logic/11.1-join-using.sqllogic                     # cross-type, absent-column, three-way cases added
  - packages/quereus/test/planner/equi-pair-semantic-gate.spec.ts            # USING block re-pointed through buildUsingCondition + extractEquiPairs
  - packages/quereus/test/optimizer/parallel-async-gather-zip-by-key.spec.ts # USING full join now folds
  - packages/quereus/test/planner/collation-soundness.spec.ts                # stale comment fixed
  - docs/optimizer-joins.md, docs/optimizer-parallel.md, docs/optimizer-fd.md, docs/types.md
difficulty: medium
---

# `using (c)` now desugars to `on l.c = r.c`

## What changed

`buildJoin` (`planner/building/select.ts`) used to store a USING join's column names on
the `JoinNode` and build **no** condition. Three separate consumers then re-implemented
the comparison from those bare names, and cross-type coercion — the step that makes `=`
compare a JSON document against a text document structurally and an integer against a
numeric string numerically — was never mirrored into any of them.

Now `buildJoin` calls a new exported `buildUsingCondition(usingColumns, leftAttrs,
rightAttrs, scope)` which synthesizes, per USING column:

```
ColumnReferenceNode(left attr)  =  ColumnReferenceNode(right attr)
```

with `insertCrossTypeCoercion` applied to the operand pair and `getType()` forced (the
type is lazily cached, and `BinaryOpNode.generateType` is where a collation conflict is
raised). Conjuncts AND-combine into `JoinNode.condition`. Column references are built
**from attributes** by first-match-per-side name lookup, not resolved through the join
scope — a USING column can be ambiguous by name within one side.

Three parallel implementations were deleted rather than left dead:

- `evaluateUsingCondition` / `usingResolved` in `runtime/emit/join.ts` (plus its
  now-unused `makeOperandComparator` / `effectiveCollationOfTypes` / `BINARY_COLLATION`
  / `ANY_TYPE` imports). `conditionMet` lost its two row parameters.
- `extractEquiPairsFromUsing` + its `UsingAttr` type in `equi-pair-extractor.ts`, and
  the `else if (node.usingColumns)` branches in both physical-selection rules.
- `validateUsingCollations` in `select.ts` — subsumed by the forced `getType()`; its
  rationale comment moved onto the desugar.
- `isValueDiscriminatingTypePair` and its `TypeSlice` type in
  `planner/analysis/comparison-collation.ts` — the USING extractor was its only caller
  (verified by grep across `src/` and `test/`).

`JoinNode.usingColumns` survives (it is part of the `JoinCapable` interface) and
`toString()` now prefers the `USING(...)` spelling, so EXPLAIN stays faithful. The field
comment states that `condition` is authoritative and `usingColumns` is presentational.
All four rules that rebuild a `JoinNode` thread the condition through verbatim, so that
preference cannot hide a modified predicate today.

## Behavior changes a reviewer should probe

**Cross-type USING pairs now match (the bug).** Verified against the built package:

```
jsonUSING: [{"lid":1,"rid":10}]     -- was []
jsonON   : [{"lid":1,"rid":10}]
numUSING : [{"lid":1,"rid":10}]     -- was []
```

**A USING column absent from a side now raises** instead of silently returning zero rows:
`USING column not found on left side of join: zzz` (`StatusCode.ERROR`). This is a new
user-visible error where there previously was silence. Worth a second opinion on the
message wording and on whether `StatusCode.ERROR` is the right code.

**A `full outer join … using (k)` now folds into the parallel async-gather zip-by-key
plan.** The old test asserted the *absence* of this capability; it now asserts the fold
and the same row set it already expected.

**Multi-column USING with one unsound column improved.** The old extractor sank the
whole extraction (no residual to demote into); the desugared condition has one, so the
sound column still keys the join and only the unsound conjunct demotes to residual.
Pinned by a new unit case.

**Cross-type USING pairs run as nested loop.** A coerced operand is a `CastNode`, and
`extractEquiPairs` only recognizes `ColumnReferenceNode = ColumnReferenceNode`. This is
intended — the spelled-out ON form already does exactly this for the same pair. Confirmed
via the plan for a JSON/TEXT USING join: `JOIN | INNER JOIN USING(k)` with
`BINARYOP | k = cast(k as json)` beneath it.

## Test / validation surface

Run: `yarn build && yarn lint && yarn test` — all clean (quereus: 8189 passing, 13
pending, 0 failing; lint clean across all packages). No pre-existing failures surfaced.

Coverage added or reworked:

- `test/logic/11.1-join-using.sqllogic` — cross-type JSON↔TEXT and INTEGER↔TEXT USING
  joins each paired with the spelled-out ON form asserting the identical row set; the
  absent-column `-- error:` case; a three-way `t3a left join t3b using (k) join t3c
  using (k)` case whose fixtures discriminate first-match-per-side pairing (the
  null-extended row's `t3b.k` is NULL while `t3a.k` is 20, so pairing on the wrong `k`
  drops a row). Header comment at the collation-conflict block corrected — USING pairs
  *are* `BinaryOpNode`s now.
- `test/planner/equi-pair-semantic-gate.spec.ts` — the `extractEquiPairsFromUsing`
  describe block became "USING, desugared to an ON condition", exercising
  `extractEquiPairs(buildUsingCondition(...))`. Every behavior the old block pinned
  survives (semantic-ordering gate, collation tagging, case-insensitive name match) plus
  new cases for the conflict now *raising*, the absent-column error, first-match pairing,
  and the cross-type no-equi-pair outcome.
- `test/optimizer/parallel-async-gather-zip-by-key.spec.ts:403` — flipped to assert the fold.
- `test/planner/collation-soundness.spec.ts:218` — stale comment fixed.

## Known gaps / things worth a skeptical look

- **`buildUsingCondition` is now exported from `planner/building/select.ts` purely so the
  unit spec can drive it with literal attributes.** It has no other external caller. If
  the reviewer prefers it private, the coverage would have to move to a db-backed spec.
- **The signature takes attribute arrays, not the two `RelationalPlanNode`s** — a
  deliberate choice for testability. `buildJoin` calls `getAttributes()` at the call site.
- **`using ()` with zero columns** raises `USING clause requires at least one column`.
  I did not confirm the parser can even produce that shape; it is a defensive guard, and
  no test covers it.
- **`getLogicalAttributes()` still reports `hasCondition: true`** for a USING join, which
  is now always true. Accurate but no longer discriminating; not changed.
- **Not measured: the nested-loop cost change.** See the tripwire below. No profiling was
  done either before or after.
- **`yarn test:store` was not run** (LevelDB path). Nothing in the diff is store-specific,
  but the store suite re-runs the same logic corpus including `11.1-join-using.sqllogic`,
  so it is the one untried surface.
- The `docs/optimizer-fd.md` gate description said "three input shapes" and now says
  "two" — worth confirming no other doc still counts three.

## Tripwire (recorded, not a ticket)

The nested-loop USING path used to resolve one comparator per column at emit time; it now
evaluates a condition sub-program per row pair, like every ON join. Only USING joins that
fall back to nested loop (cross-type pairs, existence-flag joins) pay this. **Not
measured.** If a USING-heavy workload ever profiles slower, the fix belongs in the shared
ON-condition evaluation path, not in a restored USING special case. Recorded as a `NOTE:`
in the `buildUsingCondition` doc comment (`planner/building/select.ts`).
