---
description: An uncorrelated `IN (SELECT ...)` that decorrelates into a semi join still full-scans when its probe (left) side is itself a join — the key-set seek rewrite only ever looks at a bare access leaf on that side, never through a `JoinNode`.
repro: verified
files:
  - packages/quereus/src/planner/rules/access/rule-key-set-seek.ts     # admitLeaf calls peelToSeekableAccessLeaf on the semi join's probe side
  - packages/quereus/src/planner/rules/shared/access-leaf.ts           # peelToSeekableAccessLeaf(node) — descends Alias/trivial Project/Filter, never JoinNode
  - packages/quereus/test/optimizer/key-set-seek.spec.ts               # every existing case targets a bare leaf on the probe side
  - packages/quereus-store/test/key-set-seek-store.spec.ts             # same gap, store-backed
tradeoffs: |
  Confirmed identical on both the in-memory module and a real StoreModule-backed table
  (same plan shape either way) — this is an engine-level planner gap, not a backend/store
  issue, so it does not belong to `store-module-access-plan.ts` or anything IndexedDB-specific.

  The fix shape is a reassociation, not a leaf-peeling extension: when the semi join's
  key touches only ONE side of an unrelated join sitting on the probe side —
  `SemiJoin(Inner(e, t), keys)` where the semi key is a column of `e` only and `t` is
  untouched by it — the semi join can commute inward to
  `Inner(SemiJoin(e, keys), t)`, after which the existing seek rule already fires on `e`
  as a bare leaf. This is a new rule (or an extension of `rule-join-greedy-commute`'s
  reassociation family), not a change to `peelToSeekableAccessLeaf` itself — teaching the
  peel to walk through an arbitrary `JoinNode` would be unsound in general (the join could
  duplicate or filter rows the semi key depends on); the reassociation only applies when
  the untouched side is provably irrelevant to the semi key, which is exactly the
  precondition `readsColumnsOf`-style checks elsewhere in the join rules already test.

  Scope this to inner/cross joins on the probe side first (the common case, and the one in
  the repro); LEFT/RIGHT/FULL reassociation past a semi join has real preservation
  questions (nullability, row multiplication) that are a separate, harder problem — leave
  those declining as they do today rather than trying to cover them in the same pass.
difficulty: medium
---

# Key-set seek declines when the semi join's probe side is itself a join

## Symptom

```sql
select e.id, e.amount, t.date
from entry e join txn t on t.id = e.txn_id
where e.txn_id in (select txn_id from entry where account_id = ?);
```

`e.txn_id in (select ...)` correctly decorrelates into a semi join (the uncorrelated-IN
machinery works), but the resulting plan is:

```
HashJoin [SEMI HASH JOIN]
 ├─ HashJoin [INNER HASH JOIN]
 │   ├─ IndexScan entry USING _primary_     <- full scan
 │   └─ IndexScan txn USING _primary_       <- full scan
 └─ IndexSeek entry USING idx_entry_account  <- the IN-subquery side seeks fine
```

instead of the expected multi-seek shape (`KeySetSemiJoinNode` driving indexed lookups
into `entry` by `txn_id`, with `txn` then joined onto the surviving rows). Root cause
verified by reading `rule-key-set-seek.ts`: `admitLeaf` requires the semi join's probe
side to peel down to a bare access leaf via `peelToSeekableAccessLeaf`
(`packages/quereus/src/planner/rules/shared/access-leaf.ts:54-74`), which descends through
`AliasNode`, a trivial `ProjectNode`, and `FilterNode` only — never a `JoinNode`. Here the
probe side is `entry e join txn t on t.id = e.txn_id`, an unrelated join that doesn't touch
`txn_id`, so the peel fails at the `JoinNode` and the rule declines outright (`admitLeaf`
returns null).

Reproduced identically against both the default in-memory module and a real
`StoreModule`-backed table with `ANALYZE` run — same plan shape either way, confirming this
is not a store/IndexedDB-specific gap. No existing rule fills it: `rule-join-greedy-commute`
and `rule-quickpick-enumeration` only reorder INNER/CROSS subtrees and treat a SEMI join as
an opaque boundary; `rule-join-predicate-pushdown` matches `JoinNode`, not the semi join's
physical shape. Every case in `test/optimizer/key-set-seek.spec.ts` and
`test/store/.../key-set-seek-store.spec.ts` targets a bare leaf on the probe side — this
compound shape (the filtered table also joined to something else) is untested anywhere.

Surfaced by a user report on GitHub issue #30 re-testing after `KeySetSemiJoinNode`
landed; the explicit-JOIN rewrite of the same query (with the join reordered so the
seekable table sits alone, `select ... from (select txn_id from entry where account_id = ?)
matched join entry e on ... join txn t on ...`) already plans correctly today — confirmed
by direct repro — so this is scoped to the reassociation, not the seek machinery itself.

## Fix

A new reassociation rule (or an addition to the `rule-join-greedy-commute` family) that
recognizes `SemiJoin(Inner(e, t), keys)` where the semi key touches only `e`'s columns and
rewrites it to `Inner(SemiJoin(e, keys), t)`, gated the same way the existing sibling
guards do (no LATERAL/correlated read of the other side, no write in either subtree).
After the rewrite, `rule-key-set-seek` already fires on the now-bare `e` leaf — no change
needed there. Scope to INNER/CROSS on the probe side per `tradeoffs:` above.

## Test plan

Add the compound shape (filtered table also joined to something else) to
`test/optimizer/key-set-seek.spec.ts`, asserting the reassociated plan and a
`KeySetSemiJoinNode`/seek forms; a row-equality twin in `.sqllogic` so it also runs in
store mode. Confirm the un-reassociable cases (semi key touching both join sides, or the
probe-side join carrying a LEFT/RIGHT/FULL type) still decline exactly as before —
negative controls, not just the positive one.
