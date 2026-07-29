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
import { traverseAst } from '../parser/visitor.js';
import type { TableStatistics } from '../planner/stats/catalog-stats.js';

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
 * default) via `reconcilePkCollations` (`quereus-store/store-module.ts`). So the
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
 * constraint, not a subset of the same one. An index entry that loses every column this way is
 * dropped too. Every survivor has its column indices shifted down over the removed slot.
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
 */
export function withGeneratedColumnGraph(tableSchema: TableSchema): TableSchema {
	const rawDeps = extractGeneratedColumnDependencies(tableSchema.columns, tableSchema.name);
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
 * For each generated column, walks its expression AST and collects the column
 * indices in this table that the expression references. Unknown column names
 * referenced unqualified (or qualified to this table) are rejected with a
 * specific error so typos surface at CREATE TABLE / ALTER TABLE time rather
 * than at INSERT/UPDATE time.
 *
 * References qualified to a different table are skipped — they belong to
 * an outer scope (e.g. a scalar subquery's source) and don't constitute a
 * dependency on this table's columns.
 */
export function extractGeneratedColumnDependencies(
	columns: ReadonlyArray<ColumnSchema>,
	tableName: string,
): Map<number, number[]> {
	const columnIndexMap = buildColumnIndexMap(columns);
	const tableNameLower = tableName.toLowerCase();
	const result = new Map<number, number[]>();

	columns.forEach((col, colIdx) => {
		if (!col.generated || !col.generatedExpr) return;

		const deps = new Set<number>();
		traverseAst(col.generatedExpr as AST.AstNode, {
			enterNode: (node: AST.AstNode) => {
				if (node.type === 'column') {
					const ref = node as AST.ColumnExpr;
					if (ref.table && ref.table.toLowerCase() !== tableNameLower) return;
					const refIdx = columnIndexMap.get(ref.name.toLowerCase());
					if (refIdx === undefined) {
						throw new QuereusError(
							`Column '${ref.name}' referenced by generated column '${col.name}' not found in table '${tableName}'`,
							StatusCode.ERROR,
						);
					}
					deps.add(refIdx);
				} else if (node.type === 'identifier') {
					const ref = node as AST.IdentifierExpr;
					if (ref.schema) return;
					const refIdx = columnIndexMap.get(ref.name.toLowerCase());
					if (refIdx !== undefined) deps.add(refIdx);
				}
			},
		});

		result.set(colIdx, Array.from(deps).sort((a, b) => a - b));
	});

	return result;
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

