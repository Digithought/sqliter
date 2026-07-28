description: A WHERE clause that combines several tests with AND now stops as soon as one test rejects the row, instead of always running every test.
files: packages/quereus/src/runtime/emit/filter.ts, packages/quereus/src/planner/analysis/predicate-conjuncts.ts, packages/quereus/test/filter-conjunct-early-exit.spec.ts, docs/runtime.md, docs/.doc-budget.json
difficulty: medium

## What changed

`emitFilter` used to compile a `FilterNode`'s whole predicate into one callback and
evaluate it once per row. A conjunctive predicate (`a and b and c`) is now split into
its top-level `AND` conjuncts at emit time; each becomes its own on-demand
sub-program, and per row they run in source order with the row dropped at the **first**
conjunct that does not yield true.

Measured effect (12-row table, `sidefx()` a counting scalar UDF, 3 rows satisfy
`v % 5 = 2`):

| query | before | after |
|---|---|---|
| `where v % 5 = 2 and sidefx() = 1` | 12 calls | **3 calls** |
| `where v % 5 = 2 and (select sidefx()) = 1` | 3 calls | 3 calls |

Three files of production change:

- `planner/analysis/predicate-conjuncts.ts` — new `splitConjunctsOrdered(pred)`
  returning conjuncts in left-to-right source order. The existing `splitOn` walker
  gained a defaulted `ordered` flag (pushes right-then-left so left pops first);
  `splitConjuncts` passes nothing, so its ~14 existing callers are bit-for-bit
  unchanged. A `NOTE:` on `splitConjuncts` records that it returns scrambled order and
  that order-sensitive callers must use the ordered variant.
- `runtime/emit/filter.ts` — `emitFilter` splits, and branches: one conjunct keeps the
  pre-split instruction shape verbatim (same params, same note, no loop); N > 1 emits
  `params: [source, ...conjunctCallbacks]` with a rest-tuple `run` and the note
  `filter(<predicate>) [N conjuncts, early exit]`. Truthiness reuses the unchanged
  `isTruthy(asPredicateScalar(...))`, factored into a shared `evaluatePredicate` helper
  that both branches call.
- `docs/runtime.md` — new `### Filter conjunct early exit` under *Key Emitter
  Patterns*, and the *Short-circuiting operators reuse this pattern* section now lists
  `Filter` alongside `CASE` and `AND`/`OR`.

`emitLogicalOp` in `emit/binary.ts` is untouched. It no longer sees top-level filter
`AND`s (the split subsumes them) but still owns `AND`/`OR` in SELECT-list, `ON`, and
`CASE` position, and nested `AND`s under `NOT`/`CASE`/`OR` inside a conjunct.

## Why first-non-true rejection is sound

A `FilterNode` keeps a row only when the predicate is *true*. Under SQL `AND` a
conjunct that is `false` **or** `NULL` makes the whole conjunction `false` or `NULL`,
and both are rejected. So "stop at the first non-true conjunct" yields the identical
row set as "evaluate the whole `AND` tree, then apply `isTruthy`". No three-valued
logic is reconstructed at the conjunct boundary.

## Validation performed

- `yarn test` (repo root): **7646 passing** in `packages/quereus`, 0 failing; all other
  workspaces green. No pre-existing failures surfaced.
- `yarn workspace @quereus/quereus run lint` — clean (eslint + `tsconfig.test.json`
  type pass over specs).
- `yarn workspace @quereus/quereus run typecheck` — clean.
- `yarn docs:check` — clean (see the ratchet note under *Known gaps*).
- New spec `packages/quereus/test/filter-conjunct-early-exit.spec.ts`, 32 tests.

## What to exercise in review

The new spec is the floor, not the ceiling. It covers:

- **Evaluation counts** — `where v % 5 = 2 and sidefx() = 1` calls `sidefx()` 3 times
  over 12 rows (3, not 12 = eager-every-row, not 1 = hoist-once). The bare-call and
  subquery-wrapped spellings now cost the same.
- **Ordering is deliberately not changed** — `where sidefx() = 1 and v % 5 = 2` still
  calls 12 times. That assertion is a tripwire for ticket
  `2-feat-where-conjunct-cost-ordering`, which will legitimately flip it.
- **`where null and sidefx() = 1`** — 0 rows, 0 calls.
- **Throwing UDF** in a later conjunct is never reached; a throwing UDF in the *first*
  conjunct still propagates.
- **Truthiness parity table** — 17 conjunct values (0, 1, -1, 0.0, 1.5, `0n`, `7n`,
  `''`, `'abc'`, `'0'`, `'2'`, whitespace, blob, empty blob, `null`, `true`, `false`)
  each asserted to keep the same rows in three positions: single-conjunct (unsplit
  baseline), first of two, second of two.
- **50-conjunct chain** — correct rows, note says `[50 conjuncts`, no stack overflow.
- **`HAVING a and b`** over a `group by` — unchanged results.
- **Correlated subquery conjunct** resolves against the current row.
- **Emit-shape assertions** — single conjunct keeps `filter(v % 5 = 2)` with no
  early-exit marker; two/three conjuncts carry `[N conjuncts, early exit]`;
  `not (a and b)` and `(a and b) or c` do **not** split.

Worth an adversarial look that the spec does not reach:

- A conjunct that returns a genuinely pending promise interleaved with synchronous
  conjuncts — correctness is covered via correlated subqueries, but the *absence* of a
  microtask hop on a synchronously-rejected row is asserted only by code inspection
  (`resolveMaybe` + `instanceof Promise`), not by a test.
- Filters under parallel/fork paths (`ParallelDriver`, `EagerPrefetchNode`,
  `FanOutLookupJoinNode`). The full suite passes but no test targets a split filter in
  a forked runtime context specifically.
- `QUEREUS_CONTEXT_STRICT` / `QUEREUS_FORK_STRICT` runs were not executed (they are
  part of `yarn check`, not `yarn test`). The row slot is set once before the conjunct
  loop, exactly as before, so no shadowing behaviour changed — but the strict harnesses
  would confirm it.
- `yarn test:store` (LevelDB-backed rerun) was not run; the change is emit-side and
  storage-agnostic, but it is untested against that path.
- Emission cost: N conjuncts now build N `Scheduler` sub-programs instead of one. For a
  wide `AND` chain that is more emit-time allocation. Not measured; single-conjunct
  (the common shape) is unaffected.

## Known gaps and things noticed

- **Doc size ratchet raised.** `docs/runtime.md` grew 93 words net (13096 → 13189) and
  `docs/.doc-budget.json` was updated with
  `node scripts/check-docs.mjs --update-ratchet --force`. The addition was already
  offset inside the same doc: the *Creating an Emitter* sample now uses the existing
  `buildRowDescriptor` helper instead of hand-rolling two descriptor loops (which also
  makes it match how real emitters are written), and the short-circuit section was
  tightened. Push back if the remaining 93 words should have been paid for by trimming
  something else instead.
- **A separate, pre-existing wrong-results bug was found and filed.** While writing the
  correlated-conjunct test, `select id from o where flag = 0 and (select …) > 0 order
  by id` turned out to return **every** row — the `flag = 0` condition is dropped by the
  planner. It reproduces on plain built-ins with no user-defined function, is unrelated
  to this change (it also occurs on the untouched single-conjunct emit path, and
  disabling `grow-retrieve-Filter`, `grow-retrieve-Sort`, or `predicate-pushdown` each
  cures it), and is filed as `tickets/fix/bug-filter-conjunct-lost-under-index-order.md`.
  The affected test in this ticket's spec drops its `order by id` and carries a `NOTE:`
  pointing at that slug; restore the `order by` when the bug ticket lands.
- **Error asymmetry is intentional.** A conjunct that raises is now skipped when an
  earlier conjunct rejects the row. This matches the shipped `AND`/`OR` deferral
  semantics and is pinned by a test rather than treated as a regression.
- **Tripwire (parked in code, not a ticket):** none were needed — the one conditional
  concern (emit-time cost of N sub-programs for a very wide `AND` chain) is recorded
  above under *Worth an adversarial look* rather than at a code site, because it has no
  single line to attach to and is bounded by the 50-conjunct test.
