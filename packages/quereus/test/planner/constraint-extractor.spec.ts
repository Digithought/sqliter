import { expect } from 'chai';
import { EmptyScope } from '../../src/planner/scopes/empty.js';
import { PlanNodeType } from '../../src/planner/nodes/plan-node-type.js';
import { BinaryOpNode, LiteralNode, BetweenNode, UnaryOpNode, CastNode } from '../../src/planner/nodes/scalar.js';
import { ColumnReferenceNode, ParameterReferenceNode } from '../../src/planner/nodes/reference.js';
import type { ScalarPlanNode } from '../../src/planner/nodes/plan-node.js';
import type * as AST from '../../src/parser/ast.js';
import { INTEGER_TYPE, TEXT_TYPE } from '../../src/types/builtin-types.js';
import { InNode } from '../../src/planner/nodes/subquery.js';
import {
	extractConstraints,
	computeCoveredKeysForConstraints,
	createResidualFilter,
	type TableInfo,
	type PredicateConstraint,
} from '../../src/planner/analysis/constraint-extractor.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const scope = EmptyScope.instance as unknown as any;

// ---------------------------------------------------------------------------
// AST / PlanNode construction helpers
// ---------------------------------------------------------------------------

function colRef(attrId: number, name: string, index: number): ColumnReferenceNode {
	const expr: AST.ColumnExpr = { type: 'column', schema: undefined as unknown as string, table: undefined as unknown as string, name } as unknown as AST.ColumnExpr;
	const columnType = {
		typeClass: 'scalar' as const,
		logicalType: INTEGER_TYPE,
		nullable: false,
		isReadOnly: false,
	};
	return new ColumnReferenceNode(scope, expr, columnType, attrId, index);
}

function lit(value: unknown): LiteralNode {
	const expr: AST.LiteralExpr = { type: 'literal', value } as unknown as AST.LiteralExpr;
	return new LiteralNode(scope, expr);
}

/** TEXT-typed column reference, optionally carrying an explicitly-declared collation (the existing colRef helper is INTEGER-typed). */
function textColRef(attrId: number, name: string, index: number, collation?: string): ColumnReferenceNode {
	const expr: AST.ColumnExpr = { type: 'column', schema: undefined as unknown as string, table: undefined as unknown as string, name } as unknown as AST.ColumnExpr;
	const columnType = {
		typeClass: 'scalar' as const,
		logicalType: TEXT_TYPE,
		collationName: collation,
		collationSource: collation !== undefined ? 'declared' as const : undefined,
		nullable: false,
		isReadOnly: false,
	};
	return new ColumnReferenceNode(scope, expr, columnType, attrId, index);
}

/** The folded-`COLLATE` shape: a literal whose *type* carries the collation with
 *  `'explicit'` provenance (constant folding preserves the whole type, including
 *  the CollateNode's rank-3 source). */
function collatedLit(value: string, collation: string): LiteralNode {
	const expr: AST.LiteralExpr = { type: 'literal', value } as unknown as AST.LiteralExpr;
	return new LiteralNode(scope, expr, {
		typeClass: 'scalar',
		logicalType: TEXT_TYPE,
		collationName: collation,
		collationSource: 'explicit',
		nullable: false,
		isReadOnly: true,
	});
}

function paramRef(name: string): ParameterReferenceNode {
	const expr: AST.ParameterExpr = { type: 'parameter', name } as unknown as AST.ParameterExpr;
	const paramType = {
		typeClass: 'scalar' as const,
		logicalType: INTEGER_TYPE,
		nullable: true,
		isReadOnly: true,
	};
	return new ParameterReferenceNode(scope, expr, name, paramType);
}

function binOp(op: string, left: ScalarPlanNode, right: ScalarPlanNode): BinaryOpNode {
	const ast: AST.BinaryExpr = {
		type: 'binary',
		operator: op,
		left: (left as unknown as { expression: AST.Expression }).expression,
		right: (right as unknown as { expression: AST.Expression }).expression,
	};
	return new BinaryOpNode(scope, ast, left, right);
}

function andNode(left: ScalarPlanNode, right: ScalarPlanNode): BinaryOpNode {
	return binOp('AND', left, right);
}

function orNode(left: ScalarPlanNode, right: ScalarPlanNode): BinaryOpNode {
	return binOp('OR', left, right);
}

function betweenNode(expr: ScalarPlanNode, lower: ScalarPlanNode, upper: ScalarPlanNode, not = false): BetweenNode {
	const ast: AST.BetweenExpr = {
		type: 'between',
		expr: (expr as unknown as { expression: AST.Expression }).expression,
		lower: (lower as unknown as { expression: AST.Expression }).expression,
		upper: (upper as unknown as { expression: AST.Expression }).expression,
		not,
	};
	return new BetweenNode(scope, ast, expr, lower, upper);
}

function inNode(condition: ScalarPlanNode, values: ScalarPlanNode[]): InNode {
	const ast: AST.InExpr = {
		type: 'in',
		expr: (condition as unknown as { expression: AST.Expression }).expression,
		values: values.map(v => (v as unknown as { expression: AST.Expression }).expression),
	};
	return new InNode(scope, ast, condition, undefined, values);
}

function inSubqueryNode(condition: ScalarPlanNode): InNode {
	const ast: AST.InExpr = {
		type: 'in',
		expr: (condition as unknown as { expression: AST.Expression }).expression,
	};
	// source = a dummy relational node — we use null but cast to simulate subquery presence
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return new InNode(scope, ast, condition, {} as any, undefined);
}

function unaryOp(op: string, operand: ScalarPlanNode): UnaryOpNode {
	const ast: AST.UnaryExpr = { type: 'unary', operator: op, expr: (operand as unknown as { expression: AST.Expression }).expression };
	return new UnaryOpNode(scope, ast, operand);
}

function castNode(operand: ScalarPlanNode, targetType = 'TEXT'): CastNode {
	const ast: AST.CastExpr = {
		type: 'cast',
		expr: (operand as unknown as { expression: AST.Expression }).expression,
		targetType,
	};
	return new CastNode(scope, ast, operand);
}

// ---------------------------------------------------------------------------
// Table info helpers
// ---------------------------------------------------------------------------

function makeTableInfo(name: string, attrs: Array<{ id: number; name: string; index: number }>, uniqueKeys?: number[][]): TableInfo {
	const columnIndexMap = new Map<number, number>();
	for (const a of attrs) columnIndexMap.set(a.id, a.index);
	return {
		relationName: name,
		relationKey: name,
		attributes: attrs.map(a => ({ id: a.id, name: a.name })),
		columnIndexMap,
		uniqueKeys,
	};
}

const TABLE_A = makeTableInfo('t', [
	{ id: 100, name: 'id', index: 0 },
	{ id: 101, name: 'a', index: 1 },
	{ id: 102, name: 'b', index: 2 },
], [[0]]);

const TABLE_B = makeTableInfo('u', [
	{ id: 200, name: 'x', index: 0 },
	{ id: 201, name: 'y', index: 1 },
], [[0]]);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('Constraint Extractor — Mutation Killing Tests', () => {

	// ===================================================================
	// Binary comparison: every operator, col-op-lit and lit-op-col
	// ===================================================================
	describe('extractBinaryConstraint — operator mapping', () => {
		const operators: Array<{ sql: string; expected: string }> = [
			{ sql: '=', expected: '=' },
			{ sql: '>', expected: '>' },
			{ sql: '>=', expected: '>=' },
			{ sql: '<', expected: '<' },
			{ sql: '<=', expected: '<=' },
			{ sql: 'LIKE', expected: 'LIKE' },
			{ sql: 'GLOB', expected: 'GLOB' },
			{ sql: 'MATCH', expected: 'MATCH' },
		];

		for (const { sql, expected } of operators) {
			it(`col ${sql} lit → op '${expected}'`, () => {
				const col = colRef(101, 'a', 1);
				const expr = binOp(sql, col, lit(42));
				const result = extractConstraints(expr, [TABLE_A]);
				expect(result.allConstraints).to.have.length(1);
				expect(result.allConstraints[0].op).to.equal(expected);
				expect(result.allConstraints[0].value).to.equal(42);
				expect(result.allConstraints[0].columnIndex).to.equal(1);
				expect(result.allConstraints[0].attributeId).to.equal(101);
				expect(result.allConstraints[0].targetRelation).to.equal('t');
			});
		}

		it('unsupported operator (||) → residual', () => {
			const col = colRef(101, 'a', 1);
			const expr = binOp('||', col, lit('x'));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.exist;
		});

		it('non-binary node → residual', () => {
			const expr = lit(true);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.exist;
		});
	});

	// ===================================================================
	// flipOperator — reversed operand order (lit op col)
	// ===================================================================
	describe('flipOperator — lit op col pattern', () => {
		it('lit < col → col > lit', () => {
			const col = colRef(101, 'a', 1);
			const expr = binOp('<', lit(5), col);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('>');
			expect(result.allConstraints[0].value).to.equal(5);
		});

		it('lit <= col → col >= lit', () => {
			const col = colRef(101, 'a', 1);
			const expr = binOp('<=', lit(5), col);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('>=');
		});

		it('lit > col → col < lit', () => {
			const col = colRef(101, 'a', 1);
			const expr = binOp('>', lit(5), col);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('<');
		});

		it('lit >= col → col <= lit', () => {
			const col = colRef(101, 'a', 1);
			const expr = binOp('>=', lit(5), col);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('<=');
		});

		it('lit = col → col = lit (symmetric)', () => {
			const col = colRef(101, 'a', 1);
			const expr = binOp('=', lit(5), col);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('=');
			expect(result.allConstraints[0].value).to.equal(5);
		});

		it('LIKE is not flippable (stays LIKE)', () => {
			const col = colRef(101, 'a', 1);
			const expr = binOp('LIKE', lit('%x'), col);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('LIKE');
		});

		it('GLOB is not flippable (stays GLOB)', () => {
			const col = colRef(101, 'a', 1);
			const expr = binOp('GLOB', lit('*x'), col);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('GLOB');
		});

		it('MATCH is not flippable (stays MATCH)', () => {
			const col = colRef(101, 'a', 1);
			const expr = binOp('MATCH', lit('pat'), col);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('MATCH');
		});
	});

	// ===================================================================
	// Literal value extraction — exact values matter for mutation kills
	// ===================================================================
	describe('literal value extraction', () => {
		it('extracts integer value exactly', () => {
			const col = colRef(101, 'a', 1);
			const expr = binOp('=', col, lit(99));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints[0].value).to.equal(99);
		});

		it('extracts string value exactly', () => {
			const col = colRef(101, 'a', 1);
			const expr = binOp('=', col, lit('hello'));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints[0].value).to.equal('hello');
		});

		it('extracts null value', () => {
			const col = colRef(101, 'a', 1);
			const expr = binOp('=', col, lit(null));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints[0].value).to.equal(null);
		});

		it('extracts 0 (not falsy-collapsed)', () => {
			const col = colRef(101, 'a', 1);
			const expr = binOp('=', col, lit(0));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints[0].value).to.equal(0);
		});

		it('extracts empty string (not falsy-collapsed)', () => {
			const col = colRef(101, 'a', 1);
			const expr = binOp('=', col, lit(''));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints[0].value).to.equal('');
		});
	});

	// ===================================================================
	// BETWEEN extraction
	// ===================================================================
	describe('extractBetweenConstraints', () => {
		it('BETWEEN produces >= and <= constraints', () => {
			const col = colRef(101, 'a', 1);
			const expr = betweenNode(col, lit(10), lit(20));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(2);
			const ops = result.allConstraints.map(c => c.op).sort();
			expect(ops).to.deep.equal(['<=', '>=']);
			const ge = result.allConstraints.find(c => c.op === '>=')!;
			const le = result.allConstraints.find(c => c.op === '<=')!;
			expect(ge.value).to.equal(10);
			expect(le.value).to.equal(20);
			expect(ge.columnIndex).to.equal(1);
			expect(le.columnIndex).to.equal(1);
		});

		it('NOT BETWEEN falls to residual', () => {
			const col = colRef(101, 'a', 1);
			const expr = betweenNode(col, lit(10), lit(20), true);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.exist;
		});

		it('BETWEEN with non-column operand → residual', () => {
			const expr = betweenNode(lit(5), lit(10), lit(20));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.exist;
		});

		it('BETWEEN with non-literal bounds → residual', () => {
			const col = colRef(101, 'a', 1);
			const col2 = colRef(102, 'b', 2);
			const expr = betweenNode(col, col2, lit(20));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.exist;
		});

		it('BETWEEN exact bound values (lower != upper)', () => {
			const col = colRef(101, 'a', 1);
			const expr = betweenNode(col, lit(1), lit(100));
			const result = extractConstraints(expr, [TABLE_A]);
			const ge = result.allConstraints.find(c => c.op === '>=')!;
			const le = result.allConstraints.find(c => c.op === '<=')!;
			expect(ge.value).to.not.equal(le.value);
			expect(ge.value).to.equal(1);
			expect(le.value).to.equal(100);
		});
	});

	// ===================================================================
	// IN extraction
	// ===================================================================
	describe('extractInConstraint', () => {
		it('col IN (1,2,3) extracts IN constraint with all values', () => {
			const col = colRef(101, 'a', 1);
			const expr = inNode(col, [lit(1), lit(2), lit(3)]);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('IN');
			expect(result.allConstraints[0].value).to.deep.equal([1, 2, 3]);
			expect(result.allConstraints[0].columnIndex).to.equal(1);
		});

		it('single-element IN', () => {
			const col = colRef(101, 'a', 1);
			const expr = inNode(col, [lit(42)]);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('IN');
			expect(result.allConstraints[0].value).to.deep.equal([42]);
		});

		it('empty IN list → residual (no extraction)', () => {
			const col = colRef(101, 'a', 1);
			const expr = inNode(col, []);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(0);
		});

		it('IN with subquery source → not extracted', () => {
			const col = colRef(101, 'a', 1);
			const expr = inSubqueryNode(col);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(0);
		});

		it('IN where condition is not column ref → not extracted', () => {
			const expr = inNode(lit(5), [lit(1), lit(2)]);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(0);
		});

		it('IN with column not in table info → not extracted', () => {
			const col = colRef(999, 'z', 0);
			const expr = inNode(col, [lit(1)]);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(0);
		});

		it('IN with parameter values → mixed binding', () => {
			const col = colRef(101, 'a', 1);
			const param = paramRef(':p1');
			const expr = inNode(col, [lit(1), param]);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('IN');
			expect(result.allConstraints[0].bindingKind).to.equal('mixed');
			expect(result.allConstraints[0].valueExpr).to.exist;
		});
	});

	// ===================================================================
	// IS NULL / IS NOT NULL
	// ===================================================================
	describe('extractNullConstraint', () => {
		it('IS NULL extracts correctly', () => {
			const col = colRef(101, 'a', 1);
			const expr = unaryOp('IS NULL', col);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('IS NULL');
			expect(result.allConstraints[0].value).to.be.undefined;
			expect(result.allConstraints[0].columnIndex).to.equal(1);
			expect(result.allConstraints[0].bindingKind).to.equal('literal');
		});

		it('IS NOT NULL extracts correctly', () => {
			const col = colRef(101, 'a', 1);
			const expr = unaryOp('IS NOT NULL', col);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('IS NOT NULL');
		});

		it('IS NULL on non-column → not extracted', () => {
			const expr = unaryOp('IS NULL', lit(5));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.exist;
		});

		it('IS NULL on column without table mapping → not extracted', () => {
			const col = colRef(999, 'z', 0);
			const expr = unaryOp('IS NULL', col);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(0);
		});

		it('non IS NULL/IS NOT NULL unary op → residual', () => {
			const col = colRef(101, 'a', 1);
			const expr = unaryOp('NOT', col);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.exist;
		});
	});

	// ===================================================================
	// AND decomposition
	// ===================================================================
	describe('AND decomposition', () => {
		it('AND produces constraints from both sides', () => {
			const col = colRef(101, 'a', 1);
			const expr = andNode(binOp('>', col, lit(5)), binOp('<', col, lit(10)));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(2);
			const ops = result.allConstraints.map(c => c.op).sort();
			expect(ops).to.deep.equal(['<', '>']);
		});

		it('deeply nested AND decomposes all parts', () => {
			const col = colRef(101, 'a', 1);
			const expr = andNode(
				andNode(binOp('>', col, lit(1)), binOp('<', col, lit(100))),
				binOp('=', colRef(102, 'b', 2), lit(42))
			);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(3);
		});

		it('AND with one non-extractable side → partial extraction + residual', () => {
			const col = colRef(101, 'a', 1);
			const expr = andNode(
				binOp('=', col, lit(5)),
				binOp('||', col, lit('x'))
			);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('=');
			expect(result.residualPredicate).to.exist;
		});
	});

	// ===================================================================
	// OR → IN collapse
	// ===================================================================
	describe('OR → IN collapse', () => {
		it('a=1 OR a=2 → IN (1,2)', () => {
			const col = colRef(101, 'a', 1);
			const expr = orNode(binOp('=', col, lit(1)), binOp('=', col, lit(2)));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('IN');
			expect(result.allConstraints[0].value).to.deep.equal([1, 2]);
			expect(result.allConstraints[0].columnIndex).to.equal(1);
		});

		it('a=1 OR a=2 OR a=3 → IN (1,2,3)', () => {
			const col = colRef(101, 'a', 1);
			const expr = orNode(orNode(binOp('=', col, lit(1)), binOp('=', col, lit(2))), binOp('=', col, lit(3)));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('IN');
			expect(result.allConstraints[0].value).to.deep.equal([1, 2, 3]);
		});

		it('different columns → residual (no collapse)', () => {
			const a = colRef(101, 'a', 1);
			const b = colRef(102, 'b', 2);
			const expr = orNode(binOp('=', a, lit(1)), binOp('=', b, lit(2)));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.exist;
		});

		it('non-equality OR → not collapsed to IN', () => {
			const col = colRef(101, 'a', 1);
			const expr = orNode(binOp('>', col, lit(5)), binOp('>', col, lit(10)));
			const result = extractConstraints(expr, [TABLE_A]);
			// Should be OR_RANGE, not IN
			if (result.allConstraints.length > 0) {
				expect(result.allConstraints[0].op).to.not.equal('IN');
			}
		});

		it('OR with residual branch → entire OR is residual', () => {
			const col = colRef(101, 'a', 1);
			const expr = orNode(binOp('=', col, lit(1)), binOp('||', col, lit('x')));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.exist;
		});

		it('single disjunct → residual (need >= 2)', () => {
			const col = colRef(101, 'a', 1);
			// OR with only one real branch (can't split)
			const expr = binOp('=', col, lit(1));
			// Not an OR at all — just a plain equality
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('=');
		});
	});

	// ===================================================================
	// OR → OR_RANGE collapse
	// ===================================================================
	describe('OR → OR_RANGE collapse', () => {
		it('a<5 OR a>10 → OR_RANGE with two specs', () => {
			const col = colRef(101, 'a', 1);
			const expr = orNode(binOp('<', col, lit(5)), binOp('>', col, lit(10)));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('OR_RANGE');
			expect(result.allConstraints[0].ranges).to.have.length(2);
		});

		it('a<=5 OR a>=10 → OR_RANGE with correct bound ops', () => {
			const col = colRef(101, 'a', 1);
			const expr = orNode(binOp('<=', col, lit(5)), binOp('>=', col, lit(10)));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('OR_RANGE');
			const ranges = result.allConstraints[0].ranges!;
			expect(ranges).to.have.length(2);
			// First branch: a<=5 → upper bound only
			const upper = ranges.find(r => r.upper && !r.lower);
			expect(upper).to.exist;
			expect(upper!.upper!.op).to.equal('<=');
			expect(upper!.upper!.value).to.equal(5);
			// Second branch: a>=10 → lower bound only
			const lower = ranges.find(r => r.lower && !r.upper);
			expect(lower).to.exist;
			expect(lower!.lower!.op).to.equal('>=');
			expect(lower!.lower!.value).to.equal(10);
		});

		it('mixed a=5 OR a>10 → OR_RANGE (equality treated as >=5 AND <=5)', () => {
			const col = colRef(101, 'a', 1);
			const expr = orNode(binOp('=', col, lit(5)), binOp('>', col, lit(10)));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			// Could be IN or OR_RANGE depending on impl; equality + range → OR_RANGE
			const c = result.allConstraints[0];
			expect(c.op).to.equal('OR_RANGE');
			const eqRange = c.ranges!.find(r => r.lower && r.upper);
			expect(eqRange).to.exist;
			expect(eqRange!.lower!.value).to.equal(5);
			expect(eqRange!.upper!.value).to.equal(5);
		});

		it('different columns in OR branches → residual', () => {
			const a = colRef(101, 'a', 1);
			const b = colRef(102, 'b', 2);
			const expr = orNode(binOp('<', a, lit(5)), binOp('>', b, lit(10)));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.exist;
		});

		it('OR with LIKE branches → not collapsible to OR_RANGE', () => {
			const col = colRef(101, 'a', 1);
			const expr = orNode(binOp('LIKE', col, lit('%a')), binOp('LIKE', col, lit('%b')));
			const result = extractConstraints(expr, [TABLE_A]);
			// LIKE can't form range constraints
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.exist;
		});

		it('OR with >2 branches all range on same col → OR_RANGE with 3 specs', () => {
			const col = colRef(101, 'a', 1);
			const expr = orNode(
				orNode(binOp('<', col, lit(5)), binOp('>', col, lit(10))),
				binOp('=', col, lit(50))
			);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('OR_RANGE');
			expect(result.allConstraints[0].ranges).to.have.length(3);
		});
	});

	// ===================================================================
	// Per-table slicing
	// ===================================================================
	describe('per-table constraint grouping', () => {
		it('constraints grouped by target table', () => {
			const a = colRef(101, 'a', 1);
			const x = colRef(200, 'x', 0);
			const expr = andNode(binOp('=', a, lit(1)), binOp('>', x, lit(5)));
			const result = extractConstraints(expr, [TABLE_A, TABLE_B]);
			expect(result.constraintsByTable.size).to.equal(2);
			expect(result.constraintsByTable.get('t')).to.have.length(1);
			expect(result.constraintsByTable.get('u')).to.have.length(1);
			expect(result.constraintsByTable.get('t')![0].op).to.equal('=');
			expect(result.constraintsByTable.get('u')![0].op).to.equal('>');
		});

		it('all constraints for one table only', () => {
			const a = colRef(101, 'a', 1);
			const b = colRef(102, 'b', 2);
			const expr = andNode(binOp('=', a, lit(1)), binOp('<', b, lit(100)));
			const result = extractConstraints(expr, [TABLE_A, TABLE_B]);
			expect(result.constraintsByTable.get('t')).to.have.length(2);
			expect(result.constraintsByTable.has('u')).to.be.false;
		});

		it('column not belonging to any provided table → no constraint', () => {
			const z = colRef(999, 'z', 0);
			const expr = binOp('=', z, lit(1));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.exist;
		});
	});

	// ===================================================================
	// Residual emission
	// ===================================================================
	describe('residual predicate', () => {
		it('single residual preserved as-is', () => {
			const expr = lit(true);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.residualPredicate).to.exist;
			expect(result.residualPredicate!.nodeType).to.equal(PlanNodeType.Literal);
		});

		it('multiple residuals combined with AND', () => {
			const expr = andNode(lit(true), lit(false));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.residualPredicate).to.exist;
			expect(result.residualPredicate!.nodeType).to.equal(PlanNodeType.BinaryOp);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			expect((result.residualPredicate as any).expression.operator).to.equal('AND');
		});

		it('no residual when all parts are extractable', () => {
			const col = colRef(101, 'a', 1);
			const expr = binOp('=', col, lit(5));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.residualPredicate).to.be.undefined;
		});
	});

	// ===================================================================
	// supportedPredicateByTable
	// ===================================================================
	describe('supportedPredicateByTable', () => {
		it('single extracted constraint appears in supportedPredicateByTable', () => {
			const col = colRef(101, 'a', 1);
			const expr = binOp('=', col, lit(5));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.supportedPredicateByTable).to.exist;
			expect(result.supportedPredicateByTable!.has('t')).to.be.true;
		});

		it('multiple AND constraints combined into supported predicate', () => {
			const col = colRef(101, 'a', 1);
			const expr = andNode(binOp('>', col, lit(5)), binOp('<', col, lit(10)));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.supportedPredicateByTable!.has('t')).to.be.true;
		});
	});

	// ===================================================================
	// coveredKeysByTable
	// ===================================================================
	describe('coveredKeysByTable', () => {
		it('equality on primary key covers the key', () => {
			const id = colRef(100, 'id', 0);
			const expr = binOp('=', id, lit(1));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.coveredKeysByTable).to.exist;
			const covered = result.coveredKeysByTable!.get('t')!;
			expect(covered).to.have.length(1);
			expect(covered[0]).to.deep.equal([0]);
		});

		it('inequality on primary key does NOT cover', () => {
			const id = colRef(100, 'id', 0);
			const expr = binOp('>', id, lit(1));
			const result = extractConstraints(expr, [TABLE_A]);
			const covered = result.coveredKeysByTable!.get('t')!;
			expect(covered).to.have.length(0);
		});

		it('single-value IN covers key', () => {
			const id = colRef(100, 'id', 0);
			const expr = inNode(id, [lit(1)]);
			const result = extractConstraints(expr, [TABLE_A]);
			const covered = result.coveredKeysByTable!.get('t')!;
			expect(covered).to.have.length(1);
			expect(covered[0]).to.deep.equal([0]);
		});

		it('multi-value IN does NOT cover key', () => {
			const id = colRef(100, 'id', 0);
			const expr = inNode(id, [lit(1), lit(2)]);
			const result = extractConstraints(expr, [TABLE_A]);
			const covered = result.coveredKeysByTable!.get('t')!;
			expect(covered).to.have.length(0);
		});

		it('composite key partially covered → not covered', () => {
			const table = makeTableInfo('comp', [
				{ id: 300, name: 'k1', index: 0 },
				{ id: 301, name: 'k2', index: 1 },
				{ id: 302, name: 'val', index: 2 },
			], [[0, 1]]);
			const k1 = colRef(300, 'k1', 0);
			const expr = binOp('=', k1, lit(1));
			const result = extractConstraints(expr, [table]);
			const covered = result.coveredKeysByTable!.get('comp')!;
			expect(covered).to.have.length(0);
		});

		it('composite key fully covered → covered', () => {
			const table = makeTableInfo('comp', [
				{ id: 300, name: 'k1', index: 0 },
				{ id: 301, name: 'k2', index: 1 },
				{ id: 302, name: 'val', index: 2 },
			], [[0, 1]]);
			const k1 = colRef(300, 'k1', 0);
			const k2 = colRef(301, 'k2', 1);
			const expr = andNode(binOp('=', k1, lit(1)), binOp('=', k2, lit(2)));
			const result = extractConstraints(expr, [table]);
			const covered = result.coveredKeysByTable!.get('comp')!;
			expect(covered).to.have.length(1);
			expect(covered[0]).to.deep.equal([0, 1]);
		});

		it('zero-length unique key → trivially covered', () => {
			const table = makeTableInfo('zk', [
				{ id: 400, name: 'x', index: 0 },
			], [[]]);
			const col = colRef(400, 'x', 0);
			const expr = binOp('>', col, lit(1));
			const result = extractConstraints(expr, [table]);
			const covered = result.coveredKeysByTable!.get('zk')!;
			expect(covered).to.have.length(1);
			expect(covered[0]).to.deep.equal([]);
		});

		it('table with no unique keys → empty covered', () => {
			const table = makeTableInfo('nokeys', [
				{ id: 500, name: 'x', index: 0 },
			]);
			const col = colRef(500, 'x', 0);
			const expr = binOp('=', col, lit(1));
			const result = extractConstraints(expr, [table]);
			const covered = result.coveredKeysByTable!.get('nokeys')!;
			expect(covered).to.have.length(0);
		});
	});

	// ===================================================================
	// computeCoveredKeysForConstraints (public export)
	// ===================================================================
	describe('computeCoveredKeysForConstraints', () => {
		function makeConstraint(op: string, colIdx: number): PredicateConstraint {
			return {
				columnIndex: colIdx,
				attributeId: colIdx,
				op: op as PredicateConstraint['op'],
				value: op === 'IN' ? [1] : 1,
				usable: true,
				sourceExpression: lit(1),
				targetRelation: 't',
			};
		}

		it('equality covers single-col key', () => {
			const result = computeCoveredKeysForConstraints([makeConstraint('=', 0)], [[0]]);
			expect(result).to.deep.equal([[0]]);
		});

		it('inequality does not cover', () => {
			const result = computeCoveredKeysForConstraints([makeConstraint('>', 0)], [[0]]);
			expect(result).to.deep.equal([]);
		});

		it('single-value IN covers key', () => {
			const c = makeConstraint('IN', 0);
			c.value = [42];
			const result = computeCoveredKeysForConstraints([c], [[0]]);
			expect(result).to.deep.equal([[0]]);
		});

		it('multi-value IN does not cover', () => {
			const c = makeConstraint('IN', 0);
			c.value = [1, 2];
			const result = computeCoveredKeysForConstraints([c], [[0]]);
			expect(result).to.deep.equal([]);
		});

		it('zero-length key trivially covered', () => {
			const result = computeCoveredKeysForConstraints([], [[]]);
			expect(result).to.deep.equal([[]]);
		});

		it('composite key needs all columns', () => {
			const result = computeCoveredKeysForConstraints(
				[makeConstraint('=', 0)],
				[[0, 1]]
			);
			expect(result).to.deep.equal([]);
		});

		it('composite key fully covered', () => {
			const result = computeCoveredKeysForConstraints(
				[makeConstraint('=', 0), makeConstraint('=', 1)],
				[[0, 1]]
			);
			expect(result).to.deep.equal([[0, 1]]);
		});

		it('multiple unique keys — one covered, one not', () => {
			const result = computeCoveredKeysForConstraints(
				[makeConstraint('=', 0)],
				[[0], [0, 1]]
			);
			expect(result).to.deep.equal([[0]]);
		});

		// Regression: a correlated binding (`col = <outer-ref>`) is not a
		// unique-key cover for delta-binding purposes — the RHS varies per
		// outer row. The cover guard skips on the orthogonal `correlated` flag
		// (computed at extraction time), so the relation is classified
		// `'global'` (not `'row'`), preventing false-positive NOT-EXISTS
		// violations downstream. Tracked via
		// `lamina-quereus-assertion-residual-correlated-binding` and its
		// follow-up `quereus-binding-extractor-correlated-expression-and-in`.
		it('correlated equality (correlated: true) does NOT cover', () => {
			const c = makeConstraint('=', 0);
			c.bindingKind = 'correlated';
			c.correlated = true;
			const result = computeCoveredKeysForConstraints([c], [[0]]);
			expect(result).to.deep.equal([]);
		});

		it('literal equality still covers (bindingKind: "literal")', () => {
			const c = makeConstraint('=', 0);
			c.bindingKind = 'literal';
			const result = computeCoveredKeysForConstraints([c], [[0]]);
			expect(result).to.deep.equal([[0]]);
		});

		it('parameter equality still covers (bindingKind: "parameter")', () => {
			const c = makeConstraint('=', 0);
			c.bindingKind = 'parameter';
			const result = computeCoveredKeysForConstraints([c], [[0]]);
			expect(result).to.deep.equal([[0]]);
		});

		it('mixed-key composite: literal on one column + correlated on the other does NOT cover', () => {
			const c0 = makeConstraint('=', 0);
			c0.bindingKind = 'literal';
			const c1 = makeConstraint('=', 1);
			c1.bindingKind = 'correlated';
			c1.correlated = true;
			const result = computeCoveredKeysForConstraints([c0, c1], [[0, 1]]);
			expect(result).to.deep.equal([]);
		});

		// Follow-up gaps: the cover guard keys on the orthogonal `correlated`
		// flag rather than `bindingKind`, so wrapped-correlated (`'expression'`)
		// and singleton-IN-correlated bindings are skipped uniformly.
		it('correlated singleton IN (correlated: true) does NOT cover', () => {
			const c = makeConstraint('IN', 0);
			c.value = [null];
			c.bindingKind = 'mixed';
			c.correlated = true;
			const result = computeCoveredKeysForConstraints([c], [[0]]);
			expect(result).to.deep.equal([]);
		});

		it('non-correlated singleton IN (correlated: false) still covers', () => {
			const c = makeConstraint('IN', 0);
			c.value = [1];
			const result = computeCoveredKeysForConstraints([c], [[0]]);
			expect(result).to.deep.equal([[0]]);
		});

		it('correlated wrapped-expression equality (bindingKind: "expression") does NOT cover', () => {
			const c = makeConstraint('=', 0);
			c.bindingKind = 'expression';
			c.correlated = true;
			const result = computeCoveredKeysForConstraints([c], [[0]]);
			expect(result).to.deep.equal([]);
		});

		it('same-table expression equality (correlated: false) still covers', () => {
			const c = makeConstraint('=', 0);
			c.bindingKind = 'expression';
			const result = computeCoveredKeysForConstraints([c], [[0]]);
			expect(result).to.deep.equal([[0]]);
		});
	});

	// ===================================================================
	// Dynamic / parameter binding
	// ===================================================================
	describe('dynamic binding metadata', () => {
		it('col = param → parameter binding', () => {
			const col = colRef(101, 'a', 1);
			const param = paramRef(':p1');
			const expr = binOp('=', col, param);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].bindingKind).to.equal('parameter');
			expect(result.allConstraints[0].valueExpr).to.exist;
		});

		it('col = lit → literal binding', () => {
			const col = colRef(101, 'a', 1);
			const expr = binOp('=', col, lit(5));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints[0].bindingKind).to.equal('literal');
		});

		it('col = otherTableCol → correlated binding', () => {
			const col = colRef(101, 'a', 1);
			const other = colRef(200, 'x', 0);
			const expr = binOp('=', col, other);
			const result = extractConstraints(expr, [TABLE_A, TABLE_B]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].bindingKind).to.equal('correlated');
		});

		it('col = sameTableCol → residual (not a constraint, value unknown until scan)', () => {
			const col_a = colRef(101, 'a', 1);
			const col_b = colRef(102, 'b', 2);
			const expr = binOp('=', col_a, col_b);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.not.equal(undefined);
		});

		it('param = col (reversed) → parameter binding with flipped op', () => {
			const col = colRef(101, 'a', 1);
			const param = paramRef(':p1');
			const expr = binOp('<', param, col);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('>');
			expect(result.allConstraints[0].bindingKind).to.equal('parameter');
		});
	});

	// ===================================================================
	// correlated flag — row-scope escape, orthogonal to bindingKind
	// (follow-up: quereus-binding-extractor-correlated-expression-and-in)
	// ===================================================================
	describe('correlated flag (row-scope escape)', () => {
		it('p.id = outer.id (bare other-table ref) → correlated true', () => {
			const id = colRef(100, 'id', 0);
			const other = colRef(200, 'x', 0);
			const expr = binOp('=', id, other);
			const result = extractConstraints(expr, [TABLE_A, TABLE_B]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].bindingKind).to.equal('correlated');
			expect(result.allConstraints[0].correlated).to.equal(true);
		});

		// The free-reference walk reaches refs nested under a CAST. `cast(outer.id)`
		// unwraps (via isDynamicValue) to a bare column ref, so it IS extracted —
		// inner is an other-table column → bindingKind 'correlated', and the walk
		// flags it. This is the reachable "wrapped correlated" extraction case.
		it('p.id = cast(outer.id) (cast-wrapped other-table ref) → correlated true', () => {
			const id = colRef(100, 'id', 0);
			const other = colRef(200, 'x', 0);
			const expr = binOp('=', id, castNode(other));
			const result = extractConstraints(expr, [TABLE_A, TABLE_B]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].bindingKind).to.equal('correlated');
			expect(result.allConstraints[0].correlated).to.equal(true);
		});

		// Same-table cast-wrapped ref: the cast unwraps to a same-table ColumnReference,
		// which is a per-row value and can never be a seek key — declined to residual.
		it('p.id = cast(p.b) (cast-wrapped same-table ref) → residual (not a constraint)', () => {
			const id = colRef(100, 'id', 0);
			const b = colRef(102, 'b', 2);
			const expr = binOp('=', id, castNode(b));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.exist;
		});

		// Documents the extractor limitation: a general-expression value side
		// (BinaryOp, coalesce, cast-over-expr) does NOT pass the column-constant
		// pattern guard, so `p.id = outer.id + 1` stays residual and never reaches
		// the cover guard — already safe, no false cover possible via this path.
		it('p.id = outer.id + 1 (general expression) → not extracted (residual)', () => {
			const id = colRef(100, 'id', 0);
			const other = colRef(200, 'x', 0);
			const expr = binOp('=', id, binOp('+', other, lit(1)));
			const result = extractConstraints(expr, [TABLE_A, TABLE_B]);
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.exist;
		});

		// Same-table bare column ref: per-row value, declined to residual.
		it('p.id = p.b (bare same-table ref) → residual (not a constraint)', () => {
			const id = colRef(100, 'id', 0);
			const b = colRef(102, 'b', 2);
			const expr = binOp('=', id, b);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.exist;
		});

		it('p.id = :param → correlated false (parameter does not escape row scope)', () => {
			const id = colRef(100, 'id', 0);
			const param = paramRef(':p1');
			const expr = binOp('=', id, param);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].correlated).to.equal(false);
		});

		it('p.id = 5 (literal) → correlated unset/falsy', () => {
			const id = colRef(100, 'id', 0);
			const expr = binOp('=', id, lit(5));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].correlated).to.not.equal(true);
		});

		it('p.id IN (outer.id) (correlated singleton) → correlated true, bindingKind mixed', () => {
			const id = colRef(100, 'id', 0);
			const other = colRef(200, 'x', 0);
			const expr = inNode(id, [other]);
			const result = extractConstraints(expr, [TABLE_A, TABLE_B]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('IN');
			expect(result.allConstraints[0].bindingKind).to.equal('mixed');
			expect(result.allConstraints[0].correlated).to.equal(true);
		});

		it('p.id IN (:p1) (parameter singleton) → correlated false', () => {
			const id = colRef(100, 'id', 0);
			const param = paramRef(':p1');
			const expr = inNode(id, [param]);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('IN');
			expect(result.allConstraints[0].correlated).to.equal(false);
		});

		// Cast-wrapped IN element: `cast(outer.id)` passes isDynamicValue (single
		// unwrapCast exposes a column ref) so it IS extracted, and the free-ref
		// walk reaches the outer ref through the cast → correlated true. Mirrors
		// the equality cast case for the IN path.
		it('p.id IN (cast(outer.id)) (cast-wrapped correlated singleton) → correlated true', () => {
			const id = colRef(100, 'id', 0);
			const other = colRef(200, 'x', 0);
			const expr = inNode(id, [castNode(other)]);
			const result = extractConstraints(expr, [TABLE_A, TABLE_B]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('IN');
			expect(result.allConstraints[0].correlated).to.equal(true);
			expect(result.coveredKeysByTable!.get('t')!).to.have.length(0);
		});

		// Cover integration: a correlated singleton IN must not be treated as a
		// covering key (the latent gap this ticket closes).
		it('p.id IN (outer.id) does NOT cover the PK (coveredKeysByTable)', () => {
			const id = colRef(100, 'id', 0);
			const other = colRef(200, 'x', 0);
			const expr = inNode(id, [other]);
			const result = extractConstraints(expr, [TABLE_A, TABLE_B]);
			expect(result.coveredKeysByTable!.get('t')!).to.have.length(0);
		});

		it('p.id = cast(outer.id) does NOT cover the PK (coveredKeysByTable)', () => {
			const id = colRef(100, 'id', 0);
			const other = colRef(200, 'x', 0);
			const expr = binOp('=', id, castNode(other));
			const result = extractConstraints(expr, [TABLE_A, TABLE_B]);
			expect(result.coveredKeysByTable!.get('t')!).to.have.length(0);
		});
	});

	// ===================================================================
	// No table infos → allConstraints empty but column refs still resolve
	// ===================================================================
	describe('no table infos provided', () => {
		it('returns no constraints when tableInfos is empty', () => {
			const col = colRef(101, 'a', 1);
			const expr = binOp('=', col, lit(5));
			const result = extractConstraints(expr, []);
			expect(result.allConstraints).to.have.length(0);
		});

		it('returns no constraints when tableInfos is omitted', () => {
			const col = colRef(101, 'a', 1);
			const expr = binOp('=', col, lit(5));
			const result = extractConstraints(expr);
			expect(result.allConstraints).to.have.length(0);
		});
	});

	// ===================================================================
	// Edge cases: two-column expressions (no extraction)
	// ===================================================================
	describe('two-column binary expressions', () => {
		it('col = col with no literals → residual (same-table col ref can never be a seek key)', () => {
			const a = colRef(101, 'a', 1);
			const b = colRef(102, 'b', 2);
			const expr = binOp('=', a, b);
			const result = extractConstraints(expr, [TABLE_A]);
			// Both sides are columns from the same table — value is unknown until the row is scanned.
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.not.equal(undefined);
		});
	});

	// ===================================================================
	// OR collapse — collapseBranchesToIn with mixed IN + equality
	// ===================================================================
	describe('OR collapse — mixed IN and equality branches', () => {
		it('a=1 OR a IN (2,3) collapsed when both on same column', () => {
			const col = colRef(101, 'a', 1);
			// Build: a=1 OR (a IN (2,3))
			// The OR extractor first extracts from each branch independently
			// Branch 1: a=1 → equality constraint
			// Branch 2: a IN (2,3) → IN constraint
			// Both equality/IN on same column → collapse to IN
			const branch1 = binOp('=', col, lit(1));
			const branch2 = inNode(col, [lit(2), lit(3)]);
			const expr = orNode(branch1, branch2);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('IN');
			expect(result.allConstraints[0].value).to.deep.equal([1, 2, 3]);
		});
	});

	// ===================================================================
	// OR with BETWEEN branch (range within OR)
	// ===================================================================
	describe('OR with range branches from BETWEEN', () => {
		it('(a BETWEEN 1 AND 5) OR a=10 → OR treats BETWEEN branch as 2-constraint range', () => {
			const col = colRef(101, 'a', 1);
			const branch1 = betweenNode(col, lit(1), lit(5));
			const branch2 = binOp('=', col, lit(10));
			const expr = orNode(branch1, branch2);
			const result = extractConstraints(expr, [TABLE_A]);
			// BETWEEN extracts as 2 constraints (>= and <=) on same col → branch has 2 constraints
			// tryCollapseToOrRange allows branches with 1-2 constraints
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('OR_RANGE');
			const ranges = result.allConstraints[0].ranges!;
			expect(ranges).to.have.length(2);
			// BETWEEN branch → lower and upper
			const betweenRange = ranges.find(r => r.lower && r.upper)!;
			expect(betweenRange.lower!.op).to.equal('>=');
			expect(betweenRange.lower!.value).to.equal(1);
			expect(betweenRange.upper!.op).to.equal('<=');
			expect(betweenRange.upper!.value).to.equal(5);
		});
	});

	// ===================================================================
	// Column index mapping edge cases
	// ===================================================================
	describe('column index mapping', () => {
		it('correct column index from columnIndexMap', () => {
			const table = makeTableInfo('t2', [
				{ id: 50, name: 'col0', index: 0 },
				{ id: 51, name: 'col1', index: 1 },
				{ id: 52, name: 'col2', index: 2 },
			]);
			const col = colRef(52, 'col2', 2);
			const expr = binOp('=', col, lit(99));
			const result = extractConstraints(expr, [table]);
			expect(result.allConstraints[0].columnIndex).to.equal(2);
			expect(result.allConstraints[0].attributeId).to.equal(52);
		});
	});

	// ===================================================================
	// CAST wrapping: a no-op cast is value-preserving and may be stripped;
	// a converting cast changes the compared value and must block pushdown.
	// `colRef` is INTEGER-typed, so castNode(col, 'INTEGER') is a no-op and
	// castNode(col) (default TEXT) converts. A `lit(n)` JS number types as REAL,
	// so its no-op cast target is 'REAL'. Regression cover for
	// `bug-cast-stripped-from-seek-constraints`.
	// ===================================================================
	describe('CAST wrapping — no-op strips, converting cast blocks extraction', () => {
		it('no-op CAST(col) = lit → extracts', () => {
			const col = colRef(101, 'a', 1);
			const expr = binOp('=', castNode(col, 'INTEGER'), lit(42));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('=');
			expect(result.allConstraints[0].columnIndex).to.equal(1);
			expect(result.allConstraints[0].value).to.equal(42);
		});

		it('converting CAST(col) = lit → no constraint, residual predicate', () => {
			const col = colRef(101, 'a', 1);
			const expr = binOp('=', castNode(col, 'TEXT'), lit(42));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.exist;
		});

		it('chained no-op CASTs over col → still extracts', () => {
			const col = colRef(101, 'a', 1);
			const expr = binOp('=', castNode(castNode(col, 'INTEGER'), 'INTEGER'), lit(42));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].columnIndex).to.equal(1);
		});

		it('col = no-op CAST(lit) → extracts with the literal value', () => {
			const col = colRef(101, 'a', 1);
			const expr = binOp('=', col, castNode(lit(42), 'REAL'));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('=');
			expect(result.allConstraints[0].value).to.equal(42);
			expect(result.allConstraints[0].bindingKind).to.equal('literal');
		});

		// `getLiteralValue` returns the pre-cast value, so extracting through a
		// converting cast on the literal side would seek on the integer 42 for
		// `a = cast(42 as text)`. Decline instead.
		it('col = converting CAST(lit) → no constraint, residual predicate', () => {
			const col = colRef(101, 'a', 1);
			const expr = binOp('=', col, castNode(lit(42), 'TEXT'));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.exist;
		});

		it('no-op CAST(col) = no-op CAST(lit) → extracts through both', () => {
			const col = colRef(101, 'a', 1);
			const expr = binOp('=', castNode(col, 'INTEGER'), castNode(lit(7), 'REAL'));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].value).to.equal(7);
		});

		it('converting CAST(col) = converting CAST(lit) → no constraint', () => {
			const col = colRef(101, 'a', 1);
			const expr = binOp('=', castNode(col, 'TEXT'), castNode(lit(7), 'TEXT'));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.exist;
		});

		it('no-op CAST(lit) < col → flip works through cast', () => {
			const col = colRef(101, 'a', 1);
			const expr = binOp('<', castNode(lit(3), 'REAL'), col);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('>');
			expect(result.allConstraints[0].value).to.equal(3);
		});

		it('converting CAST(lit) < col → no constraint, residual predicate', () => {
			const col = colRef(101, 'a', 1);
			const expr = binOp('<', castNode(lit(3), 'TEXT'), col);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.exist;
		});

		it('BETWEEN over no-op CAST(col) → extracts both bounds', () => {
			const col = colRef(101, 'a', 1);
			const expr = betweenNode(castNode(col, 'INTEGER'), lit(10), lit(20));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(2);
			expect(result.allConstraints.map(c => c.op).sort()).to.deep.equal(['<=', '>=']);
		});

		it('BETWEEN over converting CAST(col) → residual, no range constraints', () => {
			const col = colRef(101, 'a', 1);
			const expr = betweenNode(castNode(col, 'TEXT'), lit(10), lit(20));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.exist;
		});

		it('IN with CAST(col) condition → not extracted (InNode requires a bare column ref)', () => {
			const col = colRef(101, 'a', 1);
			const expr = inNode(castNode(col), [lit(1), lit(2)]);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(0);
		});

		it('IS NULL on no-op CAST(col) → extracts', () => {
			const col = colRef(101, 'a', 1);
			const expr = unaryOp('IS NULL', castNode(col, 'INTEGER'));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('IS NULL');
		});

		// `cast(x as text) is null` is null-preserving today, but the constraint
		// would name column `a` while the seek shape describes the cast's output.
		// Decline rather than reason about it.
		it('IS NULL on converting CAST(col) → residual', () => {
			const col = colRef(101, 'a', 1);
			const expr = unaryOp('IS NULL', castNode(col, 'TEXT'));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.exist;
		});

		// Value-side casts over a parameter stay usable: `valueExpr` retains the
		// whole CastNode and is evaluated at runtime, so `bindingKind` may be
		// classified through a converting cast.
		it('col = converting CAST(param) → parameter binding, cast retained in valueExpr', () => {
			const col = colRef(101, 'a', 1);
			const param = paramRef(':p1');
			const cast = castNode(param, 'TEXT');
			const expr = binOp('=', col, cast);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].bindingKind).to.equal('parameter');
			expect(result.allConstraints[0].valueExpr).to.equal(cast);
		});

		it('col = no-op CAST(param) → parameter binding', () => {
			const col = colRef(101, 'a', 1);
			const param = paramRef(':p1');
			const expr = binOp('=', col, castNode(param, 'INTEGER'));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].bindingKind).to.equal('parameter');
		});

		// Covered-key integration: a converting cast on the key column must not
		// produce a covering equality (no false ≤1-row claim).
		it('converting CAST(pk) = lit → PK not covered', () => {
			const id = colRef(100, 'id', 0);
			const expr = binOp('=', castNode(id, 'TEXT'), lit(1));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(0);
			expect(result.coveredKeysByTable!.get('t') ?? []).to.have.length(0);
		});

		it('no-op CAST(pk) = lit → PK covered', () => {
			const id = colRef(100, 'id', 0);
			const expr = binOp('=', castNode(id, 'INTEGER'), lit(1));
			const result = extractConstraints(expr, [TABLE_A]);
			const covered = result.coveredKeysByTable!.get('t')!;
			expect(covered).to.have.length(1);
			expect(covered[0]).to.deep.equal([0]);
		});

		it('pk = converting CAST(lit) → PK not covered', () => {
			const id = colRef(100, 'id', 0);
			const expr = binOp('=', id, castNode(lit(1), 'TEXT'));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(0);
			expect(result.coveredKeysByTable!.get('t') ?? []).to.have.length(0);
		});

		// OR collapse: every branch must survive extraction, so a converting cast
		// in one branch keeps the whole OR residual.
		it('converting CAST(col)=1 OR converting CAST(col)=2 → residual, no IN collapse', () => {
			const col = colRef(101, 'a', 1);
			const expr = orNode(
				binOp('=', castNode(col, 'TEXT'), lit(1)),
				binOp('=', castNode(col, 'TEXT'), lit(2)),
			);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.exist;
		});

		it('no-op CAST(col)=1 OR no-op CAST(col)=2 → IN (1,2)', () => {
			const col = colRef(101, 'a', 1);
			const expr = orNode(
				binOp('=', castNode(col, 'INTEGER'), lit(1)),
				binOp('=', castNode(col, 'INTEGER'), lit(2)),
			);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('IN');
			expect(result.allConstraints[0].value).to.deep.equal([1, 2]);
		});

		// A converting cast on the column side no longer makes that column the
		// constrained one. When the *other* side is a bare column of another
		// table, the constraint rebinds to it: `u.y = cast(t.a as text)` is a
		// sound correlated seek on `u`, with the cast evaluated at runtime.
		it('converting CAST(t.a) = u.y → constraint binds to u.y, cast kept in valueExpr', () => {
			const a = colRef(101, 'a', 1);
			const y = colRef(201, 'y', 1);
			const cast = castNode(a, 'TEXT');
			const expr = binOp('=', cast, y);
			const result = extractConstraints(expr, [TABLE_A, TABLE_B]);
			expect(result.allConstraints).to.have.length(1);
			const c = result.allConstraints[0];
			expect(c.targetRelation).to.equal('u');
			expect(c.attributeId).to.equal(201);
			expect(c.op).to.equal('=');
			expect(c.bindingKind).to.equal('correlated');
			expect(c.correlated).to.equal(true);
			expect(c.valueExpr).to.equal(cast);
		});

		// Same-table on both sides: the value is unknown until the row is
		// scanned, so no seek key exists either way.
		it('converting CAST(t.a) = t.b → no constraint, residual predicate', () => {
			const a = colRef(101, 'a', 1);
			const b = colRef(102, 'b', 2);
			const expr = binOp('=', castNode(a, 'TEXT'), b);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.exist;
		});

		// Value side is the cast: the column side is untouched, so the seek on
		// `t.a` survives and evaluates the cast per outer row.
		it('t.a = converting CAST(u.y) → correlated constraint on t.a, cast kept in valueExpr', () => {
			const a = colRef(101, 'a', 1);
			const y = colRef(201, 'y', 1);
			const cast = castNode(y, 'TEXT');
			const expr = binOp('=', a, cast);
			const result = extractConstraints(expr, [TABLE_A, TABLE_B]);
			const c = result.allConstraints.find(x => x.targetRelation === 't')!;
			expect(c).to.exist;
			expect(c.attributeId).to.equal(101);
			expect(c.bindingKind).to.equal('correlated');
			expect(c.valueExpr).to.equal(cast);
		});

		// IN list elements go through `getLiteralValue`, which returns the
		// pre-cast value — so a converting cast in the list must decline rather
		// than extract `a IN (1)` for `a IN (cast(1 as text))`.
		it('col IN (converting CAST(lit)) → no constraint, residual predicate', () => {
			const col = colRef(101, 'a', 1);
			const expr = inNode(col, [castNode(lit(1), 'TEXT')]);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.exist;
		});

		it('col IN (no-op CAST(lit)) → extracts with the literal value', () => {
			const col = colRef(101, 'a', 1);
			const expr = inNode(col, [castNode(lit(1), 'REAL')]);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('IN');
			expect(result.allConstraints[0].value).to.deep.equal([1]);
		});
	});

	// ===================================================================
	// createResidualFilter (public export)
	// ===================================================================
	describe('createResidualFilter', () => {
		it('returns undefined when no constraints handled', () => {
			const expr = binOp('=', colRef(101, 'a', 1), lit(5));
			const result = createResidualFilter(expr, []);
			expect(result).to.be.undefined;
		});

		it('returns undefined for non-empty constraints (stub implementation)', () => {
			const expr = binOp('=', colRef(101, 'a', 1), lit(5));
			const constraint: PredicateConstraint = {
				columnIndex: 1,
				attributeId: 101,
				op: '=',
				value: 5,
				usable: true,
				sourceExpression: expr,
				targetRelation: 't',
			};
			const result = createResidualFilter(expr, [constraint]);
			expect(result).to.be.undefined;
		});
	});

	// ===================================================================
	// OR_RANGE — more precise range spec assertions
	// ===================================================================
	describe('OR_RANGE — detailed range spec assertions', () => {
		it('a>5 OR a<2 → each spec has correct bound direction', () => {
			const col = colRef(101, 'a', 1);
			const expr = orNode(binOp('>', col, lit(5)), binOp('<', col, lit(2)));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			const c = result.allConstraints[0];
			expect(c.op).to.equal('OR_RANGE');
			expect(c.ranges).to.have.length(2);
			// a>5 branch → lower bound
			const lowerBound = c.ranges!.find(r => r.lower && r.lower.op === '>')!;
			expect(lowerBound).to.exist;
			expect(lowerBound.lower!.value).to.equal(5);
			expect(lowerBound.upper).to.be.undefined;
			// a<2 branch → upper bound
			const upperBound = c.ranges!.find(r => r.upper && r.upper.op === '<')!;
			expect(upperBound).to.exist;
			expect(upperBound.upper!.value).to.equal(2);
			expect(upperBound.lower).to.be.undefined;
		});

		it('a>=5 OR a<=2 → inclusive bounds in specs', () => {
			const col = colRef(101, 'a', 1);
			const expr = orNode(binOp('>=', col, lit(5)), binOp('<=', col, lit(2)));
			const result = extractConstraints(expr, [TABLE_A]);
			const c = result.allConstraints[0];
			const lower = c.ranges!.find(r => r.lower)!;
			expect(lower.lower!.op).to.equal('>=');
			const upper = c.ranges!.find(r => r.upper && !r.lower)!;
			expect(upper.upper!.op).to.equal('<=');
		});

		it('OR_RANGE targetRelation and columnIndex correct', () => {
			const col = colRef(101, 'a', 1);
			const expr = orNode(binOp('>', col, lit(5)), binOp('<', col, lit(2)));
			const result = extractConstraints(expr, [TABLE_A]);
			const c = result.allConstraints[0];
			expect(c.targetRelation).to.equal('t');
			expect(c.columnIndex).to.equal(1);
			expect(c.attributeId).to.equal(101);
			expect(c.usable).to.be.true;
			expect(c.bindingKind).to.equal('literal');
		});

		it('OR with 3+ constraints in single branch → not collapsible', () => {
			const col = colRef(101, 'a', 1);
			// Branch with 3 constraints: a>1 AND a<10 AND a!=5
			// tryCollapseToOrRange rejects branches with >2 constraints
			const branch1 = andNode(andNode(binOp('>', col, lit(1)), binOp('<', col, lit(10))), binOp('=', col, lit(5)));
			const branch2 = binOp('=', col, lit(20));
			const expr = orNode(branch1, branch2);
			const result = extractConstraints(expr, [TABLE_A]);
			// Branch1 has 3 constraints → OR_RANGE rejects → falls back
			// The whole OR may still extract if all branches are equality/IN
			// Actually branch1 has 3 constraints (>, <, =) → tryCollapseToOrRange returns null
			// Then tryExtractOrBranches returns null → residual
			if (result.allConstraints.length > 0) {
				// If it does extract, verify it's reasonable
				expect(result.allConstraints[0].op).to.not.equal('OR_RANGE');
			}
		});
	});

	// ===================================================================
	// OR → IN — boundary/edge cases for collapseBranchesToIn
	// ===================================================================
	describe('collapseBranchesToIn — edge cases', () => {
		it('OR of two IN on same column → merged IN', () => {
			const col = colRef(101, 'a', 1);
			const branch1 = inNode(col, [lit(1), lit(2)]);
			const branch2 = inNode(col, [lit(3), lit(4)]);
			const expr = orNode(branch1, branch2);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('IN');
			expect(result.allConstraints[0].value).to.deep.equal([1, 2, 3, 4]);
		});

		it('OR IN values include correct bindingKind=literal when all lit', () => {
			const col = colRef(101, 'a', 1);
			const expr = orNode(binOp('=', col, lit(1)), binOp('=', col, lit(2)));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints[0].bindingKind).to.equal('literal');
			expect(result.allConstraints[0].valueExpr).to.be.undefined;
		});

		it('OR with param in one branch → mixed binding', () => {
			const col = colRef(101, 'a', 1);
			const param = paramRef(':p1');
			const expr = orNode(binOp('=', col, lit(1)), binOp('=', col, param));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('IN');
			expect(result.allConstraints[0].bindingKind).to.equal('mixed');
			expect(result.allConstraints[0].valueExpr).to.exist;
		});
	});

	// ===================================================================
	// OR collapse collation gate (or-equality-collapse-collation-blind):
	// a collapse is sound only when every disjunct's effective comparison
	// collation equals the column operand's own collation (what the collapsed
	// IN / OR_RANGE compares under). Mismatches must produce NO constraint and
	// a residualPredicate — this is the "no seek strips the residual"
	// guarantee at its source.
	// ===================================================================
	describe('OR collapse — collation gate', () => {
		it('eq→IN under-match: NOCASE-collated literals over a plain TEXT column → no constraint, OR residual', () => {
			const expr = orNode(
				binOp('=', textColRef(102, 'b', 2), collatedLit('bob', 'NOCASE')),
				binOp('=', textColRef(102, 'b', 2), collatedLit('x', 'NOCASE'))
			);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.exist;
		});

		it('eq→IN over-match: BINARY-collated literals over a NOCASE-declared column → no constraint, OR residual', () => {
			const expr = orNode(
				binOp('=', textColRef(102, 'b', 2, 'NOCASE'), collatedLit('bob', 'BINARY')),
				binOp('=', textColRef(102, 'b', 2, 'NOCASE'), collatedLit('x', 'BINARY'))
			);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.exist;
		});

		it('eq-as-range→OR_RANGE: NOCASE-collated equality + plain range over a plain column → no constraint, OR residual', () => {
			const expr = orNode(
				binOp('=', textColRef(102, 'b', 2), collatedLit('bob', 'NOCASE')),
				binOp('>', textColRef(102, 'b', 2), lit('z'))
			);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.exist;
		});

		it('BETWEEN branch with a NOCASE-collated bound → no OR_RANGE, OR residual', () => {
			const expr = orNode(
				betweenNode(textColRef(102, 'b', 2), collatedLit('a', 'NOCASE'), lit('m')),
				binOp('>', textColRef(102, 'b', 2), lit('z'))
			);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.exist;
		});

		it('matched: NOCASE-declared column with NOCASE-collated and plain literals → IN still fires', () => {
			const expr = orNode(
				binOp('=', textColRef(102, 'b', 2, 'NOCASE'), collatedLit('bob', 'NOCASE')),
				binOp('=', textColRef(102, 'b', 2, 'NOCASE'), lit('x'))
			);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('IN');
			expect(result.allConstraints[0].value).to.deep.equal(['bob', 'x']);
			expect(result.residualPredicate).to.be.undefined;
		});

		it('matched: plain range disjuncts over a NOCASE-declared column → OR_RANGE still fires', () => {
			const expr = orNode(
				binOp('<', textColRef(102, 'b', 2, 'NOCASE'), lit('a')),
				binOp('>', textColRef(102, 'b', 2, 'NOCASE'), lit('m'))
			);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('OR_RANGE');
		});

		it('written order is immaterial: a NOCASE-folded literal on EITHER side of a BINARY-declared column makes the comparison NOCASE → collapse declined', () => {
			// `'bob' COLLATE NOCASE = b` compares NOCASE regardless of spelling
			// order (explicit rank 3 outranks the declared BINARY in the
			// symmetric provenance lattice), so collapsing into an IN that the
			// column's BINARY collation would drive is unsound — the gate must
			// keep the OR residual.
			const expr = orNode(
				binOp('=', collatedLit('bob', 'NOCASE'), textColRef(102, 'b', 2, 'BINARY')),
				binOp('=', textColRef(102, 'b', 2, 'BINARY'), lit('x'))
			);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.exist;
		});
	});

	// ===================================================================
	// Exact constraint property assertions (usable, targetRelation, etc.)
	// ===================================================================
	describe('constraint property completeness', () => {
		it('every extracted constraint has usable=true', () => {
			const col = colRef(101, 'a', 1);
			const expr = andNode(binOp('=', col, lit(1)), binOp('>', col, lit(0)));
			const result = extractConstraints(expr, [TABLE_A]);
			for (const c of result.allConstraints) {
				expect(c.usable).to.be.true;
			}
		});

		it('every constraint has sourceExpression set', () => {
			const col = colRef(101, 'a', 1);
			const expr = binOp('=', col, lit(1));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints[0].sourceExpression).to.exist;
		});

		it('constraint on unmapped column (no columnIndex) → not extracted', () => {
			// Table info has attr but no column index mapping
			const table: TableInfo = {
				relationName: 'broken',
				relationKey: 'broken',
				attributes: [{ id: 600, name: 'x' }],
				columnIndexMap: new Map(), // Empty map — no column index!
			};
			const col = colRef(600, 'x', 0);
			const expr = binOp('=', col, lit(1));
			const result = extractConstraints(expr, [table]);
			expect(result.allConstraints).to.have.length(0);
		});
	});

	// ===================================================================
	// Multiple tables — coveredKeysByTable for table with no constraints
	// ===================================================================
	describe('coveredKeysByTable multi-table', () => {
		it('table with no constraints gets empty covered keys', () => {
			const col_a = colRef(101, 'a', 1);
			const expr = binOp('=', col_a, lit(5));
			const result = extractConstraints(expr, [TABLE_A, TABLE_B]);
			// TABLE_B has no constraints referencing it
			expect(result.coveredKeysByTable!.has('u')).to.be.false;
			// Only tables with constraints get entries
		});

		it('both tables with equality → both check covered keys', () => {
			const id_a = colRef(100, 'id', 0);
			const x_b = colRef(200, 'x', 0);
			const expr = andNode(binOp('=', id_a, lit(1)), binOp('=', x_b, lit(100)));
			const result = extractConstraints(expr, [TABLE_A, TABLE_B]);
			const coveredA = result.coveredKeysByTable!.get('t')!;
			const coveredB = result.coveredKeysByTable!.get('u')!;
			expect(coveredA).to.have.length(1); // PK [0] covered
			expect(coveredB).to.have.length(1); // PK [0] covered
		});
	});

	// ===================================================================
	// AND with BETWEEN + binary — mixed extraction
	// ===================================================================
	describe('AND with mixed node types', () => {
		it('BETWEEN AND equality → 3 constraints total', () => {
			const col = colRef(101, 'a', 1);
			const col2 = colRef(102, 'b', 2);
			const expr = andNode(
				betweenNode(col, lit(10), lit(20)),
				binOp('=', col2, lit(42))
			);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(3);
			const ops = result.allConstraints.map(c => c.op).sort();
			expect(ops).to.deep.equal(['<=', '=', '>=']);
		});

		it('IN AND equality → 2 constraints', () => {
			const col = colRef(101, 'a', 1);
			const col2 = colRef(102, 'b', 2);
			const expr = andNode(
				inNode(col, [lit(1), lit(2)]),
				binOp('=', col2, lit(42))
			);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(2);
		});

		it('IS NULL AND equality → 2 constraints', () => {
			const col = colRef(101, 'a', 1);
			const col2 = colRef(102, 'b', 2);
			const expr = andNode(
				unaryOp('IS NULL', col),
				binOp('=', col2, lit(42))
			);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(2);
			expect(result.allConstraints.find(c => c.op === 'IS NULL')).to.exist;
			expect(result.allConstraints.find(c => c.op === '=')).to.exist;
		});
	});

	// ===================================================================
	// Operator distinction — ensure each operator is distinguishable
	// ===================================================================
	describe('operator distinction — each op differs from neighbors', () => {
		it('> differs from >=', () => {
			const col = colRef(101, 'a', 1);
			const exprGt = binOp('>', col, lit(5));
			const exprGe = binOp('>=', col, lit(5));
			const r1 = extractConstraints(exprGt, [TABLE_A]);
			const r2 = extractConstraints(exprGe, [TABLE_A]);
			expect(r1.allConstraints[0].op).to.equal('>');
			expect(r2.allConstraints[0].op).to.equal('>=');
			expect(r1.allConstraints[0].op).to.not.equal(r2.allConstraints[0].op);
		});

		it('< differs from <=', () => {
			const col = colRef(101, 'a', 1);
			const exprLt = binOp('<', col, lit(5));
			const exprLe = binOp('<=', col, lit(5));
			const r1 = extractConstraints(exprLt, [TABLE_A]);
			const r2 = extractConstraints(exprLe, [TABLE_A]);
			expect(r1.allConstraints[0].op).to.equal('<');
			expect(r2.allConstraints[0].op).to.equal('<=');
			expect(r1.allConstraints[0].op).to.not.equal(r2.allConstraints[0].op);
		});

		it('= differs from all inequality ops', () => {
			const col = colRef(101, 'a', 1);
			const eqResult = extractConstraints(binOp('=', col, lit(5)), [TABLE_A]);
			const eqOp = eqResult.allConstraints[0].op;
			for (const ineq of ['>', '>=', '<', '<=']) {
				const r = extractConstraints(binOp(ineq, col, lit(5)), [TABLE_A]);
				expect(r.allConstraints[0].op).to.not.equal(eqOp, `'=' should differ from '${ineq}'`);
			}
		});

		it('LIKE differs from GLOB and MATCH', () => {
			const col = colRef(101, 'a', 1);
			const rLike = extractConstraints(binOp('LIKE', col, lit('%x')), [TABLE_A]);
			const rGlob = extractConstraints(binOp('GLOB', col, lit('*x')), [TABLE_A]);
			const rMatch = extractConstraints(binOp('MATCH', col, lit('pat')), [TABLE_A]);
			expect(rLike.allConstraints[0].op).to.equal('LIKE');
			expect(rGlob.allConstraints[0].op).to.equal('GLOB');
			expect(rMatch.allConstraints[0].op).to.equal('MATCH');
			expect(rLike.allConstraints[0].op).to.not.equal(rGlob.allConstraints[0].op);
			expect(rLike.allConstraints[0].op).to.not.equal(rMatch.allConstraints[0].op);
			expect(rGlob.allConstraints[0].op).to.not.equal(rMatch.allConstraints[0].op);
		});
	});

	// ===================================================================
	// flipOperator symmetry — flip(flip(x)) === x for all ops
	// ===================================================================
	describe('flipOperator symmetry', () => {
		it('double flip of < via lit-col-lit-col round-trip', () => {
			const col = colRef(101, 'a', 1);
			// lit < col → col > lit; lit > col → col < lit
			const r1 = extractConstraints(binOp('<', lit(5), col), [TABLE_A]);
			expect(r1.allConstraints[0].op).to.equal('>');
			const r2 = extractConstraints(binOp('>', lit(5), col), [TABLE_A]);
			expect(r2.allConstraints[0].op).to.equal('<');
		});

		it('double flip of <= via lit-col-lit-col round-trip', () => {
			const col = colRef(101, 'a', 1);
			const r1 = extractConstraints(binOp('<=', lit(5), col), [TABLE_A]);
			expect(r1.allConstraints[0].op).to.equal('>=');
			const r2 = extractConstraints(binOp('>=', lit(5), col), [TABLE_A]);
			expect(r2.allConstraints[0].op).to.equal('<=');
		});
	});

	// ===================================================================
	// allConstraints count validation for various patterns
	// ===================================================================
	describe('allConstraints count accuracy', () => {
		it('single binary → exactly 1', () => {
			const result = extractConstraints(binOp('=', colRef(101, 'a', 1), lit(1)), [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
		});

		it('3 ANDed binaries → exactly 3', () => {
			const col = colRef(101, 'a', 1);
			const expr = andNode(andNode(binOp('>', col, lit(1)), binOp('<', col, lit(10))), binOp('=', colRef(102, 'b', 2), lit(5)));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(3);
		});

		it('OR of 2 eqs → exactly 1 (collapsed IN)', () => {
			const col = colRef(101, 'a', 1);
			const expr = orNode(binOp('=', col, lit(1)), binOp('=', col, lit(2)));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
		});

		it('BETWEEN → exactly 2 (>= and <=)', () => {
			const col = colRef(101, 'a', 1);
			const expr = betweenNode(col, lit(1), lit(10));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(2);
		});

		it('IS NULL → exactly 1', () => {
			const col = colRef(101, 'a', 1);
			const expr = unaryOp('IS NULL', col);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
		});

		it('IN → exactly 1', () => {
			const col = colRef(101, 'a', 1);
			const expr = inNode(col, [lit(1), lit(2), lit(3)]);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
		});
	});

	// ===================================================================
	// OR with tables from different relations → residual
	// ===================================================================
	describe('OR across different tables → residual', () => {
		it('a=1 OR x=2 (different tables) → residual', () => {
			const a = colRef(101, 'a', 1);
			const x = colRef(200, 'x', 0);
			const expr = orNode(binOp('=', a, lit(1)), binOp('=', x, lit(2)));
			const result = extractConstraints(expr, [TABLE_A, TABLE_B]);
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.exist;
		});
	});

	// ===================================================================
	// Dynamic binding — detailed binding kind verification
	// ===================================================================
	describe('dynamic binding — extended', () => {
		it('col > param → parameter binding, value is undefined', () => {
			const col = colRef(101, 'a', 1);
			const param = paramRef(':p1');
			const expr = binOp('>', col, param);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints[0].bindingKind).to.equal('parameter');
			expect(result.allConstraints[0].value).to.be.undefined;
			expect(result.allConstraints[0].valueExpr).to.exist;
		});

		it('col = col (cross-table) → correlated, value is undefined', () => {
			const a = colRef(101, 'a', 1);
			const x = colRef(200, 'x', 0);
			const expr = binOp('=', a, x);
			const result = extractConstraints(expr, [TABLE_A, TABLE_B]);
			const c = result.allConstraints.find(c => c.targetRelation === 't')!;
			expect(c.bindingKind).to.equal('correlated');
			expect(c.value).to.be.undefined;
			expect(c.valueExpr).to.exist;
		});

		it('lit = col → literal binding (not dynamic)', () => {
			const col = colRef(101, 'a', 1);
			const expr = binOp('=', lit(42), col);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints[0].bindingKind).to.equal('literal');
			expect(result.allConstraints[0].valueExpr).to.be.undefined;
		});
	});

	// ===================================================================
	// IN all-literal binding metadata
	// ===================================================================
	describe('IN binding metadata', () => {
		it('all-literal IN → no valueExpr', () => {
			const col = colRef(101, 'a', 1);
			const expr = inNode(col, [lit(1), lit(2), lit(3)]);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints[0].bindingKind).to.be.undefined;
			expect(result.allConstraints[0].valueExpr).to.be.undefined;
		});

		it('mixed IN (literal + param) → mixed binding with valueExpr array', () => {
			const col = colRef(101, 'a', 1);
			const param = paramRef(':p1');
			const expr = inNode(col, [lit(1), param, lit(3)]);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints[0].bindingKind).to.equal('mixed');
			expect(result.allConstraints[0].valueExpr).to.be.an('array');
			expect((result.allConstraints[0].valueExpr as ScalarPlanNode[])).to.have.length(3);
		});

		it('all-dynamic IN → extracted with mixed binding', () => {
			const col = colRef(101, 'a', 1);
			const p1 = paramRef(':p1');
			const p2 = paramRef(':p2');
			const expr = inNode(col, [p1, p2]);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].bindingKind).to.equal('mixed');
		});

		it('IN with non-usable value (non-literal, non-dynamic) → not extracted', () => {
			const col = colRef(101, 'a', 1);
			// BinaryOp as a value — not a literal and not a dynamic value
			const complexExpr = binOp('+', lit(1), lit(2));
			const expr = inNode(col, [complexExpr]);
			const result = extractConstraints(expr, [TABLE_A]);
			// The + expression is not isLiteralConstant and not isDynamicValue → allUsable = false → null
			expect(result.allConstraints).to.have.length(0);
		});
	});

	// ===================================================================
	// L585: OR branch with residual + extractable → entire OR residual
	// Kills LogicalOperator mutant: hasResidual || constraints.length===0 → hasResidual && constraints.length===0
	// ===================================================================
	describe('OR with partially-extractable branch', () => {
		it('branch has constraints AND residual → entire OR is residual', () => {
			const col = colRef(101, 'a', 1);
			// Branch 1: a=5 AND (something non-extractable) → 1 constraint + 1 residual
			const branch1 = andNode(binOp('=', col, lit(5)), binOp('||', col, lit('x')));
			// Branch 2: a=10 → pure constraint
			const branch2 = binOp('=', col, lit(10));
			const expr = orNode(branch1, branch2);
			const result = extractConstraints(expr, [TABLE_A]);
			// Branch 1 has residual, so entire OR must be residual
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.exist;
		});

		it('both branches fully extractable → succeeds', () => {
			const col = colRef(101, 'a', 1);
			const branch1 = binOp('=', col, lit(5));
			const branch2 = binOp('=', col, lit(10));
			const expr = orNode(branch1, branch2);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('IN');
		});

		it('branch with 0 constraints → entire OR is residual', () => {
			const col = colRef(101, 'a', 1);
			// Branch 1: pure residual (no constraint)
			const branch1 = binOp('||', col, lit('x'));
			// Branch 2: extractable
			const branch2 = binOp('=', col, lit(10));
			const expr = orNode(branch1, branch2);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.exist;
		});
	});

	// ===================================================================
	// L120: residual combination — 1 vs 2 residuals
	// Kills EqualityOperator mutant: length === 1 → length >= 1
	// ===================================================================
	describe('residual predicate shape', () => {
		it('single residual → Literal (not AND-combined)', () => {
			const expr = lit(true);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.residualPredicate).to.exist;
			expect(result.residualPredicate!.nodeType).to.equal(PlanNodeType.Literal);
		});

		it('two residuals → AND-combined BinaryOp', () => {
			const expr = andNode(lit(true), lit(false));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.residualPredicate).to.exist;
			expect(result.residualPredicate!.nodeType).to.equal(PlanNodeType.BinaryOp);
		});

		it('three residuals → deeply AND-combined', () => {
			const expr = andNode(andNode(lit(true), lit(false)), lit(null));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.residualPredicate).to.exist;
			expect(result.residualPredicate!.nodeType).to.equal(PlanNodeType.BinaryOp);
		});

		it('mixed extractable + non-extractable → only non-extractable in residual', () => {
			const col = colRef(101, 'a', 1);
			const expr = andNode(binOp('=', col, lit(5)), lit(true));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.residualPredicate).to.exist;
			expect(result.residualPredicate!.nodeType).to.equal(PlanNodeType.Literal);
		});
	});

	// ===================================================================
	// L697: tryCollapseToOrRange — branch with 0 constraints
	// ===================================================================
	describe('tryCollapseToOrRange — branch constraint count boundaries', () => {
		it('branch with 2 constraints (lower+upper) on same col → valid OR_RANGE', () => {
			const col = colRef(101, 'a', 1);
			// Branch 1: a>5 AND a<10 → 2 constraints on same column
			const branch1 = andNode(binOp('>', col, lit(5)), binOp('<', col, lit(10)));
			// Branch 2: a>20
			const branch2 = binOp('>', col, lit(20));
			const expr = orNode(branch1, branch2);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('OR_RANGE');
			const ranges = result.allConstraints[0].ranges!;
			expect(ranges).to.have.length(2);
			// Branch 1 should have both lower and upper
			const bothBound = ranges.find(r => r.lower && r.upper)!;
			expect(bothBound).to.exist;
			expect(bothBound.lower!.op).to.equal('>');
			expect(bothBound.lower!.value).to.equal(5);
			expect(bothBound.upper!.op).to.equal('<');
			expect(bothBound.upper!.value).to.equal(10);
		});
	});

	// ===================================================================
	// L606: columnIndex AND attributeId matching in OR collapse
	// ===================================================================
	describe('OR → IN — columnIndex/attributeId matching', () => {
		it('same columnIndex different attributeId → no collapse', () => {
			// Two tables with same column index but different attribute IDs
			const table1 = makeTableInfo('t1', [{ id: 100, name: 'a', index: 0 }]);
			const table2 = makeTableInfo('t2', [{ id: 200, name: 'a', index: 0 }]);
			const col1 = colRef(100, 'a', 0);
			const col2 = colRef(200, 'a', 0);
			const expr = orNode(binOp('=', col1, lit(1)), binOp('=', col2, lit(2)));
			const result = extractConstraints(expr, [table1, table2]);
			// Different tables → different relations → OR branches target different tables → residual
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.exist;
		});
	});

	// ===================================================================
	// L368: nonLiteral binding detection — both sides literal
	// ===================================================================
	describe('binding kind — both sides literal', () => {
		it('col = lit → bindingKind literal (rhs literal path)', () => {
			const col = colRef(101, 'a', 1);
			const expr = binOp('=', col, lit(5));
			const result = extractConstraints(expr, [TABLE_A]);
			const c = result.allConstraints[0];
			expect(c.bindingKind).to.equal('literal');
			expect(c.valueExpr).to.be.undefined;
		});

		it('lit = col → bindingKind literal (lhs literal path)', () => {
			const col = colRef(101, 'a', 1);
			const expr = binOp('=', lit(5), col);
			const result = extractConstraints(expr, [TABLE_A]);
			const c = result.allConstraints[0];
			expect(c.bindingKind).to.equal('literal');
			expect(c.valueExpr).to.be.undefined;
		});

		it('col = param → bindingKind parameter, valueExpr set', () => {
			const col = colRef(101, 'a', 1);
			const param = paramRef(':p');
			const expr = binOp('=', col, param);
			const result = extractConstraints(expr, [TABLE_A]);
			const c = result.allConstraints[0];
			expect(c.bindingKind).to.equal('parameter');
			expect(c.valueExpr).to.exist;
			expect(c.value).to.be.undefined;
		});

		it('param = col (reversed) → bindingKind parameter', () => {
			const col = colRef(101, 'a', 1);
			const param = paramRef(':p');
			const expr = binOp('=', param, col);
			const result = extractConstraints(expr, [TABLE_A]);
			const c = result.allConstraints[0];
			expect(c.bindingKind).to.equal('parameter');
			expect(c.valueExpr).to.exist;
		});

		it('col = otherCol (same table) → residual (value unknown until row scanned)', () => {
			const a = colRef(101, 'a', 1);
			const b = colRef(102, 'b', 2);
			const expr = binOp('=', a, b);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.not.equal(undefined);
		});

		it('col = otherTableCol → correlated binding', () => {
			const a = colRef(101, 'a', 1);
			const x = colRef(200, 'x', 0);
			const expr = binOp('=', a, x);
			const result = extractConstraints(expr, [TABLE_A, TABLE_B]);
			const c = result.allConstraints.find(c => c.targetRelation === 't')!;
			expect(c.bindingKind).to.equal('correlated');
			expect(c.valueExpr).to.exist;
		});
	});

	// ===================================================================
	// L460: IN — allUsable vs allLiteral distinction
	// ===================================================================
	describe('IN — allUsable vs allLiteral', () => {
		it('all literal values → values extracted as SqlValues', () => {
			const col = colRef(101, 'a', 1);
			const expr = inNode(col, [lit(10), lit(20)]);
			const result = extractConstraints(expr, [TABLE_A]);
			const c = result.allConstraints[0];
			expect(c.value).to.deep.equal([10, 20]);
			expect(c.bindingKind).to.be.undefined; // not set for all-literal
		});

		it('mixed literal + dynamic → values array has undefined for dynamic', () => {
			const col = colRef(101, 'a', 1);
			const param = paramRef(':p');
			const expr = inNode(col, [lit(10), param]);
			const result = extractConstraints(expr, [TABLE_A]);
			const c = result.allConstraints[0];
			// allLiteral is false, so values map uses getLiteralValue for literals, undefined for non-literals
			const values = c.value as unknown[];
			expect(values[0]).to.equal(10);
			expect(values[1]).to.be.undefined;
		});
	});

	// ===================================================================
	// L142: coveredKeysByTable — tableInfo lookup by relationKey vs relationName
	// ===================================================================
	describe('coveredKeysByTable — table matching', () => {
		it('matches table by relationKey', () => {
			const id = colRef(100, 'id', 0);
			const expr = binOp('=', id, lit(1));
			const result = extractConstraints(expr, [TABLE_A]);
			// TABLE_A has relationKey='t', so coveredKeysByTable should use 't'
			expect(result.coveredKeysByTable!.has('t')).to.be.true;
		});
	});

	// ===================================================================
	// L159: zero-length key in coveredKeysByTable
	// ===================================================================
	describe('coveredKeysByTable — zero-length key edge case', () => {
		it('table with only zero-length key and no equality → still covered (trivially)', () => {
			const table = makeTableInfo('trivial', [
				{ id: 700, name: 'x', index: 0 },
			], [[]]);
			const col = colRef(700, 'x', 0);
			// Non-equality constraint
			const expr = binOp('>', col, lit(1));
			const result = extractConstraints(expr, [table]);
			const covered = result.coveredKeysByTable!.get('trivial')!;
			expect(covered).to.have.length(1);
			expect(covered[0]).to.deep.equal([]);
		});
	});

	// ===================================================================
	// OR → OR_RANGE: branch where equality results in lower+upper range
	// ===================================================================
	describe('OR_RANGE — equality branch detail', () => {
		it('equality in OR_RANGE → lower >= val AND upper <= val', () => {
			const col = colRef(101, 'a', 1);
			const expr = orNode(binOp('=', col, lit(7)), binOp('>', col, lit(100)));
			const result = extractConstraints(expr, [TABLE_A]);
			const c = result.allConstraints[0];
			expect(c.op).to.equal('OR_RANGE');
			const eqRange = c.ranges!.find(r => r.lower && r.upper)!;
			expect(eqRange.lower!.op).to.equal('>=');
			expect(eqRange.lower!.value).to.equal(7);
			expect(eqRange.upper!.op).to.equal('<=');
			expect(eqRange.upper!.value).to.equal(7);
		});
	});

	// ===================================================================
	// extractBinaryConstraint — two non-column, non-literal sides
	// ===================================================================
	describe('extractBinaryConstraint — no column ref', () => {
		it('lit op lit → no constraint (no column reference)', () => {
			const expr = binOp('=', lit(1), lit(2));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.exist;
		});

		it('complex expr op complex expr → no constraint', () => {
			const expr = binOp('=', binOp('+', lit(1), lit(2)), binOp('+', lit(3), lit(4)));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(0);
		});
	});

	// ===================================================================
	// BETWEEN — attribute/table edge cases
	// ===================================================================
	describe('BETWEEN — table mapping', () => {
		it('BETWEEN on column from provided table → correct table assignment', () => {
			const col = colRef(101, 'a', 1);
			const expr = betweenNode(col, lit(1), lit(10));
			const result = extractConstraints(expr, [TABLE_A]);
			for (const c of result.allConstraints) {
				expect(c.targetRelation).to.equal('t');
				expect(c.attributeId).to.equal(101);
				expect(c.columnIndex).to.equal(1);
			}
		});

		it('BETWEEN on column NOT in table info → no constraint', () => {
			const col = colRef(999, 'z', 0);
			const expr = betweenNode(col, lit(1), lit(10));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(0);
		});
	});

	// ===================================================================
	// IS NULL — table mapping edge cases
	// ===================================================================
	describe('IS NULL — table mapping', () => {
		it('IS NULL constraint has correct targetRelation', () => {
			const col = colRef(101, 'a', 1);
			const expr = unaryOp('IS NULL', col);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints[0].targetRelation).to.equal('t');
		});

		it('IS NOT NULL value is undefined', () => {
			const col = colRef(101, 'a', 1);
			const expr = unaryOp('IS NOT NULL', col);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints[0].value).to.be.undefined;
		});
	});

	// ===================================================================
	// NOT BETWEEN — confirm it produces residual, not empty result
	// ===================================================================
	describe('NOT BETWEEN — residual behavior', () => {
		it('NOT BETWEEN produces residual (not just empty constraints)', () => {
			const col = colRef(101, 'a', 1);
			const expr = betweenNode(col, lit(1), lit(10), true);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.exist;
		});
	});

	// ===================================================================
	// OR → IN collapse with IN already — verify merged values
	// ===================================================================
	describe('collapseBranchesToIn — value merging', () => {
		it('IN branch values are merged into result', () => {
			const col = colRef(101, 'a', 1);
			const branch1 = inNode(col, [lit(10), lit(20)]);
			const branch2 = binOp('=', col, lit(30));
			const expr = orNode(branch1, branch2);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('IN');
			const values = result.allConstraints[0].value as unknown[];
			expect(values).to.include(10);
			expect(values).to.include(20);
			expect(values).to.include(30);
			expect(values).to.have.length(3);
		});

		it('two IN branches → all values merged', () => {
			const col = colRef(101, 'a', 1);
			const branch1 = inNode(col, [lit(1), lit(2)]);
			const branch2 = inNode(col, [lit(3), lit(4)]);
			const expr = orNode(branch1, branch2);
			const result = extractConstraints(expr, [TABLE_A]);
			const values = result.allConstraints[0].value as unknown[];
			expect(values).to.deep.equal([1, 2, 3, 4]);
		});
	});

	// ===================================================================
	// OR_RANGE — dynamic value expressions in ranges
	// ===================================================================
	describe('OR_RANGE — dynamic values', () => {
		it('OR with param in range branch → OR_RANGE with valueExpr in spec', () => {
			const col = colRef(101, 'a', 1);
			const param = paramRef(':p');
			const expr = orNode(binOp('>', col, param), binOp('<', col, lit(0)));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('OR_RANGE');
			const ranges = result.allConstraints[0].ranges!;
			const dynRange = ranges.find(r => r.lower && r.lower.valueExpr)!;
			expect(dynRange).to.exist;
		});
	});

	// ===================================================================
	// L426, L435: BETWEEN usable flag — kills BooleanLiteral: true→false
	// ===================================================================
	describe('BETWEEN — usable flag', () => {
		it('BETWEEN >= constraint has usable=true', () => {
			const col = colRef(101, 'a', 1);
			const expr = betweenNode(col, lit(10), lit(20));
			const result = extractConstraints(expr, [TABLE_A]);
			const ge = result.allConstraints.find(c => c.op === '>=')!;
			expect(ge.usable).to.be.true;
		});

		it('BETWEEN <= constraint has usable=true', () => {
			const col = colRef(101, 'a', 1);
			const expr = betweenNode(col, lit(10), lit(20));
			const result = extractConstraints(expr, [TABLE_A]);
			const le = result.allConstraints.find(c => c.op === '<=')!;
			expect(le.usable).to.be.true;
		});

		it('BETWEEN targetRelation set on both constraints', () => {
			const col = colRef(101, 'a', 1);
			const expr = betweenNode(col, lit(10), lit(20));
			const result = extractConstraints(expr, [TABLE_A]);
			for (const c of result.allConstraints) {
				expect(c.targetRelation).to.equal('t');
			}
		});
	});

	// ===================================================================
	// L510: IS NULL usable flag — kills BooleanLiteral: true→false
	// ===================================================================
	describe('IS NULL — usable flag', () => {
		it('IS NULL constraint has usable=true', () => {
			const col = colRef(101, 'a', 1);
			const expr = unaryOp('IS NULL', col);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints[0].usable).to.be.true;
		});

		it('IS NOT NULL constraint has usable=true', () => {
			const col = colRef(101, 'a', 1);
			const expr = unaryOp('IS NOT NULL', col);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints[0].usable).to.be.true;
		});
	});

	// ===================================================================
	// L460: every→some mutant — IN with mixed usable/non-usable values
	// ===================================================================
	describe('IN — allUsable boundary', () => {
		it('IN with one literal + one non-usable → not extracted (every, not some)', () => {
			const col = colRef(101, 'a', 1);
			// lit(1) is usable, binOp('+', ...) is NOT usable (not literal, not dynamic)
			const nonUsable = binOp('+', lit(1), lit(2));
			const expr = inNode(col, [lit(1), nonUsable]);
			const result = extractConstraints(expr, [TABLE_A]);
			// With `every`: lit is usable, nonUsable is not → false → not extracted
			// With `some`: lit is usable → true → incorrectly extracted
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.exist;
		});

		it('IN with two non-usable values → not extracted', () => {
			const col = colRef(101, 'a', 1);
			const expr = inNode(col, [binOp('+', lit(1), lit(2)), binOp('+', lit(3), lit(4))]);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(0);
		});
	});

	// ===================================================================
	// L596: OR branches targeting multiple tables → residual
	// Kills ConditionalExpression mutant: allRelations.size !== 1 → false
	// ===================================================================
	describe('OR — multi-table branch rejection', () => {
		it('OR where each branch targets a different table → residual', () => {
			const a = colRef(101, 'a', 1);
			const x = colRef(200, 'x', 0);
			const expr = orNode(binOp('=', a, lit(1)), binOp('=', x, lit(2)));
			const result = extractConstraints(expr, [TABLE_A, TABLE_B]);
			// Both branches extractable but target different tables → allRelations.size === 2 → residual
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.exist;
		});
	});

	// ===================================================================
	// L738: OR_RANGE with < 2 range specs → null
	// (Can't directly trigger this since tryCollapseToOrRange is only called
	// from tryExtractOrBranches which already ensures >= 2 disjuncts, but
	// tests confirm the check isn't removable)
	// ===================================================================

	// ===================================================================
	// L922: computeCoveredKeysForConstraints — IN with non-array value
	// Kills mutant: c.op === 'IN' && Array.isArray(c.value)
	// ===================================================================
	describe('computeCoveredKeysForConstraints — IN edge cases', () => {
		function makeConstraintFull(op: string, colIdx: number, value: unknown): PredicateConstraint {
			return {
				columnIndex: colIdx,
				attributeId: colIdx,
				op: op as PredicateConstraint['op'],
				value: value as PredicateConstraint['value'],
				usable: true,
				sourceExpression: lit(1),
				targetRelation: 't',
			};
		}

		it('IN with non-array value → does not count as equality for key coverage', () => {
			// Edge case: IN constraint where value is not an array (shouldn't happen normally)
			const c = makeConstraintFull('IN', 0, 42);
			const result = computeCoveredKeysForConstraints([c], [[0]]);
			// value is not an array → Array.isArray check fails → doesn't add to eqCols
			expect(result).to.deep.equal([]);
		});

		it('IN with single-element array covers key', () => {
			const c = makeConstraintFull('IN', 0, [42]);
			const result = computeCoveredKeysForConstraints([c], [[0]]);
			expect(result).to.deep.equal([[0]]);
		});

		it('IN with 2-element array does NOT cover key', () => {
			const c = makeConstraintFull('IN', 0, [1, 2]);
			const result = computeCoveredKeysForConstraints([c], [[0]]);
			expect(result).to.deep.equal([]);
		});

		it('empty constraints + empty keys → empty result', () => {
			const result = computeCoveredKeysForConstraints([], []);
			expect(result).to.deep.equal([]);
		});

		it('non-equality non-IN op → never covers', () => {
			const c = makeConstraintFull('>', 0, 5);
			const result = computeCoveredKeysForConstraints([c], [[0]]);
			expect(result).to.deep.equal([]);
		});

		it('LIKE op → never covers', () => {
			const c = makeConstraintFull('LIKE', 0, '%test');
			const result = computeCoveredKeysForConstraints([c], [[0]]);
			expect(result).to.deep.equal([]);
		});
	});

	// ===================================================================
	// L153: coveredKeysByTable — single-value IN as equality for key check
	// Kills mutant: c.op === 'IN' || Array.isArray(c.value)
	// ===================================================================
	describe('coveredKeysByTable — IN-as-equality', () => {
		it('single-value IN treated as equality for key coverage', () => {
			const id = colRef(100, 'id', 0);
			const expr = inNode(id, [lit(42)]);
			const result = extractConstraints(expr, [TABLE_A]);
			const covered = result.coveredKeysByTable!.get('t')!;
			expect(covered).to.have.length(1);
			expect(covered[0]).to.deep.equal([0]);
		});

		it('two-value IN NOT treated as equality for key coverage', () => {
			const id = colRef(100, 'id', 0);
			const expr = inNode(id, [lit(1), lit(2)]);
			const result = extractConstraints(expr, [TABLE_A]);
			const covered = result.coveredKeysByTable!.get('t')!;
			expect(covered).to.have.length(0);
		});

		it('= op covers key (baseline)', () => {
			const id = colRef(100, 'id', 0);
			const expr = binOp('=', id, lit(1));
			const result = extractConstraints(expr, [TABLE_A]);
			const covered = result.coveredKeysByTable!.get('t')!;
			expect(covered).to.have.length(1);
		});

		it('> op does NOT cover key', () => {
			const id = colRef(100, 'id', 0);
			const expr = binOp('>', id, lit(1));
			const result = extractConstraints(expr, [TABLE_A]);
			const covered = result.coveredKeysByTable!.get('t')!;
			expect(covered).to.have.length(0);
		});
	});

	// ===================================================================
	// OR → IN collapse with IN branch having dynamic valueExpr
	// Covers L642-L646 (NoCoverage in collapseBranchesToIn)
	// ===================================================================
	describe('collapseBranchesToIn — IN branch with dynamic values', () => {
		it('IN(col, [lit, param]) OR col=lit → merged IN with mixed binding', () => {
			const col = colRef(101, 'a', 1);
			const param = paramRef(':p');
			// Branch 1: a IN (1, :p) → IN constraint with mixed binding + valueExpr
			const branch1 = inNode(col, [lit(1), param]);
			// Branch 2: a=10 → equality constraint
			const branch2 = binOp('=', col, lit(10));
			const expr = orNode(branch1, branch2);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('IN');
			// Values should be merged: [1, undefined (param), 10]
			const values = result.allConstraints[0].value as unknown[];
			expect(values).to.have.length(3);
			expect(values).to.include(1);
			expect(values).to.include(10);
			// Should have mixed binding due to parameter
			expect(result.allConstraints[0].bindingKind).to.equal('mixed');
			expect(result.allConstraints[0].valueExpr).to.be.an('array');
		});

		it('two IN branches with params → merged mixed binding', () => {
			const col = colRef(101, 'a', 1);
			const p1 = paramRef(':p1');
			const p2 = paramRef(':p2');
			const branch1 = inNode(col, [lit(1), p1]);
			const branch2 = inNode(col, [p2, lit(4)]);
			const expr = orNode(branch1, branch2);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('IN');
			const values = result.allConstraints[0].value as unknown[];
			expect(values).to.have.length(4);
			expect(result.allConstraints[0].bindingKind).to.equal('mixed');
		});
	});

	// ===================================================================
	// OR_RANGE — dynamic value expressions tracked per-spec
	// Kills L726 BlockStatement mutant (removing body of dynamic value assignment)
	// ===================================================================
	describe('OR_RANGE — dynamic value in spec', () => {
		it('param in upper bound → spec.upper.valueExpr set', () => {
			const col = colRef(101, 'a', 1);
			const param = paramRef(':p');
			// Branch 1: a > :p (param)
			// Branch 2: a < 0 (literal)
			const expr = orNode(binOp('>', col, param), binOp('<', col, lit(0)));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			const ranges = result.allConstraints[0].ranges!;
			expect(ranges).to.have.length(2);
			// Find the range with dynamic lower bound
			const dynRange = ranges.find(r => r.lower && r.lower.valueExpr)!;
			expect(dynRange).to.exist;
			expect(dynRange.lower!.value).to.be.undefined;
			// The literal range should not have valueExpr
			const litRange = ranges.find(r => r.upper && !r.upper.valueExpr)!;
			expect(litRange).to.exist;
			expect(litRange.upper!.value).to.equal(0);
		});

		it('equality with param in OR_RANGE → both bounds have valueExpr', () => {
			const col = colRef(101, 'a', 1);
			const param = paramRef(':p');
			// Branch 1: a = :p (equality with param → lower and upper both set)
			// Branch 2: a > 100
			const expr = orNode(binOp('=', col, param), binOp('>', col, lit(100)));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('OR_RANGE');
			const ranges = result.allConstraints[0].ranges!;
			const eqRange = ranges.find(r => r.lower && r.upper)!;
			expect(eqRange).to.exist;
			// Both bounds from equality should reference the param
			expect(eqRange.lower!.valueExpr).to.exist;
			expect(eqRange.upper!.valueExpr).to.exist;
		});
	});

	// ===================================================================
	// OR → IN with equality branch having dynamic valueExpr
	// Kills L656-659 BlockStatement mutants in collapseBranchesToIn
	// ===================================================================
	describe('collapseBranchesToIn — equality branch with dynamic value', () => {
		it('col=param OR col=lit → IN with mixed binding + correct valueExpr array', () => {
			const col = colRef(101, 'a', 1);
			const param = paramRef(':p');
			const expr = orNode(binOp('=', col, param), binOp('=', col, lit(42)));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('IN');
			expect(result.allConstraints[0].bindingKind).to.equal('mixed');
			const valueExprs = result.allConstraints[0].valueExpr as ScalarPlanNode[];
			expect(valueExprs).to.be.an('array');
			expect(valueExprs).to.have.length(2);
		});
	});

	// ===================================================================
	// BETWEEN — column index undefined (no mapping) → not extracted
	// Kills L411 blockStatement mutant
	// ===================================================================
	describe('BETWEEN — columnIndex mapping edge case', () => {
		it('BETWEEN column mapped to table but no columnIndex → residual', () => {
			const table: TableInfo = {
				relationName: 'broken',
				relationKey: 'broken',
				attributes: [{ id: 600, name: 'x' }],
				columnIndexMap: new Map(), // Empty — no column index
			};
			const col = colRef(600, 'x', 0);
			const expr = betweenNode(col, lit(1), lit(10));
			const result = extractConstraints(expr, [table]);
			expect(result.allConstraints).to.have.length(0);
		});
	});

	// ===================================================================
	// IS NULL — column index undefined → not extracted
	// ===================================================================
	describe('IS NULL — columnIndex mapping edge case', () => {
		it('IS NULL column mapped to table but no columnIndex → residual', () => {
			const table: TableInfo = {
				relationName: 'broken',
				relationKey: 'broken',
				attributes: [{ id: 600, name: 'x' }],
				columnIndexMap: new Map(),
			};
			const col = colRef(600, 'x', 0);
			const expr = unaryOp('IS NULL', col);
			const result = extractConstraints(expr, [table]);
			expect(result.allConstraints).to.have.length(0);
		});
	});

	// ===================================================================
	// IN — column index undefined → not extracted
	// ===================================================================
	describe('IN — columnIndex mapping edge case', () => {
		it('IN column mapped to table but no columnIndex → residual', () => {
			const table: TableInfo = {
				relationName: 'broken',
				relationKey: 'broken',
				attributes: [{ id: 600, name: 'x' }],
				columnIndexMap: new Map(),
			};
			const col = colRef(600, 'x', 0);
			const expr = inNode(col, [lit(1), lit(2)]);
			const result = extractConstraints(expr, [table]);
			expect(result.allConstraints).to.have.length(0);
		});
	});

	// ===================================================================
	// Binary — column index undefined → not extracted
	// ===================================================================
	describe('binary — columnIndex mapping edge case', () => {
		it('binary col=lit mapped to table but no columnIndex → residual', () => {
			const table: TableInfo = {
				relationName: 'broken',
				relationKey: 'broken',
				attributes: [{ id: 600, name: 'x' }],
				columnIndexMap: new Map(),
			};
			const col = colRef(600, 'x', 0);
			const expr = binOp('=', col, lit(5));
			const result = extractConstraints(expr, [table]);
			expect(result.allConstraints).to.have.length(0);
		});
	});

	// ===================================================================
	// OR_RANGE — branch consistency checks
	// ===================================================================
	describe('OR_RANGE — branch validation edge cases', () => {
		it('OR with 3-constraint branch (>2) → cannot be OR_RANGE, falls to residual if not IN', () => {
			const col = colRef(101, 'a', 1);
			// Three constraints in one branch: a>1 AND a<10 AND a>=5
			const branch1 = andNode(andNode(binOp('>', col, lit(1)), binOp('<', col, lit(10))), binOp('>=', col, lit(5)));
			const branch2 = binOp('>', col, lit(20));
			const expr = orNode(branch1, branch2);
			const result = extractConstraints(expr, [TABLE_A]);
			// Branch1 has 3 constraints → tryCollapseToOrRange rejects it (>2 per branch)
			// allEqOrIn check also fails (branch1 has 3 constraints, not 1)
			// So entire OR is residual
			expect(result.residualPredicate).to.exist;
		});

		it('OR_RANGE with 2-constraint branch (lower+upper) → succeeds', () => {
			const col = colRef(101, 'a', 1);
			const branch1 = andNode(binOp('>=', col, lit(1)), binOp('<=', col, lit(10)));
			const branch2 = andNode(binOp('>=', col, lit(20)), binOp('<=', col, lit(30)));
			const expr = orNode(branch1, branch2);
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			expect(result.allConstraints[0].op).to.equal('OR_RANGE');
			const ranges = result.allConstraints[0].ranges!;
			expect(ranges).to.have.length(2);
			// First range: [1, 10]
			const r1 = ranges.find(r => r.lower?.value === 1)!;
			expect(r1.lower!.op).to.equal('>=');
			expect(r1.upper!.op).to.equal('<=');
			expect(r1.upper!.value).to.equal(10);
			// Second range: [20, 30]
			const r2 = ranges.find(r => r.lower?.value === 20)!;
			expect(r2.lower!.op).to.equal('>=');
			expect(r2.upper!.op).to.equal('<=');
			expect(r2.upper!.value).to.equal(30);
		});

		it('OR_RANGE where inner branch has mismatched columns → residual', () => {
			const a = colRef(101, 'a', 1);
			const b = colRef(102, 'b', 2);
			// Branch 1: a>5 AND b<10 — two different columns in one branch
			const branch1 = andNode(binOp('>', a, lit(5)), binOp('<', b, lit(10)));
			// Branch 2: a>20
			const branch2 = binOp('>', a, lit(20));
			const expr = orNode(branch1, branch2);
			const result = extractConstraints(expr, [TABLE_A]);
			// Branch 1 constraints target different columns → tryCollapseToOrRange rejects
			// allEqOrIn check also fails (branch1 has 2 constraints on different columns)
			// Falls to residual
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.exist;
		});
	});

	// ===================================================================
	// Residual: exact undefined when 0 residuals (not just falsy)
	// Kills L120 ConditionalExpression: true
	// ===================================================================
	describe('residualPredicate — strict undefined', () => {
		it('0 residuals → residualPredicate is strictly undefined', () => {
			const col = colRef(101, 'a', 1);
			const expr = binOp('=', col, lit(5));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.residualPredicate).to.equal(undefined);
		});

		it('all extractable AND → residualPredicate is strictly undefined', () => {
			const col = colRef(101, 'a', 1);
			const expr = andNode(binOp('=', col, lit(1)), binOp('>', col, lit(0)));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.residualPredicate).to.equal(undefined);
		});
	});

	// ===================================================================
	// createResidualFilter — exact return values
	// Kills L1194 mutants
	// ===================================================================
	describe('createResidualFilter — return value precision', () => {
		it('empty handledConstraints → returns exactly undefined', () => {
			const expr = binOp('=', colRef(101, 'a', 1), lit(5));
			const result = createResidualFilter(expr, []);
			expect(result).to.equal(undefined);
		});

		it('non-empty handledConstraints → returns exactly undefined (stub)', () => {
			const expr = binOp('=', colRef(101, 'a', 1), lit(5));
			const constraint: PredicateConstraint = {
				columnIndex: 1, attributeId: 101, op: '=', value: 5,
				usable: true, sourceExpression: expr, targetRelation: 't',
			};
			const result = createResidualFilter(expr, [constraint]);
			expect(result).to.equal(undefined);
		});

		it('handledConstraints.length === 0 vs > 0 produce same result (stub)', () => {
			const expr = binOp('=', colRef(101, 'a', 1), lit(5));
			const constraint: PredicateConstraint = {
				columnIndex: 1, attributeId: 101, op: '=', value: 5,
				usable: true, sourceExpression: expr, targetRelation: 't',
			};
			const resultEmpty = createResidualFilter(expr, []);
			const resultFull = createResidualFilter(expr, [constraint]);
			expect(resultEmpty).to.equal(undefined);
			expect(resultFull).to.equal(undefined);
		});
	});

	// ===================================================================
	// L600, L607, L616: OR→IN collapse — allEqOrIn and sameColumn checks
	// ===================================================================
	describe('OR → IN collapse — detailed condition checks', () => {
		it('OR of equality + range on same col → NOT IN (goes to OR_RANGE)', () => {
			const col = colRef(101, 'a', 1);
			// Branch 1: a=5 (equality)
			// Branch 2: a>10 (range, not equality/IN)
			// allEqOrIn check fails for branch2
			const expr = orNode(binOp('=', col, lit(5)), binOp('>', col, lit(10)));
			const result = extractConstraints(expr, [TABLE_A]);
			expect(result.allConstraints).to.have.length(1);
			// Should be OR_RANGE, not IN
			expect(result.allConstraints[0].op).to.not.equal('IN');
			expect(result.allConstraints[0].op).to.equal('OR_RANGE');
		});

		it('OR of equality on DIFFERENT columns → no IN collapse', () => {
			const a = colRef(101, 'a', 1);
			const b = colRef(102, 'b', 2);
			// Same table, different columns → allEqOrIn=true, sameColumn=false
			const expr = orNode(binOp('=', a, lit(1)), binOp('=', b, lit(2)));
			const result = extractConstraints(expr, [TABLE_A]);
			// Same table but different columns → tryCollapseToOrRange also fails (different cols)
			// → residual
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.exist;
		});
	});

	// ===================================================================
	// OR_RANGE — targetColumnIndex/targetAttributeId consistency
	// Kills L710 mutants (targetColumnIndex !== firstCol || ...)
	// ===================================================================
	describe('OR_RANGE — cross-branch column consistency', () => {
		it('branches with different columns → not OR_RANGE', () => {
			const a = colRef(101, 'a', 1);
			const b = colRef(102, 'b', 2);
			// Branch 1: a>5, Branch 2: b<10 — different columns
			const expr = orNode(binOp('>', a, lit(5)), binOp('<', b, lit(10)));
			const result = extractConstraints(expr, [TABLE_A]);
			// Different columns → tryCollapseToOrRange returns null
			// allEqOrIn fails (not equality/IN)
			// → residual
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.exist;
		});
	});

	// ===================================================================
	// OR_RANGE — branch with no bounds (e.g., LIKE) → reject
	// Kills L733 ConditionalExpression: false
	// ===================================================================
	describe('OR_RANGE — non-range op in branch', () => {
		it('LIKE ops in both OR branches → not OR_RANGE, residual', () => {
			const col = colRef(101, 'a', 1);
			const expr = orNode(binOp('LIKE', col, lit('%a')), binOp('LIKE', col, lit('%b')));
			const result = extractConstraints(expr, [TABLE_A]);
			// LIKE is not a range operator → tryCollapseToOrRange returns null at L727
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.exist;
		});
	});

	// ===================================================================
	// L323, L327, L330: extractBinaryConstraint — pattern matching branches
	// ===================================================================
	describe('extractBinaryConstraint — pattern matching precision', () => {
		it('col op non-col-non-lit → residual (not matched by any branch)', () => {
			const col = colRef(101, 'a', 1);
			// RHS is a complex expression (BinaryOp), not literal, not column, not param
			const complexRhs = binOp('+', lit(1), lit(2));
			const expr = binOp('=', col, complexRhs);
			const result = extractConstraints(expr, [TABLE_A]);
			// BinaryOp(+) fails isLiteralConstant and isDynamicValue → no match
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.exist;
		});

		it('non-col-non-lit op col → residual', () => {
			const col = colRef(101, 'a', 1);
			const complexLhs = binOp('+', lit(1), lit(2));
			const expr = binOp('=', complexLhs, col);
			const result = extractConstraints(expr, [TABLE_A]);
			// LHS is BinaryOp(+), not literal, not dynamic → no match
			expect(result.allConstraints).to.have.length(0);
			expect(result.residualPredicate).to.exist;
		});
	});

	// ===================================================================
	// L368: nonLiteral detection — LHS literal, RHS non-literal and vice versa
	// Kills LogicalOperator: !isLiteralConstant(lhs) && !isLiteralConstant(rhs)
	// and BooleanLiteral: isLiteralConstant(lhs)/isLiteralConstant(rhs)
	// ===================================================================
	describe('binding detection — nonLiteral flag precision', () => {
		it('col(left) = param(right) → nonLiteral true (rhs not literal)', () => {
			const col = colRef(101, 'a', 1);
			const param = paramRef(':p');
			const expr = binOp('=', col, param);
			const result = extractConstraints(expr, [TABLE_A]);
			const c = result.allConstraints[0];
			// nonLiteral = !isLiteral(col) || !isLiteral(param) = true || true = true
			// valueSide = rhs = param (not literal) → enters dynamic path
			expect(c.bindingKind).to.equal('parameter');
			expect(c.valueExpr).to.exist;
		});

		it('param(left) = col(right) → nonLiteral true, flip applied', () => {
			const col = colRef(101, 'a', 1);
			const param = paramRef(':p');
			const expr = binOp('<', param, col);
			const result = extractConstraints(expr, [TABLE_A]);
			const c = result.allConstraints[0];
			// columnIsLeft = false (column is right) → valueSide = lhs = param
			expect(c.op).to.equal('>'); // flipped
			expect(c.bindingKind).to.equal('parameter');
			expect(c.valueExpr).to.exist;
		});

		it('col(left) = no-op cast(lit)(right) → nonLiteral true but valueSide is literal', () => {
			const col = colRef(101, 'a', 1);
			const expr = binOp('=', col, castNode(lit(42), 'REAL'));
			const result = extractConstraints(expr, [TABLE_A]);
			const c = result.allConstraints[0];
			// nonLiteral = !isLiteral(col) || !isLiteral(cast(lit)) = true || false = true
			// valueSide = rhs = cast(lit), isLiteralConstant(cast(lit)) = true (the
			// no-op cast unwraps) → enters the "literal" branch inside nonLiteral block
			expect(c.bindingKind).to.equal('literal');
			expect(c.valueExpr).to.be.undefined;
		});
	});

	// ===================================================================
	// OR_RANGE — equality branch creates lower AND upper with same value
	// Directly test that both bounds exist (kills BlockStatement mutants)
	// ===================================================================
	describe('OR_RANGE — equality branch bounds', () => {
		it('equality in OR_RANGE creates both lower AND upper bounds', () => {
			const col = colRef(101, 'a', 1);
			const expr = orNode(binOp('=', col, lit(42)), binOp('>', col, lit(100)));
			const result = extractConstraints(expr, [TABLE_A]);
			const ranges = result.allConstraints[0].ranges!;
			const eqRange = ranges.find(r => r.lower && r.upper && r.lower.value === r.upper.value)!;
			expect(eqRange).to.exist;
			expect(eqRange.lower!.op).to.equal('>=');
			expect(eqRange.upper!.op).to.equal('<=');
			expect(eqRange.lower!.value).to.equal(42);
			expect(eqRange.upper!.value).to.equal(42);
		});
	});
});
