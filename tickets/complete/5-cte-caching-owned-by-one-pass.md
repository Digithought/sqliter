description: Removed a second, contradictory decision-maker for whether a `with …` query's rows get buffered in memory, so there is now exactly one place that decides.
files:
  - packages/quereus/src/planner/rules/cache/rule-cte-optimization.ts       # deleted
  - packages/quereus/src/planner/optimizer.ts
  - packages/quereus/src/planner/framework/pass.ts
  - packages/quereus/src/planner/framework/characteristics.ts               # review: dead `CTECapable` / `isCTE` removed
  - packages/quereus/src/planner/nodes/cte-node.ts                          # review: dead capability brand + `getCTESource()` removed
  - packages/quereus/src/planner/cache/materialization-advisory.ts          # unchanged — sole owner (Rule 5a)
  - packages/quereus/src/planner/util/row-estimates.ts
  - packages/quereus/src/planner/optimizer-tuning.ts
  - packages/quereus/test/optimizer/side-effect-audit.spec.ts
  - packages/quereus/test/optimizer/characteristics.spec.ts                 # review: CTE capability fixture dropped
  - packages/quereus/test/plan/cte-materialization.spec.ts                  # review: two assertions added
  - packages/quereus/test/fuzz.spec.ts
  - packages/quereus/test/logic/49-reference-graph.sqllogic
  - docs/optimizer.md, docs/optimizer-rules.md, docs/optimizer-parallel.md, docs/optimizer-costing.md, docs/runtime-caching.md, docs/invariants.md, docs/architecture.md
----

# CTE materialization has one owner: MaterializationAdvisory

## What landed

`ruleCteOptimization` (`planner/rules/cache/rule-cte-optimization.ts`) is deleted, with its
import and `PostOptimization` registration in `optimizer.ts`. `MaterializationAdvisory`
(`planner/cache/materialization-advisory.ts`) is now the only code that decides whether a
CTE's rows get buffered; its Rule 5a already refused to wrap a CTE/RecursiveCTE in a
`CacheNode`, deferring to the `materialize` mark it sets in the same pass. No advisory code
changed.

The deleted rule wrapped a CTE's **source** in a `CacheNode`, gated on
`sourceSize > 0 && sourceSize < maxSizeForCaching`. That gate read a row estimate of `0` as
"empty" when it actually means "unknown, table never analyzed", so caching turned on whether
`ANALYZE` had run rather than on anything about the query. It also never consulted the CTE's
reference count, so a real estimate would cache single-reference CTEs (which must inline) and
double-buffer multi-reference ones against the advisory's own `materialize` mark.

Behaviour after removal, by case:

| case | result |
|---|---|
| `MATERIALIZED` hint | `materialize` mark → one buffer via `emitCTE` |
| 2+ references | `materialize` mark → one buffer |
| `NOT MATERIALIZED`, 2+ references | inlined — the opt-out is now actually honored (the deleted rule could still cache it) |
| 1 reference, no hint | inlined |
| data-modifying body | `materialize: true` set at **build** time (`planner/building/with.ts`); unaffected by either pass |

Also removed: `OptimizerTuning.cte.maxSizeForCaching` and `cte.cacheThresholdMultiplier`
(no consumer left). `cte.maxCacheThreshold` stays — still read by `rule-scalar-subquery-cache`.

## Review findings

**Verified before trusting the handoff** — read the implement diff first, then the advisory,
the tuning file, and every doc the change touched (plus `docs/architecture.md`, which it
should have touched and didn't).

**Correctness of the removal — confirmed, and slightly better than claimed.** The handoff
framed removal as "nothing is lost". It is in fact a small behaviour *fix*: a
`NOT MATERIALIZED` multi-reference CTE could previously still be wrapped in a `CacheNode` by
the deleted rule (the hint was only consulted for the `'materialized'` arm), so the user's
opt-out was silently overridden. It is honored now. Recursive CTEs never reached the deleted
rule (`RecursiveCTENode` carries no CTE capability brand), confirmed independently of the
handoff's claim.

**Minor — fixed in this pass:**

- *Dead abstraction left behind.* With the rule gone, `CTECapable`, `CapabilityDetectors.isCTE`,
  the `isCTECapable` brand on `CTENode`, and `CTENode.getCTESource()` had **zero** production
  consumers (grep across `src/`; only `characteristics.spec.ts` asserted the detector). Removed
  all four, plus the now-unused spec fixture. Not exported from the package index, so no
  public surface changed.
- *`new Map([])` for the emptied `NO_SIGNAL_ALLOWLIST`* → `new Map()`
  (`test/optimizer/side-effect-audit.spec.ts`).
- *`docs/architecture.md` still listed `rules/cache/` as "CTE, scalar-subquery, materialization"* —
  the CTE rule is gone and the MV rewrite / CSE rules were never listed. Corrected to match the
  directory.
- *Doubled parenthetical in `docs/optimizer.md`* introduced by the reword ("(e.g. …) (it skips …)")
  — rewritten as one clause.

**Test gaps — closed in this pass.** The implementer's new test covered only the
MATERIALIZED *single*-reference plan shape. Added to `test/plan/cte-materialization.spec.ts`:
the **2-reference** case now also asserts no `CACHE` node (that was the deleted rule's main
double-buffer site, and nothing pinned it), and a row-level test asserts a `MATERIALIZED` CTE
still returns its rows after the wrap disappeared — the previous coverage was plan-shape only.

**Prose comments the handoff asked to be re-read** (`optimizer.ts` ~1206/~1283, `pass.ts` ~144):
checked against the manifest. `rule-nested-loop-right-cache` is indeed registered in
`PassId.PostOptimization` and does inject `CacheNode`s, so it is an accurate stand-in for the
deleted rule in the ordering rationale.

**Considered and not filed:** the `OptimizerTuning.cte` namespace is now a misnomer — its one
surviving knob is read by `rule-scalar-subquery-cache`, not by anything CTE. The implementer
left an explanatory comment at the declaration and kept the name to avoid rippling into two
vtab specs that override it by that name. That is a reasonable call, documented at the site;
no ticket, nothing to add.

**Major findings: none.** No new `fix/`, `plan/`, or `backlog/` tickets. **Tripwires: none new** —
the one conditional concern in this area (the `cte` tuning name) is already documented at its
code site, and the row-estimate "0 means unknown" class it exposed is already owned by the
queued `5.1`–`5.5` implement tickets.

## Validation

- `yarn build` — clean.
- `yarn lint` (all workspaces; `packages/quereus` also type-checks its test files) — clean.
- `yarn workspace @quereus/quereus run test` — **10299 passing, 25 pending, 0 failing**.
