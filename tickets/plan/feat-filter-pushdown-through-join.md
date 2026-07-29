---
description: A WHERE condition that only mentions one of the joined tables is applied after the join instead of before it, so both tables are read in full even when the condition would have narrowed one of them to a handful of rows via an index. Moving such conditions below the join would cut a lot of wasted reading.
files:
  - packages/quereus/src/planner/rules/predicate/rule-predicate-pushdown.ts  # tryPushDown; explicitly lists Join as a non-move
  - packages/quereus/src/planner/nodes/join-node.ts                          # JoinNode / join types
  - packages/quereus/src/planner/analysis/predicate-normalizer.ts            # conjunct splitting
  - packages/quereus/src/planner/analysis/constraint-extractor.ts            # per-table constraint attribution
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts     # what turns a pushed conjunct into an index seek
difficulty: medium
---

# Push single-table WHERE conjuncts below a join

## What happens now

`rule-predicate-pushdown` moves a `Filter` down across `Sort`, `Distinct`, `Alias`, eligible
`Project`, and into a `Retrieve` boundary — but its header lists `Join` under "Non-moves
(requires deeper analysis)", and it does not cross one. So a conjunct that mentions only one
side of a join stays above the join.

Observed on this repo at HEAD, memory module:

```sql
select e.id, e.amount, t.date
from entry e join txn t on t.id = e.txn_id
where e.account_id = 'a3'
order by t.date
```

plans as `Sort → Project → Filter(e.account_id='a3') → HashJoin( scan entry, scan txn )`.
Both base tables are scanned in full and the filter is applied to the join output, even
though `idx_entry_account` exists and would reduce `entry` from 2N rows to a small handful
before the join ever runs. The 4-way reporting query in `.tmp/quereus-join-perf.md` has the
same shape: `where a.entity_id = ? and t.date <= ?` sits above three joins, so all four base
tables are fully scanned.

This is a constant-factor cost, not the super-linear blow-up that
`implement/join-collation-gate-blocks-hash-join` fixes — but on a persistent store where each
row read costs real I/O, scanning a whole table instead of seeking a few rows is exactly the
overhead users notice.

## What a solution needs to handle

- **Conjunct attribution.** Split the predicate into conjuncts (the normalizer already does
  this), and for each one determine whether every attribute it references comes from a single
  side of the join. Only those are candidates.
- **Join type.** Safe for `INNER` and `CROSS` on either side. For `LEFT`, a conjunct on the
  *preserved* (left) side may be pushed; one on the null-extended (right) side may **not** —
  pushing it would change which outer rows get null-padded versus dropped. Mirror-image for
  `RIGHT`; nothing pushes through `FULL`. For `SEMI` / `ANTI`, only left-side conjuncts push.
- **Null-rejecting conjuncts.** A conjunct on the null-extended side of an outer join that is
  null-rejecting effectively converts the join to an inner join; that is a separate,
  well-known rewrite and should be scoped out of a first pass unless it falls out for free.
- **Side effects.** `rule-predicate-pushdown` already refuses to push past a subtree carrying
  a write; the same guard must apply per side.
- **Duplication vs move.** A conjunct pushed to one side is *moved*, not copied. Deciding
  whether to also leave a copy above (redundant but harmless, and sometimes useful for
  cardinality estimation) is a design call.
- **Interaction with the join-key equivalence classes.** Once
  `implement/join-collation-gate-blocks-hash-join` lands, physical join nodes will publish
  value-equivalence facts only for value-discriminating pairs. Deriving a *new* conjunct for
  the other side from `t.id = e.txn_id and e.txn_id = 'x'` (predicate inference through the
  join) must respect that same gate. `rule-predicate-inference-equivalence` already exists —
  check whether this is better expressed there.

## Relationship to other tickets

- `implement/join-collation-gate-blocks-hash-join` — the actual fix for the reported
  super-linear join. This ticket is a separate, additive win.
- `backlog/feat-index-nested-loop-join` — orthogonal: that one uses the index on the *join*
  key, this one uses the index on a *filter* column.
- `backlog/known/3-advanced-pushdown-phase3` — the broader push-down programme; this is a
  concrete, self-contained slice of it.
