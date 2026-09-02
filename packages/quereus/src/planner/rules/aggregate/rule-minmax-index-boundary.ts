/**
 * Rule: answer an ungrouped MIN / MAX from the index boundary.
 *
 * `min(c)` over any relation `S` equals `min(c)` over
 * `(S where c is not null order by c asc limit 1)`; `max(c)` is the same with
 * `desc`. The identity holds for every `S`, so this is a pure plan-shape change —
 * never a different answer, only a cheaper one.
 *
 * The rewrite builds exactly that shape and hands it to the planner's existing
 * sort-absorption probe (`trySortAbsorbViaIndexOrdering`). The `AggregateNode`
 * itself is kept, unchanged, on top:
 *
 *   Aggregate [max(c)]                  <- unchanged
 *     └─ LimitOffset(limit=1)           <- new
 *          └─ Filter(c is not null)     <- new, only when `c` is nullable
 *               └─ Retrieve(t)          <- equipped with an ordering access plan
 *
 * Keeping the aggregate is what makes the two hard cases free:
 *
 *  - Empty relation. An ungrouped aggregate over zero rows still emits exactly one
 *    row, and min/max finalize an empty accumulator to NULL — so
 *    `select max(c) from empty_table` keeps returning one NULL row with no special
 *    casing here.
 *  - The comparator. This rule never compares values itself. It delegates "does
 *    index order agree with the argument's semantic order" to the same access-plan
 *    ordering claim plain `ORDER BY` relies on, and min/max already rank under the
 *    same semantic comparator ORDER BY uses, so the two agree by construction.
 *
 * The probe runs BEFORE anything is committed: if it returns null the rule returns
 * null and the plan is left byte-identical. No Sort, Filter or Limit is ever
 * introduced into a plan that cannot serve the ordering.
 *
 * Neither shipped backend walks an index backwards (both require the requested
 * direction to equal the index column's declared direction), so in practice:
 *
 *   min(c) + ascending index on c (incl. the primary key) -> boundary read
 *   max(c) + descending index on c                        -> boundary read
 *   max(c) + only an ascending index on c                 -> unchanged, full scan
 *   either + no index                                     -> unchanged, full scan
 *
 * Making `max(c)` fast off an ascending index needs backwards index walks, tracked
 * separately as `feat-reverse-index-walk-for-desc-ordering`.
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, RelationalPlanNode, ScalarPlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { AggregateNode } from '../../nodes/aggregate-node.js';
import { AggregateFunctionCallNode } from '../../nodes/aggregate-function.js';
import { ColumnReferenceNode } from '../../nodes/reference.js';
import { FilterNode } from '../../nodes/filter.js';
import { SortNode } from '../../nodes/sort.js';
import { LimitOffsetNode } from '../../nodes/limit-offset.js';
import { LiteralNode, UnaryOpNode } from '../../nodes/scalar.js';
import { PlanNodeCharacteristics } from '../../framework/characteristics.js';
import { trySortAbsorbViaIndexOrdering } from '../retrieve/rule-grow-retrieve.js';
import type { Scope } from '../../scopes/scope.js';
import type * as AST from '../../../parser/ast.js';

const log = createLogger('optimizer:rule:minmax-index-boundary');

/** The extremum an accepted aggregate asks for, and the ordering that puts it first. */
type Extremum = { name: 'min' | 'max'; direction: 'asc' | 'desc' };

export function ruleMinMaxIndexBoundary(node: PlanNode, context: OptContext): PlanNode | null {
	if (!(node instanceof AggregateNode)) return null;

	const call = soleUngroupedAggregateCall(node);
	if (!call) return null;

	const extremum = classifyExtremum(call, context);
	if (!extremum) return null;

	const colRef = boundaryColumn(call);
	if (!colRef) return null;

	if (!sourceAcceptsTruncation(node)) return null;

	const scope = node.scope;
	// NOTE: two different sources of truth decide "can a NULL reach this column" — this
	// line reads the column reference's own type, while `nullSafeOrderingPrefixLength`
	// (vtab/best-access-plan.ts) reads `tableSchema.columns[i].notNull`. They agree today
	// because a bare table column's `columnType` is built from that same schema column,
	// and the DESC direction fails safe either way (a missing filter makes the ordering
	// claim be refused, so the rule declines). The ASC direction does NOT fail safe: an
	// ordering claim over a nullable ASC column is granted unconditionally, so a type that
	// under-reports nullability would skip this filter and `min(c)` would return NULL.
	// Revisit if a rewrite ever narrows a ColumnReferenceNode's nullability, or if a
	// non-table relation becomes reachable through the absorb probe's chain walk.
	const inner = colRef.getType().nullable
		? new FilterNode(scope, node.source, buildIsNotNull(scope, colRef))
		: node.source;

	// Probe-then-commit: build a throwaway Sort purely to ask whether the access
	// path can serve this ordering. `trySortAbsorbViaIndexOrdering` is
	// side-effect-free, so a null answer costs nothing and leaves the plan alone.
	const probe = new SortNode(scope, inner, [
		{ expression: colRef, direction: extremum.direction, nulls: undefined },
	]);
	// The `LimitOffset(1)` wrapped on below is synthesized HERE, so unlike a limit the
	// user wrote — which sits above the Sort, where this rule's downward walk cannot see
	// it — the bound is known before the probe. Telling the module lets it price a
	// boundary read as the one row it is, instead of as an ordered read of the whole
	// table; the absorb declines the bound on its own if anything below the Sort could
	// still filter a row out. See `feat-sort-absorb-blind-to-limit`.
	const absorbed = trySortAbsorbViaIndexOrdering(probe, context, { limit: 1, offset: 0 });
	if (!absorbed) {
		log('access path cannot serve %s ordering for %s; leaving the aggregate alone',
			extremum.direction, colRef.toString());
		return null;
	}

	// NOTE: the `Literal(null)` OFFSET is load-bearing, not cosmetic. `ruleGrowRetrieve`'s
	// LimitOffset arm (`buildRequest`, rule-grow-retrieve.ts) would otherwise swallow this
	// node into `Retrieve.source`, where the index-style branch of `ruleSelectAccessPath`
	// never executes it — the early stop would silently vanish and the scan would run to
	// completion. That arm refuses every LIMIT whose OFFSET is a non-numeric literal, which
	// is exactly this shape. Its own comment invites reading a null/absent OFFSET as 0
	// instead of refusing; if that ever changes, this rewrite needs its own guard, and
	// test/optimizer/minmax-index-boundary.spec.ts pins the LIMITOFFSET still being present
	// above the access leaf.
	const limited = new LimitOffsetNode(
		scope,
		absorbed as RelationalPlanNode,
		literal(scope, 1),
		literal(scope, null),
	);

	log('rewrote %s(%s) into an index-boundary read', extremum.name, colRef.toString());
	return node.withChildren([limited, ...node.getChildren().slice(1)]);
}

/**
 * The node's single aggregate call, when it is an ungrouped aggregate carrying
 * exactly one of them.
 *
 * Two aggregates decline: `select min(c), max(c) from t` needs both ends of the
 * index (out of scope for this rewrite), and `select max(c), count(*) from t` would
 * be answered WRONG by it — `count(*)` genuinely needs every row, so truncating the
 * source to one row would return 1.
 */
function soleUngroupedAggregateCall(node: AggregateNode): AggregateFunctionCallNode | null {
	if (node.groupBy.length !== 0) return null;
	if (node.aggregates.length !== 1) return null;
	const expr = node.aggregates[0].expression;
	return expr instanceof AggregateFunctionCallNode ? expr : null;
}

/**
 * Identify the call as the BUILTIN `min`/`max` over one argument.
 *
 * The gate is `Database._isBuiltinFunction` — schema identity against the built-in
 * registration — not a name match and not a comparison against what the name resolves
 * to now. `addFunction` overwrites by `name/numArgs`, so after
 * `db.createAggregateFunction('min', …)` the call and `_findFunction('min', 1)` return
 * the SAME shadow and comparing them proves nothing; the rewrite would then truncate a
 * user aggregate's source to one row and change its answer. `FILTER (where …)` and an
 * aggregate-level `ORDER BY` both decline; `DISTINCT` is accepted in either state
 * because `min(distinct c) = min(c)`.
 */
function classifyExtremum(call: AggregateFunctionCallNode, context: OptContext): Extremum | null {
	if (call.args.length !== 1) return null;
	if (call.filter) return null;
	if (call.orderBy && call.orderBy.length > 0) return null;
	if (!context.db._isBuiltinFunction(call.functionSchema)) return null;

	for (const candidate of [{ name: 'min', direction: 'asc' }, { name: 'max', direction: 'desc' }] as const) {
		if (call.functionSchema.name === candidate.name) {
			return { name: candidate.name, direction: candidate.direction };
		}
	}
	return null;
}

/** The aggregated column, when the argument is a bare column reference. */
function boundaryColumn(call: AggregateFunctionCallNode): ColumnReferenceNode | null {
	const arg = call.args[0];
	return arg instanceof ColumnReferenceNode ? arg : null;
}

/**
 * Whether it is sound to read only a prefix of the aggregate's source.
 *
 * The rewrite truncates how much of the source is read, so a source that writes
 * must decline. The idempotence guard is belt-and-braces: `applyPassRules` never
 * re-offers a rule its own output (the applied-rule set is inherited across the
 * re-mint), so the rule cannot stack LimitOffsets on itself.
 */
function sourceAcceptsTruncation(node: AggregateNode): boolean {
	if (node.source instanceof LimitOffsetNode) return false;
	return !PlanNodeCharacteristics.subtreeHasSideEffects(node.source);
}

/**
 * `<col> IS NOT NULL`, the predicate that does two jobs.
 *
 * Correctness first: ORDER BY in this engine places NULLs FIRST for BOTH directions
 * (`orderByNullResult`, util/comparison.ts), so without this filter `limit 1` would
 * hand the aggregate a NULL and `max(d)` would return NULL whenever the column has
 * any NULL at all.
 *
 * It also unlocks the descending case: `nullSafeOrderingPrefixLength`
 * (vtab/best-access-plan.ts) refuses a DESC ordering claim over a column NULLs could
 * reach unless a NULL-excluding filter is present in the request, and `IS NOT NULL`
 * is one of its recognized ops.
 *
 * NOTE: when the module does NOT consume this as a seek bound, the ordered walk steps
 * over the whole NULL run before reaching the first real value — bounded by the NULL
 * count, so at worst an index entry plus a row per NULL (roughly twice a plain scan on
 * an all-NULL column, free on a column with few NULLs). Worth acting on only if a
 * mostly-NULL indexed column shows up slower than before this rewrite existed.
 *
 * It costs more than that on a backend with expensive random reads. An unclaimed filter
 * makes `truncationIsSafe` (rule-grow-retrieve.ts) withhold the plan-time LIMIT, so the
 * module prices the ordered read for the WHOLE table and vetoes it — the rewrite does
 * not fire at all, and a nullable column is the SQL default. Tracked as backlog
 * `feat-store-claim-is-not-null-seek-bound`; pinned by the "declines the bound when a
 * filter is left unclaimed" case in quereus-store's `plan-time-limit.spec.ts`.
 */
function buildIsNotNull(scope: Scope, colRef: ColumnReferenceNode): ScalarPlanNode {
	const ast: AST.UnaryExpr = {
		type: 'unary',
		operator: 'IS NOT NULL',
		expr: colRef.expression,
	};
	return new UnaryOpNode(scope, ast, colRef);
}

function literal(scope: Scope, value: number | null): LiteralNode {
	return new LiteralNode(scope, { type: 'literal', value });
}
