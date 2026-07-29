---
description: Adding a column spelled "default null" to a table that already has rows used to succeed and leave those rows blank in a column the engine treats as mandatory, breaking every later insert; the statement is now refused up front.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts               # runAddColumn gate, ~line 460-494 — the real fix
  - packages/quereus/src/vtab/memory/layer/manager.ts              # MemoryTableManager.addColumn gate, ~line 1927-1941
  - packages/quereus-store/src/common/store-module-alter.ts        # StoreModuleBase.alterAddColumn ~line 176 — unchanged; the shape copied
  - packages/quereus/test/logic/41.4-alter-add-column-constraints.sqllogic  # new section 8 (8a-8e)
  - packages/quereus/test/optimizer/statistics.spec.ts             # line 588 — one-word edit
  - docs/sql-ddl.md                                                # new "ADD COLUMN over a non-empty table" block after the Default Values bullets
  - docs/memory-table.md                                           # ~line 372 — validateNotNullBackfill sentence made precise
difficulty: medium
---

# What changed

Quereus treats a column as mandatory unless you write `null`: the session option
`default_column_nullability` ships as `not_null`. So `alter table t add column extra text
default null` declared a **mandatory** column but supplied no usable value for the rows
already in the table. It was accepted; the existing rows kept NULL in a column reported as
`notnull = 1`, and every later `insert` that omitted the column failed with a NOT NULL
error. The user saw the INSERT break, but the mistake was an ALTER that had reported
success.

Two gates each asked a slightly wrong question. Both now ask the same one — *is there a
value for the existing rows?*

**Engine gate — `runAddColumn`** (`packages/quereus/src/runtime/emit/alter-table.ts:481-494`).
Was `columnDef.constraints?.some(c => c.type === 'notNull')` — mandatoriness read off the
statement text, so a column mandatory only via the session option never tripped it. Now
resolves it through `columnDefToSchema(columnDef, defaultNotNull, defaultCollation,
isCollationRegistered).notNull` — the same resolver the memory module, the store module
and the isolation layer's `deriveAddColumnBackfill` already use, so there is no fourth
spelling of the rule to drift. The companion `defaultIsNullish` test
(`!defaultConstraint?.expr || foldedDefault === null`) was already right and is untouched.

**Memory module gate — `MemoryTableManager.addColumn`**
(`packages/quereus/src/vtab/memory/layer/manager.ts:1941`). Was
`notNull && defaultValue === null && !defaultIsLiteral && !hasDefaultExpr &&
!backfillEvaluator && tableHasRows` — the two DEFAULT-*kind* clauses stepped aside for
`default null`, since a NULL literal still counts as "a literal was written". Now
`notNull && defaultValue === null && !backfillEvaluator && tableHasRows`, word for word
identical to `StoreModuleBase.alterAddColumn`. The `defaultIsLiteral` and `hasDefaultExpr`
locals are gone. The old `NOTE:` block that pointed at this ticket is gone with them — it
was the tripwire this ticket discharges.

The two shipped storage modules no longer disagree on identical SQL.

# What to exercise

Everything below is covered by section 8 of
`packages/quereus/test/logic/41.4-alter-add-column-constraints.sqllogic` (8a-8e), which runs
under **both** `yarn test` (memory) and `yarn test:store` (LevelDB store).

**Refused** — non-empty table, mandatory column, no value for the existing rows:

```sql
create table t (id integer primary key, name text null);
insert into t values (1, 'a');
alter table t add column extra text default null;   -- error: NOT NULL   (8a)
alter table t add column extra text default (null); -- error: NOT NULL   (8b, parenthesized)
alter table t add column extra text;                -- error: NOT NULL   (8e, no DEFAULT at all)
```

Each rejection is pre-mutation: `table_info` shows no `extra` column afterwards and writes
over the original shape still work. 8a asserts both.

**Still legal:**

- `add column extra text null default null` on a populated table — the column is optional,
  so NULL is a legitimate value for the existing rows; the existing row reads NULL and
  later inserts omitting the column still work (8c).
- Any `add column` on an **empty** table, mandatory or not — nothing to backfill, matching
  SQLite. NOT NULL then enforces from the first write: `insert` omitting the column fails,
  `insert` supplying it succeeds (8d).
- `add column x integer default 0` and every per-row source — `default (new.y)`,
  `generated always as (…)` — the evaluator fills each row and NOT NULL is enforced per
  row. Sections 5 and 7g of the same file cover these and were untouched.
- A module advertising `delegatesNotNullBackfill` still opts out entirely
  (`packages/quereus/test/alter-add-column-delegate.spec.ts`).

**Error-message change worth eyeballing.** For a bare `add column x text` on a non-empty
memory table the engine gate now fires *before* the memory module's, so the message became
`NOT NULL constraint failed for column 'x' added to main.t — column has no DEFAULT and
existing rows cannot be backfilled` instead of the memory module's `Cannot add NOT NULL
column 'x' to non-empty table … without a DEFAULT value`. Both contain "NOT NULL". No test
asserts the old wording literally; the closest
(`packages/quereus-store/test/alter-pending-ops.spec.ts:208`) matches
`/without a DEFAULT|NOT NULL/i` and still passes.

# Known gaps / things a reviewer should push on

- **`columnDefToSchema` now runs unconditionally in `runAddColumn`, including when the
  module declares `delegatesNotNullBackfill`.** That resolver has two side effects beyond
  nullability: it validates an explicit `COLLATE` clause and rejects `DEFAULT` +
  `GENERATED ALWAYS AS` on one column. Both errors were previously raised by the module
  *after* it had begun work; they are now raised pre-mutation, with the same message and
  the same `StatusCode`. For a delegating module this is a genuinely new pre-check it did
  not previously face. The delegate spec passes, but that spec does not declare a bad
  COLLATE or a DEFAULT+GENERATED column, so the new pre-check is **untested** on the
  delegating path. Worth deciding whether that is desirable (it matches the direction
  `runAddColumn` already leans) or whether the resolver call should be moved inside the
  `!delegatesBackfill` branch.
- **Two independent gates still encode the rule** — the engine's and each module's. They
  now agree, and the memory one is a literal copy of the store's, but nothing enforces that
  agreement mechanically. Section 8 running under both `yarn test` and `yarn test:store` is
  the only thing holding them together.
- **No unit test pins the resolution itself.** The regression coverage is all sqllogic and
  all runs with `default_column_nullability` at its shipped `not_null`. Nothing exercises
  the gate with the option flipped to `nullable` (where `add column extra text default
  null` *should* be accepted on a populated table, since the column is then optional). That
  is the direct inverse of the bug and is untested.
- **`default (null)` was verified empirically, not reasoned from the parser.** 8b passes,
  which means the parser folds the parenthesized NULL to a literal and the value-based gate
  catches it. If parenthesized-expression handling changes, that case would silently route
  through the per-row backfill instead — still an error, but a different one.

# Validation run

- `yarn lint` — clean (eslint + the `tsconfig.test.json` tsc pass over test files).
- `yarn test` — **7854 + 344 + 113 + 63 + 17 + 28 + 1176 + 594 + 52 + 31 + 34 + 134 + 22
  passing, 0 failing** (~5 min). Matches the fix stage's prototype run exactly.
- `yarn test:store` — **7845 passing, 22 pending, 0 failing** (~3 min). This is the run that
  proves both storage modules answer identically, and it was *not* done at fix stage.

One pre-existing test needed a one-word edit:
`packages/quereus/test/optimizer/statistics.spec.ts:588`, `ADD COLUMN extra TEXT DEFAULT
null` → `ADD COLUMN extra TEXT NULL DEFAULT null`. That test uses the ALTER only to produce
a frozen schema for an ANALYZE check; spelling the column nullable preserves its intent. It
was the only occurrence of `add column … default null` in the repo.

# Docs

- `docs/sql-ddl.md` — new block **"ADD COLUMN over a non-empty table needs a value for the
  rows that already exist"** after the Default Values bullets: mandatoriness is resolved
  (session option or explicit `not null`), a DEFAULT that is literally NULL supplies no
  value, a per-row source does count, empty tables are exempt, and
  `delegatesNotNullBackfill` opts a module out.
- `docs/memory-table.md` (~line 372) — the sentence already crediting
  `validateNotNullBackfill` with this rejection is now fully true; tightened to say the
  NOT NULL may come from the session option and that a DEFAULT folding to NULL counts as
  "no DEFAULT".
