----
description: Adding a rule like "this column must always be positive" to a table that already holds rows breaking that rule is accepted without complaint, so the table ends up storing data its own rules say is impossible.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts        # addCheckConstraint (~3077) — the memory backend's CHECK arm, schema-only
  - packages/quereus-store/src/common/store-module-alter.ts  # alterAddConstraint (~550-610) — the store backend's CHECK arm, same omission
  - docs/design-isolation-challenges.md                      # §§ around lines 91/93 enumerate which DDL validates existing rows; CHECK is absent from that list
  - packages/quereus/test/alter-table-conformance.spec.ts    # where the generalized test below belongs
repro: verified
severity: wrong-result
likelihood: normal-use
tradeoffs: Validating on add means a statement that succeeds today starts failing, so anyone who has been adding CHECK constraints to already-populated tables gets a new error; and the scan costs a full table read on a large table, which the current arm avoids entirely.
----

# `alter table … add constraint … check` never looks at the rows already in the table

## What happens

Take a table that already holds a row breaking a rule, then add that rule as a CHECK
constraint:

```sql
create table orders (id integer primary key, note text null);
insert into orders (id, note) values (1, 'bad');
alter table orders add constraint c_note check (note = 'good');   -- succeeds
```

The statement is accepted. `orders` now holds a row that its own CHECK constraint says
cannot exist. Nothing reports it, then or later — the constraint is enforced only on
subsequent inserts and updates.

The sibling forms of the same statement do NOT behave this way. Both were run against
violating rows and both reject:

| statement | against violating rows |
|---|---|
| `add constraint … unique` | `UNIQUE constraint failed: orders (note)` |
| `add constraint … foreign key` | `FOREIGN KEY constraint failed: orders (pid) has rows referencing a missing 'parent'` |
| `add constraint … check` | **accepted** |

So this is one arm out of step with its own statement, not a deliberate uniform posture.

## Why it matters beyond the stored row

A CHECK constraint is a statement of fact about the table. Anything that trusts it —
today's query planning, tomorrow's predicate simplification, a downstream consumer reading
the schema to decide what values are possible — can be wrong about rows already there. And
a device that syncs the table to another device replicates the constraint but not the
knowledge that some rows violate it.

## Where it comes from

Both storage backends implement the CHECK arm as schema-only, each with a comment saying
so and citing the engine's earlier in-emitter behaviour as the precedent:

- `packages/quereus/src/vtab/memory/layer/manager.ts` — `addCheckConstraint`: *"Schema-only:
  a CHECK has no covering structure and (matching the engine's prior in-emitter behavior)
  no existing-row validation"*.
- `packages/quereus-store/src/common/store-module-alter.ts` — `alterAddConstraint`'s
  `check` branch: the same wording.

Neither comment is an accepted-tradeoff decision with a stated reason to keep it; both
describe the omission and attribute it to what the code used to do.

## What the fix should cover

The point fix is one arm per backend: scan the rows the issuing transaction can see (the
same effective-rows source the UNIQUE arm already uses, so an uncommitted insert in the
same transaction counts) and reject before persisting the constraint.

The more valuable half is a **generalized test**, because this arm was the one that fell
out of a set of siblings that otherwise agree. One table-driven case per tightening form —
`set not null`, `add constraint unique`, `add constraint check`, `add constraint foreign
key`, `create unique index`, and any future form — each seeded with a violating row and
each asserting a rejection, run against both backends. That is what stops the next arm
from being added without a scan.

## Expected behaviour

- Adding a CHECK constraint to a table holding a violating row fails, and the table is
  left exactly as it was — no constraint added, no partial state.
- Adding one to a table whose rows all satisfy it succeeds, as today.
- Rows the issuing transaction has inserted but not yet committed count as present, the
  same way the UNIQUE arm treats them.

## Notes for whoever picks this up

- `docs/design-isolation-challenges.md` enumerates the DDL that inspects existing rows and
  omits the CHECK arm; that list becomes wrong once this lands and needs updating with it.
- The sync layer's apply-order classifier (`validatesExistingRows` in
  `packages/quereus-sync/src/sync/store-adapter.ts`) already treats a CHECK add as
  row-validating and applies it after a batch's rows, so it needs no change when this is
  fixed — but its comment cites this ticket and should be trimmed once the gap closes.
