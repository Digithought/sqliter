import { QuereusError } from "../common/errors.js";
import type { PlanNode } from "../planner/nodes/plan-node.js";
import type { PlanNodeType } from "../planner/nodes/plan-node-type.js";
import type { Instruction, InstructionRun, RuntimeContext } from "./types.js";
import { StatusCode, type OutputValue, type Row, type RuntimeValue } from '../common/types.js';
import { createLogger } from '../common/logger.js';
import { Scheduler } from "./scheduler.js";
import type { EmissionContext } from "./emission-context.js";
import { isAsyncIterable } from "./utils.js";
import { tryFuseScalar } from "./scalar-fusion.js";

const log = createLogger('emitters');

export type EmitterFunc = (plan: PlanNode, ctx: EmissionContext) => Instruction;

/**
 * Metadata about an emitter's execution characteristics
 * Used by optimizer to make decisions about physical properties
 */
export interface EmitterMeta {
	/** Whether this emitter preserves input ordering */
	preservesOrdering?: boolean;

	/** Column indexes that must be ordered for this emitter to work efficiently */
	requiresOrdering?: number[];

	/** Whether this emitter can handle streaming input efficiently */
	supportsStreaming?: boolean;

	/** Whether this emitter produces deterministic output */
	isDeterministic?: boolean;

	/** Estimated CPU cost factor relative to other operations */
	cpuCostFactor?: number;

	/** Estimated memory usage factor */
	memoryCostFactor?: number;

	/** Free-text description for debugging */
	note?: string;
}

/**
 * Emitter registration with metadata
 */
interface EmitterRegistration {
	emitter: EmitterFunc;
	meta: EmitterMeta;
}

const emitters: Map<PlanNodeType, EmitterRegistration> = new Map();

export function registerEmitter(nodeType: PlanNodeType, emitter: EmitterFunc, meta: EmitterMeta = {}): void {
	emitters.set(nodeType, { emitter, meta });
	log(`Registered emitter for ${nodeType} with meta: %O`, meta);
}

/**
 * Get emitter metadata for a node type
 */
export function getEmitterMeta(nodeType: PlanNodeType): EmitterMeta | undefined {
	const registration = emitters.get(nodeType);
	return registration?.meta;
}

/**
 * Wraps an instruction's run function with plan node stack tracking for debugging.
 * Only adds overhead when tracing is enabled.
 */
function instrumentRunForTracing(plan: PlanNode, originalRun: InstructionRun): InstructionRun {
	return function (ctx: RuntimeContext, ...args: RuntimeValue[]): OutputValue {
		const stack = (ctx.planStack = ctx.planStack || []);
		stack.push(plan);

		let result: OutputValue;
		try {
			result = originalRun(ctx, ...args);
		} catch (err) {
			// Synchronous error – pop immediately and re-throw
			stack.pop();
			throw err;
		}

		// If the result is an async iterable, defer the pop until iteration completes
		if (isAsyncIterable<Row>(result)) {
			const iterable: AsyncIterable<Row> = result;
			// Wrap iterable to pop stack in a finally block once iteration ends
			return (async function* (): AsyncIterable<Row> {
				try {
					for await (const item of iterable) {
						yield item;
					}
				} finally {
					stack.pop();
				}
			})();
		}

		// If the result is a promise, pop once it settles
		if (result !== null && typeof result === 'object' && typeof (result as PromiseLike<unknown>).then === 'function') {
			return (result as Promise<RuntimeValue>).finally(() => {
				stack.pop();
			});
		}

		// Synchronous return value – pop immediately
		stack.pop();
		return result;
	};
}

export function emitPlanNode(plan: PlanNode, ctx: EmissionContext): Instruction {
	const registration = emitters.get(plan.nodeType);
	if (!registration) {
		throw new QuereusError(`No emitter registered for ${plan.nodeType}`, StatusCode.ERROR);
	}
	const instruction = registration.emitter(plan, ctx);
	// Wrap with instrumentation for tracing
	if (ctx.tracePlanStack) {
		instruction.run = instrumentRunForTracing(plan, instruction.run);
	}
	return instruction;
}

/**
 * Compiles any plan node into a callable instruction that can be used as a function.
 * This enables the scheduler to create separate programs for functions and pass them
 * as callbacks to other instructions.
 */
export function emitCall(root: Instruction): Instruction {
	const program = new Scheduler(root);

	function run(_ctx: RuntimeContext): OutputValue {
		return (innerCtx: RuntimeContext) => program.run(innerCtx);
	}

	return {
		params: [],
		run,
		note: `callback(${root.note})`,
		programs: [program]
	};
}

/**
 * Helper function to emit a plan node and wrap it as a callable instruction.
 * This is useful for emitters that need to create sub-instructions.
 *
 * This is also the single front door of scalar fusion: when the emission context
 * allows it, a pure synchronous scalar subtree compiles into one fused closure
 * (runtime/scalar-fusion.ts) instead of a per-row sub-program. Transparent to every
 * consumer — a `FusedScalar` satisfies the same `(ctx) => MaybePromise<SqlValue>`
 * callback contract a sub-program does, and any plan the fusion compiler cannot
 * prove pure and synchronous (relational plans, subqueries, function calls, async
 * literals, over-deep trees) falls back to the sub-program path unchanged.
 *
 * A fused instruction returns the SAME closure on every invocation, where `emitCall`
 * allocates a fresh arrow each time; nothing keys on sub-program function identity
 * (verified across the runtime emitters), and identity per emit site is strictly
 * more stable than identity per invocation.
 *
 * NOTE: the three *debug introspection* surfaces emit unfused, but the two *observation*
 * surfaces that run a normal statement do not — `runtime_stats` metrics and a db-level
 * `Database.setInstructionTracer` both see a fused subtree as one `fused(...)`
 * instruction, so per-operator timings and per-operator trace events inside it are gone.
 * Fine today (both are debug telemetry, and `execution_trace()` covers the per-operator
 * view via `_emitUnfused`); if per-scalar-operator cost ever has to be attributed from a
 * normal run, have those two paths force `fuseScalars: false` the way `_emitUnfused` does.
 */
export function emitCallFromPlan(plan: PlanNode, emissionCtx: EmissionContext): Instruction {
	if (emissionCtx.fuseScalars) {
		const fused = tryFuseScalar(plan, emissionCtx);
		if (fused) {
			return { params: [], run: () => fused, note: `fused(${plan.toString()})` };
		}
	}
	const instruction = emitPlanNode(plan, emissionCtx);
	return emitCall(instruction);
}

/**
 * Builds an instruction for an emitter that captured schema objects during emission.
 *
 * Schema validation is NOT wrapped here: it is hoisted to once per execution in
 * `Statement._iterateRowsRawInternal`, which calls
 * `EmissionContext.validateCapturedSchemaObjects()` once before the scheduler runs.
 * A single emission context is shared by every capturing instruction, so one central
 * call covers them all — instead of O(#capturing-instructions × snapshot-size) per run
 * (worse inside an un-cached nested-loop-join inner, which re-fired per outer row).
 *
 * The signature and the six call sites are retained so those emitters stay untouched.
 */
export function createValidatedInstruction(
	params: Instruction[],
	run: InstructionRun,
	_emissionCtx: EmissionContext,
	note?: string
): Instruction {
	return { params, run, note };
}
