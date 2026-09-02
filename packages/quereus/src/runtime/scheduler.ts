import type { Instruction, RuntimeContext, InstructionRuntimeStats } from "./types.js";
import type { OutputValue, RuntimeValue, Row } from "../common/types.js";
import { isAsyncIterable } from "./utils.js";
import { hrtimeNs } from "../util/hrtime.js";
import { createLogger } from "../common/logger.js";
import { DefaultContextTracker } from './types.js';
import { recordOutput, type WorkCounterSlot } from './work-counters.js';

const log = createLogger('runtime:metrics');
const contextLog = createLogger('runtime:context');

type ResultDestination = number | null;

/** Symbol to mark wrapped iterables to prevent double-wrapping */
const TRACED_ITERABLE_SYMBOL = Symbol('tracedIterable');

/**
 * Wraps an async iterable to emit row-level trace events
 */
function wrapIterableForTracing<T>(
	src: AsyncIterable<T>,
	ctx: RuntimeContext,
	address: number,
	instruction: Instruction
): AsyncIterable<T> {
	// Prevent double-wrapping
	if ((src as unknown as Record<symbol, boolean>)[TRACED_ITERABLE_SYMBOL]) {
		return src;
	}

	const tracer = ctx.tracer!;
	const wrapped = (async function* () {
		let rowIndex = 0;
		for await (const row of src) {
			// Only emit row trace events for valid rows (non-empty arrays)
			if (Array.isArray(row) && row.length > 0) {
				tracer.traceRow(address, instruction, rowIndex++, row as Row);
			}
			yield row;
		}
	})();

	// Mark as already wrapped
	(wrapped as unknown as Record<symbol, boolean>)[TRACED_ITERABLE_SYMBOL] = true;
	return wrapped;
}

/**
 * Per-mode seam that parameterizes the two dispatch loops (a synchronous entry
 * loop and its async continuation). Optimized mode supplies only
 * `runInstruction`; tracing and metrics layer their extra behavior in through the
 * optional hooks. The point of the seam is that the core dispatch — and, in the
 * async loop, the sweep-on-throw that drains abandoned promises — lives in
 * exactly one place instead of being copy-pasted per mode.
 */
interface RunHooks {
	/** Runs once before the first instruction (metrics: initialize per-instruction stats). */
	onStart?(): void;
	/** Runs once on normal completion only — never on throw (metrics: log aggregate stats). */
	onComplete?(): void;
	/** Runs before each instruction, with its resolved args (tracing: trace input). */
	onInput?(index: number, instruction: Instruction, args: RuntimeValue[]): void;
	/**
	 * Runs the instruction. Metrics wraps timing/counting around the call here;
	 * `index` lets it address the instruction's work-counter slot (optimized and
	 * tracing modes ignore it).
	 */
	runInstruction(index: number, instruction: Instruction, ctx: RuntimeContext, args: RuntimeValue[]): OutputValue;
	/**
	 * Post-processes a non-promise output in the synchronous entry loop (tracing:
	 * wrap async iterables + trace); returns the value to park. Only ever called
	 * with a non-promise `output` — the sync loop hands off to the async loop the
	 * instant an instruction returns a promise.
	 */
	onSyncOutput?(index: number, instruction: Instruction, output: OutputValue): OutputValue;
	/**
	 * Post-processes an output in the async loop; returns the value to park (which
	 * may still be a promise, for deferred awaiting at the destination). Tracing
	 * awaits promise outputs eagerly so trace events are ordered by settlement, and
	 * wraps async iterables; optimized/metrics omit this hook and defer awaiting to
	 * the consuming instruction's `Promise.all`.
	 */
	onAsyncOutput?(index: number, instruction: Instruction, output: OutputValue): OutputValue | Promise<OutputValue>;
	/** Runs when an instruction throws (tracing: trace error). The loop re-throws. */
	onError?(index: number, instruction: Instruction, error: unknown): void;
}

export class Scheduler {
	readonly instructions: Instruction[] = [];
	/** Index of the instruction that consumes the output of each instruction. */
	readonly destinations: ResultDestination[];
	/** Local indices of the instructions producing each instruction's arguments, in param order. */
	private readonly argIndexes: number[][] = [];

	/**
	 * Instruction count of this scheduler plus every program nested under it.
	 * Computable in the constructor because emission is bottom-up: `emitCall` has
	 * already built (and attached, via `instruction.programs`) every nested
	 * scheduler by the time this one is constructed.
	 */
	readonly totalInstructionCount: number;

	/**
	 * First global address occupied by this scheduler; meaningful only once
	 * {@link ensureAddressesAssigned} has run on the root of the program tree.
	 */
	private base = 0;
	private addressesAssigned = false;

	constructor(root: Instruction) {
		const buildPlan = (inst: Instruction): number => {
			const instArgIndexes = inst.params.map(p => buildPlan(p));
			const currentIndex = this.instructions.push(inst) - 1;
			this.argIndexes[currentIndex] = instArgIndexes;
			return currentIndex;
		};

		buildPlan(root);

		this.destinations = new Array<ResultDestination>(this.instructions.length).fill(null);

		let total = this.instructions.length;
		for (let instIndex = 0; instIndex < this.instructions.length; ++instIndex) {
			const instArgIndexes = this.argIndexes[instIndex];
			if (instArgIndexes) {
				for (let argIndex = 0; argIndex < instArgIndexes.length; ++argIndex) {
					this.destinations[instArgIndexes[argIndex]] = instIndex;
				}
			}
			const programs = this.instructions[instIndex].programs;
			if (programs) {
				for (const program of programs) {
					total += program.totalInstructionCount;
				}
			}
		}
		this.totalInstructionCount = total;
	}

	// --- Instruction addressing -------------------------------------------------
	//
	// A query's instructions live in a *tree* of schedulers: the root program plus
	// one nested `Scheduler` per `emitCall` (the only place `instruction.programs`
	// is set, so every nested scheduler has exactly one owner). Each scheduler
	// numbers its own instructions from 0, which is all the dispatch loops need —
	// but two different schedulers then both have an instruction "1", and any
	// consumer that joins on that number (`execution_trace()` joining trace events
	// against the `scheduler_program()` listing) conflates them.
	//
	// So the tree gets one flat address space, depth-first and deterministic from
	// the instruction tree alone:
	//
	//   a scheduler with base B and N own instructions occupies
	//     B .. B+N-1                 its own instructions, in scheduler order
	//     then, in order of (owning instruction index, program index),
	//     each nested program takes the next block of its own totalInstructionCount
	//
	// Addresses are assigned lazily and only on the tracing path: normal execution
	// (the optimized and metrics dispatch loops) never needs them and must not pay
	// for them.

	/** Global address of local instruction `index` within the whole program tree. */
	addressOf(index: number): number {
		return this.base + index;
	}

	/** First global address of this scheduler's own instructions. */
	get baseAddress(): number {
		return this.base;
	}

	/** Global addresses of the instructions producing local instruction `index`'s arguments. */
	dependencyAddressesOf(index: number): number[] {
		return (this.argIndexes[index] ?? []).map(argIndex => this.addressOf(argIndex));
	}

	/**
	 * Assigns global addresses across this scheduler and everything nested under
	 * it, treating this scheduler as the root of the address space. Idempotent, and
	 * memoized so a cached scheduler pays it once.
	 *
	 * A nested scheduler never has to assign for itself: its root always runs
	 * first and stamps it on the way through, so the no-op guard below is what its
	 * own tracing-path call hits.
	 */
	ensureAddressesAssigned(): void {
		if (this.addressesAssigned) return;
		this.assignAddresses(0);
	}

	/** Stamps `base` on this scheduler and its nested programs; returns the next free address. */
	private assignAddresses(base: number): number {
		this.base = base;
		this.addressesAssigned = true;
		let next = base + this.instructions.length;
		for (const instruction of this.instructions) {
			if (!instruction.programs) continue;
			for (const program of instruction.programs) {
				next = program.assignAddresses(next);
			}
		}
		return next;
	}

	run(ctx: RuntimeContext): OutputValue {
		// Initialize context tracker if not already present
		if (!ctx.contextTracker) {
			ctx.contextTracker = new DefaultContextTracker();
		}

		let result: OutputValue;

		if (ctx.enableMetrics) {
			result = this.runSyncLoop(ctx, this.metricsHooks(ctx));
		} else if (!ctx.tracer) {
			result = this.runSyncLoop(ctx, this.optimizedHooks());
		} else {
			// Tracing is the only mode whose events are joined against an instruction
			// listing, so it is the only mode that pays for global addressing.
			this.ensureAddressesAssigned();
			result = this.runSyncLoop(ctx, this.tracingHooks(ctx));
		}

		// Context-leak diagnostic. A program's result is frequently an unconsumed
		// Promise or AsyncIterable — row/table contexts are opened and closed *during*
		// iteration (e.g. a scan's row slot closes in the generator's `finally`), so
		// checking synchronously here fires before any leak could occur and reports
		// false positives (or misses real leaks entirely). Defer the check to
		// settlement, and only when the context logger is enabled so production runs
		// pay nothing for a debug-only diagnostic.
		if (contextLog.enabled) {
			return this.checkContextLeaksOnSettle(ctx, result);
		}

		return result;
	}

	/**
	 * Run the context-leak check once `result` has settled: after a Promise
	 * resolves/rejects, or after an AsyncIterable is fully drained. A synchronous
	 * result is checked immediately. Only invoked when `contextLog.enabled`.
	 */
	private checkContextLeaksOnSettle(ctx: RuntimeContext, result: OutputValue): OutputValue {
		const check = (): void => {
			if (ctx.context.size > 0 || ctx.tableContexts.size > 0) {
				contextLog('Context leak detected - remaining row contexts: %d, table contexts: %d', ctx.context.size, ctx.tableContexts.size);
			}
			if (ctx.contextTracker && ctx.contextTracker.hasRemainingContexts()) {
				const remaining = ctx.contextTracker.getRemainingContexts();
				contextLog('Context tracker recorded remaining contexts: %O', remaining.map(c => c.source));
			}
		};

		if (isAsyncIterable<Row>(result)) {
			const iterable: AsyncIterable<Row> = result;
			return (async function* (): AsyncIterable<Row> {
				try {
					for await (const row of iterable) {
						yield row;
					}
				} finally {
					check();
				}
			})();
		}

		if (result instanceof Promise) {
			return result.finally(check);
		}

		check();
		return result;
	}

	/**
	 * Synchronous entry loop, shared by all three modes via {@link RunHooks}. Runs
	 * instructions in linearized order until one returns a promise, then hands the
	 * remainder to {@link runAsyncLoop}. Because it bails to the async loop the
	 * instant an output is a promise, `instrArgs` here never holds a promise — so
	 * there is nothing to sweep on a throw, and none is done.
	 */
	private runSyncLoop(ctx: RuntimeContext, hooks: RunHooks): OutputValue {
		hooks.onStart?.();

		// Argument lists for each instruction.
		const instrArgs = new Array(this.instructions.length).fill(null).map(() => [] as OutputValue[] | undefined);
		// Running output
		let output: OutputValue | undefined;

		// Run synchronously until we hit a promise
		for (let i = 0; i < this.instructions.length; ++i) {
			const instruction = this.instructions[i];
			const args = instrArgs[i]!;	// Guaranteed not to contain promises
			instrArgs[i] = undefined; // Clear args as we go to minimize memory usage.

			hooks.onInput?.(i, instruction, args as RuntimeValue[]);

			try {
				output = hooks.runInstruction(i, instruction, ctx, args as RuntimeValue[]);

				// If the instruction returned a promise, switch to async mode for the rest.
				if (output instanceof Promise) {
					return this.runAsyncLoop(ctx, instrArgs, i, output, hooks);
				}

				if (hooks.onSyncOutput) {
					output = hooks.onSyncOutput(i, instruction, output);
				}
			} catch (error) {
				hooks.onError?.(i, instruction, error);
				throw error;
			}

			// Store synchronous output
			const destination = this.destinations[i];
			if (destination !== null) {
				instrArgs[destination]!.push(output);
			}
		}

		hooks.onComplete?.();

		return output as OutputValue;
	}

	/**
	 * Async continuation loop, shared by all three modes. Instruction outputs feed
	 * later instructions by parking in `instrArgs[destination]` until the
	 * destination runs; while the query runs asynchronously, some parked args are
	 * still-pending promises.
	 *
	 * The bug this guards against: if an instruction throws *before* the
	 * destination that would await a parked promise runs, that promise would be
	 * abandoned — never awaited, never handled — and under strict rejection
	 * handling an ordinary query error escalates into a process-fatal unhandled
	 * rejection. The outer try/catch sweeps every remaining parked promise on any
	 * throw (see {@link sweepAbandonedPromises}) and re-throws the original error.
	 */
	private async runAsyncLoop(
		ctx: RuntimeContext,
		instrArgs: (OutputValue[] | undefined)[],
		startIndex: number,
		pendingOutput: OutputValue,
		hooks: RunHooks
	): Promise<RuntimeValue> {
		// Instruction indexes that have promise arguments
		const hasPromise: boolean[] = [];

		let output: OutputValue | undefined;

		try {
			// Handle the transition instruction's output (always a promise here).
			const startInstruction = this.instructions[startIndex];
			output = hooks.onAsyncOutput
				? await hooks.onAsyncOutput(startIndex, startInstruction, pendingOutput)
				: pendingOutput;

			// Store the output from the transition instruction. The transition output
			// is always deferred to its destination (parked, then awaited via
			// Promise.all), matching every pre-collapse async loop.
			const transitionDestination = this.destinations[startIndex];
			if (transitionDestination !== null) {
				instrArgs[transitionDestination]!.push(output);
				hasPromise[transitionDestination] = true;
			}

			// Continue with remaining instructions asynchronously
			for (let i = startIndex + 1; i < this.instructions.length; ++i) {
				const instruction = this.instructions[i];
				let args = instrArgs[i]!;
				instrArgs[i] = undefined;

				// Resolve any promise arguments
				if (hasPromise[i]) {
					args = await Promise.all(args);
				}

				hooks.onInput?.(i, instruction, args as RuntimeValue[]);

				try {
					output = hooks.runInstruction(i, instruction, ctx, args as RuntimeValue[]);
					if (hooks.onAsyncOutput) {
						output = await hooks.onAsyncOutput(i, instruction, output);
					}
				} catch (error) {
					hooks.onError?.(i, instruction, error);
					throw error;
				}

				// Store the output
				const destination = this.destinations[i];
				if (destination !== null) {
					instrArgs[destination]!.push(output);
					if (output instanceof Promise) {
						hasPromise[destination] = true;
					}
				}
			}

			hooks.onComplete?.();

			return output as RuntimeValue;
		} catch (error) {
			// Drain any promises still parked in `instrArgs` whose destination will
			// now never run, then re-throw the ORIGINAL error.
			await this.sweepAbandonedPromises(instrArgs);
			throw error;
		}
	}

	/**
	 * Drain any still-pending promises parked in `instrArgs` after an instruction
	 * threw, so a promise that a now-unreachable destination would have awaited
	 * cannot become an unhandled rejection (process-fatal under strict rejection
	 * handling). Rejections are logged rather than swallowed silently; the caller
	 * re-throws the ORIGINAL error, so swept results never replace it.
	 */
	private async sweepAbandonedPromises(instrArgs: (OutputValue[] | undefined)[]): Promise<void> {
		const pending: Promise<unknown>[] = [];
		for (const args of instrArgs) {
			if (!args) continue;
			for (const arg of args) {
				if (arg instanceof Promise) {
					pending.push(arg);
				}
			}
		}
		if (pending.length === 0) return;

		const settled = await Promise.allSettled(pending);
		for (const result of settled) {
			if (result.status === 'rejected') {
				log('Drained abandoned instruction promise that rejected during error unwind: %O', result.reason);
			}
		}
	}

	/** Optimized mode: plain dispatch, no tracing or metrics overhead. */
	private optimizedHooks(): RunHooks {
		return {
			runInstruction: (_index, instruction, ctx, args) => instruction.run(ctx, ...args),
		};
	}

	/**
	 * Tracing mode. `onSyncOutput`/`onAsyncOutput` diverge deliberately: the async
	 * hook eagerly awaits each promise output before tracing so trace events are
	 * ordered by settlement (the sync path never sees a promise). Both wrap async
	 * iterables via {@link wrapIterableForTracing}. For a resolved-scalar promise
	 * the async hook parks the ORIGINAL promise (deferring the await to the
	 * destination), exactly as before the collapse.
	 *
	 * Every event is reported under the instruction's *global* address
	 * ({@link addressOf}), not its scheduler-local index, so events from a nested
	 * sub-program cannot land on a main-program instruction that happens to share
	 * a local index.
	 */
	private tracingHooks(ctx: RuntimeContext): RunHooks {
		const tracer = ctx.tracer!;
		return {
			onInput: (i, instruction, args) => tracer.traceInput(this.addressOf(i), instruction, args),
			runInstruction: (_index, instruction, rctx, args) => instruction.run(rctx, ...args),
			onSyncOutput: (i, instruction, output) => {
				const address = this.addressOf(i);
				let traced = output;
				if (isAsyncIterable(traced)) {
					traced = wrapIterableForTracing(traced, ctx, address, instruction);
				}
				tracer.traceOutput(address, instruction, traced);
				return traced;
			},
			onAsyncOutput: async (i, instruction, output) => {
				const address = this.addressOf(i);
				let resolved = output instanceof Promise ? await output : output;
				// Default: keep the original output for flow control (re-defers a
				// resolved-scalar promise to its destination).
				let parkValue: OutputValue = output;
				if (isAsyncIterable(resolved)) {
					resolved = wrapIterableForTracing(resolved, ctx, address, instruction);
					parkValue = resolved;
				}
				tracer.traceOutput(address, instruction, resolved);
				return parkValue;
			},
			onError: (i, instruction, error) => tracer.traceError(this.addressOf(i), instruction, error as Error),
		};
	}

	/**
	 * Metrics mode. `runInstruction` wraps timing/counting (a sync value is timed
	 * immediately; a promise result is timed on settle via `.then/.catch`). The
	 * async loop parks that timing-wrapped promise and defers awaiting to the
	 * destination — like optimized — so no separate async instruction runner is
	 * needed. `onComplete` logs the aggregate on the normal-completion path only
	 * (never on throw), matching the pre-collapse behavior.
	 *
	 * When the context carries a work-counter collector
	 * (`Statement._iterateRowsRawInternal` builds one per execution), each
	 * instruction also feeds its counter slot. Unlike `runtimeStats`, slots are
	 * never reset here — they accumulate across sub-program re-invocations for the
	 * whole execution. Deliberately NOT fed via an `onAsyncOutput` hook: the async
	 * loop `await`s that hook's return, which would eagerly settle every promise
	 * output at the producing instruction and serialize work that today runs
	 * concurrently via parked promises + destination `Promise.all`.
	 */
	private metricsHooks(ctx: RuntimeContext): RunHooks {
		const counters = ctx.workCounters?.countersFor(this);
		return {
			onStart: () => {
				// Reset (not create-if-absent): a cached scheduler is reused across
				// executions, so stats must be zeroed each run to report per-execution
				// numbers rather than accumulating across runs.
				// NOTE: a sub-program scheduler (emitCall) reruns once per outer row in a
				// correlated re-eval, so its stats reset per invocation, not per execution —
				// its onComplete debug log reports the last invocation, not a cumulative sum.
				// Fine today (debug telemetry only); revisit if sub-program metrics ever feed
				// a decision that needs the per-execution total.
				for (const instruction of this.instructions) {
					if (instruction.runtimeStats) {
						instruction.runtimeStats.in = 0;
						instruction.runtimeStats.out = 0;
						instruction.runtimeStats.elapsedNs = 0n;
						instruction.runtimeStats.executions = 0;
					} else {
						instruction.runtimeStats = {
							in: 0,
							out: 0,
							elapsedNs: 0n,
							executions: 0
						};
					}
				}
			},
			runInstruction: (i, instruction, rctx, args) => this.runInstructionWithMetrics(instruction, rctx, args, counters?.[i]),
			onComplete: () => this.logAggregateMetrics(),
		};
	}

	private runInstructionWithMetrics(instruction: Instruction, ctx: RuntimeContext, args: RuntimeValue[], slot?: WorkCounterSlot): OutputValue {
		const stats = instruction.runtimeStats!;
		const start = hrtimeNs();
		const inputCount = this.countInputs(args);

		stats.executions++;
		stats.in += inputCount;
		if (slot) {
			slot.executions++;
			slot.in += inputCount;
		}

		try {
			const result = instruction.run(ctx, ...args);

			if (result instanceof Promise) {
				// Handle async results separately
				return result.then(resolved => {
					stats.out += this.countOutputs(resolved);
					stats.elapsedNs += hrtimeNs() - start;
					return slot ? recordOutput(slot, resolved) : resolved;
				}).catch(error => {
					stats.elapsedNs += hrtimeNs() - start;
					throw error;
				});
			}

			stats.out += this.countOutputs(result);
			stats.elapsedNs += hrtimeNs() - start;

			return slot ? recordOutput(slot, result) : result;
		} catch (error) {
			stats.elapsedNs += hrtimeNs() - start;
			throw error;
		}
	}

	private countInputs(args: RuntimeValue[]): number {
		return args.reduce((sum: number, arg) => {
			if (isAsyncIterable(arg)) {
				return sum + 1; // Count as 1 for async iterables (we don't know size)
			} else if (Array.isArray(arg)) {
				return sum + arg.length;
			} else {
				return sum + 1;
			}
		}, 0);
	}

	private countOutputs(result: OutputValue): number {
		if (isAsyncIterable(result)) {
			return 1; // Count as 1 for async iterables (we don't know size)
		} else if (Array.isArray(result)) {
			return result.length;
		} else {
			return 1;
		}
	}

	private logAggregateMetrics(): void {
		if (log.enabled) {
			let totalExecutions = 0;
			let totalElapsed = 0n;
			let totalIn = 0;
			let totalOut = 0;

			for (const instruction of this.instructions) {
				if (instruction.runtimeStats) {
					totalExecutions += instruction.runtimeStats.executions;
					totalElapsed += instruction.runtimeStats.elapsedNs;
					totalIn += instruction.runtimeStats.in;
					totalOut += instruction.runtimeStats.out;
				}
			}

			log(`Aggregate metrics: ${totalExecutions} executions, ${totalElapsed / 1000n}μs elapsed, ${totalIn} inputs, ${totalOut} outputs`);
		}
	}

	/**
	 * Get runtime statistics for all instructions
	 */
	getMetrics(): InstructionRuntimeStats[] {
		return this.instructions.map(instruction => instruction.runtimeStats || {
			in: 0,
			out: 0,
			elapsedNs: 0n,
			executions: 0
		});
	}
}
