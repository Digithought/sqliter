---
description: A query that filters one table with `in (select ...)` and also joins that table to another one reads the filtered table end-to-end instead of looking up only the matching rows. Teaching the planner to apply the `in (...)` filter before the second join fixes it.
repro: verified
difficulty: medium
files:
  - packages/quereus/src/planner/rules/join/rule-semi-join-pushdown.ts        # NEW — the rule to write
  - packages/quereus/src/planner/optimizer.ts                                 # register it in the Structural pass, next to subquery-decorrelation (~line 570)
  - packages/quereus/src/planner/analysis/predicate-dependencies.ts           # collectPredicateAttributeIds — the attribute-id walker to reuse (do NOT write a third copy)
  - packages/quereus/src/planner/nodes/join-node.ts                           # JoinNode ctor (scope, left, right, joinType, condition?, usingColumns?, existence?)
  - packages/quereus/src/planner/rules/predicate/rule-join-predicate-pushdown.ts  # the scalar-predicate sibling; its header table is the null-extension argument this rule reuses
  - packages/quereus/src/planner/rules/access/rule-key-set-seek.ts            # the beneficiary — unchanged by this ticket
  - packages/quereus/test/optimizer/key-set-seek.spec.ts                      # add the compound positive + negative controls
  - packages/quereus/test/logic/08.4-key-set-semi-join.sqllogic               # row-equality twin (also runs under `yarn test:store`)
  - packages/quereus-store/test/key-set-seek-store.spec.ts                    # store-backed twin
  - docs/optimizer-rules.md                                                   # rule catalogue — add a bullet
  - docs/optimizer.md                                                         # line ~119, "Where an `IN (SELECT …)` predicate ends up"
---

# Apply a semi join before an unrelated join, so the key-set seek can fire

## The problem

```sql
select e.id, e.amount, t.date
from entry e join txn t on t.id = e.txn_id
where e.txn_id in (select txn_id from entry where account_id = ?);
```

The `in (select …)` becomes a semi join (that part works). But the semi join lands *above*
the `entry`⋈`txn` join, and `rule-key-set-seek` — the rule that turns a semi join into
"materialize the key set, then seek the target index once per key" — only fires when the
side being filtered peels down to a bare table read. Here it peels down to a join, so the
rule declines and `entry` is read end-to-end:

```
HashJoin [SEMI]                      <- key-set-seek declines here
 ├─ HashJoin [INNER]
 │   ├─ IndexScan entry _primary_    <- full scan
 │   └─ IndexScan txn   _primary_    <- full scan
 └─ IndexSeek entry idx_entry_account
```

Reproduced on the in-memory module with a transient script (since deleted). The source
ticket reports the same shape on a store-backed table.

**Correction to the source ticket:** it claimed the hand-written join rewrite
(`from (select txn_id from entry where account_id = ?) m join entry e on …`) "already plans
correctly today". It does not — measured, that shape plans as an INNER hash join with a full
`IndexScan` of `entry`, no `KeySetSemiJoin` at all. There is no working user-side workaround
to point people at; do not go looking for one.

## The fix — push the semi join below the inner join

A semi join is an existential *filter* on its left input. When its condition reads columns
from only one side of an inner/cross join underneath it, the filter can be applied to that
side first — exactly the argument `rule-join-predicate-pushdown` already makes for scalar
conjuncts (its header table is the reference; reuse the reasoning, cite the file):

```
Join(semi, Join(inner|cross, L, R), keys, cond)      cond reads L (and keys) only
  →  Join(inner|cross, Join(semi, L, keys, cond), R)

Join(semi, Join(inner|cross, L, R), keys, cond)      cond reads R (and keys) only
  →  Join(inner|cross, L, Join(semi, R, keys, cond))
```

Output attributes are unchanged in identity *and* order: a semi join publishes its left
input's attributes verbatim, so both shapes yield `L.attrs ++ R.attrs`. Every
`ColumnReferenceNode` above resolves unchanged.

Soundness: `semi(X, K, p) = { x ∈ X : ∃k ∈ K. p(x, k) }`. When `p` reads only the `L` part of
`x`, the test is per-`L`-row and deterministic, so it commutes with the join — whether the
join drops `L` rows or fans them out, filtering before removes exactly the output rows
filtering after would have.

**No new peel through `JoinNode`.** The source ticket is right that teaching
`peelToSeekableAccessLeaf` to walk a join would be unsound. `rule-key-set-seek` and
`shared/access-leaf.ts` are not touched by this ticket — after the reassociation the filtered
side is a bare leaf again and the existing rule fires as-is.

### Where it runs

Structural pass, `nodeType: PlanNodeType.Join`, `phase: 'rewrite'`,
`sideEffectMode: 'aware'`. Register immediately after `subquery-decorrelation` and before the
IND folders (`semi-join-fk-trivial`, `anti-join-fk-empty`) and `join-elimination` — the same
placement rationale `semijoin-existence-recovery` documents. `applyPassRules` runs each pass's
rules to a fixpoint on the current node, so the semi `JoinNode` that decorrelation mints on a
`Filter` is offered to this rule in the same node visit; no extra pass or re-entry is needed.

Deeper nesting works for free: the rewrite's new semi join is a child, visited during the
top-down descent, so `Join(semi, Join(inner, Join(inner, A, B), C), K)` pushes down twice.

### Admission gates

Decline (return null) unless all hold:

- Anchor is a `JoinNode` with `joinType === 'semi'` and a `condition`.
- Anchor has no `existence` specs.
- `node.left` is a `JoinNode` with `joinType` `'inner'` or `'cross'`.
  LEFT/RIGHT/FULL are **out of scope** — see *Deliberately not in scope* below.
- Key source (`node.right`) is uncorrelated (`isCorrelatedSubquery`) and deterministic
  (`PlanNodeCharacteristics.isDeterministic`) — same admission test `rule-key-set-seek`'s
  `admitJoin` applies, and for the same reason: the source is drained once.
- Neither side of the inner join is correlated (`isCorrelatedSubquery`) — a LATERAL right side
  reads the left side, and re-rooting either branch under a semi join must not disturb that.
- No subtree carries a write (`PlanNodeCharacteristics.subtreeHasSideEffects` on the key source
  and on both inner-join branches).
- Every attribute id the condition needs — via `collectPredicateAttributeIds` from
  `planner/analysis/predicate-dependencies.ts`, which also accounts for correlated references
  inside a sub-query operand — is either a key-source attribute or an attribute of **exactly
  one** inner-join branch. An id in neither branch (an outer reference, an `exists … as` flag)
  declines. Ids spanning both branches decline. Ids touching neither branch decline (nothing to
  gain).

`inner.condition` / `inner.usingColumns` / `inner.existence` carry over verbatim to the
rebuilt inner join; `node.condition` / `node.usingColumns` carry over to the pushed semi join.
(Existence flags are unreachable on an inner join today — the parser only accepts
`exists … as` on `left join` — and the attribute-id gate above already declines any condition
that reads a flag; say so in a comment rather than adding a redundant guard.)

### Deliberately not in scope

- **`anti` joins.** `anti(L⋈R, K)` commutes the same way, but `rule-key-set-seek` admits
  `semi` only, so there is nothing downstream to gain today. Record it as a `NOTE:` in the rule
  header with the one-line algebra, don't implement it.
- **LEFT join on the probe side with the semi key on the *preserved* (left) side.** Also sound
  — `σ(L ⟕ R) = σ(L) ⟕ R` when `σ` reads only `L`. Left out to keep the first pass to the shape
  in the repro; same `NOTE:` treatment. (The key on the *null-extended* side does **not**
  commute and must stay declined permanently — say which is which in the note.)
  `backlog/feat-outer-join-to-inner-on-null-rejecting-filter`, if it lands, converts some of
  these to inner joins and this rule then covers them; not a prereq.

### Cost

Unconditional, no cost gate — the same call `rule-join-predicate-pushdown` makes for scalar
conjuncts, and at Structural time the row estimates are not usable anyway (most table-backed
inputs report `Infinity`; see the NOTE in `rule-join-greedy-commute`). The one shape where
pushdown does extra work is a strongly *filtering* inner join, where the semi probes `|L|` rows
instead of the smaller `|L⋈R|` — offset by the join then receiving a smaller left input. Record
that as a `NOTE:` at the rule's admission site with the revisit condition ("if a filtering-join
shape ever shows up regressed in the bench gate, gate this on estimated rows").

## Verification already done (prototype, not committed)

A throwaway version of exactly this rule was built, registered, exercised, and removed:

- The repro query planned to `Join(inner, Alias e → KeySetSemiJoin(IndexScan entry, keys) via
  idx_entry_txn, Alias t → IndexSeek txn primary)` — both full scans gone.
- The right-side arm (`where t.id in (select …)`) rewrote symmetrically.
- Negative controls declined as intended: condition spanning both branches; LEFT join on the
  probe side.
- Row equality held with the rule on vs. off (via `disabledRules`) across five shapes:
  compound, right-arm, `not in`, correlated `exists`, and a fan-out case — including NULL
  `txn_id` rows.
- `yarn test` was green with the prototype in place: **10231 passing, 0 failing** in
  `@quereus/quereus`, all other workspaces passing. Log:
  `tickets/.logs/1-bug-key-set-seek-declines-when-probe-is-join.test.log`.

Treat this as evidence the design holds, not as finished work — the prototype had no doc
header, no tests, and copied an attribute-id walker instead of reusing the shared one.

## TODO

**Phase 1 — the rule**

- Write `packages/quereus/src/planner/rules/join/rule-semi-join-pushdown.ts` with a file header
  in the house style: the two rewrite shapes, the commutation argument, the gate list, the
  scope notes for `anti` / LEFT, and the cost `NOTE:`.
- Use `collectPredicateAttributeIds` from `planner/analysis/predicate-dependencies.ts`. Do not
  copy `rule-join-predicate-pushdown`'s private `collectSubtreeAttributeIds`, and do not
  refactor that rule as part of this ticket.
- Register in `optimizer.ts` (Structural, `PlanNodeType.Join`, `phase: 'rewrite'`,
  `sideEffectMode: 'aware'`, id `semi-join-pushdown`) immediately after `subquery-decorrelation`
  and before `semi-join-fk-trivial` / `anti-join-fk-empty` / `join-elimination`, with the
  registration comment explaining that order.

**Phase 2 — tests**

- `test/optimizer/key-set-seek.spec.ts`: the compound positive — exactly one
  `KeySetSemiJoinNode`, zero `BloomJoinNode` semi joins, the expected index on the pushdown.
- Same file: negative controls that must still decline — condition spanning both branches, and
  a LEFT join on the probe side.
- New `test/optimizer/semi-join-pushdown.spec.ts` for the rule's own plan shape independent of
  whether a seek is won: left-arm and right-arm positives, plus declines for `anti`, `full`,
  and a correlated key source.
- `test/logic/08.4-key-set-semi-join.sqllogic`: row-equality cases for the compound shape —
  NULL join keys, duplicate matches, and fan-out on the untouched side. Runs under
  `yarn test:store` too.
- `packages/quereus-store/test/key-set-seek-store.spec.ts`: the store-backed twin of the
  compound positive.

**Phase 3 — docs + validation**

- `docs/optimizer-rules.md`: a catalogue bullet in the house style (shape, soundness argument,
  gates, pass placement, `sideEffectMode`, what is out of scope and why).
- `docs/optimizer.md` (~line 119, "Where an `IN (SELECT …)` predicate ends up"): note that a
  semi join over an inner/cross join is reassociated below it first, which is what lets the
  compound shape reach `rule-key-set-seek`.
- `yarn test` and `yarn lint` green (lint also type-checks the spec files).
- `yarn bench:gate` is optional and likely over the 10-minute agent budget — if it is skipped,
  say so in the review handoff rather than claiming it passed.
