description: Updating any column of a parent row wrongly rewrites its child rows, even when the column the children point at never changed — with "set null" or "set default" child links that silently loses the link.
files:
  - packages/quereus/src/runtime/foreign-key-actions.ts   # executeForeignKeyActions / executeSingleFKAction — no referenced-column-change gate
  - packages/quereus/src/runtime/emit/dml-executor.ts     # processUpdateRow calls executeForeignKeyActionsAndLens after every row update
  - packages/quereus/test/logic/41-foreign-keys.sqllogic  # where the regression cases belong
difficulty: medium
---

# Parent-update foreign-key actions run even when the referenced key did not change

## Expected behavior

A foreign key's `on update` action (`cascade` / `set null` / `set default`) exists to
propagate a change to the parent's **referenced** columns. An UPDATE that leaves those
columns alone must not touch the child rows at all — this is standard SQL behavior and
what every other enforcement site in this engine already does (the RESTRICT pre-checks and
the plan-time parent-side check all skip when no referenced column changed).

## Actual behavior

The action executor has no such gate: after every parent row update it re-issues the
child DML unconditionally. Reproduced on a plain in-memory database:

```sql
create table p (id integer primary key, other integer);
create table c (cid integer primary key, p_id integer default 99,
    foreign key (p_id) references p(id) on update set default);
insert into p values (1, 100), (99, 0);
insert into c values (10, 1);

-- Touches only `other`. `id` — the column c.p_id references — is untouched.
update p set other = 200 where id = 1;

select cid, p_id from c;   -- observed: p_id = 99   expected: p_id = 1
```

The child row silently stopped pointing at the parent it was inserted against. Three
severities, same root cause:

- **`on update set default` — silent data loss.** As above: the child is re-pointed at the
  default value's row (or orphaned/errored if no such parent exists).
- **`on update set null` — silent data loss, or a bogus error.** The child FK column is
  nulled. When the child FK column cannot hold NULL the statement fails instead, with a
  confusing `NOT NULL constraint failed: c.p_id` blamed on an UPDATE that never mentioned
  the child.
- **`on update cascade` — wasted work and spurious change notifications.** The child is
  rewritten to the value it already holds, so the stored value survives, but a real child
  UPDATE runs (storage write, materialized-view maintenance) and a data-change event is
  emitted for the child with an empty changed-column list. Anything consuming the change
  feed (subscriptions, the sync engine) sees a phantom child update.

## Scope

The fix belongs in the action executor, not at its call site — the gate must apply to
the physical walker (`executeForeignKeyActions` → `executeSingleFKAction`) and, if it has
the same hole, to its lens counterpart. A shared helper for exactly this question already
exists in the same file (`anyReferencedColumnChanged`, used by all the RESTRICT sites), so
the gate should reuse it rather than grow a second comparison.

Note that by the time the executor runs, the DML executor has already handed it the
*stored* (type-coerced) new row, so the values compared are apples-to-apples.

Regression coverage should pin all three actions, both directions (untouched referenced
column ⇒ child untouched; genuinely changed referenced column ⇒ action still fires), and
for `cascade` should assert the *absence* of a child data-change event, not just the final
child value — the final value is already correct today, so a value-only assertion would
not catch the phantom write.
