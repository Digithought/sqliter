import { expect } from 'chai';
import { tee, merge } from '../../src/runtime/async-util.js';

interface SourceState {
	nextCalls: number;   // times .next() was invoked on the iterator
	returned: number;    // times .return() was invoked on the iterator
	finallyRan: number;  // times the generator's finally block ran (real cleanup)
}

/**
 * Build an observable async source. The wrapper counts next()/return() calls;
 * the inner generator's finally increments `finallyRan` so we can tell a real
 * cleanup (row-slot free / vtab disconnect analogue) from a no-op return() on
 * an already-completed generator.
 */
function makeSource<T>(items: readonly T[], opts: { throwAt?: number } = {}): { iterable: AsyncIterable<T>; state: SourceState } {
	const state: SourceState = { nextCalls: 0, returned: 0, finallyRan: 0 };

	async function* gen(): AsyncGenerator<T> {
		try {
			for (let i = 0; i < items.length; i++) {
				if (opts.throwAt === i) {
					throw new Error(`boom at ${i}`);
				}
				yield items[i];
			}
			if (opts.throwAt === items.length) {
				throw new Error(`boom at ${items.length}`);
			}
		} finally {
			state.finallyRan++;
		}
	}

	const inner = gen();
	const iterable: AsyncIterable<T> = {
		[Symbol.asyncIterator]() {
			return {
				next() {
					state.nextCalls++;
					return inner.next();
				},
				return(value?: unknown) {
					state.returned++;
					return inner.return(value as T);
				},
				throw(e?: unknown) {
					return inner.throw(e);
				},
			} as AsyncIterator<T>;
		},
	};

	return { iterable, state };
}

describe('async-util tee()', () => {
	it('closes the source when a consumer breaks early', async () => {
		const { iterable, state } = makeSource([1, 2, 3, 4, 5]);
		const [a] = tee(iterable);

		const seen: number[] = [];
		for await (const x of a) {
			seen.push(x);
			if (seen.length === 2) break;
		}

		expect(seen).to.deep.equal([1, 2]);
		expect(state.returned, 'return() called once on early break').to.equal(1);
		expect(state.finallyRan, 'source finally ran exactly once').to.equal(1);
	});

	it('closes the source once on full drain of both consumers (no double-close)', async () => {
		const { iterable, state } = makeSource([1, 2, 3]);
		const [a, b] = tee(iterable);

		const seenA: number[] = [];
		const seenB: number[] = [];
		// Drain both concurrently to interleave the shared buffer.
		await Promise.all([
			(async () => { for await (const x of a) seenA.push(x); })(),
			(async () => { for await (const x of b) seenB.push(x); })(),
		]);

		expect(seenA).to.deep.equal([1, 2, 3]);
		expect(seenB).to.deep.equal([1, 2, 3]);
		// Natural completion: source finally ran once, and no spurious return().
		expect(state.finallyRan, 'source finally ran exactly once').to.equal(1);
		expect(state.returned, 'no redundant return() after natural drain').to.equal(0);
	});

	it('releases the source even when the second consumer is never iterated', async () => {
		const { iterable, state } = makeSource([1, 2, 3]);
		const [a] = tee(iterable); // second stream deliberately dropped

		const seen: number[] = [];
		for await (const x of a) seen.push(x);

		expect(seen).to.deep.equal([1, 2, 3]);
		expect(state.finallyRan, 'source released via natural completion').to.equal(1);
		expect(state.returned).to.equal(0);
	});

	it('does not close the source while one consumer is still live', async () => {
		const { iterable, state } = makeSource([1, 2, 3, 4, 5]);
		const [a, b] = tee(iterable);

		const itA = a[Symbol.asyncIterator]();
		const itB = b[Symbol.asyncIterator]();

		await itA.next(); // enter a
		await itB.next(); // enter b
		await itA.return!(undefined); // a leaves early; b still live

		expect(state.returned, 'source NOT closed while b is live').to.equal(0);

		await itB.return!(undefined); // last consumer out
		expect(state.returned, 'source closed once after last consumer leaves').to.equal(1);
		expect(state.finallyRan).to.equal(1);
	});

	it('propagates a source error to the consumer and runs its finally', async () => {
		const { iterable, state } = makeSource<number>([1], { throwAt: 1 }); // yields 1, then throws
		const [a] = tee(iterable);

		const seen: number[] = [];
		let caught: Error | undefined;
		try {
			for await (const x of a) seen.push(x);
		} catch (e) {
			caught = e as Error;
		}

		expect(seen).to.deep.equal([1]);
		expect(caught, 'source error propagated to consumer').to.be.instanceOf(Error);
		expect(caught!.message).to.match(/boom at 1/);
		// The source threw internally, so its finally ran exactly once as part of
		// the throw — cleanup happened, no leak.
		expect(state.finallyRan, 'source finally ran on throw').to.equal(1);
	});
});

describe('async-util merge()', () => {
	it('yields items from all sources', async () => {
		const a = makeSource([1, 2, 3]);
		const b = makeSource([10, 20]);

		const seen: number[] = [];
		for await (const x of merge(a.iterable, b.iterable)) {
			seen.push(x);
		}

		expect(seen.slice().sort((x, y) => x - y)).to.deep.equal([1, 2, 3, 10, 20]);
	});

	it('closes every still-live source on consumer early break', async () => {
		const a = makeSource([1, 2, 3, 4, 5]);
		const b = makeSource([10, 20, 30, 40, 50]);

		const seen: number[] = [];
		for await (const x of merge(a.iterable, b.iterable)) {
			seen.push(x);
			if (seen.length === 2) break;
		}

		expect(seen.length).to.equal(2);
		expect(a.state.returned, 'source a return()-ed once').to.equal(1);
		expect(b.state.returned, 'source b return()-ed once').to.equal(1);
		expect(a.state.finallyRan).to.equal(1);
		expect(b.state.finallyRan).to.equal(1);
	});

	it('propagates a source error and still closes the other live sources', async () => {
		const a = makeSource<number>([], { throwAt: 0 }); // throws on first next()
		const b = makeSource([1, 2, 3, 4, 5]);

		let caught: Error | undefined;
		try {
			for await (const _ of merge(a.iterable, b.iterable)) {
				// consume until the throw unwinds
			}
		} catch (e) {
			caught = e as Error;
		}

		expect(caught, 'error propagated to consumer').to.be.instanceOf(Error);
		expect(caught!.message).to.match(/boom at 0/);
		// b was still live when a threw — it must be released.
		expect(b.state.returned, 'live sibling closed once').to.equal(1);
		expect(b.state.finallyRan).to.equal(1);
	});

	it('leaves no source open on full drain and does not double-close', async () => {
		const a = makeSource([1, 2]);
		const b = makeSource([10]);

		const seen: number[] = [];
		for await (const x of merge(a.iterable, b.iterable)) {
			seen.push(x);
		}

		expect(seen.slice().sort((x, y) => x - y)).to.deep.equal([1, 2, 10]);
		// Natural completion: finally ran once, no return() needed.
		expect(a.state.finallyRan).to.equal(1);
		expect(b.state.finallyRan).to.equal(1);
		expect(a.state.returned, 'no return() after natural drain').to.equal(0);
		expect(b.state.returned).to.equal(0);
	});

	it('pulls each source exactly once per consumed item (no per-row re-wrap)', async () => {
		const a = makeSource([1, 2, 3]);
		const b = makeSource([10, 20]);

		const seen: number[] = [];
		for await (const x of merge(a.iterable, b.iterable)) {
			seen.push(x);
		}

		// N values + 1 terminating done pull per fully-drained source.
		expect(a.state.nextCalls, 'source a pulled once per item + done').to.equal(4);
		expect(b.state.nextCalls, 'source b pulled once per item + done').to.equal(3);
	});
});
