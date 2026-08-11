import { expect } from 'chai';
import { buildConformanceCheck, conformsToType } from '../../src/types/representation.js';
import {
	ANY_TYPE, BLOB_TYPE, BOOLEAN_TYPE, INTEGER_TYPE, NULL_TYPE, NUMERIC_TYPE, REAL_TYPE, TEXT_TYPE,
} from '../../src/types/builtin-types.js';
import { DATE_TYPE, TIMESTAMP_TYPE } from '../../src/types/temporal-types.js';
import { JSON_TYPE } from '../../src/types/json-type.js';
import type { LogicalType } from '../../src/types/logical-type.js';
import type { SqlValue } from '../../src/common/types.js';

/**
 * Rule R2 of docs/types.md § Physical representation — "does this value inhabit this
 * declared type's JS value space" — as the shared predicate in
 * `src/types/representation.ts`.
 *
 * Two consumers depend on the exact shape of this table and must not be allowed to
 * disagree about it: the `QUEREUS_REPR_STRICT` checker (`runtime/strict-representation.ts`)
 * turns a violation into an error, and the DML write path (`buildCellCoercion`) converts a
 * cell whose announced type the value contradicts. Enumerating every arm here is what
 * makes a generator over "every declared type × every JS value" unnecessary: the predicate
 * switches on `physicalType` alone (plus the NUMERIC name arm), so the table below IS its
 * whole state space.
 */
describe('type conformance (rule R2)', () => {
	const doc = { a: 1 } as unknown as SqlValue;
	const blob = new Uint8Array([1]) as unknown as SqlValue;

	/** One row per arm: the admitted values, then the rejected ones. */
	const arms: ReadonlyArray<{ type: LogicalType; admits: SqlValue[]; rejects: SqlValue[] }> = [
		// 1e20 rejects because a whole number past the safe-integer boundary is not an
		// INTEGER value — R1 makes it a bigint — so the write path converts rather than
		// storing the double.
		{
			type: INTEGER_TYPE,
			admits: [0, 42, -42, 9007199254740993n],
			rejects: [1.5, 'x', true, blob, doc, 1e20, NaN, Infinity],
		},
		{ type: TIMESTAMP_TYPE, admits: [0, 1700000000000], rejects: ['2024-01-05', 1.5] },
		{ type: REAL_TYPE, admits: [1.5, 0, NaN], rejects: [1n, 9007199254740993n, 'x', true, blob] },
		// NUMERIC shares REAL's physical type but admits bigint, matched by type NAME.
		{ type: NUMERIC_TYPE, admits: [1.5, 9007199254740993n], rejects: ['x', true, blob] },
		{ type: TEXT_TYPE, admits: ['', 'x'], rejects: [9, true, 1n, blob, doc] },
		{ type: DATE_TYPE, admits: ['2024-01-05', 'not a date'], rejects: [9, blob] },
		{ type: BLOB_TYPE, admits: [blob], rejects: ['x', 9, doc] },
		{ type: BOOLEAN_TYPE, admits: [true, false], rejects: [0, 1, 'true'] },
		// JSON: a native document, or a JSON scalar — which is physically a plain string,
		// number or boolean. A blob is not a document.
		{ type: JSON_TYPE, admits: [doc, 'abc', '9', 9, true], rejects: [blob, 1n] },
		// No value-space constraint at all.
		{ type: ANY_TYPE, admits: [9, 'x', true, blob, doc, 1n], rejects: [] },
		{ type: NULL_TYPE, admits: [9, 'x'], rejects: [] },
	];

	for (const { type, admits, rejects } of arms) {
		it(`${type.name} admits ${admits.length} forms and rejects ${rejects.length}`, () => {
			for (const value of admits) {
				expect(conformsToType(value as Exclude<SqlValue, null>, type), `${type.name} ← ${String(value)}`)
					.to.equal(true);
			}
			for (const value of rejects) {
				expect(conformsToType(value as Exclude<SqlValue, null>, type), `${type.name} ← ${String(value)}`)
					.to.equal(false);
			}
		});
	}

	it('pre-selects an arm only for a type that constrains something', () => {
		// `undefined` is the signal a per-row caller uses to skip the check entirely.
		expect(buildConformanceCheck(ANY_TYPE)).to.equal(undefined);
		expect(buildConformanceCheck(NULL_TYPE)).to.equal(undefined);
		expect(buildConformanceCheck(TEXT_TYPE)).to.be.a('function');
	});

	it('answers identically pre-selected and one-shot', () => {
		for (const { type, admits, rejects } of arms) {
			const check = buildConformanceCheck(type);
			for (const value of [...admits, ...rejects]) {
				const expected = conformsToType(value as Exclude<SqlValue, null>, type);
				expect(check === undefined || check(value as Exclude<SqlValue, null>)).to.equal(expected);
			}
		}
	});
});
