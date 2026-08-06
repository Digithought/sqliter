---
description: Two recovery behaviors for maintained tables — degrading gracefully when a rule they depend on stops working, and healing again when it comes back — no longer have any test covering them, because the only way a test could trigger them is now correctly rejected.
files:
  - packages/quereus/src/core/database-materialized-views.ts    # rebuildConstraintValidatorsFor (~226) — the catch that installs the poisoned validator; the `table_added` self-heal branch (~188)
  - packages/quereus/src/core/derived-row-validator.ts          # makePoisonedDerivedRowValidator (~317)
  - packages/quereus/test/maintained-table-declared-constraints.spec.ts   # where the deleted arms lived
  - packages/quereus/test/logic/51.8-maintained-table-declared-constraints.sqllogic
difficulty: medium
tradeoffs: These are defensive fallbacks on paths a user cannot reach from SQL, so a maintainer may reasonably decide untested-but-simple is acceptable and let them be covered incidentally whenever rollback or catalog-import coverage grows.
---

# What lost its coverage, and why

A maintained table (materialized view) may declare its own CHECK constraint, and
that CHECK may contain a subquery reading some other table. The engine keeps a
compiled validator per maintained table, and re-builds it whenever the catalog
changes underneath. Two behaviors hang off that rebuild:

- **Degrade cleanly.** If the rebuild fails because the CHECK's subquery target
  is gone, the failure is caught and a *poisoned* validator is installed
  (`makePoisonedDerivedRowValidator`). The next write into the maintained table
  then re-throws the clear, sited planning error rather than a stale validator's
  opaque module-connect failure. The catch also stops the exception escaping into
  whatever unrelated statement fired the schema-change event.
- **Heal again.** When the missing table is re-created, the `table_added` branch
  rebuilds any validator that named it, and validation returns to normal.

Both were covered — by a test that dropped the subquery target out from under
the maintained table's CHECK. `drop-guards-see-dependent-expressions-in-other-tables`
made that drop a refusal, correctly: the drop was the bug those tests were
standing on. The tests were rewritten to assert the refusal, and the self-heal
arm was deleted outright, since a maintained table cannot be declared against an
absent CHECK target either (the `create table … maintained as …` fails at build
time). There is now **no SQL sequence** that reaches either behavior.

The code is not dead. Internal paths still drop a table without going through
the DROP emitters — transaction rollback, catalog import on store reopen, and
the declarative-schema differ's drop-and-recreate — and those are exactly the
paths that can leave a validator pointing at something absent, then bring it
back. They are simply not paths a `.sqllogic` file can drive.

## What coverage should look like

Not another SQL-level test — the whole point is that SQL can no longer get
there. A unit-level test driving `SchemaManager.dropTable` (and the re-create)
directly, around a registered maintained table with a subquery CHECK, and
asserting:

- after the direct drop, a write into the maintained table's source surfaces the
  sited *table not found* error naming the missing target — not a module-connect
  failure, and not a silently-skipped validation;
- the schema-change listener itself does not throw (an unrelated statement that
  triggers the event must still succeed);
- after the target is re-created, a conforming write flows and a violating write
  is rejected by the re-resolved CHECK.

The FK-parent arm of the same rebuild is untouched and still covered — a parent
drop with no referencing rows is allowed and only rebuilds the validator — so
that arm is a working model for how to shape the new one.
