/**
 * Functions to convert DDL AST nodes back into SQL strings.
 *
 * Round-trip policy: the emitter is round-trip-faithful by default. Every
 * semantically meaningful AST field MUST survive `parse(astToString(ast))` —
 * a field that re-parses to a different value (or vanishes) is a bug, enforced
 * structurally by `test/emit-roundtrip-property.spec.ts`. The only fields the
 * emitter is permitted to drop are non-semantic metadata (`loc`, `comments`,
 * conditionally-filled `lexeme`) and clauses that are *exactly equivalent* to a
 * documented parser default (see below); each such omission is mirrored by an
 * entry in `test/emit-roundtrip-comparator.ts` so the drop stays intentional.
 *
 * Identifier quoting is conditional (`quoteIdentifier`): a name is quoted only
 * when it is a reserved word or not a bare-valid identifier, otherwise it is
 * emitted bare. Every identifier *position* (table/column/alias/schema/index/
 * view/savepoint/CTE/collation/pragma/function/…) must route through that gate
 * or a reserved-word name fails to re-parse — this is verified position-by-
 * position, driven off the lexer `KEYWORDS` table, in
 * `test/emit-roundtrip-positions.spec.ts` (the property test deliberately avoids
 * reserved words, so it cannot cover this class).
 *
 * Formatting Notes:
 * - Emits lowercase SQL keywords.
 * - Quotes identifiers (table/column names) using double quotes when necessary.
 * - String literals are escaped.
 * - Omits clauses that represent the default SQLite behavior:
 *   - `ON CONFLICT ABORT`
 *   - `ASC` direction for primary keys
 *   - `VIRTUAL` storage for generated columns
 */
import type * as AST from '../parser/ast.js';
import { ConflictResolution } from '../common/constants.js';
import { KEYWORDS, CONTEXTUAL_KEYWORDS } from '../parser/lexer.js';
import { uint8ArrayToHex } from '../util/serialization.js';
import type { SqlValue, RowOp } from '../common/types.js';

// --- Identifier Quoting Logic ---

// Basic check for valid SQL identifiers (adjust regex as needed)
const isValidIdentifier = (name: string): boolean => {
	return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
};

/**
 * Quotes an identifier (table, column, etc.) with double quotes if necessary.
 * Quoting is needed if the identifier:
 * - Is a reserved keyword (case-insensitive).
 * - Does not match the valid identifier pattern (starts with letter/_, contains letters/numbers/_).
 */
export function quoteIdentifier(name: string): string {
	if (Object.hasOwn(KEYWORDS, name.toLowerCase()) || !isValidIdentifier(name)) {
		return `"${name.replace(/"/g, '""')}"`; // Escape internal quotes
	}
	return name;
}

/**
 * Keyword function names the parser still accepts *bare* in a call position
 * (`consumeIdentifier([...CONTEXTUAL_KEYWORDS, 'replace'])` in parser.ts). For
 * these, emitting bare both round-trips and keeps the auto-derived result-column
 * name readable (`like('a%', x)`, not `"like"('a%', x)`).
 */
const BARE_CALLABLE_FUNCTION_NAMES = new Set<string>([...CONTEXTUAL_KEYWORDS, 'replace']);

/**
 * Quote a function name only when a bare emit would not re-parse as a call.
 * Ordinary names and bare-callable keyword names stay bare (lowercased, matching
 * the historical style); only a keyword the parser would reject bare (e.g.
 * `select`) is quoted so an exotic `"select"(x)` call still round-trips.
 */
function quoteFunctionName(name: string): string {
	const lower = name.toLowerCase();
	return BARE_CALLABLE_FUNCTION_NAMES.has(lower) ? lower : quoteIdentifier(lower);
}


// Main function to convert any AST node to SQL string
export function astToString(node: AST.AstNode): string {
	switch (node.type) {
		// Expression types
		case 'literal':
		case 'identifier':
		case 'column':
		case 'binary':
		case 'unary':
		case 'function':
		case 'cast':
		case 'parameter':
		case 'subquery':
		case 'collate':
		case 'case':
		case 'exists':
		case 'in':
		case 'between':
		case 'windowFunction':
			return expressionToString(node as AST.Expression);

		// Statement types
		case 'select':
			return selectToString(node as AST.SelectStmt);
		case 'insert':
			return insertToString(node as AST.InsertStmt);
		case 'update':
			return updateToString(node as AST.UpdateStmt);
		case 'delete':
			return deleteToString(node as AST.DeleteStmt);
		case 'values':
			return valuesToString(node as AST.ValuesStmt);
		case 'createTable':
			return createTableToString(node as AST.CreateTableStmt);
		case 'createIndex':
			return createIndexToString(node as AST.CreateIndexStmt);
		case 'createView':
			return createViewToString(node as AST.CreateViewStmt);
		case 'createMaterializedView':
			return createMaterializedViewToString(node as AST.CreateMaterializedViewStmt);
		case 'refreshMaterializedView':
			return refreshMaterializedViewToString(node as AST.RefreshMaterializedViewStmt);
		case 'createAssertion':
			return createAssertionToString(node as AST.CreateAssertionStmt);
		case 'alterTable':
			return alterTableToString(node as AST.AlterTableStmt);
		case 'alterView':
			return alterViewToString(node as AST.AlterViewStmt);
		case 'alterMaterializedView':
			return alterMaterializedViewToString(node as AST.AlterMaterializedViewStmt);
		case 'alterIndex':
			return alterIndexToString(node as AST.AlterIndexStmt);
		case 'analyze':
			return analyzeToString(node as AST.AnalyzeStmt);
		case 'drop':
			return dropToString(node as AST.DropStmt);
		case 'begin':
			return beginToString(node as AST.BeginStmt);
		case 'commit':
			return 'commit';
		case 'rollback':
			return rollbackToString(node as AST.RollbackStmt);
		case 'savepoint':
			return savepointToString(node as AST.SavepointStmt);
		case 'release':
			return releaseToString(node as AST.ReleaseStmt);
		case 'pragma':
			return pragmaToString(node as AST.PragmaStmt);
		case 'declareSchema':
			return declareSchemaToString(node as unknown as AST.DeclareSchemaStmt);
		case 'declareLens':
			return declareLensToString(node as unknown as AST.DeclareLensStmt);
		case 'diffSchema':
			return `diff schema ${quoteIdentifier((node as unknown as AST.DiffSchemaStmt).schemaName || 'main')}`;
		case 'applySchema': {
			const n = node as unknown as AST.ApplySchemaStmt;
			let s = `apply schema ${quoteIdentifier(n.schemaName || 'main')}`;
			if (n.toVersion) s += ` to version '${n.toVersion}'`;
			if (n.withSeed) s += ' with seed';
			if (n.options) {
				s += ' options (';
				const parts: string[] = [];
				if (n.options.allowDestructive !== undefined) parts.push(`allow_destructive = ${n.options.allowDestructive ? 'true' : 'false'}`);
				if (n.options.renamePolicy) parts.push(`rename_policy = '${n.options.renamePolicy}'`);
				s += parts.join(', ') + ')';
			}
			return s;
		}
		case 'explainSchema':
			return `explain schema ${quoteIdentifier((node as unknown as AST.ExplainSchemaStmt).schemaName || 'main')}`;

		default:
			// NOTE: switch is not compiler-enforced exhaustive; a new Statement/Expression AST
			// variant added without a matching case falls through here and renders as `[type]`
			// (e.g. surfaces via getBlockSql()/originalSql). If that ever bites, make this throw.
			return `[${node.type}]`; // Fallback for unknown node types
	}
}

// Helper to stringify expressions (extended from original)
export function expressionToString(expr: AST.Expression): string {
	switch (expr.type) {
		case 'literal': {
			// Prefer original lexeme for numbers if available and different
			if ((typeof expr.value === 'number' || typeof expr.value === 'bigint') && expr.lexeme && expr.lexeme !== String(expr.value)) {
				return expr.lexeme;
			}
			// Prefer original lexeme for NULL if available
			if (expr.value === null) return expr.lexeme?.toLowerCase() || 'null';
			if (typeof expr.value === 'string') return `'${expr.value.replace(/'/g, "''")}'`; // Escape single quotes
			if (typeof expr.value === 'number') return expr.value.toString();
			if (expr.value instanceof Uint8Array) {
				const hex = uint8ArrayToHex(expr.value);
				return `x'${hex}'`;
			}
			// JSON objects/arrays — render as quoted JSON string
			if (typeof expr.value === 'object' && expr.value !== null) {
				const jsonStr = JSON.stringify(expr.value);
				return `'${jsonStr.replace(/'/g, "''")}'`;
			}
			return String(expr.value);
		}

		case 'identifier': {
			let identStr = quoteIdentifier(expr.name);
			if (expr.schema) {
				identStr = `${quoteIdentifier(expr.schema)}.${identStr}`;
			}
			return identStr;
		}

		case 'column': {
			let colStr = quoteIdentifier(expr.name);
			if (expr.table) {
				colStr = `${quoteIdentifier(expr.table)}.${colStr}`;
				if (expr.schema) {
					colStr = `${quoteIdentifier(expr.schema)}.${colStr}`;
				}
			}
			return colStr;
		}

		case 'binary': {
			const leftStr = needsParens(expr.left, expr.operator, 'left')
				? `(${expressionToString(expr.left)})`
				: expressionToString(expr.left);
			const rightStr = needsParens(expr.right, expr.operator, 'right')
				? `(${expressionToString(expr.right)})`
				: expressionToString(expr.right);
			return `${leftStr} ${expr.operator.toLowerCase()} ${rightStr}`;
		}

		case 'unary': {
			const exprStr = unaryBodyNeedsParens(expr)
				? `(${expressionToString(expr.expr)})`
				: expressionToString(expr.expr);
			// Handle postfix operators: IS [NOT] NULL/TRUE/FALSE
			const upperOp = expr.operator.toUpperCase();
			if (POSTFIX_IS_OPERATORS.has(upperOp)) {
				return `${exprStr} ${expr.operator.toLowerCase()}`;
			} else if (upperOp === 'NOT') {
				return `not ${exprStr}`;
			}
			return `${expr.operator.toLowerCase()}${exprStr}`;
		}

		case 'function': {
			if (expr.name.toLowerCase() === 'count' && expr.args.length === 0) {
				return 'count(*)';
			}
			const argsStr = expr.args.map(arg => expressionToString(arg)).join(', ');
			const distinctStr = expr.distinct ? 'distinct ' : '';
			return `${quoteFunctionName(expr.name)}(${distinctStr}${argsStr})`;
		}

		case 'cast':
			return `cast(${expressionToString(expr.expr)} as ${expr.targetType.toLowerCase()})`;

		case 'parameter': {
			if (expr.index !== undefined) {
				return '?';
			} else if (expr.name) {
				return expr.name.startsWith(':') || expr.name.startsWith('$')
					? expr.name
					: `:${expr.name}`;
			}
			return '?';
		}

		case 'subquery':
			return `(${astToString(expr.query)})`;

		case 'exists':
			return `exists (${astToString((expr as AST.ExistsExpr).subquery)})`;

		case 'in': {
			const inExpr = expr as AST.InExpr;
			let result = expressionToString(inExpr.expr) + ' in ';
			if (inExpr.values) {
				result += `(${inExpr.values.map(expressionToString).join(', ')})`;
			} else if (inExpr.subquery) {
				result += `(${astToString(inExpr.subquery)})`;
			}
			return result;
		}

		case 'between': {
			const betweenExpr = expr as AST.BetweenExpr;
			const exprStr = expressionToString(betweenExpr.expr);
			const lowerStr = expressionToString(betweenExpr.lower);
			const upperStr = expressionToString(betweenExpr.upper);
			const notStr = betweenExpr.not ? 'not ' : '';
			return `${exprStr} ${notStr}between ${lowerStr} and ${upperStr}`;
		}

		case 'collate':
			return `${expressionToString(expr.expr)} collate ${quoteIdentifier(expr.collation.toLowerCase())}`;

		case 'case': {
			// TODO: preserve and emit with original case
			let caseStr = 'case';
			if (expr.baseExpr) {
				caseStr += ` ${expressionToString(expr.baseExpr)}`;
			}
			for (const clause of expr.whenThenClauses) {
				caseStr += ` when ${expressionToString(clause.when)} then ${expressionToString(clause.then)}`;
			}
			if (expr.elseExpr) {
				caseStr += ` else ${expressionToString(expr.elseExpr)}`;
			}
			caseStr += ' end';
			return caseStr;
		}

		case 'windowFunction': {
			let winStr = expressionToString(expr.function);
			if (expr.window) {
				winStr += ` over (${windowDefinitionToString(expr.window)})`;
			}
			return winStr;
		}

		default:
			return '[unknown_expr]';
	}
}

// Unary operators rendered as postfix `<expr> <op>` (e.g. `a is null`,
// `a is not true`) rather than the default prefix form.
const POSTFIX_IS_OPERATORS = new Set([
	'IS NULL', 'IS NOT NULL',
	'IS TRUE', 'IS NOT TRUE',
	'IS FALSE', 'IS NOT FALSE',
]);

// Determines whether the body of a unary expression must be parenthesised so
// the emitted SQL re-parses to the same AST. With prefix NOT bound above all
// predicates (IS [NOT] NULL, IN, BETWEEN, LIKE, comparison), most inner shapes
// round-trip cleanly without parens — only a `binary` body could re-associate
// (e.g. `not a and b` would be read as `(not a) and b`).
function unaryBodyNeedsParens(expr: AST.UnaryExpr): boolean {
	return expr.expr.type === 'binary';
}

// Binary-operator precedence for round-trip parenthesization; higher binds tighter.
// Module-level (built once) because `needsParens` runs hot during canonical-DDL /
// body-hash stringification. These are the emitter's own round-trip precedences (NOT
// SQLite's exact grammar table) — do not renumber existing operators or emitted SQL
// shifts. The keys must match the `operator` strings the parser actually stores on a
// `binary` node: `<>` is normalized to `!=` at parse time (never stored), and `IS` /
// `IS NOT` only ever form *unary* nodes (`IS NULL` / `IS [NOT] TRUE|FALSE`) — there is
// no binary distinct-from operator — so none of those appear here.
const BINARY_OPERATOR_PRECEDENCE: Record<string, number> = {
	'OR': 1, 'XOR': 1,
	'AND': 2,
	'=': 3, '==': 3, '!=': 3,
	'<': 4, '<=': 4, '>': 4, '>=': 4, 'LIKE': 4, 'GLOB': 4, 'MATCH': 4, 'REGEXP': 4,
	'+': 5, '-': 5,
	'*': 6, '/': 6, '%': 6,
	'||': 7,
};

const ASSOCIATIVE_BINARY_OPERATORS = new Set(['AND', 'OR', 'XOR', '+', '*', '||']);

// Helper to determine if parentheses are needed for binary operations
function needsParens(expr: AST.Expression, parentOp: string, side: 'left' | 'right'): boolean {
	if (expr.type !== 'binary') return false;

	const parentPrec = BINARY_OPERATOR_PRECEDENCE[parentOp.toUpperCase()] || 0;
	const childPrec = BINARY_OPERATOR_PRECEDENCE[expr.operator.toUpperCase()] || 0;

	if (childPrec < parentPrec) return true;
	if (childPrec === parentPrec && side === 'right' && !isAssociative(parentOp)) return true;

	return false;
}

function isAssociative(op: string): boolean {
	return ASSOCIATIVE_BINARY_OPERATORS.has(op.toUpperCase());
}

// Helper for window definitions
function windowDefinitionToString(win: AST.WindowDefinition): string {
	const parts: string[] = [];

	if (win.partitionBy && win.partitionBy.length > 0) {
		parts.push(`partition by ${win.partitionBy.map(expressionToString).join(', ')}`);
	}

	if (win.orderBy && win.orderBy.length > 0) {
		const orderParts = win.orderBy.map(clause => {
			let orderStr = expressionToString(clause.expr);
			if (clause.direction === 'desc') orderStr += ' desc';
			if (clause.nulls) orderStr += ` nulls ${clause.nulls.toLowerCase()}`;
			return orderStr;
		});
		parts.push(`order by ${orderParts.join(', ')}`);
	}

	if (win.frame) {
		parts.push(windowFrameToString(win.frame));
	}

	return parts.join(' ');
}

function windowFrameToString(frame: AST.WindowFrame): string {
	let frameStr = frame.type.toLowerCase(); // 'rows' or 'range'

	if (frame.end) {
		frameStr += ` between ${windowFrameBoundToString(frame.start)} and ${windowFrameBoundToString(frame.end)}`;
	} else {
		frameStr += ` ${windowFrameBoundToString(frame.start)}`;
	}

	if (frame.exclusion) {
		frameStr += ` exclude ${frame.exclusion.toLowerCase()}`;
	}

	return frameStr;
}

function windowFrameBoundToString(bound: AST.WindowFrameBound): string {
	switch (bound.type) {
		case 'currentRow': return 'current row';
		case 'unboundedPreceding': return 'unbounded preceding';
		case 'unboundedFollowing': return 'unbounded following';
		case 'preceding': return `${expressionToString(bound.value)} preceding`;
		case 'following': return `${expressionToString(bound.value)} following`;
		default: return '[unknown_bound]';
	}
}

/**
 * Returns a structural clone of an expression with every bare column / identifier
 * reference case-folded — `column` and `identifier` node `name` / `table` / `schema`
 * lowercased — and everything else left byte-exact. This is the expression-level
 * analogue of {@link lowercaseTableConstraintColumnNames}'s column-list fold: it makes
 * the canonical body of a CHECK expression / partial-index WHERE predicate
 * case-insensitive, matching Quereus's uniformly case-folding column resolution (the
 * AST never records identifier quoting; every resolver folds via `.toLowerCase()`), so
 * a reference whose case diverges from the column definition (or across re-declares)
 * renders identically on both diff sides instead of churning a spurious drop+recreate.
 *
 * Folds ONLY identifier references. Left byte-exact: string / blob / number / JSON /
 * NULL literals (`value` / `lexeme`), parameters, `cast.targetType`, `function.name`
 * (already lowercased at render), and `collate.collation` (already lowercased at
 * render — folding it here would double-handle). The full {@link expressionToString}
 * node set is mirrored so every nested shape recurses and folds its inner refs.
 *
 * Bounded limitation: subquery bodies (`subquery` / `exists` / `in (select …)`) pass
 * through structurally — the inner query is NOT descended into. This is symmetric on
 * both diff sides (no NEW churn versus today), and CHECK / partial-WHERE subqueries
 * are rare; full coverage is intentionally NOT implied.
 *
 * MUST NOT mutate the input: every folded node is rebuilt as a fresh object
 * (`{ ...node, ...recursed }`) and only `name` / `table` / `schema` are overridden on
 * a leaf ref. A `literal`'s `value` (a possibly-shared Uint8Array / JSON object /
 * Promise) is passed through by reference, never recursed into or copied. Used ONLY by
 * the canonical renderers ({@link constraintBodyToCanonicalString} via
 * {@link lowercaseTableConstraintColumnNames}, {@link createIndexBodyToCanonicalString});
 * the persistence renderers keep original case.
 */
function lowerExprIdentifiers(expr: AST.Expression): AST.Expression {
	switch (expr.type) {
		case 'column':
			return { ...expr, name: expr.name.toLowerCase(), table: expr.table?.toLowerCase(), schema: expr.schema?.toLowerCase() };
		case 'identifier':
			return { ...expr, name: expr.name.toLowerCase(), schema: expr.schema?.toLowerCase() };
		case 'binary':
			return { ...expr, left: lowerExprIdentifiers(expr.left), right: lowerExprIdentifiers(expr.right) };
		case 'unary':
			return { ...expr, expr: lowerExprIdentifiers(expr.expr) };
		case 'function':
			return { ...expr, args: expr.args.map(arg => lowerExprIdentifiers(arg)) };
		case 'cast':
			return { ...expr, expr: lowerExprIdentifiers(expr.expr) };
		case 'collate':
			// `collation` is left alone — the render lowercases it (`quoteIdentifier(collation.toLowerCase())`).
			return { ...expr, expr: lowerExprIdentifiers(expr.expr) };
		case 'case':
			return {
				...expr,
				baseExpr: expr.baseExpr ? lowerExprIdentifiers(expr.baseExpr) : undefined,
				whenThenClauses: expr.whenThenClauses.map(c => ({ when: lowerExprIdentifiers(c.when), then: lowerExprIdentifiers(c.then) })),
				elseExpr: expr.elseExpr ? lowerExprIdentifiers(expr.elseExpr) : undefined,
			};
		case 'between':
			return { ...expr, expr: lowerExprIdentifiers(expr.expr), lower: lowerExprIdentifiers(expr.lower), upper: lowerExprIdentifiers(expr.upper) };
		case 'in':
			// `subquery` (when present) passes through structurally — bounded limitation, see doc.
			return { ...expr, expr: lowerExprIdentifiers(expr.expr), values: expr.values?.map(v => lowerExprIdentifiers(v)) };
		case 'windowFunction':
			return { ...expr, function: lowerExprIdentifiers(expr.function) as AST.FunctionExpr, window: expr.window ? lowerWindowDefinitionIdentifiers(expr.window) : undefined };
		case 'literal':
		case 'parameter':
		case 'subquery':
		case 'exists':
		default:
			// Identifier-free or pass-through-structurally (subquery / exists) nodes: returned
			// as-is. Never mutated, so aliasing the input subtree back into the output is safe
			// (read-only at render); a literal's `value` is therefore never touched.
			return expr;
	}
}

/** Window-definition analogue of {@link lowerExprIdentifiers} — folds identifier refs in
 *  PARTITION BY / ORDER BY exprs and frame bounds. Window functions never appear in a CHECK /
 *  partial-WHERE today, but the fold mirrors {@link windowDefinitionToString} for symmetry. */
function lowerWindowDefinitionIdentifiers(win: AST.WindowDefinition): AST.WindowDefinition {
	return {
		...win,
		partitionBy: win.partitionBy?.map(e => lowerExprIdentifiers(e)),
		orderBy: win.orderBy?.map(o => ({ ...o, expr: lowerExprIdentifiers(o.expr) })),
		frame: win.frame ? lowerWindowFrameIdentifiers(win.frame) : undefined,
	};
}

function lowerWindowFrameIdentifiers(frame: AST.WindowFrame): AST.WindowFrame {
	return {
		...frame,
		start: lowerWindowFrameBoundIdentifiers(frame.start),
		end: frame.end ? lowerWindowFrameBoundIdentifiers(frame.end) : frame.end,
	};
}

function lowerWindowFrameBoundIdentifiers(bound: AST.WindowFrameBound): AST.WindowFrameBound {
	return (bound.type === 'preceding' || bound.type === 'following')
		? { ...bound, value: lowerExprIdentifiers(bound.value) }
		: bound;
}

/**
 * Case-insensitive identity fingerprint for aggregate-matching comparisons: folds
 * identifier (`column` / `identifier` node `name` / `table` / `schema`) case via
 * {@link lowerExprIdentifiers}, then renders through {@link expressionToString}.
 * String / blob / number / JSON literals stay byte-exact — two aggregate calls that
 * differ only in quoted-literal case (`count(nullif(b,'A'))` vs `count(nullif(b,'a'))`)
 * must NOT be treated as the same aggregate.
 *
 * NOT round-trip SQL (identifiers are lowercased) — for identity comparison only, not
 * persistence or display. Shares {@link lowerExprIdentifiers}'s bounded limitation: does
 * not descend into subquery bodies, so an aggregate argument containing a subquery whose
 * inner identifier case diverges misses the match. That is a missed match (an extra
 * aggregate gets computed, or a window specification hits the loud "not collected"
 * error) — never a wrong answer — so it is left unaddressed.
 */
export function expressionToIdentityString(expr: AST.Expression): string {
	return expressionToString(lowerExprIdentifiers(expr));
}

/**
 * Convert a result column (SELECT column list / RETURNING) to string:
 * `*` / `t.*` / `expr [as alias] [with inverse (col = expr, …)]`.
 */
function resultColumnToString(col: AST.ResultColumn): string {
	if (col.type === 'all') {
		return col.table ? `${quoteIdentifier(col.table)}.*` : '*';
	}
	let colStr = expressionToString(col.expr);
	if (col.alias) colStr += ` as ${quoteIdentifier(col.alias)}`;
	if (col.inverse && col.inverse.length > 0) {
		const assignments = col.inverse.map(a => `${quoteIdentifier(a.column)} = ${expressionToString(a.expr)}`);
		colStr += ` with inverse (${assignments.join(', ')})`;
	}
	return colStr;
}

/** Renders the `with schema s1, s2` search-path clause (WITH SCHEMA). */
function schemaPathClauseToString(schemaPath: readonly string[]): string {
	return `with schema ${schemaPath.map(quoteIdentifier).join(', ')}`;
}

// Statement stringify functions
export function selectToString(stmt: AST.SelectStmt): string {
	const parts: string[] = [];

	if (stmt.withClause) {
		parts.push(withClauseToString(stmt.withClause));
	}

	parts.push('select');

	if (stmt.distinct) parts.push('distinct');
	if (stmt.all) parts.push('all');

	parts.push(stmt.columns.map(resultColumnToString).join(', '));

	if (stmt.from && stmt.from.length > 0) {
		parts.push('from', stmt.from.map(fromClauseToString).join(', '));
	}

	if (stmt.where) {
		parts.push('where', expressionToString(stmt.where));
	}

	if (stmt.groupBy && stmt.groupBy.length > 0) {
		parts.push('group by', stmt.groupBy.map(expressionToString).join(', '));
	}

	if (stmt.having) {
		parts.push('having', expressionToString(stmt.having));
	}

	// WITH SCHEMA binds before the compound operator and before ORDER BY / LIMIT
	// (see `parseSchemaPath` in `selectStatement`; compound legs parse with
	// `isCompoundSubquery` and never consume it) — emit it here so re-parse
	// re-binds it to this statement rather than a leg or the trailing position.
	if (stmt.schemaPath && stmt.schemaPath.length > 0) {
		parts.push(schemaPathClauseToString(stmt.schemaPath));
	}

	// Trailing ORDER BY / LIMIT / OFFSET. On a COMPOUND select these apply to the
	// whole compound result and so are emitted AFTER the compound chain below —
	// rendering them in their normal position would re-bind them to the LEFT leg on
	// re-parse (and produce un-reparseable `… order by … union …` SQL). Built once
	// here and appended last in both the compound and non-compound cases.
	const trailing: string[] = [];
	if (stmt.orderBy && stmt.orderBy.length > 0) {
		const orderParts = stmt.orderBy.map(clause => {
			let orderStr = expressionToString(clause.expr);
			if (clause.direction === 'desc') orderStr += ' desc';
			if (clause.nulls) orderStr += ` nulls ${clause.nulls.toLowerCase()}`;
			return orderStr;
		});
		trailing.push('order by', orderParts.join(', '));
	}
	if (stmt.limit) {
		trailing.push('limit', expressionToString(stmt.limit));
	}
	if (stmt.offset) {
		trailing.push('offset', expressionToString(stmt.offset));
	}
	// `with defaults (col = expr, …)` binds to the whole compound, after
	// limit/offset (mirrors trailing ORDER BY) — appended last in both the
	// compound and non-compound cases below so re-parse re-binds it to the whole
	// result, not the left leg.
	const defaultsStr = defaultsClauseToString(stmt.defaults);
	if (defaultsStr) trailing.push(defaultsStr);

	let result = parts.join(' ');

	if (stmt.compound) {
		result += ` ${compoundOpToKeyword(stmt.compound.op)} `;
		// `exists <branch> as <name>` membership columns sit BETWEEN the operator keyword
		// and the right leg, so `parse(stringify(ast)) ≡ ast`.
		if (stmt.compound.existence && stmt.compound.existence.length > 0) {
			result += stmt.compound.existence
				.map(e => `exists ${e.branch} as ${quoteIdentifier(e.name)}`)
				.join(', ') + ' ';
		}
		result += compoundLegToString(stmt.compound.select);
	}

	if (trailing.length > 0) {
		result += ' ' + trailing.join(' ');
	}

	return result;
}

/**
 * Renders one compound set-operation leg. A SELECT leg that carries its OWN
 * trailing ORDER BY / LIMIT / OFFSET — or a WITH SCHEMA path, which bare legs
 * never parse (`isCompoundSubquery` suppresses it) — is wrapped in parentheses
 * so those clauses re-bind INSIDE the leg on re-parse; without the parens they
 * would attach to the enclosing compound (or fail to parse) and change the
 * parse. Every other leg — a bare SELECT, a VALUES leg, or a nested compound
 * (whose right-leaning re-parse is identical) — renders without parens, so
 * existing round-trips are unchanged.
 */
function compoundLegToString(leg: AST.QueryExpr): string {
	const s = astToString(leg);
	if (leg.type === 'select' && ((leg.orderBy && leg.orderBy.length > 0) || leg.limit || leg.offset
		|| (leg.schemaPath && leg.schemaPath.length > 0)
		|| (leg.defaults && leg.defaults.length > 0))) {
		return `(${s})`;
	}
	return s;
}

/** `with defaults (col = expr, …)` clause of a select body, or '' when absent. */
function defaultsClauseToString(defaults: ReadonlyArray<AST.ViewInsertDefault> | undefined): string {
	if (!defaults || defaults.length === 0) return '';
	const entries = defaults.map(d => `${quoteIdentifier(d.column)} = ${expressionToString(d.expr)}`);
	return `with defaults (${entries.join(', ')})`;
}

function compoundOpToKeyword(op: 'union' | 'unionAll' | 'intersect' | 'except' | 'diff'): string {
	switch (op) {
		case 'union': return 'union';
		case 'unionAll': return 'union all';
		case 'intersect': return 'intersect';
		case 'except': return 'except';
		case 'diff': return 'diff';
	}
}

function materializationHintToKeyword(hint: AST.CommonTableExpr['materializationHint']): string | undefined {
	switch (hint) {
		case 'materialized': return 'materialized';
		case 'not_materialized': return 'not materialized';
		case undefined: return undefined;
	}
}

function withClauseToString(withClause: AST.WithClause): string {
	let result = 'with';
	if (withClause.recursive) result += ' recursive';

	const ctes = withClause.ctes.map(cte => {
		let cteStr = quoteIdentifier(cte.name);
		if (cte.columns && cte.columns.length > 0) {
			cteStr += ` (${cte.columns.map(quoteIdentifier).join(', ')})`;
		}
		cteStr += ' as';
		const hint = materializationHintToKeyword(cte.materializationHint);
		if (hint) cteStr += ` ${hint}`;
		cteStr += ` (${astToString(cte.query)})`;
		return cteStr;
	});

	result += ` ${ctes.join(', ')}`;

	// Add OPTION clause if present
	if (withClause.options?.maxRecursion !== undefined) {
		result += ` option (maxrecursion ${withClause.options.maxRecursion})`;
	}

	return result;
}

function fromClauseToString(from: AST.FromClause): string {
	switch (from.type) {
		case 'table': {
			let tableStr = quoteIdentifier(from.table.name);
			if (from.table.schema) {
				tableStr = `${quoteIdentifier(from.table.schema)}.${tableStr}`;
			}
			if (from.alias) tableStr += ` as ${quoteIdentifier(from.alias)}`;
			return tableStr;
		}

		case 'subquerySource': {
			// QueryExpr body: SELECT / VALUES / INSERT|UPDATE|DELETE w/ RETURNING.
			// astToString dispatches on the inner discriminator.
			const subqueryStr = astToString(from.subquery);

			let aliasStr = `as ${quoteIdentifier(from.alias)}`;
			if (from.columns && from.columns.length > 0) {
				aliasStr += ` (${from.columns.map(quoteIdentifier).join(', ')})`;
			}

			return `(${subqueryStr}) ${aliasStr}`;
		}

		case 'functionSource': {
			const args = from.args.map(expressionToString).join(', ');
			// Check if from.name is a function expression or identifier expression
			let funcName: string;
			if (from.name.type === 'identifier') {
				funcName = quoteIdentifier(from.name.name.toLowerCase());
			} else if (from.name.type === 'function') {
				funcName = expressionToString(from.name);
			} else {
				funcName = expressionToString(from.name);
			}
			let funcStr = `${funcName}(${args})`;
			if (from.alias) funcStr += ` as ${quoteIdentifier(from.alias)}`;
			return funcStr;
		}

		case 'join': {
			const leftStr = fromClauseToString(from.left);
			const rightStr = fromClauseToString(from.right);
			// Preserve LATERAL so a correlated right side (e.g. a lateral TVF
			// `cross join lateral json_each(t.arr)`) round-trips — without it the
			// re-parsed body cannot resolve the correlation and fails to plan.
			const lateralStr = from.isLateral ? 'lateral ' : '';
			let joinStr = `${leftStr} ${from.joinType.toLowerCase()} join ${lateralStr}${rightStr}`;
			if (from.condition) {
				joinStr += ` on ${expressionToString(from.condition)}`;
			} else if (from.columns) {
				joinStr += ` using (${from.columns.map(quoteIdentifier).join(', ')})`;
			}
			// `exists <side> as <name>` existence columns after the ON/USING predicate.
			// The side is always emitted (the parser resolves the elided form) so the
			// clause round-trips structurally.
			if (from.existence && from.existence.length > 0) {
				joinStr += ' ' + from.existence
					.map(e => `exists ${e.side} as ${quoteIdentifier(e.name)}`)
					.join(', ');
			}
			return joinStr;
		}

		default:
			return '[unknown_from]';
	}
}

export function insertToString(stmt: AST.InsertStmt): string {
	const parts: string[] = [];

	if (stmt.withClause) {
		parts.push(withClauseToString(stmt.withClause));
	}

	parts.push('insert');
	if (stmt.onConflict && stmt.onConflict !== ConflictResolution.ABORT) {
		parts.push('or', ConflictResolution[stmt.onConflict].toLowerCase());
	}
	parts.push('into', expressionToString(stmt.table));

	if (stmt.columns && stmt.columns.length > 0) {
		parts.push(`(${stmt.columns.map(quoteIdentifier).join(', ')})`);
	}

	if (stmt.contextValues && stmt.contextValues.length > 0) {
		const contextAssignments = stmt.contextValues.map(assign =>
			`${quoteIdentifier(assign.name)} = ${expressionToString(assign.value)}`
		);
		parts.push('with context', contextAssignments.join(', '));
	}

	// Body is a QueryExpr — bare SELECT/VALUES at top-level of INSERT, or a
	// nested DML form (must carry RETURNING; outer INSERT is the consumer).
	// astToString dispatches on the discriminator.
	parts.push(astToString(stmt.source));

	// UPSERT clauses (ON CONFLICT DO ...)
	if (stmt.upsertClauses) {
		for (const upsert of stmt.upsertClauses) {
			parts.push(upsertClauseToString(upsert));
		}
	}

	if (stmt.tags) {
		const tagsClause = tagsClauseToString(stmt.tags).trimStart();
		if (tagsClause) parts.push(tagsClause);
	}

	// Trailing WITH SCHEMA (parseTrailingWithClauses accepts context/schema/tags
	// in any order). Emitted after WITH TAGS deliberately: an intervening trailing
	// clause stops a bare SELECT source from greedily consuming the schema path
	// onto itself on re-parse.
	if (stmt.schemaPath && stmt.schemaPath.length > 0) {
		parts.push(schemaPathClauseToString(stmt.schemaPath));
	}

	if (stmt.returning && stmt.returning.length > 0) {
		parts.push('returning', stmt.returning.map(resultColumnToString).join(', '));
	}

	return parts.join(' ');
}

/**
 * Convert an UPSERT clause to string.
 */
function upsertClauseToString(upsert: AST.UpsertClause): string {
	const parts: string[] = ['on conflict'];

	if (upsert.conflictTarget && upsert.conflictTarget.length > 0) {
		parts.push(`(${upsert.conflictTarget.map(quoteIdentifier).join(', ')})`);
	}

	if (upsert.action === 'nothing') {
		parts.push('do nothing');
	} else {
		parts.push('do update set');
		if (upsert.assignments) {
			const assigns = upsert.assignments.map(a =>
				`${quoteIdentifier(a.column)} = ${expressionToString(a.value)}`
			);
			parts.push(assigns.join(', '));
		}
		if (upsert.where) {
			parts.push('where', expressionToString(upsert.where));
		}
	}

	return parts.join(' ');
}

/**
 * Render an inline subquery DML write target: `(<body>) as <alias>[(cols)]`. Reuses the
 * FROM-subquery body+alias rendering so a nested DML/RETURNING body round-trips. The
 * alias is folded in here, so the caller must NOT also emit the standalone `as <alias>`
 * push (it would double-emit). Mirrors the `subquerySource` case of {@link fromClauseToString}.
 */
function subqueryTargetToString(target: AST.SubquerySource): string {
	let aliasStr = `as ${quoteIdentifier(target.alias)}`;
	if (target.columns && target.columns.length > 0) {
		aliasStr += ` (${target.columns.map(quoteIdentifier).join(', ')})`;
	}
	return `(${astToString(target.subquery)}) ${aliasStr}`;
}

export function updateToString(stmt: AST.UpdateStmt): string {
	const parts: string[] = [];

	if (stmt.withClause) {
		parts.push(withClauseToString(stmt.withClause));
	}

	if (stmt.targetSource) {
		// Inline subquery target: render `(body) as alias[(cols)]` in place of the named
		// target. The alias rides the targetSource rendering, so the standalone `as alias`
		// push below is skipped to avoid double-emitting it.
		parts.push('update', subqueryTargetToString(stmt.targetSource));
	} else {
		parts.push('update', expressionToString(stmt.table));
		// Synthesised internal correlation name (view-mutation single-source lowering) —
		// render it for plan/debug round-trip fidelity.
		if (stmt.alias) parts.push('as', quoteIdentifier(stmt.alias));
	}

	if (stmt.contextValues && stmt.contextValues.length > 0) {
		const contextAssignments = stmt.contextValues.map(assign =>
			`${quoteIdentifier(assign.name)} = ${expressionToString(assign.value)}`
		);
		parts.push('with context', contextAssignments.join(', '));
	}

	parts.push('set');

	const assignments = stmt.assignments.map(assign =>
		`${quoteIdentifier(assign.column)} = ${expressionToString(assign.value)}`
	);
	parts.push(assignments.join(', '));

	if (stmt.where) {
		parts.push('where', expressionToString(stmt.where));
	}

	if (stmt.tags) {
		const tagsClause = tagsClauseToString(stmt.tags).trimStart();
		if (tagsClause) parts.push(tagsClause);
	}

	// Trailing WITH SCHEMA (parseTrailingWithClauses accepts context/schema/tags in any order).
	if (stmt.schemaPath && stmt.schemaPath.length > 0) {
		parts.push(schemaPathClauseToString(stmt.schemaPath));
	}

	if (stmt.returning && stmt.returning.length > 0) {
		parts.push('returning', stmt.returning.map(resultColumnToString).join(', '));
	}

	return parts.join(' ');
}

export function deleteToString(stmt: AST.DeleteStmt): string {
	const parts: string[] = [];

	if (stmt.withClause) {
		parts.push(withClauseToString(stmt.withClause));
	}

	if (stmt.targetSource) {
		// Inline subquery target: render `(body) as alias[(cols)]` in place of the named
		// target. The alias rides the targetSource rendering, so the standalone `as alias`
		// push below is skipped to avoid double-emitting it.
		parts.push('delete from', subqueryTargetToString(stmt.targetSource));
	} else {
		parts.push('delete from', expressionToString(stmt.table));
		// Synthesised internal correlation name (view-mutation single-source lowering) —
		// render it for plan/debug round-trip fidelity.
		if (stmt.alias) parts.push('as', quoteIdentifier(stmt.alias));
	}

	if (stmt.contextValues && stmt.contextValues.length > 0) {
		const contextAssignments = stmt.contextValues.map(assign =>
			`${quoteIdentifier(assign.name)} = ${expressionToString(assign.value)}`
		);
		parts.push('with context', contextAssignments.join(', '));
	}

	if (stmt.where) {
		parts.push('where', expressionToString(stmt.where));
	}

	if (stmt.tags) {
		const tagsClause = tagsClauseToString(stmt.tags).trimStart();
		if (tagsClause) parts.push(tagsClause);
	}

	// Trailing WITH SCHEMA (parseTrailingWithClauses accepts context/schema/tags in any order).
	if (stmt.schemaPath && stmt.schemaPath.length > 0) {
		parts.push(schemaPathClauseToString(stmt.schemaPath));
	}

	if (stmt.returning && stmt.returning.length > 0) {
		parts.push('returning', stmt.returning.map(resultColumnToString).join(', '));
	}

	return parts.join(' ');
}

export function valuesToString(stmt: AST.ValuesStmt): string {
	const valueRows = stmt.values.map(row =>
		`(${row.map(expressionToString).join(', ')})`
	);
	return `values ${valueRows.join(', ')}`;
}

function indexedColumnsToString(cols: readonly AST.IndexedColumn[]): string {
	return cols.map(col => {
		if (col.name) {
			let colStr = quoteIdentifier(col.name);
			if (col.collation) colStr += ` collate ${quoteIdentifier(col.collation.toLowerCase())}`;
			if (col.direction === 'desc') colStr += ' desc';
			return colStr;
		} else if (col.expr) {
			// Collate-folded form (`col COLLATE x [desc]`): expressionToString renders
			// the column + collation, but the direction lives on col.direction and
			// must be re-appended (asc is the default and stays elided).
			let colStr = expressionToString(col.expr);
			if (col.direction === 'desc') colStr += ' desc';
			return colStr;
		}
		return '';
	}).filter(s => s).join(', ');
}

export function createIndexToString(stmt: AST.CreateIndexStmt): string {
	const parts: string[] = ['create'];
	if (stmt.isUnique) parts.push('unique');
	parts.push('index');
	if (stmt.ifNotExists) parts.push('if not exists');

	parts.push(expressionToString(stmt.index), 'on', expressionToString(stmt.table));
	parts.push(`(${indexedColumnsToString(stmt.columns)})`);

	if (stmt.where) {
		parts.push('where', expressionToString(stmt.where));
	}

	const indexTagStr = tagsClauseToString(stmt.tags);
	if (indexTagStr) parts.push(indexTagStr.trimStart());

	return parts.join(' ');
}

/**
 * The bare column name an indexed-column AST node refers to. A plain column
 * carries it on `col.name`; the parser folds `col COLLATE x` into a `collate`
 * expression over a column reference, so for that form the name lives on
 * `col.expr.expr.name`. Returns undefined for a genuine expression-index column
 * (no resolvable column name).
 *
 * Exported so the declarative differ can resolve a declared index column's
 * effective collation (it needs the bare name to look up the table column).
 */
export function indexedColumnBareName(col: AST.IndexedColumn): string | undefined {
	if (col.name) return col.name;
	if (col.expr?.type === 'collate' && col.expr.expr.type === 'column') return col.expr.expr.name;
	return undefined;
}

/**
 * The effective per-column collation to render in the canonical index body, or
 * undefined when none / `BINARY` (both elided; comparison is case-insensitive).
 *
 * Reads the resolved collation off the plain `IndexedColumn.collation`: the two
 * callers ({@link createIndexBodyToCanonicalString} via the differ's
 * `declaredIndexCanonicalBody`, and the actual catalog's `indexToCanonicalDDL`)
 * BOTH pre-resolve the effective collation onto that field (explicit index
 * COLLATE, else table-column collation, else BINARY; normalized), so rendering it
 * here makes an unchanged inherited/BINARY collation render identically on both
 * diff sides while a genuine collation change diverges. The defensive fallback
 * reads the parser's collate-folded form (`col.expr.collation`) so a future raw
 * caller that skips the pre-resolve step does not silently drop the collation.
 */
function canonicalIndexColumnCollation(col: AST.IndexedColumn): string | undefined {
	const c = col.collation ?? (col.expr?.type === 'collate' ? col.expr.collation : undefined);
	if (!c || c.toUpperCase() === 'BINARY') return undefined;
	return c;
}

/**
 * Canonical renderer for an index's column list, used only by
 * {@link createIndexBodyToCanonicalString} for body-drift comparison — NOT a
 * persistence path (see {@link indexedColumnsToString} for the persistence form).
 * For each column emit the bare column name, then an effective `collate <c>` (only
 * when non-BINARY), then ` desc` when descending — the same name/collate/desc order
 * the persistence renderer uses. The bare name is extracted from both indexed-column
 * forms (plain `col.name` and the parser's collate-folded form — see
 * {@link indexedColumnBareName}); a genuine expression-index column with no
 * resolvable name falls back to `expressionToString(col.expr)` (such indexes are
 * rejected on import and never name-match a real actual).
 *
 * The bare name is lowercased before `quoteIdentifier` so the comparison key is
 * case-insensitive — matching Quereus's uniformly case-folding column resolution
 * (the AST never records identifier quoting; every resolver folds via
 * `.toLowerCase()`). The actual side lifts the column *definition* case while the
 * declared side carries the as-written index reference case; folding both makes a
 * case-only divergence (e.g. column `Email` indexed as `email`) render identically
 * instead of churning a spurious drop+recreate.
 *
 * Collation is rendered from the pre-resolved effective value
 * ({@link canonicalIndexColumnCollation}): both diff sides resolve the column's
 * collation the same way the engine does at create/import time, so an inherited or
 * default-BINARY collation that is unchanged renders identically (no churn) while a
 * genuine per-column collation change renders differently (drop+recreate).
 */
function canonicalIndexedColumnsToString(cols: readonly AST.IndexedColumn[]): string {
	return cols.map(col => {
		const name = indexedColumnBareName(col);
		if (name) {
			let colStr = quoteIdentifier(name.toLowerCase());
			const collation = canonicalIndexColumnCollation(col);
			if (collation) colStr += ` collate ${quoteIdentifier(collation.toLowerCase())}`;
			if (col.direction === 'desc') colStr += ' desc';
			return colStr;
		}
		return col.expr ? expressionToString(col.expr) : '';
	}).filter(s => s).join(', ');
}

/**
 * Renders the **canonical body** of an index — the comparison key the declarative
 * differ uses to detect a name-matched index whose body changed (UNIQUE-ness,
 * column set/order/direction, or partial WHERE predicate). Two semantically-equal
 * indexes must render identically here or a spurious drop+recreate churns; two
 * different ones must render differently or a real change silently no-ops.
 *
 * Excludes the index `name`, the `on <table>` reference, `if not exists`, AND the
 * `with tags (...)` suffix (tags are a separate diff channel — `ALTER INDEX … SET
 * TAGS`). Per-column collation IS included, but only as an already-resolved
 * effective value: both sides pre-resolve each column's effective collation the
 * way the engine does at create/import time (explicit index COLLATE, else the
 * table column's collation, else BINARY; normalized) before calling this renderer
 * — the actual side in `ddl-generator`'s `indexToCanonicalDDL`, the declared side
 * in `schema-differ`'s `declaredIndexCanonicalBody`. An unchanged inherited or
 * default-BINARY collation therefore renders identically (no churn) while a genuine
 * collation change renders differently (drop+recreate). Both sides funnel through
 * here so their fragments are byte-comparable.
 *
 * The partial-index WHERE predicate's bare column references are case-folded
 * ({@link lowerExprIdentifiers}) so a reference whose case diverges between schema
 * versions (the stored predicate keeps the as-written case; a re-declare may differ)
 * renders identically on both sides — literals are preserved byte-exact.
 */
export function createIndexBodyToCanonicalString(stmt: AST.CreateIndexStmt): string {
	const parts: string[] = [];
	if (stmt.isUnique) parts.push('unique');
	parts.push('index');
	parts.push(`(${canonicalIndexedColumnsToString(stmt.columns)})`);
	if (stmt.where) parts.push('where', expressionToString(lowerExprIdentifiers(stmt.where)));
	return parts.join(' ');
}

/**
 * Renders the **canonical definition** of a view or materialized view — the
 * comparison key the declarative differ uses to detect a name-matched view whose
 * definition changed. Covers the two definitional parts: the explicit column
 * list (`v(a, b)` — for an MV it also names the backing-table columns) and the
 * body (`astToString` of the QueryExpr). The body string already carries any
 * trailing `with defaults (col = expr, …)` clause (write-through behavior) via
 * `selectToString`, so a defaults-only edit drifts this string automatically.
 * Excludes the view name / schema / `if not exists` / tags — tags are a separate
 * diff channel (`ALTER VIEW … SET TAGS`), mirroring `CatalogIndex.definition`.
 *
 * Both diff sides funnel through here (the actual side from the live
 * `ViewSchema` / `TableDerivation` fields, the declared side from the
 * `CreateViewStmt` / `CreateMaterializedViewStmt` fields), and both ASTs come
 * from the same parser and render through this same emitter, so keyword case /
 * whitespace cannot churn. Deliberately NO identifier case-folding — unlike the
 * constraint / index canonical bodies (whose recreates re-validate or rebuild,
 * so they fold to avoid expensive churn), a case-only edit here recreates a
 * plain view (free — data-less) or rebuilds an MV (pre-existing behavior of the
 * select-only hash). See docs/schema-rename-detection.md § View /
 * materialized-view definition-change detection.
 */
export function viewDefinitionToCanonicalString(
	columns: ReadonlyArray<string> | undefined,
	select: AST.QueryExpr,
): string {
	const parts: string[] = [];
	if (columns && columns.length > 0) {
		parts.push(`(${columns.map(quoteIdentifier).join(', ')})`);
	}
	parts.push(astToString(select));
	return parts.join(' ');
}

export function createViewToString(stmt: AST.CreateViewStmt): string {
	const parts: string[] = ['create'];
	parts.push('view');
	if (stmt.ifNotExists) parts.push('if not exists');

	parts.push(expressionToString(stmt.view));

	if (stmt.columns && stmt.columns.length > 0) {
		parts.push(`(${stmt.columns.map(quoteIdentifier).join(', ')})`);
	}

	// View body is a QueryExpr — astToString dispatches on the discriminator.
	// A trailing `with defaults (…)` rides inside the body string (selectToString).
	parts.push('as', astToString(stmt.select));

	const viewTagStr = tagsClauseToString(stmt.tags);
	if (viewTagStr) parts.push(viewTagStr.trimStart());

	return parts.join(' ');
}

export function createMaterializedViewToString(stmt: AST.CreateMaterializedViewStmt): string {
	const parts: string[] = ['create'];
	parts.push('materialized', 'view');
	if (stmt.ifNotExists) parts.push('if not exists');

	parts.push(expressionToString(stmt.view));

	if (stmt.columns && stmt.columns.length > 0) {
		parts.push(`(${stmt.columns.map(quoteIdentifier).join(', ')})`);
	}

	const usingClause = mvModuleClauseToString(stmt);
	if (usingClause) parts.push(usingClause);

	// A trailing `with defaults (…)` rides inside the body string (selectToString).
	parts.push('as', astToString(stmt.select));

	const viewTagStr = tagsClauseToString(stmt.tags);
	if (viewTagStr) parts.push(viewTagStr.trimStart());

	return parts.join(' ');
}

/** `using <module>(args)` clause for a materialized view, or '' when absent. */
function mvModuleClauseToString(stmt: AST.CreateMaterializedViewStmt): string {
	if (!stmt.moduleName) return '';
	let s = `using ${quoteIdentifier(stmt.moduleName)}`;
	if (stmt.moduleArgs && Object.keys(stmt.moduleArgs).length > 0) {
		const args = Object.entries(stmt.moduleArgs).map(([k, v]) =>
			`${quoteIdentifier(k)} = ${JSON.stringify(v)}`
		);
		s += ` (${args.join(', ')})`;
	}
	return s;
}

export function refreshMaterializedViewToString(stmt: AST.RefreshMaterializedViewStmt): string {
	return `refresh materialized view ${expressionToString(stmt.name)}`;
}

export function createAssertionToString(stmt: AST.CreateAssertionStmt): string {
	return `create assertion ${expressionToString(stmt.name)} check (${expressionToString(stmt.check)})`;
}

function alterTableToString(stmt: AST.AlterTableStmt): string {
	const table = expressionToString(stmt.table);
	switch (stmt.action.type) {
		case 'renameTable':
			return `alter table ${table} rename to ${quoteIdentifier(stmt.action.newName)}`;
		case 'renameColumn':
			return `alter table ${table} rename column ${quoteIdentifier(stmt.action.oldName)} to ${quoteIdentifier(stmt.action.newName)}`;
		case 'addColumn':
			return `alter table ${table} add column ${columnDefToString(stmt.action.column)}`;
		case 'dropColumn':
			return `alter table ${table} drop column ${quoteIdentifier(stmt.action.name)}`;
		case 'addConstraint':
			return `alter table ${table} add ${tableConstraintsToString([stmt.action.constraint])}`;
		case 'dropConstraint':
			return `alter table ${table} drop constraint ${quoteIdentifier(stmt.action.name)}`;
		case 'renameConstraint':
			return `alter table ${table} rename constraint ${quoteIdentifier(stmt.action.oldName)} to ${quoteIdentifier(stmt.action.newName)}`;
		case 'alterPrimaryKey': {
			const cols = stmt.action.columns
				.map(c => {
					let s = quoteIdentifier(c.name);
					if (c.direction === 'desc') s += ' desc';
					return s;
				})
				.join(', ');
			return `alter table ${table} alter primary key (${cols})`;
		}
		case 'alterColumn': {
			const colName = quoteIdentifier(stmt.action.columnName);
			const a = stmt.action;
			if (a.setDataType !== undefined) {
				return `alter table ${table} alter column ${colName} set data type ${a.setDataType}`;
			}
			if (a.setDefault !== undefined) {
				return a.setDefault === null
					? `alter table ${table} alter column ${colName} drop default`
					: `alter table ${table} alter column ${colName} set default ${expressionToString(a.setDefault)}`;
			}
			if (a.setCollation !== undefined) {
				return `alter table ${table} alter column ${colName} set collate ${a.setCollation}`;
			}
			if (a.setNotNull !== undefined) {
				return a.setNotNull
					? `alter table ${table} alter column ${colName} set not null`
					: `alter table ${table} alter column ${colName} drop not null`;
			}
			return `alter table ${table} alter column ${colName}`;
		}
		case 'setTags': {
			const a = stmt.action;
			const body = tagsBodyToString(a.tags);
			const verb = a.mode === 'merge' ? 'add tags' : 'set tags';
			if (a.target.kind === 'column') {
				return `alter table ${table} alter column ${quoteIdentifier(a.target.columnName)} ${verb} ${body}`;
			}
			if (a.target.kind === 'constraint') {
				return `alter table ${table} alter constraint ${quoteIdentifier(a.target.constraintName)} ${verb} ${body}`;
			}
			return `alter table ${table} ${verb} ${body}`;
		}
		case 'dropTags': {
			const a = stmt.action;
			const body = tagKeysBodyToString(a.keys);
			if (a.target.kind === 'column') {
				return `alter table ${table} alter column ${quoteIdentifier(a.target.columnName)} drop tags ${body}`;
			}
			if (a.target.kind === 'constraint') {
				return `alter table ${table} alter constraint ${quoteIdentifier(a.target.constraintName)} drop tags ${body}`;
			}
			return `alter table ${table} drop tags ${body}`;
		}
		case 'setMaintained': {
			// `(cols)` rename list is emitted only when present (an explicit MV-sugar
			// rename — the differ's lossless encoding); its absence is the implicit
			// signal. Byte-identical to the bare `set maintained as` form otherwise.
			const cols = stmt.action.columns?.length
				? ` (${stmt.action.columns.map(quoteIdentifier).join(', ')})`
				: '';
			// A trailing `with defaults (…)` rides inside the body string (selectToString).
			return `alter table ${table} set maintained${cols} as ${astToString(stmt.action.select)}`;
		}
		case 'dropMaintained':
			return `alter table ${table} drop maintained`;
	}
}

/**
 * Renders the trailing `{set|add|drop} tags (...)` clause shared by ALTER VIEW /
 * MATERIALIZED VIEW / INDEX: `setTags` is `add tags` when `mode === 'merge'` else
 * `set tags` (body via `tagsBodyToString`); `dropTags` is `drop tags` (body via
 * `tagKeysBodyToString`).
 */
function objectTagsActionToString(action: AST.AlterObjectTagsAction): string {
	if (action.type === 'dropTags') {
		return `drop tags ${tagKeysBodyToString(action.keys)}`;
	}
	const verb = action.mode === 'merge' ? 'add tags' : 'set tags';
	return `${verb} ${tagsBodyToString(action.tags)}`;
}

function alterViewToString(stmt: AST.AlterViewStmt): string {
	return `alter view ${expressionToString(stmt.name)} ${objectTagsActionToString(stmt.action)}`;
}

function alterMaterializedViewToString(stmt: AST.AlterMaterializedViewStmt): string {
	return `alter materialized view ${expressionToString(stmt.name)} ${objectTagsActionToString(stmt.action)}`;
}

export function alterIndexToString(stmt: AST.AlterIndexStmt): string {
	return `alter index ${expressionToString(stmt.name)} ${objectTagsActionToString(stmt.action)}`;
}

function analyzeToString(stmt: AST.AnalyzeStmt): string {
	if (stmt.schemaName && stmt.tableName) return `analyze ${quoteIdentifier(stmt.schemaName)}.${quoteIdentifier(stmt.tableName)}`;
	if (stmt.tableName) return `analyze ${quoteIdentifier(stmt.tableName)}`;
	if (stmt.schemaName) return `analyze ${quoteIdentifier(stmt.schemaName)}.*`;
	return 'analyze';
}

function dropToString(stmt: AST.DropStmt): string {
	const objectKeyword = stmt.objectType === 'materializedView' ? 'materialized view' : stmt.objectType.toLowerCase();
	const parts: string[] = ['drop', objectKeyword];
	if (stmt.ifExists) parts.push('if exists');
	parts.push(expressionToString(stmt.name));
	return parts.join(' ');
}

function beginToString(_stmt: AST.BeginStmt): string {
	return 'begin transaction';
}

function rollbackToString(stmt: AST.RollbackStmt): string {
	let result = 'rollback';
	if (stmt.savepoint) {
		result += ` to ${quoteIdentifier(stmt.savepoint)}`;
	}
	return result;
}

function savepointToString(stmt: AST.SavepointStmt): string {
	return `savepoint ${quoteIdentifier(stmt.name)}`;
}

function releaseToString(stmt: AST.ReleaseStmt): string {
	let result = 'release';
	if (stmt.savepoint) {
		result += ` ${quoteIdentifier(stmt.savepoint)}`;
	}
	return result;
}

function pragmaToString(stmt: AST.PragmaStmt): string {
	let result = `pragma ${quoteIdentifier(stmt.name.toLowerCase())}`;
	if (stmt.value) {
		result += ` = ${expressionToString(stmt.value)}`;
	}
	return result;
}

function declareSchemaToString(stmt: AST.DeclareSchemaStmt): string {
	let s = `declare ${stmt.isLogical ? 'logical ' : ''}schema ${quoteIdentifier(stmt.schemaName || 'main')}`;
	if (stmt.version) s += ` version '${stmt.version}'`;
	if (stmt.using && (stmt.using.defaultVtabModule || stmt.using.defaultVtabArgs)) {
		const opts: string[] = [];
		if (stmt.using.defaultVtabModule) opts.push(`default_vtab_module = '${stmt.using.defaultVtabModule}'`);
		if (stmt.using.defaultVtabArgs) opts.push(`default_vtab_args = '${stmt.using.defaultVtabArgs}'`);
		s += ` using (${opts.join(', ')})`;
	}
	s += ' {';
	for (const it of stmt.items) {
		s += ' ' + declareItemToString(it) + ';';
	}
	s += ' }';
	return s;
}

function declareLensToString(stmt: AST.DeclareLensStmt): string {
	let s = `declare lens for ${quoteIdentifier(stmt.logicalSchema)} over ${quoteIdentifier(stmt.basisSchema)} {`;
	for (const ov of stmt.overrides) {
		s += ` view ${quoteIdentifier(ov.table)} as ${selectToString(ov.select)}`;
		s += ';';
	}
	s += ' }';
	return s;
}

function declareItemToString(it: AST.DeclareItem): string {
	switch (it.type) {
		case 'declaredTable': return declaredTableToString(it);
		case 'declaredIndex': return declaredIndexToString(it);
		case 'declaredView': return declaredViewToString(it);
		case 'declaredMaterializedView': return declaredMaterializedViewToString(it);
		case 'declaredSeed': return declaredSeedToString(it);
		case 'declaredAssertion': return declaredAssertionToString(it);
		case 'declareIgnored': return it.text || '-- ignored';
	}
}

function declaredTableToString(it: AST.DeclaredTable): string {
	const stmt = it.tableStmt;
	const parts: string[] = ['table', quoteIdentifier(stmt.table.name)];

	const using = moduleClauseToString(stmt);
	if (using) parts.push(using);

	parts.push(tableBodyDefsToString(stmt));

	const ctx = contextClauseToString(stmt);
	if (ctx) parts.push(ctx);

	const tagStr = tagsClauseToString(stmt.tags);
	if (tagStr) parts.push(tagStr.trimStart());

	return parts.join(' ');
}

function declaredIndexToString(it: AST.DeclaredIndex): string {
	const stmt = it.indexStmt;
	const parts: string[] = [];
	if (stmt.isUnique) parts.push('unique');
	parts.push('index', quoteIdentifier(stmt.index.name));
	parts.push('on', quoteIdentifier(stmt.table.name));
	parts.push(`(${indexedColumnsToString(stmt.columns)})`);

	const tagStr = tagsClauseToString(stmt.tags);
	if (tagStr) parts.push(tagStr.trimStart());

	return parts.join(' ');
}

function declaredViewToString(it: AST.DeclaredView): string {
	const stmt = it.viewStmt;
	const parts: string[] = ['view', quoteIdentifier(stmt.view.name)];
	if (stmt.columns && stmt.columns.length > 0) {
		parts.push(`(${stmt.columns.map(quoteIdentifier).join(', ')})`);
	}
	// View body is a QueryExpr — astToString dispatches on the discriminator.
	// A trailing `with defaults (…)` rides inside the body string (selectToString).
	parts.push('as', astToString(stmt.select));

	const tagStr = tagsClauseToString(stmt.tags);
	if (tagStr) parts.push(tagStr.trimStart());

	return parts.join(' ');
}

function declaredMaterializedViewToString(it: AST.DeclaredMaterializedView): string {
	const stmt = it.viewStmt;
	const parts: string[] = ['materialized', 'view', quoteIdentifier(stmt.view.name)];
	if (stmt.columns && stmt.columns.length > 0) {
		parts.push(`(${stmt.columns.map(quoteIdentifier).join(', ')})`);
	}

	const usingClause = mvModuleClauseToString(stmt);
	if (usingClause) parts.push(usingClause);

	// A trailing `with defaults (…)` rides inside the body string (selectToString).
	parts.push('as', astToString(stmt.select));

	const tagStr = tagsClauseToString(stmt.tags);
	if (tagStr) parts.push(tagStr.trimStart());

	return parts.join(' ');
}

function declaredSeedToString(it: AST.DeclaredSeed): string {
	let s = `seed ${quoteIdentifier(it.tableName)}`;
	if (it.columns && it.columns.length > 0) {
		s += ` values (${it.columns.map(quoteIdentifier).join(', ')}) values`;
	}
	const rows = it.seedData?.map(r =>
		`(${r.map(sqlValueToSqlLiteral).join(', ')})`
	).join(', ') ?? '';
	s += ` (${rows})`;
	return s;
}

function declaredAssertionToString(it: AST.DeclaredAssertion): string {
	return `assertion ${expressionToString(it.assertionStmt.name)} check (${expressionToString(it.assertionStmt.check)})`;
}

/** Renders an SqlValue as a SQL literal that re-parses to the same value. */
function sqlValueToSqlLiteral(value: SqlValue): string {
	if (value === null) return 'null';
	if (typeof value === 'boolean') return value ? 'true' : 'false';
	if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
	if (typeof value === 'number') return String(value);
	if (typeof value === 'bigint') return value.toString();
	if (value instanceof Uint8Array) return `x'${uint8ArrayToHex(value)}'`;
	// JSON object/array — emit as a quoted JSON string (parser will see a STRING literal)
	if (typeof value === 'object') {
		const json = JSON.stringify(value);
		return `'${json.replace(/'/g, "''")}'`;
	}
	return String(value);
}

// Helper to stringify conflict clauses
function conflictToString(res: ConflictResolution | undefined): string {
	// ABORT is the default, so don't emit it
	if (!res || res === ConflictResolution.ABORT) return '';
	// Assuming ConflictResolution enum values are uppercase, convert them to lowercase
	return ` on conflict ${ConflictResolution[res].toLowerCase()}`;
}

// Helper to stringify column constraints
function columnConstraintsToString(constraints: AST.ColumnConstraint[]): string {
	return constraints.map(c => {
		let s = '';
		if (c.name) s += `constraint ${quoteIdentifier(c.name)} `;
		switch (c.type) {
			case 'primaryKey':
				s += 'primary key';
				// ASC is default, only specify DESC
				if (c.direction === 'desc') s += ` desc`;
				s += conflictToString(c.onConflict);
				break;
			case 'notNull':
				s += 'not null';
				s += conflictToString(c.onConflict);
				break;
			case 'null':
				s += 'null';
				s += conflictToString(c.onConflict);
				break;
			case 'unique':
				s += 'unique';
				s += conflictToString(c.onConflict);
				break;
			case 'check':
				s += 'check';
				if (c.operations && c.operations.length > 0) {
					s += ` on ${c.operations.join(', ')}`;
				}
				s += ` (${expressionToString(c.expr!)})`;
				s += conflictToString(c.onConflict);
				break;
			case 'default':
				s += `default ${expressionToString(c.expr!)}`;
				break;
			case 'collate':
				s += `collate ${quoteIdentifier(c.collation!.toLowerCase())}`;
				break;
			case 'foreignKey':
				if (c.foreignKey) {
					s += foreignKeyClauseTail(c.foreignKey);
				}
				break;
			case 'generated':
				s += `generated always as (${expressionToString(c.generated!.expr)})`;
				// VIRTUAL is default, only specify STORED
				if (c.generated!.stored) s += ' stored';
				break;
		}
		s += tagsClauseToString(c.tags);
		return s;
	}).filter(s => s.length > 0).join(' ');
}

// Helper to stringify table constraints
export function tableConstraintsToString(constraints: AST.TableConstraint[]): string {
	return constraints.map(c => {
		let s = '';
		if (c.name) s += `constraint ${quoteIdentifier(c.name)} `;
		switch (c.type) {
			case 'primaryKey':
				// ASC is default, only specify DESC
				s += `primary key (${c.columns!.map(col => `${quoteIdentifier(col.name)}${col.direction === 'desc' ? ' desc' : ''}`).join(', ')})`;
				s += conflictToString(c.onConflict);
				break;
			case 'unique':
				s += `unique (${c.columns!.map(col => quoteIdentifier(col.name)).join(', ')})`;
				s += conflictToString(c.onConflict);
				break;
			case 'check':
				s += 'check';
				if (c.operations && c.operations.length > 0) {
					s += ` on ${c.operations.join(', ')}`;
				}
				s += ` (${expressionToString(c.expr!)})`;
				s += conflictToString(c.onConflict);
				break;
			case 'foreignKey':
				if (c.foreignKey) {
					s += `foreign key (${c.columns!.map(col => quoteIdentifier(col.name)).join(', ')}) `;
					s += foreignKeyClauseTail(c.foreignKey);
				}
				break;
		}
		s += tagsClauseToString(c.tags);
		return s;
	}).filter(s => s.length > 0).join(', ');
}

/** Canonical insert→update→delete ordering for a CHECK `on` operation list. */
const ROWOP_CANONICAL_ORDER: readonly RowOp[] = ['insert', 'update', 'delete'];

/**
 * Normalizes a CHECK constraint's `on` operation list to its canonical form for
 * body comparison: the bare-CHECK default (INSERT + UPDATE) renders identically
 * whether written as `check (...)` (parser leaves `operations` undefined) or
 * `check on insert, update (...)`, so the default collapses to `undefined` (no
 * `on` clause). Any other mask emits in fixed insert→update→delete order.
 */
function canonicalCheckOperations(ops: RowOp[] | undefined): RowOp[] | undefined {
	const set = new Set<RowOp>(ops && ops.length > 0 ? ops : ['insert', 'update']);
	if (set.size === 2 && set.has('insert') && set.has('update')) return undefined;
	return ROWOP_CANONICAL_ORDER.filter(op => set.has(op));
}

/**
 * Normalizes a foreign-key clause for body comparison: the referenced (parent)
 * TABLE name is case-folded (the catalog stores it as-written — see
 * `constraint-builder`'s `referencedTable: fk.table` — so a parent-name case change
 * between versions would otherwise churn a spurious drop+add); the default `restrict`
 * action on DELETE / UPDATE renders the same whether written explicitly or
 * omitted, so it collapses to `undefined` (no `on delete/update` clause); an
 * empty referenced-column list collapses to `undefined` (bare `references t`);
 * and the deferrable clause is dropped entirely (it is not a body-change
 * channel the declarative differ tracks). `quoteIdentifier` still runs after the
 * lowercase at render, so a reserved-word parent name re-quotes correctly on both
 * sides. (The referenced COLUMN list is folded upstream by
 * {@link lowercaseTableConstraintColumnNames}.)
 */
function canonicalForeignKeyClause(fk: AST.ForeignKeyClause, childSchemaName?: string): AST.ForeignKeyClause {
	return {
		table: fk.table.toLowerCase(),
		// The parent-schema qualifier is canonical iff it differs (case-insensitively)
		// from the CHILD table's schema: a genuine cross-schema FK keeps its qualifier,
		// but an explicit own-schema qualifier elides to `undefined` so `references main.t`
		// declared on a child IN `main` canonicalizes equal to the bare `references t`
		// (and to the actual-catalog side, which already elides a parent == child schema).
		// `childSchemaName` is absent for non-FK contexts / callers without a child schema;
		// then any present qualifier is kept (case-folded) — a cross-schema FK and a
		// same-schema FK to a like-named parent still don't collapse to one canonical key.
		schema: fk.schema && fk.schema.toLowerCase() !== childSchemaName?.toLowerCase()
			? fk.schema.toLowerCase()
			: undefined,
		columns: fk.columns && fk.columns.length > 0 ? fk.columns : undefined,
		onDelete: fk.onDelete && fk.onDelete !== 'restrict' ? fk.onDelete : undefined,
		onUpdate: fk.onUpdate && fk.onUpdate !== 'restrict' ? fk.onUpdate : undefined,
	};
}

/**
 * Returns a clone of a table constraint with every bare column-name identifier in
 * its column list(s) lowercased — the canonical-body normalization that makes the
 * comparison key case-insensitive, matching Quereus's uniformly case-folding column
 * resolution (the AST never records identifier quoting, and every resolver folds via
 * `.toLowerCase()`). Applied ONLY by {@link constraintBodyToCanonicalString} (the
 * canonical-comparison entry point); the persistence renderer
 * {@link tableConstraintsToString} keeps the original case so a stored CREATE TABLE
 * round-trips its declared casing.
 *
 * Covers the UNIQUE / PRIMARY KEY column list, the FK local (child) column list, the
 * FK referenced (parent) column list, AND the bare column references embedded in a
 * CHECK expression — the last via {@link lowerExprIdentifiers} (a structural clone),
 * since CHECK carries no column list and its refs live in the expression.
 *
 * MUST NOT mutate the input: the declared side passes `DeclaredNamedConstraint.bodyAst`,
 * which backs the differ's `ddl` / `definition` — so the column arrays (and the CHECK
 * expression tree) are cloned before rewriting. `quoteIdentifier` still runs *after*
 * the lowercase, so a reserved-word column name (`Order` → `order`) re-quotes to
 * `"order"` on both sides (keyword detection is already case-insensitive).
 */
function lowercaseTableConstraintColumnNames(tc: AST.TableConstraint): AST.TableConstraint {
	switch (tc.type) {
		case 'primaryKey':
		case 'unique':
			return tc.columns
				? { ...tc, columns: tc.columns.map(c => ({ ...c, name: c.name.toLowerCase() })) }
				: tc;
		case 'foreignKey':
			return {
				...tc,
				columns: tc.columns?.map(c => ({ ...c, name: c.name.toLowerCase() })),
				foreignKey: tc.foreignKey
					? { ...tc.foreignKey, columns: tc.foreignKey.columns?.map(n => n.toLowerCase()) }
					: tc.foreignKey,
			};
		case 'check':
			// No column list — bare column refs live in the expression; fold them via a
			// structural clone. String / blob / numeric / JSON literals, parameters,
			// collation and cast/function names pass through byte-exact (see lowerExprIdentifiers).
			return tc.expr ? { ...tc, expr: lowerExprIdentifiers(tc.expr) } : tc;
	}
}

/**
 * Renders the **canonical body fragment** of a named table constraint — the
 * comparison key the declarative differ uses to detect a constraint whose name
 * is unchanged but whose body changed (an edited CHECK expression, a changed FK
 * action / referenced table / columns, a changed UNIQUE column set / conflict
 * action). Two semantically-equal constraints must render identically here or a
 * spurious drop+recreate churns; two semantically-different ones must render
 * differently or a real change silently no-ops.
 *
 * Excludes the `constraint <name>` prefix (constraints are matched by name first,
 * and a rename must not block body comparison) AND the `with tags (...)` suffix
 * (tags are a separate diff channel — `ALTER CONSTRAINT … SET TAGS`, so a
 * tag-only change must NOT masquerade as a body change). Bare column-name
 * identifiers are case-folded ({@link lowercaseTableConstraintColumnNames}) BEFORE
 * the default-form normalization so `canonicalForeignKeyClause` reads the already-
 * lowercased referenced columns. Parser-default-equivalent forms are normalized
 * (see {@link canonicalCheckOperations}, {@link canonicalForeignKeyClause}). The fold
 * reaches every identifier channel: the UNIQUE / PK / FK column lists (here, via
 * {@link lowercaseTableConstraintColumnNames}), the bare column refs inside a CHECK
 * expression (also via {@link lowercaseTableConstraintColumnNames} → {@link lowerExprIdentifiers}),
 * and the FK referenced (parent) table name (via {@link canonicalForeignKeyClause}). Both
 * the declared-AST side (`schema-differ`) and the actual-catalog side
 * (`ddl-generator`'s `constraintToCanonicalDDL`) funnel through here so their
 * fragments are byte-comparable.
 *
 * `childSchemaName` (the schema of the table OWNING this constraint) makes the FK
 * parent-schema qualifier symmetric between the two sides: an explicit qualifier
 * equal to the child schema elides to nothing (see {@link canonicalForeignKeyClause}),
 * so a declared `references main.t` on a child in `main` and the actual catalog's
 * elided form canonicalize identically (no spurious churn), while a genuine
 * cross-schema parent survives as a body-change channel. It is optional so non-FK
 * callers (CHECK / UNIQUE — no schema channel) are unaffected.
 */
export function constraintBodyToCanonicalString(tc: AST.TableConstraint, childSchemaName?: string): string {
	const normalized: AST.TableConstraint = lowercaseTableConstraintColumnNames({ ...tc, name: undefined, tags: undefined });
	if (normalized.type === 'check') {
		normalized.operations = canonicalCheckOperations(normalized.operations);
	}
	if (normalized.type === 'foreignKey' && normalized.foreignKey) {
		normalized.foreignKey = canonicalForeignKeyClause(normalized.foreignKey, childSchemaName);
	}
	return tableConstraintsToString([normalized]);
}

function foreignKeyActionToString(action: AST.ForeignKeyAction): string {
	switch (action) {
		case 'setNull': return 'set null';
		case 'setDefault': return 'set default';
		case 'cascade': return 'cascade';
		case 'restrict': return 'restrict';
	}
}

/** Emits `references [SCHEMA.]TBL(cols) [on delete …] [on update …] [[not] deferrable [initially …]]`. */
function foreignKeyClauseTail(fk: AST.ForeignKeyClause): string {
	const qualified = fk.schema ? `${quoteIdentifier(fk.schema)}.${quoteIdentifier(fk.table)}` : quoteIdentifier(fk.table);
	let s = `references ${qualified}`;
	if (fk.columns && fk.columns.length > 0) {
		s += `(${fk.columns.map(quoteIdentifier).join(', ')})`;
	}
	if (fk.onDelete) s += ` on delete ${foreignKeyActionToString(fk.onDelete)}`;
	if (fk.onUpdate) s += ` on update ${foreignKeyActionToString(fk.onUpdate)}`;
	if (fk.deferrable !== undefined) {
		s += fk.deferrable ? ' deferrable' : ' not deferrable';
		if (fk.initiallyDeferred !== undefined) {
			s += fk.initiallyDeferred ? ' initially deferred' : ' initially immediate';
		}
	}
	return s;
}

/** Formats a tag value as a SQL literal */
function tagValueToString(value: SqlValue): string {
	if (value === null) return 'null';
	if (typeof value === 'boolean') return value ? 'true' : 'false';
	if (typeof value === 'number') return String(value);
	if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
	return String(value);
}

/** Formats a tags record as a WITH TAGS (...) clause */
/**
 * Renders the inner `(k = v, …)` body of a tag list. Shared by the `WITH TAGS`
 * clause and the `ALTER TABLE … SET TAGS` forms. An empty list renders `()`
 * (the explicit clear-all form for SET TAGS).
 */
export function tagsBodyToString(tags: Record<string, SqlValue> | undefined): string {
	const entries = Object.entries(tags ?? {})
		.map(([key, value]) => `${quoteIdentifier(key)} = ${tagValueToString(value)}`)
		.join(', ');
	return `(${entries})`;
}

/**
 * Renders the inner `(k[, …])` body of a bare tag-key list for the
 * `ALTER TABLE … DROP TAGS` form. An empty list renders `()` (a no-op drop).
 */
export function tagKeysBodyToString(keys: readonly string[]): string {
	return `(${keys.map(quoteIdentifier).join(', ')})`;
}

function tagsClauseToString(tags: Record<string, SqlValue> | undefined): string {
	if (!tags || Object.keys(tags).length === 0) return '';
	return ` with tags ${tagsBodyToString(tags)}`;
}

export function columnDefToString(col: AST.ColumnDef): string {
	let colDef = quoteIdentifier(col.name);
	if (col.dataType) colDef += ` ${col.dataType}`;
	const constraints = columnConstraintsToString(col.constraints);
	if (constraints) colDef += ` ${constraints}`;
	colDef += tagsClauseToString(col.tags);
	return colDef;
}

function tableBodyDefsToString(stmt: AST.CreateTableStmt): string {
	const definitions: string[] = stmt.columns.map(columnDefToString);
	const tableConstraints = tableConstraintsToString(stmt.constraints);
	if (tableConstraints) definitions.push(tableConstraints);
	return `(${definitions.join(', ')})`;
}

function moduleClauseToString(stmt: AST.CreateTableStmt): string {
	if (!stmt.moduleName) return '';
	let s = `using ${quoteIdentifier(stmt.moduleName)}`;
	if (stmt.moduleArgs && Object.keys(stmt.moduleArgs).length > 0) {
		const args = Object.entries(stmt.moduleArgs).map(([key, value]) =>
			`${quoteIdentifier(key)} = ${JSON.stringify(value)}`
		).join(', ');
		s += ` (${args})`;
	}
	return s;
}

function contextClauseToString(stmt: AST.CreateTableStmt): string {
	if (!stmt.contextDefinitions || stmt.contextDefinitions.length === 0) return '';
	const contextVars = stmt.contextDefinitions.map(varDef => {
		let def = quoteIdentifier(varDef.name);
		if (varDef.dataType) def += ` ${varDef.dataType}`;
		if (varDef.notNull === false) def += ' NULL';
		return def;
	}).join(', ');
	return `with context (${contextVars})`;
}

export function createTableToString(stmt: AST.CreateTableStmt): string {
	const parts: string[] = ['create'];
	parts.push('table');
	if (stmt.ifNotExists) parts.push('if not exists');
	// Handle schema.table quoting
	const tableName = quoteIdentifier(stmt.table.name);
	const schemaName = stmt.table.schema ? quoteIdentifier(stmt.table.schema) : undefined;
	parts.push(schemaName ? `${schemaName}.${tableName}` : tableName);

	parts.push(tableBodyDefsToString(stmt));

	const using = moduleClauseToString(stmt);
	if (using) parts.push(using);

	const maintained = maintainedClauseToString(stmt.maintained);
	if (maintained) parts.push(maintained);

	const ctx = contextClauseToString(stmt);
	if (ctx) parts.push(ctx);

	const tagStr = tagsClauseToString(stmt.tags);
	if (tagStr) parts.push(tagStr.trimStart());

	return parts.join(' ');
}

/** `maintained [(columns)] as <body>` clause of a CREATE TABLE, or '' when absent.
 *  Clause order matches the parser grammar: using → maintained [(columns)] as <body … with defaults> → with tags.
 *  Any omitted-insert defaults ride inside the body string (selectToString's `with defaults (…)`).
 *  The `(columns)` rename list is emitted only when present (an explicit MV-sugar rename); its absence is
 *  the lossless signal that the body is implicit and may reshape to follow its source on reopen. */
export function maintainedClauseToString(maintained: AST.MaintainedClause | undefined): string {
	if (!maintained) return '';
	const parts = ['maintained'];
	if (maintained.columns && maintained.columns.length > 0) {
		parts.push(`(${maintained.columns.map(quoteIdentifier).join(', ')})`);
	}
	parts.push('as', astToString(maintained.select));
	return parts.join(' ');
}
