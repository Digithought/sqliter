---
description: Adding a column that says "default null" to a table that already has rows quietly leaves those rows blank in a column the engine considers mandatory, and every later row you try to add is then rejected. Tighten the check so the statement is refused up front.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts               # runAddColumn — the engine-side gate (~line 472); the one real fix
  - packages/quereus/src/vtab/memory/layer/manager.ts              # MemoryTableManager.addColumn — the lax module gate (~line 1927)
  - packages/quereus-store/src/common/store-module-alter.ts        # StoreModuleBase.alterAddColumn (~line 176) — already correct; the shape to copy
  - packages/quereus/src/schema/table.ts                           # columnDefToSchema — resolves nullability from the session default
  - packages/quereus/test/optimizer/statistics.spec.ts             # line 588 — one-word edit, see below
  - packages/quereus/test/logic/41.4-alter-add-column-constraints.sqllogic  # suggested regression home (runs under memory AND store)
  - docs/sql-ddl.md                                                # lines ~299 / ~316 — the ADD COLUMN backfill rules
  - docs/memory-table.md                                           # line ~372 — names validateNotNullBackfill
difficulty: medium
---

# What is wrong

Quereus makes every column mandatory unless you write `null`: the session option
`default_column_nullability` ships as `not_null` (the Third Manifesto stance, not the
SQL-standard one). So a column added without either word is mandatory.

Adding a mandatory column to a table that already holds rows must be refused — there is
no value to put in those rows. Today one spelling slips through:

```sql
create table t (id integer primary key, name text);
insert into t values (1, 'a');
alter table t add column extra text default null;   -- accepted (should be refused)
```

`extra` is mandatory (`table_info('t')` reports `notnull = 1`), yet the existing row is
left holding NULL, and every later `insert into t (id, name) values (2, 'b')` fails with
`NOT NULL constraint failed: t.extra`. The user sees the INSERT fail, but the mistake was
in an ALTER that reported success.

Reproduced on `main` at `b42a2dd2` against a plain memory table — no store, no
transaction, no other constraint involved.

# Why it happens

Two gates decide whether an `ADD COLUMN` has a usable value source for the rows that
already exist, and each asks one wrong question:

- **`runAddColumn`** (`packages/quereus/src/runtime/emit/alter-table.ts`, ~line 473) reads
  mandatoriness off the *statement text*:
  `const hasNotNull = columnDef.constraints?.some(c => c.type === 'notNull') ?? false;`
  The column above gets its mandatoriness from the session option, not from the text, so
  the gate never fires. Everything downstream of that line is already right — the
  companion `defaultIsNullish` test (`!defaultConstraint?.expr || foldedDefault === null`)
  already treats `default null` as "no value source".
- **`MemoryTableManager.addColumn`** (`packages/quereus/src/vtab/memory/layer/manager.ts`,
  ~line 1946) uses the *resolved* mandatoriness (correct) but then asks *which kind of
  DEFAULT was written* rather than *is there a value to write*: the extra
  `&& !defaultIsLiteral && !hasDefaultExpr` clauses step aside for `default null`, because
  a NULL literal still counts as "a literal default was written".

`StoreModuleBase.alterAddColumn` (`packages/quereus-store`) already asks the right
question — `newColSchema.notNull && defaultValue === null && !backfillEvaluator` — and
would reject the same statement. That is the divergence the ticket names: the two shipped
storage modules disagree on identical SQL, with memory on the wrong side.

## Two things the original ticket asked to check — both are fine

- **`alter table … alter column … set not null` is NOT statement-text blind.** It scans the
  actual rows: `alter table t alter column v set not null` over a table holding a NULL `v`
  already fails with `column v contains NULL values`. No work needed.
- **The declarative `apply schema` route needs no separate fix.** `schema-differ.ts` (~line
  2444) emits literal `ALTER TABLE … ADD COLUMN <colDef>` text and re-executes it through
  the same `emitAlterTable` path, so fixing the engine gate covers it. (This is also why
  the `delegatesNotNullBackfill` capability already covers apply-schema, per
  `test/alter-add-column-delegate.spec.ts`.)

# The fix

## Engine gate — the real fix

In `runAddColumn`, resolve nullability instead of reading the statement text. Reuse
`columnDefToSchema` (already exported from `schema/table.ts`, and already the resolver
used by the memory module, the store module, and the isolation layer's
`deriveAddColumnBackfill`) so a fourth spelling of the same rule cannot drift:

```ts
const delegatesBackfill = module.getCapabilities?.().delegatesNotNullBackfill === true;
const defaultNotNull = rctx.db.options.getStringOption('default_column_nullability') === 'not_null';
const resolvedNotNull = columnDefToSchema(
	columnDef, defaultNotNull, rctx.db.options.getStringOption('default_collation'),
	(n) => rctx.db.isCollationRegistered(n),
).notNull;
if (resolvedNotNull && !delegatesBackfill && !backfill) {
	const defaultIsNullish = !defaultConstraint?.expr || foldedDefault === null;
	if (defaultIsNullish) {
		await validateNotNullBackfill(rctx, tableSchema, columnDef.name);
	}
}
```

Add `columnDefToSchema` to the existing `../../schema/table.js` import. Update the comment
block above the gate: it currently explains only the DEFAULT half; it should also say that
mandatoriness is *resolved*, not read off the text.

Note the deliberate side effect: `columnDefToSchema` also validates an explicit `COLLATE`
clause and rejects `DEFAULT` + `GENERATED ALWAYS AS` on one column. Both were previously
raised by the module, *after* it had begun work; raising them here moves them
**pre-mutation**, which is the direction this whole function already leans. Same message,
same `StatusCode`.

## Memory module gate — make the two modules agree

In `MemoryTableManager.addColumn`, drop the two DEFAULT-kind clauses so the condition
matches the store's word for word:

```ts
if (newColumnSchema.notNull && defaultValue === null && !backfillEvaluator && tableHasRows) {
```

`defaultIsLiteral` becomes unused — remove the variable and the `hasDefaultExpr` line with
it, keeping the `folded !== undefined` branch that assigns `defaultValue`. The
non-foldable-expression case (`default (new.x)`, `generated always as (…)`) still passes,
because the engine always supplies `backfillEvaluator` for it — exactly how the store's
identical gate has always behaved.

Replace the long `NOTE:` block at that gate (lines ~1938-1943) that points at this ticket:
it is the tripwire this ticket discharges, so it must go, not be updated.

## What stays legal

- `add column extra text null default null` — the column is optional, NULL is a legitimate
  value for the existing rows.
- Any `add column` on an **empty** table, mandatory or not (nothing to backfill; matches
  SQLite).
- `add column x integer default 0`, and every per-row source (`default (new.y)`,
  `generated always as (…)`) — the evaluator fills each row and enforces NOT NULL per row.
- A module advertising `delegatesNotNullBackfill` still opts out entirely.

# Validation already done

The change above was prototyped and the full `yarn test` run clean:
**7854 + 344 + 113 + 63 + 17 + 28 + 1176 + 594 + 52 + 31 + 34 + 134 + 22 passing, 0
failing** (~5 min), with exactly one test edit needed —
`packages/quereus/test/optimizer/statistics.spec.ts:588`:

```
-  await db.exec('ALTER TABLE frozen_test ADD COLUMN extra TEXT DEFAULT null');
+  await db.exec('ALTER TABLE frozen_test ADD COLUMN extra TEXT NULL DEFAULT null');
```

That test uses the ALTER only to produce a frozen schema for an ANALYZE check; spelling
the column nullable preserves its intent. It is the only occurrence of `add column …
default null` anywhere in the repo.

The prototype was then reverted, so the tree is clean and this is a fresh implementation.
Note the error-message change for a bare `add column x text` on a non-empty memory table:
the engine gate now fires first, so the message becomes `NOT NULL constraint failed for
column 'x' added to main.t — …` instead of the memory module's `Cannot add NOT NULL column
'x' to non-empty table …`. No test asserts the old wording literally; the only nearby
assertion (`packages/quereus-store/test/alter-pending-ops.spec.ts:208`) matches
`/without a DEFAULT|NOT NULL/i` and still passes.

`yarn test:store` was **not** run during the fix stage — do run it, since the memory gate
now matches the store's and the sqllogic corpus is what exercises the store path.

# TODO

- [ ] `runAddColumn` (`packages/quereus/src/runtime/emit/alter-table.ts`): replace
      `hasNotNull` with the resolved `columnDefToSchema(...).notNull`; add
      `columnDefToSchema` to the `schema/table.js` import; rewrite the gate's comment to
      say mandatoriness is resolved (session option or explicit `not null`), not read off
      the statement text.
- [ ] `MemoryTableManager.addColumn` (`packages/quereus/src/vtab/memory/layer/manager.ts`):
      reduce the gate to `notNull && defaultValue === null && !backfillEvaluator &&
      tableHasRows`; delete the now-dead `defaultIsLiteral` / `hasDefaultExpr` locals and
      the `NOTE:` block naming this ticket.
- [ ] `packages/quereus/test/optimizer/statistics.spec.ts:588` — `TEXT DEFAULT null` →
      `TEXT NULL DEFAULT null`.
- [ ] Regression cases in `packages/quereus/test/logic/41.4-alter-add-column-constraints.sqllogic`
      (sqllogic so `yarn test:store` proves both modules agree): on a table with rows,
      `add column extra text default null` → `-- error: NOT NULL`; `add column extra text
      null default null` → succeeds and the existing row reads NULL; on an **empty** table
      `add column extra text default null` → succeeds. Add a `default (null)` case too if
      the parser folds it — the gate is value-based, so it should be refused identically.
- [ ] Docs: `docs/sql-ddl.md` (~line 299 / ~316) — state that an `ADD COLUMN` is refused on
      a non-empty table whenever the new column is mandatory and nothing supplies a value
      for the existing rows, that mandatoriness may come from the session
      `default_column_nullability` rather than an explicit `not null`, and that a DEFAULT
      which is literally NULL counts as "no value". `docs/memory-table.md` (~line 372)
      already credits `validateNotNullBackfill` with this rejection — that sentence becomes
      fully true, so check it reads right rather than rewriting it.
- [ ] `yarn lint` (eslint + the test-file `tsc` pass) and `yarn test`; then `yarn test:store`.
