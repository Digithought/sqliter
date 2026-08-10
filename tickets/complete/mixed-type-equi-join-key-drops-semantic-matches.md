---
description: Joining a duration column to a plain text column used to silently return no rows even though the same comparison in a WHERE clause matched. The join now agrees with the comparison operator, and review closed a NULL-matching regression the fix exposed.
files:
  - packages/quereus/src/util/comparison.ts                                # semanticOrderingsAgree
  - packages/quereus/src/planner/rules/join/equi-pair-extractor.ts         # the gate, both extractors
  - packages/quereus/src/planner/nodes/join-node.ts                        # review: docstring naming the ungated fact extractor
  - packages/quereus/src/runtime/emit/join.ts                              # USING comparator + review: NULL guard
  - packages/quereus/src/runtime/emit/bloom-join.ts                        # comment only
  - packages/quereus/src/runtime/emit/merge-join.ts                        # comment only
  - packages/quereus/src/runtime/emit/asof-scan.ts                         # NOTE repointed
  - packages/quereus/test/logic/15.1-semantic-ordering.sqllogic            # mixed-pair section + review: NULL case
  - packages/quereus/test/logic/11.1-join-using.sqllogic                   # review: NULL USING keys
  - packages/quereus/test/planner/equi-pair-semantic-gate.spec.ts          # review: new unit net
  - packages/quereus/test/plan/mixed-semantic-equi-key.spec.ts             # review: new plan-shape net
  - docs/types.md                                                          # § Semantic ordering
  - docs/optimizer-joins.md                                                # review: the two admissibility gates
  - docs/optimizer-fd.md                                                   # review: the two extractors differ
---

# Mixed-type equi-join keys agree with `=`

## What was wrong

Some column types define "same value" as something other than byte-equality of the
stored text (`docs/types.md` § "Semantic ordering"). `TIMESPAN` is the motivating case:
`'PT1H'` and `'PT60M'` are two spellings of one hour, and `=` treats them as equal.
Writing that comparison as a join condition gave a different answer from writing it in a
`where` clause — the join planned to a hash key over the raw stored text and returned no
rows.

## What landed

A physical equi-join key pair (hash / bloom / merge) is admissible only when its two
sides agree on semantic ordering: either neither declares a semantic-ordering logical
type, or both declare the same one. A pair that fails demotes to the join's residual
predicate — or, for `using (…)`, sinks the whole extraction — so the generic nested-loop
join evaluates it with the `=` operator's own semantics.

- `util/comparison.ts` — `semanticOrderingsAgree(a, b)`, deliberately keyed on the
  `semanticOrdering` flag rather than `compare` identity (every builtin type has its own
  `compare`, so an identity check would decline an ordinary `integer` ↔ `real` key).
- `planner/rules/join/equi-pair-extractor.ts` — the gate, applied in both
  `extractEquiPairs` and `extractEquiPairsFromUsing`.
- `runtime/emit/join.ts` — the nested-loop USING comparison routes through
  `makeOperandComparator` (the shared routing rule) instead of `compareSqlValuesFast`;
  gating alone does not fix USING, because a declined USING pair falls to a generic join
  that was equally semantic-ordering-blind.
- `bloom-join.ts` / `merge-join.ts` — comments recording that a mixed pair can no longer
  arrive; `asof-scan.ts` — NOTE repointed at its own backlog ticket.
- `docs/types.md` — the mixed-pair rule, why declining beats canonicalizing (merge join
  needs both inputs sorted in one comparator's order, and no comparator merges "sorted
  by elapsed time" with "sorted by text").

Review added, on top of that: a NULL guard in the nested-loop USING emitter, a unit net
for the gate, a plan-shape net, and three doc corrections. Details below.

## Review findings

Reviewed the implement diff (`da4a1ea0`) first-hand before reading the handoff, then
probed behavior differentially — every mixed-type shape run both as `join … on` and as
`cross join … where`, with the `where` form as the oracle, and the same probes re-run
against the pre-change tree to separate regressions from pre-existing defects.

### Fixed in this pass (minor)

- **A NULL-matching regression the gate exposed.** `evaluateUsingCondition` compared
  through an *ordering* comparator, and ordering ranks NULL/NULL as equal — so a USING
  join reaching the nested-loop emitter matched two NULL keys. Before this ticket a
  mixed `using (d)` pair became a hash join, and the hash path never inserts NULL keys,
  so the bug was unreachable for that shape; the gate demoted those joins to nested loop
  and made it observable. Confirmed against the pre-change tree: `una join unb using (d)`
  over two NULL keys returned no rows before, one spurious row after. Fixed with an
  explicit NULL guard mirroring `emitComparisonOp`'s `v1 === null || v2 === null ⇒ null`,
  and pinned in both `15.1-semantic-ordering.sqllogic` (the mixed / nested-loop path) and
  `11.1-join-using.sqllogic` (the plain / hash path, plus a LEFT JOIN case).

- **Gap 1 — no test pinned the plan shape.** Added
  `test/plan/mixed-semantic-equi-key.spec.ts`, asserting the four rows of the handoff's
  out-of-band table: a mixed pair (ON and USING) reaches no physical join operator, a
  same-type pair (ON and USING) does. This is what catches "right answer, wrong reason"
  and silent over-declining.

- **Gap 2 — `semanticOrderingsAgree` had no direct test.** Added
  `test/planner/equi-pair-semantic-gate.spec.ts`: the predicate across same-type,
  mixed, two-different-semantic-types, `undefined`, DATE/DATETIME-vs-TEXT and
  missing-`compare` branches, plus `extractEquiPairsFromUsing`'s multi-column,
  collation-mismatch and name-casing paths (the extractor's parameter type was widened
  "so tests can pass a literal" but no test did).

- **Docs were behind the code.** `docs/optimizer-joins.md` described only the
  matched-collation gate — added a "two admissibility gates" paragraph under § Physical
  Join Algorithm Selection. `docs/optimizer-fd.md` § Collation gate on equality facts
  claimed the two extractors differ only on collation — corrected, with the open defect
  named. `docs/types.md` gained the USING NULL rule and the fact-extraction gap.

### Filed as a new ticket (major)

- **`tickets/fix/equality-fact-extraction-ignores-semantic-ordering`.** The handoff's
  gap 5 asked a reviewer to try to construct a query where a fact minted by
  `extractEquiPairsFromCondition` substitutes one spelling for another. Found one:

  ```sql
  -- 1 row
  select pa.id, pb.id from pa cross join pb where pa.d = pb.s and pa.d = 'PT1H';
  -- 0 rows — same predicate, different spelling
  select pa.id, pb.id from pa join pb on pa.d = pb.s where pa.d = 'PT1H';
  ```

  `rule-predicate-inference-equivalence` reads the equivalence class the ungated fact
  extractor minted, infers `pb.s = 'PT1H'`, and compares that as text against a column
  holding `'PT60M'`. Pre-existing — the same query is wrong on the pre-change tree — so
  it is not a regression, but it is the same defect family and the handoff's "no
  observable over-claim" conclusion does not hold. Note the asymmetry that made it easy
  to miss: pinning the *plain text* side is fine; pinning the *duration* side loses rows.
  A `NOTE`-style pointer now sits in `extractEquiPairsFromCondition`'s docstring.

### Checked, nothing found

- **Gap 3 — the widened USING comparator swap.** Not a risk: `tryTemporalCompare`
  returns `undefined` unless *both* runtime values are ISO-8601 duration strings, so the
  "new temporal branch" for `date`/`time`/`datetime` USING columns never fires on those
  types' values. Probed `date` and `datetime` against `text` with canonical and
  non-canonical spellings; `using`, `on` and `where` agreed in every case.
- **A gate that keys on `semanticOrdering` while the comparator keys on `isTemporal`**
  looked like a hole (a pair the gate admits could still route to the temporal path).
  Probed `text` ↔ `blob`, `text` ↔ `integer` and an untyped column against `text`, all
  holding duration-shaped strings: `on` and `where` agreed on every one, for the same
  `tryTemporalCompare` reason.
- **Other fact consumers.** Probed join elimination (including across a real FK spanning
  a `timespan` parent key and a `text` child column), FD/key-coverage shapes over unique
  mixed pairs, `group by` on either side of the pair, `order by` one side while
  projecting the other, a three-way transitive join, `union all` + `distinct`, `in
  (subquery)`, and `exists` / `not exists`. Every one agreed with its `cross join …
  where` oracle. The new fix ticket lists these as "also worth checking" since the
  probing was not exhaustive.
- **Right / full join drivers** over a mixed pair, and `left join … where … is null` —
  all correct.
- **Gap 4 — NULL in USING** turned out to be a real defect, not a non-finding; see the
  fixed section above.
- **Gap 6 — the two adjacent open defects** (`bug-using-join-skips-cross-type-coercion`,
  `bug-asof-match-column-ignores-semantic-ordering`) are correctly scoped and correctly
  cross-referenced from code and docs. No change.

### Tripwires

None recorded. The conditional-looking concerns in this area turned out to be either
definite defects (the NULL guard, the fact-extraction over-claim) or non-issues once
probed — nothing landed in the "fine now, only matters if X later" category.

## Validation

- `yarn build` — clean.
- `yarn lint` — clean across all packages (eslint + the `tsconfig.test.json` type pass).
- `yarn test` — all workspaces green. `packages/quereus`: **7450 passing, 13 pending, 0
  failing** (up from 7434: the 16 new unit + plan assertions; the sqllogic additions run
  inside existing `it()`s).
- `yarn test:store` was not run, here or during implement. This ticket touches
  planner/runtime join paths, not storage, but the store module re-runs the same logic
  files, so a store-path confirmation is still outstanding.

## Incident during review

While comparing behavior against the pre-implement commit, the review agent created a git
worktree and junctioned the repo's `node_modules` into it so it could run. Removing that
worktree followed Yarn's workspace symlinks (`node_modules/@quereus/*` → `packages/*`)
and deleted `node_modules` plus every workspace package's source files from the main
tree. All 1546 files were unmodified tracked files and were restored from HEAD; the
review's own in-progress edits were lost and redone, and `yarn install` + `yarn build`
rebuilt the dependency tree. The final state is verified by the full lint + test run
above. **Do not junction `node_modules` into a scratch worktree** — run the comparison
tree with its own install, or copy the two or three source files under test instead.
