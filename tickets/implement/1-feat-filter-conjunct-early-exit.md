description: A WHERE clause that combines several tests with AND now stops as soon as one test rejects the row, instead of always running every test.
files: packages/quereus/src/runtime/emit/filter.ts, packages/quereus/src/planner/analysis/predicate-conjuncts.ts, packages/quereus/src/runtime/emit/binary.ts, packages/quereus/test/and-or-short-circuit.spec.ts, docs/runtime.md
difficulty: medium

## Background

`emitFilter` (`src/runtime/emit/filter.ts`) compiles a `FilterNode`'s whole
predicate into a **single** callback and evaluates it once per row. When the
predicate is a conjunction (`a and b and c`), the `AND` nodes inside it are
compiled by `emitLogicalOp` (`src/runtime/emit/binary.ts`), which only avoids
evaluating its right operand in one narrow case: the right operand contains a
subquery (a relational descendant). Every other right operand — including a
volatile user-defined function called directly, or heavy arithmetic — is emitted
as an eager scheduler parameter and therefore evaluated for **every** row, even
when the left operand already rejected the row.

Measured on `main` (12-row table, `sidefx()` is a counting scalar UDF, 3 rows
satisfy `v % 5 = 2`):

| query | `sidefx()` calls today | should be |
|---|---|---|
| `where v % 5 = 2 and sidefx() = 1` | **12** | 3 |
| `where v % 5 = 2 and (select sidefx()) = 1` | 3 | 3 |

The only difference is the subquery wrapper. The user wrote the conjuncts in the
right order and still paid for every row.

## What to build

Make the `Filter` emitter conjunct-aware: split the predicate into its top-level
`AND` conjuncts at emit time, compile each as its own on-demand callback, and
evaluate them **in plan order, stopping at the first conjunct that does not
yield true**.

This is exactly correct for a filter and needs no three-valued-logic reasoning at
the conjunct boundary: `FilterNode` keeps a row only when the predicate is
*true*, and under SQL `AND` a conjunct that evaluates to `false` **or** `NULL`
makes the whole conjunction `false` or `NULL` — either way the row is rejected.
So "reject on the first non-truthy conjunct" produces the identical row set as
"evaluate the whole AND tree, then apply `isTruthy`". The existing per-conjunct
truthiness test (`isTruthy(asPredicateScalar(result))`) is reused unchanged, so
blob / string / numeric truthiness stays byte-identical.

Sketch:

```ts
export function emitFilter(plan: FilterNode, ctx: EmissionContext): Instruction {
  const sourceInstruction = emitPlanNode(plan.source, ctx);
  const conjuncts = splitConjunctsOrdered(plan.predicate);   // source order
  const conjunctCalls = conjuncts.map(c => emitCallFromPlan(c, ctx));
  // run(rctx, source, ...predicates: SubProgram[]) — rest tuple, per asRun's
  // documented requirement for a variable-arity emitter.
}
```

Per row: for each conjunct callback in order, invoke it, resolve with
`resolveMaybe` (stay synchronous when the sub-program is synchronous — see
`docs/runtime.md` § "Avoid a per-row microtask hop on the synchronous fast
path"), test truthiness, and `continue` to the next source row on the first
falsy/NULL result. Yield the row only after all conjuncts pass.

**Single-conjunct predicates must stay exactly as they are today** — one
callback, one truthiness test, no extra loop bookkeeping. That is the
overwhelmingly common shape and must not regress.

### Source-order conjunct split

`splitConjuncts` in `src/planner/analysis/predicate-conjuncts.ts` uses a
push-left-then-right stack walk and therefore returns conjuncts in **reverse**
source order (verified: `where (select sidefx()) = 1 and v % 5 = 2` splits to
`[v % 5 = 2, (select sidefx()) = 1]`). Its ten-odd existing callers treat the
result as an unordered set, so its behaviour must not change.

Add a sibling `splitConjunctsOrdered(pred)` that returns conjuncts in
left-to-right source order (in-order walk, iterative so a pathological AND-chain
cannot overflow the stack), and add a `NOTE:` on `splitConjuncts` recording that
it is order-scrambling and that order-sensitive callers must use the ordered
variant. Ticket 2 (`feat-where-conjunct-cost-ordering`) also depends on this
helper.

### Emitter note

Keep `note: filter(<predicate>)` for a single conjunct. For N > 1 conjuncts use a
distinguishable note — e.g. `filter(<predicate>) [N conjuncts, early exit]` —
mirroring the `AND(logical short-circuit)` precedent in `binary.ts`, so
`getDebugProgram()` / EXPLAIN shows which path a filter took and tests can assert
on it.

### Interaction with the existing AND deferral

Once the Filter splits at the top level, `emitLogicalOp` is no longer invoked for
those top-level `AND` nodes — the early-exit loop subsumes them. Nested `AND`s
*inside* a conjunct (e.g. under a `NOT`, or inside a `CASE`) still route through
`emitLogicalOp` and keep their current behaviour. Do not remove or weaken the
subquery deferral in `binary.ts`; it still owns `AND`/`OR` in SELECT-list, `ON`,
and `CASE` position.

## Edge cases & interactions

- **Single conjunct / non-AND predicate** — identical instruction shape and note
  to today. Assert this (note assertion) so a later refactor cannot silently add
  per-row overhead to the common case.
- **`NULL` conjunct rejects the row and stops** — `where null and sidefx() = 1`
  must return zero rows and call `sidefx()` zero times.
- **Truthiness parity** — a conjunct returning a blob, a non-numeric string, `0`,
  `''`, or a `bigint` must reject/keep exactly as the pre-change whole-predicate
  path did. `asPredicateScalar` still rejects non-scalar conjunct results with
  the same INTERNAL error.
- **`NOT (a and b)`** — one conjunct, not split; result unchanged.
- **Nested AND under a top-level conjunct** — `where (a and b) or c` is a single
  conjunct (top level is `OR`); no split.
- **Async conjunct** — a conjunct containing a genuinely async subquery must
  still work, and a row rejected by an earlier synchronous conjunct must **not**
  pay a microtask hop.
- **Deep AND chain** — `where c1 and c2 and ... and c50` splits into 50
  callbacks; verify no stack overflow in the split and that the row set matches
  the pre-change engine.
- **Correlated conjunct** — a conjunct referencing the current row's columns must
  see the row slot; the source row is set before any conjunct runs, so ordering
  within the loop is safe. Cover a correlated subquery conjunct explicitly.
- **Aggregate `HAVING`** — `select-aggregates.ts` also builds `FilterNode`s;
  those flow through the same emitter. Confirm `having a and b` still behaves.
- **Error asymmetry** — a conjunct that raises (a throwing UDF) is now skipped
  when an earlier conjunct rejects the row. This matches the accepted semantics
  of the `AND`/`OR` deferral already shipped (`feat-and-or-short-circuit`); pin
  it with a test rather than treating it as a regression. Note that Quereus
  division by zero returns `NULL` rather than raising, so the classic
  `where v <> 0 and 10/v > 1` guard idiom is unaffected either way.
- **Row-set parity is the hard invariant** — every existing logic test must pass
  unchanged. Only evaluation *counts* may change, never results.

## TODO

- Add `splitConjunctsOrdered` to `src/planner/analysis/predicate-conjuncts.ts`
  (iterative in-order walk), plus the `NOTE:` on `splitConjuncts` that it returns
  reverse source order.
- Rewrite `emitFilter` to compile one callback per top-level conjunct and
  evaluate with early exit; preserve the exact single-conjunct shape and the
  synchronous fast path (`resolveMaybe`, no unconditional `await`).
- Give the multi-conjunct path a distinct instruction `note`.
- Tests — new `packages/quereus/test/filter-conjunct-early-exit.spec.ts`:
  - counting UDF: `where v % 5 = 2 and sidefx() = 1` over 12 rows calls
    `sidefx()` **3** times (was 12);
  - the expensive-conjunct-written-first case still calls it 12 times (ordering
    is ticket 2's job — pin the split here, not the ordering);
  - `where null and sidefx() = 1` → 0 rows, 0 calls;
  - throwing UDF in a later conjunct is never reached when an earlier conjunct
    rejects;
  - truthiness parity table across blob / string / `0` / `''` conjunct values;
  - emit-note assertions: single-conjunct note unchanged, multi-conjunct note
    carries the early-exit marker;
  - a correlated-subquery conjunct and a 50-conjunct chain.
- Run `yarn test` from the repo root (stream with `tee`), then
  `yarn workspace @quereus/quereus run lint`.
- Docs: add a short subsection to `docs/runtime.md` (near § "Key Emitter
  Patterns") describing filter conjunct early exit and why first-non-true
  rejection is sound for a filter. Do not add a new doc file.
