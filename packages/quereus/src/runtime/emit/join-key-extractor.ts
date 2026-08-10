/**
 * Shared join-key extraction for hash-style join emitters (bloom join, key-set
 * semi join). Builds the per-pair collation normalizers and semantic-ordering
 * canonicalizers once, and returns a single `extractKey(row, indices)` closure
 * both sides of a join call. The two sides MUST agree bit-for-bit on the
 * serialized key — two copies of this logic would drift, and the drift would
 * show up as missing rows.
 */

import type { Row } from '../../common/types.js';
import type { ScalarType } from '../../common/datatype.js';
import type { EmissionContext } from '../emission-context.js';
import { serializeKey, serializeRowKey } from '../../util/key-serializer.js';
import { semanticKeyTransform } from '../../util/comparison.js';
import { effectiveCollationOfTypes, hashKeyCollationName } from '../../planner/analysis/comparison-collation.js';

/**
 * Serialize the join key of `row` at `indices` (one index per equi-pair, in
 * pair order). Returns null when any component is SQL NULL — a null key can
 * never match.
 */
export type JoinKeyExtractor = (row: Row, indices: readonly number[]) => string | null;

/**
 * Build a {@link JoinKeyExtractor} for a list of equi-pairs, given each pair's
 * two side types (left-side type first; order does not affect the result — the
 * collation resolution is symmetric).
 *
 * Per pair, the comparison collation is resolved through the shared provenance
 * lattice so both sides' key normalization agrees and matches every other join
 * algorithm and the nested-loop fallback. The symmetric resolution is what
 * makes MISMATCHED-collation pairs (declared NOCASE vs defaulted BINARY —
 * tagged `collationsMatch: false` by `equi-pair-extractor`) hash-joinable:
 * both sides' keys normalize under the one resolved collation, exactly what
 * `=` would compare under. Throws on an explicit/declared conflict — a loud
 * backstop; the extractor declines conflicting pairs (they stay in the
 * residual), so this is unreachable for admitted pairs.
 *
 * Semantic-ordering key types additionally canonicalize: the serialized key IS
 * the join match (no re-verify), so values `=` treats as equal (TIMESPAN
 * 'PT1H' ≡ 'PT60M') must serialize identically. Mirrors GROUP BY in
 * hash-aggregate.ts; per pair, active only when both sides declare the same
 * semantic-ordering logical type with a groupKey hook. LOCKSTEP: a MIXED pair
 * (one side semantic-ordering, the other not) can no longer reach a hash join —
 * `equi-pair-extractor`'s semantic-ordering gate demotes it to the residual, so
 * the `=` operator evaluates it in the generic join. Canonicalizing such a pair
 * instead of declining would be unsound anyway (TIMESPAN's groupKey yields a
 * NUMBER, which would hash-match a timespan-vs-integer pair that `=` calls
 * unequal); see the gate's docstring.
 */
export function buildJoinKeyExtractor(
	pairTypes: ReadonlyArray<readonly [ScalarType, ScalarType]>,
	ctx: EmissionContext,
): JoinKeyExtractor {
	const keyNormalizers = pairTypes.map(([leftType, rightType]) => {
		const collationName = effectiveCollationOfTypes(leftType, rightType);
		return ctx.resolveKeyNormalizer(hashKeyCollationName(collationName, [leftType, rightType]));
	});

	const keyCanonicalizers = pairTypes.map(([leftType, rightType]) => {
		const leftLogical = leftType.logicalType;
		const rightLogical = rightType.logicalType;
		return leftLogical === rightLogical ? semanticKeyTransform(leftLogical) : undefined;
	});
	const hasKeyCanonicalizer = keyCanonicalizers.some(c => c !== undefined);

	return (row: Row, indices: readonly number[]): string | null => {
		if (!hasKeyCanonicalizer) return serializeRowKey(row, indices, keyNormalizers);
		const values = indices.map((idx, i) => {
			const v = row[idx];
			return keyCanonicalizers[i] ? keyCanonicalizers[i]!(v) : v;
		});
		return serializeKey(values, keyNormalizers);
	};
}
