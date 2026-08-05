import type { RuntimeContext } from './types.js';
import {
	createStrictRowContextMap,
	wrapTableContextsStrict,
	markForkOf,
	bumpParentForkCounter,
	dropParentForkCounter,
	strictForkEnabled,
} from './strict-fork.js';

/**
 * Strict-fork bookkeeping helpers, re-exported for consumers that use
 * {@link ParallelDriver.fork} directly without going through {@link ParallelDriver.drive}.
 * Manual users are responsible for calling these around the fork's lifetime.
 */
export { bumpParentForkCounter, dropParentForkCounter };

/**
 * Options controlling {@link ParallelDriver.drive} execution.
 */
export interface ParallelDriveOptions {
	/** Maximum number of concurrently-active branches. Defaults to `factories.length`. */
	concurrency?: number;
	/** Cooperative cancellation. Firing aborts all branches. */
	signal?: AbortSignal;
}

/** Pair yielded by {@link ParallelDriver.drive}: a value plus the branch index that produced it. */
export interface ParallelDriveItem<T> {
	readonly branch: number;
	readonly value: T;
}

/**
 * Runtime helper that forks a {@link RuntimeContext} into N independent child views
 * and drives N branch factories concurrently with bounded concurrency and cooperative
 * cancellation.
 *
 * This is a foundation primitive — it has no SQL/plan-node consumers yet. Combinator
 * choice (gather, merge-by-key, zip, lookup-join, ...) is left to downstream nodes;
 * {@link drive} yields `{ branch, value }` pairs in arrival order so a consumer can
 * impose whatever combinator it needs on top.
 */
export class ParallelDriver {
	/**
	 * Fork `rctx` into `n` independent child views.
	 *
	 * Each child receives:
	 * - an **independent** `RowContextMap` seeded with a snapshot of the parent's
	 *   entries — writes (e.g. via `createRowSlot`) in one fork do not leak to siblings
	 *   or to the parent;
	 * - an **independent** `tableContexts` map seeded with a shallow snapshot of the
	 *   parent's entries — set/delete in one fork do not leak to siblings or parent;
	 * - **shared** references to read-mostly state: `db`, `stmt`, `params`,
	 *   `enableMetrics`, `mutationOrdinal`, `signal`, `readCommitted`, `tracer`,
	 *   `activeConnection`, `tableNameRemap`, `contextTracker`, `planStack`,
	 *   `executionMemo`, `scanConnections`, `cacheStates`, `cteMaterializations`,
	 *   `inSetProbes`.
	 *   (`tableNameRemap` is the deferred-constraint queue's per-entry old→new table
	 *   name map; shared by reference and read-only, so a scan leaf inside a fork
	 *   resolves the same post-rename name the parent would.)
	 *   (`signal` is shared so every
	 *   branch honors the same cooperative cancellation — the table-scan leaf reads
	 *   `rctx.signal`.) (`mutationOrdinal` is a per-row INSERT/envelope
	 *   scalar set+restored synchronously by the sequential insert path, never mutated
	 *   inside a parallel fork, so each child snapshots the parent value.)
	 *   (`executionMemo` is the once-per-execution memo for impure subqueries; shared
	 *   by reference so the run-once contract spans branches, matching the pre-cache
	 *   single-closure memo. NOTE: it is lazily created on first impure-subquery run,
	 *   so if a future parallelized query drives an impure subquery inside a fork, the
	 *   memo must be eagerly created on the parent *before* fork() — otherwise each
	 *   branch lazily makes its own and the inner DML fires once per branch. Dormant
	 *   today: ParallelDriver has no query consumers.)
	 *   (`scanConnections` is the once-per-execution inner-scan connection cache; shared
	 *   by reference so the statement teardown disconnects every instance connected
	 *   across branches exactly once. NOTE: two forks scanning the SAME scan node would
	 *   share one cached vtab instance and thus issue concurrent `query()` calls on it —
	 *   only safe for a module whose `concurrencyMode` permits it. Dormant today:
	 *   ParallelDriver has no query consumers, and the sequential NLJ re-scan this cache
	 *   was built for is never concurrently self-live.)
	 *   (`cacheStates` is the once-per-execution CacheNode row-cache map; shared by
	 *   reference so a cache materialized in one branch is visible to another branch
	 *   that re-drives the same cache site within the same execution, matching the
	 *   pre-fork single-closure cache. Dormant today: ParallelDriver has no query
	 *   consumers.)
	 *   (`cteMaterializations` is the once-per-execution shared CTE buffer map;
	 *   shared by reference so a CTE materialized in one branch replays in a sibling
	 *   branch instead of re-driving the source. Same lazy-creation caveat as
	 *   `executionMemo`: it is created on first materialized-CTE run, so a future
	 *   parallelized query driving CTE references inside forks must eagerly create
	 *   the map on the parent before fork(). Dormant today: ParallelDriver has no
	 *   query consumers.)
	 *   (`inSetProbes` is the once-per-execution uncorrelated-`IN`-subquery lookup-set
	 *   map; shared by reference so a set materialized in one branch is visible to a
	 *   sibling branch re-driving the same IN site within the same execution. Same
	 *   lazy-creation caveat as `executionMemo`. Dormant today: ParallelDriver has no
	 *   query consumers.)
	 *
	 * The parent is treated as immutable for the lifetime of the forks.
	 */
	fork(rctx: RuntimeContext, n: number): RuntimeContext[] {
		if (n < 0 || !Number.isInteger(n)) {
			throw new RangeError(`ParallelDriver.fork: n must be a non-negative integer, got ${n}`);
		}
		const strict = strictForkEnabled();
		const forks: RuntimeContext[] = new Array(n);
		for (let i = 0; i < n; i++) {
			// Fresh per-fork maps. `createStrictRowContextMap()` returns the strict
			// subclass when *either* strict flag is on (so context-strict forks are
			// checkable too) and a vanilla map otherwise. Under fork-strict the map
			// can itself parent sub-forks; the seed loop runs before any sub-fork is
			// active, so the wrapper's guard passes naturally. The seed set()s also
			// initialize the context-strict epoch/winner tables for a post-fork read.
			const childContext = createStrictRowContextMap();
			for (const [desc, getter] of rctx.context.entries()) {
				childContext.set(desc, getter);
			}
			const childTableContextsRaw = new Map(rctx.tableContexts);
			const childTableContexts = strict ? wrapTableContextsStrict(childTableContextsRaw) : childTableContextsRaw;
			forks[i] = {
				db: rctx.db,
				stmt: rctx.stmt,
				params: rctx.params,
				context: childContext,
				tableContexts: childTableContexts,
				tracer: rctx.tracer,
				activeConnection: rctx.activeConnection,
				tableNameRemap: rctx.tableNameRemap,
				enableMetrics: rctx.enableMetrics,
				mutationOrdinal: rctx.mutationOrdinal,
				signal: rctx.signal,
				// Mutex-free committed-read marker: set once at execution start, only
				// ever read afterwards (scan connect options, getVTableConnection
				// assertion), so every branch shares the parent's value as immutable.
				readCommitted: rctx.readCommitted,
				contextTracker: rctx.contextTracker,
				planStack: rctx.planStack,
				executionMemo: rctx.executionMemo,
				scanConnections: rctx.scanConnections,
				cacheStates: rctx.cacheStates,
				cteMaterializations: rctx.cteMaterializations,
				inSetProbes: rctx.inSetProbes,
			};
			if (strict) {
				markForkOf(childTableContexts, rctx.tableContexts);
				markForkOf(childContext, rctx.context);
			}
		}
		return forks;
	}

	/**
	 * Drive `factories` concurrently, each invoked with its paired fork from `forks`,
	 * and yield every produced value as `{ branch, value }` in arrival order.
	 *
	 * Concurrency is capped at `opts.concurrency` (default: `factories.length`); a
	 * new branch is started only when an in-flight branch completes.
	 *
	 * If any branch's iterator throws, the original error is re-raised after every
	 * other in-flight iterator has been best-effort `return()`-closed.
	 *
	 * Cancellation is cooperative via `opts.signal`:
	 * - A pre-aborted signal causes `drive()` to throw before any factory is invoked.
	 * - An abort fired mid-stream interrupts the next race step, then closes branches.
	 *
	 * When the consumer breaks out of the `for-await` loop, the async generator's
	 * `return()` runs the same close-all path on every active branch.
	 */
	drive<T>(
		factories: ReadonlyArray<(ctx: RuntimeContext) => AsyncIterable<T>>,
		forks: ReadonlyArray<RuntimeContext>,
		opts?: ParallelDriveOptions,
	): AsyncIterable<ParallelDriveItem<T>> {
		if (factories.length !== forks.length) {
			throw new RangeError(
				`ParallelDriver.drive: factories.length (${factories.length}) !== forks.length (${forks.length})`,
			);
		}
		return driveImpl(factories, forks, opts);
	}
}

const ABORT_SENTINEL: unique symbol = Symbol('quereus.parallel-driver.abort');
type AbortSentinel = typeof ABORT_SENTINEL;

interface BranchPullResult<T> {
	branch: number;
	result: IteratorResult<T>;
	/** True iff the iterator threw; `error` then carries the thrown value (which may itself be `undefined`). */
	hadError: boolean;
	error: unknown;
}

/**
 * Close a single live source. Two invariants:
 *
 * - **Prompt cancellation.** A source parked mid-`next()` is interrupted via
 *   `return()`, not waited out — matching {@link ParallelDriver.drive}'s
 *   best-effort return()-close contract (and the sibling parallel primitive in
 *   `emit/fanout-lookup-join.ts`). Native async generators queue the `return()`
 *   safely behind the in-flight `next()`; cooperative sources use it to unblock
 *   the parked pull.
 * - **No cleanup racing ahead of an in-flight pull.** After signalling
 *   `return()` we also await the branch's outstanding pull, so the source is
 *   fully quiesced before it is considered closed. The current fault this fixes:
 *   `closeAll` used to await only the `return()`s and discard the in-flight
 *   pulls, letting cleanup resolve while a `next()` it started was still
 *   executing (and possibly still touching cursor/vtab state).
 *
 * All failures (a rejecting `return()` or pull) are settled, never rethrown, so
 * one bad close cannot abort the others.
 *
 * NOTE: awaiting the outstanding pull assumes `return()` causes that pull to
 * settle — true for native generators and any source that honors cancellation.
 * A source that both ignores `return()` and parks its `next()` forever would
 * hang cleanup here rather than leak a runaway pull; that is an acceptable, loud
 * failure for a source already violating the cancellation contract.
 */
async function closeBranch<T>(
	it: AsyncIterator<T>,
	pendingPull: Promise<BranchPullResult<T>> | undefined,
): Promise<void> {
	const settles: Promise<unknown>[] = [];
	if (typeof it.return === 'function') {
		try {
			settles.push(Promise.resolve(it.return()).catch(() => undefined));
		} catch {
			// Synchronous throw from return() — swallow; we are already in cleanup.
		}
	}
	// schedulePull never lets the pull reject, but settle defensively regardless.
	if (pendingPull) settles.push(pendingPull.catch(() => undefined));
	if (settles.length > 0) await Promise.allSettled(settles);
}

async function* driveImpl<T>(
	factories: ReadonlyArray<(ctx: RuntimeContext) => AsyncIterable<T>>,
	forks: ReadonlyArray<RuntimeContext>,
	opts: ParallelDriveOptions | undefined,
): AsyncIterable<ParallelDriveItem<T>> {
	const signal = opts?.signal;

	// Pre-aborted: throw before invoking any factory.
	if (signal?.aborted) {
		throw signalReason(signal);
	}

	if (factories.length === 0) return;

	// Strict-fork bookkeeping (no-op outside strict mode). All forks share the
	// same parent, so reading the first fork's back-reference is sufficient.
	const parentTableState = forks.length > 0 ? bumpParentForkCounter(forks[0].tableContexts) : null;
	const parentRowState = forks.length > 0 ? bumpParentForkCounter(forks[0].context) : null;

	const concurrency = Math.max(1, opts?.concurrency ?? factories.length);
	const branchCount = factories.length;

	type BranchState = 'not-started' | 'pulling' | 'done';
	const iterators: Array<AsyncIterator<T> | null> = new Array(branchCount).fill(null);
	const branchStates: BranchState[] = new Array(branchCount).fill('not-started');
	const pendingPulls = new Map<number, Promise<BranchPullResult<T>>>();

	let nextToStart = 0;
	let activePulling = 0;
	let aborted = false;
	let abortReason: unknown = undefined;

	// Build a never-rejecting promise that resolves to ABORT_SENTINEL on signal abort.
	let onAbort: (() => void) | null = null;
	const abortPromise = new Promise<AbortSentinel>((resolve) => {
		if (!signal) return; // never resolves — fine inside Promise.race
		onAbort = () => {
			if (!aborted) {
				aborted = true;
				abortReason = signalReason(signal);
			}
			resolve(ABORT_SENTINEL);
		};
		signal.addEventListener('abort', onAbort);
	});

	const schedulePull = (i: number): void => {
		if (branchStates[i] === 'done') return;
		const it = iterators[i]!;
		const promise: Promise<BranchPullResult<T>> = (async () => {
			try {
				const result = await it.next();
				return { branch: i, result, hadError: false, error: undefined };
			} catch (error) {
				return {
					branch: i,
					result: { value: undefined as unknown as T, done: true } as IteratorResult<T>,
					hadError: true,
					error,
				};
			}
		})();
		pendingPulls.set(i, promise);
	};

	const startNextBranch = (): void => {
		const i = nextToStart++;
		const factory = factories[i];
		const fork = forks[i];
		const iter = factory(fork)[Symbol.asyncIterator]();
		iterators[i] = iter;
		branchStates[i] = 'pulling';
		activePulling++;
		schedulePull(i);
	};

	const markDone = (i: number): void => {
		if (branchStates[i] !== 'done') {
			branchStates[i] = 'done';
			activePulling--;
		}
	};

	const closeAll = async (): Promise<void> => {
		// Close every still-live source: signal wind-down via return() AND await
		// each branch's outstanding pull (see closeBranch). Capturing the pending
		// pull happens synchronously here, before pendingPulls.clear() below.
		const closingPromises: Promise<unknown>[] = [];
		for (let i = 0; i < branchCount; i++) {
			const it = iterators[i];
			if (it && branchStates[i] !== 'done') {
				markDone(i);
				closingPromises.push(closeBranch(it, pendingPulls.get(i)));
			}
			iterators[i] = null;
		}
		pendingPulls.clear();
		if (closingPromises.length > 0) {
			await Promise.allSettled(closingPromises);
		}
	};

	try {
		// Start the initial wave up to the concurrency cap.
		while (activePulling < concurrency && nextToStart < branchCount) {
			startNextBranch();
		}

		while (pendingPulls.size > 0) {
			const winner = await Promise.race<BranchPullResult<T> | AbortSentinel>([
				abortPromise,
				...pendingPulls.values(),
			]);
			if (winner === ABORT_SENTINEL) throw abortReason;

			const { branch, result, hadError, error } = winner;
			pendingPulls.delete(branch);

			if (hadError) {
				throw error;
			}

			if (result.done) {
				markDone(branch);
				iterators[branch] = null;
				while (activePulling < concurrency && nextToStart < branchCount) {
					startNextBranch();
				}
			} else {
				yield { branch, value: result.value };
				if (branchStates[branch] === 'pulling') {
					schedulePull(branch);
				}
			}
		}
	} finally {
		if (signal && onAbort) {
			signal.removeEventListener('abort', onAbort);
		}
		dropParentForkCounter(parentTableState);
		dropParentForkCounter(parentRowState);
		await closeAll();
	}
}

function signalReason(signal: AbortSignal): unknown {
	const reason = (signal as { reason?: unknown }).reason;
	return reason !== undefined ? reason : new Error('aborted');
}
