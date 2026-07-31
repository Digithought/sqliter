----
description: Declaring the same plain UNIQUE rule twice on one table used to behave three different ways depending on how it was written and which storage backend was in use; it is now refused the same way everywhere, with a message about the constraint rather than about a hidden index.
files:
  - packages/quereus/src/schema/catalog.ts                         # the new guards, beside assertUniqueConstraintIndexNameFree
  - packages/quereus/src/runtime/emit/add-constraint.ts            # ALTER TABLE ADD CONSTRAINT wiring ~163-176
  - packages/quereus/src/runtime/emit/alter-table.ts               # ADD COLUMN … unique wiring ~617-641
  - packages/quereus/src/schema/manager.ts                         # createTable wiring ~2767-2780
  - packages/quereus/src/vtab/memory/layer/manager.ts              # ensureUniqueConstraintIndexes hardening ~281-296
  - packages/quereus/test/logic/10.5.7-implicit-unique-index-lifecycle.sqllogic  # new §10
  - packages/quereus/test/index-ddl-roundtrip.spec.ts              # memory-hardening shape test
  - packages/quereus-store/test/index-persistence.spec.ts          # store: refused before any catalog write
  - docs/sql-alter.md                                              # ADD CONSTRAINT § — the rule and its two carve-outs
difficulty: medium
----

## What the defect was

A `UNIQUE` constraint the user did not name has no name, so nothing ever compared a
repeat against the constraints already on the table. The only thing that ever noticed
was the name of the *hidden index* the backend builds to enforce it — and the two
built-in backends build that index differently, so one statement got three answers:

| path | before |
| --- | --- |
| memory, `alter table t add unique (c)` twice | refused, but the message named an index `_uc_c` the user never created |
| store, same statement | **accepted** — catalog entry became `… unique (c), unique (c)` |
| memory, `create table t (…, unique (c), unique (c))` | **accepted** — two index entries under one name (`index_info()` reports neither, `DROP INDEX` says `no such index`) |

Neither accepted copy could be removed: an unnamed constraint has no name for
`DROP CONSTRAINT` to address, so the only escape was recreating the table, while every
write paid the identical check twice.

## What now happens

One rule, tested on the **constraint** (its column set) rather than on its hidden
structure, so both backends answer identically:

> a table may not carry two unnamed, non-partial UNIQUE constraints over the same
> column set

Refused with `CONSTRAINT` and the message
`Cannot <operation>: an equivalent UNIQUE constraint on (<cols>) already exists.`
at every declaration site, always **before** any module dispatch (so a store-backed
statement persists nothing) and always **before** the older hidden-index name check
(so the user sees the constraint-worded message, not the index-worded one).

Carve-outs, both deliberate and both documented in code and in `docs/sql-alter.md`:

- **Partial UNIQUEs are different constraints** — one carrying a `WHERE` predicate only
  governs rows in its scope. (Today only `create unique index … where …` produces one;
  `AST.TableConstraint` has no predicate field, so a *declared* UNIQUE is never partial.
  The guard tests for it anyway.)
- **A named UNIQUE beside an unnamed one over the same columns stays legal**, as do two
  differently-named ones — each is addressable and droppable, so the result is redundant
  rather than unremovable. The `NOTE:` on `assertUniqueConstraintNotDuplicated` records
  that this omission is deliberate.

Column **order** is not identity: `unique (a, b)` and `unique (b, a)` are one rule and
collide, even though their derived structure names (`_uc_a_b` / `_uc_b_a`) differ.
Column names fold case.

## Where the code went

`packages/quereus/src/schema/catalog.ts`, immediately after
`assertUniqueConstraintIndexNameFree` (the two are ordering-coupled, so they sit
together):

- `uniqueConstraintColumnSetKey(columnNames)` — order- and repetition-insensitive,
  case-folded key. Exported because the `ADD COLUMN` caller builds a set of keys claimed
  earlier in the same statement.
- `isAnonymousUniqueConstraint(uc)` (private) — unnamed **and** not `derivedFromIndex`
  **and** no `predicate`.
- `assertUniqueConstraintNotDuplicated(tableSchema, name, columnNames, operation, alsoDeclared?)`
  — the declaration-site form. Takes prospective column *names*, like its neighbour, so
  `ADD COLUMN`'s not-yet-existing column works. No-op when the new constraint is named.
- `assertNoDuplicateUniqueConstraints(constraints, columns, operation)` — the
  `CREATE TABLE` form, scanning the built constraint list so inline and table-level
  spellings are compared in one place.

Call sites: `runAddConstraintViaModule` (add-constraint.ts), the inline-constraint loop
in `runAddColumn` (alter-table.ts), and `SchemaManager.createTable` **only** — never
`buildTableSchemaFromAST`, because the import / rehydrate path shares that builder and a
database written before the guard must still open. Same placement rationale the
FK-collation check below it already documents.

`MemoryTableManager.ensureUniqueConstraintIndexes` hardened: a structure name already
held in `newIndexes` is now **adopted**, never pushed a second time, so no path can
produce the two-entries-under-one-name shape.

`quereus-store`'s `withImplicitUniqueIndexes` was read and needs no change — it already
adds each name to its `present` set before pushing, so a second constraint deriving the
same name is skipped.

## Use cases to exercise

Refusals (all three sites, both backends):

```sql
create table t (id integer primary key, c integer, d integer);
alter table t add unique (c);
alter table t add unique (c);        -- refused
alter table t add unique (C);        -- refused (case folds)
alter table t add unique (c, d);
alter table t add unique (d, c);     -- refused (order is not identity)

alter table t add column m text unique unique;                  -- refused (same statement)
create table t2 (id integer primary key, c integer, unique (c), unique (c));   -- refused
create table t3 (id integer primary key, c integer unique, unique (c));        -- refused
create table t4 (id integer primary key, c integer unique unique);             -- refused
```

Still accepted:

```sql
create table n (id integer primary key, c integer, unique (c));
alter table n add constraint u1 unique (c);    -- named beside unnamed
alter table n add constraint u2 unique (c);    -- second distinct name
alter table n add constraint u2 unique (c);    -- refused, but by the NAME guard

create table p (id integer primary key, c integer, s text);
create unique index p_pos on p (c) where s = 'pos';
create unique index p_neg on p (c) where s = 'neg';   -- two partials, same columns
alter table p add unique (c);                          -- full one accepted beside them
```

Refusal must leave the target completely untouched: no column added, no table
registered, no catalog write on the store side.

## Tests added (treat as a floor)

- `test/logic/10.5.7-implicit-unique-index-lifecycle.sqllogic` **§10** (runs on both
  backends; the pre-existing `apply schema` section was renumbered 10 → 11): ADD
  CONSTRAINT / ADD COLUMN / CREATE TABLE refusals, case + column-order insensitivity,
  survivor still enforcing, and both carve-outs.
- `packages/quereus-store/test/index-persistence.spec.ts`: the refused `ADD UNIQUE`
  produces **zero** catalog writes (`traceCatalogWrites()`), the bundle carries exactly
  one UNIQUE, one constraint rehydrates and enforces after reopen, and the refusal still
  fires post-reopen (the guard reads the rehydrated constraint, not session memory).
- `packages/quereus/test/index-ddl-roundtrip.spec.ts`: the memory hardening's shape
  guarantee — one index entry under a shared derived name, not two.

Run: `yarn test` (8165 passing, 0 failing), `yarn test:store` (8157 passing, 0 failing),
`yarn workspace @quereus/store run test` (1226 passing), `yarn lint` (clean),
`yarn typecheck` (clean). All green.

## Known gaps — please probe these

- **The memory hardening has no test that reaches it through a user statement.** With
  the three declaration guards in place, no write path can hand
  `ensureUniqueConstraintIndexes` two constraints deriving one name *from duplicate
  unnamed UNIQUEs*. I tried to reach it via `importCatalog` and could not: the memory
  module's `connect` requires storage that already exists, so a hand-built `CREATE TABLE`
  bundle cannot be imported at all. The test that does exist reaches the same code by a
  different door (a constraint *named* `_uc_c` beside `unique (c)`), which is a real but
  obscure path — see the first bug below. If a reviewer finds a reachable route to the
  duplicate-unnamed case, that is the better test.
- **`declare schema` / `apply schema` was not tested for the CREATE TABLE arm.** The
  differ emits ordinary `CREATE TABLE` / `ALTER TABLE` statements through the normal
  pipeline, so it inherits all three guards, and §11 of the sqllogic file already pins
  that for the ADD CONSTRAINT arm — but a declared schema containing a duplicate unnamed
  UNIQUE is untested.
- **Column-set matching treats a repeated column as one** (`unique (a, a)` keys the same
  as `unique (a)`). Arguably right, never measured against any other engine.
- **The `alsoDeclared` arm on `ADD COLUMN` only ever sees single-column sets today**,
  since every inline `unique` on one `ADD COLUMN` is over that one new column. It is
  written generically; if `ADD COLUMN` ever grows a multi-column inline form, re-check.
- **Isolation / sync layers were not specifically exercised.** They pass in the suite,
  but no test asserts that a wrapper module's `ADD CONSTRAINT` path hits the guard.

## Two bugs found while implementing — filed, not fixed here

Both live at or beside the memory backend's hidden-index reuse logic, which this ticket
only hardened rather than rewrote. Neither is a regression; both predate this work.

- **`tickets/fix/bug-memory-unique-reuses-partial-index`** (verified repro) — on the
  memory backend, an unfiltered `UNIQUE` will adopt a *filtered* (partial) index over the
  same columns as its enforcing structure, after which it stops rejecting duplicates
  outside the filter. The store backend excludes partial indexes from that search and
  gets it right. One-condition root cause. This is why §10e of the sqllogic file asserts
  the full-UNIQUE-beside-partials case is *accepted* but stops short of asserting it
  *enforces* — that assertion belongs to the fix, and a `NOTE:` at the test site says so.
- **`tickets/backlog/bug-create-table-unique-derived-name-collision`** (verified repro) —
  `CREATE TABLE` runs no check that two UNIQUE constraints could resolve to the same
  hidden-index name, so `constraint _uc_c unique (b)` beside `unique (c)` creates a table
  where `unique (c)` is enforced against `b`'s structure and silently accepts duplicates.
  Requires typing the engine-reserved `_uc_` prefix, hence backlog rather than fix. The
  `ALTER` paths already refuse this.

A cross-reference to the first was appended to the existing
`backlog/debt-memory-unique-index-reuse-after-create-index`, which edits the same
function for a different reason (when the reuse decision is re-taken, vs. which shapes
qualify).

## Not mine

`yarn docs:check` fails at HEAD on `docs/schema.md` and `docs/sync.md` (both over their
recorded word-count maximums). Outside this diff; already owned by
`backlog/debt-doc-size-ratchet-red-at-head`, which names both files. `docs/sql-alter.md`,
which this ticket edits, passes.
