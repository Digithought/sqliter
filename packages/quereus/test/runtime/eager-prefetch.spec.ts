import { expect } from 'chai';
import { prefetchAsyncIterable, BoundedPrefetchBuffer } from '../../src/runtime/emit/eager-prefetch.js';
import { RowContextMap, createRowSlot } from '../../src/runtime/context-helpers.js';
import { createStrictRowContextMap, wrapTableContextsStrict } from '../../src/runtime/strict-fork.js';
import type { RuntimeContext } from '../../src/runtime/types.js';
import type { Row } from '../../src/common/types.js';
import type { RowDescriptor } from '../../src/planner/nodes/plan-node.js';
import { makeDeferred, type Deferred } from '../util/controllable-source.js';

function makeRuntimeContext(): RuntimeContext {
	return {
		db: undefined as unknown as RuntimeContext['db'],
		stmt: undefined,
		params: {},
		context: new RowContextMap(),
		tableContexts: new Map(),
		enableMetrics: false,
	};
}

function makeStrictRuntimeContext(): RuntimeContext {
	return {
		db: undefined as unknown as RuntimeContext['db'],
		stmt: undefined,
		params: {},
		context: createStrictRowContextMap(),
		tableContexts: wrapTableContextsStrict(new Map()),
		enableMetrics: false,
	};
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of iter) out.push(item);
	return out;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

describe('EagerPrefetch', () => {
	describe('pass-through equivalence', () => {
		it('yields rows in order', async () => {
			const rows: Row[] = [['A'], ['B'], ['C'], ['D'], ['E']];
			const ctx = makeRuntimeContext();
			const source = async function* (_inner: RuntimeContext): AsyncIterable<Row> {
				for (const r of rows) yield r;
			};

			const out = await collect(prefetchAsyncIterable(ctx, source, 8));
			expect(out).to.deep.equal(rows);
		});

		it('empty source yields nothing and completes', async () => {
			const ctx = makeRuntimeContext();
			const source = async function* (_inner: RuntimeContext): AsyncIterable<Row> {
				// no rows
			};

			const out = await collect(prefetchAsyncIterable(ctx, source, 4));
			expect(out).to.deep.equal([]);
		});
	});

	describe('eager start', () => {
		it('starts the source on construction, before any iter.next()', async () => {
			const ctx = makeRuntimeContext();
			let started = false;
			const source = (_inner: RuntimeContext): AsyncIterable<Row> => (async function* () {
				started = true;
				yield ['first'] as Row;
				yield ['second'] as Row;
			})();

			// EAGER contract: building the iterable forks and starts the pump
			// immediately. The pump's first `childIter.next()` runs the source's
			// body synchronously up to its first yield — so `started` flips to
			// true at construction time, before any consumer `.next()`.
			const iterable = prefetchAsyncIterable(ctx, source, 4);
			expect(started).to.equal(true, 'pump must start the source eagerly on construction');

			const iter = iterable[Symbol.asyncIterator]();
			const r = await iter.next();
			expect(r.value).to.deep.equal(['first']);

			// Drain to allow cleanup.
			await iter.next();
			await iter.next();
		});

		it('pre-fetches additional rows while the consumer is busy elsewhere', async () => {
			const ctx = makeRuntimeContext();
			let yielded = 0;
			// `allPulled` resolves the instant the source has produced its 5th row,
			// which can only happen if the pump kept fetching without consumer demand.
			const allPulled = makeDeferred();
			const source = (_inner: RuntimeContext): AsyncIterable<Row> => (async function* () {
				for (let i = 0; i < 5; i++) {
					yielded++;
					if (yielded === 5) allPulled.resolve();
					yield [i] as Row;
				}
			})();

			const iter = prefetchAsyncIterable(ctx, source, 8)[Symbol.asyncIterator]();
			// Trigger the pump and immediately consume one row.
			const first = await iter.next();
			expect(first.value).to.deep.equal([0]);

			// The consumer stays idle; with a buffer of 8 the pump must drain all 5
			// rows on its own. Awaiting `allPulled` proves the prefetch deterministically.
			await allPulled.promise;
			expect(yielded).to.equal(5, `pump did not pre-fetch: only ${yielded} of 5 rows yielded`);

			// Cleanup.
			await iter.return?.();
		});
	});

	describe('build/probe overlap (the headline win)', () => {
		it("starts the probe's first fetch during the build window, not after it", async () => {
			// Mirrors a BloomJoin: the consumer drains the "build" to completion before
			// touching the probe. With eager-on-construction the probe's first fetch is
			// already in flight while the build materializes; the old lazy behavior would
			// not fire it until the drain below began.
			//
			// Deterministic proof via event ordering: both the probe's first fetch and
			// the build-complete marker append to a shared trace. Because the pump starts
			// the probe synchronously on construction, the probe-first-fetch event is
			// recorded before we ever signal the build complete — independent of timing.
			const ctx = makeRuntimeContext();
			const trace: string[] = [];
			const firstFetchSeen = makeDeferred();

			const probeSource = (_inner: RuntimeContext): AsyncIterable<Row> => ({
				[Symbol.asyncIterator]() {
					let i = 0;
					let recorded = false;
					return {
						async next(): Promise<IteratorResult<Row>> {
							if (!recorded) {
								recorded = true;
								trace.push('probe-first-fetch');
								firstFetchSeen.resolve();
							}
							if (i >= 3) return { done: true, value: undefined as unknown as Row };
							return { done: false, value: [i++] as Row };
						},
					};
				},
			});

			// Construct the prefetch — the eager pump issues the probe's first fetch now.
			const iter = prefetchAsyncIterable(ctx, probeSource, 8)[Symbol.asyncIterator]();
			// The "build phase": wait until the probe has provably fetched, then mark the
			// build done. Ordering is guaranteed by eager-on-construction, not by a clock.
			await firstFetchSeen.promise;
			trace.push('build-complete');

			const out: Row[] = [];
			while (true) {
				const r = await iter.next();
				if (r.done) break;
				out.push(r.value);
			}

			expect(out).to.deep.equal([[0], [1], [2]]);
			// Headline assertion: the probe's first fetch was recorded before the build
			// completed — the overlap, proven by event ordering rather than wall-clock.
			expect(trace.indexOf('probe-first-fetch')).to.be.greaterThanOrEqual(0, 'probe must have fetched');
			expect(trace.indexOf('probe-first-fetch'))
				.to.be.lessThan(trace.indexOf('build-complete'),
					'probe first-fetch must occur before build-complete (build/probe overlap)');
		});
	});

	describe('back-pressure / bounded buffer', () => {
		it('producer pauses when buffer fills and advances exactly one per consume', async () => {
			const ctx = makeRuntimeContext();
			const bufferSize = 3;

			// Each pull records its index into `produced` and resolves a per-index
			// "pulled" deferred. The pump always pulls one more than what fits (buffer
			// + the in-flight row whose push blocks), so awaiting a specific pulled[i]
			// lets us observe the pump's exact progress deterministically — no sleeps.
			let produced = 0;
			const pulled: Array<Deferred<void>> = Array.from({ length: 32 }, () => makeDeferred());
			const source = (_inner: RuntimeContext): AsyncIterable<Row> => (async function* () {
				for (let i = 0; i < 1_000_000; i++) {
					produced++;
					if (i < pulled.length) pulled[i].resolve();
					yield [i] as Row;
				}
			})();

			const iter = prefetchAsyncIterable(ctx, source, bufferSize)[Symbol.asyncIterator]();

			// Deliver the first row to the consumer. The pump then fills the buffer
			// (bufferSize rows) plus pulls one more whose push blocks on the full buffer.
			const first = await iter.next();
			expect(first.done).to.equal(false);

			// Wait until the pump has pulled exactly the row that must block on push:
			// 1 delivered + bufferSize buffered + 1 in-flight = bufferSize + 2 pulls.
			// Indices are 0-based, so the blocking pull is index bufferSize + 1.
			await pulled[bufferSize + 1].promise;
			// Yield once more so the now-full push settles into its awaiting state.
			await Promise.resolve();
			expect(produced).to.equal(bufferSize + 2,
				`pump must pause after buffer fills: produced=${produced}, buffer=${bufferSize}`);

			// Consume one more row; this frees one buffer slot, so the pump advances by
			// exactly one pull — proven by the next pulled[] deferred resolving.
			const producedSnapshot = produced;
			await iter.next();
			await pulled[bufferSize + 2].promise;
			await Promise.resolve();
			expect(produced).to.be.greaterThan(producedSnapshot,
				'consuming a row must let the pump advance');
			expect(produced).to.equal(bufferSize + 3,
				`after one shift the pump advances by exactly one: produced=${produced}`);

			// Cleanup: cancel the infinite stream.
			await iter.return?.();
		});
	});

	describe('consumer break', () => {
		it("calls the child iterator's return() when the consumer breaks early", async () => {
			const ctx = makeRuntimeContext();
			let returnCalled = false;
			const source = (_inner: RuntimeContext): AsyncIterable<Row> => ({
				[Symbol.asyncIterator]() {
					let i = 0;
					return {
						async next(): Promise<IteratorResult<Row>> {
							if (i >= 10) return { done: true, value: undefined as unknown as Row };
							return { done: false, value: [i++] as Row };
						},
						async return(): Promise<IteratorResult<Row>> {
							returnCalled = true;
							return { done: true, value: undefined as unknown as Row };
						},
					};
				},
			});

			let count = 0;
			for await (const _r of prefetchAsyncIterable(ctx, source, 4)) {
				count++;
				if (count >= 2) break;
			}

			// Give the finally block a tick to run the cleanup.
			await sleep(20);
			expect(returnCalled).to.equal(true, "child iterator's return() must be called");
		});

		it('no unhandled rejection after consumer break', async () => {
			const unhandled: unknown[] = [];
			const handler = (reason: unknown) => unhandled.push(reason);
			process.on('unhandledRejection', handler);
			try {
				const ctx = makeRuntimeContext();
				const source = (_inner: RuntimeContext): AsyncIterable<Row> => (async function* () {
					for (let i = 0; i < 100; i++) {
						await sleep(1);
						yield [i] as Row;
					}
				})();

				let count = 0;
				for await (const _r of prefetchAsyncIterable(ctx, source, 4)) {
					count++;
					if (count >= 2) break;
				}
				await sleep(40);
				expect(unhandled).to.have.lengthOf(0, `got unhandled rejections: ${unhandled.map(String).join(', ')}`);
			} finally {
				process.off('unhandledRejection', handler);
			}
		});
	});

	describe('inner throw', () => {
		it('propagates the source error to the consumer with identity preserved', async () => {
			const ctx = makeRuntimeContext();
			const sourceError = new Error('boom at row 3');
			const source = (_inner: RuntimeContext): AsyncIterable<Row> => (async function* () {
				yield [0] as Row;
				yield [1] as Row;
				yield [2] as Row;
				throw sourceError;
			})();

			let caught: unknown = undefined;
			const seen: Row[] = [];
			try {
				for await (const r of prefetchAsyncIterable(ctx, source, 8)) {
					seen.push(r);
				}
			} catch (e) {
				caught = e;
			}
			expect(caught).to.equal(sourceError);
			// At minimum the consumer eventually sees the error; rows up through row 2
			// may or may not have been delivered before the throw propagates.
			expect(seen.length).to.be.at.most(3);
		});
	});

	describe('cancellation via consumer error path', () => {
		it("closes the child iterator when the consumer's body throws", async () => {
			const ctx = makeRuntimeContext();
			let returnCalled = false;
			const source = (_inner: RuntimeContext): AsyncIterable<Row> => ({
				[Symbol.asyncIterator]() {
					let i = 0;
					return {
						async next(): Promise<IteratorResult<Row>> {
							await sleep(2);
							if (i >= 50) return { done: true, value: undefined as unknown as Row };
							return { done: false, value: [i++] as Row };
						},
						async return(): Promise<IteratorResult<Row>> {
							returnCalled = true;
							return { done: true, value: undefined as unknown as Row };
						},
					};
				},
			});

			const consumerError = new Error('consumer aborted');
			let caught: unknown = undefined;
			try {
				for await (const _r of prefetchAsyncIterable(ctx, source, 4)) {
					throw consumerError;
				}
			} catch (e) {
				caught = e;
			}
			expect(caught).to.equal(consumerError);
			await sleep(20);
			expect(returnCalled).to.equal(true, "child iterator's return() must run after consumer throw");
		});
	});

	describe('strict-fork interaction', () => {
		const strictMode = process.env.QUEREUS_FORK_STRICT === '1' || process.env.QUEREUS_FORK_STRICT === 'true';

		it('throws when the parent mutates context while the prefetch is live', function () {
			if (!strictMode) {
				this.skip();
				return;
			}

			const ctx = makeStrictRuntimeContext();
			const source = (_inner: RuntimeContext): AsyncIterable<Row> => (async function* () {
				yield [0] as Row;
				await sleep(10);
				yield [1] as Row;
			})();

			const attrId = 1234;
			const descriptor: RowDescriptor = [];
			descriptor[attrId] = 0;

			return (async () => {
				let caught: unknown = undefined;
				try {
					for await (const _ of prefetchAsyncIterable(ctx, source, 4)) {
						// Mutate the parent's row context while the fork is live.
						createRowSlot(ctx, descriptor);
					}
				} catch (e) {
					caught = e;
				}
				expect(caught, 'parent mutation while prefetch is live must violate strict-fork').to.not.equal(undefined);
				expect(String((caught as Error)?.message ?? caught)).to.match(/strict-fork/i);
			})();
		});

		it('allows parent mutation after the prefetch finishes', function () {
			if (!strictMode) {
				this.skip();
				return;
			}

			const ctx = makeStrictRuntimeContext();
			const source = (_inner: RuntimeContext): AsyncIterable<Row> => (async function* () {
				yield [0] as Row;
			})();

			return (async () => {
				for await (const _ of prefetchAsyncIterable(ctx, source, 4)) { /* drain */ }
				// Parent activeForks should be 0 again.
				expect(() => {
					ctx.tableContexts.set({} as never, () => undefined as never);
				}).to.not.throw();
			})();
		});
	});

	describe('eager construction', () => {
		it('starts the source on construction even if the iterable is never iterated', async () => {
			const ctx = makeRuntimeContext();
			let started = false;
			const source = (_inner: RuntimeContext): AsyncIterable<Row> => (async function* () {
				started = true;
				yield [0] as Row;
			})();

			// EAGER contract (inverted from the old lazy behavior): building the
			// iterable starts the pump immediately, so the source runs without any
			// consumer demand. The pump fills the buffer then would block on
			// back-pressure, so we must close it to avoid a dangling fork.
			const iterable = prefetchAsyncIterable(ctx, source, 4);
			await sleep(15);
			expect(started).to.equal(true, 'source must start eagerly on construction');

			// Clean up the now-running pump.
			await iterable[Symbol.asyncIterator]().return?.(undefined);
		});
	});

	describe('BoundedPrefetchBuffer (internal helper)', () => {
		it('rejects non-positive capacity', () => {
			expect(() => new BoundedPrefetchBuffer<number>(0)).to.throw(RangeError);
			expect(() => new BoundedPrefetchBuffer<number>(-1)).to.throw(RangeError);
			expect(() => new BoundedPrefetchBuffer<number>(1.5)).to.throw(RangeError);
		});

		it('shift returns done after close on an empty buffer', async () => {
			const buf = new BoundedPrefetchBuffer<number>(2);
			buf.close();
			const r = await buf.shift();
			expect(r.done).to.equal(true);
		});

		it('shift drains queued items even after close', async () => {
			const buf = new BoundedPrefetchBuffer<number>(4);
			const ctl = new AbortController();
			await buf.push(1, ctl.signal);
			await buf.push(2, ctl.signal);
			buf.close();
			const a = await buf.shift();
			const b = await buf.shift();
			const c = await buf.shift();
			expect(a).to.deep.equal({ done: false, value: 1 });
			expect(b).to.deep.equal({ done: false, value: 2 });
			expect(c).to.deep.equal({ done: true });
		});

		it('shift throws on fail() with the cached error identity', async () => {
			const buf = new BoundedPrefetchBuffer<number>(2);
			const err = new Error('producer failure');
			buf.fail(err);
			let caught: unknown = undefined;
			try { await buf.shift(); } catch (e) { caught = e; }
			expect(caught).to.equal(err);
		});
	});
});
