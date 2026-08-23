/**
 * Rule: GROUP BY FD simplification
 *
 * Drops GROUP BY columns that are functionally determined by other remaining
 * GROUP BY columns under the aggregate-output FDs and equivalence classes.
 * Each dropped column is re-emitted as a `MIN(<original-column>)` picker
 * aggregate so the output attribute IDs (and therefore downstream binding)
 * are preserved. The picker relies on the BUILT-IN `min`'s semantics (any
 * value from the group, since the group is a single source row); the rule
 * declines when `min/1` has been shadowed by a user-registered function.
 *
 * The aggregate's own `physical.fds` and `physical.equivClasses` are already
 * projected onto its output column indices by `propagateAggregateFds`, so
 * the rule reasons in aggregate-output space directly:
 *
 *   - candidate set = bare `ColumnReferenceNode` GROUP BY output indices
 *   - ECs expand to bi-directional FDs over those indices
 *   - source keys read through the unified `keysOf` surface (declared keys,
 *     FD-derived keys, and the all-columns/`isSet` key) are mapped into the
 *     aggregate-output space and added as key FDs — this closes the gap where
 *     a source carries a declared key (or is only known a set via `isSet`)
 *     that `propagateAggregateFds` never materialized as a physical FD
 *   - `minimalCover` returns the surviving indices; the rest are dropped
 *
 * Soundness: a mapped source key `K` makes each group a single source row, so
 * every dropped (functionally-determined) column has one value per group and
 * `MIN(col)` recovers it. EC-derived FDs from `WHERE a = b` are sound because
 * every surviving row has equal values on the EC members.
 *
 * The new aggregate's own layout is: kept GROUP BYs first, then the picker MIN
 * aggregates re-emitting the dropped columns at their original attribute IDs
 * (via `preserveAttributeIds`), then the original aggregate expressions. That
 * layout may permute the original output positions, so whenever it does the
 * rule caps the new aggregate with a `ProjectNode` that re-emits the same
 * attribute IDs in their original order. The rewrite therefore preserves the
 * full output schema — attribute IDs *and* positions.
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, ScalarPlanNode, Attribute, FunctionalDependency } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { AggregateNode, type AggregateExpression } from '../../nodes/aggregate-node.js';
import { AggregateFunctionCallNode } from '../../nodes/aggregate-function.js';
import { ProjectNode } from '../../nodes/project-node.js';
import { ColumnReferenceNode } from '../../nodes/reference.js';
import { expandEcsToFds, keysOf, minimalCover, superkeyToFd } from '../../util/fd-utils.js';
import { isAggregateFunctionSchema } from '../../../schema/function.js';
import type { Scope } from '../../scopes/scope.js';
import type * as AST from '../../../parser/ast.js';

const log = createLogger('optimizer:rule:groupby-fd-simplification');

export function ruleGroupByFdSimplification(node: PlanNode, context: OptContext): PlanNode | null {
	if (!(node instanceof AggregateNode)) return null;
	if (node.groupBy.length <= 1) return null;

	const aggAttrs = node.getAttributes();

	// Build the set of candidate output indices: bare-column GROUP BYs only.
	// Map outIdx → original ColumnReferenceNode so we can wire pickers later.
	const candidateExprs = new Map<number, ColumnReferenceNode>();
	for (let i = 0; i < node.groupBy.length; i++) {
		const gb = node.groupBy[i];
		if (gb instanceof ColumnReferenceNode) {
			candidateExprs.set(i, gb);
		}
	}
	if (candidateExprs.size <= 1) return null;

	const candidateSet = new Set<number>(candidateExprs.keys());

	const sourceFds = node.physical.fds ?? [];
	const ecs = node.physical.equivClasses ?? [];

	// Map source-output column index → aggregate-output index for bare-column
	// GROUP BYs (the same mapping `propagateAggregateFds` walks). Used to lift
	// the source's keys into aggregate-output space.
	const aggCols = aggAttrs.length;
	const srcToOut = new Map<number, number>();
	const sourceAttrIndex = node.source.getAttributeIndex();
	node.groupBy.forEach((gb, outIdx) => {
		if (gb instanceof ColumnReferenceNode) {
			const srcIdx = sourceAttrIndex.get(gb.attributeId);
			if (srcIdx !== undefined && !srcToOut.has(srcIdx)) srcToOut.set(srcIdx, outIdx);
		}
	});

	// Lift each source key (declared / FD-derived / all-columns-`isSet`) whose
	// every column survives as a bare GROUP BY column into a key FD on the
	// aggregate output. A source key makes each group a single source row, so
	// these columns functionally determine the rest — letting `minimalCover`
	// collapse the GROUP BY onto them.
	const keyFds: FunctionalDependency[] = [];
	for (const srcKey of keysOf(node.source)) {
		const mapped: number[] = [];
		let ok = true;
		for (const c of srcKey) {
			const out = srcToOut.get(c);
			if (out === undefined) { ok = false; break; }
			mapped.push(out);
		}
		if (!ok) continue;
		const keyFd = superkeyToFd(mapped, aggCols);
		if (keyFd) keyFds.push(keyFd);
	}

	const combinedFds = expandEcsToFds(ecs, keyFds.length > 0 ? [...sourceFds, ...keyFds] : sourceFds);

	const cover = minimalCover(candidateSet, combinedFds);
	if (cover.size === candidateSet.size) return null;

	const dropped = new Set<number>();
	for (const idx of candidateSet) {
		if (!cover.has(idx)) dropped.add(idx);
	}
	if (dropped.size === 0) return null;

	// Build new groupBy: keep non-candidates (expressions) AND kept candidates,
	// preserving original relative order. Track the new output index each old
	// index maps to so we can rebuild preserveAttributeIds correctly.
	const keptGroupBy: ScalarPlanNode[] = [];
	const keptGroupByOldIdx: number[] = [];
	const droppedOldIdx: number[] = [];

	for (let i = 0; i < node.groupBy.length; i++) {
		if (candidateSet.has(i) && !cover.has(i)) {
			droppedOldIdx.push(i);
		} else {
			keptGroupBy.push(node.groupBy[i]);
			keptGroupByOldIdx.push(i);
		}
	}

	// Never collapse a grouped aggregate to a scalar (empty-GROUP-BY) aggregate:
	// that would emit one row over an empty input instead of zero. This happens
	// when every grouping column is constant-pinned (e.g. `where a = 0 and k = 6`),
	// so FD propagation gives each an empty-determinant FD (`{} → col`) and
	// `minimalCover` satisfies them all from `{}`, draining the cover. Removing the
	// last group key changes the query's cardinality contract, which is never sound.
	// Keep at least one grouping column.
	if (keptGroupBy.length === 0) return null;

	// Synthesize picker MIN aggregates for each dropped column, in original order.
	// Gate on schema identity, not name: `addFunction` overwrites by name/numArgs, so
	// a user `min/1` and `_findFunction('min', 1)` would otherwise agree with each
	// other while disagreeing with the built-in semantics this rewrite relies on.
	const minSchema = context.db._findBuiltinFunction('min', 1);
	if (!minSchema || !isAggregateFunctionSchema(minSchema)) {
		log('min/1 is not the built-in aggregate; skipping');
		return null;
	}

	const pickerAggregates: AggregateExpression[] = [];
	for (const oldIdx of droppedOldIdx) {
		const colRef = candidateExprs.get(oldIdx)!;
		const origAttr = aggAttrs[oldIdx];
		const minExpr: AST.FunctionExpr = {
			type: 'function',
			name: 'min',
			args: [colRef.expression],
			distinct: false,
		};
		const inferredType = minSchema.inferReturnType
			? minSchema.inferReturnType([colRef.getType().logicalType])
			: undefined;
		const pickerCall = new AggregateFunctionCallNode(
			node.scope,
			minExpr,
			'min',
			minSchema,
			[colRef],
			false,
			undefined,
			undefined,
			inferredType,
		);
		pickerAggregates.push({ expression: pickerCall, alias: origAttr.name });
	}

	// Rebuild preserveAttributeIds in the new physical order:
	//   [kept-gb attrs..., dropped-gb attrs (as picker outputs)..., orig-agg attrs...]
	const groupByCount = node.groupBy.length;
	const newAttrs: Attribute[] = [];
	for (const oldIdx of keptGroupByOldIdx) newAttrs.push(aggAttrs[oldIdx]);
	for (const oldIdx of droppedOldIdx) newAttrs.push(aggAttrs[oldIdx]);
	for (let i = groupByCount; i < aggAttrs.length; i++) newAttrs.push(aggAttrs[i]);

	const newAggregates: AggregateExpression[] = [...pickerAggregates, ...node.aggregates];

	log(
		'Dropped %d/%d GROUP BY column(s); picker aggregates: %d',
		dropped.size,
		candidateSet.size,
		pickerAggregates.length,
	);

	const newAgg = new AggregateNode(
		node.scope,
		node.source,
		keptGroupBy,
		newAggregates,
		undefined,
		newAttrs,
	);

	return restoreOutputOrder(newAgg, aggAttrs, newAttrs, node.scope);
}

/**
 * Re-emit `rewritten`'s columns in `originalAttrs` order when the rewrite permuted
 * them, otherwise hand it back bare.
 *
 * Attribute IDs survive the rewrite, so every id-bound consumer is already fine —
 * but the statement result binds by POSITION when the aggregate is the query root,
 * so a permuting rewrite needs the cap. The drop is order-preserving (and the cap
 * skipped) exactly when the dropped keys were already a suffix of the grouping list.
 */
function restoreOutputOrder(
	rewritten: AggregateNode,
	originalAttrs: readonly Attribute[],
	newAttrs: readonly Attribute[],
	scope: Scope,
): PlanNode {
	if (newAttrs.every((a, i) => a.id === originalAttrs[i].id)) return rewritten;

	// NOTE: this stacks under the builder's own select-list projection, so a
	// permuting rewrite costs one extra row copy. If grouped-plan row-copy overhead
	// ever shows up in a profile, collapse a permutation-only Project over Project;
	// the collapse needs no index rebinding because column references resolve by
	// attribute id at runtime (see runtime/emit/column-reference.ts).
	const newIndexById = new Map(newAttrs.map((a, i) => [a.id, i]));
	const projections = originalAttrs.map(attr => ({
		node: new ColumnReferenceNode(
			scope,
			{ type: 'column', name: attr.name } satisfies AST.ColumnExpr,
			attr.type,
			attr.id,
			newIndexById.get(attr.id)!,
		) as ScalarPlanNode,
		alias: attr.name,
		attributeId: attr.id,
	}));

	// `preserveInputColumns: true` is inert while `predefinedAttributes` is supplied,
	// but it describes what this node does — every projection is a bare column
	// reference republishing its source attribute id — so it stays correct if a later
	// rebuild ever drops the predefined attributes (`false` would mint fresh ids).
	return new ProjectNode(scope, rewritten, projections, undefined, originalAttrs.slice(), true);
}

