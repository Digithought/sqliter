import { expect } from 'chai';
import { Database, QuereusError } from '../src/index.js';
import { MemoryTableModule } from '../src/vtab/memory/module.js';
import { MemoryTable } from '../src/vtab/memory/table.js';
import type { TableSchema } from '../src/schema/table.js';
import type { ColumnSchema } from '../src/schema/column.js';
import { INTEGER_TYPE, TEXT_TYPE, REAL_TYPE } from '../src/types/index.js';
import { resolveDdlTransactionality, assertDdlTransactionPolicy } from '../src/runtime/emit/ddl-transaction-policy.js';
import type { AnyVirtualTableModule } from '../src/vtab/module.js';

describe('Module Capabilities', () => {
	let db: Database;
	let module: MemoryTableModule;

	beforeEach(() => {
		db = new Database();
		module = new MemoryTableModule();
	});

	afterEach(async () => {
		await db.close();
	});

	// Helper function to create a table schema
	function createTableSchema(
		name: string,
		columns: ColumnSchema[],
		primaryKey: string[]
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

	it('memory module reports correct capabilities', () => {
		const caps = module.getCapabilities();

		expect(caps.isolation).to.be.true;
		expect(caps.savepoints).to.be.true;
		expect(caps.persistent).to.be.false;
		expect(caps.secondaryIndexes).to.be.true;
		expect(caps.rangeScans).to.be.true;
		// Memory's schema changes escape the transaction but its DML rolls back.
		expect(caps.ddlTransactionality).to.equal('non-transactional');
	});

	it('extractPrimaryKey extracts correct values', async () => {
		const schema = createTableSchema(
			'test',
			[
				{ name: 'a', logicalType: INTEGER_TYPE, notNull: true, primaryKey: true, pkOrder: 1, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'b', logicalType: TEXT_TYPE, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'c', logicalType: REAL_TYPE, notNull: true, primaryKey: true, pkOrder: 2, defaultValue: null, collation: 'BINARY', generated: false }
			],
			['a', 'c']
		);

		const table = await module.create(db, schema);
		expect(table).to.be.instanceOf(MemoryTable);

		const row = [1, 'hello', 3.14];
		const pk = table.extractPrimaryKey(row);

		expect(pk).to.deep.equal([1, 3.14]);
	});

	it('extractPrimaryKey works with single-column primary key', async () => {
		const schema = createTableSchema(
			'single_pk',
			[
				{ name: 'id', logicalType: INTEGER_TYPE, notNull: true, primaryKey: true, pkOrder: 1, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'name', logicalType: TEXT_TYPE, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false }
			],
			['id']
		);

		const table = await module.create(db, schema);

		const row = [42, 'test'];
		const pk = table.extractPrimaryKey(row);

		expect(pk).to.deep.equal([42]);
	});

	it('getPrimaryKeyIndices returns correct indices', async () => {
		const schema = createTableSchema(
			'pk_test',
			[
				{ name: 'a', logicalType: INTEGER_TYPE, notNull: true, primaryKey: true, pkOrder: 1, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'b', logicalType: TEXT_TYPE, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'c', logicalType: REAL_TYPE, notNull: true, primaryKey: true, pkOrder: 2, defaultValue: null, collation: 'BINARY', generated: false }
			],
			['a', 'c']
		);

		const table = await module.create(db, schema);

		const indices = table.getPrimaryKeyIndices();
		expect(indices).to.deep.equal([0, 2]); // 'a' is at index 0, 'c' is at index 2
	});

	it('comparePrimaryKey orders correctly with integers', async () => {
		const schema = createTableSchema(
			'cmp_test',
			[
				{ name: 'id', logicalType: INTEGER_TYPE, notNull: true, primaryKey: true, pkOrder: 1, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'name', logicalType: TEXT_TYPE, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false }
			],
			['id']
		);

		const table = await module.create(db, schema);

		expect(table.comparePrimaryKey([1], [2])).to.be.lessThan(0);
		expect(table.comparePrimaryKey([2], [1])).to.be.greaterThan(0);
		expect(table.comparePrimaryKey([1], [1])).to.equal(0);
	});

	it('comparePrimaryKey orders correctly with composite keys', async () => {
		const schema = createTableSchema(
			'composite_test',
			[
				{ name: 'a', logicalType: INTEGER_TYPE, notNull: true, primaryKey: true, pkOrder: 1, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'b', logicalType: INTEGER_TYPE, notNull: true, primaryKey: true, pkOrder: 2, defaultValue: null, collation: 'BINARY', generated: false }
			],
			['a', 'b']
		);

		const table = await module.create(db, schema);

		// First column determines order
		expect(table.comparePrimaryKey([1, 5], [2, 1])).to.be.lessThan(0);
		expect(table.comparePrimaryKey([2, 1], [1, 5])).to.be.greaterThan(0);

		// When first column is equal, second column determines order
		expect(table.comparePrimaryKey([1, 1], [1, 2])).to.be.lessThan(0);
		expect(table.comparePrimaryKey([1, 2], [1, 1])).to.be.greaterThan(0);

		// Equal keys
		expect(table.comparePrimaryKey([1, 2], [1, 2])).to.equal(0);
	});

	it('comparePrimaryKey handles text values', async () => {
		const schema = createTableSchema(
			'text_pk',
			[
				{ name: 'name', logicalType: TEXT_TYPE, notNull: true, primaryKey: true, pkOrder: 1, defaultValue: null, collation: 'BINARY', generated: false }
			],
			['name']
		);

		const table = await module.create(db, schema);

		expect(table.comparePrimaryKey(['alice'], ['bob'])).to.be.lessThan(0);
		expect(table.comparePrimaryKey(['bob'], ['alice'])).to.be.greaterThan(0);
		expect(table.comparePrimaryKey(['alice'], ['alice'])).to.equal(0);
	});

	it('comparePrimaryKey handles null values', async () => {
		const schema = createTableSchema(
			'null_test',
			[
				{ name: 'id', logicalType: INTEGER_TYPE, notNull: false, primaryKey: true, pkOrder: 1, defaultValue: null, collation: 'BINARY', generated: false }
			],
			['id']
		);

		const table = await module.create(db, schema);

		// NULL is less than any non-null value
		expect(table.comparePrimaryKey([null], [1])).to.be.lessThan(0);
		expect(table.comparePrimaryKey([1], [null])).to.be.greaterThan(0);
		expect(table.comparePrimaryKey([null], [null])).to.equal(0);
	});

	it('getIndexComparator returns per-column comparators for existing indexes', async () => {
		const schema = createTableSchema(
			'idx_test',
			[
				{ name: 'id', logicalType: INTEGER_TYPE, notNull: true, primaryKey: true, pkOrder: 1, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'email', logicalType: TEXT_TYPE, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false }
			],
			['id']
		);

		// Add an index to the schema
		const schemaWithIndex: TableSchema = {
			...schema,
			indexes: Object.freeze([
				{ name: 'idx_email', columns: [{ index: 1, desc: false }] }
			])
		};

		const table = await module.create(db, schemaWithIndex);

		const comparators = table.getIndexComparator('idx_email');
		expect(comparators).to.be.an('array').with.lengthOf(1);

		const comparator = comparators![0];
		expect(comparator('alice@test.com', 'bob@test.com')).to.be.lessThan(0);
		expect(comparator('bob@test.com', 'alice@test.com')).to.be.greaterThan(0);
		expect(comparator('alice@test.com', 'alice@test.com')).to.equal(0);
	});

	it('getIndexComparator returns undefined for non-existent indexes', async () => {
		const schema = createTableSchema(
			'no_idx',
			[
				{ name: 'id', logicalType: INTEGER_TYPE, notNull: true, primaryKey: true, pkOrder: 1, defaultValue: null, collation: 'BINARY', generated: false }
			],
			['id']
		);

		const table = await module.create(db, schema);

		const comparators = table.getIndexComparator('non_existent_index');
		expect(comparators).to.be.undefined;
	});

	it('getIndexComparator handles DESC ordering', async () => {
		const schema = createTableSchema(
			'desc_test',
			[
				{ name: 'id', logicalType: INTEGER_TYPE, notNull: true, primaryKey: true, pkOrder: 1, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'score', logicalType: INTEGER_TYPE, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false }
			],
			['id']
		);

		const schemaWithIndex: TableSchema = {
			...schema,
			indexes: Object.freeze([
				{ name: 'idx_score_desc', columns: [{ index: 1, desc: true }] }
			])
		};

		const table = await module.create(db, schemaWithIndex);

		const comparators = table.getIndexComparator('idx_score_desc');
		expect(comparators).to.be.an('array').with.lengthOf(1);

		const comparator = comparators![0];
		// DESC reverses the ordering: higher values come first
		expect(comparator(10, 20)).to.be.greaterThan(0);
		expect(comparator(20, 10)).to.be.lessThan(0);
		expect(comparator(10, 10)).to.equal(0);
	});

	it('getIndexComparator handles NOCASE collation', async () => {
		const schema = createTableSchema(
			'collation_test',
			[
				{ name: 'id', logicalType: INTEGER_TYPE, notNull: true, primaryKey: true, pkOrder: 1, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'name', logicalType: TEXT_TYPE, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false }
			],
			['id']
		);

		const schemaWithIndex: TableSchema = {
			...schema,
			indexes: Object.freeze([
				{ name: 'idx_name_nocase', columns: [{ index: 1, desc: false, collation: 'NOCASE' }] }
			])
		};

		const table = await module.create(db, schemaWithIndex);

		const comparators = table.getIndexComparator('idx_name_nocase');
		expect(comparators).to.be.an('array').with.lengthOf(1);

		const comparator = comparators![0];
		// NOCASE collation: 'Alice' and 'alice' should be equal
		expect(comparator('Alice', 'alice')).to.equal(0);
		expect(comparator('alice', 'bob')).to.be.lessThan(0);
		expect(comparator('BOB', 'alice')).to.be.greaterThan(0);
	});

	it('getIndexComparator handles composite indexes with mixed DESC', async () => {
		const schema = createTableSchema(
			'composite_test',
			[
				{ name: 'id', logicalType: INTEGER_TYPE, notNull: true, primaryKey: true, pkOrder: 1, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'category', logicalType: TEXT_TYPE, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
				{ name: 'score', logicalType: INTEGER_TYPE, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false }
			],
			['id']
		);

		const schemaWithIndex: TableSchema = {
			...schema,
			indexes: Object.freeze([
				{ name: 'idx_cat_score', columns: [
					{ index: 1, desc: false },        // category ASC
					{ index: 2, desc: true }           // score DESC
				] }
			])
		};

		const table = await module.create(db, schemaWithIndex);

		const comparators = table.getIndexComparator('idx_cat_score');
		expect(comparators).to.be.an('array').with.lengthOf(2);

		// First column (category): ASC
		expect(comparators![0]('alpha', 'beta')).to.be.lessThan(0);
		expect(comparators![0]('beta', 'alpha')).to.be.greaterThan(0);

		// Second column (score): DESC
		expect(comparators![1](10, 20)).to.be.greaterThan(0);
		expect(comparators![1](20, 10)).to.be.lessThan(0);
	});

	it('module without getCapabilities returns empty object gracefully', () => {
		// Create a minimal module without getCapabilities
		const minimalModule = {
			create: async () => { throw new Error('not implemented'); },
			connect: async () => { throw new Error('not implemented'); },
			destroy: async () => { /* noop */ },
		};

		// Simulate checking capabilities on a module that doesn't implement it
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const caps = (minimalModule as any).getCapabilities?.() ?? {};
		expect(caps).to.deep.equal({});
	});
});

describe('DDL transaction policy', () => {
	let db: Database;
	let module: MemoryTableModule;

	beforeEach(async () => {
		db = new Database();
		module = new MemoryTableModule();
		await db.exec('create table t (id integer primary key, v text)');
	});

	afterEach(async () => {
		await db.close();
	});

	describe('resolveDdlTransactionality', () => {
		it('resolves the memory module to non-transactional', () => {
			expect(resolveDdlTransactionality(module)).to.equal('non-transactional');
		});

		it('defaults an undefined module to non-transactional', () => {
			expect(resolveDdlTransactionality(undefined)).to.equal('non-transactional');
		});

		it('defaults a module without getCapabilities to non-transactional', () => {
			// A flagless stub — no getCapabilities at all — must NOT be assumed clean.
			const stub = {
				create: async () => { throw new Error('nyi'); },
				connect: async () => { throw new Error('nyi'); },
				destroy: async () => { /* noop */ },
			} as unknown as AnyVirtualTableModule;
			expect(resolveDdlTransactionality(stub)).to.equal('non-transactional');
		});

		it('defaults a module whose getCapabilities omits the flag to non-transactional', () => {
			const stub = {
				create: async () => { throw new Error('nyi'); },
				connect: async () => { throw new Error('nyi'); },
				destroy: async () => { /* noop */ },
				getCapabilities: () => ({ isolation: true }),
			} as unknown as AnyVirtualTableModule;
			expect(resolveDdlTransactionality(stub)).to.equal('non-transactional');
		});
	});

	describe('assertDdlTransactionPolicy gate', () => {
		it('is a no-op under the default permissive policy, even in an explicit transaction', async () => {
			await db.beginTransaction();
			// Should not throw despite memory being non-transactional.
			assertDdlTransactionPolicy(db, module, 'memory', 'CREATE INDEX x');
			await db.rollback();
		});

		it('is a no-op under strict in autocommit mode', () => {
			void db.exec("pragma ddl_transaction_policy = 'strict'");
			expect(db.getAutocommit()).to.be.true;
			assertDdlTransactionPolicy(db, module, 'memory', 'CREATE INDEX x');
		});

		it('refuses a non-transactional module inside an explicit transaction under strict', async () => {
			await db.exec("pragma ddl_transaction_policy = 'strict'");
			await db.beginTransaction();
			expect(() => assertDdlTransactionPolicy(db, module, 'memory', 'CREATE INDEX x'))
				.to.throw(QuereusError, /ddl_transaction_policy = strict/);
			// The transaction is untouched — still open.
			expect(db.getAutocommit()).to.be.false;
			await db.rollback();
		});

		it('refuses a flagless stub module (defaults to non-transactional) under strict', async () => {
			const stub = {
				create: async () => { throw new Error('nyi'); },
				connect: async () => { throw new Error('nyi'); },
				destroy: async () => { /* noop */ },
			} as unknown as AnyVirtualTableModule;
			await db.exec("pragma ddl_transaction_policy = 'strict'");
			await db.beginTransaction();
			expect(() => assertDdlTransactionPolicy(db, stub, 'stub', 'DROP TABLE t'))
				.to.throw(QuereusError, /non-transactional/);
			await db.rollback();
		});
	});
});
