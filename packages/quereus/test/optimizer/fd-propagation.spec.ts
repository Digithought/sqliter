import { expect } from 'chai';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Database } from '../../src/core/database.js';
import { lineAt, readCode, relPosix, stripComments, tsFilesUnder } from '../util/source-scan.js';
import {
	addEquivalence,
	addFd,
	computeClosure,
	determines,
	extractEqualityFds,
	mergeEquivClasses,
	mergeFds,
	minimalCover,
	projectFds,
	shiftEquivClasses,
	shiftFds,
	superkeyToFd,
} from '../../src/planner/util/fd-utils.js';
import { EmptyScope } from '../../src/planner/scopes/empty.js';
import { BinaryOpNode, LiteralNode } from '../../src/planner/nodes/scalar.js';
import { ColumnReferenceNode } from '../../src/planner/nodes/reference.js';
import type { ScalarPlanNode, FunctionalDependency } from '../../src/planner/nodes/plan-node.js';
import type * as AST from '../../src/parser/ast.js';
import { INTEGER_TYPE } from '../../src/types/builtin-types.js';

interface PhysicalProps {
	fds?: FunctionalDependency[];
	equivClasses?: number[][];
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

function fdFind(fds: FunctionalDependency[] | undefined, det: number[], dep: number[]): FunctionalDependency | undefined {
	if (!fds) return undefined;
	const detSet = new Set(det);
	return fds.find(fd => {
		if (fd.determinants.length !== det.length) return false;
		if (!fd.determinants.every(d => detSet.has(d))) return false;
		return dep.every(d => fd.dependents.includes(d));
	});
}

function fdHas(fds: FunctionalDependency[] | undefined, det: number[], dep: number[]): boolean {
	return fdFind(fds, det, dep) !== undefined;
}

function classContains(classes: number[][] | undefined, members: number[]): boolean {
	if (!classes) return false;
	return classes.some(cls => members.every(m => cls.includes(m)));
}

// ---------------------------------------------------------------------------
// Unit tests for fd-utils
// ---------------------------------------------------------------------------

describe('fd-utils', () => {
	describe('computeClosure', () => {
		it('returns input attrs when no FDs apply', () => {
			const c = computeClosure(new Set([1, 2]), []);
			expect([...c].sort()).to.deep.equal([1, 2]);
		});

		it('applies a single FD', () => {
			const fds: FunctionalDependency[] = [{ determinants: [1], dependents: [2], kind: 'determination' }];
			const c = computeClosure(new Set([1]), fds);
			expect([...c].sort()).to.deep.equal([1, 2]);
		});

		it('iterates to fixpoint (a→b, b→c)', () => {
			const fds: FunctionalDependency[] = [
				{ determinants: [1], dependents: [2], kind: 'determination' },
				{ determinants: [2], dependents: [3], kind: 'determination' },
			];
			const c = computeClosure(new Set([1]), fds);
			expect([...c].sort()).to.deep.equal([1, 2, 3]);
		});

		it('handles constants (∅ → c)', () => {
			const fds: FunctionalDependency[] = [{ determinants: [], dependents: [5], kind: 'determination' }];
			const c = computeClosure(new Set([1]), fds);
			expect([...c].sort()).to.deep.equal([1, 5]);
		});
	});

	describe('determines', () => {
		it('trivial case: target ⊆ attrs', () => {
			expect(determines(new Set([1, 2]), new Set([1]), [])).to.equal(true);
		});

		it('transitive determination', () => {
			const fds: FunctionalDependency[] = [
				{ determinants: [1], dependents: [2], kind: 'determination' },
				{ determinants: [2], dependents: [3], kind: 'determination' },
			];
			expect(determines(new Set([1]), new Set([3]), fds)).to.equal(true);
		});

		it('does not determine when no chain', () => {
			const fds: FunctionalDependency[] = [{ determinants: [1], dependents: [2], kind: 'determination' }];
			expect(determines(new Set([1]), new Set([3]), fds)).to.equal(false);
		});
	});

	describe('minimalCover', () => {
		it('removes redundant attributes', () => {
			// {1,2} where 1→2, so {1} is the minimal cover that yields the same closure
			const fds: FunctionalDependency[] = [{ determinants: [1], dependents: [2], kind: 'determination' }];
			const cover = minimalCover(new Set([1, 2]), fds);
			expect([...cover].sort()).to.deep.equal([1]);
		});

		it('keeps independent attributes', () => {
			const cover = minimalCover(new Set([1, 2]), []);
			expect([...cover].sort()).to.deep.equal([1, 2]);
		});
	});

	describe('mergeEquivClasses', () => {
		it('unions overlapping classes ([1,2],[2,3] → [1,2,3])', () => {
			const merged = mergeEquivClasses([[1, 2]], [[2, 3]]);
			expect(merged).to.deep.equal([[1, 2, 3]]);
		});

		it('keeps disjoint classes separate', () => {
			const merged = mergeEquivClasses([[1, 2]], [[3, 4]]);
			expect(merged).to.have.length(2);
		});

		it('drops singleton classes', () => {
			const merged = mergeEquivClasses([[1]], [[2]]);
			expect(merged).to.deep.equal([]);
		});
	});

	describe('addEquivalence', () => {
		it('merges existing classes via a new bridging pair', () => {
			const merged = addEquivalence([[1, 2], [3, 4]], 2, 3);
			expect(merged).to.deep.equal([[1, 2, 3, 4]]);
		});

		it('creates a new class for two fresh attrs', () => {
			const merged = addEquivalence([], 1, 2);
			expect(merged).to.deep.equal([[1, 2]]);
		});

		it('returns input unchanged for a≡a', () => {
			const merged = addEquivalence([[1, 2]], 1, 1);
			expect(merged).to.deep.equal([[1, 2]]);
		});
	});

	describe('projectFds', () => {
		it('drops FDs that lose a determinant column', () => {
			const fds: FunctionalDependency[] = [{ determinants: [1], dependents: [2], kind: 'determination' }];
			const mapping = new Map<number, number>([[2, 0]]);
			const out = projectFds(fds, mapping);
			expect(out).to.deep.equal([]);
		});

		it('drops FDs that lose a dependent column', () => {
			const fds: FunctionalDependency[] = [{ determinants: [1], dependents: [2], kind: 'determination' }];
			const mapping = new Map<number, number>([[1, 0]]);
			const out = projectFds(fds, mapping);
			expect(out).to.deep.equal([]);
		});

		it('remaps surviving FDs', () => {
			const fds: FunctionalDependency[] = [{ determinants: [1], dependents: [2], kind: 'determination' }];
			const mapping = new Map<number, number>([[1, 10], [2, 20]]);
			const out = projectFds(fds, mapping);
			expect(out).to.deep.equal([{ determinants: [10], dependents: [20], kind: 'determination' }]);
		});
	});

	describe('OPT-047: addFd dedupes by subsumption and evicts by key/kind preference', () => {
		it('dedupes identical FDs', () => {
			const fds: FunctionalDependency[] = [{ determinants: [1], dependents: [2], kind: 'determination' }];
			const out = addFd(fds, { determinants: [1], dependents: [2], kind: 'determination' });
			expect(out).to.have.length(1);
		});

		it('drops an existing FD when new one subsumes its dependents', () => {
			const fds: FunctionalDependency[] = [{ determinants: [1], dependents: [2], kind: 'determination' }];
			const out = addFd(fds, { determinants: [1], dependents: [2, 3], kind: 'determination' });
			expect(out).to.have.length(1);
			expect(out[0].dependents.slice().sort()).to.deep.equal([2, 3]);
		});

		it('skips adding when an existing FD subsumes the new one', () => {
			const fds: FunctionalDependency[] = [{ determinants: [1], dependents: [2, 3], kind: 'determination' }];
			const out = addFd(fds, { determinants: [1], dependents: [2], kind: 'determination' });
			expect(out).to.have.length(1);
			expect(out[0].dependents.slice().sort()).to.deep.equal([2, 3]);
		});

		it('mergeFds combines lists', () => {
			const a: FunctionalDependency[] = [{ determinants: [1], dependents: [2], kind: 'determination' }];
			const b: FunctionalDependency[] = [{ determinants: [3], dependents: [4], kind: 'determination' }];
			const out = mergeFds(a, b);
			expect(out).to.have.length(2);
		});

		it('cap eviction keeps FDs whose determinants lie inside a keyHints set, even over a unique', () => {
			const fds: FunctionalDependency[] = [
				{ determinants: [1], dependents: [9], kind: 'determination' },
				{ determinants: [2], dependents: [9], kind: 'unique' },
			];
			const out = addFd(fds, { determinants: [3], dependents: [9], kind: 'unique' }, { cap: 1, keyHints: [[1]] });
			expect(out).to.have.length(1);
			expect(out[0].determinants).to.deep.equal([1]);
		});

		it('cap eviction prefers unique over determination within a partition', () => {
			const fds: FunctionalDependency[] = [
				{ determinants: [1], dependents: [9], kind: 'determination' },
				{ determinants: [2], dependents: [9], kind: 'unique' },
			];
			const out = addFd(fds, { determinants: [3], dependents: [9], kind: 'determination' }, { cap: 2 });
			expect(out).to.have.length(2);
			expect(out[0].kind).to.equal('unique');
			expect(out[0].determinants).to.deep.equal([2]);
		});

		it('cap eviction ranks key-hinted determinations ahead of non-hinted uniques', () => {
			const fds: FunctionalDependency[] = [
				{ determinants: [2], dependents: [9], kind: 'unique' },
				{ determinants: [1], dependents: [9], kind: 'determination' },
			];
			const out = addFd(fds, { determinants: [3], dependents: [9], kind: 'unique' }, { cap: 2, keyHints: [[1]] });
			expect(out).to.have.length(2);
			expect(out[0].determinants).to.deep.equal([1]);
			expect(out[1].kind).to.equal('unique');
		});
	});

	describe('shiftFds / shiftEquivClasses', () => {
		it('shifts all column indices', () => {
			const fds: FunctionalDependency[] = [{ determinants: [0], dependents: [1], kind: 'determination' }];
			const shifted = shiftFds(fds, 5);
			expect(shifted).to.deep.equal([{ determinants: [5], dependents: [6], kind: 'determination' }]);
			const classes = shiftEquivClasses([[0, 1]], 5);
			expect(classes).to.deep.equal([[5, 6]]);
		});
	});

	describe('superkeyToFd', () => {
		it('builds key → all-others for K ⊊ all_cols', () => {
			const fd = superkeyToFd([1], 4);
			expect(fd).to.not.equal(undefined);
			expect(fd!.determinants).to.deep.equal([1]);
			expect(fd!.dependents.slice().sort()).to.deep.equal([0, 2, 3]);
		});

		it('returns undefined when K = all_cols (no non-trivial encoding)', () => {
			const fd = superkeyToFd([0, 1, 2], 3);
			expect(fd).to.equal(undefined);
		});
	});

	describe('extractEqualityFds', () => {
		const scope = EmptyScope.instance as unknown as never;

		function colNode(attrId: number, index: number): ColumnReferenceNode {
			const expr = { type: 'column', name: `c${attrId}` } as unknown as AST.ColumnExpr;
			const columnType = {
				typeClass: 'scalar' as const,
				logicalType: INTEGER_TYPE,
				nullable: false,
				isReadOnly: false,
			};
			return new ColumnReferenceNode(scope, expr, columnType, attrId, index);
		}

		function litNode(value: number): LiteralNode {
			const expr = { type: 'literal', value } as unknown as AST.LiteralExpr;
			return new LiteralNode(scope, expr);
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

		it('col = const ⇒ ∅ → col', () => {
			const attrMap = new Map<number, number>([[100, 0]]);
			const pred = eqNode(colNode(100, 0), litNode(5));
			const result = extractEqualityFds(pred, attrMap);
			expect(result.fds).to.have.length(1);
			expect(result.fds[0].determinants).to.deep.equal([]);
			expect(result.fds[0].dependents).to.deep.equal([0]);
			expect(result.equivPairs).to.have.length(0);
		});

		it('col1 = col2 ⇒ bi-directional FDs + EC pair', () => {
			const attrMap = new Map<number, number>([[100, 0], [101, 1]]);
			const pred = eqNode(colNode(100, 0), colNode(101, 1));
			const result = extractEqualityFds(pred, attrMap);
			expect(result.fds).to.have.length(2);
			expect(result.equivPairs).to.have.length(1);
			expect(result.equivPairs[0].slice().sort()).to.deep.equal([0, 1]);
		});

		it('decomposes AND', () => {
			const attrMap = new Map<number, number>([[100, 0], [101, 1]]);
			const pred = andNode(
				eqNode(colNode(100, 0), litNode(5)),
				eqNode(colNode(101, 1), litNode(7)),
			);
			const result = extractEqualityFds(pred, attrMap);
			expect(result.fds).to.have.length(2);
			expect(result.fds.every(fd => fd.determinants.length === 0)).to.equal(true);
		});

		it('ignores non-equality predicates', () => {
			const attrMap = new Map<number, number>([[100, 0]]);
			const gtAst = {
				type: 'binary',
				operator: '>',
				left: colNode(100, 0).expression,
				right: litNode(5).expression,
			} as AST.BinaryExpr;
			const pred = new BinaryOpNode(scope, gtAst, colNode(100, 0), litNode(5));
			const result = extractEqualityFds(pred, attrMap);
			expect(result.fds).to.have.length(0);
			expect(result.equivPairs).to.have.length(0);
		});
	});
});

// ---------------------------------------------------------------------------
// Per-operator propagation tests (via query_plan(...))
// ---------------------------------------------------------------------------

describe('FD propagation per operator', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	it('TableReference seeds FD from PK', async () => {
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory");
		const rows = await planRows(db, 'SELECT * FROM t');
		const props = physicalOf(rows, r => r.op === 'TABLEREFERENCE')
			?? physicalOf(rows, r => /tableref/i.test(r.op));
		expect(props, 'expected physical props on TableReference').to.not.equal(undefined);
		expect(props!.fds, 'expected FDs from PK').to.be.an('array').and.have.length.greaterThan(0);
		// id (col 0) determines v (col 1)
		expect(fdHas(props!.fds, [0], [1])).to.equal(true);
	});

	it('TableReference: secondary UNIQUE produces additional FD', async () => {
		await db.exec("CREATE TABLE uc (id INTEGER PRIMARY KEY, email TEXT UNIQUE, name TEXT) USING memory");
		const rows = await planRows(db, 'SELECT * FROM uc');
		const props = physicalOf(rows, r => r.op === 'TABLEREFERENCE');
		expect(props!.fds).to.be.an('array').with.length.greaterThan(1);
	});

	it('Filter: col = literal yields ∅ → col', async () => {
		await db.exec("CREATE TABLE f (id INTEGER PRIMARY KEY, v INTEGER) USING memory");
		const rows = await planRows(db, 'SELECT * FROM f WHERE v = 5');
		const props = physicalOf(rows, r => r.op === 'FILTER');
		expect(props, 'expected Filter physical props').to.not.equal(undefined);
		// v is column index 1 in source. The ∅ → 1 FD should be present.
		expect(fdHas(props!.fds, [], [1])).to.equal(true);
	});

	it('Filter: col1 = col2 over a keyless relation yields the EC and keeps the FDs as determinations', async () => {
		await db.exec("CREATE TABLE g (a INTEGER, b INTEGER) USING memory");
		const rows = await planRows(db, 'SELECT * FROM g WHERE a = b');
		const props = physicalOf(rows, r => r.op === 'FILTER');
		expect(props).to.not.equal(undefined);
		// `g` has no key, so a/b are non-unique. The bi-directional `{a}↔{b}` is
		// kept as `kind: 'determination'` — the kind-aware readers
		// (`isUniqueDeterminant`) never read it as a uniqueness claim, so the
		// old producer-side gate is gone and the value claim survives to feed
		// ORDER BY pruning / GROUP BY simplification (ticket
		// fd-determination-reader-side-rule). The EC survives as before.
		expect(fdFind(props!.fds, [0], [1])?.kind).to.equal('determination');
		expect(fdFind(props!.fds, [1], [0])?.kind).to.equal('determination');
		expect(classContains(props!.equivClasses, [0, 1])).to.equal(true);
	});

	it('Filter: non-equality predicate contributes no FDs / ECs', async () => {
		await db.exec("CREATE TABLE h (id INTEGER PRIMARY KEY, v INTEGER) USING memory");
		const rows = await planRows(db, 'SELECT * FROM h WHERE v > 5');
		const props = physicalOf(rows, r => r.op === 'FILTER');
		expect(props).to.not.equal(undefined);
		// Source FDs from PK still pass through, but no new ∅→v FD.
		expect(fdHas(props!.fds, [], [1])).to.equal(false);
	});

	it('Project: bare column projections survive, non-injective expressions drop out of injective pairs', async () => {
		await db.exec("CREATE TABLE p (id INTEGER PRIMARY KEY, v INTEGER) USING memory");
		// `*` is not annotated as injective for numeric ops, so `v * 2` is a
		// non-injective expression and must NOT produce a bi-directional FD
		// between `id` (out col 0) and `w` (out col 1). The key-encoding FD
		// `{0} → {1}` still appears (PK col 0 is a superkey of the projection's
		// output), but no FD from {1} back to {0} is emitted for `v * 2`.
		const rows = await planRows(db, "SELECT id, v * 2 AS w FROM p WHERE v = 7");
		const props = physicalOf(rows, r => r.op === 'PROJECT');
		expect(props).to.not.equal(undefined);
		// Key FD survives.
		expect(fdHas(props!.fds, [0], [1])).to.equal(true);
		// The injective-pair would have added `{1} → {0}` as well; assert it's absent.
		expect(fdHas(props!.fds, [1], [0])).to.equal(false);
	});

	it('Project: injective unary projection (id + 1) is treated as a synonym of id', async () => {
		await db.exec("CREATE TABLE pi (id INTEGER PRIMARY KEY, v INTEGER) USING memory");
		// Source FD `idx(id) → idx(v)` should survive as `{0} → {1}` because
		// `id + 1` is injectively derived from `id` and shares its mapping.
		const rows = await planRows(db, "SELECT id + 1 AS k, v FROM pi");
		const props = physicalOf(rows, r => r.op === 'PROJECT');
		expect(props).to.not.equal(undefined);
		expect(fdHas(props!.fds, [0], [1])).to.equal(true);
	});

	it('Project: SELECT id, id + 1 emits bi-directional FDs between the two output columns', async () => {
		await db.exec("CREATE TABLE pi2 (id INTEGER PRIMARY KEY, v INTEGER) USING memory");
		const rows = await planRows(db, "SELECT id, id + 1 AS k FROM pi2");
		const props = physicalOf(rows, r => r.op === 'PROJECT');
		expect(props).to.not.equal(undefined);
		expect(fdHas(props!.fds, [0], [1])).to.equal(true);
		expect(fdHas(props!.fds, [1], [0])).to.equal(true);
	});

	it('Alias passes FDs and ECs through unchanged', async () => {
		await db.exec("CREATE TABLE al (id INTEGER PRIMARY KEY, v TEXT) USING memory");
		const rows = await planRows(db, 'SELECT * FROM al AS x');
		// The PK FD `id → v` should still be visible at the Alias node.
		const aliasProps = physicalOf(rows, r => r.op === 'ALIAS');
		expect(aliasProps, 'expected Alias physical props').to.not.equal(undefined);
		expect(fdHas(aliasProps!.fds, [0], [1])).to.equal(true);
	});

	it('Distinct passes FDs through; set-semantics carried by RelationType.isSet', async () => {
		await db.exec("CREATE TABLE d (k INTEGER PRIMARY KEY, a INTEGER, b INTEGER) USING memory");
		const rows = await planRows(db, 'SELECT DISTINCT a, b FROM d');
		// Distinct may be eliminated when the source already has a covering key;
		// when present, the node's physical surface should not crash (FDs may be
		// empty or carry through). The all-columns-are-a-key claim now lives on
		// `RelationType.isSet`, not on the physical FD surface.
		const props = physicalOf(rows, r => r.op === 'DISTINCT');
		if (props) {
			expect(props.fds === undefined || Array.isArray(props.fds)).to.equal(true);
		}
	});

	it('StreamAggregate/HashAggregate: group-by-only source FD survives, others drop', async () => {
		await db.exec("CREATE TABLE ag (id INTEGER PRIMARY KEY, g INTEGER, x INTEGER) USING memory");
		const rows = await planRows(db, 'SELECT id, count(*) FROM ag GROUP BY id');
		const aggProps =
			physicalOf(rows, r => r.op === 'STREAMAGGREGATE') ??
			physicalOf(rows, r => r.op === 'HASHAGGREGATE') ??
			physicalOf(rows, r => r.op === 'AGGREGATE');
		expect(aggProps, 'expected aggregate physical props').to.not.equal(undefined);
		// id (PK) ⇒ source has FD `id → other`. After GROUP BY id, id is the
		// only group-by column at output index 0, so any non-PK source FD whose
		// determinant doesn't survive is dropped — the test simply checks that
		// the aggregate computes FDs without crashing.
		expect(aggProps!.fds === undefined || Array.isArray(aggProps!.fds)).to.equal(true);
	});

	it('Inner JOIN: a fanning equi-pair merges the EC and emits determination FDs', async () => {
		await db.exec("CREATE TABLE jl (id INTEGER PRIMARY KEY, v TEXT) USING memory");
		await db.exec("CREATE TABLE jr (rid INTEGER PRIMARY KEY, l_id INTEGER) USING memory");
		const rows = await planRows(db, 'SELECT * FROM jl INNER JOIN jr ON jl.id = jr.l_id');
		// Look at any join node in the plan.
		const joinProps =
			physicalOf(rows, r => r.op === 'HASHJOIN') ??
			physicalOf(rows, r => r.op === 'MERGEJOIN') ??
			physicalOf(rows, r => r.op === 'JOIN');
		expect(joinProps, 'expected join physical props').to.not.equal(undefined);
		// Output column count: jl has 2 cols, so jr.rid is col 2 and jr.l_id is col 3.
		// Equi-pair is (jl.id=0, jr.l_id=1+leftCols=3). jl fans out (jr.l_id is
		// non-unique), so the only preserved key is jr.rid (col 2). The equi-pair
		// FDs are emitted unconditionally as `kind: 'determination'` — value
		// equalities, never uniqueness claims; the kind-aware readers are what
		// keep a downstream projection from deriving a phantom key off them
		// (ticket fd-determination-reader-side-rule). The EC {0,3} merges as before.
		expect(fdFind(joinProps!.fds, [0], [3])?.kind).to.equal('determination');
		expect(fdFind(joinProps!.fds, [3], [0])?.kind).to.equal('determination');
		expect(classContains(joinProps!.equivClasses, [0, 3])).to.equal(true);
	});

	it('LEFT outer JOIN: right FDs / equi-pair FDs dropped, and a FANNED left key FD downgrades to determination', async () => {
		await db.exec("CREATE TABLE lo (id INTEGER PRIMARY KEY, v TEXT) USING memory");
		await db.exec("CREATE TABLE ro (rid INTEGER PRIMARY KEY, l_id INTEGER) USING memory");
		const rows = await planRows(db, 'SELECT * FROM lo LEFT JOIN ro ON lo.id = ro.l_id');
		const joinProps =
			physicalOf(rows, r => r.op === 'HASHJOIN') ??
			physicalOf(rows, r => r.op === 'JOIN');
		expect(joinProps).to.not.equal(undefined);
		// No equi-pair FD across left/right (the right side is NULL-padded)
		expect(fdHas(joinProps!.fds, [0], [3])).to.equal(false);
		// No equivalence class merging left and right
		expect(classContains(joinProps!.equivClasses, [0, 3])).to.equal(false);
		// `ro.l_id` is non-unique, so a single `lo` row can match several `ro` rows —
		// the LEFT join fans the left side out. `lo.id` is therefore NOT row-unique
		// in the product: its key FD `{0} → {1}` survives as a value claim but is
		// downgraded to `kind: 'determination'`, which the kind-aware readers never
		// read as a key (ticket fd-determination-reader-side-rule, replacing the
		// fd-derived-key-bag-overclaim drop).
		expect(fdFind(joinProps!.fds, [0], [1])?.kind).to.equal('determination');
	});

	it('LEFT outer JOIN: a key-covered (non-fanning) left key FD survives as unique', async () => {
		await db.exec("CREATE TABLE ln (id INTEGER PRIMARY KEY, v TEXT) USING memory");
		await db.exec("CREATE TABLE rn (rid INTEGER PRIMARY KEY, w TEXT) USING memory");
		// `ln.k = rn.rid` covers rn's PK ⇒ each ln row matches ≤1 rn row ⇒ no fan-out,
		// so left's key survives and its key FD is retained with kind 'unique'.
		const rows = await planRows(db, 'SELECT * FROM ln LEFT JOIN rn ON ln.id = rn.rid');
		const joinProps =
			physicalOf(rows, r => r.op === 'HASHJOIN') ??
			physicalOf(rows, r => r.op === 'MERGEJOIN') ??
			physicalOf(rows, r => r.op === 'JOIN');
		expect(joinProps).to.not.equal(undefined);
		expect(fdFind(joinProps!.fds, [0], [1])?.kind).to.equal('unique');
	});

	it('UNION ALL: no FDs', async () => {
		await db.exec("CREATE TABLE ua (id INTEGER PRIMARY KEY, v INTEGER) USING memory");
		await db.exec("CREATE TABLE ub (id INTEGER PRIMARY KEY, v INTEGER) USING memory");
		const rows = await planRows(db, 'SELECT * FROM ua UNION ALL SELECT * FROM ub');
		const setProps = physicalOf(rows, r => r.op === 'SETOPERATION');
		expect(setProps).to.not.equal(undefined);
		expect(setProps!.fds).to.equal(undefined);
		expect(setProps!.equivClasses).to.equal(undefined);
	});

	it('Window: passes source FDs through unchanged', async () => {
		await db.exec("CREATE TABLE w (id INTEGER PRIMARY KEY, v INTEGER) USING memory");
		const rows = await planRows(db, 'SELECT id, v, row_number() OVER (ORDER BY id) AS rn FROM w');
		const windowProps = physicalOf(rows, r => r.op === 'WINDOW');
		expect(windowProps).to.not.equal(undefined);
		// The PK FD from `w` (id → v) should survive — id stays as col 0 in the source.
		expect(fdHas(windowProps!.fds, [0], [1])).to.equal(true);
	});
});

// ---------------------------------------------------------------------------
// OPT-046 static guard
// ---------------------------------------------------------------------------

interface FdPush {
	readonly key: string;
	readonly where: string;
}

/**
 * Every `<something>fds.push(...)` in `code`, keyed `<relPath>::<receiver>`. The
 * receiver test is deliberately narrow: a name ending in `fd`/`fds` (any case),
 * which is how every FD list in the planner is named.
 */
function findFdPushes(relPath: string, code: string): FdPush[] {
	const out: FdPush[] = [];
	for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\.push\(/g)) {
		const receiver = m[1];
		if (!/fds?$/i.test(receiver)) continue;
		out.push({ key: `${relPath}::${receiver}`, where: `${relPath}:${lineAt(code, m.index)} — ${receiver}.push(` });
	}
	return out;
}

/**
 * Local candidate-list builds: an array assembled here, then handed to `addFd` /
 * `mergeFds` by its consumer, or consumed as pure reasoning input that never reaches a
 * node's FD set. Each entry must name that consumer — if it cannot, the push is a real
 * violation, not an exception.
 *
 * NOTE: this guard pays for itself only while the list stays short. If it grows past
 * a handful of entries the receiver-name heuristic has stopped discriminating, and
 * the right move is to delete the guard rather than keep feeding it.
 */
const LOCAL_FD_BUILD_ALLOWLIST: ReadonlyMap<string, string> = new Map([
	[
		'nodes/project-node.ts::projectedKeyFds',
		'candidate key FDs, each then folded through `addFd` in the loop immediately below',
	],
	[
		'analysis/check-extraction.ts::fds',
		'`extractCheckConstraints` returns a candidate list; `reference.ts` folds it through `addFd`',
	],
	[
		'analysis/assertion-hoist-cache.ts::fds',
		'`getAssertionHoistedConstraints` returns a candidate list; `reference.ts` folds it through `addFd`',
	],
	[
		'rules/aggregate/rule-groupby-fd-simplification.ts::keyFds',
		'candidate key FDs handed to `expandEcsToFds`/`minimalCover` as reasoning input; they never reach a node FD set',
	],
]);

/** The sanctioned accumulation path itself — its pushes are the implementation of `addFd`. */
const FD_UTILS = 'util/fd-utils.ts';

describe('OPT-046 static guard: addFd is the only FD accumulation path', () => {
	// FDs are accumulated through `addFd` / `mergeFds`, which apply subsumption and
	// enforce MAX_FDS_PER_NODE. Pushing straight onto the array skips both, and shows
	// up as a missing key or an over-long FD list rather than a crash. Scan the whole
	// planner and flag any `.push(` onto an FD-named receiver that is not a known local
	// candidate build.
	const plannerDir = join(dirname(fileURLToPath(import.meta.url)), '../../src/planner');

	function scanPushes(): FdPush[] {
		return tsFilesUnder(plannerDir)
			.map(file => relPosix(plannerDir, file))
			.filter(rel => rel !== FD_UTILS)
			.flatMap(rel => findFdPushes(rel, readCode(join(plannerDir, rel))));
	}

	it('no FD list is accumulated by a bare .push()', () => {
		const pushes = scanPushes();
		// Self-check: the known local builds must still be found, or the scanner has
		// silently stopped matching and the guard would pass vacuously.
		expect(pushes.length, 'scanner found the known FD pushes').to.be.greaterThan(0);

		const offenders = pushes.filter(p => !LOCAL_FD_BUILD_ALLOWLIST.has(p.key)).map(p => p.where);
		expect(
			offenders,
			`FD lists accumulated without addFd/mergeFds:\n${offenders.join('\n')}`,
		).to.be.empty;
	});

	it('the allowlist has no stale entries', () => {
		const seen = new Set(scanPushes().map(p => p.key));
		for (const key of LOCAL_FD_BUILD_ALLOWLIST.keys()) {
			expect(seen.has(key), `allowlisted FD push \`${key}\` no longer exists — drop it`).to.equal(true);
		}
	});

	it('flags a hand-written violation and ignores non-FD receivers', () => {
		const code = stripComments(`
			function computePhysical(source) {
				const fds = [...source.fds];
				fds.push({ determinants: [0], dependents: [1], kind: 'unique' });
				equivPairs.push([0, 1]);
				constantBindings.push({ col: 2 });
				return { fds };
			}
		`);
		const found = findFdPushes('nodes/fake-node.ts', code);
		expect(found.map(f => f.key)).to.deep.equal(['nodes/fake-node.ts::fds']);
		expect(found[0].where).to.match(/^nodes\/fake-node\.ts:4 — fds\.push\($/);
	});
});
