import { createLogger } from '../common/logger.js'; // Import logger
import { Lexer, type Token, TokenType, CONTEXTUAL_KEYWORDS } from './lexer.js';
import * as AST from './ast.js';
import { ConflictResolution } from '../common/constants.js';
import type { RowOp, SqlValue } from '../common/types.js';
import { quereusError, QuereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import { getSyncLiteral } from './utils.js';

const errorLog = createLogger('parser:parser:error');

export class ParseError extends QuereusError {
	token: Token;

	constructor(token: Token, message: string) {
		super(message, StatusCode.ERROR, undefined, token.startLine, token.startColumn);
		this.token = token;
		this.name = 'ParseError';
		Object.setPrototypeOf(this, ParseError.prototype);
	}
}

// Helper function to create the location object
function _createLoc(startToken: Token, endToken: Token): AST.AstNode['loc'] {
	return {
		start: {
			line: startToken.startLine,
			column: startToken.startColumn,
			offset: startToken.startOffset,
		},
		end: {
			line: endToken.endLine,
			column: endToken.endColumn,
			offset: endToken.endOffset,
		},
	};
}

/**
 * Leading keywords of a `declare schema { … }` item. Items carry no required
 * separator, so these are barred from the bare-alias slot while an item body is
 * parsed (see {@link Parser.withAliasBarrier}). The reserved ones are already safe
 * — they lex to their own TokenType — but listing them keeps the set readable as
 * "the item keywords". `DOMAIN` / `COLLATION` / `IMPORT` are the ignored kinds.
 */
const DECLARE_ITEM_KEYWORDS: ReadonlySet<string> = new Set([
	'TABLE', 'INDEX', 'UNIQUE', 'MATERIALIZED', 'VIEW', 'SEED', 'ASSERTION',
	'DOMAIN', 'COLLATION', 'IMPORT',
]);

/** Leading keyword of a `declare lens { … }` override; same separator-less shape. */
const LENS_OVERRIDE_KEYWORDS: ReadonlySet<string> = new Set(['VIEW']);

/**
 * IMPORTANT: Any changes to parsed syntax must also be reflected in the corresponding emitters:
 *   - packages/quereus/src/emit/ast-stringify.ts          (AST-to-SQL string conversion)
 *   - packages/quereus/src/schema/catalog.ts              (CREATE ASSERTION DDL for catalog/hashing)
 *   - packages/quereus/src/schema/ddl-generator.ts        (canonical DDL generation for persistence)
 * If only the parser is updated, SQL round-trips and persisted schemas will silently lose the new syntax.
 */
export class Parser {
	private tokens: Token[] = [];
	private current = 0;
	// Counter for positional parameters
	private parameterPosition = 1;
	// Track opening parentheses for accurate error locations
	private parenStack: Token[] = [];
	/**
	 * Bare (no-`as`) alias barrier. While a declaration-block item body is being
	 * parsed, the leading keywords of a *sibling* item must not be absorbed as an
	 * implicit alias — block items carry no required separator, so the alias slot
	 * and the next item's first token compete for the same position. Scoped by a
	 * stack so it never leaks into ordinary statements, and by the paren depth the
	 * item started at, since a sibling item cannot begin inside an open `(`.
	 */
	private aliasBarriers: { words: ReadonlySet<string>; parenDepth: number }[] = [];

	/**
	 * Initialize the parser with tokens from a SQL string
	 * @param sql SQL string to parse
	 * @returns this parser instance for chaining
	 */
	initialize(sql: string): Parser {
		const lexer = new Lexer(sql);
		this.tokens = lexer.scanTokens();
		this.current = 0;
		this.parameterPosition = 1; // Reset parameter counter
		this.parenStack = [];
		this.aliasBarriers = [];

		// Check for errors from lexer
		const errorToken = this.tokens.find(t => t.type === TokenType.ERROR);
		if (errorToken) {
			quereusError(
				`Lexer error: ${errorToken.lexeme}`,
				StatusCode.ERROR,
				undefined,
				{
					loc: {
						start: {
							line: errorToken.startLine,
							column: errorToken.startColumn,
						},
						end: {
							line: errorToken.endLine,
							column: errorToken.endColumn,
						}
					}
				}
			);
		}

		return this;
	}

	/**
	 * Parse SQL text into an array of ASTs
	 */
	parseAll(sql: string): AST.Statement[] {
		this.initialize(sql);
		const statements: AST.Statement[] = [];

		while (!this.isAtEnd()) {
			try {
				const stmt = this.statement();
				statements.push(stmt as AST.Statement); // Cast needed as statement() returns AstNode

				// Consume optional semicolon at the end of the statement
				this.match(TokenType.SEMICOLON);

			} catch (e) {
				// error() method now throws QuereusError directly with location info
				if (e instanceof QuereusError) {
					throw e;
				}

				// Handle unexpected non-QuereusError exceptions
				errorLog("Unhandled parser error: %O", e);
				quereusError(
					`Parser error: ${e instanceof Error ? e.message : e}`,
					StatusCode.ERROR,
					e instanceof Error ? e : undefined
				);
			}
		}

		// Report any unterminated parenthesis at EOF with pointer to opening location
		if (this.parenStack.length > 0) {
			const openToken = this.parenStack[this.parenStack.length - 1];
			quereusError(
				`Unterminated '(' opened at line ${openToken.startLine}, column ${openToken.startColumn}. Expected ')' before end of input.`,
				StatusCode.ERROR,
				undefined,
				{
					loc: {
						start: { line: openToken.startLine, column: openToken.startColumn },
						end: { line: this.peek().endLine, column: this.peek().endColumn },
					},
				}
			);
		}

		// If we consumed all tokens and didn't parse any statements (e.g., empty input or only comments/whitespace),
		// return an empty array instead of throwing an error.
		return statements;
	}

	/**
	 * Parse SQL text into a single AST node.
	 * Use parseAll instead for potentially multi-statement strings.
	 * Throws error if more than one statement is found after the first.
	 */
	parse(sql: string): AST.Statement {
		const statements = this.parseAll(sql);
		if (statements.length === 0) {
			// Handle case of empty input or input with only comments/whitespace
			// Depending on desired behavior, could return null, undefined, or throw.
			// Throwing seems reasonable as prepare/eval expect a statement.
			quereusError("No SQL statement found to parse.", StatusCode.ERROR);
		}
		if (statements.length > 1) {
			// Find the token that starts the second statement for better error location
			const secondStatementStartToken = statements[1]?.loc?.start;
			const errToken = this.tokens.find(t => t.startOffset === secondStatementStartToken?.offset) ?? this.peek();
			this.error(errToken, "Provided SQL string contains multiple statements. Use exec() for multi-statement execution.");
		}
		return statements[0];
	}

	/**
	 * Attempts to parse a WITH clause if present.
	 * @returns The WithClause AST node or undefined if no WITH clause is found.
	 */
	private tryParseWithClause(): AST.WithClause | undefined {
		if (!this.check(TokenType.WITH)) {
			return undefined;
		}
		const startToken = this.advance(); // Consume WITH

		const recursive = this.match(TokenType.RECURSIVE);

		const ctes: AST.CommonTableExpr[] = [];
		do {
			ctes.push(this.commonTableExpression());
		} while (this.match(TokenType.COMMA));

		// Parse optional OPTION clause
		let options: AST.WithClauseOptions | undefined;
		if (this.matchKeyword('OPTION')) {
			this.consume(TokenType.LPAREN, "Expected '(' after OPTION.");

			// Parse MAXRECURSION option
			if (this.matchKeyword('MAXRECURSION')) {
				if (!this.check(TokenType.INTEGER)) {
					this.error(this.peek(), "Expected integer value after MAXRECURSION.");
				}
				const maxRecursionToken = this.advance();
				const maxRecursion = maxRecursionToken.literal as number;

				if (maxRecursion < 0) {
					this.error(maxRecursionToken, "MAXRECURSION value must be non-negative.");
				}

				options = { maxRecursion };
			} else {
				throw this.error(this.peek(), "Expected MAXRECURSION in OPTION clause.");
			}

			this.consume(TokenType.RPAREN, "Expected ')' after OPTION clause.");
		}

		const endToken = this.previous(); // Last token of the WITH clause

		return { type: 'with', recursive, ctes, options, loc: _createLoc(startToken, endToken) };
	}

	/**
	 * Parses a relation-producing query expression (`QueryExpr`):
	 * `[WITH …] (SELECT | VALUES | INSERT|UPDATE|DELETE)`.
	 *
	 * `outerWithContext` is an outer WITH already consumed by the caller and
	 * forwarded into inner statements purely for CTE-resolution context (the
	 * planner reads CTE definitions out of `select.withClause`). It is NOT
	 * stored on the returned node — that already happened at the outer site.
	 *
	 * If the body itself leads with `WITH`, that inner WITH is consumed here
	 * and attached to the resulting statement. The two WITH clauses do not
	 * mix: an inner body-level WITH wins.
	 *
	 * `requireReturning` enforces the rule that DML used in non-top-level
	 * relation positions (FROM subquery, scalar / IN / EXISTS subquery,
	 * compound leg, CTE body, view body) must carry a RETURNING clause —
	 * the outer position consumes a relation, not a side-effect.
	 */
	private parseQueryExpr(
		outerWithContext?: AST.WithClause,
		requireReturning: boolean = false,
	): AST.QueryExpr {
		// Inner body-level WITH (e.g. `(WITH t AS (…) SELECT … FROM t)`). The
		// inner WITH is owned by the produced statement; we still pass it down
		// to the inner builder for the same resolution-context reason and
		// re-attach explicitly so callers that swap it out (rename rewriter,
		// declared-schema canonicaliser) see a consistent shape.
		let innerWith: AST.WithClause | undefined;
		if (this.check(TokenType.WITH)) {
			innerWith = this.tryParseWithClause();
		}

		const resolutionContext = innerWith ?? outerWithContext;

		const startToken = this.peek();
		let stmt: AST.QueryExpr;
		if (this.check(TokenType.LPAREN)) {
			// A parenthesized query expression `( <query-expr> )` is a valid first
			// operand (view body / CTE body / FROM-subquery / scalar subquery all
			// funnel here). Read it, then run the shared left-associative tail so
			// `(…) union …` chains. Pure grouping (no compound follows) returns the
			// inner expression unchanged — `(select 1)` ≡ `select 1`.
			const firstOperand = this.parseCompoundOperand(resolutionContext, requireReturning);
			stmt = this.checkCompoundOperator()
				? this.parseCompoundTail(firstOperand, resolutionContext, startToken)
				: firstOperand;
		} else {
			const kw = startToken.lexeme.toUpperCase();
			switch (kw) {
				case 'SELECT': this.advance(); stmt = this.selectStatement(startToken, resolutionContext); break;
				case 'VALUES': this.advance(); stmt = this.valuesStatementWithOptionalCompound(startToken, resolutionContext); break;
				case 'INSERT': this.advance(); stmt = this.insertStatement(startToken, resolutionContext); break;
				case 'UPDATE': this.advance(); stmt = this.updateStatement(startToken, resolutionContext); break;
				case 'DELETE': this.advance(); stmt = this.deleteStatement(startToken, resolutionContext); break;
				default:
					throw this.error(startToken, "Expected SELECT, VALUES, INSERT, UPDATE, or DELETE in query expression.");
			}
		}

		if (innerWith) {
			if (this.statementSupportsWithClause(stmt)) {
				stmt.withClause = innerWith;
				if (innerWith.loc && stmt.loc) {
					stmt.loc.start = innerWith.loc.start;
				}
			} else {
				throw this.error(this.previous(), `WITH clause cannot be used with ${stmt.type} statement.`);
			}
		}

		if (requireReturning && (stmt.type === 'insert' || stmt.type === 'update' || stmt.type === 'delete')) {
			if (!stmt.returning || stmt.returning.length === 0) {
				throw this.error(this.previous(), `${stmt.type.toUpperCase()} in a relation position must have a RETURNING clause.`);
			}
		}
		return stmt;
	}

	/**
	 * Parses a single Common Table Expression (CTE).
	 * cte_name [(col1, col2, ...)] AS (query)
	 */
	private commonTableExpression(): AST.CommonTableExpr {
		const startToken = this.peek(); // Peek before consuming name
		const name = this.consumeIdentifier(CONTEXTUAL_KEYWORDS, "Expected CTE name.");
		let endToken = this.previous(); // End token initially is the name

		let columns: string[] | undefined;
		if (this.match(TokenType.LPAREN)) {
			columns = [];
			if (!this.check(TokenType.RPAREN)) {
				do {
					columns.push(this.consumeIdentifier(CONTEXTUAL_KEYWORDS, "Expected column name in CTE definition."));
				} while (this.match(TokenType.COMMA) && !this.check(TokenType.RPAREN));
			}
			endToken = this.consume(TokenType.RPAREN, "Expected ')' after CTE column list.");
		}

		this.consume(TokenType.AS, "Expected 'AS' after CTE name.");

		let materializationHint: AST.CommonTableExpr['materializationHint'];
		if (this.matchKeyword('MATERIALIZED')) {
			materializationHint = 'materialized';
		} else if (this.matchKeyword('NOT')) {
			this.consumeKeyword('MATERIALIZED', "Expected 'MATERIALIZED' after 'NOT'.");
			materializationHint = 'not_materialized';
		}

		this.consume(TokenType.LPAREN, "Expected '(' before CTE query.");

		// CTE body is any QueryExpr; DML bodies must carry RETURNING.
		const query = this.parseQueryExpr(undefined, /*requireReturning*/ true);

		endToken = this.consume(TokenType.RPAREN, "Expected ')' after CTE query."); // Capture ')' as end token

		return { type: 'commonTableExpr', name, columns, query, materializationHint, loc: _createLoc(startToken, endToken) };
	}

	/**
	 * Parse a single SQL statement
	 */
	private statement(): AST.AstNode {
		// Check for WITH clause first
		let withClause: AST.WithClause | undefined;
		if (this.check(TokenType.WITH)) {
			withClause = this.tryParseWithClause();
		}

		const startToken = this.peek();
		// --- Check for specific keywords first ---
		const currentKeyword = startToken.lexeme.toUpperCase();
		let stmt: AST.AstNode;

		// A leading `(` is a parenthesized query expression at top level
		// (`(select 1) union (select 2);` — SQLite parity). `parseQueryExpr`
		// reads the operand and any compound tail; the post-switch WITH-attach
		// below still folds an outer `with … (select …) union …` in.
		if (this.check(TokenType.LPAREN)) {
			stmt = this.parseQueryExpr(withClause);
		} else switch (currentKeyword) {
			case 'SELECT': this.advance(); stmt = this.selectStatement(startToken, withClause); break;
			case 'INSERT': this.advance(); stmt = this.insertStatement(startToken, withClause); break;
			case 'UPDATE': this.advance(); stmt = this.updateStatement(startToken, withClause); break;
			case 'DELETE': this.advance(); stmt = this.deleteStatement(startToken, withClause); break;
			case 'VALUES': this.advance(); stmt = this.valuesStatementWithOptionalCompound(startToken, withClause); break;
			case 'CREATE': this.advance(); stmt = this.createStatement(startToken, withClause); break;
			case 'REFRESH': this.advance(); stmt = this.refreshStatement(startToken, withClause); break;
			case 'DROP': this.advance(); stmt = this.dropStatement(startToken, withClause); break;
			case 'ALTER': this.advance(); stmt = this.alterStatement(startToken, withClause); break;
			case 'BEGIN': this.advance(); stmt = this.beginStatement(startToken, withClause); break;
			case 'COMMIT': this.advance(); stmt = this.commitStatement(startToken, withClause); break;
			case 'ROLLBACK': this.advance(); stmt = this.rollbackStatement(startToken, withClause); break;
			case 'SAVEPOINT': this.advance(); stmt = this.savepointStatement(startToken, withClause); break;
			case 'RELEASE': this.advance(); stmt = this.releaseStatement(startToken, withClause); break;
			// TODO: Replace pragmas with build-in functions
			case 'PRAGMA': this.advance(); stmt = this.pragmaStatement(startToken, withClause); break;
			case 'ANALYZE': this.advance(); stmt = this.analyzeStatement(startToken); break;
			case 'DECLARE': {
				this.advance();
				// `declare lens …` is a sibling statement, not a `declare schema`
				// variant: branch on the contextual LENS keyword.
				stmt = this.peekKeyword('LENS')
					? this.declareLensStatement(startToken)
					: this.declareSchemaStatement(startToken);
				break;
			}
			case 'DIFF': this.advance(); stmt = this.diffSchemaStatement(startToken); break;
			case 'APPLY': this.advance(); stmt = this.applySchemaStatement(startToken); break;
			case 'EXPLAIN': this.advance(); stmt = this.explainSchemaStatement(startToken); break;
			// --- Add default case ---
			default:
				// If it wasn't a recognized keyword starting the statement
				throw this.error(startToken, `Expected statement type (SELECT, INSERT, UPDATE, DELETE, VALUES, CREATE, etc.), got '${startToken.lexeme}'.`);
		}

		// Attach WITH clause if present and supported
		if (withClause && this.statementSupportsWithClause(stmt)) {
			stmt.withClause = withClause;
			if (withClause.loc && stmt.loc) {
				stmt.loc.start = withClause.loc.start;
			}
		} else if (withClause) {
			throw this.error(this.previous(), `WITH clause cannot be used with ${stmt.type} statement.`);
		}

		return stmt;
	}

	/**
	 * Parse an INSERT statement
	 * @returns AST for the INSERT statement
	 */
	insertStatement(startToken: Token, withClause?: AST.WithClause): AST.InsertStmt {
		// Parse optional OR <conflict-resolution> clause (INSERT OR REPLACE, INSERT OR IGNORE, etc.)
		let onConflict: ConflictResolution | undefined;
		if (this.matchKeyword('OR')) {
			if (this.match(TokenType.ROLLBACK)) onConflict = ConflictResolution.ROLLBACK;
			else if (this.match(TokenType.ABORT)) onConflict = ConflictResolution.ABORT;
			else if (this.match(TokenType.FAIL)) onConflict = ConflictResolution.FAIL;
			else if (this.match(TokenType.IGNORE)) onConflict = ConflictResolution.IGNORE;
			else if (this.match(TokenType.REPLACE)) onConflict = ConflictResolution.REPLACE;
			else throw this.error(this.peek(), "Expected conflict resolution (ROLLBACK, ABORT, FAIL, IGNORE, REPLACE) after OR.");
		}

		// INTO keyword is optional in SQLite
		this.matchKeyword('INTO'); // Handle missing keyword gracefully

		// Parse the table reference
		const table = this.tableIdentifier();

		// Parse column list if provided
		let columns: string[] | undefined;
		if (this.match(TokenType.LPAREN)) {
			columns = [];
			do {
				if (!this.checkIdentifierLike(CONTEXTUAL_KEYWORDS)) {
					throw this.error(this.peek(), "Expected column name.");
				}
				columns.push(this.getIdentifierValue(this.advance()));
			} while (this.match(TokenType.COMMA));

			this.consume(TokenType.RPAREN, "Expected ')' after column list.");
		}

		// Parse mutation context assignments and/or tags if present (after column
		// list, before VALUES/SELECT). Either may also appear trailing (after
		// VALUES/SELECT) via parseTrailingWithClauses.
		let contextValues: AST.ContextAssignment[] | undefined;
		let tags: Record<string, SqlValue> | undefined;
		while (this.matchKeyword('WITH')) {
			if (this.matchKeyword('CONTEXT')) {
				contextValues = this.parseContextAssignments();
			} else if (this.matchKeyword('TAGS')) {
				tags = this.parseTags();
			} else {
				// Not a WITH CONTEXT / WITH TAGS clause, backtrack
				this.current--;
				break;
			}
		}

		// Parse the source: VALUES / SELECT / INSERT|UPDATE|DELETE with RETURNING.
		// The outer INSERT consumes the resulting relation, so DML sources must
		// carry RETURNING — parseQueryExpr enforces that when requireReturning
		// is true. Pure VALUES / SELECT are passed through unchanged.
		const sourceStartKeyword = this.peek().lexeme.toUpperCase();
		let source: AST.QueryExpr;
		switch (sourceStartKeyword) {
			case 'VALUES':
			case 'SELECT':
				source = this.parseQueryExpr(withClause, /*requireReturning*/ false);
				break;
			case 'INSERT':
			case 'UPDATE':
			case 'DELETE':
				source = this.parseQueryExpr(withClause, /*requireReturning*/ true);
				break;
			default:
				throw this.error(this.peek(), "Expected VALUES, SELECT, or DML (with RETURNING) after INSERT.");
		}
		let lastConsumedToken = this.previous(); // After source statement is parsed

		// Parse UPSERT clauses (ON CONFLICT DO ...) - can have multiple
		let upsertClauses: AST.UpsertClause[] | undefined;
		while (this.match(TokenType.ON)) {
			if (!this.matchKeyword('CONFLICT')) {
				// Not an ON CONFLICT clause, backtrack
				this.current--;
				break;
			}

			// Validate mutual exclusivity with OR clause
			if (onConflict !== undefined) {
				throw this.error(this.previous(), "Cannot use both 'INSERT OR ...' and 'ON CONFLICT' in the same statement.");
			}

			const upsertClause = this.parseUpsertClause();
			if (!upsertClauses) upsertClauses = [];
			upsertClauses.push(upsertClause);
			lastConsumedToken = this.previous();
		}

		// Parse trailing WITH clauses (WITH CONTEXT and/or WITH SCHEMA in any order)
		const trailingClauses = this.parseTrailingWithClauses();
		if (trailingClauses.contextValues) {
			if (contextValues) {
				throw this.error(this.previous(), "Duplicate WITH CONTEXT clause");
			}
			contextValues = trailingClauses.contextValues;
		}
		if (trailingClauses.tags) {
			if (tags) {
				throw this.error(this.previous(), "Duplicate WITH TAGS clause");
			}
			tags = trailingClauses.tags;
			lastConsumedToken = this.previous(); // After tags
		}
		const schemaPath = trailingClauses.schemaPath;
		if (schemaPath) {
			lastConsumedToken = this.previous(); // After schema path
		}

		// Parse RETURNING clause if present
		let returning: AST.ResultColumn[] | undefined;
		if (this.matchKeyword('RETURNING')) {
			returning = this.columnList();
			lastConsumedToken = this.previous(); // Update after RETURNING clause
		}

		return {
			type: 'insert',
			table,
			columns,
			source,
			onConflict,
			upsertClauses,
			returning,
			contextValues,
			schemaPath,
			tags,
			loc: _createLoc(startToken, lastConsumedToken),
		};
	}

	/**
	 * Parse an UPSERT clause: ON CONFLICT [(columns)] DO NOTHING | DO UPDATE SET ... [WHERE ...]
	 * Called after 'ON CONFLICT' has been consumed.
	 */
	private parseUpsertClause(): AST.UpsertClause {
		const startToken = this.previous(); // The 'CONFLICT' token

		// Parse optional conflict target columns
		let conflictTarget: string[] | undefined;
		if (this.match(TokenType.LPAREN)) {
			conflictTarget = [];
			do {
				conflictTarget.push(this.consumeIdentifier([], "Expected column name in conflict target."));
			} while (this.match(TokenType.COMMA));
			this.consume(TokenType.RPAREN, "Expected ')' after conflict target columns.");
		}

		// Expect DO keyword
		this.consumeKeyword('DO', "Expected 'DO' after ON CONFLICT [columns].");

		// Parse action: NOTHING or UPDATE
		if (this.matchKeyword('NOTHING')) {
			return {
				type: 'upsert',
				conflictTarget,
				action: 'nothing',
				loc: _createLoc(startToken, this.previous())
			};
		}

		if (this.match(TokenType.UPDATE)) {
			// Expect SET keyword
			this.consumeKeyword('SET', "Expected 'SET' after DO UPDATE.");

			// Parse assignments
			const assignments: { column: string; value: AST.Expression }[] = [];
			do {
				const column = this.consumeIdentifier([], "Expected column name in SET clause.");
				this.consume(TokenType.EQUAL, "Expected '=' after column name in SET clause.");
				const value = this.expression();
				assignments.push({ column, value });
			} while (this.match(TokenType.COMMA));

			// Parse optional WHERE clause
			let where: AST.Expression | undefined;
			if (this.match(TokenType.WHERE)) {
				where = this.expression();
			}

			return {
				type: 'upsert',
				conflictTarget,
				action: 'update',
				assignments,
				where,
				loc: _createLoc(startToken, this.previous())
			};
		}

		throw this.error(this.peek(), "Expected 'NOTHING' or 'UPDATE' after DO.");
	}

	/**
	 * Parse a SELECT statement
	 * @param startToken The 'SELECT' token or start token of a sub-query
	 * @param withClause The WITH clause context for CTE access
	 * @param isCompoundSubquery If true, don't parse ORDER BY/LIMIT as they belong to the outer compound
	 * @returns AST for the SELECT statement
	 */
	selectStatement(startToken?: Token, withClause?: AST.WithClause, isCompoundSubquery: boolean = false): AST.SelectStmt {
		const start = startToken ?? this.previous(); // Use provided or the keyword token

		const distinct = this.matchKeyword('DISTINCT');
		const all = !distinct && this.matchKeyword('ALL');

		// Parse column list
		const columns = this.columnList();

		// Parse FROM clause if present
		let from: AST.FromClause[] | undefined;
		if (this.match(TokenType.FROM)) {
			from = this.tableSourceList(withClause);
		}

		// Parse WHERE clause if present
		let where: AST.Expression | undefined;
		if (this.match(TokenType.WHERE)) {
			where = this.expression();
		}

		// Parse GROUP BY clause if present
		let groupBy: AST.Expression[] | undefined;
		if (this.match(TokenType.GROUP) && this.consume(TokenType.BY, "Expected 'BY' after 'GROUP'.")) {
			groupBy = [];
			do {
				groupBy.push(this.expression());
			} while (this.match(TokenType.COMMA));
		}

		// Parse HAVING clause if present
		let having: AST.Expression | undefined;
		if (this.match(TokenType.HAVING)) {
			having = this.expression();
		}

		// Parse WITH SCHEMA clause if present (must come before compound / ORDER BY / LIMIT
		// and is suppressed in compound-subquery position).
		let schemaPath: string[] | undefined;
		if (!isCompoundSubquery) {
			schemaPath = this.parseSchemaPath();
		}

		const sel: AST.SelectStmt = {
			type: 'select',
			columns,
			from,
			where,
			groupBy,
			having,
			distinct,
			all,
			schemaPath,
			loc: _createLoc(start, this.previous()),
		};

		// Compound set operations (UNION / INTERSECT / EXCEPT / DIFF) bind BEFORE
		// ORDER BY / LIMIT — delegate to the shared left-associative tail parser.
		const result = this.parseCompoundTail(sel, withClause, start);

		// ORDER BY / LIMIT / OFFSET apply to the final compound result; suppressed
		// for a compound subquery (they bind to the outer compound).
		this.parseTrailingOrderLimit(result, isCompoundSubquery);

		// Trailing `with defaults (col = expr, …)` — binds to the whole compound,
		// after limit/offset and before any DDL-level `with tags`. Suppressed on a
		// compound leg (it belongs to the outer compound, like trailing ORDER BY).
		if (!isCompoundSubquery) {
			const defaults = this.parseDefaultsClause();
			if (defaults) result.defaults = defaults;
		}

		result.loc = _createLoc(start, this.previous());
		return result;
	}

	/** True when the next token is a compound set-operation keyword. */
	private checkCompoundOperator(): boolean {
		return this.check(TokenType.UNION)
			|| this.check(TokenType.INTERSECT)
			|| this.check(TokenType.EXCEPT)
			|| this.check(TokenType.DIFF);
	}

	/**
	 * Decode a compound set-operation operator the caller has just consumed
	 * (via `match`), plus the optional `<setop> exists <branch> as <name>`
	 * membership-column clause(s) that sit between the operator keyword and the
	 * right leg. One-token lookahead (`exists` followed by `left`/`right`, never
	 * `(`) distinguishes the membership clause from the `exists (<subquery>)`
	 * predicate, which never legally begins a compound leg.
	 */
	private parseCompoundOperator(): {
		op: 'union' | 'unionAll' | 'intersect' | 'except' | 'diff';
		existence?: ReadonlyArray<AST.SetOpMembershipColumn>;
	} {
		const tok = this.previous();
		let op: 'union' | 'unionAll' | 'intersect' | 'except' | 'diff';
		if (tok.type === TokenType.UNION) {
			op = this.match(TokenType.ALL) ? 'unionAll' : 'union';
		} else if (tok.type === TokenType.INTERSECT) {
			op = 'intersect';
		} else if (tok.type === TokenType.EXCEPT) {
			op = 'except';
		} else {
			op = 'diff';
		}
		const existence = this.setOpMembershipClauses(op);
		return existence ? { op, existence } : { op };
	}

	/**
	 * Reads a single `query-term` operand of a set operation: either a
	 * parenthesized query expression `( <query-expr> )` (full recursion — WITH,
	 * nested compound, and the inner's OWN trailing ORDER BY / LIMIT all bind
	 * inside the parens) or a bare keyword-led operand (SELECT / VALUES / DML).
	 *
	 * Bare SELECT / VALUES legs parse with `isCompoundSubquery=true` so a
	 * trailing ORDER BY / LIMIT binds to the OUTER compound, and a bare SELECT
	 * leg greedily consumes the remaining unparenthesized chain (preserving the
	 * historical right-leaning shape). `requireReturning` is propagated so a
	 * DML operand without RETURNING in a leg position is rejected.
	 */
	private parseCompoundOperand(
		withClause: AST.WithClause | undefined,
		requireReturning: boolean,
	): AST.QueryExpr {
		if (this.check(TokenType.LPAREN)) {
			this.advance();
			const inner = this.parseQueryExpr(withClause, requireReturning);
			this.consume(TokenType.RPAREN, "Expected ')' after parenthesized query expression.");
			return inner;
		}
		const start = this.peek();
		if (this.check(TokenType.SELECT)) {
			this.advance();
			return this.selectStatement(start, withClause, /*isCompoundSubquery*/ true);
		}
		if (this.check(TokenType.VALUES)) {
			this.advance();
			return this.valuesStatementWithOptionalCompound(start, withClause, /*isCompoundSubquery*/ true);
		}
		if (this.check(TokenType.WITH) || this.check(TokenType.INSERT) || this.check(TokenType.UPDATE) || this.check(TokenType.DELETE)) {
			return this.parseQueryExpr(undefined, requireReturning);
		}
		throw this.error(this.peek(), "Expected SELECT, VALUES, a DML statement, or '(' to begin a query operand.");
	}

	/**
	 * Wraps an arbitrary query expression as `select * from (<inner>) as
	 * <synthetic alias>` so the SELECT-level `compound` / ORDER BY / LIMIT slots
	 * apply to it. Generalized from the VALUES-compound wrapper; the synthetic
	 * alias is collision-proof per the inner's start offset (nested wraps live in
	 * distinct subquery scopes, so identical aliases never collide).
	 */
	private wrapAsSubquerySelect(inner: AST.QueryExpr, startToken: Token): AST.SelectStmt {
		const syntheticAlias = `values_${startToken.startOffset}`;
		return {
			type: 'select',
			columns: [{ type: 'all' }],
			from: [{
				type: 'subquerySource',
				subquery: inner,
				alias: syntheticAlias,
				loc: inner.loc,
			}],
			loc: inner.loc,
		};
	}

	/**
	 * Left-associative tail parser shared by every compound site. Consumes a
	 * chain of `compound-op [membership] query-term` after an already-parsed
	 * left operand and returns the resulting SELECT.
	 *
	 * A parenthesized operand iterates the loop (left-associative), wrapping the
	 * accumulator whenever it cannot host the new compound — either it is not a
	 * plain SELECT (e.g. a parenthesized VALUES/DML/compound operand) or its
	 * `compound` slot is already taken. The first BARE keyword operand greedily
	 * consumes the rest of the chain itself (its own `selectStatement` /
	 * `valuesStatementWithOptionalCompound` recursion), so an unparenthesized
	 * chain keeps today's right-leaning shape byte-for-byte. The user's explicit
	 * parentheses are the only escape hatch into left-grouping.
	 */
	private parseCompoundTail(
		left: AST.QueryExpr,
		withClause: AST.WithClause | undefined,
		startToken: Token,
	): AST.SelectStmt {
		let acc: AST.QueryExpr = left;
		while (this.match(TokenType.UNION, TokenType.INTERSECT, TokenType.EXCEPT, TokenType.DIFF)) {
			const { op, existence } = this.parseCompoundOperator();
			const parenthesized = this.check(TokenType.LPAREN);
			const right = this.parseCompoundOperand(withClause, /*requireReturning*/ true);

			if (acc.type !== 'select' || acc.compound) {
				acc = this.wrapAsSubquerySelect(acc, startToken);
			}
			acc.compound = existence ? { op, select: right, existence } : { op, select: right };

			if (!parenthesized) break; // a bare operand already consumed the remaining chain
		}
		// `left` is a SelectStmt at every call site that may take zero iterations
		// (selectStatement / continueSelectAfterFrom); the parenthesized entry only
		// delegates here once a compound operator follows, and any iteration leaves
		// `acc` a SELECT — so the result is always a SelectStmt.
		return acc as AST.SelectStmt;
	}

	/**
	 * Parses the trailing ORDER BY / LIMIT / OFFSET clauses that apply to the
	 * final result of a (possibly compound) SELECT, mutating `sel` in place.
	 * Suppressed entirely when `isCompoundSubquery` is set — those clauses then
	 * bind to the enclosing compound, not this leg. Shared by `selectStatement`
	 * and `continueSelectAfterFrom`.
	 */
	private parseTrailingOrderLimit(sel: AST.SelectStmt, isCompoundSubquery: boolean): void {
		if (isCompoundSubquery) return;

		// ORDER BY applies to the final result after compound operations.
		if (this.match(TokenType.ORDER) && this.consume(TokenType.BY, "Expected 'BY' after 'ORDER'.")) {
			sel.orderBy = [];
			do {
				const expr = this.expression();
				const direction = this.match(TokenType.DESC) ? 'desc' :
					(this.match(TokenType.ASC) ? 'asc' : 'asc'); // Default to ASC

				// Handle NULLS FIRST/LAST
				let nulls: 'first' | 'last' | undefined;
				if (this.matchKeyword('NULLS')) {
					if (this.matchKeyword('FIRST')) {
						nulls = 'first';
					} else if (this.matchKeyword('LAST')) {
						nulls = 'last';
					} else {
						throw this.error(this.peek(), "Expected 'FIRST' or 'LAST' after 'NULLS'.");
					}
				}

				const orderClause: AST.OrderByClause = { expr, direction };
				if (nulls) {
					orderClause.nulls = nulls;
				}
				sel.orderBy.push(orderClause);
			} while (this.match(TokenType.COMMA));
		}

		// LIMIT applies to the final result after compound operations.
		if (this.match(TokenType.LIMIT)) {
			sel.limit = this.expression();

			// LIMIT x OFFSET y syntax
			if (this.match(TokenType.OFFSET)) {
				sel.offset = this.expression();
			}
			// LIMIT x, y syntax (x is offset, y is limit)
			else if (this.match(TokenType.COMMA)) {
				sel.offset = sel.limit;
				sel.limit = this.expression();
			}
		}
	}

	/**
	 * Parse a comma-separated list of result columns for SELECT
	 */
	private columnList(): AST.ResultColumn[] {
		const columns: AST.ResultColumn[] = [];

		do {
			// Handle wildcard: * or table.*
			if (this.match(TokenType.ASTERISK)) {
				columns.push({ type: 'all' });
				this.rejectInverseClauseOnStar();
			}
			// Handle table.* syntax
			else if (this.checkIdentifierLike(CONTEXTUAL_KEYWORDS) && this.checkNext(1, TokenType.DOT) &&
				this.checkNext(2, TokenType.ASTERISK)) {
				const table = this.consumeIdentifier(CONTEXTUAL_KEYWORDS, "Expected table name before '.*'.");
				this.advance(); // consume DOT
				this.advance(); // consume ASTERISK
				columns.push({ type: 'all', table });
				this.rejectInverseClauseOnStar();
			}
			// Handle regular column expression
			else {
				const expr = this.expression();
				let alias: string | undefined;

				// Handle AS alias or just alias
				if (this.match(TokenType.AS)) {
					if (this.checkIdentifierLike(CONTEXTUAL_KEYWORDS) || this.check(TokenType.STRING)) {
						const aliasToken = this.advance();
						// For STRING tokens, use literal; for identifiers, use getIdentifierValue
						alias = aliasToken.type === TokenType.STRING
							? aliasToken.literal as string
							: this.getIdentifierValue(aliasToken);
					} else {
						throw this.error(this.peek(), "Expected identifier or string after 'AS'.");
					}
				}
				// Implicit alias (no AS keyword)
				else if (this.checkIdentifierLike([]) &&
					!this.checkNext(1, TokenType.LPAREN) &&
					!this.checkNext(1, TokenType.DOT) &&
					!this.isEndOfClause() &&
					!this.atAliasBarrier()) {
					const aliasToken = this.advance();
					alias = this.getIdentifierValue(aliasToken);
				}

				// Optional trailing `with inverse (col = expr, …)` — authored
				// write-back expressions (docs/vu-inverses.md § Authored inverses)
				const inverse = this.parseInverseClause();

				columns.push({ type: 'column', expr, alias, inverse });
			}
		} while (this.match(TokenType.COMMA));

		return columns;
	}

	/**
	 * Parse a table identifier (possibly schema-qualified)
	 */
	private tableIdentifier(): AST.IdentifierExpr {
		const startToken = this.peek();
		let schema: string | undefined;
		let name: string;
		let endToken = startToken;
		const contextualKeywords = [...CONTEXTUAL_KEYWORDS, 'temp', 'temporary'];

		// Check for schema.table pattern
		if (this.checkIdentifierLike(contextualKeywords) && this.checkNext(1, TokenType.DOT)) {
			schema = this.consumeIdentifier(contextualKeywords, "Expected schema name.");
			this.advance(); // Consume DOT
			name = this.consumeIdentifier(contextualKeywords, "Expected table name after schema.");
			endToken = this.previous();
		} else if (this.checkIdentifierLike(contextualKeywords)) {
			name = this.consumeIdentifier(contextualKeywords, "Expected table name.");
			endToken = this.previous();
		} else {
			throw this.error(this.peek(), "Expected table name.");
		}

		return {
			type: 'identifier',
			name,
			schema,
			loc: _createLoc(startToken, endToken),
		};
	}

	/**
	 * Parse a comma-separated list of table sources (FROM clause)
	 */
	private tableSourceList(withClause?: AST.WithClause): AST.FromClause[] {
		const sources: AST.FromClause[] = [];

		do {
			// Get the base table source
			let source: AST.FromClause = this.tableSource(withClause);

			// Look for JOINs
			while (this.isJoinToken()) {
				source = this.joinClause(source, withClause);
			}

			sources.push(source);
		} while (this.match(TokenType.COMMA));

		return sources;
	}

	/**
	 * Parse a single table source, which can now be a table name, table-valued function call, or subquery
	 */
	private tableSource(withClause?: AST.WithClause): AST.FromClause {
		const startToken = this.peek();

		// Subquery: any QueryExpr in parens. Decision is made on the token
		// immediately after `(`; all relation-producing forms (SELECT, VALUES,
		// WITH …, INSERT|UPDATE|DELETE w/ RETURNING) flow through the same
		// subquerySource path.
		if (this.startsParenSubquery()) {
			return this.subquerySource(startToken, withClause);
		}

		// Check for function call syntax: IDENTIFIER (
		if (this.checkIdentifierLike(CONTEXTUAL_KEYWORDS) && this.checkNext(1, TokenType.LPAREN)) {
			return this.functionSource(startToken);
		}
		// Otherwise, assume it's a standard table source
		else {
			return this.standardTableSource(startToken);
		}
	}

	/**
	 * Parses a subquery source: `(<QueryExpr>) [AS alias [(cols)]]`.
	 *
	 * Accepts any relation-producing form (SELECT, VALUES, WITH …, or
	 * INSERT/UPDATE/DELETE with RETURNING). The DML branch is enforced to
	 * carry RETURNING because the outer FROM-clause position consumes a
	 * relation, not a side-effect.
	 *
	 * `requireAlias` mandates an explicit user-written alias rather than synthesizing
	 * a default — set for an inline-subquery DML *write target* (`update (select …) as
	 * v set …`), whose `alias` is user-meaningful (the `where`/`set` reference it). A
	 * FROM-clause subquery leaves it false and keeps the generated-alias fallback.
	 */
	private subquerySource(startToken: Token, withClause?: AST.WithClause, requireAlias = false): AST.SubquerySource {
		this.consume(TokenType.LPAREN, "Expected '(' before subquery.");

		const subquery = this.parseQueryExpr(withClause, /*requireReturning*/ true);

		this.consume(TokenType.RPAREN, "Expected ')' after subquery.");

		// Parse optional alias for subquery
		let alias: string;
		let columns: string[] | undefined;

		if (this.match(TokenType.AS)) {
			if (!this.checkIdentifierLike([])) {
				throw this.error(this.peek(), "Expected alias after 'AS'.");
			}
			alias = this.getIdentifierValue(this.advance());
		} else {
			const aliasToken = this.matchBareSourceAlias();
			if (aliasToken) {
				alias = this.getIdentifierValue(aliasToken);
			} else if (requireAlias) {
				// A subquery write target's alias is mandatory and user-meaningful — never a
				// generated default (the `where`/`set` reference it). Reject the bare form.
				throw this.error(this.peek(), "a subquery UPDATE/DELETE write target requires an alias, e.g. (select …) as v");
			} else {
				// Generate a default alias if none provided. Keep separate prefixes
				// for read-only vs mutating bodies so generated aliases stay
				// distinguishable when surfacing in diagnostics.
				const isMutating = subquery.type === 'insert' || subquery.type === 'update' || subquery.type === 'delete';
				alias = `${isMutating ? 'mutating_subquery' : 'subquery'}_${startToken.startOffset}`;
			}
		}

		// Parse optional column list after alias: AS alias(col1, col2, ...)
		if (this.match(TokenType.LPAREN)) {
			columns = [];

			if (!this.check(TokenType.RPAREN)) {
				do {
					columns.push(this.consumeIdentifier(CONTEXTUAL_KEYWORDS, "Expected column name in alias column list."));
				} while (this.match(TokenType.COMMA) && !this.check(TokenType.RPAREN));
			}
			this.consume(TokenType.RPAREN, "Expected ')' after alias column list.");
		}

		const endToken = this.previous();
		return {
			type: 'subquerySource',
			subquery,
			alias,
			columns,
			loc: _createLoc(startToken, endToken),
		};
	}

	/**
	 * Detect and parse a leading inline-subquery DML write target — `(<query>) as v` —
	 * for `update`/`delete`, or `undefined` when the next tokens are not a `(` followed
	 * by a relation-producing keyword (the SAME lookahead {@link tableSource} uses for a
	 * FROM subquery). The alias is mandatory (`requireAlias`); the body re-uses the
	 * shared {@link subquerySource} production, so it requires RETURNING on a DML body
	 * (rejected as a write target downstream) and parses the `as v` / `v(a,b)` alias.
	 */
	private subqueryDmlTarget(withClause?: AST.WithClause): AST.SubquerySource | undefined {
		if (!this.startsParenSubquery()) return undefined;
		return this.subquerySource(this.peek(), withClause, /*requireAlias*/ true);
	}

	/**
	 * True when the cursor is at `(` followed by a relation-producing keyword
	 * (`SELECT` / `VALUES` / `WITH` / a DML keyword) — i.e. the start of a
	 * parenthesized subquery source. Shared by the FROM-clause {@link tableSource}
	 * and the inline-subquery DML target {@link subqueryDmlTarget} so the lookahead
	 * set stays defined once.
	 */
	private startsParenSubquery(): boolean {
		if (!this.check(TokenType.LPAREN)) return false;
		const lookahead = this.current + 1;
		if (lookahead >= this.tokens.length) return false;
		const nextTokenType = this.tokens[lookahead].type;
		return (
			nextTokenType === TokenType.SELECT
			|| nextTokenType === TokenType.VALUES
			|| nextTokenType === TokenType.WITH
			|| nextTokenType === TokenType.INSERT
			|| nextTokenType === TokenType.UPDATE
			|| nextTokenType === TokenType.DELETE
		);
	}

	/** Parses a standard table source (schema.table or table) */
	private standardTableSource(startToken: Token): AST.TableSource {

		// Parse table name (potentially schema-qualified)
		const table = this.tableIdentifier();
		let endToken = this.previous(); // Initialize endToken after parsing table identifier

		// Parse optional alias
		let alias: string | undefined;
		if (this.match(TokenType.AS)) {
			if (!this.checkIdentifierLike(CONTEXTUAL_KEYWORDS)) {
				throw this.error(this.peek(), "Expected alias after 'AS'.");
			}
			const aliasToken = this.advance();
			alias = this.getIdentifierValue(aliasToken);
			endToken = aliasToken;
		} else {
			const aliasToken = this.matchBareSourceAlias();
			if (aliasToken) {
				alias = this.getIdentifierValue(aliasToken);
				endToken = aliasToken;
			}
		}

		return {
			type: 'table',
			table,
			alias,
			loc: _createLoc(startToken, endToken),
		};
	}

	/** Parses a table-valued function source: name(arg1, ...) [AS alias] */
	private functionSource(startToken: Token): AST.FunctionSource {

		const name = this.tableIdentifier(); // name has its own loc
		let endToken = this.previous(); // Initialize endToken after parsing function identifier

		this.consume(TokenType.LPAREN, "Expected '(' after table function name.");

		const args: AST.Expression[] = [];
		if (!this.check(TokenType.RPAREN)) {
			// Handle DISTINCT inside function calls like COUNT(DISTINCT col)
			const distinct = this.matchKeyword('DISTINCT');
			// Handle * argument AFTER checking for distinct
			if (this.match(TokenType.ASTERISK)) {
				// Do not add '*' as an argument to the list for aggregates like COUNT(*)
				if (args.length > 0 || distinct) {
					// '*' is only valid as the *only* argument, potentially after DISTINCT
					// e.g. COUNT(*), COUNT(DISTINCT *) - though DISTINCT * might not be standard SQL?
					// For now, disallow '*' if other args exist.
					throw this.error(this.previous(), "'*' cannot be used with other arguments in function call.");
				}
				// If we parsed '*', the args list remains empty.
			} else {
				// Parse regular arguments if '*' wasn't found
				do {
					args.push(this.expression());
				} while (this.match(TokenType.COMMA));
			}
		}

		endToken = this.consume(TokenType.RPAREN, "Expected ')' after table function arguments.");

		// Parse optional alias (same logic as for standard tables)
		let alias: string | undefined;
		let columns: string[] | undefined;
		if (this.match(TokenType.AS)) {
			if (!this.checkIdentifierLike(CONTEXTUAL_KEYWORDS)) {
				throw this.error(this.peek(), "Expected alias after 'AS'.");
			}
			const aliasToken = this.advance();
			alias = this.getIdentifierValue(aliasToken);
			endToken = aliasToken;
		} else {
			const aliasToken = this.matchBareSourceAlias();
			if (aliasToken) {
				alias = this.getIdentifierValue(aliasToken);
				endToken = aliasToken;
			}
		}

		// Optional column list after alias: alias(col1, col2, ...)
		if (alias && this.match(TokenType.LPAREN)) {
			columns = [];
			if (!this.check(TokenType.RPAREN)) {
				do {
					columns.push(this.consumeIdentifier(CONTEXTUAL_KEYWORDS, "Expected column name in alias column list."));
				} while (this.match(TokenType.COMMA) && !this.check(TokenType.RPAREN));
			}
			endToken = this.consume(TokenType.RPAREN, "Expected ')' after alias column list.");
		}

		return {
			type: 'functionSource',
			name,
			args,
			alias,
			columns,
			loc: _createLoc(startToken, endToken),
		};
	}

	/**
	 * Parse a JOIN clause
	 */
	private joinClause(left: AST.FromClause, withClause?: AST.WithClause): AST.JoinClause {
		const joinStartToken = this.peek(); // Capture token before parsing JOIN type

		// Determine join type
		let joinType: 'inner' | 'left' | 'right' | 'full' | 'cross' = 'inner';

		if (this.match(TokenType.LEFT)) {
			this.match(TokenType.OUTER); // optional
			joinType = 'left';
		} else if (this.match(TokenType.RIGHT)) {
			this.match(TokenType.OUTER); // optional
			joinType = 'right';
		} else if (this.match(TokenType.FULL)) {
			this.match(TokenType.OUTER); // optional
			joinType = 'full';
		} else if (this.match(TokenType.CROSS)) {
			joinType = 'cross';
		} else if (this.match(TokenType.INNER)) {
			joinType = 'inner';
		}

		// Consume JOIN token
		this.consume(TokenType.JOIN, "Expected 'JOIN'.");

		// Optional LATERAL before right side
		const isLateral = this.match(TokenType.LATERAL);
		// Parse right side of join
		const right = this.tableSource(withClause);

		// Parse join condition
		let condition: AST.Expression | undefined;
		let columns: string[] | undefined;
		let endToken = this.previous(); // End token is end of right source initially

		if (this.match(TokenType.ON)) {
			condition = this.expression();
			endToken = this.previous(); // End token is end of ON expression
		} else if (this.match(TokenType.USING)) {
			this.consume(TokenType.LPAREN, "Expected '(' after 'USING'.");
			columns = [];

			do {
				columns.push(this.consumeIdentifier(CONTEXTUAL_KEYWORDS, "Expected column name."));
			} while (this.match(TokenType.COMMA));

			endToken = this.consume(TokenType.RPAREN, "Expected ')' after columns.");
		} else if (joinType !== 'cross') {
			throw this.error(this.peek(), "Expected 'ON' or 'USING' after JOIN.");
		}

		// Optional `exists [left|right] as <name>` existence column clause(s), after a
		// complete ON/USING predicate. One-token lookahead after `exists` (an `as` or
		// side token, never `(`) distinguishes this from the `exists (<subquery>)`
		// predicate; the comma form is recognised only when followed by another
		// `exists`, so a genuine new FROM source comma is left for `tableSourceList`.
		const existence = this.joinExistenceClauses(joinType);
		if (existence) endToken = this.previous();

		return {
			type: 'join',
			joinType,
			left,
			right,
			condition,
			columns,
			isLateral: isLateral || undefined,
			existence,
			loc: _createLoc(joinStartToken, endToken),
		};
	}

	/**
	 * Parse the optional comma-separated `exists [left|right] as <name>` clauses
	 * trailing a join. Returns `undefined` when none are present. Resolves and
	 * validates the side against the join type (default = the unique non-preserved
	 * side; explicit side required for `full`; `inner`/`cross` rejected — no
	 * null-extension means the flag would be a meaningless constant `true`).
	 */
	private joinExistenceClauses(
		joinType: 'inner' | 'left' | 'right' | 'full' | 'cross',
	): ReadonlyArray<AST.JoinExistenceColumn> | undefined {
		// `exists` here must be followed by `as` or a side token, never `(` (which
		// would be the `exists (<subquery>)` predicate). Bail before consuming if the
		// lookahead does not match the clause shape.
		const atExistenceClause = (): boolean =>
			this.check(TokenType.EXISTS) &&
			(this.checkNext(1, TokenType.AS) || this.checkNext(1, TokenType.LEFT) || this.checkNext(1, TokenType.RIGHT));

		if (!atExistenceClause()) return undefined;

		const result: AST.JoinExistenceColumn[] = [];
		do {
			this.consume(TokenType.EXISTS, "Expected 'exists'.");
			let explicitSide: 'left' | 'right' | undefined;
			if (this.match(TokenType.LEFT)) explicitSide = 'left';
			else if (this.match(TokenType.RIGHT)) explicitSide = 'right';
			this.consume(TokenType.AS, "Expected 'as' after 'exists' join existence clause.");
			const name = this.consumeIdentifier(CONTEXTUAL_KEYWORDS, "Expected name after 'exists ... as'.");
			result.push({ side: this.resolveExistenceSide(joinType, explicitSide), name });

			// Continue only on `, exists ...`; a plain comma starts a new FROM source.
		} while (this.check(TokenType.COMMA) && this.checkNext(1, TokenType.EXISTS) && this.advance());

		return result;
	}

	/**
	 * Resolve and validate the side of an `exists [<side>] as` join existence
	 * clause. The flag must reference a null-extendable (non-preserved) side.
	 */
	private resolveExistenceSide(
		joinType: 'inner' | 'left' | 'right' | 'full' | 'cross',
		explicitSide: 'left' | 'right' | undefined,
	): 'left' | 'right' {
		// Non-preserved (null-extendable) sides per join type.
		const nonPreserved: ('left' | 'right')[] =
			joinType === 'left' ? ['right']
			: joinType === 'right' ? ['left']
			: joinType === 'full' ? ['left', 'right']
			: []; // inner / cross: neither side null-extends

		if (nonPreserved.length === 0) {
			throw this.error(this.previous(),
				`'exists ... as' is not valid on an ${joinType.toUpperCase()} join (no side is null-extended, so the flag would be a constant true)`);
		}
		if (explicitSide) {
			if (!nonPreserved.includes(explicitSide)) {
				throw this.error(this.previous(),
					`'exists ${explicitSide} as' references the preserved side of a ${joinType.toUpperCase()} join; only the non-preserved side (${nonPreserved.join('/')}) has a meaningful match flag`);
			}
			return explicitSide;
		}
		if (nonPreserved.length > 1) {
			throw this.error(this.previous(),
				`'exists as' is ambiguous on a ${joinType.toUpperCase()} join — specify 'exists left as' or 'exists right as'`);
		}
		return nonPreserved[0];
	}

	/**
	 * Parse the optional comma-separated `exists <branch> as <name>` membership
	 * clauses that sit between a set-operation keyword and its right leg. Returns
	 * `undefined` when none are present. The `branch` is mandatory (`left` = the leg
	 * already parsed before the operator, `right` = the operand that follows) — there
	 * is no elided form, so `exists` here is ALWAYS followed by `left`/`right`, never
	 * `(`; that one-token lookahead distinguishes the clause from the
	 * `exists (<subquery>)` predicate. Rejected on `diff` (symmetric difference
	 * desugars to two `except`s, so membership is ambiguous).
	 */
	private setOpMembershipClauses(
		op: 'union' | 'unionAll' | 'intersect' | 'except' | 'diff',
	): ReadonlyArray<AST.SetOpMembershipColumn> | undefined {
		const atMembershipClause = (): boolean =>
			this.check(TokenType.EXISTS) &&
			(this.checkNext(1, TokenType.LEFT) || this.checkNext(1, TokenType.RIGHT));

		if (!atMembershipClause()) return undefined;

		if (op === 'diff') {
			throw this.error(this.peek(),
				"'exists <branch> as' membership columns are not valid on DIFF — symmetric difference desugars to two EXCEPTs, so branch membership is ambiguous");
		}

		const result: AST.SetOpMembershipColumn[] = [];
		do {
			this.consume(TokenType.EXISTS, "Expected 'exists'.");
			let branch: 'left' | 'right';
			if (this.match(TokenType.LEFT)) branch = 'left';
			else if (this.match(TokenType.RIGHT)) branch = 'right';
			else throw this.error(this.peek(), "Expected 'left' or 'right' after 'exists' in a set-operation membership clause.");
			this.consume(TokenType.AS, "Expected 'as' after 'exists <branch>' membership clause.");
			const name = this.consumeIdentifier(CONTEXTUAL_KEYWORDS, "Expected name after 'exists <branch> as'.");
			result.push({ branch, name });

			// Continue only on `, exists ...`; a plain comma starts the next leg / clause boundary.
		} while (this.check(TokenType.COMMA) && this.checkNext(1, TokenType.EXISTS) && this.advance());

		return result;
	}

	/**
	 * Parse a left-associative chain of binary operators.
	 * Captures the start token before parsing the first operand, avoiding O(n) token lookups.
	 */
	private parseBinaryChain(
		operand: () => AST.Expression,
		tokenTypes: TokenType[],
		resolveOperator: (token: Token) => string,
	): AST.Expression {
		const startToken = this.peek();
		let expr = operand();

		while (this.match(...tokenTypes)) {
			const operator = resolveOperator(this.previous());
			const right = operand();
			expr = {
				type: 'binary',
				operator,
				left: expr,
				right,
				loc: _createLoc(startToken, this.previous()),
			};
		}

		return expr;
	}

	/**
	 * Parse an expression
	 */
	private expression(): AST.Expression {
		return this.logicalXorOr();
	}

	/**
	 * Parse logical OR and XOR expressions (lowest precedence)
	 */
	private logicalXorOr(): AST.Expression {
		return this.parseBinaryChain(
			() => this.logicalAnd(),
			[TokenType.OR, TokenType.XOR],
			(t) => t.type === TokenType.XOR ? 'XOR' : 'OR',
		);
	}

	/**
	 * Parse logical AND expression
	 */
	private logicalAnd(): AST.Expression {
		return this.parseBinaryChain(
			() => this.notExpression(),
			[TokenType.AND],
			() => 'AND',
		);
	}

	/**
	 * Parse prefix NOT expression. Binds above every predicate (IS [NOT] NULL,
	 * comparison, IN, BETWEEN, LIKE) but below AND/OR/XOR. Right-recursive so
	 * stacked `not not p` falls out naturally.
	 */
	private notExpression(): AST.Expression {
		if (this.match(TokenType.NOT)) {
			const operatorToken = this.previous();
			const right = this.notExpression();
			return { type: 'unary', operator: 'NOT', expr: right, loc: _createLoc(operatorToken, this.previous()) };
		}
		return this.isPredicate();
	}

	/**
	 * Parse the postfix IS predicates, each a unary postfix operator on the
	 * operand: `IS [NOT] NULL`, `IS [NOT] TRUE`, `IS [NOT] FALSE`. A general
	 * `IS <expr>` (anything other than NULL/TRUE/FALSE) is unsupported — we
	 * backtrack the consumed `IS [NOT]` so the caller surfaces the same error
	 * as before.
	 */
	private isPredicate(): AST.Expression {
		const startToken = this.peek();
		const expr = this.equality();

		if (this.match(TokenType.IS)) {
			const isNot = this.match(TokenType.NOT);
			if (this.match(TokenType.NULL)) {
				const operator = isNot ? 'IS NOT NULL' : 'IS NULL';
				return { type: 'unary', operator, expr, loc: _createLoc(startToken, this.previous()) };
			}
			if (this.match(TokenType.TRUE)) {
				const operator = isNot ? 'IS NOT TRUE' : 'IS TRUE';
				return { type: 'unary', operator, expr, loc: _createLoc(startToken, this.previous()) };
			}
			if (this.match(TokenType.FALSE)) {
				const operator = isNot ? 'IS NOT FALSE' : 'IS FALSE';
				return { type: 'unary', operator, expr, loc: _createLoc(startToken, this.previous()) };
			}
			// IS [NOT] not followed by NULL/TRUE/FALSE — backtrack the IS [NOT].
			if (isNot) this.current--;
			this.current--;
		}

		return expr;
	}

	/**
	 * Parse equality expression
	 */
	private equality(): AST.Expression {
		return this.parseBinaryChain(
			() => this.comparison(),
			[TokenType.EQUAL, TokenType.EQUAL_EQUAL, TokenType.NOT_EQUAL],
			(t) => {
				switch (t.type) {
					case TokenType.NOT_EQUAL: return '!=';
					case TokenType.EQUAL_EQUAL: return '==';
					default: return '=';
				}
			},
		);
	}

	/**
	 * Parse comparison expression
	 */
	private comparison(): AST.Expression {
		const startToken = this.peek();
		let expr = this.term();

		while (this.match(
			TokenType.LESS, TokenType.LESS_EQUAL,
			TokenType.GREATER, TokenType.GREATER_EQUAL,
			TokenType.BETWEEN, TokenType.IN, TokenType.NOT,
			TokenType.LIKE
		)) {
			const operatorToken = this.previous();

			// Handle NOT IN, NOT BETWEEN, and NOT LIKE
			if (operatorToken.type === TokenType.NOT) {
				const notStartToken = operatorToken;
				if (this.match(TokenType.IN)) {
					// NOT IN
					this.consume(TokenType.LPAREN, "Expected '(' after NOT IN.");

					if (this.checkSubqueryStart()) {
						// NOT IN subquery: expr NOT IN (<QueryExpr>)
						const subquery = this.parseQueryExpr(undefined, /*requireReturning*/ true);
						const endToken = this.consume(TokenType.RPAREN, "Expected ')' after NOT IN subquery.");

						// Create an IN expression with subquery, then wrap in NOT
						const inExpr: AST.InExpr = {
							type: 'in',
							expr,
							subquery,
							loc: _createLoc(startToken, endToken),
						};

						expr = {
							type: 'unary',
							operator: 'NOT',
							expr: inExpr,
							loc: _createLoc(notStartToken, endToken),
						};
					} else {
						// NOT IN value list: expr NOT IN (value1, value2, ...)
						const values: AST.Expression[] = [];
						if (!this.check(TokenType.RPAREN)) {
							do {
								values.push(this.expression());
							} while (this.match(TokenType.COMMA));
						}
						const endToken = this.consume(TokenType.RPAREN, "Expected ')' after NOT IN values.");

						// Create an IN expression with value list, then wrap in NOT
						const inExpr: AST.InExpr = {
							type: 'in',
							expr,
							values,
							loc: _createLoc(startToken, endToken),
						};

						expr = {
							type: 'unary',
							operator: 'NOT',
							expr: inExpr,
							loc: _createLoc(notStartToken, endToken),
						};
					}
				} else if (this.match(TokenType.BETWEEN)) {
					// NOT BETWEEN
					const lower = this.term();
					this.consume(TokenType.AND, "Expected 'AND' after NOT BETWEEN lower bound.");
					const upper = this.term();
					const endToken = this.previous(); // End token is end of upper expr

					// Create the NOT BETWEEN expression as a dedicated node type
					expr = {
						type: 'between',
						expr,
						lower,
						upper,
						not: true,
						loc: _createLoc(notStartToken, endToken),
					};
				} else if (this.match(TokenType.LIKE)) {
					// NOT LIKE
					const pattern = this.term();
					const endToken = this.previous(); // End token is end of pattern expr

					// Create the LIKE expression as a binary expression, then wrap in NOT
					const likeExpr: AST.BinaryExpr = {
						type: 'binary',
						operator: 'LIKE',
						left: expr,
						right: pattern,
						loc: _createLoc(startToken, endToken),
					};

					expr = {
						type: 'unary',
						operator: 'NOT',
						expr: likeExpr,
						loc: _createLoc(notStartToken, endToken),
					};
				} else {
					// Put back the NOT token and break out of the loop
					this.current--;
					break;
				}
			} else if (operatorToken.type === TokenType.LIKE) {
				// Parse LIKE expression: expr LIKE pattern
				const pattern = this.term();
				const endToken = this.previous(); // End token is end of pattern expr

				// Create the LIKE expression as a binary expression
				expr = {
					type: 'binary',
					operator: 'LIKE',
					left: expr,
					right: pattern,
					loc: _createLoc(startToken, endToken),
				};
			} else if (operatorToken.type === TokenType.BETWEEN) {
				// Parse BETWEEN expression: expr BETWEEN low AND high
				const lower = this.term();
				this.consume(TokenType.AND, "Expected 'AND' after BETWEEN lower bound.");
				const upper = this.term();
				const endToken = this.previous(); // End token is end of upper expr

				// Create the BETWEEN expression as a dedicated node type
				expr = {
					type: 'between',
					expr,
					lower,
					upper,
					loc: _createLoc(startToken, endToken),
				};
			} else if (operatorToken.type === TokenType.IN) {
				// Parse IN expression: expr IN (value1, value2, ...) or expr IN (<QueryExpr>)
				this.consume(TokenType.LPAREN, "Expected '(' after IN.");

				// Check if this is a subquery or value list
				if (this.checkSubqueryStart()) {
					// IN subquery: expr IN (<QueryExpr>)
					const subquery = this.parseQueryExpr(undefined, /*requireReturning*/ true);
					const endToken = this.consume(TokenType.RPAREN, "Expected ')' after IN subquery.");

					// Create an IN expression with subquery
					expr = {
						type: 'in',
						expr,
						subquery,
						loc: _createLoc(startToken, endToken),
					};
				} else {
					// IN value list: expr IN (value1, value2, ...)
					const values: AST.Expression[] = [];
					if (!this.check(TokenType.RPAREN)) {
						do {
							values.push(this.expression());
						} while (this.match(TokenType.COMMA));
					}
					const endToken = this.consume(TokenType.RPAREN, "Expected ')' after IN values.");

					// Create an IN expression with value list
					expr = {
						type: 'in',
						expr,
						values,
						loc: _createLoc(startToken, endToken),
					};
				}
			} else {
				// Handle other comparison operators
				let operator: string;
				switch (operatorToken.type) {
					case TokenType.LESS: operator = '<'; break;
					case TokenType.LESS_EQUAL: operator = '<='; break;
					case TokenType.GREATER: operator = '>'; break;
					case TokenType.GREATER_EQUAL: operator = '>='; break;
					default: operator = '?';
				}

				const right = this.term();
				const endToken = this.previous(); // End token is end of right expr
				expr = {
					type: 'binary',
					operator,
					left: expr,
					right,
					loc: _createLoc(startToken, endToken),
				};
			}
		}

		return expr;
	}

	/**
	 * Parse addition and subtraction
	 */
	private term(): AST.Expression {
		return this.parseBinaryChain(
			() => this.factor(),
			[TokenType.PLUS, TokenType.MINUS],
			(t) => t.type === TokenType.PLUS ? '+' : '-',
		);
	}

	/**
	 * Parse multiplication and division
	 */
	private factor(): AST.Expression {
		return this.parseBinaryChain(
			() => this.unary(),
			[TokenType.ASTERISK, TokenType.SLASH, TokenType.PERCENT],
			(t) => t.lexeme,
		);
	}

	/**
	 * Parse arithmetic unary prefix operators (-, +, ~). Recurses to support
	 * stacked unary (e.g. `- -1`). Prefix NOT is handled higher up by
	 * `notExpression()` so that it binds above all predicates.
	 */
	private unary(): AST.Expression {
		if (this.match(TokenType.MINUS, TokenType.PLUS, TokenType.TILDE)) {
			const operatorToken = this.previous();
			const right = this.unary();
			return { type: 'unary', operator: operatorToken.lexeme, expr: right, loc: _createLoc(operatorToken, this.previous()) };
		}
		return this.concatenation();
	}

	/**
	 * Parse concatenation expression (||)
	 */
	private concatenation(): AST.Expression {
		return this.parseBinaryChain(
			() => this.collateExpression(),
			[TokenType.PIPE_PIPE],
			() => '||',
		);
	}

	/**
	 * Parse COLLATE expression
	 */
	private collateExpression(): AST.Expression {
		const startToken = this.peek();
		const expr = this.jsonPath();

		if (this.matchKeyword('COLLATE')) {
			const collationToken = this.consume(TokenType.IDENTIFIER, "Expected collation name after COLLATE.");
			// getIdentifierValue strips the quotes from a quoted collation name (e.g.
			// `collate "select"`); using the raw lexeme would embed them in the value.
			return { type: 'collate', expr, collation: this.getIdentifierValue(collationToken), loc: _createLoc(startToken, collationToken) };
		}

		return expr;
	}

	/**
	 * Parse JSON path operators -> and ->>
	 * Desugars to json_extract() function calls.
	 * -> returns JSON (native object), ->> returns SQL scalar value.
	 */
	private jsonPath(): AST.Expression {
		const startToken = this.peek();
		let expr = this.primary();

		while (this.match(TokenType.ARROW, TokenType.DARROW)) {
			const opToken = this.previous();
			const pathExpr = this.jsonPathRhs();

			// Desugar to json_extract(expr, path)
			expr = {
				type: 'function',
				name: 'json_extract',
				args: [expr, pathExpr],
				loc: _createLoc(startToken, this.previous()),
			};

			// For ->>, wrap in cast(... as text) to ensure scalar TEXT result
			if (opToken.type === TokenType.DARROW) {
				expr = {
					type: 'cast',
					expr,
					targetType: 'text',
					loc: _createLoc(startToken, this.previous()),
				};
			}
		}

		return expr;
	}

	/**
	 * Parse the right-hand side of -> / ->> operators.
	 * Accepts string literals, integer literals, or general expressions.
	 * Normalizes shorthand paths: 'name' → '$.name', 0 → '$[0]'.
	 */
	private jsonPathRhs(): AST.Expression {
		if (this.match(TokenType.STRING)) {
			const token = this.previous();
			let path = token.literal as string;
			if (!path.startsWith('$')) {
				path = '$.' + path;
			}
			return { type: 'literal', value: path, loc: _createLoc(token, token) };
		}

		if (this.match(TokenType.INTEGER)) {
			const token = this.previous();
			const index = token.literal as number;
			const path = `$[${index}]`;
			return { type: 'literal', value: path, loc: _createLoc(token, token) };
		}

		// General expression — user must provide a proper JSON path
		return this.primary();
	}

	/**
	 * Parse primary expressions (literals, identifiers, etc.)
	 */
	private primary(): AST.Expression {
		const startToken = this.peek();

		// Case expression
		if (this.matchKeyword('CASE')) {
			return this.parseCaseExpression(startToken);
		}

		// CAST expression: CAST(expr AS type)
		if (this.peekKeyword('CAST') && this.checkNext(1, TokenType.LPAREN)) {
			const castToken = this.advance(); // Consume CAST
			this.consume(TokenType.LPAREN, "Expected '(' after CAST.");
			const expr = this.expression();
			this.consumeKeyword('AS', "Expected 'AS' in CAST expression.");
			// Allow type names that might be keywords (e.g., TEXT, INTEGER, REAL, BLOB)
			// or multi-word type names if supported (e.g., "VARCHAR(255)") - for now, simple identifier
			if (!this.check(TokenType.IDENTIFIER) &&
				!this.isTypeNameKeyword(this.peek().lexeme.toUpperCase())) {
				throw this.error(this.peek(), "Expected type name after 'AS' in CAST expression.");
			}
			const typeToken = this.advance(); // Consume type name
			const targetType = typeToken.lexeme;
			const endToken = this.consume(TokenType.RPAREN, "Expected ')' after CAST expression type.");
			return { type: 'cast', expr, targetType, loc: _createLoc(castToken, endToken) };
		}

		// EXISTS expression: EXISTS(<QueryExpr>)
		if (this.match(TokenType.EXISTS)) {
			const existsToken = this.previous();
			this.consume(TokenType.LPAREN, "Expected '(' after EXISTS.");
			const subquery = this.parseQueryExpr(undefined, /*requireReturning*/ true);
			const endToken = this.consume(TokenType.RPAREN, "Expected ')' after EXISTS subquery.");
			return {
				type: 'exists',
				subquery,
				loc: _createLoc(existsToken, endToken)
			};
		}

		// Literals
		if (this.match(TokenType.INTEGER, TokenType.FLOAT, TokenType.STRING, TokenType.NULL, TokenType.TRUE, TokenType.FALSE, TokenType.BLOB)) {
			const token = this.previous();
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			let value: any;
			let lexeme: string | undefined = undefined;

			if (token.type === TokenType.NULL) {
				value = null;
				lexeme = token.lexeme; // Store original case (NULL vs null)
			} else if (token.type === TokenType.TRUE) {
				value = true;
				lexeme = token.lexeme; // Store original case (TRUE vs true)
			} else if (token.type === TokenType.FALSE) {
				value = false;
				lexeme = token.lexeme; // Store original case (FALSE vs false)
			} else if (token.type === TokenType.FLOAT) {
				// For FLOAT, parse the literal (which is the original string)
				value = parseFloat(token.literal as string);
				lexeme = token.literal as string; // Store original string as lexeme
			} else if (token.type === TokenType.INTEGER) {
				value = token.literal; // Already number or BigInt
				if (token.lexeme !== String(value)) { // Store lexeme only if different
					lexeme = token.lexeme;
				}
			} else {
				value = token.literal; // STRING, BLOB
			}

			const node: AST.LiteralExpr = { type: 'literal', value, loc: _createLoc(startToken, token) };
			if (lexeme !== undefined) {
				node.lexeme = lexeme;
			}
			return node;
		}

		// Parameter expressions (?, :name, $name)
		if (this.match(TokenType.QUESTION)) {
			const token = this.previous();
			return { type: 'parameter', index: this.parameterPosition++, loc: _createLoc(startToken, token) };
		}

		if (this.match(TokenType.COLON, TokenType.DOLLAR)) {
			// Named parameter (can be identifier like :name or integer like :1)
			if (!this.check(TokenType.IDENTIFIER) && !this.check(TokenType.INTEGER)) {
				throw this.error(this.peek(), "Expected identifier or number after parameter prefix.");
			}
			const nameToken = this.advance();
			return { type: 'parameter', name: nameToken.lexeme, loc: _createLoc(startToken, nameToken) };
		}

		// Function call (with optional window function support)
		if (this.checkIdentifierLike([...CONTEXTUAL_KEYWORDS, 'replace']) && this.checkNext(1, TokenType.LPAREN)) {
			const name = this.consumeIdentifier([...CONTEXTUAL_KEYWORDS, 'replace'], "Expected function name.");

			this.consume(TokenType.LPAREN, "Expected '(' after function name.");

			const args: AST.Expression[] = [];
			let distinct = false;
			if (!this.check(TokenType.RPAREN)) {
				// Handle DISTINCT inside function calls like COUNT(DISTINCT col)
				distinct = this.matchKeyword('DISTINCT');
				// Handle * argument AFTER checking for distinct
				if (this.match(TokenType.ASTERISK)) {
					// Do not add '*' as an argument to the list for aggregates like COUNT(*)
					if (args.length > 0 || distinct) {
						// '*' is only valid as the *only* argument, potentially after DISTINCT
						// e.g. COUNT(*), COUNT(DISTINCT *) - though DISTINCT * might not be standard SQL?
						// For now, disallow '*' if other args exist.
						throw this.error(this.previous(), "'*' cannot be used with other arguments in function call.");
					}
					// If we parsed '*', the args list remains empty.
				} else {
					// Parse regular arguments if '*' wasn't found
					do {
						args.push(this.expression());
					} while (this.match(TokenType.COMMA));
				}
			}

			const endToken = this.consume(TokenType.RPAREN, "Expected ')' after function arguments.");

			const funcExpr: AST.FunctionExpr = {
				type: 'function',
				name,
				args,
				loc: _createLoc(startToken, endToken)
			};

			// Add distinct field if it was parsed
			if (distinct) {
				funcExpr.distinct = true;
			}

			// Check for OVER clause (window function)
			if (this.matchKeyword('OVER')) {
				const window = this.parseWindowSpecification();
				const overEndToken = this.previous();
				return {
					type: 'windowFunction',
					function: funcExpr,
					window,
					loc: _createLoc(startToken, overEndToken)
				};
			}

			return funcExpr;
		}

		// Column/identifier expressions
		if (this.checkIdentifierLike(CONTEXTUAL_KEYWORDS)) {
			// Schema.table.column
			if (this.checkNext(1, TokenType.DOT) && this.checkIdentifierLikeAt(2, CONTEXTUAL_KEYWORDS) &&
				this.checkNext(3, TokenType.DOT) && this.checkIdentifierLikeAt(4, CONTEXTUAL_KEYWORDS)) {
				const schema = this.consumeIdentifier(CONTEXTUAL_KEYWORDS, "Expected schema name.");
				this.advance(); // Consume DOT
				const table = this.consumeIdentifier(CONTEXTUAL_KEYWORDS, "Expected table name.");
				this.advance(); // Consume DOT
				const name = this.consumeIdentifier(CONTEXTUAL_KEYWORDS, "Expected column name.");
				const nameToken = this.previous();

				return {
					type: 'column',
					name,
					table,
					schema,
					loc: _createLoc(startToken, nameToken),
				};
			}
			// table.column
			else if (this.checkNext(1, TokenType.DOT) && this.checkIdentifierLikeAt(2, CONTEXTUAL_KEYWORDS)) {
				const table = this.consumeIdentifier(CONTEXTUAL_KEYWORDS, "Expected table name.");
				this.advance(); // Consume DOT
				const name = this.consumeIdentifier(CONTEXTUAL_KEYWORDS, "Expected column name.");
				const nameToken = this.previous();

				return {
					type: 'column',
					name,
					table,
					loc: _createLoc(startToken, nameToken),
				};
			}
			// just column
			else {
				const name = this.consumeIdentifier(CONTEXTUAL_KEYWORDS, "Expected column name.");
				const nameToken = this.previous();

				return {
					type: 'column',
					name,
					loc: _createLoc(startToken, nameToken),
				};
			}
		}

		// Parenthesized expression or scalar / row subquery.
		// A leading SELECT/VALUES/WITH/INSERT/UPDATE/DELETE here disambiguates
		// to a subquery; anything else is a parenthesized scalar expression.
		if (this.match(TokenType.LPAREN)) {
			if (this.checkSubqueryStart()) {
				const subquery = this.parseQueryExpr(undefined, /*requireReturning*/ true);
				this.consume(TokenType.RPAREN, "Expected ')' after subquery.");
				return {
					type: 'subquery',
					query: subquery,
					loc: _createLoc(startToken, this.previous())
				};
			} else {
				// Regular parenthesized expression
				const expr = this.expression();
				this.consume(TokenType.RPAREN, "Expected ')' after expression.");
				return expr;
			}
		}

		throw this.error(this.peek(), "Expected expression.");
	}

	/**
	 * Parses a window specification: (PARTITION BY ... ORDER BY ... [frame])
	 */
	private parseWindowSpecification(): AST.WindowDefinition {
		if (this.match(TokenType.LPAREN)) {
			let partitionBy: AST.Expression[] | undefined;
			let orderBy: AST.OrderByClause[] | undefined;
			let frame: AST.WindowFrame | undefined;

			if (this.matchKeyword('PARTITION')) {
				this.consumeKeyword('BY', "Expected 'BY' after 'PARTITION'.");
				partitionBy = [];
				do {
					partitionBy.push(this.expression());
				} while (this.match(TokenType.COMMA));
			}

			if (this.matchKeyword('ORDER')) {
				this.consumeKeyword('BY', "Expected 'BY' after 'ORDER'.");
				orderBy = [];
				do {
					const expr = this.expression();
					const direction = this.match(TokenType.DESC) ? 'desc' : (this.match(TokenType.ASC) ? 'asc' : 'asc');

					// Handle NULLS FIRST/LAST
					let nulls: 'first' | 'last' | undefined;
					if (this.matchKeyword('NULLS')) {
						if (this.matchKeyword('FIRST')) {
							nulls = 'first';
						} else if (this.matchKeyword('LAST')) {
							nulls = 'last';
						} else {
							throw this.error(this.peek(), "Expected 'FIRST' or 'LAST' after 'NULLS'.");
						}
					}

					const orderClause: AST.OrderByClause = { expr, direction };
					if (nulls) {
						orderClause.nulls = nulls;
					}
					orderBy.push(orderClause);
				} while (this.match(TokenType.COMMA));
			}

			// Frame clause (ROWS|RANGE ...)
			if (this.matchKeyword('ROWS') || this.matchKeyword('RANGE')) {
				const frameType = this.previous().lexeme.toLowerCase() as 'rows' | 'range';

				// Handle both BETWEEN...AND and single bound syntax
				if (this.matchKeyword('BETWEEN')) {
					// ROWS BETWEEN start_bound AND end_bound
					const start = this.parseWindowFrameBound();
					this.consumeKeyword('AND', "Expected 'AND' after frame start bound.");
					const end = this.parseWindowFrameBound();
					frame = { type: frameType, start, end };
				} else {
					// ROWS start_bound (shorthand for ROWS BETWEEN start_bound AND CURRENT ROW)
					const start = this.parseWindowFrameBound();
					frame = { type: frameType, start, end: null };
				}
			}

			this.consume(TokenType.RPAREN, "Expected ')' after window specification.");
			return { type: 'windowDefinition', partitionBy, orderBy, frame };
		} else {
			// Window name (not implemented)
			throw this.error(this.peek(), 'Window name references are not yet supported. Use explicit window specs.');
		}
	}

	/**
	 * Parses a window frame bound (UNBOUNDED PRECEDING, CURRENT ROW, n PRECEDING/FOLLOWING)
	 */
	private parseWindowFrameBound(): AST.WindowFrameBound {
		if (this.matchKeyword('UNBOUNDED')) {
			if (this.matchKeyword('PRECEDING')) {
				return { type: 'unboundedPreceding' };
			} else if (this.matchKeyword('FOLLOWING')) {
				return { type: 'unboundedFollowing' };
			} else {
				throw this.error(this.peek(), "Expected PRECEDING or FOLLOWING after UNBOUNDED.");
			}
		} else if (this.matchKeyword('CURRENT')) {
			this.consumeKeyword('ROW', "Expected 'ROW' after 'CURRENT'.");
			return { type: 'currentRow' };
		} else {
			const value = this.expression();
			if (this.matchKeyword('PRECEDING')) {
				return { type: 'preceding', value };
			} else if (this.matchKeyword('FOLLOWING')) {
				return { type: 'following', value };
			} else {
				throw this.error(this.peek(), "Expected PRECEDING or FOLLOWING after frame value.");
			}
		}
	}

	// Helper methods for token management

	private match(...types: TokenType[]): boolean {
		for (const type of types) {
			if (this.check(type)) {
				this.advance();
				return true;
			}
		}
		return false;
	}

	private consume(type: TokenType, message: string): Token {
		if (this.check(type)) {
			return this.advance();
		}

		// If a ')' was expected, point back to the matching '('
		if (type === TokenType.RPAREN && this.parenStack.length > 0) {
			const openToken = this.parenStack[this.parenStack.length - 1];
			const got = this.peek();
			quereusError(
				`${message} Unterminated '(' opened at line ${openToken.startLine}, column ${openToken.startColumn}. Got '${got.lexeme}'.`,
				StatusCode.ERROR,
				undefined,
				{
					loc: {
						start: { line: openToken.startLine, column: openToken.startColumn },
						end: { line: this.peek().endLine, column: this.peek().endColumn },
					},
				}
			);
		}

		const got = this.peek();
		this.error(got, `${message} Got '${got.lexeme}'.`);
	}

	private check(type: TokenType): boolean {
		if (this.isAtEnd()) return false;
		return this.peek().type === type;
	}

	private checkNext(n: number, type: TokenType): boolean {
		if (this.current + n >= this.tokens.length) return false;
		return this.tokens[this.current + n].type === type;
	}

	/**
	 * Non-consuming lookahead for a trailing `with defaults` clause — `WITH`
	 * followed by the contextual `DEFAULTS` keyword (an IDENTIFIER lexeme, since
	 * DEFAULTS is not reserved). Used by the VALUES trailing-clause path to decide
	 * whether to wrap `VALUES …` as `SELECT * FROM (VALUES …)` so the select spine's
	 * {@link parseDefaultsClause} can consume the clause — exactly how a trailing
	 * ORDER BY / LIMIT on VALUES already wraps. A trailing `WITH TAGS` (DDL-level)
	 * never matches, so it stays with the outer DDL parser.
	 */
	private checkWithDefaults(): boolean {
		if (!this.check(TokenType.WITH)) return false;
		const next = this.tokens[this.current + 1];
		return next !== undefined
			&& next.type === TokenType.IDENTIFIER
			&& next.lexeme.toUpperCase() === 'DEFAULTS';
	}

	private advance(): Token {
		if (!this.isAtEnd()) this.current++;
		const tok = this.previous();
		// Maintain parenthesis balance for precise diagnostics
		if (tok.type === TokenType.LPAREN) {
			this.parenStack.push(tok);
		} else if (tok.type === TokenType.RPAREN) {
			if (this.parenStack.length === 0) {
				quereusError(
					`Unmatched ')' at line ${tok.startLine}, column ${tok.startColumn}.`,
					StatusCode.ERROR,
					undefined,
					{ loc: { start: { line: tok.startLine, column: tok.startColumn }, end: { line: tok.endLine, column: tok.endColumn } } }
				);
			} else {
				this.parenStack.pop();
			}
		}
		return tok;
	}

	private isAtEnd(): boolean {
		return this.peek().type === TokenType.EOF;
	}

	private peek(): Token {
		return this.tokens[this.current];
	}

	private previous(): Token {
		return this.tokens[this.current - 1];
	}

	private error(token: Token, message: string): never {
		// If we see common starter tokens for a different clause where a separator/comma or keyword was expected,
		// enhance the message to hint at likely fixes instead of generic parenthesis errors.
		const nextLex = token.lexeme?.toUpperCase?.() || token.lexeme;
		const hintParts: string[] = [];
		if (this.peekKeyword('CONSTRAINT') || this.peekKeyword('PRIMARY') || this.peekKeyword('UNIQUE') || this.peekKeyword('CHECK') || this.peekKeyword('FOREIGN')) {
			hintParts.push("If you're in CREATE TABLE, you might be missing a comma between elements.");
		}
		if (nextLex === 'ON' && !this.peekKeyword('JOIN')) {
			hintParts.push("'ON' must follow a JOIN. Use WHERE for filters in subqueries.");
		}
		const fullMessage = hintParts.length > 0 ? `${message} ${hintParts.join(' ')}` : message;
		quereusError(
			fullMessage,
			StatusCode.ERROR,
			undefined,
			{
				loc: {
					start: {
						line: token.startLine,
						column: token.startColumn,
					},
					end: {
						line: token.endLine,
						column: token.endColumn,
					}
				}
			}
		);
	}

	private isJoinToken(): boolean {
		return this.check(TokenType.JOIN) ||
			this.check(TokenType.INNER) ||
			this.check(TokenType.LEFT) ||
			this.check(TokenType.RIGHT) ||
			this.check(TokenType.FULL) ||
			this.check(TokenType.CROSS);
	}

	/**
	 * Consumes and returns an implicit (no-`as`) alias for a FROM-clause source,
	 * or undefined when the cursor isn't sitting on one. A trailing comma is fine —
	 * it only ends the source list item (`from t a, u b`).
	 */
	private matchBareSourceAlias(): Token | undefined {
		if (!this.checkIdentifierLike([]) ||
			this.checkNext(1, TokenType.DOT) ||
			this.isJoinToken() ||
			this.isEndOfClause() ||
			this.atAliasBarrier()) {
			return undefined;
		}
		return this.advance();
	}

	/**
	 * Runs `parse` with `words` (uppercase lexemes) barred from the bare-alias slot.
	 * See {@link aliasBarriers}; nesting is supported and the barrier always pops.
	 */
	private withAliasBarrier<T>(words: ReadonlySet<string>, parse: () => T): T {
		this.aliasBarriers.push({ words, parenDepth: this.parenStack.length });
		try {
			return parse();
		} finally {
			this.aliasBarriers.pop();
		}
	}

	/**
	 * True when the cursor sits on a bare identifier an active barrier reserves.
	 * Only fires at the paren depth the barrier was pushed at: an alias inside an
	 * open `(` — a subquery source, a scalar subquery — cannot be confused with the
	 * start of a sibling item, so `from t2 materialized` keeps working there.
	 */
	private atAliasBarrier(): boolean {
		if (this.aliasBarriers.length === 0) return false;
		const token = this.peek();
		// A quoted identifier carries `literal`; only bare words are ambiguous, so
		// `"materialized"` stays usable as an alias.
		if (token.type !== TokenType.IDENTIFIER || token.literal !== undefined) return false;
		const upper = token.lexeme.toUpperCase();
		const depth = this.parenStack.length;
		return this.aliasBarriers.some(b => b.parenDepth === depth && b.words.has(upper));
	}

	/**
	 * True when the current token starts a `QueryExpr` (SELECT, VALUES, WITH,
	 * INSERT, UPDATE, DELETE). Used by callers that have already consumed an
	 * `(` to decide between a subquery and a parenthesized scalar expression.
	 */
	private checkSubqueryStart(): boolean {
		return this.check(TokenType.SELECT)
			|| this.check(TokenType.VALUES)
			|| this.check(TokenType.WITH)
			|| this.check(TokenType.INSERT)
			|| this.check(TokenType.UPDATE)
			|| this.check(TokenType.DELETE);
	}

	// NOTE: this is also the stop set for bare (no-`as`) aliases. Any new clause keyword
	// that can follow a select item or table source must be added here, or it will be
	// swallowed as an alias — unless it lexes to its own TokenType, which keeps it safe.
	// A keyword that is only reserved *inside* an enclosing block (e.g. `materialized`
	// between `declare schema` items) does not belong here — that is a different idea,
	// handled by the scoped {@link atAliasBarrier} check at both bare-alias sites.
	private isEndOfClause(): boolean {
		const token = this.peek().type;
		return token === TokenType.FROM ||
			token === TokenType.WHERE ||
			token === TokenType.GROUP ||
			token === TokenType.HAVING ||
			token === TokenType.ORDER ||
			token === TokenType.LIMIT ||
			token === TokenType.UNION || token === TokenType.DIFF || token === TokenType.INTERSECT || token === TokenType.EXCEPT ||
			token === TokenType.SEMICOLON ||
			token === TokenType.EOF;
	}

	// --- Statement Parsing Stubs ---

	/** @internal */
	private updateStatement(startToken: Token, withClause?: AST.WithClause): AST.UpdateStmt {
		// Inline subquery target: `update (select …) as v set …`. When present, the
		// alias is the target's correlation name; mirror it into a synthetic placeholder
		// `table` (= the alias) so generic `stmt.table.name` reads stay total, and carry
		// it on `alias`. Otherwise fall through to the ordinary named/CTE target.
		const targetSource = this.subqueryDmlTarget(withClause);
		const table: AST.IdentifierExpr = targetSource
			? { type: 'identifier', name: targetSource.alias, loc: targetSource.loc }
			: this.tableIdentifier();

		// Parse mutation context assignments and/or tags if present (either may also
		// appear trailing, after WHERE, via parseTrailingWithClauses).
		let contextValues: AST.ContextAssignment[] | undefined;
		let tags: Record<string, SqlValue> | undefined;
		while (this.matchKeyword('WITH')) {
			if (this.matchKeyword('CONTEXT')) {
				contextValues = this.parseContextAssignments();
			} else if (this.matchKeyword('TAGS')) {
				tags = this.parseTags();
			} else {
				// Not a WITH CONTEXT / WITH TAGS clause, backtrack
				this.current--;
				break;
			}
		}

		this.consume(TokenType.SET, "Expected 'SET' after table name in UPDATE.");
		const assignments: { column: string; value: AST.Expression }[] = [];
		do {
			const column = this.consumeIdentifier(CONTEXTUAL_KEYWORDS, "Expected column name in SET clause.");
			this.consume(TokenType.EQUAL, "Expected '=' after column name in SET clause.");
			const value = this.expression();
			assignments.push({ column, value });
		} while (this.match(TokenType.COMMA));
		let where: AST.Expression | undefined;
		if (this.match(TokenType.WHERE)) {
			where = this.expression();
		}

		// Parse trailing WITH clauses (WITH CONTEXT and/or WITH SCHEMA in any order)
		const trailingClauses = this.parseTrailingWithClauses();
		if (trailingClauses.contextValues) {
			if (contextValues) {
				throw this.error(this.previous(), "Duplicate WITH CONTEXT clause");
			}
			contextValues = trailingClauses.contextValues;
		}
		if (trailingClauses.tags) {
			if (tags) {
				throw this.error(this.previous(), "Duplicate WITH TAGS clause");
			}
			tags = trailingClauses.tags;
		}
		const schemaPath = trailingClauses.schemaPath;

		// Parse RETURNING clause if present
		let returning: AST.ResultColumn[] | undefined;
		if (this.matchKeyword('RETURNING')) {
			returning = this.columnList();
		}

		const endToken = this.previous();
		return { type: 'update', table, targetSource, alias: targetSource?.alias, assignments, where, returning, contextValues, schemaPath, tags, loc: _createLoc(startToken, endToken) };
	}

	/** @internal */
	private deleteStatement(startToken: Token, withClause?: AST.WithClause): AST.DeleteStmt {
		// `delete` consumes an optional leading `FROM`; the inline-subquery target check
		// runs AFTER it so `delete from (select …) as v` works (and `delete (select …) as
		// v` too, matching the optional-FROM behavior). See updateStatement.
		this.matchKeyword('FROM');
		const targetSource = this.subqueryDmlTarget(withClause);
		const table: AST.IdentifierExpr = targetSource
			? { type: 'identifier', name: targetSource.alias, loc: targetSource.loc }
			: this.tableIdentifier();

		// Parse mutation context assignments and/or tags if present (either may also
		// appear trailing, after WHERE, via parseTrailingWithClauses).
		let contextValues: AST.ContextAssignment[] | undefined;
		let tags: Record<string, SqlValue> | undefined;
		while (this.matchKeyword('WITH')) {
			if (this.matchKeyword('CONTEXT')) {
				contextValues = this.parseContextAssignments();
			} else if (this.matchKeyword('TAGS')) {
				tags = this.parseTags();
			} else {
				// Not a WITH CONTEXT / WITH TAGS clause, backtrack
				this.current--;
				break;
			}
		}

		let where: AST.Expression | undefined;
		if (this.match(TokenType.WHERE)) {
			where = this.expression();
		}

		// Parse trailing WITH clauses (WITH CONTEXT and/or WITH SCHEMA in any order)
		const trailingClauses = this.parseTrailingWithClauses();
		if (trailingClauses.contextValues) {
			if (contextValues) {
				throw this.error(this.previous(), "Duplicate WITH CONTEXT clause");
			}
			contextValues = trailingClauses.contextValues;
		}
		if (trailingClauses.tags) {
			if (tags) {
				throw this.error(this.previous(), "Duplicate WITH TAGS clause");
			}
			tags = trailingClauses.tags;
		}
		const schemaPath = trailingClauses.schemaPath;

		// Parse RETURNING clause if present
		let returning: AST.ResultColumn[] | undefined;
		if (this.matchKeyword('RETURNING')) {
			returning = this.columnList();
		}

		const endToken = this.previous();
		return { type: 'delete', table, targetSource, alias: targetSource?.alias, where, returning, contextValues, schemaPath, tags, loc: _createLoc(startToken, endToken) };
	}

	/** @internal */
	private valuesStatement(startToken: Token): AST.ValuesStmt {
		const values: AST.Expression[][] = [];

		do {
			this.consume(TokenType.LPAREN, "Expected '(' before values.");
			const valueList: AST.Expression[] = [];

			if (!this.check(TokenType.RPAREN)) { // Check for empty value list
				do {
					valueList.push(this.expression());
				} while (this.match(TokenType.COMMA));
			}

			this.consume(TokenType.RPAREN, "Expected ')' after values.");
			values.push(valueList);
		} while (this.match(TokenType.COMMA));

		const endToken = this.previous();
		return { type: 'values', values, loc: _createLoc(startToken, endToken) };
	}

	/**
	 * Parses VALUES at a position that also accepts trailing compound
	 * (UNION / INTERSECT / EXCEPT / DIFF) and — outside compound-leg
	 * position — trailing ORDER BY / LIMIT / OFFSET. Used at the top-level
	 * statement dispatch, inside `parseQueryExpr`, and as a compound right
	 * leg so that chains like `VALUES (1) UNION VALUES (2) UNION VALUES (3)`
	 * and `VALUES (1) ORDER BY 1 LIMIT 2` parse uniformly.
	 *
	 * Implementation note: the AST `compound` / `orderBy` / `limit` fields
	 * live on `SelectStmt`, not on `ValuesStmt`. When any of those clauses
	 * follow VALUES we synthesize a `SELECT * FROM (VALUES …)` wrapper so the
	 * existing SELECT machinery applies. The wrapper is structurally
	 * indistinguishable from what a user-written `SELECT * FROM (VALUES …)`
	 * would produce.
	 *
	 * `isCompoundSubquery` suppresses ORDER BY / LIMIT consumption — those
	 * belong to the outer compound when VALUES appears as a right leg.
	 */
	private valuesStatementWithOptionalCompound(startToken: Token, withClause?: AST.WithClause, isCompoundSubquery: boolean = false): AST.QueryExpr {
		const values = this.valuesStatement(startToken);
		const hasCompound = this.checkCompoundOperator();
		// A trailing `with defaults (…)` wraps just like ORDER BY / LIMIT so the
		// select spine consumes it — a VALUES-bodied view's defaults are inert
		// (the view is non-updateable), but the clause must still parse + store.
		const hasTrailing = !isCompoundSubquery && (this.check(TokenType.ORDER) || this.check(TokenType.LIMIT) || this.checkWithDefaults());
		if (!hasCompound && !hasTrailing) {
			return values;
		}
		// Wrap as `SELECT * FROM (<values>) AS <synthetic alias>` and continue
		// parsing as a SELECT so the trailing clauses fold in naturally.
		const wrapped = this.wrapAsSubquerySelect(values, startToken);
		return this.continueSelectAfterFrom(wrapped, withClause, startToken, isCompoundSubquery);
	}

	/**
	 * Picks up an in-progress SELECT after its FROM clause is already populated
	 * and parses any remaining trailing clauses by delegating to the shared
	 * compound-tail / ORDER-LIMIT parsers. Used by
	 * `valuesStatementWithOptionalCompound` to graft a compound chain and
	 * trailing clauses onto a synthesized SELECT-from-VALUES wrapper. The
	 * synthesized wrapper never carries its own WHERE / GROUP BY / HAVING — bare
	 * VALUES at top level does not accept those clauses, so they fall through as
	 * a statement-boundary parse error rather than being silently absorbed.
	 *
	 * `startToken` seeds the synthetic alias of any further subquery wrapper the
	 * tail parser mints; `isCompoundSubquery` suppresses ORDER BY / LIMIT
	 * consumption — those belong to the outer compound when this wrapper is a
	 * right leg.
	 */
	private continueSelectAfterFrom(sel: AST.SelectStmt, withClause: AST.WithClause | undefined, startToken: Token, isCompoundSubquery: boolean = false): AST.SelectStmt {
		// Compound chain (left-associative tail) binds before ORDER BY / LIMIT.
		const result = this.parseCompoundTail(sel, withClause, startToken);
		this.parseTrailingOrderLimit(result, isCompoundSubquery);
		// Trailing `with defaults (…)` binds to the whole compound (see selectStatement).
		if (!isCompoundSubquery) {
			const defaults = this.parseDefaultsClause();
			if (defaults) result.defaults = defaults;
		}
		return result;
	}

	/** @internal */
	private createStatement(startToken: Token, withClause?: AST.WithClause): AST.CreateTableStmt | AST.CreateIndexStmt | AST.CreateViewStmt | AST.CreateMaterializedViewStmt | AST.CreateAssertionStmt {
		// TEMP/TEMPORARY is not a Quereus concept — the schema is already transient
		// and temp placement was never wired. Reject it rather than silently ignore.
		if (this.peekKeyword('TEMP') || this.peekKeyword('TEMPORARY')) {
			throw this.error(this.peek(), "TEMP/TEMPORARY is not supported.");
		}

		if (this.peekKeyword('TABLE')) {
			this.consumeKeyword('TABLE', "Expected 'TABLE' after CREATE.");
			return this.createTableStatement(startToken, withClause);
		} else if (this.peekKeyword('VIEW')) {
			this.consumeKeyword('VIEW', "Expected 'VIEW' after CREATE.");
			return this.createViewStatement(startToken, withClause);
		} else if (this.peekKeyword('MATERIALIZED')) {
			this.consumeKeyword('MATERIALIZED', "Expected 'MATERIALIZED' after CREATE.");
			this.consumeKeyword('VIEW', "Expected 'VIEW' after CREATE MATERIALIZED.");
			return this.createMaterializedViewStatement(startToken, withClause);
		} else if (this.peekKeyword('INDEX')) {
			this.consumeKeyword('INDEX', "Expected 'INDEX' after CREATE.");
			return this.createIndexStatement(startToken, false, withClause);
		} else if (this.peekKeyword('ASSERTION')) {
			this.consumeKeyword('ASSERTION', "Expected 'ASSERTION' after CREATE.");
			return this.createAssertionStatement(startToken, withClause);
		} else if (this.peekKeyword('UNIQUE')) {
			this.consumeKeyword('UNIQUE', "Expected 'UNIQUE' after CREATE.");
			this.consumeKeyword('INDEX', "Expected 'INDEX' after CREATE UNIQUE.");
			return this.createIndexStatement(startToken, true, withClause);
		}
		throw this.error(this.peek(), "Expected TABLE, [UNIQUE] INDEX, VIEW, MATERIALIZED VIEW, ASSERTION, or VIRTUAL after CREATE.");
	}

	/**
	 * Parse CREATE TABLE statement
	 * @returns AST for CREATE TABLE
	 */
	private createTableStatement(startToken: Token, _withClause?: AST.WithClause): AST.CreateTableStmt {
		let ifNotExists = false;
		if (this.matchKeyword('IF')) {
			this.consumeKeyword('NOT', "Expected 'NOT' after 'IF'.");
			this.consumeKeyword('EXISTS', "Expected 'EXISTS' after 'IF NOT'.");
			ifNotExists = true;
		}

		const table = this.tableIdentifier();

		const columns: AST.ColumnDef[] = [];
		const constraints: AST.TableConstraint[] = [];

		if (this.check(TokenType.LPAREN)) {
			this.consume(TokenType.LPAREN, "Expected '(' to start table definition.");
			do {
				if (this.peekKeyword('PRIMARY') || this.peekKeyword('UNIQUE') || this.peekKeyword('CHECK') || this.peekKeyword('FOREIGN') || this.peekKeyword('CONSTRAINT')) {
					constraints.push(this.tableConstraint());
				} else {
					columns.push(this.columnDefinition());
				}
				// Allow trailing comma before ')'
			} while (this.match(TokenType.COMMA) && !this.check(TokenType.RPAREN));

			// If we didn't see a comma and the next token looks like the start of another
			// column or table constraint, provide a clearer error about a missing comma.
			if (!this.check(TokenType.RPAREN)) {
				const nextLooksLikeAnotherItem = this.peekKeyword('PRIMARY') || this.peekKeyword('UNIQUE') || this.peekKeyword('CHECK') || this.peekKeyword('FOREIGN') || this.peekKeyword('CONSTRAINT') || this.checkIdentifierLike(CONTEXTUAL_KEYWORDS);
				if (nextLooksLikeAnotherItem) {
					const next = this.peek();
					throw this.error(next, `Expected ',' between table elements. Did you forget a comma before '${next.lexeme}'?`);
				}
			}

			this.consume(TokenType.RPAREN, "Expected ')' after table definition.");

		} else if (this.matchKeyword('AS')) {
			const token = this.previous();
			quereusError(
				'CREATE TABLE AS SELECT is not supported.',
				StatusCode.UNSUPPORTED,
				undefined,
				{ loc: { start: { line: token.startLine, column: token.startColumn } } }
			);
		} else {
			throw this.error(this.peek(), "Expected '(' or 'AS' after table name.");
		}

		let moduleName: string | undefined;
		const moduleArgs: Record<string, SqlValue> = {};
        if (this.matchKeyword('USING')) {
			moduleName = this.consumeIdentifier("Expected module name after 'USING'.");
            if (this.match(TokenType.LPAREN)) {
				let positionalIndex = 0;
                if (!this.check(TokenType.RPAREN)) {
                    do {
						// Check if this is a positional argument (string/number literal) or named argument (identifier=value)
						if (this.check(TokenType.STRING) || this.check(TokenType.INTEGER) || this.check(TokenType.FLOAT)) {
							// Positional argument
							const token = this.advance();
							moduleArgs[String(positionalIndex++)] = this.tokenLiteralValue(token);
						} else if (this.check(TokenType.IDENTIFIER)) {
							// Could be named argument or identifier value
							const nameValue = this.nameValueItem('module argument');
							moduleArgs[nameValue.name] = nameValue.value && nameValue.value.type === 'literal'
								? getSyncLiteral(nameValue.value)
								: (nameValue.value && nameValue.value.type === 'identifier' ? nameValue.value.name : nameValue.name);
						} else {
							throw this.error(this.peek(), "Expected module argument (string, number, or name=value pair).");
						}
                    } while (this.match(TokenType.COMMA));
                }
                this.consume(TokenType.RPAREN, "Expected ')' after module arguments.");
            }
		}

		// Optional `maintained as <body … with defaults (…)>` clause — the declared-shape
		// maintained-table form. `maintained` is contextual (an IDENTIFIER lexeme match), and
		// this position (after the column list / USING clause, before the WITH clauses) is
		// unambiguous, so no look-ahead guard is needed.
		const maintained = this.parseMaintainedClause();

		// Parse trailing WITH clauses (CONTEXT, TAGS) in any order
		let contextDefinitions: AST.MutationContextVar[] | undefined;
		let tags: Record<string, SqlValue> | undefined;
		while (this.matchKeyword('WITH')) {
			if (this.matchKeyword('CONTEXT')) {
				if (contextDefinitions) {
					throw this.error(this.previous(), "Duplicate WITH CONTEXT clause");
				}
				contextDefinitions = this.parseMutationContextDefinitions();
			} else if (this.matchKeyword('TAGS')) {
				if (tags) {
					throw this.error(this.previous(), "Duplicate WITH TAGS clause");
				}
				tags = this.parseTags();
			} else {
				// Not a recognized WITH clause, backtrack
				this.current--;
				break;
			}
		}

		return {
			type: 'createTable',
			table,
			ifNotExists,
			columns,
			constraints,
			moduleName,
			moduleArgs,
			contextDefinitions,
			tags,
			maintained,
			loc: _createLoc(startToken, this.previous()),
		};
	}

	/**
	 * Parse the optional `maintained as <query-expr>` clause of a CREATE TABLE (or
	 * a `declare schema` table item) — the declared-shape maintained-table form.
	 * Any omitted-insert defaults ride inside the body select's trailing
	 * `with defaults (…)` clause. Returns undefined when the clause is absent.
	 */
	private parseMaintainedClause(): AST.MaintainedClause | undefined {
		if (!this.matchKeyword('MAINTAINED')) return undefined;
		// Optional explicit output-column rename list before AS — the lossless
		// table-form encoding of the MV-sugar `(a, b)` renames. Absent ⇒ implicit
		// (the body follows its source shape on reopen). The required AS that
		// follows keeps this unambiguous against a parenthesized body.
		const columns = this.parseMaintainedColumnList();
		this.consumeKeyword('AS', "Expected 'AS' after MAINTAINED.");
		// Body is any QueryExpr — bare SELECT / VALUES / WITH … SELECT all qualify.
		// DML bodies parse here but the planner rejects them. A trailing
		// `with defaults (…)` is consumed by the select spine into `select.defaults`.
		const select = this.parseQueryExpr(undefined, /*requireReturning*/ true);
		return { columns, select };
	}

	/**
	 * Parse the optional parenthesized output-column rename list that may precede the
	 * `AS` of a maintained-table form — shared by `create table … maintained (cols) as`
	 * and `alter table … set maintained (cols) as`. Returns undefined when absent
	 * (the implicit form). An empty `()` is rejected: it could not round-trip
	 * (`maintainedClauseToString` drops an empty list) and the clause's absence is
	 * already the implicit signal, so require at least one column.
	 */
	private parseMaintainedColumnList(): string[] | undefined {
		if (!this.check(TokenType.LPAREN)) return undefined;
		this.consume(TokenType.LPAREN, "Expected '(' to start maintained column list.");
		if (this.check(TokenType.RPAREN)) {
			throw this.error(this.peek(), "Expected at least one column name in the maintained column list.");
		}
		const columns: string[] = [];
		do {
			columns.push(this.consumeIdentifier(CONTEXTUAL_KEYWORDS, "Expected column name in maintained column list."));
		} while (this.match(TokenType.COMMA) && !this.check(TokenType.RPAREN));
		this.consume(TokenType.RPAREN, "Expected ')' after maintained column list.");
		return columns;
	}

	/**
	 * Parse CREATE INDEX statement
	 * @param isUnique Flag indicating if UNIQUE keyword was already parsed
	 * @returns AST for CREATE INDEX
	 */
	private createIndexStatement(startToken: Token, isUnique = false, _withClause?: AST.WithClause): AST.CreateIndexStmt {
		if (!isUnique && this.peekKeyword('UNIQUE')) {
			isUnique = true;
			this.advance();
		}

		let ifNotExists = false;
		if (this.matchKeyword('IF')) {
			this.consumeKeyword('NOT', "Expected 'NOT' after 'IF'.");
			this.consumeKeyword('EXISTS', "Expected 'EXISTS' after 'IF NOT'.");
			ifNotExists = true;
		}

		const index = this.tableIdentifier();

		this.consumeKeyword('ON', "Expected 'ON' after index name.");

		const table = this.tableIdentifier();

		this.consume(TokenType.LPAREN, "Expected '(' before indexed columns.");
		const columns = this.indexedColumnList();
		this.consume(TokenType.RPAREN, "Expected ')' after indexed columns.");

		let where: AST.Expression | undefined;
		if (this.matchKeyword('WHERE')) {
			where = this.expression();
		}

		// Parse optional WITH TAGS
		let tags: Record<string, SqlValue> | undefined;
		if (this.matchKeyword('WITH')) {
			if (this.matchKeyword('TAGS')) {
				tags = this.parseTags();
			} else {
				this.current--;
			}
		}

		return {
			type: 'createIndex',
			index,
			table,
			ifNotExists,
			columns,
			where,
			isUnique,
			tags,
			loc: _createLoc(startToken, this.previous()),
		};
	}

	/**
	 * Parse CREATE VIEW statement
	 * @returns AST for CREATE VIEW
	 */
	private createViewStatement(startToken: Token, withClause?: AST.WithClause): AST.CreateViewStmt {
		let ifNotExists = false;
		if (this.matchKeyword('IF')) {
			this.consumeKeyword('NOT', "Expected 'NOT' after 'IF'.");
			this.consumeKeyword('EXISTS', "Expected 'EXISTS' after 'IF NOT'.");
			ifNotExists = true;
		}

		const view = this.tableIdentifier();

		let columns: string[] | undefined;
		if (this.check(TokenType.LPAREN)) {
			this.consume(TokenType.LPAREN, "Expected '(' to start view column list.");
			columns = [];
			if (!this.check(TokenType.RPAREN)) {
				do {
					columns.push(this.consumeIdentifier(CONTEXTUAL_KEYWORDS, "Expected column name in view column list."));
				} while (this.match(TokenType.COMMA) && !this.check(TokenType.RPAREN));
			}
			this.consume(TokenType.RPAREN, "Expected ')' after view column list.");
		}

		this.consumeKeyword('AS', "Expected 'AS' before view body in CREATE VIEW.");

		// CREATE VIEW body is any QueryExpr — bare SELECT / VALUES / WITH …
		// SELECT all qualify. DML bodies parse here but the planner rejects
		// them (mutating views are out of scope for this milestone).
		const select = this.parseQueryExpr(withClause, /*requireReturning*/ true);

		// A trailing `with defaults (…)` rides inside the select body
		// (`select.defaults`); only the DDL-level WITH TAGS is parsed here.

		// Parse optional WITH TAGS
		let tags: Record<string, SqlValue> | undefined;
		if (this.matchKeyword('WITH')) {
			if (this.matchKeyword('TAGS')) {
				tags = this.parseTags();
			} else {
				this.current--;
			}
		}

		return {
			type: 'createView',
			view,
			ifNotExists,
			columns,
			select,
			tags,
			loc: _createLoc(startToken, this.previous()),
		};
	}

	/**
	 * Parse the optional trailing `with defaults ( col = expr , … )` clause of a
	 * core select — per-column omitted-insert defaults for view write-through.
	 * Modeled byte-for-byte on {@link parseInverseClause}: commits only once
	 * DEFAULTS follows WITH, so a statement-trailing `with tags` / `with schema` /
	 * `with context` stays with the outer parser (the rewound token is WITH, which
	 * never touches the parenStack — so the bare cursor rewind is safe). Returns
	 * undefined when the clause is absent. An empty assignment list is a parse error.
	 */
	private parseDefaultsClause(): AST.ViewInsertDefault[] | undefined {
		if (!this.check(TokenType.WITH)) return undefined;
		this.advance();
		if (!this.peekKeyword('DEFAULTS')) {
			// Not our clause — back up the WITH and stop. Bare cursor rewind is safe
			// only because the rewound token is WITH: advance() has one non-cursor
			// side effect (LPAREN/RPAREN parenStack maintenance), which WITH never hits.
			this.current--;
			return undefined;
		}
		this.advance();
		this.consume(TokenType.LPAREN, "Expected '(' after WITH DEFAULTS.");
		const defaults: AST.ViewInsertDefault[] = [];
		const seen = new Set<string>();
		do {
			const columnToken = this.peek();
			const column = this.consumeIdentifier(CONTEXTUAL_KEYWORDS, "Expected column name in WITH DEFAULTS.");
			if (seen.has(column.toLowerCase())) {
				throw this.error(columnToken, `Duplicate column '${column}' in WITH DEFAULTS.`);
			}
			seen.add(column.toLowerCase());
			this.consume(TokenType.EQUAL, `Expected '=' after WITH DEFAULTS column '${column}'.`);
			const expr = this.expression();
			defaults.push({ column, expr });
		} while (this.match(TokenType.COMMA));
		this.consume(TokenType.RPAREN, "Expected ')' after WITH DEFAULTS list.");
		return defaults;
	}

	/**
	 * Parse the optional `with inverse ( col = expr , … )` clause trailing an
	 * expression result column — authored write-back expressions for view
	 * write-through (inert metadata until the write path consumes it; validation
	 * is build-time). Returns undefined when the clause is absent. `inverse` is
	 * contextual: commits only once INVERSE follows WITH, so a statement-trailing
	 * `with schema` / `with context` / `with tags` after the column list stays
	 * with the outer parser. An empty assignment list is a parse error.
	 */
	private parseInverseClause(): AST.ResultColumnInverse[] | undefined {
		if (!this.check(TokenType.WITH)) return undefined;
		this.advance();
		if (!this.peekKeyword('INVERSE')) {
			// Not our clause — back up the WITH and stop. Bare cursor rewind is safe
			// only because the rewound token is WITH: advance() has one non-cursor
			// side effect (LPAREN/RPAREN parenStack maintenance), which WITH never hits.
			this.current--;
			return undefined;
		}
		this.advance();
		this.consume(TokenType.LPAREN, "Expected '(' after WITH INVERSE.");
		const assignments: AST.ResultColumnInverse[] = [];
		const seen = new Set<string>();
		do {
			const columnToken = this.peek();
			const column = this.consumeIdentifier(CONTEXTUAL_KEYWORDS, "Expected column name in WITH INVERSE.");
			if (seen.has(column.toLowerCase())) {
				throw this.error(columnToken, `Duplicate column '${column}' in WITH INVERSE.`);
			}
			seen.add(column.toLowerCase());
			this.consume(TokenType.EQUAL, `Expected '=' after WITH INVERSE column '${column}'.`);
			const expr = this.expression();
			assignments.push({ column, expr });
		} while (this.match(TokenType.COMMA));
		this.consume(TokenType.RPAREN, "Expected ')' after WITH INVERSE list.");
		return assignments;
	}

	/**
	 * A `*` / `t.*` result column cannot carry WITH INVERSE (it names no single
	 * expression to invert). Name the clause in the diagnostic rather than letting
	 * the leftover WITH garble into a downstream CTE/clause error. A trailing
	 * `with schema` / `with tags` is untouched — parseInverseClause commits only
	 * on WITH followed by INVERSE.
	 */
	private rejectInverseClauseOnStar(): void {
		const withToken = this.peek();
		if (this.parseInverseClause()) {
			throw this.error(withToken, "WITH INVERSE cannot apply to a '*' result column.");
		}
	}

	/**
	 * Parse CREATE MATERIALIZED VIEW statement.
	 *
	 * Syntax: `create materialized view <name> [(cols)] [using <module>(args)] as <query-expr> [with tags ...]`.
	 * The optional `using` clause is parsed before `as` to stay unambiguous with the query body;
	 * v1 restricts the backing module to `memory` at build time (the AST keeps the slot forward-compatible).
	 */
	private createMaterializedViewStatement(startToken: Token, withClause?: AST.WithClause): AST.CreateMaterializedViewStmt {
		let ifNotExists = false;
		if (this.matchKeyword('IF')) {
			this.consumeKeyword('NOT', "Expected 'NOT' after 'IF'.");
			this.consumeKeyword('EXISTS', "Expected 'EXISTS' after 'IF NOT'.");
			ifNotExists = true;
		}

		const view = this.tableIdentifier();

		let columns: string[] | undefined;
		if (this.check(TokenType.LPAREN)) {
			this.consume(TokenType.LPAREN, "Expected '(' to start view column list.");
			columns = [];
			if (!this.check(TokenType.RPAREN)) {
				do {
					columns.push(this.consumeIdentifier(CONTEXTUAL_KEYWORDS, "Expected column name in view column list."));
				} while (this.match(TokenType.COMMA) && !this.check(TokenType.RPAREN));
			}
			this.consume(TokenType.RPAREN, "Expected ')' after view column list.");
		}

		// Optional backing-module clause (`using mem(...)`) before the body.
		let moduleName: string | undefined;
		const moduleArgs: Record<string, SqlValue> = {};
		if (this.matchKeyword('USING')) {
			moduleName = this.consumeIdentifier("Expected module name after 'USING'.");
			if (this.match(TokenType.LPAREN)) {
				let positionalIndex = 0;
				if (!this.check(TokenType.RPAREN)) {
					do {
						if (this.check(TokenType.STRING) || this.check(TokenType.INTEGER) || this.check(TokenType.FLOAT)) {
							const token = this.advance();
							moduleArgs[String(positionalIndex++)] = this.tokenLiteralValue(token);
						} else if (this.check(TokenType.IDENTIFIER)) {
							const nameValue = this.nameValueItem('module argument');
							moduleArgs[nameValue.name] = nameValue.value && nameValue.value.type === 'literal'
								? getSyncLiteral(nameValue.value)
								: (nameValue.value && nameValue.value.type === 'identifier' ? nameValue.value.name : nameValue.name);
						} else {
							throw this.error(this.peek(), "Expected module argument (string, number, or name=value pair).");
						}
					} while (this.match(TokenType.COMMA));
				}
				this.consume(TokenType.RPAREN, "Expected ')' after module arguments.");
			}
		}

		this.consumeKeyword('AS', "Expected 'AS' before view body in CREATE MATERIALIZED VIEW.");

		// Body is any QueryExpr — bare SELECT / VALUES / WITH … SELECT all qualify.
		// DML bodies parse here but the planner rejects them.
		const select = this.parseQueryExpr(withClause, /*requireReturning*/ true);

		// A trailing `with defaults (…)` rides inside the select body
		// (`select.defaults`); only the DDL-level WITH TAGS is parsed here.

		// Parse the trailing `with tags (...)` metadata clause.
		let tags: Record<string, SqlValue> | undefined;
		while (this.matchKeyword('WITH')) {
			if (this.matchKeyword('TAGS')) {
				tags = this.parseTags();
			} else {
				this.current--; // Not a clause we own — back up the WITH and stop.
				break;
			}
		}

		return {
			type: 'createMaterializedView',
			view,
			ifNotExists,
			columns,
			select,
			moduleName,
			moduleArgs: moduleName && Object.keys(moduleArgs).length > 0 ? moduleArgs : undefined,
			tags,
			loc: _createLoc(startToken, this.previous()),
		};
	}

	/**
	 * Parse REFRESH MATERIALIZED VIEW statement.
	 * Syntax: `refresh materialized view <name>`.
	 */
	private refreshStatement(startToken: Token, _withClause?: AST.WithClause): AST.RefreshMaterializedViewStmt {
		this.consumeKeyword('MATERIALIZED', "Expected 'MATERIALIZED' after REFRESH.");
		this.consumeKeyword('VIEW', "Expected 'VIEW' after REFRESH MATERIALIZED.");
		const name = this.tableIdentifier();
		return {
			type: 'refreshMaterializedView',
			name,
			loc: _createLoc(startToken, this.previous()),
		};
	}

	/**
	 * Parse CREATE ASSERTION statement
	 * @returns AST for CREATE ASSERTION
	 */
	private createAssertionStatement(startToken: Token, _withClause?: AST.WithClause): AST.CreateAssertionStmt {
		const name = this.tableIdentifier();

		this.consumeKeyword('CHECK', "Expected 'CHECK' after assertion name.");
		this.consume(TokenType.LPAREN, "Expected '(' after CHECK.");

		const check = this.expression();

		this.consume(TokenType.RPAREN, "Expected ')' after CHECK expression.");

		return {
			type: 'createAssertion',
			name,
			check,
			loc: _createLoc(startToken, this.previous()),
		};
	}

	/**
	 * Parse DROP statement
	 * @returns AST for DROP statement
	 */
	private dropStatement(startToken: Token, _withClause?: AST.WithClause): AST.DropStmt {
		let objectType: 'table' | 'view' | 'materializedView' | 'index' | 'trigger' | 'assertion';

		if (this.peekKeyword('TABLE')) {
			this.consumeKeyword('TABLE', "Expected TABLE after DROP.");
			objectType = 'table';
		} else if (this.peekKeyword('MATERIALIZED')) {
			this.consumeKeyword('MATERIALIZED', "Expected MATERIALIZED after DROP.");
			this.consumeKeyword('VIEW', "Expected VIEW after DROP MATERIALIZED.");
			objectType = 'materializedView';
		} else if (this.peekKeyword('VIEW')) {
			this.consumeKeyword('VIEW', "Expected VIEW after DROP.");
			objectType = 'view';
		} else if (this.peekKeyword('INDEX')) {
			this.consumeKeyword('INDEX', "Expected INDEX after DROP.");
			objectType = 'index';
		} else if (this.peekKeyword('ASSERTION')) {
			this.consumeKeyword('ASSERTION', "Expected ASSERTION after DROP.");
			objectType = 'assertion';
		} else {
			throw this.error(this.peek(), "Expected TABLE, VIEW, MATERIALIZED VIEW, INDEX, or ASSERTION after DROP.");
		}

		let ifExists = false;
		if (this.matchKeyword('IF')) {
			this.consumeKeyword('EXISTS', "Expected 'EXISTS' after 'IF'.");
			ifExists = true;
		}

		const name = this.tableIdentifier();

		return {
			type: 'drop',
			objectType,
			name,
			ifExists,
			loc: _createLoc(startToken, this.previous()),
		};
	}

	/**
	 * Top-level ALTER dispatch. `ALTER` has already been consumed. Branches on the
	 * object keyword: TABLE → the full ALTER TABLE grammar; VIEW / MATERIALIZED VIEW
	 * / INDEX → the v1 `SET TAGS`-only metadata grammar. MATERIALIZED is checked
	 * before VIEW so `MATERIALIZED VIEW` is not mis-parsed as a plain view.
	 */
	private alterStatement(startToken: Token, withClause?: AST.WithClause): AST.AstNode {
		if (this.peekKeyword('TABLE')) {
			return this.alterTableStatement(startToken, withClause);
		}
		if (this.peekKeyword('MATERIALIZED')) {
			return this.alterMaterializedViewStatement(startToken);
		}
		if (this.peekKeyword('VIEW')) {
			return this.alterViewStatement(startToken);
		}
		if (this.peekKeyword('INDEX')) {
			return this.alterIndexStatement(startToken);
		}
		throw this.error(this.peek(), "Expected 'TABLE', 'VIEW', 'MATERIALIZED VIEW', or 'INDEX' after ALTER.");
	}

	/**
	 * Parse the trailing `{SET|ADD|DROP} TAGS (...)` of an ALTER VIEW /
	 * MATERIALIZED VIEW / INDEX statement (object name already consumed):
	 *   SET TAGS  → whole-set replace (empty list clears),
	 *   ADD TAGS  → per-key merge (empty list is a no-op),
	 *   DROP TAGS → per-key delete (atomic; empty list is a no-op).
	 * No `(` look-ahead guard is needed (unlike the ALTER TABLE table level):
	 * after `ALTER VIEW <name>` the only legal grammar is a tag op, so the
	 * leading keyword is unambiguous.
	 */
	private parseObjectTagsAction(): AST.AlterObjectTagsAction {
		if (this.matchKeyword('SET')) {
			this.consumeKeyword('TAGS', "Expected 'TAGS' after SET.");
			return { type: 'setTags', mode: 'replace', tags: this.parseTags() };
		}
		if (this.matchKeyword('ADD')) {
			this.consumeKeyword('TAGS', "Expected 'TAGS' after ADD.");
			return { type: 'setTags', mode: 'merge', tags: this.parseTags() };
		}
		if (this.matchKeyword('DROP')) {
			this.consumeKeyword('TAGS', "Expected 'TAGS' after DROP.");
			return { type: 'dropTags', keys: this.parseTagKeys() };
		}
		throw this.error(this.peek(), "Expected SET, ADD, or DROP TAGS after object name.");
	}

	/** Parse `ALTER VIEW <name> {SET|ADD|DROP} TAGS (...)`. */
	private alterViewStatement(startToken: Token): AST.AlterViewStmt {
		this.consumeKeyword('VIEW', "Expected 'VIEW' after ALTER.");
		const name = this.tableIdentifier();
		const action = this.parseObjectTagsAction();
		return { type: 'alterView', name, action, loc: _createLoc(startToken, this.previous()) };
	}

	/** Parse `ALTER MATERIALIZED VIEW <name> {SET|ADD|DROP} TAGS (...)`. */
	private alterMaterializedViewStatement(startToken: Token): AST.AlterMaterializedViewStmt {
		this.consumeKeyword('MATERIALIZED', "Expected 'MATERIALIZED' after ALTER.");
		this.consumeKeyword('VIEW', "Expected 'VIEW' after MATERIALIZED.");
		const name = this.tableIdentifier();
		const action = this.parseObjectTagsAction();
		return { type: 'alterMaterializedView', name, action, loc: _createLoc(startToken, this.previous()) };
	}

	/** Parse `ALTER INDEX <name> {SET|ADD|DROP} TAGS (...)`. */
	private alterIndexStatement(startToken: Token): AST.AlterIndexStmt {
		this.consumeKeyword('INDEX', "Expected 'INDEX' after ALTER.");
		const name = this.tableIdentifier();
		const action = this.parseObjectTagsAction();
		return { type: 'alterIndex', name, action, loc: _createLoc(startToken, this.previous()) };
	}

	/**
	 * Parse ALTER TABLE statement
	 * @returns AST for ALTER TABLE statement
	 */
	private alterTableStatement(startToken: Token, _withClause?: AST.WithClause): AST.AlterTableStmt {
		this.consumeKeyword('TABLE', "Expected 'TABLE' after ALTER.");

		const table = this.tableIdentifier();

		let action: AST.AlterTableAction;

		if (this.peekKeyword('RENAME')) {
			this.consumeKeyword('RENAME', "Expected RENAME.");
			if (this.matchKeyword('COLUMN')) {
				const oldName = this.consumeIdentifier(CONTEXTUAL_KEYWORDS, "Expected old column name after RENAME COLUMN.");
				this.consumeKeyword('TO', "Expected 'TO' after old column name.");
				const newName = this.consumeIdentifier(CONTEXTUAL_KEYWORDS, "Expected new column name after TO.");
				action = { type: 'renameColumn', oldName, newName };
			} else if (this.matchKeyword('CONSTRAINT')) {
				// RENAME CONSTRAINT <old> TO <new> — name-level rename of a named
				// table-level constraint (CHECK / UNIQUE / FOREIGN KEY).
				const oldName = this.consumeIdentifier(CONTEXTUAL_KEYWORDS, "Expected old constraint name after RENAME CONSTRAINT.");
				this.consumeKeyword('TO', "Expected 'TO' after old constraint name.");
				const newName = this.consumeIdentifier(CONTEXTUAL_KEYWORDS, "Expected new constraint name after TO.");
				action = { type: 'renameConstraint', oldName, newName };
			} else {
				this.consumeKeyword('TO', "Expected 'TO' after RENAME.");
				const newName = this.consumeIdentifier(CONTEXTUAL_KEYWORDS, "Expected new table name after RENAME TO.");
				action = { type: 'renameTable', newName };
			}
		} else if (this.peekKeyword('ADD')) {
			this.consumeKeyword('ADD', "Expected ADD.");
			if (this.peekKeyword('TAGS') && this.checkNext(1, TokenType.LPAREN)) {
				// ADD TAGS (...) — per-key merge of table tags. Gated on TAGS being
				// immediately followed by '(' so a column literally named `tags`
				// (e.g. `ADD tags integer` / `ADD COLUMN tags ...`) still parses as
				// ADD COLUMN. `TAGS` is a contextual keyword (a plain identifier), so
				// without the '(' guard it would shadow such columns.
				this.consumeKeyword('TAGS', "Expected 'TAGS'.");
				const tags = this.parseTags();
				action = { type: 'setTags', target: { kind: 'table' }, mode: 'merge', tags };
			} else if (this.peekKeyword('CONSTRAINT')
				|| this.check(TokenType.UNIQUE)
				|| this.check(TokenType.FOREIGN)
				|| this.check(TokenType.CHECK)) {
				// ADD CONSTRAINT <name> <body>, or the unnamed table-constraint forms
				// ADD UNIQUE (...) / ADD FOREIGN KEY (...) / ADD CHECK (...).
				// tableConstraint() consumes the optional CONSTRAINT <name> prefix.
				const constraint = this.tableConstraint();
				action = { type: 'addConstraint', constraint };
			} else {
				// ADD [COLUMN] column_def
				this.matchKeyword('COLUMN');
				const column = this.columnDefinition();
				action = { type: 'addColumn', column };
			}
		} else if (this.peekKeyword('DROP')) {
			this.consumeKeyword('DROP', "Expected DROP.");
			if (this.peekKeyword('TAGS') && this.checkNext(1, TokenType.LPAREN)) {
				// DROP TAGS (...) — per-key delete of table tags. Same '(' guard as
				// ADD TAGS so `DROP COLUMN tags` / `DROP tags` (a column named `tags`)
				// still parse as DROP COLUMN.
				this.consumeKeyword('TAGS', "Expected 'TAGS'.");
				action = { type: 'dropTags', target: { kind: 'table' }, keys: this.parseTagKeys() };
			} else if (this.peekKeyword('MAINTAINED')) {
				// DROP MAINTAINED — detach the table's derivation. The verb wins over a
				// column literally named `maintained`; use DROP COLUMN maintained for that.
				this.consumeKeyword('MAINTAINED', "Expected 'MAINTAINED'.");
				action = { type: 'dropMaintained' };
			} else if (this.matchKeyword('CONSTRAINT')) {
				// DROP CONSTRAINT <name> — drop a named table-level constraint
				// (CHECK / UNIQUE / FOREIGN KEY).
				const name = this.consumeIdentifier(CONTEXTUAL_KEYWORDS, "Expected constraint name after DROP CONSTRAINT.");
				action = { type: 'dropConstraint', name };
			} else {
				this.matchKeyword('COLUMN');
				const name = this.consumeIdentifier(CONTEXTUAL_KEYWORDS, "Expected column name after DROP COLUMN.");
				action = { type: 'dropColumn', name };
			}
		} else if (this.peekKeyword('SET')) {
			this.consumeKeyword('SET', "Expected SET.");
			if (this.matchKeyword('MAINTAINED')) {
				// SET MAINTAINED [(cols)] AS <body> — attach / re-attach a derivation.
				// No `using` clause: the module is the table's identity. The optional
				// `(cols)` is the explicit output-column rename list (the differ's
				// lossless encoding of an MV-sugar `(a, c)` rename): present ⇒ positional
				// rename + recorded explicit; absent ⇒ implicit (the body's natural
				// names). The required AS keeps it unambiguous. A trailing
				// `with defaults (…)` rides inside the body (`select.defaults`).
				const columns = this.parseMaintainedColumnList();
				this.consumeKeyword('AS', "Expected 'AS' after SET MAINTAINED.");
				const select = this.parseQueryExpr(undefined, /*requireReturning*/ true);
				action = { type: 'setMaintained', columns, select };
			} else {
				// Table-level `SET TAGS (...)` — whole-set tag replacement on the table.
				this.consumeKeyword('TAGS', "Expected 'TAGS' or 'MAINTAINED' after SET.");
				const tags = this.parseTags();
				action = { type: 'setTags', target: { kind: 'table' }, mode: 'replace', tags };
			}
		} else if (this.peekKeyword('ALTER')) {
			this.consumeKeyword('ALTER', "Expected ALTER.");
			if (this.peekKeyword('COLUMN')) {
				this.consumeKeyword('COLUMN', "Expected COLUMN.");
				action = this.alterColumnAction();
			} else if (this.peekKeyword('CONSTRAINT')) {
				// ALTER CONSTRAINT <name> {SET|ADD|DROP} TAGS (...) — tag mutation on a
				// named table-level constraint (only named constraints are addressable):
				//   SET TAGS  → whole-set replace, ADD TAGS → per-key merge,
				//   DROP TAGS → per-key delete.
				this.consumeKeyword('CONSTRAINT', "Expected CONSTRAINT.");
				const constraintName = this.consumeIdentifier(CONTEXTUAL_KEYWORDS, "Expected constraint name after ALTER CONSTRAINT.");
				if (this.matchKeyword('SET')) {
					this.consumeKeyword('TAGS', "Expected 'TAGS' after SET.");
					action = { type: 'setTags', target: { kind: 'constraint', constraintName }, mode: 'replace', tags: this.parseTags() };
				} else if (this.matchKeyword('ADD')) {
					this.consumeKeyword('TAGS', "Expected 'TAGS' after ADD.");
					action = { type: 'setTags', target: { kind: 'constraint', constraintName }, mode: 'merge', tags: this.parseTags() };
				} else if (this.matchKeyword('DROP')) {
					this.consumeKeyword('TAGS', "Expected 'TAGS' after DROP.");
					action = { type: 'dropTags', target: { kind: 'constraint', constraintName }, keys: this.parseTagKeys() };
				} else {
					throw this.error(this.peek(), `Expected SET, ADD, or DROP after ALTER CONSTRAINT ${constraintName}.`);
				}
			} else {
				this.consumeKeyword('PRIMARY', "Expected 'PRIMARY', 'COLUMN', or 'CONSTRAINT' after ALTER.");
				this.consumeKeyword('KEY', "Expected 'KEY' after PRIMARY.");
				this.consume(TokenType.LPAREN, "Expected '(' after PRIMARY KEY.");
				const columns: Array<{ name: string; direction?: 'asc' | 'desc' }> = [];
				if (!this.check(TokenType.RPAREN)) {
					do {
						const colName = this.consumeIdentifier(CONTEXTUAL_KEYWORDS, "Expected column name in PRIMARY KEY definition.");
						let direction: 'asc' | 'desc' | undefined;
						if (this.matchKeyword('ASC')) {
							direction = 'asc';
						} else if (this.matchKeyword('DESC')) {
							direction = 'desc';
						}
						columns.push({ name: colName, direction });
					} while (this.match(TokenType.COMMA));
				}
				this.consume(TokenType.RPAREN, "Expected ')' after PRIMARY KEY column list.");
				action = { type: 'alterPrimaryKey', columns };
			}
		} else {
			throw this.error(this.peek(), "Expected RENAME, ADD, DROP, or ALTER after table name in ALTER TABLE.");
		}

		return {
			type: 'alterTable',
			table,
			action,
			loc: _createLoc(startToken, this.previous()),
		};
	}

	/**
	 * Parse the body of ALTER TABLE ... ALTER COLUMN <name> <subcommand>.
	 * Produces an 'alterColumn' action with exactly one attribute set.
	 * Caller has already consumed ALTER COLUMN.
	 */
	private alterColumnAction(): AST.AlterTableAction {
		const columnName = this.consumeIdentifier(
			CONTEXTUAL_KEYWORDS,
			"Expected column name after ALTER COLUMN.",
		);

		if (this.matchKeyword('SET')) {
			if (this.matchKeyword('NOT')) {
				this.consumeKeyword('NULL', "Expected 'NULL' after SET NOT.");
				return { type: 'alterColumn', columnName, setNotNull: true };
			}
			if (this.matchKeyword('DATA')) {
				this.consumeKeyword('TYPE', "Expected 'TYPE' after SET DATA.");
				const dataType = this.parseDataTypeName();
				return { type: 'alterColumn', columnName, setDataType: dataType };
			}
			if (this.matchKeyword('DEFAULT')) {
				const expr = this.expression();
				return { type: 'alterColumn', columnName, setDefault: expr };
			}
			if (this.match(TokenType.COLLATE)) {
				// ALTER COLUMN <name> SET COLLATE <name> — change the column's collation,
				// re-sorting / re-validating any PK / UNIQUE / index that orders by it.
				if (!this.check(TokenType.IDENTIFIER)) {
					throw this.error(this.peek(), "Expected collation name after SET COLLATE.");
				}
				const collation = this.getIdentifierValue(this.advance());
				return { type: 'alterColumn', columnName, setCollation: collation };
			}
			if (this.matchKeyword('TAGS')) {
				// ALTER COLUMN <name> SET TAGS (...) — whole-set tag replacement on the column.
				const tags = this.parseTags();
				return { type: 'setTags', target: { kind: 'column', columnName }, mode: 'replace', tags };
			}
			throw this.error(this.peek(), "Expected NOT NULL, DATA TYPE, DEFAULT, COLLATE, or TAGS after SET.");
		}

		if (this.matchKeyword('ADD')) {
			// ALTER COLUMN <name> ADD TAGS (...) — per-key merge on the column. TAGS is
			// unambiguous here (the grammar after ALTER COLUMN <name> ADD is fixed), so
			// no '(' look-ahead guard is needed as it is at the table level.
			this.consumeKeyword('TAGS', "Expected 'TAGS' after ADD.");
			const tags = this.parseTags();
			return { type: 'setTags', target: { kind: 'column', columnName }, mode: 'merge', tags };
		}

		if (this.matchKeyword('DROP')) {
			if (this.matchKeyword('NOT')) {
				this.consumeKeyword('NULL', "Expected 'NULL' after DROP NOT.");
				return { type: 'alterColumn', columnName, setNotNull: false };
			}
			if (this.matchKeyword('DEFAULT')) {
				return { type: 'alterColumn', columnName, setDefault: null };
			}
			if (this.matchKeyword('TAGS')) {
				// ALTER COLUMN <name> DROP TAGS (...) — per-key delete on the column.
				return { type: 'dropTags', target: { kind: 'column', columnName }, keys: this.parseTagKeys() };
			}
			throw this.error(this.peek(), "Expected NOT NULL, DEFAULT, or TAGS after DROP.");
		}

		throw this.error(this.peek(), "Expected SET, ADD, or DROP after ALTER COLUMN name.");
	}

	/**
	 * Parse a data-type name as used in column definitions. Supports optional
	 * parameterized types like VARCHAR(40). Shared with columnDefinition().
	 */
	private parseDataTypeName(): string {
		if (!this.check(TokenType.IDENTIFIER)) {
			throw this.error(this.peek(), "Expected data type name.");
		}
		let dataType = this.advance().lexeme;
		if (this.match(TokenType.LPAREN)) {
			dataType += '(';
			let parenLevel = 1;
			while (parenLevel > 0 && !this.isAtEnd()) {
				const token = this.peek();
				if (token.type === TokenType.LPAREN) parenLevel++;
				if (token.type === TokenType.RPAREN) parenLevel--;
				if (parenLevel > 0) {
					dataType += this.advance().lexeme;
				}
			}
			dataType += ')';
			this.consume(TokenType.RPAREN, "Expected ')' after type parameters.");
		}
		return dataType;
	}

	/**
	 * Parse BEGIN statement
	 * @returns AST for BEGIN statement
	 */
	private beginStatement(startToken: Token, _withClause?: AST.WithClause): AST.BeginStmt {
		// Skip optional TRANSACTION keyword
		this.matchKeyword('TRANSACTION');

		return { type: 'begin', loc: _createLoc(startToken, this.previous()) };
	}

	/**
	 * Parse COMMIT statement
	 * @returns AST for COMMIT statement
	 */
	private commitStatement(startToken: Token, _withClause?: AST.WithClause): AST.CommitStmt {
		this.matchKeyword('TRANSACTION');
		return { type: 'commit', loc: _createLoc(startToken, this.previous()) };
	}

	/**
	 * Parse ROLLBACK statement
	 * @returns AST for ROLLBACK statement
	 */
	private rollbackStatement(startToken: Token, _withClause?: AST.WithClause): AST.RollbackStmt {
		this.matchKeyword('TRANSACTION');

		let savepoint: string | undefined;
		if (this.matchKeyword('TO')) {
			this.matchKeyword('SAVEPOINT');
			if (!this.check(TokenType.IDENTIFIER)) {
				throw this.error(this.peek(), "Expected savepoint name after ROLLBACK TO.");
			}
			savepoint = this.getIdentifierValue(this.advance());
		}
		return { type: 'rollback', savepoint, loc: _createLoc(startToken, this.previous()) };
	}

	/**
	 * Parse SAVEPOINT statement
	 * @returns AST for SAVEPOINT statement
	 */
	private savepointStatement(startToken: Token, _withClause?: AST.WithClause): AST.SavepointStmt {
		const name = this.consumeIdentifier("Expected savepoint name after SAVEPOINT.");
		return { type: 'savepoint', name, loc: _createLoc(startToken, this.previous()) };
	}

	/**
	 * Parse RELEASE statement
	 * @returns AST for RELEASE statement
	 */
	private releaseStatement(startToken: Token, _withClause?: AST.WithClause): AST.ReleaseStmt {
		this.matchKeyword('SAVEPOINT');
		const name = this.consumeIdentifier("Expected savepoint name after RELEASE [SAVEPOINT].");
		return { type: 'release', savepoint: name, loc: _createLoc(startToken, this.previous()) };
	}

	/**
	 * Parse PRAGMA statement
	 * @returns AST for PRAGMA statement
	 */
	private pragmaStatement(startToken: Token, _withClause?: AST.WithClause): AST.PragmaStmt {
		const nameValue = this.nameValueItem("pragma");
		return { type: 'pragma', ...nameValue, loc: _createLoc(startToken, this.previous()) };
	}

	/**
	 * Parse ANALYZE statement: ANALYZE [schema.]table | ANALYZE schema.* | ANALYZE
	 */
	private analyzeStatement(startToken: Token): AST.AnalyzeStmt {
		// ANALYZE with no arguments → analyze all tables
		if (this.isAtEnd() || this.check(TokenType.SEMICOLON)) {
			return { type: 'analyze', loc: _createLoc(startToken, this.previous()) };
		}

		// Parse optional schema.table, schema.* (all tables in schema), or just table.
		// Mirrors tableIdentifier()'s allowed keyword set so `analyze temp.tt` parses.
		const contextualKeywords = [...CONTEXTUAL_KEYWORDS, 'temp', 'temporary'];
		const name1 = this.consumeIdentifier(contextualKeywords, "Expected table name after ANALYZE.");
		if (this.match(TokenType.DOT)) {
			// ANALYZE schema.* → analyze every table in the schema (schema-only shape)
			if (this.match(TokenType.ASTERISK)) {
				return { type: 'analyze', schemaName: name1, loc: _createLoc(startToken, this.previous()) };
			}
			const name2 = this.consumeIdentifier(contextualKeywords, "Expected table name after schema qualifier.");
			return { type: 'analyze', schemaName: name1, tableName: name2, loc: _createLoc(startToken, this.previous()) };
		}
		return { type: 'analyze', tableName: name1, loc: _createLoc(startToken, this.previous()) };
	}

	// === Declarative schema parsing ===

	private declareSchemaStatement(startToken: Token): AST.DeclareSchemaStmt {
		// Optional contextual keyword: `declare logical schema X { ... }`.
		const isLogical = this.matchKeyword('LOGICAL');
		this.consumeKeyword('SCHEMA', "Expected 'SCHEMA' after DECLARE.");
		const schemaName = this.consumeIdentifier(['temp', 'temporary'], "Expected schema name after DECLARE.");
		let version: string | undefined;
		let using: { defaultVtabModule?: string; defaultVtabArgs?: string } | undefined;

		// Optional: version 'semver'
		// no-op
		if (this.matchKeyword('VERSION')) {
			const tok = this.consume(TokenType.STRING, "Expected version string after VERSION.");
			version = String(tok.literal);
		}

		// Optional: using ( default_vtab_module = 'memory', default_vtab_args = '[]' )
		if (this.match(TokenType.USING)) {
			this.consume(TokenType.LPAREN, "Expected '(' after USING.");
			using = {};
			if (!this.check(TokenType.RPAREN)) {
				do {
					const optName = this.consumeIdentifier("Expected option name inside USING().").toLowerCase();
					this.consume(TokenType.EQUAL, "Expected '=' after option name in USING().");
					if (optName === 'default_vtab_module') {
						const t = this.consume(TokenType.STRING, "Expected string for default_vtab_module.");
						using.defaultVtabModule = String(t.literal);
					} else if (optName === 'default_vtab_args') {
						const t = this.consume(TokenType.STRING, "Expected JSON string for default_vtab_args.");
						using.defaultVtabArgs = String(t.literal);
					} else {
						// Consume simple literal/identifier for forward compatibility
						if (this.check(TokenType.STRING) || this.check(TokenType.INTEGER) || this.check(TokenType.FLOAT) || this.check(TokenType.IDENTIFIER)) {
							this.advance();
						}
					}
				} while (this.match(TokenType.COMMA));
			}
			this.consume(TokenType.RPAREN, "Expected ')' after USING options.");
		}

		// Block
		// Parse declaration block delimited by '{' '}'
		this.consume(TokenType.LBRACE, "Expected '{' to start schema declaration block.");
		const items: AST.DeclareItem[] = [];

		while (!this.check(TokenType.RBRACE)) {
			if (this.isAtEnd()) break;
			// A stray separator is not an item — otherwise it lands as an empty ignored one.
			if (this.match(TokenType.SEMICOLON)) continue;
			// Items need no separator, so a sibling item's leading keyword sits exactly
			// where the previous body's bare alias would go. Bar those keywords from the
			// alias slot for the duration of the item.
			items.push(this.withAliasBarrier(DECLARE_ITEM_KEYWORDS, () => this.declareBlockItem()));
			this.match(TokenType.SEMICOLON);
		}

		this.consume(TokenType.RBRACE, "Expected '}' to close schema declaration block.");

		const endTok = this.previous();
		return { type: 'declareSchema', schemaName, version, using, items, ...(isLogical ? { isLogical: true } : {}), loc: _createLoc(startToken, endTok) };
	}

	/** Parses one item of a `declare schema { … }` block, dispatched on its leading keyword. */
	private declareBlockItem(): AST.DeclareItem {
		if (this.peekKeyword('TABLE')) {
			this.advance();
			return this.declareTableItem();
		}
		if (this.peekKeyword('INDEX')) {
			this.advance();
			return this.declareIndexItem(false);
		}
		if (this.peekKeyword('UNIQUE')) {
			this.advance();
			this.consumeKeyword('INDEX', "Expected 'INDEX' after 'UNIQUE'.");
			return this.declareIndexItem(true);
		}
		if (this.peekKeyword('MATERIALIZED')) {
			this.advance();
			this.consumeKeyword('VIEW', "Expected 'VIEW' after 'MATERIALIZED'.");
			return this.declareMaterializedViewItem();
		}
		if (this.peekKeyword('VIEW')) {
			this.advance();
			return this.declareViewItem();
		}
		if (this.peekKeyword('SEED')) {
			this.advance();
			return this.declareSeedItem();
		}
		if (this.peekKeyword('ASSERTION')) {
			this.advance();
			return this.declareAssertionItem();
		}
		return this.declareIgnoredItem();
	}

	/**
	 * Fallback for an item kind the parser doesn't model yet (domain, collation, import):
	 * skip its tokens and keep a placeholder so the surrounding block still parses.
	 *
	 * NOTE: an unrecognized item is retained only as opaque text — a typo'd item keyword
	 * is therefore accepted and silently ignored rather than diagnosed. Diagnosing it
	 * needs a real grammar for these kinds, not a tighter skip.
	 */
	private declareIgnoredItem(): AST.DeclareIgnoredItem {
		const start = this.peek();
		this.skipToDeclareItemBoundary();
		const endTok = this.previous();
		return { type: 'declareIgnored', kind: 'domain', text: this.sourceSlice(start.startOffset, endTok.endOffset) };
	}

	/**
	 * Advances past the current declaration-block item, stopping at nesting depth 0 on
	 * a `;`, the block's closing `}`, or the leading keyword of the next item. Brace and
	 * paren depth is tracked so a braced column list or a parenthesized payload inside
	 * the item doesn't end the scan early.
	 *
	 * NOTE: stopping on an item keyword is a heuristic — these kinds have no grammar
	 * here, so the word `table` inside an unmodeled item would cut the skip short.
	 * Separating the items with `;` is exact; if domain/collation/import ever gain real
	 * bodies, give them a grammar rather than widening this scan.
	 */
	private skipToDeclareItemBoundary(): void {
		// The item's own leading word may itself be an item keyword (`domain`, …), so
		// always consume one token before testing for the next item's start.
		this.advance();
		let depth = 0;
		while (!this.isAtEnd()) {
			const type = this.peek().type;
			if (depth === 0) {
				if (type === TokenType.SEMICOLON || type === TokenType.RBRACE) return;
				if (this.atDeclareItemStart()) return;
			}
			if (type === TokenType.LBRACE || type === TokenType.LPAREN) {
				depth++;
			} else if (type === TokenType.RBRACE || type === TokenType.RPAREN) {
				depth--;
			}
			this.advance();
		}
	}

	/** True when the cursor sits on a keyword that can begin a declaration-block item. */
	private atDeclareItemStart(): boolean {
		for (const keyword of DECLARE_ITEM_KEYWORDS) {
			if (this.peekKeyword(keyword)) return true;
		}
		return false;
	}

	/**
	 * Parses `declare lens for <X> over <Y> { ( view <T> as <select> ;? )* }`.
	 * The DECLARE token is already consumed by {@link statement}. `lens` and `for`
	 * are contextual keywords (matched via peekKeyword's IDENTIFIER fallback);
	 * `over` is the existing window-function keyword.
	 */
	private declareLensStatement(startToken: Token): AST.DeclareLensStmt {
		this.consumeKeyword('LENS', "Expected 'LENS' after DECLARE.");
		this.consumeKeyword('FOR', "Expected 'FOR' after DECLARE LENS.");
		const logicalSchema = this.consumeIdentifier(CONTEXTUAL_KEYWORDS, "Expected logical schema name after 'FOR'.");
		this.consumeKeyword('OVER', "Expected 'OVER' after the logical schema name.");
		const basisSchema = this.consumeIdentifier(CONTEXTUAL_KEYWORDS, "Expected basis schema name after 'OVER'.");

		this.consume(TokenType.LBRACE, "Expected '{' to start the lens declaration block.");
		const overrides: AST.LensOverride[] = [];
		while (!this.check(TokenType.RBRACE)) {
			if (this.isAtEnd()) break;
			this.consumeKeyword('VIEW', "Expected 'view' to begin a lens override.");
			const table = this.consumeIdentifier(CONTEXTUAL_KEYWORDS, "Expected the logical table name after 'view'.");
			this.consumeKeyword('AS', "Expected 'AS' after the logical table name.");
			// Overrides need no separator either; bar `view` from the body's alias slot
			// (harmless today — `view` is reserved — but the shape is the same hazard).
			const body = this.withAliasBarrier(LENS_OVERRIDE_KEYWORDS, () => this.parseQueryExpr());
			if (body.type !== 'select') {
				throw this.error(this.previous(), `A lens override body must be a SELECT; got '${body.type}'.`);
			}
			// A compound set-operation parses as a single `select` node carrying a
			// `compound` (or legacy `union`) pointer; the override merger composes
			// only the top leg, so reject the shape rather than silently mis-map.
			if (body.compound || body.union) {
				throw this.error(this.previous(), `A lens override body must be a single SELECT; compound set-operations (union/intersect/except) are not supported in v1 lens overrides.`);
			}

			overrides.push({ table, select: body });
			this.match(TokenType.SEMICOLON);
		}
		this.consume(TokenType.RBRACE, "Expected '}' to close the lens declaration block.");

		return {
			type: 'declareLens',
			logicalSchema,
			basisSchema,
			overrides,
			loc: _createLoc(startToken, this.previous()),
		};
	}

	private declareTableItem(): AST.DeclaredTable {
		const tableName = this.consumeIdentifier(CONTEXTUAL_KEYWORDS, 'Expected table name in declaration.');
		let moduleName: string | undefined;
		let moduleArgs: Record<string, SqlValue> | undefined;
		const columns: AST.ColumnDef[] = [];
		const constraints: AST.TableConstraint[] = [];

		// Optional USING module
		if (this.match(TokenType.USING)) {
			if (this.check(TokenType.IDENTIFIER)) {
				moduleName = this.getIdentifierValue(this.advance());
			}
			if (this.match(TokenType.LPAREN)) {
				moduleArgs = {};
				let positionalIndex = 0;
				if (!this.check(TokenType.RPAREN)) {
					do {
						// Check if this is a positional argument (string/number literal) or named argument (identifier=value)
						if (this.check(TokenType.STRING) || this.check(TokenType.INTEGER) || this.check(TokenType.FLOAT)) {
							// Positional argument
							const token = this.advance();
							moduleArgs[String(positionalIndex++)] = this.tokenLiteralValue(token);
						} else if (this.check(TokenType.IDENTIFIER)) {
							// Could be named argument or identifier value
							const nv = this.nameValueItem('module argument');
							moduleArgs[nv.name] = nv.value && nv.value.type === 'literal' ? getSyncLiteral(nv.value) : (nv.value && nv.value.type === 'identifier' ? nv.value.name : null);
						} else {
							throw this.error(this.peek(), "Expected module argument (string, number, or name=value pair).");
						}
					} while (this.match(TokenType.COMMA));
				}
				this.consume(TokenType.RPAREN, "Expected ')' after module arguments.");
			}
		}

		// Column list can be in parens (...) or braces {...}
		const useBraces = this.check(TokenType.LBRACE);
		if (useBraces) {
			this.consume(TokenType.LBRACE, "Expected '{' before column definitions.");
		} else {
			this.consume(TokenType.LPAREN, "Expected '(' or '{' before column definitions.");
		}

		if (!this.check(useBraces ? TokenType.RBRACE : TokenType.RPAREN)) {
			do {
				// Distinguish table constraint vs column definition by lookahead for '(' or constraint keywords
				if (this.peekKeyword('CONSTRAINT') || this.peekKeyword('PRIMARY') || this.peekKeyword('UNIQUE') || this.peekKeyword('CHECK') || this.peekKeyword('FOREIGN')) {
					constraints.push(this.tableConstraint());
				} else {
					columns.push(this.columnDefinition());
				}
			} while (this.match(TokenType.COMMA) && !this.check(useBraces ? TokenType.RBRACE : TokenType.RPAREN));
		}

		if (useBraces) {
			this.consume(TokenType.RBRACE, "Expected '}' after table definition.");
		} else {
			this.consume(TokenType.RPAREN, "Expected ')' after table definition.");
		}

		// Optional `maintained as <body … with defaults (…)>` — the declared-shape
		// maintained-table form, carried through the CreateTableStmt reuse. (Differ
		// transition handling is a follow-up; the clause parses and round-trips.)
		const maintained = this.parseMaintainedClause();

		// Parse trailing WITH clauses (CONTEXT, TAGS) in any order
		let contextDefinitions: AST.MutationContextVar[] | undefined;
		let tags: Record<string, SqlValue> | undefined;
		while (this.matchKeyword('WITH')) {
			if (this.matchKeyword('CONTEXT')) {
				if (contextDefinitions) {
					throw this.error(this.previous(), "Duplicate WITH CONTEXT clause");
				}
				contextDefinitions = this.parseMutationContextDefinitions();
			} else if (this.matchKeyword('TAGS')) {
				if (tags) {
					throw this.error(this.previous(), "Duplicate WITH TAGS clause");
				}
				tags = this.parseTags();
			} else {
				this.current--;
				break;
			}
		}

		// Build the CREATE TABLE AST node for this declared table
		const tableStmt: AST.CreateTableStmt = {
			type: 'createTable',
			table: { type: 'identifier', name: tableName },
			ifNotExists: false,
			columns,
			constraints,
			moduleName,
			moduleArgs,
			contextDefinitions,
			tags,
			maintained
		};

		return { type: 'declaredTable', tableStmt };
	}

	private declareIndexItem(isUnique: boolean): AST.DeclaredIndex {
		const indexName = this.consumeIdentifier('Expected index name.');
		this.consumeKeyword('ON', "Expected 'ON' after index name.");
		const tableName = this.consumeIdentifier('Expected table name after ON.');
		this.consume(TokenType.LPAREN, "Expected '(' before index columns.");
		const columns = this.indexedColumnList();
		this.consume(TokenType.RPAREN, "Expected ')' after index columns.");

		// Parse optional WHERE <predicate> (partial index), before WITH TAGS
		let where: AST.Expression | undefined;
		if (this.matchKeyword('WHERE')) {
			where = this.expression();
		}

		// Parse optional WITH TAGS
		let tags: Record<string, SqlValue> | undefined;
		if (this.matchKeyword('WITH')) {
			if (this.matchKeyword('TAGS')) {
				tags = this.parseTags();
			} else {
				this.current--;
			}
		}

		const indexStmt: AST.CreateIndexStmt = {
			type: 'createIndex',
			index: { type: 'identifier', name: indexName },
			table: { type: 'identifier', name: tableName },
			ifNotExists: false,
			columns,
			where,
			isUnique,
			tags
		};

		return { type: 'declaredIndex', indexStmt };
	}

	private declareViewItem(): AST.DeclaredView {
		const viewName = this.consumeIdentifier('Expected view name.');
		let columns: string[] | undefined;
		if (this.match(TokenType.LPAREN)) {
			columns = this.identifierList();
			this.consume(TokenType.RPAREN, "Expected ')' after view columns.");
		}
		this.consumeKeyword('AS', "Expected AS before view body in view declaration.");
		const select = this.parseQueryExpr(undefined, /*requireReturning*/ true);

		// A trailing `with defaults (…)` rides inside the select body
		// (`select.defaults`); only the DDL-level WITH TAGS is parsed here.

		// Parse optional WITH TAGS
		let tags: Record<string, SqlValue> | undefined;
		if (this.matchKeyword('WITH')) {
			if (this.matchKeyword('TAGS')) {
				tags = this.parseTags();
			} else {
				this.current--;
			}
		}

		const viewStmt: AST.CreateViewStmt = {
			type: 'createView',
			view: { type: 'identifier', name: viewName },
			ifNotExists: false,
			columns,
			select,
			tags
		};

		return { type: 'declaredView', viewStmt };
	}

	private declareMaterializedViewItem(): AST.DeclaredMaterializedView {
		const viewName = this.consumeIdentifier('Expected materialized view name.');
		let columns: string[] | undefined;
		if (this.match(TokenType.LPAREN)) {
			columns = this.identifierList();
			this.consume(TokenType.RPAREN, "Expected ')' after materialized view columns.");
		}

		// Optional backing-module clause (`using mem(...)`) before the body — same
		// shape as the top-level CREATE MATERIALIZED VIEW form.
		let moduleName: string | undefined;
		const moduleArgs: Record<string, SqlValue> = {};
		if (this.matchKeyword('USING')) {
			moduleName = this.consumeIdentifier("Expected module name after 'USING'.");
			if (this.match(TokenType.LPAREN)) {
				let positionalIndex = 0;
				if (!this.check(TokenType.RPAREN)) {
					do {
						if (this.check(TokenType.STRING) || this.check(TokenType.INTEGER) || this.check(TokenType.FLOAT)) {
							const token = this.advance();
							moduleArgs[String(positionalIndex++)] = this.tokenLiteralValue(token);
						} else if (this.check(TokenType.IDENTIFIER)) {
							const nameValue = this.nameValueItem('module argument');
							moduleArgs[nameValue.name] = nameValue.value && nameValue.value.type === 'literal'
								? getSyncLiteral(nameValue.value)
								: (nameValue.value && nameValue.value.type === 'identifier' ? nameValue.value.name : nameValue.name);
						} else {
							throw this.error(this.peek(), "Expected module argument (string, number, or name=value pair).");
						}
					} while (this.match(TokenType.COMMA));
				}
				this.consume(TokenType.RPAREN, "Expected ')' after module arguments.");
			}
		}

		this.consumeKeyword('AS', "Expected AS before view body in materialized view declaration.");
		const select = this.parseQueryExpr(undefined, /*requireReturning*/ true);

		// A trailing `with defaults (…)` rides inside the select body
		// (`select.defaults`); only the DDL-level WITH TAGS is parsed here.

		// Parse optional WITH TAGS
		let tags: Record<string, SqlValue> | undefined;
		if (this.matchKeyword('WITH')) {
			if (this.matchKeyword('TAGS')) {
				tags = this.parseTags();
			} else {
				this.current--;
			}
		}

		const viewStmt: AST.CreateMaterializedViewStmt = {
			type: 'createMaterializedView',
			view: { type: 'identifier', name: viewName },
			ifNotExists: false,
			columns,
			select,
			moduleName,
			moduleArgs: moduleName && Object.keys(moduleArgs).length > 0 ? moduleArgs : undefined,
			tags
		};

		return { type: 'declaredMaterializedView', viewStmt };
	}

	private declareSeedItem(): AST.DeclaredSeed {
		// seed <table> ( (...), (...) ) or seed <table> values (col, ...) values (...), (...)
		const tableName = this.consumeIdentifier('Expected table name after SEED.');

		let columns: string[] | undefined;
		const rows: SqlValue[][] = [];

		// Check for column list syntax: seed table (cols...) values (...)
		if (this.matchKeyword('VALUES')) {
			this.consume(TokenType.LPAREN, "Expected '(' before seed column list.");
			columns = this.identifierList();
			this.consume(TokenType.RPAREN, "Expected ')' after seed column list.");
			this.consumeKeyword('VALUES', "Expected VALUES to introduce seed rows.");
		}

		// Parse seed rows: ( (...), (...) )
		this.consume(TokenType.LPAREN, "Expected '(' before seed rows.");

		do {
			this.consume(TokenType.LPAREN, "Expected '(' before seed row values.");
			const rowValues: SqlValue[] = [];
			if (!this.check(TokenType.RPAREN)) {
				do {
					const expr = this.expression();
					// Evaluate literal expressions to SqlValue
					if (expr.type === 'literal') {
						rowValues.push(getSyncLiteral(expr));
					} else {
						throw this.error(this.peek(), "Seed data must contain only literal values.");
					}
				} while (this.match(TokenType.COMMA));
			}
			this.consume(TokenType.RPAREN, "Expected ')' after seed row values.");
			rows.push(rowValues);
		} while (this.match(TokenType.COMMA));

		this.consume(TokenType.RPAREN, "Expected ')' after seed rows.");

		return { type: 'declaredSeed', tableName, columns, seedData: rows };
	}

	private declareAssertionItem(): AST.DeclaredAssertion {
		const startToken = this.previous();
		const assertionStmt = this.createAssertionStatement(startToken);
		return {
			type: 'declaredAssertion',
			assertionStmt,
			loc: assertionStmt.loc,
		};
	}

	private diffSchemaStatement(startToken: Token): AST.DiffSchemaStmt {
		this.consumeKeyword('SCHEMA', "Expected SCHEMA after DIFF.");
		const schemaName = this.consumeIdentifier(['temp', 'temporary'], 'Expected schema name after DIFF SCHEMA.');
		return { type: 'diffSchema', schemaName, loc: _createLoc(startToken, this.previous()) };
	}

	private applySchemaStatement(startToken: Token): AST.ApplySchemaStmt {
		this.consumeKeyword('SCHEMA', "Expected SCHEMA after APPLY.");
		const schemaName = this.consumeIdentifier(['temp', 'temporary'], 'Expected schema name after APPLY SCHEMA.');
		let toVersion: string | undefined;
		let withSeed = false;
		let options: AST.ApplySchemaStmt['options'] | undefined;

		if (this.matchKeyword('TO')) {
			this.consumeKeyword('VERSION', "Expected VERSION after TO.");
			const tok = this.consume(TokenType.STRING, "Expected version string after TO VERSION.");
			toVersion = String(tok.literal);
		}

		// Check for WITH SEED
		if (this.matchKeyword('WITH')) {
			this.consumeKeyword('SEED', "Expected SEED after WITH.");
			withSeed = true;
		}

		if (this.matchKeyword('OPTIONS')) {
			this.consume(TokenType.LPAREN, "Expected '(' after OPTIONS.");
			options = {};
			if (!this.check(TokenType.RPAREN)) {
				do {
					const key = this.consumeIdentifier('Expected option key.').toLowerCase();
					this.consume(TokenType.EQUAL, "Expected '=' after option key.");
					if (key === 'dry_run') options.dryRun = this.consumeBooleanLiteral();
					else if (key === 'validate_only') options.validateOnly = this.consumeBooleanLiteral();
					else if (key === 'allow_destructive') options.allowDestructive = this.consumeBooleanLiteral();
					else if (key === 'rename_policy') {
						const vtok = this.consume(TokenType.STRING, "Expected string for rename_policy.");
						const v = String(vtok.literal);
						if (v !== 'allow' && v !== 'require-hint' && v !== 'deny') {
							throw new ParseError(vtok, `Unknown rename_policy '${v}'. Expected 'allow', 'require-hint', or 'deny'.`);
						}
						options.renamePolicy = v;
					} else {
						// consume literal
						if (this.check(TokenType.STRING) || this.check(TokenType.INTEGER) || this.check(TokenType.FLOAT) || this.check(TokenType.IDENTIFIER)) this.advance();
					}
				} while (this.match(TokenType.COMMA));
			}
			this.consume(TokenType.RPAREN, "Expected ')' after OPTIONS.");
		}

		return { type: 'applySchema', schemaName, toVersion, withSeed, options, loc: _createLoc(startToken, this.previous()) };
	}

	private explainSchemaStatement(startToken: Token): AST.ExplainSchemaStmt {
		this.consumeKeyword('SCHEMA', "Expected SCHEMA after EXPLAIN.");
		const schemaName = this.consumeIdentifier(['temp', 'temporary'], 'Expected schema name after EXPLAIN SCHEMA.');
		let version: string | undefined;

		if (this.matchKeyword('VERSION')) {
			const tok = this.consume(TokenType.STRING, "Expected version string after VERSION.");
			version = String(tok.literal);
		}

		return { type: 'explainSchema', schemaName, version, loc: _createLoc(startToken, this.previous()) };
	}

	private consumeBooleanLiteral(): boolean {
		if (this.match(TokenType.TRUE)) return true;
		if (this.match(TokenType.FALSE)) return false;
		if (this.check(TokenType.STRING)) {
			const t = this.advance();
			const v = String(t.literal).toLowerCase();
			return v === 'true' || v === '1';
		}
		if (this.check(TokenType.INTEGER)) {
			const t = this.advance();
			return Number(t.literal) !== 0;
		}
		return false;
	}

	private sourceSlice(_start: number, _end: number): string {
		// Lexer tokens include offsets; this.tokens array belongs to this parser, but we don't have direct source here.
		// Return an empty string as placeholder; canonicalization is future work.
		return '';
	}

	private nameValueItem(context: string): { name: string, value?: AST.IdentifierExpr | AST.LiteralExpr } {
		const name = this.consumeIdentifier(`Expected ${context} name.`);

		let value: AST.LiteralExpr | AST.IdentifierExpr | undefined;
		if (this.match(TokenType.EQUAL)) {
			if (this.checkIdentifierLike(CONTEXTUAL_KEYWORDS)) {
				// `on` lexes as the JOIN keyword, so a bareword value must accept CONTEXTUAL_KEYWORDS (`pragma foreign_keys = on`)
				value = { type: 'identifier', name: this.consumeIdentifier(CONTEXTUAL_KEYWORDS, `Expected ${context} value.`) };
			} else if (this.match(TokenType.STRING, TokenType.INTEGER, TokenType.FLOAT, TokenType.NULL, TokenType.TRUE, TokenType.FALSE)) {
				const token = this.previous();
				let literal_value: SqlValue;
				if (token.type === TokenType.NULL) {
					literal_value = null;
				} else if (token.type === TokenType.TRUE) {
					literal_value = 1;
				} else if (token.type === TokenType.FALSE) {
					literal_value = 0;
				} else {
					literal_value = this.tokenLiteralValue(token);
				}
				value = { type: 'literal', value: literal_value };
			} else if (this.match(TokenType.MINUS)) {
				if (this.check(TokenType.INTEGER) || this.check(TokenType.FLOAT)) {
					const token = this.advance();
					value = { type: 'literal', value: -(token.literal as number) };
				} else {
					throw this.error(this.peek(), "Expected number after '-'.");
				}
			} else {
				throw this.error(this.peek(), `Expected ${context} value (identifier, string, number, or NULL).`);
			}
		}
		// If no '=' is found, value remains undefined (reading mode)

		return { name: name.toLowerCase(), value };
	}

	// --- Supporting Clause / Definition Parsers ---

	/** @internal Parses a comma-separated list of indexed columns */
	private indexedColumnList(): AST.IndexedColumn[] {
		const columns: AST.IndexedColumn[] = [];
		do {
			columns.push(this.indexedColumn());
		} while (this.match(TokenType.COMMA));
		return columns;
	}

	/** @internal Parses a single indexed column definition */
	private indexedColumn(): AST.IndexedColumn {
		const expr = this.expression();

		let name: string | undefined;
		if (expr.type === 'column' && !expr.table && !expr.schema) {
			name = expr.name;
		}

		let direction: 'asc' | 'desc' | undefined;
		if (this.match(TokenType.ASC)) {
			direction = 'asc';
		} else if (this.match(TokenType.DESC)) {
			direction = 'desc';
		}

		if (name) {
			return { name, direction };
		} else {
			return { expr, direction };
		}
	}

	/**
	 * @internal Helper to extract the identifier value from a token.
	 * For quoted identifiers (double-quoted, backtick, bracket), returns the unquoted value.
	 * For unquoted identifiers, returns the lexeme.
	 */
	private getIdentifierValue(token: Token): string {
		return token.literal !== undefined ? String(token.literal) : token.lexeme;
	}

	/**
	 * @internal The literal payload of a value token (STRING / INTEGER / FLOAT / BLOB)
	 * as a {@link SqlValue}. Those token types always carry a literal, so this only
	 * coalesces the type-level `undefined` (never reached at runtime for value tokens)
	 * to `null`. Use at sites that have already matched a value token type.
	 */
	private tokenLiteralValue(token: Token): SqlValue {
		return token.literal ?? null;
	}

	/** @internal Helper to consume an IDENTIFIER token and return its lexeme */
	private consumeIdentifier(errorMessage: string): string;
	private consumeIdentifier(availableKeywords: readonly string[], errorMessage: string): string;
	private consumeIdentifier(errorMessageOrKeywords: string | readonly string[], errorMessage?: string): string {
		if (typeof errorMessageOrKeywords === 'string') {
			// Single parameter version - no contextual keywords
			return this.consumeIdentifierOrContextualKeyword([], errorMessageOrKeywords);
		} else {
			// Two parameter version - with contextual keywords
			return this.consumeIdentifierOrContextualKeyword(errorMessageOrKeywords, errorMessage!);
		}
	}

	/**
	 * @internal Helper to consume an IDENTIFIER token or specified contextual keywords
	 * @param availableKeywords Array of keyword strings that can be used as identifiers in this context
	 * @param errorMessage Error message if no valid token is found
	 * @returns The identifier value (unquoted for quoted identifiers)
	 */
	private consumeIdentifierOrContextualKeyword(availableKeywords: readonly string[], errorMessage: string): string {
		const token = this.peek();

		// First check for regular identifier
		if (this.check(TokenType.IDENTIFIER)) {
			return this.getIdentifierValue(this.advance());
		}

		// Then check for available contextual keywords
		for (const keyword of availableKeywords) {
			const keywordUpper = keyword.toUpperCase();
			const expectedTokenType = TokenType[keywordUpper as keyof typeof TokenType];

			if (expectedTokenType && token.type === expectedTokenType) {
				// This keyword token is available as an identifier in this context
				return this.advance().lexeme;
			}
		}

		throw this.error(this.peek(), errorMessage);
	}

	/**
	 * @internal Helper to check if current token is an identifier or available contextual keyword
	 */
	private checkIdentifierLike(availableKeywords: readonly string[] = []): boolean {
		if (this.check(TokenType.IDENTIFIER)) {
			return true;
		}

		return this.isContextualKeywordAvailable(availableKeywords);
	}

	/**
	 * @internal Helper to check if token at offset is an identifier or available contextual keyword
	 */
	private checkIdentifierLikeAt(offset: number, availableKeywords: readonly string[] = []): boolean {
		if (this.checkNext(offset, TokenType.IDENTIFIER)) {
			return true;
		}

		if (this.current + offset >= this.tokens.length) return false;
		const token = this.tokens[this.current + offset];

		for (const keyword of availableKeywords) {
			const keywordUpper = keyword.toUpperCase();
			const expectedTokenType = TokenType[keywordUpper as keyof typeof TokenType];

			if (expectedTokenType && token.type === expectedTokenType) {
				return true;
			}
		}

		return false;
	}

	/**
	 * @internal Helper to check if any of the specified contextual keywords are available at current position
	 */
	private isContextualKeywordAvailable(availableKeywords: readonly string[]): boolean {
		const token = this.peek();

		for (const keyword of availableKeywords) {
			const keywordUpper = keyword.toUpperCase();
			const expectedTokenType = TokenType[keywordUpper as keyof typeof TokenType];

			if (expectedTokenType && token.type === expectedTokenType) {
				return true;
			}
		}

		return false;
	}

	// --- Stubs for required helpers (implement fully for CREATE TABLE) ---

	/** @internal Parses a column definition */
	private columnDefinition(): AST.ColumnDef {
		const name = this.consumeIdentifier(CONTEXTUAL_KEYWORDS, "Expected column name.");

		let dataType: string | undefined;
		if (this.check(TokenType.IDENTIFIER)) {
			dataType = this.advance().lexeme;
			if (this.match(TokenType.LPAREN)) {
				dataType += '(';
				let parenLevel = 1;
				while (parenLevel > 0 && !this.isAtEnd()) {
					const token = this.peek();
					if (token.type === TokenType.LPAREN) parenLevel++;
					if (token.type === TokenType.RPAREN) parenLevel--;
					if (parenLevel > 0) {
						dataType += this.advance().lexeme;
					}
				}
				dataType += ')';
				this.consume(TokenType.RPAREN, "Expected ')' after type parameters.");
			}
		}

		const constraints = this.columnConstraintList();

		// Parse optional column-level WITH TAGS
		let tags: Record<string, SqlValue> | undefined;
		if (this.matchKeyword('WITH')) {
			if (this.matchKeyword('TAGS')) {
				tags = this.parseTags();
			} else {
				this.current--;
			}
		}

		return { name, dataType, constraints, tags };
	}

	/** @internal Parses mutation context variable definitions: WITH CONTEXT (var type [NULL], ...) */
	private parseMutationContextDefinitions(): AST.MutationContextVar[] {
		this.consume(TokenType.LPAREN, "Expected '(' after WITH CONTEXT.");

		const contextVars: AST.MutationContextVar[] = [];

		do {
			const name = this.consumeIdentifier("Expected context variable name.");

			let dataType: string | undefined;
			if (this.check(TokenType.IDENTIFIER)) {
				dataType = this.advance().lexeme;
				if (this.match(TokenType.LPAREN)) {
					dataType += '(';
					let parenLevel = 1;
					while (parenLevel > 0 && !this.isAtEnd()) {
						const token = this.peek();
						if (token.type === TokenType.LPAREN) parenLevel++;
						if (token.type === TokenType.RPAREN) parenLevel--;
						if (parenLevel > 0) {
							dataType += this.advance().lexeme;
						}
					}
					dataType += ')';
					this.consume(TokenType.RPAREN, "Expected ')' after type parameters.");
				}
			}

			// Check for NULL keyword (explicit nullable marker)
			const notNull = !this.match(TokenType.NULL);

			contextVars.push({ name, dataType, notNull });

		} while (this.match(TokenType.COMMA));

		this.consume(TokenType.RPAREN, "Expected ')' after mutation context definitions.");

		return contextVars;
	}

	/** @internal Parses mutation context assignments: WITH CONTEXT var = expr, ... */
	private parseContextAssignments(): AST.ContextAssignment[] {
		const assignments: AST.ContextAssignment[] = [];

		do {
			const name = this.consumeIdentifier("Expected context variable name.");
			this.consume(TokenType.EQUAL, `Expected '=' after context variable '${name}'.`);
			const value = this.expression();

			assignments.push({ name, value });

		} while (this.match(TokenType.COMMA));

		return assignments;
	}

	/** @internal Parses schema search path: WITH SCHEMA schema1, schema2, ... */
	private parseSchemaPath(): string[] | undefined {
		if (this.matchKeyword('WITH')) {
			if (this.matchKeyword('SCHEMA')) {
				const schemas: string[] = [];
				do {
					const schemaName = this.consumeIdentifier("Expected schema name in WITH SCHEMA clause.");
					schemas.push(schemaName);
				} while (this.match(TokenType.COMMA));
				return schemas;
			} else {
				// Not a WITH SCHEMA clause, backtrack
				this.current--;
				return undefined;
			}
		}
		return undefined;
	}

	/**
	 * @internal Parses trailing WITH clauses (WITH CONTEXT and/or WITH SCHEMA) in any order.
	 * Returns both contextValues and schemaPath, or undefined if not present.
	 */
	private parseTrailingWithClauses(): { contextValues?: AST.ContextAssignment[], schemaPath?: string[], tags?: Record<string, SqlValue> } {
		let contextValues: AST.ContextAssignment[] | undefined;
		let schemaPath: string[] | undefined;
		let tags: Record<string, SqlValue> | undefined;

		// Keep trying to parse WITH clauses until we don't find any more
		while (this.matchKeyword('WITH')) {
			if (this.matchKeyword('CONTEXT')) {
				if (contextValues) {
					throw this.error(this.previous(), "Duplicate WITH CONTEXT clause");
				}
				contextValues = this.parseContextAssignments();
			} else if (this.matchKeyword('SCHEMA')) {
				if (schemaPath) {
					throw this.error(this.previous(), "Duplicate WITH SCHEMA clause");
				}
				const schemas: string[] = [];
				do {
					const schemaName = this.consumeIdentifier("Expected schema name in WITH SCHEMA clause.");
					schemas.push(schemaName);
				} while (this.match(TokenType.COMMA));
				schemaPath = schemas;
			} else if (this.matchKeyword('TAGS')) {
				if (tags) {
					throw this.error(this.previous(), "Duplicate WITH TAGS clause");
				}
				tags = this.parseTags();
			} else {
				// Not a recognized WITH clause, backtrack
				this.current--;
				break;
			}
		}

		return { contextValues, schemaPath, tags };
	}

	/**
	 * @internal Parses a tags list: (key = value, ...)
	 * Called after the TAGS keyword has been consumed.
	 * Keys are identifiers, values are literals (string, number, boolean via TRUE/FALSE, NULL).
	 */
	private parseTags(): Record<string, SqlValue> {
		this.consume(TokenType.LPAREN, "Expected '(' after TAGS.");
		const tags: Record<string, SqlValue> = {};

		if (!this.check(TokenType.RPAREN)) {
			do {
				const key = this.consumeIdentifier("Expected tag key identifier.");
				this.consume(TokenType.EQUAL, `Expected '=' after tag key '${key}'.`);
				const value = this.parseTagValue();
				tags[key] = value;
			} while (this.match(TokenType.COMMA));
		}

		this.consume(TokenType.RPAREN, "Expected ')' after tag list.");
		return tags;
	}

	/**
	 * @internal Parses a bare comma-list of tag keys — `(key [, key ...])` with no
	 * `= value`, used by the DROP TAGS form. Mirrors {@link parseTags} but yields
	 * just the keys. An empty list `()` yields `[]`.
	 */
	private parseTagKeys(): string[] {
		this.consume(TokenType.LPAREN, "Expected '(' after TAGS.");
		const keys: string[] = [];

		if (!this.check(TokenType.RPAREN)) {
			do {
				keys.push(this.consumeIdentifier("Expected tag key identifier."));
			} while (this.match(TokenType.COMMA));
		}

		this.consume(TokenType.RPAREN, "Expected ')' after tag key list.");
		return keys;
	}

	/** @internal Parses a tag value: string, number, TRUE, FALSE, or NULL */
	private parseTagValue(): SqlValue {
		if (this.match(TokenType.STRING)) {
			return this.previous().literal as string;
		}
		if (this.match(TokenType.INTEGER) || this.match(TokenType.FLOAT)) {
			return this.previous().literal as number;
		}
		if (this.match(TokenType.TRUE)) {
			return true;
		}
		if (this.match(TokenType.FALSE)) {
			return false;
		}
		if (this.match(TokenType.NULL)) {
			return null;
		}
		// Allow negative numbers
		if (this.match(TokenType.MINUS)) {
			if (this.match(TokenType.INTEGER) || this.match(TokenType.FLOAT)) {
				return -(this.previous().literal as number);
			}
			throw this.error(this.peek(), "Expected number after '-' in tag value.");
		}
		throw this.error(this.peek(), "Expected tag value (string, number, true, false, or null).");
	}

	/** @internal Parses column constraints */
	private columnConstraintList(): AST.ColumnConstraint[] {
		const constraints: AST.ColumnConstraint[] = [];
		while (this.isColumnConstraintStart()) {
			constraints.push(this.columnConstraint());
		}
		return constraints;
	}

	/** @internal Checks if the current token can start a column constraint */
	private isColumnConstraintStart(): boolean {
		return this.check(TokenType.CONSTRAINT) ||
			this.check(TokenType.PRIMARY) ||
			this.check(TokenType.NOT) ||
			this.check(TokenType.NULL) ||
			this.check(TokenType.UNIQUE) ||
			this.check(TokenType.CHECK) ||
			this.check(TokenType.DEFAULT) ||
			this.check(TokenType.COLLATE) ||
			this.check(TokenType.REFERENCES) ||
			this.check(TokenType.GENERATED);
	}

	/** @internal Parses a single column constraint */
	private columnConstraint(): AST.ColumnConstraint {
		let name: string | undefined;
		const startToken = this.peek(); // Capture start token
		let endToken = startToken; // Initialize end token

		if (this.match(TokenType.CONSTRAINT)) {
			name = this.consumeIdentifier("Expected constraint name after CONSTRAINT.");
			endToken = this.previous();
		}

		let result: AST.ColumnConstraint;

		if (this.match(TokenType.PRIMARY)) {
			this.consume(TokenType.KEY, "Expected KEY after PRIMARY.");
			const direction = this.match(TokenType.ASC) ? 'asc' : this.match(TokenType.DESC) ? 'desc' : undefined;
			if (direction) endToken = this.previous();
			const onConflict = this.parseConflictClause();
			if (onConflict) endToken = this.previous();
			if (this.check(TokenType.AUTOINCREMENT)) {
				throw this.error(this.peek(), 'AUTOINCREMENT is not supported. Quereus uses key-based addressing without implicit side-effects.');
			}
			result = { type: 'primaryKey', name, onConflict, direction, loc: _createLoc(startToken, endToken) };
		} else if (this.match(TokenType.NOT)) {
			this.consume(TokenType.NULL, "Expected NULL after NOT.");
			endToken = this.previous();
			const onConflict = this.parseConflictClause();
			if (onConflict) endToken = this.previous();
			result = { type: 'notNull', name, onConflict, loc: _createLoc(startToken, endToken) };
		} else if (this.match(TokenType.NULL)) {
			endToken = this.previous();
			const onConflict = this.parseConflictClause();
			if (onConflict) endToken = this.previous();
			result = { type: 'null', name, onConflict, loc: _createLoc(startToken, endToken) };
		} else if (this.match(TokenType.UNIQUE)) {
			endToken = this.previous();
			const onConflict = this.parseConflictClause();
			if (onConflict) endToken = this.previous();
			result = { type: 'unique', name, onConflict, loc: _createLoc(startToken, endToken) };
		} else if (this.match(TokenType.CHECK)) {
			let operations: RowOp[] | undefined;
			if (this.matchKeyword('ON')) {
				operations = this.parseRowOpList();
			}
			this.consume(TokenType.LPAREN, "Expected '(' after CHECK.");
			const expr = this.expression();
			endToken = this.consume(TokenType.RPAREN, "Expected ')' after CHECK expression.");
			const onConflict = this.parseConflictClause();
			if (onConflict) endToken = this.previous();
			result = { type: 'check', name, expr, operations, onConflict, loc: _createLoc(startToken, endToken) };
		} else if (this.match(TokenType.DEFAULT)) {
			const expr = this.expression();
			endToken = this.previous();
			result = { type: 'default', name, expr, loc: _createLoc(startToken, endToken) };
		} else if (this.match(TokenType.COLLATE)) {
			if (!this.check(TokenType.IDENTIFIER)) {
				throw this.error(this.peek(), "Expected collation name after COLLATE.");
			}
			const collation = this.getIdentifierValue(this.advance());
			endToken = this.previous();
			result = { type: 'collate', name, collation, loc: _createLoc(startToken, endToken) };
		} else if (this.match(TokenType.REFERENCES)) {
			const fkClause = this.foreignKeyClause();
			endToken = this.previous();
			result = { type: 'foreignKey', name, foreignKey: fkClause, loc: _createLoc(startToken, endToken) };
		} else if (this.match(TokenType.GENERATED)) {
			this.consume(TokenType.ALWAYS, "Expected ALWAYS after GENERATED.");
			this.consume(TokenType.AS, "Expected AS after GENERATED ALWAYS.");
			this.consume(TokenType.LPAREN, "Expected '(' after AS.");
			const expr = this.expression();
			this.consume(TokenType.RPAREN, "Expected ')' after generated expression.");
			endToken = this.previous();
			let stored = false;
			if (this.match(TokenType.STORED)) {
				stored = true;
				endToken = this.previous();
			} else if (this.match(TokenType.VIRTUAL)) {
				endToken = this.previous();
			}
			result = { type: 'generated', name, generated: { expr, stored }, loc: _createLoc(startToken, endToken) };
		} else {
			throw this.error(this.peek(), "Expected column constraint type (PRIMARY KEY, NOT NULL, UNIQUE, CHECK, DEFAULT, COLLATE, REFERENCES, GENERATED).");
		}

		// Parse optional trailing WITH TAGS for the constraint.
		// Only consume here for *named* constraints (CONSTRAINT <name> ...).
		// Unnamed inline constraints leave any trailing WITH TAGS for the
		// surrounding column-level parser, since users naturally write
		// `name text not null with tags (...)` to tag the column.
		if (name !== undefined && this.matchKeyword('WITH')) {
			if (this.matchKeyword('TAGS')) {
				result.tags = this.parseTags();
			} else {
				this.current--;
			}
		}

		return result;
	}

	/** @internal Parses a table constraint */
	private tableConstraint(): AST.TableConstraint {
		let name: string | undefined;
		const startToken = this.peek(); // Capture start token
		let endToken = startToken; // Initialize end token

		if (this.match(TokenType.CONSTRAINT)) {
			name = this.consumeIdentifier("Expected constraint name after CONSTRAINT.");
			endToken = this.previous();
		}

		let result: AST.TableConstraint;

		if (this.match(TokenType.PRIMARY)) {
			this.consume(TokenType.KEY, "Expected KEY after PRIMARY.");
			this.consume(TokenType.LPAREN, "Expected '(' before PRIMARY KEY columns.");

			// Handle empty PRIMARY KEY () for singleton tables (Third Manifesto feature)
			let columns: { name: string; direction?: 'asc' | 'desc' }[] = [];
			if (!this.check(TokenType.RPAREN)) {
				columns = this.identifierListWithDirection();
			}

			endToken = this.consume(TokenType.RPAREN, "Expected ')' after PRIMARY KEY columns.");
			const onConflict = this.parseConflictClause();
			if (onConflict) endToken = this.previous();
			result = { type: 'primaryKey', name, columns, onConflict, loc: _createLoc(startToken, endToken) };
		} else if (this.match(TokenType.UNIQUE)) {
			this.consume(TokenType.LPAREN, "Expected '(' before UNIQUE columns.");
			const columnsSimple = this.identifierList();
			const columns = columnsSimple.map(name => ({ name }));
			endToken = this.consume(TokenType.RPAREN, "Expected ')' after UNIQUE columns.");
			const onConflict = this.parseConflictClause();
			if (onConflict) endToken = this.previous();
			result = { type: 'unique', name, columns, onConflict, loc: _createLoc(startToken, endToken) };
		} else if (this.match(TokenType.CHECK)) {
			let operations: RowOp[] | undefined;
			if (this.matchKeyword('ON')) {
				operations = this.parseRowOpList();
			}
			this.consume(TokenType.LPAREN, "Expected '(' after CHECK.");
			const expr = this.expression();
			endToken = this.consume(TokenType.RPAREN, "Expected ')' after CHECK expression.");
			const onConflict = this.parseConflictClause();
			if (onConflict) endToken = this.previous();
			result = { type: 'check', name, expr, operations, onConflict, loc: _createLoc(startToken, endToken) };
		} else if (this.match(TokenType.FOREIGN)) {
			this.consume(TokenType.KEY, "Expected KEY after FOREIGN.");
			this.consume(TokenType.LPAREN, "Expected '(' before FOREIGN KEY columns.");
			const columns = this.identifierList().map(name => ({ name }));
			this.consume(TokenType.RPAREN, "Expected ')' after FOREIGN KEY columns.");
			const fkClause = this.foreignKeyClause();
			endToken = this.previous();
			result = { type: 'foreignKey', name, columns, foreignKey: fkClause, loc: _createLoc(startToken, endToken) };
		} else {
			throw this.error(this.peek(), "Expected table constraint type (PRIMARY KEY, UNIQUE, CHECK, FOREIGN KEY).");
		}

		// Parse optional trailing WITH TAGS for the constraint
		if (this.matchKeyword('WITH')) {
			if (this.matchKeyword('TAGS')) {
				result.tags = this.parseTags();
			} else {
				this.current--;
			}
		}

		return result;
	}

	/** @internal Parses a foreign key clause (REFERENCES may already be consumed by caller) */
	private foreignKeyClause(): AST.ForeignKeyClause {
		// Consume REFERENCES if not already consumed by caller (column-level FK)
		if (this.check(TokenType.REFERENCES)) {
			this.advance();
		}
		// Optional `schema.` qualifier on the parent table (cross-schema FK),
		// mirroring tableIdentifier() so a schema named `temp` parses.
		const contextualKeywords = [...CONTEXTUAL_KEYWORDS, 'temp', 'temporary'];
		let schema: string | undefined;
		let table: string;
		if (this.checkIdentifierLike(contextualKeywords) && this.checkNext(1, TokenType.DOT)) {
			schema = this.consumeIdentifier(contextualKeywords, "Expected schema name.");
			this.advance(); // Consume DOT
			table = this.consumeIdentifier(contextualKeywords, "Expected foreign table name after schema.");
		} else {
			table = this.consumeIdentifier(contextualKeywords, "Expected foreign table name.");
		}
		let columns: string[] | undefined;
		if (this.match(TokenType.LPAREN)) {
			columns = this.identifierList();
			this.consume(TokenType.RPAREN, "Expected ')' after foreign columns.");
		}

		let onDelete: AST.ForeignKeyAction | undefined;
		let onUpdate: AST.ForeignKeyAction | undefined;
		let deferrable: boolean | undefined;
		let initiallyDeferred: boolean | undefined;

		while (this.check(TokenType.ON) || this.check(TokenType.DEFERRABLE) || this.check(TokenType.NOT)) {
			if (this.match(TokenType.ON)) {
				if (this.match(TokenType.DELETE)) {
					onDelete = this.parseForeignKeyAction();
				} else if (this.match(TokenType.UPDATE)) {
					onUpdate = this.parseForeignKeyAction();
				} else {
					throw this.error(this.peek(), "Expected DELETE or UPDATE after ON.");
				}
			} else if (this.match(TokenType.DEFERRABLE)) {
				deferrable = true;
				if (this.match(TokenType.INITIALLY)) {
					if (this.match(TokenType.DEFERRED)) {
						initiallyDeferred = true;
					} else if (this.match(TokenType.IMMEDIATE)) {
						initiallyDeferred = false;
					} else {
						throw this.error(this.peek(), "Expected DEFERRED or IMMEDIATE after INITIALLY.");
					}
				}
			} else if (this.match(TokenType.NOT)) {
				this.consume(TokenType.DEFERRABLE, "Expected DEFERRABLE after NOT.");
				deferrable = false;
				if (this.match(TokenType.INITIALLY)) {
					if (this.match(TokenType.DEFERRED)) {
						initiallyDeferred = true;
					} else if (this.match(TokenType.IMMEDIATE)) {
						initiallyDeferred = false;
					} else {
						throw this.error(this.peek(), "Expected DEFERRED or IMMEDIATE after INITIALLY.");
					}
				}
			} else {
				break;
			}
		}

		return { table, schema, columns, onDelete, onUpdate, deferrable, initiallyDeferred };
	}

	/** @internal Parses the ON CONFLICT clause */
	private parseConflictClause(): ConflictResolution | undefined {
		if (this.match(TokenType.ON)) {
			this.consume(TokenType.CONFLICT, "Expected CONFLICT after ON.");
			if (this.match(TokenType.ROLLBACK)) return ConflictResolution.ROLLBACK;
			if (this.match(TokenType.ABORT)) return ConflictResolution.ABORT;
			if (this.match(TokenType.FAIL)) return ConflictResolution.FAIL;
			if (this.match(TokenType.IGNORE)) return ConflictResolution.IGNORE;
			if (this.match(TokenType.REPLACE)) return ConflictResolution.REPLACE;
			throw this.error(this.peek(), "Expected conflict resolution algorithm (ROLLBACK, ABORT, FAIL, IGNORE, REPLACE).");
		}
		return undefined;
	}

	/** @internal Parses the foreign key action */
	private parseForeignKeyAction(): AST.ForeignKeyAction {
		if (this.match(TokenType.SET)) {
			if (this.match(TokenType.NULL)) return 'setNull';
			if (this.match(TokenType.DEFAULT)) return 'setDefault';
			throw this.error(this.peek(), "Expected NULL or DEFAULT after SET.");
		} else if (this.match(TokenType.CASCADE)) {
			return 'cascade';
		} else if (this.match(TokenType.RESTRICT)) {
			return 'restrict';
		} else if (this.match(TokenType.NO)) {
			this.consume(TokenType.ACTION, "Expected ACTION after NO.");
			return 'restrict';
		}
		throw this.error(this.peek(), "Expected foreign key action (SET NULL, SET DEFAULT, CASCADE, RESTRICT, NO ACTION).");
	}

	/** @internal Parses a comma-separated list of identifiers, optionally with ASC/DESC */
	private identifierList(): string[] {
		const identifiers: string[] = [];
		do {
			identifiers.push(this.consumeIdentifier(CONTEXTUAL_KEYWORDS, "Expected identifier in list."));
		} while (this.match(TokenType.COMMA));
		return identifiers;
	}

	/** @internal Parses a comma-separated list of identifiers, optionally with ASC/DESC */
	private identifierListWithDirection(): { name: string; direction?: 'asc' | 'desc' }[] {
		const identifiers: { name: string; direction?: 'asc' | 'desc' }[] = [];
		do {
			const name = this.consumeIdentifier(CONTEXTUAL_KEYWORDS, "Expected identifier in list.");
			const direction = this.match(TokenType.ASC) ? 'asc' : this.match(TokenType.DESC) ? 'desc' : undefined;
			identifiers.push({ name, direction });
		} while (this.match(TokenType.COMMA));
		return identifiers;
	}

	// --- Helper method to peek keywords case-insensitively ---
	private peekKeyword(keyword: string): boolean {
		if (this.isAtEnd()) return false;
		const token = this.peek();

		// The keyword lookup string should be uppercase to match TokenType enum keys (e.g., TokenType.SELECT)
		const keywordKey = keyword.toUpperCase();
		const expectedTokenType = TokenType[keywordKey as keyof typeof TokenType];

		// Check if the current token's type is the expected specific keyword TokenType.
		// This assumes the lexer has already correctly typed true keywords.
		if (expectedTokenType !== undefined && token.type === expectedTokenType) {
			return true;
		}

		// Fallback: if the token is a generic IDENTIFIER, check if its lexeme matches the keyword.
		// This handles contextual keywords like FIRST, LAST that aren't reserved keywords.
		if (token.type === TokenType.IDENTIFIER && token.lexeme.toUpperCase() === keywordKey) {
			return true;
		}

		return false;
	}

	// --- Helper method to match keywords case-insensitively ---
	private matchKeyword(keyword: string): boolean {
		if (this.isAtEnd()) return false;
		if (this.peekKeyword(keyword)) {
			this.advance();
			return true;
		}
		return false;
	}

	// --- Helper method to consume keywords case-insensitively ---
	private consumeKeyword(keyword: string, message: string): Token {
		if (this.peekKeyword(keyword)) {
			return this.advance();
		}
		throw this.error(this.peek(), message);
	}

	/** Parses the list of operations for CHECK ON */
	private parseRowOpList(): RowOp[] {
		const operations: RowOp[] = [];

		// Parse operations in a comma-separated list
		do {
			if (this.match(TokenType.INSERT)) {
				operations.push('insert');
			} else if (this.match(TokenType.UPDATE)) {
				operations.push('update');
			} else if (this.match(TokenType.DELETE)) {
				operations.push('delete');
			} else {
				throw this.error(this.peek(), "Expected INSERT, UPDATE, or DELETE after ON.");
			}
		} while (this.match(TokenType.COMMA));

		// Optional: Check for duplicates? The design allows them but ignores them.
		return operations;
	}

	/**
	 * Parses a CASE expression
	 * CASE [base_expr] WHEN cond THEN result ... [ELSE else_result] END
	 * CASE WHEN cond THEN result ... [ELSE else_result] END
	 */
	private parseCaseExpression(startToken: Token): AST.CaseExpr {
		let baseExpr: AST.Expression | undefined;
		const whenThenClauses: AST.CaseExprWhenThenClause[] = [];
		let elseExpr: AST.Expression | undefined;
		let endToken = startToken; // Initialize with CASE token

		// Check if it's CASE expr WHEN ... or CASE WHEN ...
		if (!this.peekKeyword('WHEN')) { // Changed from checkKeyword
			baseExpr = this.expression();
		}

		while (this.matchKeyword('WHEN')) {
			const whenCondition = this.expression();
			this.consumeKeyword('THEN', "Expected 'THEN' after WHEN condition in CASE expression.");
			const thenResult = this.expression();
			whenThenClauses.push({ when: whenCondition, then: thenResult });
			endToken = this.previous(); // Update endToken to the end of the THEN expression
		}

		if (whenThenClauses.length === 0) {
			throw this.error(this.peek(), "CASE expression must have at least one WHEN clause.");
		}

		if (this.matchKeyword('ELSE')) {
			elseExpr = this.expression();
			endToken = this.previous(); // Update endToken to the end of the ELSE expression
		}

		endToken = this.consumeKeyword('END', "Expected 'END' to terminate CASE expression.");

		return {
			type: 'case',
			baseExpr,
			whenThenClauses,
			elseExpr,
			loc: _createLoc(startToken, endToken),
		};
	}

	// Helper to check if a token lexeme is a common type name keyword for CAST
	private isTypeNameKeyword(lexeme: string): boolean {
		const typeKeywords = ['TEXT', 'INTEGER', 'REAL', 'BLOB', 'NUMERIC', 'VARCHAR', 'CHAR', 'DATE', 'DATETIME', 'BOOLEAN', 'INT'];
		return typeKeywords.includes(lexeme.toUpperCase());
	}

	private statementSupportsWithClause(
		statement: AST.AstNode
	): statement is AST.SelectStmt | AST.InsertStmt | AST.UpdateStmt | AST.DeleteStmt {
		return statement.type === 'select' ||
			statement.type === 'insert' ||
			statement.type === 'update' ||
			statement.type === 'delete';
	}

	// DEFERRABLE syntax not supported for CHECK constraints in Quereus.
}
