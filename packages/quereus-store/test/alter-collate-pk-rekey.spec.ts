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
import { Database, StatusCode, asyncIterableToArray } from '@quereus/quereus';
import {
	createIsolatedStoreModule,
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

/** Runs `sql` expecting a rejection; asserts the message and (when carried) the status code. */
async function expectRejection(db: Database, sql: string, code: number, match: RegExp): Promise<void> {
	let err: unknown;
	try {
		await db.exec(sql);
	} catch (e) {
		err = e;
	}
	expect(err, `expected [${sql}] to be rejected`).to.not.be.undefined;
	expect(String((err as Error).message)).to.match(match);
	const carried = (err as { code?: number }).code;
	if (carried !== undefined) {
		expect(carried, 'status code').to.equal(code);
	}
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
		// No staged work at all: effective rows ⊇ committed rows, so the legality probe
		// trips first and the status is CONSTRAINT — BUSY is reserved for the shape only a
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
});
