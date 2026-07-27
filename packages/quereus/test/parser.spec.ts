import { expect } from 'chai';
import { parse, parseAll, type BinaryExpr, type UnaryExpr, type LiteralExpr, type SelectStmt, type Expression, type BetweenExpr } from '../src/parser/index.js';
import { ParseError } from '../src/parser/parser.js';
import { astToString } from '../src/emit/index.js';
import type { CreateMaterializedViewStmt, RefreshMaterializedViewStmt, DropStmt } from '../src/parser/ast.js';

/** Shorthand to parse an expression from a SELECT wrapper */
function parseExpr(exprSql: string): Expression {
	const stmt = parse(`select ${exprSql}`) as SelectStmt;
	const col = stmt.columns[0];
	if (col.type !== 'column') throw new Error('Expected column result');
	return col.expr;
}

/** Assert a binary expression with given operator, returning it for further inspection */
function expectBinary(expr: Expression, operator: string): BinaryExpr {
	expect(expr.type).to.equal('binary');
	const bin = expr as BinaryExpr;
	expect(bin.operator).to.equal(operator);
	return bin;
}

/** Assert a unary expression with given operator */
function expectUnary(expr: Expression, operator: string): UnaryExpr {
	expect(expr.type).to.equal('unary');
	const un = expr as UnaryExpr;
	expect(un.operator).to.equal(operator);
	return un;
}

/** Assert a literal with the given value */
function expectLiteral(expr: Expression, value: unknown): void {
	expect(expr.type).to.equal('literal');
	expect((expr as LiteralExpr).value).to.equal(value);
}

describe('Parser', () => {

	describe('Operator Precedence', () => {
		it('should parse multiplication before addition: 1 + 2 * 3', () => {
			// Expected: 1 + (2 * 3) — addition at top, multiplication on right
			const expr = parseExpr('1 + 2 * 3');
			const add = expectBinary(expr, '+');
			expectLiteral(add.left, 1);
			const mul = expectBinary(add.right, '*');
			expectLiteral(mul.left, 2);
			expectLiteral(mul.right, 3);
		});

		it('should parse AND before OR: a OR b AND c', () => {
			const expr = parseExpr('1 OR 0 AND 1');
			const or = expectBinary(expr, 'OR');
			expectLiteral(or.left, 1);
			const and = expectBinary(or.right, 'AND');
			expectLiteral(and.left, 0);
			expectLiteral(and.right, 1);
		});

		it('should parse XOR at same level as OR', () => {
			// XOR and OR are same precedence, left-to-right
			const expr = parseExpr('1 OR 0 XOR 1');
			const xor = expectBinary(expr, 'XOR');
			const or = expectBinary(xor.left, 'OR');
			expectLiteral(or.left, 1);
			expectLiteral(or.right, 0);
			expectLiteral(xor.right, 1);
		});

		it('should parse comparison before equality: a = b < c', () => {
			// = is lower precedence than <, so: a = (b < c)
			const expr = parseExpr('1 = 2 < 3');
			const eq = expectBinary(expr, '=');
			expectLiteral(eq.left, 1);
			const lt = expectBinary(eq.right, '<');
			expectLiteral(lt.left, 2);
			expectLiteral(lt.right, 3);
		});

		it('should parse subtraction left-to-right: 10 - 3 - 2', () => {
			const expr = parseExpr('10 - 3 - 2');
			const outer = expectBinary(expr, '-');
			const inner = expectBinary(outer.left, '-');
			expectLiteral(inner.left, 10);
			expectLiteral(inner.right, 3);
			expectLiteral(outer.right, 2);
		});

		it('should parse concatenation: a || b || c', () => {
			const expr = parseExpr("'a' || 'b' || 'c'");
			const outer = expectBinary(expr, '||');
			const inner = expectBinary(outer.left, '||');
			expectLiteral(inner.left, 'a');
			expectLiteral(inner.right, 'b');
			expectLiteral(outer.right, 'c');
		});

		it('should respect parentheses: (1 + 2) * 3', () => {
			const expr = parseExpr('(1 + 2) * 3');
			const mul = expectBinary(expr, '*');
			const add = expectBinary(mul.left, '+');
			expectLiteral(add.left, 1);
			expectLiteral(add.right, 2);
			expectLiteral(mul.right, 3);
		});
	});

	describe('Unary Operators', () => {
		it('should parse unary minus', () => {
			const expr = parseExpr('-1');
			const un = expectUnary(expr, '-');
			expectLiteral(un.expr, 1);
		});

		it('should parse double negation: -(-1)', () => {
			const expr = parseExpr('-(-1)');
			const outer = expectUnary(expr, '-');
			const inner = expectUnary(outer.expr, '-');
			expectLiteral(inner.expr, 1);
		});

		it('should parse NOT operator', () => {
			const expr = parseExpr('NOT 1');
			const un = expectUnary(expr, 'NOT');
			expectLiteral(un.expr, 1);
		});

		it('should parse bitwise NOT (~)', () => {
			const expr = parseExpr('~5');
			const un = expectUnary(expr, '~');
			expectLiteral(un.expr, 5);
		});

		it('should parse stacked unary minus: - -1', () => {
			const expr = parseExpr('- -1');
			const outer = expectUnary(expr, '-');
			const inner = expectUnary(outer.expr, '-');
			expectLiteral(inner.expr, 1);
		});

		it('should parse NOT NOT x', () => {
			const expr = parseExpr('NOT NOT 1');
			const outer = expectUnary(expr, 'NOT');
			const inner = expectUnary(outer.expr, 'NOT');
			expectLiteral(inner.expr, 1);
		});

		it('should parse mixed stacked unary: ~-x', () => {
			const expr = parseExpr('~-5');
			const outer = expectUnary(expr, '~');
			const inner = expectUnary(outer.expr, '-');
			expectLiteral(inner.expr, 5);
		});

		it('should parse -a * b as (-a) * b', () => {
			const expr = parseExpr('-a * b');
			const mul = expectBinary(expr, '*');
			expectUnary(mul.left, '-');
		});
	});

	describe('IS NULL / IS NOT NULL', () => {
		it('should parse IS NULL', () => {
			const expr = parseExpr('1 IS NULL');
			const un = expectUnary(expr, 'IS NULL');
			expectLiteral(un.expr, 1);
		});

		it('should parse IS NOT NULL', () => {
			const expr = parseExpr('1 IS NOT NULL');
			const un = expectUnary(expr, 'IS NOT NULL');
			expectLiteral(un.expr, 1);
		});

		it('should not consume IS when not followed by NULL', () => {
			// "1 IS" without NULL should backtrack — the expression should just be the literal 1
			// This relies on the backtracking working correctly
			const expr = parseExpr('1');
			expectLiteral(expr, 1);
		});
	});

	describe('IS [NOT] TRUE / FALSE', () => {
		it('should parse IS TRUE', () => {
			const un = expectUnary(parseExpr('1 IS TRUE'), 'IS TRUE');
			expectLiteral(un.expr, 1);
		});

		it('should parse IS NOT TRUE', () => {
			const un = expectUnary(parseExpr('1 IS NOT TRUE'), 'IS NOT TRUE');
			expectLiteral(un.expr, 1);
		});

		it('should parse IS FALSE', () => {
			const un = expectUnary(parseExpr('1 IS FALSE'), 'IS FALSE');
			expectLiteral(un.expr, 1);
		});

		it('should parse IS NOT FALSE', () => {
			const un = expectUnary(parseExpr('1 IS NOT FALSE'), 'IS NOT FALSE');
			expectLiteral(un.expr, 1);
		});

		it('binds tighter than prefix NOT: not 1 is true → NOT(1 IS TRUE)', () => {
			const outer = expectUnary(parseExpr('not 1 is true'), 'NOT');
			const inner = expectUnary(outer.expr, 'IS TRUE');
			expectLiteral(inner.expr, 1);
		});

		it('still rejects a general IS <expr> (non-NULL/TRUE/FALSE)', () => {
			// The TRUE/FALSE additions must not consume tokens for the generic
			// `IS` path: `1 is x` backtracks the IS and leaves it dangling → parse error.
			expect(() => parse('select 1 is x')).to.throw();
		});
	});

	describe('Location Tracking', () => {
		it('should track locations on expression nodes', () => {
			const expr = parseExpr('1 + 2');
			expect(expr.loc).to.exist;
			expect(expr.loc!.start.line).to.be.a('number');
			expect(expr.loc!.start.column).to.be.a('number');
			expect(expr.loc!.end.line).to.be.a('number');
			expect(expr.loc!.end.column).to.be.a('number');
		});

		it('should track locations on binary chain expressions', () => {
			const expr = parseExpr('1 + 2 + 3');
			const outer = expectBinary(expr, '+');
			expect(outer.loc).to.exist;
			// The outer node should span from the start of '1' to the end of '3'
			expect(outer.loc!.start.offset).to.be.lessThan(outer.loc!.end.offset);
		});

		it('should track locations on statements', () => {
			const stmt = parse('select 1');
			expect(stmt.loc).to.exist;
		});
	});

	describe('Statement Parsing', () => {
		it('should parse multiple statements', () => {
			const stmts = parseAll('select 1; select 2');
			expect(stmts).to.have.length(2);
			expect(stmts[0].type).to.equal('select');
			expect(stmts[1].type).to.equal('select');
		});

		it('should parse SELECT without FROM', () => {
			const stmt = parse('select 1, 2, 3') as SelectStmt;
			expect(stmt.type).to.equal('select');
			expect(stmt.columns).to.have.length(3);
		});

		it('should parse SELECT with alias', () => {
			const stmt = parse('select 1 as num') as SelectStmt;
			expect(stmt.columns).to.have.length(1);
			const col = stmt.columns[0];
			expect(col.type).to.equal('column');
			if (col.type === 'column') {
				expect(col.alias).to.equal('num');
			}
		});

		it('should parse bare (no-AS) alias followed by another select item', () => {
			const stmt = parse('select 1 a, 2 b, 3 c') as SelectStmt;
			expect(stmt.columns).to.have.length(3);
			for (const [col, expected] of [[stmt.columns[0], 'a'], [stmt.columns[1], 'b'], [stmt.columns[2], 'c']] as const) {
				expect(col.type).to.equal('column');
				if (col.type === 'column') {
					expect(col.alias).to.equal(expected);
				}
			}
		});

		it('should parse bare alias mixed with an AS alias in the same list', () => {
			const stmt = parse('select 1 as num, 2 b') as SelectStmt;
			expect(stmt.columns).to.have.length(2);
			const [first, second] = stmt.columns;
			expect(first.type).to.equal('column');
			expect(second.type).to.equal('column');
			if (first.type === 'column') expect(first.alias).to.equal('num');
			if (second.type === 'column') expect(second.alias).to.equal('b');
		});

		it('should parse a bare alias before a window function column', () => {
			const stmt = parse('select o.k kk, row_number() over () rn from o') as SelectStmt;
			expect(stmt.columns).to.have.length(2);
			const [first, second] = stmt.columns;
			expect(first.type).to.equal('column');
			expect(second.type).to.equal('column');
			if (first.type === 'column') expect(first.alias).to.equal('kk');
			if (second.type === 'column') expect(second.alias).to.equal('rn');
		});

		it('should not treat a following column as an alias when there is no bare identifier gap', () => {
			const stmt = parse('select a, b from t') as SelectStmt;
			expect(stmt.columns).to.have.length(2);
			const [first, second] = stmt.columns;
			expect(first.type).to.equal('column');
			expect(second.type).to.equal('column');
			if (first.type === 'column') expect(first.alias).to.be.undefined;
			if (second.type === 'column') expect(second.alias).to.be.undefined;
		});

		it('should parse a bare table alias in a comma-separated FROM list', () => {
			const stmt = parse('select 1 from t a, u b') as SelectStmt;
			expect(stmt.from).to.have.length(2);
			const [first, second] = stmt.from!;
			expect(first.type).to.equal('table');
			expect(second.type).to.equal('table');
			if (first.type === 'table') expect(first.alias).to.equal('a');
			if (second.type === 'table') expect(second.alias).to.equal('b');
		});

		it('should parse a bare subquery alias in a comma-separated FROM list', () => {
			const stmt = parse('select 1 from (select 1) x, (select 2) y') as SelectStmt;
			expect(stmt.from).to.have.length(2);
			const [first, second] = stmt.from!;
			expect(first.type).to.equal('subquerySource');
			expect(second.type).to.equal('subquerySource');
			if (first.type === 'subquerySource') expect(first.alias).to.equal('x');
			if (second.type === 'subquerySource') expect(second.alias).to.equal('y');
		});

		it('should parse SELECT *', () => {
			const stmt = parse('select * from t') as SelectStmt;
			expect(stmt.columns).to.have.length(1);
			expect(stmt.columns[0].type).to.equal('all');
		});
	});

	describe('Error Handling', () => {
		it('should throw ParseError for incomplete statements', () => {
			expect(() => parse('select * from')).to.throw();
		});

		it('should throw on misspelled keywords', () => {
			expect(() => parse('CREAT TABLE t (a)')).to.throw();
		});

		it('should throw on unclosed parentheses', () => {
			expect(() => parse('select (1 + 2')).to.throw();
		});

		it('should throw on empty statement', () => {
			expect(() => parse('')).to.throw();
		});

		it('should include location information in parse errors', () => {
			try {
				parse('select * from');
				expect.fail('Should have thrown');
			} catch (e: unknown) {
				if (e instanceof ParseError) {
					expect(e.token).to.exist;
					expect(e.token.startLine).to.be.a('number');
				}
			}
		});

		it('should propagate a typed ParseError unchanged, preserving subclass and location', () => {
			// This site (unknown rename_policy value) is one of the few that throws
			// the ParseError subclass directly rather than the base QuereusError.
			try {
				parse(`apply schema temp options (rename_policy = 'bogus')`);
				expect.fail('Should have thrown');
			} catch (e: unknown) {
				expect(e).to.be.instanceOf(ParseError);
				const err = e as ParseError;
				expect(err.line).to.be.a('number');
				expect(err.column).to.be.a('number');
				expect(err.message).to.include('Unknown rename_policy');
			}
		});
	});

	describe('Equality Operators', () => {
		it('should parse = operator', () => {
			const expr = parseExpr('1 = 2');
			expectBinary(expr, '=');
		});

		it('should parse == operator', () => {
			const expr = parseExpr('1 == 2');
			expectBinary(expr, '==');
		});

		it('should parse != operator', () => {
			const expr = parseExpr('1 != 2');
			expectBinary(expr, '!=');
		});
	});

	describe('BETWEEN and IN', () => {
		it('should parse BETWEEN expression', () => {
			const expr = parseExpr('5 BETWEEN 1 AND 10');
			expect(expr.type).to.equal('between');
		});

		it('should parse IN with value list', () => {
			const expr = parseExpr('1 IN (1, 2, 3)');
			expect(expr.type).to.equal('in');
		});

		it('should parse NOT BETWEEN', () => {
			const expr = parseExpr('5 NOT BETWEEN 1 AND 10');
			expect(expr.type).to.equal('between');
			expect((expr as BetweenExpr).not).to.equal(true);
		});
	});

	describe('COLLATE', () => {
		it('should parse COLLATE expression', () => {
			const expr = parseExpr("'hello' COLLATE NOCASE");
			expect(expr.type).to.equal('collate');
		});
	});

	describe('CASE Expression', () => {
		it('should parse simple CASE', () => {
			const expr = parseExpr("CASE 1 WHEN 1 THEN 'one' ELSE 'other' END");
			expect(expr.type).to.equal('case');
		});

		it('should parse searched CASE', () => {
			const expr = parseExpr("CASE WHEN 1 > 0 THEN 'pos' ELSE 'neg' END");
			expect(expr.type).to.equal('case');
		});
	});

	describe('ALTER TABLE ALTER COLUMN', () => {
		it('parses SET NOT NULL', () => {
			const stmt = parse(`alter table t alter column c set not null`) as import('../src/parser/ast.js').AlterTableStmt;
			expect(stmt.type).to.equal('alterTable');
			expect(stmt.action.type).to.equal('alterColumn');
			expect(stmt.action).to.include({ type: 'alterColumn', columnName: 'c', setNotNull: true });
		});

		it('parses DROP NOT NULL', () => {
			const stmt = parse(`alter table t alter column c drop not null`) as import('../src/parser/ast.js').AlterTableStmt;
			expect(stmt.action).to.include({ type: 'alterColumn', columnName: 'c', setNotNull: false });
		});

		it('parses SET DATA TYPE', () => {
			const stmt = parse(`alter table t alter column c set data type real`) as import('../src/parser/ast.js').AlterTableStmt;
			expect(stmt.action).to.include({ type: 'alterColumn', columnName: 'c', setDataType: 'real' });
		});

		it('parses SET DEFAULT <expr>', () => {
			const stmt = parse(`alter table t alter column c set default 42`) as import('../src/parser/ast.js').AlterTableStmt;
			const action = stmt.action as Extract<import('../src/parser/ast.js').AlterTableAction, { type: 'alterColumn' }>;
			expect(action.columnName).to.equal('c');
			expect(action.setDefault).to.not.be.null;
			expect((action.setDefault as LiteralExpr).value).to.equal(42);
		});

		it('parses DROP DEFAULT', () => {
			const stmt = parse(`alter table t alter column c drop default`) as import('../src/parser/ast.js').AlterTableStmt;
			const action = stmt.action as Extract<import('../src/parser/ast.js').AlterTableAction, { type: 'alterColumn' }>;
			expect(action.columnName).to.equal('c');
			expect(action.setDefault).to.equal(null);
		});
	});

	describe('ALTER TABLE ADD / DROP TAGS (per-key tag mutation)', () => {
		type AlterTableStmt = import('../src/parser/ast.js').AlterTableStmt;

		// ── table level ──
		it('parses ADD TAGS at the table level as a merge setTags', () => {
			const stmt = parse(`alter table t add tags (audit = true)`) as AlterTableStmt;
			expect(stmt.action).to.deep.equal({
				type: 'setTags', target: { kind: 'table' }, mode: 'merge', tags: { audit: true },
			});
		});

		it('parses DROP TAGS at the table level as a dropTags', () => {
			const stmt = parse(`alter table t drop tags (audit, legacy)`) as AlterTableStmt;
			expect(stmt.action).to.deep.equal({
				type: 'dropTags', target: { kind: 'table' }, keys: ['audit', 'legacy'],
			});
		});

		it('parses the existing table-level SET TAGS with mode replace', () => {
			const stmt = parse(`alter table t set tags (a = 1)`) as AlterTableStmt;
			expect(stmt.action).to.deep.equal({
				type: 'setTags', target: { kind: 'table' }, mode: 'replace', tags: { a: 1 },
			});
		});

		it('treats ADD TAGS () / DROP TAGS () as empty (no-op) lists', () => {
			const add = parse(`alter table t add tags ()`) as AlterTableStmt;
			expect(add.action).to.deep.equal({ type: 'setTags', target: { kind: 'table' }, mode: 'merge', tags: {} });
			const drop = parse(`alter table t drop tags ()`) as AlterTableStmt;
			expect(drop.action).to.deep.equal({ type: 'dropTags', target: { kind: 'table' }, keys: [] });
		});

		// ── column level ──
		it('parses ALTER COLUMN ADD TAGS as a column merge', () => {
			const stmt = parse(`alter table t alter column c add tags (searchable = true)`) as AlterTableStmt;
			expect(stmt.action).to.deep.equal({
				type: 'setTags', target: { kind: 'column', columnName: 'c' }, mode: 'merge', tags: { searchable: true },
			});
		});

		it('parses ALTER COLUMN DROP TAGS as a column dropTags', () => {
			const stmt = parse(`alter table t alter column c drop tags (searchable)`) as AlterTableStmt;
			expect(stmt.action).to.deep.equal({
				type: 'dropTags', target: { kind: 'column', columnName: 'c' }, keys: ['searchable'],
			});
		});

		it('parses ALTER COLUMN SET TAGS with mode replace', () => {
			const stmt = parse(`alter table t alter column c set tags (a = 1)`) as AlterTableStmt;
			expect(stmt.action).to.deep.equal({
				type: 'setTags', target: { kind: 'column', columnName: 'c' }, mode: 'replace', tags: { a: 1 },
			});
		});

		// ── named-constraint level ──
		it('parses ALTER CONSTRAINT ADD TAGS as a constraint merge', () => {
			const stmt = parse(`alter table t alter constraint uq add tags (msg = 'dup')`) as AlterTableStmt;
			expect(stmt.action).to.deep.equal({
				type: 'setTags', target: { kind: 'constraint', constraintName: 'uq' }, mode: 'merge', tags: { msg: 'dup' },
			});
		});

		it('parses ALTER CONSTRAINT DROP TAGS as a constraint dropTags', () => {
			const stmt = parse(`alter table t alter constraint uq drop tags (msg)`) as AlterTableStmt;
			expect(stmt.action).to.deep.equal({
				type: 'dropTags', target: { kind: 'constraint', constraintName: 'uq' }, keys: ['msg'],
			});
		});

		it('parses ALTER CONSTRAINT SET TAGS with mode replace', () => {
			const stmt = parse(`alter table t alter constraint uq set tags (a = 1)`) as AlterTableStmt;
			expect(stmt.action).to.deep.equal({
				type: 'setTags', target: { kind: 'constraint', constraintName: 'uq' }, mode: 'replace', tags: { a: 1 },
			});
		});

		it('rejects an ALTER CONSTRAINT verb that is not SET / ADD / DROP', () => {
			expect(() => parse(`alter table t alter constraint uq rename tags (a)`)).to.throw();
		});

		// ── column-named-`tags` disambiguation (the `(` look-ahead guard) ──
		it('keeps ADD <col> / ADD COLUMN <col> parsing as ADD COLUMN even when the column is named tags', () => {
			const noKw = parse(`alter table t add tags integer`) as AlterTableStmt;
			expect(noKw.action.type).to.equal('addColumn');
			expect((noKw.action as Extract<typeof noKw.action, { type: 'addColumn' }>).column.name).to.equal('tags');

			const withKw = parse(`alter table t add column tags integer`) as AlterTableStmt;
			expect(withKw.action.type).to.equal('addColumn');
			expect((withKw.action as Extract<typeof withKw.action, { type: 'addColumn' }>).column.name).to.equal('tags');
		});

		it('keeps DROP <col> / DROP COLUMN <col> parsing as DROP COLUMN even when the column is named tags', () => {
			const noKw = parse(`alter table t drop tags`) as AlterTableStmt;
			expect(noKw.action).to.deep.equal({ type: 'dropColumn', name: 'tags' });

			const withKw = parse(`alter table t drop column tags`) as AlterTableStmt;
			expect(withKw.action).to.deep.equal({ type: 'dropColumn', name: 'tags' });
		});

		it('round-trips ADD / DROP TAGS through astToString', () => {
			for (const sql of [
				`alter table t add tags (audit = true)`,
				`alter table t drop tags (audit, legacy)`,
				`alter table t alter column c add tags (searchable = true)`,
				`alter table t alter column c drop tags (searchable)`,
				`alter table t alter constraint uq add tags (msg = 'dup')`,
				`alter table t alter constraint uq drop tags (msg)`,
			]) {
				const stmt = parse(sql);
				// Re-parse the stringified form and compare the action — proves the
				// emitter is parseable and structurally identical.
				const reparsed = parse(astToString(stmt));
				expect((reparsed as AlterTableStmt).action).to.deep.equal((stmt as AlterTableStmt).action);
			}
		});
	});

	describe('ALTER VIEW / MATERIALIZED VIEW / INDEX SET / ADD / DROP TAGS', () => {
		type AlterViewStmt = import('../src/parser/ast.js').AlterViewStmt;
		type AlterMaterializedViewStmt = import('../src/parser/ast.js').AlterMaterializedViewStmt;
		type AlterIndexStmt = import('../src/parser/ast.js').AlterIndexStmt;

		it('parses ALTER VIEW ... SET TAGS as a replace setTags', () => {
			const stmt = parse(`alter view v set tags (cacheable = true)`) as AlterViewStmt;
			expect(stmt.type).to.equal('alterView');
			expect(stmt.name.name).to.equal('v');
			expect(stmt.action).to.deep.equal({ type: 'setTags', mode: 'replace', tags: { cacheable: true } });
		});

		it('parses ALTER MATERIALIZED VIEW ... SET TAGS as a replace setTags', () => {
			const stmt = parse(`alter materialized view mv set tags (owner = 'analytics')`) as AlterMaterializedViewStmt;
			expect(stmt.type).to.equal('alterMaterializedView');
			expect(stmt.name.name).to.equal('mv');
			expect(stmt.action).to.deep.equal({ type: 'setTags', mode: 'replace', tags: { owner: 'analytics' } });
		});

		it('parses ALTER INDEX ... SET TAGS as a replace setTags', () => {
			const stmt = parse(`alter index idx set tags (purpose = 'search')`) as AlterIndexStmt;
			expect(stmt.type).to.equal('alterIndex');
			expect(stmt.name.name).to.equal('idx');
			expect(stmt.action).to.deep.equal({ type: 'setTags', mode: 'replace', tags: { purpose: 'search' } });
		});

		// ── ADD TAGS → merge setTags ──
		it('parses ALTER VIEW ... ADD TAGS as a merge setTags', () => {
			const stmt = parse(`alter view v add tags (cacheable = true)`) as AlterViewStmt;
			expect(stmt.action).to.deep.equal({ type: 'setTags', mode: 'merge', tags: { cacheable: true } });
		});

		it('parses ALTER MATERIALIZED VIEW ... ADD TAGS as a merge setTags', () => {
			const stmt = parse(`alter materialized view mv add tags (owner = 'team-b')`) as AlterMaterializedViewStmt;
			expect(stmt.action).to.deep.equal({ type: 'setTags', mode: 'merge', tags: { owner: 'team-b' } });
		});

		it('parses ALTER INDEX ... ADD TAGS as a merge setTags', () => {
			const stmt = parse(`alter index idx add tags (purpose = 'search')`) as AlterIndexStmt;
			expect(stmt.action).to.deep.equal({ type: 'setTags', mode: 'merge', tags: { purpose: 'search' } });
		});

		// ── DROP TAGS → dropTags ──
		it('parses ALTER VIEW ... DROP TAGS as a dropTags', () => {
			const stmt = parse(`alter view v drop tags (purpose)`) as AlterViewStmt;
			expect(stmt.action).to.deep.equal({ type: 'dropTags', keys: ['purpose'] });
		});

		it('parses ALTER MATERIALIZED VIEW ... DROP TAGS as a dropTags', () => {
			const stmt = parse(`alter materialized view mv drop tags (legacy, owner)`) as AlterMaterializedViewStmt;
			expect(stmt.action).to.deep.equal({ type: 'dropTags', keys: ['legacy', 'owner'] });
		});

		it('parses ALTER INDEX ... DROP TAGS as a dropTags', () => {
			const stmt = parse(`alter index idx drop tags (purpose)`) as AlterIndexStmt;
			expect(stmt.action).to.deep.equal({ type: 'dropTags', keys: ['purpose'] });
		});

		// ── empty-list forms ──
		it('parses an empty SET TAGS () as the clear-all form', () => {
			const stmt = parse(`alter index idx set tags ()`) as AlterIndexStmt;
			expect(stmt.action).to.deep.equal({ type: 'setTags', mode: 'replace', tags: {} });
		});

		it('parses empty ADD TAGS () / DROP TAGS () as no-op lists', () => {
			const add = parse(`alter view v add tags ()`) as AlterViewStmt;
			expect(add.action).to.deep.equal({ type: 'setTags', mode: 'merge', tags: {} });
			const drop = parse(`alter view v drop tags ()`) as AlterViewStmt;
			expect(drop.action).to.deep.equal({ type: 'dropTags', keys: [] });
		});

		it('honors a schema-qualified object name', () => {
			const stmt = parse(`alter view main.v set tags (a = 1)`) as AlterViewStmt;
			expect(stmt.name.schema).to.equal('main');
			expect(stmt.name.name).to.equal('v');
		});

		it('rejects ALTER on an unsupported object keyword', () => {
			expect(() => parse(`alter sequence s set tags (a = 1)`)).to.throw();
		});

		it('rejects a tag verb that is not SET / ADD / DROP', () => {
			expect(() => parse(`alter view v rename tags (a)`)).to.throw();
		});

		it('round-trips all nine view / MV / index tag forms through astToString', () => {
			for (const sql of [
				`alter view v set tags (cacheable = true)`,
				`alter view v add tags (cacheable = true)`,
				`alter view v drop tags (purpose)`,
				`alter materialized view mv set tags (owner = 'team-b')`,
				`alter materialized view mv add tags (owner = 'team-b')`,
				`alter materialized view mv drop tags (legacy)`,
				`alter index idx set tags (purpose = 'search')`,
				`alter index idx add tags (purpose = 'search')`,
				`alter index idx drop tags (purpose)`,
				// A quoted reserved-looking key proves tagKeysBodyToString quotes keys.
				`alter view v drop tags ("quereus.id")`,
			]) {
				const stmt = parse(sql);
				const reparsed = parse(astToString(stmt));
				expect((reparsed as AlterViewStmt).action, sql).to.deep.equal((stmt as AlterViewStmt).action);
			}
		});
	});

	// Guards the shared CONTEXTUAL_KEYWORDS constant in parser.ts: these tokenized-but-contextual
	// reserved words must still be accepted as identifiers in every context, and the two extended
	// sets (+temp/temporary in tableIdentifier, +replace in the function-call path) must keep working.
	describe('Contextual keywords as identifiers', () => {
		it('accepts a contextual keyword as a qualified column reference', () => {
			const stmt = parse(`select cascade.restrict from cascade`) as SelectStmt;
			const col = stmt.columns[0];
			expect(col.type).to.equal('column');
			const expr = (col as { expr: Expression }).expr as { type: string; table?: string; name: string };
			expect(expr.type).to.equal('column');
			expect(expr.table).to.equal('cascade');
			expect(expr.name).to.equal('restrict');
		});

		it('accepts a contextual keyword as a column alias', () => {
			const stmt = parse(`select x as "default" from t`) as SelectStmt;
			const col = stmt.columns[0];
			expect(col.type).to.equal('column');
			expect((col as { alias?: string }).alias).to.equal('default');
		});

		it('accepts a contextual keyword as a table-valued function name (base set)', () => {
			const stmt = parse(`select * from like(1)`) as SelectStmt;
			const from = stmt.from![0] as { type: string; name: { name: string } };
			expect(from.type).to.equal('functionSource');
			expect(from.name.name).to.equal('like');
		});

		it("accepts 'replace' as a scalar function name (function-call spread set)", () => {
			const stmt = parse(`select replace('a', 'a', 'b')`) as SelectStmt;
			const expr = (stmt.columns[0] as { expr: Expression }).expr as { type: string; name: string };
			expect(expr.type).to.equal('function');
			expect(expr.name).to.equal('replace');
		});

		it("accepts 'temp'/'temporary' as schema/table names (tableIdentifier spread set)", () => {
			const qualified = parse(`select * from temp.foo`) as SelectStmt;
			const qFrom = qualified.from![0] as { type: string; table: { schema?: string; name: string } };
			expect(qFrom.table.schema).to.equal('temp');
			expect(qFrom.table.name).to.equal('foo');

			const bare = parse(`select * from temporary`) as SelectStmt;
			const bFrom = bare.from![0] as { type: string; table: { name: string } };
			expect(bFrom.table.name).to.equal('temporary');
		});

		it('accepts a contextual keyword as a CTE name (shared CONTEXTUAL_KEYWORDS set)', () => {
			const stmt = parse(`with "key" as (select 1 as a) select * from "key"`) as SelectStmt;
			expect(stmt.withClause).to.exist;
			expect(stmt.withClause!.ctes[0].name).to.equal('key');
		});

		// The CTE name/column list now shares the full CONTEXTUAL_KEYWORDS set
		// (ticket parser-cte-contextual-keyword-subset), so the keywords formerly
		// omitted from the CTE subset — references/on/cascade/restrict — are accepted
		// as CTE names too, matching how they are already accepted as table names.
		it('accepts a previously-omitted reserved-but-table-legal keyword as a CTE name', () => {
			const stmt = parse(`with references as (select 1 as a) select * from references`) as SelectStmt;
			expect(stmt.withClause!.ctes[0].name).to.equal('references');
			// ...consistent with the same word being accepted as a table name:
			expect(() => parse(`select * from references`)).to.not.throw();
			// `on` is in CONTEXTUAL_KEYWORDS too — exercise it explicitly, not just transitively.
			const onStmt = parse(`with on as (select 1 as a) select * from on`) as SelectStmt;
			expect(onStmt.withClause!.ctes[0].name).to.equal('on');
		});

		it('round-trips a keyword-named CTE through ast-stringify', () => {
			// The emitter must quote the keyword (e.g. `with "references" as ...`) so the
			// widened parser accepts it on re-parse and the name survives unchanged.
			const stmt = parse(`with references as (select 1 as a) select * from references`) as SelectStmt;
			const reparsed = parse(astToString(stmt)) as SelectStmt;
			expect(reparsed.withClause!.ctes[0].name).to.equal('references');
		});

		it('accepts a previously-omitted reserved-but-table-legal keyword in a CTE column list', () => {
			const stmt = parse(`with c(cascade, restrict) as (select 1, 2) select * from c`) as SelectStmt;
			expect(stmt.withClause!.ctes[0].columns).to.deep.equal(['cascade', 'restrict']);
		});
	});

	describe('Materialized Views', () => {
		it('parses CREATE MATERIALIZED VIEW with a SELECT body', () => {
			const stmt = parse(`create materialized view mv as select x, y from t`) as CreateMaterializedViewStmt;
			expect(stmt.type).to.equal('createMaterializedView');
			expect(stmt.view.name).to.equal('mv');
			expect(stmt.ifNotExists).to.equal(false);
			expect(stmt.select.type).to.equal('select');
		});

		it('parses an explicit column list', () => {
			const stmt = parse(`create materialized view mv(a, b) as select x, y from t`) as CreateMaterializedViewStmt;
			expect(stmt.columns).to.deep.equal(['a', 'b']);
		});

		it('parses IF NOT EXISTS', () => {
			const stmt = parse(`create materialized view if not exists mv as select 1 as x`) as CreateMaterializedViewStmt;
			expect(stmt.ifNotExists).to.equal(true);
		});

		it('parses an optional USING backing-module clause', () => {
			const stmt = parse(`create materialized view mv using mem() as select x from t`) as CreateMaterializedViewStmt;
			expect(stmt.moduleName).to.equal('mem');
		});

		it('parses REFRESH MATERIALIZED VIEW', () => {
			const stmt = parse(`refresh materialized view mv`) as RefreshMaterializedViewStmt;
			expect(stmt.type).to.equal('refreshMaterializedView');
			expect(stmt.name.name).to.equal('mv');
		});

		it('parses DROP MATERIALIZED VIEW with objectType materializedView', () => {
			const stmt = parse(`drop materialized view mv`) as DropStmt;
			expect(stmt.type).to.equal('drop');
			expect(stmt.objectType).to.equal('materializedView');
			expect(stmt.name.name).to.equal('mv');
		});

		it('round-trips through ast-stringify', () => {
			const sql = `create materialized view mv as select x, y from t order by y`;
			const stmt = parse(sql);
			const reparsed = parse(astToString(stmt)) as CreateMaterializedViewStmt;
			expect(reparsed.type).to.equal('createMaterializedView');
			expect(reparsed.view.name).to.equal('mv');
			expect(reparsed.select.type).to.equal('select');
		});

		it('round-trips DROP MATERIALIZED VIEW (not "drop materializedview")', () => {
			const out = astToString(parse(`drop materialized view mv`));
			expect(out).to.equal('drop materialized view mv');
			expect(parse(out)).to.have.property('type', 'drop');
		});
	});
});
