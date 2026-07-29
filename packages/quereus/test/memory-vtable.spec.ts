/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import { Database } from "../src/index.js";
import { MemoryTableModule } from "../src/vtab/memory/module.js";
import { MemoryTable } from "../src/vtab/memory/table.js";
import { TransactionLayer } from "../src/vtab/memory/layer/transaction.js";
import { BaseLayer, iteratePrimaryRows } from "../src/vtab/memory/layer/base.js";
import type { TableSchema, IndexSchema } from "../src/schema/table.js";
import type { ColumnSchema } from "../src/schema/column.js";
import type { FilterInfo } from "../src/vtab/filter-info.js";
import { ConflictResolution } from "../src/common/constants.js";
import type * as AST from "../src/parser/ast.js";
import { INTEGER_TYPE, TEXT_TYPE, REAL_TYPE, BLOB_TYPE } from "../src/types/index.js";
import type { Row, UpdateResult } from "../src/common/types.js";

/** Assert an UpdateResult succeeded and narrow it to the `'ok'` branch so `.row` is accessible. */
function expectOk(result: UpdateResult): asserts result is Extract<UpdateResult, { status: 'ok' }> {
	expect(result.status).to.equal('ok');
}

describe("Memory VTable Module", () => {
	let db: Database;
	let module: MemoryTableModule;

	beforeEach(() => {
		db = new Database();
		module = new MemoryTableModule();
	});

	afterEach(async () => {
		await db.close();
	});

	// Helper function to create a basic table schema
	function createTableSchema(
		name: string = 'test_table',
		columns: ColumnSchema[] = [
			{ name: 'id', logicalType: INTEGER_TYPE, notNull: true, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
			{ name: 'name', logicalType: TEXT_TYPE, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
			{ name: 'value', logicalType: REAL_TYPE, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false }
		],
		primaryKey: string[] = ['id']
	): TableSchema {
		const columnIndexMap = new Map(columns.map((col, idx) => [col.name, idx]));
		const primaryKeyDefinition = primaryKey.map(pkCol => {
			const index = columnIndexMap.get(pkCol);
			if (index === undefined) throw new Error(`PK column ${pkCol} not found`);
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
			vtabModule: module,
			isView: false
		};
	}

	// Helper to create basic filter info for full table scan
	function createFilterInfo(_constraints: any[] = [], _orderBy: any[] = []): FilterInfo {
		return {
			idxNum: 0,
			idxStr: 'full_scan',
			constraints: [],
			args: [],
			indexInfoOutput: {
				nConstraint: 0,
				aConstraint: [],
				nOrderBy: 0,
				aOrderBy: [],
				colUsed: 0n,
				aConstraintUsage: [],
				idxNum: 0,
				idxStr: '',
				orderByConsumed: false,
				estimatedCost: 0,
				estimatedRows: BigInt(0),
				idxFlags: 0
			}
		};
	}

	describe("Module Creation and Connection", () => {
		it("should create a new memory table", async () => {
			const schema = createTableSchema('users');
			const table = await module.create(db, schema);

			expect(table).to.be.instanceOf(MemoryTable);
			expect(table.tableName).to.equal('users');
			expect(table.schemaName).to.equal('main');
		});

	it("should connect to an existing memory table", async () => {
		const schema = createTableSchema('users');
		await module.create(db, schema);

		const table2 = await module.connect(db, null, 'memory', 'main', 'users', {});
		expect(table2).to.be.instanceOf(MemoryTable);
		expect(table2.tableName).to.equal('users');
	});

	it("should fail to connect to non-existent table", async () => {
		try {
			await module.connect(db, null, 'memory', 'main', 'nonexistent', {});
			expect.fail("Should have thrown error");
		} catch (error: any) {
			expect(error.message).to.include('not found');
		}
	});
	});

	describe("Basic CRUD Operations via query and update", () => {
		let table: MemoryTable;
		let schema: TableSchema;

		beforeEach(async () => {
			schema = createTableSchema('products', [
				{ name: 'id', logicalType: INTEGER_TYPE, notNull: true, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'name', logicalType: TEXT_TYPE, notNull: true, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'price', logicalType: REAL_TYPE, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'category', logicalType: TEXT_TYPE, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false }
			], ['id']);
			table = await module.create(db, schema);
		});

		it("should insert data via update", async () => {
			const newRow = [1, 'Laptop', 999.99, 'Electronics'];
			const result = await table.update({ operation: 'insert', values: newRow });

			expectOk(result);
			expect(result.row).to.deep.equal(newRow);
		});

		it("should query data via query", async () => {
			// Insert test data
			await table.update({ operation: 'insert', values: [1, 'Laptop', 999.99, 'Electronics'] });
			await table.update({ operation: 'insert', values: [2, 'Mouse', 29.99, 'Electronics'] });

			// Query all data
			const rows = [];
			const filterInfo = createFilterInfo();
			for await (const row of table.query(filterInfo)) {
				rows.push(row);
			}

			expect(rows).to.have.length(2);
			expect(rows[0]).to.deep.equal([1, 'Laptop', 999.99, 'Electronics']);
			expect(rows[1]).to.deep.equal([2, 'Mouse', 29.99, 'Electronics']);
		});

		it("should update existing data via update", async () => {
			await table.update({ operation: 'insert', values: [1, 'Laptop', 999.99, 'Electronics'] });

			// Update the row
			const updatedRow = [1, 'Gaming Laptop', 1199.99, 'Electronics'];
			const oldKeyValues = [1]; // Primary key values
			const result = await table.update({ operation: 'update', values: updatedRow, oldKeyValues });

			expectOk(result);
			expect(result.row).to.deep.equal(updatedRow);

			// Verify the update
			const rows = [];
			for await (const row of table.query(createFilterInfo())) {
				rows.push(row);
			}

			expect(rows).to.have.length(1);
			expect(rows[0][1]).to.equal('Gaming Laptop');
			expect(rows[0][2]).to.equal(1199.99);
		});

		it("should delete data via update", async () => {
			await table.update({ operation: 'insert', values: [1, 'Laptop', 999.99, 'Electronics'] });
			await table.update({ operation: 'insert', values: [2, 'Mouse', 29.99, 'Electronics'] });

			// Delete first row
			const oldKeyValues = [1];
			const result = await table.update({ operation: 'delete', values: undefined, oldKeyValues });

			expectOk(result);
			expect(result.row).to.deep.equal([1, 'Laptop', 999.99, 'Electronics']);

			// Verify deletion
			const rows = [];
			for await (const row of table.query(createFilterInfo())) {
				rows.push(row);
			}

			expect(rows).to.have.length(1);
			expect(rows[0][0]).to.equal(2);
		});

		it("should handle update with primary key change", async () => {
			await table.update({ operation: 'insert', values: [1, 'Laptop', 999.99, 'Electronics'] });

			// Update with new primary key
			const updatedRow = [10, 'Laptop', 999.99, 'Electronics'];
			const oldKeyValues = [1];
			const result = await table.update({ operation: 'update', values: updatedRow, oldKeyValues });

			expectOk(result);
			expect(result.row).to.deep.equal(updatedRow);

			// Verify old key is gone and new key exists
			const rows = [];
			for await (const row of table.query(createFilterInfo())) {
				rows.push(row);
			}

			expect(rows).to.have.length(1);
			expect(rows[0][0]).to.equal(10);
		});
	});

	describe("Constraint Handling", () => {
		let table: MemoryTable;

		beforeEach(async () => {
			const schema = createTableSchema('users', [
				{ name: 'id', logicalType: INTEGER_TYPE, notNull: true, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'email', logicalType: TEXT_TYPE, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false }
			], ['id']);
			table = await module.create(db, schema);
		});

		it("should enforce primary key uniqueness", async () => {
			await table.update({ operation: 'insert', values: [1, 'user@example.com'] });

			// Now returns UpdateResult with constraint violation instead of throwing
			const result = await table.update({ operation: 'insert', values: [1, 'other@example.com'] });
			expect(result.status).to.equal('constraint');
			if (result.status === 'constraint') {
				expect(result.constraint).to.equal('unique');
				expect(result.message).to.include('UNIQUE constraint failed');
				expect(result.existingRow).to.deep.equal([1, 'user@example.com']);
			}
		});

		it("should handle conflict resolution with INSERT OR IGNORE", async () => {
			await table.update({ operation: 'insert', values: [1, 'user@example.com'] });

			// Simulate INSERT OR IGNORE by passing conflict resolution
			const rowWithConflictRes = [1, 'other@example.com'];
			const result = await table.update({ operation: 'insert', values: rowWithConflictRes, onConflict: ConflictResolution.IGNORE });
			// IGNORE should return ok with undefined row
			expectOk(result);
			expect(result.row).to.be.undefined;

			// Verify original data unchanged
			const rows = [];
			for await (const row of table.query(createFilterInfo())) {
				rows.push(row);
			}

			void expect(rows).to.have.length(1);
			void expect(rows[0][1]).to.equal('user@example.com');
		});
	});

	describe("Composite Primary Keys", () => {
		let table: MemoryTable;

		beforeEach(async () => {
			const schema = createTableSchema('user_sessions', [
				{ name: 'user_id', logicalType: INTEGER_TYPE, notNull: true, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'session_id', logicalType: TEXT_TYPE, notNull: true, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'created_at', logicalType: TEXT_TYPE, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false }
			], ['user_id', 'session_id']);
			table = await module.create(db, schema);
		});

		it("should handle composite primary key operations", async () => {
			await table.update({ operation: 'insert', values: [1, 'sess_123', '2024-01-01'] });
			await table.update({ operation: 'insert', values: [1, 'sess_456', '2024-01-02'] });
			await table.update({ operation: 'insert', values: [2, 'sess_123', '2024-01-01'] });

			const rows = [];
			for await (const row of table.query(createFilterInfo())) {
				rows.push(row);
			}

			expect(rows).to.have.length(3);
		});

		it("should enforce composite primary key uniqueness", async () => {
			await table.update({ operation: 'insert', values: [1, 'sess_123', '2024-01-01'] });

			// Now returns UpdateResult with constraint violation instead of throwing
			const result = await table.update({ operation: 'insert', values: [1, 'sess_123', '2024-01-02'] });
			expect(result.status).to.equal('constraint');
			if (result.status === 'constraint') {
				expect(result.constraint).to.equal('unique');
				expect(result.message).to.include('UNIQUE constraint failed');
			}
		});

		it("should update with composite primary key", async () => {
			await table.update({ operation: 'insert', values: [1, 'sess_123', '2024-01-01'] });

			const updatedRow = [1, 'sess_123', '2024-01-01-updated'];
			const oldKeyValues = [1, 'sess_123'];
			const result = await table.update({ operation: 'update', values: updatedRow, oldKeyValues });

			expectOk(result);
			expect(result.row).to.deep.equal(updatedRow);
		});

		it("should delete with composite primary key", async () => {
			await table.update({ operation: 'insert', values: [1, 'sess_123', '2024-01-01'] });
			await table.update({ operation: 'insert', values: [1, 'sess_456', '2024-01-02'] });

			const oldKeyValues = [1, 'sess_123'];
			const result = await table.update({ operation: 'delete', values: undefined, oldKeyValues });

			expectOk(result);
			expect(result.row).to.deep.equal([1, 'sess_123', '2024-01-01']);

			const rows = [];
			for await (const row of table.query(createFilterInfo())) {
				rows.push(row);
			}

			expect(rows).to.have.length(1);
			expect(rows[0][1]).to.equal('sess_456');
		});
	});

	describe("Secondary Indexes", () => {
		let table: MemoryTable;
		let schema: TableSchema;

		beforeEach(async () => {
			schema = createTableSchema('employees', [
				{ name: 'id', logicalType: INTEGER_TYPE, notNull: true, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'name', logicalType: TEXT_TYPE, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'department', logicalType: TEXT_TYPE, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'salary', logicalType: REAL_TYPE, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false }
			], ['id']);
			table = await module.create(db, schema);
		});

		it("should create secondary indexes", async () => {
			const deptIndex: IndexSchema = {
				name: 'idx_department',
				columns: [{ index: 2, desc: false }]
			};

			await table.createIndex(deptIndex);

			// Verify the index is in the schema
			const currentSchema = table.getSchema();
			expect(currentSchema?.indexes).to.have.length(1);
			expect(currentSchema?.indexes?.[0].name).to.equal('idx_department');
		});

		it("should create composite indexes", async () => {
			const compositeIndex: IndexSchema = {
				name: 'idx_dept_salary',
				columns: [
					{ index: 2, desc: false },
					{ index: 3, desc: true }
				]
			};

			await table.createIndex(compositeIndex);

			const currentSchema = table.getSchema();
			expect(currentSchema?.indexes).to.have.length(1);
			expect(currentSchema?.indexes?.[0].columns).to.have.length(2);
		});

		it("should drop indexes", async () => {
			const deptIndex: IndexSchema = {
				name: 'idx_department',
				columns: [{ index: 2, desc: false }]
			};

			await table.createIndex(deptIndex);
			await table.dropIndex('idx_department');

			const currentSchema = table.getSchema();
			expect(currentSchema?.indexes).to.have.length(0);
		});
	});

	describe("Transaction Support", () => {
		let table: MemoryTable;

		beforeEach(async () => {
			const schema = createTableSchema('accounts', [
				{ name: 'id', logicalType: INTEGER_TYPE, notNull: true, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'balance', logicalType: REAL_TYPE, notNull: true, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false }
			], ['id']);
			table = await module.create(db, schema);

			// Insert initial data
			await table.update({ operation: 'insert', values: [1, 1000.0] });
			await table.update({ operation: 'insert', values: [2, 500.0] });
		});

		it("should handle basic transactions", async () => {
			await table.begin();
			await table.update({ operation: 'update', values: [1, 900.0], oldKeyValues: [1] });
			await table.update({ operation: 'update', values: [2, 600.0], oldKeyValues: [2] });
			await table.commit();

			const rows = [];
			for await (const row of table.query(createFilterInfo())) {
				rows.push(row);
			}

			expect(rows.find(r => r[0] === 1)?.[1]).to.equal(900.0);
			expect(rows.find(r => r[0] === 2)?.[1]).to.equal(600.0);
		});

		it("should rollback transactions", async () => {
			await table.begin();
			await table.update({ operation: 'update', values: [1, 0.0], oldKeyValues: [1] });
			await table.rollback();

			const rows = [];
			for await (const row of table.query(createFilterInfo())) {
				rows.push(row);
			}

			expect(rows.find(r => r[0] === 1)?.[1]).to.equal(1000.0);
		});

		it("should handle savepoints", async () => {
			await table.begin();
			await table.update({ operation: 'update', values: [1, 950.0], oldKeyValues: [1] });
			await table.savepoint(0);
			await table.update({ operation: 'update', values: [1, 850.0], oldKeyValues: [1] });
			await table.rollbackTo(0);
			await table.commit();

			const rows = [];
			for await (const row of table.query(createFilterInfo())) {
				rows.push(row);
			}

			expect(rows.find(r => r[0] === 1)?.[1]).to.equal(950.0);
		});

		it("should release savepoints", async () => {
			await table.begin();
			await table.update({ operation: 'update', values: [1, 950.0], oldKeyValues: [1] });
			await table.savepoint(0);
			await table.update({ operation: 'update', values: [1, 850.0], oldKeyValues: [1] });
			await table.release(0);
			await table.commit();

			const rows = [];
			for await (const row of table.query(createFilterInfo())) {
				rows.push(row);
			}

			expect(rows.find(r => r[0] === 1)?.[1]).to.equal(850.0);
		});
	});

	describe("Schema Changes via alterSchema", () => {
		let table: MemoryTable;

		beforeEach(async () => {
			const schema = createTableSchema('test_table', [
				{ name: 'id', logicalType: INTEGER_TYPE, notNull: true, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'name', logicalType: TEXT_TYPE, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false }
			], ['id']);
			table = await module.create(db, schema);
			await table.update({ operation: 'insert', values: [1, 'test'] });
		});

		it("should add columns", async () => {
			const columnDef = {
				name: 'age',
				dataType: 'INTEGER',
				constraints: [
					{ type: 'default' as const, expr: { type: 'literal' as const, value: 0 } }
				]
			};

			await table.alterSchema({ type: 'addColumn', columnDef });

			const rows = [];
			for await (const row of table.query(createFilterInfo())) {
				rows.push(row);
			}

			expect(rows[0]).to.have.length(3);
			expect(rows[0][2]).to.equal(0); // Default value
		});

		it("should drop columns", async () => {
			// First add a column to drop
			const columnDef: AST.ColumnDef = {
				name: 'temp_col',
				dataType: 'TEXT',
				constraints: [{ type: 'null' as const }]
			};

			await table.alterSchema({ type: 'addColumn', columnDef });
			await table.alterSchema({ type: 'dropColumn', columnName: 'temp_col' });

			const schema = table.getSchema();
			void expect(schema?.columns).to.have.length(2);
			void expect(schema?.columns.find(c => c.name === 'temp_col')).to.be.undefined;
		});

		it("should rename columns", async () => {
			await table.alterSchema({
				type: 'renameColumn',
				oldName: 'name',
				newName: 'full_name',
				newColumnDefAst: {
					name: 'full_name',
					dataType: 'TEXT',
					constraints: []
				}
			});

			const schema = table.getSchema();
			void expect(schema?.columns.find(c => c.name === 'full_name')).to.exist;
			void expect(schema?.columns.find(c => c.name === 'name')).to.be.undefined;
		});

		it("should prevent dropping primary key columns", async () => {
			try {
				await table.alterSchema({ type: 'dropColumn', columnName: 'id' });
				void expect.fail("Should not allow dropping PK column");
			} catch (error: any) {
				void expect(error.message).to.include('Cannot drop PK column');
			}
		});
	});

	describe("Data Types and Edge Cases", () => {
		let table: MemoryTable;

		beforeEach(async () => {
			const schema = createTableSchema('mixed_types', [
				{ name: 'id', logicalType: INTEGER_TYPE, notNull: true, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'text_col', logicalType: TEXT_TYPE, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'real_col', logicalType: REAL_TYPE, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'blob_col', logicalType: BLOB_TYPE, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'null_col', logicalType: TEXT_TYPE, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false }
			], ['id']);
			table = await module.create(db, schema);
		});

		it("should handle various data types", async () => {
			const blobData = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
			await table.update({ operation: 'insert', values: [1, 'hello', 3.14, blobData, null] });
			await table.update({ operation: 'insert', values: [2, '', 0.0, new Uint8Array(0), 'not null'] });

			const rows = [];
			for await (const row of table.query(createFilterInfo())) {
				rows.push(row);
			}

			void expect(rows).to.have.length(2);
			void expect(rows[0][1]).to.equal('hello');
			void expect(rows[0][2]).to.equal(3.14);
			void expect(rows[0][3]).to.deep.equal(blobData);
			void expect(rows[0][4]).to.be.null;
			void expect(rows[1][4]).to.equal('not null');
		});

		it("should handle NULL in composite primary keys", async () => {
			const schema = createTableSchema('composite_null', [
				{ name: 'part1', logicalType: TEXT_TYPE, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'part2', logicalType: INTEGER_TYPE, notNull: true, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'value', logicalType: TEXT_TYPE, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false }
			], ['part1', 'part2']);
			const table2 = await module.create(db, schema);

			await table2.update({ operation: 'insert', values: ['a', 1, 'value1'] });
			await table2.update({ operation: 'insert', values: [null, 2, 'value2'] });

			const rows = [];
			for await (const row of table2.query(createFilterInfo())) {
				rows.push(row);
			}

			void expect(rows).to.have.length(2);
			void expect(rows[0][0]).to.be.null;
			void expect(rows[1][0]).to.equal('a');
		});

		it("should handle empty table operations", async () => {
			// Operations on empty table should not error
			await table.update({ operation: 'update', values: [999, 'new'], oldKeyValues: [999] });
			await table.update({ operation: 'delete', values: undefined, oldKeyValues: [999] });

			const rows = [];
			for await (const row of table.query(createFilterInfo())) {
				rows.push(row);
			}
			void expect(rows).to.have.length(0);
		});
	});

	describe("Read-Only Tables", () => {
		it("should create read-only tables", async () => {
			const schema: TableSchema = {
				...createTableSchema('readonly_data'),
				isReadOnly: true
			};
			const table = await module.create(db, schema);

			void expect(table.isReadOnly()).to.be.true;

			// Should be able to query empty table
			const rows = [];
			for await (const row of table.query(createFilterInfo())) {
				rows.push(row);
			}
			void expect(rows).to.have.length(0);
		});

		it("should prevent modifications to read-only tables", async () => {
			const schema: TableSchema = {
				...createTableSchema('readonly_data'),
				isReadOnly: true
			};
			const table = await module.create(db, schema);

			try {
				await table.update({ operation: 'insert', values: [1, 'test'] });
				expect.fail("Should not allow INSERT on read-only table");
			} catch (error: any) {
				expect(error.message).to.include('read-only');
			}
		});
	});

	describe("Module Cleanup", () => {
		it("should destroy tables and clean up resources", async () => {
			const schema = createTableSchema('temp_table');
			await module.create(db, schema);

			await module.destroy(db, null, 'memory', 'main', 'temp_table');

			// Should not be able to connect to destroyed table
			try {
				await module.connect(db, null, 'memory', 'main', 'temp_table', {});
				expect.fail("Should not be able to connect to destroyed table");
			} catch (error: any) {
				expect(error.message).to.include('not found');
			}
		});
	});

	describe("TransactionLayer.hasChanges()", () => {
		function createBaseLayer(): BaseLayer {
			const schema = createTableSchema('has_changes_test', [
				{ name: 'id', logicalType: INTEGER_TYPE, notNull: true, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'value', logicalType: TEXT_TYPE, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
			], ['id']);
			return new BaseLayer(schema, db.getCollationResolver());
		}

		it("should return false for a fresh layer with no modifications", () => {
			const base = createBaseLayer();
			const layer = new TransactionLayer(base);

			expect(layer.hasChanges()).to.be.false;
		});

		it("should return false for a fresh layer over a non-empty base", () => {
			const base = createBaseLayer();
			base.primaryTree.insert([1, 'existing']);

			const layer = new TransactionLayer(base);
			expect(layer.hasChanges()).to.be.false;
		});

		it("should return true after an upsert", () => {
			const base = createBaseLayer();
			const layer = new TransactionLayer(base);

			layer.recordUpsert([1], [1, 'new'], null);
			expect(layer.hasChanges()).to.be.true;
		});

		it("should return true after a delete", () => {
			const base = createBaseLayer();
			base.primaryTree.insert([1, 'existing']);

			const layer = new TransactionLayer(base);
			layer.recordDelete([1], [1, 'existing']);
			expect(layer.hasChanges()).to.be.true;
		});

		it("should return false for outer layer when only inner layer is modified", () => {
			const base = createBaseLayer();
			base.primaryTree.insert([1, 'existing']);

			const outerLayer = new TransactionLayer(base);
			const innerLayer = new TransactionLayer(outerLayer);

			innerLayer.recordUpsert([2], [2, 'inner-only'], null);

			expect(innerLayer.hasChanges()).to.be.true;
			expect(outerLayer.hasChanges()).to.be.false;
		});
	});

	describe("TransactionLayer.rekeyPrimaryKey deletion replay", () => {
		// Changing a primary-key column's collation re-sorts every open transaction layer.
		// Each layer's deletions are replayed by looking the deleted key up in the already
		// re-sorted parent — and under the new order that lookup can land on a DIFFERENT row
		// whose key now compares equal. `installNetOwnWrites`'s `deletionTargets` guard checks,
		// under the OLD comparator, that the row it found is the row this layer removed.
		//
		// `MemoryTableManager.validateRekeyedPrimaryKey` refuses every chain that could reach
		// that arrangement before `rekeyPrimaryKey` ever runs, so the guard is pure insurance
		// in the live engine and no end-to-end test can exercise it. These build the layer
		// chain directly, bypassing the manager (and hence that validation pass), which is the
		// only way to reach the check — see `rekeyPrimaryKey`'s doc comment.

		const rekeyColumns: ColumnSchema[] = [
			{ name: 'k', logicalType: TEXT_TYPE, notNull: true, primaryKey: true, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
			{ name: 'v', logicalType: TEXT_TYPE, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
		];

		/** Pre-ALTER shape: a case-SENSITIVE text primary key, so 'A' and 'a' are distinct. */
		function binaryKeySchema(): TableSchema {
			return createTableSchema('rekey_replay', rekeyColumns, ['k']);
		}

		/**
		 * Post-ALTER shape: the same table with the key column re-collated NOCASE, so 'A' and
		 * 'a' collapse onto one key. The collation must go on the PK DEFINITION, not just the
		 * column — `createPrimaryKeyFunctions` reads the comparator's collation from there.
		 */
		function nocaseKeySchema(): TableSchema {
			const base = binaryKeySchema();
			return {
				...base,
				columns: Object.freeze(rekeyColumns.map((col, i) => (i === 0 ? { ...col, collation: 'NOCASE' } : col))),
				primaryKeyDefinition: Object.freeze([{ index: 0, desc: false, collation: 'NOCASE' }]),
			};
		}

		/** This layer's effective rows (its own tree, inheriting the parent's copy-on-write). */
		function rowsOf(layer: TransactionLayer): Row[] {
			return [...iteratePrimaryRows(layer.getModificationTree('primary')!)];
		}

		/**
		 * A two-layer chain over an EMPTY base: the parent stages a row at `parentKey`, the
		 * child deletes `childDeleteKey`. Returns both layers already re-keyed NOCASE,
		 * oldest-first as every whole-chain rebuild requires.
		 */
		function rekeyedChain(parentKey: string, childDeleteKey: string): { parent: TransactionLayer; child: TransactionLayer } {
			const base = new BaseLayer(binaryKeySchema(), db.getCollationResolver());
			const parent = new TransactionLayer(base);
			parent.recordUpsert(parentKey, [parentKey, 'parent-write'], null);
			const child = new TransactionLayer(parent);
			child.recordDelete(childDeleteKey, [childDeleteKey, 'child-delete']);

			const nocase = nocaseKeySchema();
			base.updateSchema(nocase);
			base.rebuildPrimaryTreeStrict();
			parent.rekeyPrimaryKey(nocase);
			child.rekeyPrimaryKey(nocase);
			return { parent, child };
		}

		it("leaves an unrelated row alone when a replayed deletion's key collapses onto it", () => {
			// The parent staged 'a'; the child deleted 'A', which under BINARY matched nothing.
			// After the re-key the child's replayed deletion finds the parent's 'a' — a row the
			// child never removed. Deleting it would silently discard a row the transaction just
			// wrote.
			const { child } = rekeyedChain('a', 'A');

			expect(rowsOf(child), "the parent's row must survive the child's replayed deletion")
				.to.deep.equal([['a', 'parent-write']]);
			// The deletion is also dropped from the replay log, so a later rebase / index rebuild
			// cannot re-apply it against the same row.
			expect(child.getOwnWrites(), 'a deletion that matched nothing leaves no own write').to.deep.equal([]);
		});

		it("still applies a replayed deletion that targets its own row", () => {
			// The mirror case, pinning that the guard is an identity check and not a blanket
			// "skip every deletion whose key was re-sorted": here the child deleted the very row
			// the parent staged, so the replay must remove it.
			const { child } = rekeyedChain('a', 'a');

			expect(rowsOf(child), "the child's own deletion must still take effect").to.deep.equal([]);
			expect(child.getOwnWrites(), 'the surviving deletion is kept in the replay log')
				.to.deep.equal([{ type: 'delete', primaryKey: 'a' }]);
		});
	});
});
