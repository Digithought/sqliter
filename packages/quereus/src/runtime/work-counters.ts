import type { OutputValue } from '../common/types.js';
import type { PlanNode } from '../planner/nodes/plan-node.js';
import type { PlanNodeType } from '../planner/nodes/plan-node-type.js';
import type { Scheduler } from './scheduler.js';
import { isAsyncIterable } from './utils.js';

/**
 * Machine-independent work counters for one statement execution.
 *
 * Every number here is a *count* — executions, input values, output rows — chosen
 * because counts come out identical on every machine and every run of the same plan,
 * where timings do not. `elapsedNs` is deliberately absent: putting a nanosecond
 * figure on a surface whose premise is machine-independence invites exactly the
 * cross-machine comparison this surface exists to replace.
 *
 * Instruction identity is a structural program address (see
 * {@link WorkCounterCollector}), never a plan-node id: `PlanNode.id` is a
 * process-global counter, so two runs of the same query in one process get different
 * ids and any id-derived key would diverge immediately.
 */

/** Plan-shape facts, available after compile without executing. */
export interface PlanShape {
	nodeCount: number;
	/** PlanNodeType -> how many plan nodes of that type. Keys sorted. */
	nodeTypes: Record<string, number>;
}

/** JSON-serializable snapshot of one execution's work counters: no bigint, no timings. */
export interface WorkCounterSnapshot {
	/** Plan-shape facts. Available after compile — no execution needed. */
	plan: PlanShape;
	/** One entry per instruction that ran at least once, in program-walk order. */
	instructions: Array<{
		/** Structural address, e.g. `r#12` or `r/12/0#3`. Never contains a plan-node id. */
		key: string;
		/** PlanNodeType, when the instruction came from a plan node. */
		nodeType?: string;
		executions: number;
		in: number;
		out: number;
	}>;
	totals: {
		instructionExecutions: number;
		rowsOut: number;
	};
}

/** Mutable per-instruction counter cell; the scheduler's metrics hooks feed these. */
export interface WorkCounterSlot {
	/** Structural address (`<program-path>#<instruction-index>`); never a plan-node id. */
	readonly key: string;
	/** PlanNodeType stamped by `emitPlanNode`, or undefined for synthetic instructions (emitCall callbacks, fused scalars). */
	readonly nodeType: PlanNodeType | undefined;
	executions: number;
	in: number;
	out: number;
}

/** Marker linking a counting-wrapped iterable back to the slot that wrapped it. */
const COUNTED_ITERABLE_SYMBOL = Symbol('workCountedIterable');

/**
 * Records one instruction output into `slot` and returns the value to park.
 *
 * - An async iterable is wrapped in a counting generator that increments `out` per
 *   yield — the scheduler's `countOutputs` reports 1 for a stream, and a "row count"
 *   that says 1 for every streaming operator is not a row count.
 * - An array adds its length; everything else adds 1 (matching `countOutputs`).
 *
 * The wrap is skipped only when THIS slot already wrapped the iterable: a
 * pass-through iterable re-counted by a *different* instruction's slot is correct
 * double-wrapping (rows flow through both instructions), not a bug. Metrics mode and
 * tracing mode are mutually exclusive in `Scheduler.run()` (metrics wins), so there
 * is no interplay with the tracing wrapper's own marker symbol.
 */
export function recordOutput(slot: WorkCounterSlot, value: OutputValue): OutputValue {
	if (isAsyncIterable(value)) {
		if ((value as unknown as Record<symbol, unknown>)[COUNTED_ITERABLE_SYMBOL] === slot) {
			return value;
		}
		const source = value;
		const wrapped = (async function* () {
			for await (const item of source) {
				slot.out++;
				yield item;
			}
		})();
		(wrapped as unknown as Record<symbol, unknown>)[COUNTED_ITERABLE_SYMBOL] = slot;
		return wrapped;
	}
	if (Array.isArray(value)) {
		slot.out += value.length;
		return value;
	}
	slot.out += 1;
	return value;
}

/**
 * Per-execution collector of work counters for a root scheduler and every
 * sub-program reachable from it.
 *
 * Built once per statement execution (in `Statement._iterateRowsRawInternal`) and
 * carried on the `RuntimeContext` (fork policy `shared-sink`: forks share it by
 * reference, so counts from a forked branch roll up with no merge step). The
 * scheduler's metrics hooks look up their slot array via {@link countersFor} once
 * per program run.
 *
 * Instruction identity is structural: the root program is `r`, and the scheduler at
 * `instructions[i].programs[j]` of program `P` is addressed `P/i/j`; instruction `i`
 * of a program keys as `<path>#<i>`. This depends only on the shape of the compiled
 * plan — never on execution order, which branch ran, or any plan-node id — so two
 * runs of the same plan produce the same keys on any machine.
 *
 * Unlike `Instruction.runtimeStats` (zeroed per program invocation for the debug
 * log), these slots are NEVER reset mid-execution: a correlated subquery's
 * sub-program driven 100 times reports 100 executions of its inner instructions —
 * the number that makes an N+1 regression visible.
 */
export class WorkCounterCollector {
	/** Slot arrays keyed by Scheduler identity — root program and every sub-program. */
	private readonly slots = new Map<Scheduler, WorkCounterSlot[]>();
	/** Every slot in deterministic walk order (each sub-program right after its owning instruction). */
	private readonly walkOrder: WorkCounterSlot[] = [];

	constructor(root: Scheduler) {
		this.walk(root, 'r');
	}

	private walk(scheduler: Scheduler, path: string): void {
		// Defensive: a scheduler reachable via two paths keeps its first path's keys
		// (counters are per Scheduler identity, so both paths report under one key).
		if (this.slots.has(scheduler)) return;
		const programSlots: WorkCounterSlot[] = [];
		this.slots.set(scheduler, programSlots);
		for (let i = 0; i < scheduler.instructions.length; i++) {
			const instruction = scheduler.instructions[i];
			const slot: WorkCounterSlot = {
				key: `${path}#${i}`,
				nodeType: instruction.nodeType,
				executions: 0,
				in: 0,
				out: 0,
			};
			programSlots.push(slot);
			this.walkOrder.push(slot);
			// NOTE: assumes `Instruction.programs` is only ever set by `emitCall`
			// (runtime/emitters.ts), today's single site. The walk stays correct if a
			// future emitter sets it directly — addressing is purely structural — but
			// that emitter's sub-programs silently start being counted here too.
			if (instruction.programs) {
				for (let j = 0; j < instruction.programs.length; j++) {
					this.walk(instruction.programs[j], `${path}/${i}/${j}`);
				}
			}
		}
	}

	/** The slot array for one program, index-aligned with `scheduler.instructions`. */
	countersFor(scheduler: Scheduler): WorkCounterSlot[] | undefined {
		return this.slots.get(scheduler);
	}

	/**
	 * Builds a fresh, by-value snapshot: instructions that never ran are omitted
	 * (a missing snapshot and an all-zero one are different claims — see
	 * `Statement.getWorkCounters`), and totals sum over the included entries only.
	 */
	snapshot(plan: PlanShape): WorkCounterSnapshot {
		const instructions: WorkCounterSnapshot['instructions'] = [];
		let instructionExecutions = 0;
		let rowsOut = 0;
		for (const slot of this.walkOrder) {
			if (slot.executions === 0) continue;
			const entry: WorkCounterSnapshot['instructions'][number] = {
				key: slot.key,
				executions: slot.executions,
				in: slot.in,
				out: slot.out,
			};
			if (slot.nodeType !== undefined) {
				entry.nodeType = slot.nodeType;
			}
			instructions.push(entry);
			instructionExecutions += slot.executions;
			rowsOut += slot.out;
		}
		return {
			plan: { nodeCount: plan.nodeCount, nodeTypes: { ...plan.nodeTypes } },
			instructions,
			totals: { instructionExecutions, rowsOut },
		};
	}
}

/**
 * Counts plan nodes and their types with an iterative walk over `getChildren()` and
 * a visited set — NOT `PlanNode.visit()`, which deliberately visits a DAG node once
 * per *path* and would double-count shared subtrees (inflating `nodeCount`
 * nondeterministically-looking across otherwise-identical plans).
 */
export function computePlanShape(root: PlanNode): PlanShape {
	const visited = new Set<PlanNode>();
	const stack: PlanNode[] = [root];
	const counts = new Map<string, number>();
	let nodeCount = 0;
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (visited.has(node)) continue;
		visited.add(node);
		nodeCount++;
		counts.set(node.nodeType, (counts.get(node.nodeType) ?? 0) + 1);
		for (const child of node.getChildren()) {
			stack.push(child);
		}
	}
	const nodeTypes: Record<string, number> = {};
	for (const key of [...counts.keys()].sort()) {
		nodeTypes[key] = counts.get(key)!;
	}
	return { nodeCount, nodeTypes };
}
