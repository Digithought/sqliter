/**
 * Structural survival of a partial index across ALTER TABLE column changes.
 *
 * The catalog and the memory module hold two views of the same index. The
 * existing rename tests assert only on reconstructed DDL text, which is
 * catalog-side, so they stayed green while the module silently lost the live
 * index structure. These tests assert the module side:
 *
 *   - `RENAME COLUMN` of a column named by a partial index's WHERE clause leaves
 *     the index live in the base layer's `secondaryIndexes` map, populated, and
 *     enforcing (for a unique partial index) under the new column name.
 *   - `DROP COLUMN` of such a column is rejected up front, naming both the column
 *     and the index.
 *   - A `RENAME COLUMN` that fails after the predicate rewrite rolls the rewrite
 *     back, so the stored predicate AST still names the original column.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { MemoryTableModule } from '../src/vtab/memory/module.js';
import type { MemoryIndex } from '../src/vtab/memory/index.js';
import { expressionToString } from '../src/emit/ast-stringify.js';

/**
 * The base layer is private on the manager, and deliberately so — nothing in the
 * engine reaches past `MemoryTableManager`. These tests do, because the live index
 * map is exactly the state the bug destroyed and the catalog cannot witness it.
 */
interface ManagerInternals {
	baseLayer: {
		secondaryIndexes: Map<string, MemoryIndex>;
		handleColumnRename: () => Promise<void>;
	};
}

async function rows(db: Database, sql: string): Promise<Record<string, unknown>[]> {
	const out: Record<string, unknown>[] = [];
	for await (const r of db.eval(sql)) out.push(r as Record<string, unknown>);
	return out;
}

function baseLayerOf(module: MemoryTableModule, tableName: string): ManagerInternals['baseLayer'] {
	const manager = module.tables.get(`main.${tableName}`);
	expect(manager, `no memory manager for main.${tableName}`).to.exist;
	return (manager as unknown as ManagerInternals).baseLayer;
}

/** The stored partial-index predicate, as SQL text, straight off the catalog. */
function predicateText(db: Database, tableName: string, indexName: string): string {
	const table = db.schemaManager.getSchema('main')!.getTable(tableName)!;
	const index = table.indexes!.find(i => i.name.toLowerCase() === indexName.toLowerCase())!;
	return expressionToString(index.predicate!);
}

describe('partial index across column rename/drop', () => {
	let db: Database;
	let module: MemoryTableModule;

	beforeEach(() => {
		db = new Database();
		module = new MemoryTableModule();
		db.registerModule('testmem', module);
	});

	afterEach(async () => {
		await db.close();
	});

	it('keeps a partial index live and populated across RENAME COLUMN', async () => {
		await db.exec(`create table t (id integer primary key, name text, active integer) using testmem`);
		await db.exec(`create index ix on t (name) where active = 1`);
		await db.exec(`insert into t values (1, 'a', 1), (2, 'b', 0), (3, 'c', 1)`);

		expect([...baseLayerOf(module, 't').secondaryIndexes.keys()]).to.deep.equal(['ix']);

		await db.exec(`alter table t rename column active to is_active`);

		// The live structure survives. `ALTER` first consolidates every committed
		// transaction layer into the base, so the base index is fully populated here:
		// two of the three rows satisfy the predicate.
		expect([...baseLayerOf(module, 't').secondaryIndexes.keys()]).to.deep.equal(['ix']);
		expect(baseLayerOf(module, 't').secondaryIndexes.get('ix')!.size).to.equal(2);

		// The predicate now names the new column, and scopes the index correctly.
		expect(predicateText(db, 't', 'ix').toLowerCase()).to.contain('is_active');
		const scoped = await rows(db, `select name from t where is_active = 1 order by name`);
		expect(scoped.map(r => r.name)).to.deep.equal(['a', 'c']);

		// Writes after the rename are scoped by the rewritten predicate too.
		await db.exec(`insert into t values (4, 'd', 1), (5, 'e', 0)`);
		const after = await rows(db, `select name from t where is_active = 1 order by name`);
		expect(after.map(r => r.name)).to.deep.equal(['a', 'c', 'd']);
	});

	it('keeps a UNIQUE partial index enforcing under the new column name', async () => {
		await db.exec(`create table u (id integer primary key, name text, active integer) using testmem`);
		await db.exec(`create unique index ux on u (name) where active = 1`);
		await db.exec(`insert into u values (1, 'a', 1), (2, 'a', 0)`);

		await db.exec(`alter table u rename column active to is_active`);

		const base = baseLayerOf(module, 'u');
		expect([...base.secondaryIndexes.keys()]).to.deep.equal(['ux']);

		// Inside the predicate's scope under the new name: duplicate rejected. This
		// runs through the `derivedFromIndex` UNIQUE constraint, which shares the
		// predicate AST by reference with the index.
		let threw: unknown;
		try {
			await db.exec(`insert into u values (3, 'a', 1)`);
		} catch (e) {
			threw = e;
		}
		expect(threw, 'duplicate inside the partial-index scope must be rejected').to.exist;

		// Outside the scope: still allowed.
		await db.exec(`insert into u values (4, 'a', 0)`);
		const all = await rows(db, `select count(*) as n from u`);
		expect(all[0].n).to.equal(3);
	});

	it('keeps a table-qualified, case-varied predicate live across RENAME COLUMN', async () => {
		await db.exec(`create table t (id integer primary key, name text, active integer) using testmem`);
		await db.exec(`create index ix on t (name) where t.ACTIVE = 1`);
		await db.exec(`insert into t values (1, 'a', 1), (2, 'b', 0)`);

		await db.exec(`alter table t rename column active to is_active`);

		expect([...baseLayerOf(module, 't').secondaryIndexes.keys()]).to.deep.equal(['ix']);
		expect(baseLayerOf(module, 't').secondaryIndexes.get('ix')!.size).to.equal(1);
		expect(predicateText(db, 't', 'ix').toLowerCase()).to.contain('is_active');
	});

	it('keeps a self-qualified partial index live across a table RENAME and a following rebuild', async () => {
		await db.exec(`create table t (id integer primary key, name text, active integer) using testmem`);
		await db.exec(`create index ix on t (name) where t.active = 1`);
		await db.exec(`insert into t values (1, 'a', 1), (2, 'b', 0), (3, 'c', 1)`);

		// Renaming the table rewrites the predicate's self-qualifier (`t.active` →
		// `t2.active`) in place. Before create-time rejection existed, `compilePredicate`
		// ignored the qualifier, so a stale `t.active` would have been harmless; now a
		// qualifier that failed to follow the rename would name a foreign table and throw
		// on the next rebuild. This asserts the rename keeps the qualifier self-consistent.
		await db.exec(`alter table t rename to t2`);
		// A column rename forces `ensureSchemaChangeSafety` to consolidate + rebuild the
		// secondary index against the new table name — the recompile that would throw on a
		// stale qualifier.
		await db.exec(`alter table t2 rename column active to is_active`);

		expect([...baseLayerOf(module, 't2').secondaryIndexes.keys()]).to.deep.equal(['ix']);
		const pred = predicateText(db, 't2', 'ix').toLowerCase();
		expect(pred).to.contain('t2');
		expect(pred).to.contain('is_active');
		const scoped = await rows(db, `select name from t2 where is_active = 1 order by name`);
		expect(scoped.map(r => r.name)).to.deep.equal(['a', 'c']);
	});

	it('leaves a partial index on an unrelated column alone across RENAME COLUMN', async () => {
		await db.exec(`create table t (id integer primary key, name text, active integer, flag integer) using testmem`);
		await db.exec(`create index ix_active on t (name) where active = 1`);
		await db.exec(`create index ix_flag on t (name) where flag = 1`);
		await db.exec(`insert into t values (1, 'a', 1, 1)`);

		await db.exec(`alter table t rename column active to is_active`);

		expect([...baseLayerOf(module, 't').secondaryIndexes.keys()]).to.deep.equal(['ix_active', 'ix_flag']);
		expect(predicateText(db, 't', 'ix_active').toLowerCase()).to.contain('is_active');
		expect(predicateText(db, 't', 'ix_flag').toLowerCase()).to.contain('flag');
		expect(predicateText(db, 't', 'ix_flag').toLowerCase()).to.not.contain('is_active');
	});

	it('keeps a partial index live across a RENAME COLUMN inside an open transaction', async () => {
		await db.exec(`create table t (id integer primary key, name text, active integer) using testmem`);
		await db.exec(`create index ix on t (name) where active = 1`);
		await db.exec(`insert into t values (1, 'a', 1)`);

		// The uncommitted insert forces `ensureSchemaChangeSafety` to consolidate a live
		// transaction layer into the base — the rebuild that must still see the OLD column.
		await db.exec(`begin`);
		await db.exec(`insert into t values (2, 'b', 1)`);
		await db.exec(`alter table t rename column active to is_active`);
		await db.exec(`commit`);

		expect([...baseLayerOf(module, 't').secondaryIndexes.keys()]).to.deep.equal(['ix']);
		const scoped = await rows(db, `select name from t where is_active = 1 order by name`);
		expect(scoped.map(r => r.name)).to.deep.equal(['a', 'b']);
	});

	it('rejects DROP COLUMN of a column named by a partial-index predicate', async () => {
		await db.exec(`create table t (id integer primary key, name text, active integer) using testmem`);
		await db.exec(`create index ix on t (name) where active = 1`);

		let message = '';
		try {
			await db.exec(`alter table t drop column active`);
		} catch (e) {
			message = (e as Error).message;
		}
		expect(message).to.contain(`Cannot drop column 'active'`);
		expect(message).to.contain(`partial index 'ix'`);

		// The index is untouched by the rejected drop.
		expect([...baseLayerOf(module, 't').secondaryIndexes.keys()]).to.deep.equal(['ix']);
	});

	it('rejects CREATE INDEX whose predicate names a foreign table qualifier', async () => {
		await db.exec(`create table t (id integer primary key, name text, active integer) using testmem`);

		// `where zzz.active = 1` names table `zzz`, not `t`. Ignoring the qualifier and
		// binding `active` by bare name would compile this to the same index as
		// `where active = 1`, so two statements that read differently would collide. It is
		// rejected at create time instead.
		let message = '';
		try {
			await db.exec(`create index ix on t (name) where zzz.active = 1`);
		} catch (e) {
			message = (e as Error).message;
		}
		expect(message).to.contain(`zzz.active`);
		expect(message.toLowerCase()).to.contain(`different table`);

		// The rejected statement created no index.
		expect([...baseLayerOf(module, 't').secondaryIndexes.keys()]).to.deep.equal([]);
	});

	it('accepts a self-qualified partial-index predicate and filters rows by it', async () => {
		await db.exec(`create table t (id integer primary key, name text, active integer) using testmem`);
		// A qualifier naming the owning table itself is legal — it compiles rather than
		// throwing.
		await db.exec(`create index ix on t (name) where t.active = 1`);
		await db.exec(`insert into t values (1, 'a', 1), (2, 'b', 0), (3, 'c', 1)`);

		// The index is registered and scopes exactly as a bare `where active = 1` would:
		// two of the three rows qualify.
		expect([...baseLayerOf(module, 't').secondaryIndexes.keys()]).to.deep.equal(['ix']);
		const scoped = await rows(db, `select name from t where active = 1 order by name`);
		expect(scoped.map(r => r.name)).to.deep.equal(['a', 'c']);
	});

	it('scopes a case-insensitive self-qualified UNIQUE partial index by its predicate', async () => {
		await db.exec(`create table u (id integer primary key, name text, active integer) using testmem`);
		// Both the qualifier (`U`) and the column (`ACTIVE`) differ in case from the
		// declared identifiers; the self-qualifier match is case-insensitive.
		await db.exec(`create unique index ux on u (name) where U.ACTIVE = 1`);
		await db.exec(`insert into u values (1, 'a', 1), (2, 'a', 0)`);

		// A duplicate name INSIDE the predicate's scope is rejected — proving the compiled
		// predicate scopes enforcement through the live DML path.
		let threw: unknown;
		try {
			await db.exec(`insert into u values (3, 'a', 1)`);
		} catch (e) {
			threw = e;
		}
		expect(threw, 'duplicate inside the self-qualified partial scope must be rejected').to.exist;

		// Outside the scope: still allowed.
		await db.exec(`insert into u values (4, 'a', 0)`);
		const all = await rows(db, `select count(*) as n from u`);
		expect(all[0].n).to.equal(3);
	});

	it('allows DROP COLUMN once the partial index naming it is dropped', async () => {
		await db.exec(`create table t (id integer primary key, name text, active integer) using testmem`);
		await db.exec(`create index ix on t (name) where active = 1`);
		await db.exec(`insert into t values (1, 'a', 1)`);

		await db.exec(`drop index ix`);
		await db.exec(`alter table t drop column active`);

		expect([...baseLayerOf(module, 't').secondaryIndexes.keys()]).to.deep.equal([]);
		const all = await rows(db, `select name from t`);
		expect(all.map(r => r.name)).to.deep.equal(['a']);
	});

	it('still allows DROP COLUMN of a column used only as an index key column', async () => {
		await db.exec(`create table t (id integer primary key, name text, active integer) using testmem`);
		await db.exec(`create index ix on t (name) where active = 1`);
		await db.exec(`insert into t values (1, 'a', 1)`);

		// `name` is a key column of `ix`, not named by its predicate: the module
		// narrows the index, and drops it once no key columns survive.
		await db.exec(`alter table t drop column name`);
		expect([...baseLayerOf(module, 't').secondaryIndexes.keys()]).to.deep.equal([]);
	});

	it('rolls the predicate rewrite back when RENAME COLUMN fails', async () => {
		await db.exec(`create table t (id integer primary key, name text, active integer) using testmem`);
		await db.exec(`create index ix on t (name) where active = 1`);
		await db.exec(`insert into t values (1, 'a', 1)`);

		// Fault injection: fail the rebuild that follows the in-module predicate
		// rewrite. Nothing in the engine can reach this window otherwise.
		const base = baseLayerOf(module, 't');
		const original = base.handleColumnRename.bind(base);
		base.handleColumnRename = () => Promise.reject(new Error('injected rebuild failure'));

		let threw: unknown;
		try {
			await db.exec(`alter table t rename column active to is_active`);
		} catch (e) {
			threw = e;
		}
		base.handleColumnRename = original;
		expect(threw, 'the injected failure must abort the rename').to.exist;

		// Both the column and the predicate AST are back on the original name.
		expect(predicateText(db, 't', 'ix').toLowerCase()).to.contain('active');
		expect(predicateText(db, 't', 'ix').toLowerCase()).to.not.contain('is_active');
		const cols = await rows(db, `select active from t`);
		expect(cols[0].active).to.equal(1);
	});
});
