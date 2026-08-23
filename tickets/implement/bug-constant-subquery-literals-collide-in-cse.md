description: When one query uses two different constant subqueries — such as adding `(select 1)` in one column and `(select 2)` in another — the engine treats them as the same value, so it returns wrong numbers and can silently drop rows.
files:
  - packages/quereus/src/planner/analysis/expression-fingerprint.ts               # fingerprintLiteral (~line 109) — the collision site, cause of the live wrong results
  - packages/quereus/src/planner/analysis/predicate-shape.ts                      # literalValue / planTimeLiteralValue — the existing shared accessors to route through
  - packages/quereus/src/planner/rules/access/rule-monotonic-range-access.ts      # extractRangeBounds (~line 76) — second raw reader, currently unreachable
  - packages/quereus/src/schema/function.ts                                       # evaluateLiteralOperand (~line 360) — third raw reader, cost-only
  - packages/quereus/src/planner/analysis/const-pass.ts                           # replaceBorderNodes — where the pending-Promise literal is created
  - packages/quereus/test/optimizer/expression-fingerprint.spec.ts                # unit-level fingerprint suite; builds LiteralNodes directly
  - packages/quereus/test/optimizer/scalar-cse.spec.ts                            # existing CSE rule suite that must stay green
  - packages/quereus/test/logic/96-subquery-edge-cases.sqllogic                   # home for the end-to-end regression cases
  - docs/optimizer-const.md                                                       # §4 (line ~88) and §7 already state the pending-Promise rule
repro: verified
difficulty: medium
---

# Two different constant subqueries are treated as one expression

## Reproduction (verified on the current tree)

Against `create table t (id integer primary key, x integer)` holding `(1, 10), (2, 20)`,
memory module:

| query | today | expected |
| --- | --- | --- |
| `select x + (select 1) as a, x + (select 2) as b from t where id = 1` | `[{a:11,b:11}]` | `[{a:11,b:12}]` |
| `select id from t where x = (select 10) or x = (select 20) order by id` | `[{id:1}]` | `[{id:1},{id:2}]` |

The second is the serious one — a qualifying row is silently dropped, with no error.

Controls that are correct today and must stay correct:

- `select (select 1) as a, (select 2) as b from t where id = 1` gives `[{a:1,b:2}]`
  (a bare literal is never a common-subexpression candidate, so the collision has
  nothing to act on)
- `select x + 1 as a, x + 2 as b from t where id = 1` gives `[{a:11,b:12}]`
  (ordinary literals fingerprint distinctly)

Trigger: two constant scalar subqueries with different values, inside larger
expressions, in the same SELECT's projection / filter / sort chain.

## Cause

Constant folding is a synchronous optimizer pass, but the value it evaluates may be
async. `const-pass.ts` `replaceBorderNodes` therefore builds a `LiteralNode` whose
`expression.value` can be a **still-pending Promise**; the emitter awaits it at
runtime (`runtime/emit/literal.ts`). Every uncorrelated constant scalar subquery —
`(select 1)` — folds to exactly this shape.

`fingerprintLiteral` reads `node.expression.value` and dispatches on its JavaScript
type. A Promise matches none of the scalar cases, falls into the "JSON document"
branch, and canonicalizes to the empty object — so **every** promise-valued literal
fingerprints as `LI:j{}`. `rule-scalar-cse.ts` groups subexpressions by fingerprint
and collapses each duplicate group into one shared computation, so two expressions
that differ only in which constant subquery they contain become one.

Confirmed by probe: adding an early `value instanceof Promise` arm returning
`LI:?<node id>` to `fingerprintLiteral` makes both failing queries above return their
expected rows, with the controls unchanged.

## The defect class, and what is actually unsafe

Reading `LiteralNode.expression.value` raw and assuming a resolved SQL value is the
class. It has now produced a crash (fixed in
`bug-constant-subquery-literal-crashes-predicate-rewrite`) and these wrong results.

An audit of all 26 `expression.value` read sites in `packages/quereus/src` found the
unsafe set is exactly the three below — every other reader already narrows with an
explicit `v instanceof Promise` guard or a `typeof` test a Promise cannot pass:

| site | status |
| --- | --- |
| `expression-fingerprint.ts` ~109 | **live wrong results** — the reason this ticket exists |
| `rule-monotonic-range-access.ts` ~76 | casts to `SqlValue` and uses it as a pruning range bound. Unreachable today: the constraint extractor no longer lets a promise-valued literal become a seek key. Latent — wrong the moment that changes |
| `schema/function.ts` ~360 (`evaluateLiteralOperand`) | feeds a table-valued function's row estimate. Cost-only, no wrong results, lowest priority |

The audit also showed the *safe* sites each open-code their own `instanceof Promise`
guard — eight-plus near-identical copies (`sat-checker.ts`, `limit-offset.ts`,
`fd-utils.ts` twice, `catalog-stats.ts` twice, `emit/binary.ts`, and others). That
duplication is why the class keeps recurring: there is a correct shared answer, but
nothing pulls new code toward it.

## Shape of the fix

`predicate-shape.ts` already holds both halves of the shared decision:

- `literalValue(expr: AST.LiteralExpr): SqlValue | undefined` — the primitive; returns
  `undefined` for a pending Promise. Use at sites that already hold a `LiteralNode`.
- `planTimeLiteralValue(node: ScalarPlanNode): SqlValue | undefined` — the
  plan-node-level entry point; also returns `undefined` for a non-Literal node.

`undefined` means "not usable at plan time"; SQL `NULL` comes back as `null`, so the
two stay distinguishable.

Layering note for `schema/function.ts`: `predicate-shape.ts` value-imports only the
`PlanNodeType` enum (everything else is `import type`), so importing it from `schema/`
should introduce no runtime cycle. Verify rather than assume — if a cycle does appear,
the fallback is an explicit `value instanceof Promise` rejection inside
`evaluateLiteralOperand`, with its duck-typed field retyped `MaybePromise<SqlValue>`
so the compiler forces the narrowing.

For the fingerprinter, the correct output for a non-plan-time literal is the existing
per-node-unique `LI:?<node id>` fallback — it disables common-subexpression
elimination for that one literal while keeping every result correct. Keep the existing
log line's spirit: a silently-disabled CSE should say so.

## Requirements

- Both failing queries above return their expected rows.
- Ordinary literals keep their current fingerprints — `test/optimizer/scalar-cse.spec.ts`
  and `test/optimizer/expression-fingerprint.spec.ts` (657 lines, unit-level, builds
  `LiteralNode`s directly) must stay green without edits to existing assertions.
- The two unsafe non-fingerprint readers reject a pending Promise, so the class does not
  reappear when the monotonic-range site becomes reachable.
- Prefer one general test over per-site cases: a fingerprint-level property assertion
  that two `LiteralNode`s holding distinct pending Promises never share a fingerprint
  covers the whole class at the seam where it bit, and is cheap to write in the existing
  unit suite.

## TODO

Phase 1 — fix the live wrong results

- Route `fingerprintLiteral` (`expression-fingerprint.ts` ~109) through `literalValue`
  (or an equivalent explicit Promise rejection) so a pending-Promise literal returns the
  per-node-unique `LI:?<node id>` fingerprint instead of falling into the JSON branch.
- Keep the JSON-document branch and its existing `NOTE:` about fingerprint size intact —
  that is a separate, correct concern.
- Add the two failing queries plus both controls to
  `test/logic/96-subquery-edge-cases.sqllogic` as end-to-end regression cases.
- Add a unit case to `test/optimizer/expression-fingerprint.spec.ts`: two `LiteralNode`s
  built with distinct pending Promises must produce different fingerprints, and a
  promise-valued literal must not collide with a JSON-object literal either.

Phase 2 — close the class

- `rule-monotonic-range-access.ts` ~76: replace
  `seekKey instanceof LiteralNode ? seekKey.expression.value as SqlValue : undefined`
  with `planTimeLiteralValue(seekKey)`. Drop the `as SqlValue` cast — that cast is what
  hides the Promise arm from the compiler.
- `schema/function.ts` ~360 `evaluateLiteralOperand`: reject a pending Promise, via
  `planTimeLiteralValue` if the import stays cycle-free, otherwise the explicit guard
  described above. Its duck-typed `value?: SqlValue` field annotation is a lie about the
  runtime type — fix the annotation as well as the check.
- Optional, same-site cleanup: migrate the open-coded `v instanceof Promise` guards in
  `sat-checker.ts`, `limit-offset.ts`, `fd-utils.ts`, `catalog-stats.ts`, and
  `emit/binary.ts` to `literalValue`, so there is one definition of the test. Behavior-
  preserving; skip if it balloons the diff, and say so in the handoff.

Docs and validation

- `docs/optimizer-const.md` §4 (line ~88) and §7 already state the pending-Promise rule
  and name `planTimeLiteralValue`. Extend §4 to name `literalValue` as the sibling for
  callers already holding a `LiteralNode`, so the guidance covers both shapes.
- Run `yarn workspace @quereus/quereus test` and `yarn lint` from the repo root.
