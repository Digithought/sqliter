description: Optional follow-up hardening for how the query optimizer identifies node kinds — a codebase-wide tidy-up and a stricter automated check, only worth doing if the looser style starts causing bugs again.
files: packages/quereus/src/planner
tradeoffs: Neither piece fixes a live defect, both carry real churn (a roughly 415-site audit, and a codebase-wide any-cleanup before the lint rule can be enabled), and the ticket itself says to promote only if the pain materialises.
----

## Background

The tickets `planner-capability-brands` and `planner-discrimination-doc-and-lint` established one canonical standard for node discrimination in the planner:

- concrete class identity → `instanceof`
- `nodeType` enum → dispatch / serialization only
- cross-class capability → branded marker interfaces + centralized guards
- physical characteristics → `PlanNode.physical`

They converted the fragile idiom (duck-typed `as any` capability detectors) and corrected the docs, but deliberately scoped *out* two lower-value, higher-churn pieces. This ticket parks them for a human to decide whether they are worth the churn.

## Parked work (two independent pieces)

### 1. Intent-consistency audit of `nodeType ===` and `instanceof` class checks

There are ~349 `instanceof` and ~66 `nodeType ===` sites across the planner. Under the standard both are legitimate — `instanceof` for class identity, `nodeType` for dispatch/serialization — but some sites may use the *wrong* one for their intent (e.g. a `nodeType === PlanNodeType.X` used as a class-narrowing check where `instanceof X` would give real TypeScript narrowing, or an `instanceof` used purely for a dispatch tag that would be more stable as `nodeType`). This is a low-value readability/consistency sweep, not a correctness fix — nothing here misfires today. Only worth doing if the inconsistency is actively confusing contributors.

### 2. Full custom "no duck-typed node detector" lint rule

`planner-discrimination-doc-and-lint` added only a file-scoped `no-explicit-any: error` guard on `characteristics.ts`. A broader guard — an AST-based eslint rule flagging the pattern `'method' in node && typeof (node as any).method === 'function'` anywhere in `src/planner/**`, or raising `no-explicit-any` to `error` planner-wide — would prevent the fragile idiom from reappearing *outside* the canonical file. This needs a codebase-wide `any` cleanup first (the planner currently carries legitimate `any` at `warn`), and authoring a precise custom rule is fiddly. Worth doing only if duck-typed detectors start reappearing in review.

## Why backlog, not active

Neither piece fixes a live defect; both are hardening/tidy with real churn. Promote if a concrete pain (a reintroduced duck-typed detector bug, or contributor confusion over which idiom to use) actually materializes.
