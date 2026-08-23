import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { SqlValue } from '../../src/common/types.js';
import { EmptyScope } from '../../src/planner/scopes/empty.js';
import { BinaryOpNode, LiteralNode } from '../../src/planner/nodes/scalar.js';
import { ColumnReferenceNode } from '../../src/planner/nodes/reference.js';
import { ScalarFunctionCallNode } from '../../src/planner/nodes/function.js';
import { FilterNode } from '../../src/planner/nodes/filter.js';
import type { ScalarFunctionSchema } from '../../src/schema/function.js';
import { FunctionFlags } from '../../src/common/constants.js';
import type * as AST from '../../src/parser/ast.js';
import type { Attribute, RelationalPlanNode, ScalarPlanNode } from '../../src/planner/nodes/plan-node.js';
import { PlanNode } from '../../src/planner/nodes/plan-node.js';
import { PlanNodeType } from '../../src/planner/nodes/plan-node-type.js';
import { DATETIME_TYPE, DATE_TYPE } from '../../src/types/temporal-types.js';
import { TEXT_TYPE } from '../../src/types/builtin-types.js';
import type { ScalarType, RelationType } from '../../src/common/datatype.js';
import { ruleSargableRangeRewrite } from '../../src/planner/rules/predicate/rule-sargable-range-rewrite.js';
import { splitConjuncts } from '../../src/planner/analysis/predicate-conjuncts.js';

type ResultRow = Record<string, SqlValue>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const scope = EmptyScope.instance as unknown as any;

// ---- Plan-node construction helpers (mirror expression-properties.spec) -----

function colRef(attrId: number, logicalType = DATETIME_TYPE, name = 'ts', index = 0): ColumnReferenceNode {
	const ast = { type: 'column', name } as unknown as AST.ColumnExpr;
	const columnType: ScalarType = {
		typeClass: 'scalar',
		logicalType,
		nullable: true,
		isReadOnly: false,
	};
	return new ColumnReferenceNode(scope, ast, columnType, attrId, index);
}

function lit(value: SqlValue): LiteralNode {
	const ast = { type: 'literal', value } as unknown as AST.LiteralExpr;
	return new LiteralNode(scope, ast);
}

/**
 * A LiteralNode whose value is a still-pending Promise — the shape constant
 * folding produces for an uncorrelated async scalar subquery
 * (`planner/analysis/const-pass.ts`). Not a plan-time constant.
 */
function litPromise(value: SqlValue): LiteralNode {
	const ast = { type: 'literal', value: Promise.resolve(value) } as unknown as AST.LiteralExpr;
	return new LiteralNode(scope, ast);
}

function binOp(op: string, left: ScalarPlanNode, right: ScalarPlanNode): BinaryOpNode {
	const ast = {
		type: 'binary',
		operator: op,
		left: (left as unknown as { expression: AST.Expression }).expression,
		right: (right as unknown as { expression: AST.Expression }).expression,
	} as AST.BinaryExpr;
	return new BinaryOpNode(scope, ast, left, right);
}

function makeFnSchema(opts: Partial<ScalarFunctionSchema> & { name: string; numArgs: number }): ScalarFunctionSchema {
	return {
		name: opts.name,
		numArgs: opts.numArgs,
		flags: opts.flags ?? (FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC),
		returnType: opts.returnType ?? {
			typeClass: 'scalar',
			logicalType: DATE_TYPE,
			nullable: true,
			isReadOnly: true,
		},
		implementation: opts.implementation ?? (() => null),
		injectiveOnArgs: opts.injectiveOnArgs,
		monotoneOnArgs: opts.monotoneOnArgs,
		rangeRewriteOnArg: opts.rangeRewriteOnArg,
	};
}

function fnCall(schema: ScalarFunctionSchema, operands: ScalarPlanNode[]): ScalarFunctionCallNode {
	const ast = {
		type: 'function',
		name: schema.name,
		args: operands.map(o => (o as unknown as { expression: AST.Expression }).expression),
	} as unknown as AST.FunctionExpr;
	return new ScalarFunctionCallNode(scope, ast, schema, operands);
}

/**
 * Minimal zero-ary relational stub. The rule only inspects the Filter's
 * predicate; it never touches the source, so a placeholder relation is
 * sufficient.
 */
class StubRelation extends PlanNode implements RelationalPlanNode {
	override readonly nodeType = PlanNodeType.TableReference;
	constructor(private readonly attrs: Attribute[]) {
		super(scope);
	}
	getType(): RelationType {
		return {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: this.attrs.map(a => ({ name: a.name, type: a.type, generated: false })),
			keys: [],
			rowConstraints: [],
		};
	}
	getAttributes(): readonly Attribute[] { return this.attrs; }
	getChildren(): readonly [] { return []; }
	getRelations(): readonly [] { return []; }
	withChildren(): PlanNode { return this; }
	get estimatedRows(): number { return 1; }
}

function makeFilter(attrId: number, predicate: ScalarPlanNode, logicalType = DATETIME_TYPE): FilterNode {
	const attr: Attribute = {
		id: attrId,
		name: 'ts',
		type: { typeClass: 'scalar', logicalType, nullable: true, isReadOnly: false },
	};
	const source = new StubRelation([attr]);
	return new FilterNode(scope, source, predicate);
}

// ---- Unit-level rewrite tests ----------------------------------------------

describe('rule-sargable-range-rewrite (unit)', () => {
	const dateBucketFn = makeFnSchema({
		name: 'date',
		numArgs: 1,
		rangeRewriteOnArg: { 0: { kind: 'date_bucket' } },
		returnType: { typeClass: 'scalar', logicalType: DATE_TYPE, nullable: true, isReadOnly: true },
	});

	function applyAndGetConjuncts(filter: FilterNode): ScalarPlanNode[] {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const rewritten = ruleSargableRangeRewrite(filter, {} as any);
		expect(rewritten, 'rule should produce a rewritten Filter').to.not.be.null;
		expect(rewritten!.nodeType).to.equal(PlanNodeType.Filter);
		return splitConjuncts((rewritten as FilterNode).predicate);
	}

	/**
	 * `splitConjuncts` reuses a stack, so the surfaced order is right-then-left
	 * rather than the original AND-tree's left-then-right. Tests assert by
	 * operator membership, not array position.
	 */
	function findOp(conjuncts: ScalarPlanNode[], op: '>=' | '<'): BinaryOpNode {
		const match = conjuncts.find(c => c instanceof BinaryOpNode && c.expression.operator === op);
		expect(match, `expected a conjunct with operator ${op}`).to.not.be.undefined;
		return match as BinaryOpNode;
	}

	it('rewrites date(ts) = D into ts >= D AND ts < D+1', () => {
		const col = colRef(1, DATETIME_TYPE);
		const predicate = binOp('=', fnCall(dateBucketFn, [col]), lit('2024-01-15'));
		const filter = makeFilter(1, predicate, DATETIME_TYPE);

		const conjuncts = applyAndGetConjuncts(filter);
		expect(conjuncts).to.have.lengthOf(2);

		const lower = findOp(conjuncts, '>=');
		const upper = findOp(conjuncts, '<');

		// Original column reference is reused verbatim on both sides.
		expect(lower.left).to.equal(col);
		expect(upper.left).to.equal(col);

		const lowerLit = lower.right as LiteralNode;
		expect(lowerLit.expression.value).to.equal('2024-01-15T00:00:00');
		const upperLit = upper.right as LiteralNode;
		expect(upperLit.expression.value).to.equal('2024-01-16T00:00:00');
	});

	it('rewrites flipped constant = date(ts) form', () => {
		const col = colRef(1, DATETIME_TYPE);
		const predicate = binOp('=', lit('2024-01-15'), fnCall(dateBucketFn, [col]));
		const filter = makeFilter(1, predicate, DATETIME_TYPE);

		const conjuncts = applyAndGetConjuncts(filter);
		expect(conjuncts).to.have.lengthOf(2);
		const ops = conjuncts.map(c => (c as BinaryOpNode).expression.operator);
		expect(ops).to.include('>=');
		expect(ops).to.include('<');
	});

	it('leaves date(ts) = null alone (no rewrite)', () => {
		const col = colRef(1, DATETIME_TYPE);
		const predicate = binOp('=', fnCall(dateBucketFn, [col]), lit(null));
		const filter = makeFilter(1, predicate, DATETIME_TYPE);

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const result = ruleSargableRangeRewrite(filter, {} as any);
		expect(result).to.be.null;
	});

	it('declines date(ts) = <promise literal> instead of throwing (bug-constant-subquery-literal-crashes-predicate-rewrite)', () => {
		// A folded-but-still-pending async scalar subquery constant (`(select 1)`)
		// is not a plan-time constant; the rule must decline the conjunct, not
		// call getSyncLiteral on it.
		const col = colRef(1, DATETIME_TYPE);
		const predicate = binOp('=', fnCall(dateBucketFn, [col]), litPromise('2024-01-15'));
		const filter = makeFilter(1, predicate, DATETIME_TYPE);

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect(() => ruleSargableRangeRewrite(filter, {} as any)).to.not.throw();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const result = ruleSargableRangeRewrite(filter, {} as any);
		expect(result).to.be.null;
	});

	it('leaves a non-bucket function (upper(name) = "X") alone', () => {
		const upperFn = makeFnSchema({
			name: 'upper',
			numArgs: 1,
			returnType: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true },
		});
		const col = colRef(1, TEXT_TYPE, 'name');
		const predicate = binOp('=', fnCall(upperFn, [col]), lit('X'));
		const filter = makeFilter(1, predicate, TEXT_TYPE);

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const result = ruleSargableRangeRewrite(filter, {} as any);
		expect(result).to.be.null;
	});

	it('leaves f(g(col)) = c alone (operand not bare column reference)', () => {
		// Outer fn declares the trait; inner fn wraps the column. rangeRewriteIn
		// requires the operand to be an identity reference, so this must decline.
		const innerFn = makeFnSchema({
			name: 'inner',
			numArgs: 1,
			monotoneOnArgs: { 0: 'increasing' },
			returnType: { typeClass: 'scalar', logicalType: DATETIME_TYPE, nullable: true, isReadOnly: true },
		});
		const col = colRef(1, DATETIME_TYPE);
		const predicate = binOp('=', fnCall(dateBucketFn, [fnCall(innerFn, [col])]), lit('2024-01-15'));
		const filter = makeFilter(1, predicate, DATETIME_TYPE);

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const result = ruleSargableRangeRewrite(filter, {} as any);
		expect(result).to.be.null;
	});

	it('rewrites only the rewritable conjunct in a mixed AND tree', () => {
		const col = colRef(1, DATETIME_TYPE);
		const bucketEq = binOp('=', fnCall(dateBucketFn, [col]), lit('2024-01-15'));
		const otherCol = colRef(2, TEXT_TYPE, 'name', 1);
		const otherEq = binOp('=', otherCol, lit('Alpha'));
		const predicate = binOp('AND', bucketEq, otherEq);
		const filter = makeFilter(1, predicate, DATETIME_TYPE);

		const conjuncts = applyAndGetConjuncts(filter);
		// 2 from the rewrite + 1 untouched.
		expect(conjuncts).to.have.lengthOf(3);
		const ops = conjuncts.map(c => (c as BinaryOpNode).expression.operator);
		expect(ops).to.include('>=');
		expect(ops).to.include('<');
		expect(ops).to.include('=');
	});
});

// ---- SQL-level integration --------------------------------------------------

describe('rule-sargable-range-rewrite (sql)', () => {
	let db: Database;

	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	async function setup(): Promise<void> {
		// `DATETIME` is treated as NOT NULL by default in Quereus — declare it
		// `NULL` so we can also exercise the null-row case below.
		await db.exec("create table t (id INTEGER PRIMARY KEY, ts DATETIME NULL, v INTEGER) USING memory");
		await db.exec("insert into t values (1, '2024-01-15T12:34:56', 10), (2, '2024-01-16T00:00:00', 20), (3, '2024-01-14T23:59:59', 5), (4, null, 99)");
	}

	it('returns the in-bucket row for date(ts) = D', async () => {
		await setup();
		const rows: ResultRow[] = [];
		for await (const r of db.eval("select v from t where date(ts) = '2024-01-15' order by v")) {
			rows.push(r);
		}
		expect(rows.map(r => r.v)).to.deep.equal([10]);
	});

	it('boundary: D+1 itself is excluded', async () => {
		await setup();
		const rows: ResultRow[] = [];
		// Row 2 at 2024-01-16T00:00:00 should match `date(ts) = '2024-01-16'`,
		// not `date(ts) = '2024-01-15'`.
		for await (const r of db.eval("select v from t where date(ts) = '2024-01-16' order by v")) {
			rows.push(r);
		}
		expect(rows.map(r => r.v)).to.deep.equal([20]);
	});

	it('null-ts row is excluded (matches f(null) = c semantics)', async () => {
		await setup();
		const rows: ResultRow[] = [];
		for await (const r of db.eval("select v from t where date(ts) = '2024-01-15'")) {
			rows.push(r);
		}
		expect(rows.find(r => r.v === 99)).to.be.undefined;
	});

	it('rewritten plan exposes the bare ts column range (no date() call survives in the filter)', async () => {
		await setup();
		const q = "select v from t where date(ts) = '2024-01-15'";
		const planRows: ResultRow[] = [];
		for await (const r of db.eval("select json_group_array(detail) as details from query_plan(?)", [q])) {
			planRows.push(r);
		}
		expect(planRows).to.have.lengthOf(1);
		const details = String(planRows[0].details ?? '');
		// The rewritten predicate should reference the bare ts column with range
		// operators, not the date(ts) call.
		expect(details).to.match(/ts\s*>=\s*'2024-01-15T00:00:00'/);
		expect(details).to.match(/ts\s*<\s*'2024-01-16T00:00:00'/);
	});
});
