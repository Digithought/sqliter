/**
 * A never-analyzed store table is planned against the size it actually is.
 *
 * `store-row-count-to-planner` taught `StoreModule` to fill an absent
 * `request.estimatedRows` from its own maintained row count
 * (`sizeRequestFromLiveCount`), and `store-row-count-to-planner.spec.ts` pins that
 * function by calling `getBestAccessPlan` directly. It could never fire through a real
 * query, though: `rule-grow-retrieve` sent `… || context.stats.tableRows(schema) || 1000`,
 * so the request always carried a number and the module returned early every time.
 *
 * Every planner site now sends `undefined` for a table nobody has analyzed. This file
 * drives that end to end — through `db.eval`, not through a hand-built request — and pins
 * what it does and does not change.
 *
 * The engine half of the contract (which spelling each site sends, and that a measured `0`
 * survives) lives in `packages/quereus/test/optimizer/access-plan-request-row-count.spec.ts`.
 * What is store-specific, and lives here:
 *
 *  - the live count actually reaches the module through a real query, so two un-analyzed
 *    tables of different sizes no longer price identically;
 *  - the count includes the open transaction's buffered writes, so a statement reading what
 *    its own transaction just wrote is costed against the size it will really see;
 *  - `ANALYZE` still wins over the live count, because the rest of the plan was costed from
 *    the same catalog snapshot.
 *
 * **What this does NOT change, deliberately: which plan an un-analyzed range query gets.**
 * See the `plan shape` block — the seek-versus-scan veto is scale-invariant while the
 * estimate is a shape constant, so a bigger honest number moves every cost and no verdict.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, asyncIterableToArray } from '@quereus/quereus';
import type {
	BestAccessPlanRequest,
	BestAccessPlanResult,
	SqlValue,
	TableSchema,
} from '@quereus/quereus';
import { StoreModule, InMemoryKVStore, type KVCostProfile, type KVStoreProvider } from '../src/index.js';

/**
 * The cost profile measured for IndexedDB (`store-backend-cost-profile`): a random point
 * read costs 3× a sequentially-read row. The profile that most sharpens the seek-versus-scan
 * comparison, and therefore the one to plan the "does the verdict move?" tests against.
 */
const INDEXEDDB_COST_PROFILE: KVCostProfile = { pointRead: 3.0, seekPositioning: 0.5 };

/** An in-memory provider declaring `costProfile` (or nothing, when omitted). */
function createInMemoryProvider(costProfile?: KVCostProfile): KVStoreProvider {
	const stores = new Map<string, InMemoryKVStore>();
	const get = (key: string): InMemoryKVStore => {
		let s = stores.get(key);
		if (!s) { s = new InMemoryKVStore(); stores.set(key, s); }
		return s;
	};
	return {
		...(costProfile ? { costProfile } : {}),
		async getStore(schemaName, tableName) { return get(`${schemaName}.${tableName}`); },
		async getIndexStore(schemaName, tableName, indexName) { return get(`${schemaName}.${tableName}_idx_${indexName}`); },
		async getStatsStore(schemaName, tableName) { return get(`${schemaName}.${tableName}.__stats__`); },
		async getCatalogStore() { return get('__catalog__'); },
		async closeStore() {},
		async closeIndexStore() {},
		async closeAll() { for (const s of stores.values()) await s.close(); stores.clear(); },
	};
}

/** What the planner asked, and what the module answered, for one `getBestAccessPlan` call. */
interface Exchange {
	readonly table: string;
	/** `request.estimatedRows` — `undefined` is "nobody measured this table". */
	readonly asked: number | undefined;
	/** `result.rows` — after `sizeRequestFromLiveCount` had its chance. */
	readonly answered: number | undefined;
}

/** A `StoreModule` that records every access-plan exchange, then behaves normally. */
class RecordingStoreModule extends StoreModule {
	readonly exchanges: Exchange[] = [];

	override getBestAccessPlan(
		db: Database,
		tableInfo: TableSchema,
		request: BestAccessPlanRequest,
	): BestAccessPlanResult {
		const result = super.getBestAccessPlan(db, tableInfo, request);
		this.exchanges.push({
			table: tableInfo.name.toLowerCase(),
			asked: request.estimatedRows,
			answered: result.rows,
		});
		return result;
	}

	forTable(table: string): Exchange[] {
		return this.exchanges.filter(e => e.table === table);
	}

	reset(): void {
		this.exchanges.length = 0;
	}
}

describe('a store table is planned against its live row count', () => {
	let db: Database;
	let mod: RecordingStoreModule;

	const openWith = (profile?: KVCostProfile): void => {
		db = new Database();
		mod = new RecordingStoreModule(createInMemoryProvider(profile));
		db.registerModule('store', mod);
	};

	beforeEach(() => { openWith(); });
	afterEach(async () => { await db.close(); });

	const rows = (sql: string): Promise<Array<Record<string, SqlValue>>> =>
		asyncIterableToArray(db.eval(sql));

	/** `name(id, n)` with a secondary index on `n`, holding `count` rows. */
	const seed = async (name: string, count: number): Promise<void> => {
		await db.exec(`create table ${name} (id integer primary key, n integer) using store`);
		await db.exec(`create index ix_${name} on ${name}(n)`);
		if (count === 0) return;
		await db.exec('begin');
		for (let i = 1; i <= count; i++) await db.exec(`insert into ${name} values (${i}, ${i})`);
		await db.exec('commit');
	};

	/** Plan `sql` and hand back the table-access leaf's row from `query_plan()`. */
	const accessLeaf = async (sql: string): Promise<Record<string, SqlValue>> => {
		const plan = await asyncIterableToArray(db.eval(
			`select op, detail, est_cost from query_plan(?)`, [sql]));
		const leaf = (plan as Array<Record<string, SqlValue>>).find(
			r => String(r.op).includes('INDEX') || String(r.op) === 'SEQSCAN');
		expect(leaf, `a table access in the plan for ${sql}`).to.not.be.undefined;
		return leaf!;
	};

	describe('the request reaches the module as unknown, and the module fills it in', () => {
		it('answers a never-analyzed table with its real size, not the 1000-row placeholder', async () => {
			await seed('t', 137);
			mod.reset();

			await rows(`select id from t where n > 50`);

			const seen = mod.forTable('t');
			expect(seen, 'the planner asked the module').to.not.be.empty;
			for (const e of seen) {
				expect(e.asked, 'a never-analyzed table arrives as unknown').to.be.undefined;
			}
			// `sizeRequestFromLiveCount` supplied 137, so every arm the module advertises is a
			// fraction of 137. Under the old fabricated 1000 the same arms answered fractions
			// of 1000 — the range arm alone would claim 300 rows out of a 137-row table.
			const answered = seen.map(e => e.answered ?? 0);
			expect(Math.max(...answered), 'no arm claims more rows than the table holds').to.be.at.most(137);
			expect(Math.max(...answered), 'and some arm was sized from it').to.be.greaterThan(0);

			// A whole-table read has no arm fraction in the way, so the module's answer IS the
			// size it was given: exactly the live count, not the 1000-row placeholder.
			mod.reset();
			await rows(`select id from t`);
			expect(mod.forTable('t').map(e => e.answered)).to.include(137);
		});

		it('prices two un-analyzed tables of different sizes differently', async () => {
			// The regression in one line. Before this change both requests carried the same
			// fabricated 1000 and both leaves costed identically, whatever the tables held.
			openWith(INDEXEDDB_COST_PROFILE);
			await seed('small', 40);
			await seed('large', 4000);

			const smallCost = Number((await accessLeaf(`select id from small where n > 5`)).est_cost);
			const largeCost = Number((await accessLeaf(`select id from large where n > 5`)).est_cost);

			expect(smallCost).to.be.lessThan(largeCost);
			// 100× the rows, so ~100× the cost: the leaf is priced from the size, not a constant.
			expect(largeCost / smallCost).to.be.greaterThan(50);
		});

		it('counts what the open transaction has written but not yet committed', async () => {
			// `getKnownRowCount()` includes the transaction's buffered delta, so a statement
			// reading what its own transaction just wrote is costed against the size it will
			// actually see rather than the size on disk.
			await seed('t', 5);
			await db.exec('begin');
			await db.exec(`insert into t values ${
				Array.from({ length: 95 }, (_, i) => `(${100 + i}, ${i})`).join(', ')}`);
			mod.reset();
			// A whole-table read, so the module's answer is the size it was handed, undiluted.
			await rows(`select id from t`);
			const inTransaction = mod.forTable('t');
			expect(inTransaction.map(e => e.asked), 'still un-analyzed, so still unknown')
				.to.deep.equal(inTransaction.map(() => undefined));
			expect(inTransaction.map(e => e.answered),
				'5 committed + 95 buffered = 100').to.include(100);

			await db.exec('rollback');
			mod.reset();
			await rows(`select id from t`);
			expect(mod.forTable('t').map(e => e.answered),
				'the rolled-back rows are gone from the estimate too').to.include(5);
		});

		it('defers to ANALYZE, which wins over the live count', async () => {
			// The engine-wide rule: join ordering, cache thresholds and sort costs all read the
			// same catalog snapshot, so an access path priced from a different figure would
			// disagree with the plan around it. The live count fills a GAP; it never overrides.
			await seed('t', 137);
			await db.exec('analyze t');
			await db.exec(`insert into t values (9001, 9001), (9002, 9002)`);
			mod.reset();

			await rows(`select id from t where n > 50`);

			const seen = mod.forTable('t');
			expect(seen.map(e => e.asked), 'the ANALYZE snapshot, stale by two rows and still authoritative')
				.to.deep.equal(seen.map(() => 137));
		});
	});

	describe('plan shape', () => {
		/**
		 * **Measured, and the opposite of what the ticket predicted.** Feeding the honest live
		 * count does NOT move an un-analyzed range query from a seek to a scan.
		 *
		 * The seek-versus-scan veto in `computeBestAccessPlan` compares the seek arm against a
		 * sequential scan. While the arm's estimate is an `ARM_SELECTIVITY` shape CONSTANT —
		 * which is what "un-analyzed" means — both sides of that comparison are the same linear
		 * function of `estimatedRows`, so the verdict is invariant under the table's size. The
		 * flip points are already spelled out at the top of `store-module-access-plan.ts`: the
		 * `range` arm costs `0.3·N·(0.5 + R)` against a scan's `N`, so with the veto judged at
		 * parity (`R = 1.0`, which is what an un-backed estimate means) it is `0.45·N < N` for
		 * every N — a seek, always. Only the price moves with the size.
		 *
		 * The discrimination the parent ticket measured (a range matching 55% of the rows
		 * flipping to a scan) needs `ANALYZE`: only a statistics-backed estimate is per-query,
		 * and only then is the veto judged at the backend's declared `pointRead` instead of at
		 * parity. So `ANALYZE` remains the thing that changes range plans; this ticket changes
		 * what they cost.
		 */
		it('does not move an un-analyzed range query, at either selectivity', async () => {
			openWith(INDEXEDDB_COST_PROFILE);
			const N = 2000;
			await seed('t', N);

			const wide = await accessLeaf(`select id from t where n > ${N * 0.45}`);   // ~55% of rows
			const narrow = await accessLeaf(`select id from t where n > ${N * 0.90}`); // ~10% of rows

			expect(String(wide.op), 'the 55% range keeps its seek without ANALYZE').to.contain('INDEXSEEK');
			expect(String(narrow.op), 'and so does the 10% range').to.contain('INDEXSEEK');
			// Un-analyzed, both are the same shape-constant arm, so they cost the same too.
			expect(Number(wide.est_cost)).to.equal(Number(narrow.est_cost));
		});

		it('ANALYZE is what discriminates the two — and it still does', async () => {
			openWith(INDEXEDDB_COST_PROFILE);
			const N = 2000;
			await seed('t', N);
			await db.exec('analyze t');

			const wide = await accessLeaf(`select id from t where n > ${N * 0.45}`);
			const narrow = await accessLeaf(`select id from t where n > ${N * 0.90}`);

			expect(String(wide.op), 'a 55% range is cheaper to scan on IndexedDB').to.contain('INDEXSCAN');
			expect(String(narrow.op), 'a 10% range is still worth seeking').to.contain('INDEXSEEK');
		});

		it('returns the same rows however it is planned', async () => {
			// The safety property behind every plan-shape claim above: an arm the veto drops
			// leaves its filters unclaimed, so the residual Filter survives and the row set is
			// identical. Asserted across the ANALYZE boundary that actually moves the plan.
			openWith(INDEXEDDB_COST_PROFILE);
			const N = 400;
			await seed('t', N);
			const q = `select id from t where n > ${N * 0.45} order by id`;
			const before = (await rows(q)).map(r => r.id);
			await db.exec('analyze t');
			const after = (await rows(q)).map(r => r.id);

			expect(before).to.have.lengthOf(Math.floor(N * 0.55));
			expect(after).to.deep.equal(before);
		});
	});

	describe('the key-set semi join merge gate', () => {
		/**
		 * `rule-key-set-seek` declines its rewrite when the key source's PHYSICAL row estimate
		 * exceeds the number of keys the runtime would seek with. It has never declined, and it
		 * still does not — but for a different reason than before, and one worth recording.
		 *
		 * Measured here: a 3000-row key source against a 200-row target with an advertised
		 * `breakEvenKeys` of 343, i.e. an estimate almost 9× over the threshold. The rewrite
		 * still fires, because the gate reads `node.right.physical.estimatedRows` and
		 * `IndexScanNode.computePhysical` relays `this.source.estimatedRows` — the CATALOG
		 * count, `undefined` on an un-analyzed table — rather than the module's own answer the
		 * way its sibling `IndexSeekNode` does. The live count this ticket unlocks reaches the
		 * module and is discarded again at the physical boundary. Filed as an arm on
		 * `debt-row-estimate-relay-has-no-guard`.
		 *
		 * Pinned as the observed behavior, not as desired behavior: when that relay is fixed,
		 * this test is the one that will say so, and the answer must not move either way.
		 */
		it('still proceeds on an un-analyzed key source, and returns the right rows', async () => {
			await db.exec(`create table big (pk integer primary key, v integer, w integer) using store`);
			await db.exec(`create index ix_v on big (v)`);
			await db.exec(`create table ksrc (id integer primary key, k integer null) using store`);
			await db.exec(`insert into big values ${
				Array.from({ length: 200 }, (_, i) => `(${i + 1}, ${(i + 1) * 10}, ${i + 1})`).join(', ')}`);
			await db.exec('begin');
			for (let i = 1; i <= 3000; i++) await db.exec(`insert into ksrc values (${i}, ${i * 10})`);
			await db.exec('commit');

			// No `order by`: an absorbed Sort over a SECONDARY-index target makes
			// `rule-key-set-seek` decline for an unrelated reason, which would mask the gate.
			// Rows are collected unordered and sorted here instead.
			const q = `select pk from big where v in (select k from ksrc)`;
			const ops = (await asyncIterableToArray(db.eval(
				`select json_group_array(op) as ops from query_plan(?)`, [q])))[0].ops as string;
			expect(ops, 'the rewrite fires: the gate saw no usable estimate to decline on')
				.to.contain('KEYSETSEMIJOIN');

			// Whichever way it is planned, every row of `big` matches a key in `ksrc`.
			const answer = (await rows(q)).map(r => r.pk as number).sort((a, b) => a - b);
			expect(answer).to.deep.equal(Array.from({ length: 200 }, (_, i) => i + 1));
		});
	});
});
