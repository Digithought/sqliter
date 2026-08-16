---
description: Right now a table that names its identity columns out loud is forbidden from leaving them empty, while an identical table that says nothing is allowed to — this makes the two spellings mean the same thing, so declaring the key no longer changes what values it accepts.
prereq: bug-isolation-null-pk-shadow-key, bug-set-not-null-backfill-can-merge-two-primary-keys
files:
  - packages/quereus/src/schema/manager.ts (`buildColumnSchemas` ~1731-1747 — the `(isPkColumn && !synthesized)` term)
  - packages/quereus/src/schema/table.ts (`columnDefToSchema` ~544-546 — `if (schema.primaryKey) schema.notNull = true;`; `findPKDefinition` ~1191 doc comment)
  - packages/quereus/src/runtime/emit/alter-table.ts (~1468-1471 DROP NOT NULL on a PK column; ~1777-1782 ALTER PRIMARY KEY nullable-column refusal)
  - packages/quereus/src/vtab/memory/layer/manager.ts (~2585-2590 — the memory backend's copy of the ALTER PRIMARY KEY refusal)
  - packages/quereus/src/vtab/memory/layer/alter-column.ts (`planSetNotNull` ~179-186 — memory's DROP NOT NULL on a PK column)
  - packages/quereus-store/src/common/store-module-alter-column.ts (~371-377 — the store's copy of the same refusal)
  - packages/quereus/src/schema/schema-differ.ts (`extractDeclaredNotNull` ~2587-2597 — "PK always implies NOT NULL")
  - docs/schema.md (§ "Primary-key nullability" ~42)
  - docs/sql-constraints.md (~17 — the synthesized-key paragraph; also the FK § 7.6 it points at)
  - docs/sql-txn.md (~223 — "Primary key columns are always NOT NULL regardless of this setting")
  - packages/quereus/test/logic/10.2-column-features.sqllogic (~223-231 — case "3c. Primary key column is always NOT NULL")
  - packages/quereus/test/logic/43-default-nullability.sqllogic, 43.1-notnull-or-conflict.sqllogic (nearest existing coverage; new cases go in a sibling 43.2)
difficulty: medium
---

# `PRIMARY KEY` stops implying `NOT NULL`

## The decision this implements

The maintainer's direction, recorded on the originating plan ticket: **an undeclared
all-columns key is syntactic sugar for the declared one**, not a different kind of key.
Today the two disagree, and only about nullability:

```sql
pragma default_column_nullability = 'nullable';

create table a (x integer, y integer);                     -- key (x, y), both nullable
create table b (x integer, y integer, primary key (x, y)); -- key (x, y), both forced NOT NULL
```

After this change both tables have a key of `(x, y)` with both columns nullable. `primary
key` means "these columns are the row identity" and nothing more; nullability is whatever
the column declared or the session's `default_column_nullability` gave it.

Backwards compatibility is explicitly **not** a constraint here (the only downstream
consumer, SiteCAD, is unreleased). Where a choice trades correctness against migration
cost, take correctness.

Note the shipped default is `default_column_nullability = 'not_null'`
(`packages/quereus/src/core/database.ts` ~338), so under stock settings almost nothing
observable changes — a bare `create table t (id integer primary key, …)` still yields a
non-nullable `id`. The visible change appears only where a column is nullable by explicit
declaration (`x integer null primary key`) or by the session default being set to
`'nullable'`.

## Why nullable is the coherent side

Both storage backends already treat NULL as an ordinary, self-equal value in key position:
the memory backend compares `NULL == NULL` as equal and orders NULL first, and the store's
key codec encodes NULL as an ordinary type tag (`TYPE_NULL = 0x00` in
`packages/quereus-store/src/common/encoding.ts`) that sorts first. That is what already
makes a nullable *synthesized* key work — two fully-identical all-NULL rows collide as a
duplicate key rather than both being admitted. The engine has already chosen
NULL-as-a-value for key comparison and shipped it; the declared-PK promotion is the one
place that contradicts it.

This does **not** change the SQL `UNIQUE` rule, where NULLs are distinct and never collide
(`packages/quereus/src/planner/mutation/lens-enforcement.ts`, and the store's
`dedupeRowSignature`, which deliberately returns no signature for a NULL component). Key
comparison and `UNIQUE` enforcement answering NULL differently is the state that ships
today; this change widens where the existing key rule applies rather than introducing a new
one. Say so explicitly in the docs — it is the first thing a careful reader will ask.

## Foreign keys — settled, no code change

The originating ticket flagged this as needing an answer before merge. It has one, and the
engine already implements it uniformly:

**A parent key tuple containing NULL is unreferenceable.** Nothing changes in the FK code.

- *Child side.* `synthesizeFKExistsExpr`
  (`packages/quereus/src/planner/building/foreign-key-builder.ts` ~91) wraps the parent
  `EXISTS` in `IS NULL` guards on every child column — MATCH SIMPLE. A child row with a
  NULL in its FK columns is admitted unchecked. A child row with non-NULL values compares
  with `=` against the parent columns, and `=` against NULL is never true, so a non-NULL
  child can never match a NULL-containing parent key.
- *Parent side.* Every parent-side action path already skips a parent tuple containing NULL
  under the same rule — `packages/quereus/src/runtime/foreign-key-actions.ts` ~128, ~432,
  ~575, ~794, each commented "MATCH SIMPLE: NULL parent values cannot be referenced". So
  `restrict` does not fire for it and `cascade` / `set null` do not propagate from it.

That path is not new: an FK may already reference a nullable `UNIQUE` column, so a
NULL-containing parent key is reachable on `main`. This change only makes it reachable via
a *primary* key too — most visibly through `references <parent>` with no column list, which
resolves to the parent's primary key (`docs/sql-constraints.md` § 7.6). Document the rule
there; add tests; write no new enforcement code.

## Scope

**Remove the promotion** (three sites):

- `packages/quereus/src/schema/manager.ts` `buildColumnSchemas` — the `notNull:
  (isPkColumn && !synthesized) ? true : col.notNull` term collapses to `col.notNull`, and
  the `synthesized` local is no longer needed for it (it is still needed for the
  `synthesizedPk` return value; the follow-up ticket retires that).
- `packages/quereus/src/schema/table.ts` `columnDefToSchema` — delete the
  `if (schema.primaryKey) { schema.notNull = true; }` block. Leave the `pkOrder` defaulting
  immediately below it alone.
- `packages/quereus/src/schema/schema-differ.ts` `extractDeclaredNotNull` (~2587) — delete
  the `// PK always implies NOT NULL.` early return. This is the **declarative-schema
  differ**'s own copy of the rule: it reads nullability off a declared `CREATE TABLE` AST so
  `apply schema` can tell what changed. Left in place it would compute a phantom
  `SET NOT NULL` for every nullable key column on every apply — the declared side would say
  non-nullable, the live catalog would say nullable, and the difference would never
  converge. Note it is already inconsistent today: it only inspects *column-level*
  constraints, so a table-level `primary key (x, y)` never got the promotion here even
  though the engine applied one. Removing the line makes the two agree.

**Remove the refusals that exist only because of the promotion** (five sites, three rules):

- `ALTER TABLE … ALTER PRIMARY KEY (<nullable column>)` — "Column '…' must be NOT NULL to
  participate in PRIMARY KEY", raised by the engine
  (`runtime/emit/alter-table.ts` ~1780) and again by the memory backend
  (`vtab/memory/layer/manager.ts` ~2587). Both go.
- `ALTER TABLE … ALTER COLUMN <pk column> DROP NOT NULL` — "Cannot DROP NOT NULL on PRIMARY
  KEY column", raised by the engine (`runtime/emit/alter-table.ts` ~1469), the memory
  backend (`vtab/memory/layer/alter-column.ts` ~181) and the store
  (`quereus-store/src/common/store-module-alter-column.ts` ~375). All three go: dropping
  NOT NULL is a pure schema loosening — it re-keys nothing, rewrites no row, and the
  existing rows stay non-NULL. The engine's neighbouring `Cannot SET DATA TYPE on PRIMARY
  KEY column` refusal is a *different* rule and **stays**.

If a refusal turns out to be load-bearing for a reason not listed here, keep it and say so
explicitly in the review handoff rather than working around it.

**Docs to rewrite in place** — these currently describe the split as intended behaviour, so
leaving them is worse than the code change:

- `docs/schema.md` § "Primary-key nullability" (~42) — restate as one rule for both
  spellings, with the NULL-in-key / NULL-in-`UNIQUE` contrast spelled out.
- `docs/sql-constraints.md` (~17) — the synthesized-key paragraph; and the FK section it
  points at (§ 7.6) gains the parent-key-containing-NULL rule above.
- `docs/sql-txn.md` (~223) — "Primary key columns are always NOT NULL regardless of this
  setting" is simply false afterwards. Replace it: `default_column_nullability` now governs
  key columns like any other.
- The doc comments that state the old rule as design: `findPKDefinition`
  (`schema/table.ts` ~1183-1235, both the `@returns` note and the block comment above the
  synthesized return) and the "Only an explicitly-declared PK forces NOT NULL" comment in
  `buildColumnSchemas`.
- `packages/quereus/src/vtab/memory/layer/manager.ts` ~2625 carries a `NOTE:` whose premise
  ("which a PK member cannot — the engine enforces NOT NULL on every PK member regardless of
  the declared nullability") this change falsifies outright. The defect it predicts is the
  prerequisite ticket `bug-set-not-null-backfill-can-merge-two-primary-keys`; once that has
  landed, update this comment to match whatever it decided rather than leaving a stale
  premise in place.

**Out of scope, deliberately:** the canonical-DDL emitter's omission of the `PRIMARY KEY`
clause for a synthesized key, and the `TableSchema.synthesizedPrimaryKey` /
`isSynthesizedAllColumnsKey` pair. Those become unnecessary once the promotion is gone, but
retiring them is its own change with its own round-trip test surface — see
`tickets/implement/debt-retire-synthesized-primary-key-distinction`. **Leave
`ddl-generator.ts` alone in this ticket.** Its behaviour stays correct throughout: it keeps
omitting the clause, and the re-parse keeps re-synthesizing the same key — now with the
same nullability on both sides instead of a silently tightened one.

## Correction to the originating ticket

The plan ticket suspected that `ALTER TABLE … ADD COLUMN` leaves a synthesized key at its
old width while a DDL round-trip re-synthesizes it *wider*, giving one table two different
keys. **That is not what happens.** `isSynthesizedAllColumnsKey`
(`schema/table.ts` ~1262) returns false as soon as `primaryKeyDefinition.length !==
columns.length`, so after an ADD COLUMN the emitter *does* render an explicit
`PRIMARY KEY (a, b)` clause and the key width round-trips correctly. What diverges today is
**nullability**: the re-parse reads that clause as a declared PK and forces `a` and `b` NOT
NULL, while the live table has them nullable. This change removes that divergence. Do not
file a separate key-width ticket; verify the above with a test instead (listed below).

## Edge cases & interactions

- **`create table t (x integer null primary key)`** — the headline case. `x` must end up
  nullable and `insert into t values (null)` must succeed.
- **`pragma default_column_nullability = 'nullable'`** then a declared PK with no explicit
  nullability — same outcome, via the session default rather than an explicit `null`.
- **`default_column_nullability = 'not_null'` (the shipped default)** — a bare
  `id integer primary key` stays NOT NULL. Assert this; it is the case that must *not*
  change, and it is most of the existing corpus.
- **Duplicate NULL keys collide.** Two inserts of an all-NULL key must fail as a duplicate
  primary key, not both be admitted — this is the property that makes a nullable key a real
  identity. Test single-column and composite, and both backends.
- **`insert or replace` / `on conflict` on a NULL-containing key** must resolve against the
  existing NULL-keyed row, not insert a second one.
- **`update` that moves a key column to NULL**, and back — the row must remain addressable
  by its new key and not duplicate the old one.
- **`NULL` vs `UNIQUE`.** `create table t (x integer null primary key, y integer null unique)`
  — two rows with `y = null` are legal (UNIQUE is NULL-distinct) while two rows with
  `x = null` are not (key equality is NULL-equal). Both in one test, side by side, so the
  contrast is recorded where a reader will hit it.
- **Foreign keys.** A child `references parent` (no column list) against a parent whose PK
  row contains NULL: the child row is rejected when its FK values are non-NULL (no match)
  and admitted when any is NULL (MATCH SIMPLE). `on delete cascade` / `restrict` must not
  fire when the deleted parent's key contains NULL. Cover both directions.
- **`ALTER TABLE … ALTER PRIMARY KEY` onto a nullable column** now succeeds. Existing rows
  holding NULL in that column must remain present and addressable, and a collision among
  them must be reported as a duplicate key, not silently merged.
- **`ALTER TABLE … ALTER COLUMN <pk column> DROP NOT NULL`** now succeeds and rewrites no
  rows. Follow it with an insert of NULL into that column to prove the loosening took
  effect, on both backends.
- **`ALTER TABLE … ALTER COLUMN <pk column> SET NOT NULL`** — the collision path owned by
  the prerequisite `bug-set-not-null-backfill-can-merge-two-primary-keys`. Do not re-solve
  it here; add a case asserting whatever behaviour that ticket settled on, so the two stay
  in lock-step.
- **DDL round-trip with `generateTableDDL`.** `create table t (x integer null, y integer
  null primary key (x, y))`, emit, re-parse in a fresh `Database`, and assert the key *and*
  each column's nullability survive. Cover the post-`ADD COLUMN` shape from the correction
  above too: no-PK table, add a column, emit, re-parse, assert the key is the original
  narrow key and the columns keep their declared nullability.
- **Store persistence round-trip.** The same assertions through `yarn test:store`, since
  the store rehydrates from persisted DDL text rather than from the live schema object.
- **Existing databases.** A schema persisted before this change already has `notNull: true`
  baked into its column schemas and its persisted DDL, so a reopen does not retroactively
  loosen anything. Confirm this rather than assuming it — read one persisted catalog entry
  in a store test and check the emitted DDL still carries the explicit `not null`.
- **Isolation layer.** The prerequisite `bug-isolation-null-pk-shadow-key` fixes the shadow
  key. Add one case here that exercises a nullable *declared* key through a transaction and
  a secondary-index read, so the two tickets' coverage meets.
- **`catalog-rendering.ts`** renders each column as `not null` / `null` plus a `pk` marker;
  a nullable PK column now renders `null … pk`. Check nothing downstream parses that
  rendering as mutually exclusive.
- **`apply schema` idempotence.** Declare a table with a nullable primary key, apply it,
  then apply the identical schema again and assert the second apply is a no-op. This is the
  case the `schema-differ.ts` change exists for, and a phantom `SET NOT NULL` here would be
  invisible until someone ran apply twice.

## TODO

- Remove the two promotion sites; remove the five refusal sites (three rules).
- Rewrite the four doc locations and the four stale code comments listed above.
- Rewrite `packages/quereus/test/logic/10.2-column-features.sqllogic` case "3c. Primary key
  column is always NOT NULL" (~223-231). Under the shipped `not_null` default the insert
  still fails, so keep the case but re-title it and add the explicit-`null` counterpart that
  now succeeds — do not delete the case.
- Add `packages/quereus/test/logic/43.2-nullable-primary-key.sqllogic` covering the edge
  cases above that are expressible in SQL. Sibling of the existing `43-default-nullability`
  / `43.1-notnull-or-conflict` files, so it runs under both `yarn test` and
  `yarn test:store`.
- Add the DDL round-trip assertions as a TypeScript spec (alongside
  `packages/quereus/test/alter-primary-key-generated-ddl.spec.ts`, which already has the
  emit → re-parse → compare harness).
- Run `yarn build`, `yarn test`, `yarn lint`, then `yarn test:store` — the store leg is not
  optional here, since three of the changed sites and the persistence round-trip live in it.
- In the review handoff, state plainly: which refusals you removed and which you kept and
  why; whether any existing test had to change meaning rather than just wording; and the
  result of the "existing databases do not retroactively loosen" check.
