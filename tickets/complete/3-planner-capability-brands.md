description: The optimizer's cross-class "can this node do X?" checks now key off a compiler-enforced brand on each node, so a missing implementation fails to compile instead of silently going undetected.
prereq:
files: packages/quereus/src/planner/framework/characteristics.ts, packages/quereus/src/planner/nodes/aggregate-node.ts, packages/quereus/src/planner/nodes/stream-aggregate.ts, packages/quereus/src/planner/nodes/hash-aggregate.ts, packages/quereus/src/planner/nodes/join-node.ts, packages/quereus/src/planner/nodes/merge-join-node.ts, packages/quereus/src/planner/nodes/bloom-join-node.ts, packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/planner/nodes/sort.ts, packages/quereus/src/planner/nodes/limit-offset.ts, packages/quereus/src/planner/nodes/project-node.ts, packages/quereus/src/planner/nodes/cache-node.ts, packages/quereus/src/planner/nodes/cte-node.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/planner/nodes/table-access-nodes.ts, packages/quereus/src/planner/nodes/window-function.ts, packages/quereus/src/planner/nodes/aggregate-function.ts, packages/quereus/src/planner/nodes/internal-recursive-cte-ref-node.ts, packages/quereus/test/optimizer/characteristics.spec.ts, packages/quereus/test/planner/framework.spec.ts
----

## What shipped

Cross-class capability detection in `framework/characteristics.ts` (`CapabilityDetectors.is*`) was duck-typed: it sniffed for the *presence* of methods/fields via `as any`. Add a node that should have a capability, forget a method, and detection silently misfired.

Replaced with a **compiler-enforced brand**: each capability interface declares a unique `readonly is<X>Capable: true` marker, every implementer sets it, each guard is a single typed brand comparison. Because `implements XCapable` fails to compile unless the class also sets the brand, "implements the capability" and "is detected as having it" became the same fact.

Concrete changes: added a brand field to all 16 capability interfaces; rewrote every guard to a single `(node as Partial<Pick<X, 'is…Capable'>>).is…Capable === true` check; removed the file-level `no-explicit-any` disable and every `as any`; dropped the `isAggregateFunctionSchema` tiebreak (and its null-throw hazard); added the brand initializer to every implementer class (including the four informally-detected ones and the base-class-less `StreamAggregateNode`/`HashAggregateNode`). Tests: migrated the pre-existing duck-typed unit tests to the brand mechanism and added a behavior-preservation suite that constructs a real instance of each implementer.

## Review findings

Adversarial pass over commit `6940a5a5`. Read the full diff (framework + all 16 node files + both spec files) with fresh eyes before the handoff summary.

**Checked — correctness / behavior preservation (the load-bearing risk).** A branded guard must accept *exactly* the implementer set the old duck-typed guard accepted — any missed implementer would be a silent regression (guard returns `false` where it used to return `true`). Enumerated every capability method (`getPredicate`, `withPredicate`, `getPredicates`, `getSortKeys`, `getAccessMethod`, `getProjections`, `getCacheStrategy`, `getCTESource`, `getJoinType`, `getLimitExpression`, `getBindingRelationName`, `getGroupingKeys`) across `planner/nodes/`. The branded classes match the previously-duck-matched set 1:1. **No missed implementer; no over-branding.** Verified `ScalarFunctionCallNode` does *not* carry `isAggregateFunctionCapable`, and only `TableReferenceNode` (not the physical `SeqScanNode`) carries `isColumnBindingProvider`. The `TableAccessNode` abstract base sets the brand; all four subclasses (`SeqScanNode`/`IndexScanNode`/`EmptyResultNode`/`IndexSeekNode`) extend it and inherit it — matching the pre-brand behavior (all four already had `getAccessMethod` + inherited `tableSchema`).

**Checked — the one intentional behavior change: `isAggregating` flips `false`→`true` for `StreamAggregateNode`/`HashAggregateNode`.** The handoff flagged this; I verified the neutrality argument holds. Only two consumers of `isAggregating` exist:
- `ruleAggregatePhysical` (`rule-aggregate-streaming.ts:30`) is registered `nodeType: PlanNodeType.Aggregate` (`optimizer.ts:717`) → it never runs on a physical aggregate node, so no re-fire/re-conversion.
- `rule-fanout-lookup-join.ts:455` descends subquery roots calling `isAggregating` then `root.getGroupingKeys()`. It runs in the **Structural** pass, which precedes the **Physical** pass that creates Stream/Hash → the root is still the logical `AggregateNode` at that point. Branding the physical forms only makes the rule's own defensive comment true and removes a latent crash (the post-loop `getGroupingKeys()` now exists on the physical forms).

Golden-plan suite (part of the 6877 passing) shows zero diff, consistent with neutrality.

**Checked — null-safety.** Guards that can receive `null` keep their leading `if (!node) return false`. Guards without it read a property on `node`; the old `'x' in node` form threw on `null` too, so callers that could pass `null` already had guards — behavior identical.

**Checked — tests.** The behavior-preservation suite constructs real instances of every implementer and asserts each guard accepts it, plus structurally-similar siblings asserting `false`. Covers the base-class-less aggregate family and the shared-`nodeType` aggregate/window/scalar discrimination — the two cases a naive `instanceof` guard would have broken. Migrated unit tests correctly assert the new stronger property ("method shape without brand is rejected"). Adequate for the detection wiring.

**Checked — docs.** `docs/optimizer-conventions.md:385` and `docs/optimizer.md:595` still carry the stale "prefer `CapabilityDetectors` over `instanceof`" / anti-`instanceof` guidance that this effort supersedes. This is **not** a gap: it is properly scoped to `3.1-planner-discrimination-doc-and-lint` (in `implement/`, `prereq: planner-capability-brands`, sequence 3.1 > 3), which rewrites the convention doc + framework README and adds a file-scoped `no-explicit-any: error` lint guard on `characteristics.ts`. `docs/optimizer-joins.md:130` already describes the physical-form matching correctly. `docs/review.html` is a point-in-time artifact — correctly left untouched.

**Findings requiring a fix (minor): none.** No inline corrections were needed.

**Major findings (new tickets): none.**

**Tripwires (parked, not ticketed):**
- The behavior-preservation tests construct nodes with minimal `{} as any` mock args (schemas/sources consumed lazily or not at all by the constructors under test). This tests the brand/guard wiring, not full node semantics. If a constructor later starts eagerly touching its args, these tests need real fixtures. Parked in the existing test-file comments (`characteristics.spec.ts` → `brand behavior preservation` block, which already documents the minimal-mock rationale) — no code change; recorded here as the index entry.
- `PredicateCombinable` / `canCombinePredicates` has no implementers, so its guard is always `false` (unchanged from before branding). It is branded and ready; a future combinable node sets `isPredicateCombinableCapable`. Documented at the interface site in `characteristics.ts`.

## Validation performed

- `yarn workspace @quereus/quereus run lint` → clean (exit 0). This is load-bearing: it proves every `implements XCapable` is satisfied (brand present) and every test call site type-checks.
- `yarn workspace @quereus/quereus run test` → **6877 passing, 9 pending, 0 failing** (exit 0).

## Follow-up

- `3.1-planner-discrimination-doc-and-lint` (already queued in `implement/`) — writes the canonical node-discrimination standard into `optimizer-conventions.md` + framework README and adds the file-scoped lint guard on `characteristics.ts`.
