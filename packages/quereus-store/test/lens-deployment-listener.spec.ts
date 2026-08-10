/**
 * Tests for StoreModule's lens-deployment forwarder.
 *
 * A logical `apply schema X` fires the engine `notifyLensDeployment` hook on every
 * registered module. StoreModule forwards it to a host-bound listener (the sync
 * layer's basis-table lifecycle recorder in production). The forward is
 * GUARDED — lifecycle bookkeeping is advisory, so a throwing listener is
 * swallowed (structured-logged) and must never abort the deploy, deliberately
 * inverting the engine's "a throwing notification aborts apply schema" contract.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'node:assert/strict';
import { Database, type LensDeploymentSnapshot } from '@quereus/quereus';
import {
	StoreModule,
	InMemoryKVStore,
	type KVStoreProvider,
} from '../src/index.js';

function createInMemoryProvider(): KVStoreProvider {
	const stores = new Map<string, InMemoryKVStore>();
	const get = (key: string) => {
		if (!stores.has(key)) stores.set(key, new InMemoryKVStore());
		return stores.get(key)!;
	};
	return {
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

const fakeSnapshot = (): LensDeploymentSnapshot => ({
	basisSchemaName: 'y',
	basisHash: '',
	tables: new Map(),
});

describe('StoreModule lens-deployment forwarder', () => {
	let provider: KVStoreProvider;
	let module: StoreModule;

	beforeEach(() => {
		provider = createInMemoryProvider();
		module = new StoreModule(provider);
	});

	afterEach(async () => {
		await provider.closeAll();
	});

	it('no-ops (does not throw) when no listener is bound', async () => {
		const db = new Database();
		await module.notifyLensDeployment(db, 'app', fakeSnapshot());
		await db.close();
	});

	it('forwards the deployment to the bound listener verbatim', async () => {
		const db = new Database();
		const calls: Array<{ schema: string; snapshot: LensDeploymentSnapshot }> = [];
		module.setLensDeploymentListener((_db, schema, snapshot) => {
			calls.push({ schema, snapshot });
		});

		const snap = fakeSnapshot();
		await module.notifyLensDeployment(db, 'app', snap);

		assert.equal(calls.length, 1);
		assert.equal(calls[0].schema, 'app');
		assert.equal(calls[0].snapshot, snap); // reference identity, no copy
		await db.close();
	});

	it('swallows a throwing listener (sync throw) instead of propagating', async () => {
		const db = new Database();
		module.setLensDeploymentListener(() => { throw new Error('bookkeeping-bug'); });
		// Must resolve, not reject.
		await module.notifyLensDeployment(db, 'app', fakeSnapshot());
		await db.close();
	});

	it('swallows a rejecting async listener instead of propagating', async () => {
		const db = new Database();
		module.setLensDeploymentListener(async () => { throw new Error('async-bookkeeping-bug'); });
		await module.notifyLensDeployment(db, 'app', fakeSnapshot());
		await db.close();
	});

	it('a throwing listener does NOT abort a real apply schema', async () => {
		const db = new Database();
		// Register the store module so the engine fires notifyLensDeployment on it;
		// the basis stays memory-backed (the default), name-matched by the lens.
		db.registerModule('store', module);
		module.setLensDeploymentListener(() => { throw new Error('bookkeeping-bug'); });

		await db.exec('declare schema y { table Car { id integer primary key, vin text } }');
		await db.exec('apply schema y');
		await db.exec('declare logical schema app { table Car { id integer primary key, vin text } }');

		// The throwing listener is swallowed by the store forwarder, so the deploy
		// completes and the lens is registered.
		await db.exec('apply schema app');

		const snapshot = db.declaredSchemaManager.getDeployedLensSnapshots('app')?.current;
		assert.ok(snapshot, 'lens deployed despite the throwing bookkeeping listener');

		// The deployed lens view resolves and reads (basis Car is empty).
		const reads: unknown[] = [];
		for await (const r of db.eval('select * from app.Car')) reads.push(r);
		assert.deepEqual(reads, []);

		await db.close();
	});

	it('clears the listener when set to undefined', async () => {
		const db = new Database();
		let calls = 0;
		module.setLensDeploymentListener(() => { calls++; });
		module.setLensDeploymentListener(undefined);
		await module.notifyLensDeployment(db, 'app', fakeSnapshot());
		assert.equal(calls, 0);
		await db.close();
	});
});
