/**
 * Recognition + cost-gate tests for `ruleFanOutBatchedOuter` — the PostOptimization
 * rule that flips an already-formed `FanOutLookupJoinNode` from the default
 * `serial` outer mode to `batched` (cross-row pipelined).
 *
 * Two cost surfaces drive the rule (both inert on memory-vtab plans):
 *   - `physical.expectedLatencyMs` on the slowest branch (non-zero only via the
 *     synthetic `HighLatencyMemoryModule`), and
 *   - `physical.estimatedRows` on the outer (unknown until ANALYZE runs — the
 *     gate refuses on a missing statistic, so the fixture analyzes its tables),
 *     gated by `tuning.parallel.batchedOuterMinRows` — overridden to 0 in the
 *     firing tests so the small synthetic fixture clears it.
 *
 * The fan-out must *form* first (its own Structural cost gate), so these tests
 * reuse the same `concurrency`-lowering trick as `parallel-fanout.spec.ts`.
 */
import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import type { VtabConcurrencyMode } from '../../src/vtab/module.js';
import type { SqlValue } from '../../src/common/types.js';

interface PlanRow {
	node_type: string;
	op: string;
	detail: string;
	properties: string | null;
	physical: string | null;
}

class HighLatencyMemoryModule extends MemoryTableModule {
	readonly expectedLatencyMs = 25;
}

/**
 * A memory module whose declared concurrency mode is `'serial'`, so its leaf
 * resolves `physical.concurrencySafe === false` (see `getModuleConcurrencyMode`).
 * `concurrencyMode` is narrowed to a literal on `MemoryTableModule`, so the
 * override is applied at construction via a `readonly`-stripping cast rather
 * than a field initializer.
 */
function makeSerialMemoryModule(): MemoryTableModule {
	const mod = new MemoryTableModule();
	(mod as { concurrencyMode: VtabConcurrencyMode }).concurrencyMode = 'serial';
	return mod;
}

async function planRows(db: Database, sql: string): Promise<PlanRow[]> {
	const rows: PlanRow[] = [];
	for await (const r of db.eval(
		'SELECT node_type, op, detail, properties, physical FROM query_plan(?)',
		[sql],
	)) {
		rows.push(r as unknown as PlanRow);
	}
	return rows;
}

async function results(db: Database, sql: string): Promise<Record<string, SqlValue>[]> {
	const out: Record<string, SqlValue>[] = [];
	for await (const r of db.eval(sql)) out.push(r);
	return out;
}

function fanOutRow(rows: readonly PlanRow[]): PlanRow | undefined {
	return rows.find(r => r.op === 'FANOUTLOOKUPJOIN' || r.node_type === 'FanOutLookupJoin');
}

function hasFanOut(rows: readonly PlanRow[]): boolean {
	return fanOutRow(rows) !== undefined;
}

/** Outer mode parsed from the fan-out node's logical properties. */
function fanOutOuterMode(rows: readonly PlanRow[]): string | undefined {
	const fo = fanOutRow(rows);
	if (!fo || !fo.properties) return undefined;
	const props = JSON.parse(fo.properties) as { outerMode?: string };
	return props.outerMode;
}

function hasEagerPrefetch(rows: readonly PlanRow[]): boolean {
	return rows.some(r => r.op === 'EAGERPREFETCH' || r.node_type === 'EagerPrefetch');
}

// Executing a fan-out under an ORDER BY trips the documented Sort/Project-above-
// fan-out strict-fork false-positive (see parallel-fanout.spec.ts) — skip the
// execution paths under strict-fork; the non-strict run validates correctness.
const strictFork = typeof process !== 'undefined' && (process.env?.QUEREUS_FORK_STRICT === '1' || process.env?.QUEREUS_FORK_STRICT === 'true');
const forkExecTest = strictFork ? it.skip : it;

describe('ruleFanOutBatchedOuter', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		db.registerModule('hi_lat_memory', new HighLatencyMemoryModule());
		// Lower the per-row cap so a 3-branch chain surfaces a positive *formation*
		// cost gate, and drop batchedOuterMinRows to 0 so the small synthetic
		// outer (3 analyzed rows) clears the cardinality gate. Both are restored
		// per-test where a gate is being exercised.
		const before = db.optimizer.tuning;
		db.optimizer.updateTuning({
			...before,
			parallel: { ...before.parallel, concurrency: 2, batchedOuterMinRows: 0 },
		});
	});

	afterEach(async () => {
		await db.close();
	});

	async function setup3Branches(
		using_lookup: 'memory' | 'hi_lat_memory',
		outerModule = 'memory',
	): Promise<void> {
		await db.exec(`create table cust (id integer primary key, name text) using ${using_lookup}`);
		await db.exec(`create table prod (id integer primary key, sku text) using ${using_lookup}`);
		await db.exec(`create table region (id integer primary key, label text) using ${using_lookup}`);
		await db.exec(
			`create table orders (
				order_id integer primary key,
				customer_id integer not null references cust(id),
				product_id integer not null references prod(id),
				region_id integer not null references region(id),
				total real
			) using ${outerModule}`,
		);
		await db.exec("insert into cust values (1, 'Acme'), (2, 'Beta')");
		await db.exec("insert into prod values (10, 'SKU-A'), (20, 'SKU-B')");
		await db.exec("insert into region values (100, 'EU'), (200, 'US')");
		await db.exec(`insert into orders values
			(1, 1, 10, 100, 99.0),
			(2, 2, 20, 200, 49.5),
			(3, 1, 20, 100, 12.0)`);
		// The batched flip's cardinality gate refuses on an unknown outer estimate
		// (a never-analyzed table has no row count), so measure the fixture.
		for (const t of ['orders', 'cust', 'prod', 'region']) {
			await db.exec(`analyze ${t}`);
		}
	}

	const fanout3SQL =
		`select o.order_id, c.name, p.sku, r.label
		 from orders o
		 left join cust c on o.customer_id = c.id
		 left join prod p on o.product_id = p.id
		 left join region r on o.region_id = r.id`;

	it('flips to batched when budget is under-saturated, branches high-latency, and outer cardinality clears the gate', async () => {
		await setup3Branches('hi_lat_memory');
		const plan = await planRows(db, fanout3SQL);
		expect(hasFanOut(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
		expect(fanOutOuterMode(plan)).to.equal('batched');
		// Batched implies prefetch: the outer is wrapped in EagerPrefetch for
		// isolation + read-ahead feed.
		expect(hasEagerPrefetch(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
	});

	it('leaves the node serial on local-only (memory) plans — no fan-out even forms', async () => {
		// expectedLatencyMs = 0 throughout, so the *formation* rule never clusters;
		// nothing for the batched rule to flip.
		await setup3Branches('memory');
		const plan = await planRows(db, fanout3SQL);
		expect(hasFanOut(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
	});

	it('does NOT flip when the slowest branch latency is below batchedOuterThresholdMs', async () => {
		// Raise the batched threshold above the fixture's 25 ms: the fan-out still
		// *forms* (its formation gate only needs latency > 0), but the batched gate
		// rejects, so the node stays serial.
		await setup3Branches('hi_lat_memory');
		const before = db.optimizer.tuning;
		db.optimizer.updateTuning({
			...before,
			parallel: { ...before.parallel, batchedOuterThresholdMs: 100 },
		});
		try {
			const plan = await planRows(db, fanout3SQL);
			expect(hasFanOut(plan)).to.equal(true);
			expect(fanOutOuterMode(plan)).to.equal('serial');
			expect(hasEagerPrefetch(plan)).to.equal(false);
		} finally {
			db.optimizer.updateTuning(before);
		}
	});

	it('does NOT flip when branchCount >= outerBatchConcurrency (budget already saturated per row)', async () => {
		await setup3Branches('hi_lat_memory');
		const before = db.optimizer.tuning;
		// 3 branches, global budget 3 → one row already fills it; cross-row
		// admission buys nothing.
		db.optimizer.updateTuning({
			...before,
			parallel: { ...before.parallel, outerBatchConcurrency: 3 },
		});
		try {
			const plan = await planRows(db, fanout3SQL);
			expect(hasFanOut(plan)).to.equal(true);
			expect(fanOutOuterMode(plan)).to.equal('serial');
		} finally {
			db.optimizer.updateTuning(before);
		}
	});

	it('does NOT flip when the outer is not concurrency-safe', async () => {
		// The batched driver pumps the outer concurrently with live branch forks,
		// so an outer over a `'serial'`-mode module can never be flipped — this is
		// the gate the EagerPrefetch-isolation rationale rests on. Latency,
		// cardinality (minRows=0 from beforeEach), and budget all pass here; only
		// the concurrency gate should hold the node serial.
		db.registerModule('serial_memory', makeSerialMemoryModule());
		await setup3Branches('hi_lat_memory', 'serial_memory');
		const plan = await planRows(db, fanout3SQL);
		expect(hasFanOut(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
		expect(fanOutOuterMode(plan)).to.equal('serial');
		expect(hasEagerPrefetch(plan)).to.equal(false);
	});

	it('does NOT flip when outer cardinality is below batchedOuterMinRows', async () => {
		await setup3Branches('hi_lat_memory');
		const before = db.optimizer.tuning;
		// Restore a positive minimum; the analyzed synthetic outer measures 3 rows,
		// which is below it.
		db.optimizer.updateTuning({
			...before,
			parallel: { ...before.parallel, batchedOuterMinRows: 256 },
		});
		try {
			const plan = await planRows(db, fanout3SQL);
			expect(hasFanOut(plan)).to.equal(true);
			expect(fanOutOuterMode(plan)).to.equal('serial');
		} finally {
			db.optimizer.updateTuning(before);
		}
	});

	it('honors disabledRules and leaves the fan-out serial', async () => {
		await setup3Branches('hi_lat_memory');
		const before = db.optimizer.tuning;
		db.optimizer.updateTuning({
			...before,
			disabledRules: new Set(['fanout-batched-outer']),
		});
		try {
			const plan = await planRows(db, fanout3SQL);
			expect(hasFanOut(plan)).to.equal(true);
			expect(fanOutOuterMode(plan)).to.equal('serial');
			expect(hasEagerPrefetch(plan)).to.equal(false);
		} finally {
			db.optimizer.updateTuning(before);
		}
	});

	forkExecTest('batched output equals the serial baseline (execution equivalence over a real outer plan)', async () => {
		await setup3Branches('hi_lat_memory');
		const batchedPlan = await planRows(db, fanout3SQL);
		expect(fanOutOuterMode(batchedPlan), 'rule must flip for the comparison').to.equal('batched');
		const batched = await results(db, fanout3SQL + ' order by o.order_id');

		// Disable the batched flip → serial baseline (fan-out still forms).
		const before = db.optimizer.tuning;
		db.optimizer.updateTuning({
			...before,
			disabledRules: new Set(['fanout-batched-outer']),
		});
		let serial: Record<string, SqlValue>[];
		try {
			const serialPlan = await planRows(db, fanout3SQL);
			expect(fanOutOuterMode(serialPlan)).to.equal('serial');
			serial = await results(db, fanout3SQL + ' order by o.order_id');
		} finally {
			db.optimizer.updateTuning(before);
		}

		expect(batched).to.deep.equal(serial);
		expect(batched.map(r => r.order_id)).to.deep.equal([1, 2, 3]);
		expect(batched.map(r => r.name)).to.deep.equal(['Acme', 'Beta', 'Acme']);
		expect(batched.map(r => r.sku)).to.deep.equal(['SKU-A', 'SKU-B', 'SKU-B']);
		expect(batched.map(r => r.label)).to.deep.equal(['EU', 'US', 'EU']);
	});

	// ----------------------------------------------------------------------
	// Cross branches: a node carrying any `cross` branch is owned by the
	// batched cross-mode follow-up; this rule leaves it serial.
	// ----------------------------------------------------------------------
	describe('cross-branch clusters are left serial (deferred to cross-mode ticket)', () => {
		beforeEach(() => {
			const before = db.optimizer.tuning;
			// A 2-branch cross cluster needs cap=1 to clear its formation gate.
			db.optimizer.updateTuning({
				...before,
				parallel: { ...before.parallel, concurrency: 1, batchedOuterMinRows: 0 },
			});
		});

		async function setupCross(): Promise<void> {
			await db.exec(`create table p (id integer primary key, label text) using memory`);
			await db.exec(`create table b0 (id integer primary key, pid integer, v integer) using hi_lat_memory`);
			await db.exec(`create table b1 (id integer primary key, pid integer, w integer) using hi_lat_memory`);
			await db.exec("insert into p values (1, 'one'), (2, 'two')");
			await db.exec('insert into b0 values (10, 1, 100), (11, 1, 101), (12, 2, 200)');
			await db.exec('insert into b1 values (20, 1, 5), (21, 2, 6)');
			// The cross-branch formation guard (`crossGuardsPass`) refuses to
			// cluster on unknown row estimates — measure the fixture first.
			for (const t of ['p', 'b0', 'b1']) await db.exec(`analyze ${t}`);
		}

		const crossSQL =
			`select p.id, b0.v, b1.w
			 from p
			 join b0 on p.id = b0.pid
			 join b1 on p.id = b1.pid`;

		it('does NOT flip a cross-branch fan-out to batched', async () => {
			await setupCross();
			const plan = await planRows(db, crossSQL);
			expect(hasFanOut(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
			expect(fanOutOuterMode(plan)).to.equal('serial');
			expect(hasEagerPrefetch(plan)).to.equal(false);
		});
	});
});
