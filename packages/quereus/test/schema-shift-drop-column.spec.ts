/**
 * Unit tests for `shiftSchemaIndicesForDrop` — the shared DROP COLUMN renumbering
 * used by both the memory module (`MemoryTableManager.dropColumn`) and the store
 * module (`StoreModule.alterDropColumn`).
 *
 * The end-to-end behavior is covered by the `41.x` ALTER logic tests and
 * `alter-drop-column-index-shift.spec.ts`; these pin the helper's contract directly
 * so a regression in either caller's shared dependency fails here first, with the
 * failing field named.
 */

import { expect } from 'chai';
import {
	createBasicSchema,
	shiftSchemaIndicesForDrop,
	type TableSchema,
	type IndexSchema,
	type UniqueConstraintSchema,
	type ForeignKeyConstraintSchema,
	type PrimaryKeyColumnDefinition,
} from '../src/schema/table.js';

/** t(a, b, c, d) with PK (a), plus whatever position-bearing fields the test needs. */
function schemaFixture(extra: Partial<TableSchema> = {}): TableSchema {
	const base = createBasicSchema(
		't',
		[{ name: 'a', type: 'integer' }, { name: 'b', type: 'integer' }, { name: 'c', type: 'integer' }, { name: 'd', type: 'integer' }],
		['a'],
	);
	return { ...base, ...extra };
}

function fk(columns: number[], name?: string): ForeignKeyConstraintSchema {
	return {
		name,
		columns: Object.freeze(columns),
		referencedTable: 'parent',
		referencedColumnNames: Object.freeze(columns.map((_, i) => `p${i}`)),
		onDelete: 'restrict',
		onUpdate: 'restrict',
		deferred: false,
	};
}

function uc(columns: number[], name?: string): UniqueConstraintSchema {
	return { name, columns: Object.freeze(columns) };
}

function index(name: string, columns: Array<{ index: number; desc?: boolean; collation?: string }>): IndexSchema {
	return { name, columns: Object.freeze(columns) };
}

/** Column indices of `indexName` in the shifted result, or undefined when it was dropped. */
function indexColumns(indexes: ReadonlyArray<IndexSchema>, indexName: string): number[] | undefined {
	return indexes.find(i => i.name === indexName)?.columns.map(ic => ic.index);
}

describe('shiftSchemaIndicesForDrop', () => {
	describe('columns', () => {
		it('removes exactly the dropped slot', () => {
			const { columns } = shiftSchemaIndicesForDrop(schemaFixture(), 1);
			expect(columns.map(c => c.name)).to.deep.equal(['a', 'c', 'd']);
		});

		it('handles dropping the first and last column', () => {
			expect(shiftSchemaIndicesForDrop(schemaFixture(), 0).columns.map(c => c.name)).to.deep.equal(['b', 'c', 'd']);
			expect(shiftSchemaIndicesForDrop(schemaFixture(), 3).columns.map(c => c.name)).to.deep.equal(['a', 'b', 'c']);
		});

		it('rejects an out-of-range index rather than silently no-op shifting', () => {
			expect(() => shiftSchemaIndicesForDrop(schemaFixture(), -1)).to.throw(/out of range/);
			expect(() => shiftSchemaIndicesForDrop(schemaFixture(), 4)).to.throw(/out of range/);
		});

		it('leaves the input schema untouched', () => {
			const schema = schemaFixture({ uniqueConstraints: Object.freeze([uc([1, 2])]), foreignKeys: Object.freeze([fk([2])]) });
			shiftSchemaIndicesForDrop(schema, 1);
			expect(schema.columns.map(c => c.name), 'input columns').to.deep.equal(['a', 'b', 'c', 'd']);
			expect(schema.uniqueConstraints![0].columns, 'input UNIQUE columns').to.deep.equal([1, 2]);
			expect(schema.foreignKeys![0].columns, 'input FK columns').to.deep.equal([2]);
		});
	});

	describe('primaryKeyDefinition', () => {
		it('shifts members above the dropped column and preserves desc/collation', () => {
			const pkDef: PrimaryKeyColumnDefinition[] = [{ index: 0 }, { index: 2, desc: true, collation: 'nocase' }];
			const { primaryKeyDefinition } = shiftSchemaIndicesForDrop(schemaFixture({ primaryKeyDefinition: Object.freeze(pkDef) }), 1);
			expect(primaryKeyDefinition).to.deep.equal([{ index: 0 }, { index: 1, desc: true, collation: 'nocase' }]);
		});

		it('removes a member naming the dropped column (module guards reject this; the helper must not dangle)', () => {
			const pkDef: PrimaryKeyColumnDefinition[] = [{ index: 1 }, { index: 3 }];
			const { primaryKeyDefinition } = shiftSchemaIndicesForDrop(schemaFixture({ primaryKeyDefinition: Object.freeze(pkDef) }), 1);
			expect(primaryKeyDefinition).to.deep.equal([{ index: 2 }]);
		});
	});

	describe('uniqueConstraints', () => {
		it('removes a constraint naming the dropped column outright rather than narrowing it', () => {
			const schema = schemaFixture({ uniqueConstraints: Object.freeze([uc([1, 2], 'ux_bc')]) });
			const { uniqueConstraints } = shiftSchemaIndicesForDrop(schema, 1);
			expect(uniqueConstraints, 'ux_bc is a different constraint once b is gone').to.be.undefined;
		});

		it('shifts survivors and keeps their other fields', () => {
			const schema = schemaFixture({
				uniqueConstraints: Object.freeze([
					{ ...uc([2, 3], 'ux_cd'), derivedFromIndex: 'ux_cd' },
					uc([1], 'ux_b'),
				]),
			});
			const { uniqueConstraints } = shiftSchemaIndicesForDrop(schema, 1);
			expect(uniqueConstraints).to.have.lengthOf(1);
			expect(uniqueConstraints![0].columns).to.deep.equal([1, 2]);
			expect(uniqueConstraints![0].derivedFromIndex).to.equal('ux_cd');
		});

		it('is undefined when the schema had none', () => {
			expect(shiftSchemaIndicesForDrop(schemaFixture(), 1).uniqueConstraints).to.be.undefined;
		});

		it('reports removed constraints with their PRE-shift column indices', () => {
			const schema = schemaFixture({ uniqueConstraints: Object.freeze([uc([1, 3], 'ux_bd'), uc([2], 'ux_c')]) });
			const { removedUniqueConstraints } = shiftSchemaIndicesForDrop(schema, 1);
			expect(removedUniqueConstraints.map(c => c.name)).to.deep.equal(['ux_bd']);
			expect(removedUniqueConstraints[0].columns, 'callers name the structure from the OLD column array')
				.to.deep.equal([1, 3]);
		});

		it('reports an empty removed list when nothing was removed', () => {
			const schema = schemaFixture({ uniqueConstraints: Object.freeze([uc([2], 'ux_c')]) });
			expect(shiftSchemaIndicesForDrop(schema, 1).removedUniqueConstraints).to.deep.equal([]);
		});
	});

	describe('foreignKeys', () => {
		it('removes a key that loses any child column, shifts the rest', () => {
			const schema = schemaFixture({ foreignKeys: Object.freeze([fk([1, 2], 'fk_bc'), fk([3], 'fk_d')]) });
			const { foreignKeys } = shiftSchemaIndicesForDrop(schema, 1);
			expect(foreignKeys!.map(k => k.name)).to.deep.equal(['fk_d']);
			expect(foreignKeys![0].columns).to.deep.equal([2]);
		});

		it('leaves referencedColumnNames alone (resolved by name against the parent at enforcement time)', () => {
			const schema = schemaFixture({ foreignKeys: Object.freeze([fk([2, 3], 'fk_cd')]) });
			const { foreignKeys } = shiftSchemaIndicesForDrop(schema, 1);
			expect(foreignKeys![0].columns, 'child indices shift').to.deep.equal([1, 2]);
			expect(foreignKeys![0].referencedColumnNames, 'parent names do not').to.deep.equal(['p0', 'p1']);
		});

		it('is undefined when every key was removed, and when the schema had none', () => {
			const schema = schemaFixture({ foreignKeys: Object.freeze([fk([1], 'fk_b')]) });
			expect(shiftSchemaIndicesForDrop(schema, 1).foreignKeys, 'all removed').to.be.undefined;
			expect(shiftSchemaIndicesForDrop(schemaFixture(), 1).foreignKeys, 'none declared').to.be.undefined;
		});
	});

	describe('indexes', () => {
		it('prunes the dropped column and shifts the survivors of the same index', () => {
			const schema = schemaFixture({ indexes: Object.freeze([index('idx_bcd', [{ index: 1 }, { index: 2 }, { index: 3 }])]) });
			expect(indexColumns(shiftSchemaIndicesForDrop(schema, 1).indexes, 'idx_bcd')).to.deep.equal([1, 2]);
		});

		it('drops an index left with no columns', () => {
			const schema = schemaFixture({ indexes: Object.freeze([index('idx_b', [{ index: 1 }])]) });
			expect(shiftSchemaIndicesForDrop(schema, 1).indexes).to.deep.equal([]);
		});

		it('preserves per-column desc and collation across the shift', () => {
			const schema = schemaFixture({ indexes: Object.freeze([index('idx_cd', [{ index: 2, desc: true, collation: 'nocase' }, { index: 3 }])]) });
			const shifted = shiftSchemaIndicesForDrop(schema, 1).indexes;
			expect(shifted[0].columns).to.deep.equal([{ index: 1, desc: true, collation: 'nocase' }, { index: 2 }]);
		});

		it('preserves index-level fields of a survivor', () => {
			const tags = Object.freeze({ origin: 'user' });
			const schema = schemaFixture({ indexes: Object.freeze([{ ...index('idx_bc', [{ index: 1 }, { index: 2 }]), tags }]) });
			const survivor = shiftSchemaIndicesForDrop(schema, 1).indexes[0];
			expect(survivor.columns.map(ic => ic.index), 'narrowed to its surviving column').to.deep.equal([1]);
			expect(survivor.tags).to.equal(tags);
		});

		it('removes a UNIQUE index naming the dropped column outright rather than narrowing it', () => {
			// Narrowing `unique (b, c)` to `unique (c)` would invent a constraint the table never
			// declared — and one nothing enforces, since the matching `derivedFromIndex` UNIQUE
			// constraint is removed. `index_info`, the planner's at-most-one-partner-row proof, and
			// the regenerated DDL all read the `unique` flag and would take it at face value.
			const schema = schemaFixture({
				indexes: Object.freeze([{ ...index('ux_bc', [{ index: 1 }, { index: 2 }]), unique: true }]),
				uniqueConstraints: Object.freeze([{ ...uc([1, 2], 'ux_bc'), derivedFromIndex: 'ux_bc' }]),
			});
			const shifted = shiftSchemaIndicesForDrop(schema, 1);
			expect(shifted.indexes, 'index gone, not narrowed to (c)').to.deep.equal([]);
			expect(shifted.uniqueConstraints, 'derived constraint gone too').to.be.undefined;
		});

		it('narrows a UNIQUE index that keeps every one of its columns', () => {
			const schema = schemaFixture({ indexes: Object.freeze([{ ...index('ux_cd', [{ index: 2 }, { index: 3 }]), unique: true }]) });
			const shifted = shiftSchemaIndicesForDrop(schema, 1);
			expect(indexColumns(shifted.indexes, 'ux_cd'), 'shifted, still unique').to.deep.equal([1, 2]);
			expect(shifted.indexes[0].unique).to.be.true;
		});

		it('returns an empty array (never undefined) when the schema had no indexes', () => {
			const { indexes } = shiftSchemaIndicesForDrop({ ...schemaFixture(), indexes: undefined }, 1);
			expect(indexes).to.deep.equal([]);
		});
	});
});
