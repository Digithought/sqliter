/**
 * Unit net for the provenance-ranked comparison-collation lattice (ticket
 * `comparison-collation-provenance-and-precedence`). Pins the
 * rank/conflict table of `resolveComparisonCollation`, the RHS-merge rules of
 * `resolveInCollation`, the non-comparison propagation merge, and the
 * throwing `effective*` wrappers' error shapes. End-to-end behavior lives in
 * test/logic/06.4.4-comparison-collation-precedence.sqllogic.
 */
import { expect } from 'chai';
import {
	collationContribution,
	resolveComparisonCollation,
	resolveInCollation,
	resolveGroupCollation,
	effectiveGroupCollation,
	resolveSetOpColumnCollation,
	mergePropagatedCollation,
	effectiveComparisonCollation,
	isComparisonOperator,
	type CollationSource,
	type CollationResolution,
	type SetOpColumnCollation,
} from '../../src/planner/analysis/comparison-collation.js';
import type { ScalarType } from '../../src/common/datatype.js';
import { TEXT_TYPE } from '../../src/types/builtin-types.js';
import { EmptyScope } from '../../src/planner/scopes/empty.js';
import { ColumnReferenceNode } from '../../src/planner/nodes/reference.js';
import { QuereusError } from '../../src/common/errors.js';
import type * as AST from '../../src/parser/ast.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const scope = EmptyScope.instance as unknown as any;

function t(collationName?: string, collationSource?: CollationSource): ScalarType {
	return {
		typeClass: 'scalar',
		logicalType: TEXT_TYPE,
		collationName,
		collationSource,
		nullable: false,
		isReadOnly: false,
	};
}

function colNode(type: ScalarType, attrId = 1): ColumnReferenceNode {
	const expr: AST.ColumnExpr = { type: 'column', name: `c${attrId}` } as AST.ColumnExpr;
	return new ColumnReferenceNode(scope, expr, type, attrId, 0);
}

function expectResolved(res: CollationResolution, name: string): void {
	expect(res).to.deep.equal({ kind: 'resolved', name });
}

describe('comparison-collation provenance lattice', () => {
	describe('collationContribution', () => {
		it('no collationName → no contribution', () => {
			expect(collationContribution(t())).to.equal(undefined);
		});

		it('defaulted BINARY → no contribution (the engine floor is not a preference)', () => {
			expect(collationContribution(t('BINARY', 'default'))).to.equal(undefined);
		});

		it('absent source with a present name is treated as default (safe floor)', () => {
			expect(collationContribution(t('NOCASE'))).to.deep.equal({ name: 'NOCASE', rank: 1 });
			expect(collationContribution(t('BINARY'))).to.equal(undefined);
		});

		it('ranks: explicit 3, declared 2, default 1; names normalize', () => {
			expect(collationContribution(t('nocase', 'explicit'))).to.deep.equal({ name: 'NOCASE', rank: 3 });
			expect(collationContribution(t('BINARY', 'declared'))).to.deep.equal({ name: 'BINARY', rank: 2 });
			expect(collationContribution(t('RTRIM', 'default'))).to.deep.equal({ name: 'RTRIM', rank: 1 });
		});
	});

	describe('resolveComparisonCollation rank/conflict table', () => {
		it('no contributions → BINARY', () => {
			expectResolved(resolveComparisonCollation(t(), t()), 'BINARY');
			expectResolved(resolveComparisonCollation(t('BINARY', 'default'), t()), 'BINARY');
		});

		it('headline: declared NOCASE vs defaulted BINARY → NOCASE, both spellings', () => {
			expectResolved(resolveComparisonCollation(t('NOCASE', 'declared'), t('BINARY', 'default')), 'NOCASE');
			expectResolved(resolveComparisonCollation(t('BINARY', 'default'), t('NOCASE', 'declared')), 'NOCASE');
		});

		it('higher rank wins: explicit > declared > default', () => {
			expectResolved(resolveComparisonCollation(t('BINARY', 'explicit'), t('NOCASE', 'declared')), 'BINARY');
			expectResolved(resolveComparisonCollation(t('BINARY', 'declared'), t('NOCASE', 'default')), 'BINARY');
			expectResolved(resolveComparisonCollation(t('NOCASE', 'explicit'), t('RTRIM', 'default')), 'NOCASE');
		});

		it('same rank, same name → that name', () => {
			expectResolved(resolveComparisonCollation(t('NOCASE', 'declared'), t('NOCASE', 'declared')), 'NOCASE');
			expectResolved(resolveComparisonCollation(t('NOCASE', 'explicit'), t('nocase', 'explicit')), 'NOCASE');
			expectResolved(resolveComparisonCollation(t('NOCASE', 'default'), t('NOCASE', 'default')), 'NOCASE');
		});

		it('rank-1 conflict resolves to BINARY silently (defaults are preferences)', () => {
			expectResolved(resolveComparisonCollation(t('NOCASE', 'default'), t('RTRIM', 'default')), 'BINARY');
		});

		it('rank-2 conflict, including declared BINARY (a real rank-2 preference)', () => {
			expect(resolveComparisonCollation(t('NOCASE', 'declared'), t('RTRIM', 'declared')))
				.to.deep.equal({ kind: 'conflict', level: 'declared', left: 'NOCASE', right: 'RTRIM' });
			expect(resolveComparisonCollation(t('BINARY', 'declared'), t('NOCASE', 'declared')).kind).to.equal('conflict');
		});

		it('rank-3 conflict', () => {
			expect(resolveComparisonCollation(t('NOCASE', 'explicit'), t('RTRIM', 'explicit')))
				.to.deep.equal({ kind: 'conflict', level: 'explicit', left: 'NOCASE', right: 'RTRIM' });
		});

		it('symmetry: kind and resolved name agree for flipped operands across the matrix', () => {
			const cells = [
				t(), t('BINARY', 'default'), t('NOCASE', 'default'), t('RTRIM', 'default'),
				t('BINARY', 'declared'), t('NOCASE', 'declared'), t('RTRIM', 'declared'),
				t('BINARY', 'explicit'), t('NOCASE', 'explicit'), t('RTRIM', 'explicit'),
				t('NOCASE'),
			];
			for (const a of cells) {
				for (const b of cells) {
					const ab = resolveComparisonCollation(a, b);
					const ba = resolveComparisonCollation(b, a);
					expect(ba.kind, `kind asymmetry for ${a.collationName}/${a.collationSource} vs ${b.collationName}/${b.collationSource}`).to.equal(ab.kind);
					if (ab.kind === 'resolved' && ba.kind === 'resolved') {
						expect(ba.name).to.equal(ab.name);
					}
				}
			}
		});
	});

	describe('resolveInCollation (condition vs merged RHS)', () => {
		it('literal-only list contributes nothing → condition drives', () => {
			expectResolved(resolveInCollation(t('NOCASE', 'declared'), [t(), t()]), 'NOCASE');
			expectResolved(resolveInCollation(t(), [t(), t()]), 'BINARY');
		});

		it('a declared-NOCASE element drives a plain condition', () => {
			expectResolved(resolveInCollation(t(), [t('NOCASE', 'declared')]), 'NOCASE');
		});

		it('highest-ranked element wins the RHS merge without conflict', () => {
			expectResolved(resolveInCollation(t(), [t('NOCASE', 'explicit'), t('RTRIM', 'declared')]), 'NOCASE');
		});

		it('rank-3/2 name conflicts among elements are conflicts', () => {
			expect(resolveInCollation(t(), [t('NOCASE', 'explicit'), t('RTRIM', 'explicit')]))
				.to.deep.equal({ kind: 'conflict', level: 'explicit', left: 'NOCASE', right: 'RTRIM' });
			expect(resolveInCollation(t(), [t('NOCASE', 'declared'), t('RTRIM', 'declared')]).kind).to.equal('conflict');
		});

		it('rank-1 conflicts among elements merge to no contribution → condition drives', () => {
			expectResolved(resolveInCollation(t('RTRIM', 'default'), [t('NOCASE', 'default'), t('RTRIM', 'default')]), 'RTRIM');
		});

		it('condition vs merged RHS resolves through the same lattice (conflict included)', () => {
			expect(resolveInCollation(t('NOCASE', 'declared'), [t('RTRIM', 'declared')]).kind).to.equal('conflict');
			expectResolved(resolveInCollation(t('NOCASE', 'declared'), [t('BINARY', 'explicit')]), 'BINARY');
		});
	});

	describe('resolveGroupCollation (N-ary comparison group: greatest/least)', () => {
		it('no operands / no contributions → BINARY floor', () => {
			expectResolved(resolveGroupCollation([]), 'BINARY');
			expectResolved(resolveGroupCollation([t(), t('BINARY', 'default'), t()]), 'BINARY');
		});

		it('a single explicit contributor wins over defaulted ones', () => {
			expectResolved(
				resolveGroupCollation([t('RTRIM', 'default'), t('NOCASE', 'explicit'), t('RTRIM', 'default')]),
				'NOCASE');
		});

		it('a single declared contributor drives an otherwise-plain group', () => {
			expectResolved(resolveGroupCollation([t(), t('NOCASE', 'declared'), t()]), 'NOCASE');
		});

		it('same rank, same name across the group → that name', () => {
			expectResolved(
				resolveGroupCollation([t('NOCASE', 'declared'), t('nocase', 'declared'), t('NOCASE', 'declared')]),
				'NOCASE');
		});

		it('equal-rank name conflict at rank ≥ 2 is a conflict, reported once', () => {
			expect(resolveGroupCollation([t(), t('NOCASE', 'declared'), t('RTRIM', 'declared')]))
				.to.deep.equal({ kind: 'conflict', level: 'declared', left: 'NOCASE', right: 'RTRIM' });
			expect(resolveGroupCollation([t('NOCASE', 'explicit'), t('RTRIM', 'explicit'), t('NOCASE', 'explicit')]).kind)
				.to.equal('conflict');
		});

		it('rank-1 conflict resolves to BINARY silently (defaults are preferences)', () => {
			expectResolved(resolveGroupCollation([t('NOCASE', 'default'), t('RTRIM', 'default')]), 'BINARY');
		});

		it('a higher-ranked contributor overrides a lower-rank disagreement', () => {
			expectResolved(
				resolveGroupCollation([t('NOCASE', 'declared'), t('RTRIM', 'default'), t('NOCASE', 'default')]),
				'NOCASE');
		});

		it('order-independent: permuting the group never changes the outcome', () => {
			const group = [t('RTRIM', 'default'), t('NOCASE', 'explicit'), t('NOCASE', 'declared')];
			expectResolved(resolveGroupCollation(group), 'NOCASE');
			expectResolved(resolveGroupCollation([...group].reverse()), 'NOCASE');
		});

		it('reduces to resolveComparisonCollation for two operands', () => {
			const cases: Array<[ScalarType, ScalarType]> = [
				[t(), t()],
				[t('NOCASE', 'declared'), t('BINARY', 'default')],
				[t('BINARY', 'explicit'), t('NOCASE', 'declared')],
				[t('NOCASE', 'default'), t('RTRIM', 'default')],
				[t('NOCASE', 'declared'), t('RTRIM', 'declared')],
			];
			for (const [a, b] of cases) {
				expect(resolveGroupCollation([a, b])).to.deep.equal(resolveComparisonCollation(a, b));
			}
		});

		it('effectiveGroupCollation throws QuereusError on a conflict, resolves otherwise', () => {
			expect(() => effectiveGroupCollation([t('NOCASE', 'declared'), t('RTRIM', 'declared')]))
				.to.throw(QuereusError, /ambiguous collation .* NOCASE vs RTRIM/);
			expect(() => effectiveGroupCollation([t('NOCASE', 'explicit'), t('RTRIM', 'explicit')]))
				.to.throw(QuereusError, /conflicting COLLATE clauses .* NOCASE vs RTRIM/);
			expect(effectiveGroupCollation([t(), t('nocase', 'declared')])).to.equal('NOCASE');
		});
	});

	describe('resolveSetOpColumnCollation (set-op cross-input column merge)', () => {
		// The resolved form keeps the winning RANK (as collationSource) that the bare
		// `resolveComparisonCollation` name-only form discards — needed so a nested
		// set-op re-resolves at the correct rank. Otherwise the rank table is identical.

		it('both absent / defaulted BINARY → resolved with no collation (BINARY floor)', () => {
			expect(resolveSetOpColumnCollation(t(), t())).to.deep.equal({ kind: 'resolved' });
			expect(resolveSetOpColumnCollation(t('BINARY', 'default'), t())).to.deep.equal({ kind: 'resolved' });
			expect(resolveSetOpColumnCollation(t('BINARY', 'default'), t('BINARY', 'default'))).to.deep.equal({ kind: 'resolved' });
		});

		it('one-sided contribution drives, carrying its source', () => {
			expect(resolveSetOpColumnCollation(t('NOCASE', 'declared'), t()))
				.to.deep.equal({ kind: 'resolved', collationName: 'NOCASE', collationSource: 'declared' });
			expect(resolveSetOpColumnCollation(t(), t('nocase', 'explicit')))
				.to.deep.equal({ kind: 'resolved', collationName: 'NOCASE', collationSource: 'explicit' });
		});

		it('declared beats defaulted BINARY (rank 2 over rank-1 no-contribution), both orders', () => {
			const want = { kind: 'resolved', collationName: 'NOCASE', collationSource: 'declared' };
			expect(resolveSetOpColumnCollation(t('NOCASE', 'declared'), t('BINARY', 'default'))).to.deep.equal(want);
			expect(resolveSetOpColumnCollation(t('BINARY', 'default'), t('NOCASE', 'declared'))).to.deep.equal(want);
		});

		it('explicit outranks declared, preserving rank 3 as the source', () => {
			expect(resolveSetOpColumnCollation(t('BINARY', 'explicit'), t('NOCASE', 'declared')))
				.to.deep.equal({ kind: 'resolved', collationName: 'BINARY', collationSource: 'explicit' });
		});

		it('same rank, same name → that name at that rank (explicit and declared)', () => {
			expect(resolveSetOpColumnCollation(t('NOCASE', 'explicit'), t('NOCASE', 'explicit')))
				.to.deep.equal({ kind: 'resolved', collationName: 'NOCASE', collationSource: 'explicit' });
			expect(resolveSetOpColumnCollation(t('NOCASE', 'declared'), t('nocase', 'declared')))
				.to.deep.equal({ kind: 'resolved', collationName: 'NOCASE', collationSource: 'declared' });
		});

		it('default/default different names → no collation (silent BINARY floor, never a conflict)', () => {
			expect(resolveSetOpColumnCollation(t('NOCASE', 'default'), t('RTRIM', 'default')))
				.to.deep.equal({ kind: 'resolved' });
		});

		it('declared/declared different names → declared conflict', () => {
			expect(resolveSetOpColumnCollation(t('NOCASE', 'declared'), t('RTRIM', 'declared')))
				.to.deep.equal({ kind: 'conflict', level: 'declared', left: 'NOCASE', right: 'RTRIM' });
			// declared BINARY is a real rank-2 preference, so it conflicts with declared NOCASE.
			expect(resolveSetOpColumnCollation(t('BINARY', 'declared'), t('NOCASE', 'declared')).kind).to.equal('conflict');
		});

		it('explicit/explicit different names → explicit conflict', () => {
			expect(resolveSetOpColumnCollation(t('NOCASE', 'explicit'), t('RTRIM', 'explicit')))
				.to.deep.equal({ kind: 'conflict', level: 'explicit', left: 'NOCASE', right: 'RTRIM' });
		});

		it('symmetric: swapping operands yields the same outcome across the matrix', () => {
			const cells = [
				t(), t('BINARY', 'default'), t('NOCASE', 'default'), t('RTRIM', 'default'),
				t('BINARY', 'declared'), t('NOCASE', 'declared'), t('RTRIM', 'declared'),
				t('BINARY', 'explicit'), t('NOCASE', 'explicit'), t('RTRIM', 'explicit'),
				t('NOCASE'),
			];
			const pair = (r: SetOpColumnCollation): [string, string] =>
				r.kind === 'conflict' ? [r.left, r.right].sort() as [string, string] : ['', ''];
			for (const a of cells) {
				for (const b of cells) {
					const ab = resolveSetOpColumnCollation(a, b);
					const ba = resolveSetOpColumnCollation(b, a);
					const label = `${a.collationName}/${a.collationSource} vs ${b.collationName}/${b.collationSource}`;
					expect(ba.kind, `kind asymmetry for ${label}`).to.equal(ab.kind);
					if (ab.kind === 'resolved' && ba.kind === 'resolved') {
						expect(ba.collationName, `name asymmetry for ${label}`).to.equal(ab.collationName);
						expect(ba.collationSource, `source asymmetry for ${label}`).to.equal(ab.collationSource);
					} else if (ab.kind === 'conflict' && ba.kind === 'conflict') {
						expect(ba.level, `level asymmetry for ${label}`).to.equal(ab.level);
						expect(pair(ba), `conflict-pair asymmetry for ${label}`).to.deep.equal(pair(ab));
					}
				}
			}
		});

		it('resolved name agrees with resolveComparisonCollation (the equivalence the rank-keeping form extends)', () => {
			const cases: Array<[ScalarType, ScalarType]> = [
				[t('NOCASE', 'declared'), t('BINARY', 'default')],
				[t('BINARY', 'explicit'), t('NOCASE', 'declared')],
				[t('NOCASE', 'default'), t('RTRIM', 'default')],
				[t(), t()],
				[t(), t('NOCASE', 'explicit')],
			];
			for (const [a, b] of cases) {
				const setOp = resolveSetOpColumnCollation(a, b);
				const cmp = resolveComparisonCollation(a, b);
				expect(setOp.kind).to.equal('resolved');
				expect(cmp.kind).to.equal('resolved');
				if (setOp.kind === 'resolved' && cmp.kind === 'resolved') {
					// The comparison form floors absent contributions to BINARY; the set-op form
					// reports them as no-collation. They agree once BINARY ≡ no-collation.
					expect(setOp.collationName ?? 'BINARY').to.equal(cmp.name);
				}
			}
		});
	});

	describe('mergePropagatedCollation (concat / CASE)', () => {
		it('higher rank wins and carries its source', () => {
			expect(mergePropagatedCollation([t('BINARY', 'default'), t('NOCASE', 'declared')]))
				.to.deep.equal({ collationName: 'NOCASE', collationSource: 'declared' });
			expect(mergePropagatedCollation([t('NOCASE', 'explicit'), t('RTRIM', 'declared')]))
				.to.deep.equal({ collationName: 'NOCASE', collationSource: 'explicit' });
		});

		it('equal-rank disagreement propagates NO collation (no coin-flip), at every rank', () => {
			expect(mergePropagatedCollation([t('NOCASE', 'declared'), t('RTRIM', 'declared')])).to.deep.equal({});
			expect(mergePropagatedCollation([t('NOCASE', 'explicit'), t('RTRIM', 'explicit')])).to.deep.equal({});
			expect(mergePropagatedCollation([t('NOCASE', 'default'), t('RTRIM', 'default')])).to.deep.equal({});
		});

		it('order-independent: a later same-rank duplicate cannot resurrect a conflicted name', () => {
			const branches = [t('NOCASE', 'declared'), t('RTRIM', 'declared'), t('NOCASE', 'declared')];
			expect(mergePropagatedCollation(branches)).to.deep.equal({});
			expect(mergePropagatedCollation([...branches].reverse())).to.deep.equal({});
		});

		it('no contributions → no collation', () => {
			expect(mergePropagatedCollation([])).to.deep.equal({});
			expect(mergePropagatedCollation([t(), t('BINARY', 'default')])).to.deep.equal({});
		});
	});

	describe('throwing wrappers', () => {
		it('effectiveComparisonCollation throws QuereusError with the declared-conflict message', () => {
			const left = colNode(t('NOCASE', 'declared'), 1);
			const right = colNode(t('RTRIM', 'declared'), 2);
			expect(() => effectiveComparisonCollation(left, right))
				.to.throw(QuereusError, /ambiguous collation .* NOCASE vs RTRIM .* explicit COLLATE/);
		});

		it('explicit conflicts use the conflicting-COLLATE-clauses message', () => {
			const left = colNode(t('NOCASE', 'explicit'), 1);
			const right = colNode(t('RTRIM', 'explicit'), 2);
			expect(() => effectiveComparisonCollation(left, right))
				.to.throw(QuereusError, /conflicting COLLATE clauses .* NOCASE vs RTRIM/);
		});

		it('resolved cases return the normalized name', () => {
			expect(effectiveComparisonCollation(colNode(t('nocase', 'declared'), 1), colNode(t(), 2))).to.equal('NOCASE');
		});
	});

	describe('isComparisonOperator', () => {
		it('covers the comparison class (incl. IS forms) and excludes combiners', () => {
			for (const op of ['=', '==', '!=', '<>', '<', '<=', '>', '>=', 'IS', 'IS NOT', 'is not']) {
				expect(isComparisonOperator(op), op).to.equal(true);
			}
			for (const op of ['||', 'AND', 'OR', '+', 'LIKE', 'IN']) {
				expect(isComparisonOperator(op), op).to.equal(false);
			}
		});
	});
});
