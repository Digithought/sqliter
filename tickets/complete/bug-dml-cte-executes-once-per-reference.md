---
description: A query can name a block that inserts, updates or deletes rows and hands them back; naming that block more than once used to run the write once per mention instead of once. Fixed, reviewed, and covered by row-set, base-table-state and plan-shape tests.
files:
  - packages/quereus/src/planner/building/with.ts                     # buildCommonTableExpr forces materialize for DML bodies; isDataModifyingCte predicate
  - packages/quereus/src/planner/nodes/cte-node.ts                    # CTENode — tableDescriptor threaded through rebuilds, toString gained [buffered]
  - packages/quereus/src/planner/framework/characteristics.ts         # CTECapable gained tableDescriptor and materialize
  - packages/quereus/src/planner/rules/cache/rule-cte-optimization.ts # carries descriptor + materialize through the cache rewrite
  - packages/quereus/src/planner/cache/materialization-advisory.ts    # carries the descriptor through the mark rewrite
  - packages/quereus/src/runtime/emit/cte.ts                          # buffer keyed on tableDescriptor, not plan.id
  - packages/quereus/src/runtime/emit/recursive-cte.ts                # comment + map generic aligned
  - packages/quereus/src/runtime/types.ts                             # cteMaterializations key type narrowed to TableDescriptor
  - packages/quereus/test/logic/13.6-cte-dml-runs-once.sqllogic       # row-set + base-table-state coverage
  - packages/quereus/test/plan/cte-dml-plan-shape.spec.ts             # plan-level invariants
  - packages/quereus/test/runtime/cte-dml-once.spec.ts                # NEW in review — buffer resets between executions
  - docs/optimizer.md                                                 # § Materialization Advisory
  - docs/runtime-caching.md                                           # § Shared CTE materialization
repro: verified
---

# A data-modifying `with` block runs once per statement

## What shipped

`with c as (insert into t … returning …) select …` now runs its write exactly once per
statement execution, however many times the rest of the query names `c`. Previously it ran
once per mention: `UNIQUE constraint failed` for `insert`, a silent double-increment for
`update`, and a second mention of a `delete` seeing an empty result.

Two independent causes, both fixed in the implement stage:

**A — the reference count undercounts.** Two mentions using the same alias share one
`CTEReferenceNode`, so the `CTENode` shows a single parent and the materialization-advisory
gate reads "referenced once" while that single reference node is still emitted and driven
twice. `buildCommonTableExpr` now constructs a CTE with a data-modifying body with
`materialize = true` outright and never consults that gate. An explicit `not materialized`
hint is deliberately overridden — honoring it would license a second write. Read-only bodies
keep flowing through the normal reference-count gate.

**B — the buffer key was not stable across plan rewrites.** `emitCTE` keyed its per-execution
buffer on `plan.id`, which only holds while every mention points at one `CTENode` object. The
constant-folding pass has no memo, so a node reachable from two parents is rebuilt once per
parent path — a `values`-bodied DML CTE really does end up as two `CTENode` instances. The
`tableDescriptor` is now threaded through every rebuild site and `emitCTE` keys the buffer on
it, mirroring `RecursiveCTENode` / `emitRecursiveCTE`.

## Review findings

### Behaviour probed beyond the implementer's tests

Every gap the implement handoff flagged as untested was exercised against a fresh in-memory
database. All behaved correctly and the load-bearing ones are now pinned as tests:

| probe | result | now pinned |
| --- | --- | --- |
| two DML CTEs in one `with` clause, each referenced twice | each keeps its own buffer; both write once | 13.6 sqllogic |
| `… select k from c limit 0` | write still happens (detached drive completes) | 13.6 sqllogic |
| `rollback` around a statement with a doubly-referenced DML CTE | write undone | 13.6 sqllogic |
| `rollback to savepoint` | write undone | probed only |
| prepared statement re-executed 3× | write runs on every execution; no stale buffer | `test/runtime/cte-dml-once.spec.ts` |
| DML CTE body raising a duplicate key | error surfaces, not swallowed | probed only |
| DML CTE writing a table the outer query also reads | outer read sees the write (read-your-own-writes) | probed only |
| `insert into t2 select … from c c1 join c c2` (DML CTE feeding an outer DML) | one write each | probed only |
| a `select`-bodied CTE wrapping a DML CTE, referenced twice | inner write runs once | probed only |

The prepared-statement case was the one worth a permanent guard: the buffer key
(`tableDescriptor`) is plan-level and outlives a run, so only the fresh `RuntimeContext` per
execution stops run 2 replaying run 1's rows. A regression there would be silent — identical
plausible rows, no write. sqllogic cannot re-run one prepared statement, hence a spec.

### Fixed inline

- **`CTECapable` could silently drop `materialize`.** `ruleCteOptimization` rebuilt the CTE
  with `node instanceof CTENode ? node.materialize : false` — a `false` default that, for any
  future `CTECapable` implementer, means re-executing the body, i.e. a second write. Added
  `readonly materialize: boolean` to the capability (alongside the `tableDescriptor` the
  implement stage added) and read it off the capability, dropping the `instanceof`.
- **Stale doc comment.** `CTENode.materialize` still said "set by the materialization-advisory
  pass"; it is now also set at build time. Corrected.
- **Comment bloat / DRY.** The 19-line rationale block in `buildCommonTableExpr` restated,
  near-verbatim, what `materialization-advisory.ts`, `docs/optimizer.md`,
  `docs/runtime-caching.md` and the sqllogic header all also say. Trimmed to the decision plus
  the tripwire, pointing at the doc for the rationale, and the body-kind test extracted to an
  `isDataModifyingCte` predicate beside the existing `isRecursiveCte`.
- **Docs.** `docs/runtime-caching.md` § Shared CTE materialization gained the `LIMIT 0` and
  rollback semantics and a consolidated three-item known-gaps list.

### Filed as a ticket

- `backlog/bug-dml-cte-body-cannot-see-sibling-cte` — a data-modifying CTE body cannot
  reference a sibling CTE (`with a as (select …), b as (insert … from a …) …` →
  `Table 'a' not found`). Verified for all three writing forms. Root cause is one site:
  `buildCommonTableExpr` passes `existingCTEs` to `buildSelectStmt` but the three DML builders
  have no parameter to receive it. Pre-existing — untouched by this diff.

  Filed separately rather than appended to `bug-unreferenced-dml-cte-never-runs`, which also
  lists `with.ts` in its `files:`: that ticket's site is `buildWithClause` never attaching an
  unreferenced block to the plan, a different function and a different fix. Cross-referenced in
  both directions in the new ticket's body, along with the related
  `bug-insert-with-clause-not-visible-in-returning`.

### Recorded, not filed

- **A data-modifying CTE nested inside a correlated subquery writes once per statement, not
  once per outer row**, and every outer row sees the first row's `RETURNING` set. Confirmed
  pre-existing: temporarily reverting the force-materialize flag reproduces the identical
  behaviour, so the once-per-execution memo for impure subqueries already collapsed it. Not
  filed because the intended semantics are undecided — PostgreSQL rejects a data-modifying CTE
  anywhere but a statement's top level rather than defining this case. Documented as a bullet
  in `docs/runtime-caching.md` § Shared CTE materialization.
- The implement stage's own tripwire (forced buffering takes a DML CTE off the streaming path,
  so its whole `RETURNING` set is held in memory even when referenced once) is retained as the
  `NOTE:` in `planner/building/with.ts`.

### Checked and clean — no finding

- **Golden plan files.** `CTENode.toString()` gained ` [buffered]`; no golden file under
  `test/plan/{basic,joins,aggregates}` contains a CTE, so nothing needed regenerating.
  Confirmed independently, matching the implement claim.
- **`instanceof` / capability surface.** Only `CTENode` declares `isCTECapable`, so no other
  node reaches the CTE rewrite paths.
- **Every `new CTENode(` construction site** (4 in `src`, plus test fixtures) — all three
  rebuild sites now thread the descriptor; the builder is the only one that mints a fresh one.
- **Fork contract.** `cteMaterializations` key-type narrowing does not change its
  `shared-cooperative` fork policy; `fork-contract.spec.ts` still passes.
- **Docs reachability.** `docs/runtime.md` § Per-execution caches delegates to
  `docs/runtime-caching.md`, so the `see docs/runtime.md` pointers in `emitCTE` and
  `docs/optimizer.md` resolve. Left as-is (one hop, and the recursive branch uses the same
  pointer).

### Not covered — stated plainly

- **`yarn test:store`** (LevelDB-backed) was not run. The change is confined to the planner and
  the runtime's per-execution buffer, with no storage-layer surface, and the repo guidance
  reserves `test:full` for store-specific diagnosis. If a release sweep wants it, this is the
  ticket to re-check.
- The correlated-subquery case above is documented, not tested.

## Verification

`yarn lint` — clean. `yarn build` — clean. `yarn test` — **0 failing**; 8501 + 370 + 113 + 63 +
17 + 28 + 1291 + 648 + 52 + 31 + 34 + 134 + 22 passing (8499 → 8501 is the two new runtime
specs; the sqllogic additions land inside the existing 13.6 case).

`yarn docs:check` fails on `docs/schema.md`'s word-count ratchet. Untouched by this ticket, last
modified two tickets ago, and already listed in `tickets/.pre-existing-known.md` against the
in-flight `debt-doc-size-ratchet-red-at-head` — not re-reported.
