import { expect } from 'chai';
import { buildInsertStatement, buildUpdateStatement, buildDeleteStatement } from '../../src/util/mutation-statement.js';
import type { TableSchema } from '../../src/schema/table.js';
import { INTEGER_TYPE, TEXT_TYPE, REAL_TYPE } from '../../src/types/index.js';
import type { ColumnSchema } from '../../src/schema/column.js';

describe('mutation-statement', () => {
	function makeSchema(
		name: string,
		columns: ColumnSchema[],
		pkCols: string[],
		mutationContext?: { name: string }[],
	): TableSchema {
		const columnIndexMap = new Map(columns.map((col, idx) => [col.name, idx]));
		const primaryKeyDefinition = pkCols.map(pk => {
			const index = columnIndexMap.get(pk);
			if (index === undefined) throw new Error(`PK column ${pk} not found`);
			return { index, desc: false };
		});

		return {
			vtabModuleName: 'memory',
			schemaName: 'main',
			name,
			columns: Object.freeze(columns),
			columnIndexMap,
			primaryKeyDefinition: Object.freeze(primaryKeyDefinition),
			indexes: Object.freeze([]),
			checkConstraints: Object.freeze([]),
			isView: false,
			mutationContext,
		} as TableSchema;
	}

	const simpleCol = (name: string, type: typeof INTEGER_TYPE): ColumnSchema => ({
		name,
		logicalType: type,
		notNull: false,
		primaryKey: false,
		pkOrder: 0,
		defaultValue: null,
		collation: 'BINARY',
		generated: false,
	});

	const simpleSchema = makeSchema(
		'items',
		[simpleCol('id', INTEGER_TYPE), simpleCol('name', TEXT_TYPE), simpleCol('price', REAL_TYPE)],
		['id'],
	);

	describe('buildInsertStatement', () => {
		it('should generate an INSERT statement', () => {
			const sql = buildInsertStatement(simpleSchema, [1, 'Widget', 9.99]);
			expect(sql).to.include('insert');
			expect(sql).to.include('items');
			expect(sql).to.include('1');
			expect(sql).to.include("'Widget'");
			expect(sql).to.include('9.99');
		});

		it('should handle null values', () => {
			const sql = buildInsertStatement(simpleSchema, [2, null, null]);
			expect(sql).to.include('insert');
			expect(sql).to.include('null');
		});

		it('should handle boolean-like values', () => {
			const boolSchema = makeSchema(
				'flags',
				[simpleCol('id', INTEGER_TYPE), simpleCol('active', INTEGER_TYPE)],
				['id'],
			);
			const sql = buildInsertStatement(boolSchema, [1, 1]);
			expect(sql).to.include('insert');
			expect(sql).to.include('1');
		});

		it('should include context values when provided', () => {
			const ctxSchema = makeSchema(
				'items',
				[simpleCol('id', INTEGER_TYPE), simpleCol('name', TEXT_TYPE)],
				['id'],
				[{ name: 'user_id' }],
			);
			const sql = buildInsertStatement(ctxSchema, [1, 'test'], [42]);
			expect(sql).to.include('insert');
			expect(sql).to.include('user_id');
			expect(sql).to.include('42');
		});

		it('should omit context when contextRow is undefined', () => {
			const sql = buildInsertStatement(simpleSchema, [1, 'test', 5.0], undefined);
			expect(sql).to.include('insert');
		});
	});

	describe('buildUpdateStatement', () => {
		it('should generate an UPDATE statement with single PK', () => {
			const sql = buildUpdateStatement(simpleSchema, [1, 'Updated', 19.99], [1]);
			expect(sql).to.include('update');
			expect(sql).to.include('items');
			expect(sql).to.include("'Updated'");
			expect(sql).to.include('where');
		});

		it('should generate an UPDATE with composite PK', () => {
			const compositeSchema = makeSchema(
				'orders',
				[simpleCol('user_id', INTEGER_TYPE), simpleCol('order_id', INTEGER_TYPE), simpleCol('total', REAL_TYPE)],
				['user_id', 'order_id'],
			);
			const sql = buildUpdateStatement(compositeSchema, [1, 2, 99.99], [1, 2]);
			expect(sql).to.include('update');
			expect(sql).to.include('where');
			expect(sql.toLowerCase()).to.include('and');
		});

		it('should handle null in update values', () => {
			const sql = buildUpdateStatement(simpleSchema, [1, null, null], [1]);
			expect(sql).to.include('update');
			expect(sql).to.include('null');
		});
	});

	describe('buildDeleteStatement', () => {
		it('should generate a DELETE statement with single PK', () => {
			const sql = buildDeleteStatement(simpleSchema, [1]);
			expect(sql).to.include('delete');
			expect(sql).to.include('items');
			expect(sql).to.include('where');
		});

		it('should generate a DELETE with composite PK', () => {
			const compositeSchema = makeSchema(
				'orders',
				[simpleCol('user_id', INTEGER_TYPE), simpleCol('order_id', INTEGER_TYPE), simpleCol('total', REAL_TYPE)],
				['user_id', 'order_id'],
			);
			const sql = buildDeleteStatement(compositeSchema, [1, 2]);
			expect(sql).to.include('delete');
			expect(sql).to.include('where');
		});

		it('should handle table with no primary key', () => {
			const noPkSchema = makeSchema(
				'logs',
				[simpleCol('msg', TEXT_TYPE), simpleCol('ts', INTEGER_TYPE)],
				[], // no PK
			);
			const sql = buildDeleteStatement(noPkSchema, []);
			expect(sql).to.include('delete');
			expect(sql).to.include('where');
			expect(sql).to.include('1');
		});

		it('should include context values when provided', () => {
			const ctxSchema = makeSchema(
				'items',
				[simpleCol('id', INTEGER_TYPE), simpleCol('name', TEXT_TYPE)],
				['id'],
				[{ name: 'user_id' }],
			);
			const sql = buildDeleteStatement(ctxSchema, [1], [42]);
			expect(sql).to.include('delete');
		});
	});
});
