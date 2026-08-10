import { expect } from 'chai';
import { Latches } from '../../src/util/latches.js';
import { QuereusError } from '../../src/common/errors.js';
import { StatusCode } from '../../src/common/types.js';

describe('Latches', () => {
	it('serializes acquires on the same key (default: never rejects)', async () => {
		const key = 'Latches.spec.serialize:1';
		const order: string[] = [];

		const release1 = await Latches.acquire(key);
		// Second acquire must wait for release1.
		const acquire2 = Latches.acquire(key).then((release2) => {
			order.push('second-acquired');
			release2();
		});

		order.push('first-holds');
		// Give the pending second acquire a chance to (wrongly) proceed.
		await Promise.resolve();
		release1();
		await acquire2;

		expect(order).to.deep.equal(['first-holds', 'second-acquired']);
	});

	describe('instance scoping', () => {
		it('two instances do NOT contend on the same key', async () => {
			// Models two independent Database instances that both lock an
			// identically-named table: they must proceed in parallel.
			const a = new Latches();
			const b = new Latches();
			const key = 'MemoryTable.Commit:main.t';

			// `a` holds the key and never releases within the test window.
			await a.acquire(key);

			// `b` acquiring the SAME key must not be blocked by `a`.
			let bAcquired = false;
			const bDone = b.acquire(key).then((releaseB) => {
				bAcquired = true;
				releaseB();
			});

			await bDone;
			expect(bAcquired, 'second instance should acquire independently').to.equal(true);
		});

		it('a single instance still serializes same-key acquires', async () => {
			const latches = new Latches();
			const key = 'MemoryTable.Commit:main.t';
			const order: string[] = [];

			const release1 = await latches.acquire(key);
			const acquire2 = latches.acquire(key).then((release2) => {
				order.push('second-acquired');
				release2();
			});

			order.push('first-holds');
			await Promise.resolve();
			release1();
			await acquire2;

			expect(order).to.deep.equal(['first-holds', 'second-acquired']);
		});
	});

	describe('timeout deadlock guard', () => {
		it('rejects with BUSY when the predecessor does not release in time', async () => {
			const key = 'Latches.spec.timeout:1';
			// First holder never releases within the window.
			const release1 = await Latches.acquire(key);

			let rejected: unknown;
			try {
				await Latches.acquire(key, 10);
			} catch (e) {
				rejected = e;
			}

			expect(rejected, 'timed-out acquire should reject').to.be.instanceOf(QuereusError);
			expect((rejected as QuereusError).code).to.equal(StatusCode.BUSY);

			release1(); // cleanup
		});

		it('releases its own queue slot on timeout so a later waiter is not wedged', async () => {
			const key = 'Latches.spec.timeout:2';
			// First holder is abandoned (never released) — simulates the deadlock case.
			await Latches.acquire(key);

			// Second waiter times out; its slot must be released so the third can proceed.
			await Latches.acquire(key, 10).then(
				() => { throw new Error('second acquire should have timed out'); },
				() => { /* expected BUSY rejection */ },
			);

			// Third acquire must now succeed (queue not wedged by the abandoned second wait).
			const release3 = await Latches.acquire(key, 100);
			release3();
		});
	});
});
