import { expect } from 'chai';
import { Database } from '../../src/index.js';
import type { SqlValue } from '../../src/common/types.js';
import { encodeKeyTuple, decodeKeyTuple } from '../../src/util/key-tuple-codec.js';

/** Drain `Statement.all()` (an async iterable) into an array of row objects. */
async function allRows(db: Database, sql: string): Promise<Array<Record<string, SqlValue>>> {
	const rows: Array<Record<string, SqlValue>> = [];
	for await (const row of db.prepare(sql).all()) rows.push(row);
	return rows;
}

/**
 * Regression test for the change-log key serializer crashing on a bigint PK.
 *
 * `TransactionManager.serializeKeyTuple` derived the change-log Map key via
 * canonical JSON (`JSON.stringify`), which throws "Do not know how to serialize
 * a BigInt" the moment any DML op inside a transaction touches a row whose PK
 * (or a captured column) is a JS bigint. A PK value beyond
 * `Number.MAX_SAFE_INTEGER` surfaces as a bigint, so a plain INSERT crashed.
 */
describe('TransactionManager: bigint PK does not crash the change log', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	// 2^53 + 1 — the smallest positive integer that cannot be represented
	// exactly as a JS number, so it must survive as a bigint end-to-end.
	const BIG = 9007199254740993n;

	it('inserts a bigint PK inside an explicit transaction without throwing', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory');
		await db.exec('BEGIN');
		await db.exec(`INSERT INTO t VALUES (${BIG.toString()}, 'x')`);
		await db.exec('COMMIT');

		const rows = await allRows(db, 'SELECT id, v FROM t');
		expect(rows).to.have.length(1);
		// Value must round-trip exactly — a number cast would lose the low bit.
		expect(rows[0].id).to.equal(BIG);
		expect(rows[0].v).to.equal('x');
	});

	it('updates and deletes a bigint PK row without throwing', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory');
		await db.exec(`INSERT INTO t VALUES (${BIG.toString()}, 'a')`);

		await db.exec('BEGIN');
		await db.exec(`UPDATE t SET v = 'b' WHERE id = ${BIG.toString()}`);
		await db.exec('COMMIT');
		expect((await allRows(db, 'SELECT v FROM t'))[0].v).to.equal('b');

		await db.exec('BEGIN');
		await db.exec(`DELETE FROM t WHERE id = ${BIG.toString()}`);
		await db.exec('COMMIT');
		expect(await allRows(db, 'SELECT id FROM t')).to.deep.equal([]);
	});

	it('getChangedTuples/getChangedKeyTuples round-trip a bigint PK as a bigint', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory');
		await db.exec('BEGIN');
		await db.exec(`INSERT INTO t VALUES (${BIG.toString()}, 'x')`);

		const keyTuples = db.getChangedKeyTuples('main.t');
		expect(keyTuples).to.have.length(1);
		expect(keyTuples[0][0]).to.equal(BIG); // still a bigint, exact value

		const tuples = db.getChangedTuples('main.t', [0], [0]);
		expect(tuples).to.deep.equal([[BIG]]);

		await db.exec('ROLLBACK');
	});

	it('round-trips a small number PK as a number, not a bigint', async () => {
		// Regression guard: the codec is type-faithful, so a small integer PK
		// (which flows as a JS number) must decode back as a number — otherwise
		// `delta-executor` watch matching (bigint `b:` vs number `n:` keys) breaks.
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory');
		await db.exec('BEGIN');
		await db.exec(`INSERT INTO t VALUES (5, 'x')`);

		const keyTuples = db.getChangedKeyTuples('main.t');
		expect(keyTuples).to.have.length(1);
		expect(keyTuples[0][0]).to.equal(5);
		expect(typeof keyTuples[0][0]).to.equal('number');

		await db.exec('ROLLBACK');
	});
});

describe('key-tuple-codec: type-faithful reversible round-trip', () => {
	const BIG = 9007199254740993n;

	it('round-trips every SqlValue class, including blobs', () => {
		const tuple: SqlValue[] = [
			null,
			'hello',
			42,
			-3.5,
			BIG,
			true,
			false,
			new Uint8Array([0, 1, 254, 255]),
			{ b: 2, a: 1 },
			[1, 'x', null],
		];
		const decoded = decodeKeyTuple(encodeKeyTuple(tuple));
		expect(decoded).to.deep.equal([
			null, 'hello', 42, -3.5, BIG, true, false,
			new Uint8Array([0, 1, 254, 255]),
			{ a: 1, b: 2 }, [1, 'x', null],
		]);
		// Type identity is preserved across the round-trip.
		expect(typeof decoded[2]).to.equal('number');
		expect(typeof decoded[4]).to.equal('bigint');
		expect(decoded[7]).to.be.instanceOf(Uint8Array);
	});

	it('keys bigint distinctly from number, and reorder-equal objects identically', () => {
		expect(encodeKeyTuple([5n])).to.not.equal(encodeKeyTuple([5]));
		expect(encodeKeyTuple([{ a: 1, b: 2 }])).to.equal(encodeKeyTuple([{ b: 2, a: 1 }]));
	});
});
