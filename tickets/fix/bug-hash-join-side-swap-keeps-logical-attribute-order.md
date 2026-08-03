---
description: When the planner decides to feed the two sides of a join into the hash-join operator in the opposite order, it forgets to tell the rest of the query about the change, so a grouped query above that join reads every value out of the wrong column and silently returns wrong totals.
files:
  - packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts   # the swap that keeps the old attribute order
  - packages/quereus/src/planner/nodes/bloom-join-node.ts                     # buildAttributes / getType on the swapped node
  - packages/quereus/src/planner/nodes/join-utils.ts                          # buildJoinAttributes returns preserveAttributeIds verbatim
  - packages/quereus/src/runtime/emit/bloom-join.ts                           # emits [...leftRow, ...rightRow]
  - packages/quereus/src/runtime/emit/hash-aggregate.ts                       # positional consumer that surfaces the mismatch
  - packages/quereus/test/logic/07.3-group-by-extras.sqllogic                 # nearest existing coverage
difficulty: medium
repro: verified
---

# Hash join swaps build/probe sides but keeps the logical attribute order

## Symptom

A `GROUP BY` over a multi-table join silently returns wrong values: the grouping key
comes back as some *other* column's value and the aggregate comes back `NULL` (or a
wrong number), with no error raised. The same join without `GROUP BY` returns correct
rows, which is what makes the failure so easy to miss.

Reported externally against 4.6.0 with `@quereus/plugin-indexeddb` (`entry ⋈ txn ⋈
account ⋈ account_group`, `where entity_id = ?`, `group by account_type` → one row
whose key was an unrelated integer and whose `sum` was `NULL`). Reproduced here at
`v4.6.0` **and at HEAD** against the LevelDB store module — the defect is live.

## Minimal reproduction (store module; LevelDB or IndexedDB)

```sql
create table txn           (id text primary key, entity_id text);
create table account_group (id text primary key, account_type text);
create table account       (id text primary key, entity_id text, account_group_id text);
create table entry         (id text primary key, txn_id text, account_id text, amount integer);
create index ix_acct_entity on account(entity_id);

insert into account_group values ('g0','ASSET'),('g1','EXPENSE');
insert into account       values ('a0','ent0','g0'),('a1','ent0','g1');
insert into txn           values ('t0','ent0'),('t1','ent0');
insert into entry         values ('n0','t0','a0',10),('n1','t1','a1',20);

select ag.account_type as t, sum(e.amount) as s
from entry e
join txn t            on t.id  = e.txn_id
join account a        on a.id  = e.account_id
join account_group ag on ag.id = a.account_group_id
where a.entity_id = 'ent0'
group by ag.account_type;
```

Expected `[{t:'ASSET',s:10},{t:'EXPENSE',s:20}]`; actual `[{t:'g0',s:null},{t:'g1',s:null}]`.

Ingredients, each necessary in this shape:

- the **store** module (the memory module's row estimates came out symmetric in every
  shape tried, so it never took the swap branch — see *Why the suite missed it*),
- a secondary index that turns `account` into an `IndexSeek` with a *different* row
  estimate from its sibling — this asymmetry is what makes the swap fire,
- a `where` clause (removing it changes the join tree and the answer becomes correct),
- four joined tables in the failing orders (`entry,txn,account,account_group` and
  `txn,entry,account,account_group`; `entry,account,account_group,txn` stays correct),
- an aggregate above the join — `select` of plain columns over the same join is correct.

Dropping the index, dropping the `where`, or dropping to three tables all hide it.
`db.optimizer.updateTuning({disabledRules: new Set(['join-physical-selection'])})`
makes the query correct, which localizes it to physical join selection.

## Root cause

`rule-join-physical-selection.ts` captures the logical join's attribute order *before*
it decides which side builds and which side probes:

```ts
const preserveAttrs = node.getAttributes().slice();   // logical left, then logical right
...
if (joinType === 'inner' && leftRows < rightRows && !sideEffects) {
    probeSource = node.right;      // sides swap
    buildSource = node.left;
    equiPairs   = /* flipped */;
}
return new BloomJoinNode(node.scope, probeSource, buildSource, joinType, equiPairs,
                         extracted.residual, preserveAttrs);   // ← order NOT flipped
```

`buildJoinAttributes` returns `preserveAttributeIds` verbatim, so the swapped
`BloomJoinNode` advertises **logical-left-then-logical-right** while
`emitBloomJoin` yields `[...leftRow, ...rightRow]` — i.e.
**probe-then-build**. Every consumer that maps an attribute id to a column index
through `plan.source.getAttributes()` therefore indexes into the wrong slot.

`getType()` has the same disagreement from the other direction: it builds its column
list (and its key positions, via `combineJoinKeys`) as probe-then-build, so on a
swapped node `getType().columns` and `getAttributes()` describe two different row
layouts.

Arithmetic for the repro, which matches the observed output exactly. Logical order is
`[e(4), t(2), a(3), ag(2)]` (11 columns); the emitted row is
`[ag(2), e(4), t(2), a(3)]`:

| read | advertised index | lands on | observed |
|---|---|---|---|
| `ag.account_type` (group key) | 10 | `a.account_group_id` | `'g0'` / `'g1'` |
| `e.amount` (sum arg) | 3 | `e.txn_id` (text) | `sum` → `null` |

Why a plain `select` over the same join is unaffected: column references above the
join resolve through the per-side row slots the emitter installs (`leftSlot` /
`rightSlot`, each built from its own child's attributes), which are correct by
construction. `emitHashAggregate` instead builds its *own* descriptor over
`plan.source.getAttributes()` and applies it to the row array the join yields — that is
where the mismatch bites. Any other positional consumer of a swapped hash join's row
(distinct/sort key extraction, set-op alignment, cache keys) is exposed the same way;
the fix should establish which, not assume `GROUP BY` is the only one.

Both directions are available as fixes — reorder `preserveAttrs` to probe-then-build
when the swap fires, or have the emitter yield in the node's advertised order — and the
choice interacts with `getType()`/`combineJoinKeys`, which already assume
probe-then-build. `MergeJoinNode` takes `preserveAttrs` from the same site but never
swaps, so it is not affected.

## Related

`tickets/backlog/feat-index-nested-loop-commute-drive-side.md` names this exact hazard
for the index-nested-loop path ("swapping the two inputs inside a physical-selection
rule would reshuffle the output row layout that the emitter's `[...leftRow,
...rightRow]` depends on") — while the hash-join branch in the same file has been doing
that swap all along. That ticket is a *feature* about which side to seek; it is not this
defect and should not be folded into it, but whoever fixes this should leave the
row-layout rebuild in a state that feature can build on.

## Expected behavior

A grouped aggregate over a join returns the same rows regardless of which side the cost
model picks as the hash-join build side, and regardless of backend module. Regression
coverage must pin the invariant, not just this query: a physical join's advertised
attribute order and its emitted row layout agree, on both the swapped and unswapped
paths. Note that the plain-`select` form of the failing query passes today, so a
regression test written only over projections would not have caught this.
