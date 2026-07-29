/**
 * Pins the contract of the ONE pk row-identity recipe (`resolvePkIdentityKeying` /
 * `makePkIdentitySerializer` in `src/util/key-serializer.ts`) directly, against
 * hand-built structural table stubs — no `Database`, no vtab, no sync engine.
 *
 * Two out-of-package callers key rows by this recipe and must never disagree on
 * "same row?": `@quereus/isolation`'s overlay row-alignment key
 * (`makePkKeySerializer`) and `@quereus/sync`'s per-row CRDT metadata key
 * (`resolvePkKeying`). Both are now thin wrappers, so their integration suites only
 * cover the recipe transitively; these tests pin it where it lives.
 */
import { expect } from 'chai';
import {
	ANY_TYPE,
	BUILTIN_NORMALIZERS,
	INTEGER_TYPE,
	TEXT_TYPE,
	TIMESPAN_TYPE,
	makePkIdentitySerializer,
	resolvePkIdentityKeying,
	type KeyNormalizer,
	type KeyNormalizerResolver,
	type PkIdentityColumn,
	type PkIdentityTable,
} from '../../src/index.js';

const IDENTITY: KeyNormalizer = s => s;

/** A resolver that records every collation name it is asked for. */
function recordingResolver(): { resolve: KeyNormalizerResolver; asked: (string | undefined)[] } {
	const asked: (string | undefined)[] = [];
	const resolve: KeyNormalizerResolver = name => {
		asked.push(name);
		if (name === undefined) return IDENTITY;
		const normalizer = BUILTIN_NORMALIZERS[name.toUpperCase()];
		if (!normalizer) throw new Error(`test resolver: unknown collation ${name}`);
		return normalizer;
	};
	return { resolve, asked };
}

/** A single-column table whose one column is the primary key. */
function singlePkTable(column: PkIdentityColumn): PkIdentityTable {
	return { columns: [column], primaryKeyDefinition: [{ index: 0 }] };
}

describe('pk row identity (resolvePkIdentityKeying / makePkIdentitySerializer)', () => {
	describe('which collation each pk column is keyed under', () => {
		it('uses a textual column\'s own declared collation', () => {
			const { resolve, asked } = recordingResolver();
			resolvePkIdentityKeying(singlePkTable({ logicalType: TEXT_TYPE, collation: 'NOCASE' }), resolve);
			expect(asked).to.deep.equal(['NOCASE']);
		});

		it('uses BINARY for a text-capable but non-textual column', () => {
			const { resolve, asked } = recordingResolver();
			resolvePkIdentityKeying(singlePkTable({ logicalType: ANY_TYPE, collation: 'NOCASE' }), resolve);
			expect(asked).to.deep.equal(['BINARY']);
		});

		it('uses BINARY for a temporal column, whose collation never governs comparison', () => {
			const { resolve, asked } = recordingResolver();
			resolvePkIdentityKeying(singlePkTable({ logicalType: TIMESPAN_TYPE, collation: 'NOCASE' }), resolve);
			expect(asked).to.deep.equal(['BINARY']);
		});

		it('asks for no collation on a column that can never hold text, even one declaring COLLATE', () => {
			const { resolve, asked } = recordingResolver();
			resolvePkIdentityKeying(singlePkTable({ logicalType: INTEGER_TYPE, collation: 'NOCASE' }), resolve);
			expect(asked).to.deep.equal([undefined]);
		});

		it('resolves each pk column independently, in primary-key order', () => {
			const { resolve, asked } = recordingResolver();
			const table: PkIdentityTable = {
				columns: [
					{ logicalType: INTEGER_TYPE },
					{ logicalType: TEXT_TYPE, collation: 'NOCASE' },
					{ logicalType: TEXT_TYPE, collation: 'RTRIM' },
				],
				// Deliberately not schema order: the recipe follows primaryKeyDefinition.
				primaryKeyDefinition: [{ index: 2 }, { index: 0 }, { index: 1 }],
			};
			const keying = resolvePkIdentityKeying(table, resolve);
			expect(asked).to.deep.equal(['RTRIM', undefined, 'NOCASE']);
			expect(keying.normalizers).to.have.length(3);
		});
	});

	describe('which semantic transform each pk column carries', () => {
		it('carries the logical type\'s groupKey for a semantically-ordered type', () => {
			const { resolve } = recordingResolver();
			const keying = resolvePkIdentityKeying(singlePkTable({ logicalType: TIMESPAN_TYPE }), resolve);
			expect(keying.transforms[0]).to.be.a('function');
		});

		it('carries no transform for a type without semantic ordering', () => {
			const { resolve } = recordingResolver();
			const keying = resolvePkIdentityKeying(singlePkTable({ logicalType: TEXT_TYPE }), resolve);
			expect(keying.transforms[0]).to.equal(undefined);
		});
	});

	describe('serialized identity', () => {
		it('folds case on a NOCASE text pk', () => {
			const { resolve } = recordingResolver();
			const key = makePkIdentitySerializer(singlePkTable({ logicalType: TEXT_TYPE, collation: 'NOCASE' }), resolve);
			expect(key(['apple'])).to.equal(key(['APPLE']));
			expect(key(['apple'])).to.not.equal(key(['apricot']));
		});

		it('keeps case significant on a BINARY text pk', () => {
			const { resolve } = recordingResolver();
			const key = makePkIdentitySerializer(singlePkTable({ logicalType: TEXT_TYPE, collation: 'BINARY' }), resolve);
			expect(key(['apple'])).to.not.equal(key(['APPLE']));
		});

		it('folds two spellings of one elapsed time on a TIMESPAN pk', () => {
			const { resolve } = recordingResolver();
			const key = makePkIdentitySerializer(singlePkTable({ logicalType: TIMESPAN_TYPE }), resolve);
			expect(key(['PT1H'])).to.equal(key(['PT60M']));
			expect(key(['PT1H'])).to.not.equal(key(['PT61M']));
		});

		it('folds numeric storage classes on an INTEGER pk', () => {
			const { resolve } = recordingResolver();
			const key = makePkIdentitySerializer(singlePkTable({ logicalType: INTEGER_TYPE }), resolve);
			expect(key([5])).to.equal(key([5n]));
			expect(key([5])).to.not.equal(key([6]));
		});

		it('keeps composite key columns independent', () => {
			const { resolve } = recordingResolver();
			const table: PkIdentityTable = {
				columns: [{ logicalType: TEXT_TYPE, collation: 'BINARY' }, { logicalType: TEXT_TYPE, collation: 'BINARY' }],
				primaryKeyDefinition: [{ index: 0 }, { index: 1 }],
			};
			const key = makePkIdentitySerializer(table, resolve);
			expect(key(['a', 'b'])).to.not.equal(key(['ab', '']));
		});

		it('normalizes only the column that declares the collation', () => {
			const { resolve } = recordingResolver();
			const table: PkIdentityTable = {
				columns: [{ logicalType: TEXT_TYPE, collation: 'NOCASE' }, { logicalType: TEXT_TYPE, collation: 'BINARY' }],
				primaryKeyDefinition: [{ index: 0 }, { index: 1 }],
			};
			const key = makePkIdentitySerializer(table, resolve);
			expect(key(['a', 'b'])).to.equal(key(['A', 'b']));
			expect(key(['a', 'b'])).to.not.equal(key(['a', 'B']));
		});

		it('groups NULL instead of collapsing the whole key', () => {
			const { resolve } = recordingResolver();
			const table: PkIdentityTable = {
				columns: [{ logicalType: TEXT_TYPE, collation: 'BINARY' }, { logicalType: TEXT_TYPE, collation: 'BINARY' }],
				primaryKeyDefinition: [{ index: 0 }, { index: 1 }],
			};
			const key = makePkIdentitySerializer(table, resolve);
			expect(key([null, 'b'])).to.be.a('string').and.not.empty;
			expect(key([null, 'b'])).to.equal(key([null, 'b']));
			expect(key([null, 'b'])).to.not.equal(key([null, 'c']));
			expect(key([null, 'b'])).to.not.equal(key(['a', 'b']));
		});
	});

	describe('lighter-than-TableSchema stubs (test oracles, schema-less shims)', () => {
		it('degrades a table with no primaryKeyDefinition to an empty keying', () => {
			const { resolve, asked } = recordingResolver();
			const keying = resolvePkIdentityKeying({ columns: [{ logicalType: TEXT_TYPE }] }, resolve);
			expect(keying.normalizers).to.be.empty;
			expect(keying.transforms).to.be.empty;
			expect(asked).to.be.empty;
			expect(makePkIdentitySerializer({ columns: [] }, resolve)([])).to.equal('');
		});

		it('degrades a pk column with no logicalType to raw value identity', () => {
			const { resolve, asked } = recordingResolver();
			const key = makePkIdentitySerializer(singlePkTable({}), resolve);
			expect(asked).to.deep.equal([undefined]);
			expect(key(['apple'])).to.not.equal(key(['APPLE']));
		});

		it('degrades a pk column index that resolves to no column at all', () => {
			const { resolve, asked } = recordingResolver();
			const key = makePkIdentitySerializer({ columns: [], primaryKeyDefinition: [{ index: 0 }] }, resolve);
			expect(asked).to.deep.equal([undefined]);
			expect(key(['apple'])).to.equal('s:apple');
		});
	});
});
