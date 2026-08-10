description: SQL `AND` / `OR` now skip an expensive right-hand subquery when the left side already decides the answer, instead of running it on every row for nothing.
files: packages/quereus/src/runtime/emit/binary.ts, packages/quereus/test/and-or-short-circuit.spec.ts, packages/quereus/test/logic/07.7-and-or-short-circuit.sqllogic

## What was built

`emitLogicalOp` (`runtime/emit/binary.ts`) short-circuits `AND`/`OR` when the
**right** operand contains a subquery. Instead of emitting both operands as eager
scheduler params, the right operand is emitted as an on-demand callback
(`emitCallFromPlan`) and invoked from a `run` only when the left operand does not
already decide the result:

- `AND`: skip the right when left is `false` → result `false`.
- `OR`:  skip the right when left is `true`  → result `true`.
- Left `NULL` (or the non-deciding boolean) still requires the right, exactly as
  before.

Three emit branches:

| case | path |
|------|------|
| `XOR` (any operands) | eager two-param `run` |
| `AND`/`OR`, right has **no** subquery | eager two-param `run` |
| `AND`/`OR`, right **has** a subquery | `params: [left, emitCallFromPlan(right)]`, `runShortCircuit` |

The deferred instruction carries a distinct note `AND(logical short-circuit)` /
`OR(logical short-circuit)` (vs `AND(logical)` for the eager path) so EXPLAIN /
`getDebugProgram()` shows which path was taken.

**Gate `containsSubquery(node)`:** a cheap emit-time recursive walk over
`getChildren()` that returns true if any descendant is relational
(`isRelationalNode`). Scalar/IN/EXISTS subqueries expose their relational child via
`getChildren()`, so this catches them all — including a tableless subquery like
`(select sidefx())`, whose self-cost is tiny (the concrete reason the gate is
subquery-containment, not a cost threshold). Runs once per prepare, not per row.

**3VL correctness:** the deferred and eager paths now share one combine function
(`combineLogical`) — the only difference is the right operand is fetched lazily.

## Review findings

Ran full quereus suite (**6947 passing, 0 failing, 13 pending**), lint (eslint +
test-file typecheck, exit 0), and the targeted spec (**12 passing**) — all green
before and after the changes below. Reviewed the implement-stage diff first, then
the tests, then cross-checked against `docs/runtime.md` emitter conventions.

**Fixed inline (minor):**

- **Per-row microtask hop on the short-circuit fast path.** `runShortCircuit` was
  declared `async`, so it returned a `Promise` on *every* row — including the
  left-decides fast path (right callback never runs, all params resolve
  synchronously), which is exactly the hot path this feature exists to optimize.
  `docs/runtime.md` § "Avoid a per-row microtask hop on the synchronous fast path"
  documents the required pattern: branch on `instanceof Promise` instead of an
  unconditional `await`. Rewrote `runShortCircuit` to return
  `MaybePromise<SqlValue>` and stay synchronous unless the right sub-program
  genuinely returns a `Promise`. `binary.ts`.
- **Duplicated 3VL combine (DRY).** The eager `run` and `runShortCircuit` each
  hand-rolled the same three-valued AND/OR combine — the precise divergence the
  parity tests exist to catch. Extracted a single `combineLogical(v1, v2)` helper
  used by both paths. `binary.ts`.

**Filed as a new ticket (major, orthogonal, pre-existing):**

- **`backlog/feat-where-conjunct-cost-ordering`.** A top-level `AND` in a `WHERE`
  clause is decomposed by the optimizer into *separate* `filter` nodes, so this
  binary-op short-circuit never sees it; whether a cheap conjunct filters before an
  expensive-subquery conjunct is then governed by optimizer filter ordering, which
  has no cost-based ordering today. In one inspected plan the subquery filter ran
  for every row even though a cheap sibling conjunct (`k = 2`) could have eliminated
  most rows first. This is the most likely place a user's "`where cheap and (select
  expensive)` is slow" expectation still goes unmet. Pre-existing, in a different
  subsystem (predicate/filter planning, not emit) — captured as a backlog feature
  rather than folded into this ticket.

**Checked, deemed intended (no action):**

- **Error-suppression asymmetry.** `false and (select 1/0)` now skips the division
  error (right never runs), whereas `false and (1/0)` (pure-scalar, eager) still
  raises it. This is the intended semantics of short-circuit deferral — SQL does not
  guarantee right-operand evaluation — and is pinned by the "throwing RHS is never
  reached" test. The asymmetry (subquery-wrapped vs bare scalar) is inherent to the
  subquery-containment gate, documented at the gate site.

**Tripwires (parked in code, not tickets):**

- **Non-subquery expensive scalar operands stay eager** — `NOTE:` comment at the
  gate in `binary.ts` (extend the gate with a cost/volatility check if such an
  operand ever shows up hot).
- **Decorrelation interaction** — if the optimizer rewrites a subquery RHS into a
  join, the operand no longer contains a `ScalarSubquery` at emit and falls back to
  the eager path. Correctness is unaffected (parity holds); deferral simply does not
  apply. Not observed in tests; recorded here for a future reader expecting deferral
  on a decorrelatable shape.

**Test coverage** (unchanged from implement, verified adequate — happy path, all
nine 3VL input pairs across both emit paths, non-evaluation via counting/throwing
UDFs, correlated + nested composition, and the emit-gate note assertions):
`test/and-or-short-circuit.spec.ts` (12 tests) and
`test/logic/07.7-and-or-short-circuit.sqllogic` (end-to-end truth tables + WHERE-OR
+ nested short-circuit).

**Docs:** no `docs/` change — `runtime.md` has no logical-operator-emission section
to update, AGENTS.md forbids adding summary docs, and the behavior is documented
in-code at the emit site (gate rationale, tripwires, 3VL-parity comment, and the
microtask-hop rationale that now cites the existing `runtime.md` guidance).
