/**
 * Unit net for the semantic-ordering gate on physical equi-join keys (ticket
 * `mixed-type-equi-join-key-drops-semantic-matches`): the `semanticOrderingsAgree`
 * predicate itself, and the USING extractor that applies it alongside the
 * per-pair collation tagging (`collationsMatch` / `valueDiscriminating`) and the
 * collation-conflict sink. End-to-end behavior lives in
 * test/logic/15.1-semantic-ordering.sqllogic; the resulting plan shapes are pinned
 * by test/plan/mixed-semantic-equi-key.spec.ts.
 */
import { expect } from 'chai';
import { semanticOrderingsAgree } from '../../src/util/comparison.js';
import { extractEquiPairs, extractEquiPairsFromUsing } from '../../src/planner/rules/join/equi-pair-extractor.js';
import { ANY_TYPE, BLOB_TYPE, INTEGER_TYPE, REAL_TYPE, TEXT_TYPE } from '../../src/types/builtin-types.js';
import { DATE_TYPE, DATETIME_TYPE, TIMESPAN_TYPE } from '../../src/types/temporal-types.js';
import { JSON_TYPE } from '../../src/types/json-type.js';
import type { LogicalType } from '../../src/types/logical-type.js';
import { EmptyScope } from '../../src/planner/scopes/empty.js';
import { BinaryOpNode } from '../../src/planner/nodes/scalar.js';
import { ColumnReferenceNode } from '../../src/planner/nodes/reference.js';
import type { ScalarPlanNode } from '../../src/planner/nodes/plan-node.js';
import type { CollationSource } from '../../src/common/datatype.js';
import type * as AST from '../../src/parser/ast.js';

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
		const attr = (id: number, name: string, logicalType: LogicalType, collationName = 'BINARY',
			collationSource?: 'explicit' | 'declared' | 'default') =>
			({ id, name, type: { collationName, collationSource, logicalType } });

		it('extracts a pair when both sides agree on semantic ordering', () => {
			const result = extractEquiPairsFromUsing(
				['d'],
				[attr(1, 'd', TIMESPAN_TYPE)],
				[attr(2, 'd', TIMESPAN_TYPE)]);
			expect(result?.equiPairs).to.deep.equal([
				{ leftAttrId: 1, rightAttrId: 2, collationsMatch: true, valueDiscriminating: true },
			]);
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

		it('extracts a mismatched-collation pair tagged for hash join only (no value facts)', () => {
			// Formerly the matched-collation gate sank the whole extraction; now the
			// pair is admitted with collationsMatch=false (merge declines it) and
			// valueDiscriminating=false (the resolved NOCASE comparison matches
			// value-different rows, so no key/FD/EC facts may be minted from it).
			expect(extractEquiPairsFromUsing(
				['k'],
				[attr(1, 'k', TEXT_TYPE, 'NOCASE', 'declared')],
				[attr(2, 'k', TEXT_TYPE, 'BINARY')])?.equiPairs).to.deep.equal([
				{ leftAttrId: 1, rightAttrId: 2, collationsMatch: false, valueDiscriminating: false },
			]);
		});

		it('tags a matched non-BINARY pair merge-eligible but still not value-discriminating', () => {
			expect(extractEquiPairsFromUsing(
				['k'],
				[attr(1, 'k', TEXT_TYPE, 'NOCASE', 'declared')],
				[attr(2, 'k', TEXT_TYPE, 'NOCASE', 'declared')])?.equiPairs).to.deep.equal([
				{ leftAttrId: 1, rightAttrId: 2, collationsMatch: true, valueDiscriminating: false },
			]);
		});

		it('sinks the extraction on a same-rank declared collation conflict', () => {
			// NOCASE vs RTRIM, both declared: the lattice reports `conflict` — a
			// plan-time user error surfaced elsewhere; extraction must neither throw
			// nor admit the pair, and USING has no residual, so the whole extraction
			// sinks and the generic join evaluates (and surfaces) the comparison.
			expect(extractEquiPairsFromUsing(
				['k'],
				[attr(1, 'k', TEXT_TYPE, 'NOCASE', 'declared')],
				[attr(2, 'k', TEXT_TYPE, 'RTRIM', 'declared')])).to.equal(null);
		});

		it('matches USING column names case-insensitively and skips absent columns', () => {
			expect(extractEquiPairsFromUsing(
				['D'],
				[attr(1, 'd', TEXT_TYPE)],
				[attr(2, 'd', TEXT_TYPE)])?.equiPairs).to.deep.equal([
				{ leftAttrId: 1, rightAttrId: 2, collationsMatch: true, valueDiscriminating: true },
			]);
			expect(extractEquiPairsFromUsing(
				['missing'],
				[attr(1, 'd', TEXT_TYPE)],
				[attr(2, 'd', TEXT_TYPE)])).to.equal(null);
		});
	});

	describe('extractEquiPairs (ON condition)', () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const scope = EmptyScope.instance as unknown as any;

		function colRef(
			attrId: number, index: number,
			collationName?: string, collationSource?: CollationSource,
			logicalType: LogicalType = TEXT_TYPE,
		): ColumnReferenceNode {
			const expr: AST.ColumnExpr = { type: 'column', name: `c${attrId}` } as AST.ColumnExpr;
			return new ColumnReferenceNode(scope, expr, {
				typeClass: 'scalar' as const,
				logicalType,
				collationName,
				collationSource,
				nullable: false,
				isReadOnly: false,
			}, attrId, index);
		}

		function binary(operator: string, left: ScalarPlanNode, right: ScalarPlanNode): BinaryOpNode {
			const ast: AST.BinaryExpr = {
				type: 'binary', operator,
				left: (left as unknown as { expression: AST.Expression }).expression,
				right: (right as unknown as { expression: AST.Expression }).expression,
			} as AST.BinaryExpr;
			return new BinaryOpNode(scope, ast, left, right);
		}

		const leftIds = new Set([1, 3]);
		const rightIds = new Set([2, 4]);

		it('tags a matched-BINARY pair as both merge-eligible and value-discriminating', () => {
			const result = extractEquiPairs(
				binary('=', colRef(1, 0), colRef(2, 0)), leftIds, rightIds);
			expect(result?.equiPairs).to.deep.equal([
				{ leftAttrId: 1, rightAttrId: 2, collationsMatch: true, valueDiscriminating: true },
			]);
			expect(result?.residual).to.equal(undefined);
		});

		it('extracts a mismatched-collation pair tagged hash-only (the store fk→pk shape)', () => {
			// Declared NOCASE on one side, defaulted BINARY on the other: the pair is
			// admitted so hash join can fire, but merge declines it and it mints no
			// value-level facts.
			const result = extractEquiPairs(
				binary('=', colRef(1, 0, 'NOCASE', 'declared'), colRef(2, 0)), leftIds, rightIds);
			expect(result?.equiPairs).to.deep.equal([
				{ leftAttrId: 1, rightAttrId: 2, collationsMatch: false, valueDiscriminating: false },
			]);
		});

		it('normalizes operand order — right = left still yields a left→right pair', () => {
			const result = extractEquiPairs(
				binary('=', colRef(2, 0), colRef(1, 0, 'NOCASE', 'declared')), leftIds, rightIds);
			expect(result?.equiPairs).to.deep.equal([
				{ leftAttrId: 1, rightAttrId: 2, collationsMatch: false, valueDiscriminating: false },
			]);
		});

		it('leaves a same-rank declared collation conflict in the residual (never throws, never extracts)', () => {
			// NOCASE vs RTRIM, both declared: `BinaryOpNode.generateType` is the site
			// that surfaces this as a user error. Extraction must neither throw nor
			// admit the pair — the emitters' lattice resolution would throw on it.
			const conflict = binary('=',
				colRef(3, 1, 'NOCASE', 'declared'), colRef(4, 1, 'RTRIM', 'declared'));
			const result = extractEquiPairs(
				binary('AND', binary('=', colRef(1, 0), colRef(2, 0)), conflict), leftIds, rightIds);
			expect(result?.equiPairs).to.deep.equal([
				{ leftAttrId: 1, rightAttrId: 2, collationsMatch: true, valueDiscriminating: true },
			]);
			expect(result?.residual, 'the conflicting conjunct must survive as residual').to.not.equal(undefined);
		});

		it('a non-textual pair stays value-discriminating despite a declared collation', () => {
			const result = extractEquiPairs(
				binary('=', colRef(1, 0, 'NOCASE', 'declared', INTEGER_TYPE), colRef(2, 0, undefined, undefined, INTEGER_TYPE)),
				leftIds, rightIds);
			expect(result?.equiPairs).to.deep.equal([
				{ leftAttrId: 1, rightAttrId: 2, collationsMatch: false, valueDiscriminating: true },
			]);
		});
	});
});
