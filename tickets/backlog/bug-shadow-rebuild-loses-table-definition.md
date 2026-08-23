---
description: Two places in the engine write out a table's definition by hand instead of using the one official writer, and both leave parts out — a table rebuilt behind the scenes loses its validation rules, its uniqueness rules and its labels (and can come back with the wrong identity), and the table listing reports a definition that would re-create a different table.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts        # buildShadowTableDdl (~1972-2016), rebuildViaShadowTable (~2121)
  - packages/quereus/src/schema/ddl-generator.ts            # generateTableDDL — the canonical emitter this path should be using
  - packages/quereus/test/runtime/shadow-ddl.spec.ts        # pins the current (wrong) empty-key behaviour at ~116
  - packages/quereus/test/no-alter-module.ts                # the stub backend that reaches this path
  - packages/quereus/src/func/builtins/schema.ts            # schema()'s ad-hoc createSql for a plain vtab table (arm 3)
repro: verified
severity: wrong-result
likelihood: normal-use
tradeoffs: Neither shipped backend (memory, store) ever reaches arms 1-2 — both re-key in place — so those only bite a third-party backend; arm 3 is reachable by anyone but only misreports (nothing in the engine re-parses that text). Either way the fix means making hand-rolled DDL emitters defer to the canonical one rather than a one-line patch.
---

# What is wrong

`alter table … alter primary key` first asks the storage backend to re-key itself. A backend
that cannot do that raises `UNSUPPORTED`, and the engine falls back to a **rebuild**: it builds
a shadow table, copies the rows over, drops the original and renames the shadow into place.

The shadow table's `CREATE TABLE` text is written by `buildShadowTableDdl`, a **second,
hand-rolled DDL emitter** that renders only columns, the new key, and the `using` clause. It is
not the canonical emitter (`generateTableDDL`) the rest of the engine persists and compares
with, and it has drifted from it. Everything the shadow's text does not mention is gone from
the rebuilt table.

## Arm 1 — table constraints and tags are silently dropped

Verified by running it (a stub backend with no in-place re-key, `alter primary key (b)`):

```
BEFORE: CREATE TABLE "main"."t" ("a" INTEGER NOT NULL, "b" TEXT NULL, "c" INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY ("a", "b", "c"), check on insert, update (c >= 0), unique (b)) USING noalter WITH TAGS (k = 'v')

AFTER:  CREATE TABLE "main"."t" ("a" INTEGER NOT NULL, "b" TEXT NULL PRIMARY KEY, "c" INTEGER NOT NULL DEFAULT 0)
        USING noalter
```

The `CHECK`, the `UNIQUE` and the table's tags are simply not there any more, and nothing warns.
From that point on the table accepts rows its own declaration forbade — the `check (c >= 0)` and
the `unique (b)` stop being enforced. Foreign keys live in the same table-level constraint list
and go the same way. The `on conflict` action declared with the key is dropped too.

## Arm 2 — an empty new key rebuilds as an all-columns key

`alter table t alter primary key ()` makes the table a **singleton** — a key of no columns, so
at most one row. Through the rebuild, `buildShadowTableDdl` emits *no* `PRIMARY KEY` clause when
the new key is empty, and a `CREATE TABLE` with no clause means the opposite thing: the table is
keyed by **every** column. Verified — after the rebuild the key is `(a, b)`, not `()`.

The in-place path gets this right (it rejects the statement when existing rows would collide
under the singleton key), so the same statement means two different things depending on which
backend runs it.

`packages/quereus/test/runtime/shadow-ddl.spec.ts:116` currently asserts the omission as if it
were correct, so the fix has to flip that test too.

## Arm 3 — `schema()` reports a definition that re-creates a different table

Reported from the Lamina board (`debt-delete-synthesized-primary-key-flag`, review pass), where
it turned up while checking that the canonical emitter names every key.

`select sql from schema()` is the table listing users read to find out how a table was declared.
For a **maintained** table it renders `generateMaintainedTableDDL` — the canonical emitter. For
an ordinary vtab table it instead builds the text by hand from the column names and type tokens
alone (`packages/quereus/src/func/builtins/schema.ts`, the `createSql` branch), so the key, the
nullability markers, defaults, collations and every constraint are missing.

Verified through a `using lamina` table (the omission is module-independent — it is the same
branch for any vtab module):

```
CREATE TABLE probe_t (a INTEGER NULL, b TEXT NULL);

schema().sql   →  create table "probe_t" ("a" INTEGER, "b" TEXT) using lamina()
generateTableDDL →  CREATE TABLE "probe_t" ("a" INTEGER NULL, "b" TEXT NULL, PRIMARY KEY ("a", "b"))
```

Both omissions flip meaning rather than merely abbreviating: with `not_null` defaulting on,
re-running the reported text gives NOT NULL columns, and the missing `PRIMARY KEY` clause means
"key is every column" — which happens to be right here only because this table declared no key.
Declare `primary key (a)` and the reported text still says nothing, so it re-parses to the
all-columns key instead.

Unlike arms 1-2 this does not corrupt anything in-engine — nothing re-parses `schema().sql` — so
it is a reporting defect. It is listed here rather than as its own ticket because the fix is the
same one this ticket already argues for: render through the canonical emitter, so a clause the
canonical emitter learns to emit is carried everywhere. Note the two differ in identifier case
and in `using`-clause elision, so the fix has to decide which form the listing shows.

# Root cause

Hand-rolled table DDL instead of the canonical emitter. Two sites do it — `buildShadowTableDdl`
(arms 1-2) and `schema()`'s `createSql` (arm 3). All three arms are the same defect — a hand-rolled emitter renders a
*subset* of the table, and an omission in emitted DDL is never neutral (a missing `PRIMARY KEY`
clause re-parses as a different key, a missing constraint re-parses as no constraint).

The engine already holds the invariant "canonical DDL states everything explicitly" in
`generateTableDDL`; it just is not applied here. Fixing the two symptoms individually would
leave the next omission (a column-level `on conflict`, a generated column, a future clause) free
to reappear.

# Expected behaviour

A rebuild is supposed to change the key and nothing else. After
`alter table … alter primary key …` on a backend that takes the rebuild path, the table's
constraints, tags, conflict action, defaults, collations and nullability must be exactly what
they were, and the key must be exactly what was asked for — including the empty singleton key.

The natural shape is for the rebuild to render the shadow through the canonical emitter over a
copy of the real schema with the new name and new key substituted, so a clause the canonical
emitter learns to emit is automatically carried by the rebuild. Column-dropping rebuilds share
this builder, so any constraint referencing a dropped column has to be handled deliberately
(carry it, or refuse the statement) rather than falling out as silent loss.

# Coverage to add

Using `makeNoAlterModule({ withRenameTable: true })` (already in the test tree), assert across a
rebuild-path `alter primary key`:

- a table-level `CHECK` still rejects a violating insert afterwards,
- a `UNIQUE` constraint still rejects a duplicate afterwards,
- a declared `FOREIGN KEY` survives,
- table tags survive,
- the key's `on conflict` action survives,
- `alter primary key ()` yields the empty singleton key (and rejects when existing rows would
  collide, matching the in-place path).

The strongest single check is a general one: emit canonical DDL before and after a rebuild that
re-keys the table, and assert the two texts differ **only** in the `PRIMARY KEY` clause.

For arm 3, the general check is that `schema().sql` for an ordinary vtab table parses back to
the same table it describes — key, nullability, defaults, collations and constraints included.
