import type { RuntimeValue, SqlValue, OutputValue, Row } from "../common/types.js";
import type { Database } from "../core/database.js";
import type { Statement } from "../core/statement.js";
import type { RowDescriptor, TableDescriptor, TableGetter } from "../planner/nodes/plan-node.js";
import type { Scheduler } from "./scheduler.js";
import type { VirtualTableConnection } from "../vtab/connection.js";
import type { VirtualTable } from "../vtab/table.js";
import type { PlanNode } from '../planner/nodes/plan-node.js';
import type { RowContextMap } from './context-helpers.js';
import type { CacheState } from './cache/shared-cache.js';
import type { BTree } from 'inheritree';

// Re-export types from common/types.js for convenience
export type { OutputValue };

export type RuntimeContext = {
	db: Database;
	stmt: Statement | undefined; // Undefined for transient exec statements
	params: Record<number | string, SqlValue>; // Bound args — always a plain object at runtime
	/** Row contexts with O(1) attribute index */
	context: RowContextMap;
	/** Table contexts by table name, used for recursive CTEs or other temporary table situations */
	tableContexts: Map<TableDescriptor, TableGetter>;
	/** Debug tracer for instruction execution, if enabled */
	tracer?: InstructionTracer;
	/** Active connection for the current transaction context */
	activeConnection?: VirtualTableConnection;
	/** Whether to collect runtime execution metrics */
	enableMetrics: boolean;
	/**
	 * Cooperative cancellation signal for the current statement, if the caller
	 * supplied one via `exec`/`eval` options. Honored at row and statement
	 * boundaries (notably the table-scan leaf) so a long-running query can be
	 * interrupted — e.g. on a request timeout. Undefined when no signal was given.
	 */
	signal?: AbortSignal;
	/**
	 * The 1-based ordinal of the row currently being produced within the active
	 * INSERT / mutation-context evaluation, or undefined outside one. Exposed to
	 * the `mutation_ordinal()` builtin so a column `default` can author a per-row
	 * surrogate (the shared-key-via-default case — docs/vu-mutation-context.md
	 * § Mutation Context). Set per row by the INSERT DML executor and by the
	 * shared-surrogate envelope (`runtime/emit/view-mutation.ts`), and saved/
	 * restored around each scope so it never leaks past the statement.
	 */
	mutationOrdinal?: number;
	/** Context tracking for debugging context leaks */
	contextTracker?: ContextTracker;
	/** Stack of currently executing plan nodes (only when tracing enabled) */
	planStack?: PlanNode[];
	/**
	 * Per-execution memo for instructions that must fire exactly once per statement
	 * execution — the impure (DML-bearing) scalar/`IN`/`EXISTS` subquery emitters
	 * store their drained result here, keyed by a unique symbol minted at emit time.
	 * Because a fresh RuntimeContext is built for each execution while the instruction
	 * tree is cached and reused, tying the memo to the context (not the emit-time
	 * closure) makes it reset between prepared-statement runs — so a re-executed
	 * statement re-drives its inner DML, rather than replaying the first run's result.
	 */
	executionMemo?: Map<symbol, { value: SqlValue }>;
	/**
	 * Per-execution cache of connected inner-scan virtual-table instances, keyed by
	 * a stable per-scan-node symbol minted in the {@link emitSeqScan} closure. A
	 * nested-loop join re-scans its (un-cached) inner relation once per outer row;
	 * without this, each re-scan would `module.connect(...)` + `disconnect(...)` the
	 * inner table afresh. The scan connects once per scan-site per execution, reuses
	 * the instance across every re-scan, and statement teardown disconnects each
	 * cached instance exactly once (see core/statement.ts `_iterateRowsRawInternal`).
	 *
	 * Keyed by scan-node identity (not table name) so a self-join's two scan sites
	 * over one table get distinct instances and never share a cursor — the re-scans
	 * of one site are sequential (the NLJ drains each inner cursor before the next
	 * outer row), so a single instance is never concurrently self-live. Absent on the
	 * transient/analysis RuntimeContexts that don't set it — the scan then falls back
	 * to connect-and-disconnect per invocation (correct, just no reuse).
	 */
	scanConnections?: Map<symbol, VirtualTable>;
	/**
	 * Per-execution materialized-row cache state for {@link emitCache}, keyed by a
	 * stable symbol minted in that emitter's closure. A fresh RuntimeContext is
	 * built for each execution while the instruction tree (and the emitter closure
	 * that mints the key) is cached and reused on the prepared Statement, so tying
	 * the cache to the context — not the closure — makes it reset between
	 * prepared-statement runs: a re-executed statement re-drives its cached source
	 * and observes current data instead of replaying the first run's rows. Within
	 * one execution, the same key still resolves to the same {@link CacheState},
	 * so the cache materializes once and replays across re-scans (e.g. per-outer-row
	 * `IN`-subquery evaluation). Mirrors the {@link executionMemo}/{@link scanConnections}
	 * pattern.
	 */
	cacheStates?: Map<symbol, CacheState>;
	/**
	 * Per-execution CTE materialization buffers, keyed by whatever stable identity
	 * the emitter shares across the CTE's references, buffering the CTE's rows
	 * exactly once per statement execution: the first reference to run stores the
	 * buffer promise synchronously and drives the source; every other reference
	 * awaits that same promise and never touches its own (separately-emitted)
	 * source subtree. A fresh RuntimeContext per execution resets the map between
	 * prepared-statement runs (no stale replay). Mirrors {@link cacheStates}.
	 *
	 * Two key kinds coexist here (their key spaces never collide — string vs
	 * object):
	 * - {@link emitCTE} keys by the shared CTENode's plan id (a string); all
	 *   non-recursive references share one CTENode instance, so their closures
	 *   agree on the key.
	 * - {@link emitRecursiveCTE} keys by the shared `TableDescriptor` object. A
	 *   multi-referenced recursive CTE is DUPLICATED into distinct RecursiveCTENode
	 *   instances by earlier optimizer passes (distinct plan ids), but every copy
	 *   preserves the one `tableDescriptor` identity through `withChildren`, so the
	 *   descriptor — not the plan id — is what the copies agree on.
	 */
	cteMaterializations?: Map<string | TableDescriptor, Promise<Row[]>>;
	/**
	 * Per-execution materialized lookup sets for uncorrelated, functional
	 * `x IN (subquery)` probes ({@link import('./emit/subquery.js').emitIn}), keyed
	 * by a stable symbol minted in the emitter closure. The subquery source is
	 * drained exactly once per statement execution into a `BTree` keyed under the
	 * membership collation, then probed per outer row — O(K + N·log K) with zero
	 * statistics, replacing the retired row-cache-plus-linear-scan mechanism. A
	 * fresh RuntimeContext per execution resets the map between prepared-statement
	 * runs, so a re-executed statement re-drains and observes current data.
	 * `hasNull` records whether the inner produced any NULL — needed for
	 * three-valued membership (a miss yields NULL when the inner had a NULL, else
	 * false). Mirrors {@link executionMemo} / {@link cacheStates}.
	 */
	inSetProbes?: Map<symbol, { tree: BTree<SqlValue, SqlValue>; hasNull: boolean }>;
};

export type InstructionRun = (ctx: RuntimeContext, ...args: RuntimeValue[]) => OutputValue;

export type Instruction = {
	params: Instruction[];
	run: InstructionRun;
	/** Optional human-readable note about what this instruction does */
	note?: string;
	/** Optional sub-programs used to execute this instruction - this is here for tracing purposes */
	programs?: Scheduler[];
	/** Optional runtime statistics collected during execution */
	runtimeStats?: InstructionRuntimeStats;
};

/**
 * Adapts an emitter's precisely-typed `run` (e.g.
 * `(ctx, v1: SqlValue, v2: SqlValue) => SqlValue`) to the general
 * {@link InstructionRun} that the scheduler drives every instruction through.
 *
 * A specific `run` is *not* structurally assignable to `InstructionRun`. The
 * scheduler holds instructions generically and calls `run(ctx, ...args)` with
 * every arg widened to `RuntimeValue`, so a function that declares narrower
 * params (`SqlValue`, `AsyncIterable<Row>`, a fixed arity) is rejected by
 * parameter contravariance under `strictFunctionTypes` — exactly as it would be
 * if a caller passed more, fewer, or differently-typed args. Each emitter
 * therefore has to assert the conversion. This helper is the single audited home
 * for that assertion: emit sites write `run: asRun(run)` and the only
 * `as`-to-`InstructionRun` in the runtime lives here.
 *
 * `TArgs` is inferred from the `run`'s own parameter tuple, so each emit site is
 * still checked: every declared arg must be a {@link RuntimeValue} and the return
 * must be an {@link OutputValue}. Only the arity/contravariance mismatch is
 * waived. Two consequences for `run` authors:
 * - An **optional** param (`cb?: SubProgram`) types as `SubProgram | undefined`, and
 *   `undefined` is not a `RuntimeValue` — a `run` whose trailing params are
 *   conditionally emitted must declare them as a rest tuple (`...cb: SubProgram[]`),
 *   which is also the truthful description of its call sites.
 * - `Promise<OutputValue>` is a promise-of-a-promise and is *not* an `OutputValue`.
 *   An `async` `run` returns `Promise<RuntimeValue>`.
 *
 * NOTE: the per-arg checking is only as strong as `TArgs` inferring a real tuple. A
 * `run` declared `(ctx, ...args: RuntimeValue[])` infers `TArgs = RuntimeValue[]` — the
 * constraint itself — so that emit site is accepted unchecked. That is intentional for
 * the genuinely variadic emitters (`emit/block.ts`, `emit/view-mutation.ts`), but it is
 * also the escape hatch a future author reaches for to silence one of the two errors
 * above. If you widen a `run`'s params to shut up `tsc`, you have opted that emitter
 * out of checking, not fixed it.
 */
export function asRun<TArgs extends RuntimeValue[]>(
	run: (ctx: RuntimeContext, ...args: TArgs) => OutputValue
): InstructionRun {
	return run as unknown as InstructionRun;
}

/**
 * Runtime statistics for instruction execution
 */
export interface InstructionRuntimeStats {
	/** Number of input values/rows processed */
	in: number;
	/** Number of output values/rows produced */
	out: number;
	/** Total execution time in nanoseconds */
	elapsedNs: bigint;
	/** Number of times this instruction was executed */
	executions: number;
}

/** * Trace event for instruction execution. */
export interface InstructionTraceEvent {
	instructionIndex: number;
	note?: string;
	type: 'input' | 'output' | 'row' | 'error';
	timestamp: number;
	args?: RuntimeValue[];
	result?: OutputValue;
	error?: string;
	/** Information about sub-programs if this instruction has any */
	subPrograms?: SubProgramInfo[];
	/** Row index within the async iterable (for 'row' type events) */
	rowIndex?: number;
	/** Row data (for 'row' type events) */
	row?: Row;
}

/** Information about a sub-program for tracing purposes */
export interface SubProgramInfo {
	programIndex: number;
	instructionCount: number;
	rootNote?: string;
}

/** * Interface for tracing instruction execution. */
export interface InstructionTracer {
	/** Called before an instruction executes */
	traceInput(instructionIndex: number, instruction: Instruction, args: RuntimeValue[]): void;
	/** Called after an instruction executes */
	traceOutput(instructionIndex: number, instruction: Instruction, result: OutputValue): void;
	/** Called when an instruction throws an error */
	traceError(instructionIndex: number, instruction: Instruction, error: Error): void;
	/** Called for each row emitted by an async iterable instruction */
	traceRow(instructionIndex: number, instruction: Instruction, rowIndex: number, row: Row): void;
	/** Gets collected trace events (if supported by the tracer) */
	getTraceEvents?(): InstructionTraceEvent[];
	/** Gets information about all sub-programs encountered during tracing */
	getSubPrograms?(): Map<number, { scheduler: Scheduler; parentInstructionIndex: number }>;
}

/** * Tracer that collects execution events for later analysis. */
export class CollectingInstructionTracer implements InstructionTracer {
	private events: InstructionTraceEvent[] = [];
	private subPrograms = new Map<number, { scheduler: Scheduler; parentInstructionIndex: number }>();
	private nextSubProgramId = 0;

	traceInput(instructionIndex: number, instruction: Instruction, args: RuntimeValue[]): void {
		const subPrograms = this.collectSubProgramInfo(instructionIndex, instruction);

		this.events.push({
			instructionIndex,
			note: instruction.note,
			type: 'input',
			timestamp: Date.now(),
			args: this.cloneArgs(args),
			subPrograms
		});
	}

	traceOutput(instructionIndex: number, instruction: Instruction, result: OutputValue): void {
		this.events.push({
			instructionIndex,
			note: instruction.note,
			type: 'output',
			timestamp: Date.now(),
			result: this.cloneResult(result)
		});
	}

	traceError(instructionIndex: number, instruction: Instruction, error: Error): void {
		this.events.push({
			instructionIndex,
			note: instruction.note,
			type: 'error',
			timestamp: Date.now(),
			error: error.message
		});
	}

	traceRow(instructionIndex: number, instruction: Instruction, rowIndex: number, row: Row): void {
		this.events.push({
			instructionIndex,
			note: instruction.note,
			type: 'row',
			timestamp: Date.now(),
			rowIndex,
			row
		});
	}

	getTraceEvents(): InstructionTraceEvent[] {
		return [...this.events];
	}

	getSubPrograms(): Map<number, { scheduler: Scheduler; parentInstructionIndex: number }> {
		return new Map(this.subPrograms);
	}

	clear(): void {
		this.events = [];
		this.subPrograms.clear();
		this.nextSubProgramId = 0;
	}

	private collectSubProgramInfo(instructionIndex: number, instruction: Instruction): SubProgramInfo[] | undefined {
		if (!instruction.programs || instruction.programs.length === 0) {
			return undefined;
		}

		return instruction.programs.map(scheduler => {
			const programId = this.nextSubProgramId++;
			this.subPrograms.set(programId, { scheduler, parentInstructionIndex: instructionIndex });

			return {
				programIndex: programId,
				instructionCount: scheduler.instructions.length,
				rootNote: scheduler.instructions[scheduler.instructions.length - 1]?.note
			};
		});
	}

	private cloneArgs(args: RuntimeValue[]): RuntimeValue[] {
		return args.map(arg => this.cloneValue(arg));
	}

	private cloneResult(result: OutputValue): OutputValue {
		if (result instanceof Promise) {
			return result.then(resolved => this.cloneValue(resolved as RuntimeValue));
		}
		return this.cloneValue(result as RuntimeValue);
	}

	private cloneValue(value: RuntimeValue): RuntimeValue {
		if (value === null || value === undefined) return value;
		if (typeof value === 'function') return '[Function]';
		if (typeof value === 'object' && value && Symbol.asyncIterator in value) return '[AsyncIterable]';
		if (Array.isArray(value)) return value.map(v => this.cloneValue(v as RuntimeValue)) as RuntimeValue;
		if (typeof value === 'object') return '[Object]';
		return value as RuntimeValue;
	}
}

/**
 * Tracks context additions and removals for debugging context leaks
 */
export interface ContextTracker {
	/** Record that a context was added */
	addContext(descriptor: RowDescriptor, source: string): void;
	/** Record that a context was removed */
	removeContext(descriptor: RowDescriptor): void;
	/** Get all remaining contexts with their sources */
	getRemainingContexts(): Array<{ descriptor: RowDescriptor; source: string }>;
	/** Check if there are any remaining contexts */
	hasRemainingContexts(): boolean;
}

/**
 * Default implementation of ContextTracker
 */
export class DefaultContextTracker implements ContextTracker {
	private contexts = new Map<RowDescriptor, string>();

	addContext(descriptor: RowDescriptor, source: string): void {
		this.contexts.set(descriptor, source);
	}

	removeContext(descriptor: RowDescriptor): void {
		this.contexts.delete(descriptor);
	}

	getRemainingContexts(): Array<{ descriptor: RowDescriptor; source: string }> {
		return Array.from(this.contexts.entries()).map(([descriptor, source]) => ({
			descriptor,
			source
		}));
	}

	hasRemainingContexts(): boolean {
		return this.contexts.size > 0;
	}
}
