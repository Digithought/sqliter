----
description: When a table's definition changes, the database corrects the new definition as it files it away, but tells everyone else about the uncorrected version — so listeners can cache a definition the database itself rejected. One real bug from this was already fixed by hand; nothing stops the next one.
files:
  - packages/quereus/src/schema/schema.ts                             # Schema.addTable — corrects on the way in, returns what it stored
  - packages/quereus/src/runtime/emit/alter-table.ts                  # ~15 register-then-announce sites; the DROP COLUMN one is the fixed instance
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts    # more of the same pattern, incl. paths that reshape a maintained table's columns
  - packages/quereus/src/schema/manager.ts                            # more of the same pattern
  - packages/quereus/src/schema/change-notifier.ts                    # where a boundary check would live
  - packages/quereus-store/src/common/store-module-schema-sync.ts     # the listener that caches the announced schema (updateSchema)
difficulty: medium
tradeoffs: The announced and registered definitions are identical on nearly every path today, so this buys no user-visible behavior on its own — and a check that fires on the legitimate exceptions (an announcement made under a different name, or before the registration) would be noise a maintainer has to suppress rather than a guard they trust.
----

# Announcing a table change should announce what was actually registered

## The situation

Registering a table definition is not always the identity. `Schema.addTable` corrects what
it is handed — today it drops recorded statistics naming a column the definition does not
have — and stores the corrected copy. Until recently it returned nothing, so a caller kept
holding its own uncorrected object.

Most callers only register, and for them this is invisible. But the common shape in the
DDL code is *register, then announce*:

```
schema.addTable(updated);
notifyChange({ type: 'table_modified', newObject: updated });   // the UNCORRECTED copy
```

and one listener — the storage module — caches the announced definition as its own working
copy of the table. Its later ALTER arms build their result by copying that cached copy, so
anything the catalog corrected gets rebuilt and handed straight back.

## The instance already fixed

`drop column k` then `add column k` gave the brand-new, empty column the dropped column's
recorded measurements. The catalog had correctly dropped them; the announcement carried
them anyway; the storage module cached them; the next ALTER copied them forward; and the
name was live again by then, so the catalog's own check had nothing to object to.

Fixed by hand at that one site (announce the return value of `addTable`), with a
regression test. `addTable` now returns the definition it registered, and its
documentation states the rule.

## Why that is not enough

There are roughly forty registration sites across the DDL code, about fifteen of which
announce or persist the same object immediately afterwards. Nothing checks that the
announced definition matches the registered one — a reviewer has to notice, per site.
Today the two differ only where a change removes a column from a table that has recorded
statistics, which is rare; but the divergence is structural, and the next correction added
to `addTable` widens it everywhere at once.

## What's wanted

A guard that catches the whole class rather than a sweep that fixes today's instances,
because a sweep does not survive the next new DDL arm. The shape that fits: when a
`table_modified` announcement is made, check that the definition it carries is the one the
catalog holds under that name, and complain loudly when it is not.

The known legitimate exceptions have to be part of the design rather than discovered
afterwards:

- a rename announces under the *new* name while the old entry is being removed;
- some paths deliberately announce before registering, or announce a definition that is
  about to be replaced by a further step in the same statement;
- an announcement about a table that is being dropped has no registered definition to
  compare against.

If those cannot be told apart cleanly, the fallback is a test that drives every DDL
statement form and asserts the announced definition equals the registered one — weaker,
but it needs no exception list and it fails on a new arm that gets this wrong.

## Expected outcome

A new DDL arm that registers a definition and then announces a different object is caught
automatically, rather than surfacing later as a listener acting on a definition the
catalog had already rejected.
