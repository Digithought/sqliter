description: Fixed a bug where using two different constant subqueries in one query — such as adding `(select 1)` in one column and `(select 2)` in another — made the engine treat them as the same value, returning wrong numbers and silently dropping rows.
files:
  - packages/quereus/src/planner/analysis/expression-fingerprint.ts               # the fix: fingerprintLiteral now routes through literalValue
  - packages/quereus/src/planner/analysis/predicate-shape.ts                      # header doc rewritten; literalValue is now the shared primitive
  - packages/quereus/src/planner/rules/access/rule-monotonic-range-access.ts      # latent site closed
  - packages/quereus/src/schema/function.ts                                       # cost-only site closed
  - packages/quereus/src/planner/analysis/sat-checker.ts                          # open-coded guard migrated
  - packages/quereus/src/planner/nodes/limit-offset.ts                            # open-coded guard migrated
  - packages/quereus/src/planner/util/fd-utils.ts                                 # two open-coded guards migrated
  - packages/quereus/src/planner/stats/catalog-stats.ts                           # two open-coded guards migrated
  - packages/quereus/src/runtime/emit/binary.ts                                   # open-coded guard migrated
  - packages/quereus/test/logic/96-subquery-edge-cases.sqllogic                   # 8 new end-to-end cases at the tail
  - packages/quereus/test/optimizer/expression-fingerprint.spec.ts                # 5 new unit cases (new nested describe)
  - packages/quereus/test/optimizer/statistics-edge-cases.spec.ts                 # mock fidelity fix (see "Test edits you should look at")
  - packages/quereus/test/optimizer/statistics.spec.ts                            # same
  - packages/quereus/test/planner/stats/catalog-stats.spec.ts                     # same
  - docs/optimizer-const.md                                                       # §4 now names both accessors
repro: verified
difficulty: medium
---

# Review: constant subquery literals no longer collide in CSE

## What was wrong

Constant folding is a **synchronous** optimizer pass, but the value it folds may be
async. `const-pass.ts` `replaceBorderNodes` therefore builds a `LiteralNode` whose
`expression.value` can be a **still-pending Promise**, which only the emitter awaits
(`runtime/emit/literal.ts`). Every uncorrelated constant scalar subquery — `(select 1)` —
folds to exactly that shape.

`fingerprintLiteral` read `node.expression.value` raw and dispatched on its JavaScript
type. A Promise matched none of the scalar arms, fell into the "JSON document" branch,
and canonicalized to the empty object — so **every** promise-valued literal fingerprinted
as `LI:j{}`. `rule-scalar-cse.ts` groups subexpressions by fingerprint and collapses each
duplicate group into one shared computation, so two expressions differing only in which
constant subquery they contained became one.

Two user-visible symptoms, both verified on the tree before the fix:

| query | before | after |
| --- | --- | --- |
| `select x + (select 1) as a, x + (select 2) as b from t where id = 1` | `[{a:11,b:11}]` | `[{a:11,b:12}]` |
| `select id from t where x = (select 10) or x = (select 20) order by id` | `[{id:1}]` | `[{id:1},{id:2}]` |

The second silently dropped a qualifying row with no error.

## What changed

**The fix (one site).** `fingerprintLiteral` now calls `literalValue(node.expression)` —
the existing shared plan-time accessor in `predicate-shape.ts` — and returns the
per-node-unique `LI:?<node id>` fingerprint (with a `log()` line) when it comes back
`undefined`. The JSON-document branch and its existing `NOTE:` about fingerprint size are
untouched.

Same site, one extra hardening beyond the ticket: the function's trailing fallback was
`LI:?${String(value)}`, which would give two literals holding the same unexpected host
value the *same* fingerprint. It is now `LI:?${node.id}` too, so the invariant is uniform:
**any literal we cannot fingerprint by value gets a node-unique fingerprint.** Unreachable
for a well-typed `SqlValue`, but it was the same collision class one line down.

**Closing the class (Phase 2).** All three unsafe raw readers named in the ticket now
reject a pending Promise, and every open-coded `v instanceof Promise` guard listed as
optional cleanup was migrated too — there is now **one** definition of the plan-time-value
test:

| site | change |
| --- | --- |
| `expression-fingerprint.ts` | `literalValue` (the fix) |
| `rule-monotonic-range-access.ts` ~76 | `planTimeLiteralValue(seekKey)`; the `as SqlValue` cast that hid the Promise arm from the compiler is gone, as is the now-unused `LiteralNode` value import |
| `schema/function.ts` `evaluateLiteralOperand` | body is now just `planTimeLiteralValue(operand)`; the duck-typed `{ type?: string; value?: SqlValue }` annotation (a lie about the runtime type) is deleted rather than retyped |
| `sat-checker.ts` `literalOf` | `literalValue` |
| `limit-offset.ts` `constantLimit` | `literalValue` |
| `fd-utils.ts` `literalSqlValueOf`, `constantValueOf` | `literalValue` |
| `catalog-stats.ts` `extractConstantValue`, `extractBetweenBounds` | `literalValue` |
| `runtime/emit/binary.ts` `constLikePattern` | `literalValue` |

**No import cycle.** `predicate-shape.ts` value-imports only the `PlanNodeType` enum
(`plan-node-type.ts`, which has zero imports of its own); everything else in it is
`import type`. So `schema/function.ts` → `predicate-shape.js` → `plan-node-type.js` is a
clean chain, and `yarn build` (`tsc -b` across all packages) is green. The fallback
described in the ticket (explicit guard + `MaybePromise<SqlValue>` annotation) was not
needed. `runtime/emit/binary.ts` importing `planner/analysis/` matches ~15 existing
`runtime/emit → planner/analysis` imports, so it introduces no new layering direction.

**Docs.** `docs/optimizer-const.md` §4 now names both accessors, states what `undefined`
vs `null` mean, and cites both bug slugs. `predicate-shape.ts`'s file header was rewritten
to say plainly that these two functions are the shared answer and that new code should not
open-code another `instanceof Promise` test.

## How to exercise it

End-to-end, in `test/logic/96-subquery-edge-cases.sqllogic` (new section at the tail,
table `sq_cse_t` holding `(1,10),(2,20)`):

- both failing queries from the ticket
- three distinct constant subqueries in one projection
- the **same** constant subquery repeated (both arms must still see the same value)
- distinct constant subqueries in an `ORDER BY` chain
- three controls that were already correct and must stay correct: bare `(select 1)` /
  `(select 2)` as whole projections, ordinary literals in the same projection shape,
  ordinary literals across a disjunction

Unit-level, `test/optimizer/expression-fingerprint.spec.ts`, new
`pending-Promise literals (folded async constants)` describe inside
`Literal edge cases (mutation-killing)` — the general property first, as the ticket asked:

- N literals over distinct pending Promises produce N distinct fingerprints, all `LI:?…`
- two literals over the **same** Promise instance still fingerprint distinctly (deliberately
  conservative — the value is unknown at plan time, so sharing is never provable here)
- a promise-valued literal never collides with `{}`, `{a:1}`, `[]`, `[1,2]`
- nor with `1`, `1n`, `'a'`, `true`, `null`, `Uint8Array`
- enclosing expressions (`col + <promise literal>`) built over distinct promises stay distinct

Manual repro if you want to see it bite: revert only the `const value = literalValue(...)`
line in `fingerprintLiteral` to `node.expression.value` and run
`node packages/quereus/test-runner.mjs --reporter spec --grep "96-subquery"` — it fails at
`96-subquery-edge-cases.sqllogic:238` with `Actual: {"a":11,"b":11}`. I ran exactly this
before and after, so the new cases are confirmed to fail without the fix.

## Validation run

From repo root, all foreground, all green:

- `yarn build` — clean
- `yarn test` — 10179 + 420 + 179 + 89 + 78 + 89 + 1922 + 736 + 85 + 31 + 34 + 134 + 22
  passing, 25 pending, **0 failing**
- `yarn lint` — clean (this is the pass that type-checks quereus test files)
- `yarn typecheck` — clean

`yarn test:store` was **not** run (slow; nothing here touches the store path).
No pre-existing failures surfaced, so `tickets/.pre-existing-error.md` was not written.
The tee'd log is at `tickets/.logs/bug-constant-subquery-literals-collide-in-cse.test.log`
(gitignored, auto-pruned).

## Test edits you should look at

The ticket required `scalar-cse.spec.ts` and `expression-fingerprint.spec.ts` to stay green
**without edits to existing assertions** — they did; nothing in either was modified, only
added.

But three *other* spec files needed a one-token helper fix, and this is the part worth a
skeptical read:

`mockLiteral` in `test/optimizer/statistics-edge-cases.spec.ts`,
`test/optimizer/statistics.spec.ts`, and `test/planner/stats/catalog-stats.spec.ts` built
`expression: { value }` — **without** the `type: 'literal'` tag that a real
`AST.LiteralExpr` always carries. `literalValue` checks that tag, so every mocked literal
started reading as "not a literal" and `catalog-stats` selectivity silently fell back to
its heuristics. One test caught it (`BETWEEN with histogram exercises range-based
selectivity`, expected `> 0.3`, got `0.25`); `--bail` means others may have been masked.

I fixed the mocks to `expression: { type: 'literal', value }` rather than backing out the
`catalog-stats.ts` migration, on the grounds that the mock was an unfaithful stand-in for
the real node. Note the side effect: **`catalog-stats.spec.ts`'s two "Promise literal value
falls back" tests were previously passing for the wrong reason** — the mock failed the
literal check before the Promise check ever mattered. They now exercise the Promise path
for real. If you disagree with editing mocks in files this ticket otherwise didn't touch,
the alternative is reverting only the two `catalog-stats.ts` call sites to their open-coded
guards; nothing else depends on that choice.

## Known gaps / where to push

- **`rule-monotonic-range-access.ts` has no new test.** The ticket calls that site
  unreachable today (the constraint extractor no longer lets a promise-valued literal
  become a seek key), and I did not find a way to reach it from SQL. The change is
  therefore verified only by the existing suite staying green plus the type checker no
  longer being able to hide the Promise arm. If you can construct a plan that reaches
  `extractRangeBounds` with a folded-constant seek key, that is the highest-value thing to
  add here.
- **`schema/function.ts` has no new test either.** Same reason — it is cost-only (a
  table-valued function's row estimate), and `generate_series(1, (select 100))` would need
  a TVF whose advertisement closure calls `evaluateLiteralOperand`. Worth confirming
  whether any shipped TVF advertisement actually exercises it.
- **The 5 new unit tests are a floor, not a ceiling.** They assert the property at the
  fingerprint seam. They do not assert anything about `rule-scalar-cse.ts`'s grouping
  behavior itself — that is covered only transitively, through the sqllogic cases.
- **No plan-shape assertion.** The sqllogic cases check *results*. Nothing asserts that CSE
  is now correctly declining to merge these subtrees, so a future change that fixed results
  by disabling CSE wholesale would not be caught.
- **Tripwire parked in code, not filed as a ticket** (index entry below, per the rules): a
  `NOTE:` at `expression-fingerprint.ts` `fingerprintLiteral` records that two *textually
  identical* constant subqueries in one statement now each run once instead of sharing one
  computation. Cheap today — the values are already materialized promises, and the
  pre-folding `ScalarSubquery` form was never a CSE candidate either (`_SQ:<node id>`) — so
  this is a cost only if a workload ever repeats an expensive constant subquery many times
  in one statement. The note names the fix if it trips (key on the folded subquery's
  identity rather than the node id).

## Review findings

- Tripwire parked at `packages/quereus/src/planner/analysis/expression-fingerprint.ts`
  (`fingerprintLiteral`, `NOTE:`): identical constant subqueries no longer share one
  computation after this fix. Conditional, not a defect — see the gap list above.
