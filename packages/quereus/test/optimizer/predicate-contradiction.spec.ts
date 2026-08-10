import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { EmptyScope } from '../../src/planner/scopes/empty.js';
import { checkSatisfiability } from '../../src/planner/analysis/sat-checker.js';
import {
	BetweenNode,
	BinaryOpNode,
	LiteralNode,
	UnaryOpNode,
} from '../../src/planner/nodes/scalar.js';
import { InNode } from '../../src/planner/nodes/subquery.js';
import { ColumnReferenceNode } from '../../src/planner/nodes/reference.js';
import type { ConstantBinding, DomainConstraint, ScalarPlanNode } from '../../src/planner/nodes/plan-node.js';
import type * as AST from '../../src/parser/ast.js';
import { INTEGER_TYPE, TEXT_TYPE } from '../../src/types/builtin-types.js';

const scope = EmptyScope.instance;

function intCol(attrId: number, name: string, index: number): ColumnReferenceNode {
	const expr: AST.ColumnExpr = { type: 'column', name };
	return new ColumnReferenceNode(
		scope,
		expr,
		{ typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: false },
		attrId,
		index,
	);
}

function textCol(attrId: number, name: string, index: number): ColumnReferenceNode {
	const expr: AST.ColumnExpr = { type: 'column', name };
	return new ColumnReferenceNode(
		scope,
		expr,
		{ typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: false },
		attrId,
		index,
	);
}

function lit(value: AST.LiteralExpr['value']): LiteralNode {
	return new LiteralNode(scope, { type: 'literal', value });
}

function bin(op: string, left: ScalarPlanNode, right: ScalarPlanNode): BinaryOpNode {
	const ast: AST.BinaryExpr = { type: 'binary', operator: op, left: left.expression, right: right.expression };
	return new BinaryOpNode(scope, ast, left, right);
}

function betweenNode(expr: ScalarPlanNode, lo: ScalarPlanNode, hi: ScalarPlanNode): BetweenNode {
	const ast: AST.BetweenExpr = { type: 'between', expr: expr.expression, lower: lo.expression, upper: hi.expression };
	return new BetweenNode(scope, ast, expr, lo, hi);
}

function inListNode(condition: ScalarPlanNode, values: ScalarPlanNode[]): InNode {
	const ast: AST.InExpr = {
		type: 'in',
		expr: condition.expression,
		values: values.map(v => v.expression),
	};
	return new InNode(scope, ast, condition, undefined, values);
}

function likeNode(left: ScalarPlanNode, pattern: ScalarPlanNode): BinaryOpNode {
	// Synthesize a `LIKE` comparison as a binary op. The checker treats unknown
	// operators as out-of-scope (sawUnknown), which is what we're testing.
	const ast: AST.BinaryExpr = { type: 'binary', operator: 'LIKE', left: left.expression, right: pattern.expression };
	return new BinaryOpNode(scope, ast, left, pattern);
}

function notNode(operand: ScalarPlanNode): UnaryOpNode {
	const ast: AST.UnaryExpr = { type: 'unary', operator: 'NOT', expr: operand.expression };
	return new UnaryOpNode(scope, ast, operand);
}

// Identity attrIndex: attr id `n` maps to column index `n`.
const identity = (n: number): number | undefined => n;

describe('checkSatisfiability (unit)', () => {
	it('detects range collapse: x ∈ [5,10] ∧ x ∈ [20,30] → unsat', () => {
		const x = intCol(0, 'x', 0);
		const conjuncts: ScalarPlanNode[] = [
			betweenNode(x, lit(5), lit(10)),
			betweenNode(x, lit(20), lit(30)),
		];
		expect(checkSatisfiability(conjuncts, [], [], identity)).to.equal('unsat');
	});

	it('detects equality conflict: x = 5 ∧ x = 7 → unsat', () => {
		const x = intCol(0, 'x', 0);
		const conjuncts: ScalarPlanNode[] = [
			bin('=', x, lit(5)),
			bin('=', x, lit(7)),
		];
		expect(checkSatisfiability(conjuncts, [], [], identity)).to.equal('unsat');
	});

	it('detects enum × enum disjoint: x IN (1,2,3) ∧ x IN (4,5,6) → unsat', () => {
		const x = intCol(0, 'x', 0);
		const conjuncts: ScalarPlanNode[] = [
			inListNode(x, [lit(1), lit(2), lit(3)]),
			inListNode(x, [lit(4), lit(5), lit(6)]),
		];
		expect(checkSatisfiability(conjuncts, [], [], identity)).to.equal('unsat');
	});

	it('detects enum × range disjoint: x IN (1,2,3) ∧ x > 10 → unsat', () => {
		const x = intCol(0, 'x', 0);
		const conjuncts: ScalarPlanNode[] = [
			inListNode(x, [lit(1), lit(2), lit(3)]),
			bin('>', x, lit(10)),
		];
		expect(checkSatisfiability(conjuncts, [], [], identity)).to.equal('unsat');
	});

	it('detects inclusive boundary contradiction: x > 5 ∧ x <= 5 → unsat', () => {
		const x = intCol(0, 'x', 0);
		const conjuncts: ScalarPlanNode[] = [
			bin('>', x, lit(5)),
			bin('<=', x, lit(5)),
		];
		expect(checkSatisfiability(conjuncts, [], [], identity)).to.equal('unsat');
	});

	it('accepts inclusive boundary: x >= 5 ∧ x <= 5 → sat', () => {
		const x = intCol(0, 'x', 0);
		const conjuncts: ScalarPlanNode[] = [
			bin('>=', x, lit(5)),
			bin('<=', x, lit(5)),
		];
		expect(checkSatisfiability(conjuncts, [], [], identity)).to.equal('sat');
	});

	it('detects disequality + point: x = 5 ∧ x != 5 → unsat', () => {
		const x = intCol(0, 'x', 0);
		const conjuncts: ScalarPlanNode[] = [
			bin('=', x, lit(5)),
			bin('!=', x, lit(5)),
		];
		expect(checkSatisfiability(conjuncts, [], [], identity)).to.equal('unsat');
	});

	it('returns unknown for out-of-scope only: x like "%foo"', () => {
		const x = textCol(0, 'x', 0);
		const conjuncts: ScalarPlanNode[] = [likeNode(x, lit('%foo'))];
		expect(checkSatisfiability(conjuncts, [], [], identity)).to.equal('unknown');
	});

	it('mixed: in-scope contradiction wins over unrelated unknown clause', () => {
		const x = intCol(0, 'x', 0);
		const y = textCol(1, 'y', 1);
		const conjuncts: ScalarPlanNode[] = [
			bin('=', x, lit(5)),
			bin('=', x, lit(7)),
			likeNode(y, lit('%foo')), // unknown on a different column
		];
		expect(checkSatisfiability(conjuncts, [], [], identity)).to.equal('unsat');
	});

	it('detects domain × predicate disjoint: domain [0,∞) ∩ x < 0 → unsat', () => {
		const x = intCol(0, 'x', 0);
		const domains: DomainConstraint[] = [
			{ kind: 'range', column: 0, min: 0, minInclusive: true, maxInclusive: false },
		];
		const conjuncts: ScalarPlanNode[] = [bin('<', x, lit(0))];
		expect(checkSatisfiability(conjuncts, domains, [], identity)).to.equal('unsat');
	});

	it('detects temporal contradiction across ISO date strings', () => {
		const created = textCol(0, 'created_at', 0);
		const conjuncts: ScalarPlanNode[] = [
			bin('<', created, lit('2024-01-01')),
			bin('>', created, lit('2025-01-01')),
		];
		expect(checkSatisfiability(conjuncts, [], [], identity)).to.equal('unsat');
	});

	it('detects binding × predicate conflict: binding x=5 ∧ x = 7 → unsat', () => {
		const x = intCol(0, 'x', 0);
		const bindings: ConstantBinding[] = [
			{ attrs: [0], value: { kind: 'literal', value: 5 } },
		];
		const conjuncts: ScalarPlanNode[] = [bin('=', x, lit(7))];
		expect(checkSatisfiability(conjuncts, [], bindings, identity)).to.equal('unsat');
	});

	it('parameter binding contributes no facts (unknown only)', () => {
		const x = intCol(0, 'x', 0);
		const bindings: ConstantBinding[] = [
			{ attrs: [0], value: { kind: 'parameter', paramRef: 1 } },
		];
		const conjuncts: ScalarPlanNode[] = [bin('=', x, lit(7))];
		// A literal binding would conflict; a parameter binding leaves x unrestricted.
		expect(checkSatisfiability(conjuncts, [], bindings, identity)).to.equal('sat');
	});

	it('column on RHS of comparison is normalized (flipComparison)', () => {
		const x = intCol(0, 'x', 0);
		const conjuncts: ScalarPlanNode[] = [
			bin('<', lit(10), x), // x > 10
			bin('<', x, lit(5)),
		];
		expect(checkSatisfiability(conjuncts, [], [], identity)).to.equal('unsat');
	});

	it('returns sat when no constraints conflict', () => {
		const x = intCol(0, 'x', 0);
		const conjuncts: ScalarPlanNode[] = [
			bin('>=', x, lit(0)),
			bin('<', x, lit(100)),
		];
		expect(checkSatisfiability(conjuncts, [], [], identity)).to.equal('sat');
	});

	it('NULL literal in comparison falls back to unknown (no false unsat)', () => {
		const x = intCol(0, 'x', 0);
		const conjuncts: ScalarPlanNode[] = [
			bin('<', x, lit(null)),
			bin('>=', x, lit(0)),
		];
		// `x < NULL` is UNKNOWN; result is not provably unsat or sat.
		expect(checkSatisfiability(conjuncts, [], [], identity)).to.equal('unknown');
	});

	it('detects empty IN-list: x IN () → unsat', () => {
		const x = intCol(0, 'x', 0);
		const conjuncts: ScalarPlanNode[] = [
			inListNode(x, []),
		];
		expect(checkSatisfiability(conjuncts, [], [], identity)).to.equal('unsat');
	});

	it('NULL members do not rescue contradiction: x = 2 ∧ x IN (1, NULL) → unsat', () => {
		// intersectAllowed strips NULLs before intersecting, so {1, NULL} ∩ x=2 = ∅.
		const x = intCol(0, 'x', 0);
		const conjuncts: ScalarPlanNode[] = [
			bin('=', x, lit(2)),
			inListNode(x, [lit(1), lit(null)]),
		];
		expect(checkSatisfiability(conjuncts, [], [], identity)).to.equal('unsat');
	});

	it('NOT (...) is out of scope (does not over-conclude)', () => {
		const x = intCol(0, 'x', 0);
		const conjuncts: ScalarPlanNode[] = [
			bin('=', x, lit(5)),
			notNode(bin('=', x, lit(5))),
		];
		// NOT/IS NULL set sawUnknown; the eq + eq alone don't conflict, so result is sat.
		const r = checkSatisfiability(conjuncts, [], [], identity);
		// We accept either sat or unknown — the key guarantee is no false unsat.
		expect(r === 'sat' || r === 'unknown').to.equal(true);
	});
});

describe('checkSatisfiability collation resolution (unit)', () => {
	/** `x = 'a' ∧ x = 'A'` — unsat under BINARY, satisfiable under any case-folding collation. */
	function caseConflict(): ScalarPlanNode[] {
		const x = textCol(0, 'x', 0);
		return [bin('=', x, lit('a')), bin('=', x, lit('A'))];
	}

	it("x = 'a' ∧ x = 'A' is unsat on a BINARY column", () => {
		expect(checkSatisfiability(caseConflict(), [], [], identity, () => 'BINARY')).to.equal('unsat');
	});

	it("x = 'a' ∧ x = 'A' is satisfiable on a NOCASE column", () => {
		expect(checkSatisfiability(caseConflict(), [], [], identity, () => 'NOCASE')).to.equal('sat');
	});

	it('a collation name outside the built-ins yields unknown when no resolver is supplied', () => {
		expect(checkSatisfiability(caseConflict(), [], [], identity, () => 'REVERSE')).to.equal('unknown');
	});

	it('a supplied resolver makes the custom collation decidable', () => {
		const reverse = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);
		const resolver = (name: string) => {
			if (name.toUpperCase() !== 'REVERSE') throw new Error(`no such collation sequence: ${name}`);
			return reverse;
		};
		// Under REVERSE, 'a' and 'A' are still distinct — so the conflict stands.
		expect(checkSatisfiability(caseConflict(), [], [], identity, () => 'REVERSE', resolver)).to.equal('unsat');

		// ... but two names that the custom collation equates must not be called a conflict.
		const x = textCol(0, 'x', 0);
		const lengthOnly = (a: string, b: string) => a.length - b.length;
		const lenResolver = (_name: string) => lengthOnly;
		const conjuncts = [bin('=', x, lit('a')), bin('=', x, lit('b'))];
		expect(checkSatisfiability(conjuncts, [], [], identity, () => 'LENGTH', lenResolver)).to.equal('sat');
	});

	it('a resolver that throws on the name degrades to unknown, not to BINARY', () => {
		const throwing = (name: string): never => { throw new Error(`no such collation sequence: ${name}`); };
		expect(checkSatisfiability(caseConflict(), [], [], identity, () => 'FROBNICATE', throwing)).to.equal('unknown');
	});

	it('a column with no declared collation still compares under BINARY', () => {
		expect(checkSatisfiability(caseConflict(), [], [], identity, () => undefined)).to.equal('unsat');
	});
});

// ---------------------------------------------------------------------------
// End-to-end: query_plan + execution
// ---------------------------------------------------------------------------

interface PlanRow {
	node_type: string;
	op: string;
	detail: string;
	physical: string | null;
}

async function planRows(db: Database, sql: string): Promise<PlanRow[]> {
	const rows: PlanRow[] = [];
	for await (const r of db.eval('SELECT node_type, op, detail, physical FROM query_plan(?)', [sql])) {
		rows.push(r as unknown as PlanRow);
	}
	return rows;
}

function hasOp(rows: readonly PlanRow[], op: string): boolean {
	return rows.some(r => r.op === op);
}

async function results(db: Database, sql: string): Promise<unknown[]> {
	const rows: unknown[] = [];
	for await (const r of db.eval(sql)) rows.push(r);
	return rows;
}

describe('Predicate contradiction folding (end-to-end)', () => {
	let db: Database;

	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	it("CHECK(qty >= 0) + WHERE qty < 0 → empty (no SeqScan)", async () => {
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, qty INTEGER, CHECK (qty >= 0)) USING memory");
		await db.exec("INSERT INTO t VALUES (1, 10), (2, 20)");
		const sql = 'SELECT * FROM t WHERE qty < 0';
		const plan = await planRows(db, sql);
		expect(hasOp(plan, 'EMPTYRELATION'), `plan ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
		expect(hasOp(plan, 'SEQSCAN')).to.equal(false);
		const rows = await results(db, sql);
		expect(rows).to.have.lengthOf(0);
	});

	it("CHECK(status IN ('a','i')) + WHERE status = 'x' → empty", async () => {
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, status TEXT, CHECK (status IN ('a','i'))) USING memory");
		await db.exec("INSERT INTO t VALUES (1, 'a'), (2, 'i')");
		const sql = "SELECT * FROM t WHERE status = 'x'";
		const plan = await planRows(db, sql);
		expect(hasOp(plan, 'EMPTYRELATION'), `plan ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
		const rows = await results(db, sql);
		expect(rows).to.have.lengthOf(0);
	});

	it("WHERE x BETWEEN 0 AND 5 AND x BETWEEN 10 AND 20 → empty", async () => {
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, x INTEGER) USING memory");
		await db.exec("INSERT INTO t VALUES (1, 3), (2, 15)");
		const sql = "SELECT * FROM t WHERE x BETWEEN 0 AND 5 AND x BETWEEN 10 AND 20";
		const plan = await planRows(db, sql);
		expect(hasOp(plan, 'EMPTYRELATION'), `plan ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
		const rows = await results(db, sql);
		expect(rows).to.have.lengthOf(0);
	});

	it("WHERE x >= 5 AND x <= 5 still returns matching rows (boundary satisfiable)", async () => {
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, x INTEGER) USING memory");
		await db.exec("INSERT INTO t VALUES (1, 4), (2, 5), (3, 6)");
		const sql = "SELECT id FROM t WHERE x >= 5 AND x <= 5";
		const plan = await planRows(db, sql);
		// Must NOT fold to empty.
		expect(hasOp(plan, 'EMPTYRELATION')).to.equal(false);
		const rows = await results(db, sql) as { id: number }[];
		expect(rows).to.have.lengthOf(1);
		expect(rows[0].id).to.equal(2);
	});

	it("CHECK(qty>=0) + WHERE qty<0 AND name LIKE '%foo' folds even with unknown clause", async () => {
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, qty INTEGER, name TEXT, CHECK (qty >= 0)) USING memory");
		await db.exec("INSERT INTO t VALUES (1, 5, 'abc')");
		const sql = "SELECT * FROM t WHERE qty < 0 AND name LIKE '%foo'";
		const plan = await planRows(db, sql);
		expect(hasOp(plan, 'EMPTYRELATION'), `plan ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
		const rows = await results(db, sql);
		expect(rows).to.have.lengthOf(0);
	});

	it("WHERE NULL folds to empty (lit-null short-circuit)", async () => {
		// Pins the cascade for the contradiction-rule path: with the lit-null
		// short-circuit it bails to ruleFilterFoldEmpty, which collapses to
		// EmptyRelationNode.
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, x INTEGER) USING memory");
		await db.exec("INSERT INTO t VALUES (1, 1), (2, 2)");
		const sql = "SELECT * FROM t WHERE NULL";
		const plan = await planRows(db, sql);
		expect(hasOp(plan, 'EMPTYRELATION'), `plan ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
		const rows = await results(db, sql);
		expect(rows).to.have.lengthOf(0);
	});

	it("non-contradicting WHERE with a CHECK domain leaves the plan intact", async () => {
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, qty INTEGER, CHECK (qty >= 0)) USING memory");
		await db.exec("INSERT INTO t VALUES (1, 0), (2, 1), (3, 2)");
		const sql = 'SELECT id FROM t WHERE qty < 100';
		const plan = await planRows(db, sql);
		expect(hasOp(plan, 'EMPTYRELATION')).to.equal(false);
		const rows = await results(db, sql) as { id: number }[];
		expect(rows).to.have.lengthOf(3);
	});

	it("WHERE x = 'a' AND x = 'A' on a NOCASE column returns the row (built-in collation)", async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, x TEXT COLLATE NOCASE)');
		await db.exec("INSERT INTO t VALUES (1, 'a')");
		const sql = "SELECT id FROM t WHERE x = 'a' AND x = 'A'";
		expect(hasOp(await planRows(db, sql), 'EMPTYRELATION')).to.equal(false);
		expect(await results(db, sql)).to.have.lengthOf(1);
	});

	it("WHERE x = 'a' AND x = 'A' on a BINARY column still folds to empty", async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, x TEXT)');
		await db.exec("INSERT INTO t VALUES (1, 'a')");
		const sql = "SELECT id FROM t WHERE x = 'a' AND x = 'A'";
		expect(hasOp(await planRows(db, sql), 'EMPTYRELATION')).to.equal(true);
		expect(await results(db, sql)).to.have.lengthOf(0);
	});

	it('a collation registered on the connection is honored, not degraded to BINARY', async () => {
		// A NOCASE that equates every same-length string. The rows the runtime returns for
		// each conjunct alone must also come back for their conjunction.
		db.registerCollation('NOCASE', (a, b) => a.length - b.length);
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, x TEXT COLLATE NOCASE)');
		await db.exec("INSERT INTO t VALUES (1, 'a')");
		expect(await results(db, "SELECT id FROM t WHERE x = 'a'")).to.have.lengthOf(1);
		expect(await results(db, "SELECT id FROM t WHERE x = 'b'")).to.have.lengthOf(1);
		const sql = "SELECT id FROM t WHERE x = 'a' AND x = 'b'";
		expect(hasOp(await planRows(db, sql), 'EMPTYRELATION')).to.equal(false);
		expect(await results(db, sql)).to.have.lengthOf(1);
	});

	it('a custom collation reaching the checker through a projected attribute is honored', async () => {
		// Column DDL does not accept a custom collation name yet, but a COLLATE in a
		// projection stamps it on the attribute's type — which is what the checker reads.
		db.registerCollation('REVERSE', (a, b) => (a < b ? 1 : a > b ? -1 : 0));
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, x TEXT)');
		await db.exec("INSERT INTO t VALUES (1, 'AB')");
		// Under REVERSE, 'B' sorts before 'A', so the open interval ('B','A') is non-empty
		// and contains 'AB'. Under BINARY the same interval is empty.
		const sql = "SELECT id FROM (SELECT id, x COLLATE REVERSE AS y FROM t) WHERE y > 'B' AND y < 'A'";
		expect(hasOp(await planRows(db, sql), 'EMPTYRELATION')).to.equal(false);
		expect(await results(db, sql)).to.have.lengthOf(1);
	});

	it('an explicit COLLATE on the compared column is not erased', async () => {
		// `x COLLATE NOCASE = 'a'` compares under NOCASE even though `x` is BINARY, so the
		// conjunction is satisfiable. Stripping the wrapper would prove a false contradiction.
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, x TEXT)');
		await db.exec("INSERT INTO t VALUES (1, 'a')");
		const sql = "SELECT id FROM t WHERE x COLLATE NOCASE = 'a' AND x COLLATE NOCASE = 'A'";
		expect(hasOp(await planRows(db, sql), 'EMPTYRELATION')).to.equal(false);
		expect(await results(db, sql)).to.have.lengthOf(1);
	});

	it('a value-changing CAST on the compared column is not erased', async () => {
		// `cast(x as integer) = 1` says nothing about `x = '1'` being false.
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, x TEXT)');
		await db.exec("INSERT INTO t VALUES (1, '1')");
		const sql = "SELECT id FROM t WHERE x = '1' AND CAST(x AS INTEGER) = 1";
		expect(hasOp(await planRows(db, sql), 'EMPTYRELATION')).to.equal(false);
		expect(await results(db, sql)).to.have.lengthOf(1);
	});

	it('a custom collation on an unrelated column does not fail the query', async () => {
		// A CHECK on a column with a non-BINARY collation publishes a DomainConstraint naming
		// that column, so the predicate-contradiction checker must resolve the column's collation
		// even though no emitted comparison in this query touches it. Since
		// feat-ddl-accepts-registered-collations, an explicit COLLATE is accepted on ANY column
		// type only when the collation is registered (an unregistered name is now rejected at
		// CREATE), so register it first; the checker resolves it cleanly and the query plans
		// without a false contradiction. (The checker still defensively answers `unknown` for an
		// unresolvable collation — see sat-checker.ts `tryResolve` — but that branch is no longer
		// reachable via DDL.)
		db.registerCollation('MYCOLL', (a, b) => (a < b ? -1 : a > b ? 1 : 0));
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, k INTEGER COLLATE MYCOLL CHECK (k > 0))');
		const sql = 'SELECT id FROM t WHERE id = 1';
		expect(hasOp(await planRows(db, sql), 'EMPTYRELATION')).to.equal(false);
		expect(await results(db, sql)).to.have.lengthOf(0);
	});
});
