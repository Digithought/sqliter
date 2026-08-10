/**
 * Negative control for the store-name distinctness guard.
 *
 * `runStoreNameDistinctness` asserts that a provider never folds two distinct logical
 * stores onto one physical store. A guard nobody has watched fail is not a guard — so this
 * spec drives {@link assertStoreNamesDistinct} directly against provider doubles built to
 * violate it, and checks it REJECTS; plus a faithful double that must PASS.
 *
 * The doubles differ only in how they translate a logical store name into the key of the
 * in-memory map standing in for physical storage. That is exactly the one thing a real
 * provider does differently from its siblings, so the doubles are small and the failures
 * are the same ones a real provider would produce.
 */

import assert from 'node:assert/strict';
import { InMemoryKVStore, buildDataStoreName, buildIndexStoreName, type KVStore, type KVStoreProvider } from '../src/index.js';
import { assertStoreNamesDistinct } from '../src/testing/kv-naming-conformance.js';

/**
 * A provider whose physical namespace is an in-memory map keyed by `encode(storeName)`.
 * `encode` throwing stands in for a provider that REFUSES a name it cannot represent.
 */
function providerWithEncoding(encode: (storeName: string) => string): KVStoreProvider {
	const physical = new Map<string, InMemoryKVStore>();
	const open = (storeName: string): KVStore => {
		const key = encode(storeName);
		let store = physical.get(key);
		if (!store) {
			store = new InMemoryKVStore();
			physical.set(key, store);
		}
		return store;
	};
	return {
		async getStore(schema, table) { return open(buildDataStoreName(schema, table)); },
		async getIndexStore(schema, table, index) { return open(buildIndexStoreName(schema, table, index)); },
		async getStatsStore() { return open('__stats__'); },
		async getCatalogStore() { return open('__catalog__'); },
		async closeStore() { /* nothing to release */ },
		async closeIndexStore() { /* nothing to release */ },
		async closeAll() {
			for (const store of physical.values()) await store.close();
			physical.clear();
		},
	};
}

describe('assertStoreNamesDistinct (store-name distinctness guard)', () => {
	it('accepts a provider that uses the built store name verbatim', async () => {
		// What IndexedDB does: the physical name IS the logical name.
		await assertStoreNamesDistinct(providerWithEncoding(name => name));
	});

	it('accepts a provider whose escaping is injective', async () => {
		// What LevelDB does: percent-escape the bytes, `%` reserved as the introducer.
		const percentEscape = (name: string): string => {
			let out = '';
			for (const byte of new TextEncoder().encode(name)) {
				out += (byte > 34 && byte < 127 && byte !== 0x25)
					? String.fromCharCode(byte)
					: '%' + byte.toString(16).toUpperCase().padStart(2, '0');
			}
			return out;
		};
		await assertStoreNamesDistinct(providerWithEncoding(percentEscape));
	});

	it('rejects a provider that folds punctuation to a single character', async () => {
		// The defect this battery exists for: `a-b` and `a b` both become `a_b`.
		await assert.rejects(
			() => assertStoreNamesDistinct(providerWithEncoding(name => name.replace(/[^a-z0-9_]/g, '_'))),
			/share one physical store/,
		);
	});

	it('rejects a provider that truncates long names', async () => {
		// A different lossy mapping with the same consequence — the battery must not be
		// tuned to one particular folding.
		await assert.rejects(
			() => assertStoreNamesDistinct(providerWithEncoding(name => name.slice(0, 6))),
			/share one physical store/,
		);
	});

	it('rejects a provider that refuses a name any namespace could represent', async () => {
		// Refusal is the safe escape hatch, but not for `[a-z0-9_.]` names — a provider
		// cannot buy a pass by rejecting `main.t`.
		await assert.rejects(
			() => assertStoreNamesDistinct(providerWithEncoding(name => {
				if (name.includes('_idx_')) throw new Error('no index stores here');
				return name;
			})),
			/must be representable/,
		);
	});

	it('accepts a provider that refuses the names it cannot represent, and reports them', async () => {
		// Refusing an awkward name is the safe outcome and must pass — but never silently:
		// the refused names come back through `report` so the battery can log them and a
		// provider cannot quietly shrink what it is being tested on.
		const rejected: string[] = [];
		await assertStoreNamesDistinct(
			providerWithEncoding(name => {
				// An ASCII-only namespace: every `mustAccept` name still fits.
				if (!/^[\x20-\x7e]*$/.test(name)) throw new Error(`cannot represent ${name}`);
				return name;
			}),
			rejected,
		);
		assert.deepStrictEqual(
			rejected.map(entry => entry.split(' (')[0]),
			['main.café', 'main.weißbier'],
			'refused names must be reported to the caller, not swallowed',
		);
	});
});
