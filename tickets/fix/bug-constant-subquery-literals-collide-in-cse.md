description: When one query uses two different constant subqueries, such as adding `(select 1)` in one column and `(select 2)` in another, the engine treats them as the same value — so it returns wrong numbers and can silently drop rows.
files:
  - packages/quereus/src/planner/analysis/expression-fingerprint.ts               # fingerprintLiteral - the collision site
  - packages/quereus/src/planner/rules/cache/rule-scalar-cse.ts                   # the consumer that acts on the colliding fingerprints
  - packages/quereus/src/planner/analysis/predicate-shape.ts                      # planTimeLiteralValue - the existing "is this literal a plan-time constant" decision
  - packages/quereus/src/planner/analysis/const-pass.ts                           # replaceBorderNodes - where the promise-valued literal is created
  - packages/quereus/src/planner/rules/access/rule-monotonic-range-access.ts      # second, currently-dormant raw reader (line ~76)
  - packages/quereus/src/schema/function.ts                                       # third raw reader - evaluateLiteralOperand (line ~360)
  - packages/quereus/test/logic/96-subquery-edge-cases.sqllogic                   # home for the end-to-end regression cases
  - docs/optimizer-const.md                                                       # §4/§7 now state the pending-Promise rule
repro: verified
difficulty: medium
---

# Two different constant subqueries are treated as one expression

## What happens today

Verified in `packages/quereus` against `create table t (id integer primary key, x
integer)` holding `(1, 10), (2, 20)`, memory module, on the current tree:

| query | today | expected |
| --- | --- | --- |
| `select x + (select 1) as a, x + (select 2) as b from t where id = 1` | `[{a:11, b:11}]` | `[{a:11, b:12}]` |
| `select id from t where x = (select 10) or x = (select 20) order by id` | `[{id:1}]` | `[{id:1},{id:2}]` |

The second row is the serious one: a row that satisfies the predicate is silently
dropped. No error is raised in either case.

Controls that behave correctly today, for contrast:

- `select (select 1) as a, (select 2) as b from t` — correct. A bare literal is
  never a common-subexpression candidate, so the collision has nothing to act on.
- `select x + 1 as a, x + 2 as b from t` — correct. Ordinary literals fingerprint
  distinctly.

So the trigger is: **two constant scalar subqueries, with different values, inside
larger expressions, in the same SELECT's projection / filter / sort chain.**

## Why

Constant folding runs as a synchronous optimizer pass but the value it evaluates
may be async, so the `LiteralNode` it produces can hold a **still-pending
Promise** as its value rather than a resolved SQL value (`const-pass.ts`,
`replaceBorderNodes`; the emitter awaits it at runtime). Every uncorrelated
constant scalar subquery — `(select 1)` — folds to exactly this shape.

`fingerprintLiteral` (`planner/analysis/expression-fingerprint.ts`, ~line 109)
reads `node.expression.value` directly and dispatches on its JavaScript type. A
Promise matches none of the scalar cases, falls into the "JSON document" branch,
and canonicalizes to the empty object — so **every** promise-valued literal
fingerprints identically. `rule-scalar-cse.ts` groups subexpressions by
fingerprint and replaces each duplicate group with a single shared computation, so
two expressions that differ only in which constant subquery they contain are
collapsed into one.

This is the same root cause as the already-fixed
`bug-constant-subquery-literal-crashes-predicate-rewrite` (a promise-valued
literal read as if it were a plan-time constant) at a third site. That ticket
introduced the shared decision helper `planTimeLiteralValue` in
`planner/analysis/predicate-shape.ts`; the fingerprinter predates it and does not
use it.

## Expected behavior

A literal whose value is not known at plan time must never be treated as equal to
any other expression. The fingerprinter already has the right escape hatch for
exactly this situation — the per-node-unique `LI:?<node id>` fallback it uses for
a non-canonicalizable object — which disables common-subexpression elimination for
that literal while keeping every result correct.

Concretely:

- Both queries in the table above must return their expected rows.
- Ordinary literals must keep their current fingerprints, so existing
  common-subexpression elimination is unaffected (there is an existing spec suite
  for the rule; it must stay green).

## Scope: the whole class, not just this site

Reading `LiteralNode.expression.value` raw and assuming it is a resolved SQL value
is the defect class. Most readers in the planner are already safe — they test
`typeof v === 'number'` / `=== null` and a Promise simply fails those. Three
readers are not:

- `planner/analysis/expression-fingerprint.ts` ~109 — **live wrong results**,
  demonstrated above. The reason this ticket exists.
- `planner/rules/access/rule-monotonic-range-access.ts` ~76 — casts the value to
  `SqlValue` and uses it as a range bound for pruning. Currently unreachable:
  the constraint extractor no longer lets a promise-valued literal become a seek
  key. Latent, not dormant-forever — it becomes wrong the moment that changes.
- `schema/function.ts` ~360 (`evaluateLiteralOperand`) — feeds a table-valued
  function's row estimate. Cost-only, no wrong results, lowest priority.

Prefer a change that makes the class hard to reintroduce over three point fixes:
route these reads through the existing `planTimeLiteralValue` (or a sibling
accessor for the non-unwrapped case), so "is this literal usable at plan time?" is
asked in one place. If a general test can cover the class — e.g. one that walks
every planner path with a promise-valued literal, or a fingerprint-level property
test asserting distinct constant subqueries never share a fingerprint — prefer
that over per-site cases.

`docs/optimizer-const.md` §4 and §7 now state the pending-Promise rule explicitly
(they previously claimed the pass awaits the value, which is what invited the
assumption); keep them accurate if the representation changes.
