import { expect } from 'chai';
import { Database, Statement } from '../src/index.js';
import { Parser } from '../src/parser/parser.js';

describe('Statement SQL text reconstruction', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	it('getBlockSql() returns rendered SQL, not "[object Object]"', async () => {
		await db.exec('create table t (a integer, b text)');
		const stmt = db.prepare('select a, b from t where a > 1');

		const sql = stmt.getBlockSql();

		expect(sql).to.not.include('[object Object]');
		expect(sql).to.equal('select a, b from t where a > 1');

		await stmt.finalize();
	});

	it('originalSql reflects rendered SQL when prepared from a pre-parsed AST batch', async () => {
		await db.exec('create table t (a integer, b text)');
		const astBatch = new Parser().parseAll('select a, b from t where a > 1; select b from t');
		const stmt = new Statement(db, astBatch);

		expect(stmt.originalSql).to.not.include('[object Object]');
		expect(stmt.originalSql).to.equal('select a, b from t where a > 1; select b from t');

		await stmt.finalize();
	});
});
