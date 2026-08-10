import { expect } from 'chai';
import { EmptyScope } from '../../src/planner/scopes/empty.js';
import { BinaryOpNode, LiteralNode } from '../../src/planner/nodes/scalar.js';
import { ColumnReferenceNode } from '../../src/planner/nodes/reference.js';
import { ScalarSubqueryNode } from '../../src/planner/nodes/subquery.js';
import { ValuesNode } from '../../src/planner/nodes/values-node.js';
import type { ScalarPlanNode } from '../../src/planner/nodes/plan-node.js';
import type * as AST from '../../src/parser/ast.js';
import type { ScalarType } from '../../src/common/datatype.js';
import { INTEGER_TYPE } from '../../src/types/builtin-types.js';
import { isEquiCorrelation, referencesAnyAttr, collectDefinedAttrIds } from '../../src/planner/analysis/equi-correlation.js';
import { collectScalarSubqueries, substituteSubqueries } from '../../src/planner/analysis/scalar-subqueries.js';

const scope = EmptyScope.instance;
const intType: ScalarType = { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true };

function colRef(attrId: number, name = `a${attrId}`): ColumnReferenceNode {
	return new ColumnReferenceNode(scope, { type: 'column', name }, intType, attrId, 0);
}

function lit(value: unknown): LiteralNode {
	return new LiteralNode(scope, { type: 'literal', value } as AST.LiteralExpr);
}

function binOp(op: string, left: ScalarPlanNode, right: ScalarPlanNode): BinaryOpNode {
	return new BinaryOpNode(
		scope,
		{ type: 'binary', operator: op, left: left.expression, right: right.expression },
		left,
		right,
	);
}

function subquery(): ScalarSubqueryNode {
	const body = new ValuesNode(scope, [[lit(1)]], ['x']);
	return new ScalarSubqueryNode(scope, { type: 'literal', value: 1 } as AST.Expression, body);
}

describe('analysis/equi-correlation', () => {
	const outer = new Set([1, 2]);
	const inner = new Set([10, 11]);

	it('recognizes outer.col = inner.col in either operand order', () => {
		expect(isEquiCorrelation(binOp('=', colRef(1), colRef(10)), outer, inner)).to.equal(true);
		expect(isEquiCorrelation(binOp('=', colRef(10), colRef(1)), outer, inner)).to.equal(true);
	});

	it('rejects non-equality, non-column, and same-side comparisons', () => {
		expect(isEquiCorrelation(binOp('<', colRef(1), colRef(10)), outer, inner)).to.equal(false);
		expect(isEquiCorrelation(binOp('=', colRef(1), lit(5)), outer, inner)).to.equal(false);
		expect(isEquiCorrelation(binOp('=', colRef(1), colRef(2)), outer, inner)).to.equal(false);
		expect(isEquiCorrelation(binOp('=', colRef(10), colRef(11)), outer, inner)).to.equal(false);
	});

	it('referencesAnyAttr finds nested references and ignores others', () => {
		const tree = binOp('AND', binOp('>', colRef(10), lit(1)), binOp('=', colRef(11), colRef(2)));
		expect(referencesAnyAttr(tree, new Set([2]))).to.equal(true);
		expect(referencesAnyAttr(tree, new Set([11]))).to.equal(true);
		expect(referencesAnyAttr(tree, new Set([99]))).to.equal(false);
	});

	it('collectDefinedAttrIds gathers relational attributes in a subtree', () => {
		const values = new ValuesNode(scope, [[lit(1), lit(2)]], ['x', 'y']);
		const ids = collectDefinedAttrIds(values);
		expect(ids.size).to.equal(2);
		for (const attr of values.getAttributes()) {
			expect(ids.has(attr.id)).to.equal(true);
		}
	});
});

describe('analysis/scalar-subqueries', () => {
	it('collects bare and wrapped subqueries without descending into bodies', () => {
		const bare = subquery();
		const wrapped = subquery();
		const expr = binOp('+', bare, binOp('*', wrapped, lit(2)));

		const out: ScalarSubqueryNode[] = [];
		collectScalarSubqueries(expr, out);
		expect(out).to.deep.equal([bare, wrapped]);

		const outBare: ScalarSubqueryNode[] = [];
		collectScalarSubqueries(bare, outBare);
		expect(outBare).to.deep.equal([bare]);
	});

	it('substitutes mapped subqueries, preserving wrappers and unmapped nodes', () => {
		const mapped = subquery();
		const unmapped = subquery();
		const expr = binOp('+', mapped, unmapped);
		const replacement = colRef(42);

		const result = substituteSubqueries(expr, new Map([[mapped, replacement]])) as BinaryOpNode;
		expect(result).to.not.equal(expr);
		expect(result.left).to.equal(replacement);
		expect(result.right).to.equal(unmapped);

		// Bare subquery at the root is replaced wholesale
		expect(substituteSubqueries(mapped, new Map([[mapped, replacement]]))).to.equal(replacement);
		// No mapped descendant → same instance returned
		expect(substituteSubqueries(expr, new Map())).to.equal(expr);
	});
});
