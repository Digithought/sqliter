/**
 * Tests for the `fv:` sync-metadata format gate in `SyncManagerImpl.create`.
 *
 * Per-row records are keyed by pk identity since format 2; older metadata is
 * unreadable under that layout and mixing the two would corrupt both, so a
 * replica whose stored version is missing or different must refuse to open.
 */

import { expect } from 'chai';
import { SyncManagerImpl } from '../../src/sync/sync-manager-impl.js';
import { SyncEventEmitterImpl } from '../../src/sync/events.js';
import { DEFAULT_SYNC_CONFIG, type SyncConfig } from '../../src/sync/protocol.js';
import { SYNC_KEY_PREFIX, SYNC_METADATA_FORMAT_VERSION } from '../../src/metadata/keys.js';
import { InMemoryKVStore } from '@quereus/store';
import { FakeTransactionSource } from '../helpers/fake-transaction-source.js';

describe('sync metadata format version', () => {
	let kv: InMemoryKVStore;
	let source: FakeTransactionSource;
	let syncEvents: SyncEventEmitterImpl;
	let config: SyncConfig;

	const create = (): Promise<SyncManagerImpl> =>
		SyncManagerImpl.create(kv, source, config, syncEvents);

	const storedVersion = async (): Promise<string | undefined> => {
		const data = await kv.get(SYNC_KEY_PREFIX.FORMAT_VERSION);
		return data ? new TextDecoder().decode(data) : undefined;
	};

	beforeEach(() => {
		kv = new InMemoryKVStore();
		source = new FakeTransactionSource();
		syncEvents = new SyncEventEmitterImpl();
		config = { ...DEFAULT_SYNC_CONFIG };
	});

	it('stamps the current version on a fresh replica', async () => {
		await create();
		expect(await storedVersion()).to.equal(String(SYNC_METADATA_FORMAT_VERSION));
	});

	it('reopens a replica it stamped itself', async () => {
		const first = await create();
		const siteId = first.getSiteId();

		const second = await create();
		expect(Array.from(second.getSiteId())).to.deep.equal(Array.from(siteId));
	});

	it('refuses a replica whose metadata predates versioning (identity, no fv:)', async () => {
		await create();
		await kv.delete(SYNC_KEY_PREFIX.FORMAT_VERSION);

		let error: Error | undefined;
		try {
			await create();
		} catch (e) {
			error = e as Error;
		}
		expect(error, 'open must fail').to.not.be.undefined;
		expect(error!.message).to.match(/predates format version/i);
		expect(error!.message, 'names the recovery').to.match(/re-bootstrap/i);
	});

	it('refuses a replica stamped with a different version', async () => {
		await create();
		await kv.put(SYNC_KEY_PREFIX.FORMAT_VERSION, new TextEncoder().encode('99'));

		let error: Error | undefined;
		try {
			await create();
		} catch (e) {
			error = e as Error;
		}
		expect(error, 'open must fail').to.not.be.undefined;
		expect(error!.message).to.match(/format version 99 does not match/i);
	});
});
