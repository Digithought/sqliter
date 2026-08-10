description: Queries with a correlated aggregate subquery in the SELECT list (e.g. a count of child rows per parent) now rewrite into a single grouped left join, so the child table is scanned once instead of once per parent row. Reviewed and shipped.
files: packages/quereus/src/planner/rules/subquery/rule-scalar-agg-decorrelation.ts, packages/quereus/src/planner/analysis/scalar-subqueries.ts, packages/quereus/src/planner/analysis/equi-correlation.ts, packages/quereus/src/planner/rules/subquery/rule-subquery-decorrelation.ts, packages/quereus/src/planner/rules/join/rule-fanout-lookup-join.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/src/func/registration.ts, packages/quereus/src/runtime/emit/aggregate.ts, packages/quereus/test/logic/07.7-scalar-agg-decorrelation.sqllogic, packages/quereus/test/plan/scalar-agg-decorrelation.spec.ts, packages/quereus/test/optimizer/decorrelation-analysis.spec.ts, docs/optimizer-rules.md
----

# Complete: scalar-aggregate subquery decorrelation into grouped joins

New Structural-pass rule `scalar-agg-decorrelation` rewrites a correlated
scalar-aggregate subquery in a SELECT projection into a grouped LEFT JOIN, so
the inner table is scanned/hash-aggregated once instead of re-executed per outer
row. Shared analysis helpers (`analysis/scalar-subqueries.ts`,
`analysis/equi-correlation.ts`) factored out of the fanout and EXISTS/IN
decorrelation rules. `cloneInitialValue` moved to `func/registration.ts` so the
planner can compute empty-group values via the exact runtime finalize path
without a planner→runtime import.

See the implement commit (`git log --grep="ticket(implement):
quereus-decorrelate-scalar-agg-subquery-project"`) and `docs/optimizer-rules.md`
(`ruleScalarAggDecorrelation` entry) for the full design.

## Review findings

Adversarial pass over the implement diff (fresh read of the rule before the
handoff), plus a full lint + test run. **No major findings; no new tickets
filed.** The implementer's own follow-ups (`feat-decorrelation-cost-model`,
`feat-decorrelate-subqueries-beyond-select-list`, plus the discovered
`fix/bug-nlj-right-side-not-cached` and cache-related backlog items) already
capture the parked scope; nothing to add.

**Correctness — verified sound:**

- **Empty-group "count bug" marker.** Adversarially checked the claimed
  equivalence `group-key IS NULL ⇔ join miss`. Confirmed: a matched left-join
  row required every correlation conjunct `outer=inner` to be TRUE, so each
  inner key (incl. `groupAttrs[0]`) is non-NULL; a NULL-keyed inner group can
  never satisfy `outer = NULL`, so it never matches any outer row. Holds for
  single and composite keys, and for duplicate-outer-column conjuncts. The
  `count(c.v)` all-NULL-input case (real 0 via the aggregate, join match, CASE
  else-branch) is correctly distinguished from the join-miss 0 (CASE
  then-branch) — pinned in the sqllogic (lines 22-25).
- **Empty-value equivalence.** `computeEmptyInputValue` calls
  `finalizeFunction(cloneInitialValue(initialValue))`; read the zero-group path
  in `runtime/emit/aggregate.ts:213-295` and confirmed it is byte-identical to
  the runtime's zero-row finalize. Non-foldable values (throw/async/non-
  primitive) bail. `json_group_array` empty → NULL (native-array finalize),
  consistent with the correlated path by construction.
- **Cardinality preservation.** The grouped right side yields ≤1 row per distinct
  key combination and every join conjunct constrains a group key, so each outer
  row matches 0 or 1 group — the left join cannot fan out. Verified all inner
  refs used in the join condition are group keys (no unconstrained key).
- **Bail gates.** HAVING (Filter above the aggregate), Sort/LimitOffset
  wrappers, GROUP BY, composite/multi-aggregate roots, non-equi correlation,
  pushed-down correlation, multi-table inner (source not a direct Filter),
  side-effecting inner, non-deterministic finalize, and non-value-faithful
  remaps all bail conservatively and keep today's correlated semantics
  (including the >1-row scalar-subquery error). `collectExternalReferences`
  backstop on the rebuilt right side catches any remap miss.
- **Column indexing for stacked joins.** `leftWidth`-relative key/value indices
  recomputed per join; inner attribute ids are table-distinct, so no collision
  across stacked subqueries.
- **Refactor.** Helper extraction is behavior-preserving; `cloneInitialValue`
  re-export chain (`registration.ts` → `aggregate.ts` re-export →
  `hash-aggregate.ts`) resolves and type-checks. No callers broken.

**Tests — coverage is thorough (starting point held up):** happy paths for all
aggregate families, empty groups, NULL outer/inner keys, duplicate keys,
composite/residual predicates, wrapped and expression-embedded subqueries,
multiple subqueries per SELECT, remapped and rejected outer-ref-in-arg, DISTINCT,
plus every bail shape (LIMIT-1, multi-row error, non-equi, uncorrelated, NOCASE
remap, GROUP-BY build error, DML). Plan-shape spec asserts dissolution + grouped
Hash/Stream aggregate under a Hash/Merge join and retention for each bail shape.
Helper unit tests cover the extracted analysis functions. No gaps requiring
additional tests were found.

**Lint + tests:** `yarn workspace @quereus/quereus run lint` clean;
`yarn workspace @quereus/quereus run test` green — 7011 passing / 0 failing / 13
pending. Pre-existing correlated tests (`07.6-subqueries.sqllogic`) and
`parallel-fanout.spec.ts` unchanged and green with the rule active.

**Docs:** `docs/optimizer-rules.md` carries a detailed, accurate
`ruleScalarAggDecorrelation` entry next to `ruleSubqueryDecorrelation`. Confirmed
it reflects the shipped behavior (including the CASE-marker soundness argument
and the fanout-ordering note). No other doc surface references this rule.

**Tripwires (recorded, not filed):**

- *Aggregate within-group ordering* (group_concat / json_group_array): checked
  whether decorrelation can reorder unordered aggregate inputs. It does not — the
  hash aggregate accumulates per-group in input (table-scan) order, the same
  relative order the correlated per-row subquery sees, so the concatenation
  string is unchanged. Explicit `order by` inside an aggregate is parser-rejected
  and Sort wrappers bail, so no ordering can be silently dropped. Already
  discussed in the rule header; no code site needs a new NOTE.
- *Fanout/remote-latency interaction*: `fanout-lookup-join` (earlier in manifest
  order) still claims these subqueries first on remote plans; when it declines,
  this rule now fires on remote shapes too. `parallel-fanout.spec.ts` is green.
  A reviewer with remote-vtab context should confirm no external fixture asserts
  "stays correlated" for a shape this rule now claims — parked, not blocking.
- *No cost gate*: tiny-outer/huge-inner regressions are possible by design and
  tracked in `backlog/feat-decorrelation-cost-model`.

**Style note (checked, not actioned):** `decorrelateOne` is ~210 lines — long,
but a linear gate-sequence-then-construct with purposeful comments; splitting it
risks regressions for marginal gain, so left as-is.

## Minor findings fixed inline

None — nothing warranted an inline fix.

## End
