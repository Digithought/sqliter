/**
 * Unit net for the semantic-ordering gate on physical equi-join keys (ticket
 * `mixed-type-equi-join-key-drops-semantic-matches`): the `semanticOrderingsAgree`
 * predicate itself, and `extractEquiPairs` applying it alongside the per-pair
 * collation tagging (`collationsMatch` / `valueDiscriminating`) and the
 * collation-conflict decline — over a spelled-out ON condition and over a
 * `using (…)` desugared by `buildUsingCondition`, which must agree. End-to-end
 * behavior lives in
 * test/logic/15.1-semantic-ordering.sqllogic; the resulting plan shapes are pinned
 * by test/plan/mixed-semantic-equi-key.spec.ts.
 */
import { expect } from 'chai';
import { semanticOrderingsAgree } from '../../src/util/comparison.js';
import { extractEquiPairs } from '../../src/planner/rules/join/equi-pair-extractor.js';
import { buildUsingCondition } from '../../src/planner/building/select.js';
import { ANY_TYPE, BLOB_TYPE, INTEGER_TYPE, REAL_TYPE, TEXT_TYPE } from '../../src/types/builtin-types.js';
import { DATE_TYPE, DATETIME_TYPE, TIMESPAN_TYPE } from '../../src/types/temporal-types.js';
import { JSON_TYPE } from '../../src/types/json-type.js';
import type { LogicalType } from '../../src/types/logical-type.js';
import { EmptyScope } from '../../src/planner/scopes/empty.js';
import type { Scope } from '../../src/planner/scopes/scope.js';
import { BinaryOpNode } from '../../src/planner/nodes/scalar.js';
import { ColumnReferenceNode } from '../../src/planner/nodes/reference.js';
import type { Attribute, ScalarPlanNode } from '../../src/planner/nodes/plan-node.js';
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

	// USING has no extractor of its own any more: `buildUsingCondition` desugars
	// `using (c)` into the `l.c = r.c` BinaryOpNode an ON join builds, and the same
	// `extractEquiPairs` sees it. These cases pin the gate/tagging behavior *through*
	// that desugar, so USING and ON cannot drift apart again (ticket
	// `bug-using-join-skips-cross-type-coercion`).
	describe('USING, desugared to an ON condition', () => {
		const scope: Scope = EmptyScope.instance;

		const attr = (id: number, name: string, logicalType: LogicalType, collationName = 'BINARY',
			collationSource?: CollationSource): Attribute =>
			({ id, name, type: { typeClass: 'scalar', logicalType, collationName, collationSource, nullable: false, isReadOnly: false } });

		const extractUsing = (
			usingColumns: string[], leftAttrs: Attribute[], rightAttrs: Attribute[],
		) => extractEquiPairs(
			buildUsingCondition(usingColumns, leftAttrs, rightAttrs, scope),
			new Set(leftAttrs.map(a => a.id)),
			new Set(rightAttrs.map(a => a.id)));

		it('extracts a pair when both sides agree on semantic ordering', () => {
			const result = extractUsing(
				['d'],
				[attr(1, 'd', TIMESPAN_TYPE)],
				[attr(2, 'd', TIMESPAN_TYPE)]);
			expect(result?.equiPairs).to.deep.equal([
				{ leftAttrId: 1, rightAttrId: 2, collationsMatch: true, valueDiscriminating: true },
			]);
			expect(result?.residual).to.equal(undefined);
		});

		it('yields no pair for a mixed pair — the sole conjunct is the residual', () => {
			expect(extractUsing(
				['d'],
				[attr(1, 'd', TIMESPAN_TYPE)],
				[attr(2, 'd', TEXT_TYPE)])).to.equal(null);
		});

		it('keeps the sound column of a multi-column USING and demotes only the mixed one', () => {
			// Strictly better than the old USING extractor, which sank the whole
			// extraction because it had no residual to demote into. The desugared
			// condition does, so `k` still keys the join and `d` is evaluated as a
			// residual predicate under `=` semantics.
			const result = extractUsing(
				['k', 'd'],
				[attr(1, 'k', TEXT_TYPE), attr(3, 'd', TIMESPAN_TYPE)],
				[attr(2, 'k', TEXT_TYPE), attr(4, 'd', TEXT_TYPE)]);
			expect(result?.equiPairs).to.deep.equal([
				{ leftAttrId: 1, rightAttrId: 2, collationsMatch: true, valueDiscriminating: true },
			]);
			expect(result?.residual, 'the mixed conjunct must survive as residual').to.not.equal(undefined);
		});

		it('extracts a mismatched-collation pair tagged for hash join only (no value facts)', () => {
			// The pair is admitted with collationsMatch=false (merge declines it) and
			// valueDiscriminating=false (the resolved NOCASE comparison matches
			// value-different rows, so no key/FD/EC facts may be minted from it).
			expect(extractUsing(
				['k'],
				[attr(1, 'k', TEXT_TYPE, 'NOCASE', 'declared')],
				[attr(2, 'k', TEXT_TYPE, 'BINARY')])?.equiPairs).to.deep.equal([
				{ leftAttrId: 1, rightAttrId: 2, collationsMatch: false, valueDiscriminating: false },
			]);
		});

		it('tags a matched non-BINARY pair merge-eligible but still not value-discriminating', () => {
			expect(extractUsing(
				['k'],
				[attr(1, 'k', TEXT_TYPE, 'NOCASE', 'declared')],
				[attr(2, 'k', TEXT_TYPE, 'NOCASE', 'declared')])?.equiPairs).to.deep.equal([
				{ leftAttrId: 1, rightAttrId: 2, collationsMatch: true, valueDiscriminating: false },
			]);
		});

		it('raises on a same-rank declared collation conflict, exactly as the ON form does', () => {
			// NOCASE vs RTRIM, both declared: `BinaryOpNode.generateType` reports the
			// conflict as a user error, and the desugar forces that lazily-cached type
			// so `using (k)` fails at plan time like `l.k = r.k` does.
			expect(() => extractUsing(
				['k'],
				[attr(1, 'k', TEXT_TYPE, 'NOCASE', 'declared')],
				[attr(2, 'k', TEXT_TYPE, 'RTRIM', 'declared')])).to.throw(/ambiguous|collation/i);
		});

		it('matches USING column names case-insensitively', () => {
			expect(extractUsing(
				['D'],
				[attr(1, 'd', TEXT_TYPE)],
				[attr(2, 'd', TEXT_TYPE)])?.equiPairs).to.deep.equal([
				{ leftAttrId: 1, rightAttrId: 2, collationsMatch: true, valueDiscriminating: true },
			]);
		});

		it('raises when a USING column is absent from a side (formerly a silent empty result)', () => {
			expect(() => buildUsingCondition(
				['missing'],
				[attr(1, 'd', TEXT_TYPE)],
				[attr(2, 'd', TEXT_TYPE)], scope)).to.throw(/USING column not found on left side of join: missing/);
			expect(() => buildUsingCondition(
				['d'],
				[attr(1, 'd', TEXT_TYPE)],
				[attr(2, 'other', TEXT_TYPE)], scope)).to.throw(/USING column not found on right side of join: d/);
		});

		it('pairs first-match-per-side when one side repeats the USING name', () => {
			// `a join b using (k) join c using (k)`: the second join's left side carries
			// two `k` attributes. First match on each side is the long-standing pairing.
			expect(extractUsing(
				['k'],
				[attr(1, 'k', TEXT_TYPE), attr(3, 'k', TEXT_TYPE)],
				[attr(2, 'k', TEXT_TYPE)])?.equiPairs).to.deep.equal([
				{ leftAttrId: 1, rightAttrId: 2, collationsMatch: true, valueDiscriminating: true },
			]);
		});

		it('coerces a cross-type pair — no equi-pair, so it runs as the ON form does', () => {
			// insertCrossTypeCoercion wraps the JSON side in a CastNode, and
			// extractEquiPairs only recognizes bare ColumnReference = ColumnReference.
			// `on l.j = r.s` behaves identically; matching them is the point.
			expect(extractUsing(
				['k'],
				[attr(1, 'k', JSON_TYPE)],
				[attr(2, 'k', TEXT_TYPE)])).to.equal(null);
		});

		it('rejects an empty column list', () => {
			// The parser cannot produce `using ()`, so this is a guard on the exported
			// entry point rather than a reachable SQL path — an empty conjunct list would
			// otherwise reduce to `undefined` and silently turn the join into a cross join.
			expect(() => buildUsingCondition(
				[], [attr(1, 'k', TEXT_TYPE)], [attr(2, 'k', TEXT_TYPE)], scope))
				.to.throw(/USING clause requires at least one column/);
		});

		it('AND-combines multi-column USING into both pairs', () => {
			expect(extractUsing(
				['a', 'b'],
				[attr(1, 'a', TEXT_TYPE), attr(3, 'b', INTEGER_TYPE)],
				[attr(2, 'a', TEXT_TYPE), attr(4, 'b', INTEGER_TYPE)])?.equiPairs).to.have.deep.members([
				{ leftAttrId: 1, rightAttrId: 2, collationsMatch: true, valueDiscriminating: true },
				{ leftAttrId: 3, rightAttrId: 4, collationsMatch: true, valueDiscriminating: true },
			]);
		});
	});

	describe('extractEquiPairs (ON condition)', () => {
		const scope: Scope = EmptyScope.instance;

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
