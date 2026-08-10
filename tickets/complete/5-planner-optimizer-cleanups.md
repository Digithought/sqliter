description: Three small optimizer housekeeping cleanups landed and reviewed — a rule-engine contract documented, a debug-only file de-`any`ed, and dead context-helper code removed.
files: packages/quereus/src/planner/framework/pass.ts, packages/quereus/src/planner/framework/context.ts, packages/quereus/src/planner/debug.ts, packages/quereus/src/planner/framework/README.md, docs/optimizer.md, packages/quereus/test/optimizer/pass-manager.spec.ts, packages/quereus/test/planner/framework.spec.ts
difficulty: easy
----
Completed review of `tickets/review/5-planner-optimizer-cleanups.md` (implement commit `7df758e0`). All three items landed correctly; no changes needed during review.

## What shipped

- **Item 1 — convergence contract documented.** `NOTE:` comment in `PassManager.applyPassRules` (pass.ts) + a Best-Practices bullet in `docs/optimizer.md` stating a rule is never re-offered its own output; a rule needing a fixpoint over its own rewrites must self-loop. Cites `rule-filter-merge` as canonical example.
- **Item 2 — `planner/debug.ts` de-`any`ed.** File-level `eslint-disable no-explicit-any` removed; every `any` retyped with a real type (`BaseType`, `Record<string,unknown>`, `unknown` + narrowing, `isRelationalNode` guard, `Scheduler`, `PhysicalProperties.ordering` element inference). No `eslint-disable-next-line` needed anywhere.
- **Item 3 — dead `OptimizationContext` surface removed.** Deleted `withPhase/withContext/getContext/hasContext/setContext/deleteContext/clearContext/getContextSnapshot/copyTrackingState`, the `context: Map` field, and the `isOptContext` guard (all zero callers). Fixed stale docs in `framework/README.md` and the `docs/optimizer.md` "Context Lifecycle" section. Removed stray `context: new Map()` lines from two spec files.

## Review findings

**Checked:**

- **Diff read fresh before handoff.** Reviewed all six code/doc files + both spec edits directly from `git show 7df758e0`.
- **Type claims (Item 2) verified against source.** `PlanNode.getType(): BaseType` (plan-node.ts:725), `get physical(): PhysicalProperties` is a public non-optional base getter (plan-node.ts:934 — no cast ever needed), `isRelationalNode` type guard + `estimatedRows` on `RelationalPlanNode` (plan-node.ts:1039,1056), `RuleFn = (node, context: OptContext) => …` (registry.ts:15). All correct.
- **Behavior-change risk on the `physical` getter.** Original `(node as any).physical` invoked the same always-defined base getter as the new `node.physical`; the getter always returns a truthy `PhysicalProperties` and cannot no-op differently. `estimatedRows` narrowing is functionally identical (property only exists on relational nodes). **No behavior change** — Item 2 is typing-only, confirming the implementer's EXPLAIN-output assumption without needing a golden diff.
- **Dead-code deletions (Item 3) have zero callers.** Grep across all `packages/**/*.ts` for every deleted name: only stale `dist/` build-output hits, no source callers anywhere in the monorepo (including quoomb/plugins for the exported `isOptContext`).
- **`context.phase` genuinely unused.** Only `.phase` reference in planner src is `entry.phase` (optimizer.ts:1028 — a manifest entry, unrelated). Confirms the implementer's tripwire is accurate.
- **Doc staleness swept repo-wide.** No remaining `withPhase/withContext/getContext/copyTrackingState/isOptContext` references in `docs/` or the README. The `context.set` hits in `docs/runtime.md` are the unrelated `RuntimeContext.context` runtime concept, correctly left alone.
- **Cited example is real.** `rule-filter-merge` does self-loop via `while (current.source.nodeType === Filter)` (rule-filter-merge.ts:31).
- **Lint + tests.** `yarn workspace @quereus/quereus run lint` (eslint + `tsc -p tsconfig.test.json --noEmit` over specs) exit 0. Affected suites — `test/optimizer/**`, `test/planner/**`, `test/plan/**` — 2365 passing. The tsc-on-tests pass would have caught any remaining `OptContext` literal with a stray `context` key; none surfaced, so the two spec edits are the complete set.

**Found:** Nothing requiring a fix. Implementation is clean, correctly typed, and docs match the new reality.

**Major / new tickets:** None.

**Minor (fixed this pass):** None — nothing to fix.

**Tripwire (carried forward, not a ticket):** The `OptContext.phase` field is always `'rewrite'` today and read by nothing. Left in place, documented via an inline comment on the `OptContext` interface (`framework/context.ts`) explaining it's currently unconsulted and part of the phase-management contract. If a phase-gated pass is ever added, wire `context.phase` through `PassManager`; if still unused later, it's a legitimate future deletion. Parked at the code site per tripwire rules — no action now.

## Commands run

```
yarn workspace @quereus/quereus run lint                                  # exit 0, clean
mocha test/optimizer/** test/planner/** test/plan/**  --reporter min      # 2365 passing, exit 0
```

No pre-existing failures; nothing written to `tickets/.pre-existing-error.md`.
