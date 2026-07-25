----
description: On the persistent (LevelDB) store backend, changing a primary-key column's data type silently corrupts the table — the in-memory backend now refuses the same operation, so the two backends disagree.
files:
  - packages/quereus-store/src/common/store-module.ts   # alterColumnSetDataType (~1987) — no PK-column carve-out
  - packages/quereus-store/src/common/store-table.ts     # mapRowsAtIndex (~559); rekeyRows (~600)
  - packages/quereus/src/vtab/memory/layer/manager.ts    # alterColumn setDataType arm rejects PK-column retype (~2105)
difficulty: medium
----

# Store backend corrupts a table when a primary-key column's data type is changed

## What happens

Run, against a table stored in the persistent key-value store (LevelDB plugin):

```sql
create table t (id integer primary key, v text);
insert into t values (1, 'a');
alter table t alter column id set data type text;
```

The in-memory backend **rejects** this with `CONSTRAINT` ("Cannot change the data type of
primary key column 'id' …"). The store backend **accepts** it and leaves the table in a
physically inconsistent state.

## Why it corrupts

The store keys each row by its encoded primary key (`entry.key`) and stores the row payload
separately. `StoreModule.alterColumnSetDataType` (store-module.ts ~2016) converts a retyped
column by calling `StoreTable.mapRowsAtIndex`, which rewrites **the value at the column index
inside the row payload** but never touches the physical key:

```js
const newRow = row.slice();
newRow[colIndex] = newVal;
batch.put(entry.key, serializeRow(newRow));   // same OLD key, new payload
```

When `colIndex` is the primary-key column, the payload's PK value is now the new type (e.g.
integer `1`) while the physical key still encodes the OLD type (text `'a'`/`'1'`). Result:

- a point lookup under the new encoding (`where id = 1` as an integer key) does not find the row;
- a full scan returns a row whose stored PK value disagrees with its own key bytes;
- secondary index entries (which embed the PK suffix) still point at the old-encoded key.

The store already has the right primitive for this — `StoreTable.rekeyRows` re-encodes every
row's key under a new PK definition/collation and is what `SET COLLATE` on a PK member uses — but
`alterColumnSetDataType` does not call it, and does not reject the operation either.

## Expected behavior

Decide and unify the two backends' contract for retyping a primary-key column. The memory
backend chose to **reject** (the physical key bytes change, and a value-only rewrite cannot
re-key). The simplest fix is to make the store reject identically (mirror the memory carve-out at
store-module.ts ~1994, before the physical rewrite). If re-keying a PK column on type change is
instead desired, the store must drive `rekeyRows` (and the memory backend must implement the
re-key rather than reject) — a larger change. Reject-parity is the recommended first step;
re-key support can be a follow-up feature if a use case appears.

## Scope notes

- Reachable now — no shared/higher-level guard rejects a PK-column type change; each backend owns
  it, and only memory guards it.
- Non-PK-column `set data type` on the store is fine (payload rewrite is correct; keys unaffected).
- Discovered during review of `alter-column-set-data-type-sees-transaction-rows` (memory-only
  fix); that ticket added the memory-side reject and flagged the store side as unverified. This
  ticket is the verification result: store mis-handles it.
- Confirm under `yarn test:store` — the memory suite cannot exercise the store path.
