---
description: Adding a constraint to a table under a name another constraint on that table already uses is accepted instead of rejected, leaving the table with two constraints answering to one name — after which dropping or renaming that name misbehaves or stops working entirely.
prereq:
files:
  - packages/quereus/src/runtime/emit/add-constraint.ts        # emitAddConstraint's `run` — the unguarded site for ALTER TABLE ADD CONSTRAINT
  - packages/quereus/src/schema/table.ts                       # resolveNamedConstraintClass ~140 — where the shared helper should live
  - packages/quereus/src/runtime/emit/alter-table.ts           # namedConstraintExists ~1193 (move out); runAddColumn's inline-constraint block ~528-550
  - packages/quereus/src/schema/catalog.ts                     # assertUniqueConstraintIndexNameFree ~453 — the neighbouring guard, do not disturb its message
  - packages/quereus/test/logic/41.6-alter-drop-rename-constraint.sqllogic   # § 7 "Error cases" — add the new refusals here (runs under memory AND store)
  - packages/quereus/test/alter-add-constraint.spec.ts         # unit coverage for the ADD COLUMN inline arm + message shape
  - packages/quereus/test/alter-drop-rename-constraint.spec.ts # line ~95 pins the existing index-collision message — must keep passing
difficulty: medium
repro: verified
---

# Duplicate constraint names slip in through ADD CONSTRAINT

Constraint names are meant to be unique within a table. `ALTER TABLE … RENAME
CONSTRAINT` enforces that and refuses to rename a constraint onto a name already
in use. `ALTER TABLE … ADD CONSTRAINT` has no equivalent check, so the same
collision is accepted when it arrives by addition instead of by rename.

## What was observed

Run against the in-memory backend (`new Database()`, default module), each case
in a fresh database:

| statement pair | result today |
| --- | --- |
| `constraint ck check (a > 0)` at create, then `add constraint ck check (b > 0)` | **accepted** — `check_constraint_info('t')` returns two rows named `ck` |
| `constraint fk foreign key (x) …` at create, then `add constraint fk foreign key (y) …` | **accepted** — `foreign_key_info('c')` returns two rows named `fk` |
| `constraint dup check (a > 0)` at create, then `add constraint dup unique (b)` | **accepted** — one CHECK and one UNIQUE both named `dup` |
| `add column b integer constraint ck check (b > 0)` where `ck` already exists | **accepted** — two rows named `ck` |
| `constraint uq unique (a)` at create, then `add constraint uq unique (b)` | refused, but by the wrong guard and with a misleading message (below) |

The damage each duplicate causes, also observed:

- **Same class (two CHECKs named `ck`)** — `alter table t drop constraint ck`
  removes *both* of them in one statement, and `alter table t rename constraint
  ck to ck2` renames *both*, so the table still has two constraints sharing one
  name, now under the new name.
- **Different classes (a CHECK and a UNIQUE both named `dup`)** — both
  `drop constraint dup` and `rename constraint dup to other` fail permanently
  with `Constraint name 'dup' is ambiguous in table 't' (present in more than one
  of CHECK / UNIQUE / FOREIGN KEY)`. Neither constraint can be removed or renamed
  through SQL again.

On the persistent store backend the duplicate is written to the saved schema, so
it survives close and reopen.

### The UNIQUE case's misleading refusal

The UNIQUE-onto-UNIQUE case happens to be refused on the memory backend today,
but by an unrelated guard. That backend materializes each UNIQUE constraint's
hidden backing index into the table's index list, so the constraint-name-vs-index-name
check (`assertUniqueConstraintIndexNameFree`) trips over the *first* constraint's
own hidden structure and reports:

```
Cannot add constraint 'uq' to table 't': its backing index 'uq' would collide with
existing index 'uq' on the same table. Rename the constraint or the index.
```

There is no index named `uq` the user created — the message points at an object
they cannot see. The persistent store backend keeps that structure internal, so
the guard sees nothing there and the duplicate is accepted. Same statement, two
different outcomes.

## Expected behaviour

`ALTER TABLE … ADD CONSTRAINT <name> …`, and an inline **named** constraint on
`ALTER TABLE … ADD COLUMN`, must be refused when `<name>` already addresses a
CHECK, UNIQUE or FOREIGN KEY constraint on that table. Message shape mirrors the
rename path's existing wording, with `StatusCode.CONSTRAINT`:

```
Cannot add constraint 'ck' to table 't': a constraint with that name already exists
```

Matching is case-insensitive, like every other constraint-name comparison in the
engine (`resolveNamedConstraintClass`, `namedConstraintExists`).

The refusal must land **before** the statement reaches the storage module, so it
is identical on both backends and a rejected statement persists nothing — the
same placement the other pre-dispatch checks at that site already use (the FK
collation check and `assertUniqueConstraintIndexNameFree`). For ADD CONSTRAINT
that means inside `emitAddConstraint`'s `run`, *above* the CHECK-engine-side /
module-routed branch, so both arms are covered by one guard.

## Design decisions already settled

**Unnamed constraints are out of scope.** `alter table t add unique (b)` has no
user-supplied name to collide; skip when `constraint.name` is undefined. The
engine-synthesized `_uc_*` / `_check_*` / `_fk_*` names are not user identity and
are not compared.

**CREATE TABLE is out of scope and must not change.** A `create table` that
declares two constraints under one name is accepted today and is *depended on* by
existing coverage — `test/logic/41.6-alter-drop-rename-constraint.sqllogic` § 7
builds table `e_amb` exactly that way to assert the ambiguous-drop error. Tighten
only the ALTER write paths.

**The new check runs before the index-name check.** That ordering is what makes
the two backends agree: on memory the index guard would otherwise keep firing
first on the constraint's own hidden index and produce the misleading message
above, while on store nothing fires at all. With the name check first, both
backends give the same refusal for the same statement, and the index guard keeps
owning the case it was written for (a name held by a *real* user index and by no
constraint) — `alter-drop-rename-constraint.spec.ts` ~line 95 pins that message
and must keep passing.

One consequence, accepted deliberately: when the existing same-named constraint
is a UNIQUE synthesized from `CREATE UNIQUE INDEX` (`derivedFromIndex` set), the
new message says a constraint with that name exists rather than naming the index.
That is still true, and it is what the rename path already reports for the same
shape. Leave a short code comment saying so rather than special-casing it.

**Where the helper lives.** `namedConstraintExists` is currently a private
function in `runtime/emit/alter-table.ts` (~line 1193). Move it to
`src/schema/table.ts` beside `resolveNamedConstraintClass`, which it mirrors, and
export it; the rename path imports it from there. Do not copy it — two copies of
a name-matching rule drift.

**The declarative differ was checked and is not affected.** `apply schema`
emits `ALTER TABLE … ADD <fragment>` from `TableAlterDiff.constraintsToAdd`,
which is populated only for a declared constraint with no matching actual, or for
the new side of a body change — and `generateMigrationDDL`
(`src/schema/schema-differ.ts` ~2570-2595) emits every `DROP CONSTRAINT` before
every `ADD`, so the old side is gone by the time the add runs. No differ path
re-adds a name that is still present. Nothing relies on ADD CONSTRAINT being an
idempotent no-op. The differ's own idempotency tests
(`test/declarative-equivalence.spec.ts` ~2180 / ~2219 / ~2284) re-diff rather than
re-add, so they are unaffected — but run them.

## Reproduction

Both the memory results above and the store-backend acceptance were reproduced
directly. A throwaway spec constructing `new Database()` and running the
statement pairs, then reading `check_constraint_info` / `unique_constraint_info` /
`foreign_key_info`, is enough to see all of it; the permanent coverage belongs in
the two test files listed under `files:`.

## TODO

- Move `namedConstraintExists` from `runtime/emit/alter-table.ts` to
  `src/schema/table.ts` next to `resolveNamedConstraintClass`, export it, and
  update the rename path's call site to import it.
- In `runtime/emit/add-constraint.ts`, inside `emitAddConstraint`'s `run` and
  above the CHECK-engine-side / module-routed branch, refuse when
  `constraint.name` is set and `namedConstraintExists(tableSchema, constraint.name)`
  — `StatusCode.CONSTRAINT`, message per *Expected behaviour*. Comment why it sits
  above the branch (covers both arms) and above the module dispatch (nothing
  persists on refusal).
- In `runtime/emit/alter-table.ts`'s `runAddColumn`, extend the existing
  pre-`module.alterTable` loop over `inlineConstraints` (~line 528-550, where
  `assertUniqueConstraintIndexNameFree` already runs) to refuse an inline
  **named** constraint whose name already exists on the table. Place the name
  check ahead of the index-name check, same ordering rationale as above.
- Cover the case where a single `ADD COLUMN` declares two inline named
  constraints under the same name as each other (e.g.
  `add column b integer constraint x check (b > 0) constraint x unique`) — the
  table-side check alone will not catch it, since neither exists yet when the
  loop runs. Accumulate the names seen within the statement.
- Confirm the refusal leaves the table completely untouched: no column added, no
  constraint installed, nothing persisted. `runAddColumn`'s guard runs before the
  column is materialized, so this should hold without touching `revertAddColumn`
  — assert it rather than assume it.
- Extend `test/logic/41.6-alter-drop-rename-constraint.sqllogic` § 7 with the
  refusals (CHECK-onto-CHECK, UNIQUE-onto-UNIQUE, FK-onto-FK, cross-class
  CHECK-onto-UNIQUE, and an inline named constraint on ADD COLUMN), plus a
  negative control that an unnamed `add unique (…)` alongside an existing named
  UNIQUE still succeeds. This file runs under both `yarn test` and
  `yarn test:store`, which is how backend parity gets pinned.
- Add unit coverage in `test/alter-add-constraint.spec.ts` for the message text
  and `StatusCode.CONSTRAINT`, and for the ADD COLUMN inline arm leaving the
  table unchanged.
- Verify `test/alter-drop-rename-constraint.spec.ts`'s
  "a refused UNIQUE declaration never leaves two indexes sharing a name" still
  reports `would collide with existing index 'foo'` — its `foo` is a plain
  (non-unique) index, so no constraint named `foo` exists and the new guard must
  not intercept it.
- Run `yarn test`, then `yarn test:store` (this change is specifically about the
  two backends agreeing), and `yarn lint`.
