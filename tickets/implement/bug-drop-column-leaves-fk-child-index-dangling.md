---
description: Dropping a column from a table that has a foreign key breaks the table — the next insert either crashes with an internal error or starts checking the wrong column against the parent table.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts        # dropColumn (~1987) — the BUG comment at ~2040 marks the exact spot; shiftSchemaIndicesForInsert (~101) is the mirror image to copy from
  - packages/quereus-store/src/common/store-module.ts        # alterDropColumn (~1736) — same gap, same fix
  - packages/quereus/src/runtime/emit/alter-table.ts         # runDropColumn (~815) — no change expected; takes the module's foreignKeys through verbatim
  - packages/quereus/test/logic/41.3-alter-add-column-unique.sqllogic  # style reference for a both-modules test
  - docs/sql-ddl.md                                          # DROP COLUMN section (~561) — document the new rule next to the UNIQUE one
difficulty: medium
---

# DROP COLUMN must renumber (and prune) the table's own foreign keys

## Background

A table's foreign keys record which of *its own* columns they constrain by **position**
(`foreignKeys[].columns` is an array of indices into that table's column list), not by name.

`alter table … drop column` renumbers the primary key, the secondary indexes and the UNIQUE
constraints when a column disappears from before them. It never touches the foreign keys. The
mirror-image operation — inserting a column at a position — *does* shift them
(`shiftSchemaIndicesForInsert` in the memory module); only the drop side was missed.

## Confirmed behavior today

Reproduced against the memory module at `4a3e92d7`. All five cases below were run; `foreign_keys`
pragma on throughout.

| # | Setup | After `drop column` | Result |
|---|---|---|---|
| A | `t(id pk, a, fkcol → p.pid)`, drop `a` | columns `id, fkcol`; fk still records position 2 | next insert throws raw `TypeError: Cannot read properties of undefined (reading 'name')` |
| B | `t(id pk, fkcol → p.pid, z)`, drop `fkcol` | columns `id, z`; fk still records position 1 — now `z` | **silently wrong**: the fk now constrains the unrelated text column `z` against `p.pid`, so `insert into t values (11,'r')` is rejected as a constraint violation |
| C | `t(id pk, x, y)` with `foreign key (x,y) → p(a,b)`, drop `y` | columns `id, x`; fk still records positions 1 **and** 2 | same raw `TypeError` |
| D | `t(id pk, fkcol → p.pid, z)`, drop trailing `z` | fk position 1 unchanged and still correct | correct — control case, must stay correct |
| E | same as A but `on delete cascade`, then `delete from p` | as A | same raw `TypeError` from the cascade path |

Case B is the more serious of the two failure modes: no error is raised at `alter` time and the
table quietly starts enforcing a foreign key against a column that was never declared to have one.

`foreign_key_info('t')` reads `table.columns[fk.columns[seq]].name` and so raises the same
`TypeError` on a dangling index — it is a convenient assertion vehicle once fixed.

## Required behavior

**Surviving foreign keys shift.** A foreign key none of whose columns are dropped keeps
constraining exactly the columns it did before; every recorded position greater than the dropped
one decrements by one.

**A foreign key that loses any of its columns is removed outright.** This mirrors the call the
UNIQUE path already made (see the comment above `remainingUniqueConstraints` in the memory
module's `dropColumn`): a foreign key missing one of its child columns is a *different*
constraint against the parent's key, not a narrowed one, so narrowing it would be wrong and
leaving it in place is what produces case B. Removal applies to single-column and multi-column
foreign keys alike. When no foreign keys survive, the field goes back to `undefined` — the same
shape `dropConstraint` already produces when it removes the last one.

This is a deliberate divergence from SQLite, which refuses the drop instead. It matches what this
engine already does for UNIQUE, and it keeps the engine's own `ADD COLUMN` revert path (which
drops the just-added column unconditionally) working.

**Parent-side foreign keys are out of scope.** A foreign key in *another* table pointing *at* the
dropped column is a separate problem; do not try to solve it here. It resolves parent columns by
name at enforcement time, not by the index stored here.

**No `TypeError` may escape under any drop.** The failure mode for a genuine violation is the
ordinary foreign-key constraint error.

## Both modules

The memory module and the store module each have their own DROP COLUMN implementation and both
have the gap:

- memory: `MemoryTableManager.dropColumn` — the schema rebuild spreads `...this.tableSchema`, so
  `foreignKeys` rides through unshifted. A `BUG (pre-existing, …)` comment sits exactly at the
  spot and names this ticket; delete it as part of the fix.
- store: `StoreModule.alterDropColumn` — `updatedSchema` spreads `...oldSchema` the same way.
  The store also persists its DDL (`saveTableDDL`), so the corrected foreign keys must round-trip
  across a reconnect.

The isolation module forwards `alterTable` to its underlying module and does no index arithmetic
of its own, so it needs no change.

Keep the two implementations reading alike — the store's UNIQUE-pruning comment already
cross-references the memory one.

## Testing

Prefer a `.sqllogic` case under `packages/quereus/test/logic/` so the same assertions run under
both the memory module (`yarn test`) and the store module (`yarn test:store`) — see
`41.3-alter-add-column-unique.sqllogic` for the pattern and the header-comment style. Assert via
`foreign_key_info('t')` (module-agnostic, reads the engine catalog) plus real inserts/deletes.

Cover: A (shift), B (whole key removed when its only child column goes), C (whole multi-column key
removed when one of its columns goes), D (unaffected key still enforces), E (cascade action still
fires correctly after a preceding drop), and the case where removing the last foreign key leaves
none.

Declare the foreign keys with `create table` (not `alter table add column … references …`) —
constraints added by the latter never reach the module at all today, which is a separate defect
tracked by `add-column-inline-check-fk-never-reach-module`.

## TODO

- Memory module `dropColumn`: partition `foreignKeys` into "includes the dropped column" (remove)
  and "does not" (shift indices greater than the dropped one down by one); set `undefined` when
  none survive. Replace the `BUG (pre-existing, …)` comment with a short note stating the rule.
- Store module `alterDropColumn`: same partition/shift over `oldSchema.foreignKeys`, matching the
  neighbouring UNIQUE-pruning block's shape and comment style.
- Confirm nothing else in either module caches a foreign-key column index across the drop.
- Add the `.sqllogic` coverage described above.
- Update `docs/sql-ddl.md` DROP COLUMN section: add a paragraph next to the existing UNIQUE one
  stating the shift-or-remove rule and the SQLite divergence.
- `yarn test`, `yarn test:store` (this change is squarely in the store's path), `yarn lint`.
