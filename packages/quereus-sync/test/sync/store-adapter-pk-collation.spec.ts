/**
 * Regression tests: inbound sync rows must be keyed IDENTICALLY to StoreTable
 * — including per-column PK key collations. A text PK column with a collation
 * that diverges from the table-level key collation K (e.g. `collate binary`
 * PK on a default-NOCASE store) is encoded under its own collation by the
 * store; a mismatched key would land remote inserts at phantom keys and make
 * remote deletes miss. The adapter now resolves each table via
 * `StoreModule.getTableForExternalWrite` and applies through
 * `StoreTable.applyExternalRowChanges`, so these scenarios pin the
 * TABLE-OWNED keying (no adapter-side key encoding remains to diverge).
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import {
	StoreModule,
	StoreEventEmitter,
	type KVStoreProvider,
} from '@quereus/store';
import { createStoreAdapter } from '../../src/sync/store-adapter.js';
import type { ApplyToStoreCallback } from '../../src/sync/protocol.js';
import { createInMemoryProvider, collect } from './_peer-harness.js';


describe('store-adapter PK key collation', () => {
	let db: Database;
	let provider: KVStoreProvider;
	let events: StoreEventEmitter;
	let applyToStore: ApplyToStoreCallback;

	beforeEach(() => {
		db = new Database();
		provider = createInMemoryProvider().provider;
		events = new StoreEventEmitter();
		const storeModule = new StoreModule(provider, events);
		db.registerModule('store', storeModule);
		applyToStore = createStoreAdapter({ db, storeModule, events });
	});

	afterEach(async () => {
		await db.close();
		await provider.closeAll();
	});

	it('control: remote insert/delete round-trips when PK collation matches K', async () => {
		await db.exec(`create table t (x text primary key, v text) using store`);
		await db.exec(`insert into t values ('A', 'local')`);

		let res = await applyToStore([
			{ type: 'insert', schema: 'main', table: 't', pk: ['B'], columns: { v: 'remote' } },
		], [], { remote: true });
		expect(res.errors).to.have.length(0);
		expect(await collect(db, `select v from t where x = 'B'`)).to.deep.equal([{ v: 'remote' }]);

		res = await applyToStore([
			{ type: 'delete', schema: 'main', table: 't', pk: ['A'] },
		], [], { remote: true });
		expect(res.errors).to.have.length(0);
		expect(await collect(db, `select x from t where x = 'A'`)).to.deep.equal([]);
	});

	it('remote insert on a divergent-collation PK lands at the key the store reads', async () => {
		await db.exec(`create table t (x text collate binary primary key, v text) using store`);

		const res = await applyToStore([
			{ type: 'insert', schema: 'main', table: 't', pk: ['A'], columns: { v: 'remote' } },
		], [], { remote: true });
		expect(res.errors).to.have.length(0);

		// Point lookup goes through buildDataKey with the store's per-column PK
		// collations — a mismatched adapter key makes this come back empty.
		expect(await collect(db, `select v from t where x = 'A'`)).to.deep.equal([{ v: 'remote' }]);
	});

	it('remote delete on a divergent-collation PK removes the store-written row', async () => {
		await db.exec(`create table t (x text collate binary primary key, v text) using store`);
		await db.exec(`insert into t values ('A', 'local')`);

		const res = await applyToStore([
			{ type: 'delete', schema: 'main', table: 't', pk: ['A'] },
		], [], { remote: true });
		expect(res.errors).to.have.length(0);

		// Full scan — independent of point-lookup key bytes, so a missed delete
		// (adapter keyed 'A' under NOCASE, store wrote it under BINARY) shows up.
		expect(await collect(db, `select x from t`)).to.deep.equal([]);
	});

	it('remote update on a divergent-collation PK modifies the existing row in place', async () => {
		await db.exec(`create table t (x text collate binary primary key, v text) using store`);
		await db.exec(`insert into t values ('A', 'local')`);

		const res = await applyToStore([
			{ type: 'update', schema: 'main', table: 't', pk: ['A'], columns: { v: 'remote' } },
		], [], { remote: true });
		expect(res.errors).to.have.length(0);

		// A mismatched key makes the UPSERT miss the existing row and write a
		// phantom second copy instead of updating in place.
		expect(await collect(db, `select x, v from t`)).to.deep.equal([{ x: 'A', v: 'remote' }]);
	});

	it('composite PK mixes per-column collations with the table-level fallback', async () => {
		// a → declared BINARY, b → non-text (collation ignored), c → no declared
		// collation so it falls back to K = NOCASE. The remote pk arrives with a
		// case-flipped 'z' for c: under the NOCASE fallback it must still address
		// the row the store keyed for 'Z', while 'A' must match BINARY-exactly.
		await db.exec(`create table t (a text collate binary, b integer, c text, v text, primary key (a, b, c)) using store`);
		await db.exec(`insert into t values ('A', 1, 'Z', 'local')`);

		let res = await applyToStore([
			{ type: 'update', schema: 'main', table: 't', pk: ['A', 1, 'z'], columns: { v: 'remote' } },
		], [], { remote: true });
		expect(res.errors).to.have.length(0);
		expect(await collect(db, `select a, b, c, v from t`)).to.deep.equal([{ a: 'A', b: 1, c: 'Z', v: 'remote' }]);

		res = await applyToStore([
			{ type: 'delete', schema: 'main', table: 't', pk: ['A', 1, 'z'] },
		], [], { remote: true });
		expect(res.errors).to.have.length(0);
		expect(await collect(db, `select a from t`)).to.deep.equal([]);
	});
});
