/**
 * Registers the two provider-level conformance batteries against
 * `createInMemoryProvider` (`@quereus/store/testing`), plus the `costProfile` shape this
 * provider is documented to preserve.
 *
 * This provider is the reference in-memory implementation of both the naming and reclaim
 * properties, so a failure here means the provider (or the shared battery) is wrong, not
 * some other package's plugin.
 */

import { describe, it } from 'mocha';
import { expect } from 'chai';
import {
	createInMemoryProvider,
	runStoreNameDistinctness,
	runStoreReclaimConformance,
	type KVProviderLifecycle,
} from '../src/testing/index.js';
import type { KVCostProfile } from '../src/index.js';

/** Fresh, empty provider per test — the shape both provider-level batteries require. */
function lifecycle(): KVProviderLifecycle {
	return {
		open: async () => createInMemoryProvider(),
		teardown: async () => {},
	};
}

runStoreNameDistinctness('createInMemoryProvider store names', lifecycle);
runStoreReclaimConformance('createInMemoryProvider store reclaim', lifecycle);

describe('createInMemoryProvider store identity', () => {
	it('hands back one handle per built store name', async () => {
		const provider = createInMemoryProvider();
		expect(await provider.getStore('main', 't')).to.equal(await provider.getStore('main', 't'));
		expect(await provider.getIndexStore('main', 't', 'x'))
			.to.equal(await provider.getIndexStore('main', 't', 'x'));
	});

	it('returns ONE unified stats store whatever schema/table it is asked for', async () => {
		// The interface documents both arguments as ignored; the per-table
		// `schema.table.__stats__` spelling most local copies use is the accidental variant.
		const provider = createInMemoryProvider();
		const forT = await provider.getStatsStore('main', 't');
		expect(await provider.getStatsStore('main', 'u')).to.equal(forT);
		expect(await provider.getStatsStore('other', 't')).to.equal(forT);
	});

	it('closes every handed-out store on closeAll, and re-opens the name fresh after', async () => {
		const provider = createInMemoryProvider();
		const data = await provider.getStore('main', 't');
		await data.put(Uint8Array.of(0x01), Uint8Array.of(0x10));
		await provider.closeAll();

		// A closed InMemoryKVStore rejects every operation — that is how closeAll is observable.
		let closedError: unknown;
		try {
			await data.get(Uint8Array.of(0x01));
		} catch (err) {
			closedError = err;
		}
		expect(closedError).to.be.an('error');
		expect((closedError as Error).message).to.match(/closed/);

		const reopened = await provider.getStore('main', 't');
		expect(reopened).to.not.equal(data);
		expect(await reopened.get(Uint8Array.of(0x01))).to.equal(undefined);
	});
});

describe('createInMemoryProvider costProfile shape', () => {
	it('has no costProfile property when called with no arguments', () => {
		const provider = createInMemoryProvider();
		expect('costProfile' in provider).to.equal(false);
	});

	it('has no costProfile property when called with an empty options object', () => {
		const provider = createInMemoryProvider({});
		expect('costProfile' in provider).to.equal(false);
	});

	it('surfaces a declared costProfile verbatim', () => {
		const costProfile: KVCostProfile = { pointRead: 2, seekPositioning: 0.25 };
		const provider = createInMemoryProvider({ costProfile });
		expect(provider.costProfile).to.equal(costProfile);
	});
});
