import type { SqlValue } from '../common/types.js';
import type { PlanNode } from '../planner/nodes/plan-node.js';
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
import type { ColumnReferenceNode, ParameterReferenceNode } from '../planner/nodes/reference.js';
import type { RuntimeContext } from './types.js';
import type { EmissionContext } from './emission-context.js';
import { assertSpecArity, type ScalarOpSpec } from './emit/scalar-op.js';
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
 * Past this depth the whole expression falls back to the sub-program path — correct,
 * just unoptimized. 32 is far above any real expression's nesting.
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
 * Scalar function calls are deliberately not fused yet (their sync/async split is the
 * follow-up ticket `runtime-scalar-fusion-function-calls`), so any subtree containing
 * one declines. The AND/OR short-circuit form declines through `buildBinaryOpSpec`
 * returning undefined, and subquery/window/aggregate/relational nodes decline as
 * unknown node types — which also keeps every `emitCallFromPlan` call site that passes
 * a relational plan (cache sources, join legs, view-mutation programs) on the
 * sub-program path for free.
 */
export function tryFuseScalar(plan: PlanNode, ctx: EmissionContext): FusedScalar | undefined {
	return fuseNode(plan, ctx, 0);
}

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
		default:
			return undefined;
	}
}

/**
 * Compose a spec's synchronous body with its fused operands, specialized by arity so
 * the common cases allocate nothing per row and stay monomorphic. Closure composition
 * only — no `new Function`/`eval`, which are unavailable under a Content-Security-Policy
 * and under React Native.
 */
function fuseSpec(spec: ScalarOpSpec, ctx: EmissionContext, depth: number): FusedScalar | undefined {
	assertSpecArity(spec);
	const run = spec.run;
	switch (spec.operands.length) {
		case 0:
			return (rctx) => run(rctx);
		case 1: {
			const a = fuseNode(spec.operands[0], ctx, depth + 1);
			return a && ((rctx) => run(rctx, a(rctx)));
		}
		case 2: {
			const a = fuseNode(spec.operands[0], ctx, depth + 1);
			if (!a) return undefined;
			const b = fuseNode(spec.operands[1], ctx, depth + 1);
			return b && ((rctx) => run(rctx, a(rctx), b(rctx)));
		}
		case 3: {
			const a = fuseNode(spec.operands[0], ctx, depth + 1);
			if (!a) return undefined;
			const b = fuseNode(spec.operands[1], ctx, depth + 1);
			if (!b) return undefined;
			const c = fuseNode(spec.operands[2], ctx, depth + 1);
			return c && ((rctx) => run(rctx, a(rctx), b(rctx), c(rctx)));
		}
		default: {
			// No spec is wider than 3 operands today; an args array + spread is still far
			// cheaper than a sub-program if one ever appears.
			const fused: FusedScalar[] = [];
			for (const operand of spec.operands) {
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
	if (depth > MAX_FUSION_DEPTH) return undefined;

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
