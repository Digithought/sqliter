import { expect } from 'chai';
import { ParallelDriver } from '../../src/runtime/parallel-driver.js';
import { RowContextMap, createRowSlot } from '../../src/runtime/context-helpers.js';
import type { RuntimeContext } from '../../src/runtime/types.js';
import type { RowDescriptor } from '../../src/planner/nodes/plan-node.js';
import type { Row } from '../../src/common/types.js';
import {
	ConcurrencyTracker,
	controllableSource,
	type ControllableHooks,
	type Deferred,
} from '../util/controllable-source.js';

/**
 * Build a minimal RuntimeContext suitable for the primitive's own unit tests.
 * The fields downstream of `context` / `tableContexts` are intentionally stubs —
 * ParallelDriver only reads structural fields and forwards everything else.
 */
function makeRuntimeContext(): RuntimeContext {
	return {
		// `db` / `stmt` are unused by the primitive itself; cast through unknown.
		db: undefined as unknown as RuntimeContext['db'],
		stmt: undefined,
		params: {},
		context: new RowContextMap(),
		tableContexts: new Map(),
		enableMetrics: false,
	};
}

interface GatedSourceOptions {
	/** Number of rows to produce before completing. */
	rows: number;
	/** Per-yield gates; defaults to one auto-created gate per row. */
	gates?: ReadonlyArray<Deferred>;
	/** Shared concurrency tracker the branch reports into at each gate. */
	tracker?: ConcurrencyTracker;
	/** Row index (0-based) at which to throw instead of yielding. */
	throwAtRow?: number;
	/** Error to throw if `throwAtRow` triggers; default: a fresh Error. */
	throwError?: Error;
	/** Records iterator-lifecycle events for later assertion. */
	hooks?: ControllableHooks;
}

/**
 * Gate-driven source. Each row's emission blocks on a {@link Deferred} the test
 * resolves, so interleavings are deterministic rather than timer-driven. While
 * parked the branch counts as in-flight in the shared tracker, and `hooks` let
 * the test verify the iterator's `return()` ran on cancellation.
 */
function gatedSource(opts: GatedSourceOptions): {
	factory: (ctx: RuntimeContext) => AsyncIterable<Row>;
	gates: ReadonlyArray<Deferred>;
} {
	const handle = controllableSource({
		rows: Array.from({ length: opts.rows }, (_, i) => [i] as Row),
		gates: opts.gates,
		tracker: opts.tracker,
		throwAtRow: opts.throwAtRow,
		throwError: opts.throwError,
		hooks: opts.hooks,
	});
	return { factory: handle.factory, gates: handle.gates };
}

/** Collect all driven items into an array. */
async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of iter) out.push(item);
	return out;
}

describe('ParallelDriver', () => {
	describe('fork()', () => {
		it('produces n independent contexts', () => {
			const driver = new ParallelDriver();
			const parent = makeRuntimeContext();
			const forks = driver.fork(parent, 3);

			expect(forks).to.have.lengthOf(3);
			for (const fork of forks) {
				expect(fork).to.not.equal(parent);
				expect(fork.context).to.not.equal(parent.context);
				expect(fork.tableContexts).to.not.equal(parent.tableContexts);
			}
			// Sibling identities differ pairwise.
			expect(forks[0].context).to.not.equal(forks[1].context);
			expect(forks[0].tableContexts).to.not.equal(forks[1].tableContexts);
		});

		it('shares read-only fields by reference', () => {
			const driver = new ParallelDriver();
			const parent = makeRuntimeContext();
			parent.params = { 1: 42 };
			const forks = driver.fork(parent, 2);

			expect(forks[0].db).to.equal(parent.db);
			expect(forks[0].stmt).to.equal(parent.stmt);
			expect(forks[0].params).to.equal(parent.params);
			expect(forks[0].enableMetrics).to.equal(parent.enableMetrics);
		});

		it('writes via createRowSlot in one fork are invisible to siblings', () => {
			const driver = new ParallelDriver();
			const parent = makeRuntimeContext();
			const forks = driver.fork(parent, 2);

			const attrId = 100;
			const descriptor: RowDescriptor = [];
			descriptor[attrId] = 0;

			const slot0 = createRowSlot(forks[0], descriptor);
			const slot1 = createRowSlot(forks[1], descriptor);
			slot0.set(['A'] as unknown as Row);
			slot1.set(['B'] as unknown as Row);

			// Each fork's attribute index resolves to its own slot's row.
			const entry0 = forks[0].context.attributeIndex[attrId];
			const entry1 = forks[1].context.attributeIndex[attrId];
			expect(entry0).to.not.equal(undefined);
			expect(entry1).to.not.equal(undefined);
			expect(entry0!.rowGetter()).to.deep.equal(['A']);
			expect(entry1!.rowGetter()).to.deep.equal(['B']);

			slot0.close();
			slot1.close();
		});

		it('parent context.size is unchanged after fork lifecycle', () => {
			const driver = new ParallelDriver();
			const parent = makeRuntimeContext();
			const beforeSize = parent.context.size;
			const beforeTableSize = parent.tableContexts.size;

			const forks = driver.fork(parent, 3);

			const attrId = 200;
			const descriptor: RowDescriptor = [];
			descriptor[attrId] = 0;

			// Exercise the forks: set and close slots in each.
			const slots = forks.map(f => createRowSlot(f, descriptor));
			for (const s of slots) s.set(['x'] as unknown as Row);
			for (const s of slots) s.close();

			expect(parent.context.size).to.equal(beforeSize);
			expect(parent.tableContexts.size).to.equal(beforeTableSize);
		});

		it('rejects negative or non-integer n', () => {
			const driver = new ParallelDriver();
			const parent = makeRuntimeContext();
			expect(() => driver.fork(parent, -1)).to.throw(RangeError);
			expect(() => driver.fork(parent, 1.5)).to.throw(RangeError);
		});

		it('n = 0 returns an empty array', () => {
			const driver = new ParallelDriver();
			expect(driver.fork(makeRuntimeContext(), 0)).to.deep.equal([]);
		});

		it('preserves parent-seeded attributes in every fork, then isolates fork-local overrides', () => {
			// Seed the parent with a slot BEFORE forking — the snapshot loop must rebuild
			// the child's attributeIndex from this entry so a fork-local read sees it.
			const driver = new ParallelDriver();
			const parent = makeRuntimeContext();

			const outerAttrId = 300;
			const outerDescriptor: RowDescriptor = [];
			outerDescriptor[outerAttrId] = 0;
			const parentSlot = createRowSlot(parent, outerDescriptor);
			parentSlot.set(['outer'] as unknown as Row);

			const forks = driver.fork(parent, 2);

			// Every fork resolves the outer attribute via its own attributeIndex
			// (proves the snapshot re-driving rebuilt the index correctly).
			for (const fork of forks) {
				const entry = fork.context.attributeIndex[outerAttrId];
				expect(entry, 'fork must have outer attribute in its index').to.not.equal(undefined);
				expect(entry!.rowGetter()).to.deep.equal(['outer']);
			}

			// A fork-local override of the same descriptor must not affect siblings
			// or the parent (proves descriptor identity is preserved across the snapshot,
			// so `RowContextMap.set` updates the fork's *existing* entry rather than
			// adding a parallel one).
			const fork0Slot = createRowSlot(forks[0], outerDescriptor);
			fork0Slot.set(['fork0-override'] as unknown as Row);

			expect(forks[0].context.attributeIndex[outerAttrId]!.rowGetter()).to.deep.equal(['fork0-override']);
			expect(forks[1].context.attributeIndex[outerAttrId]!.rowGetter()).to.deep.equal(['outer']);
			expect(parent.context.attributeIndex[outerAttrId]!.rowGetter()).to.deep.equal(['outer']);

			// Fork-local close removes the override from the fork but parent retains its slot.
			fork0Slot.close();
			expect(forks[0].context.attributeIndex[outerAttrId]).to.equal(undefined);
			expect(parent.context.attributeIndex[outerAttrId]!.rowGetter()).to.deep.equal(['outer']);

			parentSlot.close();
		});
	});

	describe('drive() — concurrency', () => {
		it('runs branches in parallel by default (all N reach their gate at once)', async () => {
			const driver = new ParallelDriver();
			const parent = makeRuntimeContext();
			const n = 4;
			const forks = driver.fork(parent, n);

			const tracker = new ConcurrencyTracker();
			const sources = Array.from({ length: n }, () => gatedSource({ rows: 1, tracker }));
			const factories = sources.map(s => s.factory);

			// Begin driving; do not release any gate yet.
			const driven = driver.drive(factories, forks);
			const iter = driven[Symbol.asyncIterator]();
			const firstPull = iter.next();

			// Deterministic proof of parallelism: all N branches are parked at their
			// gate simultaneously — no wall-clock involved.
			await tracker.waitForInFlight(n);
			expect(tracker.inFlight).to.equal(n, 'all branches must be in-flight before any gate is released');
			expect(tracker.peak).to.equal(n, 'peak concurrency must reach N (true parallelism)');

			// Release every gate and drain.
			for (const s of sources) for (const g of s.gates) g.resolve();
			const items: Array<{ branch: number }> = [];
			let r = await firstPull;
			while (!r.done) {
				items.push(r.value);
				r = await iter.next();
			}

			expect(items).to.have.lengthOf(n);
			expect(items.map(i => i.branch).sort((a, b) => a - b)).to.deep.equal([0, 1, 2, 3]);
		});

		it('respects concurrency cap (peak in-flight never exceeds cap)', async () => {
			const driver = new ParallelDriver();
			const parent = makeRuntimeContext();
			const n = 4;
			const cap = 2;
			const forks = driver.fork(parent, n);

			const tracker = new ConcurrencyTracker();
			const sources = Array.from({ length: n }, () => gatedSource({ rows: 1, tracker }));
			const factories = sources.map(s => s.factory);

			const items: Array<{ branch: number }> = [];
			// Drive with a cap; release gates incrementally so the driver must start a
			// fresh branch only as an in-flight one finishes. The tracker proves the
			// cap was honoured the whole way through, deterministically.
			const driven = driver.drive(factories, forks, { concurrency: cap });
			const iter = driven[Symbol.asyncIterator]();
			let pending = iter.next();

			// Initial wave: exactly `cap` branches parked.
			await tracker.waitForInFlight(cap);
			expect(tracker.inFlight).to.equal(cap, 'initial wave must fill exactly the cap');

			for (let released = 0; released < n; released++) {
				// Release the lowest-indexed still-gated branch.
				sources[released].gates[0].resolve();
				const r = await pending;
				expect(r.done).to.equal(false);
				items.push(r.value);
				pending = iter.next();
			}
			const tail = await pending;
			expect(tail.done).to.equal(true);

			expect(items).to.have.lengthOf(n);
			expect(tracker.peak).to.be.at.most(cap, `peak in-flight must never exceed cap: ${tracker.peak}`);
			expect(items.map(i => i.branch).sort((a, b) => a - b)).to.deep.equal([0, 1, 2, 3]);
		});
	});

	describe('drive() — cancellation', () => {
		it('cancels remaining branches and rejects with the original error', async () => {
			const driver = new ParallelDriver();
			const parent = makeRuntimeContext();
			const n = 4;
			const forks = driver.fork(parent, n);

			const returns = [false, false, false, false];
			const sourceError = new Error('branch 1 boom');
			const tracker = new ConcurrencyTracker();

			// Branch 1 throws on its first gate; the siblings each park on their gate
			// and are never released — so when branch 1 errors, branches 0/2/3 are
			// provably still in-flight and must be return()-closed by the driver.
			const sources = [
				gatedSource({ rows: 1, tracker, hooks: { onReturn: () => { returns[0] = true; } } }),
				gatedSource({
					rows: 1, tracker, throwAtRow: 0, throwError: sourceError,
					hooks: { onReturn: () => { returns[1] = true; } },
				}),
				gatedSource({ rows: 1, tracker, hooks: { onReturn: () => { returns[2] = true; } } }),
				gatedSource({ rows: 1, tracker, hooks: { onReturn: () => { returns[3] = true; } } }),
			];
			const factories = sources.map(s => s.factory);

			const drivePromise = collect(driver.drive(factories, forks));

			// Wait until every branch is parked at its gate (deterministic), then fire
			// branch 1's gate so it throws while the siblings are still in-flight.
			await tracker.waitForInFlight(n);
			expect(tracker.peak).to.equal(n, 'all siblings must be in-flight when branch 1 errors');
			sources[1].gates[0].resolve();

			let caught: unknown = undefined;
			try {
				await drivePromise;
			} catch (e) {
				caught = e;
			}

			expect(caught).to.equal(sourceError);
			// Branch 1 threw — its iterator's finally still fires, so returns[1] is true.
			// The critical assertion is that branches 0/2/3 also got return()-closed.
			expect(returns[0]).to.equal(true, 'branch 0 should be return()-closed');
			expect(returns[2]).to.equal(true, 'branch 2 should be return()-closed');
			expect(returns[3]).to.equal(true, 'branch 3 should be return()-closed');
		});

		it('closes every active branch when the consumer breaks early', async () => {
			const driver = new ParallelDriver();
			const parent = makeRuntimeContext();
			const n = 3;
			const forks = driver.fork(parent, n);

			const returns = [false, false, false];
			const tracker = new ConcurrencyTracker();
			// Each branch has two rows but only the first gate is released, so every
			// branch is provably still mid-stream (a second row pending behind an
			// unreleased gate) when the consumer breaks — the driver must
			// return()-close all three live siblings.
			const sources = [0, 1, 2].map(i =>
				gatedSource({
					rows: 2, tracker,
					hooks: { onReturn: () => { returns[i] = true; } },
				}),
			);
			const factories = sources.map(s => s.factory);

			// Release each branch's first-row gate so they can each emit one row; the
			// second row stays gated, guaranteeing none can complete on its own.
			for (const s of sources) s.gates[0].resolve();

			let count = 0;
			for await (const _item of driver.drive(factories, forks)) {
				count++;
				if (count >= 2) break;
			}

			// After break, every active branch should have been return()-closed.
			expect(returns[0]).to.equal(true);
			expect(returns[1]).to.equal(true);
			expect(returns[2]).to.equal(true);
		});

		it('drains an in-flight next() before considering a source closed (hand-rolled AsyncIterator)', async () => {
			// A hand-rolled AsyncIterator — deliberately NOT a native generator, so it
			// makes none of the guarantees native generators do (it does not queue a
			// return() behind an in-flight next()). Its next() parks until the test
			// releases it, and it records both the return() count and whether return()
			// arrived while its next() was still outstanding.
			function makeTrackingSource() {
				let releaseNext: (() => void) | null = null;
				const state = {
					nextCalls: 0,
					nextOutstanding: false,
					returnCalls: 0,
					returnedWhileNextOutstanding: false,
				};
				const iterator: AsyncIterator<Row> = {
					next(): Promise<IteratorResult<Row>> {
						state.nextCalls++;
						state.nextOutstanding = true;
						return new Promise<IteratorResult<Row>>((resolve) => {
							releaseNext = () => {
								state.nextOutstanding = false;
								resolve({ done: true, value: undefined as never });
							};
						});
					},
					return(): Promise<IteratorResult<Row>> {
						state.returnCalls++;
						if (state.nextOutstanding) state.returnedWhileNextOutstanding = true;
						return Promise.resolve({ done: true, value: undefined as never });
					},
				};
				return {
					factory: (_ctx: RuntimeContext): AsyncIterable<Row> => ({
						[Symbol.asyncIterator]: () => iterator,
					}),
					state,
					releaseNext: (): void => { releaseNext?.(); },
				};
			}

			const driver = new ParallelDriver();
			const parent = makeRuntimeContext();
			const forks = driver.fork(parent, 2);

			// Branch 0 emits exactly one row so the consumer has an item to break on.
			const emitter = gatedSource({ rows: 1 });
			emitter.gates[0].resolve();
			// Branch 1 is the hand-rolled source whose next() stays parked.
			const tracked = makeTrackingSource();

			const driven = driver.drive([emitter.factory, tracked.factory], forks);
			const iter = driven[Symbol.asyncIterator]();

			const first = await iter.next();
			expect(first.done).to.equal(false, 'branch 0 emits its row');
			expect(tracked.state.nextCalls).to.equal(1, 'branch 1 was pulled');
			expect(tracked.state.nextOutstanding).to.equal(true, 'branch 1 next() is parked');

			// Consumer breaks → generator.return() → closeAll on the live branches.
			const closePromise = iter.return!();

			// closeAll must NOT resolve while branch 1's next() is still in flight — it
			// has to await the outstanding pull, not discard it. (Under the old code,
			// which awaited only the return()s and dropped the pending pulls, this
			// promise would already be settled here.)
			let closed = false;
			void closePromise.then(() => { closed = true; });
			await Promise.resolve();
			await Promise.resolve();
			expect(closed).to.equal(false, 'close must wait for the in-flight next() to settle');
			expect(tracked.state.returnCalls).to.equal(1, 'return() signalled wind-down promptly');

			// Release the parked next(); only now may close complete.
			tracked.releaseNext();
			await closePromise;

			expect(tracked.state.nextOutstanding).to.equal(false, 'in-flight next() drained before close resolved');
			expect(tracked.state.returnCalls).to.equal(1, 'return() called exactly once');
		});

		it('pre-aborted signal rejects without invoking any factory', async () => {
			const driver = new ParallelDriver();
			const parent = makeRuntimeContext();
			const forks = driver.fork(parent, 3);

			let started = 0;
			const factories = [0, 1, 2].map(() =>
				gatedSource({
					rows: 1,
					hooks: { onStart: () => { started++; } },
				}).factory,
			);

			const controller = new AbortController();
			controller.abort();

			let caught: unknown = undefined;
			try {
				await collect(driver.drive(factories, forks, { signal: controller.signal }));
			} catch (e) {
				caught = e;
			}

			expect(caught).to.not.equal(undefined, 'drive() must reject');
			expect(started).to.equal(0, 'no factory should have been invoked');
		});
	});
});
