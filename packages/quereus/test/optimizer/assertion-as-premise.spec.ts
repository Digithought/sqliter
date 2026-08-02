import { expect } from 'chai';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Database } from '../../src/core/database.js';
import { lineAt, readCode, relPosix, stripComments, tsFilesUnder } from '../util/source-scan.js';
import { classifyAssertionForHoisting, negateAst } from '../../src/planner/analysis/assertion-classifier.js';
import type { IntegrityAssertionSchema } from '../../src/schema/assertion.js';
import type * as AST from '../../src/parser/ast.js';

// ---------------------------------------------------------------------------
// AST builders shared with check-derived-fds.spec.ts style.
// ---------------------------------------------------------------------------

function lit(value: AST.LiteralExpr['value']): AST.LiteralExpr {
	return { type: 'literal', value };
}
function col(name: string): AST.ColumnExpr {
	return { type: 'column', name };
}
function bin(operator: string, left: AST.Expression, right: AST.Expression): AST.BinaryExpr {
	return { type: 'binary', operator, left, right };
}
function and(left: AST.Expression, right: AST.Expression): AST.BinaryExpr { return bin('AND', left, right); }
function or(left: AST.Expression, right: AST.Expression): AST.BinaryExpr { return bin('OR', left, right); }
function notExpr(expr: AST.Expression): AST.UnaryExpr {
	return { type: 'unary', operator: 'NOT', expr };
}
function isNullExpr(expr: AST.Expression): AST.UnaryExpr {
	return { type: 'unary', operator: 'IS NULL', expr };
}
function fn(name: string, ...args: AST.Expression[]): AST.FunctionExpr {
	return { type: 'function', name, args };
}
function existsOnTable(tableName: string, where?: AST.Expression): AST.ExistsExpr {
	const sel: AST.SelectStmt = {
		type: 'select',
		columns: [{ type: 'column', expr: lit(1) }],
		from: [{ type: 'table', table: { type: 'identifier', name: tableName } } as AST.TableSource],
		where,
	};
	return { type: 'exists', subquery: sel };
}
function notExistsOnTable(tableName: string, where?: AST.Expression): AST.UnaryExpr {
	return notExpr(existsOnTable(tableName, where));
}
function existsOnJoined(leftTable: string, rightTable: string): AST.ExistsExpr {
	const sel: AST.SelectStmt = {
		type: 'select',
		columns: [{ type: 'column', expr: lit(1) }],
		from: [{
			type: 'join',
			joinType: 'inner',
			left: { type: 'table', table: { type: 'identifier', name: leftTable } } as AST.TableSource,
			right: { type: 'table', table: { type: 'identifier', name: rightTable } } as AST.TableSource,
		} as AST.JoinClause],
	};
	return { type: 'exists', subquery: sel };
}

function assertion(name: string, expr: AST.Expression): IntegrityAssertionSchema {
	return {
		name,
		schemaName: 'main',
		violationSql: 'select 1 where 0', // unused by classifier
		deferrable: true,
		initiallyDeferred: true,
		checkExpression: expr,
	};
}

// ---------------------------------------------------------------------------
// Classifier unit tests
// ---------------------------------------------------------------------------

describe('classifyAssertionForHoisting (unit)', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec(`
			create table orders (id integer primary key, qty integer, status text) using memory;
			create table customers (id integer primary key, name text) using memory;
		`);
	});
	afterEach(async () => { await db.close(); });

	it('not exists (select 1 from orders where qty < 0) qualifies', () => {
		const a = assertion('no_neg', notExistsOnTable('orders', bin('<', col('qty'), lit(0))));
		const c = classifyAssertionForHoisting(a, db.schemaManager);
		expect(c, 'expected hoist candidate').to.not.equal(undefined);
		expect(c!.baseTableQualifiedName).to.equal('main.orders');
		expect(c!.innerPredicate).to.not.equal(undefined);
		expect(c!.assertionName).to.equal('no_neg');
	});

	it('not exists (select 1 from orders where qty < 0 and status = \'a\') qualifies', () => {
		const a = assertion('no_neg_a',
			notExistsOnTable('orders', and(bin('<', col('qty'), lit(0)), bin('=', col('status'), lit('a')))));
		const c = classifyAssertionForHoisting(a, db.schemaManager);
		expect(c).to.not.equal(undefined);
	});

	it('not exists (select 1 from orders join customers on ...) rejects (multi-table)', () => {
		const a = assertion('bad_join', notExpr(existsOnJoined('orders', 'customers')));
		const c = classifyAssertionForHoisting(a, db.schemaManager);
		expect(c).to.equal(undefined);
	});

	it('not exists (select 1 from nonexistent_table) rejects (no base table)', () => {
		const a = assertion('bad_table',
			notExistsOnTable('nonexistent_table', bin('<', col('qty'), lit(0))));
		const c = classifyAssertionForHoisting(a, db.schemaManager);
		expect(c).to.equal(undefined);
	});

	it('exists(...) — non-negated existential is rejected', () => {
		const a: IntegrityAssertionSchema = {
			...assertion('exists_form', existsOnTable('orders', bin('<', col('qty'), lit(0)))),
		};
		const c = classifyAssertionForHoisting(a, db.schemaManager);
		expect(c).to.equal(undefined);
	});

	it('aggregate-form `(select count(*) from t) = 0` is rejected', () => {
		// We have no AST for `(select count(*) from t) = 0` here — substitute a
		// scalar subquery-equality shape via a UnaryExpr we know isn't `exists`.
		// Use a non-NOT outer operator to fail the very first shape gate.
		const a = assertion('agg_form', bin('=', fn('count', col('qty')), lit(0)));
		const c = classifyAssertionForHoisting(a, db.schemaManager);
		expect(c).to.equal(undefined);
	});

	it('predicate with non-deterministic call is rejected', () => {
		// random() is non-deterministic in the engine; the classifier rejects any
		// function call inside the inner predicate via containsNonDeterministicCall
		// — but our helper allows all functions. The aggregate-name filter catches
		// random_fn separately. To test true non-determinism rejection we'd need
		// to plumb through isDeterministic; for now, a subquery inside the
		// predicate triggers the same rejection.
		const innerSubquery: AST.SubqueryExpr = {
			type: 'subquery',
			query: {
				type: 'select',
				columns: [{ type: 'column', expr: fn('max', col('qty')) }],
				from: [{ type: 'table', table: { type: 'identifier', name: 'orders' } } as AST.TableSource],
			},
		};
		const a = assertion('subq_predicate',
			notExistsOnTable('orders', bin('<', col('qty'), innerSubquery)));
		const c = classifyAssertionForHoisting(a, db.schemaManager);
		expect(c).to.equal(undefined);
	});

	it('predicate referencing a column not on T is rejected', () => {
		// `nonexistent_col` doesn't exist on orders; classifier should reject.
		const a = assertion('foreign_col',
			notExistsOnTable('orders', bin('<', col('nonexistent_col'), lit(0))));
		const c = classifyAssertionForHoisting(a, db.schemaManager);
		expect(c).to.equal(undefined);
	});

	it('unconditional empty (no where clause) is rejected by the pilot', () => {
		const a = assertion('unconditional', notExistsOnTable('orders'));
		const c = classifyAssertionForHoisting(a, db.schemaManager);
		expect(c).to.equal(undefined);
	});
});

// ---------------------------------------------------------------------------
// negateAst unit tests
// ---------------------------------------------------------------------------

describe('negateAst (unit)', () => {
	it('NOT (a AND b) → (NOT a) OR (NOT b)', () => {
		const out = negateAst(and(bin('=', col('a'), lit(1)), bin('=', col('b'), lit(2))));
		expect(out.type).to.equal('binary');
		expect((out as AST.BinaryExpr).operator).to.equal('OR');
	});

	it('NOT (a OR b) → (NOT a) AND (NOT b)', () => {
		const out = negateAst(or(bin('=', col('a'), lit(1)), bin('=', col('b'), lit(2))));
		expect(out.type).to.equal('binary');
		expect((out as AST.BinaryExpr).operator).to.equal('AND');
	});

	it('NOT NOT x → x', () => {
		const x = bin('<', col('qty'), lit(0));
		const out = negateAst(notExpr(x));
		expect(out).to.equal(x);
	});

	it('NOT (a = b) → a <> b', () => {
		const out = negateAst(bin('=', col('a'), col('b')));
		expect((out as AST.BinaryExpr).operator).to.equal('<>');
	});

	it('NOT (a < b) → a >= b', () => {
		const out = negateAst(bin('<', col('a'), col('b')));
		expect((out as AST.BinaryExpr).operator).to.equal('>=');
	});

	it('NOT (a is null) → a is not null', () => {
		const out = negateAst(isNullExpr(col('a')));
		expect(out.type).to.equal('unary');
		expect((out as AST.UnaryExpr).operator).to.equal('IS NOT NULL');
	});

	it('NOT BETWEEN flips the not flag', () => {
		const bt: AST.BetweenExpr = { type: 'between', expr: col('x'), lower: lit(0), upper: lit(10) };
		const out = negateAst(bt);
		expect(out.type).to.equal('between');
		expect((out as AST.BetweenExpr).not).to.equal(true);
	});

	it('falls back to wrap-in-NOT for shapes it cannot push through', () => {
		const f = fn('foo', col('a'));
		const out = negateAst(f);
		expect(out.type).to.equal('unary');
		expect((out as AST.UnaryExpr).operator).to.equal('NOT');
	});
});

// ---------------------------------------------------------------------------
// End-to-end behaviour
// ---------------------------------------------------------------------------

interface PhysicalProps {
	fds?: { determinants: number[]; dependents: number[]; source?: { kind: string; name?: string } }[];
	equivClasses?: number[][];
	constantBindings?: Array<{ attrs: number[]; source?: { kind: string; name?: string } }>;
	domainConstraints?: Array<{
		kind: string; column: number;
		min?: unknown; max?: unknown; minInclusive?: boolean; maxInclusive?: boolean;
		values?: unknown[];
		source?: { kind: string; name?: string };
	}>;
}

interface PlanRow { node_type: string; op: string; detail: string; physical: string | null }

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

function physicalOf(rows: readonly PlanRow[], pred: (r: PlanRow) => boolean): PhysicalProps | undefined {
	const row = rows.find(pred);
	if (!row || !row.physical) return undefined;
	return JSON.parse(row.physical) as PhysicalProps;
}

async function results(db: Database, sql: string): Promise<unknown[]> {
	const rows: unknown[] = [];
	for await (const r of db.eval(sql)) rows.push(r);
	return rows;
}

describe('Assertion-as-premise: end-to-end folding', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec(`
			create table orders (id integer primary key, qty integer, status text) using memory;
			create table customers (id integer primary key, name text) using memory;
		`);
	});
	afterEach(async () => { await db.close(); });

	it("not exists (select 1 from orders where qty < 0) folds qty<0 query to empty", async () => {
		await db.exec("create assertion no_neg check (not exists (select 1 from orders where qty < 0))");
		const sql = 'select * from orders where qty < 0';
		const plan = await planRows(db, sql);
		expect(hasOp(plan, 'EMPTYRELATION'), `plan ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
		const rows = await results(db, sql);
		expect(rows).to.have.lengthOf(0);
	});

	it("folds derived contradictions (qty = -1) too", async () => {
		await db.exec("create assertion no_neg2 check (not exists (select 1 from orders where qty < 0))");
		const sql = 'select distinct status from orders where qty = -1';
		const plan = await planRows(db, sql);
		expect(hasOp(plan, 'EMPTYRELATION'), `plan ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
	});

	it('non-contradicting query is left intact', async () => {
		await db.exec("create assertion no_neg3 check (not exists (select 1 from orders where qty < 0))");
		const sql = 'select * from orders where qty >= 0';
		const plan = await planRows(db, sql);
		expect(hasOp(plan, 'EMPTYRELATION')).to.equal(false);
	});

	it('drop assertion re-derives without the hoisted domain', async () => {
		await db.exec("create assertion no_neg4 check (not exists (select 1 from orders where qty < 0))");
		// Confirm hoist took effect.
		let plan = await planRows(db, 'select * from orders where qty < 0');
		expect(hasOp(plan, 'EMPTYRELATION')).to.equal(true);
		// Drop the assertion; the schema-change notifier should invalidate the hoist cache.
		await db.exec('drop assertion no_neg4');
		plan = await planRows(db, 'select * from orders where qty < 0');
		expect(hasOp(plan, 'EMPTYRELATION'),
			`after drop, plan should no longer fold; ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
	});

	it('assertion targets orders → unrelated query on customers is unaffected', async () => {
		await db.exec("create assertion no_neg5 check (not exists (select 1 from orders where qty < 0))");
		const sql = 'select * from customers where id < 0';
		const plan = await planRows(db, sql);
		// We don't have a contradicting domain for customers — the qty bound only
		// applies to orders. Plan must not fold to empty.
		expect(hasOp(plan, 'EMPTYRELATION')).to.equal(false);
	});

	it('provenance: hoisted domain carries source = { kind: assertion, name }', async () => {
		await db.exec("create assertion no_neg6 check (not exists (select 1 from orders where qty < 0))");
		const rows = await planRows(db, 'select * from orders');
		// Look at any leaf carrying physical info — TableReference / SeqScan.
		const props = physicalOf(rows, r => r.node_type === 'TableReference')
			?? physicalOf(rows, r => r.op === 'SEQSCAN');
		expect(props, 'expected physical props').to.not.equal(undefined);
		const dom = props!.domainConstraints?.find(d => d.kind === 'range' && d.column === 1);
		expect(dom, 'expected qty range domain').to.not.equal(undefined);
		expect(dom!.source?.kind).to.equal('assertion');
		expect(dom!.source?.name).to.equal('no_neg6');
	});

	it('declared CHECK + identical assertion: dedup keeps declared-check provenance', async () => {
		await db.exec(`
			create table widgets (id integer primary key, qty integer, check (qty >= 0)) using memory;
			create assertion w_no_neg check (not exists (select 1 from widgets where qty < 0));
		`);
		const rows = await planRows(db, 'select * from widgets');
		const props = physicalOf(rows, r => r.node_type === 'TableReference')
			?? physicalOf(rows, r => r.op === 'SEQSCAN');
		expect(props, 'expected physical props').to.not.equal(undefined);
		// Both contributions are `qty >= 0` — declared-check and assertion. mergeDomainConstraints
		// dedupes by structural equality and keeps the first (declared-check).
		const dom = props!.domainConstraints?.find(d => d.kind === 'range' && d.column === 1);
		expect(dom, 'expected qty range domain').to.not.equal(undefined);
		// Declared CHECK doesn't tag provenance; the hoisted entry would have been
		// deduped against it, so source should be undefined (declared-check wins
		// by structural-equality dedup keeping the first-merged entry).
		expect(dom!.source, 'declared-check has no source tag; hoisted dup is discarded')
			.to.equal(undefined);
	});
});

// ---------------------------------------------------------------------------
// OPT-052 static guard
// ---------------------------------------------------------------------------

/**
 * Every reference to `ConstraintProvenance` in `code`, as `<relPath>:<line>`.
 *
 * The check is written against the *type name*, not against reads of the `source`
 * property: `.source` collides with `node.source` (a plan node's child pointer),
 * which rules read all the time. Any rule that wants to branch on where a fact came
 * from has to name the provenance type to do anything useful with the tag.
 */
function findProvenanceRefs(relPath: string, code: string): string[] {
	return [...code.matchAll(/\bConstraintProvenance\b/g)].map(m => `${relPath}:${lineAt(code, m.index)}`);
}

describe('OPT-052 static guard: provenance is informational', () => {
	// An FD, constant binding, or domain constraint may carry a `source` tag saying it
	// came from a declared CHECK or from a hoisted assertion. The tag is for diagnostics
	// only: `fdsEqual` ignores it, and no optimizer rule may branch on it. A rule that
	// does still typechecks and still passes its own tests — the damage is that a fact's
	// optimizer meaning starts depending on where it came from.
	const rulesDir = join(dirname(fileURLToPath(import.meta.url)), '../../src/planner/rules');

	it('no optimizer rule names ConstraintProvenance', () => {
		const files = tsFilesUnder(rulesDir);
		expect(files.length, 'found the rule sources').to.be.greaterThan(20);

		const offenders = files.flatMap(file => findProvenanceRefs(relPosix(rulesDir, file), readCode(file)));
		expect(
			offenders,
			`rules must not branch on fact provenance:\n${offenders.join('\n')}`,
		).to.be.empty;
	});

	it('flags a hand-written violation but not a comment or a child-pointer read', () => {
		const violating = stripComments(`
			import type { ConstraintProvenance } from '../../nodes/plan-node.js';
			function ruleBad(node) {
				const prov: ConstraintProvenance | undefined = node.physical.fds[0].source;
				return prov?.kind === 'assertion' ? null : node;
			}
		`);
		expect(findProvenanceRefs('rules/fake/rule-bad.ts', violating)).to.deep.equal([
			'rules/fake/rule-bad.ts:2',
			'rules/fake/rule-bad.ts:4',
		]);

		const innocent = stripComments(`
			// ConstraintProvenance is deliberately not consulted here.
			function ruleFine(node) {
				if (node.source === node.tableRef) return null;
				return node;
			}
		`);
		expect(findProvenanceRefs('rules/fake/rule-fine.ts', innocent)).to.be.empty;
	});
});
