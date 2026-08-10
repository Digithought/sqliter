/**
 * Utility to detect correlated subqueries
 * A subquery is correlated if it references columns from outer query scopes
 */

import { isRelationalNode, type PlanNode, type RelationalPlanNode } from '../nodes/plan-node.js';
import { PlanNodeType } from '../nodes/plan-node-type.js';
import type { ColumnReferenceNode } from '../nodes/reference.js';

/**
 * Detects if a subquery is correlated by checking if it references any attributes
 * that are not defined within its own scope.
 */
export function isCorrelatedSubquery(subqueryNode: RelationalPlanNode): boolean {
	// Short-circuit: stop at the first external reference rather than collecting all.
	const definedAttributes = new Set<number>();
	collectDefinedAttributes(subqueryNode, definedAttributes);
	return hasExternalReferences(subqueryNode, definedAttributes);
}

/**
 * Collect the attribute IDs the subquery references from *outer* scopes (i.e.
 * not defined within its own subtree). An empty set means the subquery is not
 * correlated. Used by rules that need to know *which* outer attributes a
 * correlation depends on, not merely that it is correlated.
 */
export function collectExternalReferences(subqueryNode: RelationalPlanNode): Set<number> {
	const definedAttributes = new Set<number>();
	collectDefinedAttributes(subqueryNode, definedAttributes);
	const external = new Set<number>();
	collectExternalAttributeIds(subqueryNode, definedAttributes, external);
	return external;
}

/**
 * Does `reader` reference a column produced anywhere inside `producer`'s subtree?
 *
 * The question a join's physical-algorithm rules must ask before replacing the
 * nested-loop driver: hash and merge each drain one side before (or
 * independently of) the other's rows exist, so a side reading its SIBLING's
 * columns — a `JOIN LATERAL` subtree, or an index-nested-loop's own correlated
 * seek — resolves against no row at runtime. Correlation to a scope OUTSIDE the
 * join is a different question ({@link isCorrelatedSubquery}) and not a hazard:
 * the enclosing driver installs that row slot before the whole join opens.
 *
 * `producer`'s whole subtree counts, not merely the attributes it exposes at its
 * top, so the answer cannot hinge on which of them survived to its output list.
 */
export function readsColumnsOf(reader: RelationalPlanNode, producer: RelationalPlanNode): boolean {
	const external = collectExternalReferences(reader);
	if (external.size === 0) return false;
	const produced = new Set<number>();
	collectDefinedAttributes(producer, produced);
	for (const attrId of external) {
		if (produced.has(attrId)) return true;
	}
	return false;
}

/**
 * Recursively collect all attributes defined by relational nodes within a subtree
 */
function collectDefinedAttributes(node: PlanNode, definedAttributes: Set<number>): void {
	// If this is a relational node, add its attributes
	const isRelational = isRelationalNode(node);
	if (isRelational) {
		const attributes = node.getAttributes();
		for (const attr of attributes) {
			definedAttributes.add(attr.id);
		}
	}

	// Recursively process all children
	const children = node.getChildren();
	for (const child of children) {
		collectDefinedAttributes(child, definedAttributes);
	}

	// Also process relational children if any
	if (isRelational) {
		const relations = node.getRelations();
		for (const relation of relations) {
			collectDefinedAttributes(relation, definedAttributes);
		}
	}
}

/**
 * Check if the subtree contains any column references to attributes not in the defined set
 */
function hasExternalReferences(node: PlanNode, definedAttributes: Set<number>): boolean {
	// Check if this is a column reference
	if (node.nodeType === PlanNodeType.ColumnReference) {
		const colRef = node as ColumnReferenceNode;
		// If the referenced attribute is not defined within the subquery, it's an external reference
		if (!definedAttributes.has(colRef.attributeId)) {
			return true; // Found a correlated reference
		}
	}

	// Check all children
	const children = node.getChildren();
	for (const child of children) {
		if (hasExternalReferences(child, definedAttributes)) {
			return true;
		}
	}

	// Also check relational children if any
	if (isRelationalNode(node)) {
		const relations = node.getRelations();
		for (const relation of relations) {
			if (hasExternalReferences(relation, definedAttributes)) {
				return true;
			}
		}
	}

	return false;
}

/**
 * Like {@link hasExternalReferences}, but accumulates every external attribute
 * ID into `external` instead of short-circuiting at the first one.
 */
function collectExternalAttributeIds(
	node: PlanNode,
	definedAttributes: Set<number>,
	external: Set<number>,
): void {
	if (node.nodeType === PlanNodeType.ColumnReference) {
		const colRef = node as ColumnReferenceNode;
		if (!definedAttributes.has(colRef.attributeId)) {
			external.add(colRef.attributeId);
		}
	}

	for (const child of node.getChildren()) {
		collectExternalAttributeIds(child, definedAttributes, external);
	}

	if (isRelationalNode(node)) {
		for (const relation of node.getRelations()) {
			collectExternalAttributeIds(relation, definedAttributes, external);
		}
	}
}
