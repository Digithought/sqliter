/**
 * Unit net for the semantic-ordering gate on physical equi-join keys (ticket
 * `mixed-type-equi-join-key-drops-semantic-matches`): the `semanticOrderingsAgree`
 * predicate itself, and the USING extractor that applies it alongside the
 * matched-collation gate. End-to-end behavior lives in
 * test/logic/15.1-semantic-ordering.sqllogic; the resulting plan shapes are pinned
 * by test/plan/mixed-semantic-equi-key.spec.ts.
 */
import { expect } from 'chai';
import { semanticOrderingsAgree } from '../../src/util/comparison.js';
import { extractEquiPairsFromUsing } from '../../src/planner/rules/join/equi-pair-extractor.js';
import { ANY_TYPE, BLOB_TYPE, INTEGER_TYPE, REAL_TYPE, TEXT_TYPE } from '../../src/types/builtin-types.js';
import { DATE_TYPE, DATETIME_TYPE, TIMESPAN_TYPE } from '../../src/types/temporal-types.js';
import { JSON_TYPE } from '../../src/types/json-type.js';
import type { LogicalType } from '../../src/types/logical-type.js';

describe('semantic-ordering gate on equi-join keys', () => {
	describe('semanticOrderingsAgree', () => {
		it('admits a pair where neither side declares semantic ordering', () => {
			expect(semanticOrderingsAgree(TEXT_TYPE, TEXT_TYPE)).to.equal(true);
			expect(semanticOrderingsAgree(INTEGER_TYPE, REAL_TYPE)).to.equal(true);
			expect(semanticOrderingsAgree(TEXT_TYPE, BLOB_TYPE)).to.equal(true);
		});

		it('admits DATE/DATETIME against TEXT — their ISO text order IS their order', () => {
			expect(semanticOrderingsAgree(DATE_TYPE, TEXT_TYPE)).to.equal(true);
			expect(semanticOrderingsAgree(DATETIME_TYPE, TEXT_TYPE)).to.equal(true);
		});

		it('admits a pair where both sides declare the SAME semantic-ordering type', () => {
			expect(semanticOrderingsAgree(TIMESPAN_TYPE, TIMESPAN_TYPE)).to.equal(true);
			expect(semanticOrderingsAgree(JSON_TYPE, JSON_TYPE)).to.equal(true);
		});

		it('declines a mixed pair — one side semantic-ordering, the other plain', () => {
			expect(semanticOrderingsAgree(TIMESPAN_TYPE, TEXT_TYPE)).to.equal(false);
			expect(semanticOrderingsAgree(TEXT_TYPE, TIMESPAN_TYPE)).to.equal(false);
			expect(semanticOrderingsAgree(JSON_TYPE, TEXT_TYPE)).to.equal(false);
			expect(semanticOrderingsAgree(TIMESPAN_TYPE, INTEGER_TYPE)).to.equal(false);
		});

		it('declines two DIFFERENT semantic-ordering types', () => {
			expect(semanticOrderingsAgree(TIMESPAN_TYPE, JSON_TYPE)).to.equal(false);
		});

		it('treats an unknown (undefined) declared type as non-semantic', () => {
			expect(semanticOrderingsAgree(undefined, undefined)).to.equal(true);
			expect(semanticOrderingsAgree(undefined, TEXT_TYPE)).to.equal(true);
			expect(semanticOrderingsAgree(undefined, ANY_TYPE)).to.equal(true);
			expect(semanticOrderingsAgree(undefined, TIMESPAN_TYPE)).to.equal(false);
			expect(semanticOrderingsAgree(TIMESPAN_TYPE, undefined)).to.equal(false);
		});

		it('declines a semantic-ordering type whose `compare` hook is missing', () => {
			// hasSemanticOrdering requires BOTH the flag and a compare function, so a
			// malformed declaration degrades to "plain" rather than half-gating.
			const flagOnly = { ...TIMESPAN_TYPE, compare: undefined } as unknown as LogicalType;
			expect(semanticOrderingsAgree(flagOnly, TIMESPAN_TYPE)).to.equal(false);
			expect(semanticOrderingsAgree(flagOnly, TEXT_TYPE)).to.equal(true);
		});
	});

	describe('extractEquiPairsFromUsing', () => {
		const attr = (id: number, name: string, logicalType: LogicalType, collationName = 'BINARY') =>
			({ id, name, type: { collationName, logicalType } });

		it('extracts a pair when both sides agree on semantic ordering', () => {
			const result = extractEquiPairsFromUsing(
				['d'],
				[attr(1, 'd', TIMESPAN_TYPE)],
				[attr(2, 'd', TIMESPAN_TYPE)]);
			expect(result?.equiPairs).to.deep.equal([{ leftAttrId: 1, rightAttrId: 2 }]);
			expect(result?.residual).to.equal(undefined);
		});

		it('sinks the WHOLE extraction on a mixed pair (USING has no residual)', () => {
			expect(extractEquiPairsFromUsing(
				['d'],
				[attr(1, 'd', TIMESPAN_TYPE)],
				[attr(2, 'd', TEXT_TYPE)])).to.equal(null);
		});

		it('sinks the extraction when ANY column of a multi-column USING is mixed', () => {
			expect(extractEquiPairsFromUsing(
				['k', 'd'],
				[attr(1, 'k', TEXT_TYPE), attr(3, 'd', TIMESPAN_TYPE)],
				[attr(2, 'k', TEXT_TYPE), attr(4, 'd', TEXT_TYPE)])).to.equal(null);
		});

		it('still sinks on mismatched collations (the pre-existing gate)', () => {
			expect(extractEquiPairsFromUsing(
				['k'],
				[attr(1, 'k', TEXT_TYPE, 'NOCASE')],
				[attr(2, 'k', TEXT_TYPE, 'BINARY')])).to.equal(null);
		});

		it('matches USING column names case-insensitively and skips absent columns', () => {
			expect(extractEquiPairsFromUsing(
				['D'],
				[attr(1, 'd', TEXT_TYPE)],
				[attr(2, 'd', TEXT_TYPE)])?.equiPairs).to.deep.equal([{ leftAttrId: 1, rightAttrId: 2 }]);
			expect(extractEquiPairsFromUsing(
				['missing'],
				[attr(1, 'd', TEXT_TYPE)],
				[attr(2, 'd', TEXT_TYPE)])).to.equal(null);
		});
	});
});
