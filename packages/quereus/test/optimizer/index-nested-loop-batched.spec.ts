/**
 * Plan-shape, execution and unit coverage for the BATCHED index-nested-loop
 * join: an index-nested-loop candidate whose seek provably returns at most one
 * row per outer row, re-driven by `rule-join-physical-selection` as a
 * one-branch `FanOutLookupJoinNode` in `batched` outer mode so the seeks
 * against a high-latency module overlap across outer rows.
 *
 * Two cost surfaces gate the candidate, both inert on memory-vtab plans:
 *   - the inner module's `expectedLatencyMs` (non-zero only via the synthetic
 *     `HighLatencyMemoryModule`), read by `toBatchedOuter`'s latency gate and
 *     by the price itself, and
 *   - the outer's `physical.estimatedRows`, gated by
 *     `tuning.parallel.batchedOuterMinRows` — lowered to 0 in the firing tests
 *     (ANALYZE on a few-row fixture clears nothing at the 256-row default).
 *
 * NOTE: `HighLatencyMemoryModule` is duplicated across the parallel/latency
 * specs by convention — `tickets/backlog/debt-shared-high-latency-test-module.md`
 * owns consolidating it.
 */

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import type { VtabConcurrencyMode } from '../../src/vtab/module.js';
import type { SqlValue } from '../../src/common/types.js';
import type { PlanNode, ScalarPlanNode } from '../../src/planner/nodes/plan-node.js';
import type * as AST from '../../src/parser/ast.js';
import { FanOutLookupJoinNode } from '../../src/planner/nodes/fanout-lookup-join-node.js';
import { EagerPrefetchNode } from '../../src/planner/nodes/eager-prefetch-node.js';
import { FilterNode } from '../../src/planner/nodes/filter.js';
import { IndexSeekNode } from '../../src/planner/nodes/table-access-nodes.js';
import { JoinNode } from '../../src/planner/nodes/join-node.js';
import { BloomJoinNode } from '../../src/planner/nodes/bloom-join-node.js';
import { ColumnReferenceNode } from '../../src/planner/nodes/reference.js';
import { LiteralNode, BinaryOpNode } from '../../src/planner/nodes/scalar.js';
import { provesAtMostOne } from '../../src/planner/rules/join/index-nested-loop.js';
import type { PredicateConstraint } from '../../src/planner/analysis/constraint-extractor.js';
import type { TableSchema } from '../../src/schema/table.js';
import { batchedIndexNestedLoopJoinCost, indexNestedLoopJoinCost } from '../../src/planner/cost/index.js';
import { EmptyScope } from '../../src/planner/scopes/empty.js';
import type { Scope } from '../../src/planner/scopes/scope.js';
import type { ScalarType } from '../../src/common/datatype.js';
import { TEXT_TYPE } from '../../src/types/builtin-types.js';

/** The synthetic remote-vtab stand-in used by every parallel/latency optimizer spec. */
class HighLatencyMemoryModule extends MemoryTableModule {
	readonly expectedLatencyMs = 25;
}

/** High latency AND `'serial'` concurrency: the branch must be lock-wrapped, not refused. */
function makeSerialHighLatencyModule(): MemoryTableModule {
	const mod = new HighLatencyMemoryModule();
	(mod as { concurrencyMode: VtabConcurrencyMode }).concurrencyMode = 'serial';
	return mod;
}

function collectNodes<T extends PlanNode>(root: PlanNode, predicate: (n: PlanNode) => n is T): T[] {
	const found: T[] = [];
	const walk = (n: PlanNode): void => {
		if (predicate(n)) found.push(n);
		for (const c of n.getChildren()) walk(c as PlanNode);
	};
	walk(root);
	return found;
}

const isFanOut = (n: PlanNode): n is FanOutLookupJoinNode => n instanceof FanOutLookupJoinNode;
const isPrefetch = (n: PlanNode): n is EagerPrefetchNode => n instanceof EagerPrefetchNode;
const isFilter = (n: PlanNode): n is FilterNode => n instanceof FilterNode;
const isIndexSeek = (n: PlanNode): n is IndexSeekNode => n instanceof IndexSeekNode;
const isJoin = (n: PlanNode): n is JoinNode => n instanceof JoinNode;
const isHashJoin = (n: PlanNode): n is BloomJoinNode => n instanceof BloomJoinNode;
const isColumnRef = (n: PlanNode): n is ColumnReferenceNode => n instanceof ColumnReferenceNode;

/** Logical JoinNodes whose right subtree seeks on a left-side attribute (the serial index-NL signature). */
function correlatedSeekJoins(root: PlanNode): JoinNode[] {
	return collectNodes(root, isJoin).filter(join => {
		const leftAttrIds = new Set(join.left.getAttributes().map(a => a.id));
		return collectNodes(join.right, isIndexSeek).some(seek =>
			seek.seekKeys.some(key =>
				collectNodes(key, isColumnRef).some(ref => leftAttrIds.has(ref.attributeId))));
	});
}

/** The one batched one-branch fan-out the rule is expected to have produced. */
function soleBatchedFanOut(plan: PlanNode): FanOutLookupJoinNode {
	const fanouts = collectNodes(plan, isFanOut);
	expect(fanouts, 'exactly one fan-out').to.have.lengthOf(1);
	const fo = fanouts[0];
	expect(fo.outerMode).to.equal('batched');
	expect(fo.branches).to.have.lengthOf(1);
	expect(fo.concurrencyCap).to.equal(1);
	expect(isPrefetch(fo.outer), 'batched implies an EagerPrefetch outer').to.equal(true);
	return fo;
}

async function drain(db: Database, sql: string): Promise<Array<Record<string, SqlValue>>> {
	const rows: Array<Record<string, SqlValue>> = [];
	for await (const r of db.eval(sql)) rows.push(r);
	return rows;
}

// Executing a fan-out under an ORDER BY trips the documented Sort/Project-above-
// fan-out strict-fork harness false-positive (see parallel-fanout.spec.ts) —
// skip execution assertions under strict-fork; plan-shape assertions still run.
const strictFork = typeof process !== 'undefined' && (process.env?.QUEREUS_FORK_STRICT === '1' || process.env?.QUEREUS_FORK_STRICT === 'true');
const forkExecTest = strictFork ? it.skip : it;

describe('batched index-nested-loop join (one-branch batched fan-out)', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		db.registerModule('hi_lat', new HighLatencyMemoryModule());
		db.registerModule('hi_lat_serial', makeSerialHighLatencyModule());
		// The synthetic outers here are a handful of rows; drop the cardinality
		// gate so the latency gate and the price are what decide. Restored
		// inline by the test that exercises the gate.
		const before = db.optimizer.tuning;
		db.optimizer.updateTuning({
			...before,
			parallel: { ...before.parallel, batchedOuterMinRows: 0 },
		});
	});

	afterEach(async () => {
		await db.close();
	});

	/**
	 * Outer `s` (4 rows, one NULL key, one key with no match) joined to inner
	 * `big` (200 rows, PK `id`, non-unique secondary index on `v`). `innerModule`
	 * picks the inner's latency profile; the outer always stays on plain memory.
	 */
	async function createTables(innerModule: 'memory' | 'hi_lat' | 'hi_lat_serial'): Promise<void> {
		await db.exec('create table s (id integer primary key, k integer null)');
		await db.exec('insert into s values (1, 5), (2, 7), (3, 999), (4, null)');
		await db.exec(`create table big (id integer primary key, v integer, w integer) using ${innerModule}`);
		await db.exec('create index idx_v on big(v)');
		const rows: string[] = [];
		for (let i = 1; i <= 200; i++) rows.push(`(${i}, ${i % 50}, ${i % 10})`);
		await db.exec(`insert into big values ${rows.join(', ')}`);
		for await (const _ of db.eval('analyze')) { /* consume */ }
	}

	const INNER_SQL = 'select s.id, big.w from s join big on big.id = s.k order by s.id';
	const LEFT_SQL = 'select s.id, big.w from s left join big on big.id = s.k order by s.id';

	describe('primary-key inner join over the high-latency module', () => {
		it('plans a batched one-branch atMostOne-inner fan-out over a prefetched outer', async () => {
			await createTables('hi_lat');
			const fo = soleBatchedFanOut(db.getPlan(INNER_SQL));
			expect(fo.branches[0].mode).to.equal('atMostOne-inner');
			expect(fo.branches[0].concurrencySafe).to.equal(true);
			// Branch child: Filter(ON) over the rebuilt inner whose leaf is the
			// correlated seek on `s.k`.
			const child = fo.branches[0].child;
			expect(isFilter(child), 'the ON condition becomes a Filter inside the branch').to.equal(true);
			const seeks = collectNodes(child, isIndexSeek);
			expect(seeks).to.have.lengthOf(1);
			const outerAttrIds = new Set(fo.outer.getAttributes().map(a => a.id));
			expect(seeks[0].seekKeys.some(key =>
				collectNodes(key, isColumnRef).some(ref => outerAttrIds.has(ref.attributeId))),
			'the seek is keyed on an outer attribute').to.equal(true);
			expect(fo.branches[0].outputAttrs.length).to.equal(child.getAttributes().length);
			// The logical join is gone: no serial index-NL, no hash join.
			expect(correlatedSeekJoins(db.getPlan(INNER_SQL))).to.have.lengthOf(0);
			expect(collectNodes(db.getPlan(INNER_SQL), isHashJoin)).to.have.lengthOf(0);
		});

		forkExecTest('returns the rows the plain-memory plan returns', async () => {
			await createTables('hi_lat');
			const batched = await drain(db, INNER_SQL);
			expect(batched).to.deep.equal([{ id: 1, w: 5 }, { id: 2, w: 7 }]);

			const control = new Database();
			try {
				await control.exec('create table s (id integer primary key, k integer null)');
				await control.exec('insert into s values (1, 5), (2, 7), (3, 999), (4, null)');
				await control.exec('create table big (id integer primary key, v integer, w integer)');
				const rows: string[] = [];
				for (let i = 1; i <= 200; i++) rows.push(`(${i}, ${i % 50}, ${i % 10})`);
				await control.exec(`insert into big values ${rows.join(', ')}`);
				expect(collectNodes(control.getPlan(INNER_SQL), isFanOut), 'control plan has no fan-out').to.have.lengthOf(0);
				expect(await drain(control, INNER_SQL)).to.deep.equal(batched);
			} finally {
				await control.close();
			}
		});
	});

	describe('LEFT join', () => {
		it('plans an atMostOne-left branch with the logical join\'s attributes pinned', async () => {
			await createTables('hi_lat');
			const plan = db.getPlan(LEFT_SQL);
			const fo = soleBatchedFanOut(plan);
			expect(fo.branches[0].mode).to.equal('atMostOne-left');
			// preserveAttrs pins the logical layout: [...left, ...right nullable-widened].
			const attrs = fo.getAttributes();
			expect(attrs.length).to.equal(fo.outer.getAttributes().length + fo.branches[0].outputAttrs.length);
			for (const a of attrs.slice(fo.outer.getAttributes().length)) {
				expect(a.type.nullable, `branch attr ${a.name} is nullable-widened`).to.equal(true);
			}
		});

		forkExecTest('NULL-pads unmatched outer rows (zero-match and NULL-key)', async () => {
			await createTables('hi_lat');
			expect(await drain(db, LEFT_SQL)).to.deep.equal([
				{ id: 1, w: 5 }, { id: 2, w: 7 }, { id: 3, w: null }, { id: 4, w: null },
			]);
		});
	});

	describe('a nullable UNIQUE inner key holding several NULL rows', () => {
		// The proof admits a UNIQUE constraint without demanding NOT NULL, and SQL
		// UNIQUE permits many NULLs — so uniqueness alone does NOT bound the match
		// count here. What bounds it is `=`: `u = NULL` is UNKNOWN, so a NULL-valued
		// seek key matches nothing and the stored NULL rows are unreachable. If that
		// leg of the proof were wrong the branch would yield two rows and the runtime
		// would throw CONSTRAINT — a working query turned into an error, not a wrong
		// answer — which is exactly what the proof exists to prevent.
		const NULL_KEY_SQL = 'select o.id, un.w from o left join un on un.u = o.k order by o.id';

		beforeEach(async () => {
			await db.exec('create table o (id integer primary key, k text null)');
			await db.exec("insert into o values (1, 'a'), (2, null), (3, 'zz')");
			await db.exec('create table un (pk integer primary key, u text null unique, w integer) using hi_lat');
			const rows: string[] = ["(1, 'a', 10)", '(2, null, 20)', '(3, null, 30)', "(4, 'b', 40)"];
			for (let i = 5; i <= 100; i++) rows.push(`(${i}, 'k${i}', ${i})`);
			await db.exec(`insert into un values ${rows.join(', ')}`);
			for await (const _ of db.eval('analyze')) { /* consume */ }
		});

		it('proves at-most-one from the UNIQUE constraint', async () => {
			expect(soleBatchedFanOut(db.getPlan(NULL_KEY_SQL)).branches[0].mode).to.equal('atMostOne-left');
		});

		forkExecTest('matches no stored NULL row for a NULL key', async () => {
			expect(await drain(db, NULL_KEY_SQL)).to.deep.equal([
				{ id: 1, w: 10 }, { id: 2, w: null }, { id: 3, w: null },
			]);
		});
	});

	describe('does not form', () => {
		it('at zero latency — the plan is the serial index-nested-loop it is today', async () => {
			await createTables('memory');
			const plan = db.getPlan(INNER_SQL);
			expect(collectNodes(plan, isFanOut)).to.have.lengthOf(0);
			expect(correlatedSeekJoins(plan), 'serial index-NL unchanged').to.have.lengthOf(1);
		});

		it('when the cardinality gate is at its default and the outer is small', async () => {
			await createTables('hi_lat');
			const before = db.optimizer.tuning;
			db.optimizer.updateTuning({
				...before,
				parallel: { ...before.parallel, batchedOuterMinRows: 256 },
			});
			try {
				expect(collectNodes(db.getPlan(INNER_SQL), isFanOut)).to.have.lengthOf(0);
			} finally {
				db.optimizer.updateTuning(before);
			}
		});

		it('on a non-unique secondary-index seek (at-most-one unproved)', async () => {
			await createTables('hi_lat');
			const sql = 'select s.id, big.id as bid from s join big on big.v = s.k';
			const plan = db.getPlan(sql);
			expect(collectNodes(plan, isFanOut)).to.have.lengthOf(0);
		});

		it('on a NOCASE join key over a BINARY unique column (collation coarser than the key)', async () => {
			// Outer key declared NOCASE resolves the join collation to NOCASE; the
			// inner unique key is enforced BINARY, so `'a'` and `'A'` are two stored
			// rows that would both match — the proof must decline, or the runtime
			// would throw CONSTRAINT on the second row.
			await db.exec('create table co (id integer primary key, name text collate nocase)');
			await db.exec("insert into co values (1, 'a'), (2, 'b')");
			await db.exec('create table ci (pk integer primary key, name text unique) using hi_lat');
			const rows: string[] = [];
			for (let i = 1; i <= 100; i++) rows.push(`(${i}, 'n${i}')`);
			await db.exec(`insert into ci values ${rows.join(', ')}`);
			for await (const _ of db.eval('analyze')) { /* consume */ }
			const plan = db.getPlan('select co.id, ci.pk from co join ci on ci.name = co.name');
			expect(collectNodes(plan, isFanOut)).to.have.lengthOf(0);
		});

		it('for an `exists … as` existence join (the fan-out has no flag support)', async () => {
			await createTables('hi_lat');
			const sql = 'select s.id, b_ex from s left join big b on b.id = s.k exists right as b_ex order by s.id';
			const plan = db.getPlan(sql);
			expect(collectNodes(plan, isFanOut)).to.have.lengthOf(0);
		});

		it('for the SEMI join EXISTS decorrelates into (no semi mode on the fan-out)', async () => {
			await createTables('hi_lat');
			const plan = db.getPlan('select s.id from s where exists (select 1 from big where big.id = s.k)');
			expect(collectNodes(plan, isFanOut)).to.have.lengthOf(0);
		});
	});

	describe('composite primary key half-supplied by a pushed predicate', () => {
		// `b.id = 5` must actually be PUSHED (an IndexSeek leaf recording it in
		// `pushedConstraints`) for the seek arm to re-offer it beside the join key:
		// the memory module cannot seek a PK on its second column alone, so `id`
		// gets its own index. Without it the predicate stays a user Filter above
		// a walk leaf — which the proof does not read (see the handoff's gaps).
		async function createCompositeTables(): Promise<void> {
			await db.exec('create table o (id integer primary key, tenant integer)');
			await db.exec('insert into o values (1, 1), (2, 2), (3, 3)');
			await db.exec('create table b (tenant integer, id integer, payload text, primary key (tenant, id)) using hi_lat');
			await db.exec('create index idx_b_id on b(id)');
			const rows: string[] = [];
			for (let t = 1; t <= 4; t++) for (let i = 1; i <= 25; i++) rows.push(`(${t}, ${i}, 'p${t}-${i}')`);
			await db.exec(`insert into b values ${rows.join(', ')}`);
			for await (const _ of db.eval('analyze')) { /* consume */ }
		}

		const SQL = 'select o.id, b.payload from o join b on b.tenant = o.tenant where b.id = 5 order by o.id';

		it('proves at-most-one from the join key plus the pushed equality', async () => {
			await createCompositeTables();
			const fo = soleBatchedFanOut(db.getPlan(SQL));
			expect(fo.branches[0].mode).to.equal('atMostOne-inner');
			// The rebuilt seek is the composite PK seek over both columns.
			const seeks = collectNodes(fo.branches[0].child, isIndexSeek);
			expect(seeks).to.have.lengthOf(1);
			expect(seeks[0].pushedConstraints, 'join key and pushed equality both consumed').to.have.lengthOf(2);
		});

		it('does not prove it when the pushed predicate stays a user Filter above a walk leaf', async () => {
			// Same query without the `id` index: `b.id = 5` is not pushable, the inner
			// is Filter(id = 5) over a PK walk, and the walk arm offers only the join
			// key — the proof never sees the Filter's predicate. Pinned so the gap is
			// visible; `feat-index-nested-loop-offer-filter-predicates` (backlog)
			// would close it by offering Filter predicates to the module.
			await db.exec('create table o (id integer primary key, tenant integer)');
			await db.exec('insert into o values (1, 1), (2, 2), (3, 3)');
			await db.exec('create table b (tenant integer, id integer, payload text, primary key (tenant, id)) using hi_lat');
			const rows: string[] = [];
			for (let t = 1; t <= 4; t++) for (let i = 1; i <= 25; i++) rows.push(`(${t}, ${i}, 'p${t}-${i}')`);
			await db.exec(`insert into b values ${rows.join(', ')}`);
			for await (const _ of db.eval('analyze')) { /* consume */ }
			expect(collectNodes(db.getPlan(SQL), isFanOut)).to.have.lengthOf(0);
		});

		forkExecTest('returns one row per tenant', async () => {
			await createCompositeTables();
			expect(await drain(db, SQL)).to.deep.equal([
				{ id: 1, payload: 'p1-5' }, { id: 2, payload: 'p2-5' }, { id: 3, payload: 'p3-5' },
			]);
		});
	});

	describe('a non-concurrency-safe inner module', () => {
		it('still forms; the branch is marked for the connection lock', async () => {
			await createTables('hi_lat_serial');
			const fo = soleBatchedFanOut(db.getPlan(INNER_SQL));
			expect(fo.branches[0].concurrencySafe).to.equal(false);
		});

		forkExecTest('returns correct rows under the lock', async () => {
			await createTables('hi_lat_serial');
			expect(await drain(db, INNER_SQL)).to.deep.equal([{ id: 1, w: 5 }, { id: 2, w: 7 }]);
		});
	});

	describe('outer smaller than the read-ahead window', () => {
		async function createSmallOuter(rowCount: number): Promise<void> {
			await db.exec('create table so (id integer primary key, k integer)');
			const rows: string[] = [];
			for (let i = 1; i <= rowCount; i++) rows.push(`(${i}, ${i * 3})`);
			await db.exec(`insert into so values ${rows.join(', ')}`);
			await db.exec('create table sb (id integer primary key, w integer) using hi_lat');
			const inner: string[] = [];
			for (let i = 1; i <= 100; i++) inner.push(`(${i}, ${i * 10})`);
			await db.exec(`insert into sb values ${inner.join(', ')}`);
			for await (const _ of db.eval('analyze')) { /* consume */ }
		}
		const SQL = 'select so.id, sb.w from so join sb on sb.id = so.k';

		for (const n of [1, 3]) {
			forkExecTest(`drives a ${n}-row outer through the batched driver in outer order`, async () => {
				await createSmallOuter(n);
				soleBatchedFanOut(db.getPlan(SQL));
				const expected: Array<Record<string, SqlValue>> = [];
				for (let i = 1; i <= n; i++) expected.push({ id: i, w: i * 30 });
				expect(await drain(db, SQL)).to.deep.equal(expected);
			});
		}
	});

	describe('nesting: two qualifying joins in one query', () => {
		async function createChain(): Promise<void> {
			await db.exec('create table a (id integer primary key, b_id integer)');
			await db.exec('insert into a values (1, 10), (2, 20), (3, 30)');
			await db.exec('create table b (id integer primary key, c_id integer) using hi_lat');
			const bs: string[] = [];
			for (let i = 1; i <= 100; i++) bs.push(`(${i}, ${i * 2})`);
			await db.exec(`insert into b values ${bs.join(', ')}`);
			await db.exec('create table c (id integer primary key, label text) using hi_lat');
			const cs: string[] = [];
			for (let i = 1; i <= 200; i++) cs.push(`(${i}, 'c${i}')`);
			await db.exec(`insert into c values ${cs.join(', ')}`);
			for await (const _ of db.eval('analyze')) { /* consume */ }
		}
		const SQL = 'select a.id, c.label from a join b on b.id = a.b_id join c on c.id = b.c_id order by a.id';

		it('nests one batched fan-out inside the other', async () => {
			await createChain();
			const plan = db.getPlan(SQL);
			const fanouts = collectNodes(plan, isFanOut);
			expect(fanouts, 'two fan-outs').to.have.lengthOf(2);
			for (const fo of fanouts) expect(fo.outerMode).to.equal('batched');
		});

		// Runs under QUEREUS_FORK_STRICT too when the ORDER BY is dropped? No —
		// keep the ORDER BY for a deterministic row set and skip under strict-fork
		// like every other fan-out execution test.
		forkExecTest('unwinds both drivers and returns the chained rows', async () => {
			await createChain();
			expect(await drain(db, SQL)).to.deep.equal([
				{ id: 1, label: 'c20' }, { id: 2, label: 'c40' }, { id: 3, label: 'c60' },
			]);
		});
	});

	describe('mirrored orientation', () => {
		it('seeks the LEFT input driven by the right when that is the cheaper batched candidate', async () => {
			// The PK-bearing high-latency table is named FIRST; the small outer second.
			await createTables('hi_lat');
			const sql = 'select s.id, big.w from big join s on big.id = s.k';
			const fo = soleBatchedFanOut(db.getPlan(sql));
			// Derived layout (no preserveAttrs): [...s, ...big].
			const names = fo.getAttributes().map(a => a.name);
			expect(names.slice(0, 2)).to.deep.equal(['id', 'k']);
		});

		forkExecTest('returns the same rows as the spelled orientation', async () => {
			await createTables('hi_lat');
			const mirrored = await drain(db, 'select s.id, big.w from big join s on big.id = s.k order by s.id');
			expect(mirrored).to.deep.equal([{ id: 1, w: 5 }, { id: 2, w: 7 }]);
		});
	});

	describe('idempotence', () => {
		it('ruleFanOutBatchedOuter leaves a node this rule already flipped alone (plan is stable)', async () => {
			await createTables('hi_lat');
			// One batched fan-out, ONE EagerPrefetch — a second flip would stack another.
			const plan = db.getPlan(INNER_SQL);
			soleBatchedFanOut(plan);
			expect(collectNodes(plan, isPrefetch)).to.have.lengthOf(1);
		});
	});
});

describe('provesAtMostOne (the at-most-one proof)', () => {
	const scope = EmptyScope.instance as unknown as Scope;
	/** A TEXT column reference type; `collation` is a DECLARED column collation (rank 2 in the lattice). */
	const text = (collation?: string): ScalarType => ({
		typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true,
		...(collation ? { collationName: collation, collationSource: 'declared' as const } : {}),
	});

	/** A minimal TableSchema stub — only the fields the proof reads. */
	function schema(overrides: Partial<TableSchema> & { columns: TableSchema['columns'] }): TableSchema {
		return {
			name: 't', schemaName: 'main', columnIndexMap: new Map(), primaryKeyDefinition: [],
			...overrides,
		} as unknown as TableSchema;
	}
	const col = (name: string, collation?: string): TableSchema['columns'][number] =>
		({ name, logicalType: TEXT_TYPE, notNull: false, primaryKey: false, collation } as unknown as TableSchema['columns'][number]);

	/**
	 * `t.<colIdx> <op> 'x'` as the constraint `extractConstraints` would mint
	 * for it. `predicateCollation` is the column reference's declared collation,
	 * which the lattice resolves the comparison to (a literal contributes none).
	 */
	function constraint(colIdx: number, predicateCollation?: string, op: PredicateConstraint['op'] = '='): PredicateConstraint {
		const ast = { type: 'column', name: `c${colIdx}` } as AST.ColumnExpr;
		const lhs = new ColumnReferenceNode(scope, ast, text(predicateCollation), 1000 + colIdx, colIdx);
		const rhs = new LiteralNode(scope, { type: 'literal', value: 'x' } as AST.LiteralExpr);
		const binAst = { type: 'binary', operator: op, left: ast, right: rhs.expression } as AST.BinaryExpr;
		const src = new BinaryOpNode(scope, binAst, lhs, rhs);
		return { columnIndex: colIdx, op, usable: true, attributeId: 1000 + colIdx, sourceExpression: src as ScalarPlanNode, bindingKind: 'literal' };
	}

	it('proves a fully pinned primary key', () => {
		const t = schema({ columns: [col('a'), col('b')], primaryKeyDefinition: [{ index: 0 }] });
		expect(provesAtMostOne(t, [constraint(0)])).to.equal(true);
	});

	it('needs every column of a composite key', () => {
		const t = schema({ columns: [col('a'), col('b')], primaryKeyDefinition: [{ index: 0 }, { index: 1 }] });
		expect(provesAtMostOne(t, [constraint(0)])).to.equal(false);
		expect(provesAtMostOne(t, [constraint(0), constraint(1)])).to.equal(true);
	});

	it('proves a UNIQUE constraint', () => {
		const t = schema({ columns: [col('a'), col('b')], primaryKeyDefinition: [{ index: 0 }], uniqueConstraints: [{ columns: [1] }] });
		expect(provesAtMostOne(t, [constraint(1)])).to.equal(true);
	});

	it('proves a UNIQUE index carried on the schema alone', () => {
		const t = schema({
			columns: [col('a'), col('b')], primaryKeyDefinition: [{ index: 0 }],
			indexes: [{ name: 'ux', columns: [{ index: 1 }], unique: true }],
		});
		expect(provesAtMostOne(t, [constraint(1)])).to.equal(true);
	});

	it('declines a partial UNIQUE constraint and a partial UNIQUE index', () => {
		const where = { type: 'literal', value: 1 } as AST.LiteralExpr;
		const t = schema({
			columns: [col('a'), col('b')], primaryKeyDefinition: [{ index: 0 }],
			uniqueConstraints: [{ columns: [1], predicate: where }],
			indexes: [{ name: 'ux', columns: [{ index: 1 }], unique: true, predicate: where }],
		});
		expect(provesAtMostOne(t, [constraint(1)])).to.equal(false);
	});

	it('declines a non-unique index', () => {
		const t = schema({
			columns: [col('a'), col('b')], primaryKeyDefinition: [{ index: 0 }],
			indexes: [{ name: 'ix', columns: [{ index: 1 }] }],
		});
		expect(provesAtMostOne(t, [constraint(1)])).to.equal(false);
	});

	it('declines a range constraint on a key column', () => {
		const t = schema({ columns: [col('a')], primaryKeyDefinition: [{ index: 0 }] });
		expect(provesAtMostOne(t, [constraint(0, undefined, '>=')])).to.equal(false);
	});

	it('declines a predicate collation coarser than the key (NOCASE over BINARY)', () => {
		// The column is declared BINARY (no collation) but the reference compares
		// NOCASE — what a NOCASE outer join key resolves to through the lattice.
		const t = schema({ columns: [col('a')], primaryKeyDefinition: [{ index: 0 }] });
		expect(provesAtMostOne(t, [constraint(0, 'NOCASE')])).to.equal(false);
	});

	it('accepts an equal collation (NOCASE predicate over a NOCASE key)', () => {
		const t = schema({ columns: [col('a', 'NOCASE')], primaryKeyDefinition: [{ index: 0 }] });
		expect(provesAtMostOne(t, [constraint(0, 'NOCASE')])).to.equal(true);
	});

	it('accepts a BINARY predicate over a NOCASE key (finer than the key)', () => {
		const t = schema({ columns: [col('a', 'NOCASE')], primaryKeyDefinition: [{ index: 0 }] });
		expect(provesAtMostOne(t, [constraint(0)])).to.equal(true);
	});

	it('reads an index-derived UNIQUE constraint under the index column collation', () => {
		// `create unique index ux on t(b collate nocase)`: uniqueness is enforced
		// NOCASE even though column `b` is declared BINARY. A BINARY predicate is
		// finer and proves; a NOCASE predicate is equal and proves; an RTRIM
		// predicate is incomparable and declines.
		const t = schema({
			columns: [col('a'), col('b')], primaryKeyDefinition: [{ index: 0 }],
			uniqueConstraints: [{ columns: [1], derivedFromIndex: 'ux' }],
			indexes: [{ name: 'ux', columns: [{ index: 1, collation: 'NOCASE' }], unique: true }],
		});
		expect(provesAtMostOne(t, [constraint(1)])).to.equal(true);
		expect(provesAtMostOne(t, [constraint(1, 'NOCASE')])).to.equal(true);
		expect(provesAtMostOne(t, [constraint(1, 'RTRIM')])).to.equal(false);
	});

	it('declines with no equalities at all', () => {
		const t = schema({ columns: [col('a')], primaryKeyDefinition: [{ index: 0 }] });
		expect(provesAtMostOne(t, [])).to.equal(false);
	});

	it('declines a non-deterministic value side (re-evaluated per row by a Filter)', () => {
		const t = schema({ columns: [col('a')], primaryKeyDefinition: [{ index: 0 }] });
		const c = constraint(0);
		const nonDet = { physical: { deterministic: false } } as unknown as ScalarPlanNode;
		expect(provesAtMostOne(t, [{ ...c, valueExpr: nonDet, bindingKind: 'expression' }])).to.equal(false);
	});
});

describe('batchedIndexNestedLoopJoinCost', () => {
	it('divides only the latency term and agrees with the serial formula at one in flight', () => {
		expect(batchedIndexNestedLoopJoinCost(100, 1, 25, 1)).to.equal(indexNestedLoopJoinCost(100, 1, 25));
		expect(batchedIndexNestedLoopJoinCost(100, 1, 0, 16)).to.equal(indexNestedLoopJoinCost(100, 1, 0));
		expect(batchedIndexNestedLoopJoinCost(100, 1, 25, 16)).to.be.closeTo(100 * (1 + 0.5 + 0.3 + 25 / 16), 1e-9);
	});

	it('guards a zero in-flight count', () => {
		expect(batchedIndexNestedLoopJoinCost(100, 1, 25, 0)).to.equal(indexNestedLoopJoinCost(100, 1, 25));
	});
});
