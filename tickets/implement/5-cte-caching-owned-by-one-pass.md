description: Two different parts of the optimizer both decide whether to keep a `with …` query result in memory, and they disagree — one of them buffers the same rows a second time, and it decides using a row count that is missing for any table nobody has collected statistics on.
files:
  - packages/quereus/src/planner/rules/cache/rule-cte-optimization.ts       # the rule to delete
  - packages/quereus/src/planner/optimizer.ts                              # registration at ~line 1247; comments at ~1210, ~1301
  - packages/quereus/src/planner/framework/pass.ts                         # comment at ~line 144 referencing `cte-optimization`
  - packages/quereus/src/planner/cache/materialization-advisory.ts         # the pass that keeps ownership (Rule 5a, shouldMaterializeCTE)
  - packages/quereus/src/planner/util/row-estimates.ts                     # NOTE at ~line 35 naming this rule
  - packages/quereus/test/fuzz.spec.ts                                     # CACHE_RULES list at ~line 1158
  - packages/quereus/test/optimizer/side-effect-audit.spec.ts              # NO_SIGNAL_ALLOWLIST at ~line 322
  - packages/quereus/test/optimizer/plan-shape-decisions.spec.ts           # "CTE referenced once is inlined (no CACHE node)"
  - packages/quereus/test/plan/cte-materialization.spec.ts                 # "does not produce a CACHE node for single-use CTE"
difficulty: easy
----

# One owner for CTE materialization

Two passes currently decide whether a common table expression (`with x as (…) select …`)
should have its rows kept in memory:

- **`MaterializationAdvisory`** (`planner/cache/materialization-advisory.ts`) counts how
  many times the CTE name is referenced and honors the `materialized` /
  `not materialized` hints, then sets `CTENode.materialize`. At emission,
  `emitCTE` buffers the rows once per statement execution. Its Rule 5a states the policy
  explicitly: *a CTE node never takes a `CacheNode` wrap — shared materialization is
  handled by the materialize mark.*

- **`ruleCteOptimization`** (`planner/rules/cache/rule-cte-optimization.ts`) wraps the
  CTE's **source** in a `CacheNode`, gated on a row estimate:

  ```ts
  const sourceSize = PlanNodeCharacteristics.estimatesRows(source);
  const shouldCache = (
      cteNode.materializationHint === 'materialized' ||
      (sourceSize > 0 && sourceSize < context.tuning.cte.maxSizeForCaching)
  ) && !isAlreadyCached;
  ```

The second pass contradicts the first's stated policy, and it decides from a number that
cannot carry the answer:

- `sourceSize > 0` is false for every table nobody has run `analyze` on — those report
  `0` rows, and that `0` means *unknown*, not *empty*. So caching turns on whether a
  maintenance command has been run, not on anything about the query.
- The gate never consults the reference count. Once a real estimate does arrive, it fires
  for **every** CTE in range, including single-reference ones — which two existing specs
  say must be inlined. Those specs pass today only because the estimate happens to be `0`.
- For a multi-reference CTE the wrap is redundant with the materialize mark, so the rows
  are buffered twice. The rule's own comment records this ("double-buffers … correct but a
  wasted buffer").

## Decision

**Retire `ruleCteOptimization`.** Every case it handles is already handled correctly, or
handled wrongly, by the pass that owns the decision:

| case | advisory | this rule |
|---|---|---|
| `materialized` hint | marks materialize → one buffer | adds a second buffer |
| two or more references | marks materialize → one buffer | adds a second buffer |
| one reference | inlines (correct) | caches once a real estimate exists (wrong) |

Nothing is lost. A CTE with a data-modifying body is marked `materialize` at **build**
time (`planner/building/with.ts`), not by either pass, so its write still runs exactly
once per execution without the `CacheNode` — that is what the side-effect audit's
allowlist entry for this rule was standing in for, and the entry goes away with the rule.

Retiring the rule is what unblocks the wider row-estimate repair: it is the only consumer
that reads a row estimate as `> 0` meaning "known and non-empty". Once it is gone, a
later ticket can make "unknown" report as absent rather than as `0` without turning these
two specs red.

## Edge cases & interactions

- **A `materialized`-hinted single-reference CTE.** The advisory marks it `materialize`
  on the hint alone (`shouldMaterializeCTE`), so it is still buffered once. Add or extend
  a plan test asserting no `CACHE` node appears above or below it.
- **A `not materialized`-hinted multi-reference CTE.** The advisory returns false, so it
  re-executes per reference — unchanged by this ticket, but confirm the rule's removal
  does not alter it (today the rule could still wrap it when the estimate was in range).
- **Recursive CTEs.** They run through `emitRecursiveCTE` and the working-table
  machinery; the advisory marks them by descriptor reference count. Confirm a recursive
  CTE plan is byte-identical before and after.
- **Data-modifying CTE bodies** (`with d as (delete from t returning *) select …`). The
  write must still execute exactly once. This is the one behavior the deleted rule was
  allowlisted for in `side-effect-audit.spec.ts` — cover it with an execution test that
  counts writes, not only a plan-shape test.
- **A CTE whose source is already a `CacheNode`** (e.g. wrapped by the nested-loop
  right-cache rule). The removed `isAlreadyCached` guard must not have been load-bearing
  anywhere else.
- **Golden plans.** `test/plan/joins/theta-nlj-right-cache.plan.json` is the only golden
  plan containing a `CACHE` node and it comes from `rule-nested-loop-right-cache`, a
  different rule — it must not change.
- **Rule-ordering comments.** `optimizer.ts` (~1210, ~1301) and `framework/pass.ts`
  (~144) describe pass ordering *relative to* `cte-optimization`. Those constraints are
  about the advisory running after CacheNode injection; re-read and rewrite them for the
  new reality rather than deleting the sentences wholesale.
- **`fuzz.spec.ts`'s `CACHE_RULES`** disables cache rules by id; dropping the id must not
  leave the list empty in a way the harness reads as "no rules to disable".

## TODO

- Delete `packages/quereus/src/planner/rules/cache/rule-cte-optimization.ts` and its
  import + registration in `planner/optimizer.ts`.
- Update the rule-ordering commentary in `planner/optimizer.ts` (~1210, ~1301) and
  `planner/framework/pass.ts` (~144) that names `cte-optimization`.
- Remove the `cte-optimization` entry from `NO_SIGNAL_ALLOWLIST` in
  `test/optimizer/side-effect-audit.spec.ts` and from `CACHE_RULES` in `test/fuzz.spec.ts`.
- Drop the `rule-cte-optimization` sentence from the NOTE in
  `planner/util/row-estimates.ts` (~line 35); the rest of that NOTE stays.
- Add a plan test: a `materialized`-hinted single-reference CTE is buffered once
  (`materialize` set, no `CACHE` node).
- Add an execution test: a data-modifying CTE body referenced twice performs exactly one
  write.
- Confirm `test/optimizer/plan-shape-decisions.spec.ts` and
  `test/plan/cte-materialization.spec.ts` still pass, and that they now pass for the right
  reason (reference count, not a zero estimate) — note this in the review handoff.
- Update `docs/optimizer.md` if it lists `cte-optimization` among the registered rules.
- Run `yarn build`, `yarn test`, `yarn lint`.
