import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { planOps } from './_helpers.js';

/**
 * Plan-shape cover for `bug-cast-stripped-from-seek-constraints`.
 *
 * `test/logic/05.2-cast-seek-correctness.sqllogic` pins the row sets; this pins
 * the *plan*, so a future regression that reintroduces the seek cannot hide
 * behind a fixture that happens to return the right rows. A converting CAST over
 * an indexed column must leave the conjunct as a residual FILTER above a scan;
 * a value-preserving (no-op) CAST must still fold away and seek.
 */
describe('Plan shape: converting CAST blocks index seek', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec("CREATE TABLE t (x TEXT PRIMARY KEY) USING memory");
		await db.exec("INSERT INTO t VALUES ('1'), ('1abc'), ('2')");
	});

	afterEach(async () => {
		await db.close();
	});

	it('explicit converting CAST on the key column → no seek, residual FILTER', async () => {
		const ops = await planOps(db, "SELECT x FROM t WHERE CAST(x AS INTEGER) = 1");
		expect(ops).to.not.include('INDEXSEEK');
		expect(ops).to.include('FILTER');
	});

	it('implicit coercion (`x = 1` on a TEXT key) → no seek, residual FILTER', async () => {
		// `insertCrossTypeCoercion` wraps `x` in a synthetic cast, reaching the
		// same shape with no explicit CAST written.
		const ops = await planOps(db, "SELECT x FROM t WHERE x = 1");
		expect(ops).to.not.include('INDEXSEEK');
		expect(ops).to.include('FILTER');
	});

	it('converting CAST inside a BETWEEN → no seek, residual FILTER', async () => {
		const ops = await planOps(db, "SELECT x FROM t WHERE CAST(x AS INTEGER) BETWEEN 1 AND 1");
		expect(ops).to.not.include('INDEXSEEK');
		expect(ops).to.include('FILTER');
	});

	it('OR of converting CASTs → no seek, residual FILTER', async () => {
		const ops = await planOps(db, "SELECT x FROM t WHERE CAST(x AS INTEGER) = 1 OR CAST(x AS INTEGER) = 2");
		expect(ops).to.not.include('INDEXSEEK');
		expect(ops).to.include('FILTER');
	});

	it('same-type comparison still seeks (no regression on the sound path)', async () => {
		const ops = await planOps(db, "SELECT x FROM t WHERE x = '1'");
		expect(ops).to.include('INDEXSEEK');
	});

	it('no-op CAST on the key column still seeks', async () => {
		const ops = await planOps(db, "SELECT x FROM t WHERE CAST(x AS TEXT) = '1'");
		expect(ops).to.include('INDEXSEEK');
	});

	it('affinity-only alias of the key type is a no-op CAST and still seeks', async () => {
		// NVARCHAR misses the type registry but matches the CHAR affinity rule, so it
		// resolves to TEXT — the same type the emitter parses with. While the planner
		// resolved it to BLOB the cast read as *converting* and blocked the seek even
		// though the runtime changed nothing.
		const ops = await planOps(db, "SELECT x FROM t WHERE CAST(x AS NVARCHAR) = '1'");
		expect(ops).to.include('INDEXSEEK');
	});

	describe('IN value list (bug-numeric-text-coercion-skips-in-and-case)', () => {
		// `coerceComparisonSet` casts each VALUE (not the probe) when the probe is
		// numeric, so a numeric-keyed IN list keeps its seek: the casts are
		// constant-foldable and must collapse to plain literals before access-path
		// selection runs, exactly as the reverse pairing already blocks the seek
		// on a TEXT key (`x = 1` above).
		let dbi: Database;

		beforeEach(async () => {
			dbi = new Database();
			await dbi.exec("CREATE TABLE ti (x INTEGER PRIMARY KEY) USING memory");
			await dbi.exec("INSERT INTO ti VALUES (1), (2), (3)");
		});

		afterEach(async () => {
			await dbi.close();
		});

		it('numeric probe, textual IN-list values → casts fold away, seek survives', async () => {
			const ops = await planOps(dbi, "SELECT x FROM ti WHERE x IN ('1', '2')");
			expect(ops).to.include('INDEXSEEK');
			expect(ops).to.not.include('FILTER');
		});

		it('textual probe, numeric IN-list values → hoisted probe cast blocks the seek, same as `x = 1`', async () => {
			const ops = await planOps(db, "SELECT x FROM t WHERE x IN (1, 2)");
			expect(ops).to.not.include('INDEXSEEK');
			expect(ops).to.include('FILTER');
		});
	});
});
