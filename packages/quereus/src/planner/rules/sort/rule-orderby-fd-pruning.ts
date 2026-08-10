/**
 * Rule: ORDER BY FD pruning
 *
 * Drops trailing ORDER BY keys that are functionally determined by the
 * preceding bare-column keys under the source's FDs and equivalence classes.
 *
 * For a SortNode with ≥ 2 keys, walk the keys front-to-back maintaining
 * `determined = closure({leading bare-column source-indices}, fds, ECs)`.
 * Drop any trailing key whose expression is a bare `ColumnReferenceNode` and
 * whose source-attribute index is already in `determined`. Direction and
 * NULL placement on the dropped trailing key are irrelevant — once the
 * preceding keys pin every value of that column to a single value per group,
 * the trailing key cannot reorder anything.
 *
 * Whole-Sort elimination (degenerate empty-key case): a source proven to hold
 * ≤1 row (the empty key `[]` present in `keysOf`, i.e. `isAtMostOneRow(source)`)
 * is trivially totally ordered, so the *entire* ORDER BY is a no-op regardless
 * of how many keys it has — even a single-key sort. The rule drops the SortNode
 * outright (returns its source) before the trailing-key logic runs. This is the
 * "0 leading keys already form a superkey" case that the front-to-back loop
 * cannot express (it always retains the first key before checking `isUnique`).
 *
 * Whole-tail pruning: once the retained leading bare-column keys form a
 * superkey of the source (`isUnique` over the unified key surface — declared
 * keys, FD-derived keys, or the all-columns/`isSet` key), the rows are totally
 * ordered and *every* remaining key (bare or not) is a no-op tiebreaker, so the
 * whole tail drops. This is what prunes the redundant trailing keys of an
 * all-columns-key set source whose ORDER BY lists a key followed by more
 * columns.
 *
 * Sort-key matcher semantics: only bare `ColumnReferenceNode` keys
 * participate in either direction of the reasoning. A non-bare-column key
 * contributes nothing to `determined` (we can't prove what expression values
 * "determine"), and a non-bare-column key cannot be dropped. The rule walks
 * past non-bare keys treating them as opaque.
 *
 * Reasoning space: `fds`/`equivClasses` from `node.source.physical` are in
 * source-attribute-INDEX space (positions in `source.getAttributes()`), NOT
 * attribute IDs. The rule converts each sort-key's `ColumnReferenceNode.
 * attributeId` to its source-attribute index before feeding `computeClosure`
 * — mirroring how `SortNode.computePhysical` does its `leadIdx` lookup.
 *
 * Soundness: equality-class FDs from a `WHERE a = b` filter or a join key
 * are sound here because every surviving row has equal values on the EC
 * members, so the trailing key is a no-op tiebreaker.
 *
 * Ordering with other rules: this is a Structural-pass rule. It must run
 * before `monotonic-limit-pushdown` (PostOptimization pass) so single-
 * key reductions can enable the pushdown. That ordering is automatic since
 * Structural runs before PostOptimization.
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode } from '../../nodes/plan-node.js';
import type { OptContext as _OptContext } from '../../framework/context.js';
import { SortNode, type SortKey } from '../../nodes/sort.js';
import { ColumnReferenceNode } from '../../nodes/reference.js';
import { computeClosure, expandEcsToFds, isAtMostOneRow, isUnique, keysOf } from '../../util/fd-utils.js';

const log = createLogger('optimizer:rule:orderby-fd-pruning');

export function ruleOrderByFdPruning(node: PlanNode, _context: _OptContext): PlanNode | null {
	if (!(node instanceof SortNode)) return null;

	// Whole-Sort elimination: a provably ≤1-row source is trivially totally
	// ordered, so the ORDER BY is a pure no-op no matter how many keys it lists.
	// `isAtMostOneRow(source)` is true iff the empty key is present in the unified
	// key surface (a `∅ → all_cols` singleton FD, a declared empty key, etc.).
	// Drop the SortNode entirely — must run before the `< 2` guard so single-key
	// sorts over a singleton source are eliminated too.
	if (isAtMostOneRow(node.source)) {
		log('Eliminating ORDER BY over provably ≤1-row source');
		return node.source;
	}

	if (node.sortKeys.length < 2) return null;

	const source = node.source;
	const sourceIndex = source.getAttributeIndex();
	const sourcePhysical = source.physical;
	const sourceFds = sourcePhysical.fds ?? [];
	const sourceEcs = sourcePhysical.equivClasses ?? [];

	// Proceed when there is any reasoning material: FDs, ECs, or a declared/
	// `isSet`-derived key surface (the latter lets us prune trailing keys via
	// `isUnique` even on sources that carry no physical FDs).
	if (sourceFds.length === 0 && sourceEcs.length === 0 && keysOf(source).length === 0) return null;

	const combinedFds = expandEcsToFds(sourceEcs, sourceFds);

	const survivors: SortKey[] = [];
	const determined = new Set<number>();
	const leadingCols: number[] = [];
	let dropped = 0;
	let totallyOrdered = false;

	for (const key of node.sortKeys) {
		if (totallyOrdered) {
			// The retained leading keys already form a superkey of the source, so
			// rows are totally ordered — every remaining key is a no-op tiebreaker.
			dropped++;
			continue;
		}
		const expr = key.expression;
		if (!(expr instanceof ColumnReferenceNode)) {
			// Non-bare-column keys are opaque: they neither contribute to nor
			// consume `determined`. Always retained.
			survivors.push(key);
			continue;
		}
		const srcIdx = sourceIndex.get(expr.attributeId) ?? -1;
		if (srcIdx < 0) {
			// Defensive: column reference doesn't resolve into the source.
			// Retain the key rather than mis-prune.
			survivors.push(key);
			continue;
		}
		if (determined.has(srcIdx)) {
			dropped++;
			continue;
		}
		survivors.push(key);
		determined.add(srcIdx);
		leadingCols.push(srcIdx);
		// Re-close under FDs so subsequent trailing keys can drop.
		const closure = computeClosure(determined, combinedFds);
		for (const x of closure) determined.add(x);
		// Once the retained leading bare-column keys form a superkey, the whole
		// remaining tail is redundant.
		if (isUnique(leadingCols, source)) {
			totallyOrdered = true;
		}
	}

	if (dropped === 0) return null;
	// Defensive: should be impossible — the first key never gets dropped.
	if (survivors.length === 0) return null;

	log('Dropped %d/%d ORDER BY key(s)', dropped, node.sortKeys.length);

	return node.withSortKeys(survivors);
}
