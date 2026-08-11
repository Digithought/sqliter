import { expect } from 'chai';
import { buildCellCoercion, buildRowCoercion } from '../../src/types/validation.js';
import { createDefaultColumnSchema, type ColumnSchema } from '../../src/schema/column.js';
import { ANY_TYPE, INTEGER_TYPE, REAL_TYPE, TEXT_TYPE } from '../../src/types/builtin-types.js';
import { JSON_TYPE } from '../../src/types/json-type.js';
import { DATE_TYPE } from '../../src/types/temporal-types.js';
import type { LogicalType } from '../../src/types/logical-type.js';
import type { Row, SqlValue } from '../../src/common/types.js';

/**
 * The DML write path's per-cell conversion decision (`buildCellCoercion` /
 * `buildRowCoercion` in `src/types/validation.ts`) — ticket
 * `dml-write-coercion-representation-guard`.
 *
 * The rule under test: convert a cell UNLESS its producing expression's static type IS
 * the column's type (registry singletons, object identity) AND the value in hand already
 * inhabits that type. The identity half alone was unsound — an announced type is an
 * inference the engine does not enforce, so a REAL-announced `sum()` can hand over a
 * bigint and a TEXT-announced positional `?` can hand over anything at all.
 *
 * The engine-level consequences of the same rule live in
 * `test/dml-write-representation.spec.ts`.
 */
describe('write-path cell coercion', () => {
	function column(name: string, logicalType: LogicalType): ColumnSchema {
		return { ...createDefaultColumnSchema(name), logicalType };
	}

	describe('buildCellCoercion', () => {
		it('skips a conforming value under an identity type match', () => {
			const coerce = buildCellCoercion(TEXT_TYPE, TEXT_TYPE, 'v');
			expect(coerce).to.be.a('function');
			expect(coerce!('9')).to.equal('9');
		});

		it('converts a NON-conforming value under an identity type match', () => {
			// The announced TEXT is contradicted by the value: an untyped positional `?`
			// announces TEXT and can be bound to anything.
			const coerce = buildCellCoercion(TEXT_TYPE, TEXT_TYPE, 'v')!;
			expect(coerce(9)).to.equal('9');
			expect(coerce(true)).to.equal('true');
			expect(coerce(9007199254740993n)).to.equal('9007199254740993');
			expect(coerce(new Uint8Array([65, 66]))).to.equal('AB');
		});

		it('converts a bigint reaching a REAL column that announced REAL', () => {
			// `sum()` announces REAL and returns a bigint past 2^53.
			const coerce = buildCellCoercion(REAL_TYPE, REAL_TYPE, 'r')!;
			const stored = coerce(18014398509481986n);
			expect(typeof stored).to.equal('number');
			expect(stored).to.equal(Number(18014398509481986n));
			// A plain number is left alone.
			expect(coerce(1.5)).to.equal(1.5);
		});

		it('converts unconditionally when the types differ', () => {
			const coerce = buildCellCoercion(TEXT_TYPE, INTEGER_TYPE, 'i')!;
			expect(coerce('42')).to.equal(42);
		});

		it('converts unconditionally when the source type is unknown', () => {
			const coerce = buildCellCoercion(undefined, INTEGER_TYPE, 'i')!;
			expect(coerce('42')).to.equal(42);
		});

		it('converts a conforming value when the types differ, to canonicalize spelling', () => {
			// The guard is a conjunction, not a replacement: a string conforms to DATE's TEXT
			// physical type, but a TEXT-announced expression still needs the DATE spelling.
			const coerce = buildCellCoercion(TEXT_TYPE, DATE_TYPE, 'd')!;
			expect(coerce('2024-01-05T10:30:00Z')).to.equal('2024-01-05');
		});

		it('leaves already-parsed JSON alone, including the scalars parse would damage', () => {
			const coerce = buildCellCoercion(JSON_TYPE, JSON_TYPE, 'j')!;
			const doc = { a: 1 };
			expect(coerce(doc as unknown as SqlValue)).to.equal(doc);
			// `JSON_TYPE.parse('abc')` throws and `parse('9')` silently returns the number 9;
			// both are JSON string scalars read back out of a JSON column, so neither converts.
			expect(coerce('abc')).to.equal('abc');
			expect(coerce('9')).to.equal('9');
			expect(coerce(9)).to.equal(9);
			expect(coerce(true)).to.equal(true);
		});

		it('needs no guard for an ANY column under an identity match', () => {
			// ANY constrains no value space, so there is provably nothing to do.
			expect(buildCellCoercion(ANY_TYPE, ANY_TYPE, 'v')).to.equal(undefined);
		});

		it('passes NULL through without consulting the guard', () => {
			expect(buildCellCoercion(TEXT_TYPE, TEXT_TYPE, 'v')!(null)).to.equal(null);
			expect(buildCellCoercion(undefined, TEXT_TYPE, 'v')!(null)).to.equal(null);
		});

		it('names the column in a conversion failure', () => {
			const coerce = buildCellCoercion(TEXT_TYPE, JSON_TYPE, 'doc')!;
			expect(() => coerce('not json')).to.throw(/doc/);
		});
	});

	describe('buildRowCoercion', () => {
		it('returns undefined only when no column converts AND none needs guarding', () => {
			const anyColumns = [column('a', ANY_TYPE), column('b', ANY_TYPE)];
			expect(buildRowCoercion([ANY_TYPE, ANY_TYPE], anyColumns)).to.equal(undefined);

			// A constrained column under an identity match still needs its guard.
			const textColumns = [column('a', TEXT_TYPE)];
			expect(buildRowCoercion([TEXT_TYPE], textColumns)).to.be.a('function');
		});

		it('guards identity cells and converts differing ones in one pass', () => {
			const columns = [column('i', INTEGER_TYPE), column('t', TEXT_TYPE), column('j', JSON_TYPE)];
			const coerce = buildRowCoercion([undefined, TEXT_TYPE, JSON_TYPE], columns)!;
			const doc = { a: 1 };
			const out = coerce(['42', 9, doc as unknown as SqlValue] as Row);
			expect(out[0]).to.equal(42);      // unknown source type ⇒ convert
			expect(out[1]).to.equal('9');     // identity, non-conforming ⇒ convert
			expect(out[2]).to.equal(doc);     // identity, conforming ⇒ untouched
		});

		it('copies the row rather than mutating it', () => {
			const columns = [column('t', TEXT_TYPE)];
			const row = [9] as Row;
			const out = buildRowCoercion([TEXT_TYPE], columns)!(row);
			expect(row[0]).to.equal(9);
			expect(out[0]).to.equal('9');
			expect(out).to.not.equal(row);
		});

		it('does not copy a row whose every guarded cell conforms', () => {
			// The guard made every constrained column carry a closure, so the all-identity
			// bulk-copy path (`insert into b select * from a`) reaches here on every row.
			// It must stay allocation-free, as it was when that path got no closure at all.
			const columns = [column('t', TEXT_TYPE), column('i', INTEGER_TYPE)];
			const coerce = buildRowCoercion([TEXT_TYPE, INTEGER_TYPE], columns)!;
			const row = ['x', 42] as Row;
			expect(coerce(row)).to.equal(row);
		});

		it('copies once when only a later cell converts', () => {
			const columns = [column('t', TEXT_TYPE), column('u', TEXT_TYPE)];
			const row = ['x', 9] as Row;
			const out = buildRowCoercion([TEXT_TYPE, TEXT_TYPE], columns)!(row);
			expect(out).to.not.equal(row);
			expect(out).to.deep.equal(['x', '9']);
			expect(row).to.deep.equal(['x', 9]);
		});

		it('leaves cells past the row length to the storage width guard', () => {
			const columns = [column('t', TEXT_TYPE), column('u', TEXT_TYPE)];
			const out = buildRowCoercion([TEXT_TYPE, TEXT_TYPE], columns)!([9] as Row);
			expect(out).to.deep.equal(['9']);
		});
	});
});
