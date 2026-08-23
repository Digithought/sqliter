description: A query answered from a materialized view used to return the view's old stored numbers when the application had since registered its own function under a name the view uses; the optimizer now notices the name changed meaning and computes the query normally instead.
files:
  - packages/quereus/src/schema/derivation.ts                                    # ~69 new `bodyFunctions` field
  - packages/quereus/src/planner/analysis/mv-body-functions.ts                   # NEW — the capture walk
  - packages/quereus/src/core/database-materialized-views.ts                     # ~318 registerMaterializedView — capture point
  - packages/quereus/src/planner/analysis/query-rewrite-matcher.ts               # ~83 reason, ~178 RecipeOrDecline, ~245 FunctionIdentityGate, ~694 gate build, ~1243/~1281/~1338 the three call sites, ~1387 tripwire NOTE
  - packages/quereus/src/planner/analysis/predicate-shape.ts                     # ~151 walkAstNodes param widened to AstNode
  - packages/quereus/test/query-rewrite-aggregate.spec.ts                        # ~512+ new "function identity" describe block
  - docs/usage.md                                                                # ~688 shadowing section rewritten
  - docs/materialized-views.md                                                   # ~282 new "Function identity" paragraph
  - docs/optimizer-rule-families.md                                              # ~29 aggregate-rollup arm
difficulty: medium
---

# Review: the MV query rewrite now gates on function identity

## What the bug was

`db.createAggregateFunction('sum', …)` replaces the built-in `sum/1` for every later
query on that connection. The optimizer decided a grouped materialized view could answer
a `group by` query by comparing **function names** between the view's stored body and the
query. Nothing checked the name still meant the same function that computed the view's
stored rows, so the covered spelling of a query returned the *old* function's numbers
while the uncovered spelling returned the new function's — silently, no error.

Both reported arms reproduced before the change and are fixed:

| setup | query | before | after |
| --- | --- | --- | --- |
| MV over built-in `sum(x)`, then a user `sum/1` that counts rows | `select k, sum(x) from t group by k` | `k=1→30, k=2→30` | `k=1→2, k=2→1` |
| MV over user `myagg(x)` (a summer), then `myagg/1` re-registered as a counter | `select k, myagg(x) from t group by k` | `k=1→30, k=2→30` | `k=1→2, k=2→1` |

## What changed

**Capture (`TableDerivation.bodyFunctions`).** `registerMaterializedView` now walks the
body AST, resolves every function call `(name, argument count)` against the live registry
(`findFunction(name, argc) ?? findFunction(name, -1)`), and stores the resulting schema
objects keyed by `getFunctionKey(name, argc)`. Assigned unconditionally, right beside the
existing `sourceScope` assignment, so a re-registration refreshes it. Runtime-only — the
catalog surfaces a maintained table through an explicit field pick
(`maintainedDescriptor`), so it never reaches serialization; verified by reading that
function and the one shallow derivation copy (`catalog-persistability.ts` ~136), which
feeds the same picker.

The walk is `walkAstNodes` (the existing reflective whole-subtree walk), whose parameter
was widened from `AST.Expression` to `AST.AstNode` so a whole body `QueryExpr` walks the
same way an expression does. That covers select list, WHERE, GROUP BY, HAVING, ORDER BY,
and nested subqueries — a clause cannot be missed by a forgotten visitor case.

**Gate (`'function-rebound'`).** A new `RewriteFailureReason`, distinct from
`aggregate-not-decomposable`. `matchAggregateFragmentToMv` builds one
`identityOk(name, argc)` closure comparing the recorded schema against
`resolveAggregate(name, argc)` by object identity; absent map, absent entry, or a
different object ⇒ decline. Applied at the three sites that consume a stored value:
`recipeForExact` (the path that previously resolved no function at all — the one both
reported arms took), `recipeForRollup`'s directly-mergeable branch, and
`resolveMergeablePartial` (including the `count(*)` substitution branch). The recipe
helpers now return `AggregateRecipe | 'rebound' | undefined` so the two decline kinds stay
distinguishable at the call site.

**Deviation from the ticket, deliberate — please check this reasoning.** The ticket said
to gate `recipeForRollup` on the *query* aggregate's `(name, argc)` before trusting its
algebra. Doing that literally breaks the existing `rollup avg` test: the SALES MV body
stores `sum`/`count` and never names `avg`, so `avg/1` is legitimately absent from the
capture and every avg rollup would decline. The gate is therefore applied to the functions
whose **stored values are consumed** — the aggregate's own partial on the direct-merge
path, each sibling partial on the decompose path — and not to the composed aggregate
itself. Argued sound: the recombine uses the *live* `avg`'s declared decomposition (same
as recomputing over the base would), over partials proven to be the live `sum`/`count`.
The rationale is recorded in `recipeForRollup`'s doc comment.

## Use cases to test / validate

Matcher-level (drives `matchAggregateMaterializedViewRewrite` directly, so the decline
reason is observable) plus one end-to-end value check. All in
`test/query-rewrite-aggregate.spec.ts`, describe block `— function identity`:

- Shadowed built-in `sum` ⇒ `function-rebound` on the **exact-key** shape (`select k,
  sum(x) from ti group by k`), asserted to have matched *before* the shadow so the test
  cannot pass vacuously.
- Same shadow ⇒ `function-rebound` on the **rollup** shape (`select sum(x) from ti`). The
  shadow deliberately declares `merge`+`decode`, so the rollup is expressible and the
  decline is provably the identity mismatch, not `aggregate-not-decomposable`.
- Arm B with **no built-in involved**: user `myagg/1` (a summer with algebra) → MV built →
  `myagg/1` re-registered as a counter ⇒ `function-rebound`.
- **Regression guard for the capability this must not break**: a view built over a user
  aggregate that is *still* the live registration keeps matching, both exact-key and
  rollup.
- **Arity isolation**: registering `sum/2` leaves `sum/1` and the `byregion` rewrite alone.
- **End-to-end values**: after the shadow, the covered spelling (`sum(x)`, answerable from
  the MV) and the uncovered one (`sum(id)`) both return the per-group row count
  `[1,2] [2,1]`, and the plan for the covered query does not name the backing.

Worth a reviewer's own probing: a body whose aggregate argument is a computed expression;
`min`/`max` under a collated argument with a shadow; two MVs over the same base where only
one uses the shadowed name (only that one should decline).

## Validation run

- `yarn workspace @quereus/quereus test` — **10213 passing, 25 pending**, run twice
  (before and after the final doc/comment polish). No pre-existing failures surfaced;
  `tickets/.pre-existing-error.md` not written.
- `yarn typecheck` (all workspaces) — clean. `yarn lint` (all workspaces, incl. the
  quereus eslint + `tsconfig.test.json` pass) — clean.
- The whole pre-existing aggregate-rewrite suite (22 tests) still matches where it did
  before, which is the check the ticket asked for: a capture point missing a registration
  path would show up as blanket `function-rebound` declines, not targeted ones.

## Known gaps — read these before signing off

**1. Re-registration refreshes the capture, which re-opens the maintenance hole.** This is
the sharpest edge and it is *new information* relative to the source ticket. `alter table
mv rename to mvr` (or any other path that re-registers) after a shadow is registered
rebuilds the maintenance plan against the shadow **and** re-captures `bodyFunctions` from
the shadow. The read-side gate then passes again — while the backing holds a mix of both
functions' output (the source ticket observed `k=1→30` built-in alongside `k=2→2` from the
counting shadow). So this ticket does not make that scenario worse than it was, but it
also does not close it, and the read gate no longer stands in its way. That is squarely
`bug-mv-maintenance-detects-function-drift`, which is designed to consume this field: the
capture is written as one statement, so that ticket can read the prior map (`const prior =
mv.derivation.bodyFunctions`) before the overwrite. No test covers the rename-after-shadow
sequence here — deliberately, it belongs to that ticket.

**2. Across a process boundary the check cannot verify a user function.** Object identity
does not survive a reopen; on a fresh connection over persisted state the capture is taken
from whatever is registered then. Stated plainly in `docs/usage.md` and
`docs/materialized-views.md` rather than implied away.

**3. Store-backed reopen path not exercised.** `yarn test:store` was not run (AGENTS.md
reserves it for store-specific diagnosis, and it is slow). The attach/reopen paths all
funnel through `registerMaterializedView` per a grep of every call site, so the capture
should be taken there too — but that is a read of the call graph, not an observation.

**4. The gate covers the aggregate arm only.** The projection and join arms match only
bare passthrough columns today, so a body's computed column (`upper(name)`) makes them
forgo on shape and they need no gate. Parked as a `NOTE:` tripwire at
`analyzeMvStoredColumns`, per the ticket. Non-aggregate functions *are* captured into the
map (the walk is whole-body) but nothing consults them yet.

**5. Over-capture is possible, and conservative.** A function call in a body subquery
records a key that the gate may later consult even though the consumed stored column is
unrelated — a mismatch there declines a rewrite that would in fact have been fine.
Forgoing a speedup only; no test pins this and none seemed worth writing.

**6. The determinism gate still fires first and can mask this one.** An application that
registers a shadow through `Database.createAggregateFunction` without declaring it
deterministic gets `no-candidate`, not `function-rebound` — same correct outcome, different
reason. The new tests use the registration helper (`func/registration.ts`), which defaults
to deterministic, so they reach the new gate. Reviewers reading the source ticket's
"determinism is coincidental cover" paragraph should know the coincidence is still there;
it is just no longer load-bearing.

## Review findings

- **Tripwire parked** — `NOTE:` at `analyzeMvStoredColumns`
  (`query-rewrite-matcher.ts` ~1387): if the projection or join arm ever learns to match a
  computed column, it must consume `derivation.bodyFunctions` the same way. Conditional
  today (neither arm matches computed columns at all), so it is knowledge, not queued work.
- Corrected a stale doc claim while in the area, as the source ticket asked:
  `docs/optimizer-rule-families.md` described the rollup as driven by a
  "decomposable-aggregate allowlist (`sum`→`sum`, …)". There is no name list — the code
  drives entirely off each aggregate's declared algebra. Rewritten to say so.
