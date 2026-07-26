----
description: On the persistent (LevelDB) storage backend, changing a column's data type rewrites the stored data before checking whether the change breaks a uniqueness rule — so a change that gets rejected has already altered the rows, leaving the saved data disagreeing with the table definition.
prereq: bug-retype-unique-revalidation-memory
files:
  - packages/quereus-store/src/common/store-module.ts   # AlterColumnAttrChange (~237); alterColumnChange (~2091); UNIQUE re-validation block (~2177); PK re-key (~2201); index rebuild (~2234); alterColumnSetNotNull (~2265); alterColumnSetDataType (~2333); validateUniqueOverExistingRows (~1307)
  - packages/quereus/test/logic/41.7.3-alter-column-retype-unique.sqllogic   # fixture from the memory ticket
  - packages/quereus/test/logic.spec.ts                  # MEMORY_ONLY_FILES (~39) — remove the entry
difficulty: hard
----

# Store backend: validate UNIQUE before the ALTER COLUMN value rewrite, not after

## Reproduced

Against the store backend (`QUEREUS_TEST_STORE=true`), on `main`:

```sql
create table t (id integer primary key, v text);
create unique index tv on t (v);
insert into t values (1, '1'), (2, '01');
alter table t alter column v set data type integer;
```

The statement **does** raise `UNIQUE constraint failed` — but only from the secondary-index
rebuild that runs *after* the value rewrite has already been committed. Afterward:

```sql
select id, v from t order by id;        -- [{"id":1,"v":1},{"id":2,"v":1}]   values converted
select name, type from table_info('t'); -- v is still TEXT                    schema not changed
```

So the rows now hold integers under a column the catalog still calls TEXT, the duplicate is
resident, and the index that raised the error was mid-rebuild. Verified by running a scratch
sqllogic fixture in store mode; the exact assertions above passed.

This is strictly worse than the memory backend's version of the bug (which silently accepts and
leaves data consistent-but-duplicated). It is the same root cause seen from the other side: the
uniqueness check does not run over the converted values *before* the rewrite.

## Why

`StoreModule.alterColumnChange` (store-module.ts ~2091) is carefully ordered so that every
throw-only check precedes the first store mutation — its own comments say so (~2198, ~2205).
But the two value-rewriting sub-helpers break that order by mutating inside themselves:

- `alterColumnSetDataType` (~2333) runs `ddlCommitPendingOps()` then
  `table.mapRowsAtIndex(colIndex, v => v === null ? v : convert(v))` (~2362) and returns
  `valuesRewritten: true`;
- `alterColumnSetNotNull` (~2265) does the same for the `null → DEFAULT` backfill (~2309).

Both are called at the *top* of `alterColumnChange` (~2113-2116), before `updatedSchema` even
exists. So by the time the caller reaches its UNIQUE re-validation block (~2177) the data is
already rewritten — and that block does not fire anyway: it is gated on
`collationChanged || keyTransformChanged`, and a plain `text → integer` conversion changes
neither (`keyTransformChanged` only covers types with a semantic key transform, e.g. TIMESPAN
or JSON — see `storeSemanticKeyTransform`).

## Expected behavior

Same contract as the memory backend after `bug-retype-unique-revalidation-memory`: a
value-rewriting `ALTER COLUMN` re-validates every UNIQUE constraint covering the altered column
over the **converted** values and over the DDL transaction's effective rows, **before** any
store mutation. A rejection throws `CONSTRAINT` and leaves the stored rows, the persisted DDL
and the transaction untouched.

## Design

### Defer the rewrite instead of doing it inside the sub-helper

Carry the conversion out of the sub-helpers as a closure and let `alterColumnChange` apply it
once all throw-only checks have passed:

```ts
interface AlterColumnAttrChange {
	newCol: ColumnSchema;
	collationChanged: boolean;
	/**
	 * Per-value rewrite this change needs, DEFERRED: `alterColumnChange` applies it only
	 * after every throw-only check, so a rejected ALTER never leaves rewritten values
	 * behind a stale declared type.
	 */
	valueConvert?: (v: SqlValue) => SqlValue;
}
```

`valuesRewritten` disappears from the interface and becomes a local in `alterColumnChange`
(`const valuesRewritten = valueConvert !== undefined`), which still gates the secondary-index
rebuild at ~2234 exactly as today.

- `alterColumnSetDataType`: keep its throw-only convert pass over
  `table.iterateEffectiveValuesAtIndex(colIndex)` (~2356) where it is; drop the
  `ddlCommitPendingOps()` + `mapRowsAtIndex` pair and return `valueConvert: v => v === null ? v
  : convert(v)` instead.
- `alterColumnSetNotNull`: keep the reject-vs-backfill probe; return
  `valueConvert: v => v === null ? fill : v` **only** when `anyNull` was true (no NULLs → no
  rewrite, as today).

### Resulting order in `alterColumnChange`

1. sub-helper → `{ newCol, collationChanged, valueConvert }` (no mutation)
2. build `updatedColumns` / `updatedIndexes` / `updatedSchema` (unchanged)
3. compute `keyTransformChanged` (unchanged)
4. **UNIQUE re-validation**, gate widened to `collationChanged || keyTransformChanged ||
   valueConvert`, over rows mapped through `valueConvert` when present
5. PK re-key (`pkRekeyNeeded`) — unchanged
6. `ddlCommitPendingOps()` then `table.mapRowsAtIndex(colIndex, valueConvert)` when
   `valueConvert` is set — **new position**, was steps 1's job
7. secondary-index rebuild — unchanged condition `(valuesRewritten || keyTransformChanged) &&
   !pkRekeyNeeded`

Steps 5 and 6 both call `ddlCommitPendingOps()`; a second call with nothing pending is already
documented as a no-op.

### Mapping the row stream in step 4

The existing block reads
`rows ? rows() : rowsFromEntries(table.iterateEffectiveEntries(buildFullScanBounds()))` fresh
per constraint (an async generator is single-shot — keep that). Wrap it in a small async
generator that replaces the value at `colIndex` with `valueConvert(value)`, mirroring the memory
ticket's `convertRowAtIndex`. `validateUniqueOverExistingRows` (~1307) needs no signature
change; it already derives its key normalizers from the schema it is handed, and `updatedSchema`
carries the new `logicalType` (which is what its `logicalTypeCanHoldText` gate reads).

### Coverage of `create unique index` vs `unique (…)`

The store walks `updatedSchema.uniqueConstraints` filtered by `uc.columns.includes(colIndex)`.
A standalone `create unique index` synthesizes a matching `derivedFromIndex` UNIQUE constraint
(`packages/quereus/src/schema/table.ts` ~462), so both declaration shapes are already reachable
through that walk — no second walk over `indexes` is needed here, unlike the memory module.

### While you are in here

Confirm whether the store rejects a **primary-key** column retype the way memory does. Memory
throws `Cannot change the data type of primary key column …`; the store's missing carve-out is
tracked separately by `bug-store-pk-column-set-data-type-corrupts-keys`. Do **not** fix it here
— but the deferred-rewrite restructure touches the same function, so leave the code shaped so
that ticket can slot its check in front of `mapRowsAtIndex`, and note in the handoff whether the
two collide.

## Testing

Remove `41.7.3-alter-column-retype-unique.sqllogic` from `MEMORY_ONLY_FILES` in
`packages/quereus/test/logic.spec.ts` (the memory ticket added it there with a comment naming
this ticket) and make it pass in store mode too.

Add to that fixture, or a store-mode-aware sibling, the specific post-rejection assertions this
bug needs — a rejected retype must leave **both** the values and the declared type at their old
form:

```sql
select id, v from t order by id;         -- old TEXT values, both rows
select name, type from table_info('t');  -- v still TEXT
insert into t values (3, '001');         -- table still writable, still TEXT-typed
```

Note `table_info()` reports the declared type uppercased (`TEXT`, `INTEGER`) — the scratch run
tripped on that.

Run both modes:

```
yarn workspace @quereus/quereus run test 2>&1 | tee /tmp/test.log; tail -n 60 /tmp/test.log
yarn workspace @quereus/quereus run test:store 2>&1 | tee /tmp/store.log; tail -n 60 /tmp/store.log
```

Single file while iterating (from repo root):

```
QUEREUS_TEST_STORE=true node --import ./packages/quereus/register.mjs \
  node_modules/mocha/bin/mocha.js "packages/quereus/test/logic.spec.ts" --grep "41.7.3"
```

## TODO

- Replace `valuesRewritten` on `AlterColumnAttrChange` with a deferred `valueConvert` closure.
- Strip the `ddlCommitPendingOps()` + `mapRowsAtIndex` calls out of `alterColumnSetDataType`
  and `alterColumnSetNotNull`; keep both throw-only probes in place.
- In `alterColumnChange`: widen the UNIQUE re-validation gate to include `valueConvert`, map
  the row stream through it, and perform the flush + `mapRowsAtIndex` after the PK re-key.
- Re-check the ordering comments at ~2169-2237 — several of them describe the old placement.
- Remove the fixture from `MEMORY_ONLY_FILES`; extend it with the post-rejection
  values-and-declared-type assertions.
- `yarn workspace @quereus/quereus run test` and `test:store` green; `yarn lint` green.
- In the review handoff, state whether this restructure conflicts with
  `bug-store-pk-column-set-data-type-corrupts-keys`.
