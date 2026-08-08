import { StatusCode, type SqlValue } from '../common/types.js';
import { QuereusError } from '../common/errors.js';
import type { PlanNode, ScalarPlanNode } from '../planner/nodes/plan-node.js';
import { PlanNodeType } from '../planner/nodes/plan-node-type.js';
import type {
	BetweenNode,
	BinaryOpNode,
	CaseExprNode,
	CastNode,
	CollateNode,
	LiteralNode,
	UnaryOpNode,
} from '../planner/nodes/scalar.js';
import type { ScalarFunctionCallNode } from '../planner/nodes/function.js';
import type { ColumnReferenceNode, ParameterReferenceNode } from '../planner/nodes/reference.js';
import { isScalarFunctionSchema } from '../schema/function.js';
import type { RuntimeContext } from './types.js';
import type { EmissionContext } from './emission-context.js';
import { assertSpecArity, type ScalarOpRun, type ScalarOpSpec } from './emit/scalar-op.js';
import { buildScalarFunctionRun } from './emit/scalar-function.js';
import { buildLiteralSpec } from './emit/literal.js';
import { buildColumnReferenceSpec } from './emit/column-reference.js';
import { buildParameterSpec } from './emit/parameter.js';
import { buildCastSpec } from './emit/cast.js';
import { buildUnaryOpSpec } from './emit/unary.js';
import { buildBetweenSpec } from './emit/between.js';
import { buildBinaryOpSpec } from './emit/binary.js';
import { buildCaseMatcher } from './emit/case.js';
import { isTruthy } from '../util/comparison.js';

/**
 * A fused scalar expression: evaluates a whole pure, synchronous subtree with direct
 * calls — no scheduler, no per-row allocation, no dynamic dispatch.
 *
 * The type is deliberately a strict narrowing of `SubProgram` (common/types.ts):
 * every consumer of `emitCallFromPlan` invokes the result as
 * `(ctx) => MaybePromise<SqlValue>`, and a fused closure satisfies that contract
 * with a value that just happens to never be a Promise.
 */
export type FusedScalar = (rctx: RuntimeContext) => SqlValue;

/**
 * Largest fused subtree depth. Fused closures nest on the JS call stack where the
 * scheduler's linearized instruction loop did not, so a pathologically deep expression
 * (`a+a+a+…` thousands of terms) could overflow the stack where it works unfused.
 * Past this depth the expression offered to {@link tryFuseScalar} falls back whole to the
 * sub-program path — correct, just unoptimized. Fusion is still retried from depth 0 at
 * every nested `emitCallFromPlan` site the fallback emission reaches (CASE branches, an
 * AND/OR short-circuit right leg), so a deep tree fuses in pieces below those seams rather
 * than not at all. 32 is far above any real expression's nesting.
 */
export const MAX_FUSION_DEPTH = 32;

/**
 * Compile `plan` into a single closure, or return undefined if any node in the subtree
 * cannot be fused (an unsupported node type, a subquery, anything that can return a
 * Promise, or a subtree deeper than {@link MAX_FUSION_DEPTH}). Undefined is the normal
 * answer for most of the plan tree; the caller falls back to the sub-program path
 * unchanged.
 *
 * Every fused body comes from the node's own {@link ScalarOpSpec} builder (or, for
 * CASE, from `buildCaseMatcher`) — the same functions the instruction emitters run —
 * so a fused expression and its instruction form cannot disagree on semantics, error
 * messages, or evaluation counts. This compiler only changes HOW operand values reach
 * those bodies: direct nested calls instead of scheduler slots.
 *
 * A scalar function call fuses only when it is provably synchronous — see
 * {@link fuseScalarFunctionCall}. The AND/OR short-circuit form declines through
 * `buildBinaryOpSpec` returning undefined, and subquery/window/aggregate/relational
 * nodes decline as unknown node types — which also keeps every `emitCallFromPlan` call
 * site that passes a relational plan (cache sources, join legs, view-mutation programs)
 * on the sub-program path for free.
 */
export function tryFuseScalar(plan: PlanNode, ctx: EmissionContext): FusedScalar | undefined {
	return fuseNode(plan, ctx, 0);
}

// NOTE: a subtree that declines partway has already built every spec above the declining
// node — resolving collations, compiling a constant LIKE matcher — and those are then
// rebuilt by the fallback `emitPlanNode`. Emit-time only, bounded by subtree size, and the
// idempotent work (collation lookups record into a Set) cannot diverge. Fine today; if emit
// latency ever shows up on function-heavy expressions, pre-walk the subtree for unfusable
// node types before building any spec.

/** Per-node dispatch. `depth` counts the closure frames already wrapping this node. */
function fuseNode(plan: PlanNode, ctx: EmissionContext, depth: number): FusedScalar | undefined {
	if (depth > MAX_FUSION_DEPTH) return undefined;

	switch (plan.nodeType) {
		case PlanNodeType.Literal: {
			// Undefined when the literal holds an unresolved async constant-fold result —
			// the scheduler resolves that Promise; a fused closure could not.
			const spec = buildLiteralSpec(plan as LiteralNode);
			return spec && fuseSpec(spec, ctx, depth);
		}
		case PlanNodeType.ColumnReference:
			return fuseSpec(buildColumnReferenceSpec(plan as ColumnReferenceNode), ctx, depth);
		case PlanNodeType.ParameterReference:
			return fuseSpec(buildParameterSpec(plan as ParameterReferenceNode), ctx, depth);
		case PlanNodeType.Collate:
			// No runtime effect (mirrors emitCollate) — fuse straight through to the
			// operand. Adds no closure frame, so depth is unchanged.
			return fuseNode((plan as CollateNode).operand, ctx, depth);
		case PlanNodeType.Cast:
			return fuseSpec(buildCastSpec(plan as CastNode), ctx, depth);
		case PlanNodeType.UnaryOp:
			return fuseSpec(buildUnaryOpSpec(plan as UnaryOpNode), ctx, depth);
		case PlanNodeType.Between:
			return fuseSpec(buildBetweenSpec(plan as BetweenNode, ctx), ctx, depth);
		case PlanNodeType.BinaryOp: {
			// Undefined for the AND/OR short-circuit form (subquery right operand),
			// whose right leg is a deferred sub-program rather than a value.
			const spec = buildBinaryOpSpec(plan as BinaryOpNode, ctx);
			return spec && fuseSpec(spec, ctx, depth);
		}
		case PlanNodeType.CaseExpr:
			return fuseCase(plan as CaseExprNode, ctx, depth);
		case PlanNodeType.ScalarFunctionCall:
			return fuseScalarFunctionCall(plan as ScalarFunctionCallNode, ctx, depth);
		default:
			return undefined;
	}
}

/**
 * The `AsyncFunction` constructor, which has no global binding — reachable only off an
 * instance. An `async function` / `async` arrow carries `AsyncFunction.prototype` on its
 * prototype chain, so `impl instanceof AsyncFunction` recognizes one.
 */
const AsyncFunction = (async () => { /* probe only */ }).constructor;

/**
 * Fuse a scalar function call, but only when its implementation is provably
 * synchronous. A fused node's contract is a plain `SqlValue`, while a `ScalarFunc` is
 * typed `(...args) => MaybePromise<SqlValue>`; admitting `MaybePromise` into the fused
 * contract would put a Promise check and a `.then` path on every node in the chain,
 * which is the sub-program overhead this compiler exists to delete. So the decision is
 * made once here, at emit time, in this order:
 *
 * 1. **A `customEmitter` never fuses.** It builds its own `Instruction` — possibly with
 *    sub-programs or async behavior — and this compiler cannot see inside it. Today that
 *    excludes `nullif`, `greatest`, `least`, `json_schema` and `mutation_ordinal`;
 *    giving custom emitters a fusion hook is parked in
 *    `tickets/backlog/feat-fuse-custom-emitter-scalar-functions.md`.
 * 2. **`isAsync === true` never fuses** — the author's explicit declaration.
 * 3. **A declared `async` implementation never fuses**, auto-detected, so the ordinary
 *    async UDF needs no flag.
 * 4. **Otherwise fuse, with a guard**: a non-`async` implementation that returns a
 *    Promise anyway is invisible to step 3, so the fused body checks and throws a
 *    `QuereusError` naming the function and the `isAsync` remedy. One `instanceof` per
 *    call — negligible beside the sub-program it replaces — and it converts a silent
 *    wrong answer (a Promise flowing on as if it were a value, comparing as garbage)
 *    into a loud, actionable error.
 *
 * The body itself is {@link buildScalarFunctionRun}, the same one
 * `emitScalarFunctionCallDefault` gives the scheduler, so a fused call and an
 * instruction call cannot disagree on error text, arity checking or the `REPR_STRICT`
 * return check. Operands compose by arity like every other fused node — including the
 * variadic case (`numArgs === -1`, e.g. `coalesce`), which needs no special handling
 * because the composition switches on `operands.length`, not on the declared arity.
 */
function fuseScalarFunctionCall(
	plan: ScalarFunctionCallNode,
	ctx: EmissionContext,
	depth: number,
): FusedScalar | undefined {
	const schema = plan.functionSchema;
	// Not a scalar schema at all: `emitScalarFunctionCall` reports that, and the unfused
	// path it falls back to still does. Decline rather than duplicate the diagnosis.
	if (!isScalarFunctionSchema(schema)) return undefined;
	if (schema.customEmitter) return undefined;
	if (schema.isAsync) return undefined;
	if (schema.implementation instanceof AsyncFunction) return undefined;

	const body = buildScalarFunctionRun(plan);
	const functionName = plan.expression.name.toLowerCase();
	const loc = plan.expression.loc?.start;

	const guarded: ScalarOpRun = (rctx, ...args) => {
		const result = body(rctx, ...args);
		if (result instanceof Promise) {
			throw new QuereusError(
				`Function ${functionName} returned a Promise but is not declared asynchronous. `
				+ `Declare isAsync: true on its registration so the engine keeps it off the fused expression path.`,
				StatusCode.ERROR, undefined, loc?.line, loc?.column);
		}
		return result;
	};

	return composeFused(guarded, plan.operands, ctx, depth);
}

/** Check the spec's body arity, then compose it with its fused operands. */
function fuseSpec(spec: ScalarOpSpec, ctx: EmissionContext, depth: number): FusedScalar | undefined {
	assertSpecArity(spec);
	return composeFused(spec.run, spec.operands, ctx, depth);
}

/**
 * Compose a synchronous body with its fused operands, specialized by arity so the common
 * cases allocate nothing per row and stay monomorphic. Closure composition only — no
 * `new Function`/`eval`, which are unavailable under a Content-Security-Policy and under
 * React Native.
 *
 * Shared by the {@link ScalarOpSpec} nodes and by {@link fuseScalarFunctionCall}, whose
 * variadic body has no fixed parameter count to assert (hence the assert living in
 * {@link fuseSpec}, not here). The switch is on how many operands are actually
 * evaluated, so a variadic function's call site lands in whichever fixed arm matches
 * its argument count.
 */
function composeFused(
	run: ScalarOpRun,
	operands: readonly ScalarPlanNode[],
	ctx: EmissionContext,
	depth: number,
): FusedScalar | undefined {
	switch (operands.length) {
		case 0:
			// The body already IS the fused closure — wrapping it would add a call frame
			// per row to the two most common leaves in any query (column refs, literals).
			return run;
		case 1: {
			const a = fuseNode(operands[0], ctx, depth + 1);
			return a && ((rctx) => run(rctx, a(rctx)));
		}
		case 2: {
			const a = fuseNode(operands[0], ctx, depth + 1);
			if (!a) return undefined;
			const b = fuseNode(operands[1], ctx, depth + 1);
			return b && ((rctx) => run(rctx, a(rctx), b(rctx)));
		}
		case 3: {
			const a = fuseNode(operands[0], ctx, depth + 1);
			if (!a) return undefined;
			const b = fuseNode(operands[1], ctx, depth + 1);
			if (!b) return undefined;
			const c = fuseNode(operands[2], ctx, depth + 1);
			return c && ((rctx) => run(rctx, a(rctx), b(rctx), c(rctx)));
		}
		default: {
			// No spec is wider than 3 operands; a wide variadic call (`coalesce(a,b,c,d)`)
			// lands here. An args array + spread is still far cheaper than a sub-program.
			const fused: FusedScalar[] = [];
			for (const operand of operands) {
				const f = fuseNode(operand, ctx, depth + 1);
				if (!f) return undefined;
				fused.push(f);
			}
			return (rctx) => run(rctx, ...fused.map(f => f(rctx)));
		}
	}
}

/**
 * CASE is the one covered node that is not a flat {@link ScalarOpSpec}: its branches are
 * lazy. Fuse it only when the base (if any) AND every WHEN/THEN/ELSE fuse — all-or-nothing
 * avoids a mixed contract where some branches are closures and some are sub-programs
 * returning `MaybePromise`. The fused body keeps SQL's evaluation rules exactly as
 * `emitCaseExpr` has them: WHEN clauses left to right, stop at the first match, evaluate
 * ONLY the selected result, never touch a later clause. Match decisions come from
 * `buildCaseMatcher`, so a fused CASE and an instruction CASE cannot disagree.
 *
 * Branch closures are invoked from inside the CASE closure, so their frames stack —
 * they count toward the depth cap (depth + 1), same as spec operands.
 */
function fuseCase(plan: CaseExprNode, ctx: EmissionContext, depth: number): FusedScalar | undefined {
	const whens: FusedScalar[] = [];
	const thens: FusedScalar[] = [];
	for (const clause of plan.whenThenClauses) {
		const when = fuseNode(clause.when, ctx, depth + 1);
		if (!when) return undefined;
		const then = fuseNode(clause.then, ctx, depth + 1);
		if (!then) return undefined;
		whens.push(when);
		thens.push(then);
	}
	const elseFn = plan.elseExpr ? fuseNode(plan.elseExpr, ctx, depth + 1) : undefined;
	if (plan.elseExpr && !elseFn) return undefined;

	const clauseCount = whens.length;

	// Simple CASE: base compared against each WHEN under the per-clause pre-resolved
	// comparator (collation + type routing). A NULL base matches nothing.
	if (plan.baseExpr) {
		const base = fuseNode(plan.baseExpr, ctx, depth + 1);
		if (!base) return undefined;
		const matcher = buildCaseMatcher(plan, ctx);
		return (rctx) => {
			const baseValue = base(rctx);
			for (let i = 0; i < clauseCount; i++) {
				if (matcher.matches(i, baseValue, whens[i](rctx))) return thens[i](rctx);
			}
			return elseFn ? elseFn(rctx) : null;
		};
	}

	// Searched CASE: first truthy WHEN selects its THEN.
	return (rctx) => {
		for (let i = 0; i < clauseCount; i++) {
			if (isTruthy(whens[i](rctx))) return thens[i](rctx);
		}
		return elseFn ? elseFn(rctx) : null;
	};
}
