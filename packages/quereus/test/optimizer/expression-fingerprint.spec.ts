import { expect } from 'chai';
import { EmptyScope } from '../../src/planner/scopes/empty.js';
import { fingerprintExpression } from '../../src/planner/analysis/expression-fingerprint.js';
import { BinaryOpNode, LiteralNode, UnaryOpNode, CaseExprNode, CastNode, CollateNode, BetweenNode } from '../../src/planner/nodes/scalar.js';
import { ColumnReferenceNode, ParameterReferenceNode } from '../../src/planner/nodes/reference.js';
import { ScalarFunctionCallNode } from '../../src/planner/nodes/function.js';
import { AggregateFunctionCallNode } from '../../src/planner/nodes/aggregate-function.js';
import type { ScalarPlanNode } from '../../src/planner/nodes/plan-node.js';
import type * as AST from '../../src/parser/ast.js';
import type { ScalarFunctionSchema, AggregateFunctionSchema } from '../../src/schema/function.js';
import { TEXT_TYPE, INTEGER_TYPE } from '../../src/types/builtin-types.js';
import { FunctionFlags } from '../../src/common/constants.js';
import type { ScalarType } from '../../src/common/datatype.js';
import { WindowFunctionCallNode } from '../../src/planner/nodes/window-function.js';

const scope = EmptyScope.instance;

const textType: ScalarType = { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: false };
const intType: ScalarType = { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: false };

function colRef(attrId: number, name = 'c', index = 0): ColumnReferenceNode {
	const expr = { type: 'column', schema: undefined, table: undefined, name } as unknown as AST.ColumnExpr;
	return new ColumnReferenceNode(scope, expr, textType, attrId, index);
}

function lit(value: unknown): LiteralNode {
	return new LiteralNode(scope, { type: 'literal', value } as unknown as AST.LiteralExpr);
}

function binOp(op: string, left: ScalarPlanNode, right: ScalarPlanNode): BinaryOpNode {
	const ast = { type: 'binary', operator: op, left: left.expression, right: right.expression } as AST.BinaryExpr;
	return new BinaryOpNode(scope, ast, left, right);
}

function unaryOp(op: string, operand: ScalarPlanNode): UnaryOpNode {
	const ast = { type: 'unary', operator: op, operand: operand.expression } as unknown as AST.UnaryExpr;
	return new UnaryOpNode(scope, ast, operand);
}

function makeFunctionSchema(name: string, deterministic: boolean): ScalarFunctionSchema {
	return {
		name,
		numArgs: -1,
		flags: FunctionFlags.UTF8 | (deterministic ? FunctionFlags.DETERMINISTIC : 0),
		returnType: textType,
		implementation: () => null,
	};
}

function fnCall(name: string, args: ScalarPlanNode[], deterministic = true): ScalarFunctionCallNode {
	const expr = { type: 'function', name, args: args.map(a => a.expression) } as unknown as AST.FunctionExpr;
	return new ScalarFunctionCallNode(scope, expr, makeFunctionSchema(name, deterministic), args);
}

function aggCall(name: string, args: ScalarPlanNode[], distinct = false): AggregateFunctionCallNode {
	const expr = { type: 'function', name, args: args.map(a => a.expression) } as unknown as AST.FunctionExpr;
	const schema: AggregateFunctionSchema = {
		name,
		numArgs: args.length,
		flags: FunctionFlags.DETERMINISTIC,
		returnType: intType,
		stepFunction: () => null,
		finalizeFunction: () => null,
	};
	return new AggregateFunctionCallNode(scope, expr, name, schema, args, distinct);
}

describe('Expression fingerprinting', () => {

	describe('Literal fingerprints', () => {
		it('integer (bigint) literal', () => {
			expect(fingerprintExpression(lit(5n))).to.equal('LI:5n');
		});

		it('real (number) literal', () => {
			expect(fingerprintExpression(lit(3.14))).to.equal('LI:3.14f');
		});

		it('text literal', () => {
			expect(fingerprintExpression(lit('hello'))).to.equal("LI:'hello'");
		});

		it('null literal', () => {
			expect(fingerprintExpression(lit(null))).to.equal('LI:null');
		});

		it('boolean literal', () => {
			expect(fingerprintExpression(lit(true))).to.equal('LI:true');
		});

		it('blob literal', () => {
			const blob = new Uint8Array([0xde, 0xad]);
			expect(fingerprintExpression(lit(blob))).to.equal('LI:xdead');
		});

		it('distinguishes integer from real', () => {
			expect(fingerprintExpression(lit(5n))).to.not.equal(fingerprintExpression(lit(5)));
		});
	});

	describe('Column reference fingerprints', () => {
		it('fingerprints by attribute ID, not name', () => {
			const a = colRef(42, 'foo');
			const b = colRef(42, 'bar');
			expect(fingerprintExpression(a)).to.equal(fingerprintExpression(b));
		});

		it('different attribute IDs produce different fingerprints', () => {
			expect(fingerprintExpression(colRef(1))).to.not.equal(fingerprintExpression(colRef(2)));
		});
	});

	describe('Parameter reference fingerprints', () => {
		it('named parameter', () => {
			const expr = { type: 'parameter', name: ':foo' } as unknown as AST.ParameterExpr;
			const node = new ParameterReferenceNode(scope, expr, ':foo', textType);
			expect(fingerprintExpression(node)).to.equal('PR::foo');
		});

		it('indexed parameter', () => {
			const expr = { type: 'parameter', name: '1' } as unknown as AST.ParameterExpr;
			const node = new ParameterReferenceNode(scope, expr, 1, textType);
			expect(fingerprintExpression(node)).to.equal('PR:1');
		});
	});

	describe('Unary operator fingerprints', () => {
		it('NOT operator', () => {
			const fp = fingerprintExpression(unaryOp('NOT', lit(true)));
			expect(fp).to.equal('UO:NOT(LI:true)');
		});

		it('negation operator', () => {
			const fp = fingerprintExpression(unaryOp('-', lit(5n)));
			expect(fp).to.equal('UO:-(LI:5n)');
		});
	});

	describe('Binary operator fingerprints', () => {
		it('basic binary op', () => {
			const fp = fingerprintExpression(binOp('>', fnCall('length', [colRef(42)]), lit(5n)));
			expect(fp).to.equal('BO:>(FN:length(CR:42),LI:5n)');
		});

		it('same structure produces same fingerprint', () => {
			const a = binOp('+', colRef(1), lit(2n));
			const b = binOp('+', colRef(1), lit(2n));
			expect(fingerprintExpression(a)).to.equal(fingerprintExpression(b));
		});

		it('different operators produce different fingerprints', () => {
			const a = binOp('+', colRef(1), lit(2n));
			const b = binOp('-', colRef(1), lit(2n));
			expect(fingerprintExpression(a)).to.not.equal(fingerprintExpression(b));
		});
	});

	describe('Commutativity', () => {
		it('a + b equals b + a', () => {
			const ab = binOp('+', colRef(1), colRef(2));
			const ba = binOp('+', colRef(2), colRef(1));
			expect(fingerprintExpression(ab)).to.equal(fingerprintExpression(ba));
		});

		it('a * b equals b * a', () => {
			const ab = binOp('*', colRef(1), lit(3n));
			const ba = binOp('*', lit(3n), colRef(1));
			expect(fingerprintExpression(ab)).to.equal(fingerprintExpression(ba));
		});

		it('a = b equals b = a', () => {
			const ab = binOp('=', colRef(1), lit(5n));
			const ba = binOp('=', lit(5n), colRef(1));
			expect(fingerprintExpression(ab)).to.equal(fingerprintExpression(ba));
		});

		it('a - b does NOT equal b - a', () => {
			const ab = binOp('-', colRef(1), colRef(2));
			const ba = binOp('-', colRef(2), colRef(1));
			expect(fingerprintExpression(ab)).to.not.equal(fingerprintExpression(ba));
		});

		it('a > b does NOT equal b > a', () => {
			const ab = binOp('>', colRef(1), colRef(2));
			const ba = binOp('>', colRef(2), colRef(1));
			expect(fingerprintExpression(ab)).to.not.equal(fingerprintExpression(ba));
		});
	});

	describe('Function call fingerprints', () => {
		it('scalar function', () => {
			const fp = fingerprintExpression(fnCall('length', [colRef(42)]));
			expect(fp).to.equal('FN:length(CR:42)');
		});

		it('same function same args produces same fingerprint', () => {
			const a = fnCall('upper', [colRef(10)]);
			const b = fnCall('upper', [colRef(10)]);
			expect(fingerprintExpression(a)).to.equal(fingerprintExpression(b));
		});

		it('different function names produce different fingerprints', () => {
			const a = fnCall('upper', [colRef(10)]);
			const b = fnCall('lower', [colRef(10)]);
			expect(fingerprintExpression(a)).to.not.equal(fingerprintExpression(b));
		});
	});

	describe('Aggregate function fingerprints', () => {
		it('basic aggregate', () => {
			const fp = fingerprintExpression(aggCall('count', [colRef(1)]));
			expect(fp).to.equal('AG:count(CR:1)');
		});

		it('distinct aggregate differs from non-distinct', () => {
			const a = aggCall('count', [colRef(1)], false);
			const b = aggCall('count', [colRef(1)], true);
			expect(fingerprintExpression(a)).to.not.equal(fingerprintExpression(b));
		});
	});

	describe('CASE expression fingerprints', () => {
		it('simple CASE', () => {
			const caseNode = new CaseExprNode(
				scope,
				{ type: 'case' } as unknown as AST.CaseExpr,
				undefined,
				[{ when: binOp('=', colRef(1), lit(1n)), then: lit('a') }],
				lit('z')
			);
			const fp = fingerprintExpression(caseNode);
			expect(fp).to.contain('CE(');
			expect(fp).to.contain('W:');
			expect(fp).to.contain('T:');
			expect(fp).to.contain('E:');
		});
	});

	describe('CAST fingerprints', () => {
		it('CAST to TEXT', () => {
			const castNode = new CastNode(
				scope,
				{ type: 'cast', targetType: 'TEXT', operand: null } as unknown as AST.CastExpr,
				colRef(7)
			);
			expect(fingerprintExpression(castNode)).to.equal('CA:TEXT(CR:7)');
		});
	});

	describe('COLLATE fingerprints', () => {
		it('COLLATE NOCASE', () => {
			const collateNode = new CollateNode(
				scope,
				{ type: 'collate', collation: 'NOCASE' } as unknown as AST.CollateExpr,
				colRef(3)
			);
			expect(fingerprintExpression(collateNode)).to.equal('CO:NOCASE(CR:3)');
		});
	});

	describe('BETWEEN fingerprints', () => {
		it('BETWEEN', () => {
			const bw = new BetweenNode(
				scope,
				{ type: 'between', not: false } as unknown as AST.BetweenExpr,
				colRef(5), lit(1n), lit(10n)
			);
			expect(fingerprintExpression(bw)).to.equal('BW:(CR:5,LI:1n,LI:10n)');
		});

		it('NOT BETWEEN differs from BETWEEN', () => {
			const bw = new BetweenNode(
				scope,
				{ type: 'between', not: false } as unknown as AST.BetweenExpr,
				colRef(5), lit(1n), lit(10n)
			);
			const nbw = new BetweenNode(
				scope,
				{ type: 'between', not: true } as unknown as AST.BetweenExpr,
				colRef(5), lit(1n), lit(10n)
			);
			expect(fingerprintExpression(bw)).to.not.equal(fingerprintExpression(nbw));
		});
	});

	describe('Non-deterministic guard', () => {
		it('non-deterministic function produces unique fingerprint', () => {
			const a = fnCall('random', [], false);
			const b = fnCall('random', [], false);
			const fpA = fingerprintExpression(a);
			const fpB = fingerprintExpression(b);
			expect(fpA).to.not.equal(fpB);
			expect(fpA).to.match(/^_ND:/);
		});
	});

	describe('Nested expressions', () => {
		it('nested expression fingerprints recursively', () => {
			// length(name) > 5
			const expr = binOp('>', fnCall('length', [colRef(42)]), lit(5n));
			expect(fingerprintExpression(expr)).to.equal('BO:>(FN:length(CR:42),LI:5n)');
		});

		it('deeply nested expressions produce consistent fingerprints', () => {
			// (a + b) * (c - d)
			const add = binOp('+', colRef(1), colRef(2));
			const sub = binOp('-', colRef(3), colRef(4));
			const mul = binOp('*', add, sub);

			const add2 = binOp('+', colRef(1), colRef(2));
			const sub2 = binOp('-', colRef(3), colRef(4));
			const mul2 = binOp('*', add2, sub2);

			expect(fingerprintExpression(mul)).to.equal(fingerprintExpression(mul2));
		});
	});

	describe('Commutative operator ordering (mutation-killing)', () => {
		it('swap actually happens when rightFp < leftFp for commutative op', () => {
			// Construct so that right fingerprint is lexicographically less than left
			// CR:1 < CR:2 lexicographically, so binOp('+', colRef(2), colRef(1)) should swap
			const normal = binOp('+', colRef(1), colRef(2));
			const swapped = binOp('+', colRef(2), colRef(1));
			const fpNormal = fingerprintExpression(normal);
			const fpSwapped = fingerprintExpression(swapped);
			expect(fpNormal).to.equal(fpSwapped);
			// Both should have CR:1 before CR:2 after canonical ordering
			expect(fpNormal).to.equal('BO:+(CR:1,CR:2)');
		});

		it('does NOT swap when rightFp >= leftFp for commutative op', () => {
			// CR:1 < CR:2, so binOp('+', colRef(1), colRef(2)) should NOT swap
			const fp = fingerprintExpression(binOp('+', colRef(1), colRef(2)));
			expect(fp).to.equal('BO:+(CR:1,CR:2)');
		});

		it('does NOT swap operands for non-commutative operator', () => {
			// '-' is not commutative
			const fp = fingerprintExpression(binOp('-', colRef(2), colRef(1)));
			expect(fp).to.equal('BO:-(CR:2,CR:1)');
		});

		it('AND is commutative', () => {
			const a = binOp('AND', colRef(10), colRef(1));
			const b = binOp('AND', colRef(1), colRef(10));
			expect(fingerprintExpression(a)).to.equal(fingerprintExpression(b));
		});

		it('OR is commutative', () => {
			const a = binOp('OR', colRef(10), colRef(1));
			const b = binOp('OR', colRef(1), colRef(10));
			expect(fingerprintExpression(a)).to.equal(fingerprintExpression(b));
		});

		it('!= is commutative', () => {
			const a = binOp('!=', colRef(10), colRef(1));
			const b = binOp('!=', colRef(1), colRef(10));
			expect(fingerprintExpression(a)).to.equal(fingerprintExpression(b));
		});

		it('<> is commutative', () => {
			const a = binOp('<>', colRef(10), colRef(1));
			const b = binOp('<>', colRef(1), colRef(10));
			expect(fingerprintExpression(a)).to.equal(fingerprintExpression(b));
		});

		it('< is NOT commutative', () => {
			const a = binOp('<', colRef(1), colRef(2));
			const b = binOp('<', colRef(2), colRef(1));
			expect(fingerprintExpression(a)).to.not.equal(fingerprintExpression(b));
		});
	});

	describe('BETWEEN fingerprint NOT flag (mutation-killing)', () => {
		it('NOT BETWEEN produces ! in fingerprint', () => {
			const nbw = new BetweenNode(
				scope,
				{ type: 'between', not: true } as unknown as AST.BetweenExpr,
				colRef(5), lit(1n), lit(10n)
			);
			expect(fingerprintExpression(nbw)).to.equal('BW:!(CR:5,LI:1n,LI:10n)');
		});

		it('BETWEEN without NOT does not have ! prefix', () => {
			const bw = new BetweenNode(
				scope,
				{ type: 'between', not: false } as unknown as AST.BetweenExpr,
				colRef(5), lit(1n), lit(10n)
			);
			expect(fingerprintExpression(bw)).to.equal('BW:(CR:5,LI:1n,LI:10n)');
			expect(fingerprintExpression(bw)).to.not.contain('!');
		});
	});

	describe('Window function fingerprint (mutation-killing)', () => {
		it('includes function name in fingerprint', () => {
			const wf = new WindowFunctionCallNode(
				scope,
				{ type: 'windowFunction', function: { type: 'function', name: 'row_number', args: [] } } as unknown as AST.WindowFunctionExpr,
				'row_number',
				false,
			);
			const fp = fingerprintExpression(wf);
			expect(fp).to.match(/^WF:row_number:/);
		});

		it('includes isDistinct in fingerprint', () => {
			const wfDistinct = new WindowFunctionCallNode(
				scope,
				{ type: 'windowFunction', function: { type: 'function', name: 'sum', args: [] } } as unknown as AST.WindowFunctionExpr,
				'sum',
				true,
			);
			const wfNonDistinct = new WindowFunctionCallNode(
				scope,
				{ type: 'windowFunction', function: { type: 'function', name: 'sum', args: [] } } as unknown as AST.WindowFunctionExpr,
				'sum',
				false,
			);
			const fpD = fingerprintExpression(wfDistinct);
			const fpND = fingerprintExpression(wfNonDistinct);
			expect(fpD).to.contain(':true:');
			expect(fpND).to.contain(':false:');
			// They differ because of isDistinct AND unique node ids
			expect(fpD).to.not.equal(fpND);
		});

		it('uses unique node id so two window functions are never equal', () => {
			const wf1 = new WindowFunctionCallNode(
				scope,
				{ type: 'windowFunction', function: { type: 'function', name: 'row_number', args: [] } } as unknown as AST.WindowFunctionExpr,
				'row_number',
				false,
			);
			const wf2 = new WindowFunctionCallNode(
				scope,
				{ type: 'windowFunction', function: { type: 'function', name: 'row_number', args: [] } } as unknown as AST.WindowFunctionExpr,
				'row_number',
				false,
			);
			expect(fingerprintExpression(wf1)).to.not.equal(fingerprintExpression(wf2));
		});
	});

	describe('Literal edge cases (mutation-killing)', () => {
		it('false boolean literal', () => {
			expect(fingerprintExpression(lit(false))).to.equal('LI:false');
		});

		it('distinguishes null from string "null"', () => {
			expect(fingerprintExpression(lit(null))).to.not.equal(fingerprintExpression(lit('null')));
		});

		it('distinguishes boolean true from string "true"', () => {
			expect(fingerprintExpression(lit(true))).to.not.equal(fingerprintExpression(lit('true')));
		});

		it('zero-length blob', () => {
			const blob = new Uint8Array([]);
			expect(fingerprintExpression(lit(blob))).to.equal('LI:x');
		});

		it('single-byte blob with leading zero', () => {
			const blob = new Uint8Array([0x0a]);
			expect(fingerprintExpression(lit(blob))).to.equal('LI:x0a');
		});

		it('bigint zero', () => {
			expect(fingerprintExpression(lit(0n))).to.equal('LI:0n');
		});

		it('negative number', () => {
			expect(fingerprintExpression(lit(-1.5))).to.equal('LI:-1.5f');
		});

		it('empty string', () => {
			expect(fingerprintExpression(lit(''))).to.equal("LI:''");
		});

		it('unknown literal type fallback', () => {
			// Passing a Symbol or similar type that matches none of the type checks
			const fp = fingerprintExpression(lit(Symbol('test')));
			expect(fp).to.match(/^LI:\?/);
		});

		// JSON documents are the only OBJECT-class literal, and const-folding turns
		// `json_col = '{"a":1}'` into one. `String(value)` renders every object as
		// '[object Object]', which made CSE fold two DIFFERENT comparisons into one and
		// silently drop a conjunct (`v = '{"a":1}' and v = '{"a":2}'` matched row 1).
		describe('object (JSON) literals', () => {
			it('structurally distinct documents fingerprint differently', () => {
				expect(fingerprintExpression(lit({ a: 1 })))
					.to.not.equal(fingerprintExpression(lit({ a: 2 })));
				expect(fingerprintExpression(lit({ a: 1 })))
					.to.not.equal(fingerprintExpression(lit({ b: 1 })));
				expect(fingerprintExpression(lit([1, 2, 3])))
					.to.not.equal(fingerprintExpression(lit([3, 2, 1])));
			});

			it('reorder-equal objects share a fingerprint (they are the same value)', () => {
				expect(fingerprintExpression(lit({ a: 1, b: 2 })))
					.to.equal(fingerprintExpression(lit({ b: 2, a: 1 })));
			});

			it('an object never collides with a same-looking string literal', () => {
				expect(fingerprintExpression(lit({ a: 1 })))
					.to.not.equal(fingerprintExpression(lit('{"a":1}')));
			});

			it('a non-serializable object falls back to a per-node fingerprint', () => {
				const cyclic: Record<string, unknown> = {};
				cyclic.self = cyclic;
				const a = lit(cyclic);
				const b = lit(cyclic);
				expect(fingerprintExpression(a)).to.match(/^LI:\?/);
				expect(fingerprintExpression(a)).to.not.equal(fingerprintExpression(b));
			});
		});

		// Constant folding is a synchronous pass, but the value it folds may be async, so
		// an uncorrelated constant scalar subquery — `(select 1)` — becomes a LiteralNode
		// whose `expression.value` is a still-pending Promise that only the emitter awaits.
		// Fingerprinting such a literal BY VALUE dropped every one of them into the
		// JSON-document branch, where they all canonicalized to `LI:j{}`; CSE then collapsed
		// `x + (select 1)` and `x + (select 2)` into one computation
		// (bug-constant-subquery-literals-collide-in-cse).
		//
		// The property below is the general statement of the class: a literal with no
		// plan-time value is fingerprinted per node, so no two of them ever collide —
		// with each other, or with any literal that DOES have a plan-time value.
		describe('pending-Promise literals (folded async constants)', () => {
			it('two literals holding distinct pending Promises never share a fingerprint', () => {
				const nodes = [1, 2, 3, 'x', null, { a: 1 }].map(v => lit(Promise.resolve(v)));
				const fps = nodes.map(fingerprintExpression);
				expect(new Set(fps).size).to.equal(nodes.length);
				for (const fp of fps) expect(fp).to.match(/^LI:\?/);
			});

			it('two literals holding the SAME pending Promise still fingerprint distinctly', () => {
				// Conservative on purpose: the value is unknown at plan time, so sharing is
				// never provable from the fingerprint alone.
				const shared = Promise.resolve(1);
				expect(fingerprintExpression(lit(shared)))
					.to.not.equal(fingerprintExpression(lit(shared)));
			});

			it('a pending-Promise literal never collides with a JSON-object literal', () => {
				const promiseFp = fingerprintExpression(lit(Promise.resolve(1)));
				for (const doc of [{}, { a: 1 }, [] as unknown[], [1, 2]]) {
					expect(promiseFp).to.not.equal(fingerprintExpression(lit(doc)));
				}
			});

			it('a pending-Promise literal never collides with an ordinary scalar literal', () => {
				const promiseFp = fingerprintExpression(lit(Promise.resolve(1)));
				for (const v of [1, 1n, 'a', true, null, new Uint8Array([1])]) {
					expect(promiseFp).to.not.equal(fingerprintExpression(lit(v)));
				}
			});

			it('enclosing expressions built over distinct pending Promises stay distinct', () => {
				const a = binOp('+', colRef(1), lit(Promise.resolve(1)));
				const b = binOp('+', colRef(1), lit(Promise.resolve(2)));
				expect(fingerprintExpression(a)).to.not.equal(fingerprintExpression(b));
			});

			// The same invariant on the trailing arm: a host value matching none of the
			// SqlValue shapes above (unreachable for a well-typed value, but one bad cast
			// away) must stay node-unique rather than render itself into the fingerprint.
			it('a literal holding an unrecognized host value is node-unique, not value-keyed', () => {
				const fps = [Symbol('s'), Symbol('s'), () => 1, () => 1].map(v => fingerprintExpression(lit(v)));
				expect(new Set(fps).size).to.equal(fps.length);
				for (const fp of fps) expect(fp).to.match(/^LI:\?/);
			});
		});
	});

	describe('Aggregate function fingerprint (mutation-killing)', () => {
		it('distinct aggregate includes D tag', () => {
			const fp = fingerprintExpression(aggCall('sum', [colRef(1)], true));
			expect(fp).to.equal('AG:sumD(CR:1)');
		});

		it('non-distinct aggregate does not include D tag', () => {
			const fp = fingerprintExpression(aggCall('sum', [colRef(1)], false));
			expect(fp).to.equal('AG:sum(CR:1)');
		});

		it('multi-arg aggregate', () => {
			const fp = fingerprintExpression(aggCall('group_concat', [colRef(1), colRef(2)], false));
			expect(fp).to.equal('AG:group_concat(CR:1,CR:2)');
		});
	});

	describe('Scalar function call fingerprint (mutation-killing)', () => {
		it('zero-arg function', () => {
			const fp = fingerprintExpression(fnCall('now', []));
			expect(fp).to.equal('FN:now()');
		});

		it('multi-arg function', () => {
			const fp = fingerprintExpression(fnCall('substr', [colRef(1), lit(2n), lit(5n)]));
			expect(fp).to.equal('FN:substr(CR:1,LI:2n,LI:5n)');
		});
	});

	describe('CASE expression fingerprint details (mutation-killing)', () => {
		it('CASE with base expression', () => {
			const caseNode = new CaseExprNode(
				scope,
				{ type: 'case' } as unknown as AST.CaseExpr,
				colRef(1), // base expression present
				[{ when: lit(1n), then: lit('one') }],
				undefined
			);
			const fp = fingerprintExpression(caseNode);
			// base expression fingerprint should appear first
			expect(fp).to.equal('CE(CR:1,W:LI:1n,T:LI:\'one\')');
		});

		it('CASE without base expression', () => {
			const caseNode = new CaseExprNode(
				scope,
				{ type: 'case' } as unknown as AST.CaseExpr,
				undefined, // no base expression
				[{ when: binOp('>', colRef(1), lit(0n)), then: lit('positive') }],
				undefined
			);
			const fp = fingerprintExpression(caseNode);
			// Should NOT include a base expression fingerprint
			expect(fp).to.not.contain('CR:1,W:');
			expect(fp).to.contain('W:');
			expect(fp).to.contain('T:');
		});

		it('CASE without else', () => {
			const caseNode = new CaseExprNode(
				scope,
				{ type: 'case' } as unknown as AST.CaseExpr,
				undefined,
				[{ when: lit(true), then: lit('yes') }],
				undefined // no else
			);
			const fp = fingerprintExpression(caseNode);
			expect(fp).to.not.contain('E:');
		});

		it('CASE with else', () => {
			const caseNode = new CaseExprNode(
				scope,
				{ type: 'case' } as unknown as AST.CaseExpr,
				undefined,
				[{ when: lit(true), then: lit('yes') }],
				lit('no')
			);
			const fp = fingerprintExpression(caseNode);
			expect(fp).to.contain("E:LI:'no'");
		});

		it('CASE with multiple when/then clauses', () => {
			const caseNode = new CaseExprNode(
				scope,
				{ type: 'case' } as unknown as AST.CaseExpr,
				undefined,
				[
					{ when: lit(1n), then: lit('one') },
					{ when: lit(2n), then: lit('two') },
				],
				lit('other')
			);
			const fp = fingerprintExpression(caseNode);
			expect(fp).to.contain("W:LI:1n");
			expect(fp).to.contain("T:LI:'one'");
			expect(fp).to.contain("W:LI:2n");
			expect(fp).to.contain("T:LI:'two'");
			expect(fp).to.contain("E:LI:'other'");
		});
	});

	describe('Non-deterministic guard (mutation-killing)', () => {
		it('non-deterministic node fingerprint starts with _ND:', () => {
			const nd = fnCall('random', [], false);
			const fp = fingerprintExpression(nd);
			expect(fp.startsWith('_ND:')).to.be.true;
		});

		it('non-deterministic node includes its unique id', () => {
			const nd = fnCall('random', [], false);
			const fp = fingerprintExpression(nd);
			expect(fp).to.equal(`_ND:${nd.id}`);
		});

		it('deterministic node does NOT start with _ND:', () => {
			const d = fnCall('length', [colRef(1)], true);
			const fp = fingerprintExpression(d);
			expect(fp.startsWith('_ND:')).to.be.false;
		});
	});

	describe('Subquery-bearing nodes (mutation-killing)', () => {
		// These are tested indirectly via integration, but we verify the format here
		// by checking that non-deterministic nodes produce unique id-based fingerprints.
		// Subquery nodes (ScalarSubquery, In, Exists) also produce unique fingerprints.
		// We can't easily construct those directly without a full plan, so we verify
		// the non-det guard pattern holds.
		it('two non-deterministic calls never share a fingerprint', () => {
			const fps = new Set<string>();
			for (let i = 0; i < 10; i++) {
				fps.add(fingerprintExpression(fnCall('random', [], false)));
			}
			expect(fps.size).to.equal(10);
		});
	});
});
