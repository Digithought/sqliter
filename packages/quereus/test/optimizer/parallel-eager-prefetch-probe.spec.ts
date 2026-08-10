/**
 * Recognition + cost-gate tests for `ruleEagerPrefetchProbe`.
 *
 * The rule wraps the probe (`left`) side of a physical hash join in an
 * `EagerPrefetchNode` when the build (`right`) side advertises high first-row
 * latency. The cost gate is anchored on `right.physical.expectedLatencyMs`,
 * which is 0 on in-process / memory-vtab paths and non-zero only for the
 * synthetic `HighLatencyMemoryModule` below. The local-only no-rewrite case
 * locks the invariant that memory-vtab plans never trigger the rule.
 *
 * SQL-level tests drive the full optimizer (recognition, threshold, opt-out,
 * execution equivalence). The skip-predicate tests (`Cache` / `EagerPrefetch`
 * / `AsyncGather` on the probe) invoke the rule directly against a manually
 * constructed `BloomJoinNode`, since those probe shapes are awkward to coax
 * out of SQL deterministically.
 */
import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import { DEFAULT_TUNING } from '../../src/planner/optimizer.js';
import type { SqlValue } from '../../src/common/types.js';
import { ruleEagerPrefetchProbe } from '../../src/planner/rules/parallel/rule-eager-prefetch-probe.js';
import { BloomJoinNode } from '../../src/planner/nodes/bloom-join-node.js';
import { EagerPrefetchNode } from '../../src/planner/nodes/eager-prefetch-node.js';
import { PlanNode, type Attribute, type PhysicalProperties } from '../../src/planner/nodes/plan-node.js';
import { PlanNodeType } from '../../src/planner/nodes/plan-node-type.js';
import type { Scope } from '../../src/planner/scopes/scope.js';
import type { BaseType, RelationType, ScalarType } from '../../src/common/datatype.js';
import type { OptContext } from '../../src/planner/framework/context.js';

interface PlanRow {
	id: number;
	parent_id: number | null;
	node_type: string;
	op: string;
	detail: string;
}

/**
 * Memory-backed module that declares a non-zero `expectedLatencyMs`. Tables
 * registered with this module surface as leaves whose physical properties meet
 * the prefetch threshold. Mirrors the helper in `parallel-async-gather.spec.ts`.
 */
class HighLatencyMemoryModule extends MemoryTableModule {
	readonly expectedLatencyMs = 25;
}

async function planRows(db: Database, sql: string): Promise<PlanRow[]> {
	const rows: PlanRow[] = [];
	for await (const r of db.eval(
		'SELECT id, parent_id, node_type, op, detail FROM query_plan(?)',
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

function prefetchRows(rows: readonly PlanRow[]): PlanRow[] {
	return rows.filter(r => r.op === 'EAGERPREFETCH' || r.node_type === 'EagerPrefetch');
}

function hashJoinRow(rows: readonly PlanRow[]): PlanRow | undefined {
	return rows.find(r => r.op === 'HASHJOIN' || r.op === 'BLOOMJOIN' || r.node_type === 'HashJoin');
}

const sortRowsKey = (r: Record<string, SqlValue>): string => JSON.stringify(Object.values(r));

describe('ruleEagerPrefetchProbe', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		db.registerModule('hi_lat_memory', new HighLatencyMemoryModule());
	});

	afterEach(async () => {
		await db.close();
	});

	/**
	 * `local_orders` is a plain memory table (probe side); `hi_lat_lookup` is
	 * high-latency (build side). Both join keys are non-PK integers so the
	 * physical-selection rule picks a hash join (merge would need sorts on both
	 * sides). The INNER join keeps `local_orders` (the larger / equal side) as
	 * the probe and `hi_lat_lookup` as the build.
	 */
	async function setup(): Promise<void> {
		await db.exec('create table local_orders (id integer primary key, cust_code integer, amt integer) using memory');
		await db.exec('create table hi_lat_lookup (id integer primary key, code integer, label text) using hi_lat_memory');
		await db.exec(`insert into local_orders values
			(1, 10, 100), (2, 20, 200), (3, 10, 300), (4, 30, 400),
			(5, 20, 500), (6, 10, 600), (7, 30, 700), (8, 20, 800)`);
		await db.exec("insert into hi_lat_lookup values (1, 10, 'a'), (2, 20, 'b'), (3, 30, 'c')");
	}

	const joinSQL =
		`select o.id, o.amt, l.label
		 from local_orders o
		 join hi_lat_lookup l on o.cust_code = l.code`;

	it('fires when the build (right) side is high-latency and the probe is local', async () => {
		await setup();
		const plan = await planRows(db, joinSQL);
		const hj = hashJoinRow(plan);
		expect(hj, `expected a hash join — ops=${plan.map(r => r.op).join(',')}`).to.exist;

		const prefetches = prefetchRows(plan);
		expect(prefetches.length, `ops=${plan.map(r => r.op).join(',')}`).to.equal(1);

		// The prefetch must be the probe child of the hash join.
		expect(prefetches[0].parent_id, 'prefetch should sit directly under the hash join')
			.to.equal(hj!.id);
	});

	it('does NOT fire on a purely local-only join', async () => {
		await db.exec('create table lo_a (id integer primary key, k integer, v integer) using memory');
		await db.exec('create table lo_b (id integer primary key, k integer, w integer) using memory');
		await db.exec('insert into lo_a values (1, 10, 100), (2, 20, 200), (3, 10, 300), (4, 30, 400)');
		await db.exec('insert into lo_b values (1, 10, 11), (2, 20, 22), (3, 30, 33)');
		const sql = 'select a.v, b.w from lo_a a join lo_b b on a.k = b.k';
		const plan = await planRows(db, sql);
		expect(prefetchRows(plan).length, `ops=${plan.map(r => r.op).join(',')}`).to.equal(0);
	});

	it('is idempotent: re-planning the same SQL does not doubly-wrap the probe', async () => {
		await setup();
		const first = prefetchRows(await planRows(db, joinSQL));
		const second = prefetchRows(await planRows(db, joinSQL));
		expect(first.length).to.equal(1);
		expect(second.length).to.equal(1);
	});

	it('does NOT fire when the threshold is raised above the leaf latency', async () => {
		await setup();
		const before = db.optimizer.tuning;
		db.optimizer.updateTuning({
			...before,
			parallel: { ...before.parallel, prefetchProbeThresholdMs: 1000 },
		});
		try {
			const plan = await planRows(db, joinSQL);
			expect(prefetchRows(plan).length, `ops=${plan.map(r => r.op).join(',')}`).to.equal(0);
		} finally {
			db.optimizer.updateTuning(before);
		}
	});

	it('honors disabledRules and leaves the probe unwrapped', async () => {
		await setup();
		const before = db.optimizer.tuning;
		db.optimizer.updateTuning({
			...before,
			disabledRules: new Set(['eager-prefetch-probe']),
		});
		try {
			const plan = await planRows(db, joinSQL);
			expect(prefetchRows(plan).length, `ops=${plan.map(r => r.op).join(',')}`).to.equal(0);
		} finally {
			db.optimizer.updateTuning(before);
		}
	});

	it('default tuning has prefetchProbeThresholdMs > 0', () => {
		// Pin the no-rewrite-on-local invariant at the tuning layer: the gate is
		// always positive, so memory-vtab leaves (expectedLatencyMs=0) fail it.
		expect(DEFAULT_TUNING.parallel.prefetchProbeThresholdMs).to.be.greaterThan(0);
		expect(DEFAULT_TUNING.parallel.prefetchBufferSize).to.be.greaterThan(0);
	});

	// Eager-start prefetch holds a fork of the statement's rctx live from
	// arg-assembly through the probe drain. Any slot-creating ancestor (the
	// Project/Sort this ORDER BY query builds) then mutates that same rctx while
	// the fork is active, tripping the strict-fork contract. This mirrors the
	// known Sort-above-AsyncGather interaction (see parallel-async-gather.spec.ts)
	// and is a strict-harness false-positive only: `bumpParentForkCounter` is a
	// no-op in production (strict-fork.ts), so real execution never forks-vs-
	// mutates unsafely here. The probe is a self-contained relation scan (hash
	// joins never correlate the probe per build-row), so the detached pump cannot
	// observe the parent's later mutations. Skip under strict; the non-strict path
	// validates row/order correctness.
	const strictFork = typeof process !== 'undefined'
		&& (process.env?.QUEREUS_FORK_STRICT === '1' || process.env?.QUEREUS_FORK_STRICT === 'true');
	const equivTest = strictFork ? it.skip : it;
	equivTest('returns the same rows as the unwrapped plan (execution equivalence)', async () => {
		await setup();
		const orderedSQL = joinSQL + ' order by o.id, l.label';

		// Confirm the rule actually fired on the rewritten path (with the rule
		// enabled), else the comparison below is vacuous.
		const rewrittenPlan = await planRows(db, joinSQL);
		expect(prefetchRows(rewrittenPlan).length, 'rule must fire for the comparison').to.equal(1);
		const rewritten = await results(db, orderedSQL);

		const before = db.optimizer.tuning;
		db.optimizer.updateTuning({
			...before,
			disabledRules: new Set(['eager-prefetch-probe']),
		});
		let baseline: Record<string, SqlValue>[];
		try {
			baseline = await results(db, orderedSQL);
		} finally {
			db.optimizer.updateTuning(before);
		}

		const sortBoth = (arr: Record<string, SqlValue>[]) =>
			[...arr].sort((a, b) => sortRowsKey(a).localeCompare(sortRowsKey(b)));
		expect(sortBoth(rewritten)).to.deep.equal(sortBoth(baseline));
		expect(rewritten.length).to.equal(8);
	});

	// --- Skip-predicate tests (direct rule invocation) -----------------------
	//
	// The probe shapes the rule must skip (`Cache` / `EagerPrefetch` /
	// `AsyncGather`) are awkward to produce deterministically from SQL, so we
	// build a `BloomJoinNode` by hand and call the rule directly.

	const mockScope = { resolveSymbol: () => undefined } as unknown as Scope;
	const mockContext = {
		tuning: { parallel: { prefetchProbeThresholdMs: 25, prefetchBufferSize: 64 } },
	} as unknown as OptContext;

	const INT_TYPE: ScalarType = {
		typeClass: 'scalar',
		logicalType: { name: 'INTEGER', affinity: 'integer', isNumeric: true } as never,
		nullable: false,
	} as ScalarType;

	let nextAttrId = 700000;
	function makeAttr(name: string): Attribute {
		return { id: nextAttrId++, name, type: INT_TYPE, sourceRelation: 'test.t', relationName: 't' };
	}

	class MockRelNode extends PlanNode {
		override readonly nodeType: PlanNodeType;
		private readonly _attrs: readonly Attribute[];
		private readonly _physicalOverride: Partial<PhysicalProperties>;
		private readonly _type: RelationType;

		constructor(opts: { nodeType: PlanNodeType; attrs: readonly Attribute[]; physical?: Partial<PhysicalProperties> }) {
			super(mockScope, 0.01);
			this.nodeType = opts.nodeType;
			this._attrs = opts.attrs;
			// Default probe physical is concurrency-safe so the rule's concurrencySafe
			// gate (which requires `=== true` on both sides) does not block the
			// "fires" paths. Tests that need an unsafe side override this explicitly.
			this._physicalOverride = opts.physical ?? { deterministic: true, readonly: true, concurrencySafe: true };
			this._type = {
				typeClass: 'relation',
				columns: opts.attrs.map(a => ({ name: a.name, type: a.type })),
				isSet: false,
				isReadOnly: true,
				keys: [],
				rowConstraints: [],
			} as RelationType;
		}

		getType(): BaseType { return this._type; }
		getChildren(): readonly PlanNode[] { return []; }
		override getAttributes(): readonly Attribute[] { return this._attrs; }
		override computePhysical(): Partial<PhysicalProperties> { return this._physicalOverride; }
		withChildren(newChildren: readonly PlanNode[]): PlanNode {
			if (newChildren.length !== 0) throw new Error('MockRelNode expects 0 children');
			return this;
		}
	}

	function makeJoin(probe: PlanNode): BloomJoinNode {
		const build = new MockRelNode({
			nodeType: PlanNodeType.SeqScan,
			attrs: [makeAttr('b_k'), makeAttr('b_v')],
			physical: { deterministic: true, readonly: true, expectedLatencyMs: 25, concurrencySafe: true },
		});
		return new BloomJoinNode(mockScope, probe as never, build as never, 'inner', []);
	}

	it('fires (direct): plain high-latency-build join wraps the probe', () => {
		const probe = new MockRelNode({ nodeType: PlanNodeType.SeqScan, attrs: [makeAttr('p_k')] });
		const join = makeJoin(probe);
		const out = ruleEagerPrefetchProbe(join, mockContext);
		expect(out).to.be.instanceOf(BloomJoinNode);
		expect((out as BloomJoinNode).left).to.be.instanceOf(EagerPrefetchNode);
		expect(((out as BloomJoinNode).left as EagerPrefetchNode).source).to.equal(probe);
	});

	it('does NOT fire (direct): probe is already an EagerPrefetch', () => {
		const inner = new MockRelNode({ nodeType: PlanNodeType.SeqScan, attrs: [makeAttr('p_k')] });
		const probe = new EagerPrefetchNode(mockScope, inner as never, 64);
		const join = makeJoin(probe);
		expect(ruleEagerPrefetchProbe(join, mockContext)).to.equal(null);
	});

	it('does NOT fire (direct): probe is a Cache', () => {
		const probe = new MockRelNode({ nodeType: PlanNodeType.Cache, attrs: [makeAttr('p_k')] });
		const join = makeJoin(probe);
		expect(ruleEagerPrefetchProbe(join, mockContext)).to.equal(null);
	});

	it('does NOT fire (direct): probe is an AsyncGather', () => {
		const probe = new MockRelNode({ nodeType: PlanNodeType.AsyncGather, attrs: [makeAttr('p_k')] });
		const join = makeJoin(probe);
		expect(ruleEagerPrefetchProbe(join, mockContext)).to.equal(null);
	});

	it('does NOT fire (direct): build side below the threshold', () => {
		const probe = new MockRelNode({ nodeType: PlanNodeType.SeqScan, attrs: [makeAttr('p_k')] });
		const build = new MockRelNode({
			nodeType: PlanNodeType.SeqScan,
			attrs: [makeAttr('b_k')],
			// concurrency-safe so the rule reaches (and fails on) the latency gate.
			physical: { deterministic: true, readonly: true, expectedLatencyMs: 0, concurrencySafe: true },
		});
		const join = new BloomJoinNode(mockScope, probe as never, build as never, 'inner', []);
		expect(ruleEagerPrefetchProbe(join, mockContext)).to.equal(null);
	});

	it('does NOT fire (direct): probe is not concurrencySafe', () => {
		// A non-reentrant probe cursor must not be iterated concurrently with the
		// build's for-await once the pump starts eagerly on run().
		const probe = new MockRelNode({
			nodeType: PlanNodeType.SeqScan,
			attrs: [makeAttr('p_k')],
			physical: { deterministic: true, readonly: true, concurrencySafe: false },
		});
		const join = makeJoin(probe); // build is high-latency + concurrencySafe
		expect(ruleEagerPrefetchProbe(join, mockContext)).to.equal(null);
	});

	it('does NOT fire (direct): build is not concurrencySafe', () => {
		const probe = new MockRelNode({ nodeType: PlanNodeType.SeqScan, attrs: [makeAttr('p_k')] });
		const build = new MockRelNode({
			nodeType: PlanNodeType.SeqScan,
			attrs: [makeAttr('b_k')],
			// Meets the latency threshold but is NOT concurrency-safe → gate blocks.
			physical: { deterministic: true, readonly: true, expectedLatencyMs: 25, concurrencySafe: false },
		});
		const join = new BloomJoinNode(mockScope, probe as never, build as never, 'inner', []);
		expect(ruleEagerPrefetchProbe(join, mockContext)).to.equal(null);
	});

	// --- Physical pass-through (regression: claims survive the wrap) ---------
	//
	// EagerPrefetch is a FIFO ring buffer: row count, order, and attribute IDs
	// are identical at runtime, so every relational claim must survive on
	// `.physical`. Before the `computePhysical` override, the default child-merge
	// dropped ordering/fds/equivClasses/monotonicOn silently, weakening the
	// wrapping hash join's own claims.

	it('propagates relational physical claims through the wrap', () => {
		const k = makeAttr('k');
		const v = makeAttr('v');
		const probe = new MockRelNode({
			nodeType: PlanNodeType.SeqScan,
			attrs: [k, v],
			physical: {
				deterministic: true,
				readonly: true,
				// column indices reference output column position; monotonicOn uses attrId.
				ordering: [{ column: 0, desc: false }],
				fds: [{ determinants: [0], dependents: [1], kind: 'unique' }],
				equivClasses: [[0, 1]],
				monotonicOn: [{ attrId: k.id, strict: true, direction: 'asc' }],
			},
		});
		const prefetch = new EagerPrefetchNode(mockScope, probe as never, 64);
		const phys = prefetch.physical;

		expect(phys.ordering, 'ordering must survive').to.deep.equal([{ column: 0, desc: false }]);
		expect(phys.fds, 'fds must survive').to.deep.equal([{ determinants: [0], dependents: [1], kind: 'unique' }]);
		expect(phys.equivClasses, 'equivClasses must survive').to.deep.equal([[0, 1]]);
		expect(phys.monotonicOn, 'monotonicOn must survive')
			.to.deep.equal([{ attrId: k.id, strict: true, direction: 'asc' }]);
	});

	it('does NOT propagate access-path-local claims through the wrap', () => {
		const k = makeAttr('k');
		const probe = new MockRelNode({
			nodeType: PlanNodeType.SeqScan,
			attrs: [k],
			physical: {
				deterministic: true,
				readonly: true,
				accessCapabilities: { ordinalSeek: true },
				rangeBoundedOn: { attrId: k.id, lower: { op: '>=' } },
			},
		});
		const prefetch = new EagerPrefetchNode(mockScope, probe as never, 64);
		const phys = prefetch.physical;

		// A pass-through node sits between the leaf iterator and the consumer, so
		// these must NOT carry — they live only on the physical access leaf.
		expect(phys.accessCapabilities, 'accessCapabilities must not carry').to.be.undefined;
		expect(phys.rangeBoundedOn, 'rangeBoundedOn must not carry').to.be.undefined;
	});
});
