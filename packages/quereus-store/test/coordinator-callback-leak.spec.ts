/**
 * Regression: the module-wide TransactionCoordinator must not accumulate stats
 * callbacks across hard table eviction (drop / recreate / rename).
 *
 * Each StoreTable registers one {onCommit: applyPendingStats, onRollback:
 * discardPendingStats} pair the first time it attaches the coordinator (on its
 * first write). The coordinator is shared by every table of the module and only
 * `closeAll` clears it, so an evicted StoreTable whose pair is never deregistered
 * stays pinned (its closures capture the instance) for the module's lifetime — a
 * leak bounded by drop/recreate/rename count, not by data size. The fix:
 * `tearDownTableStorage` and `renameTable` call `StoreTable.dispose()`, which runs
 * the disposer returned by `registerCallbacks`. After N churn cycles the
 * coordinator's callbackCount must be O(live tables), not O(N).
 *
 * Drives the genuine eviction path end-to-end through Database + StoreModule
 * (mirrors reclaim-detached-table.spec.ts's persistent provider so dropped/renamed
 * physical storage behaves like a real provider).
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import {
	StoreModule,
	StoreEventEmitter,
	InMemoryKVStore,
	type KVStoreProvider,
} from '../src/index.js';

function createPersistentProvider(): KVStoreProvider & {
	stores: Map<string, InMemoryKVStore>;
	_hardClose: () => void;
} {
	const stores = new Map<string, InMemoryKVStore>();
	const getOrCreate = (key: string): InMemoryKVStore => {
		let s = stores.get(key);
		if (!s) { s = new InMemoryKVStore(); stores.set(key, s); }
		return s;
	};
	const dataKey = (s: string, t: string) => `${s}.${t}`;
	const statsKey = (s: string, t: string) => `${s}.${t}.__stats__`;
	const idxKey = (s: string, t: string, i: string) => `${s}.${t}_idx_${i}`;
	const move = (from: string, to: string) => {
		const v = stores.get(from);
		if (v) { stores.set(to, v); stores.delete(from); }
	};

	return {
		stores,
		async getStore(s: string, t: string) { return getOrCreate(dataKey(s, t)); },
		async getIndexStore(s: string, t: string, i: string) { return getOrCreate(idxKey(s, t, i)); },
		async getStatsStore(s: string, t: string) { return getOrCreate(statsKey(s, t)); },
		async getCatalogStore() { return getOrCreate('__catalog__'); },
		async closeStore() { /* durable */ },
		async closeIndexStore() { /* durable */ },
		async deleteIndexStore(s: string, t: string, i: string) { stores.delete(idxKey(s, t, i)); },
		async deleteTableStores(s: string, t: string, indexNames: readonly string[]) {
			stores.delete(dataKey(s, t));
			stores.delete(statsKey(s, t));
			for (const i of indexNames) stores.delete(idxKey(s, t, i));
		},
		async renameTableStores(s: string, oldName: string, newName: string, indexNames: readonly string[]) {
			move(dataKey(s, oldName), dataKey(s, newName));
			move(statsKey(s, oldName), statsKey(s, newName));
			for (const i of indexNames) move(idxKey(s, oldName, i), idxKey(s, newName, i));
		},
		async closeAll() { /* data survives module close */ },
		_hardClose() {
			for (const s of stores.values()) void s.close();
			stores.clear();
		},
	};
}

describe('coordinator callback leak (hard eviction deregisters stats callbacks)', () => {
	let provider: ReturnType<typeof createPersistentProvider>;
	let events: StoreEventEmitter;

	beforeEach(() => {
		provider = createPersistentProvider();
		events = new StoreEventEmitter();
	});

	afterEach(() => provider._hardClose());

	it('drop+recreate cycles do not accumulate coordinator callbacks', async () => {
		const db = new Database();
		const mod = new StoreModule(provider, events);
		db.registerModule('store', mod);

		// A long-lived sibling keeps the coordinator non-empty across the churn.
		await db.exec(`create table keep (id integer primary key) using store`);
		await db.exec(`insert into keep values (1)`);

		const baseline = mod.getCoordinator().callbackCount;
		expect(baseline).to.be.greaterThan(0); // `keep` registered its pair

		for (let i = 0; i < 10; i++) {
			await db.exec(`create table churn (id integer primary key, v integer) using store`);
			await db.exec(`insert into churn values (1, ${i})`); // first write → attachCoordinator → register
			await db.exec(`drop table churn`);                   // destroy → tearDownTableStorage → dispose
		}

		// Each cycle minted a fresh StoreTable that registered, then was disposed on
		// drop. Without the fix this would be baseline + 10.
		expect(mod.getCoordinator().callbackCount).to.equal(baseline);

		await db.close();
	});

	it('rename evicts the old instance and the renamed table re-registers exactly once', async () => {
		const db = new Database();
		const mod = new StoreModule(provider, events);
		db.registerModule('store', mod);

		await db.exec(`create table a (id integer primary key, v integer) using store`);
		await db.exec(`insert into a values (1, 0)`);
		const afterCreate = mod.getCoordinator().callbackCount;

		// Ping-pong rename a<->b, writing after each so the fresh instance attaches.
		for (let i = 0; i < 6; i++) {
			const from = i % 2 === 0 ? 'a' : 'b';
			const to = i % 2 === 0 ? 'b' : 'a';
			await db.exec(`alter table ${from} rename to ${to}`); // renameTable → existing.dispose()
			await db.exec(`insert into ${to} values (${i + 2}, ${i})`);
		}

		// Old instances were disposed on each rename; exactly one live registration
		// remains for the (single) logical table. Without the fix: afterCreate + 6.
		expect(mod.getCoordinator().callbackCount).to.equal(afterCreate);

		await db.close();
	});
});
