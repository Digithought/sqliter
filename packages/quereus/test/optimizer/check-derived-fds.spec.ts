import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import {
	extractCheckConstraints,
} from '../../src/planner/analysis/check-extraction.js';
import type { ConstantBinding, DomainConstraint } from '../../src/planner/nodes/plan-node.js';
import type { RowConstraintSchema, RowOpMask } from '../../src/schema/table.js';
import { DEFAULT_ROWOP_MASK, RowOpFlag } from '../../src/schema/table.js';
import type * as AST from '../../src/parser/ast.js';
import type { DeclaredColumnInfo } from '../../src/planner/analysis/comparison-collation.js';
import { INTEGER_TYPE, TEXT_TYPE } from '../../src/types/builtin-types.js';
import { TIMESPAN_TYPE } from '../../src/types/temporal-types.js';
import { JSON_TYPE } from '../../src/types/json-type.js';

// ---------------------------------------------------------------------------
// AST builders for unit tests
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

function and(left: AST.Expression, right: AST.Expression): AST.BinaryExpr {
	return bin('AND', left, right);
}

function or(left: AST.Expression, right: AST.Expression): AST.BinaryExpr {
	return bin('OR', left, right);
}

function between(expr: AST.Expression, lower: AST.Expression, upper: AST.Expression, not = false): AST.BetweenExpr {
	return { type: 'between', expr, lower, upper, not };
}

function inExpr(expr: AST.Expression, values: AST.Expression[]): AST.InExpr {
	return { type: 'in', expr, values };
}

function fn(name: string, ...args: AST.Expression[]): AST.FunctionExpr {
	return { type: 'function', name, args };
}

function check(expr: AST.Expression): RowConstraintSchema {
	return { expr, operations: DEFAULT_ROWOP_MASK };
}

function qcol(table: string, name: string): AST.ColumnExpr {
	return { type: 'column', name, table };
}

function checkWith(expr: AST.Expression, overrides: Partial<RowConstraintSchema>): RowConstraintSchema {
	return { expr, operations: DEFAULT_ROWOP_MASK, ...overrides };
}

const colMap = new Map<string, number>([
	['a', 0],
	['b', 1],
	['c', 2],
	['x', 3],
	['y', 4],
	['status', 5],
	['qty', 6],
	['alt_status', 7],
]);

const allDeterministic = () => true;

// BINARY-declared TEXT metadata for every column — the value-discrimination
// gate is a pass-through for these shapes; collation-gate behavior has its own
// describe block below.
const colMeta: DeclaredColumnInfo[] = Array.from(
	{ length: colMap.size },
	() => ({ collation: 'BINARY', logicalType: TEXT_TYPE }),
);

// ---------------------------------------------------------------------------
// Unit tests for extractCheckConstraints
// ---------------------------------------------------------------------------

describe('extractCheckConstraints (unit)', () => {
	it('check (a = b) emits bi-directional FDs and an EC pair', () => {
		const result = extractCheckConstraints([check(bin('=', col('a'), col('b')))], colMap, allDeterministic, colMeta);
		expect(result.fds).to.have.length(2);
		expect(result.fds.some(fd => fd.determinants.includes(0) && fd.dependents.includes(1))).to.equal(true);
		expect(result.fds.some(fd => fd.determinants.includes(1) && fd.dependents.includes(0))).to.equal(true);
		expect(result.equivPairs).to.deep.equal([[0, 1]]);
		expect(result.constantBindings).to.have.length(0);
		expect(result.domainConstraints).to.have.length(0);
	});

	it("check (status = 'a') emits ∅ → status FD plus a literal binding", () => {
		const result = extractCheckConstraints([check(bin('=', col('status'), lit('a')))], colMap, allDeterministic, colMeta);
		expect(result.fds).to.have.length(1);
		expect(result.fds[0].determinants).to.deep.equal([]);
		expect(result.fds[0].dependents).to.deep.equal([5]);
		expect(result.constantBindings).to.have.length(1);
		expect(result.constantBindings[0].attrs).to.deep.equal([5]);
		expect(result.constantBindings[0].value).to.deep.equal({ kind: 'literal', value: 'a' });
		expect(result.domainConstraints).to.have.length(0);
	});

	it('check (qty >= 0) emits a range domain with inclusive lower bound', () => {
		const result = extractCheckConstraints([check(bin('>=', col('qty'), lit(0)))], colMap, allDeterministic, colMeta);
		expect(result.domainConstraints).to.have.length(1);
		const d = result.domainConstraints[0];
		expect(d.kind).to.equal('range');
		if (d.kind !== 'range') return;
		expect(d.column).to.equal(6);
		expect(d.min).to.equal(0);
		expect(d.minInclusive).to.equal(true);
		expect(d.max).to.equal(undefined);
		expect(result.fds).to.have.length(0);
	});

	it('check (qty between 0 and 100) emits a range with both inclusive bounds', () => {
		const result = extractCheckConstraints(
			[check(between(col('qty'), lit(0), lit(100)))],
			colMap,
			allDeterministic,
			colMeta,
		);
		expect(result.domainConstraints).to.have.length(1);
		const d = result.domainConstraints[0];
		expect(d.kind).to.equal('range');
		if (d.kind !== 'range') return;
		expect(d.column).to.equal(6);
		expect(d.min).to.equal(0);
		expect(d.max).to.equal(100);
		expect(d.minInclusive).to.equal(true);
		expect(d.maxInclusive).to.equal(true);
	});

	it('check (qty > 0 and qty < 100) emits two range domains (intersection deferred)', () => {
		const result = extractCheckConstraints(
			[check(and(bin('>', col('qty'), lit(0)), bin('<', col('qty'), lit(100))))],
			colMap,
			allDeterministic,
			colMeta,
		);
		expect(result.domainConstraints).to.have.length(2);
		const lower = result.domainConstraints.find(d => d.kind === 'range' && d.min !== undefined) as DomainConstraint & { kind: 'range' } | undefined;
		const upper = result.domainConstraints.find(d => d.kind === 'range' && d.max !== undefined) as DomainConstraint & { kind: 'range' } | undefined;
		expect(lower?.min).to.equal(0);
		expect(lower?.minInclusive).to.equal(false);
		expect(upper?.max).to.equal(100);
		expect(upper?.maxInclusive).to.equal(false);
	});

	it("check (status in ('a','i','d')) emits an enum domain", () => {
		const result = extractCheckConstraints(
			[check(inExpr(col('status'), [lit('a'), lit('i'), lit('d')]))],
			colMap,
			allDeterministic,
			colMeta,
		);
		expect(result.domainConstraints).to.have.length(1);
		const d = result.domainConstraints[0];
		expect(d.kind).to.equal('enum');
		if (d.kind !== 'enum') return;
		expect(d.column).to.equal(5);
		expect(d.values).to.deep.equal(['a', 'i', 'd']);
	});

	it("check (a = b and status = 'a') decomposes into FDs, EC, and a binding", () => {
		const result = extractCheckConstraints(
			[check(and(bin('=', col('a'), col('b')), bin('=', col('status'), lit('a'))))],
			colMap,
			allDeterministic,
			colMeta,
		);
		expect(result.fds.length).to.be.greaterThanOrEqual(3);
		expect(result.equivPairs).to.deep.equal([[0, 1]]);
		expect(result.constantBindings).to.have.length(1);
		expect(result.constantBindings[0].value).to.deep.equal({ kind: 'literal', value: 'a' });
	});

	it('check (a = b or x = y) — disjunction contributes nothing', () => {
		const result = extractCheckConstraints(
			[check(or(bin('=', col('a'), col('b')), bin('=', col('x'), col('y'))))],
			colMap,
			allDeterministic,
			colMeta,
		);
		expect(result.fds).to.have.length(0);
		expect(result.equivPairs).to.have.length(0);
		expect(result.constantBindings).to.have.length(0);
		expect(result.domainConstraints).to.have.length(0);
	});

	it('check (a > b) — non-equality column-column emits no FD or domain', () => {
		const result = extractCheckConstraints(
			[check(bin('>', col('a'), col('b')))],
			colMap,
			allDeterministic,
			colMeta,
		);
		expect(result.fds).to.have.length(0);
		expect(result.domainConstraints).to.have.length(0);
	});

	it('check (b = a + 1) — single-column RHS yields one-way FD a → b, no EC, no binding, no domain', () => {
		const result = extractCheckConstraints(
			[check(bin('=', col('b'), bin('+', col('a'), lit(1))))],
			colMap,
			allDeterministic,
			colMeta,
		);
		expect(result.fds).to.have.length(1);
		expect(result.fds[0].determinants).to.deep.equal([0]);
		expect(result.fds[0].dependents).to.deep.equal([1]);
		expect(result.equivPairs).to.have.length(0);
		expect(result.constantBindings).to.have.length(0);
		expect(result.domainConstraints).to.have.length(0);
	});

	it('check (b = a + c) — two columns on RHS contributes nothing', () => {
		const result = extractCheckConstraints(
			[check(bin('=', col('b'), bin('+', col('a'), col('c'))))],
			colMap,
			allDeterministic,
			colMeta,
		);
		expect(result.fds).to.have.length(0);
	});

	it('check (0 < qty) — column on RHS of inequality is normalized via flipComparison', () => {
		const result = extractCheckConstraints(
			[check(bin('<', lit(0), col('qty')))],
			colMap,
			allDeterministic,
			colMeta,
		);
		expect(result.domainConstraints).to.have.length(1);
		const d = result.domainConstraints[0];
		expect(d.kind).to.equal('range');
		if (d.kind !== 'range') return;
		expect(d.column).to.equal(6);
		// `0 < qty` flips to `qty > 0` → strict lower bound at 0, no upper.
		expect(d.min).to.equal(0);
		expect(d.minInclusive).to.equal(false);
		expect(d.max).to.equal(undefined);
	});

	it('check (a == b) — the `==` operator alias is recognized as equality', () => {
		const result = extractCheckConstraints([check(bin('==', col('a'), col('b')))], colMap, allDeterministic, colMeta);
		expect(result.fds).to.have.length(2);
		expect(result.equivPairs).to.deep.equal([[0, 1]]);
	});

	it('check (b = some_nondeterministic_fn(a)) — non-deterministic call drops the whole check', () => {
		const isDeterministic = (fnName: string) => fnName !== 'random_fn';
		const result = extractCheckConstraints(
			[check(bin('=', col('b'), fn('random_fn', col('a'))))],
			colMap,
			isDeterministic,
			colMeta,
		);
		expect(result.fds).to.have.length(0);
		expect(result.constantBindings).to.have.length(0);
		expect(result.domainConstraints).to.have.length(0);
	});
});

// ---------------------------------------------------------------------------
// Row-invariant gate — ticket check-extraction-rowop-mask-transition-checks,
// refined per-conjunct by ticket check-extraction-per-conjunct-old-screen.
// A CHECK contributes facts only when its operation mask covers INSERT and
// UPDATE (enforcement filters by `shouldCheckConstraint`, so other masks
// leave entry paths unenforced) and it is not deferred. `old.` row-image
// references (OLD is NULL on the INSERT path, so old.-form predicates are
// transition constraints, not row invariants) are screened per AND-conjunct:
// the conjunct containing the ref is skipped, sibling conjuncts extract
// normally; an `old.` ref inside a non-AND shape (e.g. an OR disjunct) still
// kills that entire conjunct.
// ---------------------------------------------------------------------------

describe('extractCheckConstraints row-invariant gate', () => {
	function expectEmpty(result: ReturnType<typeof extractCheckConstraints>): void {
		expect(result.fds).to.have.length(0);
		expect(result.equivPairs).to.have.length(0);
		expect(result.constantBindings).to.have.length(0);
		expect(result.domainConstraints).to.have.length(0);
	}

	const shapes: Array<[string, AST.Expression]> = [
		['a = b', bin('=', col('a'), col('b'))],
		['qty >= 0', bin('>=', col('qty'), lit(0))],
		["status in ('a','i')", inExpr(col('status'), [lit('a'), lit('i')])],
	];

	const nonQualifyingMasks: Array<[string, RowOpMask]> = [
		['insert-only', RowOpFlag.INSERT],
		['update-only', RowOpFlag.UPDATE],
		['delete-only', RowOpFlag.DELETE],
		['insert|delete', (RowOpFlag.INSERT | RowOpFlag.DELETE) as RowOpMask],
		['update|delete', (RowOpFlag.UPDATE | RowOpFlag.DELETE) as RowOpMask],
	];

	for (const [maskName, mask] of nonQualifyingMasks) {
		it(`${maskName} mask extracts nothing (equality, range, and in shapes)`, () => {
			for (const [, expr] of shapes) {
				expectEmpty(extractCheckConstraints(
					[checkWith(expr, { operations: mask })], colMap, allDeterministic, colMeta));
			}
		});
	}

	it('insert|update and insert|update|delete masks extract as before', () => {
		const qualifying: RowOpMask[] = [
			DEFAULT_ROWOP_MASK,
			(RowOpFlag.INSERT | RowOpFlag.UPDATE | RowOpFlag.DELETE) as RowOpMask,
		];
		for (const mask of qualifying) {
			const eq = extractCheckConstraints(
				[checkWith(bin('=', col('a'), col('b')), { operations: mask })], colMap, allDeterministic, colMeta);
			expect(eq.fds).to.have.length(2);
			expect(eq.equivPairs).to.deep.equal([[0, 1]]);
			const range = extractCheckConstraints(
				[checkWith(bin('>=', col('qty'), lit(0)), { operations: mask })], colMap, allDeterministic, colMeta);
			expect(range.domainConstraints).to.have.length(1);
		}
	});

	it('deferrable / initiallyDeferred checks extract nothing (defensive — not declarable via SQL today)', () => {
		expectEmpty(extractCheckConstraints(
			[checkWith(bin('=', col('a'), col('b')), { deferrable: true })], colMap, allDeterministic, colMeta));
		expectEmpty(extractCheckConstraints(
			[checkWith(bin('=', col('a'), col('b')), { initiallyDeferred: true })], colMap, allDeterministic, colMeta));
	});

	it('old. as a plain operand kills the check (old.a = b)', () => {
		expectEmpty(extractCheckConstraints(
			[check(bin('=', qcol('old', 'a'), col('b')))], colMap, allDeterministic, colMeta));
	});

	it('old. buried in a compound RHS kills the check (a = old.b + 1)', () => {
		expectEmpty(extractCheckConstraints(
			[check(bin('=', col('a'), bin('+', qcol('old', 'b'), lit(1))))], colMap, allDeterministic, colMeta));
	});

	it('old. in an implication-form guard disjunct kills the check', () => {
		expectEmpty(extractCheckConstraints(
			[check(or(bin('<>', qcol('old', 'status'), lit('x')), bin('=', col('a'), col('b'))))],
			colMap, allDeterministic, colMeta));
	});

	it('old. in BETWEEN and IN shapes kills the check', () => {
		expectEmpty(extractCheckConstraints(
			[check(between(qcol('old', 'qty'), lit(0), lit(100)))], colMap, allDeterministic, colMeta));
		expectEmpty(extractCheckConstraints(
			[check(inExpr(qcol('old', 'status'), [lit('a')]))], colMap, allDeterministic, colMeta));
	});

	it('OLD qualifier matches case-insensitively', () => {
		expectEmpty(extractCheckConstraints(
			[check(bin('=', qcol('OLD', 'a'), col('b')))], colMap, allDeterministic, colMeta));
	});

	it('a gated check does not suppress sibling checks in the same array', () => {
		const result = extractCheckConstraints([
			check(bin('=', qcol('old', 'a'), col('b'))),
			checkWith(bin('=', col('x'), col('y')), { operations: RowOpFlag.INSERT }),
			check(bin('>=', col('qty'), lit(0))),
		], colMap, allDeterministic, colMeta);
		expect(result.fds).to.have.length(0);
		expect(result.equivPairs).to.have.length(0);
		expect(result.constantBindings).to.have.length(0);
		expect(result.domainConstraints).to.have.length(1);
		expect(result.domainConstraints[0].column).to.equal(6);
	});

	it("mixed check ((old.a is null or a = old.a) and status in ('a','i')) contributes exactly the status enum", () => {
		const isNull = (e: AST.Expression): AST.UnaryExpr => ({ type: 'unary', operator: 'IS NULL', expr: e });
		const result = extractCheckConstraints(
			[check(and(
				or(isNull(qcol('old', 'a')), bin('=', col('a'), qcol('old', 'a'))),
				inExpr(col('status'), [lit('a'), lit('i')]),
			))],
			colMap, allDeterministic, colMeta);
		// Nothing from the old-conjunct...
		expect(result.fds).to.have.length(0);
		expect(result.equivPairs).to.have.length(0);
		expect(result.constantBindings).to.have.length(0);
		// ...but the invariant sibling conjunct contributes its enum domain.
		expect(result.domainConstraints).to.deep.equal([
			{ kind: 'enum', column: 5, values: ['a', 'i'] },
		]);
	});

	it('old. inside an OR disjunct kills that whole conjunct, not just the disjunct', () => {
		// Implication-form OR with an old.-ref guard: the per-conjunct argument
		// does not extend through OR, so the entire OR conjunct is skipped —
		// while the AND-sibling range conjunct still extracts.
		const result = extractCheckConstraints(
			[check(and(
				or(bin('<>', qcol('old', 'status'), lit('x')), bin('=', col('a'), col('b'))),
				bin('>=', col('qty'), lit(0)),
			))],
			colMap, allDeterministic, colMeta);
		expect(result.fds).to.have.length(0);
		expect(result.equivPairs).to.have.length(0);
		expect(result.constantBindings).to.have.length(0);
		expect(result.domainConstraints).to.have.length(1);
		expect(result.domainConstraints[0].column).to.equal(6);
	});

	it('new.a = b extracts identically to a = b (NEW is the stored row image)', () => {
		const qualified = extractCheckConstraints(
			[check(bin('=', qcol('new', 'a'), col('b')))], colMap, allDeterministic, colMeta);
		const bare = extractCheckConstraints(
			[check(bin('=', col('a'), col('b')))], colMap, allDeterministic, colMeta);
		expect(qualified).to.deep.equal(bare);
		expect(qualified.equivPairs).to.deep.equal([[0, 1]]);
	});
});

// ---------------------------------------------------------------------------
// Value-discrimination (collation) gate — ticket
// check-extraction-collation-blind-fds. Facts may only be minted when the
// enforcement comparison is BINARY for textual operands (enforcement resolves
// declared column collations plus explicit COLLATE wrappers).
// ---------------------------------------------------------------------------

describe('extractCheckConstraints collation gate', () => {
	function collateAst(expr: AST.Expression, collation: string): AST.CollateExpr {
		return { type: 'collate', expr, collation };
	}

	function metaWith(overrides: Record<number, DeclaredColumnInfo>): DeclaredColumnInfo[] {
		const m = colMeta.slice();
		for (const [idx, info] of Object.entries(overrides)) m[Number(idx)] = info;
		return m;
	}

	const NOCASE_TEXT: DeclaredColumnInfo = { collation: 'NOCASE', logicalType: TEXT_TYPE };
	const NOCASE_INT: DeclaredColumnInfo = { collation: 'NOCASE', logicalType: INTEGER_TYPE };

	it('col = col with a NOCASE-declared side mints no FDs, EC pair, or bindings', () => {
		const result = extractCheckConstraints(
			[check(bin('=', col('a'), col('b')))],
			colMap, allDeterministic, metaWith({ 0: NOCASE_TEXT }),
		);
		expect(result.fds).to.have.length(0);
		expect(result.equivPairs).to.have.length(0);
		expect(result.constantBindings).to.have.length(0);
	});

	it('col = literal on a NOCASE-declared text column mints no pin or binding', () => {
		const result = extractCheckConstraints(
			[check(bin('=', col('status'), lit('a')))],
			colMap, allDeterministic, metaWith({ 5: NOCASE_TEXT }),
		);
		expect(result.fds).to.have.length(0);
		expect(result.constantBindings).to.have.length(0);
	});

	it('col = (col collate nocase) mints no one-way FD even over BINARY-declared columns (R1 shape)', () => {
		const result = extractCheckConstraints(
			[check(bin('=', col('b'), collateAst(col('c'), 'NOCASE')))],
			colMap, allDeterministic, colMeta,
		);
		expect(result.fds).to.have.length(0);
	});

	it('col = (col collate binary) keeps the one-way FD (BINARY wrapper subtree)', () => {
		const result = extractCheckConstraints(
			[check(bin('=', col('b'), collateAst(col('c'), 'binary')))],
			colMap, allDeterministic, colMeta,
		);
		expect(result.fds).to.have.length(1);
		expect(result.fds[0].determinants).to.deep.equal([2]);
		expect(result.fds[0].dependents).to.deep.equal([1]);
	});

	it('an inert declared collation on a non-textual column keeps equality facts', () => {
		const result = extractCheckConstraints(
			[check(bin('=', col('qty'), lit(5)))],
			colMap, allDeterministic, metaWith({ 6: NOCASE_INT }),
		);
		expect(result.fds).to.have.length(1);
		expect(result.constantBindings).to.have.length(1);
	});

	it('text domains under a NOCASE-declared column are suppressed (range, BETWEEN, IN enum)', () => {
		const m = metaWith({ 5: NOCASE_TEXT });
		const range = extractCheckConstraints([check(bin('>=', col('status'), lit('m')))], colMap, allDeterministic, m);
		expect(range.domainConstraints).to.have.length(0);
		const btw = extractCheckConstraints([check(between(col('status'), lit('a'), lit('z')))], colMap, allDeterministic, m);
		expect(btw.domainConstraints).to.have.length(0);
		const enm = extractCheckConstraints([check(inExpr(col('status'), [lit('a'), lit('b')]))], colMap, allDeterministic, m);
		expect(enm.domainConstraints).to.have.length(0);
	});

	it('numeric domains on a non-textual column keep extracting despite an inert declared collation', () => {
		const m = metaWith({ 6: NOCASE_INT });
		const range = extractCheckConstraints([check(bin('>=', col('qty'), lit(0)))], colMap, allDeterministic, m);
		expect(range.domainConstraints).to.have.length(1);
		const enm = extractCheckConstraints([check(inExpr(col('qty'), [lit(1), lit(2)]))], colMap, allDeterministic, m);
		expect(enm.domainConstraints).to.have.length(1);
	});

	it('a NOCASE-collate-wrapped IN value suppresses the enum domain', () => {
		const result = extractCheckConstraints(
			[check(inExpr(col('status'), [lit('a'), collateAst(lit('b'), 'NOCASE')]))],
			colMap, allDeterministic, colMeta,
		);
		expect(result.domainConstraints).to.have.length(0);
	});
});

// ---------------------------------------------------------------------------
// Semantic-ordering gate on cross-column facts — invariant OPT-051, ticket
// check-derived-equivalence-ignores-semantic-ordering. TIMESPAN and JSON
// compare by meaning, not stored text ('PT1H' = 'PT60M'), so a mixed pair such
// as `d timespan` / `s text` shares no notion of "same value" and may mint no
// cross-column fact. Constant pins stay ungated (a pin claims only that the
// column compares equal to the literal under its own comparison).
// ---------------------------------------------------------------------------

describe('extractCheckConstraints semantic-ordering gate', () => {
	function metaWith(overrides: Record<number, DeclaredColumnInfo>): DeclaredColumnInfo[] {
		const m = colMeta.slice();
		for (const [idx, info] of Object.entries(overrides)) m[Number(idx)] = info;
		return m;
	}

	const TS: DeclaredColumnInfo = { collation: 'BINARY', logicalType: TIMESPAN_TYPE };
	const JSONC: DeclaredColumnInfo = { collation: 'BINARY', logicalType: JSON_TYPE };

	// `a` (0) semantic, `b` (1) plain text — the headline mixed pair.
	const mixed = metaWith({ 0: TS });
	// Both semantic and the SAME type — the over-declining control.
	const sameType = metaWith({ 0: TS, 1: TS });

	function expectNoCrossColumnFacts(
		result: ReturnType<typeof extractCheckConstraints>,
		why: string,
	): void {
		expect(result.fds, `${why}: FDs`).to.have.length(0);
		expect(result.equivPairs, `${why}: EC pair`).to.have.length(0);
	}

	it('check (timespan_col = text_col) mints no mirror FDs and no EC pair, in both operand orders', () => {
		expectNoCrossColumnFacts(
			extractCheckConstraints([check(bin('=', col('a'), col('b')))], colMap, allDeterministic, mixed),
			'timespan = text');
		expectNoCrossColumnFacts(
			extractCheckConstraints([check(bin('=', col('b'), col('a')))], colMap, allDeterministic, mixed),
			'text = timespan');
	});

	it('check (timespan_col = json_col) — two DIFFERENT semantic types are declined too', () => {
		expectNoCrossColumnFacts(
			extractCheckConstraints(
				[check(bin('=', col('a'), col('b')))], colMap, allDeterministic, metaWith({ 0: TS, 1: JSONC })),
			'timespan = json');
	});

	it('check (json_col = text_col) mints no cross-column facts', () => {
		expectNoCrossColumnFacts(
			extractCheckConstraints(
				[check(bin('=', col('a'), col('b')))], colMap, allDeterministic, metaWith({ 0: JSONC })),
			'json = text');
	});

	it('check (timespan_col = timespan_col) still mints both mirror FDs and the EC pair', () => {
		const result = extractCheckConstraints(
			[check(bin('=', col('a'), col('b')))], colMap, allDeterministic, sameType);
		expect(result.fds).to.have.length(2);
		expect(result.fds.some(fd => fd.determinants.includes(0) && fd.dependents.includes(1))).to.equal(true);
		expect(result.fds.some(fd => fd.determinants.includes(1) && fd.dependents.includes(0))).to.equal(true);
		expect(result.equivPairs).to.deep.equal([[0, 1]]);
	});

	it("check (timespan_col = 'PT1H') keeps its ∅ → col pin and binding — pins are ungated", () => {
		const result = extractCheckConstraints(
			[check(bin('=', col('a'), lit('PT1H')))], colMap, allDeterministic, mixed);
		expect(result.fds).to.have.length(1);
		expect(result.fds[0].determinants).to.deep.equal([]);
		expect(result.fds[0].dependents).to.deep.equal([0]);
		expect(result.constantBindings).to.have.length(1);
		expect(result.constantBindings[0].attrs).to.deep.equal([0]);
		expect(result.constantBindings[0].value).to.deep.equal({ kind: 'literal', value: 'PT1H' });
	});

	// --- Arm 3: the one-way `col = expr` determination. -----------------------

	it('check (text_col = trim(timespan_col)) mints no one-way FD across a mixed pair', () => {
		expectNoCrossColumnFacts(
			extractCheckConstraints(
				[check(bin('=', col('b'), fn('trim', col('a'))))], colMap, allDeterministic, mixed),
			'text = trim(timespan)');
		// Operand order reversed: the expression on the left.
		expectNoCrossColumnFacts(
			extractCheckConstraints(
				[check(bin('=', fn('trim', col('a')), col('b')))], colMap, allDeterministic, mixed),
			'trim(timespan) = text');
	});

	it('check (timespan_col = trim(timespan_col)) keeps the one-way FD for a same-type pair', () => {
		const result = extractCheckConstraints(
			[check(bin('=', col('b'), fn('trim', col('a'))))], colMap, allDeterministic, sameType);
		expect(result.fds).to.have.length(1);
		expect(result.fds[0].determinants).to.deep.equal([0]);
		expect(result.fds[0].dependents).to.deep.equal([1]);
	});

	// --- Arm 2: the implication form `g <> lit or d = s`. ---------------------
	// No query shape has been found where a guarded mixed pair returns a wrong
	// row (guard activation writes the class onto the Filter itself, which
	// `rule-predicate-inference-equivalence` does not read), so the extractor
	// output IS the assertion here — see the ticket's arm-2 note.

	it('implication-form check (status <> 1 or timespan_col = text_col) mints no guarded mirror pair', () => {
		expectNoCrossColumnFacts(
			extractCheckConstraints(
				[check(or(bin('<>', col('status'), lit(1)), bin('=', col('a'), col('b'))))],
				colMap, allDeterministic, mixed),
			'guarded timespan = text');
	});

	it('implication-form check over a same-type pair keeps its guarded mirror FDs and the valueEquality tag', () => {
		const result = extractCheckConstraints(
			[check(or(bin('<>', col('status'), lit(1)), bin('=', col('a'), col('b'))))],
			colMap, allDeterministic, sameType);
		expect(result.fds).to.have.length(2);
		expect(result.fds.every(fd => fd.valueEquality === true), 'valueEquality tag survives').to.equal(true);
		expect(result.fds.every(fd => fd.guard !== undefined), 'guard survives').to.equal(true);
		// Equivalences/bindings are unconditional facts — never lifted from a guarded body.
		expect(result.equivPairs).to.have.length(0);
		expect(result.constantBindings).to.have.length(0);
	});

	it('implication-form one-way body (status <> 1 or text_col = trim(timespan_col)) is declined', () => {
		expectNoCrossColumnFacts(
			extractCheckConstraints(
				[check(or(bin('<>', col('status'), lit(1)), bin('=', col('b'), fn('trim', col('a')))))],
				colMap, allDeterministic, mixed),
			'guarded text = trim(timespan)');
		// Same-type control keeps it.
		const kept = extractCheckConstraints(
			[check(or(bin('<>', col('status'), lit(1)), bin('=', col('b'), fn('trim', col('a')))))],
			colMap, allDeterministic, sameType);
		expect(kept.fds).to.have.length(1);
		expect(kept.fds[0].determinants).to.deep.equal([0]);
		expect(kept.fds[0].dependents).to.deep.equal([1]);
	});
});

// ---------------------------------------------------------------------------
// End-to-end propagation through query_plan(...)
// ---------------------------------------------------------------------------

interface PhysicalProps {
	fds?: { determinants: number[]; dependents: number[]; kind: 'unique' | 'determination' }[];
	equivClasses?: number[][];
	constantBindings?: ConstantBinding[];
	domainConstraints?: DomainConstraint[];
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

describe('CHECK-derived FDs/domains: end-to-end propagation', () => {
	let db: Database;

	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	// The one-way determination FD `{a}→{b}` from `check (b = a + 1)` now folds
	// onto the TableReference unconditionally as `kind: 'determination'`. The
	// kind-aware readers (`isUniqueDeterminant`) never read a determination as a
	// uniqueness claim, so a narrow `select distinct a, b` over a non-keyed table
	// cannot re-derive `{a}` as a phantom key — the old producer-side gate
	// (ticket fd-oneway-determination-key-bag-overclaim) is subsumed (ticket
	// fd-determination-reader-side-rule). Both arms pin the kinds: a mere
	// determination when `a` is not a key, upgradable to 'unique' when it is.
	it('table with check (b = a + 1): the one-way FD a → b folds as a determination when a is not a key', async () => {
		// `id` is the PK, so neither `a` (col 1) nor `b` (col 2) is a key.
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER, b INTEGER, CHECK (b = a + 1)) USING memory");
		const rows = await planRows(db, 'SELECT * FROM t');
		const props = physicalOf(rows, r => r.op === 'TABLEREF' || r.op === 'TABLEREFERENCE' || r.node_type === 'TableReference')
			?? physicalOf(rows, r => r.op === 'SEQSCAN' || r.op === 'SEQ SCAN' || r.op === 'INDEXSCAN');
		expect(props, 'expected physical props on a leaf').to.not.equal(undefined);
		// `a` is column index 1, `b` is column index 2 — kept, as a pure value claim.
		const fd = props!.fds?.find(fd => fd.determinants.length === 1 && fd.determinants[0] === 1 && fd.dependents.includes(2));
		expect(fd, 'one-way FD a → b folds as a determination').to.not.equal(undefined);
		expect(fd!.kind, 'a is not a key ⇒ a pure value claim').to.equal('determination');
	});

	it('table with check (b = a + 1): the one-way FD a → b is PRESENT when a is the PK', async () => {
		// `a` (col 0) is the PK, so `{a}→{b}` is a sound key — the gate keeps it.
		await db.exec("CREATE TABLE t (a INTEGER PRIMARY KEY, b INTEGER, CHECK (b = a + 1)) USING memory");
		const rows = await planRows(db, 'SELECT * FROM t');
		const props = physicalOf(rows, r => r.op === 'TABLEREF' || r.op === 'TABLEREFERENCE' || r.node_type === 'TableReference')
			?? physicalOf(rows, r => r.op === 'SEQSCAN' || r.op === 'SEQ SCAN' || r.op === 'INDEXSCAN');
		expect(props, 'expected physical props on a leaf').to.not.equal(undefined);
		// `a` is column index 0, `b` is column index 1.
		const fd = props!.fds?.find(fd => fd.determinants.length === 1 && fd.determinants[0] === 0 && fd.dependents.includes(1));
		expect(fd, 'expected FD a → b (a is the real key)').to.not.equal(undefined);
	});

	it("table with check (status in ('a','i')): TableReference carries the enum domain", async () => {
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, status TEXT, CHECK (status in ('a','i'))) USING memory");
		const rows = await planRows(db, 'SELECT * FROM t');
		const props = physicalOf(rows, r => r.op === 'SEQSCAN' || r.op === 'SEQ SCAN')
			?? physicalOf(rows, r => r.node_type === 'TableReference')
			?? physicalOf(rows, r => r.op.includes('SCAN'));
		expect(props, 'expected physical props on a leaf').to.not.equal(undefined);
		const enumDomain = props!.domainConstraints?.find(d => d.kind === 'enum' && d.column === 1);
		expect(enumDomain, 'expected enum domain on status (col 1)').to.not.equal(undefined);
	});

	it("check (status = 'a') exposes ∅ → status FD at the table reference", async () => {
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, status TEXT, CHECK (status = 'a')) USING memory");
		const rows = await planRows(db, 'SELECT status FROM t');
		// Look at any leaf or filter where the FD might surface.
		const candidate = rows
			.map(r => r.physical ? JSON.parse(r.physical) as PhysicalProps : undefined)
			.find(p => p?.fds?.some(fd => fd.determinants.length === 0 && fd.dependents.includes(1)));
		expect(candidate, 'expected ∅ → status FD somewhere in plan').to.not.equal(undefined);
	});

	it('Filter pass-through: domains on the source survive at the Filter', async () => {
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, x INTEGER, qty INTEGER, CHECK (qty >= 0)) USING memory");
		const rows = await planRows(db, 'SELECT * FROM t WHERE x > 0');
		const filterProps = physicalOf(rows, r => r.op === 'FILTER');
		expect(filterProps, 'expected Filter physical props').to.not.equal(undefined);
		const range = filterProps!.domainConstraints?.find(d => d.kind === 'range' && d.column === 2);
		expect(range, 'expected range domain on qty (col 2) to survive').to.not.equal(undefined);
	});

	it('Inner join: domain on inner side survives at the join output', async () => {
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, status TEXT, CHECK (status in ('a','i'))) USING memory");
		await db.exec("CREATE TABLE u (id INTEGER PRIMARY KEY, payload TEXT) USING memory");
		const rows = await planRows(db, 'SELECT * FROM t JOIN u ON t.id = u.id');
		const props = physicalOf(rows, r => /JOIN/i.test(r.op));
		expect(props, 'expected join physical props').to.not.equal(undefined);
		// t has cols {id=0, status=1}; join output has u columns starting at col 2.
		const enumDomain = props!.domainConstraints?.find(d => d.kind === 'enum' && d.column === 1);
		expect(enumDomain, 'expected enum domain on status (col 1) to survive').to.not.equal(undefined);
	});

	it('Left outer join: domains on the nullable (right) side are dropped', async () => {
		await db.exec("CREATE TABLE l (id INTEGER PRIMARY KEY, payload TEXT) USING memory");
		await db.exec("CREATE TABLE r (id INTEGER PRIMARY KEY, status TEXT, CHECK (status in ('a','i'))) USING memory");
		const rows = await planRows(db, 'SELECT * FROM l LEFT JOIN r ON l.id = r.id');
		const props = physicalOf(rows, r => /JOIN/i.test(r.op));
		expect(props, 'expected join physical props').to.not.equal(undefined);
		// Left's two columns at indices 0 and 1; right's status at index 3.
		const survived = props!.domainConstraints?.find(d => d.column === 3);
		expect(survived, 'right-side domain must not survive a left outer').to.equal(undefined);
	});

	it("EC closure: check (status = 'a') AND (status = alt_status) pins both columns to 'a'", async () => {
		await db.exec(
			"CREATE TABLE t (id INTEGER PRIMARY KEY, status TEXT, alt_status TEXT, " +
			"CHECK (status = 'a'), CHECK (status = alt_status)) USING memory"
		);
		const rows = await planRows(db, 'SELECT id, status, alt_status FROM t');
		// Find the leaf where bindings should surface (table ref or scan).
		const candidate = rows
			.map(r => r.physical ? JSON.parse(r.physical) as PhysicalProps : undefined)
			.find(p => p?.constantBindings && p.constantBindings.length > 0);
		expect(candidate, 'expected at least one constant binding').to.not.equal(undefined);
		// status=col1, alt_status=col2 — both should appear in some binding's attrs.
		const allAttrs = new Set<number>();
		for (const cb of candidate!.constantBindings ?? []) {
			for (const a of cb.attrs) allAttrs.add(a);
		}
		expect(allAttrs.has(1), "binding should cover 'status' (col 1)").to.equal(true);
		expect(allAttrs.has(2), "binding should cover 'alt_status' (col 2) via EC closure").to.equal(true);
	});

	it('Project drops domains on columns it does not project', async () => {
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, status TEXT, CHECK (status in ('a','i'))) USING memory");
		const rows = await planRows(db, 'SELECT id FROM t');
		const projProps = physicalOf(rows, r => r.op === 'PROJECT');
		if (!projProps) return; // Some plans skip Project for SELECT id of a single column.
		// Whatever domains survive must not reference the dropped status column index.
		const surviving = projProps.domainConstraints ?? [];
		// Status was source col 1; after projection only id (col 0) remains, so the
		// status domain shouldn't surface at the projection output.
		expect(surviving.every(d => d.column === 0), 'no domain should reference dropped status').to.equal(true);
	});
});
