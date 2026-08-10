import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { planNodeTypes, allRows } from './_helpers.js';

/**
 * Plan-shape assertions for `exists-in-select-decorrelation`: a correlated
 * EXISTS / IN in the SELECT list becomes an existence-flag LEFT join (the
 * Exists/In node is dissolved into a flag column read), and the rejected
 * shapes keep their correlated per-row plan.
 */
describe('Plan shape: SELECT-list EXISTS/IN decorrelation', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec("CREATE TABLE o (id INTEGER PRIMARY KEY, k INTEGER NULL) USING memory");
		await db.exec("CREATE TABLE c (id INTEGER PRIMARY KEY, fk INTEGER NULL, v INTEGER NULL) USING memory");
		await db.exec("INSERT INTO o VALUES (1, 10), (2, 20), (3, NULL)");
		// Two rows share fk = 10 — the fan-out case the DISTINCT collapse guards.
		await db.exec("INSERT INTO c VALUES (1, 10, 5), (2, 10, 6), (3, 20, 7)");
	});

	afterEach(async () => {
		await db.close();
	});

	it('dissolves a SELECT-list EXISTS into an existence-flag left join', async () => {
		const q = "SELECT o.id, EXISTS (SELECT 1 FROM c WHERE c.fk = o.k) AS f FROM o";
		const types = await planNodeTypes(db, q);

		expect(types, 'Exists node must be dissolved').to.not.include('Exists');
		expect(types, 'flag-bearing logical join expected').to.include('Join');
		// The fan-out guard: inner side collapsed to one row per correlation key.
		expect(types, 'DISTINCT key collapse expected on the inner side').to.include('Distinct');

		const rows = await allRows<{ id: number; f: boolean }>(db, q + ' ORDER BY o.id');
		expect(rows).to.deep.equal([
			{ id: 1, f: true },
			{ id: 2, f: true },
			{ id: 3, f: false },
		]);
	});

	it('dissolves NOT EXISTS the same way (NOT survives over the flag)', async () => {
		const q = "SELECT o.id, NOT EXISTS (SELECT 1 FROM c WHERE c.fk = o.k) AS f FROM o";
		const types = await planNodeTypes(db, q);
		expect(types).to.not.include('Exists');
		expect(types).to.include('Join');

		const rows = await allRows<{ id: number; f: boolean }>(db, q + ' ORDER BY o.id');
		expect(rows.map(r => r.f)).to.deep.equal([false, false, true]);
	});

	it('dissolves a non-nullable correlated IN into the same flag join', async () => {
		const q = "SELECT o.id, (o.id IN (SELECT c.id FROM c WHERE c.fk = o.k)) AS f FROM o";
		const types = await planNodeTypes(db, q);
		expect(types, 'In node must be dissolved').to.not.include('In');
		expect(types).to.include('Join');

		const rows = await allRows<{ id: number; f: boolean }>(db, q + ' ORDER BY o.id');
		expect(rows.map(r => r.f)).to.deep.equal([true, false, false]);
	});

	it('keeps a nullable-side IN on the correlated per-row path', async () => {
		// c.fk is nullable: `x IN S` can yield NULL, which the two-valued flag
		// cannot represent — the rule must bail.
		const q = "SELECT o.id, (o.k IN (SELECT c.fk FROM c WHERE c.v = o.id)) AS f FROM o";
		const types = await planNodeTypes(db, q);
		expect(types, 'nullable IN must stay on the per-row path').to.include('In');
	});

	it('keeps a non-equi correlation on the correlated per-row path', async () => {
		const q = "SELECT o.id, EXISTS (SELECT 1 FROM c WHERE c.v < o.k) AS f FROM o";
		const types = await planNodeTypes(db, q);
		expect(types, 'non-equi EXISTS must stay on the per-row path').to.include('Exists');
	});
});
