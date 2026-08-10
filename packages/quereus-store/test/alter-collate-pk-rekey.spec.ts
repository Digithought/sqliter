/**
 * `ALTER COLUMN … SET COLLATE` on a PRIMARY KEY member, issued inside an open
 * transaction against the store module behind the isolation layer — the shapes from
 * `bug-store-pk-collate-rejects-deleted-row-collision`.
 *
 * The store must ask the memory backend's two re-key questions BEFORE flushing or
 * mutating anything (`StoreTable.validateRekeyedPrimaryKey`):
 *   1. legality — a collision among the rows the transaction can SEE (staged rows
 *      included) is `CONSTRAINT`, and the refusal leaves the transaction usable;
 *   2. representability — a collision confined to committed rows the transaction has
 *      DELETED (rows a rollback must restore) is `BUSY`, same posture.
 * And the post-re-key secondary-index rebuild must be NON-enforcing: the committed
 * rows it reads may retain a unique-index collider the transaction deleted, which the
 * pre-mutation probe already accepted over the effective rows.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, QuereusError, StatusCode, asyncIterableToArray } from '@quereus/quereus';
import {
	createIsolatedStoreModule,
	StoreModule,
	InMemoryKVStore,
	type KVStoreProvider,
} from '../src/index.js';

function createInMemoryProvider(): KVStoreProvider {
	const stores = new Map<string, InMemoryKVStore>();
	const ensure = (key: string): InMemoryKVStore => {
		if (!stores.has(key)) stores.set(key, new InMemoryKVStore());
		return stores.get(key)!;
	};
	return {
		async getStore(schemaName: string, tableName: string) {
			return ensure(`${schemaName}.${tableName}`);
		},
		async getIndexStore(schemaName: string, tableName: string, indexName: string) {
			return ensure(`${schemaName}.${tableName}_idx_${indexName}`);
		},
		async getStatsStore() {
			return ensure('__stats__');
		},
		async getCatalogStore() {
			return ensure('__catalog__');
		},
		async closeStore() { /* no-op for in-memory stores */ },
		async closeIndexStore() { /* no-op for in-memory stores */ },
		async closeAll() {
			for (const store of stores.values()) {
				await store.close();
			}
			stores.clear();
		},
	};
}

/** Runs `sql` expecting a rejection; asserts both the status code and the message. */
async function expectRejection(db: Database, sql: string, code: StatusCode, match: RegExp): Promise<void> {
	let err: unknown;
	try {
		await db.exec(sql);
	} catch (e) {
		err = e;
	}
	expect(err, `expected [${sql}] to be rejected`).to.be.instanceOf(QuereusError);
	expect((err as QuereusError).code, `status code for [${sql}]`).to.equal(code);
	expect((err as QuereusError).message).to.match(match);
}

describe('ALTER COLUMN SET COLLATE on a store PK member, inside a transaction', () => {
	let db: Database;
	let provider: KVStoreProvider;

	beforeEach(async () => {
		db = new Database();
		provider = createInMemoryProvider();
		db.registerModule('store', createIsolatedStoreModule({ provider }));
	});

	afterEach(async () => {
		await db.close();
		await provider.closeAll();
	});

	it('a staged row colliding with a committed row is CONSTRAINT, and the committed row is never lost', async () => {
		await db.exec(`create table t (k text collate binary primary key, v text) using store`);
		await db.exec(`insert into t values ('A', 'x')`);

		await db.exec('begin');
		await db.exec(`insert into t values ('a', 'y')`); // staged in the overlay only

		// Pre-fix this was silently ACCEPTED and the committed 'A' row vanished at commit.
		await expectRejection(
			db,
			`alter table t alter column k set collate nocase`,
			StatusCode.CONSTRAINT,
			/collides under the new key definition/,
		);

		// The refusal ran before any flush or mutation: the transaction is still usable.
		await db.exec(`insert into t values ('b', 'z')`);
		await db.exec('rollback');

		expect(await asyncIterableToArray(db.eval(`select k, v from t order by k`)))
			.to.deep.equal([{ k: 'A', v: 'x' }]);
		// Nothing reached storage, and the schema still declares BINARY.
		expect(await asyncIterableToArray(db.eval(`select k, v from committed.t`)))
			.to.deep.equal([{ k: 'A', v: 'x' }]);
		const info = await asyncIterableToArray(db.eval(`select name, collation from table_info('t') where name = 'k'`));
		expect(info).to.deep.equal([{ name: 'k', collation: 'BINARY' }]);
	});

	it('a committed collider deleted in this transaction is BUSY (retryable), not CONSTRAINT', async () => {
		await db.exec(`create table t (k text collate binary primary key, v text) using store`);
		await db.exec(`insert into t values ('A', 'x'), ('a', 'y')`);

		await db.exec('begin');
		await db.exec(`delete from t where k = 'a'`); // collider invisible to this txn's view

		// Pre-fix this arrived as CONSTRAINT, after the DDL flush. It is a pending-state
		// refusal: both committed rows must survive a rollback, and the re-keyed store
		// cannot hold them under one key.
		await expectRejection(
			db,
			`alter table t alter column k set collate nocase`,
			StatusCode.BUSY,
			/still collide under the new key definition.*Commit\/rollback and retry/s,
		);

		// The transaction survives; rolling back restores both rows.
		await db.exec('rollback');
		expect(await asyncIterableToArray(db.eval(`select k, v from t order by v`)))
			.to.deep.equal([{ k: 'A', v: 'x' }, { k: 'a', v: 'y' }]);

		// Following the error's advice works: commit the delete, retry, and the re-key lands.
		await db.exec(`delete from t where k = 'a'`);
		await db.exec(`alter table t alter column k set collate nocase`);
		expect(await asyncIterableToArray(db.eval(`select k, v from t`)))
			.to.deep.equal([{ k: 'A', v: 'x' }]);
		const info = await asyncIterableToArray(db.eval(`select name, collation from table_info('t') where name = 'k'`));
		expect(info).to.deep.equal([{ name: 'k', collation: 'NOCASE' }]);
	});

	it('a unique-index collider deleted in this transaction is accepted, with the index still serving seeks', async () => {
		// Composite PK so the re-key itself never collides — only the unique index over k
		// could object, and its collider is gone from this transaction's view.
		await db.exec(`create table t (k text collate binary, j integer, v text, primary key (k, j)) using store`);
		await db.exec(`create unique index t_k on t (k)`);
		await db.exec(`insert into t values ('A', 1, 'x'), ('a', 2, 'y')`);

		await db.exec('begin');
		await db.exec(`delete from t where k = 'a'`);
		// Pre-fix the post-re-key ENFORCING index rebuild rejected this over the committed
		// rows (which still hold 'a'), after the data store was already re-keyed — leaving
		// index-backed seeks and full scans disagreeing.
		await db.exec(`alter table t alter column k set collate nocase`);
		await db.exec('commit');

		// Index-backed seek and full scan agree on the surviving row.
		expect(await asyncIterableToArray(db.eval(`select k, j from t where k = 'A'`)))
			.to.deep.equal([{ k: 'A', j: 1 }]);
		expect(await asyncIterableToArray(db.eval(`select k, j from t order by j`)))
			.to.deep.equal([{ k: 'A', j: 1 }]);
	});

	it('negative control: the same unique-index collision with the collider NOT deleted still rejects, pre-mutation', async () => {
		await db.exec(`create table t (k text collate binary, j integer, v text, primary key (k, j)) using store`);
		await db.exec(`create unique index t_k on t (k)`);
		await db.exec(`insert into t values ('A', 1, 'x'), ('a', 2, 'y')`);

		await db.exec('begin');
		// Both rows visible: under NOCASE the unique index over k genuinely collides, and
		// the pre-mutation unique probe (via the index's derived constraint) must refuse.
		await expectRejection(
			db,
			`alter table t alter column k set collate nocase`,
			StatusCode.CONSTRAINT,
			/UNIQUE constraint failed: t \(k\)/,
		);
		await db.exec('rollback');

		// Nothing was re-keyed or cleared: both access paths still see both rows.
		expect(await asyncIterableToArray(db.eval(`select k, j from t where k = 'a'`)))
			.to.deep.equal([{ k: 'a', j: 2 }]);
		expect(await asyncIterableToArray(db.eval(`select k, j from t order by j`)))
			.to.deep.equal([{ k: 'A', j: 1 }, { k: 'a', j: 2 }]);
		const info = await asyncIterableToArray(db.eval(`select name, collation from table_info('t') where name = 'k'`));
		expect(info).to.deep.equal([{ name: 'k', collation: 'BINARY' }]);
	});

	it('without a wrapper-visible deletion, a committed collision still reports CONSTRAINT (probe order)', async () => {
		// No open transaction at all, so the effective rows ARE the committed rows and the
		// legality probe trips first: CONSTRAINT. BUSY is reserved for the shape only a
		// transaction's deletion can produce.
		await db.exec(`create table t (k text collate binary primary key, v text) using store`);
		await db.exec(`insert into t values ('A', 'x'), ('a', 'y')`);

		await expectRejection(
			db,
			`alter table t alter column k set collate nocase`,
			StatusCode.CONSTRAINT,
			/collides under the new key definition/,
		);
		expect(await asyncIterableToArray(db.eval(`select k, v from t order by v`)))
			.to.deep.equal([{ k: 'A', v: 'x' }, { k: 'a', v: 'y' }]);
	});

	it('a staged row that does NOT collide is accepted, and lands under the new key', async () => {
		// The effective probe's success path — a wrapper stream carrying a staged row the
		// store has never seen must be walked and cleared, not merely tolerated.
		await db.exec(`create table t (k text collate binary primary key, v text) using store`);
		await db.exec(`insert into t values ('A', 'x')`);

		await db.exec('begin');
		await db.exec(`insert into t values ('b', 'y')`);
		await db.exec(`alter table t alter column k set collate nocase`);
		await db.exec('commit');

		expect(await asyncIterableToArray(db.eval(`select k, v from t order by v`)))
			.to.deep.equal([{ k: 'A', v: 'x' }, { k: 'b', v: 'y' }]);
		// Both rows resolve through a point lookup under the NEW collation, which a row
		// left keyed under the old bytes would fail.
		expect(await asyncIterableToArray(db.eval(`select v from t where k = 'B'`)))
			.to.deep.equal([{ v: 'y' }]);
		expect(await asyncIterableToArray(db.eval(`select v from t where k = 'a'`)))
			.to.deep.equal([{ v: 'x' }]);
	});

	it('an accepted re-key over a deleted unique-index collider survives a ROLLBACK with data and index agreeing', async () => {
		// The other half of the deleted-collider case: the DDL is not transactional, so the
		// re-key and the non-enforcing index rebuild stay after the data changes are undone.
		// Whatever the committed rows then are, the index must describe exactly them —
		// the disagreement defect 2 left behind.
		await db.exec(`create table t (k text collate binary, j integer, v text, primary key (k, j)) using store`);
		await db.exec(`create unique index t_k on t (k)`);
		await db.exec(`insert into t values ('A', 1, 'x'), ('a', 2, 'y')`);

		await db.exec('begin');
		await db.exec(`delete from t where k = 'a'`);
		await db.exec(`alter table t alter column k set collate nocase`);
		await db.exec('rollback');

		// The rollback restored the deleted row; under the now-NOCASE column an index-backed
		// seek on either spelling and the full scan must all report the same two rows.
		const both = [{ k: 'A', j: 1 }, { k: 'a', j: 2 }];
		expect(await asyncIterableToArray(db.eval(`select k, j from t order by j`))).to.deep.equal(both);
		expect(await asyncIterableToArray(db.eval(`select k, j from t where k = 'A' order by j`))).to.deep.equal(both);
		expect(await asyncIterableToArray(db.eval(`select k, j from t where k = 'a' order by j`))).to.deep.equal(both);
		const info = await asyncIterableToArray(db.eval(`select name, collation from table_info('t') where name = 'k'`));
		expect(info).to.deep.equal([{ name: 'k', collation: 'NOCASE' }]);
	});
});

describe('ALTER COLUMN SET COLLATE on a store PK member, no isolation wrapper', () => {
	let db: Database;
	let provider: KVStoreProvider;

	beforeEach(async () => {
		db = new Database();
		provider = createInMemoryProvider();
		db.registerModule('store', new StoreModule(provider));
	});

	afterEach(async () => {
		await db.close();
		await provider.closeAll();
	});

	it('a collider deleted into the module\'s own buffer is BUSY, and commit-then-retry lands the change', async () => {
		// Bare, the transaction's delete sits in this module's coordinator rather than a
		// wrapper overlay — so the effective probe clears and the committed probe still sees
		// the pair. Previously the DDL flush committed the delete and re-keyed happily,
		// spending the transaction's rollback without saying so.
		await db.exec(`create table t (k text collate binary primary key, v text) using store`);
		await db.exec(`insert into t values ('A', 'x'), ('a', 'y')`);

		await db.exec('begin');
		await db.exec(`delete from t where k = 'a'`);
		await expectRejection(
			db,
			`alter table t alter column k set collate nocase`,
			StatusCode.BUSY,
			/still collide under the new key definition.*Commit\/rollback and retry/s,
		);

		// The refusal ran before the flush, so the delete is still undoable.
		await db.exec('rollback');
		expect(await asyncIterableToArray(db.eval(`select k, v from t order by v`)))
			.to.deep.equal([{ k: 'A', v: 'x' }, { k: 'a', v: 'y' }]);

		await db.exec(`delete from t where k = 'a'`);
		await db.exec(`alter table t alter column k set collate nocase`);
		expect(await asyncIterableToArray(db.eval(`select k, v from t`)))
			.to.deep.equal([{ k: 'A', v: 'x' }]);
	});
});
