import { expect } from 'chai';
import {
	runFanOutLookupJoin,
	runFanOutLookupJoinBatched,
	type FanOutLookupBranchDescriptor,
	type FanOutLookupBranchFactory,
} from '../../src/runtime/emit/fanout-lookup-join.js';
import { RowContextMap, resolveAttribute } from '../../src/runtime/context-helpers.js';
import { createStrictRowContextMap, wrapTableContextsStrict } from '../../src/runtime/strict-fork.js';
import type { RuntimeContext } from '../../src/runtime/types.js';
import type { Row } from '../../src/common/types.js';
import type { RowDescriptor } from '../../src/planner/nodes/plan-node.js';
import { ConcurrencyTracker, makeDeferred, type Deferred } from '../util/controllable-source.js';

function makeRuntimeContext(activeConnection?: object): RuntimeContext {
	const ctx: RuntimeContext = {
		db: undefined as unknown as RuntimeContext['db'],
		stmt: undefined,
		params: {},
		context: new RowContextMap(),
		tableContexts: new Map(),
		enableMetrics: false,
	};
	if (activeConnection !== undefined) {
		(ctx as { activeConnection?: unknown }).activeConnection = activeConnection;
	}
	return ctx;
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

/** Construct an outer source from an array of rows. */
function arrayOuter(rows: Row[]): AsyncIterable<Row> {
	return (async function* () {
		for (const r of rows) yield r;
	})();
}

/** Outer descriptor with one attribute slot (attrId = 1, column 0). */
function singleOuterDescriptor(): RowDescriptor {
	const desc: RowDescriptor = [];
	desc[1] = 0;
	return desc;
}

/**
 * A branch factory that parks on `gate` (counted in `tracker`) before yielding a
 * single `['done']` row. Releasing the gate lets it proceed; holding all gates
 * lets a test assert how many branches are simultaneously in-flight, replacing
 * wall-clock latency with a deterministic concurrency proof.
 */
function gatedBranch(tracker: ConcurrencyTracker, gate: Deferred): FanOutLookupBranchFactory {
	return () => (async function* () {
		tracker.enter();
		try {
			await gate.promise;
		} finally {
			tracker.exit();
		}
		yield ['done'] as Row;
	})();
}

const STRICT = process.env.QUEREUS_FORK_STRICT === '1' || process.env.QUEREUS_FORK_STRICT === 'true';

describe('FanOutLookupJoin', () => {
	describe('atMostOne-left, all branches match', () => {
		it('composes outer + branch rows in order', async () => {
			const ctx = makeRuntimeContext();
			const outerRows: Row[] = [[1, 'a'], [2, 'b']];
			const branch0Factory: FanOutLookupBranchFactory = () => (async function* () { yield [10, 'x'] as Row; })();
			const branch1Factory: FanOutLookupBranchFactory = () => (async function* () { yield [20] as Row; })();
			const descriptors: FanOutLookupBranchDescriptor[] = [
				{ mode: 'atMostOne-left', outputColCount: 2, concurrencySafe: true },
				{ mode: 'atMostOne-left', outputColCount: 1, concurrencySafe: true },
			];

			const out = await collect(runFanOutLookupJoin(
				ctx, arrayOuter(outerRows), singleOuterDescriptor(),
				[branch0Factory, branch1Factory], descriptors, 4,
			));
			expect(out).to.deep.equal([
				[1, 'a', 10, 'x', 20],
				[2, 'b', 10, 'x', 20],
			]);
		});
	});

	describe('atMostOne-left, some branches empty', () => {
		it('NULL-pads zero-row branches', async () => {
			const ctx = makeRuntimeContext();
			const outerRows: Row[] = [[1]];
			const branchHit: FanOutLookupBranchFactory = () => (async function* () { yield ['hit', 42] as Row; })();
			const branchMiss: FanOutLookupBranchFactory = () => (async function* () { /* empty */ })();
			const descriptors: FanOutLookupBranchDescriptor[] = [
				{ mode: 'atMostOne-left', outputColCount: 2, concurrencySafe: true },
				{ mode: 'atMostOne-left', outputColCount: 3, concurrencySafe: true },
			];

			const out = await collect(runFanOutLookupJoin(
				ctx, arrayOuter(outerRows), singleOuterDescriptor(),
				[branchHit, branchMiss], descriptors, 2,
			));
			expect(out).to.deep.equal([
				[1, 'hit', 42, null, null, null],
			]);
		});
	});

	describe('atMostOne-inner, branch empty', () => {
		it('drops the outer row', async () => {
			const ctx = makeRuntimeContext();
			const outerRows: Row[] = [[1], [2], [3]];
			const branchAlways: FanOutLookupBranchFactory = () => (async function* () { yield ['ok'] as Row; })();
			// Inner branch only matches outer row 2.
			const branchInner: FanOutLookupBranchFactory = (innerCtx) => (async function* () {
				const v = resolveAttribute(innerCtx, 1);
				if (v === 2) yield ['hit'] as Row;
			})();

			const descriptors: FanOutLookupBranchDescriptor[] = [
				{ mode: 'atMostOne-left', outputColCount: 1, concurrencySafe: true },
				{ mode: 'atMostOne-inner', outputColCount: 1, concurrencySafe: true },
			];

			const out = await collect(runFanOutLookupJoin(
				ctx, arrayOuter(outerRows), singleOuterDescriptor(),
				[branchAlways, branchInner], descriptors, 2,
			));
			expect(out).to.deep.equal([
				[2, 'ok', 'hit'],
			]);
		});
	});

	describe('atMostOne violation', () => {
		it('throws QuereusError(CONSTRAINT) when a branch yields more than one row', async () => {
			const ctx = makeRuntimeContext();
			const outerRows: Row[] = [[1]];
			const branchBad: FanOutLookupBranchFactory = () => (async function* () {
				yield ['r1'] as Row;
				yield ['r2'] as Row;
			})();
			const descriptors: FanOutLookupBranchDescriptor[] = [
				{ mode: 'atMostOne-left', outputColCount: 1, concurrencySafe: true },
			];

			let caught: unknown = undefined;
			try {
				await collect(runFanOutLookupJoin(
					ctx, arrayOuter(outerRows), singleOuterDescriptor(),
					[branchBad], descriptors, 1,
				));
			} catch (e) {
				caught = e;
			}
			expect(caught).to.exist;
			expect(String((caught as Error)?.message ?? caught))
				.to.match(/FanOutLookupJoin: branch 0 produced more than one row/);
			// StatusCode.CONSTRAINT
			expect((caught as { code?: number }).code).to.equal(19);
		});
	});

	describe('concurrency', () => {
		it('runs N branches in parallel within concurrencyCap (peak in-flight reaches N)', async () => {
			const ctx = makeRuntimeContext();
			const n = 3;
			const tracker = new ConcurrencyTracker();
			const gates = Array.from({ length: n }, () => makeDeferred());
			const factories: FanOutLookupBranchFactory[] = gates.map(g => gatedBranch(tracker, g));
			const descriptors: FanOutLookupBranchDescriptor[] = factories.map(() => ({
				mode: 'atMostOne-left' as const, outputColCount: 1, concurrencySafe: true,
			}));

			const done = collect(runFanOutLookupJoin(
				ctx, arrayOuter([[1]]), singleOuterDescriptor(),
				factories, descriptors, n,
			));
			// All N branches park at their gate simultaneously → true parallelism.
			await tracker.waitForInFlight(n);
			expect(tracker.peak).to.equal(n, 'cap=N must run all branches concurrently');
			for (const g of gates) g.resolve();

			const out = await done;
			expect(out).to.deep.equal([[1, 'done', 'done', 'done']]);
		});

		it('respects concurrencyCap when cap < N (peak in-flight never exceeds cap)', async () => {
			const ctx = makeRuntimeContext();
			const n = 4;
			const cap = 2;
			const tracker = new ConcurrencyTracker();
			const gates = Array.from({ length: n }, () => makeDeferred());
			const factories: FanOutLookupBranchFactory[] = gates.map(g => gatedBranch(tracker, g));
			const descriptors: FanOutLookupBranchDescriptor[] = factories.map(() => ({
				mode: 'atMostOne-left' as const, outputColCount: 1, concurrencySafe: true,
			}));

			const done = collect(runFanOutLookupJoin(
				ctx, arrayOuter([[1]]), singleOuterDescriptor(),
				factories, descriptors, cap,
			));
			// Initial wave fills exactly the cap; pre-release all gates so the driver
			// runs the remaining branches in later waves, never exceeding the cap.
			await tracker.waitForInFlight(cap);
			expect(tracker.inFlight).to.equal(cap, 'initial wave fills exactly the cap');
			for (const g of gates) g.resolve();

			const out = await done;
			expect(out).to.deep.equal([[1, 'done', 'done', 'done', 'done']]);
			expect(tracker.peak).to.be.at.most(cap, `peak in-flight must respect cap: ${tracker.peak}`);
			expect(tracker.peak).to.be.greaterThan(1, 'expected real concurrency under the cap');
		});
	});

	describe('vtab lock fan-in', () => {
		it('serial-mode branches sharing a connection observe ≤1 concurrent runner', async () => {
			const ctx = makeRuntimeContext();
			const sharedConn = { connectionId: 'shared' };
			let inFlight = 0;
			let maxInFlight = 0;
			const makeBranch: () => FanOutLookupBranchFactory = () => () => (async function* () {
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				try {
					await sleep(20);
					yield ['done'] as Row;
				} finally {
					inFlight--;
				}
			})();
			const factories: FanOutLookupBranchFactory[] = [makeBranch(), makeBranch()];
			const descriptors: FanOutLookupBranchDescriptor[] = factories.map(() => ({
				mode: 'atMostOne-left' as const,
				outputColCount: 1,
				concurrencySafe: false,
				connectionKey: sharedConn,
			}));

			await collect(runFanOutLookupJoin(
				ctx, arrayOuter([[1]]), singleOuterDescriptor(),
				factories, descriptors, 2,
			));
			expect(maxInFlight).to.equal(1, `lock did not serialize: maxInFlight=${maxInFlight}`);
		});

		it('reentrant-reads branches sharing a connection observe parallelism', async () => {
			const ctx = makeRuntimeContext();
			const sharedConn = { connectionId: 'reentrant' };
			let inFlight = 0;
			let maxInFlight = 0;
			const makeBranch: () => FanOutLookupBranchFactory = () => () => (async function* () {
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				try {
					await sleep(20);
					yield ['done'] as Row;
				} finally {
					inFlight--;
				}
			})();
			const factories: FanOutLookupBranchFactory[] = [makeBranch(), makeBranch()];
			const descriptors: FanOutLookupBranchDescriptor[] = factories.map(() => ({
				mode: 'atMostOne-left' as const,
				outputColCount: 1,
				concurrencySafe: true,
				connectionKey: sharedConn,
			}));

			await collect(runFanOutLookupJoin(
				ctx, arrayOuter([[1]]), singleOuterDescriptor(),
				factories, descriptors, 2,
			));
			expect(maxInFlight).to.equal(2, `expected concurrent run, maxInFlight=${maxInFlight}`);
		});

		it('distinct connections do not contend even at serial mode', async () => {
			const ctx = makeRuntimeContext();
			const connA = { connectionId: 'a' };
			const connB = { connectionId: 'b' };
			let inFlight = 0;
			let maxInFlight = 0;
			const makeBranch: () => FanOutLookupBranchFactory = () => () => (async function* () {
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				try {
					await sleep(20);
					yield ['done'] as Row;
				} finally {
					inFlight--;
				}
			})();
			const factories: FanOutLookupBranchFactory[] = [makeBranch(), makeBranch()];
			const descriptors: FanOutLookupBranchDescriptor[] = [
				{ mode: 'atMostOne-left', outputColCount: 1, concurrencySafe: false, connectionKey: connA },
				{ mode: 'atMostOne-left', outputColCount: 1, concurrencySafe: false, connectionKey: connB },
			];

			await collect(runFanOutLookupJoin(
				ctx, arrayOuter([[1]]), singleOuterDescriptor(),
				factories, descriptors, 2,
			));
			expect(maxInFlight).to.equal(2, `distinct connections should not contend; maxInFlight=${maxInFlight}`);
		});
	});

	describe('outer-row binding propagation', () => {
		it('each branch sees the correct outer row value across iterations', async () => {
			const ctx = makeRuntimeContext();
			const observed: Array<{ outer: unknown; branch: number }> = [];
			const makeObserver = (branchIdx: number): FanOutLookupBranchFactory => (innerCtx) =>
				(async function* () {
					const v = resolveAttribute(innerCtx, 1);
					observed.push({ outer: v, branch: branchIdx });
					yield [`b${branchIdx}-saw-${String(v)}`] as Row;
				})();
			const factories = [makeObserver(0), makeObserver(1)];
			const descriptors: FanOutLookupBranchDescriptor[] = factories.map(() => ({
				mode: 'atMostOne-left' as const, outputColCount: 1, concurrencySafe: true,
			}));

			const out = await collect(runFanOutLookupJoin(
				ctx, arrayOuter([[10], [20], [30]]), singleOuterDescriptor(),
				factories, descriptors, 2,
			));
			expect(out).to.deep.equal([
				[10, 'b0-saw-10', 'b1-saw-10'],
				[20, 'b0-saw-20', 'b1-saw-20'],
				[30, 'b0-saw-30', 'b1-saw-30'],
			]);
			// Each branch ran exactly 3 times.
			expect(observed.filter(o => o.branch === 0)).to.have.length(3);
			expect(observed.filter(o => o.branch === 1)).to.have.length(3);
		});
	});

	describe('consumer break', () => {
		it('cleans up cleanly when the consumer breaks after one row', async () => {
			const ctx = makeRuntimeContext();
			const branchFactory: FanOutLookupBranchFactory = () => (async function* () {
				yield ['ok'] as Row;
			})();
			const factories = [branchFactory, branchFactory];
			const descriptors: FanOutLookupBranchDescriptor[] = factories.map(() => ({
				mode: 'atMostOne-left' as const, outputColCount: 1, concurrencySafe: true,
			}));

			const unhandled: unknown[] = [];
			const handler = (reason: unknown) => unhandled.push(reason);
			process.on('unhandledRejection', handler);
			try {
				let count = 0;
				for await (const _r of runFanOutLookupJoin(
					ctx, arrayOuter([[1], [2], [3]]), singleOuterDescriptor(),
					factories, descriptors, 2,
				)) {
					count++;
					if (count >= 1) break;
				}
				expect(count).to.equal(1);
				await sleep(20);
				expect(unhandled).to.have.lengthOf(0);
			} finally {
				process.off('unhandledRejection', handler);
			}
		});
	});

	describe('strict-fork interaction', () => {
		it('throws when the parent mutates context while branches are live', function () {
			if (!STRICT) {
				this.skip();
				return;
			}
			const ctx = makeStrictRuntimeContext();
			let resolveBranch!: () => void;
			const branchSignal = new Promise<void>(r => { resolveBranch = r; });
			const branchFactory: FanOutLookupBranchFactory = () => (async function* () {
				await branchSignal;
				yield ['ok'] as Row;
			})();
			const factories = [branchFactory, branchFactory];
			const descriptors: FanOutLookupBranchDescriptor[] = factories.map(() => ({
				mode: 'atMostOne-left' as const, outputColCount: 1, concurrencySafe: true,
			}));

			return (async () => {
				const iter = runFanOutLookupJoin(
					ctx, arrayOuter([[1]]), singleOuterDescriptor(),
					factories, descriptors, 2,
				)[Symbol.asyncIterator]();
				// Kick the first pull so forks become active inside driver.drive.
				const firstPromise = iter.next();
				await sleep(15);
				let caught: unknown = undefined;
				try {
					ctx.tableContexts.set({} as never, () => undefined as never);
				} catch (e) {
					caught = e;
				}
				resolveBranch();
				await firstPromise;
				expect(caught, 'parent mutation while branches live must violate strict-fork').to.not.equal(undefined);
				expect(String((caught as Error)?.message ?? caught)).to.match(/strict-fork/i);
			})();
		});

		it('allows parent mutation after the fan-out finishes', function () {
			if (!STRICT) {
				this.skip();
				return;
			}
			const ctx = makeStrictRuntimeContext();
			const branchFactory: FanOutLookupBranchFactory = () => (async function* () {
				yield ['ok'] as Row;
			})();
			const descriptors: FanOutLookupBranchDescriptor[] = [
				{ mode: 'atMostOne-left', outputColCount: 1, concurrencySafe: true },
			];

			return (async () => {
				for await (const _ of runFanOutLookupJoin(
					ctx, arrayOuter([[1]]), singleOuterDescriptor(),
					[branchFactory], descriptors, 1,
				)) { /* drain */ }
				expect(() => {
					ctx.tableContexts.set({} as never, () => undefined as never);
				}).to.not.throw();
			})();
		});
	});

	describe('empty outer source', () => {
		it('yields no rows and never forks branches when outer is empty', async () => {
			const ctx = makeRuntimeContext();
			let branchInvocations = 0;
			const branch: FanOutLookupBranchFactory = () => {
				branchInvocations++;
				return (async function* () { yield ['x'] as Row; })();
			};
			const descriptors: FanOutLookupBranchDescriptor[] = [
				{ mode: 'atMostOne-left', outputColCount: 1, concurrencySafe: true },
			];

			const out = await collect(runFanOutLookupJoin(
				ctx, arrayOuter([]), singleOuterDescriptor(),
				[branch], descriptors, 1,
			));
			expect(out).to.deep.equal([]);
			expect(branchInvocations).to.equal(0);
			// Slot must have been closed in the finally — context size returns to 0.
			expect(ctx.context.size).to.equal(0);
		});
	});

	describe('branch error propagation', () => {
		it('propagates a branch throw and closes sibling iterators', async () => {
			const ctx = makeRuntimeContext();
			let siblingClosed = false;
			const branchThrow: FanOutLookupBranchFactory = () => (async function* () {
				// require-yield: emit then throw on the iterator's first pull.
				yield Promise.reject(new Error('branch boom')) as unknown as Row;
			})();
			const branchSlow: FanOutLookupBranchFactory = () => (async function* () {
				try {
					await sleep(50);
					yield ['done'] as Row;
				} finally {
					siblingClosed = true;
				}
			})();
			const descriptors: FanOutLookupBranchDescriptor[] = [
				{ mode: 'atMostOne-left', outputColCount: 1, concurrencySafe: true },
				{ mode: 'atMostOne-left', outputColCount: 1, concurrencySafe: true },
			];

			let caught: unknown = undefined;
			try {
				await collect(runFanOutLookupJoin(
					ctx, arrayOuter([[1]]), singleOuterDescriptor(),
					[branchThrow, branchSlow], descriptors, 2,
				));
			} catch (e) {
				caught = e;
			}
			expect(String((caught as Error)?.message ?? caught)).to.equal('branch boom');
			expect(siblingClosed, 'sibling branch iterator must be closed via finally').to.equal(true);
			// Outer slot closed even on error path.
			expect(ctx.context.size).to.equal(0);
		});
	});

	describe('input validation', () => {
		it('rejects mismatched factories/descriptors length', async () => {
			const ctx = makeRuntimeContext();
			let caught: unknown = undefined;
			try {
				await collect(runFanOutLookupJoin(
					ctx, arrayOuter([[1]]), singleOuterDescriptor(),
					[() => (async function* () { /* */ })()],
					[],
					1,
				));
			} catch (e) {
				caught = e;
			}
			expect(caught).to.be.instanceOf(RangeError);
		});

		it('rejects non-positive concurrencyCap', async () => {
			const ctx = makeRuntimeContext();
			let caught: unknown = undefined;
			try {
				await collect(runFanOutLookupJoin(
					ctx, arrayOuter([[1]]), singleOuterDescriptor(),
					[], [], 0,
				));
			} catch (e) {
				caught = e;
			}
			expect(caught).to.be.instanceOf(RangeError);
		});
	});

	describe('cross mode', () => {
		const cross = (outputColCount = 1): FanOutLookupBranchDescriptor =>
			({ mode: 'cross', outputColCount, concurrencySafe: true });

		it('a single cross branch yields one output row per branch row', async () => {
			const ctx = makeRuntimeContext();
			const branch: FanOutLookupBranchFactory = () => (async function* () {
				yield ['a'] as Row; yield ['b'] as Row; yield ['c'] as Row;
			})();
			const out = await collect(runFanOutLookupJoin(
				ctx, arrayOuter([[1], [2]]), singleOuterDescriptor(),
				[branch], [cross()], 4,
			));
			expect(out).to.deep.equal([
				[1, 'a'], [1, 'b'], [1, 'c'],
				[2, 'a'], [2, 'b'], [2, 'c'],
			]);
		});

		it('two cross branches emit the Cartesian product (outer, b0, b1)', async () => {
			const ctx = makeRuntimeContext();
			const b0: FanOutLookupBranchFactory = () => (async function* () {
				yield ['a'] as Row; yield ['b'] as Row; yield ['c'] as Row;
			})();
			const b1: FanOutLookupBranchFactory = () => (async function* () {
				yield ['x'] as Row; yield ['y'] as Row;
			})();
			const out = await collect(runFanOutLookupJoin(
				ctx, arrayOuter([[1]]), singleOuterDescriptor(),
				[b0, b1], [cross(), cross()], 4,
			));
			// b0 is the outer loop, b1 the inner — matches the nested-loop chain.
			expect(out).to.deep.equal([
				[1, 'a', 'x'], [1, 'a', 'y'],
				[1, 'b', 'x'], [1, 'b', 'y'],
				[1, 'c', 'x'], [1, 'c', 'y'],
			]);
		});

		it('an empty cross branch drops the outer row (inner-drop)', async () => {
			const ctx = makeRuntimeContext();
			const branchAlways: FanOutLookupBranchFactory = () => (async function* () {
				yield ['p'] as Row; yield ['q'] as Row;
			})();
			// Cross branch only matches outer row 2.
			const branchCross: FanOutLookupBranchFactory = (innerCtx) => (async function* () {
				if ((resolveAttribute(innerCtx, 1) as number) === 2) {
					yield ['hit1'] as Row; yield ['hit2'] as Row;
				}
			})();
			const out = await collect(runFanOutLookupJoin(
				ctx, arrayOuter([[1], [2], [3]]), singleOuterDescriptor(),
				[branchAlways, branchCross], [cross(), cross()], 4,
			));
			expect(out).to.deep.equal([
				[2, 'p', 'hit1'], [2, 'p', 'hit2'],
				[2, 'q', 'hit1'], [2, 'q', 'hit2'],
			]);
		});

		it('mixes a missed atMostOne-left (NULL pad) with a cross product', async () => {
			const ctx = makeRuntimeContext();
			const branchMiss: FanOutLookupBranchFactory = () => (async function* () { /* empty */ })();
			const branchCross: FanOutLookupBranchFactory = () => (async function* () {
				yield ['x'] as Row; yield ['y'] as Row;
			})();
			const descriptors: FanOutLookupBranchDescriptor[] = [
				{ mode: 'atMostOne-left', outputColCount: 2, concurrencySafe: true },
				cross(1),
			];
			const out = await collect(runFanOutLookupJoin(
				ctx, arrayOuter([[1]]), singleOuterDescriptor(),
				[branchMiss, branchCross], descriptors, 4,
			));
			// NULL-pad factor (1 entry) × cross factor (2 entries) → 2 rows.
			expect(out).to.deep.equal([
				[1, null, null, 'x'],
				[1, null, null, 'y'],
			]);
		});

		it('a cross branch yielding >1 row does not throw', async () => {
			const ctx = makeRuntimeContext();
			const branch: FanOutLookupBranchFactory = () => (async function* () {
				yield ['r1'] as Row; yield ['r2'] as Row; yield ['r3'] as Row;
			})();
			const out = await collect(runFanOutLookupJoin(
				ctx, arrayOuter([[1]]), singleOuterDescriptor(),
				[branch], [cross()], 1,
			));
			expect(out).to.deep.equal([[1, 'r1'], [1, 'r2'], [1, 'r3']]);
		});

		it('drives multiple cross branches concurrently within the cap (peak in-flight reaches N)', async () => {
			const ctx = makeRuntimeContext();
			const n = 3;
			const tracker = new ConcurrencyTracker();
			const gates = Array.from({ length: n }, () => makeDeferred());
			const factories: FanOutLookupBranchFactory[] = gates.map(g => gatedBranch(tracker, g));
			const descriptors: FanOutLookupBranchDescriptor[] = factories.map(() => cross());

			const done = collect(runFanOutLookupJoin(
				ctx, arrayOuter([[1]]), singleOuterDescriptor(),
				factories, descriptors, n,
			));
			await tracker.waitForInFlight(n);
			expect(tracker.peak).to.equal(n, 'cap=N must drive all cross branches concurrently');
			for (const g of gates) g.resolve();

			const out = await done;
			expect(out).to.deep.equal([[1, 'done', 'done', 'done']]);
		});
	});

	describe('cross-left mode', () => {
		const crossLeft = (outputColCount = 1): FanOutLookupBranchDescriptor =>
			({ mode: 'cross-left', outputColCount, concurrencySafe: true });

		it('a non-empty cross-left branch behaves like cross (1:n product)', async () => {
			const ctx = makeRuntimeContext();
			const branch: FanOutLookupBranchFactory = () => (async function* () {
				yield ['a'] as Row; yield ['b'] as Row;
			})();
			const out = await collect(runFanOutLookupJoin(
				ctx, arrayOuter([[1], [2]]), singleOuterDescriptor(),
				[branch], [crossLeft()], 4,
			));
			expect(out).to.deep.equal([
				[1, 'a'], [1, 'b'],
				[2, 'a'], [2, 'b'],
			]);
		});

		it('an empty cross-left branch NULL-pads and preserves the outer row', async () => {
			const ctx = makeRuntimeContext();
			// Branch matches only outer row 2; rows 1 and 3 are preserved with NULLs.
			const branch: FanOutLookupBranchFactory = (innerCtx) => (async function* () {
				if ((resolveAttribute(innerCtx, 1) as number) === 2) {
					yield ['hit1'] as Row; yield ['hit2'] as Row;
				}
			})();
			const out = await collect(runFanOutLookupJoin(
				ctx, arrayOuter([[1], [2], [3]]), singleOuterDescriptor(),
				[branch], [crossLeft(1)], 4,
			));
			expect(out).to.deep.equal([
				[1, null],
				[2, 'hit1'], [2, 'hit2'],
				[3, null],
			]);
		});

		it('NULL-pads using the branch outputColCount width', async () => {
			const ctx = makeRuntimeContext();
			const branchMiss: FanOutLookupBranchFactory = () => (async function* () { /* empty */ })();
			const out = await collect(runFanOutLookupJoin(
				ctx, arrayOuter([[1]]), singleOuterDescriptor(),
				[branchMiss], [crossLeft(3)], 4,
			));
			expect(out).to.deep.equal([[1, null, null, null]]);
		});

		it('mixes a non-empty cross with an empty cross-left (cross product × NULL pad)', async () => {
			const ctx = makeRuntimeContext();
			const branchCross: FanOutLookupBranchFactory = () => (async function* () {
				yield ['x'] as Row; yield ['y'] as Row;
			})();
			const branchLeftMiss: FanOutLookupBranchFactory = () => (async function* () { /* empty */ })();
			const descriptors: FanOutLookupBranchDescriptor[] = [
				{ mode: 'cross', outputColCount: 1, concurrencySafe: true },
				crossLeft(2),
			];
			const out = await collect(runFanOutLookupJoin(
				ctx, arrayOuter([[1]]), singleOuterDescriptor(),
				[branchCross, branchLeftMiss], descriptors, 4,
			));
			// cross factor (2 entries) × cross-left NULL-pad factor (1 entry) → 2 rows.
			expect(out).to.deep.equal([
				[1, 'x', null, null],
				[1, 'y', null, null],
			]);
		});

		it('an empty cross (inner) branch still drops the outer row even with a cross-left sibling', async () => {
			const ctx = makeRuntimeContext();
			const branchCrossMiss: FanOutLookupBranchFactory = () => (async function* () { /* empty */ })();
			const branchLeft: FanOutLookupBranchFactory = () => (async function* () {
				yield ['z'] as Row;
			})();
			const descriptors: FanOutLookupBranchDescriptor[] = [
				{ mode: 'cross', outputColCount: 1, concurrencySafe: true },
				crossLeft(1),
			];
			const out = await collect(runFanOutLookupJoin(
				ctx, arrayOuter([[1]]), singleOuterDescriptor(),
				[branchCrossMiss, branchLeft], descriptors, 4,
			));
			// The inner `cross` branch is empty ⇒ inner-drop collapses the whole row.
			expect(out).to.deep.equal([]);
		});
	});
});

// ---------------------------------------------------------------------------
// Batched outer mode (runFanOutLookupJoinBatched)
// ---------------------------------------------------------------------------

describe('FanOutLookupJoin batched outer', () => {
	const left = (outputColCount = 1): FanOutLookupBranchDescriptor =>
		({ mode: 'atMostOne-left', outputColCount, concurrencySafe: true });

	it('preserves outer order under out-of-order completion', async () => {
		const ctx = makeRuntimeContext();
		// Row 0 slowest, row 2 fastest — reverse completion order.
		const branchFactory: FanOutLookupBranchFactory = (innerCtx) => (async function* () {
			const seq = resolveAttribute(innerCtx, 1) as number;
			await sleep(30 - seq * 10);
			yield [`v${seq}`] as Row;
		})();
		const out = await collect(runFanOutLookupJoinBatched(
			ctx, arrayOuter([[0], [1], [2]]), singleOuterDescriptor(),
			[branchFactory], [left()], /*globalCap*/ 8, /*maxOuterReadAhead*/ 64,
		));
		expect(out).to.deep.equal([
			[0, 'v0'],
			[1, 'v1'],
			[2, 'v2'],
		]);
	});

	it('overlaps lookups across outer rows (peak in-flight reaches the global cap)', async () => {
		const ctx = makeRuntimeContext();
		const M = 16;
		const cap = 8;
		const tracker = new ConcurrencyTracker();
		const gate = makeDeferred();
		// Every outer row's lookup parks on the shared gate. The batched driver runs
		// up to `cap` of them at once across different outer rows; once `cap` are
		// simultaneously parked we have proven cross-row overlap, then we release.
		const branchFactory: FanOutLookupBranchFactory = () => (async function* () {
			tracker.enter();
			try {
				await gate.promise;
			} finally {
				tracker.exit();
			}
			yield ['done'] as Row;
		})();
		const rows: Row[] = Array.from({ length: M }, (_, i) => [i] as Row);

		const done = collect(runFanOutLookupJoinBatched(
			ctx, arrayOuter(rows), singleOuterDescriptor(),
			[branchFactory], [left()], cap, 64,
		));
		// Deterministic proof of cross-row overlap: `cap` lookups for distinct outer
		// rows are in flight simultaneously, far more than serial's one-at-a-time.
		await tracker.waitForInFlight(cap);
		expect(tracker.peak).to.equal(cap, 'batched mode must overlap lookups across outer rows up to the cap');
		gate.resolve();

		const out = await done;
		expect(out).to.have.length(M);
		expect(tracker.peak).to.be.at.most(cap, `global budget exceeded: peak=${tracker.peak}, cap=${cap}`);
	});

	it('serial mode on the same input never overlaps (peak in-flight stays at 1)', async () => {
		const ctx = makeRuntimeContext();
		const M = 8;
		const tracker = new ConcurrencyTracker();
		// Serial mode drives one outer row at a time. Each lookup stays in-flight
		// across an await (a real concurrency window); if any two outer rows overlapped
		// the tracker would record peak >= 2. Serial mode guarantees they never do.
		const branchFactory: FanOutLookupBranchFactory = () => (async function* () {
			tracker.enter();
			try {
				await Promise.resolve();
			} finally {
				tracker.exit();
			}
			yield ['done'] as Row;
		})();
		const rows: Row[] = Array.from({ length: M }, (_, i) => [i] as Row);

		const out = await collect(runFanOutLookupJoin(
			ctx, arrayOuter(rows), singleOuterDescriptor(),
			[branchFactory], [left()], 8,
		));
		expect(out).to.have.length(M);
		// Contrast with the batched overlap above: serial peak is 1, batched peak is `cap`.
		expect(tracker.peak).to.equal(1, `serial mode must not overlap across outer rows: peak=${tracker.peak}`);
	});

	it('respects the global in-flight budget across all rows', async () => {
		const ctx = makeRuntimeContext();
		const cap = 4;
		let inFlight = 0;
		let peak = 0;
		// branchCount = 3 → readAhead = ceil(4/3) = 2 rows, i.e. up to 2×3 = 6
		// branch tasks want to run, but the single global semaphore must hold
		// concurrent branch bodies at `cap = 4`. (Read-ahead alone would allow 6.)
		const makeBranch = (): FanOutLookupBranchFactory => () => (async function* () {
			inFlight++;
			peak = Math.max(peak, inFlight);
			try {
				await sleep(15);
				yield ['x'] as Row;
			} finally {
				inFlight--;
			}
		})();
		const factories = [makeBranch(), makeBranch(), makeBranch()];
		const descriptors = [left(), left(), left()];
		const rows: Row[] = Array.from({ length: 10 }, (_, i) => [i] as Row);

		const out = await collect(runFanOutLookupJoinBatched(
			ctx, arrayOuter(rows), singleOuterDescriptor(),
			factories, descriptors, cap, 64,
		));
		expect(out).to.have.length(10);
		expect(peak).to.be.at.most(cap, `global budget exceeded: peak=${peak}, cap=${cap}`);
		expect(peak).to.be.greaterThan(1, 'expected real concurrency under the budget');
	});

	it('bounds outer read-ahead (backpressure from the consumer)', async () => {
		const ctx = makeRuntimeContext();
		const cap = 4;          // branchCount=1 → readAhead = ceil(4/1) = 4
		let produced = 0;
		const infiniteOuter = (async function* () {
			for (let i = 0; i < 1_000_000; i++) {
				produced++;
				yield [i] as Row;
			}
		})();
		const branchFactory: FanOutLookupBranchFactory = () => (async function* () {
			await sleep(5);
			yield ['x'] as Row;
		})();

		const iter = runFanOutLookupJoinBatched(
			ctx, infiniteOuter, singleOuterDescriptor(),
			[branchFactory], [left()], cap, 64,
		)[Symbol.asyncIterator]();

		// Consume just the first row, then stop demanding and let the pump settle.
		const first = await iter.next();
		expect(first.done).to.equal(false);
		await sleep(60);

		// readAhead = 4 rows ahead of the frontier. Frontier advanced ~1 (we
		// consumed one), so at most ~ (1 + readAhead) + small slack pulled.
		expect(produced).to.be.at.most(cap + 4,
			`pump ran away: produced=${produced}, readAhead=${cap}`);

		await iter.return?.();
	});

	it('isolates each row\'s outer binding (no shared-ref corruption)', async () => {
		const ctx = makeRuntimeContext();
		// Branch echoes its own outer key; with many rows concurrently in flight
		// each composed row must carry its own key.
		const branchFactory: FanOutLookupBranchFactory = (innerCtx) => (async function* () {
			const k = resolveAttribute(innerCtx, 1) as number;
			// Stagger so multiple rows overlap while bindings are live.
			await sleep((k % 4) * 5);
			yield [`saw-${k}`] as Row;
		})();
		const rows: Row[] = Array.from({ length: 12 }, (_, i) => [i] as Row);

		const out = await collect(runFanOutLookupJoinBatched(
			ctx, arrayOuter(rows), singleOuterDescriptor(),
			[branchFactory], [left()], 8, 64,
		));
		expect(out).to.deep.equal(rows.map(r => [r[0], `saw-${r[0]}`]));
	});

	it('throws QuereusError(CONSTRAINT) on atMostOne violation', async () => {
		const ctx = makeRuntimeContext();
		const branchBad: FanOutLookupBranchFactory = () => (async function* () {
			yield ['r1'] as Row;
			yield ['r2'] as Row;
		})();
		let caught: unknown = undefined;
		try {
			await collect(runFanOutLookupJoinBatched(
				ctx, arrayOuter([[1]]), singleOuterDescriptor(),
				[branchBad], [left()], 8, 64,
			));
		} catch (e) {
			caught = e;
		}
		expect(String((caught as Error)?.message ?? caught))
			.to.match(/FanOutLookupJoin: branch 0 produced more than one row/);
		expect((caught as { code?: number }).code).to.equal(19); // CONSTRAINT
	});

	it('drops outer rows when an atMostOne-inner branch misses', async () => {
		const ctx = makeRuntimeContext();
		const branchAlways: FanOutLookupBranchFactory = () => (async function* () { yield ['ok'] as Row; })();
		const branchInner: FanOutLookupBranchFactory = (innerCtx) => (async function* () {
			if ((resolveAttribute(innerCtx, 1) as number) === 2) yield ['hit'] as Row;
		})();
		const descriptors: FanOutLookupBranchDescriptor[] = [
			{ mode: 'atMostOne-left', outputColCount: 1, concurrencySafe: true },
			{ mode: 'atMostOne-inner', outputColCount: 1, concurrencySafe: true },
		];
		const out = await collect(runFanOutLookupJoinBatched(
			ctx, arrayOuter([[1], [2], [3]]), singleOuterDescriptor(),
			[branchAlways, branchInner], descriptors, 8, 64,
		));
		expect(out).to.deep.equal([[2, 'ok', 'hit']]);
	});

	it('NULL-pads zero-row atMostOne-left branches', async () => {
		const ctx = makeRuntimeContext();
		const branchHit: FanOutLookupBranchFactory = () => (async function* () { yield ['hit', 42] as Row; })();
		const branchMiss: FanOutLookupBranchFactory = () => (async function* () { /* empty */ })();
		const out = await collect(runFanOutLookupJoinBatched(
			ctx, arrayOuter([[1]]), singleOuterDescriptor(),
			[branchHit, branchMiss], [left(2), left(3)], 8, 64,
		));
		expect(out).to.deep.equal([[1, 'hit', 42, null, null, null]]);
	});

	it('serializes a shared serial connection across different outer rows', async () => {
		const ctx = makeRuntimeContext();
		const sharedConn = { connectionId: 'shared-batched' };
		let inFlight = 0;
		let maxInFlight = 0;
		const makeBranch = (): FanOutLookupBranchFactory => () => (async function* () {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			try {
				await sleep(10);
				yield ['done'] as Row;
			} finally {
				inFlight--;
			}
		})();
		// Two branches on the same non-concurrency-safe connection, many rows.
		const factories = [makeBranch(), makeBranch()];
		const descriptors: FanOutLookupBranchDescriptor[] = factories.map(() => ({
			mode: 'atMostOne-left' as const,
			outputColCount: 1,
			concurrencySafe: false,
			connectionKey: sharedConn,
		}));
		const rows: Row[] = Array.from({ length: 5 }, (_, i) => [i] as Row);

		await collect(runFanOutLookupJoinBatched(
			ctx, arrayOuter(rows), singleOuterDescriptor(),
			factories, descriptors, 8, 64,
		));
		expect(maxInFlight).to.equal(1,
			`shared serial connection must serialize across rows: maxInFlight=${maxInFlight}`);
	});

	it('propagates a branch error and closes sibling iterators', async () => {
		const ctx = makeRuntimeContext();
		let siblingClosed = false;
		const branchThrow: FanOutLookupBranchFactory = () => (async function* () {
			yield Promise.reject(new Error('batched boom')) as unknown as Row;
		})();
		const branchSlow: FanOutLookupBranchFactory = () => (async function* () {
			try {
				await sleep(40);
				yield ['done'] as Row;
			} finally {
				siblingClosed = true;
			}
		})();
		let caught: unknown = undefined;
		try {
			await collect(runFanOutLookupJoinBatched(
				ctx, arrayOuter([[1]]), singleOuterDescriptor(),
				[branchThrow, branchSlow], [left(), left()], 8, 64,
			));
		} catch (e) {
			caught = e;
		}
		expect(String((caught as Error)?.message ?? caught)).to.equal('batched boom');
		expect(siblingClosed, 'sibling branch iterator must be closed').to.equal(true);
		// All per-row slots closed on the error path.
		expect(ctx.context.size).to.equal(0);
	});

	it('propagates a branch rejection even when the reason is undefined', async () => {
		// A branch rejecting with `undefined` must abort the stream, not be
		// silently treated as a zero-row miss (don't eat exceptions).
		const ctx = makeRuntimeContext();
		const branchRejectUndefined: FanOutLookupBranchFactory = () => (async function* () {
			yield await Promise.reject(undefined) as unknown as Row;
		})();
		let threw = false;
		try {
			await collect(runFanOutLookupJoinBatched(
				ctx, arrayOuter([[1]]), singleOuterDescriptor(),
				[branchRejectUndefined], [left()], 8, 64,
			));
		} catch {
			threw = true;
		}
		expect(threw, 'undefined-reason rejection must propagate, not be swallowed').to.equal(true);
	});

	it('cleans up on early consumer break', async () => {
		const ctx = makeRuntimeContext();
		const branchFactory: FanOutLookupBranchFactory = () => (async function* () {
			await sleep(5);
			yield ['ok'] as Row;
		})();
		const rows: Row[] = Array.from({ length: 20 }, (_, i) => [i] as Row);

		const unhandled: unknown[] = [];
		const handler = (reason: unknown) => unhandled.push(reason);
		process.on('unhandledRejection', handler);
		try {
			let count = 0;
			for await (const _r of runFanOutLookupJoinBatched(
				ctx, arrayOuter(rows), singleOuterDescriptor(),
				[branchFactory], [left()], 8, 64,
			)) {
				count++;
				if (count >= 2) break;
			}
			expect(count).to.equal(2);
			await sleep(30);
			expect(unhandled).to.have.lengthOf(0);
			// Every forked per-row slot was closed on teardown.
			expect(ctx.context.size).to.equal(0);
		} finally {
			process.off('unhandledRejection', handler);
		}
	});

	it('completes correctly with an empty outer source', async () => {
		const ctx = makeRuntimeContext();
		let invocations = 0;
		const branch: FanOutLookupBranchFactory = () => {
			invocations++;
			return (async function* () { yield ['x'] as Row; })();
		};
		const out = await collect(runFanOutLookupJoinBatched(
			ctx, arrayOuter([]), singleOuterDescriptor(),
			[branch], [left()], 8, 64,
		));
		expect(out).to.deep.equal([]);
		expect(invocations).to.equal(0);
		expect(ctx.context.size).to.equal(0);
	});

	it('nested batched-over-batched completes and respects each level\'s budget', async () => {
		// Outer is itself a batched fan-out. Assert correctness and that peak
		// concurrency at each level stays within that level's global cap.
		const outerCtx = makeRuntimeContext();
		const outerCap = 4;
		const innerCap = 3;
		let outerInFlight = 0, outerPeak = 0;
		let innerInFlight = 0, innerPeak = 0;

		// Inner (level-2) branch.
		const innerBranch: FanOutLookupBranchFactory = () => (async function* () {
			innerInFlight++;
			innerPeak = Math.max(innerPeak, innerInFlight);
			try {
				await sleep(8);
				yield ['inner'] as Row;
			} finally {
				innerInFlight--;
			}
		})();

		// The level-1 outer is a batched fan-out producing rows [k, 'inner'].
		const level1Outer = (rctx: RuntimeContext): AsyncIterable<Row> => runFanOutLookupJoinBatched(
			rctx,
			arrayOuter(Array.from({ length: 12 }, (_, i) => [i] as Row)),
			singleOuterDescriptor(),
			[innerBranch], [left()], innerCap, 64,
		);

		// Level-1 (top) branch, instrumented for the outer-level budget.
		const topBranch: FanOutLookupBranchFactory = () => (async function* () {
			outerInFlight++;
			outerPeak = Math.max(outerPeak, outerInFlight);
			try {
				await sleep(8);
				yield ['top'] as Row;
			} finally {
				outerInFlight--;
			}
		})();

		const out = await collect(runFanOutLookupJoinBatched(
			outerCtx,
			level1Outer(outerCtx),
			// outer rows are [k, 'inner'] (2 cols); descriptor still binds attr 1 → col 0
			singleOuterDescriptor(),
			[topBranch], [left()], outerCap, 64,
		));

		expect(out).to.have.length(12);
		for (const row of out) {
			expect(row[2]).to.equal('top');
		}
		expect(innerPeak).to.be.at.most(innerCap, `inner budget exceeded: ${innerPeak}`);
		expect(outerPeak).to.be.at.most(outerCap, `outer budget exceeded: ${outerPeak}`);
	});

	it('rejects invalid globalCap / maxOuterReadAhead', async () => {
		const ctx = makeRuntimeContext();
		const f: FanOutLookupBranchFactory = () => (async function* () { yield ['x'] as Row; })();
		let c1: unknown, c2: unknown;
		try {
			await collect(runFanOutLookupJoinBatched(
				ctx, arrayOuter([[1]]), singleOuterDescriptor(), [f], [left()], 0, 64,
			));
		} catch (e) { c1 = e; }
		try {
			await collect(runFanOutLookupJoinBatched(
				ctx, arrayOuter([[1]]), singleOuterDescriptor(), [f], [left()], 8, 0,
			));
		} catch (e) { c2 = e; }
		expect(c1).to.be.instanceOf(RangeError);
		expect(c2).to.be.instanceOf(RangeError);
	});

	const cross = (outputColCount = 1): FanOutLookupBranchDescriptor =>
		({ mode: 'cross', outputColCount, concurrencySafe: true });

	it('emits the cross product per outer row, in outer order', async () => {
		const ctx = makeRuntimeContext();
		// Reverse completion order so we exercise the reorder buffer with products.
		const branch: FanOutLookupBranchFactory = (innerCtx) => (async function* () {
			const k = resolveAttribute(innerCtx, 1) as number;
			await sleep(30 - k * 10);
			yield [`${k}a`] as Row; yield [`${k}b`] as Row;
		})();
		const out = await collect(runFanOutLookupJoinBatched(
			ctx, arrayOuter([[0], [1], [2]]), singleOuterDescriptor(),
			[branch], [cross()], /*globalCap*/ 8, /*maxOuterReadAhead*/ 64,
		));
		// Each outer row's two product rows must appear contiguously, in outer order.
		expect(out).to.deep.equal([
			[0, '0a'], [0, '0b'],
			[1, '1a'], [1, '1b'],
			[2, '2a'], [2, '2b'],
		]);
	});

	it('matches the serial multiset for a two-branch cross product', async () => {
		const ctx = makeRuntimeContext();
		const b0: FanOutLookupBranchFactory = () => (async function* () {
			yield ['a'] as Row; yield ['b'] as Row; yield ['c'] as Row;
		})();
		const b1: FanOutLookupBranchFactory = () => (async function* () {
			yield ['x'] as Row; yield ['y'] as Row;
		})();
		const serialOut = await collect(runFanOutLookupJoin(
			makeRuntimeContext(), arrayOuter([[1], [2]]), singleOuterDescriptor(),
			[b0, b1], [cross(), cross()], 4,
		));
		const batchedOut = await collect(runFanOutLookupJoinBatched(
			ctx, arrayOuter([[1], [2]]), singleOuterDescriptor(),
			[b0, b1], [cross(), cross()], 8, 64,
		));
		expect(batchedOut).to.deep.equal(serialOut);
	});

	it('drops outer rows whose cross branch matched zero rows', async () => {
		const ctx = makeRuntimeContext();
		const branch: FanOutLookupBranchFactory = (innerCtx) => (async function* () {
			if ((resolveAttribute(innerCtx, 1) as number) === 2) {
				yield ['h1'] as Row; yield ['h2'] as Row;
			}
		})();
		const out = await collect(runFanOutLookupJoinBatched(
			ctx, arrayOuter([[1], [2], [3]]), singleOuterDescriptor(),
			[branch], [cross()], 8, 64,
		));
		expect(out).to.deep.equal([[2, 'h1'], [2, 'h2']]);
	});

	it('emits all k>1 product rows of one outer contiguously before the next seq', async () => {
		const ctx = makeRuntimeContext();
		// Slowest row first: forces row 0 to complete after rows 1/2 but still emit
		// its whole product block before theirs.
		const branch: FanOutLookupBranchFactory = (innerCtx) => (async function* () {
			const k = resolveAttribute(innerCtx, 1) as number;
			await sleep(30 - k * 10);
			for (let i = 0; i < 3; i++) yield [`${k}.${i}`] as Row;
		})();
		const out = await collect(runFanOutLookupJoinBatched(
			ctx, arrayOuter([[0], [1], [2]]), singleOuterDescriptor(),
			[branch], [cross()], 8, 64,
		));
		expect(out).to.deep.equal([
			[0, '0.0'], [0, '0.1'], [0, '0.2'],
			[1, '1.0'], [1, '1.1'], [1, '1.2'],
			[2, '2.0'], [2, '2.1'], [2, '2.2'],
		]);
	});
});

// ---------------------------------------------------------------------------
// FanOutLookupJoinNode (plan-node) tests
// ---------------------------------------------------------------------------

import { FanOutLookupJoinNode, type FanOutBranchSpec } from '../../src/planner/nodes/fanout-lookup-join-node.js';
import { PlanNode, type Attribute, type PhysicalProperties } from '../../src/planner/nodes/plan-node.js';
import { PlanNodeType } from '../../src/planner/nodes/plan-node-type.js';
import type { Scope } from '../../src/planner/scopes/scope.js';
import type { RelationType, ScalarType } from '../../src/common/datatype.js';
import { validatePhysicalTree } from '../../src/planner/validation/plan-validator.js';

const mockScope = { resolveSymbol: () => undefined } as unknown as Scope;

// Mirror packages/quereus/test/planner/validation.spec.ts helpers — minimal
// mock node sufficient for relation-style validation and plan-node interop.
class MockRelNode extends PlanNode {
	override readonly nodeType: PlanNodeType;
	readonly estimatedRows?: number;
	private readonly _attrs: readonly Attribute[];
	private readonly _physicalOverride: Partial<PhysicalProperties>;
	private readonly _type: RelationType;

	constructor(opts: {
		nodeType?: PlanNodeType;
		attrs: readonly Attribute[];
		physical?: Partial<PhysicalProperties>;
		columns?: RelationType['columns'];
		estimatedRows?: number;
	}) {
		super(mockScope, 0.01);
		this.nodeType = opts.nodeType ?? PlanNodeType.SeqScan;
		this.estimatedRows = opts.estimatedRows;
		this._attrs = opts.attrs;
		this._physicalOverride = opts.physical ?? { deterministic: true, readonly: true };
		this._type = {
			typeClass: 'relation',
			columns: opts.columns ?? opts.attrs.map(a => ({ name: a.name, type: a.type })),
			isSet: false,
			isReadOnly: true,
			keys: [],
			rowConstraints: [],
		} as RelationType;
	}

	getType(): RelationType { return this._type; }
	getChildren(): readonly PlanNode[] { return []; }
	override getAttributes(): readonly Attribute[] { return this._attrs; }
	override computePhysical(): Partial<PhysicalProperties> { return this._physicalOverride; }
	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 0) throw new Error('MockRelNode expects 0 children');
		return this;
	}
}

const INT_TYPE: ScalarType = {
	typeClass: 'scalar',
	logicalType: { name: 'INTEGER', affinity: 'integer', isNumeric: true } as never,
	nullable: false,
} as ScalarType;

let nextAttrId = 900000;
function makeAttr(name: string, sourceRelation = 'test.t'): Attribute {
	return { id: nextAttrId++, name, type: INT_TYPE, sourceRelation, relationName: 't' };
}

describe('FanOutLookupJoinNode', () => {
	it('rejects empty branch list', () => {
		const outer = new MockRelNode({ attrs: [makeAttr('outer_k')] });
		expect(() => new FanOutLookupJoinNode(mockScope, outer, [], 2))
			.to.throw(/requires >= 1 branch/);
	});

	it('rejects non-positive concurrencyCap', () => {
		const outer = new MockRelNode({ attrs: [makeAttr('outer_k')] });
		const branchChild = new MockRelNode({ attrs: [makeAttr('child_v')] });
		const branch: FanOutBranchSpec = {
			child: branchChild,
			mode: 'atMostOne-left',
			outputAttrs: branchChild.getAttributes(),
			concurrencySafe: true,
		};
		expect(() => new FanOutLookupJoinNode(mockScope, outer, [branch], 0))
			.to.throw(/concurrencyCap must be a positive integer/);
	});

	it('rejects outputAttrs length mismatch', () => {
		const outer = new MockRelNode({ attrs: [makeAttr('outer_k')] });
		const branchChild = new MockRelNode({ attrs: [makeAttr('child_v')] });
		const branch: FanOutBranchSpec = {
			child: branchChild,
			mode: 'atMostOne-left',
			outputAttrs: [], // empty, but child has 1 attribute
			concurrencySafe: true,
		};
		expect(() => new FanOutLookupJoinNode(mockScope, outer, [branch], 1))
			.to.throw(/outputAttrs length .* does not match/);
	});

	it('composes attributes outer-then-branches', () => {
		const outerAttrs = [makeAttr('outer_k'), makeAttr('outer_v')];
		const outer = new MockRelNode({ attrs: outerAttrs });
		const b0Attrs = [makeAttr('b0_x')];
		const b1Attrs = [makeAttr('b1_y'), makeAttr('b1_z')];
		const branch0Child = new MockRelNode({ attrs: b0Attrs });
		const branch1Child = new MockRelNode({ attrs: b1Attrs });
		const branches: FanOutBranchSpec[] = [
			{ child: branch0Child, mode: 'atMostOne-left', outputAttrs: b0Attrs, concurrencySafe: true },
			{ child: branch1Child, mode: 'atMostOne-inner', outputAttrs: b1Attrs, concurrencySafe: true },
		];
		const node = new FanOutLookupJoinNode(mockScope, outer, branches, 2);
		const attrs = node.getAttributes();
		expect(attrs).to.have.length(5);
		expect(attrs[0].id).to.equal(outerAttrs[0].id);
		expect(attrs[1].id).to.equal(outerAttrs[1].id);
		expect(attrs[2].id).to.equal(b0Attrs[0].id);
		expect(attrs[3].id).to.equal(b1Attrs[0].id);
		expect(attrs[4].id).to.equal(b1Attrs[1].id);
	});

	it('marks atMostOne-left branch outputs nullable', () => {
		const outerAttrs = [makeAttr('outer_k')];
		const outer = new MockRelNode({ attrs: outerAttrs });
		const b0Attrs = [makeAttr('b0_x')];
		const branchChild = new MockRelNode({ attrs: b0Attrs });
		const branches: FanOutBranchSpec[] = [
			{ child: branchChild, mode: 'atMostOne-left', outputAttrs: b0Attrs, concurrencySafe: true },
		];
		const node = new FanOutLookupJoinNode(mockScope, outer, branches, 1);
		const attrs = node.getAttributes();
		expect(attrs[1].type.nullable).to.equal(true);
		// The atMostOne-inner branch keeps declared nullability.
		const innerBranches: FanOutBranchSpec[] = [
			{ child: branchChild, mode: 'atMostOne-inner', outputAttrs: b0Attrs, concurrencySafe: true },
		];
		const innerNode = new FanOutLookupJoinNode(mockScope, outer, innerBranches, 1);
		expect(innerNode.getAttributes()[1].type.nullable).to.equal(false);
		// A cross branch is inner — its outputs are not nullable-widened.
		const crossBranches: FanOutBranchSpec[] = [
			{ child: branchChild, mode: 'cross', outputAttrs: b0Attrs, concurrencySafe: true },
		];
		const crossNode = new FanOutLookupJoinNode(mockScope, outer, crossBranches, 1);
		expect(crossNode.getAttributes()[1].type.nullable).to.equal(false);
	});

	it('multiplies estimatedRows by each cross branch fan-out', () => {
		const outer = new MockRelNode({ attrs: [makeAttr('outer_k')], estimatedRows: 10 });
		const b0Attrs = [makeAttr('b0_x')];
		const b1Attrs = [makeAttr('b1_y')];
		const cross0 = new MockRelNode({ attrs: b0Attrs, estimatedRows: 3 });
		const cross1 = new MockRelNode({ attrs: b1Attrs, estimatedRows: 2 });
		const branches: FanOutBranchSpec[] = [
			{ child: cross0, mode: 'cross', outputAttrs: b0Attrs, concurrencySafe: true },
			{ child: cross1, mode: 'cross', outputAttrs: b1Attrs, concurrencySafe: true },
		];
		const node = new FanOutLookupJoinNode(mockScope, outer, branches, 4);
		expect(node.estimatedRows).to.equal(10 * 3 * 2);

		// at-most-one branches keep a ×1 factor.
		const amo = new MockRelNode({ attrs: b1Attrs, estimatedRows: 7 });
		const mixed: FanOutBranchSpec[] = [
			{ child: cross0, mode: 'cross', outputAttrs: b0Attrs, concurrencySafe: true },
			{ child: amo, mode: 'atMostOne-left', outputAttrs: b1Attrs, concurrencySafe: true },
		];
		expect(new FanOutLookupJoinNode(mockScope, outer, mixed, 4).estimatedRows).to.equal(10 * 3);
	});

	it('leaves a cross branch unmultiplied when its child has no estimate', () => {
		const outer = new MockRelNode({ attrs: [makeAttr('outer_k')], estimatedRows: 10 });
		const b0Attrs = [makeAttr('b0_x')];
		const crossNoEst = new MockRelNode({ attrs: b0Attrs }); // estimatedRows undefined
		const branches: FanOutBranchSpec[] = [
			{ child: crossNoEst, mode: 'cross', outputAttrs: b0Attrs, concurrencySafe: true },
		];
		expect(new FanOutLookupJoinNode(mockScope, outer, branches, 4).estimatedRows).to.equal(10);

		// Undefined outer estimate ⇒ undefined overall.
		const noOuter = new MockRelNode({ attrs: [makeAttr('outer_k')] });
		expect(new FanOutLookupJoinNode(mockScope, noOuter, branches, 4).estimatedRows).to.equal(undefined);
	});

	it('passes validatePhysicalTree', () => {
		const outerAttrs = [makeAttr('outer_k')];
		const outer = new MockRelNode({
			nodeType: PlanNodeType.SeqScan,
			attrs: outerAttrs,
			physical: { deterministic: true, readonly: true, estimatedRows: 10 },
		});
		const b0Attrs = [makeAttr('b0_x')];
		const branchChild = new MockRelNode({
			nodeType: PlanNodeType.SeqScan,
			attrs: b0Attrs,
			physical: { deterministic: true, readonly: true, estimatedRows: 1 },
		});
		const branches: FanOutBranchSpec[] = [
			{ child: branchChild, mode: 'atMostOne-left', outputAttrs: b0Attrs, concurrencySafe: true },
		];
		const node = new FanOutLookupJoinNode(mockScope, outer, branches, 1);
		// Default validation: outer + branch IDs are forwarded into
		// FanOutLookupJoin's getAttributes(). The attribute-provenance surface
		// treats this as forwarding (each ID still originates once at its leaf),
		// so the full uniqueness check passes — no workaround needed.
		expect(() => validatePhysicalTree(node)).not.to.throw();
	});

	it('withChildren rebuilds preserving branch shape', () => {
		const outerAttrs = [makeAttr('outer_k')];
		const outer = new MockRelNode({ attrs: outerAttrs });
		const b0Attrs = [makeAttr('b0_x')];
		const branchChild = new MockRelNode({ attrs: b0Attrs });
		const branches: FanOutBranchSpec[] = [
			{ child: branchChild, mode: 'atMostOne-left', outputAttrs: b0Attrs, concurrencySafe: false, connectionKey: { id: 'k' } },
		];
		const node = new FanOutLookupJoinNode(mockScope, outer, branches, 4);

		// Same children: returns self.
		expect(node.withChildren([outer, branchChild])).to.equal(node);

		const replaced = node.withChildren([outer, new MockRelNode({ attrs: b0Attrs })]) as FanOutLookupJoinNode;
		expect(replaced).to.not.equal(node);
		expect(replaced.branches).to.have.length(1);
		expect(replaced.branches[0].mode).to.equal('atMostOne-left');
		expect(replaced.branches[0].outputAttrs).to.deep.equal(b0Attrs);
		expect(replaced.branches[0].concurrencySafe).to.equal(false);
		expect(replaced.branches[0].connectionKey).to.equal(branches[0].connectionKey);
		expect(replaced.concurrencyCap).to.equal(4);
	});

	it('emits FanOutLookupJoin in toString', () => {
		const outerAttrs = [makeAttr('outer_k')];
		const outer = new MockRelNode({ attrs: outerAttrs });
		const b0Attrs = [makeAttr('b0_x')];
		const branchChild = new MockRelNode({ attrs: b0Attrs });
		const node = new FanOutLookupJoinNode(mockScope, outer, [
			{ child: branchChild, mode: 'atMostOne-left', outputAttrs: b0Attrs, concurrencySafe: true },
			{ child: branchChild, mode: 'atMostOne-inner', outputAttrs: b0Attrs, concurrencySafe: false },
		], 3);
		const s = node.toString();
		expect(s).to.match(/FANOUT_LOOKUP_JOIN/);
		expect(s).to.match(/N=2/);
		expect(s).to.match(/cap=3/);
		expect(s).to.match(/atMostOne-left/);
		expect(s).to.match(/atMostOne-inner.*locked/);
	});

	it('defaults outerMode to serial and threads it through toString / attributes / withChildren', () => {
		const outerAttrs = [makeAttr('outer_k')];
		const outer = new MockRelNode({ attrs: outerAttrs });
		const b0Attrs = [makeAttr('b0_x')];
		const branchChild = new MockRelNode({ attrs: b0Attrs });
		const branches: FanOutBranchSpec[] = [
			{ child: branchChild, mode: 'atMostOne-left', outputAttrs: b0Attrs, concurrencySafe: true },
		];

		const serial = new FanOutLookupJoinNode(mockScope, outer, branches, 2);
		expect(serial.outerMode).to.equal('serial');
		expect(serial.toString()).to.not.match(/batched/);
		expect(serial.getLogicalAttributes().outerMode).to.equal('serial');

		const batched = new FanOutLookupJoinNode(mockScope, outer, branches, 2, undefined, 'batched');
		expect(batched.outerMode).to.equal('batched');
		expect(batched.toString()).to.match(/batched/);
		expect(batched.getLogicalAttributes().outerMode).to.equal('batched');

		// withChildren preserves the mode.
		const replaced = batched.withChildren([outer, new MockRelNode({ attrs: b0Attrs })]) as FanOutLookupJoinNode;
		expect(replaced.outerMode).to.equal('batched');
	});

	it('rejects an unknown outerMode', () => {
		const outer = new MockRelNode({ attrs: [makeAttr('outer_k')] });
		const branchChild = new MockRelNode({ attrs: [makeAttr('child_v')] });
		const branches: FanOutBranchSpec[] = [
			{ child: branchChild, mode: 'atMostOne-left', outputAttrs: branchChild.getAttributes(), concurrencySafe: true },
		];
		expect(() => new FanOutLookupJoinNode(
			mockScope, outer, branches, 2, undefined, 'bogus' as unknown as 'serial',
		)).to.throw(/unknown outerMode/);
	});
});

// ---------------------------------------------------------------------------
// emitFanOutLookupJoin — outerMode routing (note string distinguishes paths)
// ---------------------------------------------------------------------------

import { emitFanOutLookupJoin } from '../../src/runtime/emit/fanout-lookup-join.js';
import { EmissionContext } from '../../src/runtime/emission-context.js';
import { Database } from '../../src/core/database.js';
import { ValuesNode } from '../../src/planner/nodes/values-node.js';
import { LiteralNode } from '../../src/planner/nodes/scalar.js';
import { EmptyScope } from '../../src/planner/scopes/empty.js';
import type * as AST from '../../src/parser/ast.js';

describe('emitFanOutLookupJoin outerMode routing', () => {
	const emitScope = EmptyScope.instance;
	const lit = (value: unknown): LiteralNode =>
		new LiteralNode(emitScope, { type: 'literal', value } as unknown as AST.LiteralExpr);

	function makeNode(outerMode: 'serial' | 'batched'): FanOutLookupJoinNode {
		const outer = new ValuesNode(emitScope, [[lit(1)]], ['outer_k']);
		const branchChild = new ValuesNode(emitScope, [[lit(10)]], ['b0_x']);
		const branches: FanOutBranchSpec[] = [
			{
				child: branchChild,
				mode: 'atMostOne-left',
				outputAttrs: branchChild.getAttributes(),
				concurrencySafe: true,
			},
		];
		return new FanOutLookupJoinNode(emitScope, outer, branches, 8, undefined, outerMode);
	}

	it('serial mode routes to the serial run function', async () => {
		const db = new Database();
		try {
			const inst = emitFanOutLookupJoin(makeNode('serial'), new EmissionContext(db));
			expect(inst.note).to.match(/^fanout_lookup_join\(/);
			expect(inst.note).to.not.match(/batched/);
		} finally {
			await db.close();
		}
	});

	it('batched mode routes to the batched run function and surfaces tuning knobs', async () => {
		const db = new Database();
		try {
			const inst = emitFanOutLookupJoin(makeNode('batched'), new EmissionContext(db));
			expect(inst.note).to.match(/^fanout_lookup_join_batched\(/);
			// Defaults from DEFAULT_TUNING.parallel: globalCap=16, readAhead<=64.
			expect(inst.note).to.match(/globalCap=16/);
			expect(inst.note).to.match(/readAhead<=64/);
		} finally {
			await db.close();
		}
	});
});
