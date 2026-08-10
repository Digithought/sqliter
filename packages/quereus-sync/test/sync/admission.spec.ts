/**
 * Focused unit tests for the group-atomic admission core (`admitGroup` /
 * `applyDataToStore`, src/sync/admission.ts) that backs every sync ingress
 * modality.
 *
 * These pin the ordering invariant directly (docs/sync.md § Transactional
 * Integrity During Sync): data first → metadata second → watermark; a data-apply
 * failure emits `status:'error'` and aborts BEFORE any metadata commit or clock
 * advance. The end-to-end paths are covered in store-adapter-seam.spec.ts and
 * snapshot-bootstrap.spec.ts; here we exercise the core in isolation with stubs.
 */

import { expect } from 'chai';
import { InMemoryKVStore } from '@quereus/store';
import { HLCManager } from '../../src/clock/hlc.js';
import { generateSiteId } from '../../src/clock/site.js';
import { admitGroup, applyDataToStore } from '../../src/sync/admission.js';
import type { SyncContext } from '../../src/sync/sync-context.js';
import type {
	ApplyToStoreCallback,
	ApplyToStoreResult,
	DataChangeToApply,
} from '../../src/sync/protocol.js';

const okResult: ApplyToStoreResult = { dataChangesApplied: 0, schemaChangesApplied: 0, errors: [] };

const oneChange: DataChangeToApply[] = [
	{ type: 'update', schema: 'main', table: 't', pk: ['k'], columns: { v: 1 } },
];

interface Harness {
	ctx: SyncContext;
	/** Ordered trace of the side effects the core drives. */
	order: string[];
	errors: Array<Error | undefined>;
}

/** A minimal SyncContext wired with real KV + HLC and a tracing event sink. */
function makeHarness(applyToStore?: ApplyToStoreCallback): Harness {
	const order: string[] = [];
	const errors: Array<Error | undefined> = [];
	const hlcManager = new HLCManager(generateSiteId());

	const origReceive = hlcManager.receive.bind(hlcManager);
	hlcManager.receive = (remote) => {
		order.push('receive');
		return origReceive(remote);
	};

	const ctx = {
		kv: new InMemoryKVStore(),
		hlcManager,
		applyToStore,
		syncEvents: {
			emitSyncStateChange: (state: { status: string; error?: Error }) => {
				if (state.status === 'error') {
					order.push('error-event');
					errors.push(state.error);
				}
			},
		},
	} as unknown as SyncContext;

	return { ctx, order, errors };
}

describe('admission core (admitGroup / applyDataToStore)', () => {
	it('admitGroup: a whole-batch data throw aborts before metadata + watermark', async () => {
		const { ctx, order, errors } = makeHarness(async () => { throw new Error('boom'); });
		let committed = false;
		const remote = new HLCManager(generateSiteId()).tick();

		let thrown: unknown;
		try {
			await admitGroup(ctx, {
				dataChanges: oneChange,
				schemaChanges: [],
				applyOptions: { remote: true },
				commitMetadata: async () => { committed = true; order.push('commit'); },
				watermarkHLC: remote,
			});
		} catch (e) {
			thrown = e;
		}

		expect(String(thrown)).to.contain('boom');
		void expect(committed, 'metadata NOT committed after a data throw').to.be.false;
		// status:'error' emitted once; neither commit nor watermark receive ran.
		expect(order, 'only the error event fired').to.deep.equal(['error-event']);
		expect(errors[0]?.message).to.contain('boom');
	});

	it('admitGroup: per-change errors abort before metadata + watermark (single error emit)', async () => {
		const { ctx, order } = makeHarness(async (data) => ({
			dataChangesApplied: 0,
			schemaChangesApplied: 0,
			errors: [{ change: data[0], error: new Error('per-change fail') }],
		}));
		let committed = false;
		const remote = new HLCManager(generateSiteId()).tick();

		let thrown: unknown;
		try {
			await admitGroup(ctx, {
				dataChanges: oneChange,
				schemaChanges: [],
				applyOptions: { remote: true },
				commitMetadata: async () => { committed = true; order.push('commit'); },
				watermarkHLC: remote,
			});
		} catch (e) {
			thrown = e;
		}

		expect(String(thrown)).to.contain('apply-to-store failed');
		void expect(committed, 'metadata NOT committed on per-change errors').to.be.false;
		// Exactly one error event (the catch path is skipped — mutually exclusive).
		expect(order.filter(o => o === 'error-event'), 'single error emit').to.have.length(1);
		expect(order, 'no commit, no watermark receive').to.not.include('receive');
	});

	it('admitGroup: success commits metadata THEN advances the watermark', async () => {
		const { ctx, order, errors } = makeHarness(async () => okResult);
		const remote = new HLCManager(generateSiteId()).tick();

		await admitGroup(ctx, {
			dataChanges: oneChange,
			schemaChanges: [],
			applyOptions: { remote: true },
			commitMetadata: async () => { order.push('commit'); },
			watermarkHLC: remote,
		});

		// Metadata commit precedes the clock watermark merge; no error emitted.
		expect(order, 'commit precedes watermark receive').to.deep.equal(['commit', 'receive']);
		expect(errors, 'no error events on the happy path').to.have.length(0);
	});

	it('admitGroup: omitting watermarkHLC commits metadata but never advances the clock', async () => {
		const { ctx, order } = makeHarness(async () => okResult);

		await admitGroup(ctx, {
			dataChanges: oneChange,
			schemaChanges: [],
			applyOptions: { remote: true },
			commitMetadata: async () => { order.push('commit'); },
			// no watermarkHLC
		});

		expect(order, 'commit ran, watermark receive did not').to.deep.equal(['commit']);
	});

	it('applyDataToStore: no callback work for an empty unit', async () => {
		let called = false;
		const { ctx } = makeHarness(async () => { called = true; return okResult; });

		await applyDataToStore(ctx, [], [], { remote: true });
		void expect(called, 'callback not invoked when there is nothing to apply').to.be.false;
	});

	it('applyDataToStore: no callback configured is a no-op even with changes', async () => {
		const { ctx, order } = makeHarness(undefined);
		await applyDataToStore(ctx, oneChange, [], { remote: true });
		expect(order, 'no events without an applyToStore callback').to.deep.equal([]);
	});
});
