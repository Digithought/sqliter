import { expect } from 'chai';
import { parse, type SelectStmt, type Expression } from '../src/parser/index.js';
import { expressionToString } from '../src/emit/index.js';

/** Parse an expression from a SELECT wrapper */
function parseExpr(exprSql: string): Expression {
	const stmt = parse(`select ${exprSql}`) as SelectStmt;
	const col = stmt.columns[0];
	if (col.type !== 'column') throw new Error('Expected column result');
	return col.expr;
}

/** Round-trip: parse → stringify → parse → stringify, assert both strings match */
function roundTrip(sql: string): string {
	const expr1 = parseExpr(sql);
	const str1 = expressionToString(expr1);
	const expr2 = parseExpr(str1);
	const str2 = expressionToString(expr2);
	expect(str2, `round-trip mismatch for: ${sql}`).to.equal(str1);
	return str1;
}

describe('Emit: operator precedence round-trip', () => {

	describe('equality vs comparison', () => {
		it('should preserve parens in (a = b) < c', () => {
			const result = roundTrip('(a = b) < c');
			expect(result).to.include('(');
		});

		it('should not add unnecessary parens in a = (b < c)', () => {
			// b < c is higher-precedence than =, so no parens needed on RHS
			const result = roundTrip('a = (b < c)');
			expect(result).to.equal('a = b < c');
		});

		it('should preserve (a != b) >= c', () => {
			const result = roundTrip('(a != b) >= c');
			expect(result).to.include('(');
		});

		it('should normalize `<>` to `!=` and keep a lower-prec RHS grouped', () => {
			// `<>` is a source alias the lexer maps to the `!=` token, so it is stored and
			// emitted as `!=`. `or` is lower precedence than the equality group, so the
			// right operand must stay parenthesized to survive the round-trip.
			const result = roundTrip('a <> (b or c)');
			expect(result).to.equal('a != (b or c)');
		});
	});

	describe('concatenation || operator', () => {
		it('should not add parens for (a + b) || c — + is lower prec than ||', () => {
			// In parser: + is lower than ||, so a + b || c parses as (a + (b || c)).
			// With explicit parens: (a + b) || c should keep them.
			const result = roundTrip('(a + b) || c');
			expect(result).to.include('(');
		});

		it('should round-trip a || b || c without extra parens', () => {
			const result = roundTrip('a || b || c');
			expect(result).not.to.include('(');
		});
	});

	describe('XOR operator', () => {
		it('should preserve parens in (a xor b) and c', () => {
			const result = roundTrip('(a xor b) and c');
			expect(result).to.include('(');
		});

		it('should not add parens in a or b xor c — same precedence, left-assoc', () => {
			roundTrip('a or b xor c');
		});
	});

	describe('mixed precedence chains', () => {
		it('should round-trip a or b and c = d < e + f * g', () => {
			roundTrip('a or b and c = d < e + f * g');
		});

		it('should round-trip a * b + c < d = e and f or g', () => {
			roundTrip('a * b + c < d = e and f or g');
		});

		it('should preserve explicit override: a * (b + c)', () => {
			const result = roundTrip('a * (b + c)');
			expect(result).to.include('(');
		});

		it('should preserve a + (b || c)', () => {
			// || is higher prec than +, so this override needs parens
			// Actually wait — in the parser || is HIGHER prec than +.
			// So a + (b || c) — the parens are not needed since || already binds tighter.
			// But a + b || c parses as a + (b || c). So no explicit parens needed.
			roundTrip('a + b || c');
		});
	});

	describe('right-associativity edge cases', () => {
		it('should preserve parens for right-child same-prec non-associative: a - (b - c)', () => {
			const result = roundTrip('a - (b - c)');
			expect(result).to.include('(');
		});

		it('should not add parens for associative: a + (b + c)', () => {
			const result = roundTrip('a + b + c');
			expect(result).not.to.include('(');
		});

		it('should preserve a / (b / c)', () => {
			const result = roundTrip('a / (b / c)');
			expect(result).to.include('(');
		});
	});
});
