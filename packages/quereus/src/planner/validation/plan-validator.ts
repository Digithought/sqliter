/**
 * Plan validator pass for the Titan optimizer
 * Validates that a plan tree meets all invariants before emission
 */

import { isRelationalNode, PlanNode, type RelationalPlanNode } from '../nodes/plan-node.js';
import { PlanNodeType } from '../nodes/plan-node-type.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { validateLog } from '../debug/logger-utils.js';
import type { ColumnReferenceNode } from '../nodes/reference.js';
import { computeAttributeProvenance, type ProvenanceEntry } from '../analysis/attribute-provenance.js';

const log = validateLog();

/**
 * Validation options
 */
export interface ValidationOptions {
	/** Validate that all physical properties are set (default: true) */
	requirePhysical?: boolean;
	/** Validate attribute consistency (default: true) */
	validateAttributes?: boolean;
	/** Validate ordering properties (default: true) */
	validateOrdering?: boolean;
}

/**
 * Validate a physical plan tree before emission
 * @param root The root node of the plan tree
 * @param options Validation options
 * @throws QuereusError if validation fails
 */
export function validatePhysicalTree(root: PlanNode, options: ValidationOptions = {}): void {
	const opts = {
		requirePhysical: true,
		validateAttributes: true,
		validateOrdering: true,
		...options
	};

	log('Starting plan validation for tree rooted at %s', root.nodeType);

	const context = new ValidationContext(opts);

	// Derive the attribute-provenance surface once. This both (a) detects
	// duplicate origins (throws) and (b) yields the complete attrId → origin map
	// regardless of traversal order, so the in-scope check below is order-free
	// and forwarding (Set/Join/EagerPrefetch/AsyncGather/Project) never trips it.
	if (opts.validateAttributes) {
		context.provenance = computeAttributeProvenance(root);
	}

	validateNode(root, context, []);

	log('Plan validation completed successfully');
}

/**
 * Validation context for tracking state during traversal
 */
class ValidationContext {
	/** attrId → originating node, precomputed once when validateAttributes is on. */
	provenance?: Map<number, ProvenanceEntry>;

	constructor(public readonly options: ValidationOptions) {}

	/**
	 * Check if an attribute ID is in scope anywhere in the tree (originated or
	 * forwarded). Matches the prior global-set scoping semantics.
	 */
	hasAttribute(attrId: number): boolean {
		return this.provenance?.has(attrId) ?? false;
	}
}

/**
 * Validate a single node and recursively validate its children
 */
function validateNode(node: PlanNode, context: ValidationContext, path: string[]): void {
	const nodePath = path.concat(node.nodeType).join(' > ');

	try {
		log('Validating node %s at path: %s', node.nodeType, nodePath);

		// 1. Validate physical properties are present
		if (context.options.requirePhysical) {
			validatePhysicalProperties(node, nodePath);
		}

		// 2. Validate that this is a physical (not logical-only) node type
		validatePhysicalNodeType(node, nodePath);

		// 3. Validate relational node specific properties
		if (isRelationalNode(node)) {
			validateRelationalNode(node as RelationalPlanNode, context, nodePath);
		}

		// 4. Validate column references point to valid attributes
		if (node.nodeType === PlanNodeType.ColumnReference) {
			validateColumnReference(node as ColumnReferenceNode, context, nodePath);
		}

		// 5. Recursively validate children
		for (const child of node.getChildren()) {
			validateNode(child, context, path.concat(node.nodeType));
		}

	} catch (error) {
		if (error instanceof QuereusError) {
			// Add context to the error
			error.message = `Validation failed at ${nodePath}: ${error.message}`;
		}
		throw error;
	}
}

/**
 * Validate that physical properties are present
 */
function validatePhysicalProperties(node: PlanNode, nodePath: string): void {
	if (!node.physical) {
		throw new QuereusError(
			`Node ${node.nodeType} at ${nodePath} lacks physical properties`,
			StatusCode.INTERNAL
		);
	}

	// Basic sanity checks on physical properties
	const physical = node.physical;

	if (typeof physical.deterministic !== 'boolean') {
		throw new QuereusError(
			`Node ${node.nodeType} has invalid deterministic flag: ${physical.deterministic}`,
			StatusCode.INTERNAL
		);
	}

	if (typeof physical.readonly !== 'boolean') {
		throw new QuereusError(
			`Node ${node.nodeType} has invalid readonly flag: ${physical.readonly}`,
			StatusCode.INTERNAL
		);
	}

	if (physical.idempotent !== undefined && typeof physical.idempotent !== 'boolean') {
		throw new QuereusError(
			`Node ${node.nodeType} has invalid idempotent flag: ${physical.idempotent}`,
			StatusCode.INTERNAL
		);
	}

	if (physical.estimatedRows !== undefined && physical.estimatedRows < 0) {
		throw new QuereusError(
			`Node ${node.nodeType} has negative estimated rows: ${physical.estimatedRows}`,
			StatusCode.INTERNAL
		);
	}

	// Validate side effect consistency for DML nodes
	if (PlanNode.hasSideEffects(physical)) {
		// Nodes with side effects should not be constant
		if (physical.constant === true) {
			throw new QuereusError(
				`Node ${node.nodeType} has side effects but is marked as constant`,
				StatusCode.INTERNAL
			);
		}
	}
}

/**
 * Validate that the node type is physical (not logical-only)
 */
function validatePhysicalNodeType(node: PlanNode, nodePath: string): void {
	// Node types that should NOT appear in a fully optimized physical tree
	const logicalOnlyTypes = new Set([
		PlanNodeType.Aggregate, // Should be StreamAggregate or HashAggregate
		PlanNodeType.Retrieve,  // Must be rewritten to a physical access node
		// Add other logical-only types here as needed
	]);

	if (logicalOnlyTypes.has(node.nodeType)) {
		throw new QuereusError(
			`Logical-only node type ${node.nodeType} found in physical tree at ${nodePath}`,
			StatusCode.INTERNAL
		);
	}
}

/**
 * Validate relational node specific properties
 */
function validateRelationalNode(node: RelationalPlanNode, context: ValidationContext, nodePath: string): void {
	if (!context.options.validateAttributes) {
		return;
	}

	// Get attributes for this node
	const attributes = node.getAttributes();

	// Validate that we have attributes if this is a real relational node
	// (Some nodes like DDL operations might not have attributes)
	const needsAttributes = !isDDLNode(node.nodeType);
	if (needsAttributes && attributes.length === 0) {
		log('Warning: Relational node %s has no attributes at %s', node.nodeType, nodePath);
	}

	// Per-attribute shape checks. Duplicate-origin detection lives in the
	// precomputed provenance surface (computeAttributeProvenance), not here —
	// attribute-preserving parents (Set/Join/EagerPrefetch/AsyncGather) forward
	// child ids verbatim and must not be flagged as duplicates.
	for (const attr of attributes) {
		if (typeof attr.id !== 'number') {
			throw new QuereusError(
				`Invalid attribute ID ${attr.id} (must be number) at ${nodePath}`,
				StatusCode.INTERNAL
			);
		}

		// Validate attribute properties
		if (!attr.name || typeof attr.name !== 'string') {
			throw new QuereusError(
				`Attribute ${attr.id} has invalid name "${attr.name}" at ${nodePath}`,
				StatusCode.INTERNAL
			);
		}

		if (!attr.sourceRelation || typeof attr.sourceRelation !== 'string') {
			throw new QuereusError(
				`Attribute ${attr.id} has invalid source relation "${attr.sourceRelation}" at ${nodePath}`,
				StatusCode.INTERNAL
			);
		}
	}

	// Validate ordering properties if present
	if (context.options.validateOrdering && node.physical?.ordering) {
		validateOrdering(node.physical.ordering, attributes.length, nodePath);
	}
}

/**
 * Validate column references point to valid attributes
 */
function validateColumnReference(node: ColumnReferenceNode, context: ValidationContext, nodePath: string): void {
	if (!context.options.validateAttributes) {
		return;
	}

	const attributeId = node.attributeId;
	if (typeof attributeId !== 'number') {
		throw new QuereusError(
			`ColumnReference has invalid attribute ID ${attributeId} at ${nodePath}`,
			StatusCode.INTERNAL
		);
	}

	if (!context.hasAttribute(attributeId)) {
		throw new QuereusError(
			`ColumnReference refers to unknown attribute ID ${attributeId} at ${nodePath}`,
			StatusCode.INTERNAL
		);
	}
}

/**
 * Validate ordering specification
 */
function validateOrdering(ordering: { column: number; desc: boolean }[], columnCount: number, nodePath: string): void {
	for (let i = 0; i < ordering.length; i++) {
		const orderSpec = ordering[i];

		if (typeof orderSpec.column !== 'number') {
			throw new QuereusError(
				`Invalid ordering column index ${orderSpec.column} at ${nodePath}[${i}]`,
				StatusCode.INTERNAL
			);
		}

		if (orderSpec.column < 0 || orderSpec.column >= columnCount) {
			throw new QuereusError(
				`Ordering column index ${orderSpec.column} out of range (0-${columnCount-1}) at ${nodePath}[${i}]`,
				StatusCode.INTERNAL
			);
		}

		if (typeof orderSpec.desc !== 'boolean') {
			throw new QuereusError(
				`Invalid ordering desc flag ${orderSpec.desc} at ${nodePath}[${i}]`,
				StatusCode.INTERNAL
			);
		}
	}
}

/**
 * Check if a node type is a DDL node that doesn't produce attributes
 */
function isDDLNode(nodeType: PlanNodeType): boolean {
	const ddlTypes = new Set([
		PlanNodeType.CreateTable,
		PlanNodeType.DropTable,
		PlanNodeType.CreateIndex,
		PlanNodeType.CreateView,
		PlanNodeType.DropView,
		PlanNodeType.Transaction,
		PlanNodeType.Pragma,
		PlanNodeType.AddConstraint,
		PlanNodeType.AlterTable,
		PlanNodeType.SetObjectTags,
	]);

	return ddlTypes.has(nodeType);
}

/**
 * Assert the cost model's additivity invariant over a constructed plan tree:
 * for every node, `getTotalCost()` must equal its self-cost (`estimatedCost`)
 * plus the sum of every child's total cost, and `estimatedCost` must be a finite,
 * non-negative number.
 *
 * This guards the self-cost-only convention (`PlanNode.estimatedCost` stores only
 * the node's own cost; `getTotalCost()` is the sole place children are summed).
 * The additivity equality is tautological for the base `getTotalCost()`, so the
 * real value is catching (a) a future `getTotalCost()` override that diverges from
 * additivity, and (b) a self-cost that went NaN / negative / infinite.
 *
 * Debug- and test-callable; not on the hot path. Throws `QuereusError` on the
 * first violation.
 */
export function validateCostAdditivity(root: PlanNode): void {
	const stack: PlanNode[] = [root];
	const seen = new Set<PlanNode>();
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (seen.has(node)) continue; // shared child (DAG) — cost is identical, check once
		seen.add(node);

		const self = node.estimatedCost;
		if (typeof self !== 'number' || !Number.isFinite(self) || self < 0) {
			throw new QuereusError(
				`Node ${node.nodeType} [${node.id}] has invalid self-cost estimatedCost=${self} (must be finite and >= 0)`,
				StatusCode.INTERNAL,
			);
		}

		const children = node.getChildren();
		const expectedTotal = self + children.reduce((acc, child) => acc + child.getTotalCost(), 0);
		if (node.getTotalCost() !== expectedTotal) {
			throw new QuereusError(
				`Node ${node.nodeType} [${node.id}] violates cost additivity: getTotalCost()=${node.getTotalCost()} != estimatedCost + Σ child.getTotalCost()=${expectedTotal}`,
				StatusCode.INTERNAL,
			);
		}

		for (const child of children) stack.push(child);
	}
}

/**
 * Quick validation function for development/testing
 * Validates plan with default options and logs results
 */
export function quickValidate(root: PlanNode): boolean {
	try {
		validatePhysicalTree(root);
		log('✓ Plan validation passed');
		return true;
	} catch (error) {
		log('✗ Plan validation failed: %s', error);
		return false;
	}
}
