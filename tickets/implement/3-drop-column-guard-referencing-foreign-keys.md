---
description: Dropping a column is currently allowed even when a foreign key in a different table still points at it, and afterwards that other table can no longer be written to at all. Refuse the drop instead, with a message naming the table and key that are in the way.
prereq: drop-column-guard-check-and-assertion-dependents
files:
  - packages/quereus/src/runtime/emit/alter-table.ts                 # runDropColumn (line ~1103) — where the new guard call goes
  - packages/quereus/src/runtime/emit/drop-column-guards.ts          # created by the prereq ticket; this adds the third guard
  - packages/quereus/src/schema/table.ts                             # ForeignKeyConstraintSchema (~line 897), resolveReferencedColumns (~line 933) — the throw site
  - packages/quereus/src/planner/building/foreign-key-builder.ts     # ~line 214 — how enforcement resolves the parent table; the guard must mirror it
  - packages/quereus/src/schema/manager.ts                           # findTable (~line 714), _getAllSchemas (~line 461)
  - packages/quereus/test/logic/41.10-alter-drop-column-foreign-key.sqllogic            # the child-side sibling of this file
  - packages/quereus/test/logic/41.10.3-alter-drop-column-referencing-fk.sqllogic       # NEW test file
  - docs/sql-alter.md                                                # line 71 — the sentence that is factually wrong
  - docs/sql-ddl.md                                                  # DROP COLUMN restriction bullet (~line 347)
difficulty: medium
---

# DROP COLUMN must refuse when another table's foreign key points at the column

## What is broken

A foreign key stores its **parent** columns as names (`referencedColumnNames`), resolved
against the parent's current shape on every write by `resolveReferencedColumns`
(`schema/table.ts`). Nothing checks, at drop time, that some other table still needs the name.
Re-verified in-process at commit `8658cfdd`:

```sql
pragma foreign_keys = true;
create table Parent (pid integer primary key, refd integer unique);
create table Child  (id integer primary key, c integer references Parent(refd));
insert into Parent values (1, 100);
insert into Child  values (1, 100);

alter table Parent drop column refd;   -- accepted, no error
insert into Child values (2, 100);     -- Referenced column 'refd' not found in table 'Parent'
```

The table left unwritable is a **different** table from the one the user altered, and the error
names a column they just deliberately removed elsewhere, so it gives no hint about what to do.
Reads keep working; every insert/update on `Child` fails while the plan is built, before any
row is touched. `DELETE` from `Parent` breaks the same way through the parent-side FK builder.

`bug-drop-column-leaves-fk-child-index-dangling` fixed the mirror case — the dropped column
being one the table's **own** foreign key constrains as a *child* column. That rule (a key that
loses a child column is removed outright) is settled and unchanged here.

## The rule

`drop-column-guard-check-and-assertion-dependents` (the prereq) settles DROP COLUMN's policy:
structural dependents *of the altered table itself* are removed with the column; every other
dependent refuses the drop. A foreign key living in **another** table is squarely on the refuse
side — dropping it would silently weaken a constraint on a table the user did not name in the
statement, which is much harder to justify than the within-table removals. SQLite refuses here
too. `StatusCode.CONSTRAINT`, message names the referencing table and key so the user knows
which `DROP CONSTRAINT` unblocks them.

**Not gated on `pragma foreign_keys`.** The pragma decides whether the DML builders *emit* FK
checks, so with it off the breakage is merely latent — the schema is still wrong, and turning
the pragma on later bricks the child table. The existing guards in `runDropColumn` (primary
key, generated column, partial index) are likewise unconditional. This does change behaviour
for pragma-off users; that is intended, and the test file pins it.

**Out of scope:** a database whose schema was *already* damaged this way (store-backed, so it
survives a reopen) stays damaged — the guard only prevents new occurrences. There is nothing
to repair automatically, since the dropped column's values are gone.

## The guard

Add to `packages/quereus/src/runtime/emit/drop-column-guards.ts` (created by the prereq
ticket):

```ts
export function assertNoForeignKeyReferencesColumn(
	db: Database, tableSchema: TableSchema, columnName: string): void;
```

Called from `runDropColumn` between the CHECK guard and the assertion guard — the guards run
in order of widening blast radius (this table → another table → the whole database), so the
most locally-explainable violation is reported first. Like the others it sits **before**
`requireVtabModule` / `module.alterTable`, so a refused statement never reaches a persisting
module.

Message, matching the local style of the guards already in `runDropColumn`:

```
Cannot drop column 'refd' from 'Parent': it is referenced by foreign key '_fk_child_c' on table 'Child'
```

Use `fk.name ?? \`_fk_${childTable.name}\`` for the displayed name — the same fallback
`constraint-builder.ts` uses in its own error text. In practice every FK built from SQL carries
the auto-name `_fk_<table>_<cols>` (`constraint-builder.ts` line ~83), which is the name
`DROP CONSTRAINT` accepts.

### How the scan must resolve the parent

Iterate `db.schemaManager._getAllSchemas()`, then each schema's `getAllTables()`, then each
table's `foreignKeys`. **Resolve the parent exactly the way enforcement does** rather than
comparing names by hand — an unqualified `fk.referencedTable` resolves through the session
search path, not through the child's own schema:

```ts
const parent = db.schemaManager.findTable(fk.referencedTable, fk.referencedSchema);
if (!parent) continue;                                    // dangling parent — not our problem
if (parent.schemaName.toLowerCase() !== tableSchema.schemaName.toLowerCase()
	|| parent.name.toLowerCase() !== tableSchema.name.toLowerCase()) continue;
```

`foreign-key-builder.ts` (~line 214) uses the same `findTable(fk.referencedTable,
fk.referencedSchema)` call; keeping the two identical is what makes "the guard refuses exactly
the drops enforcement would have choked on" true. Note the search-path dependence in the guard's
doc comment.

Then: refuse when `fk.referencedColumnNames` contains `columnName` (case-insensitive).

Two skips, both required:

- **No `referencedColumnNames`** (undefined or empty) — the key falls back to the parent's
  primary key, and dropping a PK column is already refused earlier in `runDropColumn`. Skip;
  say so in a comment so a reader does not read it as an oversight.
- **A self-referencing key the drop itself removes** — when the FK belongs to the table being
  altered *and* its child `columns` include the dropped column's index, the module removes the
  whole key as part of this same drop, so there is nothing left to point at the missing name.
  Refusing there would turn a legal drop away. (Reachable via `x integer references t(x)`.)

## Edge cases & interactions

Name each of these in the test file.

- **Single-column FK from another table** — the repro above. Refused; `Child` still writable
  afterwards; `Parent.refd` still present.
- **Multi-column FK** referencing `Parent(a, b)` — dropping either `a` or `b` is refused.
- **The referencing FK is on the altered table itself** (self-referencing, parent column ≠ child
  column): `create table t (id integer primary key, a integer unique, b integer references t(a))`
  — dropping `a` is refused; dropping `b` is **accepted** (the child-side rule removes the key).
- **Self-referencing where parent column == child column** (`x integer references t(x)`) —
  accepted; the drop removes the key. This is the skip above; without it the guard over-refuses.
- **`pragma foreign_keys = false`** — the refusal still fires.
- **Cross-schema**: an FK in schema `B` naming `main.Parent(refd)` explicitly — refused.
  (`41.5-cross-schema-foreign-keys.sqllogic` shows the attach/qualified-name setup.)
- **FK pointing at the parent's PK with no explicit column list** (`references Parent`) —
  dropping a non-PK column of `Parent` is accepted; dropping the PK column is refused by the
  pre-existing PK guard with *its* message, not this one.
- **A different column of the same parent** — dropping `Parent.unrelated` is accepted and
  `Child` stays writable, including under `pragma foreign_keys = true`.
- **Refusal leaves everything untouched** — after a refused drop, `Parent` still has the column,
  `Child` inserts still validate against it, and (store mode) a reopen shows the same. The guard
  runs before `module.alterTable` precisely so this holds.
- **Escape hatch** — `alter table Child drop constraint _fk_child_c` then the `Parent` drop
  succeeds.
- **`foreign_key_info` after each accepted drop** — reuse `41.10`'s assertion style so a
  silently-mangled key cannot pass.

## Documentation

`docs/sql-alter.md` line 71 currently ends the DROP COLUMN section with a claim that is
**verified false**:

> A foreign key in *another* table pointing **at** the dropped column is unaffected by this
> rule: it resolves the parent column by name at enforcement time.

Name resolution at enforcement time is exactly what makes the referencing table unwritable.
Replace the sentence with the rule this ticket implements, keeping the by-name detail as the
*reason* the drop must be refused rather than as a reassurance. Add the matching restriction
bullet to the list at ~line 66 (which the prereq ticket extends for CHECK and assertions), and
to `docs/sql-ddl.md` (~line 347). Run `yarn docs:check`.

## Tests

New file `packages/quereus/test/logic/41.10.3-alter-drop-column-referencing-fk.sqllogic` — the
parent-side counterpart to `41.10-alter-drop-column-foreign-key.sqllogic`, which covers only
the child side. No `-- requires-capability:` directive (no standalone index DDL), so it runs in
both memory (`yarn test`) and store (`yarn test:store`) modes; the store leg matters because a
broken referencing table survives a reopen.

Use the `-- error: <substring>` form and match on the referencing constraint name, so the
assertion proves *which* key blocked the drop — same convention and rationale as `41.10`'s
header note.

Sections, one per bullet in *Edge cases & interactions* above, in that order.

## TODO

- Add `assertNoForeignKeyReferencesColumn` to
  `packages/quereus/src/runtime/emit/drop-column-guards.ts`, with a doc comment covering the
  refuse-vs-cascade choice, the `findTable` mirror and its search-path dependence, and the two
  skips.
- Add a `NOTE:` at the scan site: it walks every table's foreign keys on every DROP COLUMN.
  Trivial at today's schema sizes; if a schema ever carries many tables and the ALTER path gets
  hot, index parent references by table name instead.
- Call it from `runDropColumn`, between the CHECK guard and the assertion guard.
- Update `docs/sql-alter.md` (the wrong sentence plus the restriction list) and
  `docs/sql-ddl.md`.
- Write `41.10.3-alter-drop-column-referencing-fk.sqllogic`.
- Validate, streaming output (never silent redirection):
  `yarn lint 2>&1 | tee /tmp/lint.log`, `yarn build 2>&1 | tee /tmp/build.log`,
  `yarn test 2>&1 | tee /tmp/test.log; tail -n 80 /tmp/test.log`, then the store leg for the
  new file only:
  `yarn workspace @quereus/quereus run test:store --grep "File: 41.10.3" 2>&1 | tee /tmp/store.log`.
  A full `yarn test:store` is slow — run the targeted grep and say in the handoff that the full
  store suite was not run.
- `yarn docs:check`.
