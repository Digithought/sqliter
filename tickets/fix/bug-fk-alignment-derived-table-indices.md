---
description: A query that outer-joins a sub-select onto a table can silently lose rows — the planner throws the join away after mistaking one column for another, because it compares column positions in the sub-select's result against positions in the underlying table.
files:
  - packages/quereus/src/planner/util/key-utils.ts              # checkFkPkAlignment — compares raw column indices
  - packages/quereus/src/planner/rules/join/rule-join-elimination.ts
  - packages/quereus/src/planner/rules/join/rule-fanout-lookup-join.ts
  - packages/quereus/src/planner/util/ind-utils.ts              # resolveTableColumnMapping / mapColumnsToTable — the translation the fix needs
difficulty: medium
---

# Foreign-key alignment compares sub-select column positions against table column positions

## Reproduction

```sql
create table p (id integer primary key, other integer) using memory;
create table c (id integer primary key, p_id integer not null references p(id)) using memory;
insert into p values (7, 7), (2, 7);
insert into c values (10, 7);

-- Correct: c's single row matches BOTH p rows (both have other = 7),
-- so a left join yields two rows.
select c.id from c left join p q on c.p_id = q.other;
-- [{"id":10},{"id":10}]   ✓

-- Same query, parent wrapped in a sub-select. One row is lost.
select c.id from c left join (select other from p) q on c.p_id = q.other;
-- actual:   [{"id":10}]
-- expected: [{"id":10},{"id":10}]
```

Verified on `main` at the time of writing (2026-07-29). The rewrite that drops
the join is `rule-join-elimination`; the plan for the second query contains no
join at all, only a scan of `c`.

## What goes wrong

A declared foreign key lets the planner drop a join it can prove is redundant:
if every `c` row is guaranteed to match exactly one `p` row, and nothing above
the join reads any `p` column, the join changes nothing and can go.

Deciding "the join is on the foreign key" means comparing which columns the
join equates against which columns the foreign key declares. The foreign key is
declared in terms of **the parent table's own column positions** (`p.id` is
column 0). The join condition, however, is expressed in terms of **the join
input's output positions** — and a sub-select renames, reorders, and drops
columns freely. In the repro, `q.other` is output position 0 of the sub-select
but column 1 of `p`; position 0 in `p` is `id`, exactly the column the foreign
key references. The two numbers collide, the check reports "this join is on the
foreign key", and the join is eliminated even though the equality is on an
unrelated, non-unique column.

`checkFkPkAlignment` (in `planner/util/key-utils.ts`) is where the untranslated
comparison happens. Its two callers both hand it raw output positions:

- `rule-join-elimination` — for INNER joins a later guard
  (`isRowPreservingPathToTable`) rejects a sub-select and accidentally covers
  the hole; for LEFT/RIGHT joins there is no such guard, so the repro above
  fires.
- `rule-fanout-lookup-join` — same untranslated indices on its `atMostOne-left`
  path. Not reproduced yet; whether a real query reaches it with a sub-select
  branch is an open question this ticket should answer.

## Expected behavior

Both rules must decide alignment on **base-table** column positions. A join
whose equality is on a column the foreign key does not reference must keep the
join, regardless of where that column happens to land in an intervening
sub-select's output.

`planner/util/ind-utils.ts` already grew the translation the fix needs, for the
semi/anti-join foreign-key folds:

- `resolveTableColumnMapping(node)` — resolves a subtree to the single base
  table it reads plus a per-output-column map back to that table's columns,
  built by attribute identity (a computed column maps to nothing).
- `mapColumnsToTable(cols, mapping)` — translates a set of output positions,
  declining when any has no base-table origin.

For `rule-fanout-lookup-join` note that the outer side may span several joins,
so its outer columns need a different resolution path than a single-table
subtree — worth checking before assuming the same helper drops in.

## Validation

- The repro above must return two rows, and the plan must still contain the
  join.
- The existing FK-driven eliminations must keep firing: the plan and logic
  suites under `packages/quereus/test/plan/joins/`,
  `test/optimizer/inclusion-dependencies.spec.ts`, and the join-elimination
  logic files currently pass and pin the intended folds.
- Worth adding: an outer join onto a sub-select that *does* reorder columns and
  *is* genuinely FK-covered (`select c.id from c left join (select other, id
  from p) q on c.p_id = q.id`) — that one must still eliminate, proving the fix
  translates rather than merely refuses sub-selects.
