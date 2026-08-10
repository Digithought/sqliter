/**
 * A data-modifying CTE's once-per-execution buffer must reset **between** executions
 * (runtime/emit/cte.ts + runtime/types.ts).
 *
 * `emitCTE` buffers a materialized CTE's rows in `RuntimeContext.cteMaterializations`,
 * keyed by the CTE's `tableDescriptor`. The descriptor is a plan-level identity that
 * outlives a single run, so a prepared statement re-executed N times reuses the SAME
 * key — only the fresh `RuntimeContext` per execution keeps run 2 from replaying run
 * 1's rows and skipping its write. `test/logic/13.6-cte-dml-runs-once.sqllogic` covers
 * the within-one-execution half; sqllogic cannot re-run one prepared statement, so
 * this spec covers the across-executions half.
 *
 * A stale buffer here would be silent: every run would return plausible, identical
 * rows while only the first run actually wrote — the same failure shape as
 * `bug-cache-node-stale-across-statement-executions`.
 */

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { SqlValue } from '../../src/common/types.js';

async function collect(iter: AsyncIterable<Record<string, SqlValue>>): Promise<Record<string, SqlValue>[]> {
	const out: Record<string, SqlValue>[] = [];
	for await (const row of iter) out.push(row);
	return out;
}

describe('data-modifying CTE: the shared buffer resets between executions', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table t (k integer primary key, v integer)');
		await db.exec('insert into t values (1, 0)');
	});

	afterEach(async () => { await db.close(); });

	it('a doubly-referenced UPDATE body writes once per execution, on every execution', async () => {
		const stmt = db.prepare(
			'with c as (update t set v = v + 1 returning k, v) ' +
			'select (select count(*) from c) as a, (select count(*) from c) as b'
		);
		try {
			for (let run = 1; run <= 3; run++) {
				expect(await collect(stmt.all()), `run ${run} row set`).to.deep.equal([{ a: 1, b: 1 }]);
				expect(await collect(db.eval('select v from t')), `state after run ${run}`)
					.to.deep.equal([{ v: run }]);
			}
		} finally {
			await stmt.finalize();
		}
	});

	it('a doubly-referenced INSERT body re-runs its write, so the second execution conflicts', async () => {
		// The write really is re-attempted rather than replayed from a stale buffer:
		// the duplicate key on run 2 is the observable proof.
		const stmt = db.prepare(
			'with c as (insert into t (k, v) values (2, 0) returning k) ' +
			'select (select count(*) from c) as a, (select count(*) from c) as b'
		);
		try {
			expect(await collect(stmt.all()), 'run 1 row set').to.deep.equal([{ a: 1, b: 1 }]);
			let message = 'no error';
			try {
				await collect(stmt.all());
			} catch (e) {
				message = (e as Error).message;
			}
			expect(message, 'run 2 must re-attempt the write').to.match(/UNIQUE constraint failed/);
		} finally {
			await stmt.finalize();
		}
	});
});
