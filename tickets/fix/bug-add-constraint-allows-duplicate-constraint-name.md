---
description: Adding a constraint to a table with a name another constraint on that table already uses is accepted instead of rejected, leaving the table with two constraints answering to one name.
prereq:
files:
  - packages/quereus/src/runtime/emit/add-constraint.ts        # runAddConstraintViaModule / runAddCheckEngineSide — the unguarded site
  - packages/quereus/src/runtime/emit/alter-table.ts           # namedConstraintExists (~1193) — the check RENAME already does; runAddColumn (~535) shares the site's behaviour
  - packages/quereus/test/logic/41.6-alter-drop-rename-constraint.sqllogic
difficulty: medium
repro: verified
---

## What happens

Constraint names are supposed to be unique within a table — `ALTER TABLE …
RENAME CONSTRAINT` enforces exactly that and refuses to rename a constraint onto
a name already in use. `ALTER TABLE … ADD CONSTRAINT` has no equivalent check, so
the same collision is accepted when it arrives by addition instead of rename.

Reproduced on both storage backends (memory and the persistent store), for both
CHECK and UNIQUE:

```sql
create table t (id integer primary key, a integer, b integer, constraint ck check (a > 0));
alter table t add constraint ck check (b > 0);
-- accepted; check_constraint_info('t') now reports two rows named 'ck'
```

```sql
create table t (id integer primary key, a text, b text, constraint uq unique (a));
alter table t add constraint uq unique (b);
-- accepted on the persistent store backend;
-- unique_constraint_info('t') now reports two rows named 'uq'
```

`ALTER TABLE … ADD COLUMN` with an inline named constraint reaches the same
site and behaves the same way.

The UNIQUE case happens to be refused on the *memory* backend today, but only by
accident and with a misleading message: that backend materializes each UNIQUE
constraint's hidden backing index into the table's index list, so an unrelated
guard (the constraint-name-vs-index-name collision check added by
`bug-unique-constraint-name-collides-with-index-name`) trips over the *first*
constraint's own hidden structure and reports

```
Cannot add constraint 'uq' to table 't': its backing index 'uq' would collide with
existing index 'uq' on the same table. Rename the constraint or the index.
```

There is no index named `uq` that the user created, so the message points at an
object they cannot see. On the persistent store backend, which keeps that
structure internal, the guard sees nothing and the duplicate is accepted.

## Why it matters

A name that addresses two constraints makes every by-name operation ambiguous:
`DROP CONSTRAINT ck` removes one and silently leaves the other still enforcing;
`RENAME CONSTRAINT ck TO …` moves one of them and leaves a same-named sibling
behind, re-creating a collision the rename check exists to prevent. On the
persistent backend the duplicate round-trips through the saved schema, so it
survives close and reopen.

## Expected behaviour

`ALTER TABLE … ADD CONSTRAINT <name> …` — and an inline named constraint on
`ALTER TABLE … ADD COLUMN` — should be refused when `<name>` already addresses a
CHECK, UNIQUE or FOREIGN KEY constraint on that table, with a message in the same
shape the rename path already produces:

```
Cannot rename constraint to 'ck': a constraint with that name already exists in table 't'
```

The refusal must land **before** the statement reaches the storage module, so it
is identical on both backends and a rejected statement persists nothing — the
same placement the other pre-dispatch checks at that site use.

Once this lands, the accidental memory-backend refusal above stops being
reachable: the duplicate name is caught first, by the check that can name the
real culprit.

## Open questions for whoever picks this up

- **Unnamed constraints are out of scope** — they have no name to collide. Only
  an explicitly named one should be checked.
- **Is any existing behaviour relying on re-adding a same-named constraint as an
  idempotent no-op?** The declarative-schema differ (`apply schema`) emits
  `ALTER TABLE … ADD <constraint>` for constraints it believes are missing; it
  should never emit one that already exists, but that is worth confirming
  against the differ's tests before tightening the write path.
