import { expect } from 'chai';
import { Database } from '../src/index.js';

/**
 * MV-over-MV cascade chain oracle (materialized-view-rowtime-mv-over-mv-cascade).
 *
 * A chain `mv1 over t`, `mv2 over mv1`, `mv3 over mv2` must, after EVERY source
 * mutation, satisfy `read(mvN backing) == evaluate(body transitively against t)`
 * for every level — and revert as a unit on ROLLBACK. The bodies are covering-index
 * shapes (`mv1` filters `x > 0`; `mv2`/`mv3` are passthroughs), so the fully-evaluated
 * chain collapses to `t`'s `x > 0` rows projected to `(id, x)`. The oracle is the live
 * re-evaluation of that body against the actual source table — independent of the
 * cascade-maintained backings under test.
 *
 * This is the standalone chain oracle the ticket names; when the substrate
 * equivalence harness (`incremental-maintenance-plan-abstraction`) lands, fold these
 * chain assertions into it. The op sequence is driven by a seeded LCG so a failure is
 * reproducible.
 */
describe('Materialized view MV-over-MV cascade — chain oracle', () => {
	let db: Database;
	beforeEach(async () => {
		db = new Database();
		await db.exec(`
			create table t (id integer primary key, x integer);
			create materialized view mv1 as select id, x from t where x > 0;
			create materialized view mv2 as select id, x from mv1;
			create materialized view mv3 as select id, x from mv2;
		`);
	});
	afterEach(async () => { await db.close(); });

	async function read(sql: string): Promise<Array<{ id: number; x: number }>> {
		const rows: Array<{ id: number; x: number }> = [];
		for await (const row of db.eval(sql)) {
			rows.push({ id: Number(row.id), x: Number(row.x) });
		}
		return rows;
	}

	/** read(MV_backing) == evaluate(body against t) for every level in the chain. */
	async function assertChainConsistent(context: string): Promise<void> {
		const oracle = await read('select id, x from t where x > 0 order by id');
		for (const mv of ['mv1', 'mv2', 'mv3']) {
			const actual = await read(`select id, x from ${mv} order by id`);
			expect(actual, `${context}: ${mv} must equal evaluate(body against t)`).to.deep.equal(oracle);
		}
	}

	// Deterministic LCG so the random op sequence is reproducible.
	function makeRng(seed: number): () => number {
		let s = seed >>> 0;
		return () => {
			s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
			return s / 0x100000000;
		};
	}

	it('every level tracks a randomized insert/update/delete sequence on the source', async () => {
		const rng = makeRng(0xC0FFEE);
		const live = new Set<number>(); // source ids currently present
		let nextId = 1;

		for (let step = 0; step < 120; step++) {
			const roll = rng();
			if (roll < 0.45 || live.size === 0) {
				// insert a fresh id with x in [-4, 5] (so ~half cross the x>0 predicate)
				const id = nextId++;
				const x = Math.floor(rng() * 10) - 4;
				await db.exec(`insert into t values (${id}, ${x});`);
				live.add(id);
			} else if (roll < 0.75) {
				// update an existing id's projected/predicate column
				const id = [...live][Math.floor(rng() * live.size)];
				const x = Math.floor(rng() * 10) - 4;
				await db.exec(`update t set x = ${x} where id = ${id};`);
			} else {
				// delete an existing id
				const id = [...live][Math.floor(rng() * live.size)];
				await db.exec(`delete from t where id = ${id};`);
				live.delete(id);
			}
			await assertChainConsistent(`step ${step}`);
		}
	});

	it('a transaction of cascade writes is visible mid-statement and reverts the whole chain on rollback', async () => {
		// Seed a committed baseline.
		await db.exec('insert into t values (1, 1), (2, 2), (3, -3);');
		await assertChainConsistent('baseline');
		const baseline = await read('select id, x from mv3 order by id');

		await db.exec('begin;');
		await db.exec('insert into t values (4, 4);');
		await db.exec('update t set x = 9 where id = 3;'); // -3 → 9 enters scope at every level
		await db.exec('delete from t where id = 1;');
		// Mid-transaction: every level already reflects the uncommitted cascade writes.
		await assertChainConsistent('mid-transaction');
		await db.exec('rollback;');

		// The whole chain reverted in lockstep with the source.
		await assertChainConsistent('after rollback');
		expect(await read('select id, x from mv3 order by id'), 'mv3 restored to baseline').to.deep.equal(baseline);
	});
});
