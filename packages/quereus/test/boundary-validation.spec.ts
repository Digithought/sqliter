/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from 'chai';
import { Database, MisuseError, PhysicalType, TEXT_TYPE } from '../src/index.js';

describe('Boundary Validation', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	// ========================================================================
	// registerModule()
	// ========================================================================

	describe('registerModule()', () => {
		const validModule = {
			create: async () => ({} as any),
			connect: async () => ({} as any),
			destroy: async () => {},
		};

		it('should reject empty name', () => {
			expect(() => db.registerModule('', validModule as any)).to.throw(MisuseError, /name must be a non-empty string/);
		});

		it('should reject non-string name', () => {
			expect(() => db.registerModule(42 as any, validModule as any)).to.throw(MisuseError, /name must be a non-empty string/);
		});

		it('should reject null module', () => {
			expect(() => db.registerModule('test', null as any)).to.throw(MisuseError, /module must be an object/);
		});

		it('should reject module missing create', () => {
			const bad = { connect: async () => ({} as any), destroy: async () => {} };
			expect(() => db.registerModule('test', bad as any)).to.throw(MisuseError, /module\.create must be a function/);
		});

		it('should reject module missing connect', () => {
			const bad = { create: async () => ({} as any), destroy: async () => {} };
			expect(() => db.registerModule('test', bad as any)).to.throw(MisuseError, /module\.connect must be a function/);
		});

		it('should reject module missing destroy', () => {
			const bad = { create: async () => ({} as any), connect: async () => ({} as any) };
			expect(() => db.registerModule('test', bad as any)).to.throw(MisuseError, /module\.destroy must be a function/);
		});

		it('should accept valid module', () => {
			expect(() => db.registerModule('test_mod', validModule as any)).not.to.throw();
		});
	});

	// ========================================================================
	// registerFunction()
	// ========================================================================

	describe('registerFunction()', () => {
		// A valid scalar return type. Each case below is malformed in exactly the field
		// its name calls out, so the assertion cannot pass on some other check's error;
		// registerFunction validates returnType last, after all of these.
		const TEXT_RETURN_TYPE = { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true };

		it('should reject null schema', () => {
			expect(() => db.registerFunction(null as any)).to.throw(MisuseError, /schema must be an object/);
		});

		it('should reject schema with empty name', () => {
			expect(() => db.registerFunction({ name: '', numArgs: 0, flags: 0, returnType: TEXT_RETURN_TYPE, implementation: () => null } as any)).to.throw(MisuseError, /schema\.name must be a non-empty string/);
		});

		it('should reject schema with non-integer numArgs', () => {
			expect(() => db.registerFunction({ name: 'f', numArgs: 1.5, flags: 0, returnType: TEXT_RETURN_TYPE, implementation: () => null } as any)).to.throw(MisuseError, /schema\.numArgs must be an integer/);
		});

		it('should reject schema with numArgs < -1', () => {
			expect(() => db.registerFunction({ name: 'f', numArgs: -2, flags: 0, returnType: TEXT_RETURN_TYPE, implementation: () => null } as any)).to.throw(MisuseError, /schema\.numArgs must be an integer/);
		});

		it('should reject schema without implementation or stepFunction', () => {
			expect(() => db.registerFunction({ name: 'f', numArgs: 0, flags: 0, returnType: TEXT_RETURN_TYPE } as any)).to.throw(MisuseError, /must have implementation/);
		});

		it('should reject aggregate schema with non-function stepFunction', () => {
			expect(() => db.registerFunction({ name: 'f', numArgs: 0, flags: 0, returnType: TEXT_RETURN_TYPE, stepFunction: 'not a func', finalizeFunction: () => null } as any)).to.throw(MisuseError, /stepFunction must be a function/);
		});

		it('should reject aggregate schema with non-function finalizeFunction', () => {
			expect(() => db.registerFunction({ name: 'f', numArgs: 0, flags: 0, returnType: TEXT_RETURN_TYPE, stepFunction: () => null, finalizeFunction: 'not a func' } as any)).to.throw(MisuseError, /finalizeFunction must be a function/);
		});

		it('should reject schema with non-function implementation', () => {
			expect(() => db.registerFunction({ name: 'f', numArgs: 0, flags: 0, returnType: TEXT_RETURN_TYPE, implementation: 'not a func' } as any)).to.throw(MisuseError, /schema\.implementation must be a function/);
		});
	});

	// ========================================================================
	// registerCollation()
	// ========================================================================

	describe('registerCollation()', () => {
		it('should reject empty name', () => {
			expect(() => db.registerCollation('', () => 0)).to.throw(MisuseError, /name must be a non-empty string/);
		});

		it('should reject non-string name', () => {
			expect(() => db.registerCollation(123 as any, () => 0)).to.throw(MisuseError, /name must be a non-empty string/);
		});

		it('should reject non-function func', () => {
			expect(() => db.registerCollation('test', 'not a func' as any)).to.throw(MisuseError, /func must be a function/);
		});

		it('should accept valid collation', () => {
			expect(() => db.registerCollation('MY_COLLATION', (a, b) => a.localeCompare(b))).not.to.throw();
		});
	});

	// ========================================================================
	// registerType()
	// ========================================================================

	describe('registerType()', () => {
		it('should reject empty name', () => {
			expect(() => db.registerType('', { name: '', physicalType: PhysicalType.TEXT } as any)).to.throw(MisuseError, /name must be a non-empty string/);
		});

		it('should reject null definition', () => {
			expect(() => db.registerType('TEST', null as any)).to.throw(MisuseError, /definition must be an object/);
		});

		it('should reject definition with empty name', () => {
			expect(() => db.registerType('TEST', { name: '', physicalType: PhysicalType.TEXT })).to.throw(MisuseError, /definition\.name must be a non-empty string/);
		});

		it('should reject invalid physicalType', () => {
			// @ts-expect-error invalid PhysicalType (boundary test)
			expect(() => db.registerType('TEST', { name: 'TEST', physicalType: 99 })).to.throw(MisuseError, /physicalType must be a valid/);
		});

		it('should reject non-integer physicalType', () => {
			// @ts-expect-error invalid PhysicalType (boundary test)
			expect(() => db.registerType('TEST', { name: 'TEST', physicalType: 1.5 })).to.throw(MisuseError, /physicalType must be a valid/);
		});

		it('should reject negative physicalType', () => {
			// @ts-expect-error invalid PhysicalType (boundary test)
			expect(() => db.registerType('TEST', { name: 'TEST', physicalType: -1 })).to.throw(MisuseError, /physicalType must be a valid/);
		});
	});

	// ========================================================================
	// bind() and bindAll() — SqlValue validation
	// ========================================================================

	describe('bind() SqlValue validation', () => {
		it('should accept plain object values as JSON', async () => {
			await db.exec('CREATE TABLE t1 (id INTEGER PRIMARY KEY, val TEXT)');
			const stmt = db.prepare('INSERT INTO t1 VALUES (?, ?)');
			// Plain objects are now valid SqlValues (JSON)
			expect(() => stmt.bind(1, { foo: 'bar' })).to.not.throw();
		});

		it('should reject class instance values', async () => {
			await db.exec('CREATE TABLE t2 (id INTEGER PRIMARY KEY, val TEXT)');
			const stmt = db.prepare('INSERT INTO t2 VALUES (?, ?)');
			expect(() => stmt.bind(1, new Date() as any)).to.throw(MisuseError, /invalid value/i);
		});

		it('should reject function values', async () => {
			await db.exec('CREATE TABLE t1 (id INTEGER PRIMARY KEY, val TEXT)');
			const stmt = db.prepare('INSERT INTO t1 VALUES (?, ?)');
			expect(() => stmt.bind(2, (() => {}) as any)).to.throw(MisuseError, /invalid value/i);
		});

		it('should reject symbol values', async () => {
			await db.exec('CREATE TABLE t1 (id INTEGER PRIMARY KEY, val TEXT)');
			const stmt = db.prepare('INSERT INTO t1 VALUES (?, ?)');
			expect(() => stmt.bind(1, Symbol('test') as any)).to.throw(MisuseError, /invalid value/i);
		});

		it('should reject undefined values', async () => {
			await db.exec('CREATE TABLE t1 (id INTEGER PRIMARY KEY, val TEXT)');
			const stmt = db.prepare('INSERT INTO t1 VALUES (?, ?)');
			expect(() => stmt.bind(1, undefined as any)).to.throw(MisuseError, /invalid value/i);
		});

		it('should accept all valid SqlValue types', async () => {
			await db.exec('CREATE TABLE t1 (id INTEGER PRIMARY KEY, val TEXT)');
			const stmt = db.prepare('INSERT INTO t1 VALUES (?, ?)');
			expect(() => stmt.bind(1, null)).not.to.throw();
			expect(() => stmt.bind(1, 'hello')).not.to.throw();
			expect(() => stmt.bind(1, 42)).not.to.throw();
			expect(() => stmt.bind(1, BigInt(100))).not.to.throw();
			expect(() => stmt.bind(1, true)).not.to.throw();
			expect(() => stmt.bind(1, new Uint8Array([1, 2, 3]))).not.to.throw();
		});
	});

	describe('bindAll() SqlValue validation', () => {
		it('should accept array with plain object value as JSON', async () => {
			await db.exec('CREATE TABLE t1 (id INTEGER PRIMARY KEY, val TEXT)');
			const stmt = db.prepare('INSERT INTO t1 VALUES (?, ?)');
			expect(() => stmt.bindAll([1, { foo: 'bar' }])).to.not.throw();
		});

		it('should accept named params with plain object value as JSON', async () => {
			await db.exec('CREATE TABLE t1 (id INTEGER PRIMARY KEY, val TEXT)');
			const stmt = db.prepare('INSERT INTO t1 VALUES (:id, :val)');
			expect(() => stmt.bindAll({ id: 1, val: { foo: 'bar' } })).to.not.throw();
		});

		it('should accept valid array parameters', async () => {
			await db.exec('CREATE TABLE t1 (id INTEGER PRIMARY KEY, val TEXT)');
			const stmt = db.prepare('INSERT INTO t1 VALUES (?, ?)');
			expect(() => stmt.bindAll([1, 'hello'])).not.to.throw();
		});

		it('should accept valid named parameters', async () => {
			await db.exec('CREATE TABLE t1 (id INTEGER PRIMARY KEY, val TEXT)');
			const stmt = db.prepare('INSERT INTO t1 VALUES (:id, :val)');
			expect(() => stmt.bindAll({ id: 1, val: 'hello' })).not.to.throw();
		});
	});
});
