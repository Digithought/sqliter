import type { ColumnSchema } from './column.js';
import { normalizeCollationName } from '../util/comparison.js';
import type { AnyVirtualTableModule } from '../vtab/module.js';
import { MemoryTableModule } from '../vtab/memory/module.js';
import type { Expression } from '../parser/ast.js';
import type { ConflictResolution } from '../common/constants.js';
import { type ColumnDef, type TableConstraint } from '../parser/ast.js';
import { RowOp, StatusCode, type SqlValue } from '../common/types.js';
import type * as AST from '../parser/ast.js';
import { quereusError, QuereusError } from '../common/errors.js';
import { createLogger } from '../common/logger.js';
import { inferType } from '../types/registry.js';
import type { LogicalType } from '../types/logical-type.js';
import type { TableStatistics } from '../planner/stats/catalog-stats.js';
import { collectGeneratedColumnRefs } from './generated-column-refs.js';
import type { ResolveColumnInSource } from './rename/shared.js';

const log = createLogger('schema:table');
const warnLog = log.extend('warn');

/**
 * Represents the schema definition of a table (real or virtual).
 */
export interface TableSchema {
	/** Table name */
	name: string;
	/** Schema name (e.g., "main", "temp") */
	schemaName: string;
	/** Ordered list of column definitions */
	columns: ReadonlyArray<ColumnSchema>;
	/** Map from column name (lowercase) to column index */
	columnIndexMap: ReadonlyMap<string, number>;
	/** Definition of the primary key, including order and direction */
	primaryKeyDefinition: ReadonlyArray<PrimaryKeyColumnDefinition>;
	/**
	 * Default conflict resolution declared on a table-level
	 * `PRIMARY KEY (...) ON CONFLICT <action>` clause. Resolution precedence for
	 * PK conflicts: statement-level OR > this field > column-level
	 * `defaultConflict` on any PK column > ABORT.
	 */
	primaryKeyDefaultConflict?: ConflictResolution;
	/** CHECK constraints defined on the table or its columns */
	checkConstraints: ReadonlyArray<RowConstraintSchema>;
	/**
	 * Reference to the registered module. Optional: a **logical** table
	 * (`isLogical: true`, held only in a lens slot — never registered or
	 * executed) carries no module. Every module-backed table has one. Use
	 * {@link requireVtabModule} at sites that need the module on a physical table.
	 */
	vtabModule?: AnyVirtualTableModule;
	/** If virtual, aux data passed during module registration */
	vtabAuxData?: unknown;
	/** If virtual, the arguments passed in CREATE VIRTUAL TABLE */
	vtabArgs?: Record<string, SqlValue>;
	/** If virtual, the name the module was registered with */
	vtabModuleName: string;
	/** Whether the table is a view */
	isView: boolean;
	/**
	 * Whether this is a **logical** table — a design-only spec held in a lens
	 * slot (see `schema/lens.ts`), with `vtabModule` undefined. Logical tables
	 * are never registered via `Schema.addTable` nor executed directly; their
	 * compiled effective body is registered as a {@link ViewSchema}. See
	 * `docs/lens.md` § Schema Kinds.
	 */
	isLogical?: boolean;
	/** Whether the table is a subquery source */
	subqueryAST?: AST.SelectStmt;
	/** If virtual, the view definition */
	viewDefinition?: AST.SelectStmt;
	/** Table-level constraints */
	tableConstraints?: readonly TableConstraint[];
	/** Definitions of secondary indexes (relevant for planning) */
	indexes?: ReadonlyArray<IndexSchema>;
	/** Estimated number of rows in the table (for query planning) */
	readonly estimatedRows?: number;
	/** Whether the table is read-only */
	isReadOnly?: boolean;	// default false
	/** Mutation context variables for this table */
	mutationContext?: ReadonlyArray<MutationContextDefinition>;
	/** Cached table statistics from ANALYZE or VTab reporting */
	statistics?: TableStatistics;
	/** Foreign key constraints */
	foreignKeys?: ReadonlyArray<ForeignKeyConstraintSchema>;
	/** Unique constraints (beyond primary key) */
	uniqueConstraints?: ReadonlyArray<UniqueConstraintSchema>;
	/**
	 * For each generated column index, the set of column indices in this table its
	 * expression references. Populated alongside the columns array so INSERT/UPDATE
	 * planners and DROP COLUMN don't re-walk the AST.
	 */
	generatedColumnDependencies?: ReadonlyMap<number, ReadonlyArray<number>>;
	/**
	 * Generated column indices ordered so dependencies come before dependents.
	 * Empty / undefined when no generated columns exist.
	 */
	generatedColumnTopoOrder?: ReadonlyArray<number>;
	/** Arbitrary metadata tags (informational only, does not affect behavior or hashing) */
	tags?: Readonly<Record<string, SqlValue>>;
	/**
	 * Optional maintenance contract: present iff this table is a **maintained
	 * table** (what `create materialized view` produces). The derivation object
	 * is shared by reference across catalog swaps of this table so its runtime
	 * state survives them. See {@link import('./derivation.js').TableDerivation}.
	 */
	derivation?: import('./derivation.js').TableDerivation;
}

/**
 * Returns the table's virtual-table module, throwing if absent. Logical tables
 * (held only in lens slots, never registered or executed) carry no module, so
 * `vtabModule` is optional on {@link TableSchema}; every physical/registered
 * table has one. Use this at module-backed sites to narrow the optional with a
 * clear internal-error diagnostic rather than a silent `undefined` deref.
 */
export function requireVtabModule(table: TableSchema): AnyVirtualTableModule {
	if (!table.vtabModule) {
		quereusError(
			`Table '${table.schemaName}.${table.name}' has no virtual-table module (logical tables are not directly executable)`,
			StatusCode.INTERNAL,
		);
	}
	return table.vtabModule;
}

/**
 * The class of a named table-level constraint, as stored in the three distinct
 * constraint arrays on {@link TableSchema}.
 */
export type NamedConstraintClass = 'check' | 'unique' | 'foreignKey';

/**
 * Resolves a named table-level constraint to its class, searching in the fixed
 * order check → unique → foreign key. Used by `ALTER TABLE … DROP/RENAME
 * CONSTRAINT` and `… ALTER CONSTRAINT … SET TAGS` so a single name maps to
 * exactly one constraint.
 *
 * @throws QuereusError(NOTFOUND) if no named constraint matches.
 * @throws QuereusError(ERROR) if the name exists in more than one class (ambiguous).
 */
export function resolveNamedConstraintClass(tableSchema: TableSchema, constraintName: string): NamedConstraintClass {
	const lower = constraintName.toLowerCase();
	const inCheck = (tableSchema.checkConstraints ?? []).some(c => c.name?.toLowerCase() === lower);
	const inUnique = (tableSchema.uniqueConstraints ?? []).some(c => c.name?.toLowerCase() === lower);
	const inFk = (tableSchema.foreignKeys ?? []).some(c => c.name?.toLowerCase() === lower);
	const matchCount = [inCheck, inUnique, inFk].filter(Boolean).length;
	if (matchCount === 0) {
		throw new QuereusError(`Named constraint '${constraintName}' not found in table '${tableSchema.name}'`, StatusCode.NOTFOUND);
	}
	if (matchCount > 1) {
		throw new QuereusError(
			`Constraint name '${constraintName}' is ambiguous in table '${tableSchema.name}' (present in more than one of CHECK / UNIQUE / FOREIGN KEY)`,
			StatusCode.ERROR,
		);
	}
	return inCheck ? 'check' : inUnique ? 'unique' : 'foreignKey';
}

/**
 * True when `name` addresses any named CHECK / UNIQUE / FOREIGN KEY constraint on
 * the table. The existence-only sibling of {@link resolveNamedConstraintClass}
 * (which resolves the class and throws on absent/ambiguous), matching names the
 * same case-insensitive way.
 *
 * Lives here — not beside either caller — because two copies of a name-matching
 * rule drift. Used by the ALTER write paths that must refuse a duplicate constraint
 * name: `ADD CONSTRAINT`, an inline named constraint on `ADD COLUMN`, and
 * `RENAME CONSTRAINT`'s collision check.
 *
 * Engine-synthesized names (`_uc_*` / `_check_*` / `_fk_*`) are not user identity,
 * but they are stored in the same `name` fields, so a caller comparing a
 * user-supplied name against them is comparing against a name the user cannot have
 * typed — harmless, and not special-cased here.
 */
export function namedConstraintExists(tableSchema: TableSchema, name: string): boolean {
	const lower = name.toLowerCase();
	return (tableSchema.checkConstraints ?? []).some(c => c.name?.toLowerCase() === lower)
		|| (tableSchema.uniqueConstraints ?? []).some(c => c.name?.toLowerCase() === lower)
		|| (tableSchema.foreignKeys ?? []).some(c => c.name?.toLowerCase() === lower);
}

/**
 * Every constraint name a table currently holds (CHECK / UNIQUE / FK — the same
 * three arrays {@link namedConstraintExists} scans), case-folded. The set form of
 * that predicate, for callers that seed a mint-disambiguation taken-set
 * ({@link disambiguateAutoConstraintName}) rather than testing one name.
 */
export function collectTableConstraintNames(tableSchema: TableSchema): Set<string> {
	const names = new Set<string>();
	for (const c of tableSchema.checkConstraints ?? []) if (c.name) names.add(c.name.toLowerCase());
	for (const c of tableSchema.uniqueConstraints ?? []) if (c.name) names.add(c.name.toLowerCase());
	for (const c of tableSchema.foreignKeys ?? []) if (c.name) names.add(c.name.toLowerCase());
	return names;
}

/**
 * Refuses a *user-written* constraint name that is already taken — the within-table
 * name-uniqueness rule shared by every ALTER path that adds a named constraint
 * (`ADD CONSTRAINT`, and an inline named constraint on `ADD COLUMN`). Without it a
 * table can hold two constraints under one name, after which DROP / RENAME CONSTRAINT
 * hits every match (same class) or fails permanently as ambiguous (across classes).
 *
 * `alsoTaken` holds lowercased names claimed earlier in the SAME statement, none of
 * which is on `tableSchema` yet — one `ADD COLUMN` can declare several inline
 * constraints that collide with each other.
 *
 * Callers place this ahead of any module dispatch (a store-backed `alterTable`
 * persists, so a later throw would leave the duplicate on disk to rehydrate on
 * reopen) and ahead of `assertUniqueConstraintIndexNameFree`: the memory backend
 * materializes an existing UNIQUE's hidden backing index into the table's index list
 * and the store backend does not, so letting the index guard rule on a duplicate name
 * first makes the two backends disagree — and names an index the user never created.
 *
 * Engine-synthesized names (`_uc_*` / `_check_*` / `_fk_*`) are not user identity and
 * are never passed here; a name a user typed in that shape forfeits the guard, the
 * same corner `isAutoConstraintName` already documents for declarative lifecycle.
 *
 * @throws QuereusError(CONSTRAINT) when the name is taken.
 */
export function assertConstraintNameFree(tableSchema: TableSchema, name: string, alsoTaken?: ReadonlySet<string>): void {
	if (!alsoTaken?.has(name.toLowerCase()) && !namedConstraintExists(tableSchema, name)) return;
	throw new QuereusError(
		`Cannot add constraint '${name}' to table '${tableSchema.name}': a constraint with that name already exists`,
		StatusCode.CONSTRAINT,
	);
}

/**
 * Visits every *user-written* constraint name in a CREATE TABLE declaration —
 * column-level clauses first, then table-level, each in declaration order, with
 * the name spelled as the user typed it. Only the three classes that occupy a
 * named-constraint array (CHECK / UNIQUE / FOREIGN KEY) are visited: a name on
 * an inline NOT NULL / DEFAULT is not stored, so it cannot collide.
 *
 * The single walk behind both {@link collectDeclaredConstraintNames} (the mint
 * taken-set) and `assertNoDuplicateConstraintNames` (schema/catalog.ts, the
 * CREATE-time refusal), so the class filter cannot drift between the guard and
 * the set it guards.
 */
export function forEachDeclaredConstraintName(
	astColumns: ReadonlyArray<AST.ColumnDef>,
	astConstraints: ReadonlyArray<AST.TableConstraint> | undefined,
	visit: (name: string) => void,
): void {
	const claim = (con: { name?: string; type: string }): void => {
		if (!con.name) return;
		if (con.type !== 'check' && con.type !== 'unique' && con.type !== 'foreignKey') return;
		visit(con.name);
	};
	for (const colDef of astColumns) {
		for (const con of colDef.constraints ?? []) claim(con);
	}
	for (const con of astConstraints ?? []) claim(con);
}

/**
 * The statement-wide taken-set the CREATE TABLE mint sites disambiguate against:
 * every *user-written* CHECK / UNIQUE / FOREIGN KEY constraint name in the
 * declaration, case-folded. Seeded BEFORE any mint runs so a mint can never
 * collide with a user name declared later in the statement.
 */
export function collectDeclaredConstraintNames(
	astColumns: ReadonlyArray<AST.ColumnDef>,
	astConstraints: ReadonlyArray<AST.TableConstraint> | undefined,
): Set<string> {
	const names = new Set<string>();
	forEachDeclaredConstraintName(astColumns, astConstraints, name => names.add(name.toLowerCase()));
	return names;
}

/**
 * Collision-only disambiguation for an engine-minted constraint name
 * (`_check_<col>`, `_fk_<table>_<cols>`). The first occurrence keeps the base
 * name byte-identical to what the mint has always produced — the property that
 * keeps every non-colliding persisted name and corpus assertion unchanged; the
 * Nth colliding occurrence gets `_<N>` (N starting at 2), bumping past any
 * already-taken suffixed spelling. `taken` spans the statement's user-written
 * names ({@link collectDeclaredConstraintNames}) plus every earlier mint — one
 * case-folded name space across CHECK / UNIQUE / FK — so a mint can never
 * collide with a name the user typed, or with another mint. The chosen name is
 * registered into `taken` before returning.
 *
 * A suffixed name keeps the reserved `_` prefix, so `isAutoConstraintName`
 * (schema/catalog.ts) still classifies it as engine-synthesized.
 */
export function disambiguateAutoConstraintName(base: string, taken: Set<string>): string {
	let candidate = base;
	for (let n = 2; taken.has(candidate.toLowerCase()); n++) {
		candidate = `${base}_${n}`;
	}
	taken.add(candidate.toLowerCase());
	return candidate;
}

/**
 * Builds a map from column names to their indices in the columns array
 *
 * @param columns Array of column schemas
 * @returns Map of lowercase column names to their indices
 */
export function buildColumnIndexMap(columns: ReadonlyArray<ColumnSchema>): Map<string, number> {
	const map = new Map<string, number>();
	columns.forEach((col, index) => {
		map.set(col.name.toLowerCase(), index);
	});
	return map;
}

/**
 * Extracts just the column indices from a primary key definition
 *
 * @param pkDef Primary key definition array
 * @returns Array of column indices that form the primary key
 */
export function getPrimaryKeyIndices(pkDef: ReadonlyArray<PrimaryKeyColumnDefinition>): ReadonlyArray<number> {
	return Object.freeze(pkDef.map(def => def.index));
}

/**
 * Validates a column's explicit `COLLATE` name against the column's logical type
 * AND (when supplied) the connection's collation registry, returning the canonical
 * (normalized) form. Shared by CREATE TABLE column parsing (`columnDefToSchema`),
 * catalog rehydrate (`importTable`), and the runtime `ALTER COLUMN ... SET COLLATE`
 * path so all reject an unsupported collation with the same error shape.
 *
 * `BINARY` is always accepted (it needs no registration and every type supports it).
 *
 * When `isCollationRegistered` is **omitted** the function keeps its legacy
 * static-list behavior byte-for-byte: a type with a `supportedCollations` list
 * rejects any name not on it; a type with no list (INTEGER/REAL/BLOB) accepts any
 * name. This branch preserves every db-less caller (`createBasicSchema`, unit
 * tests, the view-MV DDL helper), none of which declare an unregistered explicit
 * collation on a no-list type.
 *
 * When `isCollationRegistered` **is** supplied the gate becomes registry-aware:
 *  - a name on the type's list (TEXT's BINARY/NOCASE/RTRIM) is accepted;
 *  - a type with an *empty* list (JSON/temporal) rejects every non-BINARY name,
 *    registered or not (the list precedes the registry);
 *  - otherwise — TEXT + a name off its list, OR a no-list type — the name is
 *    accepted iff the connection has it registered, and rejected otherwise. This
 *    both admits a registered custom collation on TEXT and closes the old hole
 *    where an unregistered name slid through on INTEGER/REAL/BLOB.
 *
 * The error keeps the exact `Unknown collation '<name>' for type '<type>'` prefix
 * (pinned by sqllogic); only the parenthetical suffix varies by case. The no-list
 * message must NOT dereference the (undefined) `supportedCollations`.
 *
 * @param collation Collation name as written
 * @param logicalType The column's logical type (carries `supportedCollations`)
 * @param columnName Column name, for the error message
 * @param isCollationRegistered Optional predicate: does the connection resolve this name?
 * @returns The canonical collation name
 * @throws QuereusError when the collation is not accepted for the type / registry
 */
export function validateCollationForType(
	collation: string,
	logicalType: LogicalType,
	columnName: string,
	isCollationRegistered?: (name: string) => boolean,
): string {
	const normalized = normalizeCollationName(collation);
	if (normalized === 'BINARY') return 'BINARY';

	const list = logicalType.supportedCollations;

	// Legacy branch: no predicate → static-list behavior, unchanged.
	if (isCollationRegistered === undefined) {
		if (list && !list.includes(normalized)) {
			throw new QuereusError(
				`Unknown collation '${collation}' for type '${logicalType.name}' on column '${columnName}' (expected one of: ${list.join(', ')})`,
				StatusCode.ERROR,
			);
		}
		return normalized;
	}

	// Registry-aware branch.
	if (list?.includes(normalized)) return normalized;

	if (list && list.length === 0) {
		throw new QuereusError(
			`Unknown collation '${collation}' for type '${logicalType.name}' on column '${columnName}' (type supports no collation other than BINARY)`,
			StatusCode.ERROR,
		);
	}

	if (isCollationRegistered(normalized)) return normalized;

	// A no-list type (INTEGER/REAL/BLOB) has no set of type collations to offer;
	// TEXT (and any non-empty-list custom type) lists its built-ins plus the
	// registry option.
	const suffix = list && list.length > 0
		? `(expected one of: ${list.join(', ')}, or a registered collation)`
		: `(not a registered collation)`;
	throw new QuereusError(
		`Unknown collation '${collation}' for type '${logicalType.name}' on column '${columnName}' ${suffix}`,
		StatusCode.ERROR,
	);
}

/**
 * Effective collation for a column that carries NO explicit COLLATE clause, given
 * the session `default_collation`. The default applies only when the column's
 * logical type explicitly supports it; otherwise BINARY (so a non-text column under
 * a non-BINARY default stays creatable / canonical).
 *
 * Used by {@link columnDefToSchema} (CREATE) AND the schema differ's
 * `extractDeclaredCollation` (APPLY) so the two never drift — create/apply parity
 * is what keeps `apply schema` idempotent under a non-BINARY default.
 *
 * The explicit `supportedCollations?.includes()` gate is deliberate and NOT the
 * same as {@link validateCollationForType}'s throw: a type with
 * `supportedCollations === undefined` (INTEGER/REAL/BLOB) is *accepted* by
 * `validateCollationForType` for any collation, so routing the default through that
 * path would silently give an INTEGER column a NOCASE collation. Gating on explicit
 * support instead falls those types back to BINARY, as the design requires. TEXT
 * supports BINARY/NOCASE/RTRIM; JSON/temporal carry an empty list ⇒ BINARY.
 *
 * Only the *implicit* default is gated this way; an *explicit* `COLLATE` clause
 * keeps its existing (looser) {@link validateCollationForType} handling.
 *
 * **Cross-backend divergence (intentional).** This function resolves the
 * *engine/memory* default only. The store module deliberately overrides an
 * implicit-default text PK column to its table-level key collation K (NOCASE by
 * default) via `reconcilePkCollations` (`quereus-store/store-module-schema-rewrite.ts`). So the
 * same DDL `create table t (x text primary key)` yields BINARY under the memory
 * module and NOCASE under the store. This is a deliberate backward-compatibility
 * choice, not a bug — see `docs/schema.md` §"Per-column PK key collation".
 */
export function resolveDefaultCollation(logicalType: LogicalType, defaultCollation: string): string {
	const normalized = normalizeCollationName(defaultCollation);
	if (normalized === 'BINARY') return 'BINARY';
	if (logicalType.supportedCollations?.includes(normalized)) return normalized;
	return 'BINARY';
}

/**
 * Converts a parsed ColumnDef AST node into a runtime ColumnSchema object
 *
 * @param def Column definition AST node
 * @param defaultNotNull Whether columns should be NOT NULL by default (Third Manifesto approach)
 * @param defaultCollation Session `default_collation` applied to columns with no explicit
 *   `COLLATE` clause (resolved via {@link resolveDefaultCollation}). Defaults to `'BINARY'`
 *   (no behavior change); the rehydrate path passes `'BINARY'` so persisted DDL stays canonical.
 * @param isCollationRegistered Optional predicate forwarded to {@link validateCollationForType}
 *   for an explicit `COLLATE` clause, so a collation the connection registered is accepted and
 *   an unregistered one is rejected for every type. Omit (db-less callers) for legacy static-list
 *   validation.
 * @returns A runtime ColumnSchema object
 */
export function columnDefToSchema(
	def: ColumnDef,
	defaultNotNull: boolean = true,
	defaultCollation: string = 'BINARY',
	isCollationRegistered?: (name: string) => boolean,
): ColumnSchema {
	// Infer logical type from the declared type name
	const logicalType = inferType(def.dataType);

	const schema: ColumnSchema = {
		name: def.name,
		logicalType: logicalType,
		notNull: defaultNotNull,
		primaryKey: false,
		pkOrder: 0,
		defaultValue: null,
		collation: resolveDefaultCollation(logicalType, defaultCollation),
		generated: false,
		declaredType: def.dataType,
	};

	for (const constraint of def.constraints ?? []) {
		switch (constraint.type) {
			case 'primaryKey':
				schema.primaryKey = true;
				schema.pkDirection = constraint.direction;
				if (constraint.onConflict !== undefined) {
					schema.defaultConflict = constraint.onConflict;
				}
				break;
			case 'notNull':
				schema.notNull = true;
				if (constraint.onConflict !== undefined) {
					schema.defaultConflict = constraint.onConflict;
				}
				break;
			case 'null':
				schema.notNull = false;
				if (constraint.onConflict !== undefined) {
					schema.defaultConflict = constraint.onConflict;
				}
				break;
			case 'unique':
				break;
			case 'default':
				schema.defaultValue = constraint.expr ?? null;
				break;
			case 'collate': {
				schema.collation = constraint.collation
					? validateCollationForType(constraint.collation, logicalType, def.name, isCollationRegistered)
					: 'BINARY';
				// Mark the collation as user-declared so modules can tell an explicit
				// `COLLATE` clause apart from the implicit default (see ColumnSchema).
				schema.collationExplicit = true;
				break;
			}
			case 'generated':
				schema.generated = true;
				if (constraint.generated) {
					schema.generatedExpr = constraint.generated.expr;
					schema.generatedStored = constraint.generated.stored;
				}
				break;
		}
	}

	if (schema.generated && schema.defaultValue !== null) {
		throw new QuereusError(
			`Column '${def.name}' cannot have both DEFAULT and GENERATED ALWAYS AS`,
			StatusCode.ERROR
		);
	}

	if (schema.primaryKey) {
		schema.notNull = true;
	}

	if (schema.primaryKey && schema.pkOrder === 0) {
		schema.pkOrder = 1;
	}

	// Thread column-level tags
	if (def.tags && Object.keys(def.tags).length > 0) {
		schema.tags = Object.freeze({ ...def.tags });
	}

	return schema;
}

/**
 * Mutation context variable definition
 */
export interface MutationContextDefinition {
	/** Variable name */
	name: string;
	/** Logical type of the variable */
	logicalType: import('../types/logical-type.js').LogicalType;
	/** Whether the variable is NOT NULL */
	notNull: boolean;
}

/**
 * Converts AST mutation context variable to schema definition
 *
 * @param varDef AST mutation context variable definition
 * @param defaultNotNull Whether variables should be NOT NULL by default
 * @returns Mutation context definition schema object
 */
export function mutationContextVarToSchema(varDef: AST.MutationContextVar, defaultNotNull: boolean = true): MutationContextDefinition {
	return {
		name: varDef.name,
		logicalType: inferType(varDef.dataType),
		notNull: varDef.notNull !== undefined ? varDef.notNull : defaultNotNull,
	};
}

/**
 * Defines a column in an index
 */
export interface IndexColumnSchema {
	/** Column index in TableSchema.columns */
	index: number;
	/** Whether the index should sort in descending order */
	desc?: boolean;	// default false
	/** Optional collation sequence for the column */
	collation?: string;
}

/**
 * Represents an index definition
 */
export interface IndexSchema {
	/** Index name */
	name: string;
	/** Columns in the index */
	columns: ReadonlyArray<IndexColumnSchema>;
	/** Whether the index enforces uniqueness on its key columns */
	unique?: boolean;
	/** Optional partial-index predicate (the WHERE clause AST). Rows for which this
	 *  evaluates to anything other than TRUE are excluded from the index and from
	 *  any UNIQUE enforcement that the index backs. */
	predicate?: Expression;
	/** Arbitrary metadata tags (informational only) */
	tags?: Readonly<Record<string, SqlValue>>;
}

/**
 * Returns a new TableSchema with `indexSchema` appended to its index list. When
 * the index is UNIQUE, also synthesizes a matching `derivedFromIndex`
 * uniqueConstraint (carrying the partial predicate) so the mutation manager and
 * the store's full-scan UNIQUE check enforce uniqueness through their existing
 * paths, and so `emitTableConstraints` knows to skip it (it round-trips via the
 * index, not as a table constraint).
 *
 * **Single source of truth** for the index→schema mutation. The three sites that
 * must agree all route through here so they cannot drift:
 *   - {@link SchemaManager.createIndex} — live `CREATE INDEX` DDL.
 *   - `SchemaManager.importIndex`        — catalog rehydrate (re-parsed DDL).
 *   - `StoreModule.createIndex`          — store-backed connected-table cache refresh.
 * The symmetric removal lives in `SchemaManager.dropIndex` / `StoreModule.dropIndex`,
 * which filter the derived constraint back out by `derivedFromIndex`.
 */
export function appendIndexToTableSchema(tableSchema: TableSchema, indexSchema: IndexSchema): TableSchema {
	const updatedIndexes = Object.freeze([...(tableSchema.indexes ?? []), indexSchema]);
	const result: TableSchema = { ...tableSchema, indexes: updatedIndexes };
	if (indexSchema.unique) {
		const derivedConstraint: UniqueConstraintSchema = {
			name: indexSchema.name,
			columns: Object.freeze(indexSchema.columns.map(c => c.index)),
			predicate: indexSchema.predicate,
			derivedFromIndex: indexSchema.name,
		};
		result.uniqueConstraints = Object.freeze([...(tableSchema.uniqueConstraints ?? []), derivedConstraint]);
	}
	return result;
}

/**
 * The renumbered position-bearing fields of `schema` after column `colIndex` is dropped, to be
 * spread over the schema alongside the caller's own new `columns` array — the DROP COLUMN mirror
 * of `shiftSchemaIndicesForInsert` (`vtab/memory/layer/manager.ts`, the ADD-COLUMN-at-a-position
 * equivalent). Shared by the memory module's `MemoryTableManager.dropColumn` and the store
 * module's `StoreModule.alterDropColumn`, whose position-renumbering logic had drifted apart
 * once already (the foreign-key pass was missing from both).
 *
 * A PRIMARY KEY member, UNIQUE constraint, or foreign key that names the dropped column is
 * removed outright rather than narrowed — one missing a column is a different, stronger
 * constraint, not a subset of the same one. A UNIQUE index is removed outright for the same
 * reason: narrowing `unique (b, c)` to `unique (c)` invents a constraint the table never
 * declared, and the matching `derivedFromIndex` UNIQUE constraint (the thing that actually
 * enforces it, see {@link appendIndexToTableSchema}) is removed by the rule above — so a
 * narrowed survivor would advertise uniqueness nothing checks — which the planner's
 * at-most-one-partner-row proof (`planner/mutation/multi-source.ts`) reads, `index_info` reports,
 * and `generateTableDDL` re-persists as a real `CREATE UNIQUE INDEX`. A plain index is narrowed
 * (it constrains nothing), and one that loses every column is dropped. Every survivor has its
 * column indices shifted down over the removed slot.
 *
 * `removedUniqueConstraints` (pre-shift, original column indices) is returned alongside so a
 * caller that materializes a physical structure per UNIQUE constraint — the memory module's
 * auto-built covering index, the store module's hidden `_uc_*` store — can tear down exactly the
 * ones this drop removes. That teardown, and the naming convention it keys off
 * (`uc.name ?? '_uc_<cols>'`), stays with each caller: neither structure is a `TableSchema` field,
 * and the two backends materialize them differently (index array entry vs. separate physical
 * store), so this function has no need to know it.
 *
 * `columnIndexMap` is rebuilt from the new column list by the caller, not returned here, matching
 * every other schema-mutation site. `checkConstraints` and each backend's own name/AST-keyed
 * bookkeeping need no shift. `generatedColumnDependencies` / `generatedColumnTopoOrder` are
 * likewise left to the caller: the engine recomputes them from column names right after DROP
 * COLUMN returns (`withGeneratedColumnGraph` in `runDropColumn`), so only a caller driving a
 * module's API directly ever observes a stale map — mirroring the same carve-out on the insert
 * side. `referencedColumns` on a foreign key is not touched, for the same reason as on the insert
 * side: enforcement resolves the parent indices on demand from `referencedColumnNames` against
 * the parent's CURRENT schema.
 */
export function shiftSchemaIndicesForDrop(schema: TableSchema, colIndex: number): {
	columns: ReadonlyArray<ColumnSchema>;
	primaryKeyDefinition: ReadonlyArray<PrimaryKeyColumnDefinition>;
	indexes: ReadonlyArray<IndexSchema>;
	uniqueConstraints: ReadonlyArray<UniqueConstraintSchema> | undefined;
	foreignKeys: ReadonlyArray<ForeignKeyConstraintSchema> | undefined;
	removedUniqueConstraints: ReadonlyArray<UniqueConstraintSchema>;
} {
	if (colIndex < 0 || colIndex >= schema.columns.length) {
		// Reachable only from a caller that skipped its own name lookup. Out of range, every
		// shift below is a silent no-op and the schema keeps a column the module has removed.
		quereusError(
			`shiftSchemaIndicesForDrop: column index ${colIndex} out of range for table '${schema.name}' `
				+ `(${schema.columns.length} columns)`,
			StatusCode.INTERNAL,
		);
	}

	const shift = (index: number): number => index > colIndex ? index - 1 : index;

	const columns = Object.freeze(schema.columns.filter((_, idx) => idx !== colIndex));

	const primaryKeyDefinition = Object.freeze(
		schema.primaryKeyDefinition
			.filter(def => def.index !== colIndex)
			.map(def => ({ ...def, index: shift(def.index) }))
	);

	const oldUniqueConstraints = schema.uniqueConstraints ?? [];
	const removedUniqueConstraints = Object.freeze(oldUniqueConstraints.filter(uc => uc.columns.includes(colIndex)));
	const remainingUniqueConstraints = oldUniqueConstraints
		.filter(uc => !uc.columns.includes(colIndex))
		.map(uc => ({ ...uc, columns: Object.freeze(uc.columns.map(shift)) }));

	const indexes = (schema.indexes ?? [])
		.filter(idx => !(idx.unique && idx.columns.some(ic => ic.index === colIndex)))
		.map(idx => ({
			...idx,
			columns: idx.columns
				.filter(ic => ic.index !== colIndex)
				.map(ic => ({ ...ic, index: shift(ic.index) })),
		}))
		.filter(idx => idx.columns.length > 0);

	const remainingForeignKeys = (schema.foreignKeys ?? [])
		.filter(fk => !fk.columns.includes(colIndex))
		.map(fk => ({ ...fk, columns: Object.freeze(fk.columns.map(shift)) }));

	return {
		columns,
		primaryKeyDefinition,
		indexes: Object.freeze(indexes),
		uniqueConstraints: remainingUniqueConstraints.length > 0 ? Object.freeze(remainingUniqueConstraints) : undefined,
		foreignKeys: remainingForeignKeys.length > 0 ? Object.freeze(remainingForeignKeys) : undefined,
		removedUniqueConstraints,
	};
}

/**
 * `schema` re-keyed to `newPkColumns` — a frozen copy whose `primaryKeyDefinition` AND
 * per-column `primaryKey` / `pkOrder` flags both describe the NEW key. The
 * `ALTER TABLE … ALTER PRIMARY KEY` sibling of {@link shiftSchemaIndicesForDrop} (same
 * role: one schema mutation shared by both built-in modules — the memory module's
 * `MemoryTableManager.buildRekeyedPrimaryKeySchema` and the store module's
 * `StoreModuleAlter.alterPrimaryKeyChange`).
 *
 * A table records its key twice: `primaryKeyDefinition` (authoritative — what
 * `table_info`, key extraction and the DDL generator read) and the per-column flags (a
 * CREATE-time mirror feeding the planner's uniqueness hints and the `ColumnDef` AST
 * that `RENAME COLUMN` reconstructs). Swapping only the definition leaves the flags
 * naming the retired key, so this helper rebuilds both together and is the only way
 * a module should re-key.
 *
 * Each member's `collation` is carried from its column (as `create table`'s PK builder
 * records it) — dropping it would silently re-key a NOCASE column's structures under
 * BINARY. `pkDirection` is deliberately NOT written: only an *inline*
 * `a integer primary key desc` populates it at CREATE time (a table-level
 * `primary key (a desc)` leaves it `undefined`), so direction is not a field this mirror
 * is expected to carry. It lives in `primaryKeyDefinition.desc`, which is what the DDL
 * generator reads. See the NOTE on {@link ColumnSchema.pkDirection}.
 *
 * The incoming `columns` are never mutated — a fresh array of fresh `ColumnSchema`
 * objects is built. The pre-ALTER schema is handed onward as `oldObject` on the
 * `table_modified` notification and kept by the memory manager as its rollback
 * snapshot, and `ColumnSchema` objects are not frozen, so in-place mutation would
 * silently corrupt both with nothing to catch it.
 *
 * User-level validation stays with the callers: the memory manager pre-checks by index and
 * the engine emitter (`runAlterPrimaryKey`) validates by column name before dispatch, so
 * NOT NULL membership is not re-checked here. What IS asserted — as {@link
 * shiftSchemaIndicesForDrop} asserts its column index — are the two inputs that would
 * otherwise yield a SELF-INCONSISTENT schema rather than a rejected statement: an
 * out-of-range index (a definition member addressing no column) and a repeated index (a
 * definition with more members than the mirror can order). Both mean a caller skipped its
 * own resolution, hence `INTERNAL`.
 */
export function rekeySchemaPrimaryKey(
	schema: TableSchema,
	newPkColumns: ReadonlyArray<{ index: number; desc?: boolean }>,
): TableSchema {
	// 1-based position in the new key, 0 for a non-member.
	const pkOrderByIndex = new Map<number, number>();
	for (const [position, pk] of newPkColumns.entries()) {
		if (pk.index < 0 || pk.index >= schema.columns.length) {
			quereusError(
				`rekeySchemaPrimaryKey: primary key column index ${pk.index} out of range for table `
					+ `'${schema.name}' (${schema.columns.length} columns)`,
				StatusCode.INTERNAL,
			);
		}
		if (pkOrderByIndex.has(pk.index)) {
			quereusError(
				`rekeySchemaPrimaryKey: column '${schema.columns[pk.index].name}' repeated in the new `
					+ `primary key for table '${schema.name}'`,
				StatusCode.INTERNAL,
			);
		}
		pkOrderByIndex.set(pk.index, position + 1);
	}

	const primaryKeyDefinition = Object.freeze(newPkColumns.map(pk => ({
		index: pk.index,
		desc: pk.desc ?? false,
		collation: schema.columns[pk.index].collation || 'BINARY',
	})));

	const columns = Object.freeze(schema.columns.map((col, index) => {
		const pkOrder = pkOrderByIndex.get(index) ?? 0;
		return { ...col, primaryKey: pkOrder > 0, pkOrder };
	}));

	return Object.freeze({ ...schema, columns, primaryKeyDefinition });
}

/**
 * Creates a basic TableSchema with minimal configuration
 *
 * @param name Table name
 * @param columns Array of column name and type objects
 * @param pkColNames Optional array of primary key column names
 * @param defaultNotNull Whether columns should be NOT NULL by default (defaults to true for Third Manifesto compliance)
 * @returns A frozen TableSchema object
 */
export function createBasicSchema(name: string, columns: { name: string, type: string }[], pkColNames?: string[], defaultNotNull: boolean = true): Readonly<TableSchema> {
	const columnSchemas = columns.map(c => columnDefToSchema({
		name: c.name,
		dataType: c.type,
		constraints: []
	}, defaultNotNull));
	const columnIndexMap = buildColumnIndexMap(columnSchemas);
	const pkDef = pkColNames
		? pkColNames.map(pkName => {
			const idx = columnIndexMap.get(pkName.toLowerCase());
			if (idx === undefined) quereusError(`PK column ${pkName} not found`);
			return { index: idx, desc: false };
		})
		: [];

	const defaultMemoryModule = new MemoryTableModule();

	return Object.freeze({
		name: name,
		schemaName: 'main',
		columns: columnSchemas,
		columnIndexMap: columnIndexMap,
		primaryKeyDefinition: pkDef,
		checkConstraints: [] as RowConstraintSchema[],
		indexes: [],
		vtabModule: defaultMemoryModule,
		vtabAuxData: null,
		vtabArgs: {},
		vtabModuleName: 'memory',
		isView: false,
		subqueryAST: undefined,
		viewDefinition: undefined,
		tableConstraints: [],
	});
}

/** Bitmask for row operations */
export const enum RowOpFlag {
	INSERT = 1,
	UPDATE = 2,
	DELETE = 4
}
export type RowOpMask = RowOpFlag;
export const DEFAULT_ROWOP_MASK = RowOpFlag.INSERT | RowOpFlag.UPDATE;

/**
 * Converts an array of row operations to a bitmask
 *
 * @param list Optional array of operation types
 * @returns A bitmask representing the operations
 */
export function opsToMask(list?: RowOp[]): RowOpMask {
	if (!list || list.length === 0) {
		return DEFAULT_ROWOP_MASK;
	}
	let mask: RowOpMask = 0 as RowOpMask;
	list.forEach(op => {
		switch (op) {
			case 'insert': mask |= RowOpFlag.INSERT; break;
			case 'update': mask |= RowOpFlag.UPDATE; break;
			case 'delete': mask |= RowOpFlag.DELETE; break;
		}
	});
	return mask;
}

/**
 * Converts an operation bitmask back to a `RowOp[]` in canonical insert→update→
 * delete order. Inverse of {@link opsToMask}. Used by the declarative differ's
 * constraint-body canonicalization (a stored CHECK keeps its operations as a
 * mask; comparing against a declared AST requires the array form).
 */
export function maskToOps(mask: RowOpMask): RowOp[] {
	const ops: RowOp[] = [];
	if (mask & RowOpFlag.INSERT) ops.push('insert');
	if (mask & RowOpFlag.UPDATE) ops.push('update');
	if (mask & RowOpFlag.DELETE) ops.push('delete');
	return ops;
}

/**
 * Represents a CHECK constraint with operation flags
 */
export interface RowConstraintSchema {
	/** Optional constraint name */
	name?: string;
	/** Constraint expression */
	expr: Expression;
	/** Bitmask of operations the constraint applies to */
	operations: RowOpMask;
	/** Whether the constraint is deferrable */
	deferrable?: boolean;
	/** Whether the constraint is initially deferred */
	initiallyDeferred?: boolean;
	/**
	 * Default conflict resolution declared at the constraint level (e.g.,
	 * `CHECK (...) ON CONFLICT IGNORE`). Statement-level OR clauses override.
	 */
	defaultConflict?: ConflictResolution;
	/** Arbitrary metadata tags (informational only) */
	tags?: Readonly<Record<string, SqlValue>>;
	/**
	 * Lens-synthesized **row-local CHECK only**: the lowercased basis-column names this
	 * constraint depends on, supplied by the prover (`collectLensRowLocalConstraints`)
	 * rather than re-derived from the AST. Superseded for the per-op decomposition gate by
	 * {@link referencedWriteRowRelations} (which additionally carries each column's owning
	 * basis relation, disambiguating two members that share a basis-column name) but kept
	 * as the bare-name introspection surface. Transient — set only on a write-plan-time
	 * constraint, never persisted to the catalog and never compared by the declarative
	 * differ. Undefined on FK / set-level lens constraints and on every basis-declared CHECK.
	 */
	referencedWriteRowColumns?: readonly string[];
	/**
	 * Lens-synthesized constraint (row-local CHECK / set-level uniqueness / child-FK /
	 * parent-FK): the write-row columns this constraint references, **each qualified by the
	 * basis relation that owns it**. The per-op decomposition gate (`constraintsForOp` in
	 * `view-mutation-builder`) prefers this over both {@link referencedWriteRowColumns} and
	 * its `writeRowColumns` AST walk: a constraint rides a member op iff every entry's
	 * `(schema, table)` matches the op's target relation. This is what fixes mis-routing a
	 * constraint onto a *sibling* decomposition member that merely shares a basis-column
	 * NAME with the column-owning member (e.g. two members both spelling their value column
	 * `val`). Lens collectors source the owning relation from the slot's decomposition
	 * advertisement members (or its single basis source for a non-decomposition lens), so it
	 * is populated for every lens class. Transient — never persisted to the catalog and
	 * never compared by the declarative differ. Undefined on basis-declared CHECKs and when
	 * the owning relation could not be resolved (the gate then falls back to the bare-name
	 * path).
	 */
	referencedWriteRowRelations?: readonly ReferencedWriteRowRelation[];
}

/**
 * One write-row column of a lens-synthesized constraint, qualified by the basis
 * relation that owns it — the relation-identity unit the per-op decomposition gate
 * matches against an op's target relation. See
 * {@link RowConstraintSchema.referencedWriteRowRelations}.
 */
export interface ReferencedWriteRowRelation {
	/** Owning basis relation's schema (original case; matched case-insensitively). */
	readonly schema: string;
	/** Owning basis relation's table name (original case; matched case-insensitively). */
	readonly table: string;
	/** The basis column name on that relation (lowercased). */
	readonly column: string;
}

/**
 * The collision-proof per-relation **write-row correlation name** — the decomposition
 * analogue of the `NEW` write-row correlation, distinct per owning member relation so two
 * basis columns that share a NAME across decomposition members never collapse to the same
 * rewritten AST term.
 *
 * The lens logical→basis CHECK rewrite (`planner/mutation/lens-enforcement.ts`) qualifies a
 * mapped write-row column with this name (instead of bare `NEW`) on a multi-member
 * decomposition, and the per-op constraint scope (`planner/building/constraint-builder.ts`)
 * registers `<corr>.<col>` for the op's own target relation. So a row-local CHECK over one
 * member's column resolves on that member's op while a sibling-member term fails to resolve
 * (a loud `Column not found` rather than a silent wrong answer) — matching the per-op gate's
 * relation-identity routing. Capture-safe for the same reason `NEW` is: neither `new` nor the
 * `__lens_new__` prefix is a reserved keyword, but both are vanishingly implausible as a
 * user-written subquery-FROM alias — unlike the bare basis table name, which a subquery's FROM
 * routinely references, and which therefore could NOT be used here without reintroducing the
 * shadow-capture bug `NEW` was added to avoid.
 */
export function writeRowRelationCorrelation(schema: string, table: string): string {
	return `__lens_new__${schema.toLowerCase()}__${table.toLowerCase()}`;
}

/**
 * Represents a FOREIGN KEY constraint linking child columns to a parent table
 */
export interface ForeignKeyConstraintSchema {
	/** Optional constraint name */
	name?: string;
	/** Column indices in this (child) table */
	columns: ReadonlyArray<number>;
	/** Referenced (parent) table name */
	referencedTable: string;
	/** Referenced schema (default: same schema) */
	referencedSchema?: string;
	/** Column indices in the parent table */
	referencedColumns: ReadonlyArray<number>;
	/**
	 * Referenced column names for deferred resolution.
	 * Parent column indices can't be resolved at schema creation time because
	 * the parent table may not exist yet. These names are resolved to indices
	 * at enforcement time via {@link resolveReferencedColumns}.
	 */
	referencedColumnNames?: ReadonlyArray<string>;
	/** Action on parent DELETE (default: 'restrict') */
	onDelete: import('../parser/ast.js').ForeignKeyAction;
	/** Action on parent UPDATE of referenced columns (default: 'restrict') */
	onUpdate: import('../parser/ast.js').ForeignKeyAction;
	/** Whether enforcement is deferred to COMMIT */
	deferred: boolean;
	/**
	 * Default conflict resolution declared at the FK constraint level. Statement-level
	 * OR clauses override.
	 */
	defaultConflict?: ConflictResolution;
	/** Arbitrary metadata tags (informational only) */
	tags?: Readonly<Record<string, SqlValue>>;
}

/**
 * Resolves referenced column indices in the parent table from a FK schema.
 * Uses stored column names or falls back to the parent's primary key.
 */
export function resolveReferencedColumns(
	fk: ForeignKeyConstraintSchema,
	parentSchema: TableSchema,
): number[] {
	const refColNames = fk.referencedColumnNames;

	if (refColNames && refColNames.length > 0) {
		return refColNames.map(name => {
			const idx = parentSchema.columnIndexMap.get(name.toLowerCase());
			if (idx === undefined) {
				throw new QuereusError(
					`Referenced column '${name}' not found in table '${parentSchema.name}'`,
					StatusCode.ERROR
				);
			}
			return idx;
		});
	}

	// Default to primary key columns
	return parentSchema.primaryKeyDefinition.map(pk => pk.index);
}

/**
 * {@link resolveReferencedColumns} plus the arity check every ENFORCEMENT site
 * needs: a FK whose child column count does not match the resolved parent key
 * cannot be checked at all, so the statement must fail rather than quietly skip
 * the constraint.
 *
 * The gap this closes is the `references <Parent>` form with no parent column
 * list: the declaration builders (`schema/constraint-builder.ts`
 * `buildForeignKeyConstraintSchema`, `SchemaManager.extractForeignKeys`) compare
 * counts only when a parent column list is written, and the defaulted form
 * resolves to the parent's primary key — which may not exist yet (forward
 * references are legal, see docs/sql-ddl.md § Order Independence) and can change
 * arity later. So the arity is only knowable at enforcement time, and every
 * enforcement site routes through here.
 *
 * Introspection / optimization callers (key-utils, ind-utils, lens FK
 * discovery, `foreign_key_info`) keep using {@link resolveReferencedColumns} —
 * a malformed FK must not make a read query fail.
 */
export function resolveReferencedColumnsForEnforcement(
	fk: ForeignKeyConstraintSchema,
	parentSchema: TableSchema,
	childSchema: TableSchema,
): number[] {
	const parentColIndices = resolveReferencedColumns(fk, parentSchema);
	if (parentColIndices.length === fk.columns.length) return parentColIndices;

	const fkName = fk.name ?? `_fk_${childSchema.name}`;
	const child = `${childSchema.schemaName}.${childSchema.name}`;
	const parent = `${parentSchema.schemaName}.${parentSchema.name}`;
	const target = (fk.referencedColumnNames && fk.referencedColumnNames.length > 0)
		? `${parentColIndices.length} column(s) of '${parent}'`
		: `the primary key of '${parent}', which has ${parentColIndices.length} column(s)`;
	throw new QuereusError(
		`Foreign key '${fkName}' on table '${child}': ${fk.columns.length} column(s) reference ${target}.`,
		StatusCode.ERROR,
	);
}

/**
 * Represents a UNIQUE constraint on one or more columns (beyond the primary key)
 */
export interface UniqueConstraintSchema {
	/** Optional constraint name */
	name?: string;
	/** Column indices in this table that form the unique constraint */
	columns: ReadonlyArray<number>;
	/**
	 * Default conflict resolution declared at the constraint level (e.g.,
	 * `email TEXT UNIQUE ON CONFLICT REPLACE`). Statement-level OR clauses override.
	 */
	defaultConflict?: ConflictResolution;
	/** Optional partial-index predicate (the WHERE clause AST). Mirrored from the
	 *  backing IndexSchema so the runtime can skip uniqueness checks for rows that
	 *  fall outside the partial scope. Only set when the constraint was synthesized
	 *  from a `CREATE UNIQUE INDEX ... WHERE ...`. */
	predicate?: Expression;
	/** When set, this constraint was synthesized from a UNIQUE index of the
	 *  given name (see appendIndexToTableSchema). DROP INDEX of that
	 *  index removes this constraint. Unset for constraints declared at
	 *  CREATE TABLE time. */
	derivedFromIndex?: string;
	/**
	 * Forward pointer to the covering structure that realizes this constraint —
	 * the name of an auto-built secondary index (the implicit covering structure)
	 * or of an explicit materialized view recognized by the coverage prover. This
	 * is the **source of truth** for the constraint↔structure link; a covering
	 * MV's `TableDerivation.covers` is the convenience reverse link.
	 * Set eagerly at MV-creation time, cleared when that MV is dropped. A
	 * "constraint is logical, structure is optional" surface. When the named
	 * structure is a covering MV (every MV is row-time maintained), UNIQUE conflict
	 * resolution routes through its backing table in preference to the auto-index
	 * (see `docs/mv-constraints.md` § Enforcement through a covering MV);
	 * a `stale` covering MV is not row-time consistent and is not used for
	 * enforcement. See `docs/schema.md`.
	 */
	coveringStructureName?: string;
	/** Arbitrary metadata tags (informational only) */
	tags?: Readonly<Record<string, SqlValue>>;
	/**
	 * User-addressable tags for this constraint's *exposed* implicit covering index
	 * (the one opted into catalog visibility via `quereus.expose_implicit_index`).
	 * Kept SEPARATE from `tags` (which holds the exposure flag + constraint tags) so
	 * the exposure flag never leaks into the surfaced index tags and the differ can
	 * treat the two independently. Only consulted for backends that do NOT
	 * materialize the implicit index as an `IndexSchema` (i.e. the store); in memory
	 * mode the tags live on the materialized `IndexSchema.tags` instead.
	 */
	exposedIndexTags?: Readonly<Record<string, SqlValue>>;
}

export interface PrimaryKeyColumnDefinition {
	index: number;
	desc?: boolean;	// default false
	collation?: string;
}

/**
 * Helper to parse primary key from AST column and table constraints.
 * @param columns Parsed column definitions from AST.
 * @param constraints Parsed table constraints from AST.
 * @returns The primary-key column list plus any table-level
 * `PRIMARY KEY (...) ON CONFLICT <action>` directive, and a `synthesized` flag.
 * `defaultConflict` is undefined when the PK was column-declared (column-level
 * `ON CONFLICT` lives on `ColumnSchema.defaultConflict`) or when no `ON CONFLICT`
 * was declared on the table-level constraint. `synthesized` is `true` only on the
 * no-PK all-columns fallback below (`false` for any explicitly-declared PK,
 * including the empty-key `primary key ()` singleton). Callers must NOT promote a
 * synthesized key's columns to NOT NULL — the whole row is the identity, but each
 * column keeps its declared (or session-default) nullability.
 * @throws QuereusError if multiple primary keys are defined or PK column not found.
 */
export function findPKDefinition(
	columns: ReadonlyArray<ColumnSchema>,
	constraints: ReadonlyArray<AST.TableConstraint> | undefined,
): {
	pkDef: ReadonlyArray<PrimaryKeyColumnDefinition>;
	defaultConflict: ConflictResolution | undefined;
	synthesized: boolean;
} {
	const columnPK = findColumnPKDefinition(columns);
	const constraintPK = findConstraintPKDefinition(columns, constraints);

	if (constraintPK && columnPK) {
		throw new QuereusError("Cannot define both table-level and column-level PRIMARY KEYs", StatusCode.CONSTRAINT);
	}

	const declaredPkDef: ReadonlyArray<PrimaryKeyColumnDefinition> | undefined =
		constraintPK?.pkDef ?? columnPK;

	if (declaredPkDef) {
		return {
			pkDef: declaredPkDef,
			defaultConflict: constraintPK?.defaultConflict,
			synthesized: false,
		};
	}

	// Quereus-specific behavior: Include all columns in the primary key when no explicit primary key is defined
	// This differs from SQLite which would use the first INTEGER column or an implicit rowid
	// This design choice ensures predictable behavior and avoids potential confusion with SQLite's implicit rules
	warnLog(`No PRIMARY KEY explicitly defined. Including all columns in primary key.`);
	const synthesizedPkDef = Object.freeze(
		columns.map((col, index) => ({
			index,
			desc: false,
			collation: col.collation || 'BINARY'
		}))
	);

	// A synthesized all-columns key does NOT force NOT NULL on its members — each
	// column keeps the nullability the author declared (or the session default).
	// NULL-in-key is supported by both backends (memory: NULL == NULL sorts first;
	// store: TYPE_NULL=0x00), so the whole-row identity stays valid with nullable
	// members. Only an explicitly-declared PK promotes nullability (see
	// `buildColumnSchemas` and `columnDefToSchema`).
	return {
		pkDef: synthesizedPkDef,
		defaultConflict: undefined,
		synthesized: true,
	};
}

/**
 * True when a table's primary key is the **synthesized all-columns key** — the
 * no-PK fallback produced by {@link findPKDefinition}: every column index in
 * declaration order, ascending, with no declared PK conflict action.
 *
 * Canonical-DDL emitters ({@link generateTableDDL}) use this to OMIT the PRIMARY
 * KEY clause for such a key. Re-parsing DDL that names an all-columns PK would
 * treat it as an *explicitly-declared* PK and force its columns NOT NULL —
 * silently dropping a nullable declaration on a store persistence round-trip
 * (the very promotion {@link findPKDefinition} deliberately avoids for a
 * synthesized key). Omitting the clause lets the re-parse re-synthesize the same
 * key while preserving each column's declared nullability.
 *
 * Detection is by shape rather than a stored flag so it holds regardless of how
 * the schema was constructed (CREATE, store rehydrate, module rebuild). An
 * explicitly-declared all-columns PK has the identical shape and re-synthesizes
 * to an identical schema (a declared PK has already forced its columns NOT NULL),
 * so treating the two alike is sound. The conflict-action guard keeps an explicit
 * `primary key (...) on conflict X` on its own declared emission path.
 */
export function isSynthesizedAllColumnsKey(tableSchema: TableSchema): boolean {
	const pk = tableSchema.primaryKeyDefinition;
	const n = tableSchema.columns.length;
	if (n === 0 || pk.length !== n) return false;
	if (tableSchema.primaryKeyDefaultConflict !== undefined) return false;
	return pk.every((def, i) => def.index === i && !def.desc);
}

/**
 * Resolves the per-constraint default conflict action for PK conflicts, per the
 * precedence documented on {@link TableSchema.primaryKeyDefaultConflict}:
 * table-level `PRIMARY KEY (...) ON CONFLICT <action>` first, else the
 * column-level `defaultConflict` on **any** PK column (set by a column-level
 * `primary key` / `not null` / `null` `ON CONFLICT` clause). Returns undefined
 * when no action is declared (⇒ the statement-level OR, else ABORT, applies).
 *
 * The single in-package source for this rule (used by the memory-layer runtime
 * resolver and the lens prover's deploy-time soundness check, so the two agree
 * on what a duplicate would resolve to). The separate `quereus-isolation` and
 * `quereus-store` packages carry structurally identical copies for their own
 * boundaries; consolidating those across packages is tracked separately.
 */
export function resolvePkDefaultConflict(schema: TableSchema): ConflictResolution | undefined {
	if (schema.primaryKeyDefaultConflict !== undefined) return schema.primaryKeyDefaultConflict;
	for (const def of schema.primaryKeyDefinition) {
		const col = schema.columns[def.index];
		if (col?.defaultConflict !== undefined) return col.defaultConflict;
	}
	return undefined;
}

/**
 * Which declared whole-table key a column set matched — the PRIMARY KEY or a
 * specific non-partial UNIQUE constraint. Surfaced (over the boolean
 * {@link columnsFormDeclaredKey}) so a caller can read the matched key's governing
 * conflict action: the basis key whose `defaultConflict` a duplicate actually
 * resolves to (the prover's bijection-transport conflict-action check needs it,
 * mirroring the row-time path's `BasisCovering.uc`).
 */
export type DeclaredKeyMatch =
	| { kind: 'primaryKey' }
	| { kind: 'unique'; constraint: UniqueConstraintSchema };

/**
 * The declared whole-table key whose column set (as a set) exactly equals
 * `indices` — the PRIMARY KEY or a non-partial UNIQUE constraint on `table` — or
 * `undefined`. Exact set-equality mirrors how `on conflict (cols)` resolves a
 * constraint by its column set; a partial UNIQUE (`predicate !== undefined`,
 * synthesized from `CREATE UNIQUE INDEX … WHERE …`) only guarantees uniqueness
 * within its scope and cannot back an unqualified conflict target, so it is
 * skipped.
 *
 * The single in-package source for "do these columns form a declared whole-table
 * key": the lens decomposition compiler's 1:1-stitch guard
 * (`lens-compiler.ts validatePrimaryAdvertisement`, via {@link columnsFormDeclaredKey})
 * and the prover's bijection-transport key proof
 * (`lens-prover.ts proveKeyByBijectionTransport`, which reads the matched key)
 * both consume it, so the two agree on what counts as a basis key.
 */
export function findDeclaredKey(table: TableSchema, indices: readonly number[]): DeclaredKeyMatch | undefined {
	const want = new Set(indices);
	const eq = (cols: readonly number[]): boolean => cols.length === want.size && cols.every(c => want.has(c));
	const pk = table.primaryKeyDefinition.map(p => p.index);
	if (pk.length > 0 && eq(pk)) return { kind: 'primaryKey' };
	for (const uc of table.uniqueConstraints ?? []) {
		if (uc.predicate !== undefined) continue; // partial UNIQUE is not a whole-table key
		if (eq(uc.columns)) return { kind: 'unique', constraint: uc };
	}
	return undefined;
}

/** True when `indices` exactly forms a declared whole-table key — the boolean-only
 *  wrapper over {@link findDeclaredKey} (the caller does not need which key matched). */
export function columnsFormDeclaredKey(table: TableSchema, indices: readonly number[]): boolean {
	return findDeclaredKey(table, indices) !== undefined;
}

/**
 * Every declared whole-table key on `table` whose column set is a **subset** of
 * `indices` — the PRIMARY KEY and each non-partial UNIQUE constraint that `indices`
 * subsumes. The subset (`⊆`) sibling of {@link findDeclaredKey}'s exact (`=`) match,
 * returning *all* matches rather than the one exact key.
 *
 * Where exact-match answers "is this key `proved` **via transport**" — an authored
 * bijection onto an *exact* basis key (a strict superset does not *prove* the smaller
 * key's uniqueness, so exact-match is correct there) — subset answers a different
 * question: "which declared basis keys **govern** a write-through duplicate of this
 * key?" A logical key whose mapped basis columns ⊇ a basis key K is, for any two rows
 * equal on the full logical key, also equal on K — so K fires on *every* logical-key
 * duplicate. Governance therefore needs subset, not equality: a logical key that is a
 * strict superkey of a smaller basis key is governed by that smaller basis key even
 * though no basis key set-equals the logical key's columns.
 *
 * Consumed by the prover's proved-key conflict-action check
 * (`lens-prover.ts rejectBasisGovernedConflictActionForProvedKey`): the basis key whose
 * `defaultConflict` a duplicate actually resolves to must be identified by subset, so a
 * superkey of a smaller basis key (which exact-match misses) is still covered. Partial
 * UNIQUE constraints are skipped for the same reason as in {@link findDeclaredKey} — they
 * only guarantee uniqueness within their scope, so they do not unconditionally govern.
 */
export function findGoverningBasisKeys(table: TableSchema, indices: readonly number[]): DeclaredKeyMatch[] {
	const want = new Set(indices);
	const subset = (cols: readonly number[]): boolean => cols.length > 0 && cols.every(c => want.has(c));
	const matches: DeclaredKeyMatch[] = [];
	const pk = table.primaryKeyDefinition.map(p => p.index);
	if (subset(pk)) matches.push({ kind: 'primaryKey' });
	for (const uc of table.uniqueConstraints ?? []) {
		if (uc.predicate !== undefined) continue; // partial UNIQUE only governs within its scope
		if (subset(uc.columns)) matches.push({ kind: 'unique', constraint: uc });
	}
	return matches;
}

function findConstraintPKDefinition(
	columns: readonly ColumnSchema[],
	constraints: readonly TableConstraint[] | undefined
): {
	pkDef: PrimaryKeyColumnDefinition[];
	defaultConflict: ConflictResolution | undefined;
} | undefined {
	const colMap = buildColumnIndexMap(columns);
	let result: {
		pkDef: PrimaryKeyColumnDefinition[];
		defaultConflict: ConflictResolution | undefined;
	} | undefined;

	if (constraints) {
		for (const constraint of constraints) {
			if (constraint.type === 'primaryKey') {
				if (result) {
					throw new QuereusError("Multiple table-level PRIMARY KEY constraints defined", StatusCode.CONSTRAINT);
				}
				let pkDef: PrimaryKeyColumnDefinition[];
				if (!constraint.columns || constraint.columns.length === 0) {
					// An empty column list is fine; means table can have 0-1 rows
					pkDef = [];
				} else {
					pkDef = constraint.columns.map(colInfo => {
						const colIndex = colMap.get(colInfo.name.toLowerCase());
						if (colIndex === undefined) {
							throw new QuereusError(`PRIMARY KEY column '${colInfo.name}' not found in table definition`, StatusCode.ERROR);
						}
						return {
							index: colIndex,
							desc: colInfo.direction === 'desc',
							collation: columns[colIndex].collation || 'BINARY'
						};
					});
				}
				result = { pkDef, defaultConflict: constraint.onConflict };
			}
		}
	}
	return result;
}

function findColumnPKDefinition(columns: ReadonlyArray<ColumnSchema>): ReadonlyArray<PrimaryKeyColumnDefinition> | undefined {
	const pkCols = columns
		.map((col, index) => ({ ...col, originalIndex: index }))
		.filter(col => col.primaryKey)
		.sort((a, b) => a.pkOrder - b.pkOrder);

	if (pkCols.length > 1 && pkCols.some(col => col.pkOrder === 0)) {
		warnLog("Multiple column-level PRIMARY KEYs defined without explicit pkOrder; consider a table-level PRIMARY KEY for composite keys.");
	}

	if (pkCols.length > 1) {
		warnLog('Multiple columns defined as PRIMARY KEY at column level. Forming a composite key.');
	}

	if (pkCols.length === 0) {
		return undefined;
	}

	return Object.freeze(pkCols.map(col => ({
		index: col.originalIndex,
		desc: col.pkDirection === 'desc',
		collation: col.collation || 'BINARY'
	})));
}

/**
 * Returns a copy of `tableSchema` with `generatedColumnDependencies` and
 * `generatedColumnTopoOrder` recomputed from its current column list.
 * Throws on cycle. The other fields are preserved as-is.
 *
 * `resolveColumnInSource` is the catalog-backed resolver
 * (`buildColumnSourceResolver(db)`) the scope-aware reference analysis
 * consults for inner FROM sources; questions about this table itself are
 * answered from `tableSchema.columns` (the catalog may hold a stale
 * pre-ALTER column set, or not hold the table at all).
 */
export function withGeneratedColumnGraph(
	tableSchema: TableSchema,
	resolveColumnInSource: ResolveColumnInSource,
): TableSchema {
	const rawDeps = extractGeneratedColumnDependencies(
		tableSchema.columns, tableSchema.name, tableSchema.schemaName, resolveColumnInSource);
	if (rawDeps.size === 0) {
		return Object.freeze({
			...tableSchema,
			generatedColumnDependencies: undefined,
			generatedColumnTopoOrder: undefined,
		});
	}
	const topoOrder = topoSortGeneratedColumns(tableSchema.columns, rawDeps);
	const frozenDeps = new Map<number, ReadonlyArray<number>>();
	for (const [k, v] of rawDeps) frozenDeps.set(k, Object.freeze(v));
	return Object.freeze({
		...tableSchema,
		generatedColumnDependencies: frozenDeps,
		generatedColumnTopoOrder: Object.freeze(topoOrder),
	});
}

/**
 * Wrap the catalog-backed source resolver so questions about the table under
 * analysis are answered from the in-flight column list instead of the catalog:
 * at CREATE TABLE the catalog does not hold the table yet, and at DROP COLUMN
 * it still holds the pre-drop column set. `extraColumnLower` covers ALTER ADD
 * COLUMN, where the resolver must answer for the post-ALTER column set the
 * emitter's re-analysis will see.
 */
function resolveWithInFlightColumns(
	resolve: ResolveColumnInSource,
	schemaName: string,
	tableName: string,
	columnIndexMap: ReadonlyMap<string, number>,
	extraColumnLower?: string,
): ResolveColumnInSource {
	const schemaLower = schemaName.toLowerCase();
	const tableLower = tableName.toLowerCase();
	return (sourceSchema, sourceName, columnName) => {
		if (sourceSchema.toLowerCase() === schemaLower && sourceName.toLowerCase() === tableLower) {
			const colLower = columnName.toLowerCase();
			return columnIndexMap.has(colLower) || colLower === extraColumnLower;
		}
		return resolve(sourceSchema, sourceName, columnName);
	};
}

/**
 * For each generated column, collects the column indices in this table that
 * its expression references, via the scope-aware collector
 * (`./generated-column-refs.ts`) — a name bound by a FROM clause inside the
 * expression belongs to that source, not to this table. Per reference:
 *
 * - `'own'` binding: a known column records a dependency edge; an unknown
 *   name of `'column'` shape is rejected ("not found") so typos surface at
 *   CREATE TABLE / ALTER TABLE time rather than at INSERT/UPDATE time; an
 *   unknown `'identifier'` is ignored (it may legitimately be a function or
 *   mutation-context variable).
 * - `'foreign'` binding: ignored entirely.
 * - `'unknown'` binding (an opaque subquery / function / CTE source
 *   intervenes): a known column records an edge (a missing edge would compute
 *   a generated column before its dependency and silently write NULL);
 *   an unknown name is ignored silently. Net effect vs. the scope-blind
 *   analysis this replaced: only ever accepts more, never less.
 */
export function extractGeneratedColumnDependencies(
	columns: ReadonlyArray<ColumnSchema>,
	tableName: string,
	schemaName: string,
	resolveColumnInSource: ResolveColumnInSource,
): Map<number, number[]> {
	const columnIndexMap = buildColumnIndexMap(columns);
	const resolve = resolveWithInFlightColumns(
		resolveColumnInSource, schemaName, tableName, columnIndexMap);
	const result = new Map<number, number[]>();

	columns.forEach((col, colIdx) => {
		if (!col.generated || !col.generatedExpr) return;

		const deps = new Set<number>();
		for (const ref of collectGeneratedColumnRefs(col.generatedExpr, tableName, schemaName, resolve)) {
			if (ref.binding === 'foreign') continue;
			const refIdx = columnIndexMap.get(ref.name);
			if (refIdx !== undefined) {
				deps.add(refIdx);
			} else if (ref.binding === 'own' && ref.shape === 'column') {
				throw new QuereusError(
					`Column '${ref.originalName}' referenced by generated column '${col.name}' not found in table '${tableName}'`,
					StatusCode.ERROR,
				);
			}
		}

		result.set(colIdx, Array.from(deps).sort((a, b) => a - b));
	});

	return result;
}

/**
 * Pre-flight for `ALTER TABLE ADD COLUMN … GENERATED ALWAYS AS (<expr>)`, run at
 * plan-build BEFORE the expression is compiled against a scope holding only the
 * table's existing columns. Without it, a reference the table cannot satisfy surfaces
 * as the generic `Column not found: <name>` from expression resolution — and for a
 * self-reference (`add column g … generated always as (g + 1)`) that names the very
 * column the statement is declaring, which reads as nonsense.
 *
 * Raises the same two errors the equivalent `CREATE TABLE` raises — from
 * {@link extractGeneratedColumnDependencies} and {@link topoSortGeneratedColumns},
 * which still run in the emitter afterwards — so the two authoring surfaces report a
 * bad generated expression identically. It only moves those rejections EARLIER; it
 * cannot reject anything they would accept.
 *
 * A self-reference is the only cycle ADD COLUMN can create: an existing column's
 * expression cannot name a column that does not exist yet.
 */
export function validateAddColumnGeneratedRefs(
	expr: AST.Expression,
	newColumnName: string,
	existingColumns: ReadonlyArray<ColumnSchema>,
	tableName: string,
	schemaName: string,
	resolveColumnInSource: ResolveColumnInSource,
): void {
	const columnIndexMap = buildColumnIndexMap(existingColumns);
	const newColLower = newColumnName.toLowerCase();
	// `add column v … generated always as (v * 2)` where `v` ALREADY exists is a duplicate
	// column, not a cycle; the reference resolves to the existing sibling. Leave the
	// rejection to `runAddColumn`'s duplicate check so the message names the real problem.
	const newColumnIsDuplicate = columnIndexMap.has(newColLower);
	// Resolve questions about this table from the POST-ALTER column set (existing
	// plus the new column): the emitter re-runs `extractGeneratedColumnDependencies`
	// on that set, and this pre-flight must accept exactly what it will.
	const resolve = resolveWithInFlightColumns(
		resolveColumnInSource, schemaName, tableName, columnIndexMap, newColLower);

	for (const ref of collectGeneratedColumnRefs(expr, tableName, schemaName, resolve)) {
		if (ref.binding === 'foreign') continue;
		// Both `'own'` and `'unknown'` bindings of the new column's own name are a
		// self-cycle here: the emitter's re-analysis records a dependency edge for
		// either (see extractGeneratedColumnDependencies) and its topological sort
		// then raises this same error — this pre-flight only moves it earlier.
		if (ref.name === newColLower && !newColumnIsDuplicate) {
			throw new QuereusError(
				`Cyclic dependency in generated columns: '${newColumnName}'`,
				StatusCode.ERROR,
			);
		}
		// Only an `'own'`-bound `column` shape yields "not found" — an `'unknown'`
		// binding may bind an opaque inner source, and a bare `identifier` may
		// legitimately resolve to something that is not a column of this table.
		if (ref.binding === 'own' && ref.shape === 'column' && !columnIndexMap.has(ref.name)) {
			throw new QuereusError(
				`Column '${ref.originalName}' referenced by generated column '${newColumnName}' not found in table '${tableName}'`,
				StatusCode.ERROR,
			);
		}
	}
}

/**
 * Topologically sorts generated columns so a generated column's dependencies
 * come before it. Throws on any cycle (including self-edges).
 *
 * The graph nodes are generated-column indices only — edges from a generated
 * column to a non-generated column are ignored for topo purposes (only
 * gen→gen edges can form cycles).
 */
export function topoSortGeneratedColumns(
	columns: ReadonlyArray<ColumnSchema>,
	deps: ReadonlyMap<number, ReadonlyArray<number>>,
): number[] {
	const genIndices = new Set<number>();
	for (const idx of deps.keys()) genIndices.add(idx);

	// Build in-degree only over gen→gen edges
	const inDegree = new Map<number, number>();
	const adjacency = new Map<number, number[]>();
	for (const idx of genIndices) {
		inDegree.set(idx, 0);
		adjacency.set(idx, []);
	}
	for (const [genIdx, depList] of deps) {
		for (const depIdx of depList) {
			if (!genIndices.has(depIdx)) continue;
			adjacency.get(depIdx)!.push(genIdx);
			inDegree.set(genIdx, (inDegree.get(genIdx) ?? 0) + 1);
		}
	}

	// Kahn's algorithm
	const queue: number[] = [];
	for (const [idx, deg] of inDegree) {
		if (deg === 0) queue.push(idx);
	}
	queue.sort((a, b) => a - b); // Stable ordering: prefer declaration order on ties

	const order: number[] = [];
	while (queue.length > 0) {
		const idx = queue.shift()!;
		order.push(idx);
		for (const next of adjacency.get(idx) ?? []) {
			const newDeg = inDegree.get(next)! - 1;
			inDegree.set(next, newDeg);
			if (newDeg === 0) {
				// Insert preserving sorted order so output is deterministic
				let inserted = false;
				for (let i = 0; i < queue.length; i++) {
					if (queue[i] > next) {
						queue.splice(i, 0, next);
						inserted = true;
						break;
					}
				}
				if (!inserted) queue.push(next);
			}
		}
	}

	if (order.length < genIndices.size) {
		const offending = Array.from(genIndices)
			.filter(i => !order.includes(i))
			.map(i => `'${columns[i].name}'`)
			.join(', ');
		throw new QuereusError(
			`Cyclic dependency in generated columns: ${offending}`,
			StatusCode.ERROR,
		);
	}

	return order;
}

