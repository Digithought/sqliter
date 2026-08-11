/**
 * `BinaryOpNode.getType()` — the logical type a binary expression advertises (ticket
 * `binary-op-result-types-match-runtime`).
 *
 * The property under test is not "operator X announces type Y" for its own sake, but that
 * the announcement and the value agree: every case below asserts the announced type AND
 * that the value the runtime actually produces inhabits it (`conformsToType`, the same R2
 * predicate the statement-egress checker and the DML write path use). That pairing is what
 * catches the drift this ticket fixed — `select 'a' == 'a'` announced TEXT and returned a
 * boolean.
 *
 * The classification itself (`analysis/binary-operator-class.ts`) is unit-tested at the
 * bottom, since it is now the single list both `generateType` and `buildBinaryOpSpec`
 * dispatch on.
 */

import { expect } from 'chai';
import { Database } from '../src/index.js';
import { Parser } from '../src/parser/parser.js';
import type * as AST from '../src/parser/ast.js';
import type { SqlValue } from '../src/common/types.js';
import { PlanNode } from '../src/planner/nodes/plan-node.js';
import { BinaryOpNode } from '../src/planner/nodes/scalar.js';
import { conformsToType } from '../src/types/representation.js';
import { classifyBinaryOperator } from '../src/planner/analysis/binary-operator-class.js';
import { isComparisonOperator } from '../src/planner/analysis/comparison-collation.js';

describe('BinaryOpNode static type', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	/** The outermost BinaryOpNode in a logically-planned statement. */
	function findBinary(sql: string): BinaryOpNode {
		const ast = new Parser().parse(sql) as unknown as AST.Statement;
		const { plan } = db._buildPlan([ast]);
		let found: BinaryOpNode | undefined;
		const visit = (n: PlanNode): void => {
			if (found) return;
			if (n instanceof BinaryOpNode) { found = n; return; }
			for (const c of n.getChildren()) visit(c);
			for (const r of n.getRelations()) visit(r);
		};
		visit(plan);
		if (!found) throw new Error(`no BinaryOpNode in plan for: ${sql}`);
		return found;
	}

	async function firstValue(sql: string): Promise<SqlValue> {
		for await (const r of db.eval(sql)) return (r as { v: SqlValue }).v;
		throw new Error(`no row for: ${sql}`);
	}

	/**
	 * Assert `select <expr> as v` announces `typeName` and that its value inhabits the
	 * announced type. Both halves matter — either alone passes while they disagree.
	 */
	async function expectAnnouncedAndInhabited(expr: string, typeName: string): Promise<SqlValue> {
		const sql = `select ${expr} as v`;
		const announced = findBinary(sql).getType().logicalType;
		expect(announced.name, `announced type of ${expr}`).to.equal(typeName);

		const value = await firstValue(sql);
		expect(value, `${expr} produced NULL, which tests nothing here`).to.not.equal(null);
		expect(
			conformsToType(value as Exclude<SqlValue, null>, announced),
			`value ${String(value)} (${typeof value}) of ${expr} does not inhabit announced ${typeName}`,
		).to.equal(true);
		return value;
	}

	describe('comparison, logical and pattern-matching operators announce BOOLEAN', () => {
		// `==` and `XOR` and `LIKE` reach the planner with those exact spellings — the
		// parser normalizes `<>` to `!=` and desugars BETWEEN, which is why those two were
		// already correct while these three were not.
		it('announces BOOLEAN for == (was TEXT — the left operand type)', async () => {
			expect(await expectAnnouncedAndInhabited(`'a' == 'a'`, 'BOOLEAN')).to.equal(true);
		});

		it('announces BOOLEAN for XOR (was REAL — the left operand type)', async () => {
			expect(await expectAnnouncedAndInhabited(`1 xor 0`, 'BOOLEAN')).to.equal(true);
		});

		it('announces BOOLEAN for LIKE (was TEXT — the left operand type)', async () => {
			expect(await expectAnnouncedAndInhabited(`'ab' like 'a%'`, 'BOOLEAN')).to.equal(true);
		});

		it('keeps BOOLEAN for the spellings that were already right', async () => {
			expect(await expectAnnouncedAndInhabited(`'a' <> 'b'`, 'BOOLEAN')).to.equal(true);
			expect(await expectAnnouncedAndInhabited(`1 < 2`, 'BOOLEAN')).to.equal(true);
			expect(await expectAnnouncedAndInhabited(`1 and 1`, 'BOOLEAN')).to.equal(true);
			expect(await expectAnnouncedAndInhabited(`0 or 1`, 'BOOLEAN')).to.equal(true);
		});

		it('classifies a lowercase keyword operator, as internally built ASTs spell it', () => {
			// util/mutation-statement.ts synthesizes `operator: 'and'`; a case-sensitive
			// switch announced such a node as its left operand's type.
			expect(classifyBinaryOperator('and')).to.equal('logical');
			expect(classifyBinaryOperator('like')).to.equal('like');
			expect(classifyBinaryOperator('xor')).to.equal('logical');
		});
	});

	describe('arithmetic with a non-numeric operand announces ANY', () => {
		// The runtime sniffs each pair of values: a duration-shaped string yields a
		// TIMESPAN string, an ordinary string coerces to a number. No single concrete type
		// describes both, so the announcement is ANY.
		it('announces ANY for a numeric-looking TEXT operand (was TEXT; produces a number)', async () => {
			expect(await expectAnnouncedAndInhabited(`'123' + 0`, 'ANY')).to.equal(123);
		});

		it('announces ANY for a non-numeric TEXT operand (was TEXT; produces a number)', async () => {
			expect(await expectAnnouncedAndInhabited(`'abc' + 0`, 'ANY')).to.equal(0);
		});

		it('leaves nested arithmetic over such an expression unchanged', async () => {
			// The outer `+` now sees an ANY left operand rather than TEXT, so it takes the
			// generic coercing path instead of the temporal-fallback path. Same answer.
			expect(await expectAnnouncedAndInhabited(`('123' + 0) + 1`, 'ANY')).to.equal(124);
		});

		it('keeps the numeric-promotion arm', async () => {
			expect(findBinary('select 1 + 2 as v').getType().logicalType.isNumeric).to.equal(true);
			expect(findBinary('select 1 + 2.5 as v').getType().logicalType.name).to.equal('REAL');
		});

		it('keeps the temporal-operation-table arm', async () => {
			await db.exec('create table dts (id integer primary key, a date not null, b date not null)');
			// `date - date` is a TIMESPAN per types/temporal-ops.ts, not ANY.
			expect(findBinary('select a - b as v from dts').getType().logicalType.name).to.equal('TIMESPAN');
		});
	});

	describe('concatenation', () => {
		it('still announces TEXT', async () => {
			expect(await expectAnnouncedAndInhabited(`'a' || 'b'`, 'TEXT')).to.equal('ab');
		});
	});

	describe('operator classification is shared', () => {
		it('is case-insensitive and covers every spelling the emitter dispatches on', () => {
			const expected: Record<string, string> = {
				'+': 'arithmetic', '-': 'arithmetic', '*': 'arithmetic', '/': 'arithmetic', '%': 'arithmetic',
				'=': 'comparison', '==': 'comparison', '!=': 'comparison', '<>': 'comparison',
				'<': 'comparison', '<=': 'comparison', '>': 'comparison', '>=': 'comparison',
				'IS': 'is', 'is not': 'is',
				'IN': 'in', 'in': 'in',
				'AND': 'logical', 'or': 'logical', 'Xor': 'logical',
				'||': 'concat',
				'LIKE': 'like',
			};
			for (const [op, cls] of Object.entries(expected)) {
				expect(classifyBinaryOperator(op), op).to.equal(cls);
			}
		});

		it('returns undefined for an unimplemented spelling', () => {
			expect(classifyBinaryOperator('&')).to.equal(undefined);
			expect(classifyBinaryOperator('<<')).to.equal(undefined);
		});

		it('announces ANY, not the left operand type, for an unimplemented spelling', () => {
			// Nothing can execute such a node — buildBinaryOpSpec raises UNSUPPORTED — so
			// the announcement must not claim a type no value will ever be produced for.
			const node = new BinaryOpNode(
				findBinary(`select 'a' || 'b' as v`).scope,
				{ type: 'binary', operator: '&', left: { type: 'literal', value: 'a' }, right: { type: 'literal', value: 1 } },
				findBinary(`select 'a' || 'b' as v`).left,
				findBinary(`select 'a' || 'b' as v`).right,
			);
			expect(node.getType().logicalType.name).to.equal('ANY');
		});

		it('drives isComparisonOperator off the same classification', () => {
			for (const op of ['=', '==', '!=', '<>', '<', '<=', '>', '>=', 'IS', 'IS NOT', 'is not']) {
				expect(isComparisonOperator(op), op).to.equal(true);
			}
			// LIKE stays out: buildLikeOpSpec ignores collation, so a conflict raised here
			// would be about a collation the operator never applies.
			for (const op of ['||', 'AND', 'OR', 'XOR', '+', 'LIKE', 'IN']) {
				expect(isComparisonOperator(op), op).to.equal(false);
			}
		});
	});
});
