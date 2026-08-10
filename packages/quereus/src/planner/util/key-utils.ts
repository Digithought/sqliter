import type { ColRef, RelationType } from '../../common/datatype.js';
import type { Attribute, PhysicalProperties, RelationalPlanNode, ScalarPlanNode } from '../nodes/plan-node.js';
import type { JoinType } from '../nodes/join-node.js';
import type { TableSchema } from '../../schema/table.js';
import { resolveReferencedColumns } from '../../schema/table.js';
import { ColumnReferenceNode, ParameterReferenceNode } from '../nodes/reference.js';
import { LiteralNode } from '../nodes/scalar.js';
import { isAtMostOneRow, isUnique, isUniqueDeterminant, keysOf, type KeyRel } from './fd-utils.js';
import { changesRowPopulation } from './row-population.js';

/**
 * Project unique keys through a projection mapping.
 * - sourceKeys: keys defined on the source relation (arrays of column refs by source column index)
 * - projectionMap: mapping from source column index -> projected column index
 * Returns keys that survive projection (all columns present), with indices remapped to output.
 */
export function projectKeys(sourceKeys: ReadonlyArray<ReadonlyArray<ColRef>>, projectionMap: ReadonlyMap<number, number>): ColRef[][] {
	const result: ColRef[][] = [];
	for (const key of sourceKeys) {
		const projected: ColRef[] = [];
		let missing = false;
		for (const col of key) {
			const projectedIndex = projectionMap.get(col.index);
			if (projectedIndex === undefined) {
				missing = true;
				break;
			}
			projected.push({ index: projectedIndex, desc: col.desc });
		}
		if (!missing) {
			result.push(projected);
		}
	}
	return result;
}

/**
 * One projected scalar expression annotated with its zero-based output column index.
 */
export interface InjectiveProjectionEntry {
	expr: ScalarPlanNode;
	outIndex: number;
}

/**
 * Result of `deriveProjectionColumnMap`. `map` carries the source→output column
 * mapping that key/FD/EC propagation should walk; `injectivePairs` lists the
 * extra `[sourceIdx, outIdx]` entries that originate from an *injective unary*
 * projection over a single source attribute (e.g. `id + 1` over PK `id`).
 *
 * `injectivePairs` is reported separately so callers can emit a bi-directional
 * FD between the bare-source output column and the injectively-derived output
 * column (when both ends are present in the projection list). Bare-column
 * projections are NOT listed in `injectivePairs` — they are trivially identity
 * and would only produce useless `{i} → {i}` FDs.
 */
export interface ProjectionMappingResult {
	map: Map<number, number>;
	injectivePairs: Array<[number, number]>;
}

/**
 * Walk the scalar `expr` collecting:
 *   - `attrIds`: the set of unique `ColumnReferenceNode` attribute IDs it depends on,
 *   - `allOtherLeavesConstant`: true iff every non-column leaf is a `LiteralNode`
 *     or `ParameterReferenceNode`.
 *
 * Early-exits when a non-constant non-column leaf is found.
 */
function analyzeProjectionLeaves(expr: ScalarPlanNode): { attrIds: Set<number>; allOtherLeavesConstant: boolean } {
	const attrIds = new Set<number>();
	let allOtherLeavesConstant = true;

	const stack: ScalarPlanNode[] = [expr];
	while (stack.length > 0) {
		const n = stack.pop()!;
		if (n instanceof ColumnReferenceNode) {
			attrIds.add(n.attributeId);
			continue;
		}
		const children = n.getChildren();
		if (children.length === 0) {
			// Leaf that is not a column reference: must be a compile-time constant.
			if (!(n instanceof LiteralNode || n instanceof ParameterReferenceNode)) {
				allOtherLeavesConstant = false;
				break;
			}
			continue;
		}
		for (const c of children) {
			// Only descend through scalar children; scalar expressions only have scalar children.
			stack.push(c as ScalarPlanNode);
		}
	}

	return { attrIds, allOtherLeavesConstant };
}

/**
 * Build a source→output column mapping that includes BOTH:
 *   - direct `ColumnReferenceNode` projections (bare passthrough), and
 *   - injective unary projections: the expression references exactly one source
 *     attribute `a`, `expr.isInjectiveIn(a).injective === true`, and every other
 *     leaf is a compile-time constant (`LiteralNode` / `ParameterReferenceNode`).
 *     For those, the output column is treated as a synonym of source column
 *     `src(a)`.
 *
 * The bare-column rule wins on collisions: if the same source column is also
 * projected directly, that mapping is preserved (first-occurrence wins, matching
 * the historical behaviour) and the injective entry is recorded in
 * `injectivePairs` instead.
 */
export function deriveProjectionColumnMap(
	// pure helper: no owning node; callers pass raw attrs incl. unit tests, so we
	// keep the array scan rather than migrating to RelationalPlanNode.getAttributeIndex().
	sourceAttrs: readonly Attribute[],
	projections: readonly InjectiveProjectionEntry[],
): ProjectionMappingResult {
	const map = new Map<number, number>();
	const injectivePairs: Array<[number, number]> = [];

	// Pass 1: bare column references (highest priority for `map`).
	for (const { expr, outIndex } of projections) {
		if (expr instanceof ColumnReferenceNode) {
			const srcIndex = sourceAttrs.findIndex(a => a.id === expr.attributeId);
			if (srcIndex >= 0 && !map.has(srcIndex)) {
				map.set(srcIndex, outIndex);
			}
		}
	}

	// Pass 2: injectively-derived columns.
	for (const { expr, outIndex } of projections) {
		if (expr instanceof ColumnReferenceNode) continue;

		const { attrIds, allOtherLeavesConstant } = analyzeProjectionLeaves(expr);
		if (!allOtherLeavesConstant) continue;
		if (attrIds.size !== 1) continue;

		const attrId = attrIds.values().next().value as number;
		if (!expr.isInjectiveIn(attrId).injective) continue;

		const srcIndex = sourceAttrs.findIndex(a => a.id === attrId);
		if (srcIndex < 0) continue;

		// Map first-occurrence wins; injective entries fill in slots not already
		// claimed by a bare-column projection. The pair is *always* recorded so
		// callers can decide whether to emit the bi-directional FD.
		if (!map.has(srcIndex)) {
			map.set(srcIndex, outIndex);
		}
		injectivePairs.push([srcIndex, outIndex]);
	}

	return { map, injectivePairs };
}

/**
 * Test whether any key in `keys` has all of its columns covered by `eqIndices`.
 * A covered key means each row in the source side maps to ≤ 1 row in the join's
 * equi-pair partner, so the partner side's keys survive null-padding (LEFT/RIGHT).
 *
 * The empty key `[]` (a ≤1-row / TableDee side) is unconditional coverage:
 * `[].every(...)` is vacuously true regardless of `eqIndices`, so a ≤1-row side
 * always caps the partner at one matching row. (There is no `k.length > 0`
 * guard — a length-0 key is the single most powerful uniqueness fact.)
 */
function joinPairsCoverKey(
	keys: ReadonlyArray<ReadonlyArray<{ index: number }>>,
	eqIndices: Set<number>,
): boolean {
	return keys.some(k => k.every(c => eqIndices.has(c.index)));
}

/** Drop structurally-duplicate keys (e.g. two `[]` entries from both sides being ≤1-row). */
function dedupeKeys(keys: ColRef[][]): ColRef[][] {
	const seen = new Set<string>();
	const out: ColRef[][] = [];
	for (const k of keys) {
		const sig = k.map(c => `${c.index}:${c.desc ?? ''}`).join(',');
		if (seen.has(sig)) continue;
		seen.add(sig);
		out.push(k);
	}
	return out;
}

/**
 * Select the "lex-min" key from a list of keys: the one with the fewest columns,
 * ties broken by the lowest first-column index. Empty keys (≤1-row markers) are
 * skipped, and `undefined` is returned when there is no non-empty key. Used to
 * bound join-product key blow-up to a single key per side.
 *
 * Generic over the key element via an index accessor so the same logic serves
 * both the ColRef form (`combineJoinKeys`) and the column-index form
 * (`analyzeJoinKeyCoverage`).
 */
function selectLexMinKey<K>(
	keys: ReadonlyArray<ReadonlyArray<K>>,
	indexOf: (el: K) => number,
): ReadonlyArray<K> | undefined {
	let best: ReadonlyArray<K> | undefined;
	for (const key of keys) {
		if (key.length === 0) continue;
		if (best === undefined
			|| key.length < best.length
			|| (key.length === best.length && indexOf(key[0]) < indexOf(best[0]))) {
			best = key;
		}
	}
	return best;
}

/**
 * Combine unique keys across a join (logical `RelationType.keys` form).
 *
 * Soundness mirrors `analyzeJoinKeyCoverage`: a side's key survives the join
 * only when each of its rows matches ≤ 1 row on the other side — i.e. the
 * equi-pairs cover a unique key of the *opposite* side. An unconditional union
 * would be unsound: a plain cross/inner join duplicates one side's key values
 * for every matching row on the other side (`ta CROSS JOIN tb` repeats `ta`'s
 * PK once per `tb` row, so `ta`'s PK is not a key of the product).
 *
 * - `inner` / `cross`: left keys survive iff a right-side key is covered; right
 *   keys (shifted by `leftColumnCount`) survive iff a left-side key is covered.
 *   A key=key join covers both, so both survive. A bare cross join covers
 *   neither, so the result is `[]` — set-ness of the full product is carried by
 *   `RelationType.isSet` instead.
 * - `left`: if `equiPairs` cover any right-side key, return left keys unchanged
 *   (each left row matches ≤ 1 right row, so left's keys survive). Otherwise `[]`.
 * - `right`: symmetric — if `equiPairs` cover any left-side key, return right's
 *   keys shifted by `leftColumnCount`. Otherwise `[]`.
 * - `full`: `[]` (both sides may be null-padded).
 * - `semi` / `anti`: return left keys (left-only output, no null-padding).
 *
 * **Empty-key (≤1-row) coverage.** A length-0 entry in either side's `keys`
 * means that side is ≤1-row. `joinPairsCoverKey` treats it as unconditional
 * coverage (a ≤1-row side caps the partner at one match regardless of
 * `equiPairs`), so the LEFT/RIGHT/inner/cross branches still run their coverage
 * check with an empty eq-set — they no longer early-return `[]` just because
 * `equiPairs` is empty. When *both* sides are ≤1-row, the (inner/cross/left/
 * right) result advertises the empty key `[]`, i.e. the join is itself ≤1-row.
 * Full outer stays `[]` (two non-matching ≤1-row sides produce two padded rows).
 * This is the logical-key layer only; FD-provable ≤1-row-ness flows through the
 * physical path (`analyzeJoinKeyCoverage` → `propagateJoinFds`).
 *
 * `equiPairs` is optional; when omitted, the LEFT/RIGHT and inner/cross branches
 * only preserve keys via an empty-key (≤1-row) side, since no equi-pair coverage
 * can be proven.
 */
export function combineJoinKeys(
	leftKeys: ReadonlyArray<ReadonlyArray<ColRef>>,
	rightKeys: ReadonlyArray<ReadonlyArray<ColRef>>,
	joinType: JoinType,
	leftColumnCount: number,
	equiPairs?: ReadonlyArray<{ left: number; right: number }>,
): ColRef[][] {
	switch (joinType) {
		case 'inner':
		case 'cross': {
			const result: ColRef[][] = [];
			const leftEqSet = new Set<number>((equiPairs ?? []).map(p => p.left));
			const rightEqSet = new Set<number>((equiPairs ?? []).map(p => p.right));
			// Left's keys survive only when each left row matches ≤ 1 right row,
			// i.e. the equi-pairs cover a right-side key (or right is ≤1-row).
			const leftKeysSurvive = joinPairsCoverKey(rightKeys, rightEqSet);
			if (leftKeysSurvive) {
				for (const key of leftKeys) {
					result.push(key.map(c => ({ index: c.index, desc: c.desc })));
				}
			}
			// Symmetrically for the right side.
			const rightKeysSurvive = joinPairsCoverKey(leftKeys, leftEqSet);
			if (rightKeysSurvive) {
				for (const key of rightKeys) {
					result.push(key.map(c => ({ index: c.index + leftColumnCount, desc: c.desc })));
				}
			}
			// True relational product: when NEITHER side's key is covered by the
			// equi-predicate (a bare cross join, or an inner join whose predicate
			// touches no key) but BOTH sides advertise a non-empty key, the pair
			// (leftKey, rightKey) is itself unique on the product — leftKey is
			// unique on the left, rightKey on the right, and inner/cross only
			// removes (leftRow, rightRow) pairs, never duplicates one, so each
			// (leftKey-value, rightKey-value) combination occurs at most once.
			// Emit exactly ONE product key (the lex-min from each side) so growth
			// is bounded to ≤1 new key per join node regardless of how many keys
			// each side carries. A ≤1-row side has only the empty key, which makes
			// joinPairsCoverKey vacuously true above (so the survivor branch already
			// fired) and also makes selectLexMinKey return undefined, so the ≤1-row
			// case never reaches a product key. Full-row set-ness of the product is
			// carried separately by RelationType.isSet.
			if (!leftKeysSurvive && !rightKeysSurvive) {
				const leftPick = selectLexMinKey(leftKeys, c => c.index);
				const rightPick = selectLexMinKey(rightKeys, c => c.index);
				if (leftPick && rightPick) {
					result.push([
						...leftPick.map(c => ({ index: c.index, desc: c.desc })),
						...rightPick.map(c => ({ index: c.index + leftColumnCount, desc: c.desc })),
					]);
				}
			}
			// When both sides are ≤1-row their empty keys both push through above,
			// advertising the join's own empty key; dedupe the redundant pair.
			return dedupeKeys(result);
		}
		case 'left': {
			// No early-return on missing equiPairs: a ≤1-row right side covers
			// regardless of equi-pairs (joinPairsCoverKey recognizes the empty key).
			const rightEqSet = new Set<number>((equiPairs ?? []).map(p => p.right));
			if (!joinPairsCoverKey(rightKeys, rightEqSet)) return [];
			// left's keys survive; if left is also ≤1-row its empty key carries here,
			// advertising the join's ≤1-row-ness when both sides are ≤1-row.
			return dedupeKeys(leftKeys.map(key => key.map(c => ({ index: c.index, desc: c.desc }))));
		}
		case 'right': {
			const leftEqSet = new Set<number>((equiPairs ?? []).map(p => p.left));
			if (!joinPairsCoverKey(leftKeys, leftEqSet)) return [];
			return dedupeKeys(rightKeys.map(key => key.map(c => ({ index: c.index + leftColumnCount, desc: c.desc }))));
		}
		case 'semi':
		case 'anti':
			return leftKeys.map(key => key.map(c => ({ index: c.index, desc: c.desc })));
		case 'full':
		default:
			return [];
	}
}

/**
 * Result of analyzing key coverage for a join's equi-join pairs.
 *
 * `preservedKeys` lists the per-output-column key sets that survive the join
 * (combined left/right indices, with right's indices already shifted by
 * `leftColumnCount`). Empty when no key survives. Callers translate each
 * preserved key into the FD `key → (all_other_join_cols)` via `superkeyToFd`.
 */
export interface JoinKeyCoverageResult {
	leftKeyCovered: boolean;
	rightKeyCovered: boolean;
	preservedKeys: number[][];
	estimatedRows: number | undefined;
}

/**
 * Shared key-coverage analysis for all join node types.
 *
 * Checks whether equi-join pairs cover a unique key on either side (via logical
 * `RelationType.keys` or the FD closure of the side's physical properties). When
 * a key is covered, the other side's unique keys are preserved and
 * estimatedRows is capped at the non-covered side's row count.
 *
 * @param joinType       The join type (inner, left, semi, etc.)
 * @param leftPhys       Physical properties of the left child
 * @param rightPhys      Physical properties of the right child
 * @param leftType       Logical type of the left child (for logical keys + colCount)
 * @param rightType      Logical type of the right child (for logical keys + colCount)
 * @param equiPairs      Equi-join column index pairs (left index, right index)
 * @param leftRows       Estimated rows from the left child — pass the PHYSICAL
 *                       count (`physicalSourceRows`), not the logical getter: a
 *                       physical access node declares no `estimatedRows` getter,
 *                       so the logical read is `undefined` by the time a join's
 *                       `computePhysical` runs.
 * @param rightRows      Estimated rows from the right child (same rule)
 * @param leftColumnCount Number of columns on the left side (for shifting right key indices)
 */
export function analyzeJoinKeyCoverage(
	joinType: JoinType,
	leftPhys: PhysicalProperties | undefined,
	rightPhys: PhysicalProperties | undefined,
	leftType: RelationType | undefined,
	rightType: RelationType | undefined,
	equiPairs: ReadonlyArray<{ left: number; right: number }>,
	leftRows: number | undefined,
	rightRows: number | undefined,
	leftColumnCount: number,
): JoinKeyCoverageResult {
	const leftColCount = leftType?.columns.length ?? leftColumnCount;
	const rightColCount = rightType?.columns.length ?? 0;

	// Logical keys on each side, as column-index arrays. Used only as the
	// fallback when the side's logical type is unavailable (param allows
	// `undefined`); otherwise the unified `keysOf` / `isUnique` surface is read.
	const leftLogicalKeys = (leftType?.keys ?? []).map(k => k.map(c => c.index));
	const rightLogicalKeys = (rightType?.keys ?? []).map(k => k.map(c => c.index));

	// Unified uniqueness read surface per side: declared keys + FD-derived keys +
	// the empty (≤1-row) key, all in one place. Built only when the logical type
	// is present; `keysOf`/`isUnique` need it for column count and declared keys.
	const leftRel: KeyRel | undefined = leftType ? { getType: () => leftType, physical: leftPhys } : undefined;
	const rightRel: KeyRel | undefined = rightType ? { getType: () => rightType, physical: rightPhys } : undefined;

	// Surviving keys on each side, sourced from `keysOf` (declared + FD-derived +
	// empty key) so FD-only keys flow through; falls back to logical keys when the
	// type is unavailable. Right indices are shifted by `leftColumnCount`.
	const leftKeys = leftRel ? keysOf(leftRel).map(k => k.slice()) : leftLogicalKeys;
	const rightKeysShifted = (rightRel ? keysOf(rightRel).map(k => k.slice()) : rightLogicalKeys)
		.map(k => k.map(i => i + leftColumnCount));

	if (joinType === 'semi' || joinType === 'anti') {
		// Left's keys survive (output is the left shape). Preserved-key list mirrors
		// left's keys; the propagateJoinFds layer materializes them as FDs. A ≤1-row
		// left side carries its empty key here, so the semi/anti output stays ≤1-row.
		return {
			leftKeyCovered: false,
			rightKeyCovered: false,
			preservedKeys: leftKeys.map(k => k.slice()),
			estimatedRows: undefined,
		};
	}

	if (joinType === 'full') {
		return { leftKeyCovered: false, rightKeyCovered: false, preservedKeys: [], estimatedRows: undefined };
	}

	const leftEqSet = new Set<number>(equiPairs.map(p => p.left));
	const rightEqSet = new Set<number>(equiPairs.map(p => p.right));

	function coversLogicalKey(keys: ReadonlyArray<ReadonlyArray<number>>, eqSet: Set<number>): boolean {
		return keys.some(key => key.length > 0 && key.every(idx => eqSet.has(idx)));
	}

	// A side's key is "covered" when the equi-pairs are row-unique on it. The
	// single `isUnique` call folds the old two-surface check AND adds empty-key
	// recognition: a ≤1-row side has `[]` in `keysOf`, and `[] ⊆ anything`, so
	// `isUnique` reports it covered regardless of equi-pairs. The no-logical-type
	// fallback uses the same kind-aware uniqueness primitive with a conservative
	// `isSet: false` (set-ness is unknowable without the type) — coverage alone
	// must never mint a preserved key, since `withKeyFds` turns preserved keys
	// into 'unique' FDs downstream.
	const leftKeyCovered = leftRel
		? isUnique(equiPairs.map(p => p.left), leftRel)
		: coversLogicalKey(leftLogicalKeys, leftEqSet) || isUniqueDeterminant(leftEqSet, leftPhys?.fds, leftColCount, false);
	const rightKeyCovered = rightRel
		? isUnique(equiPairs.map(p => p.right), rightRel)
		: coversLogicalKey(rightLogicalKeys, rightEqSet) || isUniqueDeterminant(rightEqSet, rightPhys?.fds, rightColCount, false);

	// ≤1-row sides: the named spelling of the at-most-one-row predicate.
	const leftIsSingleton = leftRel ? isAtMostOneRow(leftRel) : false;
	const rightIsSingleton = rightRel ? isAtMostOneRow(rightRel) : false;

	const preservedKeys: number[][] = [];
	let estimatedRows: number | undefined = undefined;

	if (joinType === 'inner' || joinType === 'cross') {
		if (rightKeyCovered) preservedKeys.push(...leftKeys.map(k => k.slice()));
		if (leftKeyCovered) preservedKeys.push(...rightKeysShifted.map(k => k.slice()));
		// Both sides ≤1-row ⇒ the join is ≤1-row: emit the empty key, which
		// `propagateJoinFds` → `superkeyToFd([])` materializes as `∅ → all_cols`.
		if (leftIsSingleton && rightIsSingleton) preservedKeys.push([]);

		// Cardinality reduction: when a key is covered, result rows ≤ the other side's rows
		if (rightKeyCovered && typeof leftRows === 'number') estimatedRows = leftRows;
		if (leftKeyCovered && typeof rightRows === 'number') estimatedRows = (estimatedRows === undefined) ? rightRows : Math.min(estimatedRows, rightRows);

		// True relational product (mirrors combineJoinKeys): neither side's key is
		// covered by the equi-predicate, yet both sides are keyed, so the composite
		// (leftKey + rightKey-shifted) is itself unique - each (leftKey, rightKey)
		// pair occurs at most once (inner/cross only removes pairs, never
		// duplicates). Emit ONE lex-min product key to bound blow-up to one new key
		// per node. A 1-row side carries only the empty key, so selectLexMinKey
		// returns undefined for it and the composite is skipped (the singleton
		// branch above already handles that case). rightKeysShifted is already
		// shifted; propagateJoinFds materializes this as the composite-key FD.
		if (!leftKeyCovered && !rightKeyCovered) {
			const leftPick = selectLexMinKey(leftKeys, i => i);
			const rightPick = selectLexMinKey(rightKeysShifted, i => i);
			if (leftPick && rightPick) {
				preservedKeys.push([...leftPick, ...rightPick]);
			}
		}
	} else if (joinType === 'left') {
		// LEFT outer: left's keys survive (and left's rowcount caps the output) iff
		// the equi-pairs cover a right-side unique key — each left row then matches
		// ≤ 1 right row, so no row duplication. The right-side keys do NOT survive:
		// unmatched left rows produce NULL-padded right columns, breaking right keys.
		if (rightKeyCovered) {
			preservedKeys.push(...leftKeys.map(k => k.slice()));
			if (typeof leftRows === 'number') estimatedRows = leftRows;
		}
		// Both sides ≤1-row ⇒ ≤1 matching row per ≤1 left row ⇒ join is ≤1-row.
		if (leftIsSingleton && rightIsSingleton) preservedKeys.push([]);
	} else if (joinType === 'right') {
		// Symmetric to LEFT.
		if (leftKeyCovered) {
			preservedKeys.push(...rightKeysShifted.map(k => k.slice()));
			if (typeof rightRows === 'number') estimatedRows = rightRows;
		}
		if (leftIsSingleton && rightIsSingleton) preservedKeys.push([]);
	}

	return { leftKeyCovered, rightKeyCovered, preservedKeys, estimatedRows };
}

/**
 * Extract TableSchema from a plan node by walking down through common wrappers
 * to find a RetrieveNode or TableReferenceNode.
 *
 * Permissive: answers "which table does this subtree ultimately read?", walking
 * through ANY single-relation operator including aggregates and recursive CTEs.
 * When the question is instead "whose statistics describe the rows arriving
 * here", use {@link extractRowSourceTableSchema}.
 *
 * **Not for FK/PK alignment**, and no production caller uses it for that any
 * more: a schema alone cannot say which base-table column an output position
 * came from, which is the defect `resolveTableColumnMapping` (`ind-utils.ts`)
 * exists to prevent. It survives as the permissive half of the pair the
 * selectivity rule's strict walk is defined against — its own unit tests pin
 * that contrast.
 */
export function extractTableSchema(node: RelationalPlanNode): TableSchema | undefined {
	return walkToTableSchema(node, false);
}

/**
 * The base table whose rows actually reach `node` — declines at any operator that
 * changes the row population (aggregate, recursive CTE, set operation) rather than
 * walking through it. Use this when the question is "whose statistics describe these
 * rows"; use {@link extractTableSchema} when the question is "which table does this
 * subtree read" (FK/key analysis).
 */
export function extractRowSourceTableSchema(node: RelationalPlanNode): TableSchema | undefined {
	return walkToTableSchema(node, true);
}

/**
 * Shared descent for both variants. `strict` stops the single-relation descent at
 * any row-population-changing operator so the two walks cannot drift apart.
 */
function walkToTableSchema(node: RelationalPlanNode, strict: boolean): TableSchema | undefined {
	// Use duck typing to avoid circular imports
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const n = node as any;

	// TableReferenceNode
	if (n.nodeType === 'TableReference' && n.tableSchema) {
		return n.tableSchema as TableSchema;
	}

	// RetrieveNode
	if (n.nodeType === 'Retrieve' && n.tableRef) {
		return n.tableRef.tableSchema as TableSchema | undefined;
	}

	// A row-population-changing node still has exactly one relation in some shapes
	// (an aggregate's source, a recursive CTE's base case), so the strict walk must
	// decline BEFORE the single-child descent below would step through it.
	if (strict && changesRowPopulation(node)) {
		return undefined;
	}

	// Walk through single-child wrappers (Filter, Project, Sort, etc.)
	const relations = node.getRelations?.() ?? [];
	if (relations.length === 1) {
		return walkToTableSchema(relations[0] as RelationalPlanNode, strict);
	}

	return undefined;
}

/**
 * Check if an FK→PK relationship aligns with equi-join pairs.
 *
 * **`fkTableCols` / `pkTableCols` must be BASE-TABLE column indices**, not the
 * output column positions of whatever relational subtree the join sees. FK and
 * PK declarations are stored in each table's own column order, and a sub-select
 * (or any projection) between the table and the join renames, reorders, and
 * drops columns — so an output index compared against a declaration silently
 * names a different column. Translate first via `ind-utils.ts`'s
 * `resolveTableColumnMapping` + `mapColumnsToTable`, and decline when a join
 * column has no base-table origin.
 *
 * Alignment is *positional*: for each declared FK column at index `i`, the
 * equi-pair partner must equal the FK's declared `referencedColumns[i]`. A
 * composite FK `(fa, fb) REFERENCES p(a, b)` only covers the pairing
 * `fa = a AND fb = b`; a permuted equi-pair set (`fa = b AND fb = a`) is NOT
 * guaranteed by the FK and must not be reported as aligned. A defensive
 * cross-check additionally requires every `fk.referencedColumns[i]` to be a
 * PK column so a malformed FK referencing non-PK columns is never reported as
 * an IND on the PK.
 */
export function checkFkPkAlignment(
	fkTable: TableSchema,
	pkTable: TableSchema,
	fkTableCols: ReadonlyArray<number>,
	pkTableCols: ReadonlyArray<number>,
): boolean {
	if (!fkTable.foreignKeys) return false;

	for (const fk of fkTable.foreignKeys) {
		if (fk.referencedTable.toLowerCase() !== pkTable.name.toLowerCase()) continue;

		const pkDef = pkTable.primaryKeyDefinition;
		if (pkDef.length === 0 || fk.columns.length !== pkDef.length) continue;

		// FK schemas store an empty referencedColumns at CREATE TABLE time; the
		// real indices are resolved against the parent here.
		let refCols: ReadonlyArray<number>;
		try {
			refCols = resolveReferencedColumns(fk, pkTable);
		} catch {
			continue;
		}
		if (refCols.length !== fk.columns.length) continue;

		// Build mapping: for each equi-pair, fk table column index -> pk table
		// column index
		const equiMap = new Map<number, number>();
		for (let i = 0; i < fkTableCols.length; i++) {
			equiMap.set(fkTableCols[i], pkTableCols[i]);
		}

		const pkColSet = new Set(pkDef.map(pk => pk.index));
		let allAligned = true;
		for (let i = 0; i < fk.columns.length; i++) {
			// Defensive: a malformed FK referencing a non-PK column must never be
			// reported as an IND on the parent PK.
			if (!pkColSet.has(refCols[i])) {
				allAligned = false;
				break;
			}
			// Positional match: the equi-partner of fk.columns[i] must equal the
			// parent column the FK declares at position i.
			const partner = equiMap.get(fk.columns[i]);
			if (partner !== refCols[i]) {
				allAligned = false;
				break;
			}
		}

		if (allAligned) return true;
	}

	return false;
}
