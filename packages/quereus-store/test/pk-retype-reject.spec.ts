/**
 * Direct-module-call guard for `StoreModule.alterColumnSetDataType` on a PRIMARY KEY
 * column (ticket bug-store-pk-column-set-data-type-corrupts-keys).
 *
 * No SQL surface can reach this: `runAlterColumn` (runtime/emit/alter-table.ts) already
 * refuses `ALTER TABLE … ALTER COLUMN <pk-col> SET DATA TYPE …` for every backend before
 * any module call, and the materialized-view reshape never lifts a key-column retype onto
 * `module.alterTable` either — it falls back to a rebuild. So this spec calls
 * `StoreModule.alterTable` directly, bypassing the engine guard, to pin the store-side
 * defense-in-depth reject: without it, the PK's physical key bytes stay encoded under the
 * OLD type while the row VALUE moves to the new one (`alterColumnChange`'s value rewrite is
 * a payload-only `mapRowsAtIndex` that reuses `entry.key` verbatim) — silent corruption, no
 * error.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, QuereusError, StatusCode, type SchemaChangeInfo } from '@quereus/quereus';
import {
	StoreModule,
	InMemoryKVStore,
	buildFullScanBounds,
	bytesToHex,
	type KVStore,
	type KVStoreProvider,
} from '../src/index.js';

function createInMemoryProvider(): KVStoreProvider & { stores: Map<string, InMemoryKVStore> } {
	const stores = new Map<string, InMemoryKVStore>();
	const get = (key: string) => {
		if (!stores.has(key)) stores.set(key, new InMemoryKVStore());
		return stores.get(key)!;
	};
	return {
		stores,
		async getStore(s, t) { return get(`${s}.${t}`); },
		async getIndexStore(s, t, i) { return get(`${s}.${t}_idx_${i}`); },
		async getStatsStore(s, t) { return get(`${s}.${t}.__stats__`); },
		async getCatalogStore() { return get('__catalog__'); },
		async closeStore() {},
		async closeIndexStore() {},
		async closeAll() {
			for (const store of stores.values()) await store.close();
			stores.clear();
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

describe('StoreModule.alterColumnSetDataType: primary-key column reject', () => {
	let provider: ReturnType<typeof createInMemoryProvider>;
	let db: Database;
	let mod: StoreModule;

	beforeEach(() => {
		provider = createInMemoryProvider();
		db = new Database();
		mod = new StoreModule(provider);
		db.registerModule('store', mod);
	});

	afterEach(async () => {
		await db.close();
		await provider.closeAll();
	});

	it('rejects a logical-type-changing retype of a PK column and leaves the store untouched', async () => {
		await db.exec(`create table t (id text primary key, v text) using store`);
		await db.exec(`insert into t values ('1','a'), ('2','b')`);

		const dataStore = await provider.getStore('main', 't');
		const before = await dumpEntries(dataStore);

		const change: SchemaChangeInfo = { type: 'alterColumn', columnName: 'id', setDataType: 'integer' };
		let err: Error | null = null;
		try {
			await mod.alterTable(db, 'main', 't', change);
		} catch (e) {
			err = e as Error;
		}
		expect(err, 'direct module call rejects the PK retype').to.be.instanceOf(QuereusError);
		expect((err as QuereusError).code).to.equal(StatusCode.CONSTRAINT);
		expect(err!.message).to.match(/primary key column 'id'/);

		// Nothing mutated: same KV bytes, same in-module schema. (Reads the module's own
		// schema, not `db.schemaManager` — a direct module call, unlike SQL ALTER, never
		// updates the engine's catalog copy either way.)
		expect(await dumpEntries(dataStore)).to.deep.equal(before);
		const schema = mod.getTableForExternalWrite(db, 'main', 't')!.getSchema();
		expect(schema.columns.find(c => c.name.toLowerCase() === 'id')!.logicalType.name.toUpperCase()).to.equal('TEXT');
	});

	it('still accepts an alias retype of a PK column (schema-only no-op)', async () => {
		await db.exec(`create table t (id text primary key, v text) using store`);
		await db.exec(`insert into t values ('1','a'), ('2','b')`);

		const dataStore = await provider.getStore('main', 't');
		const before = await dumpEntries(dataStore);

		const change: SchemaChangeInfo = { type: 'alterColumn', columnName: 'id', setDataType: 'varchar(50)' };
		const updated = await mod.alterTable(db, 'main', 't', change);

		// Alias retype flattens to the same logical type object: no row rewrite, no re-key.
		expect(await dumpEntries(dataStore)).to.deep.equal(before);
		expect(updated.columns.find(c => c.name.toLowerCase() === 'id')!.logicalType.name.toUpperCase()).to.equal('TEXT');
	});

	it('still accepts a retype of a non-PK column and rewrites its stored values', async () => {
		await db.exec(`create table t (id text primary key, v text) using store`);
		await db.exec(`insert into t values ('1','10'), ('2','20')`);

		const dataStore = await provider.getStore('main', 't');
		const before = await dumpEntries(dataStore);

		const change: SchemaChangeInfo = { type: 'alterColumn', columnName: 'v', setDataType: 'integer' };
		const updated = await mod.alterTable(db, 'main', 't', change);

		// The non-PK retype guard must not over-reject: the payload rewrite happens, so the
		// stored bytes for the (unchanged-key, rewritten-value) rows differ from before, while
		// the PK-derived keys stay identical.
		const after = await dumpEntries(dataStore);
		expect(after).to.not.deep.equal(before);
		expect(after.map(e => e.key)).to.deep.equal(before.map(e => e.key));
		expect(updated.columns.find(c => c.name.toLowerCase() === 'v')!.logicalType.name.toUpperCase()).to.equal('INTEGER');
	});
});
