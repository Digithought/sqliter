/**
 * Tests for the external row-write entry point — `StoreTable.applyExternalRowChanges`
 * (+ `readRowByPk`) resolved via `StoreModule.getTableForExternalWrite`
 * (`src/common/store-table.ts` / `store-module.ts`).
 *
 * The headline guarantee: committed storage, secondary-index, and stats state
 * after an externally-applied write byte-matches what the equivalent engine DML
 * would have produced — the table owns key encoding and index maintenance, so a
 * trusted replication-style caller no longer duplicates `buildDataKey` /
 * `resolvePkKeyCollations`. All-text columns are used in the byte-match
 * scenarios so row VALUES serialize deterministically (no integer
 * number-vs-bigint storage-class ambiguity), isolating key/index parity.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import {
	StoreModule,
	StoreEventEmitter,
	InMemoryKVStore,
	buildFullScanBounds,
	bytesToHex,
	type KVStore,
	type KVStoreProvider,
	type DataChangeEvent,
} from '../src/index.js';

function createProvider(): KVStoreProvider {
	const stores = new Map<string, InMemoryKVStore>();
	const get = (key: string): InMemoryKVStore => {
		let s = stores.get(key);
		if (!s) {
			s = new InMemoryKVStore();
			stores.set(key, s);
		}
		return s;
	};
	return {
		async getStore(s, t) { return get(`${s}.${t}`); },
		async getIndexStore(s, t, i) { return get(`${s}.${t}_idx_${i}`); },
		async getStatsStore() { return get('__stats__'); },
		async getCatalogStore() { return get('__catalog__'); },
		async closeStore() { /* no-op: shared in-memory store */ },
		async closeIndexStore() { /* no-op */ },
		async closeAll() {
			for (const s of stores.values()) await s.close();
			stores.clear();
		},
		async deleteTableStores(schemaName, tableName, indexNames) {
			stores.delete(`${schemaName}.${tableName}`);
			for (const i of indexNames) stores.delete(`${schemaName}.${tableName}_idx_${i}`);
		},
	};
}

/** Dump a store's entries as `{key,value}` hex pairs, in ascending key order. */
async function dumpEntries(store: KVStore): Promise<Array<{ key: string; value: string }>> {
	const out: Array<{ key: string; value: string }> = [];
	for await (const e of store.iterate(buildFullScanBounds())) {
		out.push({ key: bytesToHex(e.key), value: bytesToHex(e.value) });
	}
	return out;
}

async function countEntries(store: KVStore): Promise<number> {
	let n = 0;
	for await (const _e of store.iterate(buildFullScanBounds())) n++;
	return n;
}

describe('store external row-write entry point', () => {
	let db: Database;
	let provider: KVStoreProvider;
	let events: StoreEventEmitter;
	let storeModule: StoreModule;

	beforeEach(() => {
		db = new Database();
		provider = createProvider();
		events = new StoreEventEmitter();
		storeModule = new StoreModule(provider, events);
		db.registerModule('store', storeModule);
	});
	afterEach(async () => {
		await db.close();
		await provider.closeAll();
	});

	it('getTableForExternalWrite resolves an owned table and undefined for an unknown one', async () => {
		await db.exec('create table t (k text primary key, v text) using store');
		expect(storeModule.getTableForExternalWrite(db, 'main', 't')).to.not.be.undefined;
		expect(storeModule.getTableForExternalWrite(db, 'main', 'no_such_table')).to.be.undefined;
	});

	it('applyExternalRowChanges reports the effective per-op changes with accurate before-images', async () => {
		await db.exec('create table t (k text primary key, v text) using store');
		const t = storeModule.getTableForExternalWrite(db, 'main', 't')!;

		const inserts = await t.applyExternalRowChanges([
			{ op: 'upsert', row: ['k1', 'a'] },
			{ op: 'upsert', row: ['k2', 'b'] },
		]);
		expect(inserts).to.deep.equal([
			{ op: 'insert', newRow: ['k1', 'a'] },
			{ op: 'insert', newRow: ['k2', 'b'] },
		]);

		// readRowByPk sees the just-applied committed rows.
		expect(await t.readRowByPk(['k1'])).to.deep.equal(['k1', 'a']);
		expect(await t.readRowByPk(['nope'])).to.equal(null);

		const mixed = await t.applyExternalRowChanges([
			{ op: 'upsert', row: ['k1', 'A2'] },   // existing → update with before-image
			{ op: 'delete', pk: ['k2'] },          // existing → delete with before-image
		]);
		expect(mixed).to.deep.equal([
			{ op: 'update', oldRow: ['k1', 'a'], newRow: ['k1', 'A2'] },
			{ op: 'delete', oldRow: ['k2', 'b'] },
		]);
	});

	it('suppresses no-ops: absent delete and value-identical upsert write/report nothing', async () => {
		await db.exec('create table t (k text primary key, v text) using store');
		const t = storeModule.getTableForExternalWrite(db, 'main', 't')!;
		const dataStore = await provider.getStore('main', 't');

		await t.applyExternalRowChanges([{ op: 'upsert', row: ['k1', 'a'] }]);
		expect(await t.getEstimatedRowCount()).to.equal(1);
		const afterInsert = await dumpEntries(dataStore);

		const noops = await t.applyExternalRowChanges([
			{ op: 'upsert', row: ['k1', 'a'] },   // byte-identical → suppressed
			{ op: 'delete', pk: ['absent'] },     // absent key → suppressed
		]);
		expect(noops).to.deep.equal([]);
		// Neither storage nor stats moved.
		expect(await dumpEntries(dataStore)).to.deep.equal(afterInsert);
		expect(await t.getEstimatedRowCount()).to.equal(1);
	});

	it('stats deltas count effective inserts/deletes only (update is net zero)', async () => {
		await db.exec('create table t (k text primary key, v text) using store');
		const t = storeModule.getTableForExternalWrite(db, 'main', 't')!;

		await t.applyExternalRowChanges([
			{ op: 'upsert', row: ['k1', 'a'] },
			{ op: 'upsert', row: ['k2', 'b'] },
			{ op: 'upsert', row: ['k3', 'c'] },
		]);
		expect(await t.getEstimatedRowCount()).to.equal(3);

		await t.applyExternalRowChanges([{ op: 'upsert', row: ['k2', 'B2'] }]); // update → net 0
		expect(await t.getEstimatedRowCount()).to.equal(3);

		await t.applyExternalRowChanges([{ op: 'delete', pk: ['k3'] }]);        // delete → -1
		await t.applyExternalRowChanges([{ op: 'delete', pk: ['k3'] }]);        // absent → 0
		expect(await t.getEstimatedRowCount()).to.equal(2);
	});

	it('emits no module data events (a subscribed StoreEventEmitter sees nothing)', async () => {
		await db.exec('create table t (k text primary key, v text) using store');
		const seen: DataChangeEvent[] = [];
		events.onDataChange(e => seen.push(e));

		const t = storeModule.getTableForExternalWrite(db, 'main', 't')!;
		const changes = await t.applyExternalRowChanges([
			{ op: 'upsert', row: ['k1', 'a'] },
			{ op: 'upsert', row: ['k1', 'A2'] },
			{ op: 'delete', pk: ['k1'] },
		]);
		// Work happened (real effective changes) but no event was emitted.
		expect(changes.length).to.equal(3);
		expect(seen).to.deep.equal([]);

		// Sanity: the emitter is live — ordinary engine DML on the same module DOES emit.
		await db.exec("insert into t values ('k9', 'z')");
		expect(seen.length, 'engine DML emits through the same emitter').to.be.greaterThan(0);
	});

	it('committed data + secondary-index bytes match the engine-DML-written equivalent (upsert/update/delete)', async () => {
		// Two same-shape tables: one driven by external row writes, one by engine DML.
		await db.exec('create table dml (k text primary key, v text, w text) using store');
		await db.exec('create index v_dml on dml(v)');
		await db.exec('create table ext (k text primary key, v text, w text) using store');
		await db.exec('create index v_ext on ext(v)');

		// Engine DML history.
		await db.exec("insert into dml values ('k1','a','x'),('k2','b','y'),('k3','c','z')");
		await db.exec("update dml set v='B2' where k='k2'");  // changes the indexed column
		await db.exec("delete from dml where k='k3'");

		// Identical external history (same row VALUES → all-text → deterministic bytes).
		const ext = storeModule.getTableForExternalWrite(db, 'main', 'ext')!;
		await ext.applyExternalRowChanges([
			{ op: 'upsert', row: ['k1', 'a', 'x'] },
			{ op: 'upsert', row: ['k2', 'b', 'y'] },
			{ op: 'upsert', row: ['k3', 'c', 'z'] },
		]);
		await ext.applyExternalRowChanges([{ op: 'upsert', row: ['k2', 'B2', 'y'] }]);
		await ext.applyExternalRowChanges([{ op: 'delete', pk: ['k3'] }]);

		// Data store: identical keys AND serialized values.
		expect(await dumpEntries(await provider.getStore('main', 'ext')))
			.to.deep.equal(await dumpEntries(await provider.getStore('main', 'dml')));
		// Secondary-index store: identical keys (index name lives in the store name,
		// never in the key bytes, so identical rows produce identical index entries).
		expect(await dumpEntries(await provider.getIndexStore('main', 'ext', 'v_ext')))
			.to.deep.equal(await dumpEntries(await provider.getIndexStore('main', 'dml', 'v_dml')));
	});

	it('partial-index scope transitions add/remove without staleness, matching DML', async () => {
		await db.exec('create table dml (k text primary key, v text, flag text) using store');
		await db.exec("create index pv_dml on dml(v) where flag = 'on'");
		await db.exec('create table ext (k text primary key, v text, flag text) using store');
		await db.exec("create index pv_ext on ext(v) where flag = 'on'");

		// k1: in-scope → out-of-scope (entry must be removed, no add).
		// k2: out-of-scope → in-scope (entry must be added, no stale delete).
		await db.exec("insert into dml values ('k1','a','on')");
		await db.exec("update dml set flag='off' where k='k1'");
		await db.exec("insert into dml values ('k2','b','off')");
		await db.exec("update dml set flag='on' where k='k2'");

		const ext = storeModule.getTableForExternalWrite(db, 'main', 'ext')!;
		await ext.applyExternalRowChanges([{ op: 'upsert', row: ['k1', 'a', 'on'] }]);
		await ext.applyExternalRowChanges([{ op: 'upsert', row: ['k1', 'a', 'off'] }]);
		await ext.applyExternalRowChanges([{ op: 'upsert', row: ['k2', 'b', 'off'] }]);
		await ext.applyExternalRowChanges([{ op: 'upsert', row: ['k2', 'b', 'on'] }]);

		// Only k2 is in-scope at the end: exactly one index entry, byte-identical to DML.
		const extIdx = await provider.getIndexStore('main', 'ext', 'pv_ext');
		const dmlIdx = await provider.getIndexStore('main', 'dml', 'pv_dml');
		expect(await countEntries(extIdx)).to.equal(1);
		expect(await dumpEntries(extIdx)).to.deep.equal(await dumpEntries(dmlIdx));
	});

	it('divergent PK collation (collate binary PK on a NOCASE store) keys byte-identically to DML', async () => {
		// PK column explicitly BINARY while the store key collation K defaults NOCASE:
		// 'Apple' and 'apple' are DISTINCT keys (would collide under NOCASE). The
		// table-owned pkKeyCollations make the external write key exactly as DML does.
		await db.exec('create table dml (k text primary key collate binary, v text) using store');
		await db.exec('create table ext (k text primary key collate binary, v text) using store');

		await db.exec("insert into dml values ('Apple','a'),('apple','b')");
		const ext = storeModule.getTableForExternalWrite(db, 'main', 'ext')!;
		await ext.applyExternalRowChanges([
			{ op: 'upsert', row: ['Apple', 'a'] },
			{ op: 'upsert', row: ['apple', 'b'] },
		]);

		// Both rows survive distinctly (binary keying, not collapsed) and byte-match.
		const extData = await provider.getStore('main', 'ext');
		expect(await countEntries(extData)).to.equal(2);
		expect(await dumpEntries(extData))
			.to.deep.equal(await dumpEntries(await provider.getStore('main', 'dml')));

		// A delete keyed 'apple' removes only the lowercase row under BINARY keying.
		await db.exec("delete from dml where k='apple'");
		await ext.applyExternalRowChanges([{ op: 'delete', pk: ['apple'] }]);
		expect(await dumpEntries(extData))
			.to.deep.equal(await dumpEntries(await provider.getStore('main', 'dml')));
		const survivors = (await dumpEntries(extData)).length;
		expect(survivors).to.equal(1);
		expect(await ext.readRowByPk(['Apple'])).to.deep.equal(['Apple', 'a']);
		expect(await ext.readRowByPk(['apple'])).to.equal(null);
	});

	it('multi-column / DESC-direction PK keys and reads byte-identically to DML', async () => {
		// Composite PK with a DESC second column exercises pkDirections beyond the
		// single-column ASC path the byte-match scenarios above used.
		await db.exec('create table dml (a text, b text, v text, primary key (a, b desc)) using store');
		await db.exec('create table ext (a text, b text, v text, primary key (a, b desc)) using store');

		await db.exec("insert into dml values ('x','1','p'),('x','2','q'),('y','1','r')");
		await db.exec("update dml set v='Q2' where a='x' and b='2'");
		await db.exec("delete from dml where a='y' and b='1'");

		const ext = storeModule.getTableForExternalWrite(db, 'main', 'ext')!;
		// extractPK derives [a, b] from the row in PK-definition order.
		await ext.applyExternalRowChanges([
			{ op: 'upsert', row: ['x', '1', 'p'] },
			{ op: 'upsert', row: ['x', '2', 'q'] },
			{ op: 'upsert', row: ['y', '1', 'r'] },
		]);
		await ext.applyExternalRowChanges([{ op: 'upsert', row: ['x', '2', 'Q2'] }]);
		await ext.applyExternalRowChanges([{ op: 'delete', pk: ['y', '1'] }]);

		expect(await dumpEntries(await provider.getStore('main', 'ext')))
			.to.deep.equal(await dumpEntries(await provider.getStore('main', 'dml')));
		// Point read keyed in PK-definition order resolves under the DESC encoding.
		expect(await ext.readRowByPk(['x', '2'])).to.deep.equal(['x', '2', 'Q2']);
	});

	it('NULL indexed-column transitions maintain the secondary index like DML', async () => {
		// A NULL value entering/leaving an indexed column must add/remove the index
		// entry exactly as DML does (NULL is a distinct, indexable key, not absence).
		await db.exec('create table dml (k text primary key, v text null) using store');
		await db.exec('create index v_dml on dml(v)');
		await db.exec('create table ext (k text primary key, v text null) using store');
		await db.exec('create index v_ext on ext(v)');

		await db.exec("insert into dml values ('k1',null),('k2','b')");
		await db.exec("update dml set v='a' where k='k1'");  // NULL → non-NULL
		await db.exec("update dml set v=null where k='k2'");  // non-NULL → NULL

		const ext = storeModule.getTableForExternalWrite(db, 'main', 'ext')!;
		await ext.applyExternalRowChanges([
			{ op: 'upsert', row: ['k1', null] },
			{ op: 'upsert', row: ['k2', 'b'] },
		]);
		await ext.applyExternalRowChanges([{ op: 'upsert', row: ['k1', 'a'] }]);
		await ext.applyExternalRowChanges([{ op: 'upsert', row: ['k2', null] }]);

		expect(await dumpEntries(await provider.getStore('main', 'ext')))
			.to.deep.equal(await dumpEntries(await provider.getStore('main', 'dml')));
		expect(await dumpEntries(await provider.getIndexStore('main', 'ext', 'v_ext')))
			.to.deep.equal(await dumpEntries(await provider.getIndexStore('main', 'dml', 'v_dml')));
	});
});
