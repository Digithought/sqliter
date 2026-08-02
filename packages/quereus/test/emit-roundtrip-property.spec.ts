/**
 * AST-level round-trip property test.
 *
 * `parse(stringify(ast)) ≡ ast` is asserted structurally for generated AST
 * instances (not SQL strings). Driving from ASTs is deliberate — driving
 * from SQL strings would couple the test to whatever shapes the parser
 * happens to surface today, and miss exactly the kind of field the
 * stringifier silently drops (issues #21, #23).
 *
 * Arbitraries produce AST nodes typed against `parser/ast.ts` — when a
 * node type changes shape, the compile breaks. The comparator
 * (`emit-roundtrip-comparator.ts`) absorbs documented default-equivalences
 * so the property tests structural fidelity rather than identity.
 */

import { expect } from 'chai';
import * as fc from 'fast-check';
import { parse } from '../src/parser/index.js';
import { astToString } from '../src/emit/ast-stringify.js';
import { ConflictResolution } from '../src/common/constants.js';
import type * as AST from '../src/parser/ast.js';
import { assertAstEquivalent, astEquivalent } from './emit-roundtrip-comparator.js';
import { safeJsonStringify } from '../src/util/serialization.js';
import type { RowOp } from '../src/common/types.js';

// ------------------------------------------------------------------------
// Leaf arbitraries
// ------------------------------------------------------------------------

/** Unquoted-safe identifier the parser will accept without a contextual-keyword fight. */
const identArb: fc.Arbitrary<string> = fc.stringMatching(/^[a-z][a-z0-9_]{0,7}$/)
	// Avoid keyword clashes by sampling letter-prefixed names. The lexer keyword
	// table is large; we keep the alphabet small and rely on a denylist for the
	// common landmines.
	.filter(s => !RESERVED_AS_IDENT.has(s));

const RESERVED_AS_IDENT = new Set<string>([
	'select', 'from', 'where', 'and', 'or', 'not', 'null', 'true', 'false',
	'table', 'index', 'view', 'create', 'drop', 'alter', 'rename', 'column',
	'add', 'set', 'primary', 'key', 'unique', 'check', 'default', 'collate',
	'references', 'foreign', 'cascade', 'restrict', 'on', 'delete', 'update',
	'insert', 'into', 'values', 'using', 'with', 'as', 'asc', 'desc',
	'between', 'in', 'exists', 'case', 'when', 'then', 'else', 'end',
	'group', 'by', 'having', 'order', 'limit', 'offset', 'distinct', 'all',
	'inner', 'left', 'right', 'full', 'outer', 'cross', 'join', 'union',
	'intersect', 'except', 'diff', 'cast', 'is', 'like', 'glob', 'match',
	'regexp', 'begin', 'commit', 'rollback', 'savepoint', 'release',
	'pragma', 'analyze', 'temp', 'temporary', 'if', 'integer', 'real', 'text',
	'blob', 'numeric', 'declare', 'schema', 'version', 'apply', 'explain',
	'seed', 'assertion', 'constraint', 'generated', 'always', 'stored', 'virtual',
	'context', 'tags', 'nulls', 'first', 'last', 'rows', 'range', 'over',
	'partition', 'preceding', 'following', 'unbounded', 'current', 'row',
	'returning', 'option', 'maxrecursion', 'lateral', 'recursive', 'no', 'action',
	'conflict', 'abort', 'fail', 'ignore', 'replace', 'rollback', 'deferrable',
	'initially', 'deferred', 'immediate',
	// builtin function names that the stringifier lowercases; safer to avoid as identifiers.
	'count', 'sum', 'avg', 'min', 'max', 'length', 'substr', 'abs',
]);

/** Distinct identifier pairs. Helps avoid name collisions in multi-column shapes. */
function uniqueIdents(n: number): fc.Arbitrary<string[]> {
	return fc.uniqueArray(identArb, { minLength: n, maxLength: n });
}

/** Conflict resolution other than ABORT (the default, dropped by the stringifier). */
const conflictResArb: fc.Arbitrary<ConflictResolution | undefined> = fc.oneof(
	fc.constant(undefined),
	fc.constantFrom(
		ConflictResolution.ROLLBACK,
		ConflictResolution.FAIL,
		ConflictResolution.IGNORE,
		ConflictResolution.REPLACE,
	),
);

const rowOpArb: fc.Arbitrary<RowOp> = fc.constantFrom('insert', 'update', 'delete');
const rowOpSubsetArb: fc.Arbitrary<RowOp[]> = fc.uniqueArray(rowOpArb, { minLength: 0, maxLength: 3 });

const fkActionArb: fc.Arbitrary<AST.ForeignKeyAction> = fc.constantFrom('setNull', 'setDefault', 'cascade', 'restrict');

/**
 * Optional `with schema s1[, s2]` search path (`schemaPath` on SELECT and the
 * three DML statements) — the stealth-drop net for the clause the stringifier
 * once silently omitted (stringify-schema-path-clause).
 */
const schemaPathArb: fc.Arbitrary<string[] | undefined> = fc.option(
	fc.uniqueArray(identArb, { minLength: 1, maxLength: 2 }),
	{ nil: undefined },
);

/**
 * [NOT] DEFERRABLE [INITIALLY DEFERRED|IMMEDIATE] — produced as `deferrable` /
 * `initiallyDeferred` on `ForeignKeyClause`. `initiallyDeferred` is only set
 * inside a DEFERRABLE/NOT DEFERRABLE branch (the parser cannot reach it
 * otherwise), so we never emit `initiallyDeferred` without `deferrable`.
 */
const fkDeferrabilityArb: fc.Arbitrary<{ deferrable?: boolean; initiallyDeferred?: boolean }> = fc.oneof(
	fc.constant({}),
	fc.constant({ deferrable: true }),
	fc.constant({ deferrable: true, initiallyDeferred: true }),
	fc.constant({ deferrable: true, initiallyDeferred: false }),
	fc.constant({ deferrable: false }),
	fc.constant({ deferrable: false, initiallyDeferred: true }),
	fc.constant({ deferrable: false, initiallyDeferred: false }),
);

// ------------------------------------------------------------------------
// Expression arbitraries (kept small — DDL is the focus; expression
// coverage is provided transitively via CHECK/DEFAULT/CTE bodies)
// ------------------------------------------------------------------------

/** Literal: integer (small range so toString round-trips cleanly). */
const intLiteralArb: fc.Arbitrary<AST.LiteralExpr> = fc.integer({ min: 0, max: 1_000_000 })
	.map(value => ({ type: 'literal' as const, value }));

/** Literal: negative integer (parsed as unary minus wrapping a positive literal,
 *  so we don't model it directly as a `LiteralExpr`). */

/** Literal: string. */
const strLiteralArb: fc.Arbitrary<AST.LiteralExpr> = fc.stringMatching(/^[a-zA-Z0-9 _.,!?-]{0,20}$/)
	.map(value => ({ type: 'literal' as const, value }));

/** Literal: null. */
const nullLiteralArb: fc.Arbitrary<AST.LiteralExpr> = fc.constant({
	type: 'literal' as const,
	value: null,
});

const literalArb: fc.Arbitrary<AST.LiteralExpr> = fc.oneof(intLiteralArb, strLiteralArb, nullLiteralArb);

/** Column reference (just a bare name, no table qualifier — keeps comparator simple). */
const columnRefArb: fc.Arbitrary<AST.ColumnExpr> = identArb.map(name => ({
	type: 'column' as const,
	name,
}));

/** Simple expression: literal or column reference. */
const simpleExprArb: fc.Arbitrary<AST.Expression> = fc.oneof(literalArb, columnRefArb);

/** `new.<col>` reference — the surface an authored inverse uses for the written view row. */
const newQualifiedRefArb: fc.Arbitrary<AST.ColumnExpr> = identArb.map(name => ({
	type: 'column' as const,
	name,
	table: 'new',
}));

/**
 * `with inverse (col = expr, …)` assignment list on an expression result column
 * (`ResultColumnExpr.inverse`) — distinct targets (a duplicate is a parse
 * error), exprs spanning literals, bare refs, and `new.`-qualified refs.
 */
const inverseClauseArb: fc.Arbitrary<AST.ResultColumnInverse[]> = fc.uniqueArray(
	fc.tuple(identArb, fc.oneof(simpleExprArb, newQualifiedRefArb))
		.map(([column, expr]): AST.ResultColumnInverse => ({ column, expr })),
	{ minLength: 1, maxLength: 3, selector: a => a.column },
);

/**
 * Comparison binary expression — `col > 0` etc. Restricted to one shape so
 * we don't have to model operator precedence in the arbitrary.
 */
const checkExprArb: fc.Arbitrary<AST.BinaryExpr> = fc.tuple(
	columnRefArb,
	fc.constantFrom('>', '<', '>=', '<=', '=', '!='),
	intLiteralArb,
).map(([left, operator, right]): AST.BinaryExpr => ({
	type: 'binary',
	operator,
	left,
	right,
}));

// ------------------------------------------------------------------------
// Column constraints
// ------------------------------------------------------------------------

const columnConstraintArb: fc.Arbitrary<AST.ColumnConstraint> = fc.oneof(
	// PRIMARY KEY [ASC|DESC] [ON CONFLICT ...]
	fc.record({
		direction: fc.oneof<fc.Arbitrary<'asc' | 'desc' | undefined>[]>(fc.constant(undefined), fc.constant('asc'), fc.constant('desc')),
		onConflict: conflictResArb,
	}).map(({ direction, onConflict }): AST.ColumnConstraint => {
		const c: AST.ColumnConstraint = { type: 'primaryKey' };
		if (direction !== undefined) c.direction = direction;
		if (onConflict !== undefined) c.onConflict = onConflict;
		return c;
	}),
	// NOT NULL [ON CONFLICT ...]
	conflictResArb.map((onConflict): AST.ColumnConstraint => {
		const c: AST.ColumnConstraint = { type: 'notNull' };
		if (onConflict !== undefined) c.onConflict = onConflict;
		return c;
	}),
	// UNIQUE [ON CONFLICT ...]
	conflictResArb.map((onConflict): AST.ColumnConstraint => {
		const c: AST.ColumnConstraint = { type: 'unique' };
		if (onConflict !== undefined) c.onConflict = onConflict;
		return c;
	}),
	// CHECK [ON ops] (<expr>) [ON CONFLICT ...]
	fc.record({
		expr: checkExprArb,
		operations: rowOpSubsetArb,
		onConflict: conflictResArb,
	}).map(({ expr, operations, onConflict }): AST.ColumnConstraint => {
		const c: AST.ColumnConstraint = { type: 'check', expr };
		// Only set operations if non-empty (matches the parser's "absent vs explicit" representation:
		// when ON is missing the parser leaves the field undefined; when ON is present it always
		// produces a non-empty list).
		if (operations.length > 0) c.operations = operations;
		if (onConflict !== undefined) c.onConflict = onConflict;
		return c;
	}),
	// DEFAULT <expr>
	literalArb.map((expr): AST.ColumnConstraint => ({ type: 'default', expr })),
	// COLLATE <name>
	fc.constantFrom('binary', 'nocase', 'rtrim').map((collation): AST.ColumnConstraint => ({
		type: 'collate',
		collation,
	})),
	// REFERENCES tbl [(col)] [ON DELETE ...] [ON UPDATE ...] [[NOT] DEFERRABLE [INITIALLY ...]]
	fc.record({
		fkTable: identArb,
		fkColumn: fc.option(identArb, { nil: undefined }),
		onDelete: fc.option(fkActionArb, { nil: undefined }),
		onUpdate: fc.option(fkActionArb, { nil: undefined }),
		deferrability: fkDeferrabilityArb,
	}).map(({ fkTable, fkColumn, onDelete, onUpdate, deferrability }): AST.ColumnConstraint => {
		const fk: AST.ForeignKeyClause = { table: fkTable };
		if (fkColumn) fk.columns = [fkColumn];
		if (onDelete) fk.onDelete = onDelete;
		if (onUpdate) fk.onUpdate = onUpdate;
		if (deferrability.deferrable !== undefined) fk.deferrable = deferrability.deferrable;
		if (deferrability.initiallyDeferred !== undefined) fk.initiallyDeferred = deferrability.initiallyDeferred;
		return { type: 'foreignKey', foreignKey: fk };
	}),
	// GENERATED ALWAYS AS (<expr>) [STORED|VIRTUAL]
	fc.record({
		expr: simpleExprArb,
		stored: fc.boolean(),
	}).map(({ expr, stored }): AST.ColumnConstraint => ({
		type: 'generated',
		generated: { expr, stored },
	})),
);

// ------------------------------------------------------------------------
// Column definitions
// ------------------------------------------------------------------------

const dataTypeArb: fc.Arbitrary<string | undefined> = fc.oneof(
	fc.constant(undefined),
	fc.constantFrom('integer', 'text', 'real', 'blob', 'numeric'),
);

/**
 * A column definition for CREATE TABLE.
 *
 * To stay inside the parser's accepted subset, generated columns are
 * forbidden from co-existing with DEFAULT (the parser tolerates either
 * but they collide semantically in some engines), and PK/NotNull/Unique
 * are emitted at most once each. We don't aim for *every* legal SQL
 * column — just every (constraint, attribute) crossing that exercises
 * `columnConstraintsToString`.
 */
function makeColumnDefArb(name: string): fc.Arbitrary<AST.ColumnDef> {
	return fc.record({
		dataType: dataTypeArb,
		// Restrict to one constraint per column to keep the arbitrary in a region
		// the parser accepts uniformly. Cross-product of multiple constraints in
		// one column would require modelling exclusion rules (e.g. PRIMARY KEY +
		// NOT NULL is fine but PRIMARY KEY + GENERATED is not).
		constraint: fc.option(columnConstraintArb, { nil: undefined }),
	}).map(({ dataType, constraint }): AST.ColumnDef => ({
		name,
		dataType,
		constraints: constraint ? [constraint] : [],
	}));
}

// ------------------------------------------------------------------------
// Table constraints
// ------------------------------------------------------------------------

function makeTableConstraintArb(columnNames: string[]): fc.Arbitrary<AST.TableConstraint> {
	const colName = fc.constantFrom(...columnNames);
	const multiCol = (max: number) => fc.uniqueArray(colName, { minLength: 1, maxLength: Math.min(max, columnNames.length) });

	return fc.oneof(
		// PRIMARY KEY (col [ASC|DESC], ...) [ON CONFLICT ...]
		fc.record({
			cols: multiCol(3),
			directions: fc.array(fc.oneof<fc.Arbitrary<'asc' | 'desc' | undefined>[]>(fc.constant(undefined), fc.constant('asc'), fc.constant('desc')), { minLength: 0, maxLength: 3 }),
			onConflict: conflictResArb,
		}).map(({ cols, directions, onConflict }): AST.TableConstraint => {
			const c: AST.TableConstraint = {
				type: 'primaryKey',
				columns: cols.map((name, i) => {
					const e: { name: string; direction?: 'asc' | 'desc' } = { name };
					const d = directions[i];
					if (d !== undefined) e.direction = d;
					return e;
				}),
			};
			if (onConflict !== undefined) c.onConflict = onConflict;
			return c;
		}),
		// UNIQUE (col, ...) [ON CONFLICT ...]
		fc.record({
			cols: multiCol(3),
			onConflict: conflictResArb,
		}).map(({ cols, onConflict }): AST.TableConstraint => {
			const c: AST.TableConstraint = {
				type: 'unique',
				columns: cols.map(name => ({ name })),
			};
			if (onConflict !== undefined) c.onConflict = onConflict;
			return c;
		}),
		// CHECK [ON ops] (<expr>) [ON CONFLICT ...]
		fc.record({
			expr: checkExprArb,
			operations: rowOpSubsetArb,
			onConflict: conflictResArb,
		}).map(({ expr, operations, onConflict }): AST.TableConstraint => {
			const c: AST.TableConstraint = { type: 'check', expr };
			if (operations.length > 0) c.operations = operations;
			if (onConflict !== undefined) c.onConflict = onConflict;
			return c;
		}),
		// FOREIGN KEY (cols) REFERENCES tbl [(cols)] [ON DELETE ...] [ON UPDATE ...] [[NOT] DEFERRABLE [INITIALLY ...]]
		fc.record({
			localCols: multiCol(2),
			fkTable: identArb,
			fkColumn: fc.option(identArb, { nil: undefined }),
			onDelete: fc.option(fkActionArb, { nil: undefined }),
			onUpdate: fc.option(fkActionArb, { nil: undefined }),
			deferrability: fkDeferrabilityArb,
		}).map(({ localCols, fkTable, fkColumn, onDelete, onUpdate, deferrability }): AST.TableConstraint => {
			const fk: AST.ForeignKeyClause = { table: fkTable };
			if (fkColumn) fk.columns = [fkColumn];
			if (onDelete) fk.onDelete = onDelete;
			if (onUpdate) fk.onUpdate = onUpdate;
			if (deferrability.deferrable !== undefined) fk.deferrable = deferrability.deferrable;
			if (deferrability.initiallyDeferred !== undefined) fk.initiallyDeferred = deferrability.initiallyDeferred;
			return {
				type: 'foreignKey',
				columns: localCols.map(name => ({ name })),
				foreignKey: fk,
			};
		}),
	);
}

// ------------------------------------------------------------------------
// CREATE TABLE
// ------------------------------------------------------------------------

const createTableArb: fc.Arbitrary<AST.CreateTableStmt> = fc.tuple(
	identArb,                                  // table name
	uniqueIdents(3),                            // column names (3 fixed so table constraints have something to reference)
	fc.boolean(),                               // ifNotExists
).chain(([tableName, colNames, ifNotExists]) => {
	// Destructure into a fixed 3-tuple (colNames has exactly 3 entries) so fc.tuple
	// infers positional element types instead of `ColumnDef | TableConstraint[]`.
	const [col0, col1, col2] = colNames.map(name => makeColumnDefArb(name));
	return fc.tuple(
		col0, col1, col2,
		fc.array(makeTableConstraintArb(colNames), { minLength: 0, maxLength: 2 }),
	).map(([c0, c1, c2, constraints]): AST.CreateTableStmt => ({
		type: 'createTable',
		table: { type: 'identifier', name: tableName },
		ifNotExists,
		columns: [c0, c1, c2],
		constraints,
	}));
});

// ------------------------------------------------------------------------
// CREATE VIEW (minimal)
// ------------------------------------------------------------------------

/**
 * `select <col> [with inverse (…)] from <table> [with schema …]` — the result
 * column sometimes carries an authored-inverse clause and the statement
 * sometimes a schema path, so every QueryExpr-accepting site fed by this
 * arbitrary (CTE body, view body, subquery source, compound leg, …) also
 * probes clause survival in nested positions (a compound leg carrying a
 * schema path must re-emit grouping parens — bare legs never parse one).
 */
const simpleSelectArb: fc.Arbitrary<AST.SelectStmt> = fc.tuple(
	identArb,
	identArb,
	fc.option(inverseClauseArb, { nil: undefined }),
	schemaPathArb,
).map(([col, table, inverse, schemaPath]): AST.SelectStmt => ({
	type: 'select',
	columns: [{ type: 'column', expr: { type: 'column', name: col }, ...(inverse ? { inverse } : {}) }],
	from: [{ type: 'table', table: { type: 'identifier', name: table } }],
	...(schemaPath ? { schemaPath } : {}),
}));

/**
 * `select <col> [as alias] [with inverse (…)], … from t` — drives
 * `ResultColumnExpr.inverse` directly across 1–3 result columns, each
 * independently aliased and/or carrying the clause, so alias⨯inverse
 * coexistence and the comma boundary between a clause and the next result
 * column are probed structurally (the net for stealth field-drops in
 * `resultColumnToString`).
 */
const selectWithInverseArb: fc.Arbitrary<AST.SelectStmt> = fc.tuple(
	fc.array(
		fc.tuple(
			identArb,
			fc.option(identArb, { nil: undefined }),
			fc.option(inverseClauseArb, { nil: undefined }),
		),
		{ minLength: 1, maxLength: 3 },
	),
	identArb,
).map(([cols, table]): AST.SelectStmt => ({
	type: 'select',
	columns: cols.map(([name, alias, inverse]): AST.ResultColumn => ({
		type: 'column',
		expr: { type: 'column', name },
		...(alias ? { alias } : {}),
		...(inverse ? { inverse } : {}),
	})),
	from: [{ type: 'table', table: { type: 'identifier', name: table } }],
}));

/**
 * Compact VALUES bodies — 1–3 rows of 1–3 literal cells. Used as the
 * exemplar `ValuesStmt` instance at each QueryExpr-accepting site so the
 * comparator catches a silent drop of the VALUES branch in any of the
 * widened emitters (SubqueryExpr, ExistsExpr, InExpr, compound, CTE, view).
 */
const valuesStmtArb: fc.Arbitrary<AST.ValuesStmt> = fc.tuple(
	fc.integer({ min: 1, max: 3 }), // cells per row
	fc.integer({ min: 1, max: 3 }), // rows
).chain(([width, height]) =>
	fc.array(
		fc.array(literalArb, { minLength: width, maxLength: width }),
		{ minLength: height, maxLength: height },
	).map((rows): AST.ValuesStmt => ({ type: 'values', values: rows })),
);

/** Either a simple SELECT or a VALUES — the two QueryExpr forms today's planner runs. */
const queryExprArb: fc.Arbitrary<AST.SelectStmt | AST.ValuesStmt> = fc.oneof(
	simpleSelectArb,
	valuesStmtArb,
);

// ------------------------------------------------------------------------
// QueryExpr-bearing wrapper arbitraries — drive `queryExprArb` through
// every QueryExpr-accepting AST site so a silent-drop regression at any
// emitter dispatch surfaces structurally, not just at CREATE VIEW.
// ------------------------------------------------------------------------

/**
 * `select <subquery> from t` — drives `SubqueryExpr.query` in scalar
 * expression position. A regression that emitted only `select` legs of
 * the QueryExpr union (and dropped VALUES at this site) would surface as
 * a round-trip failure here.
 */
const subqueryInColumnArb: fc.Arbitrary<AST.SelectStmt> = fc.tuple(queryExprArb, identArb).map(
	([query, table]): AST.SelectStmt => ({
		type: 'select',
		columns: [{ type: 'column', expr: { type: 'subquery', query } }],
		from: [{ type: 'table', table: { type: 'identifier', name: table } }],
	}),
);

/**
 * `select c from t where c [not] in (<query-expr>)` — drives
 * `InExpr.subquery`. Both the bare and NOT-wrapped surface re-parse to
 * the same `UnaryExpr(NOT, InExpr)` / `InExpr` shape — the parser folds
 * `c NOT IN (…)` and prefix `NOT c IN (…)` to the same tree.
 */
const inSubqueryArb: fc.Arbitrary<AST.SelectStmt> = fc.tuple(
	queryExprArb,
	identArb, // column name
	identArb, // table name
	fc.boolean(),
).map(([query, col, table, negated]): AST.SelectStmt => {
	const inExpr: AST.InExpr = {
		type: 'in',
		expr: { type: 'column', name: col },
		subquery: query,
	};
	const where: AST.Expression = negated
		? { type: 'unary', operator: 'NOT', expr: inExpr }
		: inExpr;
	return {
		type: 'select',
		columns: [{ type: 'column', expr: { type: 'column', name: col } }],
		from: [{ type: 'table', table: { type: 'identifier', name: table } }],
		where,
	};
});

/**
 * `select c from t where exists (<query-expr>)` — drives `ExistsExpr.subquery`.
 */
const existsSubqueryArb: fc.Arbitrary<AST.SelectStmt> = fc.tuple(
	queryExprArb,
	identArb, // column name
	identArb, // table name
).map(([query, col, table]): AST.SelectStmt => ({
	type: 'select',
	columns: [{ type: 'column', expr: { type: 'column', name: col } }],
	from: [{ type: 'table', table: { type: 'identifier', name: table } }],
	where: { type: 'exists', subquery: query },
}));

/**
 * `select c from t <op> <query-expr>` — drives `SelectStmt.compound[].select`
 * across every compound operator (UNION / UNION ALL / INTERSECT / EXCEPT /
 * DIFF). Left leg is always a SELECT so the top-level wrapper-emit shape
 * does not interact (see ticket out-of-scope note on bare-VALUES UNION).
 */
const compoundOpArb: fc.Arbitrary<'union' | 'unionAll' | 'intersect' | 'except' | 'diff'> = fc.constantFrom(
	'union', 'unionAll', 'intersect', 'except', 'diff',
);

const compoundSelectArb: fc.Arbitrary<AST.SelectStmt> = fc.tuple(
	identArb, // left column name
	identArb, // left table name
	compoundOpArb,
	queryExprArb,
	// Statement-level schema path — binds BEFORE the compound operator, so the
	// stringifier must emit it ahead of the op for re-parse to re-bind it here.
	schemaPathArb,
).map(([col, table, op, rightLeg, schemaPath]): AST.SelectStmt => ({
	type: 'select',
	columns: [{ type: 'column', expr: { type: 'column', name: col } }],
	from: [{ type: 'table', table: { type: 'identifier', name: table } }],
	compound: { op, select: rightLeg },
	...(schemaPath ? { schemaPath } : {}),
}));

/**
 * `select c from (<query-expr>) as <alias>` — drives `SubquerySource.subquery`
 * in FROM position. The `case 'subquerySource'` dispatch in
 * `fromClauseToString` (ast-stringify.ts:475-486) is a distinct
 * `astToString` call site from the four expression-position dispatches;
 * a silent drop of one QueryExpr branch there would surface only here.
 * The column list is omitted for the same arity-coupling reason as the
 * CREATE VIEW arbitrary's VALUES branch — column-list survival at
 * SubquerySource isn't probed by the property suite.
 */
const subquerySourceArb: fc.Arbitrary<AST.SelectStmt> = fc.tuple(
	queryExprArb,
	identArb, // outer column name
	identArb, // FROM alias
).map(([query, col, alias]): AST.SelectStmt => ({
	type: 'select',
	columns: [{ type: 'column', expr: { type: 'column', name: col } }],
	from: [{ type: 'subquerySource', subquery: query, alias }],
}));

/** [NOT] MATERIALIZED hint on a CTE — `undefined` ≡ no keyword emitted. */
const materializationHintArb: fc.Arbitrary<AST.CommonTableExpr['materializationHint']> = fc.constantFrom(
	undefined,
	'materialized' as const,
	'not_materialized' as const,
);

/**
 * `with <name> as [materialized|not materialized] (<query-expr>) select c from t`
 * — drives `CommonTableExpr.query` and `materializationHint`. The outer SELECT
 * body is decoupled from the CTE so the test is independent of CTE-reference
 * resolution (parsing is purely syntactic — name binding happens later). The
 * CTE column list is omitted because it would couple the column arity to the
 * QueryExpr's shape and conflict with VALUES bodies.
 */
const cteSelectArb: fc.Arbitrary<AST.SelectStmt> = fc.tuple(
	identArb, // CTE name
	queryExprArb,
	materializationHintArb,
	identArb, // outer column name
	identArb, // outer table name
).map(([cteName, query, materializationHint, col, table]): AST.SelectStmt => {
	const cte: AST.CommonTableExpr = { type: 'commonTableExpr', name: cteName, query };
	if (materializationHint !== undefined) cte.materializationHint = materializationHint;
	return {
		type: 'select',
		withClause: {
			type: 'with',
			recursive: false,
			ctes: [cte],
		},
		columns: [{ type: 'column', expr: { type: 'column', name: col } }],
		from: [{ type: 'table', table: { type: 'identifier', name: table } }],
	};
});

/** `with defaults (col = expr, …)` entries — distinct columns, literal exprs.
 *  The clause now rides inside the SELECT body (`SelectStmt.defaults`); attach
 *  via {@link withDefaults} which is a no-op on a non-select body. */
const defaultsArb: fc.Arbitrary<AST.ViewInsertDefault[] | undefined> = fc.option(
	fc.uniqueArray(
		fc.tuple(identArb, literalArb).map(([column, expr]): AST.ViewInsertDefault => ({ column, expr })),
		{ minLength: 1, maxLength: 3, selector: d => d.column },
	),
	{ nil: undefined },
);

/** Attach a `with defaults (…)` clause to a body — only a SELECT body can carry it
 *  ({@link AST.SelectStmt.defaults}); a VALUES body passes through unchanged (its
 *  defaults would wrap to `SELECT * FROM (VALUES…)` and break AST round-trip). */
function withDefaults(body: AST.QueryExpr, defaults: AST.ViewInsertDefault[] | undefined): AST.QueryExpr {
	if (!defaults || body.type !== 'select') return body;
	return { ...body, defaults };
}

/**
 * CREATE VIEW with either a SELECT or VALUES body. When the body is VALUES
 * we drop the explicit column list because its arity is generator-coupled
 * to the VALUES width and the round-trip would otherwise reject the
 * mismatch — column-list survival is already covered via the SELECT body.
 */
const createViewArb: fc.Arbitrary<AST.CreateViewStmt> = fc.tuple(
	identArb,
	fc.boolean(),
	fc.option(uniqueIdents(1), { nil: undefined }),
	queryExprArb,
	defaultsArb,
).map(([name, ifNotExists, columns, body, defaults]): AST.CreateViewStmt => ({
	type: 'createView',
	view: { type: 'identifier', name },
	ifNotExists,
	columns: body.type === 'values' ? undefined : columns,
	select: withDefaults(body, defaults),
}));

// ------------------------------------------------------------------------
// CREATE INDEX
// ------------------------------------------------------------------------

const indexedColumnArb: fc.Arbitrary<AST.IndexedColumn> = fc.record({
	name: identArb,
	direction: fc.oneof<fc.Arbitrary<'asc' | 'desc' | undefined>[]>(fc.constant(undefined), fc.constant('asc'), fc.constant('desc')),
}).map(({ name, direction }) => {
	const c: AST.IndexedColumn = { name };
	if (direction !== undefined) c.direction = direction;
	return c;
});

const createIndexArb: fc.Arbitrary<AST.CreateIndexStmt> = fc.record({
	idxName: identArb,
	tblName: identArb,
	ifNotExists: fc.boolean(),
	isUnique: fc.boolean(),
	columns: fc.array(indexedColumnArb, { minLength: 1, maxLength: 3 }),
	wherePred: fc.option(checkExprArb, { nil: undefined }),
}).map(({ idxName, tblName, ifNotExists, isUnique, columns, wherePred }): AST.CreateIndexStmt => ({
	type: 'createIndex',
	index: { type: 'identifier', name: idxName },
	table: { type: 'identifier', name: tblName },
	ifNotExists,
	isUnique,
	columns,
	where: wherePred,
}));

// ------------------------------------------------------------------------
// CREATE ASSERTION
// ------------------------------------------------------------------------

const createAssertionArb: fc.Arbitrary<AST.CreateAssertionStmt> = fc.record({
	name: identArb,
	schema: fc.option(identArb, { nil: undefined }),
	check: checkExprArb,
}).map(({ name, schema, check }): AST.CreateAssertionStmt => ({
	type: 'createAssertion',
	name: { type: 'identifier', name, schema },
	check,
}));

// ------------------------------------------------------------------------
// DECLARE SCHEMA (items round-trip)
// ------------------------------------------------------------------------

/**
 * Declared-table inner CreateTableStmt. The declarative grammar forces
 * `ifNotExists` to false (no `IF NOT EXISTS` at the item level), so we pin it
 * to false here to keep generated trees inside the parser's declared-form subset.
 */
const declaredTableInnerArb: fc.Arbitrary<AST.CreateTableStmt> = fc.tuple(
	identArb,
	uniqueIdents(3),
).chain(([tableName, colNames]) => {
	// Destructure into a fixed 3-tuple (colNames has exactly 3 entries) so fc.tuple
	// infers positional element types instead of `ColumnDef | TableConstraint[]`.
	const [col0, col1, col2] = colNames.map(name => makeColumnDefArb(name));
	return fc.tuple(
		col0, col1, col2,
		fc.array(makeTableConstraintArb(colNames), { minLength: 0, maxLength: 2 }),
	).map(([c0, c1, c2, constraints]): AST.CreateTableStmt => ({
		type: 'createTable',
		table: { type: 'identifier', name: tableName },
		ifNotExists: false,
		columns: [c0, c1, c2],
		constraints,
	}));
});

const declaredTableItemArb: fc.Arbitrary<AST.DeclaredTable> = declaredTableInnerArb.map(tableStmt => ({
	type: 'declaredTable' as const,
	tableStmt,
}));

const declaredIndexItemArb: fc.Arbitrary<AST.DeclaredIndex> = fc.record({
	idxName: identArb,
	tblName: identArb,
	isUnique: fc.boolean(),
	columns: fc.array(indexedColumnArb, { minLength: 1, maxLength: 3 }),
}).map(({ idxName, tblName, isUnique, columns }): AST.DeclaredIndex => ({
	type: 'declaredIndex',
	indexStmt: {
		type: 'createIndex',
		index: { type: 'identifier', name: idxName },
		table: { type: 'identifier', name: tblName },
		ifNotExists: false,
		isUnique,
		columns,
	},
}));

const declaredViewItemArb: fc.Arbitrary<AST.DeclaredView> = fc.record({
	name: identArb,
	cols: fc.option(uniqueIdents(1), { nil: undefined }),
	select: simpleSelectArb,
	defaults: defaultsArb,
}).map(({ name, cols, select, defaults }): AST.DeclaredView => ({
	type: 'declaredView',
	viewStmt: {
		type: 'createView',
		view: { type: 'identifier', name },
		ifNotExists: false,
		columns: cols,
		select: { ...select, defaults },
	},
}));

/** Seed literals limited to integers and short strings — what the parser accepts as `literal`. */
const seedScalarArb: fc.Arbitrary<number | string | null> = fc.oneof(
	fc.integer({ min: 0, max: 1_000_000 }),
	fc.stringMatching(/^[a-zA-Z0-9 _.,!?-]{0,12}$/),
	fc.constant(null),
);

const declaredSeedItemArb: fc.Arbitrary<AST.DeclaredSeed> = fc.tuple(
	identArb,
	fc.integer({ min: 1, max: 3 }), // columns-per-row
	fc.integer({ min: 1, max: 3 }), // rows
).chain(([tableName, width, height]) =>
	fc.array(fc.array(seedScalarArb, { minLength: width, maxLength: width }), { minLength: height, maxLength: height })
		.map((rows): AST.DeclaredSeed => ({
			type: 'declaredSeed',
			tableName,
			seedData: rows,
		})),
);

const declaredAssertionItemArb: fc.Arbitrary<AST.DeclaredAssertion> = fc.record({
	name: identArb,
	check: checkExprArb,
}).map(({ name, check }): AST.DeclaredAssertion => ({
	type: 'declaredAssertion',
	assertionStmt: { type: 'createAssertion', name: { type: 'identifier', name }, check },
}));

const declareItemArb: fc.Arbitrary<AST.DeclareItem> = fc.oneof(
	declaredTableItemArb,
	declaredIndexItemArb,
	declaredViewItemArb,
	declaredSeedItemArb,
	declaredAssertionItemArb,
);

const declareSchemaArb: fc.Arbitrary<AST.DeclareSchemaStmt> = fc.array(declareItemArb, { minLength: 1, maxLength: 3 })
	.map((items): AST.DeclareSchemaStmt => ({
		type: 'declareSchema',
		schemaName: 'main',
		items,
	}));

// ------------------------------------------------------------------------
// ALTER TABLE actions
// ------------------------------------------------------------------------

const alterTableArb: fc.Arbitrary<AST.AlterTableStmt> = fc.tuple(
	identArb, // table name
	fc.oneof<fc.Arbitrary<AST.AlterTableAction>[]>(
		// RENAME TO
		identArb.map(newName => ({ type: 'renameTable', newName })),
		// RENAME COLUMN
		fc.tuple(identArb, identArb).map(([oldName, newName]) => ({
			type: 'renameColumn',
			oldName,
			newName,
		})),
		// ADD COLUMN
		identArb.chain(name => makeColumnDefArb(name)).map(column => ({
			type: 'addColumn',
			column,
		})),
		// DROP COLUMN
		identArb.map(name => ({ type: 'dropColumn', name })),
		// DROP CONSTRAINT <name>
		identArb.map(name => ({ type: 'dropConstraint' as const, name })),
		// RENAME CONSTRAINT <old> TO <new>
		fc.tuple(identArb, identArb).map(([oldName, newName]) => ({
			type: 'renameConstraint' as const,
			oldName,
			newName,
		})),
		// ADD CONSTRAINT — generate a NAMED constraint so the parser's `ADD CONSTRAINT`
		// path is exercised (the unnamed table-constraint path requires the constraint
		// keyword to be present anyway, so we always set a name).
		fc.tuple(identArb, uniqueIdents(2)).chain(([cName, colNames]) =>
			makeTableConstraintArb(colNames).map(c => ({
				type: 'addConstraint' as const,
				constraint: { ...c, name: cName } as AST.TableConstraint,
			})),
		),
		// ALTER PRIMARY KEY (cols)
		uniqueIdents(2).chain(cols => fc.array(fc.oneof<fc.Arbitrary<'asc' | 'desc' | undefined>[]>(
			fc.constant(undefined),
			fc.constant('asc'),
			fc.constant('desc'),
		), { minLength: 2, maxLength: 2 }).map(directions => ({
			type: 'alterPrimaryKey' as const,
			columns: cols.map((name, i) => {
				const e: { name: string; direction?: 'asc' | 'desc' } = { name };
				if (directions[i] !== undefined) e.direction = directions[i];
				return e;
			}),
		}))),
		// ALTER COLUMN ... SET NOT NULL / DROP NOT NULL
		fc.tuple(identArb, fc.boolean()).map(([columnName, setNotNull]) => ({
			type: 'alterColumn' as const,
			columnName,
			setNotNull,
		})),
		// ALTER COLUMN ... SET DATA TYPE <type>
		fc.tuple(identArb, fc.constantFrom('integer', 'text', 'real', 'blob', 'numeric')).map(([columnName, setDataType]) => ({
			type: 'alterColumn' as const,
			columnName,
			setDataType,
		})),
		// ALTER COLUMN ... SET DEFAULT <expr>
		fc.tuple(identArb, literalArb).map(([columnName, expr]) => ({
			type: 'alterColumn' as const,
			columnName,
			setDefault: expr,
		})),
		// ALTER COLUMN ... DROP DEFAULT
		identArb.map(columnName => ({
			type: 'alterColumn' as const,
			columnName,
			setDefault: null,
		})),
	),
).map(([tableName, action]): AST.AlterTableStmt => ({
	type: 'alterTable',
	table: { type: 'identifier', name: tableName },
	action,
}));

// ------------------------------------------------------------------------
// DROP
// ------------------------------------------------------------------------

const dropArb: fc.Arbitrary<AST.DropStmt> = fc.record({
	objectType: fc.constantFrom<('table' | 'view' | 'index' | 'assertion')[]>(
		'table', 'view', 'index', 'assertion',
	),
	ifExists: fc.boolean(),
	name: identArb,
}).map(({ objectType, ifExists, name }): AST.DropStmt => ({
	type: 'drop',
	objectType,
	name: { type: 'identifier', name },
	ifExists,
}));

// ------------------------------------------------------------------------
// Transactional + PRAGMA + ANALYZE
// ------------------------------------------------------------------------

const transactionStmtArb: fc.Arbitrary<AST.Statement> = fc.oneof(
	fc.constant<AST.BeginStmt>({ type: 'begin' }),
	fc.constant<AST.CommitStmt>({ type: 'commit' }),
	fc.option(identArb, { nil: undefined }).map((savepoint): AST.RollbackStmt => ({
		type: 'rollback',
		savepoint,
	})),
	identArb.map((name): AST.SavepointStmt => ({ type: 'savepoint', name })),
	identArb.map((savepoint): AST.ReleaseStmt => ({ type: 'release', savepoint })),
);

const pragmaArb: fc.Arbitrary<AST.PragmaStmt> = fc.tuple(identArb, fc.option(intLiteralArb, { nil: undefined }))
	.map(([name, value]): AST.PragmaStmt => {
		const p: AST.PragmaStmt = { type: 'pragma', name };
		if (value) p.value = value;
		return p;
	});

const analyzeArb: fc.Arbitrary<AST.AnalyzeStmt> = fc.oneof(
	fc.constant<AST.AnalyzeStmt>({ type: 'analyze' }),
	identArb.map(tableName => ({ type: 'analyze' as const, tableName })),
	// schema-only shape (`analyze schema.*`) — round-trips via the ASTERISK surface
	identArb.map(schemaName => ({ type: 'analyze' as const, schemaName })),
	fc.tuple(identArb, identArb).map(([schemaName, tableName]) => ({
		type: 'analyze' as const,
		schemaName,
		tableName,
	})),
);

// ------------------------------------------------------------------------
// DML smoke (kept tiny — string round-trip already covers most surface)
// ------------------------------------------------------------------------

// The INSERT source stays VALUES-shaped: a trailing schema path after a bare
// SELECT source re-binds to the select on re-parse (the select's own
// `parseSchemaPath` is greedy), so insert-level schemaPath ⨯ select-source is
// only reachable with an intervening trailing clause — covered deterministically
// in emit-roundtrip.spec.ts.
const insertArb: fc.Arbitrary<AST.InsertStmt> = fc.tuple(
	identArb,
	uniqueIdents(2),
	fc.array(literalArb, { minLength: 2, maxLength: 2 }),
	conflictResArb,
	schemaPathArb,
).map(([tbl, colNames, vals, onConflict, schemaPath]): AST.InsertStmt => {
	const stmt: AST.InsertStmt = {
		type: 'insert',
		table: { type: 'identifier', name: tbl },
		columns: colNames,
		source: {
			type: 'values',
			values: [vals],
		},
	};
	if (onConflict !== undefined) stmt.onConflict = onConflict;
	if (schemaPath) stmt.schemaPath = schemaPath;
	return stmt;
});

const updateArb: fc.Arbitrary<AST.UpdateStmt> = fc.tuple(
	identArb,
	identArb,
	literalArb,
	fc.option(checkExprArb, { nil: undefined }),
	schemaPathArb,
).map(([tbl, col, val, wherePred, schemaPath]): AST.UpdateStmt => {
	const stmt: AST.UpdateStmt = {
		type: 'update',
		table: { type: 'identifier', name: tbl },
		assignments: [{ column: col, value: val }],
	};
	if (wherePred) stmt.where = wherePred;
	if (schemaPath) stmt.schemaPath = schemaPath;
	return stmt;
});

const deleteArb: fc.Arbitrary<AST.DeleteStmt> = fc.tuple(
	identArb,
	fc.option(checkExprArb, { nil: undefined }),
	schemaPathArb,
).map(([tbl, wherePred, schemaPath]): AST.DeleteStmt => {
	const stmt: AST.DeleteStmt = {
		type: 'delete',
		table: { type: 'identifier', name: tbl },
	};
	if (wherePred) stmt.where = wherePred;
	if (schemaPath) stmt.schemaPath = schemaPath;
	return stmt;
});

/**
 * A minimal single-column-from-table SELECT body for an inline-subquery DML target
 * (`(select <col> from <tbl>)`), shaped to match exactly what the parser yields for the
 * same SQL so the round-trip compares equal.
 */
const subqueryBodyArb: fc.Arbitrary<AST.SelectStmt> = fc.tuple(identArb, identArb).map(
	([col, tbl]): AST.SelectStmt => ({
		type: 'select',
		columns: [{ type: 'column', expr: { type: 'column', name: col } }],
		from: [{ type: 'table', table: { type: 'identifier', name: tbl } }],
	}),
);

/**
 * Inline-subquery UPDATE target (`update (select …) as v [(cols)] set …`). Built to
 * mirror parser output: `table` is the alias-named placeholder, `alias` carries the
 * correlation name, and `targetSource` holds the body + optional rename list. Guards the
 * stringifier against silently dropping `targetSource`.
 */
const subqueryTargetUpdateArb: fc.Arbitrary<AST.UpdateStmt> = fc.tuple(
	subqueryBodyArb,
	identArb,
	identArb,
	literalArb,
	fc.option(fc.array(identArb, { minLength: 1, maxLength: 3 }), { nil: undefined }),
).map(([subquery, alias, setCol, val, columns]): AST.UpdateStmt => {
	const targetSource: AST.SubquerySource = { type: 'subquerySource', subquery, alias };
	if (columns) targetSource.columns = columns;
	return {
		type: 'update',
		table: { type: 'identifier', name: alias },
		alias,
		targetSource,
		assignments: [{ column: setCol, value: val }],
	};
});

/** Inline-subquery DELETE target (`delete from (select …) as v [(cols)] [where …]`). */
const subqueryTargetDeleteArb: fc.Arbitrary<AST.DeleteStmt> = fc.tuple(
	subqueryBodyArb,
	identArb,
	fc.option(fc.array(identArb, { minLength: 1, maxLength: 3 }), { nil: undefined }),
).map(([subquery, alias, columns]): AST.DeleteStmt => {
	const targetSource: AST.SubquerySource = { type: 'subquerySource', subquery, alias };
	if (columns) targetSource.columns = columns;
	return {
		type: 'delete',
		table: { type: 'identifier', name: alias },
		alias,
		targetSource,
	};
});

// ------------------------------------------------------------------------
// Round-trip driver
// ------------------------------------------------------------------------

/**
 * Stringify, re-parse, and compare. On parser/stringifier exceptions or
 * comparator failures, augment the error with the original AST + SQL so
 * fast-check's shrinker has enough context to minimize.
 */
function checkRoundTrip<T extends AST.AstNode>(ast: T): void {
	let sql: string;
	try {
		sql = astToString(ast);
	} catch (e) {
		throw new Error(`Stringify failed for ${safeJsonStringify(ast)}: ${e instanceof Error ? e.message : String(e)}`);
	}
	let reparsed: AST.AstNode;
	try {
		reparsed = parse(sql) as AST.AstNode;
	} catch (e) {
		throw new Error(`Re-parse failed for AST=${safeJsonStringify(ast)}\n  SQL: ${sql}\n  err: ${e instanceof Error ? e.message : String(e)}`);
	}
	try {
		assertAstEquivalent(ast, reparsed);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		throw new Error(`${msg}\n  original AST: ${safeJsonStringify(ast)}\n  SQL:          ${sql}\n  reparsed AST: ${safeJsonStringify(reparsed)}`);
	}
}

// ------------------------------------------------------------------------
// Comparator self-tests — verify it catches drops and tolerates noise
// ------------------------------------------------------------------------

describe('AST round-trip comparator: self-tests', () => {
	it('ignores positional metadata', () => {
		const a: AST.LiteralExpr = { type: 'literal', value: 1 };
		const b: AST.LiteralExpr = {
			type: 'literal',
			value: 1,
			loc: { start: { line: 1, column: 0, offset: 0 }, end: { line: 1, column: 1, offset: 1 } },
		};
		assertAstEquivalent(a, b);
	});

	it('treats missing PK direction as equivalent to asc', () => {
		const a: AST.ColumnConstraint = { type: 'primaryKey' };
		const b: AST.ColumnConstraint = { type: 'primaryKey', direction: 'asc' };
		assertAstEquivalent(a, b);
	});

	it('flags a dropped CHECK operations list', () => {
		const a: AST.ColumnConstraint = {
			type: 'check',
			expr: { type: 'literal', value: 1 },
			operations: ['delete'],
		};
		const b: AST.ColumnConstraint = {
			type: 'check',
			expr: { type: 'literal', value: 1 },
		};
		expect(() => assertAstEquivalent(a, b)).to.throw(/operations/);
	});

	it('flags a wrong literal storage class (int vs string)', () => {
		const a: AST.LiteralExpr = { type: 'literal', value: 1 };
		const b: AST.LiteralExpr = { type: 'literal', value: '1' };
		expect(() => assertAstEquivalent(a, b)).to.throw(/value/);
	});

	it('case-folds identifier names', () => {
		const a: AST.IdentifierExpr = { type: 'identifier', name: 'Users' };
		const b: AST.IdentifierExpr = { type: 'identifier', name: 'users' };
		assertAstEquivalent(a, b);
	});

	it('treats undefined onConflict as ABORT', () => {
		const a: AST.ColumnConstraint = { type: 'notNull' };
		const b: AST.ColumnConstraint = { type: 'notNull', onConflict: ConflictResolution.ABORT };
		assertAstEquivalent(a, b);
	});

	it('treats empty CHECK operations array as missing', () => {
		const a: AST.ColumnConstraint = {
			type: 'check',
			expr: { type: 'literal', value: 1 },
			operations: [],
		};
		const b: AST.ColumnConstraint = {
			type: 'check',
			expr: { type: 'literal', value: 1 },
		};
		assertAstEquivalent(a, b);
	});

	it('tags compared key-set + value, order-insensitive', () => {
		astEquivalent(
			{ tags: { a: 1, b: 'x' } },
			{ tags: { b: 'x', a: 1 } },
		);
	});
});

// ------------------------------------------------------------------------
// Property suites — one `it` per AST family so failures localize.
// ------------------------------------------------------------------------

describe('AST round-trip property: DDL', () => {
	it('CREATE TABLE round-trips structurally', () => {
		fc.assert(fc.property(createTableArb, checkRoundTrip), { numRuns: 200 });
	});

	it('CREATE VIEW round-trips structurally', () => {
		fc.assert(fc.property(createViewArb, checkRoundTrip), { numRuns: 100 });
	});

	it('CREATE INDEX round-trips structurally', () => {
		fc.assert(fc.property(createIndexArb, checkRoundTrip), { numRuns: 100 });
	});

	it('CREATE ASSERTION round-trips structurally', () => {
		fc.assert(fc.property(createAssertionArb, checkRoundTrip), { numRuns: 50 });
	});

	it('ALTER TABLE round-trips structurally', () => {
		fc.assert(fc.property(alterTableArb, checkRoundTrip), { numRuns: 200 });
	});

	it('DROP round-trips structurally', () => {
		fc.assert(fc.property(dropArb, checkRoundTrip), { numRuns: 50 });
	});

	it('DECLARE SCHEMA round-trips structurally', () => {
		fc.assert(fc.property(declareSchemaArb, checkRoundTrip), { numRuns: 100 });
	});
});

describe('AST round-trip property: QueryExpr at every accepting site', () => {
	// Each suite drives `queryExprArb` (today: SELECT | VALUES) through a
	// distinct AST site that accepts a QueryExpr. The CREATE VIEW site is
	// covered above (`CREATE VIEW round-trips structurally`) — these add
	// coverage for the remaining sites widened by query-expr-ast-parser-
	// unification so a silent emitter drop on any one branch surfaces here
	// rather than only in the `.sqllogic` execution corpus.
	it('scalar SubqueryExpr in a SELECT column round-trips structurally', () => {
		fc.assert(fc.property(subqueryInColumnArb, checkRoundTrip), { numRuns: 100 });
	});

	it('InExpr.subquery in WHERE round-trips structurally', () => {
		fc.assert(fc.property(inSubqueryArb, checkRoundTrip), { numRuns: 100 });
	});

	it('ExistsExpr.subquery in WHERE round-trips structurally', () => {
		fc.assert(fc.property(existsSubqueryArb, checkRoundTrip), { numRuns: 100 });
	});

	it('SelectStmt.compound leg round-trips structurally', () => {
		fc.assert(fc.property(compoundSelectArb, checkRoundTrip), { numRuns: 100 });
	});

	it('SubquerySource.subquery in FROM round-trips structurally', () => {
		fc.assert(fc.property(subquerySourceArb, checkRoundTrip), { numRuns: 100 });
	});

	it('CommonTableExpr.query body round-trips structurally', () => {
		fc.assert(fc.property(cteSelectArb, checkRoundTrip), { numRuns: 100 });
	});

	it('ResultColumnExpr.inverse (alias ⨯ clause ⨯ multi-column) round-trips structurally', () => {
		fc.assert(fc.property(selectWithInverseArb, checkRoundTrip), { numRuns: 200 });
	});
});

describe('AST round-trip property: transactional + misc', () => {
	it('transaction statements round-trip structurally', () => {
		fc.assert(fc.property(transactionStmtArb, checkRoundTrip), { numRuns: 50 });
	});

	it('PRAGMA round-trips structurally', () => {
		fc.assert(fc.property(pragmaArb, checkRoundTrip), { numRuns: 50 });
	});

	it('ANALYZE round-trips structurally', () => {
		fc.assert(fc.property(analyzeArb, checkRoundTrip), { numRuns: 50 });
	});

	it('ANALYZE schema.* parses to the schema-only shape', () => {
		const stmt = parse('ANALYZE main.*') as AST.AnalyzeStmt;
		expect(stmt.type).to.equal('analyze');
		expect(stmt.schemaName).to.equal('main');
		expect(stmt.tableName).to.equal(undefined);
	});

	it('schema-only ANALYZE round-trips a schema name that requires quoting', () => {
		// The structural property test only samples safe lowercase idents, so it
		// never exercises the quoteIdentifier + `.*` emit path. A reserved word as
		// the schema name forces quoting and confirms the quoted `.*` form re-parses
		// back to the same schema-only shape.
		const ast: AST.AnalyzeStmt = { type: 'analyze', schemaName: 'select' };
		const sql = astToString(ast);
		expect(sql).to.include('.*');
		const reparsed = parse(sql) as AST.AnalyzeStmt;
		expect(reparsed.schemaName).to.equal('select');
		expect(reparsed.tableName).to.equal(undefined);
	});
});

describe('AST round-trip property: DML smoke', () => {
	it('INSERT round-trips structurally', () => {
		fc.assert(fc.property(insertArb, checkRoundTrip), { numRuns: 50 });
	});

	it('UPDATE round-trips structurally', () => {
		fc.assert(fc.property(updateArb, checkRoundTrip), { numRuns: 50 });
	});

	it('DELETE round-trips structurally', () => {
		fc.assert(fc.property(deleteArb, checkRoundTrip), { numRuns: 50 });
	});

	it('UPDATE with an inline-subquery target round-trips structurally', () => {
		fc.assert(fc.property(subqueryTargetUpdateArb, checkRoundTrip), { numRuns: 50 });
	});

	it('DELETE with an inline-subquery target round-trips structurally', () => {
		fc.assert(fc.property(subqueryTargetDeleteArb, checkRoundTrip), { numRuns: 50 });
	});
});
