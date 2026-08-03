/**
 * Runtime behaviour of the KeySetSemiJoin node (rule-key-set-seek).
 *
 * These tests observe the target table's `query()` calls — how often it is
 * opened, which `idxStr` it receives (a `plan=5` multi-seek when pushing, the
 * plan-time every-row walk when scanning), and how many rows are pulled — via
 * an instrumented memory module. The break-even suite doctors the module's
 * costs so the rule's interpolated seek-vs-scan threshold lands on a small,
 * exactly-known key count, then asserts the two paths are observationally
 * identical either side of it.
 */

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { Statement } from '../../src/core/statement.js';
import type { TableSchema } from '../../src/schema/table.js';
import type { MemoryTable } from '../../src/vtab/memory/table.js';
import type { MemoryTableConfig } from '../../src/vtab/memory/types.js';
import type { FilterInfo } from '../../src/vtab/filter-info.js';
import type { Row } from '../../src/common/types.js';
import type { BestAccessPlanRequest, BestAccessPlanResult } from '../../src/vtab/best-access-plan.js';
import type { PlanNode } from '../../src/planner/nodes/plan-node.js';
import { isAbortError } from '../../src/common/errors.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import { CountingMemoryModule } from './_counting-memory-module.js';

/**
 * CountingMemoryModule that additionally records every `idxStr` handed to each
 * table's `query()`, keyed by lowercased table name — the observable seek/scan
 * decision.
 */
class IdxStrCapturingModule extends CountingMemoryModule {
	readonly idxStrs = new Map<string, string[]>();

	private capture(table: MemoryTable): MemoryTable {
		const key = table.tableName.toLowerCase();
		const strs = this.idxStrs;
		const original = table.query.bind(table);
		table.query = (filterInfo: FilterInfo): AsyncIterable<Row> => {
			const list = strs.get(key) ?? [];
			list.push(filterInfo.idxStr ?? '');
			strs.set(key, list);
			return original(filterInfo);
		};
		return table;
	}

	override async create(db: Database, tableSchema: TableSchema): Promise<MemoryTable> {
		return this.capture(await super.create(db, tableSchema));
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
		return this.capture(await super.connect(db, pAux, moduleName, schemaName, tableName, options, tableSchema));
	}

	reset(): void {
		this.scanCounts.clear();
		this.rowCounts.clear();
		this.idxStrs.clear();
	}
}

/**
 * Memory module whose costs for the `big` table are doctored so the rule's
 * three probes interpolate to an exactly-known break-even:
 *
 *   runtime-set probe: cost = 1 + 10·maxCount  →  costA(2) = 21, costB(1000) = 10001
 *   scan probe:        cost = 71
 *   slope = (10001 − 21) / 998 = 10
 *   breakEvenKeys = floor(2 + (71 − 21) / 10) = 7
 *
 * Only the costs are patched; the claim (index, seek columns) is the real
 * module's answer, so the runtime path is unchanged.
 */
class BreakEvenModule extends IdxStrCapturingModule {
	override getBestAccessPlan(
		db: Database,
		tableInfo: TableSchema,
		request: BestAccessPlanRequest,
	): BestAccessPlanResult {
		const plan = MemoryTableModule.prototype.getBestAccessPlan.call(this, db, tableInfo, request) as BestAccessPlanResult;
		if (tableInfo.name.toLowerCase() !== 'big') return plan;
		const runtimeSet = request.filters.find(f => f.runtimeSet)?.runtimeSet;
		if (runtimeSet) return { ...plan, cost: 1 + 10 * runtimeSet.maxCount };
		if (request.filters.length === 0) return { ...plan, cost: 71 };
		return plan;
	}
}

/**
 * Cost-model variants of {@link BreakEvenModule} that pin the two interpolation
 * arms the linear fit takes outside the ordinary "seek gets dearer with keys"
 * case. `flat` keeps the runtime-set cost independent of key count (slope ≤ 0 ⇒
 * a seek never loses, so the engine ceiling becomes the threshold); `scan-wins`
 * keeps the seek cost rising but prices the plain scan below even a two-key seek
 * (break-even interpolates below 1 ⇒ the rule must decline outright and leave
 * the hash semi join).
 */
class CostArmModule extends IdxStrCapturingModule {
	constructor(private readonly arm: 'flat' | 'scan-wins') {
		super();
	}

	override getBestAccessPlan(
		db: Database,
		tableInfo: TableSchema,
		request: BestAccessPlanRequest,
	): BestAccessPlanResult {
		const plan = MemoryTableModule.prototype.getBestAccessPlan.call(this, db, tableInfo, request) as BestAccessPlanResult;
		if (tableInfo.name.toLowerCase() !== 'big') return plan;
		const runtimeSet = request.filters.find(f => f.runtimeSet)?.runtimeSet;
		if (this.arm === 'flat') {
			if (runtimeSet) return { ...plan, cost: 50 };
			if (request.filters.length === 0) return { ...plan, cost: 1000 };
			return plan;
		}
		if (runtimeSet) return { ...plan, cost: 500 + runtimeSet.maxCount };
		if (request.filters.length === 0) return { ...plan, cost: 1 };
		return plan;
	}
}

/** Memory module that answers the engine's synthesized runtime-set probe with a
 *  self-contradictory plan (it claims to have handled a filter it was never
 *  given), which `validateAccessPlan` rejects. */
class InvalidProbeModule extends IdxStrCapturingModule {
	override getBestAccessPlan(
		db: Database,
		tableInfo: TableSchema,
		request: BestAccessPlanRequest,
	): BestAccessPlanResult {
		const plan = MemoryTableModule.prototype.getBestAccessPlan.call(this, db, tableInfo, request) as BestAccessPlanResult;
		if (tableInfo.name.toLowerCase() !== 'big' || !request.filters.some(f => f.runtimeSet)) return plan;
		return { ...plan, handledFilters: [...plan.handledFilters, true] };
	}
}

const MULTI_SEEK_RE = /^idx=idx_v\(0\);plan=5;inCount=(\d+)$/;

async function allRows<T>(db: Database, sql: string): Promise<T[]> {
	const rows: T[] = [];
	for await (const r of db.eval(sql)) rows.push(r as T);
	return rows;
}

/** Every node type in a plan tree, for shape assertions that need no node identity. */
function collectNodeTypes(root: PlanNode): string[] {
	const types: string[] = [root.nodeType];
	for (const child of root.getChildren()) types.push(...collectNodeTypes(child as PlanNode));
	return types;
}

describe('KeySetSemiJoin runtime', () => {
	describe('seek path (instrumented memory module)', () => {
		let db: Database;
		let module: IdxStrCapturingModule;

		beforeEach(async () => {
			db = new Database();
			module = new IdxStrCapturingModule();
			db.registerModule('countmem', module);
			await db.exec('create table small (id integer primary key, k integer null) using countmem()');
			await db.exec('create table big (pk integer primary key, v integer null) using countmem()');
			await db.exec('create index idx_v on big(v)');
			const values = Array.from({ length: 40 }, (_v, i) => `(${i + 1}, ${(i + 1) * 10})`).join(', ');
			await db.exec(`insert into big values ${values}`);
		});

		afterEach(async () => {
			await db.close();
		});

		function bigIdxStrs(): string[] {
			return module.idxStrs.get('big') ?? [];
		}

		it('pushes a plan=5 multi-seek and pulls only the matching rows', async () => {
			await db.exec('insert into small values (1, 100), (2, 300), (3, 555)');
			module.reset();
			const rows = await allRows<{ pk: number }>(db,
				'select pk from big where v in (select k from small)');
			expect(rows).to.deep.equal([{ pk: 10 }, { pk: 30 }]);

			expect(module.scanCounts.get('small'), 'key source drained exactly once').to.equal(1);
			expect(module.scanCounts.get('big'), 'target opened exactly once').to.equal(1);
			const idxStr = bigIdxStrs()[0];
			expect(idxStr, 'target received a multi-seek').to.match(MULTI_SEEK_RE);
			expect(idxStr).to.contain('inCount=3');
			// The seek returns only the (up to) 3 matching windows — never the
			// whole 40-row table.
			expect(module.rowCounts.get('big') ?? 0, 'only matching rows pulled').to.be.at.most(3);
		});

		it('collapses duplicate inner values: inCount reflects the distinct count, rows emit once', async () => {
			await db.exec('insert into small values (1, 100), (2, 100), (3, 300), (4, 100)');
			module.reset();
			const rows = await allRows<{ pk: number }>(db,
				'select pk from big where v in (select k from small)');
			expect(rows, 'each target row at most once').to.deep.equal([{ pk: 10 }, { pk: 30 }]);
			expect(bigIdxStrs()[0]).to.contain('inCount=2');
		});

		it('skips inner NULLs; rows matching the non-NULL values still return', async () => {
			await db.exec('insert into small values (1, null), (2, 200), (3, null)');
			module.reset();
			const rows = await allRows<{ pk: number }>(db,
				'select pk from big where v in (select k from small)');
			expect(rows).to.deep.equal([{ pk: 20 }]);
			expect(bigIdxStrs()[0]).to.contain('inCount=1');
		});

		it('never opens the target when the inner is empty', async () => {
			module.reset();
			const rows = await allRows(db, 'select pk from big where v in (select k from small)');
			expect(rows).to.deep.equal([]);
			expect(module.scanCounts.get('big'), 'target query() never called').to.equal(undefined);
		});

		it('never opens the target when the inner is all NULLs', async () => {
			await db.exec('insert into small values (1, null), (2, null)');
			module.reset();
			const rows = await allRows(db, 'select pk from big where v in (select k from small)');
			expect(rows).to.deep.equal([]);
			expect(module.scanCounts.get('big'), 'target query() never called').to.equal(undefined);
		});

		it('NULL target values never match', async () => {
			await db.exec('insert into big values (100, null)');
			await db.exec('insert into small values (1, 100)');
			module.reset();
			const rows = await allRows<{ pk: number }>(db,
				'select pk from big where v in (select k from small)');
			expect(rows).to.deep.equal([{ pk: 10 }]);
		});

		it('falls back to the plan-time walk above RUNTIME_SET_MAX_KEYS and stays correct', async () => {
			// 1001 distinct keys — over the engine ceiling, so the runtime must
			// scan; the probe still filters correctly.
			const values = Array.from({ length: 1001 }, (_v, i) => `(${i + 1}, ${i + 1})`).join(', ');
			await db.exec(`insert into small values ${values}`);
			module.reset();
			const rows = await allRows<{ pk: number }>(db,
				'select pk from big where v in (select k from small)');
			// v = 10·pk ≤ 1001 ⇒ pk ≤ 100 — all 40 rows with v in 10..400 match.
			expect(rows).to.have.lengthOf(40);
			const idxStr = bigIdxStrs()[0];
			expect(idxStr, 'no multi-seek above the ceiling').to.not.match(MULTI_SEEK_RE);
		});

		it('a LIMIT above the node stops the target early', async () => {
			await db.exec('insert into small values (1, 100), (2, 300), (3, 200)');
			module.reset();
			const rows = await allRows(db, 'select pk from big where v in (select k from small) limit 1');
			expect(rows).to.have.lengthOf(1);
			expect(module.rowCounts.get('big') ?? 0, 'not every window drained').to.be.at.most(2);
		});

		it('re-executing a prepared statement re-drains the key source and rebuilds the set', async () => {
			await db.exec('insert into small values (1, 100)');
			const stmt: Statement = db.prepare('select pk from big where v in (select k from small)');
			try {
				module.reset();
				const run1: Record<string, unknown>[] = [];
				for await (const row of stmt.all()) run1.push(row);
				expect(run1).to.deep.equal([{ pk: 10 }]);
				expect(module.scanCounts.get('small'), 'first run drains once').to.equal(1);

				await db.exec('insert into small values (2, 400)');
				module.reset();
				const run2: Record<string, unknown>[] = [];
				for await (const row of stmt.all()) run2.push(row);
				expect(run2, 'second run sees the new inner data').to.deep.equal([{ pk: 10 }, { pk: 40 }]);
				expect(module.scanCounts.get('small'), 'second run re-drains once').to.equal(1);
			} finally {
				await stmt.finalize();
			}
		});

		it('self-referencing delete drains the key set before touching the target', async () => {
			// The key source is a snapshot: rows deleted from `big` must not
			// shrink the set mid-flight. v ≤ 200 selects pk 1..20.
			await db.exec('delete from big where v in (select v from big where v <= 200)');
			const rows = await allRows<{ c: number }>(db, 'select count(*) as c from big');
			expect(rows).to.deep.equal([{ c: 20 }]);
		});

		it('trims index over-fetch under a coarser (NOCASE) index with a BINARY join', async () => {
			// The only index on `s` is NOCASE while the join comparison is BINARY
			// (both columns default BINARY): the seek may return case variants,
			// and the probe must drop them. Exact rows, not just counts.
			await db.exec('create table ct (pk integer primary key, s text) using countmem()');
			await db.exec('create index idx_ci on ct(s collate nocase)');
			await db.exec("insert into ct values (1, 'alpha'), (2, 'ALPHA'), (3, 'beta')");
			await db.exec('create table csrc (id integer primary key, s text) using countmem()');
			await db.exec("insert into csrc values (1, 'alpha')");
			module.reset();
			const rows = await allRows<{ pk: number }>(db,
				'select pk from ct where s in (select s from csrc)');
			expect(rows, 'the case variant the index over-fetched is trimmed').to.deep.equal([{ pk: 1 }]);
			expect((module.idxStrs.get('ct') ?? [])[0], 'the coarser index was seeked (probe did the trimming)')
				.to.match(/^idx=idx_ci\(0\);plan=5;inCount=1$/);
		});

		it('an abort during the drain never opens the target', async () => {
			await db.exec('insert into small values (1, 100), (2, 300)');
			module.reset();
			const controller = new AbortController();
			controller.abort();
			let caught: unknown;
			try {
				for await (const _row of db.eval(
					'select pk from big where v in (select k from small)', [], { signal: controller.signal })) {
					// unreachable — the abort fires before the key set is built
				}
			} catch (e) {
				caught = e;
			}
			expect(isAbortError(caught), 'the abort surfaces as an AbortError').to.equal(true);
			expect(module.scanCounts.get('big'), 'target query() never called').to.equal(undefined);
		});
	});

	describe('merge-arm primary-key seek (key-set-seek-merge)', () => {
		// `pk in (select id from small)` walks both sides in primary-key order, so
		// it plans as a MERGE semi join and reaches the KeySetSemiJoin through the
		// merge anchor. The node claims the walk's own order
		// (seekPreservesTargetOrder), so the emitted rows must be in ascending pk
		// order on BOTH runtime branches — asserted directly, not sorted in JS.
		let db: Database;
		let module: IdxStrCapturingModule;

		const PRIMARY_MULTI_SEEK_RE = /^idx=_primary_\(0\);plan=5;inCount=(\d+)$/;

		beforeEach(async () => {
			db = new Database();
			module = new IdxStrCapturingModule();
			db.registerModule('countmem', module);
			await db.exec('create table small (id integer primary key) using countmem()');
			await db.exec('create table big (pk integer primary key, v integer null) using countmem()');
			const values = Array.from({ length: 40 }, (_v, i) => `(${i + 1}, ${(i + 1) * 10})`).join(', ');
			await db.exec(`insert into big values ${values}`);
		});

		afterEach(async () => {
			await db.close();
		});

		it('pushes a _primary_ multi-seek, pulls only K rows, and emits them ascending', async () => {
			// Inserted out of pk order: the seek keys are sorted before stamping.
			await db.exec('insert into small values (30), (7), (18)');
			module.reset();
			const rows = await allRows<{ pk: number }>(db,
				'select pk from big where pk in (select id from small)');
			expect(rows, 'ascending pk order — the ordering claim, observed').to.deep.equal(
				[{ pk: 7 }, { pk: 18 }, { pk: 30 }]);
			const idxStr = (module.idxStrs.get('big') ?? [])[0];
			expect(idxStr, 'the primary key was multi-seeked').to.match(PRIMARY_MULTI_SEEK_RE);
			expect(idxStr).to.contain('inCount=3');
			expect(module.rowCounts.get('big') ?? 0, 'only the matching rows pulled').to.be.at.most(3);
		});

		it('serves an absorbed ORDER BY pk through the seek', async () => {
			await db.exec('insert into small values (25), (3), (11)');
			module.reset();
			const rows = await allRows<{ pk: number }>(db,
				'select pk from big where pk in (select id from small) order by pk');
			expect(rows).to.deep.equal([{ pk: 3 }, { pk: 11 }, { pk: 25 }]);
			expect((module.idxStrs.get('big') ?? [])[0],
				'the ORDER BY did not force a scan — the claim serves it').to.match(PRIMARY_MULTI_SEEK_RE);
		});

		it('deletes exactly the matching rows through the seek, and RETURNING works', async () => {
			await db.exec('insert into small values (5), (12)');
			module.reset();
			const returned = await allRows<{ pk: number }>(db,
				'delete from big where pk in (select id from small) returning pk');
			expect(returned).to.deep.equal([{ pk: 5 }, { pk: 12 }]);
			expect((module.idxStrs.get('big') ?? [])[0], 'the delete read was a multi-seek')
				.to.match(PRIMARY_MULTI_SEEK_RE);
			const remaining = await allRows<{ c: number }>(db, 'select count(*) as c from big');
			expect(remaining).to.deep.equal([{ c: 38 }]);
		});

		it('falls back to the ordered walk above the ceiling and still emits ascending', async () => {
			// 1001 distinct keys — over RUNTIME_SET_MAX_KEYS, so the runtime scans.
			// The ordering claim must hold on THIS branch too.
			const values = Array.from({ length: 1001 }, (_v, i) => `(${i + 1})`).join(', ');
			await db.exec(`insert into small values ${values}`);
			module.reset();
			const rows = await allRows<{ pk: number }>(db,
				'select pk from big where pk in (select id from small)');
			expect(rows.map(r => r.pk), 'all 40 match, ascending').to.deep.equal(
				Array.from({ length: 40 }, (_v, i) => i + 1));
			expect((module.idxStrs.get('big') ?? [])[0], 'no multi-seek above the ceiling')
				.to.not.match(PRIMARY_MULTI_SEEK_RE);
		});
	});

	describe('descending seek index', () => {
		it('seeks a DESC index and returns the matching rows', async () => {
			const db = new Database();
			const module = new IdxStrCapturingModule();
			db.registerModule('countmem', module);
			try {
				await db.exec('create table small (id integer primary key, k integer null) using countmem()');
				await db.exec('create table big (pk integer primary key, v integer null) using countmem()');
				// The seek keys are emitted in the index's own (descending) key order.
				await db.exec('create index idx_v on big(v desc)');
				await db.exec('insert into big values (1, 10), (2, 20), (3, 30), (4, 40)');
				await db.exec('insert into small values (1, 30), (2, 10), (3, 40)');
				module.reset();
				// No ORDER BY: an absorbed sort would mark the leaf's emission order
				// load-bearing and the rule would (correctly) decline.
				const rows = await allRows<{ pk: number }>(db,
					'select pk from big where v in (select k from small)');
				expect(rows.map(r => r.pk).sort((a, b) => a - b)).to.deep.equal([1, 3, 4]);
				expect((module.idxStrs.get('big') ?? [])[0], 'the DESC index was seeked')
					.to.match(/^idx=idx_v\(0\);plan=5;inCount=3$/);
			} finally {
				await db.close();
			}
		});
	});

	describe('cost-model arms', () => {
		async function setup(module: IdxStrCapturingModule, keyCount: number): Promise<Database> {
			const db = new Database();
			db.registerModule('armmem', module);
			await db.exec('create table small (id integer primary key, k integer null) using armmem()');
			await db.exec('create table big (pk integer primary key, v integer null) using armmem()');
			await db.exec('create index idx_v on big(v)');
			await db.exec(`insert into big values ${
				Array.from({ length: 30 }, (_v, i) => `(${i + 1}, ${(i + 1) * 10})`).join(', ')}`);
			await db.exec(`insert into small values ${
				Array.from({ length: keyCount }, (_v, i) => `(${i + 1}, ${(i + 1) * 10})`).join(', ')}`);
			module.reset();
			return db;
		}

		it('a key-count-independent seek cost (slope <= 0) seeks up to the engine ceiling', async () => {
			const module = new CostArmModule('flat');
			const db = await setup(module, 20);
			try {
				const rows = await allRows(db, 'select pk from big where v in (select k from small)');
				expect(rows).to.have.lengthOf(20);
				// A flat cost never overtakes the scan, so 20 keys — far past the
				// interpolated break-even of any rising curve — still seeks.
				expect((module.idxStrs.get('big') ?? [])[0]).to.match(MULTI_SEEK_RE);
			} finally {
				await db.close();
			}
		});

		it('a scan cheaper than a two-key seek declines the rewrite entirely', async () => {
			const module = new CostArmModule('scan-wins');
			const db = await setup(module, 3);
			try {
				const sql = 'select pk from big where v in (select k from small)';
				const plan = db.getPlan(sql);
				expect(collectNodeTypes(plan), 'no KeySetSemiJoin — the hash semi join survives')
					.to.not.include('KeySetSemiJoin');
				expect(collectNodeTypes(plan)).to.include('HashJoin');
				expect(await allRows(db, sql), 'the surviving hash join still answers').to.have.lengthOf(3);
			} finally {
				await db.close();
			}
		});

		it('declines when the module answers a synthesized probe with an invalid plan', async () => {
			const module = new InvalidProbeModule();
			const db = await setup(module, 3);
			try {
				const sql = 'select pk from big where v in (select k from small)';
				// The rule must swallow the module's contract violation and leave the
				// hash semi join — not fail a query the user's predicate ran fine on.
				expect(collectNodeTypes(db.getPlan(sql))).to.not.include('KeySetSemiJoin');
				expect(await allRows(db, sql)).to.have.lengthOf(3);
			} finally {
				await db.close();
			}
		});
	});

	describe('break-even from doctored module costs', () => {
		let db: Database;
		let module: BreakEvenModule;

		beforeEach(async () => {
			db = new Database();
			module = new BreakEvenModule();
			db.registerModule('bemem', module);
			await db.exec('create table small (id integer primary key, k integer null) using bemem()');
			await db.exec('create table big (pk integer primary key, v integer null) using bemem()');
			await db.exec('create index idx_v on big(v)');
			const values = Array.from({ length: 30 }, (_v, i) => `(${i + 1}, ${(i + 1) * 10})`).join(', ');
			await db.exec(`insert into big values ${values}`);
		});

		afterEach(async () => {
			await db.close();
		});

		async function runWithDistinctKeys(count: number): Promise<{ rows: unknown[]; idxStr: string }> {
			await db.exec('delete from small');
			const values = Array.from({ length: count }, (_v, i) => `(${i + 1}, ${(i + 1) * 10})`).join(', ');
			await db.exec(`insert into small values ${values}`);
			module.reset();
			const rows = await allRows(db, 'select pk from big where v in (select k from small)');
			return { rows, idxStr: (module.idxStrs.get('big') ?? [])[0] ?? '' };
		}

		it('exactly breakEvenKeys keys pushes; one more scans; both return the same rows', async () => {
			// costA=21 @2 keys, costB=10001 @1000, scan=71 ⇒ slope 10, breakEven 7.
			const at = await runWithDistinctKeys(7);
			expect(at.idxStr, '7 keys — at the break-even — seeks').to.match(MULTI_SEEK_RE);
			expect(at.idxStr).to.contain('inCount=7');

			const over = await runWithDistinctKeys(8);
			expect(over.idxStr, '8 keys — over the break-even — scans').to.not.match(MULTI_SEEK_RE);

			// The two paths must be observationally identical: 8 keys returns the
			// 7-key rows plus the 8th match.
			expect(at.rows).to.deep.equal(
				Array.from({ length: 7 }, (_v, i) => ({ pk: i + 1 })));
			expect(over.rows).to.deep.equal(
				Array.from({ length: 8 }, (_v, i) => ({ pk: i + 1 })));
		});
	});
});
