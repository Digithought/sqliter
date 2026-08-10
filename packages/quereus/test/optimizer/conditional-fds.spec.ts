import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import {
	extractCheckConstraints,
} from '../../src/planner/analysis/check-extraction.js';
import { extractPartialUniqueGuardedFds } from '../../src/planner/analysis/partial-unique-extraction.js';
import {
	predicateImpliesGuard,
	projectFds,
	shiftFds,
	addFd,
	stripGuard,
} from '../../src/planner/util/fd-utils.js';
import { EmptyScope } from '../../src/planner/scopes/empty.js';
import { BetweenNode, BinaryOpNode, CollateNode, LiteralNode, UnaryOpNode } from '../../src/planner/nodes/scalar.js';
import { InNode } from '../../src/planner/nodes/subquery.js';
import { ColumnReferenceNode } from '../../src/planner/nodes/reference.js';
import type {
	ConstantBinding,
	FunctionalDependency,
	GuardPredicate,
	ScalarPlanNode,
} from '../../src/planner/nodes/plan-node.js';
import type { ColumnSchema } from '../../src/schema/column.js';
import type { RowConstraintSchema, TableSchema, UniqueConstraintSchema } from '../../src/schema/table.js';
import { DEFAULT_ROWOP_MASK, buildColumnIndexMap } from '../../src/schema/table.js';
import type * as AST from '../../src/parser/ast.js';
import { INTEGER_TYPE, TEXT_TYPE } from '../../src/types/builtin-types.js';

// ---------------------------------------------------------------------------
// AST + scalar-node builders shared by unit tests
// ---------------------------------------------------------------------------

const scope = EmptyScope.instance as unknown as never;
const intType = { typeClass: 'scalar' as const, logicalType: INTEGER_TYPE, nullable: false, isReadOnly: false };
const intTypeNullable = { typeClass: 'scalar' as const, logicalType: INTEGER_TYPE, nullable: true, isReadOnly: false };
const textType = { typeClass: 'scalar' as const, logicalType: TEXT_TYPE, nullable: false, isReadOnly: false };

function lit(value: AST.LiteralExpr['value']): AST.LiteralExpr {
	return { type: 'literal', value };
}

function colExpr(name: string): AST.ColumnExpr {
	return { type: 'column', name };
}

function bin(operator: string, left: AST.Expression, right: AST.Expression): AST.BinaryExpr {
	return { type: 'binary', operator, left, right };
}

function or(left: AST.Expression, right: AST.Expression): AST.BinaryExpr {
	return bin('OR', left, right);
}

function un(operator: string, expr: AST.Expression): AST.UnaryExpr {
	return { type: 'unary', operator, expr };
}

function check(expr: AST.Expression): RowConstraintSchema {
	return { expr, operations: DEFAULT_ROWOP_MASK };
}

function colNode(attrId: number, index: number, nullable = false): ColumnReferenceNode {
	const expr: AST.ColumnExpr = { type: 'column', name: `c${attrId}` };
	return new ColumnReferenceNode(scope, expr, nullable ? intTypeNullable : intType, attrId, index);
}

function textColNode(attrId: number, index: number): ColumnReferenceNode {
	const expr: AST.ColumnExpr = { type: 'column', name: `c${attrId}` };
	return new ColumnReferenceNode(scope, expr, textType, attrId, index);
}

/** Text column reference whose type carries a declared collation. */
function collatedTextColNode(attrId: number, index: number, collation: string): ColumnReferenceNode {
	const expr: AST.ColumnExpr = { type: 'column', name: `c${attrId}` };
	return new ColumnReferenceNode(scope, expr, { ...textType, collationName: collation }, attrId, index);
}

/** `<operand> COLLATE <name>` wrapper (the type carries the collation). */
function collateNode(operand: ScalarPlanNode, collation: string): CollateNode {
	const ast: AST.CollateExpr = {
		type: 'collate',
		collation,
		expr: (operand as unknown as { expression: AST.Expression }).expression,
	} as AST.CollateExpr;
	return new CollateNode(scope, ast, operand);
}

function litNode(value: AST.LiteralExpr['value']): LiteralNode {
	const expr: AST.LiteralExpr = { type: 'literal', value };
	return new LiteralNode(scope, expr);
}

function eqNode(left: ScalarPlanNode, right: ScalarPlanNode): BinaryOpNode {
	const ast: AST.BinaryExpr = {
		type: 'binary',
		operator: '=',
		left: (left as unknown as { expression: AST.Expression }).expression,
		right: (right as unknown as { expression: AST.Expression }).expression,
	};
	return new BinaryOpNode(scope, ast, left, right);
}

function gtNode(left: ScalarPlanNode, right: ScalarPlanNode): BinaryOpNode {
	const ast: AST.BinaryExpr = {
		type: 'binary',
		operator: '>',
		left: (left as unknown as { expression: AST.Expression }).expression,
		right: (right as unknown as { expression: AST.Expression }).expression,
	};
	return new BinaryOpNode(scope, ast, left, right);
}

function andNode(left: ScalarPlanNode, right: ScalarPlanNode): BinaryOpNode {
	const ast: AST.BinaryExpr = {
		type: 'binary',
		operator: 'AND',
		left: (left as unknown as { expression: AST.Expression }).expression,
		right: (right as unknown as { expression: AST.Expression }).expression,
	};
	return new BinaryOpNode(scope, ast, left, right);
}

function isNullUnary(operand: ScalarPlanNode, negated: boolean): UnaryOpNode {
	const ast: AST.UnaryExpr = {
		type: 'unary',
		operator: negated ? 'IS NOT NULL' : 'IS NULL',
		expr: (operand as unknown as { expression: AST.Expression }).expression,
	};
	return new UnaryOpNode(scope, ast, operand);
}

function notUnary(operand: ScalarPlanNode): UnaryOpNode {
	const ast: AST.UnaryExpr = {
		type: 'unary',
		operator: 'NOT',
		expr: (operand as unknown as { expression: AST.Expression }).expression,
	};
	return new UnaryOpNode(scope, ast, operand);
}

function inNode(condition: ScalarPlanNode, values: ScalarPlanNode[]): InNode {
	const ast: AST.InExpr = {
		type: 'in',
		expr: (condition as unknown as { expression: AST.Expression }).expression,
		values: values.map(v => (v as unknown as { expression: AST.Expression }).expression),
	};
	return new InNode(scope, ast, condition, undefined, values);
}

function orPlanNode(left: ScalarPlanNode, right: ScalarPlanNode): BinaryOpNode {
	const ast: AST.BinaryExpr = {
		type: 'binary',
		operator: 'OR',
		left: (left as unknown as { expression: AST.Expression }).expression,
		right: (right as unknown as { expression: AST.Expression }).expression,
	};
	return new BinaryOpNode(scope, ast, left, right);
}

function cmpNode(operator: string, left: ScalarPlanNode, right: ScalarPlanNode): BinaryOpNode {
	const ast: AST.BinaryExpr = {
		type: 'binary',
		operator,
		left: (left as unknown as { expression: AST.Expression }).expression,
		right: (right as unknown as { expression: AST.Expression }).expression,
	};
	return new BinaryOpNode(scope, ast, left, right);
}

function betweenPlanNode(expr: ScalarPlanNode, lower: ScalarPlanNode, upper: ScalarPlanNode): BetweenNode {
	const ast: AST.BetweenExpr = {
		type: 'between',
		expr: (expr as unknown as { expression: AST.Expression }).expression,
		lower: (lower as unknown as { expression: AST.Expression }).expression,
		upper: (upper as unknown as { expression: AST.Expression }).expression,
	};
	return new BetweenNode(scope, ast, expr, lower, upper);
}

// ---------------------------------------------------------------------------
// predicateImpliesGuard — unit tests
// ---------------------------------------------------------------------------

describe('predicateImpliesGuard', () => {
	const attrMap = new Map<number, number>([[100, 0], [101, 1], [102, 2]]);
	const noBindings: ConstantBinding[] = [];
	const noEcs: ReadonlyArray<ReadonlyArray<number>> = [];
	const allNullable = () => false;
	const allNumeric = (_: number) => true;
	const noneNumeric = (_: number) => false;
	const allBinary = (_: number) => 'BINARY';

	it('eq-literal direct match: predicate c = "x" entails guard {c="x"}', () => {
		const guard: GuardPredicate = { clauses: [{ kind: 'eq-literal', column: 0, value: 'x' }] };
		const pred = eqNode(textColNode(100, 0), litNode('x'));
		expect(predicateImpliesGuard(pred, guard, noEcs, noBindings, attrMap, allNullable, allNumeric, allBinary)).to.equal(true);
	});

	it('eq-literal via EC: predicate c1="x" and c1=c2 entails guard {c2="x"}', () => {
		const guard: GuardPredicate = { clauses: [{ kind: 'eq-literal', column: 1, value: 'x' }] };
		const pred = andNode(
			eqNode(textColNode(100, 0), litNode('x')),
			eqNode(colNode(100, 0), colNode(101, 1)),
		);
		const ecs: ReadonlyArray<ReadonlyArray<number>> = [[0, 1]];
		expect(predicateImpliesGuard(pred, guard, ecs, noBindings, attrMap, allNullable, allNumeric, allBinary)).to.equal(true);
	});

	it('eq-literal via existing binding', () => {
		const guard: GuardPredicate = { clauses: [{ kind: 'eq-literal', column: 0, value: 5 }] };
		// Trivial predicate; binding carries the fact.
		const pred = eqNode(litNode(1), litNode(1));
		const bindings: ConstantBinding[] = [
			{ attrs: [0], value: { kind: 'literal', value: 5 } },
		];
		expect(predicateImpliesGuard(pred, guard, noEcs, bindings, attrMap, allNullable, allNumeric, allBinary)).to.equal(true);
	});

	it('eq-column via existing EC', () => {
		const guard: GuardPredicate = { clauses: [{ kind: 'eq-column', left: 0, right: 1 }] };
		const pred = eqNode(litNode(1), litNode(1));
		const ecs: ReadonlyArray<ReadonlyArray<number>> = [[0, 1]];
		expect(predicateImpliesGuard(pred, guard, ecs, noBindings, attrMap, allNullable, allNumeric, allBinary)).to.equal(true);
	});

	it('eq-column via predicate conjunct', () => {
		const guard: GuardPredicate = { clauses: [{ kind: 'eq-column', left: 0, right: 1 }] };
		const pred = eqNode(colNode(100, 0), colNode(101, 1));
		expect(predicateImpliesGuard(pred, guard, noEcs, noBindings, attrMap, allNullable, allNumeric, allBinary)).to.equal(true);
	});

	it('is-null direct: predicate c is null matches guard {c is null}', () => {
		const guard: GuardPredicate = { clauses: [{ kind: 'is-null', column: 0, negated: false }] };
		const pred = isNullUnary(colNode(100, 0, true), false);
		expect(predicateImpliesGuard(pred, guard, noEcs, noBindings, attrMap, allNullable, allNumeric, allBinary)).to.equal(true);
	});

	it('is-null negated via non-nullable column metadata', () => {
		const guard: GuardPredicate = { clauses: [{ kind: 'is-null', column: 0, negated: true }] };
		const pred = eqNode(litNode(1), litNode(1));
		const nonNullable = (col: number) => col === 0;
		expect(predicateImpliesGuard(pred, guard, noEcs, noBindings, attrMap, nonNullable, allNumeric, allBinary)).to.equal(true);
	});

	it('is-null negated via "is not null" predicate conjunct', () => {
		const guard: GuardPredicate = { clauses: [{ kind: 'is-null', column: 0, negated: true }] };
		const pred = isNullUnary(colNode(100, 0, true), true);
		expect(predicateImpliesGuard(pred, guard, noEcs, noBindings, attrMap, allNullable, allNumeric, allBinary)).to.equal(true);
	});

	it('conservative false: predicate c > 5 does not entail guard {c = "x"}', () => {
		const guard: GuardPredicate = { clauses: [{ kind: 'eq-literal', column: 0, value: 'x' }] };
		const pred = gtNode(colNode(100, 0), litNode(5));
		expect(predicateImpliesGuard(pred, guard, noEcs, noBindings, attrMap, allNullable, allNumeric, allBinary)).to.equal(false);
	});

	it('conservative false: top-level OR with no AND-conjunct match', () => {
		const guard: GuardPredicate = { clauses: [{ kind: 'eq-literal', column: 0, value: 'x' }] };
		const orAst: AST.BinaryExpr = {
			type: 'binary',
			operator: 'OR',
			left: eqNode(textColNode(100, 0), litNode('x')).expression,
			right: eqNode(textColNode(100, 0), litNode('y')).expression,
		};
		const pred = new BinaryOpNode(
			scope,
			orAst,
			eqNode(textColNode(100, 0), litNode('x')),
			eqNode(textColNode(100, 0), litNode('y')),
		);
		// Our extractor only walks AND-conjunctions; a top-level OR yields no facts.
		expect(predicateImpliesGuard(pred, guard, noEcs, noBindings, attrMap, allNullable, allNumeric, allBinary)).to.equal(false);
	});

	it('conjunctive guard requires all clauses to match', () => {
		const guard: GuardPredicate = {
			clauses: [
				{ kind: 'eq-literal', column: 0, value: 'x' },
				{ kind: 'is-null', column: 1, negated: true },
			],
		};
		// Only the literal half holds.
		const pred = eqNode(textColNode(100, 0), litNode('x'));
		expect(predicateImpliesGuard(pred, guard, noEcs, noBindings, attrMap, allNullable, allNumeric, allBinary)).to.equal(false);
		// Both halves hold.
		const pred2 = andNode(
			eqNode(textColNode(100, 0), litNode('x')),
			isNullUnary(colNode(101, 1, true), true),
		);
		expect(predicateImpliesGuard(pred2, guard, noEcs, noBindings, attrMap, allNullable, allNumeric, allBinary)).to.equal(true);
	});

	// -----------------------------------------------------------------
	// or-of clause discharge — IN, OR, NOT shapes
	// -----------------------------------------------------------------

	it("or-of: predicate c IN ('a','b') entails guard {col=a OR col=b}", () => {
		const guard: GuardPredicate = {
			clauses: [{
				kind: 'or-of',
				clauses: [
					{ kind: 'eq-literal', column: 0, value: 'a' },
					{ kind: 'eq-literal', column: 0, value: 'b' },
				],
			}],
		};
		const pred = inNode(textColNode(100, 0), [litNode('a'), litNode('b')]);
		expect(predicateImpliesGuard(pred, guard, noEcs, noBindings, attrMap, allNullable, allNumeric, allBinary)).to.equal(true);
	});

	it("or-of: predicate c='a' entails guard {col=a OR col=b} (singleton subset of OR-set)", () => {
		const guard: GuardPredicate = {
			clauses: [{
				kind: 'or-of',
				clauses: [
					{ kind: 'eq-literal', column: 0, value: 'a' },
					{ kind: 'eq-literal', column: 0, value: 'b' },
				],
			}],
		};
		const pred = eqNode(textColNode(100, 0), litNode('a'));
		expect(predicateImpliesGuard(pred, guard, noEcs, noBindings, attrMap, allNullable, allNumeric, allBinary)).to.equal(true);
	});

	it("or-of: predicate c='c' (literal outside OR-set) does NOT entail guard {col=a OR col=b}", () => {
		const guard: GuardPredicate = {
			clauses: [{
				kind: 'or-of',
				clauses: [
					{ kind: 'eq-literal', column: 0, value: 'a' },
					{ kind: 'eq-literal', column: 0, value: 'b' },
				],
			}],
		};
		const pred = eqNode(textColNode(100, 0), litNode('c'));
		expect(predicateImpliesGuard(pred, guard, noEcs, noBindings, attrMap, allNullable, allNumeric, allBinary)).to.equal(false);
	});

	it("or-of: predicate c IN ('a','c') (filter set ⊄ OR-set) does NOT entail guard", () => {
		const guard: GuardPredicate = {
			clauses: [{
				kind: 'or-of',
				clauses: [
					{ kind: 'eq-literal', column: 0, value: 'a' },
					{ kind: 'eq-literal', column: 0, value: 'b' },
				],
			}],
		};
		const pred = inNode(textColNode(100, 0), [litNode('a'), litNode('c')]);
		expect(predicateImpliesGuard(pred, guard, noEcs, noBindings, attrMap, allNullable, allNumeric, allBinary)).to.equal(false);
	});

	it("or-of mixed: predicate `deleted_at IS NULL` entails guard {deleted_at IS NULL OR status=archived}", () => {
		// Guard column for the is-null clause uses col 0; eq-literal uses col 1.
		const guard: GuardPredicate = {
			clauses: [{
				kind: 'or-of',
				clauses: [
					{ kind: 'is-null', column: 0, negated: false },
					{ kind: 'eq-literal', column: 1, value: 'archived' },
				],
			}],
		};
		const pred = isNullUnary(colNode(100, 0, true), false);
		expect(predicateImpliesGuard(pred, guard, noEcs, noBindings, attrMap, allNullable, allNumeric, allBinary)).to.equal(true);
	});

	it("or-of mixed: predicate `status='archived'` entails guard {deleted_at IS NULL OR status=archived}", () => {
		const guard: GuardPredicate = {
			clauses: [{
				kind: 'or-of',
				clauses: [
					{ kind: 'is-null', column: 0, negated: false },
					{ kind: 'eq-literal', column: 1, value: 'archived' },
				],
			}],
		};
		const pred = eqNode(textColNode(101, 1), litNode('archived'));
		expect(predicateImpliesGuard(pred, guard, noEcs, noBindings, attrMap, allNullable, allNumeric, allBinary)).to.equal(true);
	});

	it("or-of mixed: unrelated predicate `id=1` does NOT entail guard {deleted_at IS NULL OR status=archived}", () => {
		const guard: GuardPredicate = {
			clauses: [{
				kind: 'or-of',
				clauses: [
					{ kind: 'is-null', column: 0, negated: false },
					{ kind: 'eq-literal', column: 1, value: 'archived' },
				],
			}],
		};
		const pred = eqNode(colNode(102, 2), litNode(1));
		expect(predicateImpliesGuard(pred, guard, noEcs, noBindings, attrMap, allNullable, allNumeric, allBinary)).to.equal(false);
	});

	it("NOT col predicate pins col=0 (discharges eq-literal{col, 0} guard)", () => {
		const guard: GuardPredicate = { clauses: [{ kind: 'eq-literal', column: 0, value: 0 }] };
		const pred = notUnary(colNode(100, 0));
		expect(predicateImpliesGuard(pred, guard, noEcs, noBindings, attrMap, allNullable, allNumeric, allBinary)).to.equal(true);
	});

	it("predicate col=0 also discharges eq-literal{col, 0} guard (NOT col rewritten the same)", () => {
		const guard: GuardPredicate = { clauses: [{ kind: 'eq-literal', column: 0, value: 0 }] };
		const pred = eqNode(colNode(100, 0), litNode(0));
		expect(predicateImpliesGuard(pred, guard, noEcs, noBindings, attrMap, allNullable, allNumeric, allBinary)).to.equal(true);
	});

	it("NOT col on TEXT column does NOT discharge eq-literal{col, 0} guard (numeric-only rewrite)", () => {
		// `NOT col` on a TEXT column is only equivalent to `col = ''` under
		// SQLite's truthiness rules, NOT to `col = 0`. Pinning col=0 here
		// would falsely discharge a guard the runtime UC never enforced.
		const guard: GuardPredicate = { clauses: [{ kind: 'eq-literal', column: 0, value: 0 }] };
		const pred = notUnary(textColNode(100, 0));
		expect(predicateImpliesGuard(pred, guard, noEcs, noBindings, attrMap, allNullable, noneNumeric, allBinary)).to.equal(false);
	});

	it("WHERE col = 0 on TEXT column still discharges eq-literal{col, 0} guard (= path unaffected)", () => {
		// The numeric gate applies only to the `NOT col → col = 0` rewrite.
		// A direct `col = 0` conjunct is recognized regardless of column type —
		// this documents the asymmetric treatment is intentional.
		const guard: GuardPredicate = { clauses: [{ kind: 'eq-literal', column: 0, value: 0 }] };
		const pred = eqNode(textColNode(100, 0), litNode(0));
		expect(predicateImpliesGuard(pred, guard, noEcs, noBindings, attrMap, allNullable, noneNumeric, allBinary)).to.equal(true);
	});

	it("NOT col on INTEGER column still discharges eq-literal{col, 0} guard (feature regression guard)", () => {
		const guard: GuardPredicate = { clauses: [{ kind: 'eq-literal', column: 0, value: 0 }] };
		const pred = notUnary(colNode(100, 0));
		expect(predicateImpliesGuard(pred, guard, noEcs, noBindings, attrMap, allNullable, allNumeric, allBinary)).to.equal(true);
	});

	it("or-of via EC peer: c1 pinned to literal in OR-set, guard on c2 (c1 ≡ c2)", () => {
		const guard: GuardPredicate = {
			clauses: [{
				kind: 'or-of',
				clauses: [
					{ kind: 'eq-literal', column: 1, value: 'a' },
					{ kind: 'eq-literal', column: 1, value: 'b' },
				],
			}],
		};
		const pred = eqNode(textColNode(100, 0), litNode('a'));
		const ecs: ReadonlyArray<ReadonlyArray<number>> = [[0, 1]];
		expect(predicateImpliesGuard(pred, guard, ecs, noBindings, attrMap, allNullable, allNumeric, allBinary)).to.equal(true);
	});

	it("top-level OR predicate (status=a OR status=b) does NOT discharge guard col=a (AND-only walker)", () => {
		// The PredicateFacts walker only inspects AND-conjunctions of the
		// predicate, so a top-level OR predicate contributes no facts —
		// even when each disjunct individually would discharge the guard.
		// This pins the conservative behavior.
		const guard: GuardPredicate = { clauses: [{ kind: 'eq-literal', column: 0, value: 'a' }] };
		const pred = orPlanNode(
			eqNode(textColNode(100, 0), litNode('a')),
			eqNode(textColNode(100, 0), litNode('b')),
		);
		expect(predicateImpliesGuard(pred, guard, noEcs, noBindings, attrMap, allNullable, allNumeric, allBinary)).to.equal(false);
	});

	// -----------------------------------------------------------------
	// range clause discharge
	// -----------------------------------------------------------------

	it("range: filter age >= 21 entails guard {age >= 18}", () => {
		const guard: GuardPredicate = {
			clauses: [{ kind: 'range', column: 0, min: 18, minInclusive: true, maxInclusive: false }],
		};
		const pred = cmpNode('>=', colNode(100, 0), litNode(21));
		expect(predicateImpliesGuard(pred, guard, noEcs, noBindings, attrMap, allNullable, allNumeric, allBinary)).to.equal(true);
	});

	it("range: filter age >= 18 entails guard {age >= 18} (same bound)", () => {
		const guard: GuardPredicate = {
			clauses: [{ kind: 'range', column: 0, min: 18, minInclusive: true, maxInclusive: false }],
		};
		const pred = cmpNode('>=', colNode(100, 0), litNode(18));
		expect(predicateImpliesGuard(pred, guard, noEcs, noBindings, attrMap, allNullable, allNumeric, allBinary)).to.equal(true);
	});

	it("range: filter age > 18 entails guard {age >= 18} (stricter inclusivity)", () => {
		const guard: GuardPredicate = {
			clauses: [{ kind: 'range', column: 0, min: 18, minInclusive: true, maxInclusive: false }],
		};
		const pred = cmpNode('>', colNode(100, 0), litNode(18));
		expect(predicateImpliesGuard(pred, guard, noEcs, noBindings, attrMap, allNullable, allNumeric, allBinary)).to.equal(true);
	});

	it("range: filter age >= 18 does NOT entail guard {age > 18} (filter inclusive, guard exclusive at same value)", () => {
		const guard: GuardPredicate = {
			clauses: [{ kind: 'range', column: 0, min: 18, minInclusive: false, maxInclusive: false }],
		};
		const pred = cmpNode('>=', colNode(100, 0), litNode(18));
		expect(predicateImpliesGuard(pred, guard, noEcs, noBindings, attrMap, allNullable, allNumeric, allBinary)).to.equal(false);
	});

	it("range: filter age >= 17 does NOT entail guard {age >= 18}", () => {
		const guard: GuardPredicate = {
			clauses: [{ kind: 'range', column: 0, min: 18, minInclusive: true, maxInclusive: false }],
		};
		const pred = cmpNode('>=', colNode(100, 0), litNode(17));
		expect(predicateImpliesGuard(pred, guard, noEcs, noBindings, attrMap, allNullable, allNumeric, allBinary)).to.equal(false);
	});

	it("range: filter age BETWEEN 21 AND 30 entails guards {age >= 18} and {age <= 50}", () => {
		const lowerGuard: GuardPredicate = {
			clauses: [{ kind: 'range', column: 0, min: 18, minInclusive: true, maxInclusive: false }],
		};
		const upperGuard: GuardPredicate = {
			clauses: [{ kind: 'range', column: 0, max: 50, maxInclusive: true, minInclusive: false }],
		};
		const pred = betweenPlanNode(colNode(100, 0), litNode(21), litNode(30));
		expect(predicateImpliesGuard(pred, lowerGuard, noEcs, noBindings, attrMap, allNullable, allNumeric, allBinary)).to.equal(true);
		expect(predicateImpliesGuard(pred, upperGuard, noEcs, noBindings, attrMap, allNullable, allNumeric, allBinary)).to.equal(true);
	});

	it("range: filter (age >= 21 AND age <= 30) intersects to a closed interval", () => {
		const closedGuard: GuardPredicate = {
			clauses: [{ kind: 'range', column: 0, min: 18, max: 50, minInclusive: true, maxInclusive: true }],
		};
		const pred = andNode(
			cmpNode('>=', colNode(100, 0), litNode(21)),
			cmpNode('<=', colNode(100, 0), litNode(30)),
		);
		expect(predicateImpliesGuard(pred, closedGuard, noEcs, noBindings, attrMap, allNullable, allNumeric, allBinary)).to.equal(true);
	});

	it("range: filter age = 25 (eq-literal) does NOT auto-discharge a range guard via the range path", () => {
		// eq-literal is its own clause kind; the range path doesn't piggyback
		// on equality. Out of scope per ticket.
		const guard: GuardPredicate = {
			clauses: [{ kind: 'range', column: 0, min: 18, minInclusive: true, maxInclusive: false }],
		};
		const pred = eqNode(colNode(100, 0), litNode(25));
		expect(predicateImpliesGuard(pred, guard, noEcs, noBindings, attrMap, allNullable, allNumeric, allBinary)).to.equal(false);
	});

	it("range: EC-peer discharge — filter c1 >= 21 AND c1 = c2 entails guard {c2 >= 18}", () => {
		const guard: GuardPredicate = {
			clauses: [{ kind: 'range', column: 1, min: 18, minInclusive: true, maxInclusive: false }],
		};
		const pred = andNode(
			cmpNode('>=', colNode(100, 0), litNode(21)),
			eqNode(colNode(100, 0), colNode(101, 1)),
		);
		const ecs: ReadonlyArray<ReadonlyArray<number>> = [[0, 1]];
		expect(predicateImpliesGuard(pred, guard, ecs, noBindings, attrMap, allNullable, allNumeric, allBinary)).to.equal(true);
	});

	// -----------------------------------------------------------------
	// per-conjunct collation gate (ticket collation-blind-equality-fact-extraction)
	// -----------------------------------------------------------------

	it("collation: c = 'x' COLLATE NOCASE does NOT discharge eq-literal{c,'x'} on a BINARY-declared column", () => {
		// The NOCASE comparison admits rows outside the BINARY guard scope.
		const guard: GuardPredicate = { clauses: [{ kind: 'eq-literal', column: 0, value: 'x' }] };
		const pred = eqNode(textColNode(100, 0), collateNode(litNode('x'), 'NOCASE'));
		expect(predicateImpliesGuard(pred, guard, noEcs, noBindings, attrMap, allNullable, allNumeric, allBinary)).to.equal(false);
	});

	it('collation: effective collation equal to the declared collation discharges (filter rows = scope rows)', () => {
		// Column declared NOCASE; conjunct compares NOCASE (column-contributed) —
		// the same comparison the guard scope was evaluated under.
		const guard: GuardPredicate = { clauses: [{ kind: 'eq-literal', column: 0, value: 'x' }] };
		const pred = eqNode(collatedTextColNode(100, 0, 'NOCASE'), litNode('x'));
		const declaredNocase = (_: number) => 'NOCASE';
		expect(predicateImpliesGuard(pred, guard, noEcs, noBindings, attrMap, allNullable, allNumeric, declaredNocase)).to.equal(true);
		// Same conjunct against a BINARY-declared column: NOCASE filter rows ⊄ BINARY scope.
		expect(predicateImpliesGuard(pred, guard, noEcs, noBindings, attrMap, allNullable, allNumeric, allBinary)).to.equal(false);
	});

	it('collation: col1 = col2 with mismatched declared collations does NOT discharge eq-column guard', () => {
		const guard: GuardPredicate = { clauses: [{ kind: 'eq-column', left: 0, right: 1 }] };
		const mismatched = eqNode(collatedTextColNode(100, 0, 'NOCASE'), textColNode(101, 1));
		expect(predicateImpliesGuard(mismatched, guard, noEcs, noBindings, attrMap, allNullable, allNumeric, allBinary)).to.equal(false);
		// Matched (NOCASE = NOCASE) still discharges — any resolution order lands
		// on the same collation the guard's own comparison resolves to.
		const matched = eqNode(collatedTextColNode(100, 0, 'NOCASE'), collatedTextColNode(101, 1, 'NOCASE'));
		const declaredNocase = (_: number) => 'NOCASE';
		expect(predicateImpliesGuard(matched, guard, noEcs, noBindings, attrMap, allNullable, allNumeric, declaredNocase)).to.equal(true);
	});

	it('collation: TEXT range bounds discharge only when both effective and declared collations are BINARY', () => {
		const guard: GuardPredicate = {
			clauses: [{ kind: 'range', column: 0, min: 'm', minInclusive: true, maxInclusive: false }],
		};
		// BINARY/BINARY control: text bound still discharges.
		const plain = cmpNode('>=', textColNode(100, 0), litNode('p'));
		expect(predicateImpliesGuard(plain, guard, noEcs, noBindings, attrMap, allNullable, noneNumeric, allBinary)).to.equal(true);
		// NOCASE effective collation (collate-wrapped bound): no range fact.
		const collatedBound = cmpNode('>=', textColNode(100, 0), collateNode(litNode('p'), 'NOCASE'));
		expect(predicateImpliesGuard(collatedBound, guard, noEcs, noBindings, attrMap, allNullable, noneNumeric, allBinary)).to.equal(false);
		// NOCASE-declared column (collation contributed by the column side): no
		// range fact either — the subset check compares bounds under BINARY.
		const nocaseCol = cmpNode('>=', collatedTextColNode(100, 0, 'NOCASE'), litNode('p'));
		const declaredNocase = (_: number) => 'NOCASE';
		expect(predicateImpliesGuard(nocaseCol, guard, noEcs, noBindings, attrMap, allNullable, noneNumeric, declaredNocase)).to.equal(false);
	});
});

// ---------------------------------------------------------------------------
// CHECK extraction — unit tests for implication-form recognition
// ---------------------------------------------------------------------------

const checkColMap = new Map<string, number>([
	['id', 0],
	['status', 1],
	['region', 2],
	['assigned', 3],
	['deleted_at', 4],
	['x', 5],
	['y', 6],
	['a', 7],
	['b', 8],
]);
const allDeterministic = () => true;
// BINARY-declared TEXT metadata — pass-through for the shapes below; the
// collation gate's own behavior is covered in collation-soundness.spec.ts
// and check-derived-fds.spec.ts.
const checkColMeta = Array.from(
	{ length: checkColMap.size },
	() => ({ collation: 'BINARY', logicalType: TEXT_TYPE }),
);

describe('extractCheckConstraints (implication form)', () => {
	it("check (status <> 'active' or assigned = region) emits two guarded FDs", () => {
		const expr = or(
			bin('!=', colExpr('status'), lit('active')),
			bin('=', colExpr('assigned'), colExpr('region')),
		);
		const result = extractCheckConstraints([check(expr)], checkColMap, allDeterministic, checkColMeta);
		expect(result.equivPairs).to.have.length(0);
		expect(result.constantBindings).to.have.length(0);
		expect(result.domainConstraints).to.have.length(0);
		expect(result.fds).to.have.length(2);
		for (const fd of result.fds) {
			expect(fd.guard, 'expected guard on body FD').to.not.equal(undefined);
			expect(fd.guard!.clauses).to.have.length(1);
			const c = fd.guard!.clauses[0];
			expect(c.kind).to.equal('eq-literal');
			if (c.kind !== 'eq-literal') return;
			expect(c.column).to.equal(1);
			expect(c.value).to.equal('active');
		}
		const detSets = result.fds.map(fd => fd.determinants[0]).sort();
		expect(detSets).to.deep.equal([2, 3]);
	});

	it('check (deleted_at is not null or x = y) emits guarded FDs with is-null guard', () => {
		const expr = or(
			un('IS NOT NULL', colExpr('deleted_at')),
			bin('=', colExpr('x'), colExpr('y')),
		);
		const result = extractCheckConstraints([check(expr)], checkColMap, allDeterministic, checkColMeta);
		expect(result.fds).to.have.length(2);
		for (const fd of result.fds) {
			expect(fd.guard!.clauses).to.have.length(1);
			const c = fd.guard!.clauses[0];
			expect(c.kind).to.equal('is-null');
			if (c.kind !== 'is-null') return;
			expect(c.column).to.equal(4);
			expect(c.negated).to.equal(false);
		}
	});

	it('check (a <> 1 or b <> 2 or x = y) — two-clause guard, both must hold', () => {
		const expr = or(
			or(bin('!=', colExpr('a'), lit(1)), bin('!=', colExpr('b'), lit(2))),
			bin('=', colExpr('x'), colExpr('y')),
		);
		const result = extractCheckConstraints([check(expr)], checkColMap, allDeterministic, checkColMeta);
		expect(result.fds).to.have.length(2);
		const guard = result.fds[0].guard!;
		expect(guard.clauses).to.have.length(2);
		const cols = guard.clauses
			.filter(c => c.kind === 'eq-literal')
			.map(c => (c as { kind: 'eq-literal'; column: number; value: AST.LiteralExpr['value'] }).column)
			.sort();
		expect(cols).to.deep.equal([7, 8]);
	});

	it("check (status = 'active') falls through to unguarded equality recognition", () => {
		const expr = bin('=', colExpr('status'), lit('active'));
		const result = extractCheckConstraints([check(expr)], checkColMap, allDeterministic, checkColMeta);
		expect(result.fds).to.have.length(1);
		expect(result.fds[0].guard).to.equal(undefined);
		expect(result.constantBindings).to.have.length(1);
	});

	it("check (status <> 'active' or x > y) — non-equality body produces nothing", () => {
		const expr = or(
			bin('!=', colExpr('status'), lit('active')),
			bin('>', colExpr('x'), colExpr('y')),
		);
		const result = extractCheckConstraints([check(expr)], checkColMap, allDeterministic, checkColMeta);
		expect(result.fds).to.have.length(0);
	});

	// Implication-form range guards:  (¬range) OR body.
	// In each disjunct the comparison operator is *negated* to produce the
	// actual range guard for the body.

	it("check (region < 'eu' or x = y) emits guarded FDs with range guard {region >= 'eu'}", () => {
		// The disjunct `region < 'eu'` is the negation of the guard, so the
		// implied guard is `region >= 'eu'`.
		const expr = or(
			bin('<', colExpr('region'), lit('eu')),
			bin('=', colExpr('x'), colExpr('y')),
		);
		const result = extractCheckConstraints([check(expr)], checkColMap, allDeterministic, checkColMeta);
		expect(result.fds).to.have.length(2);
		for (const fd of result.fds) {
			expect(fd.guard, 'expected guard on body FD').to.not.equal(undefined);
			expect(fd.guard!.clauses).to.have.length(1);
			const c = fd.guard!.clauses[0];
			expect(c.kind).to.equal('range');
			if (c.kind !== 'range') return;
			expect(c.column).to.equal(2);
			expect(c.min).to.equal('eu');
			expect(c.minInclusive).to.equal(true);
			expect(c.maxInclusive).to.equal(false);
			expect(c.max).to.equal(undefined);
		}
	});

	it("check (region >= 'eu' or x = y) emits guarded FDs with range guard {region < 'eu'}", () => {
		// The disjunct `region >= 'eu'` is the negation of `region < 'eu'`.
		const expr = or(
			bin('>=', colExpr('region'), lit('eu')),
			bin('=', colExpr('x'), colExpr('y')),
		);
		const result = extractCheckConstraints([check(expr)], checkColMap, allDeterministic, checkColMeta);
		expect(result.fds).to.have.length(2);
		const c = result.fds[0].guard!.clauses[0];
		expect(c.kind).to.equal('range');
		if (c.kind !== 'range') return;
		expect(c.column).to.equal(2);
		expect(c.max).to.equal('eu');
		expect(c.maxInclusive).to.equal(false);
		expect(c.minInclusive).to.equal(false);
		expect(c.min).to.equal(undefined);
	});

	// --- collation gate on guarded bodies / guard scopes ----------------------

	function collateAst(expr: AST.Expression, collation: string): AST.CollateExpr {
		return { type: 'collate', expr, collation };
	}

	it('guarded body over a NOCASE-declared column mints no guarded FDs', () => {
		const expr = or(
			bin('!=', colExpr('status'), lit('active')),
			bin('=', colExpr('assigned'), colExpr('region')),
		);
		const nocaseRegion = checkColMeta.slice();
		nocaseRegion[2] = { collation: 'NOCASE', logicalType: TEXT_TYPE };
		const result = extractCheckConstraints([check(expr)], checkColMap, allDeterministic, nocaseRegion);
		expect(result.fds).to.have.length(0);
	});

	it('collate-wrapped guarded body mints no guarded FDs (one-way single-column shape)', () => {
		const expr = or(
			bin('!=', colExpr('status'), lit('active')),
			bin('=', colExpr('x'), collateAst(colExpr('y'), 'NOCASE')),
		);
		const result = extractCheckConstraints([check(expr)], checkColMap, allDeterministic, checkColMeta);
		expect(result.fds).to.have.length(0);
	});

	it('a COLLATE wrapper inside a guard-scope disjunct keeps the whole CHECK skipped', () => {
		// columnIndexFromExpr does not unwrap collate nodes, so the disjunct is
		// not a recognized guard-negation shape — pinned: the implication form
		// must not be recognized with a wrapper-altered guard scope.
		const expr = or(
			bin('!=', collateAst(colExpr('status'), 'NOCASE'), lit('active')),
			bin('=', colExpr('x'), colExpr('y')),
		);
		const result = extractCheckConstraints([check(expr)], checkColMap, allDeterministic, checkColMeta);
		expect(result.fds).to.have.length(0);
	});
});

// ---------------------------------------------------------------------------
// fd-utils — guard projection / shifting / equality
// ---------------------------------------------------------------------------

describe('fd-utils: guarded FD helpers', () => {
	const guard: GuardPredicate = { clauses: [{ kind: 'eq-literal', column: 0, value: 'x' }] };
	const fd: FunctionalDependency = { determinants: [1], dependents: [2], guard, kind: 'unique' };

	it('shiftFds shifts guard columns alongside determinants/dependents', () => {
		const shifted = shiftFds([fd], 10);
		expect(shifted[0].determinants).to.deep.equal([11]);
		expect(shifted[0].dependents).to.deep.equal([12]);
		expect(shifted[0].guard).to.not.equal(undefined);
		const c = shifted[0].guard!.clauses[0];
		expect(c.kind).to.equal('eq-literal');
		if (c.kind !== 'eq-literal') return;
		expect(c.column).to.equal(10);
	});

	it('projectFds drops a guarded FD when a guard column is missing from the mapping', () => {
		const mapping = new Map<number, number>([[1, 100], [2, 200]]); // guard col 0 missing
		const out = projectFds([fd], mapping);
		expect(out).to.have.length(0);
	});

	it('projectFds remaps a guarded FD when every column survives', () => {
		const mapping = new Map<number, number>([[0, 50], [1, 100], [2, 200]]);
		const out = projectFds([fd], mapping);
		expect(out).to.have.length(1);
		expect(out[0].guard).to.not.equal(undefined);
		const c = out[0].guard!.clauses[0];
		expect(c.kind).to.equal('eq-literal');
		if (c.kind !== 'eq-literal') return;
		expect(c.column).to.equal(50);
	});

	it('stripGuard removes the guard while preserving det/dep', () => {
		const stripped = stripGuard(fd);
		expect(stripped.guard).to.equal(undefined);
		expect(stripped.determinants).to.deep.equal(fd.determinants);
		expect(stripped.dependents).to.deep.equal(fd.dependents);
	});

	it('addFd keeps two same-det FDs side-by-side when only one is guarded', () => {
		const unguarded: FunctionalDependency = { determinants: [1], dependents: [2], kind: 'determination' };
		const after = addFd([unguarded], fd);
		expect(after).to.have.length(2);
	});

	it('addFd dedupes structurally equal guarded FDs', () => {
		const after = addFd([fd], { ...fd });
		expect(after).to.have.length(1);
	});

	// -----------------------------------------------------------------
	// or-of: equality, projection
	// -----------------------------------------------------------------

	it("addFd treats two or-of clauses with same sub-clauses in different orders as equal", () => {
		const a: GuardPredicate = {
			clauses: [{
				kind: 'or-of',
				clauses: [
					{ kind: 'eq-literal', column: 0, value: 'a' },
					{ kind: 'eq-literal', column: 0, value: 'b' },
				],
			}],
		};
		const b: GuardPredicate = {
			clauses: [{
				kind: 'or-of',
				clauses: [
					{ kind: 'eq-literal', column: 0, value: 'b' },
					{ kind: 'eq-literal', column: 0, value: 'a' },
				],
			}],
		};
		const fdA: FunctionalDependency = { determinants: [1], dependents: [2], guard: a, kind: 'unique' };
		const fdB: FunctionalDependency = { determinants: [1], dependents: [2], guard: b, kind: 'unique' };
		const after = addFd([fdA], fdB);
		expect(after).to.have.length(1);
	});

	it("addFd keeps or-of guards with different sub-clauses side by side", () => {
		const a: GuardPredicate = {
			clauses: [{
				kind: 'or-of',
				clauses: [
					{ kind: 'eq-literal', column: 0, value: 'a' },
					{ kind: 'eq-literal', column: 0, value: 'b' },
				],
			}],
		};
		const b: GuardPredicate = {
			clauses: [{
				kind: 'or-of',
				clauses: [
					{ kind: 'eq-literal', column: 0, value: 'a' },
					{ kind: 'eq-literal', column: 0, value: 'c' },
				],
			}],
		};
		const fdA: FunctionalDependency = { determinants: [1], dependents: [2], guard: a, kind: 'unique' };
		const fdB: FunctionalDependency = { determinants: [1], dependents: [2], guard: b, kind: 'unique' };
		const after = addFd([fdA], fdB);
		expect(after).to.have.length(2);
	});

	it("projectFds drops an or-of guarded FD when any nested column drops from the mapping", () => {
		const orGuard: GuardPredicate = {
			clauses: [{
				kind: 'or-of',
				clauses: [
					{ kind: 'eq-literal', column: 0, value: 'a' },
					{ kind: 'eq-literal', column: 5, value: 'b' },
				],
			}],
		};
		const fdOr: FunctionalDependency = { determinants: [1], dependents: [2], guard: orGuard, kind: 'unique' };
		// Mapping omits column 5 (a nested sub-clause column).
		const mapping = new Map<number, number>([[0, 50], [1, 100], [2, 200]]);
		const out = projectFds([fdOr], mapping);
		expect(out).to.have.length(0);
	});

	it("projectFds remaps an or-of guarded FD when all columns survive", () => {
		const orGuard: GuardPredicate = {
			clauses: [{
				kind: 'or-of',
				clauses: [
					{ kind: 'eq-literal', column: 0, value: 'a' },
					{ kind: 'eq-literal', column: 5, value: 'b' },
				],
			}],
		};
		const fdOr: FunctionalDependency = { determinants: [1], dependents: [2], guard: orGuard, kind: 'unique' };
		const mapping = new Map<number, number>([[0, 50], [1, 100], [2, 200], [5, 500]]);
		const out = projectFds([fdOr], mapping);
		expect(out).to.have.length(1);
		const c = out[0].guard!.clauses[0];
		expect(c.kind).to.equal('or-of');
		if (c.kind !== 'or-of') return;
		const cols = c.clauses.map(s => (s as { kind: 'eq-literal'; column: number }).column).sort((a, b) => a - b);
		expect(cols).to.deep.equal([50, 500]);
	});

	it("shiftFds shifts or-of sub-clause columns", () => {
		const orGuard: GuardPredicate = {
			clauses: [{
				kind: 'or-of',
				clauses: [
					{ kind: 'eq-literal', column: 0, value: 'a' },
					{ kind: 'is-null', column: 1, negated: false },
				],
			}],
		};
		const fdOr: FunctionalDependency = { determinants: [2], dependents: [3], guard: orGuard, kind: 'unique' };
		const out = shiftFds([fdOr], 10);
		expect(out[0].determinants).to.deep.equal([12]);
		const c = out[0].guard!.clauses[0];
		expect(c.kind).to.equal('or-of');
		if (c.kind !== 'or-of') return;
		const cols = c.clauses.map(s =>
			s.kind === 'eq-literal' ? s.column : s.kind === 'is-null' ? s.column : -1,
		).sort((a, b) => a - b);
		expect(cols).to.deep.equal([10, 11]);
	});

	// -----------------------------------------------------------------
	// range: equality, projection, shifting
	// -----------------------------------------------------------------

	it("shiftFds shifts range guard column", () => {
		const rangeGuard: GuardPredicate = {
			clauses: [{ kind: 'range', column: 0, min: 18, minInclusive: true, maxInclusive: false }],
		};
		const fdRange: FunctionalDependency = { determinants: [1], dependents: [2], guard: rangeGuard, kind: 'unique' };
		const out = shiftFds([fdRange], 10);
		const c = out[0].guard!.clauses[0];
		expect(c.kind).to.equal('range');
		if (c.kind !== 'range') return;
		expect(c.column).to.equal(10);
		expect(c.min).to.equal(18);
		expect(c.minInclusive).to.equal(true);
	});

	it("projectFds drops a range-guarded FD when the guard column is missing from the mapping", () => {
		const rangeGuard: GuardPredicate = {
			clauses: [{ kind: 'range', column: 0, min: 18, minInclusive: true, maxInclusive: false }],
		};
		const fdRange: FunctionalDependency = { determinants: [1], dependents: [2], guard: rangeGuard, kind: 'unique' };
		const mapping = new Map<number, number>([[1, 100], [2, 200]]);
		expect(projectFds([fdRange], mapping)).to.have.length(0);
	});

	it("projectFds remaps a range-guarded FD when all columns survive", () => {
		const rangeGuard: GuardPredicate = {
			clauses: [{ kind: 'range', column: 0, min: 18, minInclusive: true, maxInclusive: false }],
		};
		const fdRange: FunctionalDependency = { determinants: [1], dependents: [2], guard: rangeGuard, kind: 'unique' };
		const mapping = new Map<number, number>([[0, 50], [1, 100], [2, 200]]);
		const out = projectFds([fdRange], mapping);
		expect(out).to.have.length(1);
		const c = out[0].guard!.clauses[0];
		expect(c.kind).to.equal('range');
		if (c.kind !== 'range') return;
		expect(c.column).to.equal(50);
	});

	it("addFd dedupes structurally equal range guards", () => {
		const rangeGuard: GuardPredicate = {
			clauses: [{ kind: 'range', column: 0, min: 18, minInclusive: true, maxInclusive: false }],
		};
		const fdA: FunctionalDependency = { determinants: [1], dependents: [2], guard: rangeGuard, kind: 'unique' };
		const fdB: FunctionalDependency = {
			determinants: [1],
			dependents: [2],
			guard: { clauses: [{ kind: 'range', column: 0, min: 18, minInclusive: true, maxInclusive: false }] },
			kind: 'unique',
		};
		const after = addFd([fdA], fdB);
		expect(after).to.have.length(1);
	});

	it("addFd keeps range guards with different bound values side by side", () => {
		const a: GuardPredicate = {
			clauses: [{ kind: 'range', column: 0, min: 18, minInclusive: true, maxInclusive: false }],
		};
		const b: GuardPredicate = {
			clauses: [{ kind: 'range', column: 0, min: 21, minInclusive: true, maxInclusive: false }],
		};
		const fdA: FunctionalDependency = { determinants: [1], dependents: [2], guard: a, kind: 'unique' };
		const fdB: FunctionalDependency = { determinants: [1], dependents: [2], guard: b, kind: 'unique' };
		expect(addFd([fdA], fdB)).to.have.length(2);
	});

	it("addFd keeps range guards with different inclusivity side by side", () => {
		const a: GuardPredicate = {
			clauses: [{ kind: 'range', column: 0, min: 18, minInclusive: true, maxInclusive: false }],
		};
		const b: GuardPredicate = {
			clauses: [{ kind: 'range', column: 0, min: 18, minInclusive: false, maxInclusive: false }],
		};
		const fdA: FunctionalDependency = { determinants: [1], dependents: [2], guard: a, kind: 'unique' };
		const fdB: FunctionalDependency = { determinants: [1], dependents: [2], guard: b, kind: 'unique' };
		expect(addFd([fdA], fdB)).to.have.length(2);
	});
});

// ---------------------------------------------------------------------------
// Partial UNIQUE extraction — unit tests
// ---------------------------------------------------------------------------

function makeColumn(name: string, notNull: boolean, type = INTEGER_TYPE): ColumnSchema {
	return {
		name,
		logicalType: type,
		notNull,
		primaryKey: false,
		pkOrder: 0,
		defaultValue: null,
		collation: 'BINARY',
		generated: false,
	};
}

function makeSchema(columns: ColumnSchema[], uniqueConstraints: UniqueConstraintSchema[]): TableSchema {
	return {
		name: 't',
		schemaName: 'main',
		columns,
		columnIndexMap: buildColumnIndexMap(columns),
		primaryKeyDefinition: [],
		checkConstraints: [],
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		vtabModule: undefined as any,
		vtabModuleName: 'memory',
		isView: false,
		uniqueConstraints,
	};
}

describe('extractPartialUniqueGuardedFds', () => {
	it('recognizes col = literal as a single eq-literal guard clause', () => {
		const schema = makeSchema(
			[makeColumn('id', true), makeColumn('c', true), makeColumn('status', true, TEXT_TYPE)],
			[{ columns: [1], predicate: bin('=', colExpr('status'), lit('active')) }],
		);
		const fds = extractPartialUniqueGuardedFds(schema);
		expect(fds).to.have.length(1);
		expect(fds[0].determinants).to.deep.equal([1]);
		expect(fds[0].dependents).to.deep.equal([0, 2]);
		expect(fds[0].guard!.clauses).to.have.length(1);
		const c = fds[0].guard!.clauses[0];
		expect(c.kind).to.equal('eq-literal');
		if (c.kind !== 'eq-literal') return;
		expect(c.column).to.equal(2);
		expect(c.value).to.equal('active');
	});

	it("recognizes literal = col (operand-flipped) as eq-literal", () => {
		const schema = makeSchema(
			[makeColumn('c', true), makeColumn('status', true, TEXT_TYPE)],
			[{ columns: [0], predicate: bin('=', lit('active'), colExpr('status')) }],
		);
		const fds = extractPartialUniqueGuardedFds(schema);
		expect(fds).to.have.length(1);
		const c = fds[0].guard!.clauses[0];
		expect(c.kind).to.equal('eq-literal');
		if (c.kind !== 'eq-literal') return;
		expect(c.column).to.equal(1);
		expect(c.value).to.equal('active');
	});

	it('recognizes col1 = col2 as eq-column', () => {
		const schema = makeSchema(
			[makeColumn('c', true), makeColumn('a', true), makeColumn('b', true)],
			[{ columns: [0], predicate: bin('=', colExpr('a'), colExpr('b')) }],
		);
		const fds = extractPartialUniqueGuardedFds(schema);
		expect(fds).to.have.length(1);
		const c = fds[0].guard!.clauses[0];
		expect(c.kind).to.equal('eq-column');
		if (c.kind !== 'eq-column') return;
		expect([c.left, c.right].sort()).to.deep.equal([1, 2]);
	});

	it('recognizes col IS NULL as is-null negated:false', () => {
		const schema = makeSchema(
			[makeColumn('c', true), makeColumn('deleted_at', false, TEXT_TYPE)],
			[{ columns: [0], predicate: un('IS NULL', colExpr('deleted_at')) }],
		);
		const fds = extractPartialUniqueGuardedFds(schema);
		expect(fds).to.have.length(1);
		const c = fds[0].guard!.clauses[0];
		expect(c.kind).to.equal('is-null');
		if (c.kind !== 'is-null') return;
		expect(c.column).to.equal(1);
		expect(c.negated).to.equal(false);
	});

	it('recognizes col IS NOT NULL as is-null negated:true', () => {
		const schema = makeSchema(
			[makeColumn('c', true), makeColumn('archived', false, TEXT_TYPE)],
			[{ columns: [0], predicate: un('IS NOT NULL', colExpr('archived')) }],
		);
		const fds = extractPartialUniqueGuardedFds(schema);
		expect(fds).to.have.length(1);
		const c = fds[0].guard!.clauses[0];
		expect(c.kind).to.equal('is-null');
		if (c.kind !== 'is-null') return;
		expect(c.column).to.equal(1);
		expect(c.negated).to.equal(true);
	});

	it('recognizes multi-conjunct AND into a multi-clause guard', () => {
		const schema = makeSchema(
			[
				makeColumn('c', true),
				makeColumn('status', true, TEXT_TYPE),
				makeColumn('region', true, TEXT_TYPE),
			],
			[{
				columns: [0],
				predicate: bin('AND',
					bin('=', colExpr('status'), lit('active')),
					bin('=', colExpr('region'), lit('us'))),
			}],
		);
		const fds = extractPartialUniqueGuardedFds(schema);
		expect(fds).to.have.length(1);
		const clauses = fds[0].guard!.clauses;
		expect(clauses).to.have.length(2);
		const cols = clauses
			.filter(c => c.kind === 'eq-literal')
			.map(c => (c as { kind: 'eq-literal'; column: number; value: AST.LiteralExpr['value'] }).column)
			.sort();
		expect(cols).to.deep.equal([1, 2]);
	});

	it('recognizes col > literal as range guard (exclusive lower bound)', () => {
		const schema = makeSchema(
			[makeColumn('c', true), makeColumn('age', true)],
			[{ columns: [0], predicate: bin('>', colExpr('age'), lit(18)) }],
		);
		const fds = extractPartialUniqueGuardedFds(schema);
		expect(fds).to.have.length(1);
		const c = fds[0].guard!.clauses[0];
		expect(c.kind).to.equal('range');
		if (c.kind !== 'range') return;
		expect(c.column).to.equal(1);
		expect(c.min).to.equal(18);
		expect(c.minInclusive).to.equal(false);
		expect(c.max).to.equal(undefined);
		expect(c.maxInclusive).to.equal(false);
	});

	it('recognizes col >= literal as range guard (inclusive lower bound)', () => {
		const schema = makeSchema(
			[makeColumn('c', true), makeColumn('age', true)],
			[{ columns: [0], predicate: bin('>=', colExpr('age'), lit(18)) }],
		);
		const fds = extractPartialUniqueGuardedFds(schema);
		expect(fds).to.have.length(1);
		const c = fds[0].guard!.clauses[0];
		expect(c.kind).to.equal('range');
		if (c.kind !== 'range') return;
		expect(c.min).to.equal(18);
		expect(c.minInclusive).to.equal(true);
	});

	it('recognizes col < literal as range guard (exclusive upper bound)', () => {
		const schema = makeSchema(
			[makeColumn('c', true), makeColumn('age', true)],
			[{ columns: [0], predicate: bin('<', colExpr('age'), lit(65)) }],
		);
		const fds = extractPartialUniqueGuardedFds(schema);
		expect(fds).to.have.length(1);
		const c = fds[0].guard!.clauses[0];
		expect(c.kind).to.equal('range');
		if (c.kind !== 'range') return;
		expect(c.max).to.equal(65);
		expect(c.maxInclusive).to.equal(false);
		expect(c.min).to.equal(undefined);
	});

	it('recognizes col <= literal as range guard (inclusive upper bound)', () => {
		const schema = makeSchema(
			[makeColumn('c', true), makeColumn('age', true)],
			[{ columns: [0], predicate: bin('<=', colExpr('age'), lit(65)) }],
		);
		const fds = extractPartialUniqueGuardedFds(schema);
		expect(fds).to.have.length(1);
		const c = fds[0].guard!.clauses[0];
		expect(c.kind).to.equal('range');
		if (c.kind !== 'range') return;
		expect(c.max).to.equal(65);
		expect(c.maxInclusive).to.equal(true);
	});

	it('recognizes literal < col (operand-flipped) as same guard as col > literal', () => {
		const schema = makeSchema(
			[makeColumn('c', true), makeColumn('age', true)],
			[{ columns: [0], predicate: bin('<', lit(18), colExpr('age')) }],
		);
		const fds = extractPartialUniqueGuardedFds(schema);
		expect(fds).to.have.length(1);
		const c = fds[0].guard!.clauses[0];
		expect(c.kind).to.equal('range');
		if (c.kind !== 'range') return;
		expect(c.min).to.equal(18);
		expect(c.minInclusive).to.equal(false);
	});

	it('recognizes col BETWEEN lo AND hi as closed-interval range guard', () => {
		const between: AST.BetweenExpr = {
			type: 'between',
			expr: colExpr('age'),
			lower: lit(18),
			upper: lit(65),
		};
		const schema = makeSchema(
			[makeColumn('c', true), makeColumn('age', true)],
			[{ columns: [0], predicate: between }],
		);
		const fds = extractPartialUniqueGuardedFds(schema);
		expect(fds).to.have.length(1);
		const c = fds[0].guard!.clauses[0];
		expect(c.kind).to.equal('range');
		if (c.kind !== 'range') return;
		expect(c.column).to.equal(1);
		expect(c.min).to.equal(18);
		expect(c.max).to.equal(65);
		expect(c.minInclusive).to.equal(true);
		expect(c.maxInclusive).to.equal(true);
	});

	it('rejects NOT BETWEEN', () => {
		const between: AST.BetweenExpr = {
			type: 'between',
			expr: colExpr('age'),
			lower: lit(18),
			upper: lit(65),
			not: true,
		};
		const schema = makeSchema(
			[makeColumn('c', true), makeColumn('age', true)],
			[{ columns: [0], predicate: between }],
		);
		expect(extractPartialUniqueGuardedFds(schema)).to.have.length(0);
	});

	it("rejects col != literal", () => {
		const schema = makeSchema(
			[makeColumn('c', true), makeColumn('status', true, TEXT_TYPE)],
			[{ columns: [0], predicate: bin('!=', colExpr('status'), lit('x')) }],
		);
		expect(extractPartialUniqueGuardedFds(schema)).to.have.length(0);
	});

	it("recognizes col IN (lit, lit, …) as an or-of of eq-literal clauses", () => {
		const inExpr: AST.InExpr = {
			type: 'in',
			expr: colExpr('status'),
			values: [lit('a'), lit('b')],
		};
		const schema = makeSchema(
			[makeColumn('c', true), makeColumn('status', true, TEXT_TYPE)],
			[{ columns: [0], predicate: inExpr }],
		);
		const fds = extractPartialUniqueGuardedFds(schema);
		expect(fds).to.have.length(1);
		const clauses = fds[0].guard!.clauses;
		expect(clauses).to.have.length(1);
		const c = clauses[0];
		expect(c.kind).to.equal('or-of');
		if (c.kind !== 'or-of') return;
		expect(c.clauses).to.have.length(2);
		const vals = c.clauses.map(s => (s as { kind: 'eq-literal'; column: number; value: AST.LiteralExpr['value'] }).value).sort();
		expect(vals).to.deep.equal(['a', 'b']);
	});

	it('collapses col IN (single-literal) to a bare eq-literal', () => {
		const inExpr: AST.InExpr = {
			type: 'in',
			expr: colExpr('status'),
			values: [lit('a')],
		};
		const schema = makeSchema(
			[makeColumn('c', true), makeColumn('status', true, TEXT_TYPE)],
			[{ columns: [0], predicate: inExpr }],
		);
		const fds = extractPartialUniqueGuardedFds(schema);
		expect(fds).to.have.length(1);
		const c = fds[0].guard!.clauses[0];
		expect(c.kind).to.equal('eq-literal');
	});

	it('rejects col IN (?) (parameter, not literal)', () => {
		const inExpr: AST.InExpr = {
			type: 'in',
			expr: colExpr('status'),
			values: [{ type: 'parameter', index: 1 } as AST.Expression],
		};
		const schema = makeSchema(
			[makeColumn('c', true), makeColumn('status', true, TEXT_TYPE)],
			[{ columns: [0], predicate: inExpr }],
		);
		expect(extractPartialUniqueGuardedFds(schema)).to.have.length(0);
	});

	it("recognizes top-level OR as an or-of", () => {
		const schema = makeSchema(
			[makeColumn('c', true), makeColumn('status', true, TEXT_TYPE), makeColumn('region', true, TEXT_TYPE)],
			[{
				columns: [0],
				predicate: or(
					bin('=', colExpr('status'), lit('a')),
					bin('=', colExpr('region'), lit('b'))),
			}],
		);
		const fds = extractPartialUniqueGuardedFds(schema);
		expect(fds).to.have.length(1);
		const c = fds[0].guard!.clauses[0];
		expect(c.kind).to.equal('or-of');
		if (c.kind !== 'or-of') return;
		expect(c.clauses).to.have.length(2);
	});

	it("flattens 3-way OR into a single or-of with three sub-clauses", () => {
		const schema = makeSchema(
			[makeColumn('c', true), makeColumn('a', true, TEXT_TYPE), makeColumn('b', true, TEXT_TYPE), makeColumn('d', true, TEXT_TYPE)],
			[{
				columns: [0],
				predicate: or(
					or(bin('=', colExpr('a'), lit('x')), bin('=', colExpr('b'), lit('y'))),
					bin('=', colExpr('d'), lit('z'))),
			}],
		);
		const fds = extractPartialUniqueGuardedFds(schema);
		expect(fds).to.have.length(1);
		const c = fds[0].guard!.clauses[0];
		expect(c.kind).to.equal('or-of');
		if (c.kind !== 'or-of') return;
		expect(c.clauses).to.have.length(3);
		for (const sub of c.clauses) {
			expect(sub.kind).to.equal('eq-literal');
		}
	});

	it('recognizes NOT col on declared-NOT-NULL column as eq-literal { col, 0 }', () => {
		const schema = makeSchema(
			[makeColumn('id', true), makeColumn('archived', true)],
			[{ columns: [0], predicate: un('NOT', colExpr('archived')) }],
		);
		const fds = extractPartialUniqueGuardedFds(schema);
		expect(fds).to.have.length(1);
		const c = fds[0].guard!.clauses[0];
		expect(c.kind).to.equal('eq-literal');
		if (c.kind !== 'eq-literal') return;
		expect(c.column).to.equal(1);
		expect(c.value).to.equal(0);
	});

	it('rejects NOT col on nominally-nullable column (NOT-NULL gate is syntactic)', () => {
		const schema = makeSchema(
			[makeColumn('id', true), makeColumn('archived', false)],
			[{ columns: [0], predicate: un('NOT', colExpr('archived')) }],
		);
		expect(extractPartialUniqueGuardedFds(schema)).to.have.length(0);
	});

	it('rejects NOT col on declared-NOT-NULL TEXT column (numeric-only rewrite)', () => {
		// `NOT col` rewrites to `col = 0`, but for a TEXT column `col = 0` is
		// not equivalent to `NOT col` under strict `sqlValueEquals` — the
		// rewrite would produce an FD the runtime UC never enforces.
		const schema = makeSchema(
			[makeColumn('id', true), makeColumn('flag', true, TEXT_TYPE)],
			[{ columns: [0], predicate: un('NOT', colExpr('flag')) }],
		);
		expect(extractPartialUniqueGuardedFds(schema)).to.have.length(0);
	});

	it('rejects OR with one unrecognized disjunct (whole predicate dropped)', () => {
		// `status != 'a'` is not a recognized guard clause shape (only `=` /
		// `==` produce eq-literal; `!=` is out of scope).
		const schema = makeSchema(
			[makeColumn('c', true), makeColumn('status', true, TEXT_TYPE), makeColumn('age', true)],
			[{
				columns: [0],
				predicate: or(
					bin('=', colExpr('status'), lit('a')),
					bin('!=', colExpr('age'), lit(18))),
			}],
		);
		expect(extractPartialUniqueGuardedFds(schema)).to.have.length(0);
	});

	it('rejects nullable UC column (NOT-NULL gate)', () => {
		const schema = makeSchema(
			[makeColumn('c', false), makeColumn('status', true, TEXT_TYPE)],
			[{ columns: [0], predicate: bin('=', colExpr('status'), lit('active')) }],
		);
		expect(extractPartialUniqueGuardedFds(schema)).to.have.length(0);
	});

	it('admits nullable UC column when predicate has matching IS NOT NULL', () => {
		const schema = makeSchema(
			[makeColumn('id', true), makeColumn('email', false, TEXT_TYPE)],
			[{ columns: [1], predicate: un('IS NOT NULL', colExpr('email')) }],
		);
		const fds = extractPartialUniqueGuardedFds(schema);
		expect(fds).to.have.length(1);
		expect(fds[0].determinants).to.deep.equal([1]);
		expect(fds[0].dependents).to.deep.equal([0]);
	});

	it('admits composite UC when every nullable UC column has its own IS NOT NULL conjunct', () => {
		const schema = makeSchema(
			[makeColumn('id', true), makeColumn('a', false), makeColumn('b', false)],
			[{
				columns: [1, 2],
				predicate: bin('AND',
					un('IS NOT NULL', colExpr('a')),
					un('IS NOT NULL', colExpr('b'))),
			}],
		);
		const fds = extractPartialUniqueGuardedFds(schema);
		expect(fds).to.have.length(1);
		expect([...fds[0].determinants].sort()).to.deep.equal([1, 2]);
	});

	it('rejects nullable UC column when IS NOT NULL names a different column', () => {
		const schema = makeSchema(
			[makeColumn('id', true), makeColumn('email', false, TEXT_TYPE), makeColumn('status', true, TEXT_TYPE)],
			[{ columns: [1], predicate: un('IS NOT NULL', colExpr('status')) }],
		);
		expect(extractPartialUniqueGuardedFds(schema)).to.have.length(0);
	});

	it('rejects composite UC when only one nullable UC column has IS NOT NULL', () => {
		const schema = makeSchema(
			[makeColumn('id', true), makeColumn('a', false), makeColumn('b', false)],
			[{
				columns: [1, 2],
				predicate: un('IS NOT NULL', colExpr('a')),
			}],
		);
		expect(extractPartialUniqueGuardedFds(schema)).to.have.length(0);
	});

	it('rejects nullable UC column when conjunct is IS NULL, not IS NOT NULL', () => {
		const schema = makeSchema(
			[makeColumn('id', true), makeColumn('email', false, TEXT_TYPE)],
			[{ columns: [1], predicate: un('IS NULL', colExpr('email')) }],
		);
		expect(extractPartialUniqueGuardedFds(schema)).to.have.length(0);
	});

	// Mixed shape: one UC column admitted via IS-NOT-NULL conjunct, another via
	// table-declared NOT-NULL — admits only when both halves resolve.
	it('admits composite UC mixing IS NOT NULL conjunct with table-declared NOT NULL column', () => {
		const schema = makeSchema(
			[makeColumn('id', true), makeColumn('email', false, TEXT_TYPE), makeColumn('region', true, TEXT_TYPE)],
			[{
				columns: [1, 2],
				predicate: bin('AND',
					un('IS NOT NULL', colExpr('email')),
					bin('=', colExpr('region'), lit('us'))),
			}],
		);
		const fds = extractPartialUniqueGuardedFds(schema);
		expect(fds).to.have.length(1);
		expect([...fds[0].determinants].sort()).to.deep.equal([1, 2]);
	});

	// Same shape but `region` nullable on the table: the eq-literal conjunct
	// does NOT establish non-NULL for region, and there is no IS NOT NULL
	// conjunct on region — so the FD must be dropped.
	it('rejects composite UC mixing IS NOT NULL conjunct with eq-literal on a nullable column', () => {
		const schema = makeSchema(
			[makeColumn('id', true), makeColumn('email', false, TEXT_TYPE), makeColumn('region', false, TEXT_TYPE)],
			[{
				columns: [1, 2],
				predicate: bin('AND',
					un('IS NOT NULL', colExpr('email')),
					bin('=', colExpr('region'), lit('us'))),
			}],
		);
		expect(extractPartialUniqueGuardedFds(schema)).to.have.length(0);
	});

	it('rejects the whole predicate if one conjunct is unrecognized (soundness)', () => {
		// `age != 18` is not a recognized clause shape, so the whole predicate
		// must be dropped even though the other conjunct is recognized.
		const schema = makeSchema(
			[makeColumn('c', true), makeColumn('status', true, TEXT_TYPE), makeColumn('age', true)],
			[{
				columns: [0],
				predicate: bin('AND',
					bin('=', colExpr('status'), lit('active')),
					bin('!=', colExpr('age'), lit(18))),
			}],
		);
		// One conjunct recognized, one not — whole FD is dropped.
		expect(extractPartialUniqueGuardedFds(schema)).to.have.length(0);
	});

	it('skips non-partial UCs', () => {
		const schema = makeSchema(
			[makeColumn('c', true), makeColumn('status', true, TEXT_TYPE)],
			[{ columns: [0] }],
		);
		expect(extractPartialUniqueGuardedFds(schema)).to.have.length(0);
	});

	it('returns nothing when table has no uniqueConstraints', () => {
		const schema = makeSchema([makeColumn('c', true)], []);
		expect(extractPartialUniqueGuardedFds(schema)).to.have.length(0);
	});
});

// ---------------------------------------------------------------------------
// End-to-end via query_plan(...)
// ---------------------------------------------------------------------------

interface PhysicalProps {
	fds?: { determinants: number[]; dependents: number[]; guard?: GuardPredicate; kind: 'unique' | 'determination' }[];
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

function fdHas(
	fds: PhysicalProps['fds'] | undefined,
	det: number[],
	dep: number[],
	unguardedOnly = true,
): boolean {
	if (!fds) return false;
	const detSet = new Set(det);
	return fds.some(fd => {
		if (unguardedOnly && fd.guard !== undefined) return false;
		if (fd.determinants.length !== det.length) return false;
		if (!fd.determinants.every(d => detSet.has(d))) return false;
		return dep.every(d => fd.dependents.includes(d));
	});
}

describe('Conditional FDs: end-to-end propagation', () => {
	let db: Database;

	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	const setupRegionTable = async (): Promise<void> => {
		await db.exec(
			"CREATE TABLE t (" +
			" id INTEGER PRIMARY KEY," +
			" customer_region TEXT NOT NULL," +
			" assigned_region TEXT NOT NULL," +
			" status TEXT NOT NULL," +
			" CHECK (status <> 'active' OR assigned_region = customer_region)" +
			") USING memory"
		);
	};

	it("table reference carries guarded FDs from the implication-form CHECK", async () => {
		await setupRegionTable();
		const rows = await planRows(db, 'SELECT * FROM t');
		const props = physicalOf(rows, r => /TABLEREF/i.test(r.op))
			?? physicalOf(rows, r => /SCAN/i.test(r.op));
		expect(props, 'expected table-ref physical props').to.not.equal(undefined);
		const guardedFd = props!.fds?.find(fd => fd.guard !== undefined);
		expect(guardedFd, 'expected a guarded FD on the source').to.not.equal(undefined);
	});

	it("filter with status='active' activates the guard: assigned_region equivalent to customer_region", async () => {
		await setupRegionTable();
		const rows = await planRows(db, "SELECT * FROM t WHERE status = 'active'");
		const filterProps = physicalOf(rows, r => r.op === 'FILTER');
		expect(filterProps, 'expected Filter physical props').to.not.equal(undefined);
		// Columns: id=0, customer_region=1, assigned_region=2, status=3.
		// Activation strips the guard unconditionally (kind-preserving): the
		// value-equality body `assigned_region = customer_region` surfaces both as
		// the bi-directional FD `{1}↔{2}` with `kind: 'determination'` AND as the
		// EC {1,2}. Neither endpoint is a key (PK is id) — soundness lives in the
		// kind-aware readers, which never derive a key from a determination on a
		// bag (ticket fd-determination-reader-side-rule, replacing the activation
		// endpoint gate from fd-guarded-activation-key-bag-overclaim).
		const aToB = filterProps!.fds?.find(fd =>
			fd.guard === undefined && fd.determinants.length === 1 && fd.determinants[0] === 1 && fd.dependents.includes(2));
		const bToA = filterProps!.fds?.find(fd =>
			fd.guard === undefined && fd.determinants.length === 1 && fd.determinants[0] === 2 && fd.dependents.includes(1));
		expect(aToB?.kind, 'activated bi-FD {1}->{2} is a determination').to.equal('determination');
		expect(bToA?.kind, 'activated bi-FD {2}->{1} is a determination').to.equal('determination');
		const ecs = filterProps!.equivClasses ?? [];
		const hasEc = ecs.some(c => c.includes(1) && c.includes(2));
		expect(hasEc, 'value-equality lifted as EC {1,2}').to.equal(true);
	});

	it("without status='active' the guarded FD does not activate", async () => {
		await setupRegionTable();
		// No WHERE clause — the table reference itself surfaces the guarded FD,
		// and no operator should expose the body FDs unguarded.
		const rows = await planRows(db, 'SELECT * FROM t');
		const anyUnguardedActivation = rows.some(r => {
			if (!r.physical) return false;
			const props = JSON.parse(r.physical) as PhysicalProps;
			return fdHas(props.fds, [1], [2]) || fdHas(props.fds, [2], [1]);
		});
		expect(anyUnguardedActivation, 'no node should have activated guard without status=active').to.equal(false);
	});

	describe('Partial UNIQUE → guarded FD', () => {
		const setupPartialUnique = async (): Promise<void> => {
			await db.exec(
				"CREATE TABLE p (" +
				" id INTEGER PRIMARY KEY," +
				" c TEXT NOT NULL," +
				" status TEXT NOT NULL," +
				" region TEXT NOT NULL," +
				" amt INTEGER NOT NULL" +
				") USING memory"
			);
			await db.exec("CREATE UNIQUE INDEX ix_p_active ON p(c) WHERE status = 'active'");
		};

		it("table reference carries a guarded FD with eq-literal guard on `status`", async () => {
			await setupPartialUnique();
			const rows = await planRows(db, 'SELECT * FROM p');
			const props = physicalOf(rows, r => /TABLEREF/i.test(r.op))
				?? physicalOf(rows, r => /SCAN/i.test(r.op));
			expect(props, 'expected table-ref physical props').to.not.equal(undefined);
			// Columns: id=0, c=1, status=2, region=3, amt=4.
			const guardedFd = props!.fds?.find(fd =>
				fd.guard !== undefined &&
				fd.determinants.length === 1 &&
				fd.determinants[0] === 1 &&
				fd.guard.clauses.length === 1 &&
				fd.guard.clauses[0].kind === 'eq-literal' &&
				(fd.guard.clauses[0] as { kind: 'eq-literal'; column: number }).column === 2,
			);
			expect(guardedFd, 'expected guarded FD c → others with eq-literal status guard').to.not.equal(undefined);
		});

		it("filter with status='active' activates the guard: c → other-columns becomes unguarded", async () => {
			await setupPartialUnique();
			const rows = await planRows(db, "SELECT * FROM p WHERE status = 'active'");
			const filterProps = physicalOf(rows, r => r.op === 'FILTER');
			expect(filterProps, 'expected Filter physical props').to.not.equal(undefined);
			// Columns: id=0, c=1, status=2, region=3, amt=4.
			// The activated FD's determinant is [1]; dependents should cover id/region/amt
			// (status is pinned by the filter binding and may be merged or split).
			const activated = filterProps!.fds?.find(fd =>
				fd.guard === undefined &&
				fd.determinants.length === 1 &&
				fd.determinants[0] === 1 &&
				fd.dependents.includes(0) &&
				fd.dependents.includes(3) &&
				fd.dependents.includes(4),
			);
			expect(activated, 'expected activated unconditional FD c → others').to.not.equal(undefined);
		});

		it("filter with operand-flipped 'active' = status also activates the guard", async () => {
			await setupPartialUnique();
			const rows = await planRows(db, "SELECT * FROM p WHERE 'active' = status");
			const filterProps = physicalOf(rows, r => r.op === 'FILTER');
			expect(filterProps, 'expected Filter physical props').to.not.equal(undefined);
			const activated = filterProps!.fds?.some(fd =>
				fd.guard === undefined &&
				fd.determinants.length === 1 &&
				fd.determinants[0] === 1 &&
				fd.dependents.length > 0,
			);
			expect(activated, 'expected operand-flipped predicate to discharge the guard').to.equal(true);
		});

		it("filter with status='inactive' (wrong literal) does NOT activate the guard", async () => {
			await setupPartialUnique();
			const rows = await planRows(db, "SELECT * FROM p WHERE status = 'inactive'");
			const filterProps = physicalOf(rows, r => r.op === 'FILTER');
			expect(filterProps, 'expected Filter physical props').to.not.equal(undefined);
			const anyUnconditionalCKey = filterProps!.fds?.some(fd =>
				fd.guard === undefined &&
				fd.determinants.length === 1 &&
				fd.determinants[0] === 1 &&
				fd.dependents.includes(0),
			);
			expect(anyUnconditionalCKey ?? false, 'wrong filter must not activate guard').to.equal(false);
		});

		it("filter superset (status='active' AND amt > 5) still activates the guard", async () => {
			await setupPartialUnique();
			const rows = await planRows(db, "SELECT * FROM p WHERE status = 'active' AND amt > 5");
			const filterProps = physicalOf(rows, r => r.op === 'FILTER');
			expect(filterProps, 'expected Filter physical props').to.not.equal(undefined);
			const activated = filterProps!.fds?.some(fd =>
				fd.guard === undefined &&
				fd.determinants.length === 1 &&
				fd.determinants[0] === 1 &&
				fd.dependents.includes(0),
			);
			expect(activated, 'extra conjuncts in filter are harmless to entailment').to.equal(true);
		});

		it("multi-conjunct partial predicate requires all conjuncts in the filter", async () => {
			await db.exec(
				"CREATE TABLE p2 (" +
				" id INTEGER PRIMARY KEY," +
				" c TEXT NOT NULL," +
				" status TEXT NOT NULL," +
				" region TEXT NOT NULL" +
				") USING memory"
			);
			await db.exec("CREATE UNIQUE INDEX ix_p2 ON p2(c) WHERE status = 'active' AND region = 'us'");

			// Both conjuncts present ⇒ activated.
			{
				const rows = await planRows(db, "SELECT * FROM p2 WHERE status = 'active' AND region = 'us'");
				const fp = physicalOf(rows, r => r.op === 'FILTER');
				expect(fp).to.not.equal(undefined);
				const activated = fp!.fds?.some(fd =>
					fd.guard === undefined &&
					fd.determinants.length === 1 &&
					fd.determinants[0] === 1 &&
					fd.dependents.includes(0),
				);
				expect(activated, 'matching multi-conjunct filter activates').to.equal(true);
			}

			// Single conjunct only ⇒ NOT activated (the other guard clause remains unsatisfied).
			{
				const rows = await planRows(db, "SELECT * FROM p2 WHERE status = 'active'");
				const fp = physicalOf(rows, r => r.op === 'FILTER');
				expect(fp).to.not.equal(undefined);
				const guardedSurvives = fp!.fds?.some(fd =>
					fd.guard !== undefined &&
					fd.determinants.length === 1 &&
					fd.determinants[0] === 1,
				);
				const wronglyActivated = fp!.fds?.some(fd =>
					fd.guard === undefined &&
					fd.determinants.length === 1 &&
					fd.determinants[0] === 1 &&
					fd.dependents.includes(0),
				);
				expect(wronglyActivated ?? false, 'partial entailment must not activate').to.equal(false);
				expect(guardedSurvives, 'guarded FD should still be present, waiting for a stronger filter').to.equal(true);
			}
		});

		it("nullable UC column suppresses the FD (NOT-NULL gate) — no guarded FD on the source", async () => {
			await db.exec(
				"CREATE TABLE pn (" +
				" id INTEGER PRIMARY KEY," +
				" c TEXT NULL," +
				" status TEXT NOT NULL" +
				") USING memory"
			);
			await db.exec("CREATE UNIQUE INDEX ix_pn ON pn(c) WHERE status = 'active'");
			const rows = await planRows(db, 'SELECT * FROM pn');
			const props = physicalOf(rows, r => /TABLEREF/i.test(r.op))
				?? physicalOf(rows, r => /SCAN/i.test(r.op));
			expect(props, 'expected table-ref physical props').to.not.equal(undefined);
			const partialFd = props!.fds?.find(fd =>
				fd.guard !== undefined &&
				fd.determinants.length === 1 &&
				fd.determinants[0] === 1,
			);
			expect(partialFd, 'NOT-NULL gate must suppress the partial-UC FD').to.equal(undefined);
		});

		// -----------------------------------------------------------------
		// IN-list partial UNIQUE (or-of guard discharge)
		// -----------------------------------------------------------------

		const setupInListUnique = async (): Promise<void> => {
			await db.exec(
				"CREATE TABLE pin (" +
				" id INTEGER PRIMARY KEY," +
				" c TEXT NOT NULL," +
				" status TEXT NOT NULL" +
				") USING memory"
			);
			await db.exec("CREATE UNIQUE INDEX ix_pin ON pin(c) WHERE status IN ('active', 'pending')");
		};

		it("partial UNIQUE WHERE status IN (...): filter status IN (subset) activates the guard", async () => {
			await setupInListUnique();
			const rows = await planRows(db, "SELECT * FROM pin WHERE status IN ('active', 'pending')");
			const filterProps = physicalOf(rows, r => r.op === 'FILTER');
			expect(filterProps, 'expected Filter physical props').to.not.equal(undefined);
			// Columns: id=0, c=1, status=2.
			const activated = filterProps!.fds?.some(fd =>
				fd.guard === undefined &&
				fd.determinants.length === 1 &&
				fd.determinants[0] === 1 &&
				fd.dependents.includes(0),
			);
			expect(activated, 'matching IN-list filter activates partial-UC FD').to.equal(true);
		});

		it("partial UNIQUE WHERE status IN (...): filter status='active' (singleton subset) activates", async () => {
			await setupInListUnique();
			const rows = await planRows(db, "SELECT * FROM pin WHERE status = 'active'");
			const filterProps = physicalOf(rows, r => r.op === 'FILTER');
			expect(filterProps, 'expected Filter physical props').to.not.equal(undefined);
			const activated = filterProps!.fds?.some(fd =>
				fd.guard === undefined &&
				fd.determinants.length === 1 &&
				fd.determinants[0] === 1 &&
				fd.dependents.includes(0),
			);
			expect(activated, 'singleton subset of IN-list activates').to.equal(true);
		});

		it("partial UNIQUE WHERE status IN (...): wrong-literal filter status='inactive' does NOT activate", async () => {
			await setupInListUnique();
			const rows = await planRows(db, "SELECT * FROM pin WHERE status = 'inactive'");
			const filterProps = physicalOf(rows, r => r.op === 'FILTER');
			expect(filterProps, 'expected Filter physical props').to.not.equal(undefined);
			const wronglyActivated = filterProps!.fds?.some(fd =>
				fd.guard === undefined &&
				fd.determinants.length === 1 &&
				fd.determinants[0] === 1 &&
				fd.dependents.includes(0),
			);
			expect(wronglyActivated ?? false, 'literal outside IN-set must not activate').to.equal(false);
		});

		it("partial UNIQUE WHERE status IN (...): filter IN (mixed superset) does NOT activate", async () => {
			await setupInListUnique();
			const rows = await planRows(db, "SELECT * FROM pin WHERE status IN ('active', 'expired')");
			const filterProps = physicalOf(rows, r => r.op === 'FILTER');
			expect(filterProps, 'expected Filter physical props').to.not.equal(undefined);
			const wronglyActivated = filterProps!.fds?.some(fd =>
				fd.guard === undefined &&
				fd.determinants.length === 1 &&
				fd.determinants[0] === 1 &&
				fd.dependents.includes(0),
			);
			expect(wronglyActivated ?? false, "filter's IN-set must be a subset of the partial's IN-set").to.equal(false);
		});

		// -----------------------------------------------------------------
		// OR partial UNIQUE (or-of mixed-shape guard discharge)
		// -----------------------------------------------------------------

		it("partial UNIQUE WHERE deleted_at IS NULL OR status='archived': either disjunct activates", async () => {
			await db.exec(
				"CREATE TABLE por (" +
				" id INTEGER PRIMARY KEY," +
				" c TEXT NOT NULL," +
				" status TEXT NOT NULL," +
				" deleted_at TEXT NULL" +
				") USING memory"
			);
			await db.exec("CREATE UNIQUE INDEX ix_por ON por(c) WHERE deleted_at IS NULL OR status = 'archived'");

			const anyNodeHasActivatedCKey = (rs: readonly PlanRow[]): boolean =>
				rs.some(r => {
					if (!r.physical) return false;
					const props = JSON.parse(r.physical) as PhysicalProps;
					return fdHas(props.fds, [1], [0]);
				});

			// Filter deleted_at IS NULL: activates (sub-clause directly entailed).
			{
				const rows = await planRows(db, "SELECT * FROM por WHERE deleted_at IS NULL");
				expect(anyNodeHasActivatedCKey(rows), 'IS NULL disjunct activates OR-guard').to.equal(true);
			}

			// Filter status='archived': activates (the other sub-clause).
			{
				const rows = await planRows(db, "SELECT * FROM por WHERE status = 'archived'");
				expect(anyNodeHasActivatedCKey(rows), 'eq-literal disjunct activates OR-guard').to.equal(true);
			}

			// Filter id=1 — matches neither disjunct: no activation.
			{
				const rows = await planRows(db, "SELECT * FROM por WHERE id = 1");
				expect(anyNodeHasActivatedCKey(rows), 'unrelated filter must not activate').to.equal(false);
			}
		});

		// -----------------------------------------------------------------
		// NOT col partial UNIQUE (rewritten to col=0)
		// -----------------------------------------------------------------

		it("partial UNIQUE WHERE NOT archived (declared NOT NULL int): filter archived=0 or NOT archived activates", async () => {
			await db.exec(
				"CREATE TABLE pnot (" +
				" id INTEGER PRIMARY KEY," +
				" c TEXT NOT NULL," +
				" archived INTEGER NOT NULL" +
				") USING memory"
			);
			await db.exec("CREATE UNIQUE INDEX ix_pnot ON pnot(c) WHERE NOT archived");

			// Filter archived=0: should activate (same eq-literal{archived, 0}).
			{
				const rows = await planRows(db, "SELECT * FROM pnot WHERE archived = 0");
				const filterProps = physicalOf(rows, r => r.op === 'FILTER');
				expect(filterProps).to.not.equal(undefined);
				const activated = filterProps!.fds?.some(fd =>
					fd.guard === undefined &&
					fd.determinants.length === 1 &&
					fd.determinants[0] === 1 &&
					fd.dependents.includes(0),
				);
				expect(activated, 'archived=0 activates NOT-rewritten guard').to.equal(true);
			}

			// Filter NOT archived: should activate (rewritten to archived=0).
			{
				const rows = await planRows(db, "SELECT * FROM pnot WHERE NOT archived");
				const filterProps = physicalOf(rows, r => r.op === 'FILTER');
				expect(filterProps).to.not.equal(undefined);
				const activated = filterProps!.fds?.some(fd =>
					fd.guard === undefined &&
					fd.determinants.length === 1 &&
					fd.determinants[0] === 1 &&
					fd.dependents.includes(0),
				);
				expect(activated, 'NOT archived activates NOT-rewritten guard').to.equal(true);
			}

			// Filter archived=1: should NOT activate.
			{
				const rows = await planRows(db, "SELECT * FROM pnot WHERE archived = 1");
				const filterProps = physicalOf(rows, r => r.op === 'FILTER');
				expect(filterProps).to.not.equal(undefined);
				const wronglyActivated = filterProps!.fds?.some(fd =>
					fd.guard === undefined &&
					fd.determinants.length === 1 &&
					fd.determinants[0] === 1 &&
					fd.dependents.includes(0),
				);
				expect(wronglyActivated ?? false, 'archived=1 must not activate').to.equal(false);
			}
		});

		// -----------------------------------------------------------------
		// Range partial UNIQUE — subset subsumption
		// -----------------------------------------------------------------

		const setupRangeUnique = async (): Promise<void> => {
			await db.exec(
				"CREATE TABLE prng (" +
				" id INTEGER PRIMARY KEY," +
				" c TEXT NOT NULL," +
				" created_at TEXT NOT NULL" +
				") USING memory"
			);
			await db.exec("CREATE UNIQUE INDEX ix_prng ON prng(c) WHERE created_at >= '2025-01-01'");
		};

		it("partial UNIQUE WHERE created_at >= 'D': stronger filter activates the guard", async () => {
			await setupRangeUnique();
			const rows = await planRows(db, "SELECT * FROM prng WHERE created_at >= '2025-06-01'");
			const filterProps = physicalOf(rows, r => r.op === 'FILTER');
			expect(filterProps, 'expected Filter physical props').to.not.equal(undefined);
			// Columns: id=0, c=1, created_at=2.
			const activated = filterProps!.fds?.some(fd =>
				fd.guard === undefined &&
				fd.determinants.length === 1 &&
				fd.determinants[0] === 1 &&
				fd.dependents.includes(0),
			);
			expect(activated, 'stronger range filter activates the partial-UC FD').to.equal(true);
		});

		it("partial UNIQUE WHERE created_at >= 'D': weaker filter does NOT activate", async () => {
			await setupRangeUnique();
			const rows = await planRows(db, "SELECT * FROM prng WHERE created_at >= '2024-01-01'");
			const filterProps = physicalOf(rows, r => r.op === 'FILTER');
			expect(filterProps, 'expected Filter physical props').to.not.equal(undefined);
			const wronglyActivated = filterProps!.fds?.some(fd =>
				fd.guard === undefined &&
				fd.determinants.length === 1 &&
				fd.determinants[0] === 1 &&
				fd.dependents.includes(0),
			);
			expect(wronglyActivated ?? false, 'weaker range filter must not activate').to.equal(false);
		});
	});

	it("LEFT OUTER JOIN drops right-side guarded FDs", async () => {
		await db.exec("CREATE TABLE l (id INTEGER PRIMARY KEY, v TEXT) USING memory");
		await db.exec(
			"CREATE TABLE r (id INTEGER PRIMARY KEY, status TEXT, x TEXT, y TEXT," +
			" CHECK (status <> 'a' OR x = y)" +
			") USING memory"
		);
		const rows = await planRows(db, 'SELECT * FROM l LEFT JOIN r ON l.id = r.id');
		const joinProps =
			physicalOf(rows, r => r.op === 'HASHJOIN') ??
			physicalOf(rows, r => r.op === 'JOIN') ??
			physicalOf(rows, r => /JOIN/i.test(r.op));
		expect(joinProps, 'expected join physical props').to.not.equal(undefined);
		// No guarded FD from right's CHECK should survive in the join output.
		const surviving = joinProps!.fds?.filter(fd => fd.guard !== undefined) ?? [];
		expect(surviving).to.have.length(0);
	});
});
