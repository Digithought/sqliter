---
description: Adding or removing a column while a transaction is open corrupts that transaction's data — rows come back with values under the wrong column names, newly added columns silently vanish table-wide, and in some cases rows disappear entirely when the transaction commits.
prereq:
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts       # addColumn (~1756), dropColumn (~1839), commitTransaction (~397), convertColumnOnOpenLayers (~3338), openTransactionLayersOldestFirst (~3360)
  - packages/quereus/src/vtab/memory/layer/transaction.ts   # convertColumn (~366) — the method the fix is modelled on; adoptSchema (~201), rekeyPrimaryKey (~271), reindexOwnWrites (~454)
  - packages/quereus/src/vtab/memory/layer/base.ts          # addColumnToBase (~339), dropColumnFromBase (~399)
  - packages/quereus/src/vtab/memory/layer/row-convert.ts   # shared row-rewrite helpers
  - docs/memory-table.md                                    # § DDL and transactions
difficulty: hard
---

# Memory backend: ALTER TABLE ADD/DROP COLUMN does not reach open transaction layers

Reproduced, root-caused, and a candidate fix prototyped and validated against the full test
suite (7271 passing, 0 failures). This ticket carries the validated design; the work is to land
it properly — with docstrings matching the density of the surrounding code, plus the tests.

This is the **plain in-memory table module** — no isolation layer, no store.

## What actually happens

The original bug report described one symptom. Probing found the blast radius is wider, and
includes silent value/column misalignment that gets **committed to the table**. All of the
following were observed on `new Database()` with the default memory module.

### 1. The transaction's own pending rows keep the old column layout

```sql
create table t (id integer primary key, v text);
begin;
insert into t values (1, 'a');
alter table t add column w text default 'z';
select * from t;   -- {"id":1,"v":"a"}    expected {"id":1,"v":"a","w":"z"}
commit;
select * from t;   -- {"id":1,"v":"a"}    w still missing
```

### 2. DROP COLUMN misaligns every value against its column name, and commits the result

The worst case. Dropping a column that sits *before* other columns shifts the schema but not the
transaction's pending rows, so the values line up one slot off:

```sql
create table t (a text, id integer primary key, v text);
begin;
insert into t values ('x', 1, 'a');
alter table t drop column a;
commit;
select * from t;        -- {"id":"x","v":1,"col_2":"a"}
select id, v from t;    -- {"id":"x","v":1,"col_2":"a"}   -- projection ignored too
select * from t where id = 1;  -- returns the row, whose id renders as 'x'
```

`id` reports the dropped column's value, `v` reports the primary key, and a third value surfaces
under the synthetic name `col_2`. This is durable corruption, not a display glitch.

### 3. A committed ADD COLUMN is undone table-wide by an unrelated transaction committing

The open layer froze the pre-ALTER schema at construction, so for the rest of that transaction
*every* read — including of rows committed long before — projects through the stale column list.
At commit the stale layer becomes the committed head, so the column is lost for everyone:

```sql
create table t (id integer primary key, v text);
insert into t values (0, 'committed');
begin;
insert into t values (1, 'pending');
alter table t add column w text default (new.v);
select * from t;   -- {"id":0,"v":"committed"}, {"id":1,"v":"pending"}   -- w missing on BOTH
commit;
select * from t;   -- w is gone from the table entirely
```

A row the transaction merely *deletes* is enough to trigger it — the surviving committed row
loses `w` permanently:

```sql
create table t (id integer primary key, v text);
insert into t values (1,'a'), (2,'b');
begin;
delete from t where id = 1;
alter table t add column w text default 'z';
commit;
select * from t;   -- {"id":2,"v":"b"}   -- w never appears
```

### 4. With a savepoint before the ALTER, rows are lost outright

```sql
create table t (id integer primary key, v text);
begin;
insert into t values (1, 'a');
savepoint s;
alter table t add column w text default 'z';
rollback to savepoint s;
select * from t;   -- {"id":1,"v":"a"}   -- still there mid-transaction
commit;
select * from t;   -- []                 -- the row is GONE
```

Also reproduces with nested savepoints (`savepoint s1` / `savepoint s2`, ALTER at the inner one,
`rollback to savepoint s1`).

An unrelated symptom of the same arity mismatch: `select w from t` in this state raises the
confusing runtime error *"No row context found for column w. The column reference must be
evaluated within the context of its source relation."*

## Root cause

`MemoryTableManager.addColumn` (`manager.ts:1756`) and `dropColumn` (`manager.ts:1839`) update
the base layer and the manager's cached schema, but never touch the **open transaction layers**.
`ensureSchemaChangeSafety` (`manager.ts:2960`) deliberately lets the DDL-issuing connection keep
its uncommitted work — it only raises `BUSY` for *other* connections — so those layers stay live,
still holding rows at the pre-ALTER arity, under the `TableSchema` they froze at construction
(`TransactionLayer.tableSchemaAtCreation`).

The manager already has this machinery for `alterColumn`, which propagates into every open layer
via `convertColumnOnOpenLayers` / `adoptSchemaOnOpenLayers` (`manager.ts:3319`, `:3338`), applied
oldest-first so each layer's copy-on-write base is already rebuilt. `addColumn` and `dropColumn`
have no equivalent.

**Symptom 4 specifically** (rows vanishing at commit) comes from `commitTransaction`
(`manager.ts:397-400`). After `rollback to savepoint`, the connection has no pending layer and its
`readLayer` is the eager savepoint snapshot. The block that wraps an empty pending layer around
that snapshot — so the snapshot's rows reach the committed chain — is gated on
`connection.readLayer.getSchema() === this.tableSchema`. The snapshot's frozen schema is not the
post-ALTER one, so the wrap is skipped, control falls to `manager.ts:423`
(`connection.readLayer = this._currentCommittedLayer`), and the snapshot's rows are dropped on the
floor. Propagating the new schema into the open layers makes that identity check pass again; no
change to `commitTransaction` itself was needed in the prototype.

## Important: DDL is not transactional here

The original bug report assumed `rollback to savepoint` undoes an ALTER. It does not — verified
by probe, and consistent with `TransactionLayer.adoptSchema`'s docstring and
`docs/memory-table.md`. After `rollback to savepoint s`, an `add column w` is still in effect
(`select w from t` succeeds) and a `drop column w` stays dropped (`select w from t` raises
"Column not found"). Making DDL transactional is `feat-ddl-transaction-capability`, out of scope
here.

So the correct expectation for the savepoint cases is: **the ALTER survives the rollback, and the
pre-savepoint INSERT survives too.** Do not write tests that assert the column change is undone.

## Validated fix

Model a new `TransactionLayer.reshapeColumns` on the existing `convertColumn`
(`transaction.ts:366`), which already solves the same shape of problem for value conversion:
rebuild the layer's primary tree over the parent's freshly-rebuilt one, collapse `ownWrites` to
its net per-key effect, rewrite each surviving row, and rebuild every secondary index.

Two things differ from `convertColumn` and drive the design:

- **`pkFunctions` must be rebuilt.** DROP COLUMN shifts the primary key's *column indices*
  (`updatedPkDefinition` at `manager.ts:1854`), so the extractor changes even though the key
  *values* do not. Because the values are invariant under both ADD (appends at the end) and DROP
  (dropping a PK column is rejected at `manager.ts:1849`), tree ordering is preserved and the
  `primaryKey` values already recorded in `ownWrites` stay valid — so no re-key of the kind
  `rekeyPrimaryKey` performs is needed.
- **The row rewrite is async.** ADD COLUMN's `backfillEvaluator` returns
  `SqlValue | Promise<SqlValue>` for a per-row `default (new.<col>)` expression, and the pending
  rows need it too (symptom 3's first example). `convertColumn` is synchronous; this one cannot be.

Prototype that passed everything (docstrings omitted — the real thing needs them):

```ts
// transaction.ts
public async reshapeColumns(newSchema: TableSchema, reshapeRow: (row: Row) => Row | Promise<Row>): Promise<void> {
	const preTree = this.primaryModifications;
	const oldEncode = this.pkFunctions.encode;

	// Net per-key effect of this layer's own writes, read out of the pre-reshape tree.
	const seen = new Set<string>();
	const survivingDeletions: BTreeKeyForPrimary[] = [];
	const effectiveRows: Row[] = [];
	for (const write of this.ownWrites) {
		const encoded = oldEncode(write.primaryKey);
		if (seen.has(encoded)) continue;
		seen.add(encoded);

		const effectiveRow = preTree.get(write.primaryKey);
		if (effectiveRow === undefined) { survivingDeletions.push(write.primaryKey); continue; }
		effectiveRows.push(effectiveRow);
	}

	const upserts: Row[] = [];
	for (const row of effectiveRows) upserts.push(await reshapeRow(row));

	this.tableSchemaAtCreation = newSchema;
	this.pkFunctions = createPrimaryKeyFunctions(newSchema, this.collationResolver);

	const { extractFromRow, compare } = this.pkFunctions;
	const parentPrimaryTree = this.parentLayer.getModificationTree('primary');
	const rebuilt = new BTree<BTreeKeyForPrimary, Row>(
		(value: Row): BTreeKeyForPrimary => extractFromRow(value),
		compare,
		{ base: parentPrimaryTree || undefined },
	);

	for (const primaryKey of survivingDeletions) {
		const path = rebuilt.find(primaryKey);
		if (path.on) rebuilt.deleteAt(path);
	}
	for (const row of upserts) rebuilt.upsert(row);
	this.primaryModifications = rebuilt;

	this.ownWrites.length = 0;
	for (const primaryKey of survivingDeletions) this.ownWrites.push({ type: 'delete', primaryKey });
	for (const row of upserts) this.ownWrites.push({ type: 'upsert', primaryKey: extractFromRow(row), newRow: row });

	this.secondaryIndexes = new Map();
	this.initializeSecondaryIndexes();
	for (const index of this.secondaryIndexes.values()) this.reindexOwnWrites(index);
}
```

```ts
// manager.ts — alongside convertColumnOnOpenLayers
private async reshapeColumnsOnOpenLayers(newSchema: TableSchema, reshapeRow: (row: Row) => Row | Promise<Row>): Promise<void> {
	for (const layer of this.openTransactionLayersOldestFirst()) {
		await layer.reshapeColumns(newSchema, reshapeRow);
	}
}
```

Call sites — both inside the existing `try`, immediately after the manager's schema swap, so the
base is already rebuilt when the layers inherit from it:

```ts
// addColumn, after `this.tableSchema = finalNewTableSchema; this.initializePrimaryKeyFunctions();`
await this.reshapeColumnsOnOpenLayers(finalNewTableSchema, async (row: Row): Promise<Row> =>
	[...row, backfillEvaluator ? await backfillEvaluator(row) : defaultValue] as Row);

// dropColumn, after `this.tableSchema = finalNewTableSchema;`
await this.reshapeColumnsOnOpenLayers(finalNewTableSchema, (row: Row): Row =>
	row.filter((_, idx) => idx !== colIndex) as Row);
```

`backfillEvaluator` takes the OLD-shape row, matching how `BaseLayer.addColumnToBase` calls it.

### Known gap in the prototype — decide before landing

If `reshapeRow` throws part-way (a `backfillEvaluator` that fails on a pending row), the layers
are left half-reshaped: layers already visited carry the new schema, the rest carry the old. The
`catch` blocks in `addColumn`/`dropColumn` restore the manager and base schemas but know nothing
about the layers.

Suggested remedy: split into two phases, matching how `BaseLayer.recreatePrimaryTreeWithNewColumn`
already builds into a local tree and only swaps it in once every row migrates. Phase 1 (async,
no mutation) walks the layers oldest-first and computes each one's net own-writes plus its
reshaped rows; phase 2 (synchronous, cannot throw) installs them. Reading each layer's effective
rows out of its *pre*-reshape tree is safe during phase 1 because that tree's base pointer still
resolves against the parent's old tree — which is exactly why `convertColumn` reads from `preTree`.

Confirm the failure is actually reachable before investing: `addColumn` gates NOT NULL up front,
and a non-literal default that yields NULL for a NOT NULL column throws inside
`addColumnToBase` — i.e. before the layer walk. If nothing can throw in the reshape, say so in a
`NOTE:` at the call site instead of building the two-phase machinery.

## Verified with the prototype in place

Each of these was probed and produced the correct result both mid-transaction and after commit:

- ADD / DROP with a pending INSERT (symptoms 1 and 2)
- ADD / DROP after `savepoint`, and with nested savepoints (symptom 4)
- DROP of a column preceding the PK column — single-column and multi-column PK (index shift)
- DROP of an indexed column; ADD with a secondary index present (index scan still correct)
- `default (new.<col>)` per-row backfill reaching pending rows
- Pending DELETE and pending UPDATE of committed rows
- Two ADD COLUMNs in one transaction over the same pending row
- Full `rollback` (not savepoint) after the ALTER
- UNIQUE still enforced after both ADD and DROP

Full suite with the prototype: `yarn test` → 7271 passing in `packages/quereus`, 0 failures
across all packages.

## Reproducing spec

This was written and validated during the fix stage, then removed so the tree would not be
committed red. Recreate it verbatim at
`packages/quereus/test/alter-column-open-transaction-layer.spec.ts`; all four cases fail before
the change and pass after.

```ts
/**
 * Regression tests: ALTER TABLE ADD/DROP COLUMN must reach the rows that the
 * DDL-issuing transaction inserted but has not yet committed.
 *
 * `MemoryTableManager.alterColumn` already propagates its change into every open
 * transaction layer; `addColumn` / `dropColumn` did not, so a transaction's own
 * pending rows kept the pre-ALTER arity — and with a savepoint taken before the
 * ALTER, the mismatched rows were dropped outright at commit.
 *
 * NOTE on the savepoint cases: DDL is NOT transactional in this engine (see
 * `docs/memory-table.md` and `TransactionLayer.adoptSchema`) — `rollback to
 * savepoint` does not undo an ALTER. So the post-rollback expectation is that the
 * column change is still in effect; what must survive is the pre-savepoint INSERT.
 */

import { expect } from 'chai';
import { Database } from '../src/index.js';

async function collect(db: Database, sql: string): Promise<Array<Record<string, unknown>>> {
	const rows: Array<Record<string, unknown>> = [];
	for await (const r of db.eval(sql)) rows.push(r as Record<string, unknown>);
	return rows;
}

describe('ALTER TABLE COLUMN — open transaction layers (memory module)', () => {
	let db: Database;

	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	it('ADD COLUMN applies to rows inserted earlier in the same transaction', async () => {
		await db.exec(`create table t (id integer primary key, v text)`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (1, 'a')`);
		await db.exec(`alter table t add column w text default 'z'`);

		expect(await collect(db, `select * from t`)).to.deep.equal([{ id: 1, v: 'a', w: 'z' }]);

		await db.exec(`commit`);

		expect(await collect(db, `select * from t`)).to.deep.equal([{ id: 1, v: 'a', w: 'z' }]);
	});

	it('ADD COLUMN after a savepoint does not lose pre-savepoint rows at commit', async () => {
		await db.exec(`create table t (id integer primary key, v text)`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (1, 'a')`);
		await db.exec(`savepoint s`);
		await db.exec(`alter table t add column w text default 'z'`);
		await db.exec(`rollback to savepoint s`);

		expect(await collect(db, `select * from t`)).to.deep.equal([{ id: 1, v: 'a', w: 'z' }]);

		await db.exec(`commit`);

		expect(await collect(db, `select * from t`)).to.deep.equal([{ id: 1, v: 'a', w: 'z' }]);
	});

	it('DROP COLUMN applies to rows inserted earlier in the same transaction', async () => {
		await db.exec(`create table t (id integer primary key, v text, w text)`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (1, 'a', 'z')`);
		await db.exec(`alter table t drop column w`);

		expect(await collect(db, `select * from t`)).to.deep.equal([{ id: 1, v: 'a' }]);

		await db.exec(`commit`);

		expect(await collect(db, `select * from t`)).to.deep.equal([{ id: 1, v: 'a' }]);
	});

	it('DROP COLUMN after a savepoint does not lose pre-savepoint rows at commit', async () => {
		await db.exec(`create table t (id integer primary key, v text, w text)`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (1, 'a', 'z')`);
		await db.exec(`savepoint s`);
		await db.exec(`alter table t drop column w`);
		await db.exec(`rollback to savepoint s`);

		expect(await collect(db, `select * from t`)).to.deep.equal([{ id: 1, v: 'a' }]);

		await db.exec(`commit`);

		expect(await collect(db, `select * from t`)).to.deep.equal([{ id: 1, v: 'a' }]);
	});
});
```

Run with:

```
cd packages/quereus && node test-runner.mjs --grep "open transaction layers"
```

Note `test-runner.mjs` passes `--bail`, so only the first failure shows. To see all four at once,
drive mocha directly from the repo root:

```
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/alter-column-open-transaction-layer.spec.ts"
```

## Downstream

`bug-isolation-alter-column-rebuild-drops-savepoint-writes` (in `tickets/fix/`) names this ticket
as its prereq: the isolation layer's per-connection overlays are themselves memory tables, and the
clean fix there is to have an overlay adopt an ALTER in place rather than be rebuilt — which is
only possible once the memory module can propagate a column change into an open transaction layer.
`reshapeColumns` is the primitive that unblocks it.

## TODO

- Add `TransactionLayer.reshapeColumns` in `transaction.ts`, next to `convertColumn`. Give it a
  docstring at the density of its neighbours: why `pkFunctions` is rebuilt but the key values are
  invariant, why the rewrite is async where `convertColumn` is not, why `ownWrites` collapses to
  its net per-key effect, and the oldest-first precondition the caller must honour.
- Add `MemoryTableManager.reshapeColumnsOnOpenLayers` alongside `convertColumnOnOpenLayers`, and
  extend the `openTransactionLayersOldestFirst` docstring to mention column-set changes as a third
  kind of propagation.
- Wire it into `addColumn` (append `backfillEvaluator(row)` or `defaultValue`) and `dropColumn`
  (filter out `colIndex`), inside the existing `try`, after the manager schema swap.
- Decide the partial-failure question: either implement the two-phase compute-then-install split,
  or establish that `reshapeRow` cannot throw at that point and record it as a `NOTE:` at the call
  site. Do not leave it undecided.
- Recreate `packages/quereus/test/alter-column-open-transaction-layer.spec.ts` from the block
  above; confirm all four fail before the change and pass after.
- Extend that spec to cover the cases the prototype was probed against but that have no test yet —
  at minimum the DROP-COLUMN value misalignment of symptom 2 (`select * from t` after dropping a
  column that precedes the PK), the ADD-COLUMN-lost-table-wide case of symptom 3 (pending DELETE
  only, no INSERT), and nested savepoints.
- Update `docs/memory-table.md` § DDL and transactions: ADD/DROP COLUMN now propagate into open
  transaction layers, same as `alter column`. Keep the existing statement that DDL is not
  transactional — this change does not alter that.
- Run `yarn test`, `yarn lint`, and `yarn typecheck`. `yarn test:store` is optional here (the
  defect and the fix are both memory-module-local) — skip it unless the diff reaches shared code.
