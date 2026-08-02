import type { SchemaCatalog, CatalogTable, CatalogView, CatalogIndex } from './catalog.js';
import type * as AST from '../parser/ast.js';
import type { SqlValue } from '../common/types.js';
import { createTableToString, createViewToString, createMaterializedViewToString, createIndexToString, createAssertionToString, columnDefToString, quoteIdentifier, expressionToString, tagsBodyToString, tableConstraintsToString, constraintBodyToCanonicalString, createIndexBodyToCanonicalString, indexedColumnBareName, viewDefinitionToCanonicalString, astToString } from '../emit/ast-stringify.js';
import { computeBodyHash, normalizeBackingModuleName, canonicalBackingModuleArgs } from './view.js';
import { QuereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import { createLogger } from '../common/logger.js';
import { validateReservedTags, type TagDiagnostic } from './reserved-tags.js';
import { raiseReservedTagDiagnostics } from './reserved-tags-policy.js';
import { renameColumnInAst, renameColumnInCheckExpression, renameTableInAst, tableReferencedInAst } from './rename-rewriter.js';
import type { ResolveColumnInSource } from './rename-rewriter.js';
import { cloneExpr, cloneQueryExpr } from '../planner/mutation/scope-transform.js';
import { normalizeCollationName } from '../util/comparison.js';
import { inferType } from '../types/registry.js';
import { resolveDefaultCollation } from './table.js';

const log = createLogger('schema:differ');
const warnLog = log.extend('warn');

/** Reserved tag namespace prefix used for differ-recognized hints. */
const QUEREUS_TAG_PREFIX = 'quereus.';

export type RenamePolicy = 'allow' | 'require-hint' | 'deny';

export type RenameKind = 'table' | 'view' | 'index' | 'constraint';

export interface RenameOp {
	kind: RenameKind;
	oldName: string;
	newName: string;
}

export interface ColumnRenameOp {
	oldName: string;
	newName: string;
}

/**
 * Represents the difference between a declared schema and actual database state
 */
export interface SchemaDiff {
	tablesToCreate: string[];
	tablesToDrop: string[];
	tablesToAlter: TableAlterDiff[];
	/**
	 * Maintained tables whose declared backing module drifted from the live backing
	 * — a destructive, incarnation-minting migration realized as drop+recreate (the
	 * DROP rides {@link tablesToDrop} under the actual name; the recreate, which
	 * re-materializes the body into the new module, rides {@link tablesToCreate}).
	 * Recorded separately for the apply-time `allow_destructive` gate and for
	 * diagnostics: `diff schema` surfaces the DDL unconditionally (read-only
	 * preview), while `apply schema` refuses unless acknowledged. Distinct from a
	 * non-destructive body re-attach (`set maintained as`), which preserves the
	 * incarnation. See `docs/materialized-views.md` § Declarative-schema integration.
	 */
	maintainedModuleMigrations: Array<{ name: string; fromModule: string; toModule: string }>;
	viewsToCreate: string[];
	viewsToDrop: string[];
	indexesToCreate: string[];
	indexesToDrop: string[];
	assertionsToCreate: string[];
	assertionsToDrop: string[];
	/**
	 * In-place metadata-tag changes on name-matched views / indexes (whole-set
	 * replacement; `tags: {}` clears). These take the new `ALTER … SET TAGS`
	 * primitive rather than a drop+recreate. A maintained table is a TABLE now, so
	 * its tag-only change rides `TableAlterDiff.tableTagsChange` (`ALTER TABLE …
	 * SET TAGS`) — there is no separate materialized-view tag bucket.
	 */
	viewTagsChanges: Array<{ name: string; tags: Record<string, SqlValue> }>;
	indexTagsChanges: Array<{ name: string; tags: Record<string, SqlValue> }>;
	/** Renames detected via `quereus.id` / `quereus.previous_name` hints. */
	renames: RenameOp[];
	/**
	 * Logical-schema lens attaches: declared logical tables not yet registered
	 * as a lens body. Only populated for a logical declared schema. Carries no
	 * migration DDL — the lens compiler attaches at apply time, not via DDL.
	 */
	lensToAttach: string[];
	/**
	 * Logical-schema lens detaches: registered lens bodies absent from the
	 * declaration. A logical removal detaches the lens and **never** drops basis
	 * storage (see `docs/lens.md` § Deployment) — so this is emitted *instead of*
	 * a basis-table drop.
	 */
	lensToDetach: string[];
}

export interface ColumnAttributeChange {
	columnName: string;
	/** Desired NOT NULL setting. Omitted = no change. */
	notNull?: boolean;
	/** Desired declared (logical) data type. Omitted = no change. */
	dataType?: string;
	/**
	 * Desired DEFAULT expression.
	 *   undefined = no change
	 *   null      = drop existing default
	 *   Expression = set to given expression
	 */
	defaultValue?: AST.Expression | null;
	/**
	 * Desired collation (canonical, e.g. `'NOCASE'`) when the declared column's
	 * COLLATE differs from actual. Omitted = no change. Absent and `'BINARY'` are
	 * treated as equal (no spurious diff). Emitted as `SET COLLATE <name>`.
	 */
	collation?: string;
	/**
	 * Desired metadata tag set (whole-set replacement) when the declared column
	 * tags differ from actual. Omitted = no change; `{}` = clear all tags. Rename
	 * hints (`quereus.id` / `quereus.previous_name`) are excluded from the drift
	 * comparison but kept verbatim in the emitted set.
	 */
	tags?: Record<string, SqlValue>;
}

export interface TableAlterDiff {
	tableName: string;
	columnsToAdd: string[];
	columnsToDrop: string[];
	columnsToAlter: ColumnAttributeChange[];
	/** Column renames discovered via `quereus.id` / `quereus.previous_name` on declared columns. */
	columnsToRename: ColumnRenameOp[];
	/** Constraint renames discovered via tag hints (user-named CHECK / UNIQUE / FK). */
	constraintsToRename?: ColumnRenameOp[];
	/**
	 * User-named constraints to remove via `DROP CONSTRAINT <name>`: those present
	 * in the actual catalog but absent from the declaration (and not consumed by a
	 * rename), PLUS the old side of a **body change** — a name-matched constraint
	 * whose canonical body drifted is realized as drop-old + add-new (it pairs with
	 * an entry in {@link constraintsToAdd}).
	 */
	constraintsToDrop?: string[];
	/**
	 * Declared user-named constraints to install via `ALTER TABLE … ADD
	 * <constraint-fragment>`: those absent from the actual catalog (and not a rename
	 * target), PLUS the new side of a **body change** (paired with a
	 * {@link constraintsToDrop} entry under the old name). Each entry is the full
	 * constraint DDL fragment (`constraint <name> check (...)` with any tags) the
	 * `ADD` primitive consumes. ADD applies a CHECK in place; a UNIQUE / FOREIGN
	 * KEY add routes through the module's `addConstraint`, re-validating existing
	 * rows (so a body-change recreate re-validates against the new rule).
	 */
	constraintsToAdd?: string[];
	primaryKeyChange?: {
		oldPkColumns: string[];
		newPkColumns: Array<{ name: string; direction?: 'asc' | 'desc' }>;
	};
	/**
	 * Desired table-level metadata tag set (whole-set replacement) when the declared
	 * table tags differ from actual. Omitted = no change; `{}` = clear all tags.
	 */
	tableTagsChange?: Record<string, SqlValue>;
	/**
	 * Per named table-level constraint whose declared tags drifted from actual.
	 * Whole-set replacement; `tags: {}` clears. Name-matched constraints only.
	 */
	constraintTagsChanges?: Array<{ constraintName: string; tags: Record<string, SqlValue> }>;
	/**
	 * Maintained-table (derivation) transition. Attach or re-attach a derivation:
	 * `alter table … set maintained [(cols)] as <body>` (any `with defaults (…)` rides
	 * inside the body). Emitted LATE (after table creates/alters), where the target's
	 * final shape and the body's sources must already exist. Set on: a fresh attach
	 * (declared maintained, live plain) and a re-attach (both maintained, body
	 * drift). On a same-shape re-attach this is the only op (content reconcile /
	 * refresh — no recreate).
	 *
	 * `columns` carries the DECLARED rename list verbatim: the names array for an
	 * explicit maintained form (`mv (a, c)` / `maintained (a, c) as`) — rendered as the
	 * `(cols)` form so the verb positionally renames the body and reshapes the backing
	 * — or `undefined` for an implicit/sugar-without-list MV, where the verb stays
	 * implicit (the body's natural names follow). The differ never synthesizes or
	 * compares renames; it hands the verb the authored list and the verb does the
	 * reshape (and re-records `derivation.columns`).
	 */
	setMaintained?: { columns?: ReadonlyArray<string>; select: AST.QueryExpr };
	/**
	 * Detach a derivation: `alter table … drop maintained` (the table keeps its
	 * rows and becomes writable). Emitted EARLY (before table alters/drops) — a
	 * detach must precede column ops on the table and may precede a drop of its
	 * former source. Set on: a detach (declared plain, live maintained) and the
	 * reshape leg of a re-attach with a concurrent shape change (detach → column
	 * ops → {@link setMaintained}).
	 */
	dropMaintained?: boolean;
	/**
	 * When {@link tableTagsChange} is set on a table that is STILL maintained at the
	 * point the alter block's SET TAGS runs (live-maintained and NOT detached early
	 * in this same diff), the tag edit must go through `ALTER MATERIALIZED VIEW …
	 * SET TAGS` rather than `ALTER TABLE … SET TAGS`: the TABLE verb fires
	 * `table_modified`, not `materialized_view_modified`, so a store-backed catalog
	 * would never re-persist the maintained-table entry — and the runtime ALTER
	 * TABLE handler rejects a tag action on a maintained table outright. A detach
	 * (or re-attach reshape leg) runs its `drop maintained` EARLY, so by tag time
	 * the table is plain and the ordinary ALTER TABLE path applies (flag absent).
	 */
	maintainedTags?: boolean;
	/**
	 * Set when a name-matched maintained table's declared backing module drifted
	 * from the live backing (BOTH sides maintained). A backing-module move
	 * physically relocates the table to a different store and mints a new
	 * incarnation — there is no in-place move primitive — so it must take a
	 * destructive drop+recreate, NOT any of the alter ops above. This flag signals
	 * {@link computeSchemaDiff} to route the table to drop+recreate (and record a
	 * {@link SchemaDiff.maintainedModuleMigrations} entry) instead of pushing this
	 * alter diff; the recreate subsumes any concurrent body / tag / shape op also
	 * present on this diff. `fromModule` / `toModule` are the normalized backing
	 * labels (`name` or `name(args)`) for the diagnostic.
	 */
	maintainedModuleMigration?: { fromModule: string; toModule: string };
}

/** Kind label as it appears in the duplicate-declaration diagnostic. */
type DeclaredObjectKind = 'table' | 'view' | 'materialized view' | 'index' | 'assertion';

/** A name declared twice inside one `declare schema` block. */
interface DuplicateDeclaredName {
	/** The name as written on the SECOND declaration. */
	name: string;
	/** Kind of the second declaration. */
	kind: DeclaredObjectKind;
	/** Kind of the first declaration — equal to `kind` for a same-kind duplicate. */
	priorKind: DeclaredObjectKind;
	/** Owning table of each declaration; indexes only, for the index diagnostic. */
	firstTable?: string;
	secondTable?: string;
}

/** One recorded declaration, for collision reporting. */
interface DeclaredNameEntry {
	kind: DeclaredObjectKind;
	/** Owning table — indexes only. */
	table?: string;
}

/**
 * First name collision in declaration order, or undefined. Pure — never throws,
 * so the caller decides when to raise (the physical path defers to the
 * reserved-tag diagnostics first).
 *
 * Three namespaces, matching what the engine enforces imperatively:
 *   - `table` / `view` / `materialized view` share ONE namespace (`Schema.addView`
 *     rejects a view whose name a table holds, and `SchemaManager.createTable` the
 *     mirror case), so a cross-kind clash here would emit DDL that can never apply
 *     — it half-applies and then throws deep in the migration loop.
 *   - `index` — its own namespace, unique per schema (SCH-001). An index sharing a
 *     table's name is legal and stays legal.
 *   - `assertion` — its own namespace; likewise free to share a table's name.
 *
 * Only the FIRST collision is reported, matching the surrounding structural
 * conflicts (rename resolution, tag diagnostics stop at their first raise point).
 */
function findDuplicateDeclaredName(items: readonly AST.DeclareItem[]): DuplicateDeclaredName | undefined {
	// table / view / materialized view all land in `sharedObjects`.
	const sharedObjects = new Map<string, DeclaredNameEntry>();
	const indexes = new Map<string, DeclaredNameEntry>();
	const assertions = new Map<string, DeclaredNameEntry>();

	/** First-write-wins record; returns the collision when the name is taken. */
	const record = (
		registry: Map<string, DeclaredNameEntry>,
		name: string,
		entry: DeclaredNameEntry,
	): DuplicateDeclaredName | undefined => {
		const key = name.toLowerCase();
		const prior = registry.get(key);
		if (prior) {
			return {
				name,
				kind: entry.kind,
				priorKind: prior.kind,
				firstTable: prior.table,
				secondTable: entry.table,
			};
		}
		registry.set(key, entry);
		return undefined;
	};

	for (const item of items) {
		let duplicate: DuplicateDeclaredName | undefined;
		switch (item.type) {
			case 'declaredTable':
				duplicate = record(sharedObjects, item.tableStmt.table.name, { kind: 'table' });
				break;
			case 'declaredView':
				duplicate = record(sharedObjects, item.viewStmt.view.name, { kind: 'view' });
				break;
			case 'declaredMaterializedView':
				duplicate = record(sharedObjects, item.viewStmt.view.name, { kind: 'materialized view' });
				break;
			case 'declaredIndex':
				duplicate = record(indexes, item.indexStmt.index.name, { kind: 'index', table: item.indexStmt.table.name });
				break;
			case 'declaredAssertion':
				duplicate = record(assertions, item.assertionStmt.name.name, { kind: 'assertion' });
				break;
			// NOTE: `declareIgnored` (domain / collation / import) is skipped — the parser
			// keeps it as an opaque snippet with no parsed name, so there is nothing to key
			// on. If any of those becomes first-class, it needs its own namespace decision
			// here. `declaredSeed` is keyed by target table, guarded in schema-declarative.ts.
		}
		if (duplicate) return duplicate;
	}
	return undefined;
}

/** Renders the diagnostic for a duplicate declared name. */
function duplicateDeclaredNameError(dup: DuplicateDeclaredName, schemaName: string): QuereusError {
	const { name, kind, priorKind, firstTable, secondTable } = dup;
	if (kind !== priorKind) {
		// Cross-kind is only reachable inside the shared table/view/MV namespace,
		// so both labels take the article "a". Kinds read in declaration order.
		return new QuereusError(
			`'${name}' is declared as both a ${priorKind} and a ${kind} in schema '${schemaName}'`,
			StatusCode.ERROR,
		);
	}
	if (kind === 'index') {
		// Pinned wording — documented in docs/sql-ddl.md § 6.3 and SCH-001.
		return new QuereusError(
			`Index '${name}' is declared more than once in schema '${schemaName}'`
				+ ` (on '${firstTable}' and '${secondTable}') — index names are unique per schema`,
			StatusCode.ERROR,
		);
	}
	const label = kind.charAt(0).toUpperCase() + kind.slice(1);
	return new QuereusError(
		`${label} '${name}' is declared more than once in schema '${schemaName}'`,
		StatusCode.ERROR,
	);
}

/**
 * Computes the difference between declared schema and actual catalog
 */
export function computeSchemaDiff(
	declaredSchema: AST.DeclareSchemaStmt,
	actualCatalog: SchemaCatalog,
	policy: RenamePolicy = 'allow',
	/**
	 * Session `default_collation` used to resolve an omitted COLLATE on the *declared*
	 * side, matching how the CREATE path resolves it for a fresh `apply`. Defaults to
	 * `'BINARY'` so direct callers (and the existing test suite, which runs under the
	 * BINARY session default) keep byte-for-byte identical diffs. The emitters thread
	 * the live `default_collation` session option.
	 */
	defaultCollation: string = 'BINARY',
): SchemaDiff {
	const diff: SchemaDiff = {
		tablesToCreate: [],
		tablesToDrop: [],
		tablesToAlter: [],
		maintainedModuleMigrations: [],
		viewsToCreate: [],
		viewsToDrop: [],
		indexesToCreate: [],
		indexesToDrop: [],
		assertionsToCreate: [],
		assertionsToDrop: [],
		viewTagsChanges: [],
		indexTagsChanges: [],
		renames: [],
		lensToAttach: [],
		lensToDetach: [],
	};

	// Logical schema: the per-table diff is attach/detach-lens, never
	// create/drop-table. A logical schema's actual catalog views ARE its lens
	// bodies (a logical schema has no user views), so compare declared logical
	// tables against the registered views. Basis storage is untouched.
	const targetSchemaName = actualCatalog.schemaName;

	if (declaredSchema.isLogical) {
		// Raise here rather than deferring to the physical raise point below: the
		// logical path returns before any tag validation, and `computeLogicalSchemaDiff`
		// dedupes declared table names into a Set — so a duplicate would silently
		// collapse into one attach with the first declaration lost.
		const duplicate = findDuplicateDeclaredName(declaredSchema.items);
		if (duplicate) throw duplicateDeclaredNameError(duplicate, targetSchemaName);
		return computeLogicalSchemaDiff(declaredSchema, actualCatalog, diff);
	}

	// Extract schema-level default module settings
	const defaultVtabModule = declaredSchema.using?.defaultVtabModule;
	const defaultVtabArgs = declaredSchema.using?.defaultVtabArgs;

	// Build maps of declared items
	const declaredTables = new Map<string, AST.DeclaredTable>();
	const declaredViews = new Map<string, AST.DeclaredView>();
	const declaredMaterializedViews = new Map<string, AST.DeclaredMaterializedView>();
	const declaredIndexes = new Map<string, AST.DeclaredIndex>();
	const declaredAssertions = new Map<string, AST.DeclaredAssertion>();

	// Reserved-tag shape/site validation flows through the SAME typed registry
	// (`validateReservedTags`) as the lens-compile / mutation / advertisement
	// paths — there is no second differ-local allow-list. Severity is unified:
	// an unknown / mis-sited / malformed `quereus.*` key is a hard error here too
	// (Decision 2 of the ticket), so a physical-schema typo fails `apply`/`diff`
	// loudly instead of silently soft-warning. We accumulate every declared
	// object's diagnostics across the whole schema, then raise once — BEFORE the
	// throw-y rename resolution below, so a tag typo surfaces deterministically
	// rather than being masked by a rename conflict. Sites per Decision 3:
	// table → physical-table (also the basis-table/advertisement position),
	// column → physical-column, view / materialized view → view-ddl,
	// index → physical-index, table constraint (named or not) → physical-constraint.
	// Assertions carry no `tags` field (no site). The rename hints
	// (quereus.id / quereus.previous_name) are first-class specs valid at each of
	// these physical sites; an MV's hint validates (over-permissive: the differ
	// supports no MV rename and simply ignores it — harmless, see Decision 1).
	const tagDiagnostics: TagDiagnostic[] = [];
	// Every `declared*` map below is keyed schema-wide by lowercased name, so a
	// repeated declaration would silently last-writer-wins and half-apply the
	// declaration. `findDuplicateDeclaredName` (called right after the tag
	// diagnostics are raised) rejects that up front — see SCH-003.
	for (const item of declaredSchema.items) {
		switch (item.type) {
			case 'declaredTable':
				declaredTables.set(item.tableStmt.table.name.toLowerCase(), item);
				tagDiagnostics.push(...validateReservedTags(item.tableStmt.tags, 'physical-table'));
				for (const col of item.tableStmt.columns) {
					tagDiagnostics.push(...validateReservedTags(col.tags, 'physical-column'));
				}
				for (const c of item.tableStmt.constraints ?? []) {
					// Validate every table constraint's tags, named or not. A table-level
					// constraint consumes a trailing `WITH TAGS` unconditionally (the
					// parser only defers it to the column for *unnamed inline column*
					// constraints), so an unnamed table constraint CAN carry a reserved
					// tag — gating validation on `c.name` would leave a typo there as a
					// silent no-op, the exact escape the unified hard-error posture
					// exists to close. Rename detection still keys off named constraints
					// only; this is validation-only and harmless on unnamed ones.
					tagDiagnostics.push(...validateReservedTags(c.tags, 'physical-constraint'));
				}
				// Inline *named* column constraints carry their own trailing `WITH TAGS`
				// on `cc.tags` at the SAME physical-constraint site as a table-level
				// constraint (the parser lifts a trailing tag onto the constraint only
				// when it is named; an unnamed inline constraint defers its tags to the
				// column, so `cc.tags` is undefined there and validateReservedTags returns
				// [] — a harmless no-op, no `cc.name` guard needed). Validate regardless of
				// constraint *kind* (validation is independent of the lifecycle lift that
				// handles only check/unique/fk) so a typo'd or mis-sited reserved key on
				// e.g. `qty integer constraint chk check (qty>0) with tags (...)` fails
				// here too. Appended LAST (after the table-level constraint loop) so the
				// accumulated diagnostic order is identical to the direct CREATE path:
				// table → columns → table-constraints → column-constraints.
				for (const col of item.tableStmt.columns) {
					for (const cc of col.constraints ?? []) {
						tagDiagnostics.push(...validateReservedTags(cc.tags, 'physical-constraint'));
					}
				}
				break;
			case 'declaredView':
				declaredViews.set(item.viewStmt.view.name.toLowerCase(), item);
				tagDiagnostics.push(...validateReservedTags(item.viewStmt.tags, 'view-ddl'));
				break;
			case 'declaredMaterializedView':
				declaredMaterializedViews.set(item.viewStmt.view.name.toLowerCase(), item);
				tagDiagnostics.push(...validateReservedTags(item.viewStmt.tags, 'view-ddl'));
				break;
			case 'declaredIndex':
				declaredIndexes.set(item.indexStmt.index.name.toLowerCase(), item);
				tagDiagnostics.push(...validateReservedTags(item.indexStmt.tags, 'physical-index'));
				break;
			case 'declaredAssertion':
				declaredAssertions.set(item.assertionStmt.name.name.toLowerCase(), item);
				break;
		}
	}
	raiseReservedTagDiagnostics(tagDiagnostics, {
		log: (d) => warnLog('reserved tag advisory (%s) on %s: %s', d.reason, d.site, d.message),
	});

	// Raised AFTER the tag diagnostics so a reserved-tag typo still surfaces first
	// (the same deterministic order the tag/rename split has).
	const duplicateDeclaration = findDuplicateDeclaredName(declaredSchema.items);
	if (duplicateDeclaration) throw duplicateDeclaredNameError(duplicateDeclaration, targetSchemaName);

	// Normalize every declared `materialized view` into the TABLE category: a
	// declared table whose `maintained` clause carries the body (no declared
	// columns — the body owns the shape). This is what dissolves the standalone MV
	// comparison: a maintained table is now compared per name against a declared
	// table or maintained clause in ONE category, so a table↔maintained transition
	// becomes an attach/detach alter, never a cross-category drop+create. The
	// original `declaredMaterializedViews` map is retained for the CREATE branch
	// (a fresh maintained table renders the `create materialized view` sugar, since
	// a column-less `create table … maintained as` has no parseable DDL).
	for (const [name, declaredMv] of declaredMaterializedViews) {
		// No clobber check needed: `findDuplicateDeclaredName` above shares ONE
		// namespace across table / view / materialized view, so a declared table of
		// this name has already raised.
		declaredTables.set(name, materializedViewToDeclaredTable(declaredMv));
	}

	// Build maps of actual items
	const actualTables = new Map(actualCatalog.tables.map(t => [t.name.toLowerCase(), t]));
	const actualViews = new Map(actualCatalog.views.map(v => [v.name.toLowerCase(), v]));
	// Exclude *exposed implicit covering indexes* (`CatalogIndex.implicit` — the
	// secondary BTree backing a UNIQUE constraint tagged
	// `quereus.expose_implicit_index`). The catalog surfaces them for introspection
	// (`schema()` / `index_info()`), but their lifecycle belongs to the originating
	// UNIQUE constraint (the named-constraint diff path), NOT to `CREATE/DROP INDEX`.
	// Filtering here keeps them out of ALL three downstream index consumers in one
	// place — rename resolution, the create/body loop, and the orphan-drop loop — so a
	// converged schema with an exposed implicit index diffs empty (no phantom
	// `DROP INDEX IF EXISTS`). See `catalog.ts` `CatalogIndex.implicit`.
	const actualIndexes = new Map(
		actualCatalog.indexes.filter(i => !i.implicit).map(i => [i.name.toLowerCase(), i]),
	);

	// Resolve renames per-kind. Each call returns:
	//   - rename ops (oldName -> newName)
	//   - matched pairs (declaredKey -> actual): for the alter-diff loop later
	//   - consumedActuals: actuals that are now spoken-for by a rename and must
	//     not be dropped
	const tableRenames = resolveRenames<AST.DeclaredTable, CatalogTable>({
		kind: 'table',
		declared: declaredTables,
		actual: actualTables,
		getDeclaredName: d => d.tableStmt.table.name,
		getActualName: a => a.name,
		getDeclaredTags: d => d.tableStmt.tags,
		getActualTags: a => a.tags,
		policy,
	});
	diff.renames.push(...tableRenames.renames);

	const viewRenames = resolveRenames<AST.DeclaredView, CatalogView>({
		kind: 'view',
		declared: declaredViews,
		actual: actualViews,
		getDeclaredName: d => d.viewStmt.view.name,
		getActualName: a => a.name,
		getDeclaredTags: d => d.viewStmt.tags,
		getActualTags: a => a.tags,
		policy,
	});
	diff.renames.push(...viewRenames.renames);

	const indexRenames = resolveRenames<AST.DeclaredIndex, CatalogIndex>({
		kind: 'index',
		declared: declaredIndexes,
		actual: actualIndexes,
		getDeclaredName: d => d.indexStmt.index.name,
		getActualName: a => a.name,
		getDeclaredTags: d => d.indexStmt.tags,
		getActualTags: a => a.tags,
		policy,
	});
	diff.renames.push(...indexRenames.renames);

	// Pre-pass: resolve every name-matched declared table's column renames, keyed by
	// declared (new) table name (lowercased). This gives the per-table alter loop
	// cross-table visibility of a *parent* table's column renames, so the FK branch
	// of `reconciledDeclaredBody` can inverse-rename an FK's referenced PARENT column
	// (its `foreignKey.table` carries the parent's declared name at diff time — the
	// same lookup key). A self-referential FK falls out for free: the parent is the
	// current table, so `map.get(currentTable)` matches `diff.columnsToRename`. Pure
	// creates (no matched actual) contribute nothing. NOTE: this re-resolves the
	// current table's renames a second time (once here, once in its own
	// `computeTableAlterDiff`); see `resolveColumnRenames` for why that's accepted.
	const columnRenamesByTable = new Map<string, ColumnRenameOp[]>();
	for (const [name, declaredTable] of declaredTables) {
		const matchedActual = tableRenames.pairs.get(name);
		if (!matchedActual) continue;
		const renames = resolveColumnRenames(declaredTable, matchedActual, policy).renames;
		if (renames.length > 0) {
			columnRenamesByTable.set(name, renames.map(r => ({ oldName: r.oldName, newName: r.newName })));
		}
	}

	// Declared-side column-existence resolver for the scope-aware seeded column
	// rewrites in the reconcilers (the optional `ResolveColumnInSource` arg of
	// `renameColumnInCheckExpression`). The forward rename propagation passes a
	// live schemaManager lookup (see `rewriteTableForColumnRename` in
	// runtime/emit/alter-table.ts); the diff side has no live catalog for the
	// post-rename world, so it answers from the DECLARED column sets instead:
	// the inverse walk's match target (`oldCol`) is the rename's NEW column
	// name, and the question being answered is "in the declared world, does
	// this inner FROM source expose that name (so the unqualified ref binds
	// there, not to the owning seed)?". The walk's `realSources` carry OLD
	// table names when the inverse table-rename pass has pre-normalized
	// qualifiers (and DECLARED names when it hasn't — `columnReconciledViewStmt`),
	// hence the old→new table-name mapping before the declared lookup: an
	// already-declared name simply misses the rename find and passes through.
	// Cross-schema sources answer false (the catalog is single-schema) —
	// conservative where the forward path's live lookup could say yes; worst
	// case a benign drop+recreate.
	const targetSchemaLower = targetSchemaName.toLowerCase();
	const resolveDeclaredColumn: ResolveColumnInSource = (schema, table, column) => {
		if (schema !== targetSchemaLower) return false;
		const declaredName = tableRenames.renames.find(r => r.oldName.toLowerCase() === table)?.newName.toLowerCase() ?? table;
		const dt = declaredTables.get(declaredName);
		return dt?.tableStmt.columns.some(c => c.name.toLowerCase() === column) ?? false;
	};

	// Tables: creates / alters. `dropSet` accumulates the destructive
	// backing-module moves here (the live incarnation must be dropped) AND the
	// orphan drops below — both flow through `orderDropsByFKDependency` together.
	// `maintainedModuleRecreates` counts those module-move drop+create pairs so the
	// require-hint guard can exclude them (a deliberate recreate of a matched
	// object, not an ambiguous unhinted rename — mirroring viewRecreates /
	// indexRecreates).
	const dropSet = new Set<string>();
	let maintainedModuleRecreates = 0;
	for (const [name, declaredTable] of declaredTables) {
		const tableStmt = declaredTable.tableStmt;
		const matchedActual = tableRenames.pairs.get(name);
		if (matchedActual) {
			// Either a rename match or a name-based match — compute alter diff against the matched actual.
			// Thread the table renames (all `kind: 'table'` from this resolver), the
			// schema name, and the cross-table column-rename map so the constraint body
			// comparison can reconcile a renamed local column / FK-parent-table /
			// FK-referenced-parent-column against the actual (pre-rename) catalog body.
			const alterDiff = computeTableAlterDiff(declaredTable, matchedActual, policy, tableRenames.renames, targetSchemaName, columnRenamesByTable, resolveDeclaredColumn, defaultCollation);
			if (alterDiff.maintainedModuleMigration) {
				// Destructive backing-module move: drop the live incarnation (via the
				// shared drop ordering) and recreate into the newly declared module
				// (re-materializing the body). The recreate subsumes any concurrent body /
				// tag / shape op, so the alter diff is SUPPRESSED — no `tablesToAlter`
				// entry for this table. Gated at apply (allow_destructive); surfaced
				// unconditionally by `diff schema`.
				//
				// Rename-coincident case: when the same apply BOTH renames this
				// maintained table (hinted match, `matchedActual.name !== name`) AND moves
				// its backing module, the table RENAME op is preserved in `diff.renames`
				// (dependents over the old name retarget via the ALTER … RENAME primitive —
				// see reconciledDeclaredViewDefinition). At apply that rename runs FIRST,
				// moving the live incarnation to the NEW declared name, so the drop must
				// target the NEW name `name` — dropping the old `matchedActual.name` would
				// no-op (it was just renamed away) and the recreate, which renders under
				// `name`, would then collide ("already exists"). For a plain name match the
				// two names are identical.
				const dropName = matchedActual.name.toLowerCase() !== name ? name : matchedActual.name.toLowerCase();
				dropSet.add(dropName);
				diff.tablesToCreate.push(renderFreshTableCreate(name, tableStmt, declaredMaterializedViews, targetSchemaName, defaultVtabModule, defaultVtabArgs));
				diff.maintainedModuleMigrations.push({
					name: tableStmt.table.name,
					fromModule: alterDiff.maintainedModuleMigration.fromModule,
					toModule: alterDiff.maintainedModuleMigration.toModule,
				});
				maintainedModuleRecreates++;
				continue;
			}
			// If this was a rename, set the alter target to the new name (post-rename)
			if (matchedActual.name.toLowerCase() !== name) {
				alterDiff.tableName = tableStmt.table.name;
			}
			if (
				alterDiff.columnsToAdd.length > 0
				|| alterDiff.columnsToDrop.length > 0
				|| alterDiff.columnsToAlter.length > 0
				|| alterDiff.columnsToRename.length > 0
				|| (alterDiff.constraintsToRename?.length ?? 0) > 0
				|| (alterDiff.constraintsToDrop?.length ?? 0) > 0
				|| (alterDiff.constraintsToAdd?.length ?? 0) > 0
				|| alterDiff.primaryKeyChange
				|| alterDiff.tableTagsChange !== undefined
				|| (alterDiff.constraintTagsChanges?.length ?? 0) > 0
				|| alterDiff.setMaintained !== undefined
				|| alterDiff.dropMaintained === true
			) {
				diff.tablesToAlter.push(alterDiff);
			}
		} else {
			diff.tablesToCreate.push(renderFreshTableCreate(name, tableStmt, declaredMaterializedViews, targetSchemaName, defaultVtabModule, defaultVtabArgs));
		}
	}

	// Tables: drops (skip those consumed by a rename). The module-move drops added
	// above stay in `dropSet`; the orphan drops join them here.
	for (const [name] of actualTables) {
		if (tableRenames.consumedActuals.has(name)) continue;
		if (!declaredTables.has(name)) dropSet.add(name);
	}
	diff.tablesToDrop = orderDropsByFKDependency(dropSet, actualTables);

	// Views: creates / drops / definition-change recreates / hinted-rename
	// recreates / in-place tag changes.
	// A matched view (name- OR rename-matched) whose canonical definition drifted
	// (explicit column list, body, or the `insert defaults` clause — see
	// `viewDefinitionToCanonicalString`) drops+recreates: a plain view is
	// data-less, so the recreate is free, and it carries the declared tags — so a
	// definition change SUPPRESSES any separate SET TAGS (the same mutual
	// exclusion the MV/index paths use). The declared definition is compared raw
	// first; on mismatch a rename-RECONCILED render (every in-diff table/column
	// rename inverse-applied NEW→OLD — see `reconciledDeclaredViewDefinition`)
	// re-compares, so a dependent view over a source renamed in this same diff
	// does not churn a spurious recreate. That reconciliation is
	// correctness-critical, not just churn: `generateMigrationDDL` emits view
	// creates BEFORE the table-alter block where RENAME COLUMN lives, and CREATE
	// VIEW plans its body at create time — an unreconciled recreate naming the
	// NEW column would fail at apply. A RENAME-matched view (hinted via
	// quereus.id / quereus.previous_name) resolves to drop(actual old name) +
	// create(declared new name) whether or not its definition changed — its
	// `kind: 'view'` rename op is metadata only (no ALTER VIEW … RENAME TO
	// primitive), so the convergence DDL must come from these buckets. A
	// definition-UNCHANGED hinted rename renders the recreate with the in-diff
	// COLUMN renames inverse-applied while keeping declared TABLE names (table
	// renames run before creates; column renames run after — see
	// `columnReconciledViewStmt`); the recreate carries the declared tags, so a
	// rename + tag drift converges through it and the in-place SET TAGS branch
	// below never double-emits (renames `continue` past it). A pure name match
	// whose definition is unchanged but tags drifted still takes the in-place
	// `ALTER VIEW … SET TAGS`.
	let viewRecreates = 0; // deliberate drop+create pairs, excluded from the require-hint counts
	for (const [name, declaredView] of declaredViews) {
		const matchedActual = viewRenames.pairs.get(name);
		if (!matchedActual) {
			diff.viewsToCreate.push(createViewToString(applyViewSchemaDefault(declaredView.viewStmt, targetSchemaName)));
			continue;
		}
		const stmt = declaredView.viewStmt;
		// The body string carries any trailing `with defaults (…)` clause, so the
		// canonical definition (and its rename-reconciled form) covers defaults drift.
		let definitionDrifted = viewDefinitionToCanonicalString(stmt.columns, stmt.select) !== matchedActual.definition;
		if (definitionDrifted && (tableRenames.renames.length > 0 || columnRenamesByTable.size > 0)) {
			definitionDrifted = reconciledDeclaredViewDefinition(stmt.columns, stmt.select, tableRenames.renames, columnRenamesByTable, targetSchemaName, resolveDeclaredColumn) !== matchedActual.definition;
		}
		if (definitionDrifted) {
			diff.viewsToDrop.push(matchedActual.name);
			diff.viewsToCreate.push(createViewToString(applyViewSchemaDefault(stmt, targetSchemaName)));
			viewRecreates++;
			continue;
		}
		if (matchedActual.name.toLowerCase() !== name) {
			// Hinted rename, definition unchanged → drop(old) + recreate(declared),
			// rendered with in-diff column renames inverse-applied (NEW→OLD).
			diff.viewsToDrop.push(matchedActual.name);
			diff.viewsToCreate.push(createViewToString(applyViewSchemaDefault(columnReconciledViewStmt(stmt, columnRenamesByTable, targetSchemaName, resolveDeclaredColumn), targetSchemaName)));
			viewRecreates++;
			continue;
		}
		if (tagsDrifted(stmt.tags, matchedActual.tags)) {
			diff.viewTagsChanges.push({ name: stmt.view.name, tags: desiredTagSet(stmt.tags) });
		}
	}
	for (const [name] of actualViews) {
		if (viewRenames.consumedActuals.has(name)) continue;
		if (!declaredViews.has(name)) diff.viewsToDrop.push(name);
	}

	// (Maintained tables are no longer compared here. They are normalized into the
	// table category above, so the unified table loop recognizes a body change as a
	// re-attach (`set maintained as`), a table↔maintained transition as an
	// attach/detach, and an undeclared live maintained table as a `drop table` —
	// see `computeTableAlterDiff` / `applyMaintainedTransition`. A backing-module
	// change on a both-maintained name-match IS detected (see `backingModuleDrifted`)
	// and routed to a destructive drop+recreate in the table loop above —
	// incarnation-minting, so gated at apply on `allow_destructive`.)

	// Indexes: creates / drops / body-change recreates / hinted-rename recreates /
	// in-place tag changes.
	// A name-matched index whose canonical body drifted (UNIQUE-ness, column
	// set/order/direction, partial WHERE) drops+recreates — the same drop+recreate
	// shape MVs use, since an index has no in-place "redefine" primitive. The
	// recreate carries the declared tags, so a body change SUPPRESSES any separate
	// SET TAGS for that index (mutually exclusive per object, mirroring the MV
	// precedence above). A RENAME-matched index (hinted) resolves to drop(actual
	// old name) + create(declared new name) whether or not its body changed — the
	// `kind: 'index'` rename op is metadata only (no ALTER INDEX … RENAME TO
	// primitive), so the convergence DDL must come from these buckets; the
	// rebuild cost on a pure rename is the documented tradeoff. A body-UNCHANGED
	// hinted rename renders the recreate with the in-diff COLUMN renames
	// inverse-applied while keeping declared TABLE names (see
	// `columnReconciledIndexStmt`); the recreate carries the declared tags, so the
	// in-place SET TAGS branch below never double-emits (renames `continue` past
	// it). A pure name match whose body is unchanged but tags drifted still takes
	// the in-place `ALTER INDEX … SET TAGS`.
	let indexRecreates = 0; // deliberate drop+create pairs, excluded from the require-hint counts
	for (const [name, declaredIndex] of declaredIndexes) {
		const matchedActual = indexRenames.pairs.get(name);
		if (!matchedActual) {
			const effectiveStmt = applyIndexDefaults(declaredIndex.indexStmt, targetSchemaName);
			diff.indexesToCreate.push(createIndexToString(effectiveStmt));
			continue;
		}
		// Body comparison (canonical: name / tags excluded; per-column collation
		// included via both-sides pre-resolution). Schema qualification does not affect
		// the body render, so compare the raw declared stmt. The declared side resolves
		// each column's effective collation against the matched declared table (so an
		// inherited/BINARY collation that is unchanged does not churn, while a real
		// collation change recreates), then inverse-applies the index table's in-diff
		// column renames so a same-named index over a column renamed in this same diff
		// matches the actual (pre-rename) body instead of churning a spurious
		// drop+recreate (the column rename rides the table-alter channel). The rename
		// lookup is keyed by the index's *declared* (post-rename) table name — exactly
		// how `columnRenamesByTable` is keyed — so a table renamed in the same diff still
		// resolves its column renames. ALL in-diff table renames are threaded too, so
		// both a table-qualified self-reference and a cross-table reference in the
		// partial WHERE predicate reconcile alongside the column renames (the own-table
		// rename's remaining special role — seeding the column rewrites — is resolved
		// inside declaredIndexCanonicalBody). The drop targets the actual
		// (pre-rename) name and the recreate carries the declared (post-rename) name, so
		// a genuine body change on a rename-matched index resolves to a correct
		// drop+recreate that supersedes the no-op rename op.
		const declaredTableForIndex = declaredTables.get(declaredIndex.indexStmt.table.name.toLowerCase());
		const indexColRenames = columnRenamesByTable.get(declaredIndex.indexStmt.table.name.toLowerCase()) ?? [];
		const declaredBody = declaredIndexCanonicalBody(declaredIndex.indexStmt, declaredTableForIndex, indexColRenames, tableRenames.renames, targetSchemaName, defaultCollation);
		if (declaredBody !== matchedActual.definition) {
			diff.indexesToDrop.push(matchedActual.name);
			const effectiveStmt = applyIndexDefaults(declaredIndex.indexStmt, targetSchemaName);
			diff.indexesToCreate.push(createIndexToString(effectiveStmt));
			indexRecreates++;
			continue;
		}
		if (matchedActual.name.toLowerCase() !== name) {
			// Hinted rename, body unchanged → drop(old) + recreate(declared),
			// rendered with in-diff column renames inverse-applied (NEW→OLD).
			diff.indexesToDrop.push(matchedActual.name);
			const reconciledStmt = columnReconciledIndexStmt(declaredIndex.indexStmt, indexColRenames, columnRenamesByTable, targetSchemaName);
			diff.indexesToCreate.push(createIndexToString(applyIndexDefaults(reconciledStmt, targetSchemaName)));
			indexRecreates++;
			continue;
		}
		// Body unchanged → in-place tag change (pure name match only — renames `continue` above).
		if (tagsDrifted(declaredIndex.indexStmt.tags, matchedActual.tags)) {
			diff.indexTagsChanges.push({ name: declaredIndex.indexStmt.index.name, tags: desiredTagSet(declaredIndex.indexStmt.tags) });
		}
	}
	for (const [name] of actualIndexes) {
		if (indexRenames.consumedActuals.has(name)) continue;
		if (!declaredIndexes.has(name)) diff.indexesToDrop.push(name);
	}

	// Apply 'require-hint' policy: any unhinted name change is an error rather
	// than a silent drop+create. A body-change OR hinted-rename recreate counts as
	// both a create and a drop, which would falsely trip the unhinted-rename guard
	// — so exclude those from the view/index counts (the constraint path does the
	// same with its pure counts): both are deliberate drop+create pairs of a
	// matched object, not an ambiguous unhinted rename. A backing-module move is the
	// table-side analogue (matched-object recreate, not a rename), so subtract
	// `maintainedModuleRecreates` from both table counts.
	if (policy === 'require-hint') {
		enforceRequireHint('table', diff.tablesToCreate.length - maintainedModuleRecreates, diff.tablesToDrop.length - maintainedModuleRecreates);
		enforceRequireHint('view', diff.viewsToCreate.length - viewRecreates, diff.viewsToDrop.length - viewRecreates);
		enforceRequireHint('index', diff.indexesToCreate.length - indexRecreates, diff.indexesToDrop.length - indexRecreates);
	}

	// Assertions (no rename support — names are explicitly part of the contract).
	// A name-matched assertion whose CHECK body drifted drops+recreates — an
	// assertion has no in-place "redefine" primitive, same shape as index/view
	// body drift above. Bodies are compared via the canonical (name/schema-free)
	// `definition` field so both sides run the same `expressionToString` over
	// ASTs from the same parser: an unchanged body renders byte-identical.
	// Identifiers are NOT case-folded (same policy as the view/MV bodies above):
	// a case-only edit churns a drop+recreate, which is cheap here — an assertion
	// recreate re-plans a query, it does not rebuild a structure or rescan rows.
	// NOTE: no rename reconciliation here (unlike the view/index loops above), and
	// none is needed for the well-formed case: `alter table … rename` DOES rewrite
	// an assertion's stored CHECK expression (see `assertion-rename-helpers.ts`), and
	// `apply schema` runs renames before assertion creates, so the re-diff compares
	// new-name against new-name and converges. On the FIRST diff a table renamed in
	// the same round still makes an otherwise-unchanged assertion body look drifted
	// and churns a spurious-but-correct drop+recreate (the DDL applies cleanly). The
	// converse — renaming a table while LEAVING the declared body on the old name —
	// converges the diff, and the recreate then FAILS loudly at apply with
	// `Cannot create assertion '<name>': Table '<old>' not found`, because
	// `CREATE ASSERTION` now plans its body at build time. That is the intended
	// outcome: the migration stops instead of leaving the database unwritable.
	const actualAssertions = new Map(actualCatalog.assertions.map(a => [a.name.toLowerCase(), a]));

	// An unchanged assertion naming an object this same migration DROPS must still
	// be dropped and recreated around it — otherwise the DROP is refused by the
	// runtime guard (`assertNoAssertionDependsOn`) and the migration dies. The live
	// case is a maintained table whose backing module changed: it emits
	// `DROP TABLE IF EXISTS x` plus a recreate of `x`, so the assertion's target
	// comes back and the recreate (emitted last) succeeds. When the object is
	// genuinely gone, the recreate fails loudly with the build-time error above
	// rather than silently bricking every write.
	const droppedInThisDiff = [...diff.tablesToDrop, ...diff.viewsToDrop];
	const namesDroppedObject = (check: AST.Expression): boolean =>
		droppedInThisDiff.some(dropped => tableReferencedInAst(check, dropped, targetSchemaName));

	for (const [name, declaredAssertion] of declaredAssertions) {
		const matchedActual = actualAssertions.get(name);
		const declaredBody = expressionToString(declaredAssertion.assertionStmt.check);
		if (matchedActual && declaredBody === matchedActual.definition
			&& !namesDroppedObject(declaredAssertion.assertionStmt.check)) continue;
		// Drift on a name match: drop the old one first (creates run later, see
		// `generateMigrationDDL`), then recreate from the declaration.
		if (matchedActual) diff.assertionsToDrop.push(matchedActual.name);
		diff.assertionsToCreate.push(createAssertionToString(
			applyAssertionSchemaDefault(declaredAssertion.assertionStmt, targetSchemaName)));
	}

	for (const [name] of actualAssertions) {
		if (!declaredAssertions.has(name)) {
			diff.assertionsToDrop.push(name);
		}
	}

	return diff;
}

/**
 * Computes the diff for a **logical** declared schema. The per-table unit is
 * attach/detach-lens, not create/drop-table:
 *   - a declared logical table not currently registered → attach,
 *   - a registered lens body absent from the declaration → detach.
 *
 * Crucially, this never populates `tablesToDrop` — a logical removal detaches
 * the lens and leaves basis storage intact (see `docs/lens.md` § Deployment).
 * Physical buckets stay empty; `generateMigrationDDL` emits nothing for a
 * logical diff (attach/detach happens in the lens compiler at apply time).
 */
function computeLogicalSchemaDiff(
	declaredSchema: AST.DeclareSchemaStmt,
	actualCatalog: SchemaCatalog,
	diff: SchemaDiff,
): SchemaDiff {
	const declaredLogical = new Set<string>();
	for (const item of declaredSchema.items) {
		if (item.type === 'declaredTable') {
			declaredLogical.add(item.tableStmt.table.name.toLowerCase());
		}
	}
	// In a logical schema, registered views are exclusively lens bodies.
	const actualLens = new Set(actualCatalog.views.map(v => v.name.toLowerCase()));

	for (const name of declaredLogical) {
		if (!actualLens.has(name)) diff.lensToAttach.push(name);
	}
	for (const name of actualLens) {
		if (!declaredLogical.has(name)) diff.lensToDetach.push(name);
	}
	return diff;
}

/**
 * Generic resolver: pair declared and actual objects by name first, then by
 * `quereus.id` and `quereus.previous_name` tag hints to detect renames.
 *
 * Returns:
 *   - `renames`: ordered RenameOps to perform.
 *   - `pairs`:  map from lowercased *declared* name to the matched actual,
 *               for use by alter-diff (covers both name-matched and rename-matched).
 *   - `consumedActuals`: lowercase actual names that are spoken-for by a rename
 *                       (so the drop loop skips them).
 */
function resolveRenames<D, A>(args: {
	kind: RenameKind;
	declared: Map<string, D>;
	actual: Map<string, A>;
	getDeclaredName: (d: D) => string;
	getActualName: (a: A) => string;
	getDeclaredTags: (d: D) => Readonly<Record<string, SqlValue>> | undefined;
	getActualTags: (a: A) => Readonly<Record<string, SqlValue>> | undefined;
	policy: RenamePolicy;
}): {
	renames: RenameOp[];
	pairs: Map<string, A>;
	consumedActuals: Set<string>;
} {
	const { kind, declared, actual, getDeclaredName, getActualName, getDeclaredTags, getActualTags, policy } = args;

	const renames: RenameOp[] = [];
	const pairs = new Map<string, A>();
	const consumedActuals = new Set<string>();

	// Under 'deny' policy, skip rename detection entirely — only name matches.
	if (policy === 'deny') {
		for (const [dn] of declared) {
			const nameMatch = actual.get(dn);
			if (nameMatch) pairs.set(dn, nameMatch);
		}
		return { renames, pairs, consumedActuals };
	}

	// Build (id → actual) index for quick stable-id lookup.
	const actualById = new Map<string, A>();
	for (const [, a] of actual) {
		const id = readQuereusHint(getActualTags(a), 'id');
		if (id) {
			if (actualById.has(id)) {
				throw new QuereusError(
					`Duplicate quereus.id '${id}' on ${kind}s in actual catalog`,
					StatusCode.ERROR,
				);
			}
			actualById.set(id, a);
		}
	}

	// Iterate declared in insertion order. For each declared:
	//   - hintMatch: actual resolved by quereus.id (preferred) or previous_name
	//   - nameMatch: actual sharing the declared's name
	//   If both exist and refer to *different* actuals → conflict (always error,
	//   independent of policy beyond 'deny').
	for (const [dn, d] of declared) {
		const tags = getDeclaredTags(d);
		const declaredId = readQuereusHint(tags, 'id');
		const prevNamesRaw = readQuereusHint(tags, 'previous_name');

		let hintMatch: A | undefined;
		let hintMatchKey: string | undefined;
		if (declaredId) {
			const byId = actualById.get(declaredId);
			if (byId) {
				hintMatch = byId;
				hintMatchKey = getActualName(byId).toLowerCase();
			}
		}
		if (!hintMatch && prevNamesRaw) {
			const candidates = prevNamesRaw
				.split(',')
				.map(s => s.trim().toLowerCase())
				.filter(s => s.length > 0);
			for (const cand of candidates) {
				if (cand === dn) continue; // self-reference is never a rename source
				const byPrev = actual.get(cand);
				if (byPrev) {
					hintMatch = byPrev;
					hintMatchKey = cand;
					break;
				}
			}
		}

		const nameMatch = actual.get(dn);
		const hintIsSelf = hintMatch && hintMatchKey === dn;

		// Conflict: declared name AND hint each resolve to *distinct* existing actuals.
		if (nameMatch && hintMatch && !hintIsSelf) {
			throw new QuereusError(
				`Rename conflict for ${kind} '${getDeclaredName(d)}': declared name and quereus.previous_name/id resolve to different existing objects ('${dn}' vs '${hintMatchKey}')`,
				StatusCode.ERROR,
			);
		}

		if (nameMatch) {
			pairs.set(dn, nameMatch);
			continue;
		}
		if (hintMatch && !hintIsSelf) {
			if (consumedActuals.has(hintMatchKey!)) {
				throw new QuereusError(
					`Rename conflict for ${kind} '${getDeclaredName(d)}': old object '${hintMatchKey}' already consumed by another rename`,
					StatusCode.ERROR,
				);
			}
			renames.push({ kind, oldName: getActualName(hintMatch), newName: getDeclaredName(d) });
			pairs.set(dn, hintMatch);
			consumedActuals.add(hintMatchKey!);
		}
		// Else: create path (caller emits CREATE)
	}

	return { renames, pairs, consumedActuals };
}

/**
 * Read a `quereus.<key>` tag value as a string. Returns undefined if not present
 * or non-string.
 */
function readQuereusHint(
	tags: Readonly<Record<string, SqlValue>> | undefined,
	key: 'id' | 'previous_name',
): string | undefined {
	if (!tags) return undefined;
	const fullKey = QUEREUS_TAG_PREFIX + key;
	const v = tags[fullKey];
	if (typeof v !== 'string') return undefined;
	const trimmed = v.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function enforceRequireHint(kind: string, creates: number, drops: number): void {
	if (creates > 0 && drops > 0) {
		throw new QuereusError(
			`rename_policy = 'require-hint': ${kind} drops and creates both present (${drops} drop / ${creates} create); add 'quereus.previous_name' or 'quereus.id' to hint renames, or use 'allow' / 'deny'.`,
			StatusCode.ERROR,
		);
	}
}

/**
 * Renders the fresh-create DDL for a declared table — shared by the create branch
 * and the destructive backing-module move's recreate, so both re-materialize a
 * maintained body into the declared module through one renderer. A maintained
 * table declared via the `materialized view` sugar renders that sugar (its
 * column-less normalized table form has no parseable `create table` DDL); a
 * declared-shape maintained table and a plain table render the `create table …`
 * form (carrying any `maintained as` clause).
 */
function renderFreshTableCreate(
	name: string,
	tableStmt: AST.CreateTableStmt,
	declaredMaterializedViews: ReadonlyMap<string, AST.DeclaredMaterializedView>,
	targetSchemaName: string,
	defaultVtabModule: string | undefined,
	defaultVtabArgs: string | undefined,
): string {
	const declaredMv = declaredMaterializedViews.get(name);
	if (declaredMv) {
		return createMaterializedViewToString(applyViewSchemaDefault(declaredMv.viewStmt, targetSchemaName));
	}
	const effectiveStmt = applyTableDefaults(tableStmt, targetSchemaName, defaultVtabModule, defaultVtabArgs);
	return createTableToString(effectiveStmt);
}

/**
 * Qualifies a view / materialized-view create statement's own name with the
 * target schema (when not `main` and not already qualified), so the rendered
 * DDL lands the object in the declared schema rather than whatever schema is
 * current at apply time. The table analogue is {@link applyTableDefaults}.
 * Shared with `catalog.ts`'s baseline DDL emission, which needs the same rule.
 */
export function applyViewSchemaDefault<T extends AST.CreateViewStmt | AST.CreateMaterializedViewStmt>(
	stmt: T,
	targetSchemaName: string | undefined,
): T {
	if (!targetSchemaName || targetSchemaName === 'main' || stmt.view.schema) return stmt;
	return {
		...stmt,
		view: {
			...stmt.view,
			schema: targetSchemaName,
		},
	};
}

/**
 * The assertion analogue of {@link applyViewSchemaDefault}: qualifies a
 * `create assertion` statement's name with the target schema (when not `main`
 * and not already qualified), so the rendered DDL lands the assertion in the
 * declared schema rather than whatever schema is current at apply time.
 * Shared with `catalog.ts`'s declared-DDL emission.
 */
export function applyAssertionSchemaDefault(
	stmt: AST.CreateAssertionStmt,
	targetSchemaName: string | undefined,
): AST.CreateAssertionStmt {
	if (!targetSchemaName || targetSchemaName === 'main' || stmt.name.schema) return stmt;
	return {
		...stmt,
		name: {
			...stmt.name,
			schema: targetSchemaName,
		},
	};
}

/**
 * Applies schema-level defaults (schema name, default vtab module) to a table statement
 */
function applyTableDefaults(
	tableStmt: AST.CreateTableStmt,
	targetSchemaName: string,
	defaultVtabModule?: string,
	defaultVtabArgs?: string
): AST.CreateTableStmt {
	let result = tableStmt;

	// Apply schema name if not main and not already specified
	if (targetSchemaName && targetSchemaName !== 'main' && !tableStmt.table.schema) {
		result = {
			...result,
			table: {
				...result.table,
				schema: targetSchemaName
			}
		};
	}

	// Apply default vtab module if table doesn't have an explicit one
	if (!tableStmt.moduleName && defaultVtabModule) {
		let parsedArgs: Record<string, SqlValue> = {};
		if (defaultVtabArgs) {
			try {
				parsedArgs = JSON.parse(defaultVtabArgs) as Record<string, SqlValue>;
			} catch (e) {
				throw new QuereusError(
					`Invalid JSON in schema default vtab args for table '${tableStmt.table.name}': ${(e as Error).message}`,
					StatusCode.ERROR,
					e as Error
				);
			}
		}
		result = {
			...result,
			moduleName: defaultVtabModule,
			moduleArgs: parsedArgs
		};
	}

	return result;
}

/**
 * Applies schema name to an index statement and its table reference
 */
function applyIndexDefaults(
	indexStmt: AST.CreateIndexStmt,
	targetSchemaName: string
): AST.CreateIndexStmt {
	let result = indexStmt;

	// Apply schema name to the index if not main and not already specified
	if (targetSchemaName && targetSchemaName !== 'main') {
		// Apply schema to the index name
		if (!indexStmt.index.schema) {
			result = {
				...result,
				index: {
					...result.index,
					schema: targetSchemaName
				}
			};
		}
		// Apply schema to the table reference
		if (!indexStmt.table.schema) {
			result = {
				...result,
				table: {
					...result.table,
					schema: targetSchemaName
				}
			};
		}
	}

	return result;
}

/**
 * Reads an index column's EXPLICIT per-column collation as-written, covering both
 * indexed-column forms: the plain `col.collation` and the parser's collate-folded
 * form (`col COLLATE x`, whose collation lives on `col.expr.collation`). Returns
 * undefined when the column carries no explicit COLLATE — it then inherits the
 * table column's collation (see {@link declaredColumnCollation}).
 */
function explicitIndexColumnCollation(col: AST.IndexedColumn): string | undefined {
	if (col.collation) return col.collation;
	if (col.expr?.type === 'collate') return col.expr.collation;
	return undefined;
}

/**
 * Reads a declared table column's effective collation from its `collate` column
 * constraint, normalized (uppercase), defaulting to `'BINARY'`. Mirrors the
 * engine's resolution of a table column's collation ({@link extractDeclaredCollation}).
 * Returns `'BINARY'` when no declared table is supplied (an index on a non-declared
 * table — not a coherent name-match) or the column is not found in it.
 */
function declaredColumnCollation(declaredTable: AST.DeclaredTable | undefined, columnName: string, defaultCollation: string): string {
	if (!declaredTable) return 'BINARY';
	const lower = columnName.toLowerCase();
	const col = declaredTable.tableStmt.columns.find(c => c.name.toLowerCase() === lower);
	return col ? extractDeclaredCollation(col, defaultCollation) : 'BINARY';
}

/**
 * Renders the canonical body of a DECLARED index, pre-resolving each column's
 * effective collation the same way the engine does at create/import time
 * (`buildIndexSchema` / `importIndex`): explicit index COLLATE, else the declared
 * table column's collation, else BINARY — normalized. The resolved value is placed
 * on a normalized plain-form {@link AST.IndexedColumn} (`{ name, collation,
 * direction }`) so {@link createIndexBodyToCanonicalString} reads it off
 * `col.collation`, matching the actual side's lift (`indexToCanonicalDDL`). Because
 * both sides feed an identically-resolved collation, an unchanged inherited/BINARY
 * collation renders identically (no churn) while a genuine collation change diverges
 * (drop+recreate).
 *
 * A genuine expression-index column (no resolvable bare name) is passed through
 * untouched — there is no column collation to resolve and the renderer falls back to
 * `expressionToString`. `declaredTable` is the matched declared table (looked up by
 * the index's table reference); undefined falls back to explicit-or-BINARY.
 *
 * **Column-rename reconciliation.** `colRenames` are the in-diff column renames of
 * the index's table (keyed by the declared/new table name in `computeSchemaDiff`'s
 * pre-pass). The actual catalog body still renders the *pre-rename* column names at
 * diff time, while the declared side renders the *new* names — so a same-named index
 * over a column renamed in this same diff would otherwise churn a spurious
 * drop+recreate. To reconcile, each resolved bare name is inverse-mapped from its NEW
 * name back to its OLD name (case-insensitive) so a pure rename matches the actual
 * body (no churn) while a genuine body edit layered on the rename still differs
 * (recreate). The indexed-column list carries bare names (no qualifiers) and the body
 * excludes the `on <table>` reference, so a *table* rename alone never churns the
 * column list — but the partial WHERE predicate CAN embed table names: the index
 * table as a qualifier (`where t.active = 1`) or, in principle, another table
 * inside a subquery — so ALL in-diff table renames (`tableRenames`) are
 * reconciled there (see below). The cross-table case is currently unreachable
 * end-to-end (the memory backend rejects subqueries — and any cross-table ref —
 * in partial-index predicates at create time, so no actual catalog index can
 * carry one), but the all-renames scope is kept for symmetry with the forward
 * rewriter and future backends.
 *
 * **Ordering is load-bearing**: the effective collation is resolved from the *new*
 * (declared) column name FIRST — the declared table's `ColumnDef` is keyed by the new
 * name — and only THEN is the emitted name inverse-renamed to its old form. Reversing
 * this would look up the declared column's collation under the old name and miss it.
 *
 * The partial-index `where` predicate is reconciled the same way the constraint CHECK
 * path is: EVERY in-diff table rename is inverse-rewritten NEW→OLD first (via
 * {@link renameTableInAst} — the exact inverse of the forward rewriter the executed
 * rename migration runs over ALL tables, so the diff-side reconcile and the migration
 * cannot drift), THEN each renamed column is inverse-rewritten NEW→OLD via
 * {@link renameColumnInCheckExpression} seeded with the OLD table name (qualifiers
 * are pre-normalized to OLD by that point; unqualified refs resolve via the seed
 * either way). The index table's OWN rename retains one special role: it supplies
 * that seed. Sequential inverse application of multiple renames is order-independent
 * because `resolveRenames` makes chains/swaps unrepresentable — no inverse output
 * (oldName) can match another inverse input (newName). This keeps a partial index
 * over a renamed column AND/OR a qualified self-reference under a renamed table from
 * churning, while a genuine predicate edit layered on either rename still differs
 * (recreate). `schemaName` is the default schema for both rewriters. Known accepted
 * edge (symmetric with the forward path): the rewriters are scope-naive about a
 * subquery alias that happens to equal a renamed table's new name — worst case a
 * spurious (valid) recreate.
 */
function declaredIndexCanonicalBody(
	indexStmt: AST.CreateIndexStmt,
	declaredTable: AST.DeclaredTable | undefined,
	colRenames: ReadonlyArray<ColumnRenameOp>,
	tableRenames: ReadonlyArray<RenameOp>,
	schemaName: string,
	defaultCollation: string,
): string {
	const columns: AST.IndexedColumn[] = indexStmt.columns.map(col => {
		const bareName = indexedColumnBareName(col);
		if (!bareName) return col;
		// Collation resolves on the DECLARED (new) name — see the ordering note above.
		// An inherited (no explicit index COLLATE) column resolves the table column's
		// collation under the session default, matching the actual catalog index built
		// from a default-resolved table column — so a non-BINARY default doesn't churn.
		const effective = normalizeCollationName(
			explicitIndexColumnCollation(col) || declaredColumnCollation(declaredTable, bareName, defaultCollation) || 'BINARY',
		);
		// THEN inverse-rename the emitted name to its old (actual-catalog) form.
		const oldName = colRenames.find(r => r.newName.toLowerCase() === bareName.toLowerCase())?.oldName ?? bareName;
		return { name: oldName, collation: effective, direction: col.direction };
	});
	// Reconcile the partial-WHERE predicate: inverse-rewrite EVERY in-diff table
	// rename NEW→OLD first (self-qualifier or a cross-table reference in a
	// subquery alike — mirroring the forward rewriter's all-tables walk), then
	// each renamed column NEW→OLD, over a clone (the rewriters mutate in place;
	// indexStmt backs the recreate DDL). Skip the clone when nothing can match.
	// The column rewrites are seeded with the OLD table name because the
	// qualifier pass has already normalized qualified refs to it (with no own-
	// table rename, OLD == declared, so the seed is unchanged).
	let where = indexStmt.where;
	if (where && (colRenames.length > 0 || tableRenames.length > 0)) {
		const clone = cloneExpr(where);
		for (const r of tableRenames) {
			renameTableInAst(clone, r.newName, r.oldName, schemaName);
		}
		// The index's OWN table rename retains one special role: seeding the
		// column rewrites with that table's OLD name (matched by the declared/
		// NEW table name, exactly the lookup the call site used to do).
		const ownRename = tableRenames.find(
			r => r.newName.toLowerCase() === indexStmt.table.name.toLowerCase(),
		);
		const seedTableName = ownRename?.oldName ?? indexStmt.table.name;
		for (const r of colRenames) {
			renameColumnInCheckExpression(clone, seedTableName, r.newName, r.oldName, schemaName);
		}
		where = clone;
	}
	return createIndexBodyToCanonicalString({ ...indexStmt, columns, where });
}

/**
 * Renders the declared view definition's canonical string with the in-diff
 * renames inverse-applied — each renamed identifier rewritten from its declared
 * NEW name back to the ACTUAL (pre-rename) name the catalog still carries at
 * diff time. The view analogue of {@link reconciledDeclaredBody} (constraints)
 * and {@link declaredIndexCanonicalBody}: comparing this against the actual
 * definition distinguishes a *pure source rename* (matches after reconciliation
 * → no recreate; the rename ops alone converge the view at apply, via the live
 * rename propagation) from a *genuine definition edit* (still differs →
 * drop+recreate). Callers short-circuit the raw-equal compare and call this
 * only on mismatch with renames present.
 *
 * The explicit column list names the VIEW's own output columns — stable
 * identity untouched by source renames — so it passes through unchanged; the
 * body (including its trailing `with defaults (…)` clause) reconciles via
 * {@link inverseRenamedViewParts} with ALL in-diff table renames threaded.
 */
function reconciledDeclaredViewDefinition(
	columns: ReadonlyArray<string> | undefined,
	select: AST.QueryExpr,
	tableRenames: ReadonlyArray<RenameOp>,
	/** Declared (new) table name (lowercased) → that table's column renames. */
	columnRenamesByTable: ReadonlyMap<string, ColumnRenameOp[]>,
	schemaName: string,
	/** Declared-side column-existence resolver for the seeded defaults-expr rewrites (see `computeSchemaDiff`). */
	resolveDeclaredColumn: ResolveColumnInSource,
): string {
	const reconciledSelect = inverseRenamedViewParts(select, tableRenames, columnRenamesByTable, schemaName, resolveDeclaredColumn);
	return viewDefinitionToCanonicalString(columns, reconciledSelect);
}

/**
 * Core inverse-rename pass shared by {@link reconciledDeclaredViewDefinition}
 * (which threads ALL in-diff table renames) and {@link columnReconciledViewStmt}
 * (which passes none — its render must keep declared table names): clones the
 * declared select and `insert defaults` clause (the rewriters mutate in place;
 * the declared stmt backs the declared-schema store / recreate DDL) and
 * rewrites the in-diff renames NEW→OLD.
 *
 * Reconciled body: inverse table renames over the select clone for ALL threaded
 * renames FIRST — so both a direct FROM reference and a cross-table reference in
 * a subquery normalize to OLD names — THEN each renamed table's column renames
 * NEW→OLD, seeded with that table's OLD name (qualifiers are pre-normalized to
 * OLD by the table pass; with no own-table rename — in particular with no table
 * pass at all — the seed is the DECLARED name the qualifiers still carry).
 * Sequential inverse application is order-independent: `resolveRenames` makes
 * chains/swaps unrepresentable, so no inverse output (oldName) can match another
 * inverse input (newName).
 *
 * The trailing `with defaults (…)` clause now rides inside `select`
 * ({@link AST.SelectStmt.defaults}), so the scope-aware body walks descend it
 * directly: each entry's `expr` inverse-renames in the select's FROM scope frame
 * and each entry's `column` target rides the same synthetic-probe rewrite as a
 * `with inverse` target, so the body reconciliation here covers the defaults for
 * free. The `resolveDeclaredColumn` resolver is threaded into that body walk so
 * an unqualified ref inside a defaults-expr subquery that binds a like-named
 * column on its own FROM is NOT false-captured by the enclosing FROM seed
 * (declared-side parity with the forward live-lookup walk; see `computeSchemaDiff`).
 */
function inverseRenamedViewParts(
	select: AST.QueryExpr,
	tableRenames: ReadonlyArray<RenameOp>,
	/** Declared (new) table name (lowercased) → that table's column renames. */
	columnRenamesByTable: ReadonlyMap<string, ColumnRenameOp[]>,
	schemaName: string,
	/** Declared-side column-existence resolver for the scope-aware body walk (see `computeSchemaDiff`). */
	resolveDeclaredColumn: ResolveColumnInSource,
): AST.QueryExpr {
	const selectClone = cloneQueryExpr(select);
	for (const r of tableRenames) {
		renameTableInAst(selectClone, r.newName, r.oldName, schemaName);
	}
	for (const [declaredTableName, colRenames] of columnRenamesByTable) {
		const ownRename = tableRenames.find(r => r.newName.toLowerCase() === declaredTableName);
		const seedTableName = ownRename?.oldName ?? declaredTableName;
		for (const r of colRenames) {
			renameColumnInAst(selectClone, seedTableName, r.newName, r.oldName, schemaName, resolveDeclaredColumn);
		}
	}
	return selectClone;
}

/**
 * Declared {@link AST.CreateViewStmt} with the in-diff COLUMN renames
 * inverse-applied (NEW→OLD); table references untouched. Renders the recreate
 * DDL of a hinted-RENAME-matched view whose definition is otherwise unchanged:
 * in migration order the create runs AFTER `ALTER TABLE … RENAME TO` (declared
 * table names are already live) but BEFORE `ALTER TABLE … RENAME COLUMN` (a
 * body naming the NEW column would fail to plan at create time). After the
 * create, the live column-rename propagation rewrites the fresh body, so the
 * post-apply state and a re-diff converge. Unlike
 * {@link reconciledDeclaredViewDefinition} there is NO inverse table pass (it
 * would name a table that no longer exists at create time) — the shared
 * {@link inverseRenamedViewParts} core runs with no table renames, seeding the
 * column rewrites with each table's DECLARED name, which the body's qualifiers
 * still carry. Identity when the diff carries no column renames.
 */
function columnReconciledViewStmt(
	stmt: AST.CreateViewStmt,
	/** Declared (new) table name (lowercased) → that table's column renames. */
	columnRenamesByTable: ReadonlyMap<string, ColumnRenameOp[]>,
	schemaName: string,
	/** Declared-side column-existence resolver for the seeded defaults-expr rewrites (see `computeSchemaDiff`). */
	resolveDeclaredColumn: ResolveColumnInSource,
): AST.CreateViewStmt {
	if (columnRenamesByTable.size === 0) return stmt;
	// The reconciled body carries any trailing `with defaults (…)` clause inline.
	const reconciledSelect = inverseRenamedViewParts(stmt.select, [], columnRenamesByTable, schemaName, resolveDeclaredColumn);
	return { ...stmt, select: reconciledSelect };
}

/**
 * Declared {@link AST.CreateIndexStmt} with the in-diff COLUMN renames
 * inverse-applied (NEW→OLD); table references untouched. The index analogue of
 * {@link columnReconciledViewStmt}, rendering the recreate DDL of a
 * hinted-RENAME-matched index whose body is otherwise unchanged. Indexed-column
 * bare names map NEW→OLD via the index table's own renames (both indexed-column
 * forms — plain and the parser's collate-folded `col COLLATE x`). The partial
 * WHERE predicate reuses the walk shape of {@link declaredIndexCanonicalBody}
 * minus its inverse table pass: the own table's renames via the
 * CHECK-expression entry point seeded with the DECLARED table name (qualifiers
 * still carry it — no table pass pre-normalized them), other tables' renames
 * via the plain scope-aware walk (a cross-table predicate reference is
 * unreachable today — the memory backend rejects it at create time — kept for
 * symmetry with the canonical-body reconciler). After the create, the live
 * column-rename propagation rewrites the indexed columns and predicate, so a
 * re-diff converges. Identity when the diff carries no column renames.
 */
function columnReconciledIndexStmt(
	stmt: AST.CreateIndexStmt,
	/** The index's own table's in-diff column renames. */
	colRenames: ReadonlyArray<ColumnRenameOp>,
	/** Declared (new) table name (lowercased) → that table's column renames. */
	columnRenamesByTable: ReadonlyMap<string, ColumnRenameOp[]>,
	schemaName: string,
): AST.CreateIndexStmt {
	if (columnRenamesByTable.size === 0) return stmt;

	const columns: AST.IndexedColumn[] = stmt.columns.map(col => {
		const bareName = indexedColumnBareName(col);
		if (!bareName) return col;
		const rename = colRenames.find(r => r.newName.toLowerCase() === bareName.toLowerCase());
		if (!rename) return col;
		if (col.name) return { ...col, name: rename.oldName };
		// Collate-folded form: the bare name lives on col.expr.expr.name.
		const collate = col.expr as AST.CollateExpr;
		const inner = collate.expr as AST.ColumnExpr;
		return { ...col, expr: { ...collate, expr: { ...inner, name: rename.oldName } } };
	});

	let where = stmt.where;
	if (where) {
		const clone = cloneExpr(where);
		for (const r of colRenames) {
			renameColumnInCheckExpression(clone, stmt.table.name, r.newName, r.oldName, schemaName);
		}
		const ownTableLower = stmt.table.name.toLowerCase();
		for (const [declaredTableName, renames] of columnRenamesByTable) {
			if (declaredTableName === ownTableLower) continue;
			for (const r of renames) {
				renameColumnInAst(clone, declaredTableName, r.newName, r.oldName, schemaName);
			}
		}
		where = clone;
	}

	return { ...stmt, columns, where };
}

/**
 * A declared user-named table constraint, normalized for lifecycle detection.
 * `ddl` is the full constraint fragment (`constraint <name> check (...)` with
 * tags) consumed by `ALTER TABLE … ADD <fragment>`. `definition` is the canonical
 * body fragment (name + tags excluded) compared against the actual catalog's
 * `definition` to detect a name-unchanged-but-body-changed constraint.
 */
interface DeclaredNamedConstraint {
	name: string;
	tags?: Readonly<Record<string, SqlValue>>;
	ddl: string;
	definition: string;
	/**
	 * The lifted table-level constraint AST `definition` was rendered from. Kept so
	 * the body comparison can build a rename-reconciled body (see
	 * {@link reconciledDeclaredBody}) by inverse-rewriting a renamed identifier back
	 * to its actual (pre-rename) name. MUST NOT be mutated — it backs `ddl` /
	 * `definition`; reconciliation clones before rewriting.
	 */
	bodyAst: AST.TableConstraint;
}

/**
 * Converts a column-level constraint carrying a name into the equivalent
 * table-level {@link AST.TableConstraint}, so it can be stringified into an
 * `ADD CONSTRAINT` fragment and diffed by name alongside table-level constraints.
 * Returns undefined for constraint kinds that are not lifecycle-managed named
 * constraints (NOT NULL / NULL / DEFAULT / COLLATE / GENERATED / PRIMARY KEY).
 */
function columnConstraintToTableConstraint(columnName: string, cc: AST.ColumnConstraint): AST.TableConstraint | undefined {
	switch (cc.type) {
		case 'check':
			if (!cc.expr) return undefined;
			return { type: 'check', name: cc.name, expr: cc.expr, operations: cc.operations, onConflict: cc.onConflict, tags: cc.tags };
		case 'unique':
			return { type: 'unique', name: cc.name, columns: [{ name: columnName }], onConflict: cc.onConflict, tags: cc.tags };
		case 'foreignKey':
			if (!cc.foreignKey) return undefined;
			return { type: 'foreignKey', name: cc.name, columns: [{ name: columnName }], foreignKey: cc.foreignKey, tags: cc.tags };
		default:
			return undefined;
	}
}

/**
 * Gathers declared *user-named* CHECK / UNIQUE / FOREIGN KEY constraints from a
 * declared table — both table-level and column-level (carrying an explicit name)
 * — keyed by lowercased name. PRIMARY KEY is excluded (handled by
 * `primaryKeyChange`); engine-synthesized `_`-prefixed names are excluded to stay
 * symmetric with the catalog's `namedConstraints`. On a name collision the first
 * wins (a duplicate user constraint name is a separate validation concern).
 *
 * `schemaName` is the schema this table is being diffed under (the differ runs
 * per schema — it is the CHILD schema for any FK declared here). It is threaded
 * into the canonical-body render so an FK's explicit own-schema qualifier folds
 * out symmetrically with the actual-catalog side (see
 * {@link constraintBodyToCanonicalString}); a genuine cross-schema parent stays a
 * body-change channel.
 */
function collectDeclaredNamedConstraints(declaredTable: AST.DeclaredTable, schemaName: string): Map<string, DeclaredNamedConstraint> {
	const out = new Map<string, DeclaredNamedConstraint>();
	const add = (name: string | undefined, tags: Readonly<Record<string, SqlValue>> | undefined, tc: AST.TableConstraint): void => {
		if (!name) return;
		const lower = name.toLowerCase();
		if (lower.startsWith('_')) return;
		if (out.has(lower)) return;
		out.set(lower, { name, tags, ddl: tableConstraintsToString([tc]), definition: constraintBodyToCanonicalString(tc, schemaName), bodyAst: tc });
	};
	for (const c of declaredTable.tableStmt.constraints ?? []) {
		if (c.type === 'primaryKey') continue;
		add(c.name, c.tags, c);
	}
	for (const col of declaredTable.tableStmt.columns) {
		for (const cc of col.constraints ?? []) {
			if (!cc.name) continue;
			const tc = columnConstraintToTableConstraint(col.name, cc);
			if (tc) add(cc.name, cc.tags, tc);
		}
	}
	return out;
}

/**
 * Inverse-applies the in-diff column renames to a constraint's column list: maps
 * each `{ name }` entry from its NEW name back to its OLD name (case-insensitive).
 * Used to reconcile a UNIQUE column set / an FK's local (child) column set against
 * the actual catalog body, which still renders the pre-rename names at diff time.
 * Mutates the supplied (already-cloned) array in place.
 */
function inverseRenameConstraintColumns(
	columns: Array<{ name: string; direction?: 'asc' | 'desc' }> | undefined,
	colRenames: ReadonlyArray<ColumnRenameOp>,
): void {
	if (!columns) return;
	for (const col of columns) {
		const lower = col.name.toLowerCase();
		const r = colRenames.find(cr => cr.newName.toLowerCase() === lower);
		if (r) col.name = r.oldName;
	}
}

/**
 * String-list variant of {@link inverseRenameConstraintColumns}: inverse-applies
 * column renames to a bare `string[]` (an FK's referenced PARENT column list,
 * which is `string[]` rather than `{ name }[]`), mapping each entry from its NEW
 * name back to its OLD name (case-insensitive). Used to reconcile an FK whose
 * *parent* table renamed a referenced column — the parent's column renames are
 * threaded in from `computeSchemaDiff`'s pre-pass. Mutates the supplied
 * (already-cloned) array in place; an undefined / elided list is a no-op (so a
 * `references parent` with no column list never synthesizes one).
 */
function inverseRenameStringColumns(
	columns: string[] | undefined,
	colRenames: ReadonlyArray<ColumnRenameOp>,
): void {
	if (!columns) return;
	for (let i = 0; i < columns.length; i++) {
		const lower = columns[i].toLowerCase();
		const r = colRenames.find(cr => cr.newName.toLowerCase() === lower);
		if (r) columns[i] = r.oldName;
	}
}

/**
 * Renders the declared constraint's canonical body with the in-diff renames
 * inverse-applied — i.e. each renamed identifier rewritten from its NEW name
 * back to the ACTUAL (pre-rename) name the catalog still carries at diff time.
 * Comparing this against `actual.definition` lets the body-change detector
 * distinguish a *pure rename* (bodies match after reconciliation → no churn) from
 * a *genuine body edit* (still differ → drop+recreate). A body edit layered on a
 * rename survives the reconciliation, so the existing rename-vs-body precedence is
 * preserved.
 *
 * Reconciles only what each kind needs (surgical clone, never the whole tree):
 *   - CHECK:  inverse table renames on ALL in-diff renamed tables FIRST —
 *             mirroring the forward path (`rewriteTableForTableRename` walks
 *             every table's CHECKs), so both a qualified self-reference and a
 *             cross-table reference inside a subquery reconcile — then inverse
 *             column renames, in two passes mirroring the forward
 *             `rewriteTableForColumnRename` branch split: the OWNING table's
 *             renames via the seeded CHECK rewriter (OLD-table seed — correct
 *             unconditionally, since qualifiers are pre-normalized to OLD by
 *             the qualifier pass — plus the declared-side scope resolver, so
 *             an unqualified inner-subquery ref binding to a like-named column
 *             on its own FROM source is not falsely captured by the seed),
 *             then OTHER tables' renames via the plain scope-aware walk (no
 *             seed, no resolver — exactly the forward non-owning branch).
 *             Within each pass, sequential inverse application is
 *             order-independent: `resolveRenames` makes rename chains/swaps
 *             unrepresentable, so no inverse output (oldName) can match
 *             another inverse input (newName). BETWEEN the passes order
 *             matters — owning first (see the cross-table loop's comment).
 *   - UNIQUE: inverse column renames on the column list.
 *   - FK:     inverse column renames on the LOCAL (child) column list, inverse
 *             column renames on the referenced PARENT column list (via the parent
 *             table's column renames, keyed by the declared parent name in
 *             `columnRenamesByTable`), AND inverse table renames on the referenced
 *             parent `foreignKey.table`. A parent-table rename and a parent-column
 *             rename in the same diff reconcile together: look up the parent's
 *             column renames by the *new* parent name first, then rewrite the
 *             table name back to its old form.
 */
function reconciledDeclaredBody(
	d: DeclaredNamedConstraint,
	colRenames: ReadonlyArray<ColumnRenameOp>,
	tableRenames: ReadonlyArray<RenameOp>,
	tableName: string,
	schemaName: string,
	/** Declared (new) table name (lowercased) → that table's column renames; for the FK parent-column reconcile. */
	columnRenamesByTable: ReadonlyMap<string, ColumnRenameOp[]>,
	/** Declared-side column-existence resolver for the seeded CHECK rewrites (see `computeSchemaDiff`). */
	resolveDeclaredColumn: ResolveColumnInSource,
): string {
	const tc = d.bodyAst;
	switch (tc.type) {
		case 'check': {
			if (!tc.expr) return d.definition;
			// cloneExpr: the rewriters mutate in place; bodyAst backs ddl/definition.
			const clone: AST.TableConstraint = { ...tc, expr: cloneExpr(tc.expr) };
			// Qualifiers first: any qualified reference in the declared CHECK carries
			// a NEW table name (a self-reference after the owning table's rename, or a
			// cross-table reference inside a subquery after THAT table's rename);
			// inverse-rewrite every in-diff rename to its OLD name so the body matches
			// the actual catalog and the OLD-seeded column rewrites below see the
			// owning table's OLD qualifier. Sequential in-place application is safe:
			// `resolveRenames` makes chains and swaps unrepresentable (every newName is
			// absent from the actual catalog while every oldName is present), so no
			// rename's inverse output can match another's inverse input — order is
			// immaterial and equivalent to simultaneous substitution.
			for (const r of tableRenames) {
				renameTableInAst(clone.expr!, r.newName, r.oldName, schemaName);
			}
			for (const r of colRenames) {
				// Inverse: rewrite the declared NEW column name back to its OLD name.
				// The declared-side resolver keeps the seeded walk scope-aware — an
				// unqualified ref inside a subquery whose own FROM source exposes the
				// NEW name (in the declared world) binds there, not to the owning
				// seed, so it is NOT inverse-rewritten — mirroring the forward seeded
				// call in `rewriteTableForColumnRename` (owning-table branch).
				renameColumnInCheckExpression(clone.expr!, tableName, r.newName, r.oldName, schemaName, resolveDeclaredColumn);
			}
			// Cross-table column renames: a subquery in this CHECK may reference
			// ANOTHER table whose column was renamed in this same diff; the forward
			// propagation rewrites those refs via the plain scope-aware walk (no seed
			// frame, no resolver — `rewriteTableForColumnRename`'s non-owning branch),
			// so the inverse uses the same walker: an unqualified ref only rewrites
			// when the renamed table sits in an enclosing FROM frame, which is exactly
			// right for subquery references. The map key is the DECLARED (new) table
			// name; the qualifier pass above already rewrote the clone's references to
			// OLD names, so map the walk's table seed back. The owning table's entry
			// is skipped — its renames are `colRenames`, handled by the seeded loop
			// above (`tableName` is the ACTUAL/old owning name, so the comparison
			// holds even when the owning table was itself renamed). ORDER MATTERS:
			// owning-seeded inverse FIRST. With the reverse order, a compound diff
			// (owning `qty→cap` + referenced `lim.cap→capacity`) has this loop turn
			// the inner `capacity` back into `cap`, which the owning inverse then
			// falsely captures; owning-first leaves the inner ref spelled `capacity`
			// (no match) until this loop fixes it.
			for (const [declaredTableName, renames] of columnRenamesByTable) {
				const ownRename = tableRenames.find(r => r.newName.toLowerCase() === declaredTableName);
				const seedTableName = ownRename?.oldName ?? declaredTableName;
				if (seedTableName.toLowerCase() === tableName.toLowerCase()) continue;
				for (const r of renames) {
					renameColumnInAst(clone.expr!, seedTableName, r.newName, r.oldName, schemaName);
				}
			}
			return constraintBodyToCanonicalString(clone);
		}
		case 'unique': {
			const clone: AST.TableConstraint = { ...tc, columns: tc.columns?.map(c => ({ ...c })) };
			inverseRenameConstraintColumns(clone.columns, colRenames);
			return constraintBodyToCanonicalString(clone);
		}
		case 'foreignKey': {
			const clone: AST.TableConstraint = {
				...tc,
				columns: tc.columns?.map(c => ({ ...c })),
				foreignKey: tc.foreignKey
					? { ...tc.foreignKey, columns: tc.foreignKey.columns ? [...tc.foreignKey.columns] : undefined }
					: tc.foreignKey,
			};
			// Local (child) columns live on THIS table → inverse column rename.
			inverseRenameConstraintColumns(clone.columns, colRenames);
			if (clone.foreignKey) {
				// Referenced PARENT columns → inverse column rename via the parent
				// table's renames, looked up by the DECLARED (new) parent name —
				// BEFORE the table inverse-rename below rewrites that name to its old
				// form. Absent from the map (e.g. a freshly created parent) ⇒ no-op.
				const parentLower = clone.foreignKey.table.toLowerCase();
				const parentColRenames = columnRenamesByTable.get(parentLower);
				if (parentColRenames) inverseRenameStringColumns(clone.foreignKey.columns, parentColRenames);
				// Parent table reference → inverse table rename (newTable → oldTable).
				// The parent SCHEMA is NOT a rename channel (renames are within-schema),
				// so `foreignKey.schema` rides the clone untouched; the canonical render
				// folds an own-schema qualifier out against `schemaName` (the child schema).
				const tr = tableRenames.find(r => r.newName.toLowerCase() === parentLower);
				if (tr) clone.foreignKey = { ...clone.foreignKey, table: tr.oldName };
			}
			return constraintBodyToCanonicalString(clone, schemaName);
		}
		default:
			return d.definition;
	}
}

/**
 * Resolves a declared table's column renames against its matched actual catalog
 * table — the map-building + {@link resolveRenames} step shared by both the
 * `computeSchemaDiff` pre-pass (which keeps only `.renames`, keyed by declared
 * table name, so the FK branch of {@link reconciledDeclaredBody} can inverse-
 * rename a parent's referenced column cross-table) and {@link computeTableAlterDiff}
 * (which uses the full `{ renames, pairs, consumedActuals }` for add/drop/alter).
 * The current table's renames are therefore resolved twice per diff — once in the
 * pre-pass and once in its own alter-diff. Accepted: `resolveRenames` over a
 * table's columns is O(columns) with no I/O, and threading the full result through
 * the loop for a micro-optimization would widen the blast radius.
 */
function resolveColumnRenames(
	declaredTable: AST.DeclaredTable,
	actualTable: CatalogTable,
	policy: RenamePolicy,
): { renames: RenameOp[]; pairs: Map<string, CatalogTable['columns'][number]>; consumedActuals: Set<string> } {
	const declaredColumns = new Map<string, AST.ColumnDef>();
	for (const col of declaredTable.tableStmt.columns) {
		declaredColumns.set(col.name.toLowerCase(), col);
	}
	const actualColumns = new Map<string, CatalogTable['columns'][number]>();
	for (const col of actualTable.columns) {
		actualColumns.set(col.name.toLowerCase(), col);
	}
	return resolveRenames<AST.ColumnDef, CatalogTable['columns'][number]>({
		kind: 'constraint', // unused for ColumnRenameOp; kind only flows into RenameOp not surfaced here
		declared: declaredColumns,
		actual: actualColumns,
		getDeclaredName: d => d.name,
		getActualName: a => a.name,
		getDeclaredTags: d => d.tags,
		getActualTags: a => a.tags,
		policy,
	});
}

function computeTableAlterDiff(
	declaredTable: AST.DeclaredTable,
	actualTable: CatalogTable,
	policy: RenamePolicy,
	/** Table renames detected in this same diff (used to reconcile FK parent-table refs). */
	tableRenames: ReadonlyArray<RenameOp>,
	/** Schema name — the default schema for the CHECK column-rename rewriter. */
	schemaName: string,
	/**
	 * Declared (new) table name (lowercased) → that table's column renames, for the
	 * cross-table FK referenced-parent-column reconcile in {@link reconciledDeclaredBody}.
	 */
	columnRenamesByTable: ReadonlyMap<string, ColumnRenameOp[]>,
	/** Declared-side column-existence resolver for the scope-aware CHECK reconcile (see `computeSchemaDiff`). */
	resolveDeclaredColumn: ResolveColumnInSource,
	/** Session `default_collation` for resolving an omitted COLLATE on the declared side. */
	defaultCollation: string,
): TableAlterDiff {
	const diff: TableAlterDiff = {
		// Default to actual's name; caller may override to declared name when this is a rename target.
		tableName: actualTable.name,
		columnsToAdd: [],
		columnsToDrop: [],
		columnsToAlter: [],
		columnsToRename: [],
	};

	const declaredMaintained = declaredTable.tableStmt.maintained;
	const liveMaintained = actualTable.maintained;

	// Backing-module drift on a both-maintained name-match → a destructive,
	// incarnation-minting move (drop+recreate). Detected here, where both module
	// sides are in scope (declared on the table stmt; live on the maintained
	// descriptor); `computeSchemaDiff` routes it to drop+recreate instead of
	// pushing this alter. Compare ONLY when BOTH sides are maintained — a
	// table↔maintained transition is an attach/detach (handled by
	// applyMaintainedTransition), never a module move — and use the SAME
	// normalization the live catalog already applied (absent/`mem` ⇒ `memory`;
	// args stable-sorted, absent ⇒ ''), so the two spellings of the memory default
	// never drift. The module is deliberately separate from `bodyHash`, so the body
	// re-attach path stays untouched.
	const moduleMigration = backingModuleDrifted(declaredMaintained, liveMaintained, declaredTable.tableStmt.moduleName, declaredTable.tableStmt.moduleArgs);
	if (moduleMigration) diff.maintainedModuleMigration = moduleMigration;

	// MV-sugar / implicit maintained form: the body owns the shape, so the differ
	// stays PLAN-FREE — it never derives or compares this table's columns /
	// constraints / PK. A genuine shape mismatch surfaces at apply's attach shape
	// check (the sited, authoritative check), not here. Only table tags and the
	// derivation transition matter. (The declared-shape table form carries columns
	// and falls through to the full comparison below.)
	if (declaredMaintained && declaredTable.tableStmt.columns.length === 0) {
		if (tagsDrifted(declaredTable.tableStmt.tags, actualTable.tags)) {
			diff.tableTagsChange = desiredTagSet(declaredTable.tableStmt.tags);
		}
		applyMaintainedTransition(diff, declaredMaintained, liveMaintained, tableRenames, columnRenamesByTable, schemaName, resolveDeclaredColumn);
		markMaintainedTagRoute(diff, liveMaintained);
		return diff;
	}

	// Detect column renames first so subsequent add/drop/alter operate on the
	// post-rename column set.
	const colRenames = resolveColumnRenames(declaredTable, actualTable, policy);
	for (const r of colRenames.renames) {
		diff.columnsToRename.push({ oldName: r.oldName, newName: r.newName });
	}

	// Find columns to add (store full column definition for DDL generation).
	// Emit an EXPLICIT resolved COLLATE when the declared column omits one and the
	// session `default_collation` resolves to a non-BINARY collation for its type
	// (see {@link withResolvedAddColumnCollation}) — keeps the migration both
	// self-contained (lands the same collation under any executing session default)
	// and idempotent (matches the catalog column the engine's ADD COLUMN now creates).
	for (const col of declaredTable.tableStmt.columns) {
		if (!colRenames.pairs.has(col.name.toLowerCase())) {
			diff.columnsToAdd.push(columnDefToString(withResolvedAddColumnCollation(col, defaultCollation)));
		}
	}

	// Find columns to drop (skip those consumed by a rename)
	const declaredColumnNames = new Set(declaredTable.tableStmt.columns.map(c => c.name.toLowerCase()));
	for (const col of actualTable.columns) {
		const ln = col.name.toLowerCase();
		if (colRenames.consumedActuals.has(ln)) continue;
		if (!declaredColumnNames.has(ln)) {
			diff.columnsToDrop.push(col.name);
		}
	}

	// Detect attribute changes for surviving columns (matched declared/actual pair)
	for (const col of declaredTable.tableStmt.columns) {
		const matched = colRenames.pairs.get(col.name.toLowerCase());
		if (!matched) continue;
		const change = computeColumnAttributeChange(col, matched, defaultCollation);
		if (change) {
			diff.columnsToAlter.push(change);
		}
	}

	// Apply require-hint to columns within this table
	if (policy === 'require-hint') {
		enforceRequireHint(`column (${actualTable.name})`, diff.columnsToAdd.length, diff.columnsToDrop.length);
	}

	// Constraint lifecycle (CHECK / UNIQUE / FOREIGN KEY) by name: rename / drop /
	// add. We gather declared *user-named* constraints from BOTH the table-level
	// `constraints` list AND column-level constraints carrying an explicit name
	// (e.g. `qty int constraint chk_qty check (qty > 0)`) — the actual catalog's
	// `namedConstraints` already merges both. PRIMARY KEY constraints are excluded
	// (PK changes flow through `primaryKeyChange`); auto-prefixed (`_`) names are
	// excluded to stay symmetric with the catalog (see catalog.ts) so an unnamed
	// declared constraint never churns add/drop against its synthesized actual name.
	const declaredNamedConstraints = collectDeclaredNamedConstraints(declaredTable, schemaName);
	const actualNamedConstraints = new Map<string, CatalogTable['namedConstraints'][number]>();
	for (const c of actualTable.namedConstraints ?? []) {
		actualNamedConstraints.set(c.name.toLowerCase(), c);
	}
	const constraintRenames = resolveRenames<DeclaredNamedConstraint, CatalogTable['namedConstraints'][number]>({
		kind: 'constraint',
		declared: declaredNamedConstraints,
		actual: actualNamedConstraints,
		getDeclaredName: d => d.name,
		getActualName: a => a.name,
		getDeclaredTags: d => d.tags,
		getActualTags: a => a.tags,
		policy,
	});
	// Adds / drops / body-change recreates. A declared constraint is matched (by
	// name or by rename hint) to at most one actual via `constraintRenames.pairs`:
	//   - no match           → create (ADD declared fragment)
	//   - match, same body    → no-op here (rename, if any, handled below; tags below)
	//   - match, body changed → drop the old + add the declared (drop+recreate); a
	//                           constraint body change has no in-place "redefine"
	//                           primitive, and re-creation re-validates existing rows
	//                           against the new rule.
	// Precedence: when a constraint was rename-matched AND its body changed, prefer
	// the drop+recreate (under the declared name/def) and SUPPRESS the RENAME — one
	// coherent op, and the new body must re-validate regardless.
	const constraintsToAdd: string[] = [];
	const constraintsToDrop: string[] = [];
	const renamesSuppressedByBodyChange = new Set<string>(); // declared lower-names
	const bodyChangedNames = new Set<string>();              // declared lower-names recreated
	// Counts that feed the `require-hint` guard: only a PURE create + PURE drop
	// (the unhinted-rename shape) trips it. A same-constraint body-change drop+add
	// is a deliberate recreate, not an ambiguous rename, so it is excluded here.
	let pureCreateCount = 0;
	let pureDropCount = 0;

	for (const [lower, d] of declaredNamedConstraints) {
		const matchedActual = constraintRenames.pairs.get(lower);
		if (!matchedActual) {
			constraintsToAdd.push(d.ddl); // create (name- or rename-unmatched)
			pureCreateCount++;
			continue;
		}
		// Body comparison. The actual side (`matchedActual.definition`) renders the
		// PRE-rename identifier names (a column/parent-table rename has not landed at
		// diff time); the declared side uses the NEW names. So a string mismatch that
		// is purely a renamed identifier — already emitted as a rename in this same
		// diff — must NOT churn a drop+recreate. Short-circuit the common no-rename
		// case (raw strings equal) first; only then reconcile the declared body back
		// to the old names and re-compare. A genuine body edit still differs after
		// reconciliation, so the drop+recreate (and its rename-suppression) is kept.
		if (
			d.definition !== matchedActual.definition &&
			reconciledDeclaredBody(d, diff.columnsToRename, tableRenames, actualTable.name, schemaName, columnRenamesByTable, resolveDeclaredColumn) !== matchedActual.definition
		) {
			constraintsToDrop.push(matchedActual.name); // drop old
			constraintsToAdd.push(d.ddl);               // add new (declared name + tags)
			bodyChangedNames.add(lower);
			if (matchedActual.name.toLowerCase() !== lower) renamesSuppressedByBodyChange.add(lower);
		}
	}

	// Renames, minus any subsumed by a same-constraint body change.
	const effectiveConstraintRenames = constraintRenames.renames.filter(
		r => !renamesSuppressedByBodyChange.has(r.newName.toLowerCase()),
	);
	if (effectiveConstraintRenames.length > 0) {
		diff.constraintsToRename = effectiveConstraintRenames.map(r => ({ oldName: r.oldName, newName: r.newName }));
	}

	// Drops: actual constraint neither declared nor consumed by a rename → DROP.
	// (A rename-consumed actual whose body also changed was already dropped above;
	// it stays in `consumedActuals`, so it is skipped here — no double drop.)
	for (const [lower, a] of actualNamedConstraints) {
		if (constraintRenames.consumedActuals.has(lower)) continue;
		if (!declaredNamedConstraints.has(lower)) {
			constraintsToDrop.push(a.name);
			pureDropCount++;
		}
	}

	if (constraintsToAdd.length > 0) diff.constraintsToAdd = constraintsToAdd;
	if (constraintsToDrop.length > 0) diff.constraintsToDrop = constraintsToDrop;

	// Apply require-hint to constraints within this table (a PURE add + a PURE drop
	// with no rename hint is the ambiguous case the policy guards — body-change
	// recreates are excluded from the counts).
	if (policy === 'require-hint') {
		enforceRequireHint(`constraint (${actualTable.name})`, pureCreateCount, pureDropCount);
	}

	// Detect named-constraint tag drift (name-matched constraints only — a
	// renamed constraint is not addressable by ALTER CONSTRAINT, see the runtime
	// emitter). Whole-set replacement; rename hints excluded from the compare. A
	// constraint that is being body-change-recreated is skipped: its recreate
	// fragment already carries the declared tags, so a separate SET TAGS would be
	// redundant (and would target a constraint that no longer exists at that point).
	const constraintTagsChanges: Array<{ constraintName: string; tags: Record<string, SqlValue> }> = [];
	for (const [name, declaredConstraint] of declaredNamedConstraints) {
		if (bodyChangedNames.has(name)) continue;
		const actualConstraint = actualNamedConstraints.get(name);
		if (!actualConstraint) continue; // a rename/create — not a same-name tag change
		if (tagsDrifted(declaredConstraint.tags, actualConstraint.tags)) {
			constraintTagsChanges.push({
				constraintName: declaredConstraint.name,
				tags: desiredTagSet(declaredConstraint.tags),
			});
		}
	}
	if (constraintTagsChanges.length > 0) {
		diff.constraintTagsChanges = constraintTagsChanges;
	}

	// Detect table-level tag drift (whole-set replacement; rename hints excluded).
	if (tagsDrifted(declaredTable.tableStmt.tags, actualTable.tags)) {
		diff.tableTagsChange = desiredTagSet(declaredTable.tableStmt.tags);
	}

	// Detect PK changes
	const declaredPk = extractDeclaredPK(declaredTable);
	const actualPk = actualTable.primaryKey;

	// Inverse-rename declared PK column names (new → old) so a pure PK-column rename
	// — already emitted as RENAME COLUMN — does not also churn an ALTER PRIMARY KEY.
	// Mirrors the constraint-body reconciliation (reconciledDeclaredBody). A PK
	// references only THIS table's own columns, so `diff.columnsToRename` suffices —
	// no cross-table `columnRenamesByTable` / table renames (unlike the FK body case).
	// Clone first: inverseRenameConstraintColumns mutates in place, and declaredPk
	// backs the NEW names carried in `newPkColumns`.
	const reconciledDeclaredPk = declaredPk.map(c => ({ ...c }));
	inverseRenameConstraintColumns(reconciledDeclaredPk, diff.columnsToRename);

	if (!pkSequencesEqual(reconciledDeclaredPk, actualPk)) {
		diff.primaryKeyChange = {
			oldPkColumns: actualPk.map(pk => pk.columnName),
			newPkColumns: declaredPk, // keep NEW (declared) names for the genuine-change DDL
		};
	}

	// Derivation transition LAST, so a re-attach with a concurrent shape change can
	// observe the column / PK / constraint ops recorded above (→ detach-reshape-attach).
	applyMaintainedTransition(diff, declaredMaintained, liveMaintained, tableRenames, columnRenamesByTable, schemaName, resolveDeclaredColumn);
	markMaintainedTagRoute(diff, liveMaintained);

	return diff;
}

/**
 * Route a maintained table's tag change through `ALTER MATERIALIZED VIEW` (see
 * {@link TableAlterDiff.maintainedTags}): set the flag when a tag change exists on
 * a table that is live-maintained and NOT detached early in this same diff (so it
 * is still maintained at the moment the alter block's SET TAGS runs).
 */
function markMaintainedTagRoute(diff: TableAlterDiff, liveMaintained: CatalogTable['maintained']): void {
	if (diff.tableTagsChange !== undefined && liveMaintained && !diff.dropMaintained) {
		diff.maintainedTags = true;
	}
}

/**
 * Detects a backing-module move on a name-matched maintained table: the declared
 * `using <module>(args)` clause normalizes to a different backing than the live
 * one. Returns `{ fromModule, toModule }` (normalized labels) on drift, else
 * `undefined`. Fires ONLY when BOTH sides are maintained — a table↔maintained
 * transition is an attach/detach, not a module move. The name half uses
 * {@link normalizeBackingModuleName} (absent/`mem` ⇒ `memory`, lowercased) and
 * the args half {@link canonicalBackingModuleArgs} (stable sorted-key render,
 * absent ⇒ ''), so the two spellings of the memory default (`using memory()` /
 * `using mem()` / omitted) never register as drift.
 */
function backingModuleDrifted(
	declaredMaintained: AST.MaintainedClause | undefined,
	liveMaintained: CatalogTable['maintained'],
	declaredModuleName: string | undefined,
	declaredModuleArgs: Readonly<Record<string, SqlValue>> | undefined,
): { fromModule: string; toModule: string } | undefined {
	if (!declaredMaintained || !liveMaintained) return undefined;
	const declName = normalizeBackingModuleName(declaredModuleName);
	const liveName = normalizeBackingModuleName(liveMaintained.backingModuleName);
	const declArgs = canonicalBackingModuleArgs(declaredModuleArgs);
	const liveArgs = canonicalBackingModuleArgs(liveMaintained.backingModuleArgs);
	if (declName === liveName && declArgs === liveArgs) return undefined;
	return {
		fromModule: backingModuleLabel(liveName, liveArgs),
		toModule: backingModuleLabel(declName, declArgs),
	};
}

/** Renders a normalized backing-module identity as `name` or `name(args)` for diagnostics. */
function backingModuleLabel(name: string, canonicalArgs: string): string {
	return canonicalArgs ? `${name}(${canonicalArgs})` : name;
}

/**
 * Recognize the maintained-table (derivation) transition for a name-matched table
 * and record the attach / detach / re-attach op on `diff`. PLAN-FREE: it compares
 * only the canonical body hash (declared `maintained` clause vs the live
 * `derivation.bodyHash`), never the body's derived shape.
 *
 *   declared maintained, live plain      → attach    (set maintained as)
 *   declared plain,      live maintained → detach    (drop maintained)
 *   both maintained, body hash equal     → no-op (idempotent — no phantom re-attach)
 *   both maintained, body hash drift     → re-attach: a single `set maintained as`
 *       when the table shape is unchanged (content reconcile / refresh — NOT a
 *       recreate, so the table incarnation and unrelated rows survive); a
 *       detach → column ops → attach when the declared shape ALSO drifted (the new
 *       column's values arrive via the attach reconcile).
 *
 * A pure in-diff source rename is inverse-applied before the hash compare so a
 * rename never churns a spurious re-attach (mirrors the view/MV body reconcile).
 * A backing-module change is deliberately NOT compared here — it is a destructive
 * incarnation-minting move (drop+recreate), detected separately by
 * {@link backingModuleDrifted} in `computeTableAlterDiff` and routed by
 * `computeSchemaDiff`, never folded into this non-destructive body transition.
 */
function applyMaintainedTransition(
	diff: TableAlterDiff,
	declaredMaintained: AST.MaintainedClause | undefined,
	liveMaintained: CatalogTable['maintained'],
	tableRenames: ReadonlyArray<RenameOp>,
	columnRenamesByTable: ReadonlyMap<string, ColumnRenameOp[]>,
	schemaName: string,
	/** Declared-side column-existence resolver for the seeded defaults-expr rewrites (see `computeSchemaDiff`). */
	resolveDeclaredColumn: ResolveColumnInSource,
): void {
	if (!declaredMaintained && !liveMaintained) return;
	if (declaredMaintained && !liveMaintained) {
		// Attach: derived content reconciles the live (plain) table's rows. Any
		// `with defaults (…)` rides inside the body select. Carry the DECLARED rename
		// list (the verb renames + records explicit; `undefined` ⇒ stays implicit).
		diff.setMaintained = { columns: declaredMaintained.columns, select: declaredMaintained.select };
		return;
	}
	if (!declaredMaintained && liveMaintained) {
		// Detach: rows stay, maintenance stops, the table becomes writable.
		diff.dropMaintained = true;
		return;
	}
	// Both maintained — compare the canonical body hash (reconciling in-diff renames
	// so a pure source rename converges via the rename propagation, not a re-attach).
	if (maintainedBodyMatches(declaredMaintained!, liveMaintained!.bodyHash, tableRenames, columnRenamesByTable, schemaName, resolveDeclaredColumn)) {
		return; // no derivation change → no churn
	}
	// Body drift → re-attach. A concurrent shape change (column / PK / constraint
	// ops already on `diff`) means detach → reshape → re-attach; an unchanged shape
	// re-attaches in place (content reconcile / refresh). Carry the DECLARED rename
	// list so an explicit rename-list change (`(a, b)` → `(a, c)`) reshapes the
	// backing in place via the verb instead of erroring at the strict attach shape
	// check; `undefined` ⇒ the verb follows the body (implicit reshape).
	if (alterDiffHasShapeOps(diff)) diff.dropMaintained = true;
	diff.setMaintained = { columns: declaredMaintained!.columns, select: declaredMaintained!.select };
}

/**
 * True when the declared maintained body canonicalizes to the live
 * `derivation.bodyHash` — i.e. an unchanged derivation (no re-attach).
 *
 * The recorded form is the as-authored `maintained.columns`: `undefined` for an
 * implicit body (MV sugar / `create table … maintained as` / the re-attach verb,
 * which now records implicit) and the names array for an explicit rename list
 * (`mv (a, b)` / `maintained (a, b) as`). Both the create path AND the re-attach
 * verb record the same implicit form for a body whose natural names already equal
 * the table columns, so a single as-authored variant suffices — there is no
 * create-vs-attach representation gap to absorb. The variant is also re-compared
 * under in-diff rename reconciliation so a pure source rename converges via the
 * rename propagation rather than churning a re-attach. A genuine body / clause edit
 * (including an explicit rename-list change b → c) fails the compare, so it is not
 * masked.
 */
function maintainedBodyMatches(
	declared: AST.MaintainedClause,
	liveBodyHash: string,
	tableRenames: ReadonlyArray<RenameOp>,
	columnRenamesByTable: ReadonlyMap<string, ColumnRenameOp[]>,
	schemaName: string,
	/** Declared-side column-existence resolver for the seeded defaults-expr rewrites (see `computeSchemaDiff`). */
	resolveDeclaredColumn: ResolveColumnInSource,
): boolean {
	const hasRenames = tableRenames.length > 0 || columnRenamesByTable.size > 0;
	// The single as-authored form: implicit (`undefined`) for a sugar / verb-attached
	// body, or the explicit declared rename list. Both create and re-attach record the
	// implicit form for a same-name body, so there is no live-names fallback to add.
	// The body string carries any trailing `with defaults (…)` clause, so a
	// defaults-only edit fails the compare and a pure source rename converges.
	const variants = [declared.columns];
	for (const columns of variants) {
		if (computeBodyHash(viewDefinitionToCanonicalString(columns, declared.select)) === liveBodyHash) return true;
		if (hasRenames
			&& computeBodyHash(reconciledDeclaredViewDefinition(columns, declared.select, tableRenames, columnRenamesByTable, schemaName, resolveDeclaredColumn)) === liveBodyHash) {
			return true;
		}
	}
	return false;
}

/** True when a table-alter diff carries any structural (column / PK / constraint) op. */
function alterDiffHasShapeOps(diff: TableAlterDiff): boolean {
	return diff.columnsToAdd.length > 0
		|| diff.columnsToDrop.length > 0
		|| diff.columnsToAlter.length > 0
		|| diff.columnsToRename.length > 0
		|| !!diff.primaryKeyChange
		|| (diff.constraintsToAdd?.length ?? 0) > 0
		|| (diff.constraintsToDrop?.length ?? 0) > 0
		|| (diff.constraintsToRename?.length ?? 0) > 0;
}

/**
 * Normalize a declared `materialized view` item into the table category: a
 * declared table whose `maintained` clause carries the body and whose declared
 * column list is empty (the body owns the shape). This is what lets the differ
 * compare a maintained declaration per name in ONE category — a table↔maintained
 * transition becomes an attach/detach alter, never a cross-category drop+create.
 */
function materializedViewToDeclaredTable(declaredMv: AST.DeclaredMaterializedView): AST.DeclaredTable {
	const mv = declaredMv.viewStmt;
	return {
		type: 'declaredTable',
		tableStmt: {
			type: 'createTable',
			table: mv.view,
			ifNotExists: false,
			columns: [],
			constraints: [],
			moduleName: mv.moduleName,
			moduleArgs: mv.moduleArgs,
			tags: mv.tags,
			// Any `with defaults (…)` rides inside mv.select.
			maintained: { columns: mv.columns, select: mv.select },
		},
	};
}

/**
 * Extract a declared column's effective nullability from its AST constraints.
 * Returns undefined when no explicit NULL/NOT NULL is present (session default applies).
 */
function extractDeclaredNotNull(col: AST.ColumnDef): boolean | undefined {
	if (!col.constraints) return undefined;
	// PK always implies NOT NULL.
	if (col.constraints.some(c => c.type === 'primaryKey')) return true;
	for (const c of col.constraints) {
		if (c.type === 'notNull') return true;
		if (c.type === 'null') return false;
	}
	return undefined;
}

function extractDeclaredDefault(col: AST.ColumnDef): AST.Expression | null {
	if (!col.constraints) return null;
	const d = col.constraints.find(c => c.type === 'default');
	return d?.expr ?? null;
}

/**
 * Extract a declared column's effective collation from its COLLATE constraint,
 * canonicalized (uppercase). When no COLLATE is declared, resolves the
 * `defaultCollation` exactly as the engine's CREATE path does
 * ({@link resolveDefaultCollation}) — so absent COLLATE and an explicit
 * `COLLATE <default>` compare equal against the actual catalog collation, and an
 * `apply schema` under a non-BINARY default stays idempotent (the live catalog
 * column already carries the resolved default; resolving the declared side to the
 * same value avoids a spurious `SET COLLATE`). `defaultCollation` is threaded from
 * the live session — the cross-session rehydrate concern stays fixed-BINARY on the
 * `importTable` path, not here.
 */
function extractDeclaredCollation(col: AST.ColumnDef, defaultCollation: string): string {
	const c = col.constraints?.find(c => c.type === 'collate');
	if (c) return c.collation ? normalizeCollationName(c.collation) : 'BINARY';
	return resolveDefaultCollation(inferType(col.dataType), defaultCollation);
}

/**
 * Returns `col` unchanged when it already declares an explicit COLLATE, or when the
 * session `default_collation` resolves to BINARY for its type; otherwise returns a
 * shallow clone with an explicit `{ type: 'collate', collation: <resolved> }`
 * constraint appended. Used by the ADD COLUMN emission so generated DDL carries an
 * explicit non-BINARY collation rather than relying on the executing session's
 * default — this is what makes `apply schema` idempotent and `diff schema` output
 * portable across sessions with different defaults. Never mutates the declared AST
 * (clones the `constraints` array).
 */
function withResolvedAddColumnCollation(col: AST.ColumnDef, defaultCollation: string): AST.ColumnDef {
	if (col.constraints?.some(c => c.type === 'collate')) return col;
	const resolved = resolveDefaultCollation(inferType(col.dataType), defaultCollation);
	if (resolved === 'BINARY') return col;
	return { ...col, constraints: [...(col.constraints ?? []), { type: 'collate', collation: resolved }] };
}

/**
 * Structural equality for DEFAULT expressions. Compares AST shape by
 * JSON serialization with a stable key order — adequate for literals
 * and common expression shapes typically used as DEFAULT values.
 */
function defaultExpressionsEqual(a: AST.Expression | null, b: AST.Expression | null): boolean {
	if (a === null && b === null) return true;
	if (a === null || b === null) return false;
	return stableStringify(a) === stableStringify(b);
}

function stableStringify(v: unknown): string {
	if (v === null || typeof v !== 'object') return JSON.stringify(v);
	if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
	const obj = v as Record<string, unknown>;
	const keys = Object.keys(obj).filter(k => k !== 'loc').sort();
	return `{${keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',')}}`;
}

/**
 * Rename-hint keys excluded from tag-drift comparison: they drive rename
 * detection ({@link resolveRenames}), not data state, so a tag set carrying only
 * a hint must not churn out a `SET TAGS` after the rename completes. All other
 * reserved tags (`quereus.lens.*`, `quereus.expose_implicit_index`, …) are real
 * schema state and ARE compared.
 */
const RENAME_HINT_KEYS = new Set([QUEREUS_TAG_PREFIX + 'id', QUEREUS_TAG_PREFIX + 'previous_name']);

/** A tag record with the rename-hint keys stripped, for drift comparison. */
function tagsForDriftCompare(tags: Readonly<Record<string, SqlValue>> | undefined): Record<string, SqlValue> {
	const out: Record<string, SqlValue> = {};
	if (tags) {
		for (const [k, v] of Object.entries(tags)) {
			if (!RENAME_HINT_KEYS.has(k.toLowerCase())) out[k] = v;
		}
	}
	return out;
}

/**
 * True when the declared and actual tag sets differ (order-independent, rename
 * hints ignored). On drift the differ emits a `SET TAGS` carrying the full
 * declared set (hints included — they are stored verbatim).
 */
function tagsDrifted(
	declared: Readonly<Record<string, SqlValue>> | undefined,
	actual: Readonly<Record<string, SqlValue>> | undefined,
): boolean {
	return stableStringify(tagsForDriftCompare(declared)) !== stableStringify(tagsForDriftCompare(actual));
}

/** The whole-set replacement value to emit for a drifted tag site (declared, or `{}`). */
function desiredTagSet(declared: Readonly<Record<string, SqlValue>> | undefined): Record<string, SqlValue> {
	return declared ? { ...declared } : {};
}

function computeColumnAttributeChange(
	declared: AST.ColumnDef,
	actual: CatalogTable['columns'][number],
	defaultCollation: string,
): ColumnAttributeChange | undefined {
	const change: ColumnAttributeChange = { columnName: declared.name };
	let any = false;

	// Nullability — only compare when explicitly declared; session default handles unspecified.
	const declaredNotNull = extractDeclaredNotNull(declared);
	if (declaredNotNull !== undefined && declaredNotNull !== actual.notNull) {
		change.notNull = declaredNotNull;
		any = true;
	}

	// Data type — declared type is a string; compare case-insensitively.
	if (declared.dataType && declared.dataType.toLowerCase() !== actual.type.toLowerCase()) {
		change.dataType = declared.dataType;
		any = true;
	}

	// Default expression — declared absent + actual present → drop (null).
	const declaredDefault = extractDeclaredDefault(declared);
	const hasDeclaredDefaultConstraint = !!declared.constraints?.some(c => c.type === 'default');
	const actualDefault = actual.defaultValue ?? null;
	if (hasDeclaredDefaultConstraint) {
		if (!defaultExpressionsEqual(declaredDefault, actualDefault)) {
			change.defaultValue = declaredDefault;
			any = true;
		}
	} else if (actualDefault !== null) {
		change.defaultValue = null;
		any = true;
	}

	// Collation — declared COLLATE (default BINARY) vs actual, case-insensitive.
	// Absent and BINARY are equal, so a column that never mentions COLLATE never
	// churns a diff against an actual BINARY column.
	const declaredCollation = extractDeclaredCollation(declared, defaultCollation);
	if (declaredCollation !== (actual.collation || 'BINARY').toUpperCase()) {
		change.collation = declaredCollation;
		any = true;
	}

	// Tag drift — whole-set replacement (rename hints excluded from the compare).
	if (tagsDrifted(declared.tags, actual.tags)) {
		change.tags = desiredTagSet(declared.tags);
		any = true;
	}

	return any ? change : undefined;
}

function extractDeclaredPK(declaredTable: AST.DeclaredTable): Array<{ name: string; direction?: 'asc' | 'desc' }> {
	const stmt = declaredTable.tableStmt;

	// Check for table-level PRIMARY KEY constraint
	if (stmt.constraints) {
		for (const constraint of stmt.constraints) {
			if (constraint.type === 'primaryKey' && constraint.columns) {
				return constraint.columns.map(c => ({
					name: c.name,
					direction: c.direction,
				}));
			}
		}
	}

	// Check for column-level PRIMARY KEY
	const pkCols: Array<{ name: string; direction?: 'asc' | 'desc' }> = [];
	for (const col of stmt.columns) {
		if (col.constraints?.some(c => c.type === 'primaryKey')) {
			const pkConstraint = col.constraints.find(c => c.type === 'primaryKey');
			pkCols.push({
				name: col.name,
				direction: pkConstraint?.type === 'primaryKey' ? pkConstraint.direction : undefined,
			});
		}
	}

	if (pkCols.length > 0) return pkCols;

	// No explicit PK — Quereus defaults to all columns
	return stmt.columns.map(c => ({ name: c.name }));
}

function pkSequencesEqual(
	declared: Array<{ name: string; direction?: 'asc' | 'desc' }>,
	actual: Array<{ columnName: string; desc: boolean }>,
): boolean {
	if (declared.length !== actual.length) return false;
	for (let i = 0; i < declared.length; i++) {
		if (declared[i].name.toLowerCase() !== actual[i].columnName.toLowerCase()) return false;
		const declaredDesc = declared[i].direction === 'desc';
		if (declaredDesc !== actual[i].desc) return false;
	}
	return true;
}

/**
 * Serializes a schema diff to JSON string
 */
export function serializeSchemaDiff(diff: SchemaDiff): string {
	return JSON.stringify(diff, null, 2);
}

/**
 * Topologically sort the to-be-dropped table set so that, for every edge
 * "child references parent" within the set, child appears before parent.
 * Falls back to the input order on a cycle (shouldn't happen for simple FKs,
 * but self/cyclic FKs would otherwise hang the migration).
 */
function orderDropsByFKDependency(
	dropSet: Set<string>,
	actualTables: Map<string, CatalogTable>,
): string[] {
	const result: string[] = [];
	const visited = new Set<string>();
	const visiting = new Set<string>();

	function visit(name: string): void {
		if (visited.has(name)) return;
		if (visiting.has(name)) return; // cycle; bail out gracefully
		visiting.add(name);
		const table = actualTables.get(name);
		if (table) {
			for (const refName of table.referencedTables) {
				if (dropSet.has(refName) && refName !== name) visit(refName);
			}
		}
		visiting.delete(name);
		visited.add(name);
		result.push(name);
	}

	// DFS post-order along child→parent edges puts parents first; reverse to
	// drop children before parents.
	for (const name of dropSet) visit(name);
	return result.reverse();
}

/**
 * One column's `SET DATA TYPE` / `SET COLLATE` statements, ordered so the engine
 * accepts them. `SET DATA TYPE` carries the column's CURRENT collation into the new
 * type and is rejected when the new type does not accept it, so a retype into a
 * BINARY-only type (`DATE`/`TIME`/`DATETIME`/`TIMESPAN`/`JSON`) must follow its
 * `SET COLLATE BINARY` rather than precede it.
 *
 * Collate-first is the right order exactly when the target collation is BINARY: every
 * type accepts BINARY, so that statement never fails on the OLD type, and the retype
 * then arrives with a collation the new type accepts. A non-BINARY target must land
 * AFTER the retype instead — the new type is the one declaring support for it, and
 * setting it on the old type could be rejected (`DATE` → `TEXT COLLATE NOCASE`).
 */
function comparisonDomainAlters(quotedTable: string, quotedCol: string, change: ColumnAttributeChange): string[] {
	const prefix = `ALTER TABLE ${quotedTable} ALTER COLUMN ${quotedCol}`;
	const retype = change.dataType !== undefined ? [`${prefix} SET DATA TYPE ${change.dataType}`] : [];
	const recollate = change.collation !== undefined ? [`${prefix} SET COLLATE ${change.collation}`] : [];
	return normalizeCollationName(change.collation ?? 'BINARY') === 'BINARY'
		? [...recollate, ...retype]
		: [...retype, ...recollate];
}

/**
 * Generates migration DDL statements from a schema diff
 */
export function generateMigrationDDL(diff: SchemaDiff, schemaName?: string): string[] {
	const statements: string[] = [];
	const schemaPrefix = (schemaName && schemaName !== 'main') ? `${quoteIdentifier(schemaName)}.` : '';

	// Renames first — they free old names for subsequent creates and re-target
	// dependents (handled inside ALTER TABLE ... RENAME by the rename rewriter).
	// Only tables have a rename primitive. The other RenameOp kinds are metadata
	// here: a hinted view/index rename's convergence DDL is emitted by
	// computeSchemaDiff itself as drop(old) + recreate(declared) through the
	// standard viewsToDrop/viewsToCreate / indexesToDrop/indexesToCreate buckets
	// (whether or not the definition also changed), and a constraint rename rides
	// the table-alter channel (RENAME CONSTRAINT below).
	for (const r of diff.renames) {
		if (r.kind === 'table') {
			statements.push(`ALTER TABLE ${schemaPrefix}${quoteIdentifier(r.oldName)} RENAME TO ${quoteIdentifier(r.newName)}`);
		}
		// Non-table rename ops emit no DDL here — see the note above.
	}

	// Drop assertions first (they may reference tables)
	for (const name of diff.assertionsToDrop) {
		statements.push(`DROP ASSERTION IF EXISTS ${schemaPrefix}${quoteIdentifier(name)}`);
	}

	// Detach maintained tables (`drop maintained`) EARLY — where MV drops ran
	// before — so a detach precedes any column op on that table AND any drop of its
	// former source in the same migration. This is the reshape leg of a re-attach
	// (detach → column ops → re-attach) and the standalone detach transition; the
	// flip's cross-table detach-v2 / attach-v1 pair falls out of this ordering.
	for (const alter of diff.tablesToAlter) {
		if (alter.dropMaintained) {
			statements.push(`ALTER TABLE ${schemaPrefix}${quoteIdentifier(alter.tableName)} DROP MAINTAINED`);
		}
	}

	// Drop items (reverse order)
	for (const tableName of diff.tablesToDrop) {
		statements.push(`DROP TABLE IF EXISTS ${schemaPrefix}${quoteIdentifier(tableName)}`);
	}

	for (const viewName of diff.viewsToDrop) {
		statements.push(`DROP VIEW IF EXISTS ${schemaPrefix}${quoteIdentifier(viewName)}`);
	}

	for (const indexName of diff.indexesToDrop) {
		statements.push(`DROP INDEX IF EXISTS ${schemaPrefix}${quoteIdentifier(indexName)}`);
	}

	// Create new items. A fresh maintained table rides `tablesToCreate` (rendered
	// as the `create materialized view` sugar) and re-materializes as part of its
	// create.
	statements.push(...diff.tablesToCreate);
	statements.push(...diff.viewsToCreate);
	statements.push(...diff.indexesToCreate);
	// Assertion creates do NOT go here — they run last, after the table alters and
	// the maintained re-attaches. See the push at the end of this function.

	// Alter existing tables.
	// Phase order within one table:
	//   RENAME COLUMN (so subsequent phases see post-rename column names)
	//   → ADD COLUMN
	//   → ALTER COLUMN (comparison domain, then default, then nullability — so SET
	//     NOT NULL can rely on an already-populated DEFAULT for backfill; the
	//     type/collation pair orders internally, see comparisonDomainAlters)
	//   → RENAME CONSTRAINT, then DROP CONSTRAINT (free / remove a name before any
	//     re-add; a UNIQUE drop precedes the PK change so it can't strand a PK dep)
	//   → ALTER PRIMARY KEY
	//   → ADD CONSTRAINT (after the PK change and the column adds it may reference)
	//   → DROP COLUMN (last, so NOT NULL relaxation never blocks subsequent drops)
	for (const alter of diff.tablesToAlter) {
		const quotedTable = `${schemaPrefix}${quoteIdentifier(alter.tableName)}`;
		for (const r of alter.columnsToRename) {
			statements.push(`ALTER TABLE ${quotedTable} RENAME COLUMN ${quoteIdentifier(r.oldName)} TO ${quoteIdentifier(r.newName)}`);
		}
		for (const colDef of alter.columnsToAdd) {
			statements.push(`ALTER TABLE ${quotedTable} ADD COLUMN ${colDef}`);
		}
		for (const colAlter of alter.columnsToAlter) {
			const quotedCol = quoteIdentifier(colAlter.columnName);
			// SET DATA TYPE / SET COLLATE lead the per-column phase (both are
			// comparison-domain changes), before DEFAULT / NOT NULL.
			statements.push(...comparisonDomainAlters(quotedTable, quotedCol, colAlter));
			if (colAlter.defaultValue !== undefined) {
				if (colAlter.defaultValue === null) {
					statements.push(`ALTER TABLE ${quotedTable} ALTER COLUMN ${quotedCol} DROP DEFAULT`);
				} else {
					statements.push(`ALTER TABLE ${quotedTable} ALTER COLUMN ${quotedCol} SET DEFAULT ${expressionToString(colAlter.defaultValue)}`);
				}
			}
			if (colAlter.notNull !== undefined) {
				statements.push(colAlter.notNull
					? `ALTER TABLE ${quotedTable} ALTER COLUMN ${quotedCol} SET NOT NULL`
					: `ALTER TABLE ${quotedTable} ALTER COLUMN ${quotedCol} DROP NOT NULL`);
			}
		}
		// Constraint lifecycle: RENAME (free a name) then DROP (remove a stale /
		// conflicting constraint), both BEFORE re-adds and before the PK change so a
		// dropped UNIQUE can't strand a PK dependency.
		for (const r of alter.constraintsToRename ?? []) {
			statements.push(`ALTER TABLE ${quotedTable} RENAME CONSTRAINT ${quoteIdentifier(r.oldName)} TO ${quoteIdentifier(r.newName)}`);
		}
		for (const name of alter.constraintsToDrop ?? []) {
			statements.push(`ALTER TABLE ${quotedTable} DROP CONSTRAINT ${quoteIdentifier(name)}`);
		}
		if (alter.primaryKeyChange) {
			const pkCols = alter.primaryKeyChange.newPkColumns
				.map(c => {
					let s = quoteIdentifier(c.name);
					if (c.direction === 'desc') s += ' desc';
					return s;
				})
				.join(', ');
			statements.push(`ALTER TABLE ${quotedTable} ALTER PRIMARY KEY (${pkCols})`);
		}
		// ADD CONSTRAINT after the PK change (a new UNIQUE / FK may align with the new
		// key) and after the column adds it may reference. CHECK adds apply in-place;
		// UNIQUE / FK adds depend on module ADD CONSTRAINT support (see constraintsToAdd).
		for (const frag of alter.constraintsToAdd ?? []) {
			statements.push(`ALTER TABLE ${quotedTable} ADD ${frag}`);
		}
		for (const colName of alter.columnsToDrop) {
			statements.push(`ALTER TABLE ${quotedTable} DROP COLUMN ${quoteIdentifier(colName)}`);
		}
		// Tags phase — last, so a SET TAGS lands on the post-structural column /
		// constraint set (a tag set emitted alongside a RENAME COLUMN targets the
		// post-rename name). Whole-set replacement; an empty set clears.
		if (alter.tableTagsChange !== undefined) {
			// A maintained table's tag edit must use ALTER MATERIALIZED VIEW (fires
			// materialized_view_modified so a store catalog re-persists; the ALTER
			// TABLE handler rejects a tag action on a maintained table). See
			// `TableAlterDiff.maintainedTags`.
			const tagVerb = alter.maintainedTags ? 'ALTER MATERIALIZED VIEW' : 'ALTER TABLE';
			statements.push(`${tagVerb} ${quotedTable} SET TAGS ${tagsBodyToString(alter.tableTagsChange)}`);
		}
		for (const colAlter of alter.columnsToAlter) {
			if (colAlter.tags === undefined) continue;
			statements.push(`ALTER TABLE ${quotedTable} ALTER COLUMN ${quoteIdentifier(colAlter.columnName)} SET TAGS ${tagsBodyToString(colAlter.tags)}`);
		}
		for (const ctc of alter.constraintTagsChanges ?? []) {
			statements.push(`ALTER TABLE ${quotedTable} ALTER CONSTRAINT ${quoteIdentifier(ctc.constraintName)} SET TAGS ${tagsBodyToString(ctc.tags)}`);
		}
	}

	// Attach / re-attach maintained tables (`set maintained as`) LATE — where MV
	// creates ran — after every table create/alter, so the target's final shape and
	// the body's sources already exist (and any reshape leg's `drop maintained` +
	// column ops have run). A same-shape re-attach reconciles content in place (a
	// refresh, not a recreate). Rendered via `astToString` over a synthetic
	// `set maintained as` action so the body QueryExpr round-trips exactly.
	for (const alter of diff.tablesToAlter) {
		if (!alter.setMaintained) continue;
		const stmt: AST.AlterTableStmt = {
			type: 'alterTable',
			table: schemaName && schemaName !== 'main'
				? { type: 'identifier', name: alter.tableName, schema: schemaName }
				: { type: 'identifier', name: alter.tableName },
			action: {
				// Any `with defaults (…)` rides inside the body select. The `(cols)`
				// rename list rides too when the DECLARED form is explicit (`astToString`
				// renders it; `undefined` ⇒ the bare `set maintained as` implicit form).
				type: 'setMaintained',
				columns: alter.setMaintained.columns,
				select: alter.setMaintained.select,
			},
		};
		statements.push(astToString(stmt));
	}

	// Assertion creates LAST — after every table alter and maintained re-attach, so
	// a body sees the final shape of every object. `CREATE ASSERTION` plans its
	// body at build time (see `planAssertionBody`), so a declaration that adds a
	// column and an assertion over that column in the same round would fail if the
	// create ran in the create block, before `ADD COLUMN`. Nothing in a migration
	// depends on an assertion existing, so last is strictly safer. Assertion DROPs
	// stay first (see the top of this function).
	statements.push(...diff.assertionsToCreate);

	// In-place tag changes on views / indexes. These are leaf metadata writes (no
	// dependency ordering vs the table-alter block). The `?? []` keeps
	// generateMigrationDDL robust against hand-built diffs (some tests construct
	// partial SchemaDiff literals), mirroring `constraintTagsChanges`. A maintained
	// table's tag-only change rides the table-alter block above (`SET TAGS`), not a
	// separate bucket.
	for (const vtc of diff.viewTagsChanges ?? []) {
		statements.push(`ALTER VIEW ${schemaPrefix}${quoteIdentifier(vtc.name)} SET TAGS ${tagsBodyToString(vtc.tags)}`);
	}
	for (const itc of diff.indexTagsChanges ?? []) {
		statements.push(`ALTER INDEX ${schemaPrefix}${quoteIdentifier(itc.name)} SET TAGS ${tagsBodyToString(itc.tags)}`);
	}

	return statements;
}


