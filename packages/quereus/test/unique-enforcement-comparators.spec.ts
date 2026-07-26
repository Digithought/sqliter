/**
 * Contract lock for {@link uniqueEnforcementComparators} — the single per-column
 * comparator builder every backend's UNIQUE re-validation uses (memory's three
 * re-validators, the store's finders, the isolation overlay's merged-view search).
 *
 * Two rules, both load-bearing:
 *   - a SEMANTIC-ORDERING column (TIMESPAN, JSON) compares through its declared
 *     type's `compare`, so equal-identity spellings conflict regardless of collation;
 *   - every other column keeps storage-class + collation comparison, because a
 *     TEXT type's `compare` is not collation-aware and routing NOCASE/RTRIM through
 *     it would silently drop those enforcement semantics.
 *
 * The end-to-end behavior lives in `test/logic/15.1-semantic-ordering.sqllogic` and
 * `test/logic/102.2-unique-collation.sqllogic`; this suite pins the rule itself, so
 * a re-validator that stops calling the helper still leaves the contract asserted.
 */

import { expect } from 'chai';
import { uniqueEnforcementComparators } from '../src/schema/unique-enforcement.js';
import { BINARY_COLLATION, NOCASE_COLLATION } from '../src/util/comparison.js';
import { TEXT_TYPE, BLOB_TYPE } from '../src/types/builtin-types.js';
import { TIMESPAN_TYPE } from '../src/types/temporal-types.js';
import { JSON_TYPE } from '../src/types/json-type.js';
import type { ColumnSchema } from '../src/schema/column.js';
import type { LogicalType } from '../src/types/logical-type.js';

function column(name: string, logicalType: LogicalType, collation = 'BINARY'): ColumnSchema {
	return {
		name,
		logicalType,
		notNull: false,
		primaryKey: false,
		pkOrder: 0,
		defaultValue: null,
		collation,
		generated: false,
	};
}

describe('uniqueEnforcementComparators', () => {
	it('collapses equal-elapsed TIMESPAN spellings, whatever the collation', () => {
		const columns = [column('d', TIMESPAN_TYPE)];
		for (const collation of [BINARY_COLLATION, NOCASE_COLLATION]) {
			const [compare] = uniqueEnforcementComparators(columns, [0], [collation]);
			expect(compare('PT1H', 'PT60M'), 'PT1H ≡ PT60M').to.equal(0);
			expect(compare('PT1H', 'PT30M'), 'PT1H ≢ PT30M').to.not.equal(0);
		}
	});

	it('collapses key-reordered JSON objects but keeps array order significant', () => {
		// A JSON column holds NATIVE objects at runtime (PhysicalType.OBJECT) — the DML
		// coercion parses on the way in — so the comparator sees objects, not text.
		const [compare] = uniqueEnforcementComparators([column('v', JSON_TYPE)], [0], [BINARY_COLLATION]);
		expect(compare({ a: 1, b: 2 }, { b: 2, a: 1 }), 'object key order is not identity').to.equal(0);
		expect(compare([1, 2], [2, 1]), 'array order IS identity').to.not.equal(0);
		// A JSON string scalar stays a text comparison, under the column's collation.
		expect(compare('abc', 'abc')).to.equal(0);
		expect(compare('abc', 'ABC')).to.not.equal(0);
	});

	it('keeps collation comparison for a non-semantic-ordering column', () => {
		const columns = [column('t', TEXT_TYPE, 'NOCASE'), column('b', BLOB_TYPE)];
		const [compareText] = uniqueEnforcementComparators(columns, [0], [NOCASE_COLLATION]);
		expect(compareText('abc', 'ABC'), 'NOCASE unifies case variants').to.equal(0);

		const [compareBinary] = uniqueEnforcementComparators(columns, [0], [BINARY_COLLATION]);
		expect(compareBinary('abc', 'ABC'), 'BINARY keeps them distinct').to.not.equal(0);
	});

	it('pairs each comparator with its OWN column and collation', () => {
		// Constrained columns given out of declaration order, with per-position
		// collations: a positional mix-up would compare 'k' under the TIMESPAN rule.
		const columns = [column('k', TEXT_TYPE, 'NOCASE'), column('d', TIMESPAN_TYPE)];
		const compares = uniqueEnforcementComparators(columns, [1, 0], [BINARY_COLLATION, NOCASE_COLLATION]);
		expect(compares).to.have.lengthOf(2);
		expect(compares[0]('PT1H', 'PT60M'), 'position 0 is the TIMESPAN column').to.equal(0);
		expect(compares[1]('abc', 'ABC'), 'position 1 is the NOCASE text column').to.equal(0);
		expect(compares[1]('PT1H', 'PT60M'), 'text column never consults a type compare').to.not.equal(0);
	});

	it('treats NULL as SQL does — equal to NULL, below everything else', () => {
		// Callers skip a row with any NULL constrained value before comparing; the
		// comparator must still be total so a stale/partial candidate cannot throw.
		const [compare] = uniqueEnforcementComparators([column('d', TIMESPAN_TYPE)], [0], [BINARY_COLLATION]);
		expect(compare(null, null)).to.equal(0);
		expect(compare(null, 'PT1H')).to.be.lessThan(0);
		expect(compare('PT1H', null)).to.be.greaterThan(0);
	});
});
