/**
 * Unit tests for the lens access-shape form matcher
 * (`planner/rules/access/lens-access-form-matcher.ts`, ticket
 * `lens-access-shape-path-selection` D1/D5). Exercised in isolation — no plan, no
 * optimizer — over hand-built predicates and a minimal {@link RoutableAuxiliary}.
 */

import { expect } from 'chai';
import { EmptyScope } from '../src/planner/scopes/empty.js';
import { ColumnReferenceNode, ParameterReferenceNode } from '../src/planner/nodes/reference.js';
import { BinaryOpNode, LiteralNode } from '../src/planner/nodes/scalar.js';
import { ScalarFunctionCallNode } from '../src/planner/nodes/function.js';
import { FunctionFlags } from '../src/common/constants.js';
import { INTEGER_TYPE } from '../src/types/builtin-types.js';
import type { ScalarType } from '../src/common/datatype.js';
import type { ScalarFunctionSchema } from '../src/schema/function.js';
import type * as AST from '../src/parser/ast.js';
import type { ScalarPlanNode } from '../src/planner/nodes/plan-node.js';
import type { RoutableAuxiliary } from '../src/planner/nodes/lens-auxiliary-access-node.js';
import { matchAccessForms, registerAccessFormRecognizer, functionNameRecognizer } from '../src/planner/rules/access/lens-access-form-matcher.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const scope = EmptyScope.instance as unknown as any;
const intType: ScalarType = { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: true, isReadOnly: false };

const COORD_ATTR = 1;     // the advertised access column's logical attr id
const OTHER_ATTR = 2;     // a non-advertised column

function colRef(attrId: number, name: string, index = 0): ColumnReferenceNode {
	const ast = { type: 'column', name } as AST.ColumnExpr;
	return new ColumnReferenceNode(scope, ast, intType, attrId, index);
}

function lit(value: number): LiteralNode {
	return new LiteralNode(scope, { type: 'literal', value } as AST.LiteralExpr);
}

function param(name: string): ParameterReferenceNode {
	return new ParameterReferenceNode(scope, { type: 'parameter', name } as AST.ParameterExpr, name, intType);
}

function binOp(op: string, left: ScalarPlanNode, right: ScalarPlanNode): BinaryOpNode {
	const ast = { type: 'binary', operator: op, left: (left as { expression: AST.Expression }).expression, right: (right as { expression: AST.Expression }).expression } as AST.BinaryExpr;
	return new BinaryOpNode(scope, ast, left, right);
}

function fnCall(name: string, operands: ScalarPlanNode[]): ScalarFunctionCallNode {
	const schema: ScalarFunctionSchema = {
		name, numArgs: operands.length, flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC,
		returnType: intType,
		implementation: () => null,
	};
	const ast = { type: 'function', name, args: operands.map(o => (o as { expression: AST.Expression }).expression) } as AST.FunctionExpr;
	return new ScalarFunctionCallNode(scope, ast, schema, operands);
}

/** A routable auxiliary serving the given forms over logical column `coord`. */
function routable(forms: string[]): RoutableAuxiliary {
	return {
		advertisement: { id: 'Spatial_nd', logicalTable: 'Spatial', role: 'auxiliary-access' },
		// auxScan / joinPairs are unused by the matcher (consumed by the rule).
		auxScan: undefined as unknown as RoutableAuxiliary['auxScan'],
		joinPairs: [],
		accessColumns: [{ logicalColumn: 'coord', logicalAttrId: COORD_ATTR, auxRef: { attrId: 101, columnIndex: 1, type: intType } }],
		served: [{ columns: ['coord'], forms }],
	};
}

describe('lens access-shape form matcher', () => {
	before(() => {
		// The fixture recognizer the engine ships only knows the built-in form names;
		// register the nd_contains → contains association the fixture relies on.
		registerAccessFormRecognizer('contains', functionNameRecognizer('nd_contains'));
	});

	it('matches nd_contains(coord, ?) against the contains recognizer', () => {
		const pred = fnCall('nd_contains', [colRef(COORD_ATTR, 'coord'), param(':pt')]);
		const matches = matchAccessForms(pred, [routable(['contains', 'knn'])]);
		const contains = matches.filter(m => m.form === 'contains');
		expect(contains).to.have.lengthOf(1);
		expect(contains[0].kind).to.equal('function-predicate');
		expect(contains[0].accessColumn.logicalColumn).to.equal('coord');
		expect(contains[0].predicateFragment).to.equal(pred);
	});

	it('an advertised form with no recognizer returns no match (degrade)', () => {
		const pred = fnCall('nd_contains', [colRef(COORD_ATTR, 'coord'), param(':pt')]);
		const matches = matchAccessForms(pred, [routable(['vector-cosine'])]);
		expect(matches).to.have.lengthOf(0);
	});

	it('nd_contains over a non-advertised column returns no match', () => {
		const pred = fnCall('nd_contains', [colRef(OTHER_ATTR, 'other'), param(':pt')]);
		const matches = matchAccessForms(pred, [routable(['contains'])]);
		expect(matches).to.have.lengthOf(0);
	});

	it('matches equality (coord = ?) against the equality comparison form', () => {
		const pred = binOp('=', colRef(COORD_ATTR, 'coord'), lit(5));
		const matches = matchAccessForms(pred, [routable(['equality'])]);
		expect(matches).to.have.lengthOf(1);
		expect(matches[0].form).to.equal('equality');
		expect(matches[0].kind).to.equal('comparison');
	});

	it('matches range (coord > ?) against the range comparison form', () => {
		const pred = binOp('>', colRef(COORD_ATTR, 'coord'), lit(5));
		const matches = matchAccessForms(pred, [routable(['range'])]);
		expect(matches).to.have.lengthOf(1);
		expect(matches[0].form).to.equal('range');
		expect(matches[0].kind).to.equal('comparison');
	});

	it('equality predicate does not match a contains-only auxiliary (discrimination)', () => {
		const pred = binOp('=', colRef(COORD_ATTR, 'coord'), lit(5));
		const matches = matchAccessForms(pred, [routable(['contains', 'knn', 'intersects'])]);
		expect(matches).to.have.lengthOf(0);
	});

	it('finds the matching conjunct inside an AND predicate', () => {
		const fragment = fnCall('nd_contains', [colRef(COORD_ATTR, 'coord'), param(':pt')]);
		const pred = binOp('AND', binOp('>', colRef(OTHER_ATTR, 'other'), lit(0)), fragment);
		const matches = matchAccessForms(pred, [routable(['contains'])]);
		expect(matches).to.have.lengthOf(1);
		expect(matches[0].predicateFragment).to.equal(fragment);
	});
});
