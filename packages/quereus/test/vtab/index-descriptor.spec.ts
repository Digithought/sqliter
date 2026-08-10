import { expect } from 'chai';
import { validateAccessPlan } from '../../src/vtab/best-access-plan.js';
import type { BestAccessPlanRequest, BestAccessPlanResult, ColumnMeta } from '../../src/vtab/best-access-plan.js';
import { primaryKeyDescriptor, resolveIndexDescriptor, type IndexDescriptor } from '../../src/vtab/index-descriptor.js';
import type { TableSchema } from '../../src/schema/table.js';
import { INTEGER_TYPE, TEXT_TYPE } from '../../src/types/index.js';

const columns: ColumnMeta[] = [
	{ index: 0, name: 'id', type: INTEGER_TYPE, isPrimaryKey: true, isUnique: true },
	{ index: 1, name: 'name', type: TEXT_TYPE, isPrimaryKey: false, isUnique: false },
	{ index: 2, name: 'age', type: INTEGER_TYPE, isPrimaryKey: false, isUnique: false },
];

/** Minimal TableSchema: single-column PK on `id`, two secondary indexes. */
function makeTableSchema(): TableSchema {
	return {
		name: 'people',
		schemaName: 'main',
		columns: columns.map(c => ({ name: c.name, index: c.index })),
		columnIndexMap: new Map(columns.map(c => [c.name, c.index])),
		primaryKeyDefinition: [{ index: 0, desc: false }],
		indexes: [
			{ name: 'by_name', columns: [{ index: 1, desc: false, collation: 'NOCASE' }], unique: true },
			// A secondary index whose name merely LOOKS like an aliased primary key.
			{ name: '_primary_extra', columns: [{ index: 2, desc: true }] },
		],
		checkConstraints: [],
		vtabModule: {},
		vtabModuleName: 'memory',
	} as unknown as TableSchema;
}

function makeSchemaWithoutPk(): TableSchema {
	return { ...makeTableSchema(), primaryKeyDefinition: [] } as unknown as TableSchema;
}

const basePlan: BestAccessPlanResult = { handledFilters: [], cost: 1, rows: 1 };

describe('primaryKeyDescriptor', () => {
	it('describes the primary key, named _primary_ and unique', () => {
		const d = primaryKeyDescriptor(makeTableSchema());
		expect(d).to.deep.equal({
			name: '_primary_',
			role: 'primary',
			keyColumns: [{ columnIndex: 0, desc: false, collation: undefined }],
			unique: true,
		});
	});

	it('returns undefined for a table with no primary key', () => {
		// A descriptor with zero key columns describes nothing; callers must full-scan.
		expect(primaryKeyDescriptor(makeSchemaWithoutPk())).to.be.undefined;
	});
});

describe('resolveIndexDescriptor', () => {
	const tableSchema = makeTableSchema();

	it('prefers a module-supplied descriptor naming the requested index', () => {
		const supplied: IndexDescriptor = {
			name: '_primary_1',
			role: 'primary',
			keyColumns: [{ columnIndex: 0, desc: false }],
			unique: true,
		};
		const plan = { ...basePlan, indexName: '_primary_1', indexDescriptor: supplied };
		expect(resolveIndexDescriptor(tableSchema, plan, '_primary_1')).to.equal(supplied);
	});

	it('ignores a supplied descriptor that names a DIFFERENT index than the one asked about', () => {
		// The legacy arms hardcode `_primary_`; a descriptor for some other index must
		// not be mistaken for a description of the primary key.
		const supplied: IndexDescriptor = {
			name: 'by_name',
			role: 'secondary',
			keyColumns: [{ columnIndex: 1, desc: false }],
			unique: true,
		};
		const plan = { ...basePlan, indexName: 'by_name', indexDescriptor: supplied };
		const resolved = resolveIndexDescriptor(tableSchema, plan, '_primary_');
		expect(resolved!.role).to.equal('primary');
		expect(resolved!.name).to.equal('_primary_');
	});

	it('resolves both spellings of the primary key without a supplied descriptor', () => {
		expect(resolveIndexDescriptor(tableSchema, basePlan, '_primary_')!.role).to.equal('primary');
		expect(resolveIndexDescriptor(tableSchema, basePlan, 'primary')!.role).to.equal('primary');
	});

	it('resolves a schema index, carrying its FULL key columns, direction, collation, and uniqueness', () => {
		const d = resolveIndexDescriptor(tableSchema, basePlan, 'by_name')!;
		expect(d).to.deep.equal({
			name: 'by_name',
			role: 'secondary',
			keyColumns: [{ columnIndex: 1, desc: false, collation: 'NOCASE' }],
			unique: true,
		});
	});

	it('matches a schema index case-insensitively', () => {
		expect(resolveIndexDescriptor(tableSchema, basePlan, 'BY_NAME')!.name).to.equal('by_name');
	});

	it('defaults `unique` to false for a non-unique schema index', () => {
		expect(resolveIndexDescriptor(tableSchema, basePlan, '_primary_extra')!.unique).to.be.false;
	});

	it('resolves a secondary index named _primary_extra as SECONDARY (no prefix rule)', () => {
		const d = resolveIndexDescriptor(tableSchema, basePlan, '_primary_extra')!;
		expect(d.role).to.equal('secondary');
		expect(d.keyColumns).to.deep.equal([{ columnIndex: 2, desc: true, collation: undefined }]);
	});

	it('returns undefined for an alias the engine cannot resolve', () => {
		expect(resolveIndexDescriptor(tableSchema, basePlan, '_primary_1')).to.be.undefined;
		expect(resolveIndexDescriptor(tableSchema, basePlan, '_primary_a')).to.be.undefined;
	});
});

describe('validateAccessPlan with indexDescriptor', () => {
	const request: BestAccessPlanRequest = { columns, filters: [] };
	const descriptor: IndexDescriptor = {
		name: 'by_name',
		role: 'secondary',
		keyColumns: [{ columnIndex: 1, desc: false }],
		unique: true,
	};

	it('accepts a descriptor matching indexName', () => {
		expect(() => validateAccessPlan(request, {
			...basePlan, indexName: 'by_name', indexDescriptor: descriptor,
		})).to.not.throw();
	});

	it('accepts a descriptor matching orderingIndexName on an ordering-only plan', () => {
		expect(() => validateAccessPlan(request, {
			...basePlan,
			orderingIndexName: 'by_name',
			providesOrdering: [{ columnIndex: 1, desc: false }],
			indexDescriptor: descriptor,
		})).to.not.throw();
	});

	it('throws when the descriptor names a different index than indexName', () => {
		expect(() => validateAccessPlan(request, {
			...basePlan, indexName: '_primary_', indexDescriptor: descriptor,
		})).to.throw(/must equal the plan's index name/);
	});

	it('throws when the plan names no index at all', () => {
		expect(() => validateAccessPlan(request, {
			...basePlan, indexDescriptor: descriptor,
		})).to.throw(/names no index/);
	});

	it('throws on an empty keyColumns list', () => {
		expect(() => validateAccessPlan(request, {
			...basePlan,
			indexName: 'by_name',
			indexDescriptor: { ...descriptor, keyColumns: [] },
		})).to.throw(/at least one key column/);
	});

	it('throws on an out-of-range key column index', () => {
		expect(() => validateAccessPlan(request, {
			...basePlan,
			indexName: 'by_name',
			indexDescriptor: { ...descriptor, keyColumns: [{ columnIndex: 7, desc: false }] },
		})).to.throw(/Invalid indexDescriptor key column index 7/);
	});
});
