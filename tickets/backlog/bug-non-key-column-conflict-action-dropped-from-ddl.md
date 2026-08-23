---
description: Some things a table declares are thrown away when the database saves its definition: a column's rule-violation instruction (roll the transaction back, skip the row) and a table's per-statement parameters. After reopening, the first quietly falls back to the default behaviour and the second makes the table impossible to write to at all.
files:
  - packages/quereus/src/schema/ddl-generator.ts (`formatColumnDef` — see the `NOTE:` just after the nullability annotation; `nullabilityAnnotation` below it)
  - packages/quereus/src/schema/table.ts (`columnDefToSchema` ~472-492 — the three constraint arms that write `ColumnSchema.defaultConflict`)
  - packages/quereus/src/schema/column.ts (~77 — `ColumnSchema.defaultConflict`)
  - packages/quereus/test/table-ddl-round-trip.spec.ts (the round-trip harness a new case belongs in)
  - packages/quereus/src/emit/ast-stringify.ts (~1873 `contextDefinitionsToString` — the OTHER emitter, which does emit the clause; arm 2)
  - packages/quereus/src/schema/manager.ts (~1938 — where a parsed `with context (…)` becomes `TableSchema.mutationContext`; arm 2)
repro: static
severity: wrong-result   # arm 2 is worse: the reloaded table rejects every write
likelihood: unusual
tradeoffs: Per-column `on conflict` clauses are rare in practice, and the fix needs a decision about forcing a nullability annotation in the session-elided output form purely so the action has a clause to attach to — a maintainer may reasonably decide the added DDL noise is not worth it until someone actually depends on the behaviour.
---

# A non-key column's `ON CONFLICT` action is lost when the table's definition is saved

## What happens

SQL lets a column state what should happen when a write violates it:

```sql
create table t (id integer primary key, x integer not null on conflict rollback);
```

`on conflict rollback` says: if someone tries to write NULL into `x`, roll the whole
transaction back rather than just failing the statement. The engine records that on the
column (`ColumnSchema.defaultConflict`).

Quereus persists a table by regenerating its `CREATE TABLE` text and storing that; on
reopen it re-parses the text to rebuild the schema. The text generator never writes a
non-key column's conflict action. So the instruction survives only until the database is
closed. After a reopen the column behaves as though it had said nothing — the default
(`ABORT`, which fails the statement but keeps the transaction) applies instead.

## Why it is limited to non-key columns

A sibling fix (`tickets/complete/3-ddl-primary-key-conflict-action-persisted`) made the
*primary key's* conflict action survive, by attaching it to the `PRIMARY KEY` clause the
key already emits. `ColumnSchema.defaultConflict` is a single field that a column-level
`primary key`, `not null`, or `null` clause all write to, so for a key column the action
now has somewhere to ride. A non-key column has no such clause in the emitted text.

One carve-out: a key column of an **all-columns** key is in the same position as a non-key
column, because that key emits no clause at all. That case is not this ticket — it clears
with `tickets/implement/debt-retire-synthesized-primary-key-distinction`, which makes every
key emit its clause, and the round-trip harness pins it in the meantime.

## Why it was not fixed at the same time

The natural place to attach it is the column's nullability annotation — `NOT NULL ON
CONFLICT ROLLBACK`. But that annotation is **elided** in one of the generator's two output
modes: when a `Database` is passed, a column whose nullability matches the session's
`default_column_nullability` emits no annotation at all (see `nullabilityAnnotation`). So
the fix has to either force an annotation whenever an action is present, or accept that the
action is dropped in the session-elided form. That is a deliberate choice about output
shape, not a mechanical change, which is why it is filed rather than folded in.

Note the persistence path always uses the no-`db` form, where the annotation is never
elided — so forcing it costs nothing there. The elision only affects the display/
same-session form.

## Expected behaviour

A `CREATE TABLE` emitted by `generateTableDDL` and re-parsed in a fresh `Database` should
produce a schema whose every column has the same `defaultConflict` as the original,
including non-key columns, and the emitted text should be a fixed point (a second emission
byte-identical to the first).

## Confirming it

`repro: static` — read from the code rather than executed. The claim is that
`ColumnSchema.defaultConflict` has no emission site in `ddl-generator.ts` outside the inline
`PRIMARY KEY` branch, which a grep for `defaultConflict` in that file confirms. What would
turn this into `verified`: add a case to
`packages/quereus/test/table-ddl-round-trip.spec.ts` for
`create table t (id integer primary key, x integer not null on conflict rollback)` asserting
the re-parsed `columns[1].defaultConflict` equals the original — it should fail today.

An end-to-end version would be stronger and is worth having either way: write a violating
row against a store-backed table, close and reopen, write it again, and assert the same
outcome (transaction rolled back) both times.

---

## Arm 2 — a table's mutation-context declaration is dropped the same way (added 2026-08-23)

Found while reviewing `reject-mutation-context-on-maintained-table`. Same site, same
shape as the conflict action above: the table declares something, `generateTableDDL`
never writes it, and it is gone after a save/reopen. Filed here as a second arm rather
than as its own ticket because one emission pass over `generateTableDDL` fixes both.

A table can declare **mutation-context variables** — per-statement parameters its CHECK
constraints and DEFAULT expressions read by name, and that each write supplies:

```sql
create table t (id integer primary key, v integer check (v <= cap))
	with context (cap integer);
insert into t values (1, 5) with context cap = 10;   -- works
```

`repro: verified` — run against the current tree:

- `generateTableDDL` for that table emits
  `CREATE TABLE "main"."t" ("id" INTEGER NOT NULL PRIMARY KEY, "v" INTEGER NOT NULL, constraint _check_v check on insert, update (v <= cap)) USING memory`
  — the `with context (cap integer)` clause is simply absent (a grep for `context` in
  `schema/ddl-generator.ts` finds no emission site at all).
- Executing that emitted text in a fresh database **succeeds** — the CHECK still
  mentions `cap`, but nothing declares it any more.
- The very next `insert into t values (1, 5);` fails with `Column not found: cap`, and
  so does every other write. The reloaded table is unwritable, and no `with context`
  value can rescue it because the declaration is gone.

That is worse than arm 1's silent fallback: the table survives the reload looking
healthy and then rejects all writes with a message that names a column nobody wrote.

**Two emitters disagree.** The declarative-schema path stringifies a declared table
through `emit/ast-stringify.ts`, which DOES emit `with context (…)` (an `apply schema`
of a table declaring context round-trips correctly). Only the canonical persistence
generator drops it — the same "second emitter drifted from the canonical one" pattern
`bug-shadow-rebuild-loses-table-definition` describes, but here the canonical one is
the lossy side.

**Expected behaviour.** `generateTableDDL` emits the `with context (…)` clause whenever
`TableSchema.mutationContext` is non-empty, including each variable's declared
nullability (variables are NOT NULL unless marked `null`, and the emitted text must be
explicit — the no-`db` persistence form elides nothing). Re-parsing the emitted text in
a fresh `Database` reproduces the same `mutationContext`, and a second emission is
byte-identical.

**Not affected by the maintained-table restriction.** A maintained table may no longer
declare context variables at all (rejected at declaration since
`reject-mutation-context-on-maintained-table`), so no persisted maintained-table DDL can
carry the clause — this arm is purely about ordinary tables.
