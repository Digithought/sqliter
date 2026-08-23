description: When an application registers its own SQL aggregate function under a name a materialized view already uses, queries the view covers silently return the view's old stored numbers instead of running the new function; make the optimizer notice the name changed meaning and skip the view.
files:
  - packages/quereus/src/schema/derivation.ts                                    # TableDerivation — where the recorded identity goes
  - packages/quereus/src/core/database-materialized-views.ts                     # ~308 registerMaterializedView — the capture point
  - packages/quereus/src/planner/analysis/query-rewrite-matcher.ts               # ~74 RewriteFailureReason, ~589 matchAggregateFragmentToMv, ~1209 recipeForExact, ~1229 recipeForRollup, ~1283 resolveMergeablePartial
  - packages/quereus/src/planner/rules/cache/rule-materialized-view-rewrite.ts   # ~179 rewriteAggregate — threads the probes into the matcher
  - packages/quereus/src/schema/function.ts                                      # ~466 getFunctionKey — the (name, argc) key format
  - packages/quereus/test/query-rewrite-aggregate.spec.ts                        # matcher unit tests — already imports createAggregateFunction
  - docs/usage.md                                                                # ~688 — the "known exception" paragraph that names the source ticket
  - docs/optimizer-rule-families.md                                              # ~29 — the aggregate-rollup arm paragraph
repro: verified
difficulty: medium
---

# The materialized-view rewrite must check *which* function a name resolves to

## What is wrong

Registering a function overwrites by name and argument count, so
`db.createAggregateFunction('sum', …)` replaces the built-in `sum/1` for every query on
that connection. The optimizer separately decides that a grouped materialized view can
answer a `group by` query, and it decides that by comparing **function names** — the name
parsed out of the view body's stored AST against the name in the query. Nothing checks
that the name still means the same function it meant when the view's rows were computed.

Result: the same query answered two ways disagrees, and neither errors.

### Observed (both arms re-run for this ticket, `packages/quereus`, memory backing)

Base table `t(id integer primary key, k integer not null, x integer not null)` with rows
`(1,1,10),(2,1,20),(3,2,30)`.

**Arm A — built-in taken over.** View `mv as select k, sum(x) as s from t group by k`,
then a deterministic user `sum/1` that counts rows is registered:

| query | expected (user `sum` = row count) | observed |
| --- | --- | --- |
| `select k, sum(id) from t group by k` — view does not cover it | `k=1→2, k=2→1` | `k=1→2, k=2→1` — correct |
| `select k, sum(x) from t group by k` — view covers it | `k=1→2, k=2→1` | `k=1→30, k=2→30` — **wrong** |

**Arm B — one user aggregate swapped for another.** A user aggregate `myagg/1` that sums
is registered *first*, then `mv2 as select k, myagg(x) as s from t group by k` is created,
then `myagg/1` is re-registered as a row counter:

| query | expected after the swap | observed |
| --- | --- | --- |
| `select k, myagg(x) from t group by k` | `k=1→2, k=2→1` | `k=1→30, k=2→30` — **wrong** |

Arm B is the reason a "is it the built-in?" check is not enough — there is no built-in
anywhere in it. Both arms are one defect and close together.

**Not affected, confirmed:** a view built over a user aggregate that is *still* the
registration the view was built on answers correctly (a view created while the counting
`sum` was already registered returns `k=1→2, k=2→1`, and the covered query agrees).
Whatever gate lands must keep that working.

### Why the determinism gate does not already cover this

The rewrite declines any view whose body calls a non-deterministic function, and
`db.createAggregateFunction` defaults to *not* deterministic — so a shadow registered with
the plain default already declines and behaves correctly. Only a shadow that explicitly
declares itself `DETERMINISTIC` reaches the bug. That is a flag an application sets in
good faith about its own function, not a warning sign, so the gate is coincidental cover,
not a fix.

## Root cause

`TableDerivation` (`src/schema/derivation.ts`) records the view body's parsed AST and a
hash of its text. It records nothing about *which registered functions* produced the rows
sitting in the backing table.

Everything downstream therefore works off names:

- `analyzeMvStoredColumns` (`query-rewrite-matcher.ts` ~1332) reads the body AST and
  records each stored aggregate as `{ funcName: fn.name.toLowerCase(), … }`.
- `recipeForExact` (~1209) matches a query aggregate to a stored one with
  `sa.funcName === qa.funcName` and hands back the stored column verbatim. No function is
  resolved at all — which is why arm A and arm B both slip through the exact-key path.
- `recipeForRollup` (~1229) and `resolveMergeablePartial` (~1283) *do* resolve a schema,
  but off the **live** registry by `(name, argc)` — so they pick up the shadow's declared
  algebra and apply it to partials the old function produced.

## What must hold

**The function resolving now must be the function whose output the view stores.** That is
strictly stronger than "is it the built-in", because arm B has no built-in in it.

The only thing that can witness "the function whose output the view stores" is the
registration that was live when the view's maintenance plan was built. That plan is built
once, in `MaterializedViewManager.registerMaterializedView`
(`database-materialized-views.ts` ~308), and cached in `this.rowTime` — confirmed by
observation: after registering the counting `sum`, inserting `(4,2,5)` still maintained
the view with built-in semantics (`30 + 5 = 35`), because the cached plan holds the
built-in's implementation. So registration time is both the moment the maintaining
functions are fixed *and* a place with access to the live registry.

## Design

### Record the identity on the derivation

Add a runtime-only field to `TableDerivation`:

```ts
/**
 * The registered function schemas the body's function calls resolved to when this
 * derivation's maintenance plan was built — i.e. the functions that produced (and
 * keep producing) the backing's rows. Keyed by `getFunctionKey(name, argc)`.
 *
 * The read-side rewrite compares the LIVE resolution of a name against the schema
 * recorded here by object identity, so a name re-registered to a different function
 * declines the rewrite instead of serving the old function's stored values.
 *
 * Runtime state, never serialized — object identity cannot cross a process boundary.
 * Re-captured on every re-registration, exactly like `sourceScope`.
 */
bodyFunctions?: ReadonlyMap<string, FunctionSchema>;
```

Serialization is safe by construction: the catalog surfaces a maintained table's
derivation through an explicit field pick (`maintainedDescriptor` in `src/schema/catalog.ts`
~377 takes only `bodyHash` / backing module / `selectAst`), which is the same reason
`stale` and `sourceScope` already live here without leaking.

The derivation object is shared by reference across catalog swaps — `alter table … rename`
rebuilds the table schema with `{...table}` (`alter-table.ts` ~2377
`rewriteTableForTableRename`), so the derivation reference survives the swap. That matters
for the follow-on ticket, not for this one.

### Capture it at registration

In `registerMaterializedView`, alongside the existing `sourceScope` assignment: walk
`mv.derivation.selectAst` for function calls, resolve each `(name, argc)` off the live
registry (the same lookup the rule's probes use — `schemaManager.findFunction(name, argc)
?? schemaManager.findFunction(name, -1)`), and store the resulting schemas under
`getFunctionKey(name, argc)`. Assign unconditionally, so a re-registration refreshes it.

A name that resolves to nothing is simply absent from the map; the gate below treats
absent as "cannot vouch" and declines.

### Gate the matcher

`matchAggregateFragmentToMv` already receives everything it needs — the `mv` (hence the
recorded map) and the `AggregateResolver` probe (hence the live resolution). No new
registry import in the analysis module.

Add one helper and call it in three places:

- Before/within `recipeForExact`, for the query aggregate's own
  `(qa.funcName, aggArgc(qa.argBaseCol))` — this is the path that resolves nothing today,
  and the one arm A and arm B both take.
- In `recipeForRollup`, for `(qa.funcName, aggArgc(qa.argBaseCol))` before its algebra is
  trusted.
- In `resolveMergeablePartial`, for `(p.func, storedArgc)` — including the `count(*)`
  substitution branch, which resolves `count/0`.

The check is `recorded.get(key) !== undefined && recorded.get(key) === resolveAggregate(name, argc)`.
Absent recorded map, absent entry, or a mismatch ⇒ decline. Declining is always safe: the
query falls back to computing the aggregate itself — correct, only slower.

Passing `recipeForExact` / `recipeForRollup` a small `identityOk(name, argc): boolean`
closure built once at the top of `matchAggregateFragmentToMv` keeps their signatures from
growing a third registry-shaped parameter.

### Name the decline distinctly

Add to `RewriteFailureReason` (`query-rewrite-matcher.ts` ~74):

```
| 'function-rebound'        // a function the MV body used now resolves to a different registration
```

Keep it distinct from `aggregate-not-decomposable` so the matcher unit tests can observe
it directly, per the reported expectation.

## Scope boundaries

**Out of scope — the maintenance side.** Re-registering the view (e.g.
`alter table mv rename to mvr`) after a shadow is registered rebuilds the maintenance plan
against the shadow, and a subsequent insert leaves the backing holding *both* functions'
output: observed `k=1→30` (built-in) alongside `k=2→2` (the counting shadow). That is a
separate site and a worse symptom; it is `bug-mv-maintenance-detects-function-drift`,
which consumes the field this ticket adds. Do not try to solve it here — but do not make
it harder either: keep the capture unconditional so the follow-on can compare the prior
map against the freshly resolved one.

**Out of scope — across a reopen.** Object identity cannot survive a process boundary, so
on a fresh connection over persisted state the map is captured from whatever is registered
then. Nothing this ticket adds can verify that a *user* function is the same code as last
session's. Say so plainly in the doc note rather than implying otherwise.

**Not affected — the projection and join arms.** A view over a computed column such as
`upper(name)` is not matched by the projection rewrite at all, and a function call in a
body's `WHERE` is not among the clause shapes `recognizeConjunctiveClauses` recognizes, so
it fails predicate entailment instead. Leave a `NOTE:` at the top of
`analyzeMvStoredColumns` (or beside `matchFragmentToMv`) recording that if either arm ever
learns to match computed columns, it must consume `bodyFunctions` the same way — a
tripwire, not work to do now.

## TODO

Phase 1 — representation and capture

- Add `bodyFunctions?: ReadonlyMap<string, FunctionSchema>` to `TableDerivation` with the doc comment above; import the type.
- Add a small AST walk collecting `(name, argc)` for every function call in a body `QueryExpr` — select-list items, `WHERE`, `GROUP BY`. Put it wherever it reads naturally next to the existing body walks in the analysis area, but keep it callable from `database-materialized-views.ts`.
- Populate `mv.derivation.bodyFunctions` in `registerMaterializedView`, unconditionally, beside the `sourceScope` assignment.

Phase 2 — the read-side gate

- Add `'function-rebound'` to `RewriteFailureReason` with a comment matching the neighbours' style.
- Build an `identityOk(name, argc)` closure in `matchAggregateFragmentToMv` from `mv.derivation.bodyFunctions` and the `AggregateResolver`; return `fail('function-rebound')` when a recipe declines for this reason specifically, not folded into `aggregate-not-decomposable`.
- Apply it in `recipeForExact`, `recipeForRollup`, and `resolveMergeablePartial` (including the `count(*)` substitution branch).
- Add the `NOTE:` tripwire about the projection / join arms.

Phase 3 — tests

- In `test/query-rewrite-aggregate.spec.ts`: a shadowed built-in `sum` declines with `function-rebound`, in both the exact-key and the rollup shape.
- A user aggregate re-registered to a different implementation declines (arm B).
- A view built over a user aggregate that is still the live registration still matches — the regression guard for the capability this must not break.
- An end-to-end case asserting the *values*, not just the matcher verdict: the covered and uncovered spellings of the same query agree after a shadow is registered.
- A shadow at a different arity (`sum/2`) leaves `sum/1` and its rewrite alone.

Phase 4 — docs

- `docs/usage.md` ~688: replace the "One known exception … Tracked as `bug-mv-aggregate-rewrite-ignores-shadowed-function`" paragraph with what actually happens now — the rewrite declines and the query is computed normally — plus the honest limit that across a reopen a user function's sameness cannot be verified.
- `docs/optimizer-rule-families.md` ~29 (aggregate-rollup arm): add `function-rebound` to the listed decline reasons. While in that paragraph, note that its "decomposable-aggregate allowlist (`sum`→`sum`, …)" wording is already stale — the code drives entirely off each aggregate's declared algebra (`recipeForRollup`), with no name list — so correct it in the same pass.

Phase 5 — validation

- `yarn workspace @quereus/quereus test` green, plus `yarn lint` and `yarn typecheck`.
- Confirm the existing MV-rewrite suites still match: a capture point that misses some registration path would show up as blanket `function-rebound` declines rather than a targeted one.
