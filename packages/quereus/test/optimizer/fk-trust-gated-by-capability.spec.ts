/**
 * Verifies the `permitsOrphanedForeignKeyRows` capability gate on the
 * planner's trust in declared foreign keys (invariant OPT-059; see
 * `planner/util/ind-utils.ts` and `vtab/capabilities.ts`).
 *
 * Default vtab modules leave the cap off: a declared FK is a hard inclusion
 * dependency (`child.fk ⊆ parent.pk`), so INNER join elimination, the
 * semi/anti-join FK folds, and IND seeding all fire — and, when the backend
 * actually holds an orphan (inserted here with `pragma foreign_keys = false`),
 * they return rows a real join would have dropped. Those wrong answers are
 * pinned below as the control. Modules that opt in (e.g. Lamina, whose
 * `ALTER TABLE … ADD CONSTRAINT` grandfathers orphans and whose replication
 * can delete parents out-of-band) suppress both producers of the existence
 * claim — `lookupCoveringFK` and `seedTableForeignKeyInds` — so every
 * consumer keeps the join and the orphan behaves like a real orphan.
 *
 * The at-most-one claim (`checkFkPkAlignment`) is deliberately NOT gated:
 * LEFT-join elimination and `atMostOne-left` fan-out must survive the cap
 * (the anti-over-suppression tests below).
 */

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import { TableReferenceNode } from '../../src/planner/nodes/reference.js';
import { GlobalScope } from '../../src/planner/scopes/global.js';
import type { ModuleCapabilities } from '../../src/vtab/capabilities.js';
import { lookupCoveringFK, seedTableForeignKeyInds } from '../../src/planner/util/ind-utils.js';
import type { TableSchema } from '../../src/schema/table.js';
import type { SqlValue } from '../../src/common/types.js';

type ResultRow = Record<string, SqlValue>;

interface PlanRow {
	node_type: string;
	op: string;
	detail: string;
	properties: string | null;
	physical: string | null;
}

const JOIN_OPS = new Set([
	'JOIN',
	'HASHJOIN',
	'MERGEJOIN',
	'NESTEDLOOPJOIN',
	'BLOOMJOIN',
	'ASOFSCAN',
]);

/** Test double: a memory module that permits orphaned FK rows. */
class OrphanMemoryModule extends MemoryTableModule {
	override getCapabilities(): ModuleCapabilities {
		return { ...super.getCapabilities(), permitsOrphanedForeignKeyRows: true };
	}
}

/** Orphan-permitting AND high-latency — for the fan-out clustering tests. */
class HighLatencyOrphanMemoryModule extends OrphanMemoryModule {
	readonly expectedLatencyMs = 25;
}

/** Plain high-latency control (mirrors parallel-fanout.spec.ts). */
class HighLatencyMemoryModule extends MemoryTableModule {
	readonly expectedLatencyMs = 25;
}

describe('FK trust gated by permitsOrphanedForeignKeyRows', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
		db.registerModule('orphanmem', new OrphanMemoryModule());
	});

	afterEach(async () => {
		await db.close();
	});

	async function planRows(sql: string): Promise<PlanRow[]> {
		const rows: PlanRow[] = [];
		for await (const r of db.eval(
			'SELECT node_type, op, detail, properties, physical FROM query_plan(?)',
			[sql],
		)) {
			rows.push(r as unknown as PlanRow);
		}
		return rows;
	}

	function joinCount(rows: readonly PlanRow[]): number {
		return rows.filter(r => JOIN_OPS.has(r.op)).length;
	}

	async function results(sql: string): Promise<ResultRow[]> {
		const rows: ResultRow[] = [];
		for await (const r of db.eval(sql)) rows.push(r);
		return rows;
	}

	/**
	 * The ticket's reproducer: parent with one row, child with a matched row (10)
	 * and an orphan (20 → pa=99, no parent). The orphan is inserted with
	 * enforcement off, then enforcement is restored — the exact "backend holds a
	 * row the FK never vouched for" state an orphan-permitting module can reach
	 * without any pragma games.
	 */
	async function setupParChi(childModuleName: string, parentModuleName = childModuleName): Promise<void> {
		await db.exec(`create table par (pid integer primary key) using ${parentModuleName}`);
		await db.exec(`create table chi (id integer primary key, pa integer not null references par(pid)) using ${childModuleName}`);
		await db.exec('insert into par values (1)');
		await db.exec('pragma foreign_keys = false');
		await db.exec('insert into chi values (10, 1)');
		await db.exec('insert into chi values (20, 99)');
		await db.exec('pragma foreign_keys = true');
	}

	const innerQ = 'select c.id from chi c join par p on c.pa = p.pid';
	const semiQ = 'select id from chi where exists (select 1 from par where par.pid = chi.pa)';
	const antiQ = 'select id from chi where not exists (select 1 from par where par.pid = chi.pa)';

	describe('INNER join elimination', () => {
		it('control (cap absent): join eliminated and the orphan leaks into the result', async () => {
			await setupParChi('memory');
			const rows = await planRows(innerQ);
			expect(joinCount(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(0);
			// Pinned wrong answer: a real join would drop id=20. This is today's
			// documented behavior for backends that cannot hold orphans — the cap
			// exists precisely for backends that can.
			const out = await results(innerQ + ' order by c.id');
			expect(out.map(r => r.id)).to.deep.equal([10, 20]);
		});

		it('cap on: join survives and the orphan is dropped', async () => {
			await setupParChi('orphanmem');
			const rows = await planRows(innerQ);
			expect(joinCount(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.be.greaterThan(0);
			const out = await results(innerQ + ' order by c.id');
			expect(out.map(r => r.id)).to.deep.equal([10]);
		});

		it('cap on, parent side only: still suppressed (orphan-permitting parent can lose rows out-of-band)', async () => {
			await setupParChi('memory', 'orphanmem');
			const rows = await planRows(innerQ);
			expect(joinCount(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.be.greaterThan(0);
			const out = await results(innerQ + ' order by c.id');
			expect(out.map(r => r.id)).to.deep.equal([10]);
		});
	});

	describe('anti-over-suppression: the at-most-one claim is NOT gated', () => {
		it('cap on: LEFT join with unreferenced right side still eliminates', async () => {
			// LEFT elimination rests on checkFkPkAlignment (≤1 match from the
			// parent PK being unique), not on the FK existence promise — orphans
			// cannot break it. If this fails, the gate leaked into
			// checkFkPkAlignment.
			await db.exec('create table customers (id integer primary key, name text) using orphanmem');
			await db.exec('create table orders (order_id integer primary key, customer_id integer not null references customers(id), total real) using orphanmem');
			await db.exec("insert into customers values (1, 'Acme')");
			await db.exec('pragma foreign_keys = false');
			await db.exec('insert into orders values (10, 1, 99.0), (11, 7, 49.5)');
			await db.exec('pragma foreign_keys = true');

			const q = 'select order_id, total from orders left join customers on orders.customer_id = customers.id';
			const rows = await planRows(q);
			expect(joinCount(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(0);
			// LEFT preserves the orphan row — elimination is answer-preserving here.
			const out = await results(q + ' order by order_id');
			expect(out.map(r => r.order_id)).to.deep.equal([10, 11]);
		});
	});

	describe('semi-join FK trivialization', () => {
		it('control (cap absent): semi-join dropped — the orphan passes EXISTS', async () => {
			await setupParChi('memory');
			const rows = await planRows(semiQ);
			expect(rows.some(r => JOIN_OPS.has(r.op)), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(false);
			const out = await results(semiQ + ' order by id');
			expect(out.map(r => r.id)).to.deep.equal([10, 20]);
		});

		it('cap on: semi-join survives and EXISTS is answered from the data', async () => {
			await setupParChi('orphanmem');
			const rows = await planRows(semiQ);
			expect(rows.some(r => JOIN_OPS.has(r.op)), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(true);
			const out = await results(semiQ + ' order by id');
			expect(out.map(r => r.id)).to.deep.equal([10]);
		});
	});

	describe('anti-join FK empty fold', () => {
		it('control (cap absent): NOT EXISTS folds to empty — the orphan is hidden', async () => {
			await setupParChi('memory');
			const out = await results(antiQ + ' order by id');
			expect(out.map(r => r.id)).to.deep.equal([]);
		});

		it('cap on: NOT EXISTS returns the orphan row', async () => {
			await setupParChi('orphanmem');
			const out = await results(antiQ + ' order by id');
			expect(out.map(r => r.id)).to.deep.equal([20]);
		});
	});

	describe('IND seeding on TableReferenceNode.computePhysical', () => {
		function buildReference(vtabModule: MemoryTableModule, tableName = 'chi'): TableReferenceNode {
			const table = db.schemaManager.findTable(tableName, 'main');
			if (!table) throw new Error(`table main.${tableName} not found`);
			// Pass the module explicitly (the node resolves it at construction,
			// independent of the schema) and the schema manager (needed to resolve
			// FK parents) — mirrors check-fold-gated-by-capability.spec.ts.
			return new TableReferenceNode(
				new GlobalScope(db.schemaManager),
				table,
				vtabModule,
				undefined,
				undefined,
				false,
				db.schemaManager,
			);
		}

		it('default (cap absent): one IND per declared FK', async () => {
			await setupParChi('memory');
			const phys = buildReference(new MemoryTableModule()).computePhysical([]);
			expect(phys.inds, 'FK seeds an IND by default').to.exist;
			expect(phys.inds).to.have.lengthOf(1);
			expect(phys.inds![0].cols).to.deep.equal([1]);
			expect(phys.inds![0].target).to.deep.include({ kind: 'table', table: 'par' });
			expect(phys.inds![0].nullRejecting).to.equal(false);
		});

		it('cap on (construction-resolved module): inds is undefined', async () => {
			// The schema-registered module is plain memory; the capability rides on
			// the module passed at construction — proving reference.ts hands its own
			// module to seedTableForeignKeyInds rather than the schema's.
			await setupParChi('memory');
			const phys = buildReference(new OrphanMemoryModule()).computePhysical([]);
			// `out.inds` is only set when non-empty (see reference.ts); absence is
			// the contract.
			expect(phys.inds, 'no IND seeding under cap').to.be.undefined;
		});
	});

	describe('lookupCoveringFK / seedTableForeignKeyInds units', () => {
		function schemas(): { chi: TableSchema; par: TableSchema } {
			const chi = db.schemaManager.findTable('chi', 'main');
			const par = db.schemaManager.findTable('par', 'main');
			if (!chi || !par) throw new Error('setup tables missing');
			return { chi, par };
		}
		const findParent = (t: string, s: string) => db.schemaManager.findTable(t, s);

		it('default: lookup matches and the seeder mints one IND', async () => {
			await setupParChi('memory');
			const { chi, par } = schemas();
			expect(lookupCoveringFK(chi, par, [1], [0]), 'covering FK found').to.exist;
			expect(seedTableForeignKeyInds(chi, findParent)).to.have.lengthOf(1);
		});

		it('cap on child module: both producers return the empty answer', async () => {
			await setupParChi('orphanmem', 'memory');
			const { chi, par } = schemas();
			expect(lookupCoveringFK(chi, par, [1], [0])).to.equal(undefined);
			expect(seedTableForeignKeyInds(chi, findParent)).to.deep.equal([]);
		});

		it('cap on parent module only: both producers return the empty answer', async () => {
			await setupParChi('memory', 'orphanmem');
			const { chi, par } = schemas();
			expect(lookupCoveringFK(chi, par, [1], [0])).to.equal(undefined);
			// Per-FK parent check inside the seeder loop.
			expect(seedTableForeignKeyInds(chi, findParent)).to.deep.equal([]);
		});

		it('logical (module-less) schemas are never gated — and never throw', async () => {
			// Lens-slot logical tables carry no vtabModule (schema/table.ts). The
			// gate must treat an absent module as ungated, exactly like the CHECK
			// precedent — and a future `requireVtabModule` refactor must not start
			// throwing here.
			await setupParChi('memory');
			const { chi, par } = schemas();
			const bareChi: TableSchema = { ...chi, vtabModule: undefined };
			const barePar: TableSchema = { ...par, vtabModule: undefined };
			expect(lookupCoveringFK(bareChi, barePar, [1], [0]), 'ungated without a module').to.exist;
			const findBarePar = (t: string, s: string) => {
				const found = db.schemaManager.findTable(t, s);
				return found ? { ...found, vtabModule: undefined } : undefined;
			};
			expect(seedTableForeignKeyInds(bareChi, findBarePar)).to.have.lengthOf(1);
		});

		it('self-referencing FK: both sides resolve to the same module and the gate fires once', async () => {
			await db.exec('create table emp_m (id integer primary key, mgr integer not null references emp_m(id)) using memory');
			await db.exec('create table emp_o (id integer primary key, mgr integer not null references emp_o(id)) using orphanmem');
			const empM = db.schemaManager.findTable('emp_m', 'main')!;
			const empO = db.schemaManager.findTable('emp_o', 'main')!;
			expect(lookupCoveringFK(empM, empM, [1], [0]), 'ungated self-reference matches').to.exist;
			expect(seedTableForeignKeyInds(empM, findParent)).to.have.lengthOf(1);
			expect(lookupCoveringFK(empO, empO, [1], [0]), 'gated self-reference declines').to.equal(undefined);
			expect(seedTableForeignKeyInds(empO, findParent)).to.deep.equal([]);
		});

		it('composite FK: the gate declines before the alignment walk; permutation rejection stays independent', async () => {
			for (const mod of ['memory', 'orphanmem']) {
				await db.exec(`create table pcomp_${mod} (a integer not null, b integer not null, primary key (a, b)) using ${mod}`);
				await db.exec(`create table ccomp_${mod} (
					id integer primary key,
					fa integer not null,
					fb integer not null,
					foreign key (fa, fb) references pcomp_${mod}(a, b)
				) using ${mod}`);
			}
			const pM = db.schemaManager.findTable('pcomp_memory', 'main')!;
			const cM = db.schemaManager.findTable('ccomp_memory', 'main')!;
			const pO = db.schemaManager.findTable('pcomp_orphanmem', 'main')!;
			const cO = db.schemaManager.findTable('ccomp_orphanmem', 'main')!;
			// Aligned pairing, ungated → matches.
			expect(lookupCoveringFK(cM, pM, [1, 2], [0, 1]), 'aligned composite matches').to.exist;
			// Permuted pairing, ungated → declined by the positional walk (the gate
			// must not become the only thing declining a permutation).
			expect(lookupCoveringFK(cM, pM, [1, 2], [1, 0]), 'permuted composite declines').to.equal(undefined);
			// Aligned pairing, gated → declined by the cap, before the walk.
			expect(lookupCoveringFK(cO, pO, [1, 2], [0, 1]), 'gated composite declines').to.equal(undefined);
		});
	});

	describe('fan-out lookup join under the cap', () => {
		function fanOutBranchModes(rows: readonly PlanRow[]): string[] {
			const fo = rows.find(r => r.op === 'FANOUTLOOKUPJOIN' || r.node_type === 'FanOutLookupJoin');
			if (!fo || !fo.properties) return [];
			const props = JSON.parse(fo.properties) as { branches?: { mode: string }[] };
			return (props.branches ?? []).map(b => b.mode);
		}

		async function setup3InnerBranches(lookupModule: string): Promise<void> {
			await db.exec(`create table cust (id integer primary key, name text) using ${lookupModule}`);
			await db.exec(`create table prod (id integer primary key, sku text) using ${lookupModule}`);
			await db.exec(`create table region (id integer primary key, label text) using ${lookupModule}`);
			await db.exec(`create table orders (
				order_id integer primary key,
				customer_id integer not null references cust(id),
				product_id integer not null references prod(id),
				region_id integer not null references region(id),
				total real
			) using memory`);
		}

		const fanout3InnerSQL =
			`select o.order_id, c.name, p.sku, r.label
			 from orders o
			 inner join cust c on o.customer_id = c.id
			 inner join prod p on o.product_id = p.id
			 inner join region r on o.region_id = r.id`;

		function tightenConcurrency(): () => void {
			// Mirror parallel-fanout.spec.ts: cap=2 so 3 branches yield a positive
			// latency win and the cost gate fires.
			const before = db.optimizer.tuning;
			db.optimizer.updateTuning({
				...before,
				parallel: { ...before.parallel, concurrency: 2 },
			});
			return () => db.optimizer.updateTuning(before);
		}

		it('control (cap absent): FK-aligned inner branches cluster as atMostOne-inner', async () => {
			db.registerModule('hi_lat_memory', new HighLatencyMemoryModule());
			const restore = tightenConcurrency();
			try {
				await setup3InnerBranches('hi_lat_memory');
				const plan = await planRows(fanout3InnerSQL);
				expect(fanOutBranchModes(plan), `ops=${plan.map(r => r.op).join(',')}`)
					.to.deep.equal(['atMostOne-inner', 'atMostOne-inner', 'atMostOne-inner']);
			} finally {
				restore();
			}
		});

		it('cap on: branches still cluster — as cross, not vanishing wholesale', async () => {
			// The gated lookupCoveringFK fails the at-most-one existence proof, but
			// recognizeBranch falls through to the sound `cross` mode instead of
			// bailing the entire cluster.
			db.registerModule('hi_lat_orphan', new HighLatencyOrphanMemoryModule());
			const restore = tightenConcurrency();
			try {
				await setup3InnerBranches('hi_lat_orphan');
				const plan = await planRows(fanout3InnerSQL);
				expect(fanOutBranchModes(plan), `ops=${plan.map(r => r.op).join(',')}`)
					.to.deep.equal(['cross', 'cross', 'cross']);
				expect(joinCount(plan), `ops=${plan.map(r => r.op).join(',')}`).to.equal(0);
			} finally {
				restore();
			}
		});
	});

	describe('multi-hop IND chains lose the proof under the cap (conservative)', () => {
		it('cap on: chained FK joins keep every join node', async () => {
			// T → M → P: the IND path is what proves multi-hop no-row-loss. With
			// seeding suppressed the proof is simply absent — joins survive, no
			// false Covers possible.
			await db.exec('create table p3 (id integer primary key) using orphanmem');
			await db.exec('create table m3 (id integer primary key, p_id integer not null references p3(id)) using orphanmem');
			await db.exec('create table t3 (id integer primary key, m_id integer not null references m3(id)) using orphanmem');
			await db.exec('insert into p3 values (1)');
			await db.exec('insert into m3 values (5, 1)');
			await db.exec('pragma foreign_keys = false');
			await db.exec('insert into t3 values (100, 5), (101, 9)');
			await db.exec('pragma foreign_keys = true');

			const q = 'select t3.id from t3 join m3 on t3.m_id = m3.id join p3 on m3.p_id = p3.id';
			const rows = await planRows(q);
			expect(joinCount(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.be.greaterThan(0);
			const out = await results(q + ' order by t3.id');
			expect(out.map(r => r.id)).to.deep.equal([100]);
		});
	});
});
