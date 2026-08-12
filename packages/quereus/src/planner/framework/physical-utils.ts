/**
 * Physical property utilities for the Titan optimizer
 * Provides helpers for handling ordering, unique keys, and property propagation
 */

import { PlanNodeType } from '../nodes/plan-node-type.js';
import type { MonotonicOnInfo, ScalarPlanNode } from '../nodes/plan-node.js';
import type { ColumnReferenceNode } from '../nodes/reference.js';

/**
 * Ordering specification for a column
 */
export interface Ordering {
	/** Column index */
	column: number;
	/** True for descending order */
	desc: boolean;
}

/**
 * Extract ordering from sort keys if they are trivial column references
 * Returns undefined if any sort key is not a simple column reference
 *
 * NOTE: all-or-nothing. `order by a, b * 2` yields nothing, though the leading
 * `a` prefix alone would be a sound (weaker) claim that merge join and the
 * ordering-prefix rules could still use. Cheap to relax — return the prefix
 * collected before the first non-column key — if a plan ever needs an ordering
 * above a computed secondary sort key.
 */
export function extractOrderingFromSortKeys(
	sortKeys: readonly { expression: ScalarPlanNode; direction: 'asc' | 'desc' }[],
	sourceAttributes: readonly { id: number }[]
): Ordering[] | undefined {
	const ordering: Ordering[] = [];

	for (const sortKey of sortKeys) {
		// Check if this is a trivial column reference
		if (sortKey.expression.nodeType !== PlanNodeType.ColumnReference) {
			return undefined; // Non-trivial expression, cannot determine ordering
		}

		const columnRef = sortKey.expression as unknown as ColumnReferenceNode;

		// Raw `{ id }[]` helper with no owning node (unit-tested against bare arrays);
		// see getAttributeIndex() callers — migrating would change this signature
		// contract, so the array scan stays.
		const columnIndex = sourceAttributes.findIndex(attr => attr.id === columnRef.attributeId);
		if (columnIndex === -1) {
			return undefined; // Column not found in source
		}

		ordering.push({
			column: columnIndex,
			desc: sortKey.direction === 'desc'
		});
	}

	return ordering;
}

/**
 * Check if a scalar expression is a trivial column reference
 */
export function isTrivialColumnReference(expr: ScalarPlanNode): boolean {
	return expr.nodeType === PlanNodeType.ColumnReference;
}

/**
 * Extract column index from a column reference if it exists in the given attributes
 */
export function getColumnIndex(
	columnRef: ColumnReferenceNode,
	attributes: Array<{ id: number }>
): number | undefined {
	// Raw `{ id }[]` helper with no owning node — see getAttributeIndex() callers;
	// the array scan stays rather than forcing a throwaway local map.
	const index = attributes.findIndex(attr => attr.id === columnRef.attributeId);
	return index >= 0 ? index : undefined;
}

/**
 * Merge ordering requirements between parent and child
 * Returns undefined if orderings are incompatible
 */
export function mergeOrderings(
	parent: Ordering[] | undefined,
	child: Ordering[] | undefined
): Ordering[] | undefined {
	// If parent has no ordering requirements, use child's ordering
	if (!parent || parent.length === 0) {
		return child;
	}

	// If child provides no ordering, parent requirements cannot be satisfied
	if (!child || child.length === 0) {
		return undefined;
	}

	// Check if child ordering satisfies parent requirements
	if (parent.length > child.length) {
		return undefined; // Child provides fewer columns than parent needs
	}

	// Verify each parent requirement is satisfied by child
	for (let i = 0; i < parent.length; i++) {
		const parentOrder = parent[i];
		const childOrder = child[i];

		if (parentOrder.column !== childOrder.column ||
			parentOrder.desc !== childOrder.desc) {
			return undefined; // Ordering mismatch
		}
	}

	// Parent requirements are satisfied, return child's full ordering
	return child;
}

/**
 * Check if two orderings are compatible (one satisfies the other)
 */
export function orderingsCompatible(
	required: Ordering[] | undefined,
	provided: Ordering[] | undefined
): boolean {
	if (!required || required.length === 0) {
		return true; // No requirements
	}

	if (!provided || provided.length === 0) {
		return false; // Requirements exist but nothing provided
	}

	if (required.length > provided.length) {
		return false; // Not enough columns provided
	}

	// Check prefix compatibility
	for (let i = 0; i < required.length; i++) {
		const req = required[i];
		const prov = provided[i];

		if (req.column !== prov.column || req.desc !== prov.desc) {
			return false;
		}
	}

	return true;
}

/**
 * Check if orderings are exactly equal
 */
export function orderingsEqual(
	a: Ordering[] | undefined,
	b: Ordering[] | undefined
): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	if (a.length !== b.length) return false;

	for (let i = 0; i < a.length; i++) {
		if (a[i].column !== b[i].column || a[i].desc !== b[i].desc) {
			return false;
		}
	}

	return true;
}

/**
 * Reverse an ordering (flip ASC/DESC)
 */
export function reverseOrdering(ordering: Ordering[]): Ordering[] {
	return ordering.map(ord => ({ ...ord, desc: !ord.desc }));
}

/**
 * Project ordering through a projection
 * Returns undefined if any ordering column is removed by the projection
 */
export function projectOrdering(
	ordering: Ordering[] | undefined,
	columnMapping: Map<number, number> // oldColumn -> newColumn
): Ordering[] | undefined {
	if (!ordering || ordering.length === 0) {
		return ordering;
	}

	const result: Ordering[] = [];
	for (const ord of ordering) {
		const newCol = columnMapping.get(ord.column);
		if (newCol === undefined) {
			return undefined;
		}
		result.push({ column: newCol, desc: ord.desc });
	}

	return result;
}

/**
 * Filter `monotonicOn` entries to those whose attrId is in the preserved set.
 * Returns undefined if nothing survives (so callers can omit the field).
 */
export function projectMonotonicOnByAttrId(
	monotonicOn: readonly MonotonicOnInfo[] | undefined,
	preservedAttrIds: ReadonlySet<number>,
): readonly MonotonicOnInfo[] | undefined {
	if (!monotonicOn || monotonicOn.length === 0) return undefined;
	const survived = monotonicOn.filter(m => preservedAttrIds.has(m.attrId));
	return survived.length > 0 ? survived : undefined;
}

/**
 * Intersect two `monotonicOn` lists by attrId+direction. Strictness is the
 * conjunction (AND) of the two sides.
 */
export function intersectMonotonicOn(
	left: readonly MonotonicOnInfo[] | undefined,
	right: readonly MonotonicOnInfo[] | undefined,
): readonly MonotonicOnInfo[] | undefined {
	if (!left || !right || left.length === 0 || right.length === 0) return undefined;
	const result: MonotonicOnInfo[] = [];
	for (const l of left) {
		const r = right.find(x => x.attrId === l.attrId && x.direction === l.direction);
		if (r) {
			result.push({
				attrId: l.attrId,
				direction: l.direction,
				strict: l.strict && r.strict,
			});
		}
	}
	return result.length > 0 ? result : undefined;
}

/**
 * Derive an ordering specification from `monotonicOn` entries by mapping
 * attrIds to column indices in the supplied attribute list. Each surviving
 * entry yields one ordering element.
 */
export function deriveOrderingFromMonotonicOn(
	monotonicOn: readonly MonotonicOnInfo[] | undefined,
	attrs: readonly { id: number }[],
): { column: number; desc: boolean }[] | undefined {
	if (!monotonicOn || monotonicOn.length === 0) return undefined;
	const result: { column: number; desc: boolean }[] = [];
	for (const m of monotonicOn) {
		// Raw `{ id }[]` helper with no owning node — see getAttributeIndex() callers;
		// migrating would force a throwaway local map, so the array scan stays.
		const idx = attrs.findIndex(a => a.id === m.attrId);
		if (idx >= 0) {
			result.push({ column: idx, desc: m.direction === 'desc' });
		}
	}
	return result.length > 0 ? result : undefined;
}
