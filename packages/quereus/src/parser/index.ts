import { quereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
export * from './ast.js';
export * from './parser.js';
export * from './lexer.js';

import { Parser } from './parser.js';
import type { Statement, SelectStmt, InsertStmt, Expression } from './ast.js';

/**
 * Parse a single SQL statement into an AST node.
 *
 * @param sql SQL statement
 * @returns AST for the statement
 * @throws ParseError if the SQL is invalid
 */
export function parse(sql: string): Statement {
	const parser = new Parser();
	return parser.parse(sql);
}

/**
 * Parse multiple SQL statements separated by semicolons.
 *
 * @param sql SQL text containing one or more statements
 * @returns Array of AST nodes for each statement
 * @throws ParseError if the SQL is invalid
 */
export function parseAll(sql: string): Statement[] {
	const parser = new Parser();
	return parser.parseAll(sql);
}

/**
 * Parse a SQL SELECT statement
 *
 * @param sql SQL SELECT statement
 * @returns AST for the SELECT statement
 * @throws ParseError if the SQL is invalid or not a SELECT statement
 */
export function parseSelect(sql: string): SelectStmt {
	const stmt = parse(sql);
	if (stmt.type !== 'select') {
		quereusError(
			`Expected SELECT statement, but got ${stmt.type}`,
			StatusCode.ERROR,
			undefined,
			stmt
		);
	}
	return stmt as SelectStmt;
}

/**
 * Parse a single scalar SQL expression into an {@link Expression} AST.
 *
 * Wraps the expression in a `select <expr>` and extracts the projected column's
 * expression — the established pattern for one-off expression parsing (see the
 * parser/emit specs). Used to lower synthesized SQL fragments (e.g. the
 * view-mutation presence predicates) into AST nodes.
 *
 * @param exprSql A SQL scalar expression (e.g. `epoch_ms('now')`, `42`)
 * @returns The parsed expression AST
 * @throws ParseError if the text is not a single parseable expression
 */
export function parseExpressionString(exprSql: string): Expression {
	const stmt = parse(`select ${exprSql}`);
	if (stmt.type !== 'select' || stmt.columns.length !== 1 || stmt.columns[0].type !== 'column') {
		quereusError(
			`Expected a single scalar expression, got: ${exprSql}`,
			StatusCode.ERROR,
			undefined,
			stmt,
		);
	}
	return stmt.columns[0].expr;
}

/**
 * Parse a SQL INSERT statement
 *
 * @param sql SQL INSERT statement
 * @returns AST for the INSERT statement
 * @throws Error if the SQL is not an INSERT statement
 */
export function parseInsert(sql: string): InsertStmt {
	const stmt = parse(sql);
	if (stmt.type !== 'insert') {
		quereusError(
			`Expected INSERT statement, but got ${stmt.type}`,
			StatusCode.ERROR,
			undefined,
			stmt
		);
	}
	return stmt as InsertStmt;
}
