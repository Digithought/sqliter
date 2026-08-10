import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { Statement } from '../../src/core/statement.js';
import { CountingMemoryModule } from './_counting-memory-module.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import type { MemoryTable } from '../../src/vtab/memory/table.js';
import type { MemoryTableConfig } from '../../src/vtab/memory/types.js';
import type { TableSchema } from '../../src/schema/table.js';
import type { FilterInfo } from '../../src/vtab/filter-info.js';
import type { Row } from '../../src/common/types.js';
import { QuereusError } from '../../src/common/errors.js';
import { StatusCode } from '../../src/common/types.js';

/**
 * MemoryTableModule whose scans yield every real row and then throw — but only
 * once `armed` is set. Arming after the seed INSERTs keeps table setup working
 * and confines the failure to the CTE's source drive at eval time, so a test can
 * assert emitCTE surfaces a source error through the shared materialization
 * buffer (and does not leak an unhandled rejection from the detached drive).
 */
class ThrowingMemoryModule extends MemoryTableModule {
	armed = false;

	private wrap(table: MemoryTable): MemoryTable {
		const isArmed = () => this.armed;
		const original = table.query.bind(table);
		table.query = (filterInfo: FilterInfo): AsyncIterable<Row> => {
			const source = original(filterInfo);
			return (async function* () {
				for await (const row of source) yield row;
				if (isArmed()) throw new QuereusError('boom during CTE source drive', StatusCode.INTERNAL);
			})();
		};
		return table;
	}

	override async create(db: Database, tableSchema: TableSchema): Promise<MemoryTable> {
		return this.wrap(await super.create(db, tableSchema));
	}

	override async connect(
		db: Database,
		pAux: unknown,
		moduleName: string,
		schemaName: string,
		tableName: string,
		options: MemoryTableConfig,
		tableSchema?: TableSchema,
	): Promise<MemoryTable> {
		return this.wrap(await super.connect(db, pAux, moduleName, schemaName, tableName, options, tableSchema));
	}
}

/**
 * Runtime execution-count checks for shared CTE materialization.
 *
 * A non-recursive CTE referenced more than once is marked `materialize` by the
 * materialization-advisory pass; emitCTE then buffers its rows once per
 * statement execution and every reference reads that one buffer. Before the
 * fix, each CTE reference compiled and drove its own copy of the source
 * subtree — `with x as (...) ... from x a join x b` ran the source twice.
 */
describe('CTE shared materialization: scan count', () => {
	let db: Database;
	let module: CountingMemoryModule;

	beforeEach(async () => {
		db = new Database();
		module = new CountingMemoryModule();
		db.registerModule('countmem', module);
		await db.exec("CREATE TABLE counting (id INTEGER PRIMARY KEY, val INTEGER) USING countmem()");
		await db.exec("INSERT INTO counting VALUES (1, 10), (2, 20), (3, 30), (4, 40)");
	});

	afterEach(async () => {
		await db.close();
	});

	async function allRows<T>(sql: string): Promise<T[]> {
		const rows: T[] = [];
		for await (const r of db.eval(sql)) rows.push(r as T);
		return rows;
	}

	const MULTI_REF = `
		WITH cte AS (SELECT id, val FROM counting)
		SELECT c1.id AS id, c2.val AS val
		FROM cte c1 JOIN cte c2 ON c1.id = c2.id
	`;

	it('scans the source exactly once for a CTE joined to itself', async () => {
		module.scanCounts.clear();
		for await (const _ of db.eval(MULTI_REF)) { void _; }
		expect(module.scanCounts.get('counting'),
			'both CTE references must share one materialized buffer, not re-drive the source'
		).to.equal(1);
	});

	it('produces correct rows for the self-joined CTE', async () => {
		const rows = await allRows<{ id: number; val: number }>(MULTI_REF + ' ORDER BY c1.id');
		expect(rows).to.deep.equal([
			{ id: 1, val: 10 },
			{ id: 2, val: 20 },
			{ id: 3, val: 30 },
			{ id: 4, val: 40 },
		]);
	});

	it('does not fully drain a single-reference streaming CTE under LIMIT 1', async () => {
		const total = 200;
		const values: string[] = [];
		for (let i = 5; i < 5 + total; i++) values.push(`(${i}, ${i * 10})`);
		await db.exec(`INSERT INTO counting VALUES ${values.join(', ')}`);

		module.rowCounts.clear();
		const rows = await allRows<{ id: number; val: number }>(
			'WITH big AS (SELECT id, val FROM counting) SELECT * FROM big LIMIT 1'
		);
		expect(rows).to.have.lengthOf(1);

		// Single-reference, un-hinted CTE keeps the streaming path: LIMIT 1 must
		// pull only a handful of rows, never the whole table. (A blanket
		// materialization here would drain all 204 rows.)
		const pulled = module.rowCounts.get('counting') ?? 0;
		expect(pulled, 'single-ref CTE under LIMIT 1 must stream, not materialize').to.be.lessThan(total / 2);
	});

	it('re-materializes per execution of a prepared statement (no stale replay)', async () => {
		const stmt: Statement = db.prepare(MULTI_REF + ' ORDER BY c1.id');
		try {
			module.scanCounts.clear();
			const run1: Record<string, unknown>[] = [];
			for await (const row of stmt.all()) run1.push(row);
			expect(run1).to.have.lengthOf(4);
			expect(module.scanCounts.get('counting'), 'first execution scans once').to.equal(1);

			await db.exec('INSERT INTO counting VALUES (5, 50)');

			module.scanCounts.clear();
			const run2: Record<string, unknown>[] = [];
			for await (const row of stmt.all()) run2.push(row);
			// Second execution reflects the mutation — the buffer is per
			// RuntimeContext, so it cannot replay run 1's rows...
			expect(run2).to.have.lengthOf(5);
			expect(run2[4]).to.deep.equal({ id: 5, val: 50 });
			// ...and still scans exactly once (fresh materialization, not zero).
			expect(module.scanCounts.get('counting'), 'second execution re-drives the source once').to.equal(1);
		} finally {
			await stmt.finalize();
		}
	});

	it('propagates a source error from the shared materialization drive', async () => {
		// A 2-reference (materialized) CTE whose source throws mid-drive must
		// surface the error to the consumer — not silently yield an empty buffer —
		// and the detached drive's rejection must be observed (no unhandled
		// rejection). Exercises emitCTE's pre-attached .catch + await propagation.
		const tdb = new Database();
		const tmod = new ThrowingMemoryModule();
		tdb.registerModule('throwmem', tmod);
		await tdb.exec("CREATE TABLE boom (id INTEGER PRIMARY KEY, val INTEGER) USING throwmem()");
		await tdb.exec("INSERT INTO boom VALUES (1, 10), (2, 20)");
		tmod.armed = true;

		let caught: unknown;
		try {
			for await (const _ of tdb.eval(`
				WITH cte AS (SELECT id, val FROM boom)
				SELECT c1.id, c2.val FROM cte c1 JOIN cte c2 ON c1.id = c2.id
			`)) { void _; }
		} catch (e) {
			caught = e;
		}
		expect(caught, 'source error must propagate through the shared buffer').to.be.instanceOf(QuereusError);
		await tdb.close();
	});
});
