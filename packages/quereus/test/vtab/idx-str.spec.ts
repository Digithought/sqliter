import { expect } from 'chai';
import {
	decodeIdxStr,
	encodeIdxStr,
	idxStrSentinel,
	makeIdxStrSpec,
	planCodeFromKind,
	planKindFromCode,
	retargetIdxStr,
	type IdxStrSpec,
} from '../../src/vtab/idx-str.js';

/**
 * The seven `idxStr` shapes `rule-select-access-path.ts` emits. These strings are the
 * regression net: module runtimes (`scan-plan.ts`, `store-table-scan.ts`) parse them, and
 * `test/vtab/scan-plan-bounds.spec.ts` / `test/optimizer/in-multiseek-incount.spec.ts`
 * assert against their text.
 */
const EMITTED_SHAPES: { label: string; text: string; spec: IdxStrSpec }[] = [
	{
		label: 'ordered index walk (plan=0)',
		text: 'idx=_primary_(0);plan=0',
		spec: { indexName: '_primary_', nameArg: 0, plan: 0, params: new Map() },
	},
	{
		label: 'equality seek (plan=2)',
		text: 'idx=by_name(0);plan=2',
		spec: { indexName: 'by_name', nameArg: 0, plan: 2, params: new Map() },
	},
	{
		label: 'range seek (plan=3)',
		text: 'idx=by_name(0);plan=3',
		spec: { indexName: 'by_name', nameArg: 0, plan: 3, params: new Map() },
	},
	{
		label: 'IN multi-seek (plan=5)',
		text: 'idx=by_name(0);plan=5;inCount=3',
		spec: { indexName: 'by_name', nameArg: 0, plan: 5, params: new Map([['inCount', '3']]) },
	},
	{
		label: 'composite IN multi-seek (plan=5, seekWidth)',
		text: 'idx=by_ab(0);plan=5;inCount=3;seekWidth=2',
		spec: {
			indexName: 'by_ab', nameArg: 0, plan: 5,
			params: new Map([['inCount', '3'], ['seekWidth', '2']]),
		},
	},
	{
		label: 'OR-range multi-seek (plan=6)',
		text: 'idx=by_v(0);plan=6;rangeCount=2;rangeOps=ge:lt,gt',
		spec: {
			indexName: 'by_v', nameArg: 0, plan: 6,
			params: new Map([['rangeCount', '2'], ['rangeOps', 'ge:lt,gt']]),
		},
	},
	{
		label: 'prefix-equality + trailing range (plan=7)',
		text: 'idx=by_ab(0);plan=7;prefixLen=1',
		spec: { indexName: 'by_ab', nameArg: 0, plan: 7, params: new Map([['prefixLen', '1']]) },
	},
];

describe('idxStr codec', () => {
	describe('round-trips every shape the planner emits', () => {
		for (const { label, text, spec } of EMITTED_SHAPES) {
			it(`encodes ${label}`, () => {
				expect(encodeIdxStr(spec)).to.equal(text);
			});

			it(`decodes ${label}`, () => {
				const decoded = decodeIdxStr(text);
				expect(decoded).to.not.be.null;
				expect(decoded!.indexName).to.equal(spec.indexName);
				expect(decoded!.nameArg).to.equal(spec.nameArg);
				expect(decoded!.plan).to.equal(spec.plan);
				expect([...decoded!.params]).to.deep.equal([...spec.params]);
			});

			it(`round-trips ${label} byte-for-byte`, () => {
				expect(encodeIdxStr(decodeIdxStr(text)!)).to.equal(text);
			});
		}
	});

	describe('parameter values with punctuation', () => {
		it('keeps `:` and `,` inside a rangeOps value', () => {
			const spec = decodeIdxStr('idx=v(0);plan=6;rangeCount=2;rangeOps=ge:lt,gt')!;
			expect(spec.params.get('rangeOps')).to.equal('ge:lt,gt');
		});

		it('splits only on the FIRST `=` of a term', () => {
			const spec = decodeIdxStr('idx=v(0);plan=2;note=a=b')!;
			expect(spec.params.get('note')).to.equal('a=b');
			expect(encodeIdxStr(spec)).to.equal('idx=v(0);plan=2;note=a=b');
		});

		it('preserves parameter order', () => {
			const spec = decodeIdxStr('idx=v(0);plan=5;seekWidth=2;inCount=3')!;
			expect([...spec.params.keys()]).to.deep.equal(['seekWidth', 'inCount']);
			expect(encodeIdxStr(spec)).to.equal('idx=v(0);plan=5;seekWidth=2;inCount=3');
		});

		it('decodes terms in any order, since encode normalizes position', () => {
			const spec = decodeIdxStr('plan=3;idx=_primary_(1);argvMap=[1,0][2,1]')!;
			expect(spec.indexName).to.equal('_primary_');
			expect(spec.nameArg).to.equal(1);
			expect(spec.plan).to.equal(3);
			expect(spec.params.get('argvMap')).to.equal('[1,0][2,1]');
		});
	});

	describe('sentinels and unparseable strings', () => {
		it('decodes the sentinels to null', () => {
			expect(decodeIdxStr('fullscan')).to.be.null;
			expect(decodeIdxStr('empty')).to.be.null;
		});

		it('decodes null / empty / garbage to null', () => {
			expect(decodeIdxStr(null)).to.be.null;
			expect(decodeIdxStr('')).to.be.null;
			expect(decodeIdxStr('full_scan')).to.be.null;
			expect(decodeIdxStr('test-pushdown')).to.be.null;
			expect(decodeIdxStr('plan=3')).to.be.null;
		});

		it('decodes an idx term without a `(n)` group to null', () => {
			expect(decodeIdxStr('idx=by_name;plan=2')).to.be.null;
		});

		it('distinguishes the two sentinels', () => {
			expect(idxStrSentinel('fullscan')).to.equal('fullScan');
			expect(idxStrSentinel('empty')).to.equal('empty');
			expect(idxStrSentinel('idx=v(0);plan=2')).to.be.null;
			expect(idxStrSentinel(null)).to.be.null;
			expect(idxStrSentinel('')).to.be.null;
		});
	});

	describe('retargetIdxStr', () => {
		it('renames the index, preserving nameArg, an unknown plan code, and unknown params', () => {
			expect(retargetIdxStr('idx=_primary_7(3);plan=9;wat=x', '_primary_'))
				.to.equal('idx=_primary_(3);plan=9;wat=x');
		});

		it('preserves every parameter of a prefix-range plan', () => {
			expect(retargetIdxStr('idx=_primary_1(0);plan=7;prefixLen=1', '_primary_'))
				.to.equal('idx=_primary_(0);plan=7;prefixLen=1');
		});

		it('returns the string unchanged when it names no index', () => {
			expect(retargetIdxStr('fullscan', '_primary_')).to.equal('fullscan');
			expect(retargetIdxStr('empty', '_primary_')).to.equal('empty');
			expect(retargetIdxStr(null, '_primary_')).to.be.null;
			expect(retargetIdxStr('garbage', '_primary_')).to.equal('garbage');
		});

		it('is identity when the name already matches', () => {
			const s = 'idx=_primary_(0);plan=2';
			expect(retargetIdxStr(s, '_primary_')).to.equal(s);
		});
	});

	describe('plan code mapping', () => {
		it('is a bijection over the kinds the engine emits', () => {
			const kinds = ['scan', 'eqSeek', 'rangeSeek', 'multiSeek', 'multiRangeSeek', 'prefixRangeSeek'] as const;
			for (const kind of kinds) {
				expect(planKindFromCode(planCodeFromKind(kind))).to.equal(kind);
			}
		});

		it('maps the legacy descending codes to undefined (direction lives in idxStr)', () => {
			expect(planKindFromCode(1)).to.be.undefined;
			expect(planKindFromCode(4)).to.be.undefined;
		});
	});

	describe('makeIdxStrSpec', () => {
		it('always emits nameArg 0', () => {
			expect(encodeIdxStr(makeIdxStrSpec('by_v', 'eqSeek'))).to.equal('idx=by_v(0);plan=2');
		});

		it('rejects a reserved parameter key', () => {
			expect(() => encodeIdxStr(makeIdxStrSpec('v', 'scan', new Map([['plan', '9']]))))
				.to.throw(/reserved/);
		});
	});
});
