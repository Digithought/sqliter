/**
 * The two halves of a declared comparison group's cross-type coercion
 * (`bug-comparison-coercion-corrupts-returned-value`).
 *
 * `BaseFunctionSchema.comparesArgs` names the argument positions a function
 * compares as one group. How that group's coercion is applied depends on whether
 * the function hands one of those arguments back:
 *   - **without** `returnsArg` the group is rewritten at plan-build time, so the
 *     implementation receives already-converted arguments (`coerceComparisonGroup`,
 *     `planner/building/coercion.ts`). No builtin takes this path any more — it is
 *     kept for a comparison function that returns a FRESH value, and for
 *     third-party registrations — so this file is what keeps it honest;
 *   - **with** `returnsArg` the arguments are left alone and the emitter converts
 *     per-row copies instead (`makeComparisonGroup`,
 *     `runtime/emit/operand-comparator.ts`), because a plan-time cast would replace
 *     the returned value too.
 *
 * The end-to-end values are pinned by `test/logic/03.6.1-…sqllogic`; what is here
 * is the plan-level shape and the group-builder paths no builtin reaches.
 */

import { expect } from 'chai';
import { Database, createScalarFunction } from '../src/index.js';
import { Parser } from '../src/parser/parser.js';
import type * as AST from '../src/parser/ast.js';
import type { ScalarType } from '../src/common/datatype.js';
import type { LogicalType } from '../src/types/logical-type.js';
import { INTEGER_TYPE, NUMERIC_TYPE, TEXT_TYPE } from '../src/types/builtin-types.js';
import { PlanNode } from '../src/planner/nodes/plan-node.js';
import { CastNode } from '../src/planner/nodes/scalar.js';
import { ScalarFunctionCallNode } from '../src/planner/nodes/function.js';
import { makeComparisonGroup } from '../src/runtime/emit/operand-comparator.js';
import type { SqlValue } from '../src/common/types.js';

const scalarType = (logicalType: LogicalType): ScalarType =>
	({ typeClass: 'scalar', logicalType, nullable: true, isReadOnly: true });

describe('comparison group coercion', () => {
	describe('makeComparisonGroup', () => {
		it('converts the textual probe over an all-numeric group', () => {
			// The hoisted probe cast targets NUMERIC even over an all-INTEGER list, so
			// INTEGER's prefix parse ('1.9' → 1) cannot decide the comparison.
			const group = makeComparisonGroup([scalarType(TEXT_TYPE), scalarType(INTEGER_TYPE)], [0, 1]);
			expect(group.types[0].logicalType.name).to.equal(NUMERIC_TYPE.name);
			expect(group.types[1].logicalType.name).to.equal(INTEGER_TYPE.name);
			expect(group.key(0, '3')).to.equal(3);
			expect(group.key(1, 3)).to.equal(3);
		});

		it('converts each textual value against a numeric probe (opposite orientation)', () => {
			const group = makeComparisonGroup([scalarType(INTEGER_TYPE), scalarType(TEXT_TYPE)], [0, 1]);
			expect(group.key(0, 3)).to.equal(3);
			expect(group.key(1, '3')).to.equal(3);
		});

		it('leaves positions outside the declared group untouched', () => {
			// Group is [0, 2]: position 0 is the probe, 2 the only value; 1 is not compared.
			const group = makeComparisonGroup(
				[scalarType(TEXT_TYPE), scalarType(TEXT_TYPE), scalarType(INTEGER_TYPE)],
				[0, 2],
			);
			expect(group.types[0].logicalType.name).to.equal(NUMERIC_TYPE.name);
			expect(group.types[1].logicalType.name).to.equal(TEXT_TYPE.name);
			expect(group.key(0, '3')).to.equal(3);
			expect(group.key(1, '3')).to.equal('3');
			expect(group.key(2, 3)).to.equal(3);
		});

		it('is the identity group when the declaration names fewer than two positions', () => {
			const group = makeComparisonGroup([scalarType(TEXT_TYPE), scalarType(INTEGER_TYPE)], []);
			expect(group.key(0, '3')).to.equal('3');
			expect(group.key(1, 3)).to.equal(3);
		});

		it('ignores declared positions past the call\'s arity', () => {
			const group = makeComparisonGroup([scalarType(TEXT_TYPE), scalarType(INTEGER_TYPE)], [0, 1, 7]);
			expect(group.types).to.have.length(2);
			expect(group.key(0, '3')).to.equal(3);
		});
	});

	describe('plan-time rewrite (no returnsArg)', () => {
		let db: Database;

		beforeEach(async () => {
			db = new Database();
			await db.exec('create table cg (id integer primary key, i integer, s text)');
			await db.exec("insert into cg values (1, 1, '3')");
			// A comparison function returning a FRESH value: it declares a group but not
			// `returnsArg`, so `buildFunctionCall` rewrites its arguments with casts and
			// the implementation sees the converted forms.
			db.registerFunction(createScalarFunction(
				{ name: 'seen_args', numArgs: 2, deterministic: true, comparesArgs: [0, 1] },
				(...args: SqlValue[]) => JSON.stringify(args),
			));
			// Control: same implementation, no comparison group declared.
			db.registerFunction(createScalarFunction(
				{ name: 'raw_args', numArgs: 2, deterministic: true },
				(...args: SqlValue[]) => JSON.stringify(args),
			));
		});

		afterEach(async () => {
			await db.close();
		});

		async function one(sql: string): Promise<unknown> {
			for await (const row of db.eval(sql)) return (row as { v: unknown }).v;
			throw new Error(`no row for: ${sql}`);
		}

		it('converts the textual argument before the implementation sees it', async () => {
			expect(await one("select seen_args(i, '3') as v from cg")).to.equal('[1,3]');
			expect(await one("select raw_args(i, '3') as v from cg")).to.equal('[1,"3"]');
		});

		it('converts the probe when every value is numeric', async () => {
			expect(await one("select seen_args(s, 1) as v from cg")).to.equal('[3,1]');
		});

		it('yields the cast fallback for unconvertible text — which is exactly why a value-returning function must not take this path', async () => {
			expect(await one("select seen_args('abc', 1) as v")).to.equal('[0,1]');
		});
	});

	describe('plan shape', () => {
		let db: Database;

		beforeEach(async () => {
			db = new Database();
			await db.exec('create table cg (id integer primary key, i integer, s text)');
		});

		afterEach(async () => {
			await db.close();
		});

		function callNode(sql: string, name: string): ScalarFunctionCallNode {
			const ast = new Parser().parse(sql) as unknown as AST.Statement;
			const { plan } = db._buildPlan([ast]);
			let found: ScalarFunctionCallNode | undefined;
			const visit = (node: PlanNode): void => {
				if (found) return;
				if (node instanceof ScalarFunctionCallNode && node.expression.name.toLowerCase() === name) {
					found = node;
					return;
				}
				for (const child of node.getChildren()) visit(child);
				for (const relation of node.getRelations()) visit(relation);
			};
			visit(plan);
			if (!found) throw new Error(`no ${name}() call in plan for: ${sql}`);
			return found;
		}

		const hasCastOperand = (node: ScalarFunctionCallNode): boolean =>
			node.operands.some(operand => operand instanceof CastNode);

		it('leaves a returnsArg builtin\'s arguments un-rewritten', () => {
			expect(hasCastOperand(callNode("select nullif(s, 1) as v from cg", 'nullif'))).to.equal(false);
			expect(hasCastOperand(callNode("select greatest(i, '2') as v from cg", 'greatest'))).to.equal(false);
			expect(hasCastOperand(callNode("select least(i, '2') as v from cg", 'least'))).to.equal(false);
		});

		it('declares the first argument\'s type for nullif, which is the one it returns', () => {
			expect(callNode("select nullif(s, 1) as v from cg", 'nullif').getType().logicalType.name)
				.to.equal(TEXT_TYPE.name);
		});

		it('declares ANY for a greatest/least group that has no type covering every argument', () => {
			expect(callNode("select greatest(i, s) as v from cg", 'greatest').getType().logicalType.name)
				.to.equal('ANY');
			expect(callNode("select least(i, '2') as v from cg", 'least').getType().logicalType.name)
				.to.equal('ANY');
		});

		it('keeps the precise type when every valued argument shares one', () => {
			expect(callNode('select greatest(i, id) as v from cg', 'greatest').getType().logicalType.name)
				.to.equal(INTEGER_TYPE.name);
			// A NULL-typed argument can only win with NULL, which the declaration is
			// already nullable for, so it must not widen the group to ANY.
			expect(callNode('select greatest(i, null) as v from cg', 'greatest').getType().logicalType.name)
				.to.equal(INTEGER_TYPE.name);
		});
	});
});
