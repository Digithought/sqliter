----
description: Changing a column's data type (or filling in its blanks) can make two rows that used to be different become identical, but the in-memory backend does not re-check the uniqueness rule on that column, so a duplicate slips through silently.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts        # alterColumn (~2023); validate block (~2216); convertBaseRows (~2989); validateUniqueOverEffectiveRows (~3020); validateRekeyedUniqueStructures (~3069)
  - packages/quereus/src/vtab/memory/layer/base.ts            # populateIndexFromRows / …Async / addRowToIndex (~44-100)
  - packages/quereus/test/logic/41.7.3-alter-column-retype-unique.sqllogic   # NEW fixture
  - packages/quereus/test/logic.spec.ts                       # MEMORY_ONLY_FILES (~39)
  - docs/memory-table.md                                      # § DDL and transactions (~200)
difficulty: medium
----

# Memory backend: re-validate UNIQUE after a value-rewriting ALTER COLUMN

## Reproduced

Both of these are confirmed failures on `main` (memory module, run through
`test/logic.spec.ts`):

```sql
-- (a) SET DATA TYPE collapses two distinct texts onto one integer
create table t (id integer primary key, v text);
create unique index tv on t (v);
insert into t values (1, '1'), (2, '01');
alter table t alter column v set data type integer;   -- ACCEPTED, should reject
select id, v from t order by id;                      -- [{1,1},{2,1}]  <- duplicate
select id from t where v = 1;                         -- [{1},{2}]      <- index returns both
```

```sql
-- (b) SET NOT NULL backfill collapses two NULLs onto one DEFAULT
create table u (id integer primary key, v text null);
create unique index uv on u (v);
insert into u (id, v) values (1, null), (2, null);
alter table u alter column v set default 'x';
alter table u alter column v set not null;            -- ACCEPTED, should reject
select id, v from u order by id;                      -- [{1,'x'},{2,'x'}] <- duplicate
```

Note (b) is the same defect: SQL UNIQUE treats multiple NULLs as distinct, so the backfill
turns two legal rows into a collision. The original ticket only named SET DATA TYPE.

A note on the fixtures: in this engine a bare `v text` column is **NOT NULL**; you must write
`v text null` to hold NULLs. That is what makes (b) reachable at all.

## Why

`MemoryTableManager.alterColumn` (manager.ts ~2023) has two families of change that rewrite
stored values at the altered column index, both funnelled through a single
`valueConvert` closure:

- `SET DATA TYPE` with a changed physical type — `validateAndParse` per value (~2147);
- `SET NOT NULL` with a NULL backfill — `null → folded DEFAULT literal` (~2112), with
  `convertNulls = true`.

The uniqueness re-validation next to them (`validateRekeyedUniqueStructures`, ~3069) is gated
purely on `collationChanged` (~2231). Nothing re-checks uniqueness for the `valueConvert`
family. The rebuild that follows, `BaseLayer.rebuildPrimaryTreeFromRows` →
`rebuildAllSecondaryIndexes` → `populateSecondaryIndexes`, passes `enforceUnique = false`
deliberately (base rows are not a subset of the transaction's effective rows), so it cannot
catch it either — and would be the wrong place even if it could.

`SET COLLATE` got this guard when it landed; the value-rewriting paths never got the analogue.

## Expected behavior

A value-rewriting `ALTER COLUMN` re-validates every uniqueness-enforcing structure covering the
altered column, **over the converted values**, over the DDL transaction's effective rows, and
**before any mutation** — so a rejection throws `CONSTRAINT` (`UNIQUE constraint failed: <table>
(<cols>)`) and leaves the table, the schema and the transaction exactly as they were, matching
the `SET COLLATE` shape.

Unchanged semantics that must survive:

- NULLs stay mutually distinct under UNIQUE (`addRowToIndex`'s `hasNull` skip in base.ts ~102),
  so a `text → integer` retype of a column holding several NULLs must still be accepted.
- A retype the transaction's *deleted* rows would collide on must not block the change; a
  collision among rows it has *inserted but not committed* must reject it. That is what
  routing through the effective-row source buys.
- A non-colliding retype still succeeds, and index-backed lookups return the new values.

## Design

### Pass a row transform into the existing probe

`validateUniqueOverEffectiveRows` (~3020) builds a throwaway `MemoryIndex` over the effective
rows and lets `populateIndexFromRows{,Async}` raise on the first duplicate. It reads either the
wrapper-supplied `EffectiveRowSource` or `effectiveDdlRows()`. Give it — and its caller
`validateRekeyedUniqueStructures` — an optional row mapper applied to whichever stream it uses:

```ts
/** Row with the value at the altered column replaced by its post-ALTER form. */
type RowMapper = (row: Row) => Row;

private async validateUniqueOverEffectiveRows(
	indexSchema: IndexSchema,
	schema: TableSchema,
	rows?: EffectiveRowSource,
	mapRow?: RowMapper,
): Promise<void>;

private async validateRekeyedUniqueStructures(
	newSchema: TableSchema,
	alteredColumnIndex: number,
	rows?: EffectiveRowSource,
	mapRow?: RowMapper,
): Promise<void>;
```

Map at the manager (wrap the sync iterable / async iterable before handing it to
`populateIndexFromRows{,Async}`) rather than threading a mapper down into base.ts — those
helpers are shared with the real index build and should stay a straight row → index pipe.

The probe is constructed from `schema.columns`, and the call site passes `finalNewTableSchema`,
whose altered column already carries the **new** `logicalType`. That is what makes the probe's
comparator match the structure that will actually exist — it matters for e.g. `text → real`.

### Call site

Replace the `if (collationChanged) { … }` validate block (~2231) with a two-armed one, still
sited before `this.baseLayer.updateSchema(...)`:

```ts
if (collationChanged) {
	await this.validateRekeyedUniqueStructures(finalNewTableSchema, colIndex, rows);
	if (pkColumnRekeyed) this.validateRekeyedPrimaryKey(finalNewTableSchema);
} else if (valueConvert) {
	await this.validateRekeyedUniqueStructures(
		finalNewTableSchema, colIndex, rows,
		row => convertRowAtIndex(row, colIndex, valueConvert, convertNulls),
	);
}
```

The two arms are mutually exclusive today (`SET COLLATE` never sets `valueConvert`); keeping
them as separate arms rather than one merged pass keeps the collate path's PK pre-pass ordering
untouched.

### Share the per-row conversion with `convertBaseRows`

`convertBaseRows` (~2989) already encodes "convert the value at `colIndex`, pass NULL through
unless `convertNulls`". Factor its body out so the probe and the base rewrite cannot drift:

```ts
function convertRowAtIndex(
	row: Row,
	colIndex: number,
	convert: (v: SqlValue) => SqlValue,
	convertNulls: boolean,
): Row {
	const oldVal = row[colIndex];
	if (oldVal === null && !convertNulls) return row;
	return row.map((v, i) => i === colIndex ? convert(oldVal as SqlValue) : v) as Row;
}
```

The two callers differ **only** in error handling, and deliberately:

- `convertBaseRows` swallows a conversion failure and keeps the row as-is — a base value that
  fails here is shadowed by a pending delete/overwrite and no reader can see it (its existing
  docstring explains this). It keeps its `try`/`catch` around the helper.
- The probe must **not** swallow. Its rows are all visible, and the `setDataType` pre-pass
  (~2164) has already proved every one of them convertible, so a throw is unreachable; letting
  it propagate as `MISMATCH` is still better than silently probing a stale value that could
  mask a collision.

### Known gap that carries over unchanged

`validateRekeyedUniqueStructures` walks `newSchema.indexes`; a UNIQUE constraint covered by a
row-time materialized view rather than its auto-index is not walked (the auto-index always
exists alongside, so the structure is still validated). Its existing `NOTE:` says so — leave it
in place and make sure it still reads correctly once the docstring stops being SET-COLLATE-only.

## Testing

New cross-module-shaped fixture `test/logic/41.7.3-alter-column-retype-unique.sqllogic`, added
to `MEMORY_ONLY_FILES` in `test/logic.spec.ts` **for now** — the store backend has the same
defect plus a worse one, fixed by `bug-retype-unique-revalidation-store`, which removes the
entry. Say so in a comment next to the entry (that file's existing entries all carry a
one-line reason).

Cover:

- `text → integer` collision under `create unique index` (repro (a)) — rejects, and afterward
  the table is unchanged (`v` still text `'1'`/`'01'`) and still writable.
- `text → integer` collision under a table-level `unique (v)` constraint — same rejection via
  the auto-built covering index.
- `text → real` collision (`'1.0'` / `'1.00'`).
- `SET NOT NULL` backfill collision (repro (b)).
- **Accepted** cases that must not regress: a retype with no collision (and an index-backed
  lookup returning the new value afterwards); a retype of a column holding two or more NULLs
  under a unique index; a multi-column `unique (a, v)` where the retype of `v` collides only in
  a pair that also differs in `a` (must be accepted).
- A collision that exists only in rows the open transaction has **deleted** — must be accepted;
  and one only in rows it has **inserted** uncommitted — must be rejected.

Run: `yarn workspace @quereus/quereus run test` (single file while iterating:
`node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js
"packages/quereus/test/logic.spec.ts" --grep "41.7.3"` from the repo root).

## Docs

`docs/memory-table.md` § "DDL and transactions", rule 1 (~213) currently says "A collation
change is validated the same way…". Extend that paragraph to value-rewriting changes: `SET DATA
TYPE` and a `SET NOT NULL` DEFAULT backfill are re-validated over the **converted** values,
under the new column type, against the same effective rows.

## TODO

- Factor `convertRowAtIndex` out of `convertBaseRows`; keep `convertBaseRows`'s
  keep-on-failure behavior in its own `try`/`catch`.
- Add the optional `mapRow` parameter to `validateUniqueOverEffectiveRows` and
  `validateRekeyedUniqueStructures`; apply it to both the `EffectiveRowSource` and the
  `effectiveDdlRows()` streams.
- Update `validateRekeyedUniqueStructures`'s docstring — it is no longer the "SET COLLATE arm".
- Add the `else if (valueConvert)` arm to `alterColumn`'s pre-mutation validate block.
- Write `test/logic/41.7.3-alter-column-retype-unique.sqllogic` covering the list above; add it
  to `MEMORY_ONLY_FILES` with a reason comment pointing at the store ticket.
- Update `docs/memory-table.md` § DDL and transactions.
- `yarn workspace @quereus/quereus run test` and `yarn lint` green.
