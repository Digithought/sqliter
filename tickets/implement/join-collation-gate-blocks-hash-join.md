---
description: Joining two tables on a text key gets dramatically slower as data grows whenever the two columns were declared with different text-sorting rules — which is the default shape for every foreign-key join on the persistent store. The planner silently gives up on its fast join strategy and falls back to comparing every row against every row.
files:
  - packages/quereus/src/planner/rules/join/equi-pair-extractor.ts          # the gate that drops the join key
  - packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts # hash/merge/NL pick; flips pairs on build/probe swap
  - packages/quereus/src/planner/rules/join/rule-monotonic-merge-join.ts    # other consumer of extractEquiPairs
  - packages/quereus/src/planner/nodes/join-utils.ts                        # EquiJoinPair type; propagateJoinFds / combineJoinKeys / propagateJoinMonotonicOn
  - packages/quereus/src/planner/nodes/bloom-join-node.ts                   # getType + computePhysical feed equiPairs into fact propagation
  - packages/quereus/src/planner/nodes/merge-join-node.ts                   # same
  - packages/quereus/src/planner/nodes/join-node.ts                         # extractEquiPairsFromCondition — the already-correct gate to mirror
  - packages/quereus/src/planner/analysis/comparison-collation.ts           # operandCollation, isValueDiscriminatingEquality, resolveComparisonCollation
  - packages/quereus/src/runtime/emit/bloom-join.ts                         # already resolves the pair collation symmetrically — no change expected
  - packages/quereus/src/runtime/emit/merge-join.ts                         # relies on matched collations — must keep doing so
  - packages/quereus/test/plan/join-selection.spec.ts                       # where the new plan assertions belong
  - packages/quereus/test/planner/collation-soundness.spec.ts               # line ~217 asserts today's reject-outright behavior; must be updated
  - packages/quereus/test/planner/equi-pair-semantic-gate.spec.ts           # unit tests over extractEquiPairsFromUsing
  - docs/optimizer.md                                                       # join-strategy selection docs
difficulty: hard
---

# Hash join is refused whenever the two join-key columns declare different collations

## Summary of the diagnosis

The reported super-linear join is **not** a missing index-nested-loop join and **not** a
join-ordering or cache problem. `rule-join-physical-selection` never fires at all on the
affected schemas, because `extractEquiPairs` refuses to recognize `t.id = e.txn_id` as an
equi-pair. With zero equi-pairs the rule returns `null`, the plan keeps the generic
nested-loop `JoinNode`, and the join goes quadratic.

The refusal comes from one line in `equi-pair-extractor.ts`:

```ts
&& operandCollation(n.left) === operandCollation(n.right)
```

The persistent store gives an **undecorated `text` primary-key column the collation
`NOCASE`** (the table key collation `K`, default `NOCASE`, becomes the column default for
`isTextual` PK columns — `docs/schema.md` § "Per-column PK key collation"). An ordinary
non-PK `text` column stays `BINARY`. So on the store, *every* `child.fk = parent.pk` join —
the single most common join in any schema — has a `BINARY` column on one side and a
`NOCASE` column on the other, fails the equality above, and is demoted to a residual
predicate. On the memory module the same thing happens the moment anyone writes an explicit
`collate nocase` on one side of a join key.

The gate's own doc comment explains why it is conservative, and that reasoning is still
correct — but it only justifies the restriction for **merge** join, which needs both inputs
physically sorted under the key's comparison collation while `PhysicalProperties.ordering`
is collation-blind. Hash / Bloom join has no such requirement: `runtime/emit/bloom-join.ts`
already resolves each pair's collation symmetrically through `effectiveCollationOfTypes` and
normalizes its hash keys under the result. The gate is applied to all three algorithms
because extraction happens once, before the algorithm is chosen.

## Reproduction (done at fix stage — reproduce again before/after)

Schema: `txn(id text primary key, entity_id text, date text)`,
`entry(id text primary key, txn_id text, account_id text, amount integer)` plus
`create index idx_entry_txn on entry(txn_id)` and `idx_txn_entity_date`, seeded with N txns
and 2N entries. Timed queries:

- `JOIN2` = `select e.id, e.amount, t.date from entry e join txn t on t.id = e.txn_id where e.account_id = 'a3' order by t.date`
- `JOIN4` = the 4-way `entry ⋈ txn ⋈ account ⋈ account_group` with `group by g.account_type`
- control = `select id from entry where txn_id = 't5'`

Measured on this repo at HEAD (LevelDB store module, the same store abstraction the
IndexedDB plugin sits on):

| backend / schema | plan | N=100 | N=1000 | N=5000 |
|---|---|---|---|---|
| store, undecorated `text` PK (the reported shape) | nested-loop `Join` + `Cache` | JOIN2 34 ms | **2098 ms** (61×) | not run |
| store, PK forced to `collate binary` (⇒ hash join fires) | `HashJoin` | JOIN2 7.5 ms | 34.5 ms (4.6×) | 206 ms |
| memory, undecorated PK | `HashJoin` | JOIN2 9 ms | 29 ms | — |
| control (all of the above) | `IndexSeek` on `idx_entry_txn` | ~2 ms | ~2 ms | ~7 ms |

The 61× / 47× growth per decade in the first row reproduces the external report's numbers
almost exactly (report: 36 ms → 1679 ms). Making the pair collations agree — which is
exactly what this fix does for the *planner*, without changing anyone's schema — is a **~60×
improvement at N=1000** and restores linear scaling; the 4-way join at N=5000 lands at
296 ms rather than not completing.

The bug reproduces on the **memory** module too, so regression tests do not need
`yarn test:store`:

```
create table txn (id text collate nocase primary key, date text);
create table entry (id text primary key, txn_id text);
select e.id, t.date from entry e join txn t on t.id = e.txn_id;
```
→ `JOIN INNER JOIN ON condition` today; should be `HASHJOIN`. Flipping which side carries
the `collate nocase` reproduces it equally. With both sides `BINARY` (or both `NOCASE`) the
plan is already `HASHJOIN`.

## Prerequisite: physical join nodes over-claim value facts

Loosening the gate is only sound once a second, **pre-existing** defect is closed, because
loosening widens the class of pairs that hits it.

`JoinNode` (the logical / nested-loop node) derives its equi-pairs via
`extractEquiPairsFromCondition` in `join-node.ts`, which is gated on
`isValueDiscriminatingEquality` — it deliberately mints **no** value-level facts from a
comparison that passes value-*different* rows (a `NOCASE` comparison matches `'Bob'` to
`'bob'`).

`BloomJoinNode` and `MergeJoinNode` do **not** have that gate. Their `getType()` and
`computePhysical()` feed `this.equiPairs` straight into `combineJoinKeys`,
`analyzeJoinKeyCoverage`, `propagateJoinFds`, and `propagateJoinMonotonicOn`, which mint
equivalence classes, both-direction determination FDs, and output-key claims from every
pair. Observed today (memory module, matched-`NOCASE` join key on both sides), the chosen
`MergeJoin` publishes:

```
"fds":[…{"determinants":[0],"dependents":[2],…},{"determinants":[2],"dependents":[0],…}…],
"equivClasses":[[0,2]]
```

for a join whose matched rows are `a.x = 'Bob'` against `b.y = 'bob'` / `'BOB'` — values
that are *not* equal. Probing DISTINCT / GROUP BY / ORDER BY / predicate-inference over that
shape did **not** produce a wrong answer at HEAD (those consumers re-compare under the
columns' own `NOCASE` collation, which absorbs the difference), so this is latent rather
than currently reachable — but it is the exact fact `isValueDiscriminatingEquality` exists to
prevent, and after this change the minted equivalence would couple a `NOCASE`-declared
column to a `BINARY`-declared one, where a downstream `BINARY` comparison would genuinely
be wrong. Close it as part of this ticket, not after.

## Design

### Carry two independent per-pair properties on `EquiJoinPair`

`EquiJoinPair` (in `planner/nodes/join-utils.ts`) currently holds only the two attribute
ids. Two distinct things must travel with each pair, because the physical nodes hold the
pairs but not the originating condition:

```ts
export interface EquiJoinPair {
	leftAttrId: number;
	rightAttrId: number;

	/**
	 * True when both sides declare the SAME collation. Only merge join needs
	 * this: it requires both inputs physically ordered under the key's comparison
	 * collation, and `PhysicalProperties.ordering` is collation-blind, so a
	 * matched declared collation is what makes each input's advertised order
	 * equal the merge comparator's order. Hash/Bloom join does not care — its
	 * emitter resolves the pair collation symmetrically.
	 */
	collationsMatch: boolean;

	/**
	 * True when rows this pair matches are genuinely value-equal
	 * (`isValueDiscriminatingEquality`). False for any possibly-text pair whose
	 * comparison collation is non-BINARY: it matches value-DIFFERENT rows, so it
	 * must not mint equivalence classes, determination FDs, key coverage, or
	 * monotonicity.
	 */
	valueDiscriminating: boolean;
}
```

Make both **required**, not optional-with-a-default. There are only about four construction
sites (three in `equi-pair-extractor.ts`, plus the build/probe flip in
`rule-join-physical-selection.ts`), and an implicit `true` default would silently reproduce
today's over-claim at any site that forgets. `rule-lateral-top1-asof.ts:415` and
`asof-scan-node.ts` use a different, similarly-shaped type — check before widening; do not
change them if they are not `EquiJoinPair`.

### `extractEquiPairs` — extract, don't reject

Keep the **semantic-ordering** gate exactly as it is: a mixed `timespan = text` pair is
unsound for hash join too (raw-text hashing would miss `'PT1H'` vs `'PT60M'`), so those pairs
stay demoted to the residual.

Drop the collation *equality* requirement from the accept test. A `ColumnRef = ColumnRef`
pair now becomes an equi-pair regardless of collation, tagged with:

- `collationsMatch = operandCollation(left) === operandCollation(right)`
- `valueDiscriminating = isValueDiscriminatingEquality(left, right)`

`resolveComparisonCollation` can report a same-rank `conflict` (two *declared* non-BINARY
collations that differ — e.g. `NOCASE` vs `RTRIM`). That is a plan-time user error surfaced
by `BinaryOpNode.generateType`; extraction must not throw. Treat a conflicting pair as
**not** an equi-pair (leave it in the residual) so this rule never becomes the thing that
raises the error.

`extractEquiPairsFromUsing` gets the same treatment: it currently returns `null` outright on
a collation mismatch because USING has no residual to demote into. With the split it can
return the pairs tagged `collationsMatch: false`; hash join uses them, merge declines. The
semantic-ordering rejection there stays as-is (still returns `null`).

### `rule-join-physical-selection`

- **Hash / Bloom branch**: use all extracted pairs. No other change. When flipping pair
  direction for the build/probe swap (currently rebuilding the object literal at
  `rule-join-physical-selection.ts:193`), **spread the source pair** so the two new flags
  survive the flip.
- **Merge branch**: merge is a candidate only when *every* pair has `collationsMatch`. If any
  pair is mismatched, treat merge's cost as unavailable (do not consider it) and let hash vs
  nested-loop compete. Requiring all-matched rather than merging on the matched subset keeps
  the change minimal and cannot be unsound; the mixed-collation multi-key merge is a rare
  shape and losing it costs an optimization, never a row.
- `isOrderedOnEquiPairs` / `reorderEquiPairsForMerge` / `isMergeReadyOnAllPairs` need no
  logic change, but every caller that reaches them for *merge* purposes must have filtered on
  `collationsMatch` first.

### `rule-monotonic-merge-join`

Same requirement as the merge branch above: its merge key must be a `collationsMatch` pair,
and its `isMergeReadyOnAllPairs` defer-check should consider only matched pairs.

### Physical node fact propagation

In both `bloom-join-node.ts` and `merge-join-node.ts`, filter to
`equiPairs.filter(p => p.valueDiscriminating)` before feeding:

- `combineJoinKeys` (in `getType()`),
- `analyzeJoinKeyCoverage`, `propagateJoinFds`, `propagateJoinMonotonicOn` (in
  `computePhysical()`).

Do **not** filter the pairs handed to the runtime emitters or used for build/probe keying —
a non-value-discriminating pair is still a perfectly good *join condition*, it just is not a
value-equality *fact*. Keep `this.equiPairs` as the full set; derive the filtered set locally.

`getLogicalAttributes()` in both nodes serializes the pairs for `query_plan()` — include the
two flags (or at least mark non-default ones) so a plan dump shows why merge was declined.

### Runtime emitters

`emit/bloom-join.ts` already calls `effectiveCollationOfTypes(leftType, rightType)` per pair
and threads the result through `hashKeyCollationName` into the key normalizer, so mismatched
pairs are handled correctly with no change. Its comment (lines ~45-53) claims the
matched-collation gate keeps mismatched pairs out of this path — that comment becomes wrong;
update it. `emit/merge-join.ts` keeps its matched-collation assumption, which the selection
rules now enforce; update its comment to point at the new enforcement site.

## Scope boundary

This ticket makes hash join fire reliably, which is one of the two outcomes the source
ticket accepted ("a reliably-selected hash join on the store path … which is linear even
though it does not use the inner index"). It does **not** add an index-nested-loop join and
does **not** push a single-table `WHERE` conjunct below a join. Both were confirmed absent
during the fix investigation and are filed separately:
`backlog/feat-index-nested-loop-join` and `backlog/feat-filter-pushdown-through-join`.
Neither is needed to close the reported regression.

Also confirmed **not** contributing, despite being listed as candidate causes on the source
ticket: join-order enumeration on unknown cardinality, and the nested-loop right-cache
abandon cliff (`backlog/bug-cache-threshold-abandon-cliff`). Both are real, but with hash
join selected the 4-way join at N=5000 completes in 296 ms.

## TODO

### Phase 1 — soundness prerequisite

- Add `collationsMatch` and `valueDiscriminating` as **required** fields on `EquiJoinPair` in
  `planner/nodes/join-utils.ts`; document each with the reasoning above. Fix every
  construction site the compiler flags.
- In `bloom-join-node.ts` and `merge-join-node.ts`, restrict `combineJoinKeys`,
  `analyzeJoinKeyCoverage`, `propagateJoinFds` and `propagateJoinMonotonicOn` to
  `valueDiscriminating` pairs. Leave emitter-facing `equiPairs` untouched.
- Add a plan test asserting a matched-`NOCASE` equi-join's physical `HashJoin`/`MergeJoin`
  publishes **no** `equivClasses` / determination FDs coupling the two sides — mirroring what
  the logical `JoinNode` path already does. (Extend
  `test/planner/collation-soundness.spec.ts`.)
- Confirm `yarn test` is green at this point, before loosening anything.

### Phase 2 — split the gate

- `extractEquiPairs`: remove the collation-equality accept condition; tag each pair with the
  two flags; treat a same-rank `resolveComparisonCollation` conflict as not-an-equi-pair
  (residual), never a throw. Keep the semantic-ordering gate.
- `extractEquiPairsFromUsing`: same, returning tagged pairs instead of `null` on a collation
  mismatch. Keep the semantic-ordering `null`.
- Rewrite the long "Collation gate" doc comment on `extractEquiPairs` to describe the split —
  it is currently the canonical explanation of the old behavior and will otherwise be
  actively misleading.
- `rule-join-physical-selection`: hash branch takes all pairs; merge branch requires every
  pair `collationsMatch`; build/probe flip spreads the source pair so flags survive.
- `rule-monotonic-merge-join`: require `collationsMatch` on its merge key and on the
  `isMergeReadyOnAllPairs` defer-check.
- Update the now-stale lockstep comments in `runtime/emit/bloom-join.ts` and
  `runtime/emit/merge-join.ts`.

### Phase 3 — tests

- Plan tests (memory module, `test/plan/join-selection.spec.ts`): `collate nocase` PK vs
  plain FK selects `HashJoin`, both directions of which side carries the `collate`. Both
  sides `BINARY` and both sides `NOCASE` keep selecting hash/merge as they do today.
- Plan test: a mismatched-collation pair over two inputs that are *both* physically ordered
  on the key must **not** select `MergeJoin`.
- Result-correctness test (`test/logic/*.sqllogic`): a `NOCASE`-vs-`BINARY` join returns the
  same rows under the hash plan as the nested-loop plan did — specifically that case-variant
  matches (`'Bob'` joining `'bob'`) are still returned, since the resolved pair collation is
  `NOCASE`. Cover LEFT and SEMI/ANTI as well as INNER.
- USING-join test: `using (col)` over differently-collated columns now hash-joins and returns
  the same rows.
- `test/planner/collation-soundness.spec.ts:~217` currently asserts the reject-outright
  behavior ("extractEquiPairsFromUsing rejects the mismatched pair, so no physical join") —
  update it to the new contract rather than deleting it.
- `test/planner/equi-pair-semantic-gate.spec.ts` — extend for the new tagged return shape.
- Re-run the perf harness from the Reproduction section on the LevelDB store module and
  record the before/after numbers in the review handoff. Keep it out of the committed test
  suite (it is a timing benchmark, not an assertion).

### Phase 4 — validation and docs

- `yarn build`, `yarn lint`, `yarn test`.
- `yarn test:store` — this ticket changes the plan shape for essentially every join on the
  store path, so the store leg is not optional here. Note `83-merge-join.sqllogic` is already
  memory-only in store mode.
- Update `docs/optimizer.md` where it describes join-strategy selection and the equi-pair
  collation restriction.
