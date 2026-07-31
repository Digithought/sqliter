---
description: Declaring the same plain UNIQUE rule twice on one table behaves three different ways depending on how it is written and which storage backend is in use — one path refuses it with a confusing message about an index the user never created, another quietly keeps both copies so every write pays for the same check twice with no way to remove either, and a third leaves the table in a corrupt state.
prereq: bug-rename-column-shifts-unnamed-unique-index-name
files:
  - packages/quereus/src/runtime/emit/add-constraint.ts           # ALTER TABLE ADD CONSTRAINT pre-dispatch guards ~129-180
  - packages/quereus/src/runtime/emit/alter-table.ts              # ADD COLUMN … unique inline-constraint guards ~545-585
  - packages/quereus/src/schema/manager.ts                        # extractUniqueConstraints ~1825, buildTableSchemaFromAST ~1840 — the CREATE TABLE site
  - packages/quereus/src/schema/catalog.ts                        # assertUniqueConstraintIndexNameFree ~456, implicitIndexNameForColumns ~409
  - packages/quereus/src/vtab/memory/layer/manager.ts             # ensureUniqueConstraintIndexes ~246 — pushes a duplicate name
  - packages/quereus/test/logic/10.5.7-implicit-unique-index-lifecycle.sqllogic
  - packages/quereus-store/test/index-persistence.spec.ts
  - docs/sql-alter.md                                             # ADD CONSTRAINT rules ~85-86
difficulty: medium
repro: verified
---

## The problem

A UNIQUE constraint the user did not name has no name to compare, so nothing checks
it against the constraints already on the table. The only thing that ever catches a
repeat is the *hidden helper index* name check
(`assertUniqueConstraintIndexNameFree`), and that check can only see a helper
structure the backend actually materialized. The two backends materialize
differently, so the same statement gets three different answers.

## Measured (current tree, run directly against both modules)

```sql
create table t (id integer primary key, c integer);
alter table t add unique (c);
alter table t add unique (c);   -- the same constraint, declared twice
```

| path | result |
| --- | --- |
| memory, `ALTER TABLE … ADD UNIQUE` | refused: `Cannot add UNIQUE constraint to table 't2': its backing index '_uc_c' would collide with existing index '_uc_c' on the same table. Rename the constraint or the index.` |
| store, `ALTER TABLE … ADD UNIQUE` | **accepted** — catalog entry becomes `... unique (c), unique (c)) USING store` |
| memory, `create table t1 (id integer primary key, c integer, unique (c), unique (c))` | **accepted** — `t1.indexes` is `["_uc_c", "_uc_c"]`, two entries under one name |

`alter table t add column c integer null unique` followed by
`alter table t add unique (c)` behaves like the ALTER row. The store leg was not
measured for the `CREATE TABLE` shape — check it during implementation.

Three problems, one per row:

- The memory refusal talks about an *index* the user never created, for a statement
  whose actual fault is a duplicate *constraint*.
- The store keeps both copies. They are then unaddressable: the constraints carry a
  null name (`_uc_c` is only ever computed), so
  `alter table t drop constraint _uc_c` answers
  `Named constraint '_uc_c' not found in table 't'`. Neither copy can be removed
  short of recreating the table, and every INSERT/UPDATE pays duplicate enforcement.
- Two index entries sharing one name is the state `SchemaManager` already warns about
  at `manager.ts:3361-3395` when it sees it in an imported catalog, describing it as
  worse than a shadowed index: `index_info()` reports neither entry, `DROP INDEX`
  answers `no such index`, and a predicate over the indexed column stops filtering.
  (Those three downstream effects were *not* re-measured here for the CREATE TABLE
  path — the duplicate-name array shape was. Confirm them, or the absence of them,
  while implementing.)

## Root cause

Unnamed UNIQUE constraints are compared by their derived helper-structure name
instead of by what actually makes two of them the same: the same column set with the
same partial predicate. `ensureUniqueConstraintIndexes`
(`vtab/memory/layer/manager.ts:246`) compounds it by testing each new entry only
against the *original* index list, so two constraints in one `CREATE TABLE` each push
an entry under the same name.

## Expected behavior

One behavior on both backends, stated in terms of the constraint rather than its
hidden structure: a table may not carry two non-derived UNIQUE constraints over the
same column set when neither carries a partial predicate. The second declaration is
refused with a `CONSTRAINT`-class error along the lines of

> Cannot add UNIQUE constraint to table 't': an equivalent UNIQUE constraint on (c)
> already exists.

Refusal (rather than silently collapsing the duplicate) matches what the memory
backend already does for the ALTER form and keeps the rule the same at every
declaration site.

Scope decisions to hold:

- **Two partial UNIQUEs over the same columns are legal** — different predicates make
  them genuinely different constraints. Only refuse when both predicates are absent.
- **A named UNIQUE alongside an unnamed one over the same columns stays legal.**
  Measured today: `create table t3 (…, unique (c))` then
  `alter table t3 add constraint u1 unique (c)` is accepted and yields two
  constraints with distinct helper names (`_uc_c`, `u1`), both addressable and
  droppable. Redundant, but not broken, and refusing it would change more surface
  than this ticket owns. Say so in a `NOTE:` comment at whichever site implements the
  duplicate test, so the next reader knows the omission is deliberate.
- The order of guards matters: the constraint-level duplicate test must run **before**
  `assertUniqueConstraintIndexNameFree`, so both backends answer identically and the
  user sees the constraint-worded message rather than the index-worded one. This is
  the same ordering rationale already written out at `alter-table.ts:545-556`.

## TODO

- Add a shared predicate next to `assertUniqueConstraintIndexNameFree` in
  `packages/quereus/src/schema/catalog.ts` (or `schema/table.ts` if it fits the
  existing constraint helpers better) that answers "does this table already carry a
  non-derived, predicate-free UNIQUE over this exact column set?", plus its
  `assert…` wrapper carrying the message above. Take prospective column *names*, like
  `assertUniqueConstraintIndexNameFree` does, so the `ADD COLUMN` caller (whose column
  does not exist yet) can use it.
- Wire it into `ALTER TABLE … ADD CONSTRAINT` (`runtime/emit/add-constraint.ts`,
  ahead of the existing index-name check) and `ALTER TABLE … ADD COLUMN … unique`
  (`runtime/emit/alter-table.ts`, same relative position), both pre-dispatch so no
  store persistence happens on a refused statement.
- Wire it into the `CREATE TABLE` assembly path
  (`SchemaManager.extractUniqueConstraints` / `buildTableSchemaFromAST`,
  `schema/manager.ts:1825`) so a duplicate inside one `CREATE TABLE` is refused
  before any table is registered. Note `docs/sql-alter.md:86` currently states
  "`CREATE TABLE` is not tightened by this" about the *named*-constraint rule — that
  sentence is about names and stays true; do not widen it accidentally.
- Harden `ensureUniqueConstraintIndexes` (`vtab/memory/layer/manager.ts:246`) so it
  can never push a second entry under a name already in `newIndexes` — defence in
  depth for catalogs written before the guard (`importDDL` warns and proceeds; see
  `manager.ts:3361`).
- Check whether the store's `withImplicitUniqueIndexes`
  (`packages/quereus-store/src/common/implicit-unique-index.ts:141`) needs the same
  hardening; it already dedupes via its `present` set, so this is a read-and-confirm,
  not an edit.
- Tests in `test/logic/10.5.7-implicit-unique-index-lifecycle.sqllogic` (both
  backends): duplicate via `ADD UNIQUE`, via `ADD COLUMN … unique`, and inside one
  `CREATE TABLE` — each refused with the constraint-worded message; a partial-UNIQUE
  pair over the same columns still accepted; a named-plus-unnamed pair still accepted.
- Store-side: confirm the refusal happens before any catalog write (extend
  `packages/quereus-store/test/index-persistence.spec.ts` with a `traceCatalogWrites()`
  assertion, matching the existing collision test's shape).
- Run: `yarn test`, both `10.5.7` `.sqllogic` legs (plain and
  `QUEREUS_TEST_STORE=true`), `yarn workspace @quereus/store run test`, and
  `yarn lint` in `packages/quereus`.
- Docs: `docs/sql-alter.md` §ADD CONSTRAINT — state the duplicate-UNIQUE rule and its
  two carve-outs (partial predicates, named-plus-unnamed).

## Note on ordering

`prereq` is `bug-rename-column-shifts-unnamed-unique-index-name` only to serialize
edits: both tickets touch `schema/catalog.ts`, `runtime/emit/alter-table.ts`, and the
same `.sqllogic` file. Nothing here depends on that ticket's behavior.
