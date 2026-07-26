---
description: Changing a column's declared type to another type stored the same way (for example plain text to a date) neither rejects values the new type would refuse nor rewrites values into the new type's canonical spelling, so a date column can end up holding the word "hello", and a date written as "2024-06-05T00:00:00Z" becomes invisible to a search for "2024-06-05".
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts        # alterColumn — same-physical-class SET DATA TYPE branch (~2153) and the three valueConvert/structuresRekeyed if-else chains (~2305, ~2340, ~2382)
  - packages/quereus/src/vtab/memory/layer/transaction.ts    # convertColumn (~360) / adoptSchema (~201) — what the open-layer half does
  - packages/quereus-store/src/common/store-module.ts        # alterColumnSetDataType (~2394) physical-class gate; alterColumnChange (~2100-2280) already composes value rewrite + key-transform change
  - packages/quereus-isolation/src/isolation-module.ts       # deriveSetDataTypeConvert (~1793) — same physical-class gate on the overlay leg
  - packages/quereus/test/logic/41.2-alter-column.sqllogic   # SET DATA TYPE coverage
  - packages/quereus/test/alter-table-conformance.spec.ts    # memory leg of the ALTER conformance matrix
  - packages/quereus-store/test/timespan-semantic-key-identity.spec.ts  # store leg's existing same-class retype tests
  - docs/sql-ddl.md                                          # line 616 SET DATA TYPE bullet, line 618 UNIQUE re-validation bullet
difficulty: hard
---

# `SET DATA TYPE` must validate *and* normalize when the storage class does not change

## What was reproduced (memory module, autocommit, on `main`)

Every case below currently **succeeds silently**. Verified by driving a throwaway spec against
`packages/quereus/src/index.ts`.

**1. Illegal value survives.**

```sql
create table j (id integer primary key, v text);
insert into j values (1, 'hello');
alter table j alter column j.v set data type date;  -- ACCEPTED
select v from j;                                    -- 'hello', column declared DATE
insert into j values (2, 'world');
-- MISMATCH: Cannot convert 'world' to DATE
```

**2. A non-canonical value survives and becomes unfindable.** This is the finding that settles the
ticket's open question — it is not cosmetic.

```sql
create table t (id integer primary key, v text);
insert into t values (1, '2024-06-05T00:00:00Z');
alter table t alter column v set data type date;    -- ACCEPTED
select v from t;                     -- '2024-06-05T00:00:00Z'  (an INSERT would have stored '2024-06-05')
select id from t where v = '2024-06-05';            -- NO ROWS
```

`DATE.compare` is hard-wired to `BINARY_COLLATION` over the stored text (`types/temporal-types.ts:72`),
so an un-normalized value does not compare equal to the canonical spelling of the same date.

**3. …and a UNIQUE column therefore admits a duplicate.**

```sql
create table u (id integer primary key, v text unique);
insert into u values (1, '2024-06-05T00:00:00Z');
alter table u alter column v set data type date;    -- ACCEPTED
insert into u values (2, '2024-06-05');             -- ACCEPTED — same date, two rows
```

**4. TIMESPAN's semantic ordering does not rescue it either.** `TIMESPAN.parse` accepts human text,
but `TIMESPAN.compare`'s `timespanTotalSeconds` does not, so it falls back to binary text compare:

```sql
create table k (id integer primary key, v text);
insert into k values (1, '1 hour');
alter table k alter column v set data type timespan; -- ACCEPTED, stored stays '1 hour'
select id from k where v = 'PT1H';                   -- NO ROWS
```

**5. Temporal → temporal narrowing is affected too.** `date` → `time` is accepted with
`'2024-06-05'` still stored, which `TIME.parse` would reject on insert.

## Decision on the open question: **normalize**

The fix stores the converted value, it does not merely throw. Cases 2–4 show that leaving values
byte-identical is not the "smaller, safer" option — it leaves rows that no query can match and that
UNIQUE cannot dedupe. Normalizing also makes the same-class arm identical in shape to the
class-changing arm, which is one behavior to document and test instead of two.

Concretely: on a same-physical-class retype where the logical **type object** actually changes,
run `validateAndParse` over every value and keep the result.

## Which retypes this newly touches

`inferType` returns the *shared* type object for aliases, so `text → varchar(50)` and
`integer → bigint` flatten to the identical `LogicalType` and must remain a pure no-op — gate the
whole new path on `newLogicalType !== oldCol.logicalType`, not on the type *name*.

Physical classes with more than one logical type (`types/builtin-types.ts`, `temporal-types.ts`):

| physical class | logical types | effect of the fix |
| --- | --- | --- |
| TEXT | TEXT, DATE, TIME, DATETIME, TIMESPAN | validate + normalize (the cases above) |
| REAL | REAL, NUMERIC | scan added; numbers pass through `NUMERIC.parse` unchanged, so no behavior change |
| NULL | NULL, ANY | `ANY.parse` is identity; no behavior change |
| INTEGER / BLOB / BOOLEAN / OBJECT | one type each | unreachable |

**Out of scope, deliberately:** `VARCHAR(n)` over-length. The engine already ignores declared
length — an over-length `INSERT` into `varchar(2)` is accepted today — and `inferType('varchar(2)')`
returns `TEXT_TYPE` itself, so no scan even runs. That matches SQLite; leave it, and say so in the
docs bullet rather than filing it.

## Memory module: the structural obstacle

`MemoryTableManager.alterColumn` currently treats "the comparator moved" and "the values were
rewritten" as **mutually exclusive**, in three places (`manager.ts` ~2305, ~2340, ~2382), each an
`if (structuresRekeyed) … else if (valueConvert) …`. Its own comment says so: *"The two arms are
mutually exclusive today — neither comparator trigger sets `valueConvert`."*

Normalizing a same-class retype sets **both** for the first time (`text → date` moves the
comparator *and* rewrites values), so the `else if` would silently skip the value-rewrite half.
The three chains must be reordered to put `valueConvert` **first**:

- **Pre-pass** — `validateRekeyedUniqueStructures(finalNewTableSchema, colIndex, rows, mapRow)`
  already takes both a new schema and a row mapper, so the combined case is exactly one call:
  judge the **converted** rows under the **new** comparators. This is what makes case 3 above
  reject with `CONSTRAINT` instead of admitting the duplicate.
- **Base rebuild** — the `valueConvert` branch's `convertBaseRows` + `rebuildPrimaryTreeFromRows`
  subsumes `rebuildAllSecondaryIndexes`: it rebuilds every secondary index from the converted rows,
  and `baseLayer.updateSchema(finalNewTableSchema)` has already installed the new comparators.
- **Open layers** — `TransactionLayer.convertColumn` subsumes `adoptSchema` for this case: it
  assigns `tableSchemaAtCreation = newSchema` and rebuilds every secondary index from scratch
  (`transaction.ts:423-428`), so the layers pick up the new comparators as well as the new values.

`pkColumnRekeyed` stays safe under the reorder: it is `collationChanged && pk-member`, and
`collationChanged` is set only by the `SET COLLATE` arm, which never sets `valueConvert` — so
whenever `pkColumnRekeyed` is true, `valueConvert` is null and the `structuresRekeyed` branch still
runs. Keep the existing comments honest — they currently assert the exclusivity that is being
removed.

Keep building fresh `IndexSchema` objects on `structuresRekeyed` (the identity signal
`TransactionLayer.adoptSchema` discriminates on); it is harmless on the combined path.

Widen the same-class arm's primary-key guard from `comparatorChanged && pk-member` to fire whenever
the logical type object changes on a PK member. It is defense-in-depth for direct module calls —
the engine already refuses `SET DATA TYPE` on a PK column in `runtime/emit/alter-table.ts:974`.

## Store module: much simpler

`StoreModule.alterColumnSetDataType` (`store-module.ts` ~2394) gates its throw-only pass and its
deferred `valueConvert` on `newLogicalType.physicalType !== oldCol.logicalType.physicalType`.
Change that to `newLogicalType !== oldCol.logicalType`. The caller `alterColumnChange` already
composes `rewritesValues` and `keyTransformChanged` **additively** (`store-module.ts:2210`, `:2273`,
`:2296`) rather than exclusively, so no restructuring is needed there. Re-read the `NOTE` at
`:2263` about `valueConvert` and `pkRekeyNeeded` never coinciding — it stays true (a PK retype is
refused upstream), but confirm it while you are in the file.

Pre-existing and **not** this ticket's job: the store's sub-helper scans
`table.iterateEffectiveValuesAtIndex` and ignores the wrapper-supplied `rows`, unlike the memory
leg. Under isolation the overlay's own conversion covers staged rows, so no gap is introduced.
Leave a `NOTE:` at the site if one is not already there.

## Isolation module: the third leg

`IsolationModule.deriveSetDataTypeConvert` (`isolation-module.ts` ~1793) has the *same* physical-class
gate and returns `undefined` for a "metadata-only retype", so staged overlay rows would keep raw
values while committed rows get normalized. Change the same condition. Its doc comment explicitly
says it mirrors the two underlyings' gate so the legs cannot drift — update that comment with the
gate.

All three legs must land together; a partial fix leaves the backends disagreeing, which is exactly
what the ALTER conformance matrix exists to catch.

## Expected behavior after the fix

- A `SET DATA TYPE` judges existing values against the new type whether or not the physical storage
  class changes. The first value the transaction can **see** that the new type rejects fails the
  statement with `MISMATCH`, leaving the declared type, the stored values and the enclosing
  transaction untouched.
- A value only in a row the transaction has **deleted** does not block the change.
- Accepted retypes rewrite each value to the new type's canonical form, so the post-ALTER table is
  a state an `INSERT` could have produced.
- If normalization collapses two previously-distinct values covered by a UNIQUE constraint, the
  statement fails with `CONSTRAINT` before anything is mutated.

## TODO

**Phase 1 — memory module**

- In `alterColumn`'s same-physical-class `setDataType` branch, when
  `newLogicalType !== oldCol.logicalType`: build the same `convert` closure the class-changing arm
  uses (`validateAndParse`, rethrown as `MISMATCH` with the existing message), run the throw-only
  pass over the effective rows (`rows()` when supplied, else `effectiveDdlRows()`), and set
  `valueConvert`.
- Widen that branch's PK rejection to any logical-type change on a PK member.
- Reorder the three `structuresRekeyed` / `valueConvert` chains to test `valueConvert` first, and
  rewrite the comments that assert the two are mutually exclusive.
- Check `convertBaseRows`' swallow-on-failure and `TransactionLayer.convertColumn`'s equivalent
  still read correctly now that the same-class path reaches them.

**Phase 2 — store and isolation legs**

- `StoreModule.alterColumnSetDataType`: gate on logical-type identity instead of physical class.
- `IsolationModule.deriveSetDataTypeConvert`: same gate, and update its mirror-the-underlyings
  comment.

**Phase 3 — tests**

- `test/logic/41.2-alter-column.sqllogic`: `text → date` rejecting `'hello'` (type and value
  unchanged after the reject); `text → date` normalizing `'2024-06-05T00:00:00Z'` to `'2024-06-05'`
  with the equality lookup then finding the row; `text → timespan` normalizing `'1 hour'` to
  `'PT1H'`; `date → time` rejecting; `text → varchar(50)` still a no-op.
- `test/alter-table-conformance.spec.ts`: a same-storage-class **narrowing** arm expecting
  `MISMATCH`, and a same-storage-class **normalization collides under UNIQUE** arm expecting
  `CONSTRAINT` (the combined value-rewrite + comparator-move path, which nothing exercises today).
  Add the matching arms to the store leg (`packages/quereus-store/test/`) and the isolation leg
  (`packages/quereus-isolation/test/`).
- Transaction coverage: a pending insert of an illegal value rejects; a value only in a row the
  transaction deleted does not block; the transaction's own pending rows are normalized too (memory
  `convertColumnOnOpenLayers`, isolation overlay).
- Confirm the existing same-class retype tests still pass —
  `packages/quereus-store/test/timespan-semantic-key-identity.spec.ts` § "ALTER interactions" and
  the two TIMESPAN conformance arms at `alter-table-conformance.spec.ts:338` and `:364`.

**Phase 4 — docs and validation**

- `docs/sql-ddl.md:616`: the "rewrites no stored value when the new type shares the same physical
  representation" clause is now wrong. Say instead that every retype between *different* logical
  types validates and normalizes every value, that only a retype between aliases of one type
  (`TEXT` → `VARCHAR(50)`, `INTEGER` → `BIGINT`) is schema-only, and note explicitly that declared
  lengths such as `VARCHAR(n)` are not enforced. Check line 618's UNIQUE bullet still reads true.
- `yarn build && yarn test`, then `yarn test:store`, and the isolation package's own suite.
