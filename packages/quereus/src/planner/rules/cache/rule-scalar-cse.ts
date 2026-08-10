/**
 * Rule: Scalar Common Subexpression Elimination (CSE)
 *
 * Detects duplicate scalar expression computations across a ProjectNode and
 * its immediate relational child chain (Filter, Sort), then injects a
 * lower ProjectNode that computes each deduplicated expression once.
 *
 * Guards:
 * - Only deduplicate deterministic expressions
 * - Skip bare column references and literals (cost 0, cheap to recompute)
 * - Require at least 2 occurrences of the same fingerprint
 *
 * Pass: Structural (top-down)
 * Node type: PlanNodeType.Project
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, ScalarPlanNode, Attribute, RelationalPlanNode } from '../../nodes/plan-node.js';
import { PlanNode as PlanNodeClass } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { PlanNodeType } from '../../nodes/plan-node-type.js';
import { ProjectNode, type Projection } from '../../nodes/project-node.js';
import { FilterNode } from '../../nodes/filter.js';
import { SortNode, type SortKey } from '../../nodes/sort.js';
import { ColumnReferenceNode } from '../../nodes/reference.js';
import { fingerprintExpression } from '../../analysis/expression-fingerprint.js';
import type * as AST from '../../../parser/ast.js';

const log = createLogger('optimizer:rule:scalar-cse');

/** Where an expression lives in the chain */
interface ExprLocation {
	/** Which node in the chain ('project', 'filter', 'sort') */
	owner: 'project' | 'filter' | 'sort';
	/** Index within the owner (projection index, or sort key index; 0 for filter predicate) */
	index: number;
	/** The expression node */
	node: ScalarPlanNode;
}

/** Group of expressions sharing the same fingerprint */
interface FingerprintGroup {
	fingerprint: string;
	locations: ExprLocation[];
}

/**
 * Recursively collect all scalar subexpression locations from a scalar expression tree.
 * Each subexpression that is non-trivial and deterministic gets its own location entry.
 */
function collectSubexpressions(
	root: ScalarPlanNode,
	owner: ExprLocation['owner'],
	index: number,
	out: ExprLocation[]
): void {
	// Skip column references and literals - they're trivially cheap
	if (root.nodeType === PlanNodeType.ColumnReference || root.nodeType === PlanNodeType.Literal) {
		return;
	}
	// Skip non-deterministic expressions
	if (root.physical.deterministic === false) {
		return;
	}
	// Skip side-effect-bearing expressions: deduplicating N copies of a
	// `(insert ... returning ...)` scalar into a single shared computation
	// would silently change the number of writes.
	if (root.physical.readonly === false) {
		return;
	}
	// Skip parameter references - cheap to evaluate
	if (root.nodeType === PlanNodeType.ParameterReference) {
		return;
	}

	out.push({ owner, index, node: root });

	// Recurse into children (scalar children only)
	for (const child of root.getChildren()) {
		if (child.getType().typeClass === 'scalar') {
			collectSubexpressions(child as ScalarPlanNode, owner, index, out);
		}
	}
}

/**
 * Collect the relational child chain under a ProjectNode.
 * Returns [filter?, sort?, bottomSource] where filter/sort are optional
 * intermediate nodes and bottomSource is the first non-Filter/non-Sort child.
 */
function collectChain(project: ProjectNode): {
	filter: FilterNode | null;
	sort: SortNode | null;
	bottomSource: RelationalPlanNode;
} {
	let current: RelationalPlanNode = project.source;
	let filter: FilterNode | null = null;
	let sort: SortNode | null = null;

	// Walk at most two levels: Filter then Sort, or Sort then Filter
	for (let i = 0; i < 2; i++) {
		if (!filter && current instanceof FilterNode) {
			filter = current;
			current = current.source;
		} else if (!sort && current instanceof SortNode) {
			sort = current;
			current = current.source;
		} else {
			break;
		}
	}

	return { filter, sort, bottomSource: current };
}

export function ruleScalarCSE(node: PlanNode, _context: OptContext): PlanNode | null {
	if (node.nodeType !== PlanNodeType.Project) {
		return null;
	}

	const project = node as ProjectNode;
	const { filter, sort, bottomSource } = collectChain(project);

	// Collect all subexpressions from the chain
	const allLocations: ExprLocation[] = [];

	// Collect from projections
	for (let i = 0; i < project.projections.length; i++) {
		collectSubexpressions(project.projections[i].node, 'project', i, allLocations);
	}

	// Collect from filter predicate
	if (filter) {
		collectSubexpressions(filter.predicate, 'filter', 0, allLocations);
	}

	// Collect from sort keys
	if (sort) {
		for (let i = 0; i < sort.sortKeys.length; i++) {
			collectSubexpressions(sort.sortKeys[i].expression, 'sort', i, allLocations);
		}
	}

	if (allLocations.length === 0) {
		return null;
	}

	// Group by fingerprint
	const groups = new Map<string, ExprLocation[]>();
	for (const loc of allLocations) {
		const fp = fingerprintExpression(loc.node);
		let group = groups.get(fp);
		if (!group) {
			group = [];
			groups.set(fp, group);
		}
		group.push(loc);
	}

	// Find groups with duplicates (2+ locations with distinct node identities)
	const duplicateGroups: FingerprintGroup[] = [];
	for (const [fingerprint, locations] of groups) {
		// Deduplicate by node identity - same node object appearing in multiple positions
		// counts as one, we need at least 2 distinct node instances
		const uniqueNodes = new Set(locations.map(l => l.node));
		if (uniqueNodes.size >= 2) {
			duplicateGroups.push({ fingerprint, locations });
		}
	}

	if (duplicateGroups.length === 0) {
		return null;
	}

	log('Found %d duplicate expression groups in Project chain', duplicateGroups.length);

	// For each duplicate group, pick the canonical instance and create a computed column
	const injectedProjections: Projection[] = [];
	const injectedAttributes: Attribute[] = [];

	// Map from canonical node id to the new attribute/column ref info
	const replacements = new Map<string, { attrId: number; colRef: ColumnReferenceNode; canonical: ScalarPlanNode }>();

	// We'll build the injected projections: passthrough of bottomSource + computed columns
	// First, collect passthrough from the bottomSource
	const bottomAttrs = bottomSource.getAttributes();

	// Index for the new columns starts after passthrough columns
	let nextColIndex = bottomAttrs.length;

	for (const group of duplicateGroups) {
		const canonical = group.locations[0].node;
		const attrId = PlanNodeClass.nextAttrId();
		const alias = `$cse_${attrId}`;

		const colRefExpr: AST.ColumnExpr = {
			type: 'column',
			name: alias,
		} as AST.ColumnExpr;

		const colRef = new ColumnReferenceNode(
			project.scope,
			colRefExpr,
			canonical.getType(),
			attrId,
			nextColIndex
		);

		injectedProjections.push({
			node: canonical,
			alias,
			attributeId: attrId,
		});

		injectedAttributes.push({
			id: attrId,
			name: alias,
			type: canonical.getType(),
			sourceRelation: 'cse',
			relationName: 'cse',
		});

		replacements.set(group.fingerprint, { attrId, colRef, canonical });
		nextColIndex++;
	}

	// Build the passthrough projections for the injected ProjectNode
	const passthroughProjections: Projection[] = bottomAttrs.map((attr, i) => {
		const colRefExpr: AST.ColumnExpr = {
			type: 'column',
			name: attr.name,
		} as AST.ColumnExpr;

		const colRef = new ColumnReferenceNode(
			project.scope,
			colRefExpr,
			attr.type,
			attr.id,
			i
		);

		return {
			node: colRef,
			alias: attr.name,
			attributeId: attr.id,
		} as Projection;
	});

	// Combine passthrough + computed projections
	const allInjectedProjections = [...passthroughProjections, ...injectedProjections];

	// Build predefined attributes for the injected ProjectNode
	const predefinedAttributes: Attribute[] = [
		...bottomAttrs.map(a => ({ ...a })),
		...injectedAttributes,
	];

	// Create the injected ProjectNode
	const injectedProject = new ProjectNode(
		project.scope,
		bottomSource,
		allInjectedProjections,
		undefined,
		predefinedAttributes,
		true // preserveInputColumns
	);

	// Now replace all duplicate occurrences in the outer nodes with ColumnReferenceNodes
	// We need to rebuild: project projections, filter predicate, sort keys

	// Helper: replace all occurrences of any duplicate group's nodes with colRefs
	function replaceAllDuplicates(expr: ScalarPlanNode): ScalarPlanNode {
		// Check if this exact expression matches a fingerprint group
		if (expr.nodeType !== PlanNodeType.ColumnReference &&
			expr.nodeType !== PlanNodeType.Literal &&
			expr.nodeType !== PlanNodeType.ParameterReference &&
			expr.physical.deterministic !== false &&
			expr.physical.readonly !== false) {
			const fp = fingerprintExpression(expr);
			const rep = replacements.get(fp);
			if (rep) {
				return rep.colRef;
			}
		}

		// Recurse into children
		const children = expr.getChildren();
		if (children.length === 0) return expr;

		const newChildren: PlanNode[] = [];
		let changed = false;
		for (const child of children) {
			if (child.getType().typeClass === 'scalar') {
				const replaced = replaceAllDuplicates(child as ScalarPlanNode);
				newChildren.push(replaced);
				if (replaced !== child) changed = true;
			} else {
				newChildren.push(child);
			}
		}

		if (!changed) return expr;
		return expr.withChildren(newChildren) as ScalarPlanNode;
	}

	// Rebuild sort (innermost in the outer chain, sits on injectedProject)
	let newSortOrSource: RelationalPlanNode = injectedProject;
	if (sort) {
		const newSortKeys: SortKey[] = sort.sortKeys.map(key => ({
			expression: replaceAllDuplicates(key.expression),
			direction: key.direction,
			nulls: key.nulls,
		}));
		newSortOrSource = new SortNode(sort.scope, injectedProject, newSortKeys);
	}

	// Rebuild filter
	let newFilterOrSource: RelationalPlanNode = newSortOrSource;
	if (filter) {
		const newPredicate = replaceAllDuplicates(filter.predicate);
		newFilterOrSource = new FilterNode(filter.scope, newSortOrSource, newPredicate);
	}

	// Rebuild the outer project
	const origAttributes = project.getAttributes();
	const newProjections = project.projections.map((proj, i) => ({
		node: replaceAllDuplicates(proj.node),
		alias: proj.alias,
		attributeId: origAttributes[i].id,
	}));

	const newProject = new ProjectNode(
		project.scope,
		newFilterOrSource,
		newProjections,
		undefined,
		origAttributes,
		project.preserveInputColumns
	);

	log('Injected CSE ProjectNode with %d computed columns', injectedProjections.length);
	return newProject;
}
