import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import {
	closeConstantBindingsOverEcs,
	extractEqualityFds,
	mergeConstantBindings,
	projectConstantBindings,
	shiftConstantBindings,
	type ConstantBinding,
} from '../../src/planner/util/fd-utils.js';
import { EmptyScope } from '../../src/planner/scopes/empty.js';
import { BinaryOpNode, LiteralNode } from '../../src/planner/nodes/scalar.js';
import { ColumnReferenceNode, ParameterReferenceNode } from '../../src/planner/nodes/reference.js';
import type { ScalarPlanNode } from '../../src/planner/nodes/plan-node.js';
import type * as AST from '../../src/parser/ast.js';
import { INTEGER_TYPE, TEXT_TYPE } from '../../src/types/builtin-types.js';

// ---------------------------------------------------------------------------
// Plan-row introspection helpers (mirror fd-propagation.spec.ts)
// ---------------------------------------------------------------------------

interface PhysicalProps {
	fds?: { determinants: number[]; dependents: number[] }[];
	equivClasses?: number[][];
	constantBindings?: ConstantBinding[];
}

interface PlanRow { node_type: string; op: string; detail: string; physical: string | null }

async function planRows(db: Database, sql: string): Promise<PlanRow[]> {
	const rows: PlanRow[] = [];
	for await (const r of db.eval('SELECT node_type, op, detail, physical FROM query_plan(?)', [sql])) {
		rows.push(r as unknown as PlanRow);
	}
	return rows;
}

function physicalOf(rows: readonly PlanRow[], pred: (r: PlanRow) => boolean): PhysicalProps | undefined {
	const row = rows.find(pred);
	if (!row || !row.physical) return undefined;
	return JSON.parse(row.physical) as PhysicalProps;
}

function bindingFor(bindings: ConstantBinding[] | undefined, col: number): ConstantBinding | undefined {
	if (!bindings) return undefined;
	return bindings.find(b => b.attrs.includes(col));
}

// ---------------------------------------------------------------------------
// Unit tests for the new ConstantBinding surface
// ---------------------------------------------------------------------------

describe('fd-utils: ConstantBinding helpers', () => {
	const scope = EmptyScope.instance as unknown as never;
	const intType = { typeClass: 'scalar' as const, logicalType: INTEGER_TYPE, nullable: false, isReadOnly: false };

	function colNode(attrId: number, index: number): ColumnReferenceNode {
		const expr = { type: 'column', name: `c${attrId}` } as unknown as AST.ColumnExpr;
		return new ColumnReferenceNode(scope, expr, intType, attrId, index);
	}

	function litNode(value: number): LiteralNode {
		const expr = { type: 'literal', value } as unknown as AST.LiteralExpr;
		return new LiteralNode(scope, expr);
	}

	function paramNode(nameOrIndex: string | number): ParameterReferenceNode {
		const expr = { type: 'parameter', name: typeof nameOrIndex === 'string' ? `:${nameOrIndex}` : '?' } as unknown as AST.ParameterExpr;
		const t = { typeClass: 'scalar' as const, logicalType: TEXT_TYPE, nullable: true };
		return new ParameterReferenceNode(scope, expr, nameOrIndex, t);
	}

	function eqNode(left: ScalarPlanNode, right: ScalarPlanNode): BinaryOpNode {
		const ast = {
			type: 'binary',
			operator: '=',
			left: (left as unknown as { expression: AST.Expression }).expression,
			right: (right as unknown as { expression: AST.Expression }).expression,
		} as AST.BinaryExpr;
		return new BinaryOpNode(scope, ast, left, right);
	}

	function andNode(left: ScalarPlanNode, right: ScalarPlanNode): BinaryOpNode {
		const ast = {
			type: 'binary',
			operator: 'AND',
			left: (left as unknown as { expression: AST.Expression }).expression,
			right: (right as unknown as { expression: AST.Expression }).expression,
		} as AST.BinaryExpr;
		return new BinaryOpNode(scope, ast, left, right);
	}

	describe('extractEqualityFds (with bindings)', () => {
		it('emits a literal binding for col = literal', () => {
			const attrMap = new Map<number, number>([[100, 0]]);
			const pred = eqNode(colNode(100, 0), litNode(5));
			const result = extractEqualityFds(pred, attrMap);
			expect(result.constantBindings).to.have.length(1);
			expect(result.constantBindings[0].attrs).to.deep.equal([0]);
			expect(result.constantBindings[0].value).to.deep.equal({ kind: 'literal', value: 5 });
		});

		it('emits a parameter binding for col = ?', () => {
			const attrMap = new Map<number, number>([[100, 0]]);
			const pred = eqNode(colNode(100, 0), paramNode(1));
			const result = extractEqualityFds(pred, attrMap);
			// Parameter equality also yields the ∅ → col FD.
			expect(result.fds.some(fd => fd.determinants.length === 0 && fd.dependents.includes(0))).to.equal(true);
			expect(result.constantBindings).to.have.length(1);
			expect(result.constantBindings[0].attrs).to.deep.equal([0]);
			expect(result.constantBindings[0].value).to.deep.equal({ kind: 'parameter', paramRef: 1 });
		});

		it('mixes literal + parameter bindings in a single conjunction', () => {
			const attrMap = new Map<number, number>([[100, 0], [101, 1]]);
			const pred = andNode(
				eqNode(colNode(100, 0), litNode(5)),
				eqNode(colNode(101, 1), paramNode(2)),
			);
			const result = extractEqualityFds(pred, attrMap);
			expect(result.constantBindings).to.have.length(2);
			const litB = result.constantBindings.find(b => b.value.kind === 'literal');
			const parB = result.constantBindings.find(b => b.value.kind === 'parameter');
			expect(litB?.attrs).to.deep.equal([0]);
			expect(parB?.attrs).to.deep.equal([1]);
		});

		it('col1 = col2 produces no constant binding', () => {
			const attrMap = new Map<number, number>([[100, 0], [101, 1]]);
			const pred = eqNode(colNode(100, 0), colNode(101, 1));
			const result = extractEqualityFds(pred, attrMap);
			expect(result.constantBindings).to.have.length(0);
		});
	});

	describe('mergeConstantBindings', () => {
		it('coalesces bindings that share a literal value by unioning attrs', () => {
			const a: ConstantBinding[] = [{ attrs: [0], value: { kind: 'literal', value: 5 } }];
			const b: ConstantBinding[] = [{ attrs: [3], value: { kind: 'literal', value: 5 } }];
			const merged = mergeConstantBindings(a, b);
			expect(merged).to.have.length(1);
			expect(merged[0].attrs).to.deep.equal([0, 3]);
		});

		it('keeps distinct values as separate bindings', () => {
			const a: ConstantBinding[] = [{ attrs: [0], value: { kind: 'literal', value: 5 } }];
			const b: ConstantBinding[] = [{ attrs: [1], value: { kind: 'literal', value: 7 } }];
			const merged = mergeConstantBindings(a, b);
			expect(merged).to.have.length(2);
		});

		it('treats two parameters with the same ref as the same value', () => {
			const a: ConstantBinding[] = [{ attrs: [0], value: { kind: 'parameter', paramRef: 1 } }];
			const b: ConstantBinding[] = [{ attrs: [3], value: { kind: 'parameter', paramRef: 1 } }];
			const merged = mergeConstantBindings(a, b);
			expect(merged).to.have.length(1);
			expect(merged[0].attrs).to.deep.equal([0, 3]);
		});

		it('keeps parameters with different refs as distinct bindings', () => {
			const a: ConstantBinding[] = [{ attrs: [0], value: { kind: 'parameter', paramRef: 1 } }];
			const b: ConstantBinding[] = [{ attrs: [1], value: { kind: 'parameter', paramRef: 2 } }];
			const merged = mergeConstantBindings(a, b);
			expect(merged).to.have.length(2);
		});
	});

	describe('closeConstantBindingsOverEcs', () => {
		it('folds an EC bridging member into a single binding', () => {
			const bindings: ConstantBinding[] = [{ attrs: [0], value: { kind: 'literal', value: 5 } }];
			const ecs = [[0, 3]];
			const closed = closeConstantBindingsOverEcs(bindings, ecs);
			expect(closed).to.have.length(1);
			expect(closed[0].attrs).to.deep.equal([0, 3]);
		});

		it('chains through multiple ECs transitively', () => {
			const bindings: ConstantBinding[] = [{ attrs: [0], value: { kind: 'literal', value: 5 } }];
			const ecs = [[0, 3], [3, 7]];
			const closed = closeConstantBindingsOverEcs(bindings, ecs);
			expect(closed[0].attrs).to.deep.equal([0, 3, 7]);
		});

		it('leaves bindings alone when no EC overlaps', () => {
			const bindings: ConstantBinding[] = [{ attrs: [0], value: { kind: 'literal', value: 5 } }];
			const ecs = [[2, 4]];
			const closed = closeConstantBindingsOverEcs(bindings, ecs);
			expect(closed[0].attrs).to.deep.equal([0]);
		});
	});

	describe('projectConstantBindings', () => {
		it('drops bindings whose attrs are completely unmapped', () => {
			const bindings: ConstantBinding[] = [{ attrs: [5], value: { kind: 'literal', value: 1 } }];
			const mapping = new Map<number, number>([[0, 10]]);
			expect(projectConstantBindings(bindings, mapping)).to.deep.equal([]);
		});

		it('keeps bindings with at least one surviving column, remapping the survivors', () => {
			const bindings: ConstantBinding[] = [{ attrs: [0, 5], value: { kind: 'literal', value: 1 } }];
			const mapping = new Map<number, number>([[0, 10]]);
			const out = projectConstantBindings(bindings, mapping);
			expect(out).to.have.length(1);
			expect(out[0].attrs).to.deep.equal([10]);
		});
	});

	describe('shiftConstantBindings', () => {
		it('shifts attrs by the offset', () => {
			const bindings: ConstantBinding[] = [{ attrs: [0, 1], value: { kind: 'literal', value: 1 } }];
			const out = shiftConstantBindings(bindings, 5);
			expect(out[0].attrs).to.deep.equal([5, 6]);
		});
	});
});

// ---------------------------------------------------------------------------
// End-to-end EC / binding propagation through query_plan(...)
// ---------------------------------------------------------------------------

describe('ConstantBinding propagation per operator', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	it('Filter: parameter equality yields a constantBinding', async () => {
		// Use a non-PK column so the predicate stays in a Filter rather than
		// being pushed into an index seek.
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER) USING memory");
		const rows = await planRows(db, 'SELECT * FROM t WHERE v = ?');
		const props = physicalOf(rows, r => r.op === 'FILTER');
		expect(props, 'expected Filter physical props').to.not.equal(undefined);
		// Filter sees `v` at column index 1.
		const binding = bindingFor(props!.constantBindings, 1);
		expect(binding, 'expected a binding on v').to.not.equal(undefined);
		expect(binding!.value.kind).to.equal('parameter');
	});

	it('Filter: literal + parameter mix produces two bindings', async () => {
		await db.exec("CREATE TABLE t (a INTEGER, b INTEGER, c TEXT) USING memory");
		const rows = await planRows(db, 'SELECT * FROM t WHERE a = 5 AND c = ?');
		const props = physicalOf(rows, r => r.op === 'FILTER');
		expect(props).to.not.equal(undefined);
		// a is col 0, c is col 2.
		const aB = bindingFor(props!.constantBindings, 0);
		const cB = bindingFor(props!.constantBindings, 2);
		expect(aB?.value.kind).to.equal('literal');
		expect(cB?.value.kind).to.equal('parameter');
	});

	it('Filter: closes binding over EC (a = b AND a = 7 binds both a and b)', async () => {
		await db.exec("CREATE TABLE t (a INTEGER, b INTEGER) USING memory");
		const rows = await planRows(db, 'SELECT * FROM t WHERE a = b AND a = 7');
		const props = physicalOf(rows, r => r.op === 'FILTER');
		expect(props).to.not.equal(undefined);
		// One binding whose attrs include BOTH 0 (a) and 1 (b).
		const binding = props!.constantBindings?.find(b => b.attrs.includes(0) && b.attrs.includes(1));
		expect(binding, 'expected a single binding covering both EC members').to.not.equal(undefined);
		expect(binding!.value).to.deep.equal({ kind: 'literal', value: 7 });
	});

	it('Inner JOIN: one-sided literal binding closes over the equi-pair EC', async () => {
		await db.exec("CREATE TABLE jl (id INTEGER PRIMARY KEY, k INTEGER) USING memory");
		await db.exec("CREATE TABLE jr (rid INTEGER PRIMARY KEY, k INTEGER) USING memory");
		// The WHERE conjunct is pushed onto the `jl` branch by
		// `rule-join-predicate-pushdown`, so the join node itself is the first frame
		// that holds both k columns — and where the branch's binding must close over
		// the equi-pair EC. (Any surviving FILTER is a branch filter with only one
		// side's columns in frame, so it cannot answer this question.)
		const rows = await planRows(db,
			'SELECT * FROM jl INNER JOIN jr ON jl.k = jr.k WHERE jl.k = 5'
		);
		const props =
			physicalOf(rows, r => r.op === 'HASHJOIN') ??
			physicalOf(rows, r => r.op === 'MERGEJOIN') ??
			physicalOf(rows, r => r.op === 'JOIN');
		expect(props, 'expected physical props on the join').to.not.equal(undefined);
		// Output columns: jl has 2 cols (id=0, k=1); jr starts at col 2 (rid=2, k=3).
		// The binding for jl.k = 5 should close over the EC {1, 3} and cover BOTH 1 and 3.
		const binding = props!.constantBindings?.find(b => b.attrs.includes(1) && b.attrs.includes(3));
		expect(binding, 'expected a binding covering both join-side k columns').to.not.equal(undefined);
		expect(binding!.value).to.deep.equal({ kind: 'literal', value: 5 });
	});

	it('Inner JOIN: one-sided parameter binding closes over the equi-pair EC', async () => {
		await db.exec("CREATE TABLE jl (id INTEGER PRIMARY KEY, k INTEGER) USING memory");
		await db.exec("CREATE TABLE jr (rid INTEGER PRIMARY KEY, k INTEGER) USING memory");
		const rows = await planRows(db,
			'SELECT * FROM jl INNER JOIN jr ON jl.k = jr.k WHERE jl.k = ?'
		);
		// Read at the join, for the same reason as the literal case above.
		const props = physicalOf(rows, r => r.op === 'HASHJOIN') ??
			physicalOf(rows, r => r.op === 'MERGEJOIN') ??
			physicalOf(rows, r => r.op === 'JOIN');
		expect(props).to.not.equal(undefined);
		const binding = props!.constantBindings?.find(b => b.attrs.includes(1) && b.attrs.includes(3));
		expect(binding, 'expected a parameter-valued binding covering both k columns').to.not.equal(undefined);
		expect(binding!.value.kind).to.equal('parameter');
	});

	it('LEFT JOIN drops right-side constant', async () => {
		await db.exec("CREATE TABLE lo (id INTEGER PRIMARY KEY, k INTEGER) USING memory");
		await db.exec("CREATE TABLE ro (rid INTEGER PRIMARY KEY, k INTEGER) USING memory");
		// Push a right-side constant into the ON clause; under left outer the
		// right-side binding must NOT survive on the join output (NULL-pad rule).
		const rows = await planRows(db,
			'SELECT * FROM lo LEFT JOIN ro ON lo.k = ro.k AND ro.k = 5'
		);
		const joinProps =
			physicalOf(rows, r => r.op === 'HASHJOIN') ??
			physicalOf(rows, r => r.op === 'JOIN');
		expect(joinProps).to.not.equal(undefined);
		// jl.k = 1, ro.k = 3 in output. The right side's binding on col 3 must be
		// absent (NULL-pad can violate it).
		const binding = bindingFor(joinProps!.constantBindings, 3);
		expect(binding, 'right-side binding must not survive a left outer').to.equal(undefined);
	});

	it('Project drops bindings on columns it does not project', async () => {
		await db.exec("CREATE TABLE p (id INTEGER PRIMARY KEY, k INTEGER) USING memory");
		// Select only id; the binding on k should not show up at the Project.
		const rows = await planRows(db, "SELECT id FROM p WHERE k = 5");
		const projProps = physicalOf(rows, r => r.op === 'PROJECT');
		expect(projProps).to.not.equal(undefined);
		// Whatever bindings survive must not reference k's output index (it isn't projected).
		// Project re-maps source col 0 (id) → output col 0; source col 1 (k) is dropped.
		for (const b of projProps!.constantBindings ?? []) {
			expect(b.attrs.every(c => c === 0)).to.equal(true);
		}
		// In particular: the binding on k (source col 1) is dropped completely.
		expect(projProps!.constantBindings?.some(b => b.attrs.includes(1))).to.not.equal(true);
	});

	it('Non-equality predicate contributes no constantBindings', async () => {
		await db.exec("CREATE TABLE g (id INTEGER PRIMARY KEY, v INTEGER) USING memory");
		const rows = await planRows(db, 'SELECT * FROM g WHERE v > 5');
		const props = physicalOf(rows, r => r.op === 'FILTER');
		expect(props).to.not.equal(undefined);
		expect(props!.constantBindings).to.equal(undefined);
	});
});
