import type { RecursiveCTENode } from '../../planner/nodes/recursive-cte-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitCallFromPlan, emitPlanNode } from '../emitters.js';
import type { MaybePromise, Row, SqlValue } from '../../common/types.js';
import { createLogger } from '../../common/logger.js';
import { BTree } from 'inheritree';
import { compareRows } from '../../util/comparison.js';
import { WorkingTableIterable } from '../../util/working-table-iterable.js';
import { DEFAULT_TUNING } from '../../planner/optimizer-tuning.js';
import { quereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
const log = createLogger('runtime:emit:recursive-cte');

export function emitRecursiveCTE(plan: RecursiveCTENode, ctx: EmissionContext): Instruction {
	// Use the plan's table descriptor for table context coordination
	const { tableDescriptor } = plan;
	const hasLimit = !!plan.limitExpr;
	const hasOffset = !!plan.offsetExpr;

	// Drive the recursion once: base case, then the semi-naïve iterative loop,
	// through the global LIMIT/OFFSET gate. This is the streaming body; the run
	// wrapper either yields it directly (single-reference) or buffers it once and
	// replays per reference (multi-reference — see `plan.materialize`).
	async function* driveRecursion(
		rctx: RuntimeContext,
		baseCaseResult: AsyncIterable<Row>,
		recursiveCaseCallback: (ctx: RuntimeContext) => AsyncIterable<Row>,
		...rest: Array<(ctx: RuntimeContext) => MaybePromise<SqlValue>>
	): AsyncIterable<Row> {
		log('Starting recursive CTE execution for %s (union=%s, algorithm=semi-naive)', plan.cteName, plan.isUnionAll ? 'ALL' : 'DISTINCT');

		// Resolve LIMIT/OFFSET if present
		let argIndex = 0;
		const limitFn = hasLimit ? rest[argIndex++] : undefined;
		const offsetFn = hasOffset ? rest[argIndex++] : undefined;

		const limitValue = limitFn ? await limitFn(rctx) : null;
		const offsetValue = offsetFn ? await offsetFn(rctx) : null;

		let limit = limitValue !== null ? Number(limitValue) : Infinity;
		let offset = offsetValue !== null ? Number(offsetValue) : 0;
		if (limit < 0 || !Number.isFinite(limit)) limit = limit < 0 ? 0 : Infinity;
		if (offset < 0 || !Number.isFinite(offset)) offset = 0;

		// Total rows that need to be generated before limit is satisfied
		const totalNeeded = limit === Infinity ? Infinity : offset + limit;

		// Get configuration - use plan node limit if specified, otherwise use default tuning
		const maxIterations = plan.maxRecursion ?? DEFAULT_TUNING.recursiveCte.maxIterations;

		// Step 1: Initialize deduplication storage (for UNION DISTINCT) and delta tracking
		const allRowsTree = plan.isUnionAll ? null : new BTree<Row, Row>(
			(row: Row) => row, // Identity function - use row as its own key
			compareRows
		);
		let deltaRows: Row[] = [];

		// Counters for global LIMIT/OFFSET enforcement
		let yieldedCount = 0;	// rows actually yielded downstream (post-offset, pre-limit)
		let producedCount = 0;	// rows produced by the recursion (pre-offset)

		// Yields a row through the global offset/limit gate. Returns true if the consumer
		// has not yet hit the limit (i.e., recursion should continue).
		const tryYield = function* (row: Row): Generator<Row, boolean, unknown> {
			producedCount++;
			if (producedCount <= offset) {
				return producedCount < totalNeeded;
			}
			if (yieldedCount >= limit) return false;
			yield row;
			yieldedCount++;
			return yieldedCount < limit;
		};

		// Step 2: Execute base case and populate initial delta
		let continueRecursion = true;
		for await (const row of baseCaseResult) {
			// Yield if we're union all or if the row is new
			const shouldYield = !allRowsTree || allRowsTree.insert(row).on;

			if (shouldYield) {
				const gate = tryYield(row);
				let gateResult = gate.next();
				while (!gateResult.done) {
					yield gateResult.value;
					gateResult = gate.next();
				}
				continueRecursion = gateResult.value;

				// Add to delta for recursive processing (deep copy to avoid reference issues)
				deltaRows.push([...row] as Row);

				if (!continueRecursion) break;
			}
		}

		// Step 3: Semi-naïve iterative recursive execution
		let iterationCount = 0;

		while (continueRecursion && deltaRows.length > 0 && (maxIterations === 0 || iterationCount < maxIterations)) {
			++iterationCount;
			log('Recursive CTE %s iteration %d, delta size: %d', plan.cteName, iterationCount, deltaRows.length);

			// Create a working table iterable from ONLY the delta (not all accumulated rows)
			const deltaIterable = new WorkingTableIterable([...deltaRows]);
			const newDeltaRows: Row[] = []; // Collect rows for next iteration

			// Set up the delta table in context for CTE references to access
			rctx.tableContexts.set(tableDescriptor, () => deltaIterable);
			try {
				// Execute recursive case using the callback - it only sees the delta
				for await (const row of recursiveCaseCallback(rctx)) {
					// For UNION DISTINCT: check if row is new; for UNION ALL: accept all rows
					const shouldYield = !allRowsTree || allRowsTree.insert(row).on;

					if (shouldYield) {
						const gate = tryYield(row);
						let gateResult = gate.next();
						while (!gateResult.done) {
							yield gateResult.value;
							gateResult = gate.next();
						}
						continueRecursion = gateResult.value;

						// Add to next iteration's delta (deep copy to avoid reference issues)
						newDeltaRows.push([...row] as Row);

						if (!continueRecursion) break;
					}
				}
			} finally {
				rctx.tableContexts.delete(tableDescriptor);
			}

			// Update delta for next iteration - only new rows, not accumulated result
			deltaRows = newDeltaRows;
		}

		// Safety check for infinite recursion — only error if we hit the limit
		// while there was still work to do (deltaRows not empty) AND we didn't already satisfy LIMIT
		if (maxIterations > 0 && iterationCount >= maxIterations && deltaRows.length > 0 && continueRecursion) {
			quereusError(
				`Recursive CTE '${plan.cteName}' exceeded maximum iteration limit (${maxIterations})`,
				StatusCode.ERROR
			);
		}

		log('Recursive CTE %s completed after %d iterations (semi-naive algorithm)', plan.cteName, iterationCount);
	}

	async function* run(
		rctx: RuntimeContext,
		baseCaseResult: AsyncIterable<Row>,
		recursiveCaseCallback: (ctx: RuntimeContext) => AsyncIterable<Row>,
		...rest: Array<(ctx: RuntimeContext) => MaybePromise<SqlValue>>
	): AsyncIterable<Row> {
		if (!plan.materialize) {
			// Streaming path: single-reference recursive CTE. Each reference drives
			// its own recursion, and streaming lets an outer LIMIT cut an unbounded
			// recursion off before the iteration guard trips. Only ONE reference
			// exists, so its drive owns the shared working-table `tableDescriptor`
			// uncontended.
			yield* driveRecursion(rctx, baseCaseResult, recursiveCaseCallback, ...rest);
			return;
		}

		// Shared-buffer path: multi-referenced recursive CTE. Two interleaved
		// streaming drives would clobber each other's delta on the shared
		// `tableDescriptor` (the double-reference runaway). Instead drive the
		// recursion exactly once per statement execution into a buffer keyed by that
		// SAME `tableDescriptor`. Earlier optimizer passes duplicate a multi-
		// referenced recursive CTE into distinct RecursiveCTENode instances (distinct
		// plan ids), but every copy preserves the one tableDescriptor identity, so it
		// — not plan.id — is what the references agree on. emitCTE keys the same map
		// the same way, for the same reason.
		const buffers = (rctx.cteMaterializations ??= new Map<typeof tableDescriptor, Promise<Row[]>>());
		let bufferPromise = buffers.get(tableDescriptor);
		if (!bufferPromise) {
			// First reference to run owns the single drive. Create and store the
			// promise SYNCHRONOUSLY (before any await) so a second reference
			// interleaving under a nested-loop join finds it and awaits instead of
			// starting its own drive on the shared `tableDescriptor`. The drive runs
			// detached so it drains independently of how the join pulls — the owner
			// reference can't yield row 1 until the drive finishes, and the drive
			// doesn't depend on downstream pulls, which is what breaks the deadlock.
			// NOTE: like emitCTE, an abandoned drive (every consumer torn down early)
			// still runs to completion in the background; bounded by the recursion's
			// row count and its maxRecursion guard.
			bufferPromise = (async () => {
				const rows: Row[] = [];
				for await (const row of driveRecursion(rctx, baseCaseResult, recursiveCaseCallback, ...rest)) {
					rows.push([...row] as Row);
				}
				return rows;
			})();
			// Pre-attach a no-op rejection handler: if the drive fails after every
			// awaiting reference has detached, the stored promise would otherwise
			// surface an unhandled rejection. Still-awaiting references observe the
			// rejection through their own await.
			bufferPromise.catch(() => { /* observed by awaiting references */ });
			buffers.set(tableDescriptor, bufferPromise);
		}

		const rows = await bufferPromise;
		for (const row of rows) {
			// Copy per consumer so a downstream mutator cannot corrupt another
			// reference's (or a replay's) view of the buffer.
			yield [...row] as Row;
		}
	}

	// Emit both base case and recursive case instructions
	const baseCaseInstruction = emitPlanNode(plan.baseCaseQuery, ctx);
	const recursiveCaseInstruction = emitCallFromPlan(plan.recursiveCaseQuery, ctx);

	const params: Instruction[] = [baseCaseInstruction, recursiveCaseInstruction];
	if (plan.limitExpr) params.push(emitCallFromPlan(plan.limitExpr, ctx));
	if (plan.offsetExpr) params.push(emitCallFromPlan(plan.offsetExpr, ctx));

	return {
		params,
		run: asRun(run),
		note: `recursiveCTE(${plan.cteName})`
	};
}



