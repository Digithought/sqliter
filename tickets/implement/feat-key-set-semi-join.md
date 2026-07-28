---
description: When a query filters a big table by a set of values coming from a subquery, collect that set first and then look up just those rows in the index, instead of reading the whole table.
prereq: feat-runtime-key-set-protocol, feat-uncorrelated-in-semijoin
files:
  - packages/quereus/src/planner/nodes/plan-node-type.ts               # new node type
  - packages/quereus/src/planner/nodes/key-set-semi-join-node.ts       # NEW
  - packages/quereus/src/planner/rules/access/rule-key-set-seek.ts     # NEW
  - packages/quereus/src/planner/rules/access/rule-monotonic-limit-pushdown.ts  # peel/rebuild pattern to copy
  - packages/quereus/src/planner/optimizer.ts                          # rule registration (~line 905)
  - packages/quereus/src/runtime/emit/key-set-semi-join.ts             # NEW
  - packages/quereus/src/runtime/emit/scan.ts                          # FilterInfoOverride hook (already exists)
  - packages/quereus/src/runtime/emit/ordinal-slice.ts                 # the override pattern to copy
  - packages/quereus/src/runtime/emit/bloom-join.ts                    # key extraction to factor out
  - packages/quereus/src/runtime/register.ts                           # emitter registration
  - packages/quereus/src/planner/nodes/bloom-join-node.ts              # the node the rule anchors on
  - packages/quereus/src/vtab/idx-str.ts                               # encodeIdxStr / makeIdxStrSpec
  - packages/quereus/src/vtab/index-descriptor.ts                      # resolveIndexDescriptor
  - docs/optimizer-rules.md
  - docs/optimizer.md
difficulty: hard
---

# Materialize the key set, then seek the target with it

## What this builds

After `feat-uncorrelated-in-semijoin`, `delete from big where id in (select id from small)`
plans as a hash semi join: `small` is drained into a hash table, then every row of `big` is
streamed and probed. Linear, but it still reads all of `big`.

This ticket adds a physical node that does the same thing and, when it is worth it, hands
the collected key set to the storage backend so the backend reads only the matching rows.

```
KeySetSemiJoin  on big.id  (push=by_id, breakEven=NNN)
├─ target:    SeqScan(big)          ← the leaf whose FilterInfo gets rewritten at runtime
└─ keySource: <the inner relation>  ← drained once into a set
```

## The central design decision: the probe never goes away

The node **always** builds the key set and **always** probes each target row against it.
The pushdown only changes how many rows the target emits. That makes correctness
independent of the pushdown: if the seek over-fetches, the probe removes the extras; if the
pushdown is skipped entirely (set too large, wrong runtime context) the node degrades to
exactly the hash semi join it replaced. A bug in the seek path can cost performance; it
cannot produce a wrong answer.

The one thing the probe cannot fix is an **under-fetch** — rows the seek fails to return.
Every gate below exists to make under-fetch impossible.

## The second design decision: no new runtime protocol

`feat-runtime-key-set-protocol` establishes the plan-time question. The answer at runtime
needs **no new channel**: the emitter rewrites the leaf's `FilterInfo` into an ordinary
single-column `plan=5` multi-seek — the identical shape `rule-select-access-path` already
emits for `where col in (1,2,3)` (see its single-column arm, `inCount=<K>`, one EQ
constraint per key, `argvIndex` 1…K). `StoreTable.scanMultiSeek`,
`vtab/memory/layer/scan-plan.ts` and `IsolatedTable.buildConstraintMatcher` all consume it
unchanged, because they cannot tell it apart from a literal list.

The mechanism is the existing `FilterInfoOverride` hook on `emitSeqScan`
(`runtime/emit/scan.ts`), which `OrdinalSlice` already uses to stamp `limit`/`offset`.
Copy that pattern.

## Plan node

`PlanNodeType.KeySetSemiJoin`, in `planner/nodes/key-set-semi-join-node.ts`.

```ts
/** How the target's access path is rewritten when the runtime decides to seek. */
interface KeySetPushdown {
	/** Index name as it must appear in idxStr (the module's own spelling). */
	readonly indexName: string;
	/** Structured identity of that index — must resolve; an unresolved path declines. */
	readonly accessPath: AccessPath;          // always { kind: 'index', plan: 'multiSeek' }
	/** Table column index the seek is on (the index's leading key column). */
	readonly seekColumnIndex: number;
	/** true ⇒ the index's leading key column is DESC, so keys sort descending. */
	readonly seekDescending: boolean;
	/** Engine ceiling the module accepted. Above this the runtime scans instead. */
	readonly maxKeys: number;
	/** Seek iff the materialized distinct key count is ≤ this. See "Choosing seeks vs scan". */
	readonly breakEvenKeys: number;
}

class KeySetSemiJoinNode extends PlanNode implements BinaryRelationalNode {
	readonly nodeType = PlanNodeType.KeySetSemiJoin;
	constructor(
		scope: Scope,
		readonly target: SeqScanNode,             // the access leaf, verbatim
		readonly keySource: RelationalPlanNode,
		readonly targetAttrId: number,            // join key attribute on the target side
		readonly keyAttrId: number,               // join key attribute on the keySource side
		readonly pushdown: KeySetPushdown,
	) { … }
}
```

- `getAttributes()` / `getType()` — the target's, verbatim (semi-join semantics; mirrors
  `buildJoinAttributes` for `'semi'`, which exposes only the left side with unchanged ids).
- `getChildren()` / `getRelations()` — `[target, keySource]`.
- `withChildren` — rebuild; the first child must still be a `SeqScanNode`.
- `estimatedRows` — `estimateJoinRows(target.estimatedRows, keySource.estimatedRows, 'semi')`.
- Self cost — `hashJoinCost(keySourceRows, targetRows)`, i.e. the same self-cost the
  `BloomJoinNode` it replaces charged. The saving is in the *target's* row count, which is
  not modelled at plan time (the decision is deferred to runtime by design); do not invent a
  discount here.

### `computePhysical` — read this before writing it

Propagate the **target's** `fds`, `equivClasses`, `constantBindings`, `domainConstraints`
and `inds` (the output is a row-subset of the target with identical attributes), and
`estimatedRows`.

**Do not propagate `ordering`, `monotonicOn`, or `accessCapabilities`.** Emission order
depends on a decision made at runtime: seek order (index-key order on the seek column) when
pushing, the leaf's native order when scanning. Claiming either would let a `Sort` be
elided that the plan actually needs.

This is safe with respect to what already ran: `BloomJoinNode.computePhysical` propagates
no `ordering` or `monotonicOn` either, so nothing above the join it replaces could have
been built on the leaf's order. Losing those properties is not a regression — it is the
status quo. Record that reasoning as a comment on `computePhysical`; it is the non-obvious
invariant a future reader will want.

## Rule: `rule-key-set-seek`

Anchored on `PlanNodeType.HashJoin` (`BloomJoinNode`), registered in
`planner/optimizer.ts` in `PassId.PostOptimization`, **after** `join-physical-selection`
(so the hash semi join exists) and **after** `monotonic-limit-pushdown` (so a
`LIMIT`-over-leaf pushdown keeps priority; the two peels are mutually exclusive and
whichever runs first wins — LIMIT pushdown is the more valuable of the two on the shapes
where both could apply). `phase: 'impl'`. The rule declines when either side has side
effects, so `sideEffectMode: 'safe'` is accurate; state that in the registration comment.

### Structural match

1. `joinType === 'semi'`, exactly one `equiPairs` entry, `residualCondition === undefined`.
2. `PlanNodeCharacteristics.subtreeHasSideEffects(right) === false` and
   `isDeterministic(right)`. Same admission test the set-probe and the decorrelation rule use.
3. Peel `left` down to an access leaf, descending only through `AliasNode`, trivial
   `ProjectNode` (every projection a bare `ColumnReferenceNode`), and `FilterNode`. Copy
   `peelToLeaf` / `rebuildChain` from `rule-monotonic-limit-pushdown.ts`; `FilterNode` is
   admissible here (a filter and a semi-filter commute) where it is not there.
4. The leaf must be a `SeqScanNode` whose `filterInfo.accessPath?.kind === 'fullScan'`,
   with `constraints.length === 0` and no `limit` / `offset`.

   **Why so strict.** A leaf that already carries pushed constraints had its residual
   `Filter` dropped on the module's promise to enforce them; replacing its `FilterInfo`
   with our multi-seek would silently drop those predicates. Merging the two is real work
   and is parked in `backlog/feat-key-set-seek-over-pushed-constraints`.
5. `equiPairs[0].leftAttrId` must be one of `leaf.getAttributes()`; its position in that
   array is the table column index (a `TableAccessNode`'s attributes are the table
   reference's, positionally 1:1 with `tableSchema.columns`).

### Semantic gates — each one prevents an under-fetch

6. **Identical logical types.** The target column's `logicalType` must equal the key
   column's. A cross-type set (INTEGER column, REAL keys) would be encoded into seek keys
   that miss rows `=` considers equal, and the probe cannot resurrect a row the seek never
   returned. Declining keeps the hash semi join, whose answer is unchanged. Widening this
   is `backlog/feat-key-set-seek-cross-type-keys`.
7. **No semantic ordering.** `hasSemanticOrdering(logicalType)` (`util/comparison.ts`) must
   be false. `'PT1H'` and `'PT60M'` are equal but byte-distinct; a raw-value seek
   under-fetches. The store module declines these itself — gate in the engine too, so the
   guarantee does not depend on which module answered.
8. **Collation cover.** Resolve the pair's comparison collation with
   `effectiveCollationOfTypes(targetType, keyType)` (the same call `emitBloomJoin` makes, so
   the seek and the probe agree). Compare it to the chosen index's leading key column
   collation from the resolved `IndexDescriptor`. Accept when they are equal (exact seek) or
   when the join collation is `BINARY` and the index collation is not (the index
   over-fetches a superset, which the probe trims). Reject anything else — a finer index
   under-fetches. This is `classifyConstraintCover(joinColl, indexColl, /*isEquality*/ true,
   false) !== 'MISMATCH_UNSAFE'` in `rule-select-access-path.ts`; export it rather than
   restating the lattice.
9. The resolved `IndexDescriptor` must have `keyColumns[0].columnIndex === seekColumnIndex`.
   A module naming an index whose leading column is something else has answered a different
   question; decline.
10. `accessPlan.residualFilter` must be absent. A module-supplied JS residual has no place
    to run in this path.

### Module probe and the cost model

Build a `BestAccessPlanRequest` the same way `createIndexBasedAccess` does (the
`columns` mapping is identical), and call `vtabModule.getBestAccessPlan` **three** times:

| probe | `filters` | gives |
|---|---|---|
| A | one runtime-set `IN`, `maxCount: 2` | `costA`, chosen index |
| B | one runtime-set `IN`, `maxCount: RUNTIME_SET_MAX_KEYS` | `costB` |
| C | `[]` | `scanCost` |

`RUNTIME_SET_MAX_KEYS = 1000` — an engine constant, matching the store's own
`MAX_MULTI_SEEK_KEYS`. Pass `estimatedCount: keySource.estimatedRows` on A and B.

Accept only if A and B both claim the filter, both set `indexName` and
`seekColumnIndexes === [seekCol]`, and **name the same index**. Run each result through
`validateAccessPlan` — these are synthesized requests and a module bug should surface here,
not three layers down.

Then interpolate the module's own cost as a function of key count and solve for the
break-even:

```
slope        = (costB - costA) / (RUNTIME_SET_MAX_KEYS - 2)
seekCost(K)  = costA + (K - 2) * slope
breakEvenKeys = slope <= 0 ? RUNTIME_SET_MAX_KEYS
                           : clamp(floor(2 + (scanCost - costA) / slope), 0, RUNTIME_SET_MAX_KEYS)
```

Decline the rewrite when `breakEvenKeys < 1` — a scan beats a seek at every size, so there
is nothing to gain.

**Why interpolate instead of an engine-side constant.** The choice between K seeks and one
scan is a cost question, and cost authority belongs to the module. Two probes give the
module's real numbers at two points; the linear fit between them is an approximation, but it
is the module's approximation, not a second cost model living in the optimizer. Probe A uses
`maxCount: 2` rather than 1 only to keep the two probe points distinct; both modules now
take the multi-seek arm at `maxCount: 1` too (a runtime set is delivered as a `plan=5`
multi-seek whatever its ceiling), so 1 would price on the same basis — it just gives a
shorter, noisier baseline for the slope.

### Rewrite

Replace the `BloomJoinNode` with the left chain rebuilt around the new node:

```
HashJoin(semi, Project(Filter(leaf)), right)
  →  Project(Filter(KeySetSemiJoin(leaf, right)))
```

using `rebuildChain(left, leaf, keySetSemiJoinNode)`. Pushing a semi join below a
row-wise `Filter` / trivial `Project` / `Alias` is order-independent, which is why the peel
admits exactly those three.

## Emitter

`runtime/emit/key-set-semi-join.ts`, registered in `runtime/register.ts`. Structure mirrors
`emit/ordinal-slice.ts`.

**Factor out the key extraction from `emit/bloom-join.ts` first.** Lines 31–85 there build
the collation normalizers (`effectiveCollationOfTypes` → `hashKeyCollationName` →
`ctx.resolveKeyNormalizer`), the semantic-ordering canonicalizers (`semanticKeyTransform`,
active only when both sides declare the same semantic-ordering type), and the
`extractKey(row, indices)` closure. Move that into a shared helper (e.g.
`runtime/emit/join-key-extractor.ts`) and have both emitters use it. The two sides **must**
agree bit-for-bit; two copies would drift and the drift would show up as missing rows.

```ts
const stateByCtx = new WeakMap<RuntimeContext, KeySetState>();
interface KeySetState {
	/** Serialized+normalized keys, for the probe. */
	readonly probe: ReadonlySet<string>;
	/** Raw seek values in index order, or null when the runtime chose to scan. */
	readonly seekKeys: readonly SqlValue[] | null;
}

const targetInstruction = emitSeqScan(plan.target, ctx, (base, rctx) => {
	const state = stateByCtx.get(rctx);
	if (!state) throw new QuereusError('KeySetSemiJoin target executed without key-set initialization', StatusCode.INTERNAL);
	if (!state.seekKeys) return base;                       // scan fallback — unchanged FilterInfo
	return stampMultiSeek(base, plan.pushdown, state.seekKeys);
});
```

`run(rctx, targetRows, keyRows)`:

1. Drain `keyRows` fully. For each row take the key column, skip `null`, canonicalize +
   normalize into the probe string; keep the **first raw value** seen per distinct probe
   string as the seek value. `throwIfAborted(rctx.signal)` per row.
2. `K = 0` ⇒ return without touching `targetRows` — an empty build side means the semi join
   emits nothing, and the target must not be opened at all.
3. `push = K <= min(pushdown.maxKeys, pushdown.breakEvenKeys)`.
4. When pushing, sort the raw seek values with `compareSqlValues` under the seek column's
   collation — ascending, or descending when `pushdown.seekDescending`. See "Emission order"
   below.
5. `stateByCtx.set(rctx, …)`, then stream `targetRows`, yielding each row whose extracted
   key is in `probe`. `finally { stateByCtx.delete(rctx) }`.

`stampMultiSeek(base, pushdown, keys)` returns:

```ts
const constraints = keys.map((_v, i) => ({
	constraint: { iColumn: pushdown.seekColumnIndex, op: IndexConstraintOp.EQ, usable: true },
	argvIndex: i + 1,
}));
const idxStr = encodeIdxStr(makeIdxStrSpec(pushdown.indexName, 'multiSeek',
	new Map([['inCount', String(keys.length)]])));   // seekWidth omitted ⇒ 1, matching the literal-IN arm
return {
	...base,
	idxStr,
	constraints,
	args: keys,
	accessPath: pushdown.accessPath,
	indexInfoOutput: {
		...base.indexInfoOutput,
		idxStr,
		nConstraint: constraints.length,
		aConstraint: constraints.map(c => c.constraint),
		aConstraintUsage: constraints.map(c => ({ argvIndex: c.argvIndex, omit: true })),
		estimatedRows: BigInt(keys.length),
	},
};
```

Compare the result field-for-field against what `rule-select-access-path`'s single-column
multi-seek arm produces for `where col in (1,2,3)` — a test should assert they are the same
shape, because every downstream consumer's correctness rests on that.

### Emission order

Sorting the seek keys before stamping is not cosmetic:

- It makes the target's emission order deterministic across executions.
- The isolation layer's primary-key overlay merge assumes the underlying stream arrives in
  ascending key order (`packages/quereus-isolation/src/merge-iterator.ts`).
  `backlog/bug-isolation-multiseek-merge-order` records what goes wrong when a multi-seek
  arrives out of order. Sorting means this feature never *creates* an out-of-order
  primary-key multi-seek. It does **not** fix that bug (which is about literal lists written
  out of order) and must not be described as fixing it.
- The store re-sorts its windows by encoded bytes anyway, so sorting costs it nothing; the
  memory vtab visits keys in the order given, so for it the sort is what buys the property.

Sorting by SQL value order equals index-key order for a single ascending key column under
the column's collation; `seekDescending` inverts it for a DESC key column. That equivalence
is why the rule declines composite seeks (`seekColumnIndexes.length !== 1`) — there is only
ever one column here, since an `IN` subquery yields one column.

## Edge cases & interactions

Each of these wants a test.

**Key set contents**
- Inner returns duplicates → each target row emitted at most once, and `inCount` reflects
  the *distinct* count. Assert row counts and the `inCount` on the stamped `idxStr`.
- Inner returns NULLs mixed with values → NULLs skipped; rows matching the non-NULL values
  still returned.
- Inner returns only NULLs → zero rows, target never opened.
- Inner returns zero rows → zero rows, target never opened. (Assert with a counting module
  that the target's `query()` was not called.)
- Target column is NULL on some rows → those rows never match.
- Exactly `breakEvenKeys` keys → pushes. `breakEvenKeys + 1` → scans. Both must return the
  same rows. This is the single most important pair of assertions in the ticket: the two
  paths must be observationally identical.
- More than `RUNTIME_SET_MAX_KEYS` keys → scans, correct answer.

**Plan shape**
- `delete from big where id in (select id from small)` with an index on `big.id` → a
  `KeySetSemiJoin` in the plan.
- Same query with **no** index on the column → no `KeySetSemiJoin`; the hash semi join
  survives.
- Left side already carrying a pushed constraint (`where status = 'x' and id in (…)` with
  `status` indexed) → declines; hash semi join survives.
- `where status = 'x' and id in (…)` with `status` **not** indexed → the `status` predicate
  is a `Filter` above the leaf, the peel descends through it, and the node lands under it.
  Assert both the shape and the rows.
- Anti join (`not in` / `not exists`) must never produce this node.
- A semi join with a residual condition must never produce this node.
- Correlated `IN` (which reaches the semi join through the other decorrelation arm) — the
  keySource is correlated, `isDeterministic`/side-effect gates aside, draining it once
  would be wrong. Confirm the rule declines it (its `keySource` references outer
  attributes); add an explicit test.

**Ordering**
- `select * from big where id in (select …) order by id` → the `Sort` must survive. Assert
  the plan still contains a `Sort` and the rows come back ordered. This is the test that
  pins the `computePhysical` decision.

**Types and collation**
- `NOCASE` target column, `BINARY` key column and the reverse → same rows as the hash semi
  join returns for the same data.
- Target `BINARY` index, join collation resolves `NOCASE` → must decline (under-fetch).
- Join collation `BINARY`, index `NOCASE` → may push; the probe must drop the case variants
  the index over-fetched. Assert the exact rows, not just the count.
- `TIMESPAN` on both sides → declines; `'PT1H'` still matches `'PT60M'` via the surviving
  hash semi join.
- Integer target against REAL key column → declines (type gate); rows unchanged.

**DML**
- `delete from big where id in (select id from small)` and the `update` equivalent — row
  counts and surviving rows.
- Self-referencing `delete from a where x in (select y from a)`. The node drains
  `keySource` completely before opening the target, so the pre-statement snapshot the set
  probe established survives.
  **`test/logic/07.7-in-subquery-caching.sqllogic` must pass unmodified.** If it does not,
  the rewrite is wrong — do not edit it to match.
- Deleting rows while the multi-seek is mid-flight: each seek window is a distinct key, and
  a row deleted from an already-emitted window cannot affect a later one. Worth a test with
  a multi-row delete inside an explicit transaction.

**Runtime lifecycle**
- Re-executing a prepared statement re-drains the key source and rebuilds the set (the
  `WeakMap` entry is cleared in `finally`). Assert correct results on the second execution
  with different inner data.
- A `LIMIT` above the node stops the target scan early without draining every seek window.
- Abort / request timeout during the key-set drain unwinds promptly (`throwIfAborted`).
- The target executing without a state entry throws `StatusCode.INTERNAL` rather than
  silently full-scanning — mirrors `OrdinalSlice`'s guard. A silent fallback here would be
  correct but would hide a scheduling bug indefinitely.
- Under a nested-loop rescan the key source is re-drained each pass. That is correct but
  wasteful; leave a `NOTE:` at the drain site rather than filing a ticket — the node's
  right side is uncorrelated by construction, so caching it is a pure optimization and only
  matters if this shape ever shows up under an NLJ inner.

## Tests

- **sqllogic** — a new `test/logic/` file covering the key-set-contents, type/collation and
  DML cases above, run under the default memory vtab.
  `test/logic/07.7-in-subquery-caching.sqllogic` unmodified.
- **Plan shape** — `test/plan/` assertions for every "Plan shape" bullet, reading the
  optimized plan the way `test/optimizer/in-multiseek-incount.spec.ts` does.
- **Stamped `FilterInfo`** — a unit test that the emitter's `stampMultiSeek` output is
  field-for-field equivalent to the plan-time single-column multi-seek `FilterInfo` for the
  same keys.
- **Push/scan equivalence** — a parameterized test that runs the same query at
  `breakEvenKeys` and `breakEvenKeys + 1` distinct keys and asserts identical result sets.
- **Scan-count** — extend `test/vtab/in-subquery-cache-scan-count.spec.ts`'s counting module
  so the inner source is still scanned exactly once, and add an assertion that the target's
  `query()` receives a `plan=5` `idxStr` when pushing and `fullscan` when not.
- **Perf sentinel** — the existing 10k × 5k SELECT+DELETE case in
  `test/performance-sentinels.spec.ts` must stay inside its bound and should improve.
- Regenerate any affected golden plans under `test/plan/`.

## Docs

- `docs/optimizer-rules.md` — a `key-set-seek` entry: what it matches, what it declines,
  and that the probe is unconditional.
- `docs/optimizer.md` — where the `IN`-subquery pipeline now ends up: set probe →
  semi join → key-set seek, and which shapes stop at each stage.
- Header comment on `rule-key-set-seek.ts` in the style of
  `rule-monotonic-limit-pushdown.ts`: the pattern, the peel, and the full decline list.

## TODO

**Phase 1 — node and emitter**
- [ ] Factor the key-extraction closure out of `emit/bloom-join.ts` into a shared helper;
      re-point `emitBloomJoin` at it.
- [ ] Add `PlanNodeType.KeySetSemiJoin` and `KeySetSemiJoinNode` (attributes, children,
      `withChildren`, cost, `computePhysical` with the ordering comment).
- [ ] Write `emit/key-set-semi-join.ts` (`stampMultiSeek`, the `WeakMap` state, the drain /
      sort / decide / probe loop) and register it.
- [ ] Unit test `stampMultiSeek` against the plan-time literal-IN `FilterInfo`.

**Phase 2 — rule**
- [ ] Export `classifyConstraintCover` from `rule-select-access-path.ts`.
- [ ] Write `rule-key-set-seek.ts`: peel, structural gates, semantic gates, three-probe
      cost model, rewrite.
- [ ] Register it in `optimizer.ts` after `monotonic-limit-pushdown`, with the ordering
      rationale in the registration comment.
- [ ] Plan-shape tests, including every decline case.

**Phase 3 — behaviour**
- [ ] sqllogic file; push/scan equivalence test; scan-count test; DML and self-reference
      cases.
- [ ] `NOTE:` at the drain site about NLJ rescan re-draining.
- [ ] Docs; regenerate goldens.
- [ ] `yarn lint`, `yarn build`, `yarn test` green. `yarn test:store` is deliberately left
      to `feat-key-set-seek-store-isolation` — but if it is cheap to run here, a red result
      is worth knowing about early.
