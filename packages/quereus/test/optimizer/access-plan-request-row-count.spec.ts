/**
 * What the planner puts in `BestAccessPlanRequest.estimatedRows`.
 *
 * The field is documented as "the planner's hint, populated only from `ANALYZE`-collected
 * statistics; `undefined` means unknown" — the cue for a module that can size itself to
 * substitute its own count. Two of the five sites that build a request did not honor it:
 * `rule-grow-retrieve` sent `tableRef.estimatedRows || context.stats.tableRows(schema) || 1000`,
 * so a never-analyzed table arrived as a fabricated `1000` that no module could tell apart
 * from a real 1000-row `ANALYZE` result. Two consequences, both closed here:
 *
 *  - a self-sizing backend was locked out — `quereus-store`'s `sizeRequestFromLiveCount`
 *    returned early on every call, because the request always carried a number;
 *  - the same table was priced two ways in one plan — `rule-grow-retrieve` said 1000 while
 *    `rule-select-access-path` said unknown, and the optimizer then compared the answers.
 *
 * `context.stats.tableRows()` is not consulted at those sites any more. It reads the same
 * catalog row count `TableReferenceNode.estimatedRows` does and then falls back to
 * `NaiveStatsProvider`'s fixed 1000 — a naive default dressed up as a measurement, which is
 * exactly what this change exists to stop. The module's own default is the sole fallback now.
 *
 * Three spellings must stay distinct all the way to the module: `undefined` (nobody
 * measured), `0` (measured, and empty), and `n > 0` (measured). The `||` spellings at the
 * remaining sites collapsed `0` into the next fallback and are now `??`.
 *
 * The memory backend keeps no live row count, so nothing here may change what it plans —
 * `two un-analyzed tables of very different sizes` pins that directly, and the full suite
 * pins it broadly.
 */

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import type { TableSchema } from '../../src/schema/table.js';
import type { BestAccessPlanRequest, BestAccessPlanResult } from '../../src/vtab/best-access-plan.js';

/** Every `estimatedRows` the planner sent, with the table it was about. */
interface Ask {
	readonly table: string;
	readonly estimatedRows: number | undefined;
}

/** A memory module that records what the planner asks it, then answers normally. */
class RecordingMemoryModule extends MemoryTableModule {
	readonly asks: Ask[] = [];

	override getBestAccessPlan(
		db: Database,
		tableInfo: TableSchema,
		request: BestAccessPlanRequest,
	): BestAccessPlanResult {
		this.asks.push({ table: tableInfo.name.toLowerCase(), estimatedRows: request.estimatedRows });
		return super.getBestAccessPlan(db, tableInfo, request);
	}

	/** What was asked about `table` since the last `reset()`, in order. */
	forTable(table: string): Array<number | undefined> {
		return this.asks.filter(a => a.table === table).map(a => a.estimatedRows);
	}

	reset(): void {
		this.asks.length = 0;
	}
}

/** `query_plan()` rows for `sql`, as `{op, detail, est_cost}` records. */
async function planRows(db: Database, sql: string): Promise<Array<Record<string, unknown>>> {
	const out: Array<Record<string, unknown>> = [];
	for await (const row of db.eval('select op, detail, est_cost from query_plan(?)', [sql])) {
		out.push(row as unknown as Record<string, unknown>);
	}
	return out;
}

describe('BestAccessPlanRequest.estimatedRows', () => {
	let db: Database;
	let mod: RecordingMemoryModule;

	beforeEach(async () => {
		db = new Database();
		mod = new RecordingMemoryModule();
		db.registerModule('recording', mod);
	});

	afterEach(async () => {
		await db.close();
	});

	/** `n` rows into a fresh `t(id, v, w)` with a secondary index on `v`. */
	const seed = async (n: number, name = 't'): Promise<void> => {
		await db.exec(`create table ${name} (id integer primary key, v integer, w text) using recording`);
		await db.exec(`create index ix_${name}_v on ${name}(v)`);
		if (n > 0) {
			const values = Array.from({ length: n }, (_, i) => `(${i + 1}, ${(i + 1) * 10}, 'w${i % 4}')`);
			await db.exec(`insert into ${name} values ${values.join(', ')}`);
		}
	};

	describe('a never-analyzed table', () => {
		/**
		 * Every request shape the planner builds, in one place. `rule-grow-retrieve` has two
		 * (the filter/limit arm and the sort-absorption arm), `rule-select-access-path` one,
		 * and `buildProbeRequest` is reached from `index-nested-loop` and `rule-key-set-seek`.
		 * A plain `select *` exercises none of the constraint arms, so it is included too.
		 */
		const shapes: Array<[string, string]> = [
			['whole-table read', 'select id from t'],
			['filter (grow-retrieve, filter arm)', 'select id from t where v > 100'],
			['filter + order by (grow-retrieve, sort arm)', 'select id from t where v > 100 order by v'],
			['limit (grow-retrieve, sort arm with a bound)', 'select id from t order by v limit 5'],
			['join (index-nested-loop probe)', 'select t.id from t join u on t.v = u.v'],
			['in (select …) (key-set-seek probe)', 'select id from t where v in (select v from u)'],
		];

		for (const [label, sql] of shapes) {
			it(`sends undefined, not a placeholder — ${label}`, async () => {
				await seed(137);
				await seed(9, 'u');
				mod.reset();

				await planRows(db, sql);

				const asked = mod.asks;
				expect(asked, 'the planner asked the module at least once').to.not.be.empty;
				expect(asked.map(a => a.estimatedRows),
					'a never-analyzed table must arrive as unknown, never as 1000 and never as 0')
					.to.deep.equal(asked.map(() => undefined));
			});
		}

		it('leaves the module free to answer with a size of its own', async () => {
			// The memory backend has no live count, so its own `?? 1000` default answers —
			// unchanged behavior, and the whole point of leaving module-side defaults alone.
			await seed(137);
			mod.reset();
			await planRows(db, 'select id from t where v > 100');
			expect(mod.forTable('t').every(e => e === undefined)).to.equal(true);
		});
	});

	describe('an ANALYZEd table', () => {
		it('sends the measured count', async () => {
			await seed(137);
			await db.exec('analyze t');
			mod.reset();

			await planRows(db, 'select id from t where v > 100');

			expect(mod.forTable('t'), 'every site agrees on the one measured number')
				.to.deep.equal(mod.forTable('t').map(() => 137));
			expect(mod.forTable('t')[0]).to.equal(137);
		});

		it('sends a measured 0 as 0 — not as unknown, and not as the module default', async () => {
			// This is what the `||` → `??` change buys: `0` is a measurement ("analyzed, and
			// empty"), and a module is entitled to price against it. `||` swallowed it into
			// whatever fallback came next.
			await seed(0, 'e');
			await db.exec('analyze e');
			mod.reset();

			await planRows(db, `select id from e where v > 100`);

			const asked = mod.forTable('e');
			expect(asked, 'the planner asked about the empty table').to.not.be.empty;
			expect(asked).to.deep.equal(asked.map(() => 0));
		});

		it('agrees across every request site in one plan', async () => {
			// The defect this closes: `rule-grow-retrieve` said 1000 while
			// `rule-select-access-path` said unknown, and the optimizer compared the two
			// answers as if they described the same table.
			await seed(212);
			await seed(37, 'u');
			await db.exec('analyze t');
			await db.exec('analyze u');
			mod.reset();

			await planRows(db, 'select t.id from t join u on t.v = u.v where t.v > 100 order by t.v');

			expect(new Set(mod.forTable('t')), 'one answer for t').to.deep.equal(new Set([212]));
			expect(new Set(mod.forTable('u')), 'one answer for u').to.deep.equal(new Set([37]));
		});
	});

	describe('the memory backend is unaffected', () => {
		it('prices two un-analyzed tables of very different sizes identically', async () => {
			// The memory module cannot size itself, so its `?? 1000` default answers for both.
			// If a real size ever leaked into the request from the planner, these would differ
			// — which is the regression this whole ticket must NOT cause on this backend.
			await seed(6, 'tiny');
			await seed(4000, 'huge');

			const costOf = async (name: string): Promise<unknown> => {
				const rows = await planRows(db, `select id from ${name} where v > 50`);
				const leaf = rows.find(r => String(r.op).includes('INDEX') || String(r.op) === 'SEQSCAN');
				expect(leaf, `a table access for ${name}`).to.not.be.undefined;
				return leaf!.est_cost;
			};

			expect(await costOf('tiny')).to.equal(await costOf('huge'));
		});
	});
});
