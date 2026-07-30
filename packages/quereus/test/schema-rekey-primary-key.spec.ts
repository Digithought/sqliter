/**
 * Unit tests for `rekeySchemaPrimaryKey` — the shared ALTER PRIMARY KEY schema
 * mutation used by both the memory module (`MemoryTableManager.buildRekeyedPrimaryKeySchema`)
 * and the store module (`StoreModuleAlter.alterPrimaryKeyChange`).
 *
 * End-to-end behavior is covered by `alter-table-conformance.spec.ts`,
 * `alter-primary-key-generated-ddl.spec.ts` and the store's persistence spec; these pin
 * the helper's contract directly so a regression in either caller's shared dependency
 * fails here first, with the failing field named. Modeled on
 * `schema-shift-drop-column.spec.ts` (the DROP COLUMN sibling).
 */

import { expect } from 'chai';
import {
	createBasicSchema,
	rekeySchemaPrimaryKey,
	type TableSchema,
} from '../src/schema/table.js';

/** t(a, b, c) with PK (a) — flags and definition agreeing, as CREATE leaves them. */
function schemaFixture(extra: Partial<TableSchema> = {}): TableSchema {
	const base = createBasicSchema(
		't',
		[{ name: 'a', type: 'integer' }, { name: 'b', type: 'text' }, { name: 'c', type: 'integer' }],
		['a'],
	);
	const columns = base.columns.map((col, i) => ({ ...col, primaryKey: i === 0, pkOrder: i === 0 ? 1 : 0 }));
	return { ...base, columns, ...extra };
}

/** `[primaryKey, pkOrder]` per column, in declaration order. */
function flags(schema: TableSchema): Array<[boolean, number]> {
	return schema.columns.map(c => [c.primaryKey, c.pkOrder]);
}

describe('rekeySchemaPrimaryKey', () => {
	describe('primaryKeyDefinition', () => {
		it('records the requested members in order, defaulting desc to false', () => {
			const out = rekeySchemaPrimaryKey(schemaFixture(), [{ index: 2 }, { index: 1, desc: true }]);
			expect(out.primaryKeyDefinition).to.deep.equal([
				{ index: 2, desc: false, collation: 'BINARY' },
				{ index: 1, desc: true, collation: 'BINARY' },
			]);
		});

		it('carries each member column\'s collation (dropping it would re-key NOCASE data as BINARY)', () => {
			const base = schemaFixture();
			const columns = base.columns.map(c => (c.name === 'b' ? { ...c, collation: 'NOCASE' } : c));
			const out = rekeySchemaPrimaryKey({ ...base, columns }, [{ index: 1 }]);
			expect(out.primaryKeyDefinition[0].collation).to.equal('NOCASE');
		});

		it('falls back to BINARY for a column carrying no collation', () => {
			const base = schemaFixture();
			const columns = base.columns.map(c => ({ ...c, collation: '' }));
			const out = rekeySchemaPrimaryKey({ ...base, columns }, [{ index: 0 }]);
			expect(out.primaryKeyDefinition[0].collation).to.equal('BINARY');
		});

		it('accepts an empty key (the `primary key ()` singleton shape)', () => {
			const out = rekeySchemaPrimaryKey(schemaFixture(), []);
			expect(out.primaryKeyDefinition).to.deep.equal([]);
			expect(flags(out), 'every column a non-member').to.deep.equal([[false, 0], [false, 0], [false, 0]]);
		});
	});

	describe('self-inconsistent input rejected', () => {
		// Not user-facing rejections (the engine emitter and the memory manager validate the
		// column list first) — these are the two shapes that would otherwise yield a schema
		// whose definition and flag mirror cannot agree, so they assert as INTERNAL.
		it('throws on an out-of-range column index rather than minting a member addressing no column', () => {
			expect(() => rekeySchemaPrimaryKey(schemaFixture(), [{ index: 3 }])).to.throw(/out of range/i);
			expect(() => rekeySchemaPrimaryKey(schemaFixture(), [{ index: -1 }])).to.throw(/out of range/i);
		});

		it('throws on a repeated column index rather than minting more members than the mirror can order', () => {
			expect(() => rekeySchemaPrimaryKey(schemaFixture(), [{ index: 1 }, { index: 1 }])).to.throw(/repeated/i);
		});
	});

	describe('per-column flags', () => {
		it('mirrors the new definition: membership and 1-based pkOrder, non-members zeroed', () => {
			const out = rekeySchemaPrimaryKey(schemaFixture(), [{ index: 2 }, { index: 1 }]);
			// c is member 1, b is member 2, a is retired.
			expect(flags(out)).to.deep.equal([[false, 0], [true, 2], [true, 1]]);
		});

		it('zeroes the retired single-column key\'s flags', () => {
			const out = rekeySchemaPrimaryKey(schemaFixture(), [{ index: 1 }]);
			expect(out.columns[0].primaryKey, 'retired member no longer flagged').to.be.false;
			expect(out.columns[0].pkOrder, 'retired member order zeroed').to.equal(0);
		});

		it('leaves pkDirection alone — direction lives in primaryKeyDefinition.desc, not in the mirror', () => {
			const base = schemaFixture();
			const columns = base.columns.map(c => (c.name === 'a' ? { ...c, pkDirection: 'asc' as const } : c));
			const out = rekeySchemaPrimaryKey({ ...base, columns }, [{ index: 1, desc: true }]);
			expect(out.columns[0].pkDirection, 'retired member keeps whatever it had').to.equal('asc');
			expect(out.columns[1].pkDirection, 'new desc member is NOT given a direction').to.be.undefined;
		});

		it('preserves every other column field', () => {
			const base = schemaFixture();
			const tags = Object.freeze({ origin: 'user' });
			const columns = base.columns.map(c => (c.name === 'b' ? { ...c, tags, notNull: true, collation: 'NOCASE' } : c));
			const out = rekeySchemaPrimaryKey({ ...base, columns }, [{ index: 1 }]);
			expect(out.columns[1].tags).to.equal(tags);
			expect(out.columns[1].notNull).to.be.true;
			expect(out.columns[1].collation).to.equal('NOCASE');
			expect(out.columns[1].logicalType).to.equal(base.columns[1].logicalType);
		});
	});

	describe('input immutability', () => {
		it('does not mutate the incoming column objects (they are the rollback snapshot / event oldObject)', () => {
			const input = schemaFixture();
			const beforeFlags = flags(input);
			const firstColumn = input.columns[0];
			const out = rekeySchemaPrimaryKey(input, [{ index: 2 }]);
			expect(flags(input), 'input flags untouched').to.deep.equal(beforeFlags);
			expect(input.primaryKeyDefinition.map(p => p.index), 'input definition untouched').to.deep.equal([0]);
			expect(out.columns[0], 'a fresh column object was built').to.not.equal(firstColumn);
			expect(firstColumn.primaryKey, 'the shared object itself was not rewritten').to.be.true;
		});

		it('returns a frozen schema with a frozen column list and definition', () => {
			const out = rekeySchemaPrimaryKey(schemaFixture(), [{ index: 1 }]);
			expect(Object.isFrozen(out), 'schema frozen').to.be.true;
			expect(Object.isFrozen(out.columns), 'columns frozen').to.be.true;
			expect(Object.isFrozen(out.primaryKeyDefinition), 'definition frozen').to.be.true;
		});

		it('preserves the schema\'s non-key fields', () => {
			const input = schemaFixture({ indexes: Object.freeze([{ name: 'ix_c', columns: Object.freeze([{ index: 2 }]) }]) });
			const out = rekeySchemaPrimaryKey(input, [{ index: 1 }]);
			expect(out.indexes).to.equal(input.indexes);
			expect(out.columnIndexMap, 'column names/positions unchanged, so the map carries over').to.equal(input.columnIndexMap);
			expect(out.name).to.equal('t');
		});
	});
});
