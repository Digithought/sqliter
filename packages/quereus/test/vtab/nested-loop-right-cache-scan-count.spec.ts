import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { CountingMemoryModule } from './_counting-memory-module.js';

/**
 * Runtime scan-count check for rule-nested-loop-right-cache.
 *
 * A left-driven nested-loop join re-opens the right pipeline once per left row
 * (emitLoopJoin.driveFromLeft). Without the cache, the right table's `query()`
 * is invoked once per left row → N full scans. With the CacheNode the rule
 * injects, the right side materializes on the first left row and every
 * subsequent left row replays the buffer → exactly one `query()` per table.
 *
 * The counting module tallies `query()` opens on every MemoryTable it hands
 * out. The assertion is robust to join-order choice: after the rule fires NO
 * table is scanned more than once, whichever side the optimizer picks as the
 * driver.
 */

describe('nested-loop right-side cache: scan count', () => {
	let db: Database;
	let module: CountingMemoryModule;

	beforeEach(async () => {
		db = new Database();
		module = new CountingMemoryModule();
		db.registerModule('countmem', module);
		await db.exec("CREATE TABLE l (id INTEGER PRIMARY KEY, v INTEGER) USING countmem()");
		await db.exec("CREATE TABLE r (id INTEGER PRIMARY KEY, v INTEGER) USING countmem()");
		// Left has several rows so an uncached right would be re-scanned per row.
		await db.exec("INSERT INTO l VALUES (1, 100), (2, 200), (3, 300), (4, 400), (5, 500)");
		await db.exec("INSERT INTO r VALUES (1, 10), (2, 20), (3, 30)");
	});

	afterEach(async () => {
		await db.close();
	});

	async function drain(sql: string): Promise<void> {
		for await (const _ of db.eval(sql)) { void _; }
	}

	it('scans the right table once under a left-driven theta join', async () => {
		module.scanCounts.clear();
		// Theta join stays a nested loop; the cache rule wraps the right side.
		await drain("SELECT l.v, r.v FROM l JOIN r ON l.v > r.v");

		// With the cache in place, neither side is scanned more than once,
		// regardless of which table the optimizer drives from.
		for (const [name, count] of module.scanCounts) {
			expect(count, `table ${name} should be scanned once, not per outer row`).to.equal(1);
		}
		// Sanity: both tables were actually touched.
		expect(module.scanCounts.get('l'), 'left table scanned').to.equal(1);
		expect(module.scanCounts.get('r'), 'right table scanned').to.equal(1);
	});

	it('produces correct rows under the theta join', async () => {
		const rows: { lv: number; rv: number }[] = [];
		for await (const row of db.eval(
			"SELECT l.v AS lv, r.v AS rv FROM l JOIN r ON l.v > r.v ORDER BY lv, rv")) {
			rows.push(row as { lv: number; rv: number });
		}
		// Every l.v (100..500) exceeds every r.v (10,20,30): 5 * 3 = 15 rows.
		expect(rows).to.have.lengthOf(15);
		expect(rows[0]).to.deep.equal({ lv: 100, rv: 10 });
	});
});
