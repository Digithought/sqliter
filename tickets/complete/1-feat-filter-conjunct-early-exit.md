description: A WHERE clause that combines several tests with AND now stops as soon as one test rejects the row, instead of always running every test.
files: packages/quereus/src/runtime/emit/filter.ts, packages/quereus/src/planner/analysis/predicate-conjuncts.ts, packages/quereus/src/planner/analysis/query-rewrite-matcher.ts, packages/quereus/test/filter-conjunct-early-exit.spec.ts, packages/quereus/test/and-or-short-circuit.spec.ts, docs/runtime.md, docs/.doc-budget.json

## What shipped

`emitFilter` used to compile a `FilterNode`'s whole predicate into one callback and
evaluate it once per row. A conjunctive predicate (`a and b and c`) is now split into
its top-level `AND` conjuncts at emit time; each becomes its own on-demand
sub-program, and per row they run in source order with the row dropped at the **first**
conjunct that does not yield true.

Measured effect (12-row table, `sidefx()` a counting scalar user-defined function,
3 rows satisfy `v % 5 = 2`):

| query | before | after |
|---|---|---|
| `where v % 5 = 2 and sidefx() = 1` | 12 calls | **3 calls** |
| `where v % 5 = 2 and (select sidefx()) = 1` | 3 calls | 3 calls |

Production surface after review:

- `planner/analysis/predicate-conjuncts.ts` — `splitConjuncts` / `splitDisjuncts`
  now return conjuncts in left-to-right **source order** (the stack walk pushes the
  right child first). One splitter, no flag, no second export.
- `runtime/emit/filter.ts` — one generator with a rest-tuple of conjunct callbacks;
  the per-row loop stops at the first conjunct that is not true. Truthiness is the
  unchanged `isTruthy(asPredicateScalar(...))`, wrapped in `evaluatePredicate`. The
  instruction note gains `[N conjuncts, early exit]` only when N > 1.
- `planner/analysis/query-rewrite-matcher.ts` — its private duplicate of
  `splitConjuncts` was deleted in favour of the shared one.
- `docs/runtime.md` — `### Filter conjunct early exit` under *Key Emitter Patterns*;
  the *Short-circuiting operators reuse this pattern* section now lists `Filter`
  alongside `CASE` and `AND`/`OR`.

`emitLogicalOp` in `emit/binary.ts` is untouched. It no longer sees top-level filter
`AND`s but still owns `AND`/`OR` in SELECT-list, `ON`, and `CASE` position, and
nested `AND`s under `NOT`/`CASE`/`OR` inside a conjunct.

## Why first-non-true rejection is sound

A `FilterNode` keeps a row only when the predicate is *true*. Under SQL `AND` a
conjunct that is `false` **or** `NULL` makes the whole conjunction `false` or `NULL`,
and both are rejected. So "stop at the first non-true conjunct" yields the identical
row set as "evaluate the whole `AND` tree, then apply `isTruthy`". No three-valued
logic is reconstructed at the conjunct boundary.

## Review findings

Reviewed the implement diff first, then the handoff. Checked: correctness of the
split, evaluation order, async/microtask behaviour, resource cleanup (row slot),
duplication, API shape, docs accuracy, test coverage, and emission cost.

**Fixed in this pass (minor):**

- **Two near-identical generators (DRY).** The emitter carried a special-cased
  single-conjunct `run` duplicating ~18 lines of the N-conjunct `runConjuncts`,
  justified as avoiding "loop bookkeeping". The saving is one array iteration against
  a sub-program invocation — not measurable. Collapsed to one generator; the note
  suffix is the only thing that still branches, so the emit-shape tests are unchanged.
- **Two splitters differing only in order (footgun).** `splitConjuncts` returned
  scrambled order and `splitConjunctsOrdered` source order, with a `NOTE:` telling
  callers to pick correctly. Picking wrong is silently wrong. Unified: `splitOn` now
  always yields source order, `splitConjunctsOrdered` is gone, `splitDisjuncts`
  benefits too. Source order is also the strictly better default —
  `combineConjuncts(splitConjuncts(p))` previously rebuilt the predicate reversed.
  Full suite, both strict harnesses, and `yarn test` across every workspace pass with
  no plan or golden churn.
- **Private duplicate of the shared splitter.** `query-rewrite-matcher.ts` had its own
  recursive `splitConjuncts` (pre-existing, but in the same module family and now
  provably redundant since the shared one is source-ordered). Deleted; both call sites
  use the shared helper.
- **Stale comment in a neighbouring spec.** `and-or-short-circuit.spec.ts` said a
  top-level `AND` in `WHERE` is "governed by filter ordering, not this ticket" and
  pointed at a review handoff. Rewritten to point at the emitter split and its spec.
- **Doc reference drift.** `docs/runtime.md` named `splitConjunctsOrdered` and
  described the now-removed single-conjunct special case. Updated, and the ratchet in
  `docs/.doc-budget.json` lowered 13189 → 13181 to match the shorter text.
- **In-flight ticket reference.** `tickets/implement/2-feat-where-conjunct-cost-ordering.md`
  told its implementer to call `splitConjunctsOrdered`; corrected to `splitConjuncts`
  with the source-order guarantee stated.

**Tests added (the handoff's own list of what it did not reach):**

- `an asynchronous conjunct interleaves with synchronous ones` — a genuinely pending
  promise-returning function between two synchronous conjuncts: right rows, and the
  early exit still holds (3 calls, not 12).
- `returns conjuncts in left-to-right source order` and
  `round-trips through combineConjuncts without permuting the predicate` — the order
  contract asserted directly on the splitter, so a regression names its cause instead
  of surfacing as an evaluation count. This is also the baseline ticket 2's
  cost-ordering rule will compare against.
- `a repeated conjunct keeps the same rows` — `where p and p`, in case a shared plan
  node ever aliased one sub-program across two params.

Suite for this feature: 36 tests (32 from implement + 4 added), all passing.

**Filed as a separate ticket (major, out of scope):**

- `tickets/backlog/bug-async-scalar-udf-typing.md` — `Database.createScalarFunction`
  types its callback as synchronous while the engine's `ScalarFunc` accepts a promise
  and runs it correctly. Found while writing the async-conjunct test, which had to
  register through the internal factory to compile.

**Confirmed, not re-filed:**

- The pre-existing wrong-results bug the implementer found
  (`tickets/fix/bug-filter-conjunct-lost-under-index-order`) reproduces at HEAD and is
  planner-side: with `order by id` the emitted program contains only the sub-select's
  filter instruction and `filter(flag = 0)` is absent entirely. Both filters in that
  plan are single-conjunct, so the emit split cannot be the cause. Ticket left as
  filed; the `order by` stays removed from the affected test with its `NOTE:` intact.

**Tripwire (parked in code, not a ticket):** `runtime/emit/filter.ts` carries a `NOTE:`
at the split site — N cheap conjuncts that all pass now cost N callback invocations
per row instead of one. Measured on a purpose-built micro-benchmark (3 all-true
conjuncts, 20k memory rows, count(*)): ~125–150 ms split vs ~120–130 ms unsplit,
roughly 5–10%, and that is the worst direction — any conjunct that rejects repays it
immediately. The note says what to do (fuse cheap side-effect-free conjuncts back into
one sub-program) if wide all-passing filters ever show up as hot.

**Checked and clean, no finding:**

- Resource cleanup — the row slot is opened once per invocation and closed in
  `finally`, unchanged by the split; both strict harnesses agree.
- Async behaviour — `evaluatePredicate` returns `MaybePromise` and the loop awaits
  only a genuine `Promise`, so an all-synchronous filter still costs no microtask hop
  per row. A first draft of the DRY fix extracted the loop into an `async` helper,
  which would have forced a hop per row; reverted to the inline loop.
- Error handling — a conjunct that raises still propagates when reached; being skipped
  after an earlier conjunct rejects matches the shipped `AND`/`OR` deferral semantics
  and is pinned by a test.
- Type safety — no `any`, no casts beyond the existing `asRun` (which is how every
  variadic emitter is typed).
- Source hygiene — `filter.ts` is 88 lines with three short functions;
  `predicate-conjuncts.ts` shrank from 5 exported/helper functions to 4.
- Parallel/fork paths (`ParallelDriver`, `EagerPrefetchNode`, `FanOutLookupJoinNode`) —
  no targeted test was added. The row slot is set once before the conjunct loop exactly
  as before, so no shadowing behaviour changed, and `QUEREUS_FORK_STRICT` /
  `QUEREUS_CONTEXT_STRICT` full-suite runs (which the implementer had not run) are both
  green.

## Validation performed

- `yarn workspace @quereus/quereus run test` — 7650 passing, 13 pending, 0 failing.
- `yarn workspace @quereus/quereus run test:context-strict` — 7652 passing, 0 failing.
- `yarn workspace @quereus/quereus run test:fork-strict` — 7640 passing, 0 failing.
- `yarn test` (repo root, every workspace) — green.
- `yarn workspace @quereus/quereus run lint` — clean (eslint + test-file type pass).
- `yarn workspace @quereus/quereus run typecheck` — clean.
- `yarn docs:check` — clean.
- `yarn test:store` (LevelDB-backed rerun) was **not** run: its wall clock does not fit
  the agent budget, and this change is emit-side and storage-agnostic. Untested against
  that path.
