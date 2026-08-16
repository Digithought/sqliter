---
description: A table that says what to do when two rows collide on their identity columns was forgetting that instruction whenever the database was saved and reopened; now it is written down and survives. Also adds a test that re-saves and re-reads every table shape to prove nothing else is being quietly lost.
files:
  - packages/quereus/src/schema/ddl-generator.ts (`pkConflictClause`; `generateTableDDLInternal`; `formatColumnDef`)
  - packages/quereus/test/table-ddl-round-trip.spec.ts (new — 16 cases)
  - packages/quereus/src/schema/table.ts (two `NOTE:` comments only — no behaviour change)
  - docs/schema.md (~315-319)
difficulty: medium
---

# What landed

This ticket started as `debt-retire-synthesized-primary-key-distinction`. **That work did
not land** — see *What did not land* below; the remaining ticket is still in
`tickets/implement/`. What follows is what actually changed on disk, and it is unrelated
to the original ask except that it was found while building its test harness.

## 1. The primary key's `ON CONFLICT` action now survives a DDL round-trip (bug fix)

`generateTableDDL` renders the canonical `CREATE TABLE` text that `@quereus/store` writes
to its catalog and re-parses on reopen. It never emitted the primary key's `ON CONFLICT`
action. So:

```sql
create table t (a integer, b text, primary key (a, b) on conflict replace);
-- emitted DDL:  CREATE TABLE "main"."t" ("a" INTEGER NOT NULL, "b" TEXT NOT NULL, PRIMARY KEY ("a", "b"))
--                                                                                              ^ REPLACE gone
```

After a close + reopen the table resolved duplicate-key writes as `ABORT` instead of
`REPLACE`. Same for a column-declared `a integer primary key on conflict replace`.

The fix adds `pkConflictClause` and appends the action to whichever clause carries the key:
the inline column clause for a single-column key, the table-level clause otherwise. The
inline branch falls back to the column's own `ColumnSchema.defaultConflict` when
`TableSchema.primaryKeyDefaultConflict` is unset — this mirrors `resolvePkDefaultConflict`
(the in-package source of truth for PK conflict precedence) and is what makes the emission
a **fixed point**: a table-level action legitimately re-parses onto the column, so the
second emission has only the column-level record to read. `ABORT` is never emitted (it is
the parser's default for an absent clause, so emitting it would make two equivalent tables
render differently).

## 2. A round-trip fixed-point harness for primary-key DDL (new test)

`packages/quereus/test/table-ddl-round-trip.spec.ts`, 16 cases. For each table shape it
emits the canonical DDL, re-parses it in a fresh `Database`, and asserts:

- the `PRIMARY KEY` clause count is what the shape should produce,
- the re-parsed key matches (column index + `desc` + collation),
- every column's `notNull` matches, and
- **emitting the re-parsed schema reproduces byte-identical text.**

That last assertion is what caught the `ON CONFLICT` loss. Shapes covered: no-PK single
column, no-PK composite, declared all-columns PK, declared narrow PK, declared inline PK,
post-`ADD COLUMN` narrowed key, the `primary key ()` singleton, all-columns PK with
`ON CONFLICT`, narrow table-level PK with `ON CONFLICT`, column-declared PK with
`ON CONFLICT`, `ON CONFLICT ABORT` (must emit nothing), all-columns PK with a `DESC`
component, all-columns PK in non-declaration order, a no-PK table with a `NOCASE` column,
plus two standalone cases (omitted-vs-declared all-columns PK emit identical text; legacy
persisted DDL with no `PRIMARY KEY` clause still rehydrates to the all-columns key).

## 3. Documentation and `NOTE:` markers (no behaviour change)

- `docs/schema.md` gained a paragraph on `ON CONFLICT` emission and one on the fixed-point
  property, and the existing synthesized-key paragraph now says *why* the omission exists
  and what removes it.
- `schema/table.ts`: a `NOTE:` on `TableSchema.synthesizedPrimaryKey` recording that
  `../lamina` reads it (it is not dead code), and one on `isSynthesizedAllColumnsKey`
  recording the planned retirement.
- `schema/ddl-generator.ts`: a `NOTE:` on `formatColumnDef` for the remaining gap (below).

# What did not land, and why

**The ticket's actual scope — deleting `isSynthesizedAllColumnsKey`,
`TableSchema.synthesizedPrimaryKey`, and the DDL emitter's omission of the `PRIMARY KEY`
clause for a synthesized key — was implemented, tested, found to regress, and reverted.**
Two independent blockers, both verified rather than assumed:

**Blocker 1 — the prerequisite has not landed.** The emitter change is only sound once
`PRIMARY KEY` stops forcing its columns `NOT NULL`. That promotion is still live at
`schema/manager.ts` `buildColumnSchemas` (`notNull: (isPkColumn && !synthesized) ? …`) and
`schema/table.ts` `columnDefToSchema`. With the emitter change applied, an existing test
failed:

```
round-trips an unaltered table's DDL byte-identically:
  expected 'CREATE TABLE "main"."t" ("a" INTEGER NOT NULL, "b" TEXT NOT NULL, PRIMARY KEY ("a", "b")) USING memory'
     to be 'CREATE TABLE "main"."t" ("a" INTEGER NULL, "b" TEXT NULL, PRIMARY KEY ("a", "b")) USING memory'
```

i.e. naming a synthesized key silently tightens nullable columns to `NOT NULL` on every
persistence round-trip. Landing that would be a data-fidelity regression on `main`, for as
long as the prerequisite chain takes.

**Blocker 2 — `TableSchema.synthesizedPrimaryKey` is not dead.** The original ticket's
premise was "nothing reads it". True in this repo; **false across the monorepo boundary**.
The sibling `../lamina` repo's `lamina-quereus` adapter reads it in two places:

- `packages/lamina-quereus/src/quereus-ast-translators.ts:646` —
  `const statedSynthesized = asBoolean(s.synthesizedPrimaryKey);` with a *shape* fallback
  when the slot is absent, and
- `packages/lamina-quereus/src/module.ts:3258` — `rejectSynthesizedKeyWidening`, the
  `ALTER TABLE … ADD COLUMN` guard, gated on `primaryKey.synthesized`.

Its own comment says the shape fallback cannot tell a *declared* all-columns PK from the
synthesized one, and that using it for the ADD COLUMN decision "would silently rewrite a
key its author wrote". Deleting the field from Quereus therefore degrades a live downstream
consumer from an authoritative answer to an unsound guess. So the ticket's claim that
lamina is merely *unblocked* by this change is backwards — lamina's
`tickets/backlog/debt-retire-synthesized-primary-key-flag.md` has to land **with or before**
the Quereus deletion, not after.

# How to verify what landed

```bash
yarn build
yarn test            # 9617 passing / 25 pending — includes the 16 new round-trip cases
yarn lint            # clean
yarn test:store      # 9609 passing / 33 pending — the leg that actually persists and re-parses DDL
```

Targeted:

```bash
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus/test/table-ddl-round-trip.spec.ts" --colors
```

Manual check of the fix, in `quoomb-cli` or a scratch script:

```sql
create table t (a integer, b text, primary key (a, b) on conflict replace);
-- emitted DDL must contain: PRIMARY KEY ("a", "b") ON CONFLICT REPLACE
create table u (a integer, b text, v integer, primary key (a) on conflict replace);
-- emitted DDL must contain: "a" INTEGER NOT NULL PRIMARY KEY ON CONFLICT REPLACE
```

# Known gaps — treat these as the starting point, not the finish line

- **The `ON CONFLICT` fix is asserted at the DDL-text and schema level, not the behaviour
  level.** No test writes a duplicate row into a reopened store-backed table and checks it
  actually replaces rather than aborts. The round-trip assertions say the schema carries the
  right action; they do not prove the runtime honours it after a rehydrate. That end-to-end
  case is the most valuable thing a reviewer could add.
- **No `.sqllogic` coverage was added** for `on conflict` on a primary key. The new
  assertions live only in a TypeScript spec, so they do not run under the store leg's logic
  corpus.
- **A non-key column's own `ON CONFLICT` is still dropped.** `x integer not null on conflict
  rollback` reverts to `ABORT` on a round-trip — `ColumnSchema.defaultConflict` has no
  emission site outside the inline PK clause. Filed as
  `tickets/backlog/bug-non-key-column-conflict-action-dropped-from-ddl` and marked with a
  `NOTE:` at `formatColumnDef`. Not fixed here because the nullability annotation it would
  have to ride elides in the with-`db` form, which needs a decision this ticket did not own.
- **The round-trip harness only runs under the shipped
  `default_column_nullability = 'not_null'`.** Every column is non-nullable either way, so
  the nullability leg of the round-trip is only pinned for non-nullable columns. The
  nullable case is the one that fails today (blocker 1) and is called out in the spec's
  header comment.
- **`ALTER TABLE … ALTER PRIMARY KEY` onto a key with a conflict action is untested.** The
  existing `alter-primary-key-generated-ddl.spec.ts` cases have no `on conflict`.
- **Maintained-table / materialized-view backing DDL was not specifically exercised** for
  the `ON CONFLICT` change, though it shares `generateTableDDLInternal` and the full suite
  including the store leg passes.
- **Casing is inconsistent by design and unverified against every reader.** The new clause
  emits uppercase (`ON CONFLICT REPLACE`) to match the surrounding `CREATE TABLE` keywords,
  while the constraint fragment on the same line emits lowercase via
  `tableConstraintsToString`. Both re-parse; nothing compares this text case-sensitively as
  far as I could tell, but I did not audit every consumer.

## Review findings to carry forward

- Non-key column `ON CONFLICT` is dropped from emitted DDL → parked as a `NOTE:` at
  `packages/quereus/src/schema/ddl-generator.ts` `formatColumnDef` **and** filed as
  `tickets/backlog/bug-non-key-column-conflict-action-dropped-from-ddl` (it is reachable
  today, so it is a defect rather than a tripwire).
- `TableSchema.synthesizedPrimaryKey` looks dead in-repo but is read by `../lamina` →
  parked as a `NOTE:` on the field in `packages/quereus/src/schema/table.ts`, so the next
  reader does not repeat the deletion attempt.
- The synthesized-key clause omission and its two helpers are retired by
  `tickets/implement/3-debt-retire-synthesized-primary-key-distinction`, which stays in
  `implement/` — its prerequisite chain has not cleared.
