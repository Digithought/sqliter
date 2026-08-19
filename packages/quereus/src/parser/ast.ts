import type { MaybePromise, RowOp, SqlValue } from '../common/types.js';
import type { ConflictResolution } from '../common/constants.js';

/**
 * SQL Abstract Syntax Tree (AST) definitions
 * These interfaces define the structure of parsed SQL statements
 */

// Base for all AST nodes
export interface AstNode {
	type: 'literal' | 'identifier' | 'column' | 'binary' | 'unary' | 'function' | 'cast' | 'parameter' | 'subquery' | 'select'
		| 'insert' | 'update' | 'delete' | 'createTable' | 'createIndex' | 'createView' | 'createMaterializedView' | 'refreshMaterializedView' | 'createAssertion' | 'alterTable' | 'alterView' | 'alterMaterializedView' | 'alterIndex' | 'drop' | 'begin' | 'commit'
		| 'rollback' | 'table' | 'join' | 'savepoint' | 'release' | 'functionSource' | 'with' | 'commonTableExpr' | 'pragma'
		| 'collate' | 'primaryKey' | 'notNull' | 'null' | 'unique' | 'check' | 'default' | 'foreignKey' | 'generated' | 'windowFunction'
		| 'windowDefinition' | 'windowFrame' | 'currentRow' | 'unboundedPreceding' | 'unboundedFollowing' | 'preceding' | 'following'
		| 'subquerySource' | 'case' | 'in' | 'exists' | 'values' | 'between'
		| 'declareSchema' | 'declareLens' | 'diffSchema' | 'applySchema' | 'explainSchema'
		| 'declaredTable' | 'declaredIndex' | 'declaredView' | 'declaredMaterializedView' | 'declaredSeed' | 'declaredAssertion' | 'declareIgnored' | 'upsert'
		| 'analyze';
	loc?: {
		start: { line: number, column: number, offset: number };
		end: { line: number, column: number, offset: number };
	};
}

// Expression types
export type Expression = LiteralExpr | IdentifierExpr | BinaryExpr | UnaryExpr | FunctionExpr | CastExpr
	| ParameterExpr | SubqueryExpr | ColumnExpr | FunctionSource | CollateExpr | WindowFunctionExpr | CaseExpr
	| InExpr | ExistsExpr | BetweenExpr;

// Literal value expression (number, string, null, etc.)
export interface LiteralExpr extends AstNode {
	type: 'literal';
	value: MaybePromise<SqlValue>;
	lexeme?: string; // Optional: Original text representation, e.g., for numbers like '2.0'
}

// Identifier expression (table name or pragma name)
export interface IdentifierExpr extends AstNode {
	type: 'identifier';
	name: string;
	schema?: string; // Optional schema qualifier
}

// Column reference expression
export interface ColumnExpr extends AstNode {
	type: 'column';
	name: string;
	table?: string;  // Optional table qualifier
	schema?: string; // Optional schema qualifier
	alias?: string;  // Optional column alias
}

// Binary operation expression
export interface BinaryExpr extends AstNode {
	type: 'binary';
	operator: string; // +, -, *, /, AND, OR, =, <, etc.
	left: Expression;
	right: Expression;
}

// Unary operation expression
export interface UnaryExpr extends AstNode {
	type: 'unary';
	operator: string; // NOT, -, +, etc.
	expr: Expression;
}

// Function call expression
export interface FunctionExpr extends AstNode {
	type: 'function';
	name: string;
	args: Expression[];
	distinct?: boolean; // For DISTINCT in aggregate functions like COUNT(DISTINCT col)
}

// Window function expression
export interface WindowFunctionExpr extends AstNode {
	type: 'windowFunction';
	function: FunctionExpr;
	window?: WindowDefinition;
	alias?: string;
}

// Window definition (OVER clause)
export interface WindowDefinition extends AstNode {
	type: 'windowDefinition';
	partitionBy?: Expression[];
	orderBy?: OrderByClause[];
	frame?: WindowFrame;
}

// Window frame clause
export interface WindowFrame {
	type: WindowFrameUnits; // Changed from 'windowFrame' to WindowFrameUnits
	start: WindowFrameBound;
	end: WindowFrameBound | null; // Can be just START bound
	exclusion?: WindowFrameExclusion;
}

// Window frame bound
export type WindowFrameBound =
	| { type: 'currentRow' }
	| { type: 'unboundedPreceding' }
	| { type: 'unboundedFollowing' }
	| { type: 'preceding', value: Expression }
	| { type: 'following', value: Expression };

// Window frame units
export type WindowFrameUnits = 'rows' | 'range';

// Window frame exclusion
export type WindowFrameExclusion = 'no others' | 'current row' | 'group' | 'ties';

// CAST expression
export interface CastExpr extends AstNode {
	type: 'cast';
	expr: Expression;
	targetType: string;
}

// Parameter expression (? or :name or $name)
export interface ParameterExpr extends AstNode {
	type: 'parameter';
	index?: number;  // For positional parameters (?)
	name?: string;   // For named parameters (:name or $name)
}

// Subquery expression
export interface SubqueryExpr extends AstNode {
	type: 'subquery';
	query: QueryExpr;
}

// BETWEEN expression
export interface BetweenExpr extends AstNode {
	type: 'between';
	expr: Expression;      // Left side of BETWEEN
	lower: Expression;     // Lower bound
	upper: Expression;     // Upper bound
	not?: boolean;         // For NOT BETWEEN
}

// IN expression
export interface InExpr extends AstNode {
	type: 'in';
	expr: Expression;  // Left side of IN
	values?: Expression[];  // For IN (value1, value2, ...)
	subquery?: QueryExpr;  // For IN (SELECT/VALUES/INSERT/UPDATE/DELETE …)
}

// EXISTS expression
export interface ExistsExpr extends AstNode {
	type: 'exists';
	subquery: QueryExpr;  // EXISTS (SELECT/VALUES/INSERT/UPDATE/DELETE …)
}

// --- Statement Types ---

// --- Add FunctionSource type ---
export interface FunctionSource extends AstNode {
	type: 'functionSource';
	name: IdentifierExpr; // Function name (potentially schema.name)
	args: Expression[];    // Arguments passed to the function
	alias?: string;        // Optional alias for the generated table
	columns?: string[];    // Optional column list after alias: alias(col1, col2, ...)
}

// SELECT statement
export interface SelectStmt extends AstNode {
	type: 'select';
	withClause?: WithClause;
	columns: ResultColumn[];
	from?: FromClause[];
	where?: Expression;
	groupBy?: Expression[];
	having?: Expression;
	orderBy?: OrderByClause[];
	limit?: Expression;
	offset?: Expression;
	distinct?: boolean;
	all?: boolean;
	union?: SelectStmt;
	unionAll?: boolean;
	compound?: { op: 'union' | 'unionAll' | 'intersect' | 'except' | 'diff'; select: QueryExpr; existence?: ReadonlyArray<SetOpMembershipColumn> };
	schemaPath?: string[]; // Optional schema search path from WITH SCHEMA clause
	/**
	 * Optional trailing `with defaults (col = expr, …)` clause — per-column
	 * omitted-insert defaults for view write-through. Binds to the WHOLE compound
	 * (like trailing `order by`), so it is parsed only in non-compound-leg
	 * position and never lands on a leg. Inert metadata wherever no write path
	 * consumes it (a bare top-level select, a VALUES view body); the view INSERT
	 * write-through rewrite and `view_info`'s insertability derivation pull it
	 * from the stored body AST. See {@link ViewInsertDefault} and
	 * docs/vu-inverses.md § View defaults.
	 */
	defaults?: ReadonlyArray<ViewInsertDefault>;
	/**
	 * The naming environment of the stored view / materialized-view body this
	 * sub-select was copied out of. See {@link StoredBodyEnv}. Never set by the
	 * parser and inert everywhere else.
	 */
	storedBodyEnv?: StoredBodyEnv;
}

/**
 * The whole naming environment of a stored view / materialized-view body, carried on a
 * sub-select the write-through lowering copied out of that body.
 *
 * Write-through lowering metadata ONLY; never set by the parser. A write through a view
 * is not executed as the body plan — it is *lowered* into a plain INSERT/UPDATE/DELETE
 * against the base table, and definition-derived fragments (the view's own `where`, each
 * view column's base-term expression, an authored `with inverse` put, a `with defaults`
 * value) are copied into that lowered statement. The result is a mix of caller-authored
 * clauses and definition-derived fragments planned on ONE (the caller's) context, so
 * "which naming environment does this piece belong to" cannot ride the context — it rides
 * the AST node. `buildViewMutation` stamps this object onto every nested sub-select of the
 * cloned body (via `mapNestedSelects`, `planner/mutation/scope-transform.ts`) and
 * `enterStoredBodyEnv` (`planner/building/select-context.ts`), called at the top of
 * `buildSelectStmt`, consumes it.
 *
 * The three pieces are always stamped together and consumed together, in a fixed ORDER
 * (home swap → declared path → carried `with` clause) — hence one object rather than three
 * parallel optional fields, so a fourth piece cannot be silently missed. See
 * docs/view-updateability.md § Schema resolution during write-through.
 */
export interface StoredBodyEnv {
	/**
	 * Schema the stored view / MV this fragment was copied out of lives in. Without it
	 * a sub-select inside a fragment resolves its `from` names on the CALLER's search
	 * path: a non-`main` view fails outright, and a `main` view under a session path
	 * that reaches a same-named table silently writes the wrong row set.
	 * `buildSelectStmt` re-enters the object's home environment (`storedBodyContext`)
	 * for the marked fragment.
	 */
	readonly homeSchema: string;
	/**
	 * The definition's declared `with schema` path, when it has one. It lives on the
	 * body's top-level `SelectStmt` — which is not one of the copied pieces — so
	 * without the carry a fragment resolves on the plain home path and the write
	 * disagrees with the read of the same view about which tables exist. Applied AFTER
	 * the home swap and BEFORE the carried `with` clause is built, so a carried block's
	 * own sources see the declared path too. A fragment's OWN `with schema` clause
	 * (`SelectStmt.schemaPath`) still wins over this.
	 */
	readonly schemaPath?: string[];
	/**
	 * The definition's own leading `with` clause, when it has one. Re-entering the
	 * body's home naming environment clears the caller's CTE namespace, so a copied
	 * sub-select that reads a body-local CTE would otherwise have nothing to bind to.
	 * `buildSelectStmt` builds these definitions on the home context and hands them in
	 * as the fragment's parent CTE namespace (the fragment's OWN `with` clause still
	 * shadows them).
	 */
	readonly withClause?: WithClause;
}

/**
 * UPSERT clause for INSERT statements.
 * Specifies conflict handling with optional column-level updates.
 *
 * Syntax:
 *   ON CONFLICT [(column, ...)] DO NOTHING
 *   ON CONFLICT [(column, ...)] DO UPDATE SET col = expr, ... [WHERE condition]
 */
export interface UpsertClause extends AstNode {
	type: 'upsert';
	/** Conflict target columns. If undefined, matches any unique constraint. */
	conflictTarget?: string[];
	/** Action to take on conflict: 'nothing' skips the row, 'update' performs column updates */
	action: 'nothing' | 'update';
	/** For 'update' action: column assignments (col = expr) */
	assignments?: { column: string; value: Expression }[];
	/** For 'update' action: optional WHERE condition to control when update applies */
	where?: Expression;
}

// INSERT statement
export interface InsertStmt extends AstNode {
	type: 'insert';
	withClause?: WithClause;
	table: IdentifierExpr;
	columns?: string[];
	/**
	 * Source rows for the insert — a SELECT, a VALUES, or another DML with
	 * RETURNING. Replaces the legacy `values` / `select` pair: bare
	 * `INSERT … VALUES (…), (…)` parses as a `ValuesStmt` here.
	 */
	source: QueryExpr;
	/** Legacy conflict resolution (INSERT OR REPLACE, etc.) - mutually exclusive with upsertClauses */
	onConflict?: ConflictResolution;
	/** UPSERT clauses (ON CONFLICT DO ...) - mutually exclusive with onConflict */
	upsertClauses?: UpsertClause[];
	returning?: ResultColumn[];
	contextValues?: ContextAssignment[]; // Optional mutation context assignments
	schemaPath?: string[]; // Optional schema search path from WITH SCHEMA clause
	tags?: Record<string, SqlValue>; // Optional WITH TAGS clause — statement-level metadata tags (reserved keys validated at the dml-stmt site)
}

// UPDATE statement
export interface UpdateStmt extends AstNode {
	type: 'update';
	withClause?: WithClause;
	table: IdentifierExpr;
	/**
	 * Inline parenthesized subquery target: `update (select …) as v set …`. Mutually
	 * exclusive with a named/CTE `table`. Routes the subquery body through the same
	 * view-mutation substrate a named view / CTE target uses (an ephemeral view-like).
	 * Its `alias` is the mandatory correlation name (the `where`/`set` reference its
	 * columns via `v.col`), and `columns` carries an optional `as v(a,b)` rename list.
	 * When set, the parser also fills {@link table} with a synthetic placeholder
	 * identifier equal to the alias (so generic `stmt.table.name` reads stay total) and
	 * {@link alias} with the same correlation name.
	 */
	targetSource?: SubquerySource;
	/**
	 * Correlation name for the target. Synthesised by the view-mutation single-source
	 * lowering to give the lowered UPDATE target a collision-proof alias, so a
	 * substituted subquery-descent base term qualified with it binds the outer target
	 * row even when the user subquery FROM names the same base table. Also carries the
	 * user-written alias of an inline subquery target ({@link targetSource}) — the one
	 * place `UPDATE … AS x` reaches the AST.
	 */
	alias?: string;
	assignments: { column: string; value: Expression }[];
	where?: Expression;
	returning?: ResultColumn[];
	contextValues?: ContextAssignment[]; // Optional mutation context assignments
	schemaPath?: string[]; // Optional schema search path from WITH SCHEMA clause
	tags?: Record<string, SqlValue>; // Optional WITH TAGS clause — statement-level metadata tags (reserved keys validated at the dml-stmt site)
}

// DELETE statement
export interface DeleteStmt extends AstNode {
	type: 'delete';
	withClause?: WithClause;
	table: IdentifierExpr;
	/**
	 * Inline parenthesized subquery target: `delete from (select …) as v where …`.
	 * Mutually exclusive with a named/CTE `table`. Routes the subquery body through the
	 * same view-mutation substrate a named view / CTE target uses (an ephemeral
	 * view-like). Its `alias` is the mandatory correlation name (the `where` references
	 * its columns via `v.col`), and `columns` carries an optional `as v(a,b)` rename
	 * list. When set, the parser also fills {@link table} with a synthetic placeholder
	 * identifier equal to the alias and {@link alias} with the same correlation name.
	 */
	targetSource?: SubquerySource;
	/**
	 * Correlation name for the target. Synthesised by the view-mutation single-source
	 * lowering to give the lowered DELETE target a collision-proof alias, so a
	 * substituted subquery-descent base term qualified with it binds the outer target
	 * row even when the user subquery FROM names the same base table. Also carries the
	 * user-written alias of an inline subquery target ({@link targetSource}) — the one
	 * place `DELETE FROM … AS x` reaches the AST.
	 */
	alias?: string;
	where?: Expression;
	returning?: ResultColumn[];
	contextValues?: ContextAssignment[]; // Optional mutation context assignments
	schemaPath?: string[]; // Optional schema search path from WITH SCHEMA clause
	tags?: Record<string, SqlValue>; // Optional WITH TAGS clause — statement-level metadata tags (reserved keys validated at the dml-stmt site)
}

// VALUES statement
export interface ValuesStmt extends AstNode {
	type: 'values';
	values: Expression[][]; // Array of value lists: VALUES (1, 'a'), (2, 'b'), ...
}

/**
 * Query expression — anything that produces a relation. The orthogonal shape
 * accepted everywhere a relation is allowed (top-level statement, FROM
 * subquery source, scalar / IN / EXISTS subquery, compound-set legs, CTE
 * body, view body).
 *
 * DML forms (INSERT/UPDATE/DELETE) qualify only when they carry a RETURNING
 * clause; the parser enforces this at non-top-level positions. DML in
 * scalar / IN / EXISTS / compound-leg / CTE-body / FROM-source positions
 * executes with full-drain + run-once semantics (see `docs/runtime.md`).
 * DML as a view body is rejected at view-creation time — a view body
 * re-evaluates on every reference and re-driving the write per read is
 * incoherent.
 */
export type QueryExpr =
	| SelectStmt
	| ValuesStmt
	| InsertStmt
	| UpdateStmt
	| DeleteStmt;

/**
 * The `maintained [(columns)] as <body>` clause of a CREATE TABLE — declares the
 * table as a **maintained table** (the canonical table form of a materialized
 * view): the declared column/PK shape is the frozen basis and the body must
 * derive exactly that shape. The optional `(columns)` is the explicit
 * output-column rename list (see `columns` below). Any omitted-insert defaults
 * ride inside the body select's trailing `with defaults (…)` clause
 * ({@link SelectStmt.defaults}). Clause order:
 * `(columns) → using → maintained [(columns)] as <body … with defaults> → with tags`.
 * `maintained` is contextual (no new reserved word).
 */
export interface MaintainedClause {
	/**
	 * Explicit output-column rename list (`maintained (a, b) as …`) — the lossless
	 * table-form encoding of the MV-sugar rename list. Absent ⇒ implicit: the body
	 * follows its source shape, so a widened `select *` reshapes on reopen instead
	 * of arity-erroring against a stale declared list.
	 */
	columns?: ReadonlyArray<string>;
	/** Derivation body — any relation-producing QueryExpr. Carries its own
	 *  `with defaults (…)` clause when present ({@link SelectStmt.defaults}). */
	select: QueryExpr;
}

// CREATE TABLE statement
export interface CreateTableStmt extends AstNode {
	type: 'createTable';
	table: IdentifierExpr;
	ifNotExists: boolean;
	columns: ColumnDef[];
	constraints: TableConstraint[];
	moduleName?: string;   // Optional module name from USING clause
	moduleArgs?: Record<string, SqlValue>; // Optional module arguments from USING clause
	contextDefinitions?: MutationContextVar[]; // Optional mutation context variables
	tags?: Record<string, SqlValue>; // Optional metadata tags from WITH TAGS clause
	/** Optional `maintained as <body>` clause — declares a maintained table (declared-shape form). */
	maintained?: MaintainedClause;
}

// CREATE INDEX statement
export interface CreateIndexStmt extends AstNode {
	type: 'createIndex';
	index: IdentifierExpr;
	table: IdentifierExpr;
	ifNotExists: boolean;
	columns: IndexedColumn[];
	where?: Expression;
	isUnique?: boolean;
	tags?: Record<string, SqlValue>; // Optional metadata tags from WITH TAGS clause
}

// CREATE ASSERTION statement
export interface CreateAssertionStmt extends AstNode {
	type: 'createAssertion';
	name: IdentifierExpr; // Possibly schema-qualified assertion name
	check: Expression; // The CHECK (<violation-query>) expression
}

/**
 * One entry of a select body's `with defaults (col = expr, …)` clause: a
 * per-column default supplied when an insert through the view omits the column.
 * The column may name a base column the view projects away or a base-lineage
 * view column. Stored on {@link SelectStmt.defaults}.
 */
export interface ViewInsertDefault {
	column: string;
	expr: Expression;
}

// CREATE VIEW statement
export interface CreateViewStmt extends AstNode {
	type: 'createView';
	view: IdentifierExpr;
	ifNotExists: boolean;
	columns?: string[];
	/** View body — any relation-producing form. Bare `VALUES (...)` is permitted.
	 *  Carries its own trailing `with defaults (…)` clause when present
	 *  ({@link SelectStmt.defaults}). */
	select: QueryExpr;
	tags?: Record<string, SqlValue>; // Optional metadata tags from WITH TAGS clause
}

// CREATE MATERIALIZED VIEW statement
export interface CreateMaterializedViewStmt extends AstNode {
	type: 'createMaterializedView';
	view: IdentifierExpr;
	ifNotExists: boolean;
	columns?: string[];
	/** View body — any relation-producing form. Bare `VALUES (...)` is permitted. */
	select: QueryExpr;
	/** Optional backing-module name from a `USING mod(...)` clause. v1 only accepts `memory`. */
	moduleName?: string;
	/** Optional backing-module arguments (forward-compatible; ignored in v1). */
	moduleArgs?: Record<string, SqlValue>;
	tags?: Record<string, SqlValue>; // Optional metadata tags from WITH TAGS clause
}

// REFRESH MATERIALIZED VIEW statement
export interface RefreshMaterializedViewStmt extends AstNode {
	type: 'refreshMaterializedView';
	name: IdentifierExpr;
}

// ALTER TABLE statement
export interface AlterTableStmt extends AstNode {
	type: 'alterTable';
	table: IdentifierExpr;
	action: AlterTableAction;
}

/**
 * ALTER VIEW / ALTER MATERIALIZED VIEW / ALTER INDEX … {SET|ADD|DROP} TAGS —
 * a metadata-tag mutation on the named object itself (the object is the
 * statement's own `name`, not a sub-site, so unlike the ALTER TABLE union there
 * is no `target` field). Mirrors the ALTER TABLE tag-mutation semantics:
 *   - `setTags` with `mode:'replace'` (SET TAGS): whole-set replacement; `tags`
 *     is the complete desired set and an empty record clears all tags.
 *   - `setTags` with `mode:'merge'` (ADD TAGS): per-key merge; set/overwrite the
 *     listed keys and keep the rest. An empty list is a no-op (it does NOT
 *     clear — that distinguishes `ADD TAGS ()` from `SET TAGS ()`).
 *   - `dropTags` (DROP TAGS): per-key deletion. Atomic — every listed key must
 *     currently be present, else a NOTFOUND error names the missing key(s) and
 *     nothing is dropped. Dropping the last key(s) leaves `tags IS NULL`. An
 *     empty list is a no-op. Key matching is verbatim (case-sensitive). DROP
 *     does NO value validation — dropping a reserved `quereus.*` key is legit.
 * All forms are catalog-only (no module / data round-trip, no re-materialize).
 */
export type AlterObjectTagsAction =
	| { type: 'setTags'; mode: 'replace' | 'merge'; tags: Record<string, SqlValue> }
	| { type: 'dropTags'; keys: string[] };

export interface AlterViewStmt extends AstNode {
	type: 'alterView';
	name: IdentifierExpr;
	action: AlterObjectTagsAction;
}

export interface AlterMaterializedViewStmt extends AstNode {
	type: 'alterMaterializedView';
	name: IdentifierExpr;
	action: AlterObjectTagsAction;
}

export interface AlterIndexStmt extends AstNode {
	type: 'alterIndex';
	name: IdentifierExpr;
	action: AlterObjectTagsAction;
}

// DROP statement
export interface DropStmt extends AstNode {
	type: 'drop';
	objectType: 'table' | 'view' | 'materializedView' | 'index' | 'trigger' | 'assertion';
	name: IdentifierExpr;
	ifExists: boolean;
}

// TRANSACTION statements
export interface BeginStmt extends AstNode {
	type: 'begin';
}

export interface CommitStmt extends AstNode {
	type: 'commit';
}

export interface RollbackStmt extends AstNode {
	type: 'rollback';
	savepoint?: string;
}

// --- Add Savepoint/Release ---
export interface SavepointStmt extends AstNode {
    type: 'savepoint';
    name: string;
}

export interface ReleaseStmt extends AstNode {
    type: 'release';
    savepoint?: string; // Optional savepoint name
}

// --- Supporting Types ---

/**
 * One assignment of a result column's `with inverse (col = expr, …)` clause: an
 * authored write-back expression computing a FROM-source base column from the
 * written view row (referenced via `new.<output-col>`). Inert metadata until the
 * view write path consumes it; shape mirrors {@link ViewInsertDefault}.
 * See docs/vu-inverses.md § Authored inverses.
 */
export interface ResultColumnInverse {
	column: string;
	expr: Expression;
}

export type ResultColumnExpr = {
	type: 'column',
	expr: Expression,
	alias?: string,
	/** Optional `with inverse (col = expr, …)` clause — authored write-back expressions for view write-through. */
	inverse?: ReadonlyArray<ResultColumnInverse>,
}

// Result column in SELECT
export type ResultColumn =
	| { type: 'all', table?: string }
	| ResultColumnExpr;

// FROM clause item (table, join, function call, or subquery)
export type FromClause = TableSource | JoinClause | FunctionSource | SubquerySource;

// Table source in FROM clause
export interface TableSource extends AstNode {
	type: 'table';
	table: IdentifierExpr;
	alias?: string;
}

/**
 * Subquery source in FROM clause: `(SELECT/VALUES/INSERT/UPDATE/DELETE …) AS alias`.
 * The body is any `QueryExpr`. When the body is a DML statement it must carry
 * RETURNING (enforced at parse time outside top-level position). The planner
 * dispatches on `subquery.type` to choose the read vs mutating pipeline.
 */
export interface SubquerySource extends AstNode {
	type: 'subquerySource';
	subquery: QueryExpr;
	alias: string;
	columns?: string[]; // Optional column list: AS alias(col1, col2, ...)
}

/**
 * One `exists [<side>] as <name>` existence-column clause on a join (Dataphor
 * `include rowexists`). The flag reifies whether the non-preserved `side`
 * matched the current row — a clean `{true,false}` boolean derived at the
 * combinator (NOT a null-extended constant). `side` is the resolved
 * non-preserved side (the parser resolves the elided form against the join
 * type), so it is always explicit in the AST and round-trips unambiguously.
 */
export interface JoinExistenceColumn {
	side: 'left' | 'right';
	name: string;
}

/**
 * One `<setop> exists <branch> as <name>` membership-column clause on a compound
 * set operation (the vertical/row analogue of {@link JoinExistenceColumn}). The
 * flag reifies whether the result tuple is a member of the named immediate
 * `branch` of the binary combinator — a clean `{true,false}` boolean derived AT
 * THE COMBINATOR by a per-branch semijoin probe (NOT a stored operand column,
 * which would re-enter the union schema and dedup). `branch` is `left` (the leg
 * before the operator) or `right` (the operand after the clause). Read-only in
 * this half (`set-op-membership-read`); the write half flips the column to a
 * branch insert/delete. Rejected on `diff` (ambiguous over its two `except`s).
 */
export interface SetOpMembershipColumn {
	branch: 'left' | 'right';
	name: string;
}

// JOIN clause in FROM
export interface JoinClause extends AstNode {
	type: 'join';
	joinType: 'inner' | 'left' | 'right' | 'full' | 'cross';
	left: FromClause;
	right: FromClause;
	condition?: Expression; // For ON clause
	columns?: string[];     // For USING clause
	/** Right side is a LATERAL (correlated) subquery — the left's columns are visible inside. */
	isLateral?: boolean;
	/** `exists [<side>] as <name>` existence columns derived at the combinator (read-only here). */
	existence?: ReadonlyArray<JoinExistenceColumn>;
}

// ORDER BY clause
export interface OrderByClause {
	expr: Expression;
	direction: 'asc' | 'desc';
	nulls?: 'first' | 'last';
}

// Column definition in CREATE TABLE
export interface ColumnDef {
	name: string;
	dataType?: string;
	constraints: ColumnConstraint[];
	tags?: Record<string, SqlValue>; // Optional metadata tags from WITH TAGS clause
}

// Mutation context variable definition
export interface MutationContextVar {
	name: string;
	dataType?: string;
	notNull?: boolean;
}

// Mutation context assignment
export interface ContextAssignment {
	name: string;
	value: Expression;
}

// Column constraint (PRIMARY KEY, NOT NULL, etc.)
export interface ColumnConstraint extends AstNode {
	type: 'primaryKey' | 'notNull' | 'null' | 'unique' | 'check' | 'default' | 'foreignKey' | 'collate' | 'generated';
	name?: string;
	expr?: Expression;          // For CHECK or DEFAULT
	operations?: RowOp[];       // ADDED: For CHECK ON (...)
	collation?: string;         // For COLLATE
	direction?: 'asc' | 'desc'; // ADDED: For PRIMARY KEY ASC/DESC
	onConflict?: ConflictResolution;
	foreignKey?: ForeignKeyClause;
	generated?: {
		expr: Expression;
		stored: boolean;          // STORED or VIRTUAL
	};
	tags?: Record<string, SqlValue>; // Optional metadata tags from WITH TAGS clause
}

// Table constraint (PRIMARY KEY, UNIQUE, etc.)
export interface TableConstraint extends AstNode {
	type: 'primaryKey' | 'unique' | 'check' | 'foreignKey';
	name?: string;
	columns?: { name: string; direction?: 'asc' | 'desc' }[];
	expr?: Expression;         // For CHECK
	operations?: RowOp[];       // ADDED: For CHECK ON (...)
	onConflict?: ConflictResolution;
	foreignKey?: ForeignKeyClause;
	tags?: Record<string, SqlValue>; // Optional metadata tags from WITH TAGS clause
}

// Foreign key clause
export interface ForeignKeyClause {
	table: string;
	schema?: string;           // Optional parent schema qualifier (cross-schema FK)
	columns?: string[];
	onDelete?: ForeignKeyAction;
	onUpdate?: ForeignKeyAction;
	deferrable?: boolean;
	initiallyDeferred?: boolean;
}

// Foreign key action
export type ForeignKeyAction = 'setNull' | 'setDefault' | 'cascade' | 'restrict';

// Column in index definition
export interface IndexedColumn {
	name?: string;  // Column name
	expr?: Expression;  // Or expression
	collation?: string;
	direction?: 'asc' | 'desc';
}

// Alter table action
export type AlterTableAction =
	| { type: 'renameTable', newName: string }
	| { type: 'renameColumn', oldName: string, newName: string }
	| { type: 'addColumn', column: ColumnDef }
	| { type: 'dropColumn', name: string }
	| { type: 'addConstraint', constraint: TableConstraint }
	| { type: 'dropConstraint', name: string }
	| { type: 'renameConstraint', oldName: string, newName: string }
	| { type: 'alterPrimaryKey', columns: Array<{ name: string; direction?: 'asc' | 'desc' }> }
	| {
		/**
		 * ALTER COLUMN <name> [SET NOT NULL | DROP NOT NULL | SET DATA TYPE <type> | SET DEFAULT <expr> | DROP DEFAULT].
		 * Each statement sets exactly one attribute — only one of the optional fields is populated.
		 */
		type: 'alterColumn',
		columnName: string,
		setNotNull?: boolean,          // true = SET NOT NULL, false = DROP NOT NULL
		setDataType?: string,
		setDefault?: Expression | null, // null = DROP DEFAULT, Expression = SET DEFAULT
		setCollation?: string          // SET COLLATE <name> — re-sorts dependent PK / UNIQUE / index structures
	}
	| {
		/**
		 * ALTER TABLE … SET TAGS / ADD TAGS — metadata-tag mutation on the table
		 * itself, one of its columns, or one of its named table-level constraints.
		 * `mode` selects the semantics:
		 *   - `'replace'` (SET TAGS): whole-set replacement; `tags` is the complete
		 *     desired tag set and an empty record clears all tags.
		 *   - `'merge'` (ADD TAGS): per-key merge; set/overwrite the listed keys and
		 *     keep the rest. An empty list is a no-op (it does NOT clear — that
		 *     distinguishes `ADD TAGS ()` from `SET TAGS ()`).
		 * Tags are catalog-only metadata (no stored-row / physical effect), so this
		 * never round-trips through `module.alterTable`.
		 */
		type: 'setTags',
		target:
			| { kind: 'table' }
			| { kind: 'column'; columnName: string }
			| { kind: 'constraint'; constraintName: string },
		mode: 'replace' | 'merge',
		tags: Record<string, SqlValue> // replace: empty = clear; merge: empty = no-op
	}
	| {
		/**
		 * ALTER TABLE … DROP TAGS — per-key deletion of the metadata tags on the
		 * table itself, one of its columns, or one of its named table-level
		 * constraints. `keys` is the bare list of tag keys to remove (no `= value`).
		 * Atomic: every listed key must currently be present, else a NOTFOUND error
		 * names the missing key(s) and nothing is dropped. Dropping the last
		 * remaining key(s) leaves `tags IS NULL`. An empty list is a no-op. Key
		 * matching is verbatim (case-sensitive). Catalog-only like SET/ADD TAGS, with
		 * no value validation — dropping a reserved `quereus.*` key is legitimate.
		 */
		type: 'dropTags',
		target:
			| { kind: 'table' }
			| { kind: 'column'; columnName: string }
			| { kind: 'constraint'; constraintName: string },
		keys: string[] // empty list = no-op
	}
	| {
		/**
		 * ALTER TABLE … SET MAINTAINED [(cols)] AS <body> — attach (or, on an
		 * already-maintained table, atomically replace) a derivation. Any
		 * omitted-insert defaults ride inside the body select's trailing
		 * `with defaults (…)` clause ({@link SelectStmt.defaults}). The optional
		 * `(cols)` is the explicit output-column rename list (the differ's lossless
		 * encoding of an MV-sugar `(a, c)` rename):
		 * present ⇒ the body outputs are renamed positionally to it, the list is
		 * recorded as `derivation.columns`, and a same-arity name drift reshapes
		 * (renames) the backing in place; absent ⇒ the implicit form (the body's
		 * natural names, may reshape the backing to follow the body). Attach
		 * reconciles the table's current contents against the derived contents by
		 * keyed diff (derived content wins). There is deliberately no `using`
		 * clause — the module is the table's identity and never changes via attach.
		 */
		type: 'setMaintained',
		columns?: ReadonlyArray<string>,
		select: QueryExpr
	}
	| {
		/**
		 * ALTER TABLE … DROP MAINTAINED — detach the derivation. Nothing physical
		 * changes: the table keeps its rows, row-time maintenance stops, and the
		 * table becomes an ordinary user-writable table.
		 */
		type: 'dropMaintained'
	};

// Add PragmaStmt interface
export interface PragmaStmt extends AstNode {
	type: 'pragma';
	name: string; // Name of the pragma
	value?: LiteralExpr | IdentifierExpr; // Value being assigned (optional for some pragmas)
}

export interface AnalyzeStmt extends AstNode {
	type: 'analyze';
	/** Optional table name. If omitted, all tables in the schema are analyzed. */
	tableName?: string;
	/** Optional schema qualifier (e.g., "main") */
	schemaName?: string;
}

export interface WithClause extends AstNode {
	type: 'with';
	recursive: boolean;
	ctes: CommonTableExpr[];
	options?: WithClauseOptions;
}

export interface WithClauseOptions {
	maxRecursion?: number;
}

export interface CommonTableExpr extends AstNode {
	type: 'commonTableExpr';
	name: string;
	columns?: string[];
	/** CTE body — any relation-producing form. DML bodies must carry RETURNING. */
	query: QueryExpr;
	materializationHint?: 'materialized' | 'not_materialized';
}

/**
 * Represents a COLLATE expression in SQL, which specifies the collation sequence
 * to use for a string operation
 */
export interface CollateExpr extends AstNode {
	type: 'collate';
	expr: Expression;
	collation: string;
}

export interface CaseExprWhenThenClause {
	when: Expression;
	then: Expression;
}

export interface CaseExpr extends AstNode {
	type: 'case'; // New type
	baseExpr?: Expression; // Optional: for CASE expr WHEN ...
	whenThenClauses: CaseExprWhenThenClause[];
	elseExpr?: Expression; // Optional: for ELSE ...
}

// --- Utility Type for Top-Level Statements ---
export type Statement =
	| SelectStmt
	| InsertStmt
	| UpdateStmt
	| DeleteStmt
	| ValuesStmt
	| CreateTableStmt
	| CreateIndexStmt
	| CreateViewStmt
	| CreateMaterializedViewStmt
	| RefreshMaterializedViewStmt
	| CreateAssertionStmt
	| DropStmt
	| AlterTableStmt
	| AlterViewStmt
	| AlterMaterializedViewStmt
	| AlterIndexStmt
	| BeginStmt
	| CommitStmt
	| RollbackStmt
	| SavepointStmt
	| ReleaseStmt
	| PragmaStmt
	| AnalyzeStmt
	| DeclareSchemaStmt
	| DeclareLensStmt
	| DiffSchemaStmt
	| ApplySchemaStmt
	| ExplainSchemaStmt;

// === Declarative Schema AST ===

export interface DeclareSchemaStmt extends AstNode {
	type: 'declareSchema';
	schemaName?: string;
	version?: string;
	using?: { defaultVtabModule?: string; defaultVtabArgs?: string };
	items: readonly DeclareItem[];
	/**
	 * `declare logical schema X { ... }` — a design-only schema (`Schema.kind`
	 * becomes `'logical'` at apply). Logical tables declare columns + logical
	 * constraints only; module association / indexes / materialized views are
	 * rejected at apply. See `docs/lens.md` § Schema Kinds. Omitted/false for an
	 * ordinary physical schema.
	 */
	isLogical?: boolean;
}

export type DeclareItem = DeclaredTable | DeclaredIndex | DeclaredView | DeclaredMaterializedView | DeclaredSeed | DeclaredAssertion | DeclareIgnoredItem;

export interface DeclaredTable extends AstNode {
	type: 'declaredTable';
	tableStmt: CreateTableStmt;
}

export interface DeclaredIndex extends AstNode {
	type: 'declaredIndex';
	indexStmt: CreateIndexStmt;
}

export interface DeclaredView extends AstNode {
	type: 'declaredView';
	viewStmt: CreateViewStmt;
}

export interface DeclaredMaterializedView extends AstNode {
	type: 'declaredMaterializedView';
	viewStmt: CreateMaterializedViewStmt;
}

export interface DeclaredSeed extends AstNode {
	type: 'declaredSeed';
	tableName: string;
	columns?: readonly string[];
	seedData?: readonly SqlValue[][];
}

export interface DeclaredAssertion extends AstNode {
	type: 'declaredAssertion';
	assertionStmt: CreateAssertionStmt;
}

/** Placeholder for domain/collation/import items to keep parser forward-compatible */
export interface DeclareIgnoredItem extends AstNode {
	type: 'declareIgnored';
	kind: 'domain' | 'collation' | 'import';
	text: string; // original text snippet for hashing/canonicalization if needed
}

export interface DiffSchemaStmt extends AstNode {
	type: 'diffSchema';
	schemaName?: string;
}

export interface ApplySchemaStmt extends AstNode {
	type: 'applySchema';
	schemaName?: string;
	toVersion?: string;
	withSeed?: boolean;
	options?: {
		allowDestructive?: boolean;
		renamePolicy?: 'allow' | 'require-hint' | 'deny';
	};
}

export interface ExplainSchemaStmt extends AstNode {
	type: 'explainSchema';
	schemaName?: string;
	version?: string;
}

/**
 * `declare lens for X over Y { view T as <select> ... }` — the
 * lens authoring surface (sibling of `declare schema`, NOT a variant of it).
 *
 * Binds a logical schema (`for X`) to a basis schema (`over Y`) and supplies
 * per-logical-table sparse overrides. The basis binding lives on the lens, not
 * the logical schema, which is what keeps the logical design embodiment-free
 * (one logical schema can target different bases across deployments). See
 * `docs/lens.md` § Sparse Overrides / Syntax.
 */
export interface DeclareLensStmt extends AstNode {
	type: 'declareLens';
	/** The logical schema this lens binds (`for X`). */
	logicalSchema: string;
	/** The basis schema the lens aligns over (`over Y`) — the explicit basis. */
	basisSchema: string;
	/** Per-logical-table sparse overrides. */
	overrides: readonly LensOverride[];
}

/**
 * One `view T as <select>` entry inside a {@link DeclareLensStmt}.
 * `select` is the authored override body.
 */
export interface LensOverride {
	/** The logical table this override targets. */
	table: string;
	/** The authored override body (a relation-producing SELECT). */
	select: SelectStmt;
}
