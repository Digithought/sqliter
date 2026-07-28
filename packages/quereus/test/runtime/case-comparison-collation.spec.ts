import { expect } from 'chai';
import { Database } from '../../src/index.js';
import type { SqlValue } from '../../src/common/types.js';

/**
 * Simple-CASE comparison collation (runtime/emit/case.ts + emit/operand-comparator.ts).
 *
 * `case x when v` decides its match exactly as `x = v` does, resolved per WHEN clause
 * through the shared provenance lattice. The SQL-observable behavior is pinned in
 * test/logic/06.4.2-collation-extras.sqllogic; this suite covers the two surfaces a
 * .sqllogic file cannot reach:
 *
 *  1. The instruction `note` — an `explain`-style program dump must show which
 *     collation each WHEN clause compares under, so a silent regression to raw-byte
 *     comparison is visible in the program listing, not only in query results.
 *  2. Bound parameters as an operand — an untyped parameter contributes no collation,
 *     so the column's declared collation must win from either side.
 */
describe('simple CASE comparison collation', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec(`create table cc (id integer primary key, n text collate nocase, m text)`);
		await db.exec(`insert into cc values (1, 'bob', 'bob')`);
	});

	afterEach(async () => {
		await db.close();
	});

	function programOf(sql: string): string {
		const stmt = db.prepare(sql);
		try {
			return stmt.getDebugProgram();
		} finally {
			void stmt.finalize();
		}
	}

	async function collect(sql: string, params?: SqlValue[]): Promise<Array<Record<string, SqlValue>>> {
		const rows: Array<Record<string, SqlValue>> = [];
		for await (const r of db.eval(sql, params)) rows.push(r);
		return rows;
	}

	describe('instruction note reports the per-clause collation', () => {
		it('a single non-BINARY clause names its collation', () => {
			expect(programOf(`select case n when 'A' then 1 end as r from cc`))
				.to.contain('case(short-circuit, 1 when clauses) NOCASE');
		});

		it('an all-BINARY CASE carries no suffix', () => {
			const prog = programOf(`select case m when 'A' then 1 end as r from cc`);
			expect(prog).to.contain('case(short-circuit, 1 when clauses)');
			expect(prog, 'BINARY is the floor — not worth the noise').to.not.contain('BINARY');
		});

		it('clauses that resolve differently are listed in clause order', () => {
			expect(programOf(`select case n when 'A' then 1 when 'B' collate binary then 2 end as r from cc`))
				.to.contain('case(short-circuit, 2 when clauses) NOCASE/BINARY');
		});

		it('a searched CASE compares nothing and carries no suffix', () => {
			// The inner `n = 'A'` still reports its own NOCASE, so look at the CASE
			// instruction alone rather than the whole program.
			const prog = programOf(`select case when n = 'A' then 1 end as r from cc`);
			expect(prog).to.match(/case\(short-circuit, 1 when clauses\)(?! NOCASE)/);
		});

		it('BETWEEN keeps its own two-bound note through the shared formatter', () => {
			expect(programOf(`select id from cc where n between 'a' and 'c' collate binary`))
				.to.contain('BETWEEN NOCASE/BINARY');
		});
	});

	describe('bound parameters contribute no collation', () => {
		it('a parameter base compares under the WHEN column collation', async () => {
			expect(await collect(`select case ? when n then 'hit' else 'miss' end as r from cc`, ['BOB']))
				.to.deep.equal([{ r: 'hit' }]);
		});

		it('a parameter WHEN compares under the base column collation', async () => {
			expect(await collect(`select case n when ? then 'hit' else 'miss' end as r from cc`, ['BOB']))
				.to.deep.equal([{ r: 'hit' }]);
		});

		it('a parameter on both sides of a BINARY column stays case-sensitive', async () => {
			expect(await collect(`select case m when ? then 'hit' else 'miss' end as r from cc`, ['BOB']))
				.to.deep.equal([{ r: 'miss' }]);
		});
	});
});
