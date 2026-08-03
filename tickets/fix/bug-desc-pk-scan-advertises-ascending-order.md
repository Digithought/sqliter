---
description: Any query that joins an in-memory table whose primary key is declared descending silently returns the wrong rows — most of the matching rows just vanish.
files:
  - packages/quereus/src/vtab/memory/module.ts
  - packages/quereus-store/src/common/store-module-access-plan.ts
  - packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts
  - packages/quereus/test/vtab/multiseek-key-order.spec.ts
difficulty: easy
repro: verified
---

# A `desc` primary key is read backwards but reported as ascending

## Repro

```sql
create table dpk (id integer, v text, primary key (id desc));
create table small (id integer primary key);
insert into dpk values (1,'a'),(2,'b'),(3,'c');
insert into small values (1),(2),(3);

select id from dpk where id in (select id from small);
```

Observed: `[3]`. Expected: `[1, 2, 3]` (in some order).

Ran on the memory backend at `ffa64351` via `db.eval`. Every equi-join shape
against the table is affected, not just `IN`:

| query                                                          | observed                                | expected            |
| -------------------------------------------------------------- | --------------------------------------- | ------------------- |
| `select id from dpk where id in (select id from small)`          | `[3]`                                   | `[1,2,3]`           |
| `select id from dpk d where exists (select 1 from small s where s.id = d.id)` | `[3]`                     | `[1,2,3]`           |
| `select d.id from dpk d join small s on s.id = d.id`             | `[3]`                                   | `[1,2,3]`           |
| `select d.id, s.id from dpk d left join small s on s.id = d.id`  | `3→3, 2→null, 1→null`                   | all three matched   |

A plain `select id from dpk` (no join) is correct — it returns `3,2,1`, which is
the table's real emission order.

## What is wrong

`packages/quereus/src/vtab/memory/module.ts:362-378` advertises "this scan comes
back in primary-key order" whenever the caller did not ask for a specific order.
It builds that advertisement from the table's primary-key definition but
hard-codes the direction:

```ts
const pkOrdering: OrderingSpec[] = tableInfo.primaryKeyDefinition.map(col => ({
    columnIndex: col.index,
    desc: false          // <-- ignores col.desc
}));
```

`primaryKeyDefinition` carries the real flag (`[{ index: 0, desc: true, collation: 'BINARY' }]`
for the table above), and the underlying B-tree really is walked descending. So
the planner is told "ascending" about a stream that arrives descending.

The planner then picks a merge join on the strength of that advertisement. A
merge join advances whichever side is behind by comparing keys under the
declared direction; with one side actually running backwards the two cursors
walk away from each other and all but one row is dropped. Nothing downstream can
detect this — the rows are simply not emitted.

Note the ordering is right in the one place a user would notice directly:
`select id from dpk order by id` returns `1,2,3`, because an explicit `ORDER BY`
takes the `adjustPlanForOrdering` path, which reads the direction correctly and
leaves a Sort in place. Only the no-`ORDER BY` advertisement is wrong, and its
only consumers are join/streaming rules — which is why this hides.

## Expected behaviour

- The advertised primary-key ordering must carry each key column's declared
  direction, so it describes the order the scan actually emits.
- Every equi-join shape over a `desc`-primary-key table returns the same rows it
  would return if the key were declared ascending. That includes `IN (select …)`,
  `EXISTS`, inner join, left join, and semi/anti shapes, on both the memory and
  the persistent-store backends.
- A multi-column primary key with mixed directions (`primary key (a, b desc)`)
  must advertise per-column directions, not one flag for the whole key.

## Notes for whoever picks this up

- The persistent store has its own primary-key ordering advertisement
  (`packages/quereus-store/src/common/store-module-access-plan.ts`, the
  `computePkOrdering` helper). It reads the PK direction flags rather than
  hard-coding, so it is probably already correct — confirm with the same repro
  under `yarn test:store` rather than assuming.
- Emission order for a `desc` key is already pinned for the multi-seek path in
  `packages/quereus/test/vtab/multiseek-key-order.spec.ts` ("serves a DESC-PK
  multi-seek in descending key order"), so the backend behaviour is the settled
  half; only the advertisement disagrees with it.
- Once the advertisement is truthful, a merge join between a `desc`-keyed side
  and an `asc`-keyed side should stop being selected (the directions no longer
  match) and fall back to hash/nested-loop. Check the join-selection rules
  actually compare direction and do not merely compare column positions —
  otherwise the same wrong answer survives the fix.
- Worth a regression test at the SQL level (a `.sqllogic` case is enough) so both
  backends are covered by one file.
