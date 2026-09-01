description: When the engine has to rebuild a table behind the scenes to change its key, it writes out the new table's definition by hand and leaves parts out — the table comes back without its validation rules, its uniqueness rules, its links to other tables, its labels, and sometimes with the wrong key entirely. Make the rebuild use the one official definition writer instead.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts        # buildShadowTableDdl ~2033-2073; rebuildViaShadowTable ~2178-2233; rebuildTableWithNewShape ~2001; call site ~1957
  - packages/quereus/src/schema/ddl-generator.ts            # generateTableDDL (~52), generateIndexDDL (~182) — the canonical emitters to defer to
  - packages/quereus/src/schema/table.ts                    # TableSchema / PrimaryKeyColumnDefinition shape
  - packages/quereus/test/runtime/shadow-ddl.spec.ts        # every assertion in this spec has to be rewritten for the canonical form
  - packages/quereus/test/no-alter-module.ts                # the stub backend that reaches this path; needs createIndex/dropIndex forwarding to test index survival
  - packages/quereus/test/alter-table-conformance.spec.ts   # existing honored-rebuild arm (~616) and `expectKeyFlagsAgreeWithDefinition`
difficulty: hard
repro: verified

# Rebuild a table through the canonical DDL writer, not a hand-rolled one

## Background

`alter table … alter primary key` first asks the storage backend to re-key itself. A backend
that cannot raises `UNSUPPORTED`, and the engine falls back to a **rebuild**: create a shadow
table with the new key, copy the rows over, drop the original, rename the shadow into place
(`rebuildViaShadowTable`).

The shadow's `CREATE TABLE` text is produced by `buildShadowTableDdl` — a second, hand-rolled
DDL writer that renders only columns, the new key, and the `using` clause. The engine already
has one canonical writer, `generateTableDDL`, which is what everything else persists and
compares against. The hand-rolled one has drifted from it, and everything the shadow's text
does not mention is gone from the rebuilt table.

Neither shipped backend reaches this path (memory and the store both re-key in place), so this
bites a third-party backend. It is still a data-loss defect: the rebuilt table stops enforcing
rules it declared.

## What was reproduced

Ran against `makeNoAlterModule({ withRenameTable: true })` (the stub for a backend that cannot
re-key in place), comparing `generateTableDDL` output before and after the rebuild.

**Table constraints and tags are dropped.**

```
BEFORE: CREATE TABLE "main"."t" ("a" INTEGER NOT NULL, "b" TEXT NULL, "c" INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY ("a", "b", "c"), check on insert, update (c >= 0), unique (b)) USING noalter WITH TAGS (k = 'v')

AFTER:  CREATE TABLE "main"."t" ("a" INTEGER NOT NULL, "b" TEXT NULL PRIMARY KEY, "c" INTEGER NOT NULL DEFAULT 0)
        USING noalter
```

The `CHECK`, the `UNIQUE` and the tags are gone, with no warning. From then on the table accepts
rows its own declaration forbade. The key's `on conflict` action goes the same way.

**Foreign keys are dropped.** Same shape, separately reproduced:

```
create table c (id integer not null, pid integer not null, primary key (id),
                foreign key (pid) references p(id)) using noalter;
alter table c alter primary key (pid);

AFTER:  CREATE TABLE "main"."c" ("id" INTEGER NOT NULL, "pid" INTEGER NOT NULL PRIMARY KEY) USING noalter
```

**An empty new key rebuilds as an all-columns key.** `alter primary key ()` makes a table a
singleton (a key of no columns, so at most one row). `buildShadowTableDdl` emits *no*
`PRIMARY KEY` clause when the new key is empty, and a `CREATE TABLE` with no clause means the
opposite thing — keyed by every column. Verified: after
`create table t (a integer not null, b text null, primary key (a)) using noalter` then
`alter primary key ()`, the key reads back as `(a, b)`. The in-place path gets this right
(it rejects the statement when existing rows would collide under the singleton key), so today
the same statement means two different things depending on which backend runs it.

**Indexes are not recreated at all.** Read from the code, not run: `rebuildViaShadowTable`
executes exactly four statements — create shadow, insert-select, drop original, rename — and
never re-creates the table's indexes. Confirming this end-to-end needs the stub to forward
`createIndex`/`dropIndex` (it currently forwards neither, so `create index … using noalter`
fails outright). Note this is not fixed by rendering the shadow through `generateTableDDL`:
`emitTableConstraints` deliberately skips a UNIQUE constraint marked `derivedFromIndex`
(it round-trips via its index, not as a table constraint), so those plus every plain, partial
and unique index still need separate `CREATE INDEX` statements.

## Root cause

One code site: `buildShadowTableDdl` renders a *subset* of the table by hand. An omission in
emitted DDL is never neutral — a missing `PRIMARY KEY` clause re-parses as a different key,
a missing constraint re-parses as no constraint. Fixing each dropped clause individually
leaves the next one (a generated column, a column-level `on conflict`, a future clause) free
to reappear.

## Shape of the fix

Render the shadow through `generateTableDDL` over a **copy of the real `TableSchema`** with the
new name and new key substituted:

```ts
generateTableDDL({ ...tableSchema, name: shadowName, primaryKeyDefinition: newPkDef })
```

Notes that make this land cleanly:

- Call it **without** a `db` argument. That form fully qualifies the name, always emits `USING`,
  and annotates nullability on every column — exactly what a shadow needs, since it must
  re-parse to the same shape regardless of the session's `default_column_nullability` and
  `default_vtab_module` settings.
- `generateTableDDLInternal` already emits `PRIMARY KEY ()` for an empty key and reads the key
  from `primaryKeyDefinition` (never from the stale per-column `primaryKey` flag), so the
  empty-key arm is fixed by the switch alone.
- The stale per-column `primaryKey` flags on the copied schema do not need refreshing — the
  emitter ignores them, and the shadow's real schema is built by re-parsing the emitted text.

**Delete the `survivingColumns` parameter.** It threads through `rebuildTableWithNewShape` →
`rebuildViaShadowTable` → `buildShadowTableDdl`, and the one caller (`alter-table.ts:1957`)
always passes the full column list. `ALTER TABLE … DROP COLUMN` goes through
`module.alterTable`, never through this rebuild — verified by reading `runDropColumn`. Keeping
the parameter is what makes "a constraint references a column the shadow does not have" a
representable state (stored constraints address columns by *index*, so a subset copy would also
need every index remapped). Removing it makes that state unrepresentable. If a column-dropping
rebuild is ever wanted, it has to come back with deliberate constraint handling — say so in a
comment where the parameter used to be.

**Indexes.** Emit a `CREATE INDEX` per index onto the shadow (via `generateIndexDDL` against the
shadow schema) inside the existing suppressed-events scope, after the row copy. If that turns
out to be more than this ticket can carry, the alternative is to *refuse* the rebuild when the
table has indexes — but silent loss is not an option either way.

**Verify the foreign-key ordering still works.** After the fix the shadow carries its FKs, which
it did not before. The shadow is created while the original still exists, then the original is
dropped and the shadow renamed. A **self-referencing** FK is the sharp case: the shadow's FK
names the original table, which is then dropped mid-flight. Check whether `drop table` refuses
while the shadow references it, and whether `propagateTableRename` leaves the FK pointing at the
right table afterwards.

## Expected behaviour

A rebuild changes the key and nothing else. After a rebuild-path `alter primary key`, the
table's constraints, foreign keys, tags, conflict action, defaults, collations, nullability and
indexes are exactly what they were, and the key is exactly what was asked for — including the
empty singleton key.

## Related

`tickets/backlog/bug-non-key-column-conflict-action-dropped-from-ddl.md` is about a gap *inside*
`generateTableDDL` itself (a non-key column's `on conflict` action, and `with context (…)`).
Different site, opposite direction — but once this ticket lands, anything that emitter learns to
emit is carried by the rebuild for free, which is the whole point.

## TODO

- Replace `buildShadowTableDdl`'s body with a `generateTableDDL` call over a shadow copy of the
  `TableSchema` (name + `primaryKeyDefinition` substituted), no `db` argument.
- Remove the `survivingColumns` parameter from `buildShadowTableDdl`,
  `rebuildViaShadowTable` and `rebuildTableWithNewShape`; derive the insert-select projection
  from `tableSchema.columns` at the one place it is needed. Leave a comment stating why the
  builder is deliberately whole-table-only.
- Recreate the table's indexes on the shadow with `generateIndexDDL`, inside the existing
  `withPublicEventsSuppressed` scope, after the row copy. If any index cannot be recreated,
  fail the rebuild rather than dropping it silently.
- Check the drop + rename ordering with a self-referencing foreign key on the rebuilt table, and
  with another table's foreign key pointing at it. Make whichever outcome is correct explicit
  (carry it, or refuse the statement with a sited message) — not an accident.
- Rewrite `packages/quereus/test/runtime/shadow-ddl.spec.ts` for the canonical form. Every
  regex in it currently matches the lowercase hand-rolled spelling (`not null`,
  `primary key (a, b)`, unquoted names) and will fail against the canonical uppercase, quoted
  output. In particular the `omits PRIMARY KEY clause when newPkDef is empty` case (~line 116)
  asserts the *bug* and must flip to expecting `PRIMARY KEY ()`.
- Add `createIndex`/`dropIndex` forwarding to `makeNoAlterModule` behind an opt-in flag
  (matching the existing `withRenameTable` shape) so the index arm is testable.
- Add end-to-end coverage through a rebuild-path `alter primary key` on
  `makeNoAlterModule({ withRenameTable: true })`:
  - a table-level `CHECK` still rejects a violating insert afterwards
  - a `UNIQUE` constraint still rejects a duplicate afterwards
  - a declared `FOREIGN KEY` survives (assert enforcement, not just the DDL text)
  - table tags survive
  - the key's `on conflict` action survives
  - indexes survive
  - `alter primary key ()` yields the empty singleton key, and rejects when existing rows would
    collide under it — matching the in-place path
- Add the general check that subsumes the list above: emit `generateTableDDL` before and after a
  rebuild that re-keys the table, and assert the two texts differ **only** in the
  `PRIMARY KEY` clause.
- Run `yarn workspace @quereus/quereus test` and `yarn lint`.
