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
