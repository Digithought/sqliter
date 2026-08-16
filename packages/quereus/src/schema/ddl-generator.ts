/**
 * Canonical DDL generation from TableSchema / IndexSchema.
 *
 * Exports:
 *   - generateTableDDL(tableSchema, db?) => CREATE TABLE ...
 *   - generateIndexDDL(indexSchema, tableSchema, db?) => CREATE INDEX ...
 *
 * When `db` is omitted, the generator emits fully-qualified DDL with
 * unconditional annotations (schema name qualified, USING emitted,
 * nullability annotated on every column). This makes the output safe to
 * persist and re-parse in any session.
 *
 * When `db` is provided, clauses that match the current session defaults
 * are elided for readability:
 *   - schema name qualification (db.schemaManager current schema)
 *   - USING module / args (db.options.default_vtab_module / default_vtab_args)
 *   - per-column NULL / NOT NULL annotation (db.options.default_column_nullability)
 */

import type { Database } from '../core/database.js';
import type { TableSchema, IndexSchema, RowConstraintSchema, UniqueConstraintSchema, ForeignKeyConstraintSchema, NamedConstraintClass } from './table.js';
import { maskToOps, isSynthesizedAllColumnsKey, resolvePkDefaultConflict } from './table.js';
import type { ColumnSchema } from './column.js';
import type { ViewSchema } from './view.js';
import { normalizeBackingModule } from './view.js';
import type { MaintainedTableSchema } from './derivation.js';
import type { SqlValue } from '../common/types.js';
import { ConflictResolution } from '../common/constants.js';
import type * as AST from '../parser/ast.js';
import { quoteIdentifier, expressionToString, constraintBodyToCanonicalString, createIndexBodyToCanonicalString, tableConstraintsToString, createViewToString, maintainedClauseToString, alterIndexToString } from '../emit/ast-stringify.js';
import { normalizeCollationName } from '../util/comparison.js';

/**
 * Unconditionally double-quote an identifier, escaping internal quotes.
 *
 * This generator deliberately uses two quoting policies:
 *   - `quoteName` (here, unconditional) for *structural* names — table, column,
 *     schema, index, and primary-key columns — so they always emit quoted.
 *   - `quoteIdentifier` (conditional; from `../emit/ast-stringify.js`) for
 *     *operand* identifiers — collation name, USING module name, vtab-arg key,
 *     and tag key — which stay bare unless they are reserved words / non-bare-
 *     valid. This keeps the common forms readable and re-parseable
 *     (`USING store`, `COLLATE NOCASE`) while still quoting a reserved-word name
 *     (`USING "select"`). Both forms re-parse; the split matches the canonical
 *     DDL convention pinned by the quereus-store ddl-generator spec.
 */
function quoteName(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

/** Generate canonical DDL for a table from its schema. */
export function generateTableDDL(tableSchema: TableSchema, db?: Database): string {
	const ctx = resolveEmitContext(db);
	// USING clause: emit when vtabModuleName differs from the session default,
	// or always when no db context is provided.
	return generateTableDDLInternal(tableSchema, ctx, formatUsingClause(tableSchema, ctx), null);
}

/**
 * Generate canonical DDL for a **maintained table** (a `TableSchema` carrying a
 * {@link import('./derivation.js').TableDerivation}) — the table form:
 *
 *   `create table <schema>.<name> (<declared shape>) [using <module>(args)]
 *    maintained as <body … [with defaults (…)]> [with tags (…)]`
 *
 * This is the one canonical comparison/persistence surface for every maintained
 * table regardless of authoring form (`create table … maintained as` or the
 * `create materialized view` sugar). The declared column list is the live
 * backing shape (the frozen basis), so a re-import verifies the body still
 * derives exactly that shape. The `using` clause is re-derived from the table's
 * own `vtabModuleName`/`vtabArgs` through `normalizeBackingModule`, so the
 * memory default stays clause-free while a non-default host module round-trips.
 * Current `tags` are read live, so a tag-only swap round-trips. Always emitted
 * fully-qualified / fully-annotated (no session elision) — safe to persist and
 * re-parse in any session.
 */
export function generateMaintainedTableDDL(table: MaintainedTableSchema): string {
	const ctx = resolveEmitContext(undefined);
	const backing = normalizeBackingModule(table.vtabModuleName, table.vtabArgs);
	let usingClause: string | null = null;
	if (backing.storedModuleName) {
		usingClause = `USING ${quoteIdentifier(backing.storedModuleName)}`;
		const args = backing.storedModuleArgs ?? {};
		if (Object.keys(args).length > 0) usingClause += ` (${formatVtabArgs(args)})`;
	}
	const maintained = maintainedClauseToString({
		// Emit the rename list only when the derivation carries one (an explicit
		// MV-sugar rename / an attached backing). Its absence is the lossless signal
		// that the body is implicit and must reshape to follow its source on reopen.
		// Any `with defaults (…)` rides inside the body string (selectAst).
		columns: table.derivation.columns,
		select: table.derivation.selectAst,
	});
	return generateTableDDLInternal(table, ctx, usingClause, maintained);
}

/**
 * Shared CREATE TABLE body emitter. `usingClause` is pre-resolved by the caller
 * (session-elided for {@link generateTableDDL}, backing-normalized for
 * {@link generateMaintainedTableDDL}); `maintainedClause` is the rendered
 * `maintained as …` clause or null. Clause order matches the parser grammar:
 * `(columns) → using → maintained as … [insert defaults] → with tags`.
 */
function generateTableDDLInternal(
	tableSchema: TableSchema,
	ctx: EmitContext,
	usingClause: string | null,
	maintainedClause: string | null,
): string {
	const parts: string[] = ['CREATE'];
	parts.push('TABLE', qualifiedName(tableSchema.schemaName, tableSchema.name, ctx.currentSchemaName));

	// A synthesized all-columns key (the no-PK fallback) round-trips by OMITTING the
	// PRIMARY KEY clause: the re-parse re-synthesizes the identical key from its absence.
	// Emitting a named clause instead would also be correct now that declaring a key
	// changes nothing about its columns — see isSynthesizedAllColumnsKey and
	// `tickets/implement/4-debt-emit-primary-key-clause-for-every-key`.
	const synthesizedKey = isSynthesizedAllColumnsKey(tableSchema);

	// The one column that carries the inline `PRIMARY KEY` clause, or -1 when there is
	// none to emit (no key, a composite key — rendered table-level below — or a
	// synthesized all-columns key). Resolved from `primaryKeyDefinition`, the
	// authoritative key record, NOT from the per-column `primaryKey` flag: the flag is a
	// CREATE-time mirror that `ALTER TABLE … ALTER PRIMARY KEY` producers may leave
	// pointing at the retired key, and rendering from it emitted DDL that re-parsed to
	// the OLD key (and, on a composite→single move, two inline clauses).
	const inlinePkIndex = !synthesizedKey && tableSchema.primaryKeyDefinition.length === 1
		? tableSchema.primaryKeyDefinition[0].index
		: -1;

	// The declared `ON CONFLICT` action rides whichever clause ends up carrying the key
	// (see pkConflictClause) — without it a `primary key (...) on conflict replace`
	// re-parses as ABORT and stops replacing after a persistence reopen. Resolved through
	// resolvePkDefaultConflict, not the raw `primaryKeyDefaultConflict` field, so a
	// column-declared action (`a integer not null on conflict replace, … primary key (a, b)`)
	// reaches the table-level clause too — reading the field alone dropped it there, and
	// dropped it stably enough that the fixed-point assertion could not see it.
	const pkConflict = pkConflictClause(resolvePkDefaultConflict(tableSchema));

	const columnDefs: string[] = tableSchema.columns.map((col, columnIndex) =>
		formatColumnDef(col, tableSchema, ctx.defaultNotNull, columnIndex === inlinePkIndex, pkConflict));

	// Table-level PRIMARY KEY: empty () for singleton, (a, b, ...) for composite.
	// Single-column PK is emitted inline on the column above. A synthesized
	// all-columns key emits no clause at all (neither here nor inline). Per-column
	// DESC is emitted so a descending key component (e.g. an ordering-seeded
	// maintained-table backing key) survives the round-trip instead of silently
	// re-keying ascending on re-parse.
	if (tableSchema.primaryKeyDefinition.length === 0) {
		columnDefs.push(`PRIMARY KEY ()${pkConflict}`);
	} else if (!synthesizedKey && tableSchema.primaryKeyDefinition.length > 1) {
		const pkCols = tableSchema.primaryKeyDefinition
			.map(pk => quoteName(tableSchema.columns[pk.index].name) + (pk.desc ? ' DESC' : ''))
			.join(', ');
		columnDefs.push(`PRIMARY KEY (${pkCols})${pkConflict}`);
	}

	// Table-level CHECK / UNIQUE / FOREIGN KEY constraints. Emitting these is what
	// lets store-backed tables retain (and keep enforcing) their constraints across
	// a closeAll() + reopen + rehydrateCatalog, which re-parses this string. Reuse
	// the AST emitter (tableConstraintsToString) over the schema→AST lift so this
	// persistence path and the declarative AST→SQL path render constraints
	// identically and cannot drift. Emission is independent of the session defaults
	// (constraints have no default-elision), so the no-db and db-context branches
	// agree byte-for-byte.
	const constraintClause = emitTableConstraints(tableSchema);
	if (constraintClause) columnDefs.push(constraintClause);

	parts.push(`(${columnDefs.join(', ')})`);

	if (usingClause) parts.push(usingClause);

	if (maintainedClause) parts.push(maintainedClause);

	// Table-level WITH TAGS
	if (hasTags(tableSchema.tags)) {
		parts.push(formatTagsClause(tableSchema.tags!));
	}

	return parts.join(' ');
}

/** Generate canonical DDL for an index from its schema. */
export function generateIndexDDL(
	indexSchema: IndexSchema,
	tableSchema: TableSchema,
	db?: Database,
): string {
	const ctx = resolveEmitContext(db);
	// Clause order mirrors the parser grammar and the AST emitter
	// `createIndexToString` (ast-stringify.ts): CREATE [UNIQUE] INDEX <name> ON
	// <table> (<cols>) [WHERE <predicate>] [WITH TAGS (...)]. Keeping the order
	// aligned means a UNIQUE / partial index re-parses to the same shape, so the
	// declarative differ (which round-trips the actual catalog DDL) never churns.
	const parts: string[] = ['CREATE'];
	if (indexSchema.unique) parts.push('UNIQUE');
	parts.push('INDEX');
	parts.push(quoteName(indexSchema.name));
	parts.push('ON');
	parts.push(qualifiedName(tableSchema.schemaName, tableSchema.name, ctx.currentSchemaName));

	const cols = indexSchema.columns.map(col => {
		let colStr = quoteName(tableSchema.columns[col.index].name);
		if (col.collation) colStr += ` COLLATE ${quoteIdentifier(col.collation)}`;
		if (col.desc) colStr += ' DESC';
		return colStr;
	});
	parts.push(`(${cols.join(', ')})`);

	// Partial-index predicate. Reuse expressionToString (the same emitter used for
	// DEFAULT / CHECK) so the WHERE clause re-parses to the same AST on import.
	if (indexSchema.predicate) {
		parts.push(`WHERE ${expressionToString(indexSchema.predicate)}`);
	}

	if (hasTags(indexSchema.tags)) {
		parts.push(formatTagsClause(indexSchema.tags!));
	}

	return parts.join(' ');
}

/**
 * Canonical `drop table "<schema>"."<name>"` statement.
 *
 * The counterpart of {@link generateTableDDL} for the drop half of a table's
 * lifecycle. Always fully qualified (same {@link quoteName} policy as the CREATE
 * side) so the statement targets the intended schema regardless of the executing
 * session's current schema — which is what makes it safe to ship to a sync peer.
 *
 * NOTE: the two drop generators emit lowercase keywords (the repo convention)
 * while the CREATE generators above emit uppercase (their output is compared
 * byte-for-byte against persisted catalog text). Nothing compares drop text —
 * both sync and the catalog treat a drop as presence, not as a string — so the
 * split is harmless today. If a drop's text ever becomes a comparison key, the
 * casing must be pinned on both sides first.
 */
export function generateDropTableDDL(schemaName: string, tableName: string): string {
	return `drop table ${quoteName(schemaName)}.${quoteName(tableName)}`;
}

/**
 * Canonical `drop index "<schema>"."<name>"` statement — the counterpart of
 * {@link generateIndexDDL}. Fully qualified for the same reason
 * {@link generateDropTableDDL} is; the owning table is not named because
 * `DROP INDEX` resolves the owner by scanning the schema.
 */
export function generateDropIndexDDL(schemaName: string, indexName: string): string {
	return `drop index ${quoteName(schemaName)}.${quoteName(indexName)}`;
}

/**
 * Generate canonical DDL for a (non-materialized) view from its schema.
 *
 * Lifts the stored {@link ViewSchema} back into the equivalent
 * {@link AST.CreateViewStmt} and renders it via the shared `createViewToString`
 * emitter (the same schema→AST-lift strategy {@link generateTableDDL} uses for
 * constraints), so this persistence path and the declarative AST→SQL path cannot
 * drift. The view name is fully qualified (`schema.name`) so a re-parse registers
 * into the correct schema regardless of the session's current schema, and the
 * **current** `tags` are read live — so a `view_modified` (ALTER VIEW … SET TAGS,
 * which swaps the in-memory schema without rewriting the stored `sql`) round-trips.
 * The body is already an AST (`selectAst`), so this is a thin, drift-free wrapper.
 */
export function generateViewDDL(view: ViewSchema): string {
	const stmt: AST.CreateViewStmt = {
		type: 'createView',
		view: { type: 'identifier', name: view.name, schema: view.schemaName },
		ifNotExists: false,
		columns: view.columns ? [...view.columns] : undefined,
		// Any `with defaults (…)` rides inside the body string (selectAst).
		select: view.selectAst,
		tags: view.tags ? { ...view.tags } : undefined,
	};
	return createViewToString(stmt);
}

/**
 * Canonical `alter index "<schema>"."<name>" set tags (...)` statement applying
 * `tags` as a whole-set replacement — the vehicle a store-backed catalog bundle
 * uses to persist an *exposed implicit index*'s user tags
 * (`UniqueConstraintSchema.exposedIndexTags`), which have no `CREATE INDEX` line
 * to ride (the index is never materialized in store mode). Lifts the equivalent
 * {@link AST.AlterIndexStmt} and renders it via the shared `alterIndexToString`
 * emitter, so the persisted form re-parses to exactly the statement a live
 * `ALTER INDEX … SET TAGS` produces and the two paths cannot drift. Always emits
 * the replace form (canonical whole-set, mirroring the declarative differ's
 * convention); callers skip empty/absent tag records rather than emitting a
 * clearing statement. The emitter renders lowercase (`alter index …`) while the
 * CREATE lines are uppercase — purely cosmetic, both re-parse.
 */
export function generateIndexTagsDDL(
	schemaName: string | undefined,
	indexName: string,
	tags: Readonly<Record<string, SqlValue>>,
): string {
	const stmt: AST.AlterIndexStmt = {
		type: 'alterIndex',
		name: { type: 'identifier', name: indexName, schema: schemaName },
		action: { type: 'setTags', mode: 'replace', tags: { ...tags } },
	};
	return alterIndexToString(stmt);
}

/**
 * Canonical **body** string for a stored index (UNIQUE-ness, column
 * set/order/direction, partial predicate) — the actual-catalog comparison key the
 * declarative differ diffs against the declared-AST body (rendered by the same
 * {@link createIndexBodyToCanonicalString}) to detect a name-matched index whose
 * body changed (→ drop+recreate). The stored {@link IndexSchema} is first lifted
 * into the equivalent minimal {@link AST.CreateIndexStmt} (column indices → names,
 * `unique`, `predicate` → `where`), so both sides share one rendering path and
 * stay byte-comparable — exactly as {@link constraintToCanonicalDDL} does via
 * `schemaConstraintToTableConstraint`. Each lifted column carries its resolved
 * effective collation (stored `IndexColumnSchema.collation`, falling back to the
 * table column's collation; normalized, default BINARY) so the shared renderer
 * elides BINARY and emits a non-BINARY collation explicitly — matching the
 * declared side's pre-resolution (see `createIndexBodyToCanonicalString`).
 * `index` / `table` are placeholder identifiers the body render never reads (it
 * excludes the name and the `on <table>` reference).
 */
export function indexToCanonicalDDL(indexSchema: IndexSchema, tableSchema: TableSchema): string {
	const stmt: AST.CreateIndexStmt = {
		type: 'createIndex',
		index: { type: 'identifier', name: indexSchema.name },
		table: { type: 'identifier', name: tableSchema.name },
		ifNotExists: false,
		columns: indexSchema.columns.map(col => ({
			name: tableSchema.columns[col.index].name,
			direction: col.desc ? 'desc' as const : undefined,
			collation: normalizeCollationName(col.collation ?? tableSchema.columns[col.index].collation ?? 'BINARY'),
		})),
		isUnique: !!indexSchema.unique,
		where: indexSchema.predicate,
	};
	return createIndexBodyToCanonicalString(stmt);
}

/**
 * Canonical DDL **body fragment** for a stored named constraint (CHECK / UNIQUE /
 * FOREIGN KEY), excluding its `constraint <name>` prefix and `with tags (...)`
 * suffix. This is the actual-catalog comparison key the declarative differ
 * diffs against the declared-AST fragment (rendered by the same
 * {@link constraintBodyToCanonicalString}) to detect a constraint whose name is
 * unchanged but whose body changed. The schema constraint is first lifted back
 * into the equivalent {@link AST.TableConstraint} (column indices → names,
 * operation mask → `RowOp[]`, `defaultConflict` → `onConflict`, FK actions and
 * deferred resolution mapped over), so both sides share one rendering path and
 * stay byte-comparable. The child schema (`tableSchema.schemaName`) is threaded so
 * the FK parent-schema qualifier folds symmetrically with the declared side — an
 * own-schema qualifier elides, a genuine cross-schema parent survives (the lift
 * already elides a parent == child qualifier, so this pass is idempotent here).
 */
export function constraintToCanonicalDDL(
	kind: NamedConstraintClass,
	constraint: RowConstraintSchema | UniqueConstraintSchema | ForeignKeyConstraintSchema,
	tableSchema: TableSchema,
): string {
	return constraintBodyToCanonicalString(schemaConstraintToTableConstraint(kind, constraint, tableSchema), tableSchema.schemaName);
}

/**
 * Lifts a stored named constraint back into the equivalent AST.TableConstraint.
 *
 * **Full-fidelity**: preserves the constraint `name` and `tags`, and (for FK)
 * reconstructs the deferrability clause, so the same lift drives both the
 * persistence emitter ({@link generateTableDDL}, via {@link tableConstraintsToString})
 * and the canonical-body comparison ({@link constraintToCanonicalDDL}). The
 * canonical consumer strips `name`/`tags`/deferrable downstream
 * (`constraintBodyToCanonicalString` does `{ ...tc, name: undefined, tags: undefined }`
 * and `canonicalForeignKeyClause` drops the deferrable clause), so carrying these
 * fields here does NOT change `constraintToCanonicalDDL` output — only the
 * persistence path benefits.
 */
function schemaConstraintToTableConstraint(
	kind: NamedConstraintClass,
	constraint: RowConstraintSchema | UniqueConstraintSchema | ForeignKeyConstraintSchema,
	tableSchema: TableSchema,
): AST.TableConstraint {
	const colName = (i: number): string => tableSchema.columns[i]?.name ?? String(i);
	switch (kind) {
		case 'check': {
			const c = constraint as RowConstraintSchema;
			return { type: 'check', name: c.name, expr: c.expr, operations: maskToOps(c.operations), onConflict: c.defaultConflict, tags: copyTags(c.tags) };
		}
		case 'unique': {
			const c = constraint as UniqueConstraintSchema;
			return { type: 'unique', name: c.name, columns: c.columns.map(i => ({ name: colName(i) })), onConflict: c.defaultConflict, tags: copyTags(c.tags) };
		}
		case 'foreignKey': {
			const c = constraint as ForeignKeyConstraintSchema;
			// The schema collapses every deferrability variant to a single `deferred`
			// boolean (= AST `initiallyDeferred`, see constraint-builder), so the only
			// form distinguishable here is `deferrable initially deferred`; all
			// non-deferred forms reconstruct as no clause (re-parses to deferred=false).
			//
			// Cross-schema FK: emit the `schema.` qualifier ONLY when the parent schema
			// differs from the child's, so a cross-schema parent survives the DDL
			// round-trip while same-schema FK DDL stays byte-identical (no qualifier).
			const crossSchema =
				c.referencedSchema &&
				c.referencedSchema.toLowerCase() !== tableSchema.schemaName.toLowerCase()
					? c.referencedSchema
					: undefined;
			return {
				type: 'foreignKey',
				name: c.name,
				columns: c.columns.map(i => ({ name: colName(i) })),
				foreignKey: {
					table: c.referencedTable,
					schema: crossSchema,
					columns: c.referencedColumnNames ? [...c.referencedColumnNames] : undefined,
					onDelete: c.onDelete,
					onUpdate: c.onUpdate,
					deferrable: c.deferred ? true : undefined,
					initiallyDeferred: c.deferred ? true : undefined,
				},
				onConflict: c.defaultConflict,
				tags: copyTags(c.tags),
			};
		}
	}
}

/** Mutable shallow copy of a (readonly) tags record, or undefined when absent. */
function copyTags(tags: Readonly<Record<string, SqlValue>> | undefined): Record<string, SqlValue> | undefined {
	return tags ? { ...tags } : undefined;
}

/**
 * Renders the table-level CHECK / UNIQUE / FOREIGN KEY constraints of a table as
 * a single comma-joined fragment (or '' when there are none), suitable to append
 * inside the CREATE TABLE column-def paren list.
 *
 * Order is deterministic — CHECK, then UNIQUE, then FOREIGN KEY, each in stored-
 * array order — so the persisted catalog DDL is byte-stable (which the declarative
 * differ and any diff-on-disk rely on).
 *
 * UNIQUE constraints synthesized from a `CREATE UNIQUE INDEX` (`derivedFromIndex`)
 * are skipped: they round-trip via their index, not as a table constraint, so
 * emitting them here would make the declarative differ churn a spurious
 * DROP CONSTRAINT. All CHECKs (including the engine's auto `_check_<col>` names)
 * and every FK are emitted — `_`-prefixed auto-names re-parse stably and stay
 * excluded from the differ's user-addressable `namedConstraints`.
 */
function emitTableConstraints(tableSchema: TableSchema): string {
	const constraints: AST.TableConstraint[] = [];
	for (const c of tableSchema.checkConstraints ?? []) {
		constraints.push(schemaConstraintToTableConstraint('check', c, tableSchema));
	}
	for (const c of tableSchema.uniqueConstraints ?? []) {
		if (c.derivedFromIndex) continue;
		constraints.push(schemaConstraintToTableConstraint('unique', c, tableSchema));
	}
	for (const c of tableSchema.foreignKeys ?? []) {
		constraints.push(schemaConstraintToTableConstraint('foreignKey', c, tableSchema));
	}
	return constraints.length > 0 ? tableConstraintsToString(constraints) : '';
}

// --- Internals ---

interface EmitContext {
	/** Current schema name used to elide qualification; undefined = always qualify. */
	currentSchemaName: string | undefined;
	/** Session default_column_nullability; undefined = always annotate. */
	defaultNotNull: boolean | undefined;
	/** Session default vtab module; undefined = always emit USING when set. */
	defaultVtabModule: string | undefined;
	/** Session default vtab args; undefined = always emit args when set. */
	defaultVtabArgs: Record<string, SqlValue> | undefined;
}

function resolveEmitContext(db?: Database): EmitContext {
	if (!db) {
		return {
			currentSchemaName: undefined,
			defaultNotNull: undefined,
			defaultVtabModule: undefined,
			defaultVtabArgs: undefined,
		};
	}
	const nullability = db.options.getStringOption('default_column_nullability');
	return {
		currentSchemaName: db.schemaManager.getCurrentSchemaName(),
		defaultNotNull: nullability === 'not_null',
		defaultVtabModule: db.options.getStringOption('default_vtab_module'),
		defaultVtabArgs: db.options.getObjectOption('default_vtab_args'),
	};
}

function qualifiedName(schemaName: string | undefined, name: string, currentSchemaName: string | undefined): string {
	const quotedName = quoteName(name);
	if (!schemaName) return quotedName;
	// Elide qualification when schema matches the session's current schema.
	if (currentSchemaName !== undefined && schemaName.toLowerCase() === currentSchemaName.toLowerCase()) {
		return quotedName;
	}
	return `${quoteName(schemaName)}.${quotedName}`;
}

/**
 * Renders the ` ON CONFLICT <action>` tail of a table's primary-key declaration, or ''
 * when none was declared or it is the ABORT default (which re-parses identically).
 *
 * Emitted on whichever clause carries the key — inline on the column for a
 * single-column key, table-level otherwise — because the action is a property of the
 * key, not of the clause's spelling. Dropping it silently downgrades a
 * `primary key (...) on conflict replace` table to ABORT on any DDL round-trip, so a
 * store-backed table stops replacing on duplicate-key writes after a reopen.
 *
 * Uppercase to match the surrounding CREATE TABLE keywords; the parser is
 * case-insensitive, and the constraint fragment emitted below (lowercase, via
 * `tableConstraintsToString`) already mixes the two.
 */
function pkConflictClause(defaultConflict: ConflictResolution | undefined): string {
	if (defaultConflict === undefined || defaultConflict === ConflictResolution.ABORT) return '';
	return ` ON CONFLICT ${ConflictResolution[defaultConflict]}`;
}

/**
 * Renders one column definition. `isInlinePk` is decided by the caller from
 * `primaryKeyDefinition` (see `generateTableDDLInternal`) — this function never
 * consults the per-column `primaryKey` flag, so flag drift from any ALTER producer
 * cannot reach the emitted DDL. `pkConflict` is the rendered `ON CONFLICT` tail for the
 * table's key, appended only when this column carries the inline clause.
 */
function formatColumnDef(col: ColumnSchema, tableSchema: TableSchema, defaultNotNull: boolean | undefined, isInlinePk: boolean, pkConflict: string): string {
	let colDef = quoteName(col.name);
	// NOTE: emits the flattened col.logicalType.name (e.g. 'INTEGER'), not col.declaredType
	// (e.g. 'BIGINT'). That's intentional today — declaredType is informational-only, read
	// by an external host, not by Quereus's own DDL round-trip — but if this ever needs to
	// regenerate a byte-faithful CREATE TABLE, prefer col.declaredType here so the raw token
	// isn't silently dropped again.
	if (col.logicalType) colDef += ` ${col.logicalType.name}`;

	const nullAnnotation = nullabilityAnnotation(col.notNull, defaultNotNull);
	if (nullAnnotation) colDef += ` ${nullAnnotation}`;
	// NOTE: a column's own `ON CONFLICT` action (`ColumnSchema.defaultConflict`, which a
	// `not null` / `null` / `primary key` column clause all collapse onto) is emitted ONLY
	// on the inline PRIMARY KEY clause below. On a non-key column — `x integer not null on
	// conflict rollback` — it is still dropped, so the column falls back to ABORT after a
	// persistence round-trip. Emitting it on the nullability annotation would fix that, but
	// the annotation elides in the with-`db` form (see nullabilityAnnotation), so the action
	// would need a forced annotation to ride on. Worth doing when a non-key `on conflict`
	// declaration actually has to survive a reopen.

	// Column COLLATE: emit only a non-default collation (BINARY / '' are elided),
	// mirroring the index column path (generateIndexDDL). Without this, a re-parse
	// of the canonical DDL (e.g. the @quereus/store persistence round-trip) silently
	// reverts the column to BINARY, changing its comparison / sort / unique semantics.
	// Quote conditionally (quoteIdentifier) so an ordinary collation stays bare
	// (COLLATE NOCASE) and only a reserved-word collation quotes (COLLATE "select").
	// Collation has no session-default elision, so both emit branches agree byte-for-byte.
	if (col.collation && normalizeCollationName(col.collation) !== 'BINARY') {
		colDef += ` COLLATE ${quoteIdentifier(col.collation)}`;
	}

	// Inline column-level PK only for a genuine single-column declared PK. A
	// synthesized single-column key (a one-column no-PK table) emits no PK clause.
	// DESC is emitted so a descending key survives the round-trip (the re-parse
	// would otherwise silently re-key ascending).
	if (isInlinePk) {
		colDef += tableSchema.primaryKeyDefinition[0].desc ? ' PRIMARY KEY DESC' : ' PRIMARY KEY';
		// `pkConflict` already folds in this column's own action (resolvePkDefaultConflict
		// reads the column-level record when no table-level one is set), which is what makes
		// the emission a fixed point — a table-level action re-parses ONTO the column, so the
		// second emission has only the column-level record to read.
		colDef += pkConflict;
	}

	if (col.defaultValue !== null && col.defaultValue !== undefined) {
		colDef += ` DEFAULT ${formatDefaultExpression(col.defaultValue)}`;
	}

	// GENERATED ALWAYS AS: mutually exclusive with DEFAULT (columnDefToSchema rejects both),
	// so this and the block above never both fire. Without this, the rule computing the
	// column is silently dropped on persist — a reopened table stores nulls in the column
	// forever after (and, wrongly, accepts direct writes to it again).
	if (col.generated && col.generatedExpr) {
		colDef += ` GENERATED ALWAYS AS (${expressionToString(col.generatedExpr)})`;
		colDef += col.generatedStored ? ' STORED' : ' VIRTUAL';
	}

	if (hasTags(col.tags)) {
		colDef += ' ' + formatTagsClause(col.tags!);
	}

	return colDef;
}

/**
 * Decides what nullability annotation (if any) to emit.
 *
 * - With a known session default: emit only the annotation that differs from the default.
 * - Without a session default: always emit explicitly (safe for persistence under any reader).
 */
function nullabilityAnnotation(notNull: boolean, defaultNotNull: boolean | undefined): string | null {
	if (defaultNotNull === undefined) {
		return notNull ? 'NOT NULL' : 'NULL';
	}
	if (defaultNotNull && !notNull) return 'NULL';
	if (!defaultNotNull && notNull) return 'NOT NULL';
	return null;
}

function formatUsingClause(tableSchema: TableSchema, ctx: EmitContext): string | null {
	const moduleName = tableSchema.vtabModuleName;
	if (!moduleName) return null;

	const args = tableSchema.vtabArgs ?? {};
	const hasArgs = Object.keys(args).length > 0;

	// If no db context, always emit both module and args.
	if (ctx.defaultVtabModule === undefined) {
		let clause = `USING ${quoteIdentifier(moduleName)}`;
		if (hasArgs) clause += ` (${formatVtabArgs(args)})`;
		return clause;
	}

	const moduleMatches = moduleName === ctx.defaultVtabModule;
	const defaultArgs = ctx.defaultVtabArgs ?? {};
	const argsMatch = recordsShallowEqual(args, defaultArgs);

	if (moduleMatches && argsMatch) return null;

	let clause = `USING ${quoteIdentifier(moduleName)}`;
	if (hasArgs) clause += ` (${formatVtabArgs(args)})`;
	return clause;
}

function formatVtabArgs(args: Record<string, SqlValue>): string {
	return Object.entries(args)
		.map(([key, value]) => `${quoteIdentifier(key)} = ${formatSqlLiteral(value)}`)
		.join(', ');
}

function formatDefaultExpression(expr: AST.Expression): string {
	// Prefer AST stringifier, which preserves lexeme for literals where possible.
	return expressionToString(expr);
}

/** Format a SqlValue as a SQL literal (suitable for DEFAULT / USING args). */
function formatSqlLiteral(value: SqlValue): string {
	if (value === null) return 'NULL';
	if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
	if (typeof value === 'number' || typeof value === 'bigint') return String(value);
	if (typeof value === 'boolean') return value ? '1' : '0';
	// Fallback for complex values — stringify as JSON string literal.
	return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
}

/**
 * Format a tag value. Differs from formatSqlLiteral: booleans emit TRUE/FALSE.
 */
function formatTagValue(value: SqlValue): string {
	if (value === null) return 'NULL';
	if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
	if (typeof value === 'number' || typeof value === 'bigint') return String(value);
	if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
	return String(value);
}

function formatTagsClause(tags: Readonly<Record<string, SqlValue>>): string {
	const entries = Object.entries(tags)
		.map(([key, value]) => `${quoteIdentifier(key)} = ${formatTagValue(value)}`)
		.join(', ');
	return `WITH TAGS (${entries})`;
}

function hasTags(tags: Readonly<Record<string, SqlValue>> | undefined): boolean {
	return !!tags && Object.keys(tags).length > 0;
}

function recordsShallowEqual(a: Record<string, SqlValue>, b: Record<string, SqlValue>): boolean {
	const aKeys = Object.keys(a);
	const bKeys = Object.keys(b);
	if (aKeys.length !== bKeys.length) return false;
	for (const k of aKeys) {
		if (!Object.hasOwn(b, k)) return false;
		if (a[k] !== b[k]) return false;
	}
	return true;
}
