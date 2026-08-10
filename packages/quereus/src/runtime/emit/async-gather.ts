import type { AsyncGatherNode } from '../../planner/nodes/async-gather-node.js';
import type { EmissionContext } from '../emission-context.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import type { Row } from '../../common/types.js';
import { emitCallFromPlan } from '../emitters.js';
import { ParallelDriver } from '../parallel-driver.js';
import { BTree } from 'inheritree';
import { createCollationRowComparator, BINARY_COLLATION } from '../../util/comparison.js';

/** Branch factory: invoked with a forked RuntimeContext, returns an async row stream. */
export type AsyncGatherFactory = (innerCtx: RuntimeContext) => AsyncIterable<Row>;

/**
 * Yield the N-ary Cartesian product of the given per-branch row buffers, in
 * lexicographic order over branch indices (branch 0 varies slowest). Caller
 * is responsible for confirming every buffer is non-empty; an empty buffer
 * means the product is empty and this helper should not be called.
 *
 * Exported for unit testing.
 */
export function* cartesianProduct(buffers: readonly Row[][]): Generator<Row> {
	const n = buffers.length;
	const indices = new Array<number>(n).fill(0);
	while (true) {
		const row: Row = [];
		for (let i = 0; i < n; i++) {
			const sub = buffers[i][indices[i]];
			for (let j = 0; j < sub.length; j++) {
				row.push(sub[j]);
			}
		}
		yield row;
		let k = n - 1;
		while (k >= 0) {
			indices[k]++;
			if (indices[k] < buffers[k].length) break;
			indices[k] = 0;
			k--;
		}
		if (k < 0) return;
	}
}

/**
 * Async-iterate the `unionAll` shape: fork N child views off `rctx`, drive
 * the factories concurrently via {@link ParallelDriver.drive}, and yield every
 * produced row in arrival order. Yielded order is non-deterministic.
 *
 * Exported for unit testing — production callers go through {@link emitAsyncGather}.
 */
export async function* runUnionAll(
	rctx: RuntimeContext,
	factories: ReadonlyArray<AsyncGatherFactory>,
	concurrencyCap: number,
	driver: ParallelDriver = new ParallelDriver(),
): AsyncIterable<Row> {
	const forks = driver.fork(rctx, factories.length);
	for await (const { value } of driver.drive(factories, forks, { concurrency: concurrencyCap })) {
		yield value;
	}
}

/**
 * Async-iterate the `crossProduct` shape: fork N child views off `rctx`,
 * drive the factories concurrently, buffer every branch's rows in memory,
 * then yield the full N-ary Cartesian product. **Every branch is drained
 * before the first row is yielded.** If any branch is empty, the product
 * is empty.
 *
 * Exported for unit testing — production callers go through {@link emitAsyncGather}.
 */
export async function* runCrossProduct(
	rctx: RuntimeContext,
	factories: ReadonlyArray<AsyncGatherFactory>,
	concurrencyCap: number,
	driver: ParallelDriver = new ParallelDriver(),
): AsyncIterable<Row> {
	const n = factories.length;
	const forks = driver.fork(rctx, n);
	const buffers: Row[][] = Array.from({ length: n }, () => []);
	for await (const { branch, value } of driver.drive(factories, forks, {
		concurrency: concurrencyCap,
	})) {
		buffers[branch].push(value);
	}
	for (let i = 0; i < n; i++) {
		if (buffers[i].length === 0) return;
	}
	yield* cartesianProduct(buffers);
}

/** BTree entry for {@link runZipByKey}: the key tuple plus a per-branch row slot. */
interface ZipEntry {
	readonly key: Row;
	/** Length N; `cells[b]` is branch b's row for this key, or undefined if absent. */
	readonly cells: (Row | undefined)[];
}

/**
 * Compose the merged key cells for a group **deterministically**: the
 * lowest-indexed branch that has a row for this key supplies all K key cells.
 *
 * This matches `coalesce(b0.k, b1.k, …)`'s left-to-right first-non-null
 * contract: every branch present for a (non-NULL) key has all its key columns
 * non-null and collation-equal to the group key, so the first present branch
 * wins every key position — independent of concurrent arrival order. Callers
 * guarantee at least one branch is present.
 */
function composeMergedKeyCells(
	cells: readonly (Row | undefined)[],
	branchKeyIndices: readonly (readonly number[])[],
): Row {
	for (let b = 0; b < cells.length; b++) {
		const cell = cells[b];
		if (cell) return branchKeyIndices[b].map(ix => cell[ix]);
	}
	// Unreachable: a group always has at least one present branch.
	return [];
}

/**
 * Compose one output row from a key tuple and per-branch row slots:
 * `[ key cells ] ++ for each branch b: (cells[b] ? its non-key cells : NULLs)`.
 */
function composeZipRow(
	keyCells: Row,
	cells: readonly (Row | undefined)[],
	branchNonKeyIndices: readonly (readonly number[])[],
): Row {
	const out: Row = [...keyCells];
	for (let b = 0; b < cells.length; b++) {
		const cell = cells[b];
		const nonKeyIx = branchNonKeyIndices[b];
		if (cell) {
			for (const ix of nonKeyIx) out.push(cell[ix]);
		} else {
			for (let j = 0; j < nonKeyIx.length; j++) out.push(null);
		}
	}
	return out;
}

/**
 * Async-iterate the `zipByKey` shape: a full N-way outer join on the shared key
 * columns, implemented as an **eager hash-merge**. Forks N child views off
 * `rctx`, drives the factories concurrently, and upserts each row into a `BTree`
 * keyed by its key tuple. **Every branch is drained before the first row is
 * yielded** (memory-bound, like {@link runCrossProduct}).
 *
 * NULL keys never merge (SQL `NULL = NULL` is unknown): each NULL-keyed row is
 * buffered and emitted standalone (only its own branch's columns populated).
 *
 * The merged key cells are **deterministic** regardless of concurrent branch
 * arrival order: at emit time the lowest-indexed present branch supplies them
 * (see {@link composeMergedKeyCells}), matching `coalesce`'s left-to-right pick
 * even under a non-binary collation that makes collation-equal keys byte-distinct
 * (NOCASE `'A'`/`'a'`). The `BTree` is still keyed by whichever key tuple arrived
 * first, but that only drives comparison (collation-equal → identical merges).
 *
 * Within-branch duplicate keys are **unspecified** in v1 — branches are assumed
 * key-unique; a second write for the same key overwrites the first.
 *
 * Exported for unit testing — production callers go through {@link emitAsyncGather}.
 */
export async function* runZipByKey(
	rctx: RuntimeContext,
	factories: ReadonlyArray<AsyncGatherFactory>,
	branchKeyIndices: readonly (readonly number[])[],
	branchNonKeyIndices: readonly (readonly number[])[],
	keyComparator: (a: Row, b: Row) => number,
	concurrencyCap: number,
	driver: ParallelDriver = new ParallelDriver(),
): AsyncIterable<Row> {
	const n = factories.length;
	const forks = driver.fork(rctx, n);
	const tree = new BTree<Row, ZipEntry>(e => e.key, keyComparator);
	const nullKeyed: { branch: number; value: Row }[] = [];

	for await (const { branch, value } of driver.drive(factories, forks, { concurrency: concurrencyCap })) {
		const keyRow: Row = branchKeyIndices[branch].map(ix => value[ix]);
		if (keyRow.some(v => v === null)) {
			// NULL key: never merges; emit standalone at the end.
			nullKeyed.push({ branch, value });
			continue;
		}
		const path = tree.find(keyRow);
		if (path.on) {
			tree.at(path)!.cells[branch] = value;
		} else {
			const cells = new Array<Row | undefined>(n).fill(undefined);
			cells[branch] = value;
			tree.insert({ key: keyRow, cells });
		}
	}

	// Walk the tree in key order; the tree is no longer mutated, so a plain
	// first()/moveNext() walk is safe (no safeIterate recovery needed).
	const path = tree.first();
	while (path.on) {
		const entry = tree.at(path)!;
		const keyCells = composeMergedKeyCells(entry.cells, branchKeyIndices);
		yield composeZipRow(keyCells, entry.cells, branchNonKeyIndices);
		tree.moveNext(path);
	}

	// NULL-keyed rows: each emits standalone with only its branch's columns.
	for (const { branch, value } of nullKeyed) {
		const cells = new Array<Row | undefined>(n).fill(undefined);
		cells[branch] = value;
		const keyCells = composeMergedKeyCells(cells, branchKeyIndices);
		yield composeZipRow(keyCells, cells, branchNonKeyIndices);
	}
}

/**
 * Emit an {@link AsyncGatherNode}.
 *
 * - `unionAll`: drives every branch concurrently and yields each branch's
 *   rows in arrival order (multiset union, no dedup). Downstream consumers
 *   requiring ordering must wrap the gather in `Sort`.
 *
 * - `crossProduct`: drives every branch concurrently, buffers each branch's
 *   rows in memory, then yields the full N-ary Cartesian product. **All
 *   branches are materialised before the first row is yielded.**
 *
 * - `zipByKey`: drives every branch concurrently, hash-merges rows by key tuple,
 *   then yields one composed row per distinct key (full N-way outer join).
 *   **All branches are materialised before the first row is yielded.**
 *
 * All combinators inherit cancellation, error propagation, strict-fork
 * bookkeeping, and consumer-break cleanup from `ParallelDriver.drive`.
 */
export function emitAsyncGather(plan: AsyncGatherNode, ctx: EmissionContext): Instruction {
	const childInstructions: Instruction[] = plan.children.map(c => emitCallFromPlan(c, ctx));
	const concurrencyCap = plan.concurrencyCap;
	const branchCount = plan.children.length;

	if (plan.combinator.kind === 'unionAll') {
		function run(
			rctx: RuntimeContext,
			...childFactories: AsyncGatherFactory[]
		): AsyncIterable<Row> {
			return runUnionAll(rctx, childFactories, concurrencyCap);
		}
		return {
			params: childInstructions,
			run: asRun(run),
			note: `async_gather(unionAll, N=${branchCount}, cap=${concurrencyCap})`,
		};
	}

	if (plan.combinator.kind === 'zipByKey') {
		const { branchKeyIndices, branchNonKeyIndices } = plan.getZipByKeyIndices();
		// Build the key comparator from children[0]'s key column collations (key
		// columns share affinity across branches per the construction contract).
		const child0Attrs = plan.children[0].getAttributes();
		const keyCollations = branchKeyIndices[0].map((colIx) => {
			const attr = child0Attrs[colIx];
			return attr.type.collationName ? ctx.resolveCollation(attr.type.collationName) : BINARY_COLLATION;
		});
		const keyComparator = createCollationRowComparator(keyCollations);

		function run(
			rctx: RuntimeContext,
			...childFactories: AsyncGatherFactory[]
		): AsyncIterable<Row> {
			return runZipByKey(rctx, childFactories, branchKeyIndices, branchNonKeyIndices, keyComparator, concurrencyCap);
		}
		return {
			params: childInstructions,
			run: asRun(run),
			note: `async_gather(zipByKey, N=${branchCount}, cap=${concurrencyCap})`,
		};
	}

	function run(
		rctx: RuntimeContext,
		...childFactories: AsyncGatherFactory[]
	): AsyncIterable<Row> {
		return runCrossProduct(rctx, childFactories, concurrencyCap);
	}
	return {
		params: childInstructions,
		run: asRun(run),
		note: `async_gather(crossProduct, N=${branchCount}, cap=${concurrencyCap})`,
	};
}
