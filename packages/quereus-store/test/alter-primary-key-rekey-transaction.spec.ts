/**
 * `ALTER TABLE … ALTER PRIMARY KEY`, issued inside an open transaction against the bare
 * store module — `bug-store-alter-primary-key-rejection-eats-transaction`.
 *
 * Before the fix, `StoreModuleAlter.alterPrimaryKeyChange` called
 * `StoreModuleBase.ddlCommitPendingOps()` (which commits the module's WHOLE buffered
 * transaction, across every table it holds) BEFORE `StoreTable.rekeyRows`' duplicate-key
 * check could reject the re-key. A rejected statement therefore left the store untouched
 * but silently spent the enclosing transaction: a following `rollback` had nothing left
 * to undo.
 *
 * The fix asks `StoreTable.validateRekeyedPrimaryKey` — the same two throw-only probes
 * the `ALTER COLUMN … SET COLLATE` arm already uses (`alter-collate-pk-rekey.spec.ts`) —
 * BEFORE the flush:
 *   1. legality — a collision among the rows the transaction can SEE is `CONSTRAINT`,
 *      and the refusal leaves the transaction usable;
 *   2. representability — a collision confined to committed rows the transaction has
 *      DELETED (rows a rollback must restore) is `BUSY`, same posture.
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

describe('ALTER TABLE ALTER PRIMARY KEY on the bare store module, inside a transaction', () => {
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

	it('a rejected re-key leaves an unrelated sibling table\'s uncommitted insert rollback-able', async () => {
		await db.exec(`create table t (id integer primary key, code integer not null) using store`);
		await db.exec(`create table other (id integer primary key, v text) using store`);
		await db.exec(`insert into t values (1, 10), (2, 10)`); // both rows collide under code

		await db.exec('begin');
		await db.exec(`insert into other values (1, 'uncommitted')`);

		// Pre-fix this silently COMMITTED the whole module (every table, not just t) before
		// rekeyRows' own duplicate check fired.
		await expectRejection(
			db,
			`alter table t alter primary key (code)`,
			StatusCode.CONSTRAINT,
			/primary key collides under the new key definition/,
		);

		await db.exec('rollback');
		expect(await asyncIterableToArray(db.eval(`select id, v from other`))).to.deep.equal([]);
	});

	it('a rejected re-key leaves the altered table\'s own staged insert rollback-able', async () => {
		await db.exec(`create table t (id integer primary key, code integer not null) using store`);
		await db.exec(`insert into t values (1, 10)`);

		await db.exec('begin');
		await db.exec(`insert into t values (2, 10)`); // staged row collides with the committed one

		await expectRejection(
			db,
			`alter table t alter primary key (code)`,
			StatusCode.CONSTRAINT,
			/primary key collides under the new key definition/,
		);

		await db.exec('rollback');
		expect(await asyncIterableToArray(db.eval(`select id, code from t`)))
			.to.deep.equal([{ id: 1, code: 10 }]);
	});

	it('a committed collider deleted in this transaction is BUSY (retryable), not CONSTRAINT', async () => {
		await db.exec(`create table t (id integer primary key, code integer not null) using store`);
		await db.exec(`insert into t values (1, 10), (2, 10)`);

		await db.exec('begin');
		await db.exec(`delete from t where id = 2`); // collider invisible to this txn's view

		await expectRejection(
			db,
			`alter table t alter primary key (code)`,
			StatusCode.BUSY,
			/still collide under the new key definition.*Commit\/rollback and retry/s,
		);

		// The transaction survives; rolling back restores both rows.
		await db.exec('rollback');
		expect(await asyncIterableToArray(db.eval(`select id, code from t order by id`)))
			.to.deep.equal([{ id: 1, code: 10 }, { id: 2, code: 10 }]);

		// Following the error's advice works: commit the delete, retry, and the re-key lands.
		await db.exec(`delete from t where id = 2`);
		await db.exec(`alter table t alter primary key (code)`);
		expect(await asyncIterableToArray(db.eval(`select id, code from t`)))
			.to.deep.equal([{ id: 1, code: 10 }]);
	});

	it('a non-colliding re-key inside a transaction still succeeds and keys rows under the new definition', async () => {
		await db.exec(`create table t (id integer primary key, code integer not null) using store`);
		await db.exec(`insert into t values (1, 10)`);

		await db.exec('begin');
		await db.exec(`insert into t values (2, 20)`);
		await db.exec(`alter table t alter primary key (code)`);
		await db.exec('commit');

		expect(await asyncIterableToArray(db.eval(`select id, code from t order by code`)))
			.to.deep.equal([{ id: 1, code: 10 }, { id: 2, code: 20 }]);
		// A point lookup under the new key finds the right row.
		expect(await asyncIterableToArray(db.eval(`select id from t where code = 20`)))
			.to.deep.equal([{ id: 2 }]);
	});
});

describe('ALTER TABLE ALTER PRIMARY KEY behind the isolation wrapper, inside a transaction', () => {
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

	it('a rejected re-key leaves the issuer\'s staged rows on a sibling table intact', async () => {
		await db.exec(`create table t (id integer primary key, code integer not null) using store`);
		await db.exec(`create table other (id integer primary key, v text) using store`);
		await db.exec(`insert into t values (1, 10), (2, 10)`);

		await db.exec('begin');
		await db.exec(`insert into other values (1, 'uncommitted')`);

		await expectRejection(
			db,
			`alter table t alter primary key (code)`,
			StatusCode.CONSTRAINT,
			/primary key collides under the new key definition/,
		);

		await db.exec('rollback');
		expect(await asyncIterableToArray(db.eval(`select id, v from other`))).to.deep.equal([]);
	});
});
