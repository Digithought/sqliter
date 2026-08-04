import { expect } from 'chai';
import { Database } from '../../src/core/database.js';

/**
 * Regression for bug-star-in-select-list-ignores-its-position.
 *
 * `buildSelectStmt` used to assemble a SELECT's projection list by collecting
 * every `*` / `table.*` expansion first, then appending every named column
 * after — so a star anywhere in the list came out first in the output,
 * regardless of where it was written. `test/logic/01.1-select-projection-extras.sqllogic`
 * pins the row *values* (which were always correct); a row-value comparison is
 * key-order-insensitive and cannot see a reordering where every duplicate name
 * lands on the same value, so this file pins column *order* directly via
 * `getColumnNames()`.
 */
describe('Plan shape: SELECT-list order with a star', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec("CREATE TABLE t1 (a INTEGER PRIMARY KEY, b TEXT) USING memory");
		await db.exec("INSERT INTO t1 VALUES (1, 'one')");
		// No primary key, so the functional-dependency reduction of GROUP BY keys
		// can't rewrite the grouped cases below into a different shape.
		await db.exec("CREATE TABLE nk (a TEXT, b TEXT) USING memory");
		await db.exec("INSERT INTO nk VALUES ('x', '1')");
	});

	afterEach(async () => {
		await db.close();
	});

	const columnNames = async (sql: string): Promise<string[]> => {
		const stmt = db.prepare(sql);
		try {
			// Column names are only settled once the statement is compiled, which
			// iterating guarantees.
			for await (const _row of stmt.iterateRows()) { /* drain */ }
			return stmt.getColumnNames();
		} finally {
			await stmt.finalize();
		}
	};

	it('a star after a named column expands in place, not first', async () => {
		expect(await columnNames("SELECT a, * FROM t1")).to.deep.equal(['a', 'a:1', 'b']);
	});

	it('a star between two named columns expands in place', async () => {
		expect(await columnNames("SELECT a, *, b FROM t1")).to.deep.equal(['a', 'a:1', 'b', 'b:1']);
	});

	it('a star after a computed column expands in place', async () => {
		expect(await columnNames("SELECT upper(b) u, * FROM t1")).to.deep.equal(['u', 'a', 'b']);
	});

	it('a star before a named column still expands first (unchanged)', async () => {
		expect(await columnNames("SELECT *, a AS last FROM t1")).to.deep.equal(['a', 'b', 'last']);
	});

	it('a grouped query expands the star in place too', async () => {
		// The grouped path assembles its own final projections
		// (buildFinalAggregateProjections) and must agree with the ungrouped one.
		expect(await columnNames("SELECT a, * FROM nk GROUP BY a, b")).to.deep.equal(['a', 'a:1', 'b']);
		expect(await columnNames("SELECT upper(b) u, * FROM nk GROUP BY a, b")).to.deep.equal(['u', 'a', 'b']);
		expect(await columnNames("SELECT a, *, count(*) c FROM nk GROUP BY a, b")).to.deep.equal(['a', 'a:1', 'b', 'c']);
	});

	it('grouped and ungrouped agree when an alias collides with a star column', async () => {
		// `b as a` puts a *different* value under the star's own column name, so
		// which occurrence keeps the bare name and which gets `:1` is decided by
		// assembly order alone — the case a row-value comparison cannot see.
		const expected = ['a', 'a:1', 'b'];
		expect(await columnNames("SELECT b AS a, * FROM nk")).to.deep.equal(expected);
		expect(await columnNames("SELECT b AS a, * FROM nk GROUP BY a, b")).to.deep.equal(expected);
	});

	it('two stars keep their positions around an interleaved named column', async () => {
		expect(await columnNames("SELECT *, a AS mid, * FROM nk")).to.deep.equal(['a', 'b', 'mid', 'a:1', 'b:1']);
	});

	it('ORDER BY ordinal position agrees with the star-expanded output position', async () => {
		// Position 3 is `b` in written order (a, then the star's a, then the star's
		// b) — before the fix the assembled output disagreed with this even though
		// the ordinal itself always resolved against the written list.
		// NOTE: this pins the output *shape* only. Which column an ordinal actually
		// sorts by is a separate, still-open defect when a select-list alias shadows
		// the target column's name — see fix/bug-order-by-ordinal-resolves-to-shadowing-alias.
		expect(await columnNames("SELECT a, * FROM t1 ORDER BY 3")).to.deep.equal(['a', 'a:1', 'b']);
	});
});
