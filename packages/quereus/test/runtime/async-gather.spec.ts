import { expect } from 'chai';
import {
	runUnionAll,
	runCrossProduct,
	runZipByKey,
	cartesianProduct,
} from '../../src/runtime/emit/async-gather.js';
import { createCollationRowComparator, BINARY_COLLATION, NOCASE_COLLATION } from '../../src/util/comparison.js';
import { AsyncGatherNode } from '../../src/planner/nodes/async-gather-node.js';
import { PlanNode, type Attribute, type RelationalPlanNode, type PhysicalProperties } from '../../src/planner/nodes/plan-node.js';
import { PlanNodeType } from '../../src/planner/nodes/plan-node-type.js';
import type { RelationType, ColRef, ColumnDef } from '../../src/common/datatype.js';
import type { Scope } from '../../src/planner/scopes/scope.js';
import { validatePhysicalTree } from '../../src/planner/validation/plan-validator.js';
import { QuereusError } from '../../src/common/errors.js';
import { RowContextMap, createRowSlot } from '../../src/runtime/context-helpers.js';
import { createStrictRowContextMap, wrapTableContextsStrict } from '../../src/runtime/strict-fork.js';
import type { RuntimeContext } from '../../src/runtime/types.js';
import type { Row } from '../../src/common/types.js';
import type { RowDescriptor } from '../../src/planner/nodes/plan-node.js';
import {
	ConcurrencyTracker,
	controllableSource,
	makeDeferred,
	type Deferred,
	type SourceEvent,
} from '../util/controllable-source.js';

const mockScope = { resolveSymbol: () => undefined } as unknown as Scope;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function makeRuntimeContext(): RuntimeContext {
	return {
		db: undefined as unknown as RuntimeContext['db'],
		stmt: undefined,
		params: {},
		context: new RowContextMap(),
		tableContexts: new Map(),
		enableMetrics: false,
	};
}

function makeStrictRuntimeContext(): RuntimeContext {
	return {
		db: undefined as unknown as RuntimeContext['db'],
		stmt: undefined,
		params: {},
		context: createStrictRowContextMap(),
		tableContexts: wrapTableContextsStrict(new Map()),
		enableMetrics: false,
	};
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of iter) out.push(item);
	return out;
}

let attrIdCounter = 700000;
function makeAttr(name: string, sourceRelation = 'test.t'): Attribute {
	return {
		id: attrIdCounter++,
		name,
		type: {
			typeClass: 'scalar',
			logicalType: { name: 'TEXT', affinity: 'text' } as never,
			nullable: false,
			isReadOnly: false,
		},
		sourceRelation,
	};
}

/**
 * Build an attribute with an explicit id and physical-type code, for zipByKey
 * key-column tests where a specific per-branch key id, nullability, and/or an
 * affinity mismatch across branches must be exercised deliberately.
 */
function makeKeyAttr(id: number, name: string, physicalType: number, nullable = false): Attribute {
	return {
		id,
		name,
		type: {
			typeClass: 'scalar',
			logicalType: { name, physicalType } as never,
			nullable,
			isReadOnly: false,
		},
		sourceRelation: 'test.t',
	};
}

/**
 * Minimal RelationalPlanNode mock for unit-testing AsyncGatherNode. Carries
 * a per-instance attribute list, column count, key list, and optional
 * physical-property override. The mock is a leaf — getChildren() returns
 * empty so validator traversal terminates here.
 */
class MockRelationalNode extends PlanNode implements RelationalPlanNode {
	override readonly nodeType: PlanNodeType = PlanNodeType.SeqScan;
	constructor(
		private readonly _attrs: readonly Attribute[],
		private readonly _keys: ColRef[][] = [],
		private readonly _physicalOverride: Partial<PhysicalProperties> = { deterministic: true, readonly: true },
		private readonly _columnsOverride?: ColumnDef[],
	) {
		super(mockScope, 0.1);
	}

	getType(): RelationType {
		const columns: ColumnDef[] = this._columnsOverride ?? this._attrs.map(a => ({
			name: a.name,
			type: a.type,
		}));
		return {
			typeClass: 'relation',
			columns,
			isSet: false,
			isReadOnly: true,
			keys: this._keys,
			rowConstraints: [],
		} as RelationType;
	}
	getAttributes(): readonly Attribute[] { return this._attrs; }
	getChildren(): readonly PlanNode[] { return []; }
	getRelations(): readonly RelationalPlanNode[] { return []; }
	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 0) throw new Error('mock relational has no children');
		return this;
	}
	override computePhysical(_children: readonly PhysicalProperties[]): Partial<PhysicalProperties> {
		return this._physicalOverride;
	}
}

function rowSource(rows: Row[], delayMs = 0): (innerCtx: RuntimeContext) => AsyncIterable<Row> {
	return (_inner: RuntimeContext): AsyncIterable<Row> => (async function* () {
		for (const r of rows) {
			if (delayMs > 0) await sleep(delayMs);
			yield r;
		}
	})();
}

/**
 * Single-row gated source for concurrency proofs. The branch parks at a gate
 * (reporting into `tracker`) until released, so a test can assert how many
 * branches are simultaneously in-flight without any wall-clock.
 */
function gatedSingleRow(
	row: Row,
	tracker: ConcurrencyTracker,
	gate: Deferred,
): (innerCtx: RuntimeContext) => AsyncIterable<Row> {
	return controllableSource({ rows: [row], tracker, gates: [gate] }).factory;
}

describe('AsyncGather', () => {
	describe('node construction', () => {
		it('rejects N < 2 children', () => {
			expect(() => new AsyncGatherNode(mockScope, [], { kind: 'unionAll' }, 4))
				.to.throw(QuereusError, /requires >= 2/);
			const oneChild = new MockRelationalNode([makeAttr('c0')]);
			expect(() => new AsyncGatherNode(mockScope, [oneChild], { kind: 'unionAll' }, 4))
				.to.throw(QuereusError, /requires >= 2/);
		});

		it('rejects unionAll with mismatched column counts', () => {
			const left = new MockRelationalNode([makeAttr('a'), makeAttr('b')]);
			const right = new MockRelationalNode([makeAttr('x')]);
			expect(() => new AsyncGatherNode(mockScope, [left, right], { kind: 'unionAll' }, 4))
				.to.throw(QuereusError, /column count mismatch/);
		});

		it('rejects non-positive concurrencyCap', () => {
			const a = new MockRelationalNode([makeAttr('c0')]);
			const b = new MockRelationalNode([makeAttr('c0')]);
			expect(() => new AsyncGatherNode(mockScope, [a, b], { kind: 'unionAll' }, 0))
				.to.throw(QuereusError, /concurrencyCap/);
			expect(() => new AsyncGatherNode(mockScope, [a, b], { kind: 'unionAll' }, 1.5))
				.to.throw(QuereusError, /concurrencyCap/);
		});

		it('unionAll preserves children[0] attribute IDs', () => {
			const leftAttrs = [makeAttr('a'), makeAttr('b')];
			const left = new MockRelationalNode(leftAttrs);
			const right = new MockRelationalNode([makeAttr('x'), makeAttr('y')]);
			const node = new AsyncGatherNode(mockScope, [left, right], { kind: 'unionAll' }, 4);
			expect(node.getAttributes().map(a => a.id)).to.deep.equal(leftAttrs.map(a => a.id));
		});

		it('crossProduct concatenates children attributes verbatim', () => {
			const a = makeAttr('a'); const b = makeAttr('b');
			const x = makeAttr('x'); const y = makeAttr('y'); const z = makeAttr('z');
			const left = new MockRelationalNode([a, b]);
			const right = new MockRelationalNode([x, y, z]);
			const node = new AsyncGatherNode(mockScope, [left, right], { kind: 'crossProduct' }, 4);
			expect(node.getAttributes().map(a => a.id)).to.deep.equal([a.id, b.id, x.id, y.id, z.id]);
		});

		it('crossProduct keys are the Cartesian product of children keys', () => {
			const left = new MockRelationalNode([makeAttr('a'), makeAttr('b')], [[{ index: 0 }]]);
			const right = new MockRelationalNode([makeAttr('x'), makeAttr('y')], [[{ index: 0 }]]);
			const node = new AsyncGatherNode(mockScope, [left, right], { kind: 'crossProduct' }, 4);
			const keys = node.getType().keys;
			expect(keys).to.have.lengthOf(1);
			expect(keys[0].map(c => c.index)).to.deep.equal([0, 2]);
		});

		it('crossProduct keys are empty when any child has no key', () => {
			const left = new MockRelationalNode([makeAttr('a')], [[{ index: 0 }]]);
			const right = new MockRelationalNode([makeAttr('x')], []);
			const node = new AsyncGatherNode(mockScope, [left, right], { kind: 'crossProduct' }, 4);
			expect(node.getType().keys).to.deep.equal([]);
		});

		it('unionAll drops keys/FDs in physical properties', () => {
			const a = new MockRelationalNode(
				[makeAttr('c0')],
				[[{ index: 0 }]],
				{ deterministic: true, readonly: true, fds: [{ determinants: [], dependents: [0], kind: 'unique' }] },
			);
			const b = new MockRelationalNode(
				[makeAttr('c0')],
				[[{ index: 0 }]],
				{ deterministic: true, readonly: true, fds: [{ determinants: [], dependents: [0], kind: 'unique' }] },
			);
			const node = new AsyncGatherNode(mockScope, [a, b], { kind: 'unionAll' }, 4);
			const phys = node.physical;
			expect(phys.fds).to.equal(undefined);
			expect(phys.equivClasses).to.equal(undefined);
			expect(phys.constantBindings).to.equal(undefined);
			expect(phys.domainConstraints).to.equal(undefined);
			expect(phys.ordering).to.equal(undefined);
		});

		it('crossProduct folds child FDs with shifted column indices', () => {
			const a = new MockRelationalNode(
				[makeAttr('a0'), makeAttr('a1')],
				[],
				{ deterministic: true, readonly: true, fds: [{ determinants: [0], dependents: [1], kind: 'determination' }] },
			);
			const b = new MockRelationalNode(
				[makeAttr('b0'), makeAttr('b1')],
				[],
				{ deterministic: true, readonly: true, fds: [{ determinants: [0], dependents: [1], kind: 'determination' }] },
			);
			const node = new AsyncGatherNode(mockScope, [a, b], { kind: 'crossProduct' }, 4);
			const phys = node.physical;
			expect(phys.fds).to.not.equal(undefined);
			const fds = phys.fds!;
			// Expect FD on [0]→[1] (from a) and on [2]→[3] (from b, shifted by 2 cols).
			const has01 = fds.some(f => f.determinants.length === 1 && f.determinants[0] === 0 && f.dependents.includes(1));
			const has23 = fds.some(f => f.determinants.length === 1 && f.determinants[0] === 2 && f.dependents.includes(3));
			expect(has01).to.equal(true, 'left child FD must propagate');
			expect(has23).to.equal(true, 'right child FD must propagate with shifted indices');
		});

		it("crossProduct downgrades a child's 'unique' FDs when another child fans it out", () => {
			// Neither child is provably ≤1-row, so the product duplicates both
			// children's rows — every 'unique' claim must downgrade to
			// 'determination' (the value claim survives unchanged).
			const a = new MockRelationalNode(
				[makeAttr('a0'), makeAttr('a1')],
				[],
				{ deterministic: true, readonly: true, fds: [{ determinants: [0], dependents: [1], kind: 'unique' }] },
			);
			const b = new MockRelationalNode(
				[makeAttr('b0'), makeAttr('b1')],
				[],
				{ deterministic: true, readonly: true, fds: [{ determinants: [0], dependents: [1], kind: 'unique' }] },
			);
			const node = new AsyncGatherNode(mockScope, [a, b], { kind: 'crossProduct' }, 4);
			const fds = node.physical.fds!;
			for (const fd of fds) {
				expect(fd.kind).to.equal('determination');
			}
		});

		it("crossProduct keeps a child's 'unique' FDs when every other child is ≤1-row", () => {
			// Child b carries the singleton FD `∅ → all_cols` (provably ≤1 row), so
			// child a's rows are never duplicated and a's 'unique' claim survives.
			// The reverse does NOT hold: a is not a singleton, so b's rows ARE
			// duplicated and b's own singleton claim must downgrade.
			const a = new MockRelationalNode(
				[makeAttr('a0'), makeAttr('a1')],
				[],
				{ deterministic: true, readonly: true, fds: [{ determinants: [0], dependents: [1], kind: 'unique' }] },
			);
			const b = new MockRelationalNode(
				[makeAttr('b0')],
				[],
				{ deterministic: true, readonly: true, fds: [{ determinants: [], dependents: [0], kind: 'unique' }] },
			);
			const node = new AsyncGatherNode(mockScope, [a, b], { kind: 'crossProduct' }, 4);
			const fds = node.physical.fds!;
			const aFd = fds.find(f => f.determinants.length === 1 && f.determinants[0] === 0);
			const bFd = fds.find(f => f.determinants.length === 0);
			expect(aFd, "a's FD propagates").to.not.equal(undefined);
			expect(aFd!.kind, "a keeps 'unique' (b is ≤1-row)").to.equal('unique');
			expect(bFd, "b's FD propagates").to.not.equal(undefined);
			expect(bFd!.kind, "b downgrades (a fans it out)").to.equal('determination');
		});

		it("crossProduct requires EVERY other child to be ≤1-row, not just one (3 children)", () => {
			// a's siblings are b (singleton) and c (not provably ≤1-row): one
			// singleton sibling is not enough — c still fans a out, so a's 'unique'
			// claim must downgrade. Pins the `.every` quantifier in the fold (a
			// 2-child fixture cannot distinguish every-other from some-other).
			const a = new MockRelationalNode(
				[makeAttr('a0'), makeAttr('a1')],
				[],
				{ deterministic: true, readonly: true, fds: [{ determinants: [0], dependents: [1], kind: 'unique' }] },
			);
			const b = new MockRelationalNode(
				[makeAttr('b0')],
				[],
				{ deterministic: true, readonly: true, fds: [{ determinants: [], dependents: [0], kind: 'unique' }] },
			);
			const c = new MockRelationalNode(
				[makeAttr('c0')],
				[],
				{ deterministic: true, readonly: true },
			);
			const node = new AsyncGatherNode(mockScope, [a, b, c], { kind: 'crossProduct' }, 4);
			const fds = node.physical.fds!;
			for (const fd of fds) {
				expect(fd.kind, `FD over [${fd.determinants}]→[${fd.dependents}] must downgrade`).to.equal('determination');
			}
		});

		it('withChildren arity-checks against original length', () => {
			const a = new MockRelationalNode([makeAttr('c0')]);
			const b = new MockRelationalNode([makeAttr('c0')]);
			const node = new AsyncGatherNode(mockScope, [a, b], { kind: 'unionAll' }, 4);
			expect(() => node.withChildren([a])).to.throw(QuereusError, /expects 2 children/);
		});

		it('withChildren returns this when children unchanged', () => {
			const a = new MockRelationalNode([makeAttr('c0')]);
			const b = new MockRelationalNode([makeAttr('c0')]);
			const node = new AsyncGatherNode(mockScope, [a, b], { kind: 'unionAll' }, 4);
			expect(node.withChildren([a, b])).to.equal(node);
		});

		it('withChildren rebuilds preserving combinator + cap + preserveAttributeIds', () => {
			const a = new MockRelationalNode([makeAttr('c0')]);
			const b = new MockRelationalNode([makeAttr('c0')]);
			const c = new MockRelationalNode([makeAttr('c0')]);
			const preserved = [makeAttr('preserved')];
			const node = new AsyncGatherNode(
				mockScope, [a, b], { kind: 'crossProduct' }, 7, preserved,
			);
			const rebuilt = node.withChildren([a, c]) as AsyncGatherNode;
			expect(rebuilt).to.not.equal(node);
			expect(rebuilt.combinator).to.deep.equal({ kind: 'crossProduct' });
			expect(rebuilt.concurrencyCap).to.equal(7);
			expect(rebuilt.preserveAttributeIds).to.equal(preserved);
		});

		it('zipByKey rejects empty branchKeyAttrs', () => {
			const a = new MockRelationalNode([makeAttr('k'), makeAttr('v1')]);
			const b = new MockRelationalNode([makeAttr('k2'), makeAttr('v2')]);
			expect(() => new AsyncGatherNode(mockScope, [a, b], { kind: 'zipByKey', branchKeyAttrs: [[], []], outputKeyAttrs: [] }, 4))
				.to.throw(QuereusError, /requires >= 1 key/);
		});

		it('zipByKey rejects a branch key attr absent from its branch', () => {
			const ka = makeAttr('ka');
			const a = new MockRelationalNode([ka, makeAttr('v1')]);
			const b = new MockRelationalNode([makeAttr('other'), makeAttr('v2')]);
			// branch 1's key ref names ka.id, which is not present in branch 1.
			expect(() => new AsyncGatherNode(mockScope, [a, b],
				{ kind: 'zipByKey', branchKeyAttrs: [[ka.id], [ka.id]], outputKeyAttrs: [PlanNode.nextAttrId()] }, 4))
				.to.throw(QuereusError, /not found in branch/);
		});

		it('zipByKey rejects an output key id that collides with a child attribute id', () => {
			const ka = makeAttr('ka');
			const kb = makeAttr('kb');
			const a = new MockRelationalNode([ka, makeAttr('v1')]);
			const b = new MockRelationalNode([kb, makeAttr('v2')]);
			// outputKeyAttrs reuses a branch id (ka.id) instead of minting a fresh one.
			expect(() => new AsyncGatherNode(mockScope, [a, b],
				{ kind: 'zipByKey', branchKeyAttrs: [[ka.id], [kb.id]], outputKeyAttrs: [ka.id] }, 4))
				.to.throw(QuereusError, /collides with a child attribute id/);
		});

		it('zipByKey rejects key column affinity disagreement across branches', () => {
			// Distinct per-branch key ids, but different physical storage class.
			const ka = makeKeyAttr(910001, 'k', 1 /* INTEGER */);
			const kb = makeKeyAttr(910002, 'k', 3 /* TEXT */);
			const a = new MockRelationalNode([ka, makeAttr('v1')]);
			const b = new MockRelationalNode([kb, makeAttr('v2')]);
			expect(() => new AsyncGatherNode(mockScope, [a, b],
				{ kind: 'zipByKey', branchKeyAttrs: [[910001], [910002]], outputKeyAttrs: [PlanNode.nextAttrId()] }, 4))
				.to.throw(QuereusError, /affinity mismatch/);
		});

		it('zipByKey rejects key column collation disagreement across branches', () => {
			// Same affinity (TEXT), but branch 1 declares a different collation.
			// The runtime comparator derives from branch 0 only, so a mismatch
			// would silently merge under the wrong collation — reject it.
			const ka = makeKeyAttr(911001, 'k', 3 /* TEXT */);
			const kbBase = makeKeyAttr(911002, 'k', 3 /* TEXT */);
			const kb = { ...kbBase, type: { ...kbBase.type, collationName: 'NOCASE' } };
			const a = new MockRelationalNode([ka, makeAttr('v1')]);
			const b = new MockRelationalNode([kb, makeAttr('v2')]);
			expect(() => new AsyncGatherNode(mockScope, [a, b],
				{ kind: 'zipByKey', branchKeyAttrs: [[911001], [911002]], outputKeyAttrs: [PlanNode.nextAttrId()] }, 4))
				.to.throw(QuereusError, /collation mismatch/);
		});

		it('zipByKey rejects duplicate ids within outputKeyAttrs', () => {
			// K=2 composite key, but both output positions reuse the same minted id.
			const ak0 = makeAttr('k0'); const ak1 = makeAttr('k1');
			const bk0 = makeAttr('k0'); const bk1 = makeAttr('k1');
			const a = new MockRelationalNode([ak0, ak1, makeAttr('a1')]);
			const b = new MockRelationalNode([bk0, bk1, makeAttr('b1')]);
			const dup = PlanNode.nextAttrId();
			expect(() => new AsyncGatherNode(mockScope, [a, b],
				{ kind: 'zipByKey', branchKeyAttrs: [[ak0.id, ak1.id], [bk0.id, bk1.id]], outputKeyAttrs: [dup, dup] }, 4))
				.to.throw(QuereusError, /duplicate id/);
		});

		it('zipByKey rejects branchKeyAttrs whose list count != branch count', () => {
			// Three key-ref lists supplied for a 2-branch gather (INTERNAL guard).
			const ka = makeAttr('ka');
			const kb = makeAttr('kb');
			const a = new MockRelationalNode([ka, makeAttr('v1')]);
			const b = new MockRelationalNode([kb, makeAttr('v2')]);
			expect(() => new AsyncGatherNode(mockScope, [a, b],
				{ kind: 'zipByKey', branchKeyAttrs: [[ka.id], [kb.id], [ka.id]], outputKeyAttrs: [PlanNode.nextAttrId()] }, 4))
				.to.throw(QuereusError, /branchKeyAttrs has 3 lists but there are 2 branches/);
		});

		it('zipByKey rejects branchKeyAttrs with inconsistent per-branch K', () => {
			// Branch 0 declares a 2-column key, branch 1 only 1 column.
			const ak0 = makeAttr('k0'); const ak1 = makeAttr('k1');
			const bk0 = makeAttr('k0');
			const a = new MockRelationalNode([ak0, ak1, makeAttr('a1')]);
			const b = new MockRelationalNode([bk0, makeAttr('b1')]);
			expect(() => new AsyncGatherNode(mockScope, [a, b],
				{ kind: 'zipByKey', branchKeyAttrs: [[ak0.id, ak1.id], [bk0.id]], outputKeyAttrs: [PlanNode.nextAttrId(), PlanNode.nextAttrId()] }, 4))
				.to.throw(QuereusError, /branch 1 has 1 key columns, expected 2/);
		});

		it('zipByKey output: key attrs first (minted outputKeyAttrs), then branch non-key attrs (nullable)', () => {
			const ka = makeAttr('ka');
			const kb = makeAttr('kb');
			const a1 = makeAttr('a1');
			const b1 = makeAttr('b1');
			const outK = PlanNode.nextAttrId();
			// Key sits at index 0 in branch A but index 1 in branch B (position-independent).
			const a = new MockRelationalNode([ka, a1]);
			const b = new MockRelationalNode([b1, kb]);
			const node = new AsyncGatherNode(mockScope, [a, b],
				{ kind: 'zipByKey', branchKeyAttrs: [[ka.id], [kb.id]], outputKeyAttrs: [outK] }, 4);
			// Output key column carries the minted id, not either branch's key id.
			expect(node.getAttributes().map(x => x.id)).to.deep.equal([outK, a1.id, b1.id]);
			const cols = node.getType().columns;
			expect(cols).to.have.lengthOf(3);
			// Key column is non-nullable (both branches non-nullable); non-key cols forced nullable.
			expect(cols[0].type.nullable).to.equal(false);
			expect(cols[1].type.nullable).to.equal(true, 'branch-A non-key must be nullable');
			expect(cols[2].type.nullable).to.equal(true, 'branch-B non-key must be nullable');
		});

		it('zipByKey key nullability is OR across branches', () => {
			// Branch B's key column is nullable → output key column nullable.
			const ka = makeKeyAttr(920001, 'k', 1 /* INTEGER */, false);
			const kb = makeKeyAttr(920002, 'k', 1 /* INTEGER */, true);
			const a = new MockRelationalNode([ka, makeAttr('a1')]);
			const b = new MockRelationalNode([kb, makeAttr('b1')]);
			const node = new AsyncGatherNode(mockScope, [a, b],
				{ kind: 'zipByKey', branchKeyAttrs: [[920001], [920002]], outputKeyAttrs: [PlanNode.nextAttrId()] }, 4);
			expect(node.getType().columns[0].type.nullable).to.equal(true);
		});

		it('zipByKey getType keys are [[0..K-1]] and isSet is false', () => {
			const ak0 = makeAttr('k0'); const ak1 = makeAttr('k1');
			const bk0 = makeAttr('k0'); const bk1 = makeAttr('k1');
			const a = new MockRelationalNode([ak0, ak1, makeAttr('a1')]);
			const b = new MockRelationalNode([bk0, bk1, makeAttr('b1')]);
			const node = new AsyncGatherNode(mockScope, [a, b],
				{ kind: 'zipByKey', branchKeyAttrs: [[ak0.id, ak1.id], [bk0.id, bk1.id]], outputKeyAttrs: [PlanNode.nextAttrId(), PlanNode.nextAttrId()] }, 4);
			expect(node.getType().keys).to.deep.equal([[{ index: 0 }, { index: 1 }]]);
			expect(node.getType().isSet).to.equal(false);
		});

		it('zipByKey drops fds/equivClasses/constantBindings/domainConstraints/ordering in physical', () => {
			const ka = makeAttr('ka');
			const kb = makeAttr('kb');
			const a = new MockRelationalNode(
				[ka, makeAttr('a1')],
				[[{ index: 0 }]],
				{ deterministic: true, readonly: true, fds: [{ determinants: [0], dependents: [1], kind: 'unique' }] },
			);
			const b = new MockRelationalNode(
				[kb, makeAttr('b1')],
				[[{ index: 0 }]],
				{ deterministic: true, readonly: true, fds: [{ determinants: [0], dependents: [1], kind: 'unique' }] },
			);
			const node = new AsyncGatherNode(mockScope, [a, b],
				{ kind: 'zipByKey', branchKeyAttrs: [[ka.id], [kb.id]], outputKeyAttrs: [PlanNode.nextAttrId()] }, 4);
			const phys = node.physical;
			expect(phys.fds).to.equal(undefined);
			expect(phys.equivClasses).to.equal(undefined);
			expect(phys.constantBindings).to.equal(undefined);
			expect(phys.domainConstraints).to.equal(undefined);
			expect(phys.ordering).to.equal(undefined);
		});

		it('zipByKey withChildren rebuilds preserving the combinator (incl. outputKeyAttrs)', () => {
			const ka = makeAttr('ka');
			const kb = makeAttr('kb');
			const a = new MockRelationalNode([ka, makeAttr('a1')]);
			const b = new MockRelationalNode([kb, makeAttr('b1')]);
			// Rebuilt branch-1 child must still carry the branch-1 key id (kb.id) so
			// the verbatim combinator's branchKeyAttrs[1] resolves.
			const c = new MockRelationalNode([kb, makeAttr('c1')]);
			const outK = PlanNode.nextAttrId();
			const node = new AsyncGatherNode(mockScope, [a, b],
				{ kind: 'zipByKey', branchKeyAttrs: [[ka.id], [kb.id]], outputKeyAttrs: [outK] }, 5);
			const rebuilt = node.withChildren([a, c]) as AsyncGatherNode;
			expect(rebuilt).to.not.equal(node);
			// Combinator (and its minted outputKeyAttrs) is passed verbatim — stable across rebuild.
			const reb = rebuilt.combinator as { kind: 'zipByKey'; outputKeyAttrs: readonly number[] };
			expect(reb.kind).to.equal('zipByKey');
			expect(reb.outputKeyAttrs).to.deep.equal([outK]);
			expect(rebuilt.concurrencyCap).to.equal(5);
		});
	});

	describe('validator pass-through', () => {
		it('passes full validation (attribute-preserving N-ary node)', () => {
			// AsyncGather is a physical node that forwards its children's attribute
			// IDs verbatim (crossProduct concatenates them). The attribute-provenance
			// surface recognizes this as forwarding, not duplication, so default
			// validation (validateAttributes: true) succeeds — no workaround needed.
			const leftA = makeAttr('a'); const leftB = makeAttr('b');
			const rightX = makeAttr('x'); const rightY = makeAttr('y');
			const left = new MockRelationalNode([leftA, leftB]);
			const right = new MockRelationalNode([rightX, rightY]);
			const node = new AsyncGatherNode(mockScope, [left, right], { kind: 'crossProduct' }, 4);
			expect(() => validatePhysicalTree(node)).to.not.throw();
		});

		it('zipByKey passes full validation (per-branch key refs + minted output key)', () => {
			// Provenance-clean by construction: each branch originates its own key
			// id (distinct ka/kb), and the gather mints a fresh outputKeyAttrs id
			// that appears in no child. The provenance walk records the gather as
			// the sole origin of the minted key and forwards each branch's non-key id.
			const ka = makeAttr('ka');
			const kb = makeAttr('kb');
			const left = new MockRelationalNode([ka, makeAttr('a')]);
			const right = new MockRelationalNode([kb, makeAttr('b')]);
			const node = new AsyncGatherNode(mockScope, [left, right],
				{ kind: 'zipByKey', branchKeyAttrs: [[ka.id], [kb.id]], outputKeyAttrs: [PlanNode.nextAttrId()] }, 4);
			expect(() => validatePhysicalTree(node)).to.not.throw();
		});
	});

	describe('unionAll runtime', () => {
		it('yields rows from every branch (multiset union)', async () => {
			const ctx = makeRuntimeContext();
			const factories = [
				rowSource([[1], [2], [3]]),
				rowSource([[4], [5], [6]]),
				rowSource([[7], [8], [9]]),
			];
			const out = await collect(runUnionAll(ctx, factories, 4));
			expect(out.map(r => r[0]).sort((a, b) => (a as number) - (b as number))).to.deep.equal([1, 2, 3, 4, 5, 6, 7, 8, 9]);
		});

		it('handles one empty branch', async () => {
			const ctx = makeRuntimeContext();
			const factories = [
				rowSource([[1], [2]]),
				rowSource([]),
				rowSource([[5]]),
			];
			const out = await collect(runUnionAll(ctx, factories, 4));
			expect(out.map(r => r[0]).sort((a, b) => (a as number) - (b as number))).to.deep.equal([1, 2, 5]);
		});

		it('handles all-empty branches', async () => {
			const ctx = makeRuntimeContext();
			const factories = [
				rowSource([]),
				rowSource([]),
			];
			const out = await collect(runUnionAll(ctx, factories, 4));
			expect(out).to.deep.equal([]);
		});

		it('drives branches concurrently with cap=N (peak in-flight reaches N)', async () => {
			const ctx = makeRuntimeContext();
			const n = 3;
			const tracker = new ConcurrencyTracker();
			const gates = Array.from({ length: n }, () => makeDeferred());
			const factories = gates.map((g, i) => gatedSingleRow([i + 1] as Row, tracker, g));

			const iter = runUnionAll(ctx, factories, n)[Symbol.asyncIterator]();
			const firstPull = iter.next();
			// All N branches park at their gate at once → cap=N admits true parallelism.
			await tracker.waitForInFlight(n);
			expect(tracker.peak).to.equal(n, 'cap=N must admit all branches concurrently');

			for (const g of gates) g.resolve();
			const out: Row[] = [];
			let r = await firstPull;
			while (!r.done) { out.push(r.value); r = await iter.next(); }
			expect(out).to.have.lengthOf(n);
		});

		it('cap=1 serializes branches (peak in-flight never exceeds 1)', async () => {
			const ctx = makeRuntimeContext();
			const n = 3;
			const tracker = new ConcurrencyTracker();
			const gates = Array.from({ length: n }, () => makeDeferred());
			const factories = gates.map((g, i) => gatedSingleRow([i] as Row, tracker, g));

			// Pre-release every gate: cap=1 forces the driver to admit branches strictly
			// one at a time regardless of gate readiness, so the peak in-flight the
			// tracker observes is the deterministic proof of serialization.
			for (const g of gates) g.resolve();
			const out = await collect(runUnionAll(ctx, factories, 1));
			expect(out).to.have.lengthOf(n);
			expect(tracker.peak).to.equal(1, 'cap=1 must serialize: peak in-flight stays at 1');
		});

		it('concurrencyCap < N caps peak in-flight (N=4, cap=2)', async () => {
			const ctx = makeRuntimeContext();
			const n = 4;
			const cap = 2;
			const tracker = new ConcurrencyTracker();
			const gates = Array.from({ length: n }, () => makeDeferred());
			const factories = gates.map((g, i) => gatedSingleRow([i] as Row, tracker, g));

			const iter = runUnionAll(ctx, factories, cap)[Symbol.asyncIterator]();
			const out: Row[] = [];
			let pending = iter.next();
			// Initial wave fills exactly the cap.
			await tracker.waitForInFlight(cap);
			expect(tracker.inFlight).to.equal(cap, 'initial wave fills the cap');
			for (let i = 0; i < n; i++) {
				gates[i].resolve();
				const r = await pending;
				expect(r.done).to.equal(false);
				out.push(r.value);
				pending = iter.next();
			}
			expect((await pending).done).to.equal(true);
			expect(out).to.have.lengthOf(n);
			expect(tracker.peak).to.be.at.most(cap, `peak in-flight must respect cap: ${tracker.peak}`);
			expect(tracker.peak).to.be.greaterThan(1, 'expected real concurrency under the cap');
		});

		it('arrival order follows the order gates are released (deterministic interleave)', async () => {
			// Two branches; release branch-1's row first, then branch-0's. The gather
			// yields in arrival order, so the controlled release order fixes the
			// interleave deterministically — no timer race.
			const ctx = makeRuntimeContext();
			const tracker = new ConcurrencyTracker();
			const g0 = makeDeferred();
			const g1 = makeDeferred();
			const factories = [
				gatedSingleRow(['a'] as Row, tracker, g0),
				gatedSingleRow(['b'] as Row, tracker, g1),
			];

			const iter = runUnionAll(ctx, factories, 2)[Symbol.asyncIterator]();
			const firstPull = iter.next();
			await tracker.waitForInFlight(2); // both parked, neither has yielded yet

			g1.resolve(); // branch 1 arrives first
			const r0 = await firstPull;
			expect(r0.value).to.deep.equal(['b']);

			g0.resolve(); // branch 0 arrives second
			const r1 = await iter.next();
			expect(r1.value).to.deep.equal(['a']);

			expect((await iter.next()).done).to.equal(true);
		});

		it('outer ordering is not preserved (multiset, not list)', async () => {
			// Two branches each yielding [1,2,3] deterministically. The output
			// is required only to be the multiset {1,1,2,2,3,3}; we explicitly
			// do not assert it is `[1,1,2,2,3,3]`.
			const ctx = makeRuntimeContext();
			const factories = [
				rowSource([[1], [2], [3]]),
				rowSource([[1], [2], [3]]),
			];
			const out = await collect(runUnionAll(ctx, factories, 2));
			const sorted = out.map(r => r[0]).sort((a, b) => (a as number) - (b as number));
			expect(sorted).to.deep.equal([1, 1, 2, 2, 3, 3]);
		});

		it('closes all in-flight branches when the consumer breaks', async () => {
			const ctx = makeRuntimeContext();
			const returns = [false, false, false];
			const makeSlow = (i: number): (innerCtx: RuntimeContext) => AsyncIterable<Row> => {
				return (_inner: RuntimeContext): AsyncIterable<Row> => ({
					[Symbol.asyncIterator]() {
						let n = 0;
						return {
							async next(): Promise<IteratorResult<Row>> {
								await sleep(5);
								if (n >= 100) return { done: true, value: undefined as unknown as Row };
								return { done: false, value: [i, n++] as Row };
							},
							async return(): Promise<IteratorResult<Row>> {
								returns[i] = true;
								return { done: true, value: undefined as unknown as Row };
							},
						};
					},
				});
			};
			const factories = [makeSlow(0), makeSlow(1), makeSlow(2)];

			let count = 0;
			for await (const _r of runUnionAll(ctx, factories, 3)) {
				count++;
				if (count >= 1) break;
			}
			await sleep(20);
			expect(returns.every(r => r)).to.equal(true, `every branch must be return()-closed: ${returns}`);
		});

		it('propagates a branch throw and closes siblings', async () => {
			const ctx = makeRuntimeContext();
			const branchError = new Error('boom from branch 1');
			const throwingBranch = (_inner: RuntimeContext): AsyncIterable<Row> => ({
				[Symbol.asyncIterator]() {
					return {
						async next(): Promise<IteratorResult<Row>> {
							await sleep(5);
							throw branchError;
						},
					};
				},
			});
			const factories = [
				rowSource([[0]]),
				throwingBranch,
				rowSource([[2]]),
			];
			let caught: unknown = undefined;
			try {
				await collect(runUnionAll(ctx, factories, 3));
			} catch (e) {
				caught = e;
			}
			expect(caught).to.equal(branchError);
		});

		describe('strict-fork interaction', () => {
			const strictMode = process.env.QUEREUS_FORK_STRICT === '1' || process.env.QUEREUS_FORK_STRICT === 'true';

			it('throws when parent mutates context while gather is live', function () {
				if (!strictMode) {
					this.skip();
					return;
				}
				const ctx = makeStrictRuntimeContext();
				const factories = [
					(_inner: RuntimeContext): AsyncIterable<Row> => (async function* () {
						yield [0] as Row;
						await sleep(10);
						yield [1] as Row;
					})(),
					rowSource([[2]]),
				];
				const attrId = 99001;
				const descriptor: RowDescriptor = [];
				descriptor[attrId] = 0;
				return (async () => {
					let caught: unknown = undefined;
					try {
						for await (const _r of runUnionAll(ctx, factories, 2)) {
							createRowSlot(ctx, descriptor);
						}
					} catch (e) {
						caught = e;
					}
					expect(caught, 'parent mutation while gather is live must violate strict-fork').to.not.equal(undefined);
					expect(String((caught as Error)?.message ?? caught)).to.match(/strict-fork/i);
				})();
			});
		});
	});

	describe('crossProduct runtime', () => {
		it('yields the full Cartesian product of two non-empty branches', async () => {
			const ctx = makeRuntimeContext();
			const factories = [
				rowSource([['A'], ['B']]),
				rowSource([[1], [2]]),
			];
			const out = await collect(runCrossProduct(ctx, factories, 2));
			expect(out).to.have.lengthOf(4);
			const formatted = out.map(r => `${r[0]}-${r[1]}`).sort();
			expect(formatted).to.deep.equal(['A-1', 'A-2', 'B-1', 'B-2']);
		});

		it('an empty branch makes the product empty', async () => {
			const ctx = makeRuntimeContext();
			const factories = [
				rowSource([['A'], ['B']]),
				rowSource([]),
			];
			const out = await collect(runCrossProduct(ctx, factories, 2));
			expect(out).to.deep.equal([]);
		});

		it('three branches of sizes 2/3/4 yield 24 rows', async () => {
			const ctx = makeRuntimeContext();
			const factories = [
				rowSource([['a'], ['b']]),                 // 2
				rowSource([[1], [2], [3]]),                // 3
				rowSource([['x'], ['y'], ['z'], ['w']]),   // 4
			];
			const out = await collect(runCrossProduct(ctx, factories, 3));
			expect(out).to.have.lengthOf(24);
			// Every output row has 3 cells (one per branch).
			for (const r of out) expect(r).to.have.lengthOf(3);
			// Distinct rows: assert all 24 combinations are present exactly once.
			const set = new Set(out.map(r => r.join('|')));
			expect(set.size).to.equal(24);
		});

		it('drives the production phase concurrently (cap=3, peak in-flight reaches 3)', async () => {
			const ctx = makeRuntimeContext();
			const n = 3;
			const tracker = new ConcurrencyTracker();
			const gates = Array.from({ length: n }, () => makeDeferred());
			const factories = gates.map((g, i) => gatedSingleRow([i] as Row, tracker, g));

			// crossProduct drains every branch before yielding; collect in parallel and
			// prove all branches were producing simultaneously before releasing them.
			const done = collect(runCrossProduct(ctx, factories, n));
			await tracker.waitForInFlight(n);
			expect(tracker.peak).to.equal(n, 'cap=N must drive all branch productions concurrently');
			for (const g of gates) g.resolve();
			const out = await done;
			expect(out).to.have.lengthOf(1); // 1×1×1 product
		});

		it('cap=1 serializes production (peak in-flight never exceeds 1)', async () => {
			const ctx = makeRuntimeContext();
			const n = 3;
			const tracker = new ConcurrencyTracker();
			const gates = Array.from({ length: n }, () => makeDeferred());
			const factories = gates.map((g, i) => gatedSingleRow([i] as Row, tracker, g));

			// Pre-release every gate: with cap=1 the driver still admits only one branch
			// production at a time regardless of gate availability, so the peak in-flight
			// the tracker observes is the deterministic proof of serialization.
			const done = collect(runCrossProduct(ctx, factories, 1));
			for (const g of gates) g.resolve();
			await done;
			expect(tracker.peak).to.equal(1, 'cap=1 must serialize production: peak stays at 1');
		});
	});

	describe('zipByKey runtime', () => {
		const cmp1 = createCollationRowComparator([BINARY_COLLATION]);
		const cmp2 = createCollationRowComparator([BINARY_COLLATION, BINARY_COLLATION]);

		it('two branches, full overlap → one row per key with both sides filled', async () => {
			const ctx = makeRuntimeContext();
			const factories = [
				rowSource([[1, 'a1'], [2, 'a2']]),
				rowSource([[1, 'b1'], [2, 'b2']]),
			];
			const out = await collect(runZipByKey(ctx, factories, [[0], [0]], [[1], [1]], cmp1, 2));
			expect(out).to.deep.equal([[1, 'a1', 'b1'], [2, 'a2', 'b2']]);
		});

		it('key present in only one branch → other branch NULL-padded', async () => {
			const ctx = makeRuntimeContext();
			const factories = [
				rowSource([[1, 'a1'], [2, 'a2']]),
				rowSource([[2, 'b2'], [3, 'b3']]),
			];
			const out = await collect(runZipByKey(ctx, factories, [[0], [0]], [[1], [1]], cmp1, 2));
			expect(out).to.deep.equal([
				[1, 'a1', null],
				[2, 'a2', 'b2'],
				[3, null, 'b3'],
			]);
		});

		it('three branches, partial overlap → correct NULL padding, one row per key', async () => {
			const ctx = makeRuntimeContext();
			const factories = [
				rowSource([[1, 'a1']]),
				rowSource([[1, 'b1'], [2, 'b2']]),
				rowSource([[2, 'c2'], [3, 'c3']]),
			];
			const out = await collect(
				runZipByKey(ctx, factories, [[0], [0], [0]], [[1], [1], [1]], cmp1, 3),
			);
			expect(out).to.deep.equal([
				[1, 'a1', 'b1', null],
				[2, null, 'b2', 'c2'],
				[3, null, null, 'c3'],
			]);
			// Row width = K(1) + Σ non-key arities (1+1+1).
			for (const r of out) expect(r).to.have.lengthOf(4);
		});

		it('empty branch → keys from other branches still emit (NULL-padded for empty one)', async () => {
			const ctx = makeRuntimeContext();
			const factories = [
				rowSource([]),
				rowSource([[1, 'b1']]),
				rowSource([[2, 'c2']]),
			];
			const out = await collect(
				runZipByKey(ctx, factories, [[0], [0], [0]], [[1], [1], [1]], cmp1, 3),
			);
			expect(out).to.deep.equal([
				[1, null, 'b1', null],
				[2, null, null, 'c2'],
			]);
		});

		it('all-empty branches → no rows', async () => {
			const ctx = makeRuntimeContext();
			const factories = [rowSource([]), rowSource([])];
			const out = await collect(runZipByKey(ctx, factories, [[0], [0]], [[1], [1]], cmp1, 2));
			expect(out).to.deep.equal([]);
		});

		it('NULL-keyed rows from different branches do NOT merge', async () => {
			const ctx = makeRuntimeContext();
			const factories = [
				rowSource([[null, 'a1']]),
				rowSource([[null, 'b1']]),
			];
			const out = await collect(runZipByKey(ctx, factories, [[0], [0]], [[1], [1]], cmp1, 2));
			expect(out).to.have.lengthOf(2);
			// Arrival order is non-deterministic; assert as a set.
			const set = new Set(out.map(r => JSON.stringify(r)));
			expect(set.has(JSON.stringify([null, 'a1', null]))).to.equal(true);
			expect(set.has(JSON.stringify([null, null, 'b1']))).to.equal(true);
		});

		it('multi-column composite key (K=2) merges correctly', async () => {
			const ctx = makeRuntimeContext();
			const factories = [
				rowSource([['x', 1, 'a1'], ['x', 2, 'a2']]),
				rowSource([['x', 1, 'b1'], ['y', 1, 'b2']]),
			];
			const out = await collect(
				runZipByKey(ctx, factories, [[0, 1], [0, 1]], [[2], [2]], cmp2, 2),
			);
			expect(out).to.deep.equal([
				['x', 1, 'a1', 'b1'],
				['x', 2, 'a2', null],
				['y', 1, null, 'b2'],
			]);
		});

		it('composite key with a NULL component is treated as NULL-keyed (no merge)', async () => {
			// (x, NULL) and (x, NULL) must NOT merge: SQL `x = x AND NULL = NULL`
			// is unknown, so each row emits standalone. Only the fully-non-NULL
			// composite key (y, 1) is eligible for the tree.
			const ctx = makeRuntimeContext();
			const factories = [
				rowSource([['x', null, 'a1'], ['y', 1, 'a2']]),
				rowSource([['x', null, 'b1'], ['y', 1, 'b2']]),
			];
			const out = await collect(
				runZipByKey(ctx, factories, [[0, 1], [0, 1]], [[2], [2]], cmp2, 2),
			);
			expect(out).to.have.lengthOf(3, 'two standalone NULL-composite rows + one merged (y,1)');
			const set = new Set(out.map(r => JSON.stringify(r)));
			expect(set.has(JSON.stringify(['x', null, 'a1', null]))).to.equal(true);
			expect(set.has(JSON.stringify(['x', null, null, 'b1']))).to.equal(true);
			expect(set.has(JSON.stringify(['y', 1, 'a2', 'b2']))).to.equal(true);
		});

		it('drives branches concurrently with cap=3 (peak in-flight reaches 3)', async () => {
			const ctx = makeRuntimeContext();
			const n = 3;
			const tracker = new ConcurrencyTracker();
			const gates = Array.from({ length: n }, () => makeDeferred());
			// Distinct keys per branch so no merge collapses the row count.
			const factories = gates.map((g, i) => gatedSingleRow([i, `v${i}`] as Row, tracker, g));

			const done = collect(runZipByKey(ctx, factories, [[0], [0], [0]], [[1], [1], [1]], cmp1, n));
			await tracker.waitForInFlight(n);
			expect(tracker.peak).to.equal(n, 'cap=N must drive all branches concurrently');
			for (const g of gates) g.resolve();
			const out = await done;
			expect(out).to.have.lengthOf(n); // three distinct keys → three rows
		});

		it('cap=1 serializes branches (peak in-flight never exceeds 1)', async () => {
			const ctx = makeRuntimeContext();
			const n = 3;
			const tracker = new ConcurrencyTracker();
			const gates = Array.from({ length: n }, () => makeDeferred());
			const factories = gates.map((g, i) => gatedSingleRow([i, `v${i}`] as Row, tracker, g));

			const done = collect(runZipByKey(ctx, factories, [[0], [0], [0]], [[1], [1], [1]], cmp1, 1));
			// Pre-release every gate: cap=1 forces the driver to run branches strictly
			// one at a time, so peak in-flight is the deterministic serialization proof.
			for (const g of gates) g.resolve();
			await done;
			expect(tracker.peak).to.equal(1, 'cap=1 must serialize: peak stays at 1');
		});

		it('merged key is deterministic under forced reverse arrival (lowest-index branch wins, matches coalesce)', async () => {
			// NOCASE: 'A' (branch 0) and 'a' (branch 1) are collation-equal but
			// byte-distinct. Force branch 1 to arrive FIRST so it seeds the BTree
			// entry's key tuple with 'a', then let branch 0 arrive and merge in. The
			// emitted merged key must still be branch 0's 'A' — composeMergedKeyCells
			// picks the lowest-indexed present branch, matching coalesce(b0.k, b1.k),
			// not the arrival-order winner. (Pre-fix this yielded the arrived-first 'a'.)
			const cmpNoCase = createCollationRowComparator([NOCASE_COLLATION]);
			const ctx = makeRuntimeContext();
			const tracker = new ConcurrencyTracker();
			const trace: SourceEvent[] = [];
			const g0 = makeDeferred();
			const g1 = makeDeferred();
			const b0 = controllableSource({ branch: 0, rows: [['A', 'a1']], gates: [g0], tracker, trace });
			const b1 = controllableSource({ branch: 1, rows: [['a', 'b1']], gates: [g1], tracker, trace });

			const done = collect(
				runZipByKey(ctx, [b0.factory, b1.factory], [[0], [0]], [[1], [1]], cmpNoCase, 2),
			);
			await tracker.waitForInFlight(2); // both parked at their gates
			g1.resolve(); // branch 1 ('a') arrives first → seeds entry.key
			while (!trace.some(e => e.kind === 'yielded' && e.branch === 1)) await sleep(0);
			g0.resolve(); // branch 0 ('A') arrives second → merges into the same group
			const out = await done;
			expect(out).to.deep.equal([['A', 'a1', 'b1']]);
		});
	});

	describe('cartesianProduct helper', () => {
		it('produces all combinations for 2x2', () => {
			const buffers: Row[][] = [[['A'], ['B']], [[1], [2]]];
			const out = Array.from(cartesianProduct(buffers));
			expect(out).to.have.lengthOf(4);
			expect(out.map(r => `${r[0]}-${r[1]}`).sort()).to.deep.equal(['A-1', 'A-2', 'B-1', 'B-2']);
		});

		it('produces 1 row when every buffer has one row', () => {
			const buffers: Row[][] = [[['x']], [[1]], [['z']]];
			const out = Array.from(cartesianProduct(buffers));
			expect(out).to.deep.equal([['x', 1, 'z']]);
		});
	});
});
