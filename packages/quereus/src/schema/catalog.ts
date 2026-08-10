import type { Database } from '../core/database.js';
import type { TableSchema, IndexSchema, IndexColumnSchema, UniqueConstraintSchema } from './table.js';
import { forEachDeclaredConstraintName } from './table.js';
import type { ViewSchema } from './view.js';
import { normalizeBackingModule } from './view.js';
import { isMaintainedTable, type MaintainedTableSchema } from './derivation.js';
import type { IntegrityAssertionSchema } from './assertion.js';
import { createTableToString, createViewToString, createMaterializedViewToString, createIndexToString, createAssertionToString, quoteIdentifier, expressionToString, viewDefinitionToCanonicalString } from '../emit/ast-stringify.js';
import type * as AST from '../parser/ast.js';
import { type SqlValue, StatusCode } from '../common/types.js';
import { QuereusError } from '../common/errors.js';
import { generateTableDDL, generateIndexDDL, generateMaintainedTableDDL, constraintToCanonicalDDL, indexToCanonicalDDL } from './ddl-generator.js';
import { applyViewSchemaDefault, applyAssertionSchemaDefault } from './schema-differ.js';
import { ENGINE_MANAGED_TABLE_TAG } from './reserved-tags.js';

/**
 * Represents a catalog snapshot of the current database schema state
 */
export interface SchemaCatalog {
	schemaName: string;
	tables: CatalogTable[];
	views: CatalogView[];
	indexes: CatalogIndex[];
	assertions: CatalogAssertion[];
}

export interface CatalogTable {
	name: string;
	ddl: string;
	columns: Array<{
		name: string;
		type: string;
		notNull: boolean;
		primaryKey: boolean;
		defaultValue: AST.Expression | null;
		/** Canonical collation (normalized, uppercase). Default `'BINARY'`. */
		collation: string;
		tags?: Readonly<Record<string, SqlValue>>;
	}>;
	primaryKey: Array<{ columnName: string; desc: boolean }>;
	/** Lowercased names of tables this table FK-references (within the same schema). */
	referencedTables: string[];
	tags?: Readonly<Record<string, SqlValue>>;
	/**
	 * Named constraints (CHECK / UNIQUE / FOREIGN KEY) carrying their tags and a
	 * canonical body fragment. Constraints without a user-supplied name are excluded.
	 * `definition` is the order/format-stable body DDL (name + tags excluded) the
	 * differ compares against a declared constraint's body to detect a
	 * name-unchanged-but-body-changed constraint (→ drop+recreate). Tags are kept
	 * separate (and out of `definition`) so a tag-only change takes `ALTER
	 * CONSTRAINT … SET TAGS`, not a needless drop+recreate.
	 */
	namedConstraints: Array<{ name: string; tags?: Readonly<Record<string, SqlValue>>; definition: string }>;
	/**
	 * Present iff this is a **maintained table** (carries a `derivation` — what
	 * `create materialized view` / `create table … maintained as` produces). A
	 * maintained table round-trips in the table category like any other table; this
	 * descriptor carries the extra derivation dimension the differ compares to
	 * recognize attach / detach / re-attach transitions (table↔maintained) as
	 * non-destructive alter ops instead of a drop+recreate. `bodyHash` is the
	 * canonical DEFINITION hash (`computeBodyHash` over `viewDefinitionToCanonicalString`
	 * — explicit rename list + body + `insert defaults`; name / schema / tags
	 * excluded), matching the live `derivation.bodyHash`. Absent ⇒ a plain table.
	 */
	maintained?: {
		bodyHash: string;
		/** Normalized backing-host module when non-default (absent ⇒ memory). */
		backingModuleName?: string;
		/** Backing-module args; recorded only when non-empty. */
		backingModuleArgs?: Readonly<Record<string, SqlValue>>;
		/**
		 * The live derivation body AST, for the differ's rename-artifact-tolerant
		 * hash re-compare (see `CatalogView.select`). Read-only to consumers.
		 */
		select?: AST.QueryExpr;
	};
}

export interface CatalogView {
	name: string;
	ddl: string;
	/**
	 * Canonical definition string (explicit column list, body, `insert defaults`
	 * clause; name / schema / tags excluded — see
	 * `viewDefinitionToCanonicalString`). The differ compares this against a
	 * declared view's definition — rendered by the same function — to detect a
	 * name-matched view whose definition changed (→ drop+recreate), mirroring
	 * `CatalogIndex.definition`. Tags are kept separate (and out of `definition`)
	 * so a tag-only change takes `ALTER VIEW … SET TAGS`, not a needless
	 * drop+recreate.
	 */
	definition: string;
	tags?: Readonly<Record<string, SqlValue>>;
	/**
	 * The live body AST behind `definition`. The differ needs it for the
	 * rename-artifact-tolerant compare (`absorbRenameArtifacts`): the live
	 * rename propagation can write an engine-authored schema qualifier or FROM
	 * alias into a stored body, and only a structural walk against the declared
	 * AST can tell those artifacts from a real edit. Optional so hand-built
	 * catalogs without it simply skip that tolerance (strict compare). Treated
	 * as read-only by every consumer — it is the live schema's AST, not a copy.
	 */
	select?: AST.QueryExpr;
}

export interface CatalogIndex {
	name: string;
	tableName: string;
	ddl: string;
	/**
	 * Canonical body string (UNIQUE-ness, column set/order/direction, per-column
	 * collation, partial predicate; name / `on <table>` / tags excluded). Per-column
	 * collation is rendered from the resolved effective value (the same value both
	 * diff sides pre-resolve — see `indexToCanonicalDDL` / the differ's
	 * `declaredIndexCanonicalBody`), so an inherited/default-BINARY collation that is
	 * unchanged never churns while a real collation change recreates. The differ
	 * compares this against a declared index's body — rendered by the same
	 * `createIndexBodyToCanonicalString` — to detect a name-matched index whose
	 * body changed (→ drop+recreate), mirroring `CatalogTable.namedConstraints[].
	 * definition` and `CatalogMaterializedView.bodyHash`. Tags are kept separate
	 * (and out of `definition`) so a tag-only change takes `ALTER INDEX … SET TAGS`,
	 * not a needless drop+recreate.
	 */
	definition: string;
	tags?: Readonly<Record<string, SqlValue>>;
	/**
	 * True when this index is an *exposed implicit covering structure* — the
	 * secondary BTree backing a UNIQUE constraint tagged
	 * `quereus.expose_implicit_index`. Surfaced for introspection only; its
	 * lifecycle is the originating constraint's (the named-constraint diff path),
	 * so the schema differ MUST exclude it from the standalone-index
	 * create/drop/rename buckets (see `computeSchemaDiff`'s `actualIndexes`).
	 * Absent/false ⇒ an ordinary, differ-managed index.
	 */
	implicit?: boolean;
}

export interface CatalogAssertion {
	name: string;
	ddl: string;
	/**
	 * Canonical CHECK-expression rendering (name / schema excluded), so the
	 * differ compares bodies without name-qualification noise, mirroring
	 * `CatalogView.definition` / `CatalogIndex.definition`.
	 */
	definition: string;
	/**
	 * The live CHECK expression AST behind `definition`, for the differ's
	 * rename-artifact-tolerant compare (see `CatalogView.select`). Absent for
	 * the hypothetical violationSql-only reconstruction path. Read-only to
	 * consumers.
	 */
	check?: AST.Expression;
}

/**
 * True when a constraint name is engine-synthesized rather than user-supplied.
 * The schema extractors auto-name unnamed column/table constraints with a
 * reserved `_`-leading prefix (`_check_<col>`, `_fk_<table>_<cols>`,
 * `_uc_<cols>`); such names are deterministic from structure but are NOT stable
 * identity a declarative schema can reference, so they are excluded from the
 * catalog's user-addressable `namedConstraints` (which drives differ
 * add/drop/rename lifecycle). A user who explicitly names a constraint `_x`
 * forfeits declarative lifecycle management of it — an acceptable corner.
 */
function isAutoConstraintName(name: string): boolean {
	return name.startsWith('_');
}

/**
 * True when a table is **engine-managed** — a relation the engine (or an
 * engine-driven module) synthesizes and owns, marked with the reserved
 * `quereus.engine_managed = true` tag. Such a table is excluded from the catalog
 * entirely (see {@link collectSchemaCatalog}), so the declarative differ never
 * emits a create/drop for it and `export_schema` omits it — while it stays
 * resolvable via `getTable` / `getAllTables` for every other path. The motivating
 * case is Lamina's lens basis layer, whose per-column `(rowId, value)` member
 * relations register into the basis scope's `Schema`; without this exclusion a
 * bare in-place `apply schema <basis>` would diff them as orphan tables and drop
 * each. Sibling of the implicit-covering-index exclusion (`CatalogIndex.implicit`).
 */
function isEngineManagedTable(tableSchema: TableSchema): boolean {
	return tableSchema.tags?.[ENGINE_MANAGED_TABLE_TAG] === true;
}

/**
 * Collects current schema state from the database into a catalog representation
 */
export function collectSchemaCatalog(db: Database, schemaName: string = 'main'): SchemaCatalog {
	const schema = db.schemaManager.getSchema(schemaName);
	if (!schema) {
		return {
			schemaName,
			tables: [],
			views: [],
			indexes: [],
			assertions: []
		};
	}

	const tables: CatalogTable[] = [];
	const views: CatalogView[] = [];
	const indexes: CatalogIndex[] = [];
	const assertions: CatalogAssertion[] = [];

	// Collect tables. A maintained table (one carrying a `derivation` — what
	// `create materialized view` / `create table … maintained as` produces)
	// round-trips in the TABLE category like any other table, carrying a
	// `maintained` descriptor (body hash + backing module) so the declarative
	// differ compares it per name in one category and recognizes attach / detach /
	// re-attach transitions as non-destructive alter ops. Its internal covering
	// indexes stay OUT of the catalog `indexes` set — they are a maintenance
	// backing detail, not differ-managed objects. (Check maintained BEFORE isView:
	// a maintained table may legacy-carry isView.)
	for (const tableSchema of schema.getAllTables()) {
		// Engine-managed tables (e.g. Lamina's per-column `(rowId, value)` basis
		// member relations) are excluded from the catalog UNCONDITIONALLY — before
		// the maintained / isView branches — so the declarative differ never sees
		// them as orphans to drop nor as objects to create, and `export_schema`
		// omits them. They remain resolvable via `getTable` / `getAllTables` for
		// compile / introspection / servicing. Sibling of the implicit-covering-index
		// exclusion (see `CatalogIndex.implicit`).
		if (isEngineManagedTable(tableSchema)) continue;
		if (isMaintainedTable(tableSchema)) {
			tables.push(tableSchemaToCatalog(tableSchema, db));
			continue;
		}
		if (tableSchema.isView) continue;
		tables.push(tableSchemaToCatalog(tableSchema, db));

		// Collect indexes for this table. Implicit covering structures (the
		// auto-built secondary BTree a declared UNIQUE constraint synthesizes for
		// enforcement) are a backing detail and are omitted by default, surfaced
		// only when the originating constraint opts in via
		// `quereus.expose_implicit_index` — preserving the user-visible shape.
		if (tableSchema.indexes && tableSchema.indexes.length > 0) {
			const implicit = implicitCoveringIndexExposure(tableSchema);
			for (const indexSchema of tableSchema.indexes) {
				// Map keys are lowercased (see `implicitCoveringIndexExposure`); without
				// the fold a mixed-case constraint name leaks its hidden backing structure
				// into the catalog as an ordinary index, which the declarative differ then
				// tries to DROP.
				const exposed = implicit.get(indexSchema.name.toLowerCase());
				if (exposed === false) continue; // hidden implicit covering structure
				// Mark only the *exposed* implicit covering structure (exposed === true);
				// an ordinary index (absent from the exposure map ⇒ undefined) stays
				// unmarked so the differ manages it normally.
				indexes.push(indexSchemaToCatalog(indexSchema, tableSchema, db, exposed === true));
			}
		}

		// Surface exposed implicit covering indexes the backend did NOT
		// materialize as `IndexSchema` entries (store mode). In memory mode this
		// returns [] (the name is already in `tableSchema.indexes` above), so the
		// catalog shape matches across backends with no double-listing. Tags ride
		// on the descriptor (from `uc.exposedIndexTags`), kept out of the canonical
		// `definition` so a tag-only change stays `ALTER INDEX … SET TAGS`.
		for (const desc of exposedImplicitIndexes(tableSchema)) {
			// Every synthetic descriptor is exposed-implicit by construction → mark it.
			indexes.push(indexSchemaToCatalog(desc, tableSchema, db, true));
		}
	}

	// Collect views
	for (const viewSchema of schema.getAllViews()) {
		views.push(viewSchemaToCatalog(viewSchema));
	}

	// Collect assertions
	for (const assertionSchema of schema.getAllAssertions()) {
		assertions.push(assertionSchemaToCatalog(assertionSchema));
	}

	return {
		schemaName,
		tables,
		views,
		indexes,
		assertions
	};
}

function tableSchemaToCatalog(tableSchema: TableSchema, db: Database): CatalogTable {
	// Canonical DDL: a maintained table renders the `create table … maintained as`
	// form (carrying its derivation body), a plain table the ordinary form.
	const maintainedTable = isMaintainedTable(tableSchema) ? tableSchema : undefined;
	const ddl = maintainedTable ? generateMaintainedTableDDL(maintainedTable) : generateTableDDL(tableSchema, db);

	const columns = tableSchema.columns.map(col => ({
		name: col.name,
		type: col.logicalType.name,
		notNull: col.notNull,
		primaryKey: col.primaryKey,
		defaultValue: col.defaultValue ?? null,
		collation: col.collation || 'BINARY',
		tags: col.tags,
	}));

	const primaryKey = tableSchema.primaryKeyDefinition.map(pk => ({
		columnName: tableSchema.columns[pk.index].name,
		desc: pk.desc ?? false,
	}));

	// FK references within the same schema (cross-schema FKs are excluded — drop
	// ordering only matters for tables whose lifetimes are tied to this schema).
	const ownSchemaLower = tableSchema.schemaName.toLowerCase();
	const referencedTables: string[] = [];
	const seen = new Set<string>();
	for (const fk of tableSchema.foreignKeys ?? []) {
		const refSchema = (fk.referencedSchema ?? tableSchema.schemaName).toLowerCase();
		if (refSchema !== ownSchemaLower) continue;
		const refName = fk.referencedTable.toLowerCase();
		if (refName === tableSchema.name.toLowerCase()) continue; // self-FK
		if (seen.has(refName)) continue;
		seen.add(refName);
		referencedTables.push(refName);
	}

	// Surface *user-addressable* named constraints with their tags so the differ
	// can detect renames / drops / adds of named CHECK / UNIQUE / FOREIGN KEY
	// constraints. Excluded:
	//   - engine-synthesized names (the `_check_*` / `_fk_*` / `_uc_*` auto-names
	//     the extractors assign to unnamed column/table constraints) — these are
	//     not stable identity a user can reference declaratively, and surfacing
	//     them would churn add/drop on every diff against a declaration that only
	//     carries explicit names (see `isAutoConstraintName`);
	//   - UNIQUE constraints synthesized from a `CREATE UNIQUE INDEX`
	//     (`derivedFromIndex`) — those are managed as indexes (the differ's
	//     index buckets), not as table constraints.
	const namedConstraints: CatalogTable['namedConstraints'] = [];
	for (const c of tableSchema.checkConstraints ?? []) {
		if (c.name && !isAutoConstraintName(c.name)) {
			namedConstraints.push({ name: c.name, tags: c.tags, definition: constraintToCanonicalDDL('check', c, tableSchema) });
		}
	}
	for (const c of tableSchema.uniqueConstraints ?? []) {
		if (c.name && !isAutoConstraintName(c.name) && !c.derivedFromIndex) {
			namedConstraints.push({ name: c.name, tags: c.tags, definition: constraintToCanonicalDDL('unique', c, tableSchema) });
		}
	}
	for (const c of tableSchema.foreignKeys ?? []) {
		if (c.name && !isAutoConstraintName(c.name)) {
			namedConstraints.push({ name: c.name, tags: c.tags, definition: constraintToCanonicalDDL('foreignKey', c, tableSchema) });
		}
	}

	return {
		name: tableSchema.name,
		ddl,
		columns,
		primaryKey,
		referencedTables,
		tags: tableSchema.tags,
		namedConstraints,
		...(maintainedTable ? { maintained: maintainedDescriptor(maintainedTable) } : {}),
	};
}

/**
 * The derivation dimension surfaced on a maintained table's catalog entry — the
 * canonical body hash plus the normalized backing module (compared separately
 * from the hash, the module is deliberately not folded into the hash formula).
 * The differ uses this to recognize a body change (re-attach) vs an unchanged
 * maintained table (no-op), and table↔maintained transitions (attach / detach).
 */
function maintainedDescriptor(table: MaintainedTableSchema): NonNullable<CatalogTable['maintained']> {
	const backing = normalizeBackingModule(table.vtabModuleName, table.vtabArgs);
	return {
		bodyHash: table.derivation.bodyHash,
		backingModuleName: backing.storedModuleName,
		backingModuleArgs: backing.storedModuleArgs,
		select: table.derivation.selectAst,
	};
}

function viewSchemaToCatalog(viewSchema: ViewSchema): CatalogView {
	return {
		name: viewSchema.name,
		ddl: viewSchema.sql,
		definition: viewDefinitionToCanonicalString(viewSchema.columns, viewSchema.selectAst),
		tags: viewSchema.tags,
		select: viewSchema.selectAst,
	};
}

/**
 * Tag opting a UNIQUE constraint's implicit covering structure into catalog /
 * `export_schema` visibility. Off by default — the auto-built secondary BTree is
 * a backing detail of enforcement, not part of the user-visible schema shape.
 */
const EXPOSE_IMPLICIT_INDEX_TAG = 'quereus.expose_implicit_index';

/**
 * Maps each implicit-covering-structure index name to its exposure flag. An index
 * is an implicit covering structure when it is the secondary BTree auto-built to
 * back a declared (inline) UNIQUE constraint — identified by the deterministic
 * auto-index name `uc.name ?? '_uc_<cols>'` (see
 * `MemoryTableManager.ensureUniqueConstraintIndexes`). Constraints synthesized
 * from a real `CREATE UNIQUE INDEX` (`derivedFromIndex` set) are excluded — that
 * index is the user's, always shown. The flag is `true` when the constraint
 * carries {@link EXPOSE_IMPLICIT_INDEX_TAG} (surface it), `false` otherwise
 * (hide). Index names absent from the map are ordinary indexes (always shown).
 *
 * Keys are **lowercased** — index names are matched case-insensitively
 * everywhere else in the engine (`createIndex`, `dropIndex`, `updateIndexTags`
 * all compare on `toLowerCase()`), so callers must look up a lowercased name.
 */
function implicitCoveringIndexExposure(tableSchema: TableSchema): Map<string, boolean> {
	const map = new Map<string, boolean>();
	for (const uc of tableSchema.uniqueConstraints ?? []) {
		if (uc.derivedFromIndex) continue;
		map.set(implicitIndexName(tableSchema, uc).toLowerCase(), uc.tags?.[EXPOSE_IMPLICIT_INDEX_TAG] === true);
	}
	return map;
}

/**
 * Deterministic name of the implicit covering structure realizing `uc` —
 * `uc.name` when the constraint is named, else the auto-name `_uc_<cols>`. This is
 * the single source of the name shared by the catalog exposure map, the synthetic
 * descriptor, and `MemoryTableManager.ensureUniqueConstraintIndexes` (which
 * materializes the identical name).
 */
function implicitIndexName(tableSchema: TableSchema, uc: UniqueConstraintSchema): string {
	return implicitIndexNameForColumns(uc.name, uniqueConstraintColumnNames(tableSchema.columns, uc));
}

/**
 * The names of the columns `uc` covers, in declaration order, resolved against
 * `columns`. An index with no column falls back to its own number — the same
 * degenerate-input handling every other resolver here uses; it cannot arise from a
 * built schema, whose constraint columns are resolved through `columnIndexMap`.
 */
function uniqueConstraintColumnNames(
	columns: ReadonlyArray<{ name: string }>,
	uc: UniqueConstraintSchema,
): string[] {
	return uc.columns.map(i => columns[i]?.name ?? String(i));
}

/**
 * The same name rule as {@link implicitIndexName}, expressed over column *names*
 * rather than a resolved {@link UniqueConstraintSchema}. Declaration-time callers
 * (`ALTER TABLE … ADD CONSTRAINT`, `ADD COLUMN … unique`) hold only the statement's
 * column names — an `ADD COLUMN`'s column does not even exist on the table yet — so
 * they cannot go through the schema-resolved form.
 *
 * Keep this the ONLY spelling of the `_uc_<cols>` rule in this package.
 * `quereus-store`'s `implicitUniqueIndexName` and
 * `MemoryTableManager.implicitIndexNameFor` mirror it for their own backends and
 * must stay equal to it.
 */
function implicitIndexNameForColumns(constraintName: string | undefined, columnNames: ReadonlyArray<string>): string {
	return constraintName ?? `_uc_${columnNames.join('_')}`;
}

/**
 * The existing index on `tableSchema` whose name would be claimed by the backing
 * structure of a UNIQUE constraint declared as `constraintName` over
 * `columnNames` — or undefined when the name is free.
 *
 * The mirror image of the guard {@link SchemaManager.createIndex} applies from the
 * index side via {@link isImplicitCoveringIndex}: one name, one table, two objects
 * that both want it. Left unguarded, the constraint's backing structure adopts the
 * index's name and the user's index stops being addressable — it vanishes from
 * `schema()` / `index_info()`, `DROP INDEX` reports `no such index`, and on the
 * store backend the persisted `CREATE INDEX` line is dropped from the catalog
 * entry (`buildCatalogEntry` skips whatever `isHiddenImplicitIndex` reports).
 *
 * Matched case-insensitively, like every other index-name comparison in the
 * engine. Deliberately name-only: the legitimate "reuse an existing index to back
 * a constraint" case matches on *columns*, not names, and is unaffected. Matching
 * columns do NOT make the collision benign — see the callers.
 *
 * `columnNames` is consulted only when `constraintName` is undefined (the
 * `_uc_<cols>` auto-name); a named constraint ignores it.
 *
 * NOTE: reads `.indexes` only, which is what makes it backend-independent — a user
 * index is in `tableSchema.indexes` on every backend, so this collision is refused
 * identically everywhere. The OTHER producer of a shared structure name — a second
 * UNIQUE constraint on the same table deriving the same name — is deliberately not
 * this function's business: `.indexes` sees it under memory (which materializes a
 * constraint's structure there) and not under store, so reading it here would make
 * the two backends disagree. {@link findUniqueConstraintSharingBackingName} handles
 * that arm off `uniqueConstraints`, which both backends carry, and
 * {@link assertUniqueConstraintIndexNameFree} runs it first.
 */
function findIndexShadowedByUniqueConstraint(
	tableSchema: TableSchema,
	constraintName: string | undefined,
	columnNames: ReadonlyArray<string>,
): IndexSchema | undefined {
	const wanted = implicitIndexNameForColumns(constraintName, columnNames).toLowerCase();
	return (tableSchema.indexes ?? []).find(idx => idx.name.toLowerCase() === wanted);
}

/**
 * The UNIQUE constraint already on `tableSchema` whose own backing structure name is
 * the one a constraint declared as `constraintName` over `columnNames` would take —
 * or undefined when no other constraint holds it.
 *
 * The constraint-side twin of {@link findIndexShadowedByUniqueConstraint}. Two
 * spellings reach it: a constraint name carrying the engine's reserved `_uc_` prefix
 * (`constraint _uc_z unique (b)` beside `unique (z)`), and the `_`-joined auto-name
 * colliding on ordinary column names (`unique (a_b)` beside `unique (a, b)` — both
 * derive `_uc_a_b`). Left unguarded the second constraint adopts the first's
 * structure and is then enforced by one keyed on the OTHER constraint's columns, so
 * it silently stops rejecting duplicates.
 *
 * Reads `uniqueConstraints`, which every backend carries, so the refusal is identical
 * on memory and store. Case-folded, like every other index-name comparison here.
 *
 * `derivedFromIndex` constraints are skipped: such a constraint's backing structure
 * IS the `CREATE UNIQUE INDEX` that synthesized it, already in `.indexes` and already
 * compared by the sibling arm — matching it here would report one collision twice
 * under two different messages.
 *
 * Deliberately compares against the table's CURRENT derived names, including those of
 * constraints a RENAME COLUMN is about to move. That is sufficient: two constraints
 * can only newly collide under a rename if both cover the renamed column, and two such
 * names differ only in their unrenamed parts — which the rename leaves alone.
 */
function findUniqueConstraintSharingBackingName(
	tableSchema: TableSchema,
	constraintName: string | undefined,
	columnNames: ReadonlyArray<string>,
): UniqueConstraintSchema | undefined {
	const wanted = implicitIndexNameForColumns(constraintName, columnNames).toLowerCase();
	return (tableSchema.uniqueConstraints ?? []).find(uc =>
		uc.derivedFromIndex === undefined
		&& implicitIndexName(tableSchema, uc).toLowerCase() === wanted);
}

/**
 * How a UNIQUE constraint is named back to the user in a collision message: by the
 * name they wrote when it has one, else by the columns they wrote.
 */
function describeUniqueConstraint(constraintName: string | undefined, columnNames: ReadonlyArray<string>): string {
	return constraintName !== undefined ? `'${constraintName}'` : `on (${columnNames.join(', ')})`;
}

/**
 * Rejects a UNIQUE constraint declaration whose implicit backing structure would
 * claim a name already held on the same table — by another UNIQUE constraint's
 * backing structure ({@link findUniqueConstraintSharingBackingName}) or by an index
 * ({@link findIndexShadowedByUniqueConstraint}). No-op for any other constraint kind
 * — CHECK and FOREIGN KEY build no backing index, so they cannot collide.
 *
 * Called from the engine side BEFORE `module.alterTable`, which is what makes one
 * guard cover both backends and keeps a rejected statement from reaching the
 * store's persistence side effects.
 *
 * The constraint arm runs FIRST so a collision both arms can see reports identically
 * on memory and store: memory materializes a constraint's structure into `.indexes`
 * and store does not, so letting the index arm rule first would name an index the
 * user never created under one backend and a constraint under the other.
 *
 * `operation` describes what the statement was doing, e.g.
 * `add constraint 'foo' to table 't'`.
 */
export function assertUniqueConstraintIndexNameFree(
	tableSchema: TableSchema,
	constraintName: string | undefined,
	columnNames: ReadonlyArray<string>,
	operation: string,
): void {
	const backingName = implicitIndexNameForColumns(constraintName, columnNames);

	const sibling = findUniqueConstraintSharingBackingName(tableSchema, constraintName, columnNames);
	if (sibling) {
		const siblingDescription = describeUniqueConstraint(
			sibling.name,
			uniqueConstraintColumnNames(tableSchema.columns, sibling),
		);
		throw new QuereusError(
			`Cannot ${operation}: its backing structure '${backingName}' would collide with the backing structure `
				+ `of the UNIQUE constraint ${siblingDescription} on the same table. Rename the constraint.`,
			StatusCode.CONSTRAINT,
		);
	}

	const shadowed = findIndexShadowedByUniqueConstraint(tableSchema, constraintName, columnNames);
	if (!shadowed) return;
	throw new QuereusError(
		`Cannot ${operation}: its backing index '${backingName}' would collide with existing index '${shadowed.name}' `
			+ `on the same table. Rename the constraint or the index.`,
		StatusCode.CONSTRAINT,
	);
}

/**
 * The pairwise form of {@link assertUniqueConstraintIndexNameFree}'s constraint arm:
 * refuses a set of UNIQUE constraints declared TOGETHER, none of them on a table yet,
 * in which two derive one backing structure name.
 *
 * Two callers hold a whole declaration at once and so have no table to compare
 * against: `CREATE TABLE` (its entire constraint list) and
 * `ALTER TABLE … ADD COLUMN` (the inline `unique` constraints on the new column).
 * Both run it AFTER the duplicate-constraint guards, so a genuine duplicate keeps
 * producing the constraint-worded duplicate message rather than a structure-name one,
 * and — for `CREATE TABLE` — before `module.create`, so a refusal leaves no storage
 * behind.
 *
 * Takes `{ name, columnNames }` pairs rather than built {@link UniqueConstraintSchema}s
 * so the ADD COLUMN caller, whose column does not exist on any schema yet, can use it;
 * {@link assertNoDuplicateUniqueConstraintBackingNames} is the built-constraint wrapper.
 */
export function assertUniqueConstraintBackingNamesDistinct(
	declared: ReadonlyArray<{ name?: string; columnNames: ReadonlyArray<string> }>,
	operation: string,
): void {
	const seen = new Map<string, { name?: string; columnNames: ReadonlyArray<string> }>();
	for (const uc of declared) {
		const backingName = implicitIndexNameForColumns(uc.name, uc.columnNames);
		const lower = backingName.toLowerCase();
		const held = seen.get(lower);
		if (held) {
			throw new QuereusError(
				`Cannot ${operation}: the UNIQUE constraint ${describeUniqueConstraint(held.name, held.columnNames)} and `
					+ `the UNIQUE constraint ${describeUniqueConstraint(uc.name, uc.columnNames)} both derive backing `
					+ `structure name '${backingName}'. Rename one of them.`,
				StatusCode.CONSTRAINT,
			);
		}
		seen.set(lower, uc);
	}
}

/**
 * The `CREATE TABLE` wrapper over {@link assertUniqueConstraintBackingNamesDistinct},
 * reading the BUILT constraints (column indices already resolved) so inline and
 * table-level spellings are compared in one place. A `CREATE TABLE` declares no
 * indexes, so this pairwise comparison is the whole of the check there.
 *
 * `derivedFromIndex` constraints are skipped for the same reason
 * {@link findUniqueConstraintSharingBackingName} skips them — unreachable from a
 * `CREATE TABLE` today (the statement carries no index declarations), kept so the two
 * arms answer alike if that ever changes.
 *
 * Called from `SchemaManager.createTable` only — never from the import / rehydrate
 * path, so a catalog written before this guard existed still opens (same placement
 * rationale as {@link assertNoDuplicateUniqueConstraints}; the memory backend's
 * `ensureUniqueConstraintIndexes` keeps its adoption behaviour as damage limitation
 * for exactly those catalogs).
 */
export function assertNoDuplicateUniqueConstraintBackingNames(
	constraints: ReadonlyArray<UniqueConstraintSchema>,
	columns: ReadonlyArray<{ name: string }>,
	operation: string,
): void {
	assertUniqueConstraintBackingNamesDistinct(
		constraints
			.filter(uc => uc.derivedFromIndex === undefined)
			.map(uc => ({ name: uc.name, columnNames: uniqueConstraintColumnNames(columns, uc) })),
		operation,
	);
}

/* ─────────────── duplicate UNIQUE constraints ───────────────
 * An unnamed UNIQUE has no name to compare, so nothing but the derived structure
 * name ever noticed a repeat — and that name is only materialized by SOME backends,
 * so the same statement got different answers on memory and store. The two helpers
 * below compare what actually makes two UNIQUEs the same (their column set), which
 * is backend-independent, and every declaration site runs them BEFORE
 * `assertUniqueConstraintIndexNameFree` so the user sees a constraint-worded message
 * rather than one naming an index they never created. Same ordering rationale
 * `assertConstraintNameFree` documents in schema/table.ts. */

/**
 * Order- and repetition-insensitive key for the column set a UNIQUE constraint
 * covers. `unique (a, b)` and `unique (b, a)` enforce the identical rule, so they
 * share a key — while their derived structure names (`_uc_a_b` / `_uc_b_a`) do not,
 * which is exactly why the duplicate test cannot go through those names.
 * Case-folded like every other column-name comparison in the engine.
 *
 * JSON-encoded rather than joined on a separator character: a column name may
 * legally contain any character (`"a,b"` is one quoted identifier), and a plain
 * `join(',')` would key it identically to the two-column set `(a, b)` — refusing a
 * legal declaration. JSON escaping makes the encoding injective.
 */
export function uniqueConstraintColumnSetKey(columnNames: ReadonlyArray<string>): string {
	return JSON.stringify([...new Set(columnNames.map(n => n.toLowerCase()))].sort());
}

/**
 * True when `uc` carries no identity of its own beyond the columns it covers:
 * unnamed, not synthesized from a `CREATE UNIQUE INDEX` (`derivedFromIndex`), and
 * not partial (`predicate`). Two of these over one column set are wholly
 * indistinguishable — neither can be named in `DROP CONSTRAINT`, so neither can be
 * removed short of recreating the table, while every write pays the same check twice.
 *
 * The three exclusions each carve out a genuinely different constraint:
 * - `derivedFromIndex` — owned by its `CREATE UNIQUE INDEX`, addressable and
 *   droppable through it.
 * - `predicate` — a partial UNIQUE only governs rows inside its scope, so two with
 *   different predicates are different rules. (Only a `CREATE UNIQUE INDEX … WHERE`
 *   produces one today: `AST.TableConstraint` has no predicate field, so a declared
 *   UNIQUE is never partial. Tested for anyway, so the rule stays right if it gains
 *   one.)
 * - a name — see the NOTE on {@link assertUniqueConstraintNotDuplicated}.
 */
function isAnonymousUniqueConstraint(uc: UniqueConstraintSchema): boolean {
	return uc.name === undefined && uc.derivedFromIndex === undefined && uc.predicate === undefined;
}

function duplicateUniqueConstraintError(operation: string, columnNames: ReadonlyArray<string>): QuereusError {
	return new QuereusError(
		`Cannot ${operation}: an equivalent UNIQUE constraint on (${columnNames.join(', ')}) already exists.`,
		StatusCode.CONSTRAINT,
	);
}

/**
 * Rejects a UNIQUE declaration that would duplicate one the table already carries —
 * see {@link isAnonymousUniqueConstraint} for what counts as "the same constraint".
 *
 * Takes prospective column *names* (like {@link assertUniqueConstraintIndexNameFree})
 * so the `ALTER TABLE ADD COLUMN … unique` caller, whose column does not exist on
 * `tableSchema` yet, can use it. A name absent from the table simply matches no
 * existing constraint, which is the correct answer for a brand-new column.
 *
 * `alsoDeclared` holds column-set keys ({@link uniqueConstraintColumnSetKey}) claimed
 * earlier in the SAME statement, none of which is on `tableSchema` yet — one
 * `ADD COLUMN` can declare several inline `unique` constraints over its new column.
 *
 * NOTE: deliberately silent when the NEW constraint is named, and skips named
 * existing ones. A named UNIQUE beside an unnamed one over the same columns
 * (`create table t (…, unique (c))` then `alter table t add constraint u1 unique (c)`)
 * stays legal: both are addressable and droppable by name, so the state is merely
 * redundant rather than broken, and refusing it would change more surface than the
 * defect this guard exists for. Two DIFFERENTLY-named UNIQUEs over one column set are
 * legal for the same reason; two with the SAME name are refused by
 * `assertConstraintNameFree` on the ALTER paths and by
 * {@link assertNoDuplicateConstraintNames} at CREATE TABLE.
 */
export function assertUniqueConstraintNotDuplicated(
	tableSchema: TableSchema,
	constraintName: string | undefined,
	columnNames: ReadonlyArray<string>,
	operation: string,
	alsoDeclared?: ReadonlySet<string>,
): void {
	if (constraintName !== undefined) return;
	const key = uniqueConstraintColumnSetKey(columnNames);
	const duplicated = alsoDeclared?.has(key)
		|| (tableSchema.uniqueConstraints ?? []).some(uc =>
			isAnonymousUniqueConstraint(uc)
			&& uniqueConstraintColumnSetKey(uniqueConstraintColumnNames(tableSchema.columns, uc)) === key);
	if (!duplicated) return;
	throw duplicateUniqueConstraintError(operation, columnNames);
}

/**
 * The `CREATE TABLE` form of {@link assertUniqueConstraintNotDuplicated}: rejects a
 * constraint list that already contains two equivalent UNIQUEs, whether they were
 * declared inline on a column or at table level. Runs over the BUILT constraints
 * (column indices already resolved), so both declaration shapes are compared in one
 * place and neither can slip past.
 *
 * Called from `SchemaManager.createTable` only — never from the import / rehydrate
 * path, so a catalog written before this guard existed still opens (`importDDL`
 * warns and proceeds; `MemoryTableManager.ensureUniqueConstraintIndexes` refuses to
 * build the duplicate structure such a catalog asks for).
 */
export function assertNoDuplicateUniqueConstraints(
	constraints: ReadonlyArray<UniqueConstraintSchema>,
	columns: ReadonlyArray<{ name: string }>,
	operation: string,
): void {
	const seen = new Set<string>();
	for (const uc of constraints) {
		if (!isAnonymousUniqueConstraint(uc)) continue;
		const names = uniqueConstraintColumnNames(columns, uc);
		const key = uniqueConstraintColumnSetKey(names);
		if (seen.has(key)) throw duplicateUniqueConstraintError(operation, names);
		seen.add(key);
	}
}

/**
 * Refuses a CREATE TABLE whose declaration carries two *user-written* constraint
 * names that collide — the same within-table rule every ALTER path enforces via
 * `assertConstraintNameFree` (schema/table.ts), applied at birth. One case-folded
 * name space across CHECK + UNIQUE + FOREIGN KEY: two same-class collisions make
 * `DROP CONSTRAINT` remove both, and a cross-class collision makes the pair
 * permanently un-droppable (`resolveNamedConstraintClass` reports it ambiguous
 * forever), so neither shape may be born.
 *
 * Reads the RAW declaration through {@link forEachDeclaredConstraintName} — the
 * same walk that builds the mint taken-set — never the built constraints: the
 * extractors auto-name unnamed CHECKs / FKs, and a synthesized name is not user
 * identity, so comparing built names would refuse two unnamed CHECKs on one
 * column, which is legal (the same reasoning `assertInlineConstraintNamesFree`
 * in runtime/emit/alter-table.ts documents; colliding *mints* are disambiguated
 * by `disambiguateAutoConstraintName` instead).
 *
 * Called from `SchemaManager.createTable` only — never from the import /
 * rehydrate path, so a catalog written before this guard existed still opens
 * (same placement rationale as {@link assertNoDuplicateUniqueConstraints}).
 */
export function assertNoDuplicateConstraintNames(
	astColumns: ReadonlyArray<AST.ColumnDef>,
	astConstraints: ReadonlyArray<AST.TableConstraint> | undefined,
	operation: string,
): void {
	const seen = new Set<string>();
	forEachDeclaredConstraintName(astColumns, astConstraints, name => {
		const lower = name.toLowerCase();
		if (seen.has(lower)) {
			throw new QuereusError(
				`Cannot ${operation}: duplicate constraint name '${name}' — constraint names must be unique within a table (case-insensitive, across CHECK / UNIQUE / FOREIGN KEY)`,
				StatusCode.CONSTRAINT,
			);
		}
		seen.add(lower);
	});
}

/**
 * A backend-agnostic description of an *exposed* implicit covering index that is
 * NOT materialized in `tableSchema.indexes` (the store-mode case). Shaped as a
 * subset of {@link IndexSchema} (no `unique` flag — see below) so the read-path
 * helpers (`indexSchemaToCatalog`, the `schema()` / `index_info()` TVFs) can
 * consume it identically to a real index.
 */
export interface SyntheticExposedIndex {
	name: string;
	/** Mirrors `ensureUniqueConstraintIndexes`: per-column index + declared collation. */
	columns: ReadonlyArray<IndexColumnSchema>;
	/** Partial-index predicate from `uc.predicate`, when any. */
	predicate?: AST.Expression;
	/** User tags from `uc.exposedIndexTags` (the exposure flag stays on `uc.tags`). */
	tags?: Readonly<Record<string, SqlValue>>;
	// NOTE: deliberately NO `unique` flag — mirrors the memory materialized entry
	// (ensureUniqueConstraintIndexes does not set `unique`; UNIQUE enforcement routes
	// through uniqueConstraints), so index_info()'s `unique` column matches across
	// backends.
}

/**
 * Exposed implicit covering indexes that are NOT already materialized in
 * `tableSchema.indexes` — i.e. the store-mode case. For each non-derived UNIQUE
 * constraint carrying `quereus.expose_implicit_index = true` whose implicit name
 * (`uc.name ?? '_uc_<cols>'`) is absent from `tableSchema.indexes`, returns a
 * descriptor the read paths can surface and `updateIndexTags` can target.
 *
 * Returns empty for memory-mode tables (the name is already materialized), so
 * callers can append unconditionally with no risk of double-listing.
 */
export function exposedImplicitIndexes(tableSchema: TableSchema): SyntheticExposedIndex[] {
	const result: SyntheticExposedIndex[] = [];
	const materialized = new Set((tableSchema.indexes ?? []).map(idx => idx.name.toLowerCase()));
	for (const uc of tableSchema.uniqueConstraints ?? []) {
		if (uc.derivedFromIndex) continue;
		if (uc.tags?.[EXPOSE_IMPLICIT_INDEX_TAG] !== true) continue;
		const name = implicitIndexName(tableSchema, uc);
		if (materialized.has(name.toLowerCase())) continue; // memory mode — already surfaced
		result.push({
			name,
			columns: uc.columns.map(colIdx => ({ index: colIdx, collation: tableSchema.columns[colIdx]?.collation })),
			predicate: uc.predicate,
			tags: uc.exposedIndexTags,
		});
	}
	return result;
}

/**
 * Index of the exposed (non-materialized) implicit-covering UNIQUE constraint
 * whose implicit name matches `indexName`, or `-1` when none — the write-path
 * counterpart of {@link exposedImplicitIndexes}. `updateIndexTags` uses this to
 * route `ALTER INDEX … TAGS` onto the originating constraint's `exposedIndexTags`
 * when the index is not materialized as an `IndexSchema` (store mode). A *hidden*
 * implicit index (exposure flag absent/false) and a materialized one both return
 * `-1`, preserving their `NOTFOUND` behavior.
 */
export function findExposedImplicitConstraintIndex(tableSchema: TableSchema, indexName: string): number {
	const lower = indexName.toLowerCase();
	const ucs = tableSchema.uniqueConstraints ?? [];
	const materialized = new Set((tableSchema.indexes ?? []).map(idx => idx.name.toLowerCase()));
	for (let i = 0; i < ucs.length; i++) {
		const uc = ucs[i];
		if (uc.derivedFromIndex) continue;
		if (uc.tags?.[EXPOSE_IMPLICIT_INDEX_TAG] !== true) continue;
		const name = implicitIndexName(tableSchema, uc).toLowerCase();
		if (materialized.has(name)) continue;
		if (name === lower) return i;
	}
	return -1;
}

/**
 * True when `indexName` names an index that is a **hidden** implicit covering
 * structure on `tableSchema` — the auto-built secondary BTree backing a declared
 * UNIQUE constraint that has NOT opted into catalog visibility via
 * {@link EXPOSE_IMPLICIT_INDEX_TAG}. Such an index is a backing detail, not a
 * user-addressable object, so `ALTER INDEX … SET TAGS` treats it as NOTFOUND (its
 * tags live on the originating constraint — use `ALTER TABLE … ALTER CONSTRAINT
 * … SET TAGS`). An *exposed* implicit index (flag true) and any ordinary index
 * are not hidden. Match is case-insensitive, like every other index-name
 * comparison in the engine.
 */
export function isHiddenImplicitIndex(tableSchema: TableSchema, indexName: string): boolean {
	return implicitCoveringIndexExposure(tableSchema).get(indexName.toLowerCase()) === false;
}

/**
 * True when `indexName` names an implicit covering structure on `tableSchema` —
 * the auto-built secondary BTree backing a declared UNIQUE constraint — whether
 * that structure is hidden or {@link EXPOSE_IMPLICIT_INDEX_TAG}-exposed. The
 * broader counterpart of {@link isHiddenImplicitIndex}.
 *
 * This is what excludes implicit structures from the *schema-wide* index-name
 * namespace that `SchemaManager.createIndex` enforces: a constraint name is
 * unique per table, not per schema, so two tables may each carry a
 * `constraint uq_email unique (email)` and hence each materialize an index
 * literally named `uq_email`. That is legal and must stay legal.
 *
 * Match is case-insensitive.
 */
export function isImplicitCoveringIndex(tableSchema: TableSchema, indexName: string): boolean {
	return implicitCoveringIndexExposure(tableSchema).has(indexName.toLowerCase());
}

function indexSchemaToCatalog(
	indexSchema: IndexSchema,
	tableSchema: TableSchema,
	db: Database,
	/** Set true for an exposed implicit covering structure — see `CatalogIndex.implicit`. */
	implicit = false,
): CatalogIndex {
	const entry: CatalogIndex = {
		name: indexSchema.name,
		tableName: tableSchema.name,
		ddl: generateIndexDDL(indexSchema, tableSchema, db),
		definition: indexToCanonicalDDL(indexSchema, tableSchema),
		tags: indexSchema.tags,
	};
	// Only set the field when true so an ordinary index's catalog shape is unchanged.
	if (implicit) entry.implicit = true;
	return entry;
}

function assertionSchemaToCatalog(assertionSchema: IntegrityAssertionSchema): CatalogAssertion {
	// Emit a faithful, re-parseable `CREATE ASSERTION <name> CHECK (<expr>)` by
	// stringifying the original CHECK expression AST — the same `expressionToString`
	// call `emitCreateAssertion` already uses, so it is proven to produce a
	// parseable expression for this input. Using the stored `violationSql` here
	// instead would embed a full `select 1 where not (...)` query in the CHECK
	// slot, which is not a CHECK-expression and never round-trips through `parse()`.
	//
	// `checkExpression` is absent only for assertions reconstructed from persisted
	// `violationSql` alone — a path that does not exist today (`importDDL`
	// throws on assertion DDL), so the primary branch always fires. The fallback
	// keeps a descriptive (non-reparseable) string for that hypothetical case
	// rather than throwing. See assertion.ts:21-27.
	// NOTE: the fallback also feeds `definition`, and a `select 1 where not (…)`
	// query never equals a declared CHECK body — so if assertion reconstruction
	// from `violationSql` is ever implemented, every such assertion reads as
	// permanently drifted and `apply schema` re-drops/recreates it on each run.
	// Whoever lights that path up must re-parse the CHECK body (or persist it)
	// rather than reuse `violationSql` here.
	const checkSql = assertionSchema.checkExpression
		? expressionToString(assertionSchema.checkExpression)
		: assertionSchema.violationSql;
	// Qualify a non-main assertion's name so the rendered DDL is faithful to
	// where the assertion actually lives. `name` stays bare — the catalog is
	// per-schema and the differ keys assertions by bare name within it.
	const qualifiedName = assertionSchema.schemaName.toLowerCase() !== 'main'
		? `${quoteIdentifier(assertionSchema.schemaName)}.${quoteIdentifier(assertionSchema.name)}`
		: quoteIdentifier(assertionSchema.name);
	return {
		name: assertionSchema.name,
		ddl: `CREATE ASSERTION ${qualifiedName} CHECK (${checkSql})`,
		definition: checkSql,
		check: assertionSchema.checkExpression,
	};
}

/**
 * Generates canonical DDL from a declared schema AST
 */
export function generateDeclaredDDL(declaredSchema: AST.DeclareSchemaStmt, targetSchema?: string): string[] {
	const ddlStatements: string[] = [];

	for (const item of declaredSchema.items) {
		switch (item.type) {
			case 'declaredTable': {
				// Qualify table name with schema if specified
				const tableStmt = item.tableStmt;
				if (targetSchema && targetSchema !== 'main' && !tableStmt.table.schema) {
					const qualifiedStmt: AST.CreateTableStmt = {
						...tableStmt,
						table: {
							...tableStmt.table,
							schema: targetSchema
						}
					};
					ddlStatements.push(createTableToString(qualifiedStmt));
				} else {
					ddlStatements.push(createTableToString(tableStmt));
				}
				break;
			}
			case 'declaredIndex': {
				// Generate index DDL using AST stringifier
				const indexStmt = item.indexStmt;
				if (targetSchema && targetSchema !== 'main' && !indexStmt.table.schema) {
					const qualifiedStmt: AST.CreateIndexStmt = {
						...indexStmt,
						table: {
							...indexStmt.table,
							schema: targetSchema
						}
					};
					ddlStatements.push(createIndexToString(qualifiedStmt));
				} else {
					ddlStatements.push(createIndexToString(indexStmt));
				}
				break;
			}
			case 'declaredView':
				ddlStatements.push(createViewToString(applyViewSchemaDefault(item.viewStmt, targetSchema)));
				break;
			case 'declaredMaterializedView':
				ddlStatements.push(createMaterializedViewToString(applyViewSchemaDefault(item.viewStmt, targetSchema)));
				break;
			case 'declaredAssertion':
				// Assertions participate in the declared DDL (and hence the schema
				// hash — a changed assertion body must change the schema version).
				// `declaredSeed` stays absent deliberately: a seed is data, not shape.
				ddlStatements.push(createAssertionToString(applyAssertionSchemaDefault(item.assertionStmt, targetSchema)));
				break;
		}
	}

	return ddlStatements;
}


