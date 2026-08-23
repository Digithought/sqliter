import type { Database } from '../../core/database.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type Row, type SqlValue } from '../../common/types.js';
import type * as AST from '../../parser/ast.js';
import { astToString, expressionToString, viewDefinitionToCanonicalString } from '../../emit/ast-stringify.js';
import type { PlanNode, RelationalPlanNode } from '../../planner/nodes/plan-node.js';
import { TableReferenceNode, ColumnReferenceNode } from '../../planner/nodes/reference.js';
import { Parser } from '../../parser/parser.js';
import { keysOf } from '../../planner/util/fd-utils.js';
import { proveCoverage } from '../../planner/analysis/coverage-prover.js';
import { deriveCoarsenedBackingKey, type CoarsenedBackingKey } from '../../planner/analysis/coarsened-key.js';
import type { ColumnSchema } from '../../schema/column.js';
import { type TableSchema, type PrimaryKeyColumnDefinition, buildColumnIndexMap, requireVtabModule, RowOpFlag } from '../../schema/table.js';
import {
	validateChecksOverExistingRows,
	validateForeignKeyOverExistingRows,
	maintainedTableCheckViolationError,
	maintainedTableFkViolationError,
	formatKeyValue,
} from '../../schema/constraint-builder.js';
import type { CoarsenedKeyInfo } from '../../schema/view.js';
import { computeBodyHash, normalizeBackingModuleName } from '../../schema/view.js';
import { isMaintainedTable, type MaintainedTableSchema, type TableDerivation } from '../../schema/derivation.js';
import { assertCatalogObjectPersistable } from '../../schema/catalog-persistability.js';
import type { Schema } from '../../schema/schema.js';
import { renameTableInAst, renameColumnInAst } from '../../schema/rename-rewriter.js';
import type { ResolveObjectRef, TableRenameTarget } from '../../schema/rename-rewriter.js';
import type { ResolveColumnInSource } from '../../schema/rename-rewriter.js';
import { createLogger } from '../../common/logger.js';
import type { BackingHost, BackingRowChange } from '../../vtab/backing-host.js';
import type { ResidualKeyBatch } from '../../core/database-materialized-views.js';
import type { VirtualTableConnection } from '../../vtab/connection.js';
import type { SchemaChangeInfo } from '../../vtab/module.js';
import { compareSqlValuesFast, resolveCollationFunctions } from '../../util/comparison.js';
import type { CollationResolver } from '../../types/logical-type.js';

const log = createLogger('runtime:emit:materialized-view');
const warnLog = log.extend('warn');

// Canonical body-hash lives next to the MV schema definition so the declarative
// differ can share it without depending on the runtime layer. Re-exported here
// for the create/refresh emitters that already import from this module.
export { computeBodyHash };

/**
 * Purpose-built diagnostic for a bag (duplicate-producing) materialized-view
 * body. A v1 materialized view is a *keyed* derived relation: its body must
 * produce a **set** (no duplicate rows under the backing-table key). This
 * replaces the raw `UNIQUE constraint failed: <backing table> PK` message —
 * which named a hidden implementation detail — with one that names the MV and
 * explains the contract. Raised at create (loud, immediate) or at the next
 * refresh if a duplicate-free body later becomes duplicate-producing.
 */
export function materializedViewNotASetError(schemaName: string, viewName: string): QuereusError {
	return new QuereusError(
		`materialized view '${schemaName}.${viewName}' body produces duplicate rows, `
			+ `but a materialized view must be a set: its body needs a unique key. `
			+ `Project the source's primary-key column(s) so every row is unique; for a `
			+ `non-keyed result use a plain \`create view\` (live re-evaluation) or `
			+ `\`create table ... as <body>\` (a one-off snapshot).`,
		StatusCode.CONSTRAINT,
	);
}

/**
 * Purpose-built diagnostic for a refresh that would store a NULL into a backing column
 * the schema declares NOT NULL *and* that is a physical-PK member. This is the exact
 * reachable contradiction: the view's `order by <col>` seeded the column into the
 * backing's **physical** primary key ({@link computeBackingPrimaryKey}), which keeps it
 * declared NOT NULL even after the source column loosened to nullable — the refresh reshape
 * masks the loosening of a physical-PK column rather than emitting it (see
 * {@link isPhysicalPkColumn}). Once the
 * source column becomes nullable and the recomputed body yields a NULL row, storing it
 * would leave the backing schema declaring NOT NULL while holding a NULL — a silent
 * contradiction. Both maintenance vectors raise this instead, naming the column, the cause,
 * and the remedy: the **refresh** rebuild (`rebuildBacking` → {@link assertNoNullInNotNullSeededPk})
 * and the **row-time** write-through (the primary vector — `assertNoNullInNotNullSeededPkRowTime`
 * in database-materialized-views-apply.ts, gated on the precomputed `plan.nullGuardColumns`).
 * The message is worded vector-neutrally ("maintaining …") so it reads correctly from both.
 *
 * NOTE: narrow loud-error guard, not the full fix. The lasting resolution stops
 * ordering-seeding the physical PK (expressing body order as a materialized secondary
 * index) — backlog `debt-mv-ordering-seed-to-materialized-index`. Until it lands the MV
 * rejects (rather than silently stores) a source NULL in the seeded column.
 */
export function nullInNotNullSeededPkError(schemaName: string, viewName: string, columnName: string): QuereusError {
	return new QuereusError(
		`maintaining materialized view '${schemaName}.${viewName}' would store NULL in column '${columnName}', `
			+ `which the backing declares NOT NULL because the view's \`order by\` seeded it into the physical `
			+ `primary key; the source column became nullable and now produces a NULL row. Recreate the view `
			+ `without \`order by ${columnName}\` (or excluding ${columnName} from the ordering) to allow `
			+ `nullable values in it.`,
		StatusCode.CONSTRAINT,
	);
}

/** Backing-table column/PK/ordering shape derived from the optimized body relation. */
export interface BackingShape {
	columns: ColumnSchema[];
	primaryKey: ReadonlyArray<{ index: number; desc: boolean }>;
	ordering?: ReadonlyArray<{ index: number; desc: boolean }>;
	/** Qualified (lowercased `schema.table`) source tables the body reads. */
	sourceTables: string[];
	/** Present when `primaryKey` is a **collation-coarsened lineage key** — the body
	 *  has no provable key and the backing identity was derived from source-key
	 *  lineage with at least one collation-weakened column (the parallel-migration
	 *  shape — `deriveCoarsenedBackingKey`). Drives the create-time key-coarsening
	 *  warning and the MV-record stamp. Absent when `keysOf` proved a key, when the
	 *  lineage key does not coarsen, or when no key was derivable at all (the
	 *  all-columns fallback; such a body is rejected at registration). */
	coarsenedKey?: CoarsenedKeyInfo;
	/** All minimal candidate keys proved by `keysOf` for the body root, as sorted
	 *  column-index arrays. Present only when `keysOf` returned at least one key
	 *  (i.e., not the coarsened-lineage or all-columns path). Used by
	 *  `tryRecompileMaterializedViewLive` to check if the existing backing PK is
	 *  still a superkey after a body-irrelevant constraint change. */
	allProvedKeys?: ReadonlyArray<ReadonlyArray<number>>;
}

/**
 * Builds + optimizes the materialized-view body and derives the backing table's
 * column list, primary key, body ordering, and source-table dependencies.
 *
 * Columns and types come straight from the optimized relation's
 * {@link RelationalPlanNode.getType}; the PK is the first usable key from
 * `keysOf` (all-columns fallback when none — such an MV is incremental-ineligible
 * until Phase 2). Re-planning here is cheap relative to materialization and keeps
 * the create/refresh emitters free of optimizer plumbing.
 *
 * `backing` names the module that hosts (or would host) this shape's backing table,
 * plus (for a comparison) the table the result will be compared against. Supplying it
 * runs the derived shape through that module's own create-time normalization
 * ({@link normalizeBackingShape}) so every downstream comparison sees the shape the
 * module would actually create — see that function for why, and for what `against`
 * resolves. Omit only where no backing identity exists; every consumer that compares
 * against a live backing must pass it.
 */
export function deriveBackingShape(
	db: Database,
	schemaName: string,
	bodySql: string,
	explicitColumns: ReadonlyArray<string> | undefined,
	backing?: {
		moduleName?: string;
		moduleArgs?: Readonly<Record<string, SqlValue>>;
		against?: TableSchema;
	},
): BackingShape {
	// Suppress the read-side rewrite: we are computing the MV body to derive/populate
	// its OWN backing, so it must not be rewritten to read that backing.
	const shape = db.schemaManager.withSuppressedMaterializedViewRewrite(
		() => deriveBackingShapeUnguarded(db, schemaName, bodySql, explicitColumns),
	);
	return normalizeBackingShape(db, schemaName, shape, backing?.moduleName, backing?.moduleArgs, backing?.against);
}

function deriveBackingShapeUnguarded(
	db: Database,
	schemaName: string,
	bodySql: string,
	explicitColumns: ReadonlyArray<string> | undefined,
): BackingShape {
	// Home-schema path: the body's unqualified source names resolve next to the
	// MV, independent of the session's schema path at re-plan time.
	const plan = db.getPlan(bodySql, db._homeSchemaPath(schemaName));
	const root = plan.getRelations()[0];
	if (!root) {
		throw new QuereusError('materialized view body produced no relation', StatusCode.INTERNAL);
	}

	const relType = root.getType();
	const bodyColumns = relType.columns;
	const names = explicitColumns && explicitColumns.length > 0
		? explicitColumns
		: bodyColumns.map((c, i) => c.name || `col${i}`);

	const columns: ColumnSchema[] = bodyColumns.map((c, i) => {
		const col: ColumnSchema = {
			name: names[i] ?? `col${i}`,
			logicalType: c.type.logicalType,
			notNull: c.type.nullable === false,
			primaryKey: false,
			pkOrder: 0,
			defaultValue: null,
			collation: c.type.collationName ?? 'BINARY',
			generated: false,
		};
		// Thread the output collation's PROVENANCE into backing-column explicitness:
		// a deliberately-collated output column (an explicit `COLLATE`, or a column
		// whose declared collation flows through unchanged) publishes an EXPLICIT
		// backing collation, so the store module's PK-collation reconcile keeps the
		// backing text PK under the published collation instead of re-keying it under
		// the store default (NOCASE). A 'default'/absent source stays implicit (field
		// left unset — matching ColumnSchema's "absent ⇒ implicit" contract), so a
		// genuinely-implicit MV column preserves the historical store-default keying.
		if (c.type.collationSource === 'explicit' || c.type.collationSource === 'declared') {
			col.collationExplicit = true;
		}
		return col;
	});

	// First usable key from the unified surface. A keyless body is then offered the
	// coarsened lineage key (the parallel-migration shape — see coarsened-key.ts):
	// the projected source key, keyed under the OUTPUT collations, so create-fill
	// rejects collisions loudly and steady-state maintenance merges them LWW. The
	// all-columns fallback remains for bodies with neither (rejected at
	// registration as a bag, exactly as before).
	const keys = keysOf(root);
	let pkIndices: number[];
	let coarsenedKey: CoarsenedKeyInfo | undefined;
	if (keys.length > 0) {
		pkIndices = [...keys[0]];
	} else {
		const lineageKey = deriveCoarsenedBackingKey(root);
		if (lineageKey) {
			pkIndices = [...lineageKey.keyIndices];
			// Only a genuinely COARSENING key carries the warning payload; an
			// equal/refining lineage key is a true unique key accepted silently.
			if (lineageKey.coarsens) coarsenedKey = buildCoarsenedKeyInfo(lineageKey, columns);
		} else {
			pkIndices = columns.map((_c, i) => i);
		}
	}
	const primaryKey = pkIndices.map(idx => ({ index: idx, desc: false }));

	// A COARSENING key must be the backing's physical key EXACTLY: the loud
	// create-fill and the LWW merge both rest on the backing btree equating
	// colliding source keys, and the ordering-seeded physical PK
	// (computeBackingPrimaryKey leads with the body's `order by` columns) would
	// widen uniqueness past K' — colliding siblings would then coexist silently,
	// defeating both. So drop the ordering seed for a coarsened key; the only
	// cost is the clustering optimization (`mv.ordering` is informational). A
	// non-coarsening lineage key is a true key, so the seed stays uniqueness-
	// preserving there, exactly as for a `keysOf`-proved key.
	const ordering = coarsenedKey
		? undefined
		: root.physical?.ordering?.map(o => ({ index: o.column, desc: o.desc }));

	return {
		columns,
		primaryKey,
		ordering: ordering && ordering.length > 0 ? ordering : undefined,
		sourceTables: collectSourceTables(plan),
		coarsenedKey,
		allProvedKeys: keys.length > 0 ? keys.map(k => Array.from(k)) : undefined,
	};
}

/** Lift the structural {@link CoarsenedBackingKey} into the named, record-facing
 *  {@link CoarsenedKeyInfo} (backing column names instead of indices). */
function buildCoarsenedKeyInfo(key: CoarsenedBackingKey, columns: readonly ColumnSchema[]): CoarsenedKeyInfo {
	const nameOf = (idx: number): string => columns[idx]?.name ?? `col${idx}`;
	return {
		columns: key.keyIndices.map(nameOf),
		weakened: key.columns
			.filter(c => c.coarsens)
			.map(c => ({
				column: nameOf(c.outputIndex),
				sourceCollation: c.sourceCollation,
				outputCollation: c.outputCollation,
			})),
	};
}

/** Walks the plan collecting qualified (lowercased) names of every base table referenced. */
function collectSourceTables(plan: PlanNode): string[] {
	const out = new Set<string>();
	const visited = new Set<PlanNode>();
	const walk = (node: PlanNode): void => {
		if (visited.has(node)) return;
		visited.add(node);
		if (node instanceof TableReferenceNode) {
			out.add(`${node.tableSchema.schemaName}.${node.tableSchema.name}`.toLowerCase());
		}
		for (const c of node.getChildren()) walk(c as unknown as PlanNode);
		for (const r of node.getRelations()) walk(r as unknown as PlanNode);
	};
	walk(plan);
	return [...out];
}

/**
 * Computes the backing table's *physical* primary key. When the body carries an
 * `order by`, the ordering columns lead the key so the btree clusters (and scans)
 * in the body's order — "seeding the backing-table ordering" — with the logical
 * key (from `keysOf`) appended as a uniqueness-preserving tiebreaker. Without an
 * `order by`, the physical key is just the logical key.
 *
 * NOTE: this diverges from `TableDerivation.logicalKey`, which keeps the
 * logical `keysOf` identity. The covering ticket replaces this seeding with a
 * proper materialized index.
 */
export function computeBackingPrimaryKey(shape: BackingShape): ReadonlyArray<{ index: number; desc: boolean }> {
	if (!shape.ordering || shape.ordering.length === 0) {
		return shape.primaryKey;
	}
	const seeded: { index: number; desc: boolean }[] = [];
	const seen = new Set<number>();
	for (const o of shape.ordering) {
		if (!seen.has(o.index)) { seeded.push({ index: o.index, desc: o.desc }); seen.add(o.index); }
	}
	for (const k of shape.primaryKey) {
		if (!seen.has(k.index)) { seeded.push({ index: k.index, desc: k.desc }); seen.add(k.index); }
	}
	return seeded.length > 0 ? seeded : shape.primaryKey;
}

/**
 * Constructs the backing-table {@link TableSchema} for a materialized view from a
 * derived {@link BackingShape}, hosted in `moduleName` — resolved through the one
 * {@link normalizeBackingModuleName} decision (absent ⇒ `'memory'`), the same one
 * the strict DDL-transaction gate in `materialized-view.ts` consults.
 * The capability check here is defense-in-depth — the create builder already
 * gates, but the catalog-import path reaches this without it.
 */
export function buildBackingTableSchema(
	db: Database,
	schemaName: string,
	backingTableName: string,
	shape: BackingShape,
	moduleName?: string,
	moduleArgs?: Readonly<Record<string, SqlValue>>,
	/** Table-level metadata tags (the MV's `with tags (…)` — top-level on the unified record). */
	tags?: Readonly<Record<string, SqlValue>>,
): TableSchema {
	const resolvedModuleName = normalizeBackingModuleName(moduleName);
	const moduleInfo = db.schemaManager.getModule(resolvedModuleName);
	if (!moduleInfo || !moduleInfo.module) {
		throw new QuereusError(`no virtual table module named '${resolvedModuleName}'`, StatusCode.ERROR);
	}
	if (!moduleInfo.module.getBackingHost) {
		throw new QuereusError(
			`module '${resolvedModuleName}' cannot host a materialized-view backing table (it does not implement the backing-host capability)`,
			StatusCode.UNSUPPORTED,
		);
	}

	const backingPk = computeBackingPrimaryKey(shape);
	const pkDefinition: PrimaryKeyColumnDefinition[] = backingPk.map(pk => ({
		index: pk.index,
		desc: pk.desc,
		collation: shape.columns[pk.index]?.collation,
	}));
	// Reflect the physical PK in the column flags (cosmetic; the memory table reads
	// `primaryKeyDefinition`, but catalog/introspection consults column flags).
	backingPk.forEach((pk, order) => {
		const col = shape.columns[pk.index];
		if (col) { col.primaryKey = true; col.pkOrder = order + 1; }
	});

	return {
		name: backingTableName,
		schemaName,
		columns: Object.freeze(shape.columns),
		columnIndexMap: buildColumnIndexMap(shape.columns),
		primaryKeyDefinition: Object.freeze(pkDefinition),
		checkConstraints: Object.freeze([]),
		vtabModule: moduleInfo.module,
		vtabModuleName: resolvedModuleName,
		vtabArgs: moduleArgs ? { ...moduleArgs } : {},
		vtabAuxData: moduleInfo.auxData,
		isView: false,
		estimatedRows: 0,
		tags: tags && Object.keys(tags).length > 0 ? tags : undefined,
	};
}

/**
 * Applies the backing module's own create-time schema normalization
 * ({@link VirtualTableModule.normalizeCreateSchema}) to a derived {@link BackingShape},
 * so a shape derived from the body is expressed in the SAME terms as a table the module
 * actually created.
 *
 * Why: a module may own per-column physical attributes the body's output type cannot
 * predict. The store module keys an *implicit*-collation text primary-key column under
 * its table-level key collation K (default NOCASE — `reconcilePkCollations`), so a
 * persisted backing reads `COLLATE NOCASE` while the re-derived shape says BINARY. Every
 * shape comparison ({@link backingShapeMatches}, {@link describeBackingShapeMismatch},
 * {@link classifyBackingReshape}) would then report a difference that does not exist,
 * refilling the backing on every reopen. Normalizing here — at the SOURCE, before any
 * comparison — keeps both sides post-normalization rather than teaching each comparison
 * site to special-case a module's rewrite.
 *
 * Identity for a module without the hook (memory, and every third-party module), and for
 * an unresolvable module name — the real `no virtual table module named …` /
 * capability diagnostics stay with {@link buildBackingTableSchema}, which is deliberately
 * NOT reused here: it carries the `getBackingHost` gate (whose error must keep firing at
 * its own site) and stamps primary-key flags onto `shape.columns`, neither of which
 * belongs on a pure "what would this become?" probe.
 *
 * **`against` — two-valued compatibility for an implicit attribute.** The hook only ever
 * rewrites attributes the shape left IMPLICIT (the store touches a text primary-key column
 * only when it declares no `collate`). An implicit attribute is genuinely ambiguous once a
 * table exists, because explicitness does not survive a catalog round-trip
 * (`ColumnSchema.collationExplicit` is not persisted; a declared `collate binary` reloads
 * indistinguishable from no clause at all). So an implicit shape column is compatible with
 * a live column carrying EITHER the shape's own declared value or the module's normalized
 * one — both are physically consistent with the body. When the caller names the table this
 * shape will be compared against, the rewrite is therefore kept only where the RAW shape
 * does not already agree with that table; a table-form maintained table whose text key was
 * declared `collate binary` keeps matching its own declaration, while a materialized-view
 * backing the module keyed under K matches that. Omit `against` on a create path (nothing
 * to be compatible with yet) and the module's answer is taken verbatim.
 *
 * A collation the module would NOT produce and the body did NOT declare (a backing
 * persisted under RTRIM, say) matches neither reading and still reports a mismatch. The
 * agreement test looks only at the attributes the hook actually rewrote — see
 * {@link rawReadingIsTheLiveOne}.
 *
 * Only `columns` can change; `primaryKey`, `ordering`, `sourceTables`, `coarsenedKey`,
 * and `allProvedKeys` pass through untouched.
 */
function normalizeBackingShape(
	db: Database,
	schemaName: string,
	shape: BackingShape,
	moduleName?: string,
	moduleArgs?: Readonly<Record<string, SqlValue>>,
	against?: TableSchema,
): BackingShape {
	const resolvedModuleName = normalizeBackingModuleName(moduleName);
	const module = db.schemaManager.getModule(resolvedModuleName)?.module;
	if (!module?.normalizeCreateSchema) return shape;

	// Copy the columns into the probe: the contract says the hook is pure, but a
	// sloppy implementation mutating a column in place would otherwise corrupt the
	// caller's shape. The probe uses the PHYSICAL primary key
	// ({@link computeBackingPrimaryKey} — ordering-seeded), not `shape.primaryKey`,
	// because that is the key the module will actually be handed at create; a text
	// ORDERING column is reconciled there too and would keep diverging otherwise.
	const probeColumns: ColumnSchema[] = shape.columns.map(c => ({ ...c }));
	const probe: TableSchema = {
		name: `<materialized-view backing shape probe>`,
		schemaName,
		columns: probeColumns,
		columnIndexMap: buildColumnIndexMap(probeColumns),
		primaryKeyDefinition: computeBackingPrimaryKey(shape).map(pk => ({
			index: pk.index,
			desc: pk.desc,
			collation: probeColumns[pk.index]?.collation,
		})),
		checkConstraints: [],
		vtabModule: module,
		vtabModuleName: resolvedModuleName,
		vtabArgs: moduleArgs ? { ...moduleArgs } : {},
		isView: false,
		estimatedRows: 0,
	};

	const normalized = module.normalizeCreateSchema(probe);
	if (normalized.columns === probe.columns) return shape;   // hook declined to rewrite

	// A reshape is a contract violation, not a shape difference: the hook may only
	// adjust per-column attributes it owns physically. Fail loud rather than let a
	// misbehaving module silently redefine the backing's column list.
	if (normalized.columns.length !== shape.columns.length) {
		throw new QuereusError(
			`module '${resolvedModuleName}' normalizeCreateSchema changed the column count `
				+ `(${shape.columns.length} → ${normalized.columns.length}); it may only adjust per-column attributes`,
			StatusCode.INTERNAL,
		);
	}
	for (let i = 0; i < shape.columns.length; i++) {
		if (normalized.columns[i].name !== shape.columns[i].name) {
			throw new QuereusError(
				`module '${resolvedModuleName}' normalizeCreateSchema renamed or reordered column ${i} `
					+ `('${shape.columns[i].name}' → '${normalized.columns[i].name}'); it may only adjust per-column attributes`,
				StatusCode.INTERNAL,
			);
		}
	}

	// Two-valued compatibility (see the docblock): where the RAW shape column already
	// agrees with the table this shape is about to be compared against, that reading is
	// the live one and the module's alternative is not applied.
	// NOTE: the two readings exist only because `ColumnSchema.collationExplicit` does not
	// survive a catalog round-trip. If explicitness is ever persisted, the live table can
	// answer "did the author declare this?" directly and this collapses to a single
	// reading — take the module's answer iff the live column is implicit.
	// NOTE: `against` is read POSITIONALLY, which is what the rename cascade needs (names
	// have shifted there, the attributes have not). It is only ever consulted for a column
	// the hook rewrote, so a pure append/drop reshape still resolves correctly — but if a
	// reshape ever MOVES a rewritten column to a position the live table fills with a
	// different column, this asks the wrong column and the alignment-based
	// {@link classifyBackingReshape} would see a collation the module did not produce. Give
	// callers a way to say "align by name" if a reshape is ever seen misclassified this way.
	const columns = normalized.columns.map((col, i) => {
		const raw = shape.columns[i];
		if (col === raw) return raw;
		const live = against?.columns[i];
		if (live && rawReadingIsTheLiveOne(raw, col, live)) return raw;
		return col;
	});
	if (columns.every((c, i) => c === shape.columns[i])) return shape;

	return { ...shape, columns };
}

/**
 * The two-valued compatibility test of {@link normalizeBackingShape}: does the RAW
 * (pre-normalization) reading of a column agree with the live table on every attribute
 * the hook actually rewrote?
 *
 * Only the REWRITTEN attributes are compared. An attribute the hook left alone carries no
 * second reading, so a difference in it is a genuine shape change for the comparison sites
 * to report — it says nothing about which reading of the rewritten attribute is live.
 * Testing all three attributes unconditionally instead would let an unrelated difference
 * decide the collation: a NOT NULL loosening on a physical-PK column — which
 * {@link describeBackingShapeMismatch} deliberately masks — would flip a declared
 * `collate binary` key over to the module's K and turn a data-only refresh into a
 * spurious "primary-key column 0 collation BINARY → NOCASE" inexpressible reshape.
 */
function rawReadingIsTheLiveOne(raw: ColumnSchema, normalized: ColumnSchema, live: ColumnSchema): boolean {
	if (!backingTypeMatches(raw, normalized) && !backingTypeMatches(raw, live)) return false;
	if (!backingNotNullMatches(raw, normalized) && !backingNotNullMatches(raw, live)) return false;
	if (!backingCollationMatches(raw, normalized) && !backingCollationMatches(raw, live)) return false;
	return true;
}

/** Runs the body to completion and returns its rows (raw `Row` arrays). Uses the
 *  no-transaction-management primitive — the caller is already inside DDL execution. */
export async function collectBodyRows(db: Database, schemaName: string, bodySql: string): Promise<Row[]> {
	// Suppress the read-side rewrite for the whole prepare+iterate: this body is run
	// to (re)compute the MV's OWN backing (create fill / refresh rebuild), so it must
	// recompute from the source, never read the backing it is populating.
	return db.schemaManager.withSuppressedMaterializedViewRewriteAsync(async () => {
		const stmt = db.prepare(bodySql);
		// Compile is deferred, so the override lands before any planning happens.
		stmt._schemaPathOverride = db._homeSchemaPath(schemaName);
		try {
			const rows: Row[] = [];
			for await (const row of stmt._iterateRowsRaw()) {
				rows.push(row as Row);
			}
			return rows;
		} finally {
			await stmt.finalize();
		}
	});
}

/**
 * Everything needed to materialize an MV — identity, canonical DDL, and the body
 * in both AST and canonical-SQL form. Satisfied by the create plan node
 * (`CreateMaterializedViewNode`) and by a re-parsed catalog entry
 * (`SchemaManager.importMaterializedView`).
 */
export interface MaterializeViewDefinition {
	schemaName: string;
	viewName: string;
	/** Body AST — retained on the derivation for refresh, declarative emission, and body-hash. */
	selectAst: AST.QueryExpr;
	/** Canonical SQL of the body alone (re-planned here to derive and fill the backing). */
	bodySql: string;
	/** Explicit column list from `create materialized view mv(a, b) ...`, when present. */
	columns?: ReadonlyArray<string>;
	tags?: Readonly<Record<string, SqlValue>>;
	/** Normalized backing-host module (absent ⇒ memory default — see
	 *  `normalizeBackingModule` in schema/view.ts). */
	backingModuleName?: string;
	/** Backing-module args; recorded only when non-empty. */
	backingModuleArgs?: Readonly<Record<string, SqlValue>>;
}

/**
 * Throws the sited declared-column-arity diagnostic when `def`'s explicit column
 * list disagrees with the body's output arity. Build-time creation already
 * validated this (with a build-located diagnostic); this guards the import path —
 * both the refill arm ({@link materializeView}) and the adopt gate check
 * (`SchemaManager.tryAdoptPreExistingBacking`, which must raise it BEFORE the
 * caller drops a durable backing: the entry can never materialize, so dropping
 * would destroy rows for nothing). The refresh path deliberately does NOT share
 * this — it reaches a legitimate mismatch after a source ALTER and has its own
 * "drop and recreate" diagnostic.
 */
export function assertDeclaredColumnArity(def: MaterializeViewDefinition, shape: BackingShape): void {
	if (def.columns && def.columns.length > 0 && def.columns.length !== shape.columns.length) {
		throw new QuereusError(
			`materialized view '${def.schemaName}.${def.viewName}' has ${def.columns.length} declared columns but body produces ${shape.columns.length}`,
			StatusCode.ERROR,
		);
	}
}

/**
 * Builds the {@link TableDerivation} record for `def` over the derived
 * `shape` — the single record formula shared by {@link materializeView} (refill)
 * and {@link adoptMaterializedView} (adopt), so the two paths cannot drift: an
 * adopted and a refilled maintained table are indistinguishable (fixed point:
 * export DDL after adopt == after refill).
 *
 * `bodyHash` hashes the canonical DEFINITION (explicit columns + body — the body
 * string carries any trailing `with defaults (…)` clause), NOT the executable
 * bodySql — the declarative differ recomputes the same form from a declared MV,
 * so a defaults-only or explicit-columns-only change is detected as drift.
 * `def.bodySql` is the full body render (it carries the inert trailing
 * `with defaults (…)` clause, which the read planner ignores — defaults are
 * realized only in the view write-through rewrite): it feeds execution
 * (collectBodyRows / deriveBackingShape / linkCoveredUniqueConstraints).
 */
function buildTableDerivation(def: MaterializeViewDefinition, shape: BackingShape): TableDerivation {
	return {
		selectAst: def.selectAst,
		columns: def.columns,
		logicalKey: shape.primaryKey,
		coarsenedKey: shape.coarsenedKey,
		bodyHash: computeBodyHash(viewDefinitionToCanonicalString(def.columns, def.selectAst)),
		ordering: shape.ordering,
		sourceTables: shape.sourceTables,
		stale: false,
	};
}

/**
 * Rejects a body that references the maintained table being created. The
 * unified model makes self-reference *lexically* possible mid-create (the
 * table registers under the MV's own name before the fill runs), so the
 * create/import paths reject it up front — a self-referential derivation can
 * never be maintained coherently.
 */
function assertNoSelfReference(def: MaterializeViewDefinition, shape: BackingShape): void {
	const self = `${def.schemaName}.${def.viewName}`.toLowerCase();
	if (shape.sourceTables.includes(self)) {
		throw new QuereusError(
			`materialized view '${def.schemaName}.${def.viewName}' body may not reference the view itself`,
			StatusCode.ERROR,
		);
	}
}

/**
 * The key-coarsening warning `docs/migration.md` § Convergence hazards
 * specifies — emitted (structured logger, `warn` channel) when an MV
 * materializes over a coarsened backing key, with `TableDerivation.coarsenedKey`
 * as the record-side complement. Warn, don't reject: the merge-on-coarsen
 * behavior is often exactly what the migration intends.
 */
function warnKeyCoarsening(schemaName: string, viewName: string, info: CoarsenedKeyInfo): void {
	const detail = info.weakened
		.map(w => `${w.column}: collation ${w.sourceCollation} → ${w.outputCollation}`)
		.join(', ');
	warnLog(
		`materialized view '%s.%s': backing key (%s) is coarser than the source primary key (%s); `
			+ `colliding source rows will last-write-win until they are merged`,
		schemaName, viewName, info.columns.join(', '), detail,
	);
}

/**
 * The materialize core shared by `emitCreateMaterializedView` and the
 * catalog-import path (`SchemaManager.importMaterializedView`): derive the
 * backing shape from the planned body → create the maintained table under the
 * MV's own name in the declared backing-host module (memory default) → fill it
 * from the body → attach the {@link TableDerivation} → compile + register
 * row-time write-through maintenance. Returns the registered maintained table.
 *
 * Fires `table_added` for the table (it is created like any table) but
 * deliberately does NOT fire `materialized_view_added` — the create emitter
 * notifies after this returns, while import stays silent (a store rehydrating
 * its own catalog must not re-emit persistence events).
 *
 * Rollback-on-throw: a fill failure (including the "must be a set"
 * duplicate-key gate) drops the half-built table; a registration failure (the
 * mandatory row-time eligibility gate runs there) drops the table — derivation
 * and all — either way the schema is left exactly as before the call.
 * Existence/collision checks are the caller's job (the create emitter checks
 * before calling; on import a duplicate surfaces as a table-name conflict).
 *
 * `preDerivedShape` short-circuits the shape derivation for a caller that
 * already planned the body (the import path derives it once for its gates).
 */
export async function materializeView(db: Database, def: MaterializeViewDefinition, preDerivedShape?: BackingShape): Promise<MaintainedTableSchema> {
	const sm = db.schemaManager;

	const shape = preDerivedShape ?? deriveBackingShape(db, def.schemaName, def.bodySql, def.columns,
		{ moduleName: def.backingModuleName, moduleArgs: def.backingModuleArgs });
	// Lives here — not in deriveBackingShape — because the refresh path reaches a
	// legitimate mismatch after a source ALTER (see the assert's docstring).
	assertDeclaredColumnArity(def, shape);
	// The table registers under the MV's own name BEFORE the fill runs, so a
	// self-referential body must be rejected up front (it would otherwise read
	// the empty table being populated).
	assertNoSelfReference(def, shape);
	const backingSchema = buildBackingTableSchema(db, def.schemaName, def.viewName, shape, def.backingModuleName, def.backingModuleArgs, def.tags);
	const completeBacking = await sm.createBackingTable(backingSchema);

	try {
		const rows: Row[] = await collectBodyRows(db, def.schemaName, def.bodySql);
		const host = resolveBackingHost(db, completeBacking);
		// `replaceContents` runs NO derived-row constraint validation: this caller's
		// backing is the MV-sugar shape (`buildBackingTableSchema` hard-codes empty
		// checkConstraints and carries no foreignKeys), so there is nothing to
		// validate. The constraint-bearing refresh path that DOES need validation
		// over a `replaceContents`-style whole-set swap runs it in `rebuildBacking`
		// (pending-layer `replace-all` + `validateDeclaredConstraintsOverContents`),
		// not here.
		await host.replaceContents(rows, () => materializedViewNotASetError(def.schemaName, def.viewName));
	} catch (e) {
		// Roll back: drop the table, do not attach a derivation.
		try {
			await sm.dropTable(def.schemaName, def.viewName, /*ifExists*/ true);
		} catch { /* best-effort cleanup */ }
		throw e;
	}

	const maintained = sm.attachDerivation(def.schemaName, def.viewName, buildTableDerivation(def, shape));
	// Eagerly record the constraint↔structure link if this MV covers a UNIQUE
	// constraint (informational — enforcement still routes through the
	// synchronously-maintained auto-index).
	linkCoveredUniqueConstraints(db, maintained, def.bodySql);

	// Compile + register row-time write-through maintenance. The mandatory
	// eligibility gate runs here (it needs the analyzed body) and throws on a
	// body that is not row-time maintainable — roll the whole MV back so an
	// ineligible body errors cleanly.
	try {
		// Same pre-flight the CREATE VIEW path runs, but it can only run HERE: the
		// persisted DDL text (`generateMaintainedTableDDL`) does not exist until the
		// derivation is attached. Placed inside this try so the existing catch — which
		// already unlinks and drops the half-built backing — rolls a rejection back with
		// no extra teardown. Harmless on the catalog-import path (an entry read back from
		// the catalog re-generates persistable DDL by construction).
		assertCatalogObjectPersistable(db, 'materializedView', maintained);
		db.registerMaterializedView(maintained);
	} catch (e) {
		unlinkCoveredUniqueConstraints(db, maintained);
		try {
			await sm.dropTable(def.schemaName, def.viewName, /*ifExists*/ true);
		} catch { /* best-effort cleanup */ }
		throw e;
	}

	// After the MV fully materialized (a fill/registration failure must error, not
	// warn): surface the key-coarsening hazard the coarsened backing key carries.
	if (maintained.derivation.coarsenedKey) {
		warnKeyCoarsening(def.schemaName, def.viewName, maintained.derivation.coarsenedKey);
	}

	return maintained;
}

/**
 * The adopt-without-refill counterpart of {@link materializeView}: the
 * registration tail without create+fill, for the catalog-import path
 * (`SchemaManager.importMaterializedView`) when a pre-existing durable backing
 * passed every adopt gate (same module, shape match, all sources same-module
 * with upstream maintained tables themselves adopted, caller-attested
 * `trustBackings`). The table's rows are trusted as-is — no body execution.
 *
 * **Backing schema re-stamp.** `preExisting` is a phase-1 DDL round-trip and
 * loses ScalarType fidelity the refill path would carry (the registry-interned
 * logical types survive only by name in DDL). Re-registering the body-derived
 * {@link buildBackingTableSchema} result — shape-verified identical by the
 * caller's `backingShapeMatches` gate — makes post-adopt state equivalent to
 * post-refill state for the row-time plan `registerMaterializedView` binds.
 * Module identity/args come from `def` exactly as the refill path's
 * `buildBackingTableSchema` call does (gate 1 verified the registered module
 * matches); `estimatedRows` carries over from the registered schema (the rows
 * are preserved, so the prior estimate stays truthful). The module-side LIVE
 * table instance still caches the phase-1 schema — the importing host
 * reconciles it after import (the store module's `rehydrateCatalog` runs
 * `StoreTable.updateSchema` over every connected table); reads are unaffected
 * either way since the shapes are identical.
 *
 * Rollback on a registration failure (the mandatory row-time eligibility gate
 * runs there): unlink + detach the derivation + rethrow — the table stays
 * REGISTERED, reverting to its plain (derivation-less) state. Dropping a
 * durable backing on a registration error would destroy the very rows a later
 * retry could adopt; the caller records the throw as a per-entry rehydration
 * error.
 */
export async function adoptMaterializedView(
	db: Database,
	def: MaterializeViewDefinition,
	preExisting: TableSchema,
	shape: BackingShape,
): Promise<MaintainedTableSchema> {
	const sm = db.schemaManager;
	const schema = sm.getSchemaOrFail(def.schemaName);

	assertNoSelfReference(def, shape);
	const stamped = buildBackingTableSchema(db, def.schemaName, def.viewName, shape, def.backingModuleName, def.backingModuleArgs, def.tags);
	schema.addTable({ ...stamped, estimatedRows: preExisting.estimatedRows ?? 0 });

	const maintained = sm.attachDerivation(def.schemaName, def.viewName, buildTableDerivation(def, shape));
	linkCoveredUniqueConstraints(db, maintained, def.bodySql);

	try {
		db.registerMaterializedView(maintained);
	} catch (e) {
		unlinkCoveredUniqueConstraints(db, maintained);
		// Detach the derivation: the table reverts to a plain table (re-stamped
		// schema is shape-identical to its phase-1 state) — deliberately NOT dropped.
		const { derivation: _derivation, ...plain } = maintained;
		schema.addTable(plain);
		throw e;
	}

	return maintained;
}

/* ──────────────── attach / detach lifecycle verbs ────────────────
 * The maintained-table lifecycle verbs: `create table … maintained as <body>`
 * (attach-to-empty), `alter table … set maintained as <body>` (attach /
 * re-attach with verify-by-diff reconcile), and `alter table … drop maintained`
 * (detach). The attach core never trusts existing rows blindly and never refills
 * wholesale: it re-derives the body and reconciles by keyed diff (the
 * 'replace-all' MaintenanceOp), so identical derivable content means ZERO row
 * writes and zero reported changes, while divergence resolves derived-wins with
 * only the genuine per-row changes reported (and cascaded to consumer maintained
 * tables). Blind trust remains the rehydrate fast path's domain, where
 * clean-shutdown attestation gates it (`SchemaManager.tryAdoptPreExistingBacking`). */

/**
 * Names the first difference between a table's declared/live shape and the
 * derived body `shape` — the attach-time strict shape check (null when the body
 * derives exactly the declared shape). Unlike {@link describeBackingShapeMismatch}
 * (the structural, name-blind refresh check) this one is part of the
 * declared-shape contract and therefore compares column NAMES too: the declared
 * layout is the frozen basis, so the body must be aliased to produce it
 * verbatim — names, types, not-null, collations, and the physical primary key
 * (order, direction, per-component collation). Not-null is exact in BOTH
 * directions: tolerating a body-notNull/declared-nullable skew would make the
 * next refresh's reshape pass "tighten" the declared column, silently mutating
 * the frozen basis.
 *
 * `skipNames` drops the per-column NAME comparison for the `create table …
 * maintained (columns) as` form: there the authored rename list is the
 * authoritative output-name vector (body outputs are renamed positionally to it),
 * so a body whose natural names differ from the declared columns is accepted as a
 * positional rename. Everything else — column count, types, not-null (both ways),
 * collations, and the physical primary key — stays strict.
 */
function describeAttachShapeMismatch(table: TableSchema, shape: BackingShape, skipNames = false): string | null {
	if (table.columns.length !== shape.columns.length) {
		return `body produces ${shape.columns.length} columns but the table declares ${table.columns.length}`;
	}
	for (let i = 0; i < shape.columns.length; i++) {
		const declared = table.columns[i];
		const derived = shape.columns[i];
		if (!skipNames && declared.name.toLowerCase() !== derived.name.toLowerCase()) {
			return `body output column ${i + 1} is named '${derived.name}' but the table declares '${declared.name}' (alias the body output to match the declared shape)`;
		}
		if (!backingTypeMatches(declared, derived)) {
			return `column '${declared.name}': body derives type ${derived.logicalType.name} but the table declares ${declared.logicalType.name}`;
		}
		if (!backingNotNullMatches(declared, derived)) {
			return `column '${declared.name}': body derives ${derived.notNull ? 'not null' : 'nullable'} but the table declares ${declared.notNull ? 'not null' : 'nullable'}`;
		}
		if (!backingCollationMatches(declared, derived)) {
			return `column '${declared.name}': body derives collation ${derived.collation ?? 'BINARY'} but the table declares ${declared.collation ?? 'BINARY'}`;
		}
	}
	const derivedPk = computeBackingPrimaryKey(shape);
	const declaredPk = table.primaryKeyDefinition;
	if (declaredPk.length !== derivedPk.length) {
		return `body derives a ${derivedPk.length}-column primary key but the table declares ${declaredPk.length} (a body \`order by\` seeds the derived key — see computeBackingPrimaryKey)`;
	}
	for (let k = 0; k < derivedPk.length; k++) {
		const declaredCol = table.columns[declaredPk[k].index];
		const derivedCol = shape.columns[derivedPk[k].index];
		if (declaredPk[k].index !== derivedPk[k].index) {
			return `primary-key component ${k + 1}: body derives '${derivedCol?.name}' but the table declares '${declaredCol?.name}'`;
		}
		if ((declaredPk[k].desc === true) !== (derivedPk[k].desc === true)) {
			return `primary-key component ${k + 1} ('${declaredCol?.name}'): direction differs`;
		}
		const declaredColl = declaredPk[k].collation ?? declaredCol?.collation ?? 'BINARY';
		const derivedColl = derivedCol?.collation ?? 'BINARY';
		if (declaredColl !== derivedColl) {
			return `primary-key component ${k + 1} ('${declaredCol?.name}'): body derives collation ${derivedColl} but the table declares ${declaredColl}`;
		}
	}
	return null;
}

/**
 * Rejects an attach whose body would close a derivation cycle. Create-MV can
 * never form one (a consumer is created after its producer), but attach can:
 * `alter table A set maintained as select … from B` where B's derivation
 * (transitively) reads A — including the degenerate self-reference (`… from A`).
 * Walks the sourceTables→derivation edges of the LIVE catalog from the new
 * body's sources; reaching the attach target names the cycle path in the
 * diagnostic. The maintenance cascade's depth guard
 * (`assertCascadeDepth`) stays as defense-in-depth behind this.
 */
function assertNoDerivationCycle(db: Database, schemaName: string, tableName: string, sourceTables: readonly string[]): void {
	const target = `${schemaName}.${tableName}`.toLowerCase();
	const sm = db.schemaManager;
	const visited = new Set<string>();
	const walk = (qualified: string, path: readonly string[]): void => {
		if (qualified === target) {
			// Render in data-flow order, closing the loop on the target. `path` is the
			// derived-from chain outward from the new body (path[0] = a body source,
			// path[last] = the table derived from the target), so data flows
			// target → path[last] → … → path[0] → target.
			const cycle = [target, ...[...path].reverse(), target].join(' → ');
			throw new QuereusError(
				`cannot attach derivation to '${schemaName}.${tableName}': the body would create a derivation cycle (${cycle})`,
				StatusCode.ERROR,
			);
		}
		if (visited.has(qualified)) return;
		visited.add(qualified);
		const dot = qualified.indexOf('.');
		const srcSchema = dot >= 0 ? qualified.slice(0, dot) : 'main';
		const srcName = dot >= 0 ? qualified.slice(dot + 1) : qualified;
		const source = sm.getTable(srcSchema, srcName);
		if (source && isMaintainedTable(source)) {
			for (const next of source.derivation.sourceTables) walk(next, [...path, qualified]);
		}
	};
	for (const src of sourceTables) walk(src, []);
}

/**
 * The loud "must be a set" reject for attach, BEFORE any catalog or data
 * mutation: the keyed reconcile diff would otherwise last-write-win duplicate
 * derived keys silently. Collation-aware pairing — duplicates are detected
 * under the backing primary-key collations (the same key identity the
 * 'replace-all' diff uses), so a coarsened-key collision present in the source
 * rejects here, naming the colliding key. `pk` is the SHAPE-derived physical
 * key ({@link computeBackingPrimaryKey} over the derived shape): the rows are
 * indexed by the shape, and under a reshape-on-attach the table's own PK
 * definition may carry pre-reshape column indices. Equivalent to the table's
 * PK whenever the shapes match (the strict attach check verifies index, desc,
 * and collation equality).
 *
 * `onDuplicate` overrides the default attach-time diagnostic with a caller-built
 * one (receiving the rendered colliding key values) — the refresh path threads
 * {@link materializedViewNotASetError} through {@link assertRefreshRowsAreSet} so
 * its constraint-bearing branch rejects duplicates identically to the
 * `replaceContents` fast path, single-sourcing the collation-aware dup detection.
 *
 * The declared key collation names resolve against the OWNING database
 * (`db.getCollationResolver()`), so a database-replaced `NOCASE` — or a custom
 * collation registered only on this connection — decides key identity here exactly
 * as it does in the backing host's own keying. Resolution happens once, above the
 * sort, and throws `no such collation sequence` on an unregistered name.
 */
function assertDerivedRowsAreSet(
	rows: readonly Row[],
	pk: ReadonlyArray<{ index: number; collation?: string }>,
	collationResolver: CollationResolver,
	schemaName: string,
	name: string,
	onDuplicate?: (keyVals: string) => QuereusError,
): void {
	if (rows.length < 2) return;
	const keyCollations = resolveCollationFunctions(collationResolver, pk.map(c => c.collation));
	const compareKeys = (ra: Row, rb: Row): number => {
		for (let i = 0; i < pk.length; i++) {
			const idx = pk[i].index;
			const cmp = compareSqlValuesFast(ra[idx], rb[idx], keyCollations[i]);
			if (cmp !== 0) return cmp;
		}
		return 0;
	};
	const order = rows.map((_r, i) => i).sort((a, b) => compareKeys(rows[a], rows[b]));
	for (let i = 1; i < order.length; i++) {
		if (compareKeys(rows[order[i - 1]], rows[order[i]]) === 0) {
			const keyVals = pk.map(c => formatKeyValue(rows[order[i]][c.index])).join(', ');
			throw onDuplicate?.(keyVals) ?? new QuereusError(
				`cannot attach derivation to '${schemaName}.${name}': the body produces duplicate rows for primary key (${keyVals}), but a maintained table must be a set — `
					+ `project a unique key or merge the colliding source rows first`,
				StatusCode.CONSTRAINT,
			);
		}
	}
}

/**
 * Refresh's duplicate-derived-key reject — the constraint-bearing
 * {@link rebuildBacking} branch's parity with the `replaceContents` fast path,
 * which rejects duplicate backing PKs via {@link materializedViewNotASetError}.
 * `applyMaintenance('replace-all')` would otherwise silently LWW-merge colliding
 * keys, so this raises the IDENTICAL diagnostic BEFORE the pending-layer reconcile,
 * keeping the two refresh branches indistinguishable on duplicate handling.
 * Delegates to {@link assertDerivedRowsAreSet} so the collation-aware detection
 * stays single-sourced.
 */
function assertRefreshRowsAreSet(
	rows: readonly Row[],
	pk: ReadonlyArray<{ index: number; collation?: string }>,
	collationResolver: CollationResolver,
	schemaName: string,
	name: string,
): void {
	assertDerivedRowsAreSet(rows, pk, collationResolver, schemaName, name, () => materializedViewNotASetError(schemaName, name));
}

/**
 * Refresh guard: reject a rebuild that would store a NULL into a backing column the
 * schema declares NOT NULL *and* that is a physical-PK member — the precise reachable
 * contradiction (a NOT-NULL column pinned into the PK by an `order by` seed whose source
 * loosened to nullable). Throws {@link nullInNotNullSeededPkError} naming the first
 * offending column. A non-PK NOT-NULL column is not at risk: refresh loosens it in the
 * backing when its source loosens (it is not physical-PK-pinned), so by the time this
 * runs a legitimately-loosened non-PK column already reads nullable. A physical-PK column
 * declared *nullable* (the permitted create-time nullable-source-ordering case) is not
 * guarded — it self-consistently stores NULL. Early-returns only when no backing column
 * is both NOT NULL and physical-PK; that set is otherwise non-empty for nearly every MV
 * (the logical-key PK column is normally the NOT-NULL source PK), so the common case
 * scans every row over the guarded set. Cheap here — the rows are already materialized on
 * the full-rebuild path — but this same shape is NOT cheap on the row-time hot path, which
 * needs a precomputed nullable-source skew flag instead (see
 * `fix/bug-mv-rowtime-null-into-notnull-seeded-pk`).
 */
function assertNoNullInNotNullSeededPk(
	backing: TableSchema,
	rows: readonly Row[],
	schemaName: string,
	name: string,
): void {
	const pkIndices = new Set(backing.primaryKeyDefinition.map(d => d.index));
	const guarded = backing.columns
		.map((col, index) => ({ col, index }))
		.filter(({ col, index }) => col.notNull === true && pkIndices.has(index));
	if (guarded.length === 0) return;
	for (const row of rows) {
		for (const { col, index } of guarded) {
			if (row[index] === null || row[index] === undefined) {
				throw nullInNotNullSeededPkError(schemaName, name, col.name);
			}
		}
	}
}

/**
 * Resolve (or lazily create + register) the table's backing connection for the
 * current transaction — the same discipline as the maintenance manager's
 * `getBackingConnection`, so the reconcile's pending writes ride the
 * coordinated commit in lockstep with the statement, and a `select` from the
 * table inside the same transaction observes them (reads-own-writes).
 */
async function resolveAttachConnection(db: Database, host: BackingHost, qualifiedName: string): Promise<VirtualTableConnection> {
	for (const c of db.getConnectionsForTable(qualifiedName)) {
		if (host.ownsConnection(c)) return c;
	}
	const conn = host.connect();
	await db.registerConnection(conn);
	return conn;
}

/**
 * Whether `mt` declares ≥1 constraint the {@link rebuildBacking} refresh path must
 * validate over the recomputed row set — the same predicate
 * {@link validateDeclaredConstraintsOverContents} gates on: any CHECK whose op-mask
 * intersects INSERT | UPDATE (the derived-row op-mask collapse — a derived row's
 * presence is neither a user INSERT nor UPDATE), or any child-side FK.
 *
 * The FK term is additionally gated on `pragma foreign_keys`: with enforcement off
 * the bulk FK scan no-ops, so an FK-only maintained table keeps the zero-overhead
 * `replaceContents` fast path rather than spinning up a connection for a no-op scan.
 * A table also declaring an applicable CHECK always takes the validating branch
 * regardless of the pragma.
 */
function hasApplicableConstraints(db: Database, mt: TableSchema): boolean {
	const hasCheck = mt.checkConstraints.some(
		c => (c.operations & (RowOpFlag.INSERT | RowOpFlag.UPDATE)) !== 0);
	if (hasCheck) return true;
	const fks = mt.foreignKeys ?? [];
	return fks.length > 0 && db.options.getBooleanOption('foreign_keys');
}

/**
 * Bulk derived-row constraint validation for the attach paths (create-fill and
 * attach/re-attach reconcile): after the `'replace-all'` reconcile lands the
 * derived row set in the connection's pending layer, scan the table's EFFECTIVE
 * (pending-over-committed) contents against every declared CHECK whose op-mask
 * intersects INSERT | UPDATE (the derived-row op-mask collapse — a derived row's
 * presence is neither a user INSERT nor UPDATE, see docs/mv-constraints.md)
 * and every declared child-side FK (pragma-gated inside the FK validator,
 * MATCH SIMPLE). Post-reconcile contents are exactly the derived set, so this
 * validates every row the table will hold — which is also why detach can never
 * strand a violator. Zero overhead when nothing is declared (every MV-sugar
 * backing: `buildBackingTableSchema` hard-codes empty constraints).
 *
 * The scan is a plain table read of the backing (a maintained table resolves
 * through the ORDINARY table path in `building/select.ts` — never a
 * re-derivation), observing the pending reconcile writes through the registered
 * attach connection (reads-own-writes). An `old.`/`new.`-qualified CHECK —
 * which this SQL scan could not resolve — was already rejected at registration
 * (`buildDerivedRowValidator`), which runs before this validation on every
 * create/attach path.
 *
 * Declared-constraint folding: the optimizer trusts a declared CHECK / FK as a
 * proven invariant (`ruleFilterContradiction` / `ruleAntiJoinFkEmpty`), and —
 * unlike the ALTER ADD paths — the constraints under validation are already on
 * the LIVE record here. So the live record is swapped for a constraint-stripped
 * clone for the duration of the scans (the ADD COLUMN intermediate-schema
 * discipline, see `runtime/emit/alter-table.ts`), then restored.
 *
 * `validationColumns` (the reshape arms only, {@link previewReshapedColumns})
 * overrides the clone's column list with the attributes the reshape is ABOUT TO
 * land, so a CHECK / FK resolves its affinity and collation from the final
 * declared shape rather than the one being replaced. Comparison semantics are a
 * function of the DECLARED column attributes, and the reshape's `retype` /
 * `recollate` module ops run after this scan (they convert stored rows, so they
 * must); without the override this scan would evaluate `v < '9'` on a column
 * moving TEXT → INTEGER as a text comparison and admit a row that violates the
 * constraint under the type it is about to have. Omitted (⇒ `mt.columns`) on
 * every non-reshape path, so those stay byte-identical.
 */
async function validateDeclaredConstraintsOverContents(
	db: Database,
	mt: MaintainedTableSchema,
	validationColumns?: readonly ColumnSchema[],
): Promise<void> {
	const applicableChecks = mt.checkConstraints.filter(
		c => (c.operations & (RowOpFlag.INSERT | RowOpFlag.UPDATE)) !== 0);
	const fks = mt.foreignKeys ?? [];
	if (applicableChecks.length === 0 && fks.length === 0) return;

	const schema = db.schemaManager.getSchemaOrFail(mt.schemaName);
	const stripped: MaintainedTableSchema = {
		...mt,
		columns: validationColumns ?? mt.columns,
		checkConstraints: Object.freeze([]),
		foreignKeys: undefined,
	};
	schema.addTable(stripped);
	try {
		await validateChecksOverExistingRows(db, mt, applicableChecks, (check, exprSql) =>
			maintainedTableCheckViolationError(
				mt.schemaName, mt.name,
				check.name ?? `_check_${mt.checkConstraints.indexOf(check)}`,
				exprSql,
			));
		for (const fk of fks) {
			await validateForeignKeyOverExistingRows(db, mt, fk, () =>
				maintainedTableFkViolationError(
					mt.schemaName, mt.name,
					fk.name ?? `_fk_${mt.name}`,
					fk.referencedSchema ?? mt.schemaName, fk.referencedTable,
				));
		}
	} finally {
		schema.addTable(mt);
	}
}

/**
 * The attach core shared by `alter table … set maintained as` (fresh attach and
 * re-attach) and `create table … maintained as` (attach-to-empty, via
 * {@link createMaintainedTable}): verify-by-diff, never trust, never refill
 * wholesale.
 *
 * Sequence — every gate runs BEFORE any catalog or data mutation:
 *  1. backing-host capability (defense-in-depth; the builders gate with a sited
 *     error);
 *  2. derive the body's shape (rewrite-suppressed) and run the STRICT
 *     declared-shape check ({@link describeAttachShapeMismatch} — names
 *     included);
 *  3. cycle / self-reference check over the live derivation graph;
 *  4. evaluate the body once and reject duplicate derived keys (the loud
 *     "must be a set" reject);
 *  5. catalog flip (`attachDerivation`) + maintenance registration — the
 *     create-time gates (determinism, keyed-or-coarsened body, full-rebuild
 *     size threshold) run inside `registerMaterializedView`, before any row is
 *     written; a throw restores the prior record (and the prior plan, on
 *     re-attach);
 *  6. reconcile-by-diff: one `'replace-all'` op against the table's effective
 *     contents through the backing host — collation-aware pairing,
 *     byte-faithful identical-row skip, so identical content writes nothing and
 *     divergence resolves derived-wins with the minimal genuine
 *     {@link BackingRowChange}s. The writes land in the connection's PENDING
 *     state, committing/rolling back in lockstep with the statement;
 *  7. covering links (clear the prior body's, stamp the new body's), cascade
 *     the genuine changes to consumer maintained tables, fire
 *     `materialized_view_added` (fresh) / `materialized_view_modified`
 *     (re-attach) so store catalogs re-persist the canonical table-form DDL,
 *     and surface the key-coarsening warning exactly as create does.
 *
 * `recordedColumns` is recorded verbatim as `derivation.columns` (the lossless
 * implicit/explicit signal the persist + import paths already use): the authored
 * column names for the explicit forms — `create table … maintained (columns) as`
 * AND the re-attach verb `set maintained (columns) as` — or `undefined` for the
 * implicit forms — `create table … maintained as` (which reshapes its source on
 * reopen) AND the implicit re-attach verb `set maintained as` (which reshapes to
 * follow the body's natural names). When `positionalRename` is set — every
 * explicit form — the body outputs are renamed positionally to `recordedColumns`
 * and the per-column name check is skipped (the authored list is the authoritative
 * output-name vector); otherwise the strict declared-shape check (names included)
 * applies. `buildTableDerivation` hashes `recordedColumns` into `bodyHash`, so
 * live exec and catalog import of the same canonical DDL agree on both the record
 * and the hash — making attach/create → persist → reopen a fixed point.
 *
 * An explicit list whose arity disagrees with the body raises a sited error (the
 * list-vs-body arity guard) before anything is recorded — `deriveBackingShape`
 * sizes the shape to the body, so a surplus/short list would otherwise persist a
 * miscounted `derivation.columns`.
 *
 * **Reshape-on-attach (`allowReshape`).** The verb path (`set maintained [(cols)]
 * as` — manual AND differ-emitted) passes `allowReshape = true`; create and any
 * non-verb caller pass `false` and keep the strict declared-shape error. Two
 * reshape triggers, both reusing the two-phase splice + restore handlers below:
 *
 *  - **Implicit call** (no rename list): on a strict-shape mismatch the backing
 *    reshapes in place to follow the body's natural names — the same "the body
 *    owns an implicit table's shape" contract the refresh reshape and the implicit
 *    table form's reopen honor. Now permitted over a prior-EXPLICIT record too:
 *    `set maintained as <body>` over an `(a, b)` table abandons the authored list
 *    and relabels the backing to the body's names, recording an implicit
 *    derivation (the deliberate "go implicit" re-attach).
 *  - **Explicit call** (`positionalRename`): a same-arity output-NAME drift
 *    `(a, b) → (a, c)` produces no strict mismatch (names are skipped), yet the
 *    backing must be relabeled to the recorded names — classified as a reshape.
 *    The derived shape carries the TARGET names, so {@link classifyBackingReshape}
 *    emits a pure positional RENAME (`b → c`); a renamed PK output column is
 *    matched through the rename map (not a key change). A count/type/PK delta is
 *    still the strict error, and a reorder/swap (`(a, b) → (b, a)`) classifies as
 *    inexpressible.
 *
 * An inexpressible delta (interleave / physical-PK change, or a host module
 * without `alterTable`) raises {@link inexpressibleReshapeError} with the table
 * untouched. An expressible plan splices around the verify-by-diff reconcile —
 * see the sequencing notes inside.
 */
// NOTE: this core does NOT re-assert {@link assertNoMutationContextOnMaintainedTable};
// both of today's callers (createMaintainedTable, runSetMaintained) check before
// calling. A third caller must run that guard too, or add it here.
export async function attachMaintainedDerivation(
	db: Database,
	table: TableSchema,
	select: AST.QueryExpr,
	recordedColumns: ReadonlyArray<string> | undefined,
	positionalRename = false,
	allowReshape = false,
	/**
	 * When true, a FAILED FRESH attach discards (via {@link VirtualTableModule.discardBackingForAttach})
	 * any backing store {@link VirtualTableModule.ensureBackingForAttach} created IN
	 * THIS attach. Set by the `set maintained` ATTACH verb ({@link runSetMaintained}),
	 * which owns its own backing cleanup. NOT set by `create table … maintained`
	 * ({@link createMaintainedTable}) — there the store was created by the prior
	 * `createTable(preferBacking)`, and the create path's own `dropTable` cleanup
	 * retires it; a discard here would double-drop and strand the catalog entry.
	 */
	discardBackingOnFailure = false,
): Promise<MaintainedTableSchema> {
	const sm = db.schemaManager;
	const schemaName = table.schemaName;
	const name = table.name;
	const schema = sm.getSchemaOrFail(schemaName);

	const module = requireVtabModule(table);
	if (!module.getBackingHost) {
		throw new QuereusError(
			`cannot attach derivation to '${schemaName}.${name}': module '${table.vtabModuleName}' cannot host a maintained table (it does not implement the backing-host capability)`,
			StatusCode.UNSUPPORTED,
		);
	}

	const bodySql = astToString(select);
	// With an authored rename list (`maintained (columns)` create form) the body is
	// renamed positionally to it and the name check skipped; otherwise natural output
	// names with the strict declared-shape check (the body must already be aliased to
	// the declared names — the attach verb / implicit-create posture).
	const shape = deriveBackingShape(db, schemaName, bodySql, positionalRename ? recordedColumns : undefined,
		{ moduleName: table.vtabModuleName, moduleArgs: table.vtabArgs, against: table });

	// Explicit rename-list arity guard. `deriveBackingShape` sizes the shape to the
	// BODY's arity (a surplus rename name is dropped, a missing one padded), so a
	// list whose length disagrees with the body would otherwise record an
	// over/under-counted `derivation.columns` over the backing. The CREATE path
	// catches this via its table-vs-body count check before reaching here (the
	// freshly-created table mirrors the list); on re-attach the existing table can
	// match the body while the list does not, so guard the list-vs-body arity
	// directly. The implicit form (`recordedColumns === undefined`) is exempt.
	if (recordedColumns !== undefined && recordedColumns.length !== shape.columns.length) {
		throw new QuereusError(
			`cannot attach derivation to '${schemaName}.${name}': the rename list declares ${recordedColumns.length} columns but the body produces ${shape.columns.length}`,
			StatusCode.ERROR,
		);
	}

	const mismatch = describeAttachShapeMismatch(table, shape, positionalRename);
	// Reshape-on-attach (see the docstring). The verb (`allowReshape`) reshapes the
	// backing in place instead of erroring on a shape change; create and any
	// non-verb caller keep the strict error. Two reshape triggers:
	//   - IMPLICIT call (no rename list): a strict mismatch follows the body's
	//     natural names — now also over a prior-explicit record (the deliberate
	//     "go implicit" re-attach); the explicit forms keep the strict count/type/PK
	//     error instead.
	//   - EXPLICIT call (`positionalRename`): a same-arity NAME drift `(a,b)→(a,c)`
	//     produces NO mismatch under `skipNames`, yet the backing must be relabeled
	//     to the recorded names — classify that as a reshape too. The shape carries
	//     the TARGET names, so `classifyBackingReshape` emits a pure positional
	//     RENAME; a reorder/swap classifies inexpressible (table untouched) and a
	//     renamed PK column is matched through the rename map (not a key change).
	const strictMismatchReshape = mismatch !== null && allowReshape && !positionalRename && recordedColumns === undefined;
	const explicitNameDriftReshape = mismatch === null && positionalRename && allowReshape
		&& table.columns.some((c, i) => c.name.toLowerCase() !== shape.columns[i].name.toLowerCase());
	let reshapePlan: ReshapePlan | undefined;
	if (mismatch && !strictMismatchReshape) {
		throw new QuereusError(
			`cannot attach derivation to '${schemaName}.${name}': ${mismatch}`,
			StatusCode.ERROR,
		);
	}
	if (strictMismatchReshape || explicitNameDriftReshape) {
		if (!module.alterTable) {
			throw inexpressibleReshapeError(schemaName, name,
				`its backing module '${table.vtabModuleName}' does not support in-place ALTER`);
		}
		const classification = classifyBackingReshape(table, shape);
		if (!classification.expressible) {
			throw inexpressibleReshapeError(schemaName, name, classification.reason);
		}
		reshapePlan = classification.plan;
	}
	assertNoDerivationCycle(db, schemaName, name, shape.sourceTables);

	const rows: Row[] = await collectBodyRows(db, schemaName, bodySql);
	// Shape-derived physical key (see assertDerivedRowsAreSet): under a reshape the
	// table's own PK definition may carry pre-reshape indices; equivalent otherwise.
	const shapePk = computeBackingPrimaryKey(shape)
		.map(c => ({ index: c.index, collation: shape.columns[c.index]?.collation }));
	assertDerivedRowsAreSet(rows, shapePk, db.getCollationResolver(), schemaName, name);

	const def: MaterializeViewDefinition = {
		schemaName,
		viewName: name,
		selectAst: select,
		bodySql,
		// Recorded as authored: declared names for the explicit forms, undefined for
		// the implicit create form — the lossless signal persist + import already use.
		// Any `with defaults (…)` rides inside `select` (→ derivation.selectAst).
		columns: recordedColumns,
	};

	const prior = schema.getTable(name) ?? table;
	const priorMaintained = isMaintainedTable(prior) ? prior : undefined;

	// Undo the catalog flip after a gate/reconcile failure: restore the prior
	// record and, on re-attach, the prior row-time plan (registerMaterializedView
	// released it when registering the new one).
	const restorePrior = (): void => {
		schema.addTable(prior);
		if (priorMaintained) {
			if (!priorMaintained.derivation.stale) {
				try {
					db.registerMaterializedView(priorMaintained);
				} catch (e) {
					// The prior plan registered before, so this should not throw; if it
					// does, fail safe: stale (reads re-validate) beats silently live.
					db.markMaterializedViewStale(priorMaintained);
					log('Re-registering the prior derivation of %s.%s failed during attach rollback; marked stale: %s',
						schemaName, name, e instanceof Error ? e.message : String(e));
				}
			}
		} else {
			db.unregisterMaterializedView(schemaName, name);
		}
	};

	// Defensive-guard input: capture whether the gate-time backing host is absent
	// BEFORE the gate registration below. Resolved against `table` — the pre-reshape
	// catalog record the gate registration also resolves against
	// (`tryResolveBackingHost` keys only on schema+name, never the shape). A module
	// that materializes its host LATE (`getBackingHost` undefined until
	// `ensureBackingForAttach`) reads absent here, so the replicable-determinism gate
	// inside `registerMaterializedView` was skipped; the guard after the late seam
	// re-checks once the now-present host is in hand. See the eager-resolution
	// invariant on `BackingHost.requiresReplicableDerivations`.
	const gateHostAbsent = tryResolveBackingHost(db, table) === undefined;

	const maintained = sm.attachDerivation(schemaName, name, buildTableDerivation(def, shape));
	try {
		// The create-time gates (determinism, keyed-or-coarsened body, relational
		// output, full-rebuild size threshold) run here — identical to create.
		// Under a reshape this registration is a GATE only: the catalog still
		// holds the pre-reshape columns, so the plan it builds may classify into
		// the full-rebuild floor where the final record fits a bounded-delta arm;
		// the post-reshape re-registration below rebuilds the binding plan, and
		// nothing exercises the interim plan inside this DDL statement.
		db.registerMaterializedView(maintained);
	} catch (e) {
		restorePrior();
		throw e;
	}

	// Failure restore once the module's live schema has (partially) reshaped:
	// module column ops are NOT transactional, so restoring the PRIOR record would
	// strand a catalog/module divergence. Keep the catalog tracking the module
	// instead — fresh attach: the table reverts to a plain (derivation-less) table
	// at the reshaped schema; re-attach: the prior derivation rides the reshaped
	// backing marked STALE (its body no longer derives this shape — a later
	// refresh reshapes it back). Coherent and re-runnable either way.
	const restoreReshaped = (moduleSchema: TableSchema): void => {
		if (priorMaintained) {
			const restored = graftReshapedRecord(moduleSchema, priorMaintained);
			schema.addTable(restored);
			db.markMaterializedViewStale(restored);
		} else {
			const { derivation: _derivation, ...plain } = moduleSchema as Partial<MaintainedTableSchema> & TableSchema;
			schema.addTable(plain);
			db.unregisterMaterializedView(schemaName, name);
		}
	};

	let live: MaintainedTableSchema = maintained;
	let changes: BackingRowChange[];
	let current: TableSchema = table;
	let moduleMutated = false;
	let reconcileCommitted = false;
	try {
		if (reshapePlan) {
			// Pre-reconcile structural ops (rename/add/loosen/drop — none throw on
			// data), then re-register the reshaped schema with the new derivation so
			// the reconcile resolves the reshaped backing. Mirrors
			// reshapeBackingInPlace's pre batch; ops address columns by name.
			for (const op of reshapePlan.preReconcileOps) {
				current = await module.alterTable!(db, schemaName, name, reshapeOpToChange(op));
				moduleMutated = true;
			}
			live = graftReshapedRecord(current, maintained);
			schema.addTable(live);
		}

		// Materialize the durable backing store the reconcile will write into,
		// BEFORE resolving the host. A module whose `getBackingHost` resolves over a
		// SEPARATE durable store (e.g. lamina) needs the store created here — the
		// attach core only RESOLVES the host, never creates it, and on the
		// non-reshape path there is no other async module call beforehand. Placed
		// AFTER the reshape `preReconcileOps` + `schema.addTable(live)` so `live`
		// carries the reshaped shape and the store is sized to it. A no-op for
		// modules that omit the hook (memory hosts the live table directly).
		await module.ensureBackingForAttach?.(db, schemaName, name, live);

		// Verify-by-diff reconcile against the (possibly reshaped) backing: the
		// re-resolved host keys the 'replace-all' diff by the module's CURRENT
		// physical PK, so a reshape that shifted PK column indices stays aligned.
		const host = resolveBackingHost(db, live);

		// Defensive guard (defense-in-depth — see `tryResolveBackingHost` and the
		// eager-resolution invariant on `BackingHost.requiresReplicableDerivations`).
		// The gate-time host was absent, so the replicable-determinism gate inside
		// `registerMaterializedView` could not run — yet the now-resolved host DEMANDS
		// replicable derivations. A demanding host MUST resolve eagerly (at plan-build
		// time, before this late-backing seam); reaching here means it violated that
		// contract and a non-replicable body would have slipped the gate. Fail loud
		// rather than corrupt peers. The throw is inside this try, so the catch runs
		// `restorePrior()` / `discardBackingForAttach` cleanup and the statement rolls
		// back — the table reverts to ordinary, untouched. INTERNAL because reaching it
		// is a host-author contract violation, not user error. Single-sited after the
		// sole `resolveBackingHost(db, live)`, so it covers the reshape arm too.
		if (gateHostAbsent && host.requiresReplicableDerivations) {
			throw new QuereusError(
				`cannot attach derivation to '${schemaName}.${name}': its backing host requires `
					+ `replicable derivations but did not resolve until after the durable backing was `
					+ `materialized, so the replicable-determinism gate could not run. A host that sets `
					+ `requiresReplicableDerivations must resolve via getBackingHost at plan-build time `
					+ `(before ensureBackingForAttach).`,
				StatusCode.INTERNAL,
			);
		}

		const conn = await resolveAttachConnection(db, host, `${schemaName}.${name}`);
		changes = await host.applyMaintenance(conn, [{ kind: 'replace-all', rows }]);
		// Declared CHECK / child-side FK over the reconciled (derived) row set —
		// inside this try so a violation restores the prior record; the pending
		// reconcile writes roll back with the failing statement. On the reshape arm
		// the scan resolves against the attributes the post-reconcile ops below are
		// about to land, keeping this path identical to the refresh reshape arm
		// (`reshapeBackingInPlace` → `rebuildBacking`).
		await validateDeclaredConstraintsOverContents(db, live,
			reshapePlan ? previewReshapedColumns(live, shape) : undefined);

		if (reshapePlan && reshapePlan.postReconcileOps.length > 0) {
			// Data-validating attribute ops (retype / recollate / tighten NOT NULL)
			// must validate the RECONCILED body rows, not the stale backing — but the
			// module's alterTable scans COMMITTED contents (memory's alterColumn walks
			// the base layer) while the reconcile above sits in the connection's
			// PENDING layer. So commit the reconcile eagerly first (refresh-parity
			// commit-first semantics — the structural ops above are already
			// non-transactional, so the reshaping attach is DDL-grade atomicity
			// regardless; the later coordinated commit no-ops). Then mirror
			// reshapeBackingInPlace's post batch: re-register the catalog after EACH
			// op so a mid-batch throw cannot strand catalog/module divergence.
			await conn.commit();
			reconcileCommitted = true;
			for (const op of reshapePlan.postReconcileOps) {
				current = await module.alterTable!(db, schemaName, name, reshapeOpToChange(op));
				live = graftReshapedRecord(current, maintained);
				schema.addTable(live);
			}
		}

		if (reshapePlan) {
			// Final binding: the early registration gated against the pre-reshape
			// record; re-register (idempotent) so the row-time plan binds the
			// RESHAPED backing's columns and physical PK.
			db.registerMaterializedView(live);
		}
	} catch (e) {
		if (reconcileCommitted) {
			// The reconciled rows are already committed and the catalog tracks the
			// module per-op — leave the new record in place, stale (reads re-validate;
			// a refresh applies the remaining attribute reshape).
			db.markMaterializedViewStale(live);
		} else if (moduleMutated) {
			restoreReshaped(current);
		} else {
			restorePrior();
		}
		// Discard a backing store freshly created by `ensureBackingForAttach` for a
		// FAILED FRESH attach (no prior derivation): the table reverts to ordinary,
		// whose storage still holds the pre-attach rows, so the just-created (empty /
		// rolled-back) store must be dropped — otherwise the module would keep routing
		// reads to it. A re-attach (priorMaintained) reused the existing store, which
		// `restorePrior` keeps for the restored prior derivation, so it is NOT
		// discarded. The reconcile-committed branch keeps its committed store (stale).
		if (discardBackingOnFailure && !reconcileCommitted && !priorMaintained) {
			await module.discardBackingForAttach?.(db, schemaName, name);
		}
		throw e;
	}

	if (priorMaintained) unlinkCoveredUniqueConstraints(db, priorMaintained);
	linkCoveredUniqueConstraints(db, live, bodySql);

	if (reshapePlan) {
		// The table's column SHAPE changed, and the modified-event channel has no
		// maintenance listener — fire the same single table_modified the refresh
		// reshape fires, BEFORE the row cascade below, so consumer maintained
		// tables go stale (and their released plans never receive shape-shifted
		// rows); cached plans scanning the table directly recompile.
		sm.getChangeNotifier().notifyChange({
			type: 'table_modified',
			schemaName, objectName: name,
			oldObject: prior, newObject: live,
		});
	}

	// Cascade the GENUINE reconcile changes to consumer maintained tables: the
	// reconcile wrote this table through the privileged surface, so the DML
	// boundary never saw the writes. Identical content produced zero changes and
	// therefore zero dispatch. Full-rebuild and residual-arm consumers defer +
	// drain once, mirroring the statement flush.
	if (changes.length > 0) {
		const base = `${schemaName}.${name}`;
		const deferred = new Set<string>();
		const residualBatch: ResidualKeyBatch = new Map();
		for (const change of changes) {
			await db._maintainRowTimeCoveringStructures(base, change, undefined, deferred, residualBatch);
		}
		await db._flushDeferredMaintenance(deferred, residualBatch);
	}

	sm.getChangeNotifier().notifyChange(priorMaintained
		? {
			type: 'materialized_view_modified',
			schemaName, objectName: name,
			oldObject: priorMaintained, newObject: live,
		}
		: {
			type: 'materialized_view_added',
			schemaName, objectName: name,
			newObject: live,
		});

	if (live.derivation.coarsenedKey) {
		warnKeyCoarsening(schemaName, name, live.derivation.coarsenedKey);
	}
	return live;
}

/**
 * Detach a maintained table's derivation — `alter table … drop maintained`.
 * Catalog-only: nothing physical changes. The row-time plan is released, the
 * covering-structure link un-stamped (UNIQUE enforcement falls back to the
 * auto-index), and the registered record swapped for the same table minus the
 * derivation — rows, indexes, module identity, and tags all stay; staleness
 * state lives on the derivation and leaves with it. The table becomes ordinary
 * and user-writable.
 *
 * Fires `materialized_view_removed` ONLY: the maintenance manager releases any
 * remaining plan, store catalogs delete the persisted maintained entry (a
 * store-hosted table's plain bundle is already clause-free), and cached
 * statement plans over the table invalidate (a cached write-through plan
 * compiled against the old derivation must not survive the flip). Deliberately
 * NO `table_modified`: the table's shape and rows are unchanged, so consumer
 * maintained tables reading it stay live — subsequent user writes drive their
 * maintenance exactly like any source write.
 */
export function detachMaintainedDerivation(db: Database, mv: MaintainedTableSchema): TableSchema {
	const sm = db.schemaManager;
	const schema = sm.getSchemaOrFail(mv.schemaName);

	db.unregisterMaterializedView(mv.schemaName, mv.name);
	unlinkCoveredUniqueConstraints(db, mv);

	const live = schema.getTable(mv.name);
	const source = live && isMaintainedTable(live) ? live : mv;
	const { derivation: _derivation, ...plain } = source;
	schema.addTable(plain);

	sm.getChangeNotifier().notifyChange({
		type: 'materialized_view_removed',
		schemaName: mv.schemaName,
		objectName: mv.name,
		oldObject: source,
	});
	return plain;
}

/**
 * Reject a declared mutation-context variable on a maintained table. A maintained
 * table's rows are derived by the engine — nobody ever writes to it directly — so no
 * statement can ever carry a `with context` clause for one, and a declared variable
 * could never receive a value. Left unrejected, the combination fails later and
 * confusingly: the derived-row validator that compiles the table's declared CHECK /
 * child-side-FK constraints registers no context symbols, so a bare-name read of the
 * variable falls through to ordinary column resolution and raises "Column not found"
 * from `planner/resolve.ts`.
 *
 * Rejects **any** declaration, not only one some constraint reads — the "declared but
 * unread" case is harmless today, but that distinction is invisible to the author and
 * would silently drift the moment a constraint is added; one rule is simpler to state
 * and to document. Called from both authoring routes: {@link createMaintainedTable}
 * (declared schema, before the table registers) and `runSetMaintained` in
 * `alter-table.ts` (the live table, before {@link attachMaintainedDerivation}).
 */
export function assertNoMutationContextOnMaintainedTable(
	table: TableSchema,
	verb: 'create' | 'alter',
	loc?: { line: number; column: number },
): void {
	const declared = table.mutationContext;
	if (!declared || declared.length === 0) return;

	const label = `${table.schemaName}.${table.name}`;
	const names = declared.map(v => v.name).join(', ');
	const message = verb === 'create'
		? `cannot create maintained table '${label}': a maintained table's rows are derived `
			+ `by the engine, so no statement can supply its mutation context variables (${names}); `
			+ `remove the 'with context' clause`
		: `cannot make table '${label}' maintained: it declares mutation context variables `
			+ `(${names}) that no statement can supply, because a maintained table's rows are `
			+ `derived by the engine`;
	throw new QuereusError(message, StatusCode.ERROR, undefined, loc?.line, loc?.column);
}

/**
 * `create table … maintained as <body>` — the declared-shape authoring form,
 * executed all-or-nothing:
 *
 *  - an existing table/view + `if not exists` skips ENTIRELY (never a
 *    half-attach); without it, the standard already-exists error — both before
 *    the body is planned;
 *  - the declared shape is verified against the derived body shape BEFORE any
 *    catalog registration ({@link SchemaManager.buildDeclaredTableSchema} builds
 *    the schema the CREATE would register, without registering it);
 *  - then the table registers through the ordinary `createTable` path (declared
 *    constraints and defaults intact) and the shared {@link attachMaintainedDerivation}
 *    core runs — attach-to-empty: the reconcile diff against an empty table IS
 *    the fill, applied to the connection's pending state so it commits in
 *    lockstep with the statement (no `replaceContents` commit-first caveat);
 *  - any failure past registration (duplicate derived keys, a maintenance gate)
 *    drops the just-created table — the schema is left exactly as before.
 *
 * The attach core re-derives the body AFTER the table registers, so a body that
 * resolves differently once the new name exists (e.g. a same-name reference that
 * becomes a self-reference) is caught by the cycle check and rolled back.
 */
export async function createMaintainedTable(db: Database, stmt: AST.CreateTableStmt): Promise<MaintainedTableSchema | undefined> {
	const sm = db.schemaManager;
	const schemaName = stmt.table.schema ? sm.canonicalSchemaName(stmt.table.schema) : sm.getCurrentSchemaName();
	const name = stmt.table.name;

	if (sm.getTable(schemaName, name) || sm.getView(schemaName, name)) {
		if (stmt.ifNotExists) return undefined;
		throw new QuereusError(
			`Table ${schemaName}.${name} already exists`,
			StatusCode.CONSTRAINT,
			undefined,
			stmt.table.loc?.start.line,
			stmt.table.loc?.start.column,
		);
	}

	// An authored `maintained (columns)` list is the explicit/arity-locked form: the
	// body is renamed positionally to the declared names (name check skipped) and the
	// declared names are recorded as `derivation.columns`. No list is the implicit
	// form: the strict name check applies and `derivation.columns` is undefined, so
	// the canonical DDL omits the clause and the table reshapes its source on reopen.
	const list = stmt.maintained!.columns;
	const explicit = list !== undefined && list.length > 0;
	const declared = sm.buildDeclaredTableSchema(stmt);
	const recordedColumns = explicit ? declared.columns.map(c => c.name) : undefined;
	const bodySql = astToString(stmt.maintained!.select);
	const shape = deriveBackingShape(db, schemaName, bodySql, explicit ? recordedColumns : undefined,
		{ moduleName: declared.vtabModuleName, moduleArgs: declared.vtabArgs, against: declared });
	const mismatch = describeAttachShapeMismatch(declared, shape, explicit);
	if (mismatch) {
		throw new QuereusError(
			`cannot create maintained table '${schemaName}.${name}': ${mismatch}`,
			StatusCode.ERROR,
			undefined,
			stmt.table.loc?.start.line,
			stmt.table.loc?.start.column,
		);
	}
	assertNoMutationContextOnMaintainedTable(declared, 'create', stmt.table.loc?.start);

	// `preferBacking = true`: route the create through the module's durable backing
	// seam (`createBacking?() ?? create()`) so a durable-backing module (lamina)
	// builds the basis `RowStore` that `resolveBackingHost` → `getBackingHost`
	// resolves below for the attach-to-empty fill. Without this the table is an
	// ordinary relational collection with no basis store and the fill throws
	// `backing host not found`. Memory (no `createBacking`) falls through to `create`.
	const table = await sm.createTable(stmt, /*preferBacking*/ true);
	try {
		return await attachMaintainedDerivation(
			db, table, stmt.maintained!.select,
			explicit ? table.columns.map(c => c.name) : undefined, explicit,
		);
	} catch (e) {
		try {
			await sm.dropTable(schemaName, name, /*ifExists*/ true);
		} catch { /* best-effort cleanup */ }
		throw e;
	}
}

/**
 * Full-rebuild of a maintained table's contents: re-run the body to completion
 * and swap the table to the recomputed set. The always-correct path the two
 * `refresh materialized view` arms funnel through — the fast (data-only) path
 * (`backingShapeMatches` ⇒ direct `rebuildBacking`) and the reshape arm
 * (`reshapeBackingInPlace`, between its pre- and post-reconcile structural ops).
 * It is used by NOTHING else: create/import (`materializeView`) calls
 * `replaceContents` directly, and the incremental manager's full-rebuild arm
 * (`applyFullRebuild` in `core/database-materialized-views.ts`) does its own
 * `applyMaintenance` + per-delta validation (`validateDerivedChanges`).
 *
 * **Constraint-bearing branch.** When the maintained table declares ≥1 applicable
 * CHECK or (FK-enforcement-on) child-side FK ({@link hasApplicableConstraints}),
 * the swap mirrors the attach core instead of calling `replaceContents`: reject
 * duplicate derived keys ({@link assertRefreshRowsAreSet} — parity with
 * `replaceContents`'s set gate), land the recomputed set in the connection's
 * PENDING layer via `applyMaintenance('replace-all')`, run the eager bulk
 * anti-join / `not (<check>)` scan ({@link validateDeclaredConstraintsOverContents})
 * which throws the maintained-table-attributed CONSTRAINT diagnostic on the first
 * violator BEFORE the swap is committed (the failing statement unwinds and the
 * pending reconcile is discarded by statement-level rollback — the pre-refresh
 * COMMITTED contents stay intact), then `conn.commit()`.
 *
 * The commit is **commit-first parity** and load-bearing two ways: (1)
 * `replaceContents` already swaps committed state (a `begin; refresh; rollback`
 * does NOT undo a refresh today), so committing here preserves that exact
 * observable behavior; (2) on the reshape arm, `reshapeBackingInPlace`'s
 * post-reconcile data-validating ops (retype/recollate/tighten-NOT-NULL) scan
 * COMMITTED contents after this returns, so they must see the rebuilt rows —
 * `replaceContents` gives that implicitly, the pending-layer branch matches it by
 * committing (as the attach reshape path does before its own post-reconcile ops).
 *
 * The real-world trigger is a STALE table: a body-relevant source change released
 * the MV's row-time plan, subsequent source writes drifted unvalidated, and a
 * refresh recomputes that drifted set — so this scan is where a declared CHECK/FK
 * is enforced over rows that never crossed the maintenance boundary. A
 * continuously-maintained table re-derives an already-validated set, so the scan
 * is redundant-but-cheap there.
 *
 * Constraint-less maintained tables and every MV-sugar backing take the untouched
 * `replaceContents` fast path — no connection, no scan, byte-for-byte the prior
 * behavior. The caller is responsible for staleness re-validation when relevant;
 * this helper assumes the derivation body plans. Throws if the table is missing
 * from the catalog.
 *
 * `validationColumns` is the reshape arm's column preview
 * ({@link previewReshapedColumns}) — the type/collation attributes the reshape's
 * still-pending post-reconcile ops are about to land — forwarded to the scan so
 * the CHECK / FK resolve against the final declared shape. `undefined` on every
 * other path (and on a reshape that shifts neither attribute).
 */
export async function rebuildBacking(
	db: Database,
	mv: MaintainedTableSchema,
	validationColumns?: readonly ColumnSchema[],
): Promise<void> {
	const bodySql = astToString(mv.derivation.selectAst);
	const rows: Row[] = await collectBodyRows(db, mv.schemaName, bodySql);

	const backing = db.schemaManager.getTable(mv.schemaName, mv.name);
	if (!backing) {
		throw new QuereusError(
			`Internal error: maintained table '${mv.name}' not found during rebuild`,
			StatusCode.INTERNAL,
		);
	}
	const host = resolveBackingHost(db, backing);

	// Loud-error guard (covers BOTH branches below — neither validates column NOT NULL):
	// a backing column declared NOT NULL that is also a physical-PK member cannot legally
	// hold the recomputed NULL a nullable source now produces. The ordering-seeded physical
	// PK (computeBackingPrimaryKey) pins such a column NOT NULL even after its source column
	// dropped NOT NULL — the reshape masks the loosening of a physical-PK column rather than
	// emitting it — so at this point the only still-NOT-NULL columns that can
	// carry source-nullable data are the physical-PK ones. Storing the NULL would make the
	// backing schema declare NOT NULL while holding a NULL; reject it before either swap.
	// NOTE: narrow loud guard until `debt-mv-ordering-seed-to-materialized-index` replaces
	// ordering-seeding with a materialized index. While a source NULL persists in the seeded
	// column the MV stays un-refreshable (drop + recreate the view without `order by <col>`).
	assertNoNullInNotNullSeededPk(backing, rows, mv.schemaName, mv.name);

	if (!isMaintainedTable(backing) || !hasApplicableConstraints(db, backing)) {
		// Fast path: nothing declared to validate (every MV-sugar backing, and a
		// constraint-less table-form maintained table). `replaceContents` swaps
		// COMMITTED contents and runs no derived-row validation — byte-for-byte the
		// historical path. (A pragma-off FK-only table also lands here: its bulk FK
		// scan would no-op anyway — see hasApplicableConstraints.)
		await host.replaceContents(rows, () => materializedViewNotASetError(mv.schemaName, mv.name));
		return;
	}

	// Constraint-bearing branch: pending-layer replace-all + eager bulk scan, then a
	// commit-first commit (see the docstring). `shapePk` is the live backing's
	// physical key — re-derived shape matches it on the fast path, and on the reshape
	// arm the catalog was already re-registered with the post-reshape PK before this
	// runs, so the live `primaryKeyDefinition` is the correct keying either way.
	const shapePk = backing.primaryKeyDefinition.map(c => ({
		index: c.index,
		collation: c.collation ?? backing.columns[c.index]?.collation,
	}));
	assertRefreshRowsAreSet(rows, shapePk, db.getCollationResolver(), mv.schemaName, mv.name);

	const conn = await resolveAttachConnection(db, host, `${mv.schemaName}.${mv.name}`);
	await host.applyMaintenance(conn, [{ kind: 'replace-all', rows }]);
	// Throws the maintained-table-attributed diagnostic BEFORE the commit; on a
	// violation the failing statement unwinds and discards the pending reconcile,
	// leaving the pre-refresh committed contents intact (the MV stays stale, so the
	// next read re-validates rather than serving the rejected set).
	//
	// On the reshape arm `validationColumns` carries the attributes the reshape is
	// about to land ({@link previewReshapedColumns}), so a CHECK / FK is evaluated
	// under the column's FINAL type and collation even though the `retype` /
	// `recollate` module ops still run post-reconcile in reshapeBackingInPlace. That
	// keeps this commit's ordering exactly as it was — the scan stays before the
	// commit, the post-reconcile ops still scan committed contents — while removing
	// the wrong-semantics gap. The attach reshape path passes the same preview at its
	// own call site, so both arms reject identically.
	await validateDeclaredConstraintsOverContents(db, backing, validationColumns);
	await conn.commit();
}

/**
 * True iff the live backing `TableSchema` is structurally identical to what the
 * derived `shape` would build — so a `refresh` can take the data-only fast path
 * (`rebuildBacking`, preserving the backing identity and warm caches) instead of
 * rebuilding the backing table. Compares, in order:
 *  - column **count**;
 *  - per column: **name** (case-insensitive — matching the matcher's name compare),
 *    **logical type**, **not-null**, **collation**;
 *  - the **physical** PK ({@link computeBackingPrimaryKey} vs the backing's
 *    `primaryKeyDefinition`, by index + desc + collation, in order).
 *
 * Returns false when a source schema change has shifted the body's output shape
 * (most visibly a `select *` body whose new source column interleaves into the
 * output) — the caller then rebuilds the backing to match the re-planned body.
 */
export function backingShapeMatches(current: TableSchema, shape: BackingShape): boolean {
	if (!backingShapeMatchesStructurally(current, shape)) return false;
	for (let i = 0; i < shape.columns.length; i++) {
		if (current.columns[i].name.toLowerCase() !== shape.columns[i].name.toLowerCase()) return false;
	}
	return true;
}

/**
 * The structural (name-blind) half of {@link backingShapeMatches}: column count,
 * per-column logical type / not-null / collation, and the physical PK. The rename
 * propagation ({@link propagateColumnRenameToMaterializedViews}) uses it to assert
 * a source column rename produced a *pure name shift* in the body's output before
 * carrying the new names onto the live backing — anything structural is not a
 * rename outcome and fails the propagation instead of rebuilding data.
 */
function backingShapeMatchesStructurally(current: TableSchema, shape: BackingShape): boolean {
	return describeBackingShapeMismatch(current, shape) === null;
}

/* ──────────────── shared backing-column comparison primitives ────────────────
 * The per-column attribute comparisons below are the single shape-diff vocabulary
 * shared by the positional {@link describeBackingShapeMismatch} (the rename
 * propagation's "pure name shift?" assertion) and the alignment-based
 * {@link classifyBackingReshape} (refresh's in-place reshape gate) — neither rolls
 * its own column compare. All compare by NAME / normalized value, not identity:
 * logical types resolve through the (name-interned) registry, but a module may
 * rebuild its TableSchema with fresh instances after an ALTER (the store module
 * does), so object identity is spuriously false. */

/** The two columns carry the same logical type (by interned type name). */
function backingTypeMatches(a: ColumnSchema, b: ColumnSchema): boolean {
	return a.logicalType.name.toUpperCase() === b.logicalType.name.toUpperCase();
}

/** The two columns agree on NOT NULL. */
function backingNotNullMatches(a: ColumnSchema, b: ColumnSchema): boolean {
	return (a.notNull === true) === (b.notNull === true);
}

/** The two columns agree on declared collation (absent ⇒ BINARY). */
function backingCollationMatches(a: ColumnSchema, b: ColumnSchema): boolean {
	return (a.collation ?? 'BINARY') === (b.collation ?? 'BINARY');
}

/** Whether `columnNameLower` (already lowercased) names a column of `table`'s
 *  *physical* primary key ({@link TableSchema.primaryKeyDefinition} — which for an
 *  MV backing includes any ordering-seeded columns, {@link computeBackingPrimaryKey}).
 *  An MV backing keeps its physical-PK columns NOT NULL, so the refresh reshape must
 *  never try to loosen one — see the two callers below.
 *
 *  NOTE: that is now a POLICY of the MV backing, not an engine constraint. A primary key
 *  column may be nullable in general (docs/schema.md § Primary-key nullability) and
 *  `alter column … drop not null` on one is accepted by both backends; the backing keeps
 *  its seeded key columns NOT NULL because the ordering seed treats them as a total order
 *  and `assertNoNullInNotNullSeededPk` is the loud guard for the contradiction. If
 *  ordering-seeded backings ever need to carry NULLs in the seeded column, this mask and
 *  that guard are the pair to revisit together — `debt-mv-ordering-seed-to-materialized-index`
 *  removes the need for both. */
function isPhysicalPkColumn(table: TableSchema, columnNameLower: string): boolean {
	return table.primaryKeyDefinition.some(
		def => table.columns[def.index]?.name.toLowerCase() === columnNameLower,
	);
}

/** Names the first structural difference between the live backing and the derived
 *  shape (null when structurally identical) — the diagnostic half of
 *  {@link backingShapeMatchesStructurally}. Deliberately **positional** (column i
 *  vs column i): it answers "is this a pure positional name shift (or identical)?"
 *  for the rename-propagation pass, which only ever carries names. The richer
 *  alignment that tolerates appended / dropped / renamed columns is
 *  {@link classifyBackingReshape}; both share the per-column predicates above. */
function describeBackingShapeMismatch(current: TableSchema, shape: BackingShape): string | null {
	if (current.columns.length !== shape.columns.length) {
		return `column count ${current.columns.length} → ${shape.columns.length}`;
	}
	for (let i = 0; i < shape.columns.length; i++) {
		const a = current.columns[i];
		const b = shape.columns[i];
		if (!backingTypeMatches(a, b)) {
			return `column ${i} type ${a.logicalType.name} → ${b.logicalType.name}`;
		}
		if (!backingNotNullMatches(a, b)) {
			// A physical-PK column stays NOT NULL in the backing regardless of the
			// re-derived logical nullability (an MV-backing policy — see
			// {@link isPhysicalPkColumn}), so a NOT-NULL→nullable *loosening*
			// of a PK column is NOT a shape difference. Masking it lets refresh keep the
			// data-only rebuild path instead of emitting a doomed `loosenNotNull` op. Tight
			// on purpose: only a loosening (`current` NOT NULL, derived nullable) of a
			// current physical-PK column; a tighten, or any non-PK column, stays a real diff.
			// NOTE: this pairs with the ordering-seeded physical PK (computeBackingPrimaryKey,
			// ~line 236); the covering ticket that replaces ordering-seeding with a
			// materialized index removes the need for this mask.
			const looseningPkColumn = a.notNull === true && b.notNull !== true
				&& isPhysicalPkColumn(current, a.name.toLowerCase());
			if (!looseningPkColumn) {
				return `column ${i} not-null ${a.notNull === true} → ${b.notNull === true}`;
			}
		}
		if (!backingCollationMatches(a, b)) {
			return `column ${i} collation ${a.collation ?? 'BINARY'} → ${b.collation ?? 'BINARY'}`;
		}
	}
	const shapePk = computeBackingPrimaryKey(shape);
	const currentPk = current.primaryKeyDefinition;
	if (currentPk.length !== shapePk.length) {
		return `primary-key length ${currentPk.length} → ${shapePk.length}`;
	}
	for (let i = 0; i < shapePk.length; i++) {
		if (currentPk[i].index !== shapePk[i].index) {
			return `primary-key column ${i} index ${currentPk[i].index} → ${shapePk[i].index}`;
		}
		if ((currentPk[i].desc === true) !== (shapePk[i].desc === true)) {
			return `primary-key column ${i} direction`;
		}
		const shapeColl = shape.columns[shapePk[i].index]?.collation ?? 'BINARY';
		if ((currentPk[i].collation ?? 'BINARY') !== shapeColl) {
			return `primary-key column ${i} collation ${currentPk[i].collation ?? 'BINARY'} → ${shapeColl}`;
		}
	}
	return null;
}

/* ──────────────── body-irrelevant source change: recompile, never skip ────────────────
 * A `table_modified` whose old/new differ only in fields a body cannot read —
 * constraint metadata (CHECK exprs, FK targets, UNIQUE sets, index predicates),
 * `statistics`/`estimatedRows` (ANALYZE), `tags`, column defaults — cannot change
 * what a dependent MV's body *evaluates to*. But it CAN change what the body
 * **compiles to**: CHECK constraints seed domain facts (`ruleFilterContradiction`
 * may have folded a filter — or the whole body — away against a CHECK that no
 * longer holds), and `proveOneToOneJoin`'s join-residual arm rests on NOT-NULL
 * FK→PK referential integrity. So the MV manager's schema-change listener routes
 * live dependents of a qualifying event through an in-place RECOMPILE
 * ({@link tryRecompileMaterializedViewLive}) instead of marking them stale —
 * recompile, never skip. Any failure falls back to the mark-stale path. */

/** The per-column fields a body can observe: name, logical type, NOT NULL,
 *  collation (absent ⇒ BINARY), and the generated expression. `defaultValue`
 *  and per-column conflict metadata are deliberately IGNORED — a body reads
 *  stored values, never source defaults; the recompile-not-skip discipline
 *  covers any optimizer-level concern. */
function bodyRelevantColumnMatches(a: ColumnSchema, b: ColumnSchema): boolean {
	return a.name.toLowerCase() === b.name.toLowerCase()
		&& backingTypeMatches(a, b)
		&& backingNotNullMatches(a, b)
		&& backingCollationMatches(a, b)
		&& (a.generated === true) === (b.generated === true)
		&& (!a.generated || sameGeneratedExpr(a, b));
}

function sameGeneratedExpr(a: ColumnSchema, b: ColumnSchema): boolean {
	if ((a.generatedExpr === undefined) !== (b.generatedExpr === undefined)) return false;
	if (!a.generatedExpr || !b.generatedExpr) return true;
	return expressionToString(a.generatedExpr) === expressionToString(b.generatedExpr);
}

/** Pairwise physical-PK identity (`index`, `desc`, effective per-component
 *  collation — explicit, else the keyed column's, else BINARY). */
function samePrimaryKeyDefinition(a: TableSchema, b: TableSchema): boolean {
	if (a.primaryKeyDefinition.length !== b.primaryKeyDefinition.length) return false;
	return a.primaryKeyDefinition.every((pa, i) => {
		const pb = b.primaryKeyDefinition[i];
		const collA = pa.collation ?? a.columns[pa.index]?.collation ?? 'BINARY';
		const collB = pb.collation ?? b.columns[pb.index]?.collation ?? 'BINARY';
		return pa.index === pb.index
			&& (pa.desc === true) === (pb.desc === true)
			&& collA === collB;
	});
}

/**
 * True when a `table_modified` event's old→new transition is **body-irrelevant**:
 * same table name and schema, columns pairwise identical in every body-relevant
 * field ({@link bodyRelevantColumnMatches}), and an identical physical primary
 * key. Everything else may differ — `checkConstraints`, `foreignKeys`,
 * `uniqueConstraints`, `indexes`, `statistics`, `estimatedRows`, `tags`,
 * `primaryKeyDefaultConflict`, defaults. A qualifying event cannot change what a
 * dependent body evaluates to, only what it compiles to — see the section note
 * above for why dependents are recompiled rather than skipped.
 *
 * **Reference-equality guard (load-bearing coupling).** The MV manager's
 * `emitBackingInvalidation` fires a synthetic `table_modified` on an MV's own
 * backing with the SAME object as `oldObject` and `newObject` — the event that
 * cascades staleness down MV-over-MV chains. It must classify as body-RELEVANT,
 * hence `oldObject === newObject` short-circuits to false here. Every genuine
 * emitter passes distinct old/new objects. If either side changes, change both
 * (see the matching comment in `emitBackingInvalidation`,
 * core/database-materialized-views.ts).
 */
export function isBodyIrrelevantTableChange(oldObject: TableSchema, newObject: TableSchema): boolean {
	if (oldObject === newObject) return false;
	if (oldObject.name.toLowerCase() !== newObject.name.toLowerCase()) return false;
	if (oldObject.schemaName.toLowerCase() !== newObject.schemaName.toLowerCase()) return false;
	if (oldObject.columns.length !== newObject.columns.length) return false;
	for (let i = 0; i < oldObject.columns.length; i++) {
		if (!bodyRelevantColumnMatches(oldObject.columns[i], newObject.columns[i])) return false;
	}
	return samePrimaryKeyDefinition(oldObject, newObject);
}

/** Structural (name-blind) column-only check: count + per-column type/not-null/collation,
 *  WITHOUT comparing the physical PK. Used by the superkey relaxation in
 *  `tryRecompileMaterializedViewLive` to gate the PK-changing case where column
 *  attributes are otherwise identical. */
function backingColumnsStructurallyMatch(current: TableSchema, shape: BackingShape): boolean {
	if (current.columns.length !== shape.columns.length) return false;
	for (let i = 0; i < shape.columns.length; i++) {
		const a = current.columns[i];
		const b = shape.columns[i];
		if (!backingTypeMatches(a, b)) return false;
		if (!backingNotNullMatches(a, b)) return false;
		if (!backingCollationMatches(a, b)) return false;
	}
	return true;
}

/** Returns true when the live backing's physical PK column set is a superkey of the
 *  re-planned body — i.e., some proved minimal key from `shape.allProvedKeys` is
 *  entirely contained in the backing PK's column set.  Returns false when
 *  `allProvedKeys` is absent (coarsened-lineage or all-columns path). */
function isBackingPkASuperkeyInShape(current: TableSchema, shape: BackingShape): boolean {
	if (!shape.allProvedKeys) return false;
	const backingPkCols = new Set(current.primaryKeyDefinition.map(pk => pk.index));
	return shape.allProvedKeys.some(k => k.every(idx => backingPkCols.has(idx)));
}

/* ──────────────── content-stability proof (structural-ALTER keep-live) ────────────────
 * For a CONSTRAINT-only `table_modified`, re-derived backing-shape identity implies
 * content identity (a constraint cannot change what stored rows the body evaluates
 * to, only what the body compiles to), so a recompile against the new catalog is
 * sufficient — that is the constraint-only path. For a STRUCTURAL ALTER (ADD / DROP /
 * ALTER COLUMN) the same argument does NOT carry: shape identity ⇏ content identity.
 * The classic hazard is `alter column v set collate nocase` (or `set data type`) on a
 * column the body uses only in a WHERE / join / group / order position — the output
 * shape is unchanged (v is unprojected), yet the row set the predicate admits, hence
 * the backing content, changes. So a structural keep-live additionally proves the
 * value-semantics of the change is DISJOINT from everything the body reads. The two
 * helpers below compute the two sides of that proof; the gate lives in
 * {@link tryRecompileMaterializedViewLive}. */

/**
 * The columns whose **value semantics** the `oldObject → newObject` transition
 * changed: present **by name in both** schemas and differing in logical type or
 * collation. Returns lowercased column names (the column-index map key). NOT NULL,
 * default, generated-expr-unchanged, and add/drop are deliberately excluded —
 * NOT NULL / default are content-irrelevant (a body reads stored values, never
 * constraints or defaults), and an add/drop that the body reads is already caught
 * upstream (a `select *` reshapes ⇒ shape mismatch; a referenced dropped column
 * fails re-derivation; a referenced added column cannot exist in the authored body).
 * So the set is EMPTY for every change except ALTER COLUMN SET DATA TYPE / SET
 * COLLATE — making the disjointness proof a no-op (today's behavior) elsewhere.
 */
function valueSemanticsChangedColumns(oldObject: TableSchema, newObject: TableSchema): Set<string> {
	const out = new Set<string>();
	for (const newCol of newObject.columns) {
		const oldCol = oldObject.columns.find(c => c.name.toLowerCase() === newCol.name.toLowerCase());
		if (!oldCol) continue; // added column — no value-semantics change to an existing column
		if (!backingTypeMatches(oldCol, newCol) || !backingCollationMatches(oldCol, newCol)) {
			out.add(newCol.name.toLowerCase());
		}
	}
	return out;
}

/**
 * The set of source-column indices (in `qualifiedSource`'s POST-ALTER schema) that a
 * materialized-view body **reads** — directly, through a predicate / join / group /
 * order position, or transitively through a generated column. The disjointness half
 * of the structural-ALTER content-stability gate (see the section note and
 * {@link tryRecompileMaterializedViewLive}): a value-semantics change (type /
 * collation) to a column NOT in this set cannot alter what the body evaluates to.
 *
 * **Why the un-optimized built plan, not `db.getPlan`.** The optimizer can absorb a
 * `where v = 'x'` predicate into an access-method seek key, dropping the explicit
 * {@link ColumnReferenceNode} from the tree — walking the optimized plan would MISS
 * that reference and falsely conclude disjoint (UNSOUND). The un-optimized built plan
 * (`db._buildPlan`) carries every reference explicitly in its projection / filter /
 * join / group / order nodes. Over-approximation is the safe direction: an extra
 * column in the read set only ever causes MORE staleness, never an unsound keep-live.
 *
 * Mechanics: walk the built tree (children AND relations, like {@link collectSourceTables},
 * so nested subqueries / EXISTS / correlated refs are reached) collecting every
 * `ColumnReferenceNode.attributeId`; for every `TableReferenceNode` whose qualified
 * name equals `qualifiedSource` (several for a self-join) map the collected attribute
 * ids back to its column indices via `getAttributes()`; union over occurrences. Then
 * expand the set DOWNWARD through `generatedColumnDependencies` to a fixed point —
 * reading a generated column reads its dependency columns even when the body never
 * names them (safe whether or not the planner inlines generated columns: if it does,
 * the dep already appears as a direct reference and the closure is a no-op; if it
 * does not, the closure is load-bearing).
 *
 * The rewrite is suppressed for the same reason {@link deriveBackingShape} suppresses
 * it. Any exception propagates to {@link tryRecompileMaterializedViewLive}'s try/catch,
 * which treats a failed analysis as "could not prove disjoint" ⇒ stale (the safe
 * default) — it must never be swallowed into a false "disjoint" conclusion.
 */
export function referencedSourceColumns(db: Database, schemaName: string, bodySql: string, qualifiedSource: string): Set<number> {
	const targetName = qualifiedSource.toLowerCase();
	return db.schemaManager.withSuppressedMaterializedViewRewrite(() => {
		const ast = new Parser().parse(bodySql);
		const { plan } = db._buildPlan([ast as AST.Statement], undefined, db._homeSchemaPath(schemaName));

		const referencedAttrIds = new Set<number>();
		const sourceRefs: TableReferenceNode[] = [];
		const visited = new Set<PlanNode>();
		const walk = (node: PlanNode): void => {
			if (visited.has(node)) return;
			visited.add(node);
			if (node instanceof ColumnReferenceNode) {
				referencedAttrIds.add(node.attributeId);
			} else if (node instanceof TableReferenceNode
				&& `${node.tableSchema.schemaName}.${node.tableSchema.name}`.toLowerCase() === targetName) {
				sourceRefs.push(node);
			}
			for (const c of node.getChildren()) walk(c as unknown as PlanNode);
			for (const r of node.getRelations()) walk(r as unknown as PlanNode);
		};
		walk(plan);

		const cols = new Set<number>();
		let deps: ReadonlyMap<number, ReadonlyArray<number>> | undefined;
		for (const ref of sourceRefs) {
			const attrs = ref.getAttributes();
			for (let i = 0; i < attrs.length; i++) {
				if (referencedAttrIds.has(attrs[i].id)) cols.add(i);
			}
			// The TableReferenceNode is built from the live (post-ALTER) catalog, so its
			// schema IS `newObject`; all S occurrences share it.
			deps ??= ref.tableSchema.generatedColumnDependencies;
		}
		if (deps) expandGeneratedDependencyClosure(cols, deps);
		return cols;
	});
}

/** Expand `cols` downward through `deps` (generated-column index → dependency column
 *  indices) to a fixed point: a read of a generated column is a read of its dependency
 *  columns, which may themselves be generated. */
function expandGeneratedDependencyClosure(cols: Set<number>, deps: ReadonlyMap<number, ReadonlyArray<number>>): void {
	const queue = [...cols];
	while (queue.length > 0) {
		const idx = queue.pop()!;
		const depIndices = deps.get(idx);
		if (!depIndices) continue;
		for (const d of depIndices) {
			if (!cols.has(d)) { cols.add(d); queue.push(d); }
		}
	}
}

/**
 * Recompile a LIVE materialized view's row-time plan in place after a **genuine**
 * source `table_modified` (`oldObject !== newObject` — constraint/stats/tags-only OR
 * structural ADD/DROP/ALTER COLUMN), gated by shape re-derivation and — for a
 * structural value-semantics change — a content-stability proof. The same discipline
 * as {@link restoreUnaffectedMaterializedViews}. Fully synchronous (the schema-change
 * listener is sync; shape derivation, schema lookups, the disjointness analysis, and
 * registration all are). Never throws: logs and returns `false` on any failure, and
 * the caller falls back to the mark-stale path. On success the MV stays live —
 * `stale` untouched, row-time plan rebuilt against the new catalog, no backing
 * invalidation (the backing stays maintained, so cached plans reading it remain
 * correct).
 *
 * **Structural-ALTER soundness (why a recompile is not enough on its own).** For a
 * constraint-only change, re-derived backing-shape identity IMPLIES content identity —
 * a constraint cannot change what stored rows the body evaluates to, only what the
 * body compiles to. For a structural ALTER that argument does NOT carry: shape
 * identity ⇏ content identity. `alter column v set collate nocase` / `set data type`
 * on a column the body reads only in a WHERE / join / group / order position leaves
 * the output shape identical while changing the admitted row set — the backing content
 * diverges from a fresh body evaluation. So the structural keep-live adds a final
 * **content-stability gate** proving the change's value-semantics-changed columns are
 * disjoint from everything the body reads (the {@link valueSemanticsChangedColumns} ∩
 * {@link referencedSourceColumns} proof). That changed set is EMPTY for constraint-only,
 * ADD, DROP, NOT NULL, and DEFAULT changes, so the proof is a no-op there and preserves
 * today's behavior exactly; it does real work only for ALTER COLUMN type/collation.
 *
 * Gates, in order — each failure is a stale fallback:
 *  1. `deriveBackingShape` throws when the body no longer plans against the
 *     post-change catalog (e.g. a rename-cascade constraint rewrite observed
 *     mid-statement, while a co-source's rename has landed but this MV's body
 *     rewrite has not — the rename propagation's own MV loop restores it later).
 *     A DROP COLUMN the body references directly throws here too.
 *  2. `sameSourceTables`: the re-planned source set must equal the recorded one.
 *     An FK drop can un-eliminate a previously FK/PK-eliminated join (growing
 *     the set); a constraint change can let `ruleFilterContradiction` fold a
 *     source out of the plan entirely (shrinking it). Either way the record is
 *     out of sync with the body's plan — leave it to REFRESH, which re-derives.
 *  3. `backingColumnsStructurallyMatch` + `isBackingPkASuperkeyInShape`: the column
 *     structural attributes (type / not-null / collation) must match positionally,
 *     AND the live backing's physical PK column set must be a superkey of the
 *     re-planned body (some proved minimal key ⊆ backing PK columns). This forces
 *     staleness when a dropped UNIQUE un-proves the recorded backing key (`keysOf`
 *     falls back to a smaller key or all-columns → no proved key ⊆ old PK). An
 *     ADD CONSTRAINT UNIQUE that subsumes the compound key passes: the new minimal
 *     key is a subset of the old compound backing PK. A `select *` body over an
 *     ADD/DROP COLUMN reshapes its output here ⇒ shape mismatch ⇒ stale. A PROJECTED
 *     column whose type/collation changed shifts the output column ⇒ shape mismatch
 *     ⇒ stale. Re-registers with the EXISTING backing (PK unchanged) on a pass.
 *  4. Content-stability gate (structural value-semantics ALTER only — see above):
 *     if any value-semantics-changed column (type/collation) is read by the body
 *     (transitively through generated columns), the backing content is unstable ⇒
 *     stale. Empty changed set ⇒ no-op. A failure to build the disjointness analysis
 *     propagates to the outer try/catch ⇒ stale (could not prove disjoint).
 *  5. `registerMaterializedView` re-runs arm selection / eligibility / cost
 *     gating (`buildMaintenancePlan`) against the new catalog and throws on the
 *     create-time gates (non-determinism, bag/no-key floor, full-rebuild
 *     pathology against fresh ANALYZE stats — defensible: the alternative is
 *     unbounded per-write rebuild cost). Registration is event-silent, so the
 *     success path fires no nested schema-change notifications.
 *
 * `oldObject`/`newObject` are the genuine event's distinct schemas. The synthetic
 * backing-invalidation event (same object as old/new) is excluded by the caller's
 * `oldObject !== newObject` guard — it must cascade staleness, never recompile.
 *
 * Deliberately NOT {@link restoreMaterializedViewLive}: that path is async, may
 * rename backing columns, and clears `stale` — the wrong discipline here, where
 * the MV is live throughout and a pre-existing `stale` flag must stay untouched.
 */
export function tryRecompileMaterializedViewLive(
	db: Database,
	mv: MaintainedTableSchema,
	oldObject: TableSchema,
	newObject: TableSchema,
): boolean {
	try {
		const d = mv.derivation;
		const bodySql = astToString(d.selectAst);
		const schema = db.schemaManager.getSchemaOrFail(mv.schemaName);
		const live = schema.getTable(mv.name);
		const backing = isMaintainedTable(live) ? live : mv;
		const shape = deriveBackingShape(db, mv.schemaName, bodySql, d.columns,
			{ moduleName: mv.vtabModuleName, moduleArgs: mv.vtabArgs, against: backing });
		if (!sameSourceTables(d.sourceTables, shape.sourceTables)) {
			log('Marking materialized view %s.%s stale instead of recompiling: re-planned source tables (%s) disagree with the recorded set (%s) — REFRESH re-derives',
				mv.schemaName, mv.name, shape.sourceTables.join(', '), d.sourceTables.join(', '));
			return false;
		}
		const mismatch = describeBackingShapeMismatch(backing, shape);
		if (mismatch) {
			// Relaxed superkey gate: columns match structurally AND the existing backing
			// PK column set is still a superkey of the re-planned body (some proved
			// minimal key is ⊆ the backing PK's column set). Covers ADD CONSTRAINT UNIQUE
			// that subsumes the compound key — keysOf now returns a smaller key first,
			// changing the physical PK shape, but the old backing PK is still uniquely
			// identifying. Re-register with the EXISTING backing (unchanged PK).
			if (!backingColumnsStructurallyMatch(backing, shape) || !isBackingPkASuperkeyInShape(backing, shape)) {
				log('Marking materialized view %s.%s stale instead of recompiling: backing shape mismatch (%s) — REFRESH rebuilds it',
					mv.schemaName, mv.name, mismatch);
				return false;
			}
			log('Recompiling materialized view %s.%s with existing backing PK (superkey check passed): %s',
				mv.schemaName, mv.name, mismatch);
		}
		// Name-stability gate. The recompile re-registers against the EXISTING backing, so
		// it is sound only when the re-derived body's output column NAMES still match the
		// backing's. `describeBackingShapeMismatch` is deliberately name-blind (it serves the
		// rename propagation's pure-positional-name-shift detection), so a column RENAME under
		// a `select *`-style body re-derives a name-blind-identical shape — keeping it live
		// here would leave the backing column under its OLD name. Decline so the
		// rename-propagation pass owns the backing rename (restoreUnaffectedMaterializedViews);
		// an explicit-column body naming the renamed column already declined upstream
		// (deriveBackingShape threw).
		if (shape.columns.some((c, i) => c.name.toLowerCase() !== (backing.columns[i]?.name ?? '').toLowerCase())) {
			log('Marking materialized view %s.%s stale instead of recompiling: re-derived output names shifted (a column rename) — the rename-propagation pass owns the backing rename',
				mv.schemaName, mv.name);
			return false;
		}
		// Content-stability gate. EMPTY for constraint-only / ADD / DROP / NOT NULL /
		// DEFAULT (no-op — exactly today's behavior); for an ALTER COLUMN type/collation
		// it proves the change is disjoint from every column the body reads (directly or
		// transitively through generated columns), else the backing content is unstable.
		const valueChanged = valueSemanticsChangedColumns(oldObject, newObject);
		if (valueChanged.size > 0) {
			const source = `${newObject.schemaName}.${newObject.name}`.toLowerCase();
			const read = referencedSourceColumns(db, mv.schemaName, bodySql, source);
			const collidingName = [...valueChanged].find(name => {
				const idx = newObject.columnIndexMap.get(name);
				return idx !== undefined && read.has(idx);
			});
			if (collidingName !== undefined) {
				log("Marking materialized view %s.%s stale instead of recompiling: a value-semantics ALTER (type/collation) on '%s' — a column the body reads — changes backing content; REFRESH re-derives",
					mv.schemaName, mv.name, collidingName);
				return false;
			}
			log('Recompiling materialized view %s.%s after a value-semantics ALTER (type/collation) on column(s) the body does not read (%s)',
				mv.schemaName, mv.name, [...valueChanged].join(', '));
		}
		db.registerMaterializedView(backing);
		log('Recompiled materialized view %s.%s in place after a genuine source change',
			mv.schemaName, mv.name);
		return true;
	} catch (e) {
		log('Marking materialized view %s.%s stale instead of recompiling after a genuine source change: %s',
			mv.schemaName, mv.name, e instanceof Error ? e.message : String(e));
		return false;
	}
}

/* ──────────────── identity-preserving refresh reshape ──────────────── */

/**
 * A single in-place reshape step expressed against the hosting module's
 * `alterTable` surface. The classifier emits these in execution order; the
 * executor lifts each onto a `SchemaChangeInfo` arm. Names are tracked
 * post-rename (the rename phase runs first), and every op addresses its column
 * by name, so the running index shift that add/drop induce never matters.
 *
 * `retype`, `recollate`, and `tightenNotNull` are the **data-validating** ops —
 * each can throw on the rows it touches (a non-convertible value → MISMATCH, a
 * unique collision under the new collation → CONSTRAINT, a NULL under the new
 * NOT NULL → CONSTRAINT). The classifier routes them into the plan's
 * post-reconcile batch so they validate the **reconciled body rows**, not the
 * about-to-be-discarded backing (see {@link ReshapePlan}). `rename`, `add`,
 * `loosenNotNull`, and `drop` never throw on data and stay pre-reconcile.
 */
type ReshapeColumnOp =
	| { kind: 'rename'; oldName: string; oldCol: ColumnSchema; newName: string }
	| { kind: 'add'; col: ColumnSchema }
	| { kind: 'retype'; name: string; newTypeName: string }
	| { kind: 'recollate'; name: string; collation: string }
	| { kind: 'loosenNotNull'; name: string }
	| { kind: 'tightenNotNull'; name: string }
	| { kind: 'drop'; name: string };

/**
 * An expressible in-place reshape, split into two batches by whether an op can
 * throw on the data it touches:
 *
 *  - `preReconcileOps` — the structural, data-lossless ops (`rename`, `add`,
 *    `loosenNotNull`, `drop`). These run BEFORE the data reconcile and only morph
 *    the schema; the pre-reconcile rows are about to be discarded by the rebuild.
 *  - `postReconcileOps` — the data-validating ops (`retype`, `recollate`,
 *    `tightenNotNull`). These run AFTER the reconcile so they validate the freshly
 *    re-derived body rows (which satisfy the new attribute) rather than the stale
 *    backing (which may not). Deferring them is what fixes the spurious
 *    MISMATCH/CONSTRAINT a narrowing reshape over stale data used to throw — see
 *    {@link reshapeBackingInPlace}.
 */
interface ReshapePlan {
	preReconcileOps: ReshapeColumnOp[];
	postReconcileOps: ReshapeColumnOp[];
}

type ReshapeClassification =
	| { expressible: true; plan: ReshapePlan }
	| { expressible: false; reason: string };

/**
 * Classifies the column-level delta old(`current`)→new(`shape`) for an
 * identity-preserving refresh reshape. **Expressible in place** — returns the
 * ordered module-op plan — iff the change is any combination of **trailing**
 * appended columns, dropped columns, positionally renamed columns, and per-column
 * attribute (type / collation / not-null) changes, with the surviving columns'
 * relative order preserved and the physical primary key unchanged. Otherwise
 * **inexpressible** (the caller raises a sited error and leaves the table
 * untouched):
 *
 *  - an **interleaving** reorder — a new column landing mid-table (the canonical
 *    `select *` body whose new source column lands before existing outputs):
 *    append-only `addColumn` cannot place it, and renaming survivors to fake it
 *    would silently re-map values;
 *  - a **physical-PK definition change** (column set, order, direction,
 *    collation, or a key column's type) — a maintained table's PK is its
 *    replicated row identity; silently re-keying it is the fatality drop+recreate
 *    was.
 *
 * Surviving columns are matched by **name** (case-insensitive — the only stable
 * identity a derived backing carries); a name absent on both sides at an aligned
 * position is a positional rename (the value-preserving trace
 * {@link renameShiftedBackingColumns} already uses). Shares the per-column
 * predicates with {@link describeBackingShapeMismatch} (the positional pure-name-
 * shift check) rather than re-implementing the column compare.
 *
 * The resulting plan is two-phase (see {@link ReshapePlan}): the structural,
 * data-lossless ops (`rename`/`add`/`loosenNotNull`/`drop`) go pre-reconcile; the
 * data-validating attribute shifts (`retype`/`recollate`) and every deferred
 * NOT NULL `tightenNotNull` go post-reconcile, so they validate the reconciled
 * body rows rather than the discarded backing.
 */
function classifyBackingReshape(current: TableSchema, shape: BackingShape): ReshapeClassification {
	const cur = current.columns;
	const sh = shape.columns;
	const curNames = new Set(cur.map(c => c.name.toLowerCase()));
	const shNames = new Set(sh.map(c => c.name.toLowerCase()));

	const renames: ReshapeColumnOp[] = [];
	const adds: ReshapeColumnOp[] = [];
	const loosens: ReshapeColumnOp[] = [];        // pre-reconcile: NOT NULL loosen never throws on data
	const drops: ReshapeColumnOp[] = [];
	const postReconcileOps: ReshapeColumnOp[] = []; // retype / recollate / tightenNotNull — validate the reconciled body
	// lower(oldName) → lower(newName), for the rename-aware PK comparison below.
	const renameMap = new Map<string, string>();

	// A survivor's attribute shift. The data-validating shifts (type/collation
	// retype, NOT NULL *tightening*) defer to the post-reconcile batch — the live
	// rows may still violate them, but the re-derived body rows will not. A NOT NULL
	// *loosening* never throws on data, so it stays pre-reconcile. `name` is the
	// column's post-rename (new) name.
	// NOTE: `retype` is queued before `recollate`, so a `TEXT COLLATE NOCASE` → `DATE`
	// reshape transits an illegal `DATE COLLATE NOCASE` shape between the two ops. Harmless
	// today — these lift straight onto `module.alterTable`, bypassing the engine-side
	// SET-DATA-TYPE collation guard (runtime/emit/alter-table.ts), and the following
	// `recollate` lands the legal final shape. It matters if either changes: if that guard
	// ever moves module-side the retype op starts failing, and on a store backend a crash
	// between the two ops leaves catalog DDL that does not re-parse. Fix then is the
	// differ's rule (schema-differ.ts `comparisonDomainAlters`): queue the collation change
	// first when its target is BINARY, after the retype otherwise.
	const recordAttrShift = (from: ColumnSchema, to: ColumnSchema, name: string): void => {
		if (!backingTypeMatches(from, to)) postReconcileOps.push({ kind: 'retype', name, newTypeName: to.logicalType.name });
		if (!backingCollationMatches(from, to)) postReconcileOps.push({ kind: 'recollate', name, collation: to.collation ?? 'BINARY' });
		if (!backingNotNullMatches(from, to)) {
			if (to.notNull === true) postReconcileOps.push({ kind: 'tightenNotNull', name });
			// An MV backing keeps its physical-PK columns NOT NULL (a backing policy — see
			// {@link isPhysicalPkColumn}), so skip the `loosenNotNull` op for a physical-PK
			// column of `current` (matched by its pre-rename name) rather than emitting a
			// loosening the backing must not take. Reached only when reshape is entered for SOME OTHER genuine
			// shape change coexisting with a PK-column loosening in the same refresh;
			// touch point #1 masks the loosening-only case before reshape. See the NOTE at
			// describeBackingShapeMismatch / computeBackingPrimaryKey (~line 236).
			else if (!isPhysicalPkColumn(current, from.name.toLowerCase())) {
				loosens.push({ kind: 'loosenNotNull', name });
			}
		}
	};

	let i = 0, j = 0;
	while (i < cur.length && j < sh.length) {
		const cc = cur[i], sc = sh[j];
		const cn = cc.name.toLowerCase(), sn = sc.name.toLowerCase();
		if (cn === sn) {
			recordAttrShift(cc, sc, sc.name);
			i++; j++;
		} else if (!shNames.has(cn) && !curNames.has(sn)) {
			// Aligned position, both names "extra" ⇒ positional rename cc → sc.
			renames.push({ kind: 'rename', oldName: cc.name, oldCol: cc, newName: sc.name });
			renameMap.set(cn, sn);
			recordAttrShift(cc, sc, sc.name);   // attr ops reference the post-rename name
			i++; j++;
		} else if (!shNames.has(cn)) {
			// cc's name is gone from the new shape ⇒ dropped; sc matches a later survivor.
			drops.push({ kind: 'drop', name: cc.name });
			i++;
		} else if (!curNames.has(sn)) {
			// A genuinely new column appearing before the current survivors are
			// exhausted ⇒ a mid-table insert, not a trailing append.
			return { expressible: false, reason: `new column '${sc.name}' lands mid-table (an interleaving reshape, not a trailing append)` };
		} else {
			// Both names exist on the opposite side but are not aligned here ⇒ a reorder/swap.
			return { expressible: false, reason: `columns '${cc.name}' and '${sc.name}' are reordered` };
		}
	}
	for (; i < cur.length; i++) {
		const cc = cur[i];
		if (!shNames.has(cc.name.toLowerCase())) drops.push({ kind: 'drop', name: cc.name });
		else return { expressible: false, reason: `column '${cc.name}' is reordered` };
	}
	for (; j < sh.length; j++) {
		const sc = sh[j];
		if (!curNames.has(sc.name.toLowerCase())) {
			// Added NULLABLE pre-reconcile (the reconcile fills it); any NOT NULL is
			// asserted post-reconcile against the filled rows, joining the tighten batch.
			adds.push({ kind: 'add', col: sc });
			if (sc.notNull === true) postReconcileOps.push({ kind: 'tightenNotNull', name: sc.name });
		} else {
			return { expressible: false, reason: `column '${sc.name}' is reordered` };
		}
	}

	const pkReason = describePhysicalPkChange(current, shape, renameMap);
	if (pkReason) return { expressible: false, reason: pkReason };

	// Pre-reconcile: the structural, data-lossless ops only (renames + adds before
	// drops, so a mid-sequence failure leaves a re-derivable state). The
	// data-validating attribute shifts + NOT NULL tightenings run post-reconcile
	// against the reconciled body, never the discarded backing.
	return {
		expressible: true,
		plan: {
			preReconcileOps: [...renames, ...adds, ...loosens, ...drops],
			postReconcileOps,
		},
	};
}

/**
 * Compares the live backing's physical primary key to the re-derived shape's
 * ({@link computeBackingPrimaryKey}) **by column name through the reshape's rename
 * map** — not by index, which add/drop shift. Any change to the key's column set,
 * order, direction, collation, or a key column's **type** makes the reshape
 * inexpressible: a maintained table's PK is its replicated row identity, and
 * re-keying replicated row identity in place is refused. Returns a reason string,
 * or null when the key is unchanged. (A renamed key column is *not* a key change —
 * the rename map carries its new name; but a renamed-*and*-retyped key column still
 * trips the type check, because the comparison is on the underlying column schemas,
 * whose type identity a rename does not change.)
 */
function describePhysicalPkChange(
	current: TableSchema,
	shape: BackingShape,
	renameMap: ReadonlyMap<string, string>,
): string | null {
	const shapePk = computeBackingPrimaryKey(shape);
	const currentPk = current.primaryKeyDefinition;
	if (currentPk.length !== shapePk.length) {
		return `primary-key column count ${currentPk.length} → ${shapePk.length}`;
	}
	for (let k = 0; k < shapePk.length; k++) {
		const curCol = current.columns[currentPk[k].index];
		const shCol = shape.columns[shapePk[k].index];
		const curName = renameMap.get(curCol.name.toLowerCase()) ?? curCol.name.toLowerCase();
		if (curName !== shCol.name.toLowerCase()) {
			return `primary-key column ${k} '${curCol.name}' → '${shCol.name}'`;
		}
		if (!backingTypeMatches(curCol, shCol)) {
			return `primary-key column ${k} '${curCol.name}' type ${curCol.logicalType.name} → ${shCol.logicalType.name}`;
		}
		if ((currentPk[k].desc === true) !== (shapePk[k].desc === true)) {
			return `primary-key column ${k} direction`;
		}
		const curColl = currentPk[k].collation ?? curCol.collation ?? 'BINARY';
		const shColl = shCol.collation ?? 'BINARY';
		if (curColl !== shColl) {
			return `primary-key column ${k} collation ${curColl} → ${shColl}`;
		}
	}
	return null;
}

/**
 * Lifts a {@link ReshapeColumnOp} onto the module's `SchemaChangeInfo` surface.
 * Never sets `ddl` — these are engine-internal backing reshapes, not statements the
 * application issued, and a module emits a schema-change event only for a call
 * carrying `ddl` (see `SchemaChangeInfo.ddl`), so every reshape stays silent on the
 * public schema channel.
 */
function reshapeOpToChange(op: ReshapeColumnOp): SchemaChangeInfo {
	switch (op.kind) {
		case 'rename':
			// Preserve the OLD column's attributes (type / not-null / collation / PK)
			// under the new name — attribute shifts ride separate alter ops.
			return { type: 'renameColumn', oldName: op.oldName, newName: op.newName, newColumnDefAst: backingColumnDef(op.oldCol, op.newName) };
		case 'add': {
			// Add NULLABLE: real values arrive with the reconcile, and any NOT NULL is
			// asserted post-reconcile so a non-empty backing never trips "ADD NOT NULL
			// without a default". An added column is never a PK column (a PK change is
			// inexpressible), so force non-PK in the lifted def.
			const nullable: ColumnSchema = { ...op.col, notNull: false, primaryKey: false, pkOrder: 0, pkDirection: undefined };
			return { type: 'addColumn', columnDef: backingColumnDef(nullable, op.col.name) };
		}
		case 'retype':
			return { type: 'alterColumn', columnName: op.name, setDataType: op.newTypeName };
		case 'recollate':
			return { type: 'alterColumn', columnName: op.name, setCollation: op.collation };
		case 'loosenNotNull':
			return { type: 'alterColumn', columnName: op.name, setNotNull: false };
		case 'tightenNotNull':
			return { type: 'alterColumn', columnName: op.name, setNotNull: true };
		case 'drop':
			return { type: 'dropColumn', columnName: op.name };
	}
}

/**
 * Rebuild a maintained-table catalog record from the backing module's post-reshape
 * `TableSchema`. `module.alterTable` returns ONLY the physical column shape — it
 * tracks neither the catalog-only `derivation` nor the catalog-only `tags`, so a
 * bare `{ ...moduleSchema, derivation }` graft silently drops the table's tags.
 * Graft both from the authoritative catalog record so a reshaping re-attach
 * preserves any tags a concurrent SET TAGS routed through ALTER MATERIALIZED VIEW
 * (and a refresh-driven reshape never wipes existing tags). A non-reshaping
 * re-attach keeps the whole record, tags included — this restores parity.
 */
function graftReshapedRecord(moduleSchema: TableSchema, source: MaintainedTableSchema): MaintainedTableSchema {
	return { ...moduleSchema, derivation: source.derivation, tags: source.tags };
}

/**
 * The column list a reshape is ABOUT TO land, for the declared-constraint scan that
 * runs mid-reshape ({@link validateDeclaredConstraintsOverContents}).
 *
 * A reshape's data-validating ops (`retype` / `recollate`) must run AFTER the data
 * reconcile — they convert/re-key STORED rows, so running them first would validate
 * the about-to-be-discarded contents and throw spuriously. But a SQL comparison
 * takes its type affinity and its collation from the column's DECLARED attributes,
 * so a scan against the live (pre-op) record evaluates a declared CHECK under the
 * attributes the reshape is replacing: `check (v < '9')` on a column moving
 * TEXT → INTEGER compares as text ('10' < '9' is true) and never as the numeric
 * comparison it is becoming. Previewing the attributes fixes the semantics without
 * moving a single op — the scan stays exactly where it was, still before the commit.
 *
 * Maps `live`'s columns onto `shape`'s **by name** (names and order already agree:
 * the reshape's pre-reconcile batch has applied every rename / add / drop before
 * either caller reaches this) and overrides only `logicalType` and `collation`.
 * Returns `undefined` when neither attribute shifts, so a reshape with no
 * `retype`/`recollate` — and every non-reshape path — behaves exactly as before.
 *
 * Deliberately NOT previewed:
 *  - **`notNull`.** The tighten-NOT-NULL op stays a post-reconcile module op and
 *    keeps validating there. Declaring `notNull` early would let the optimizer fold
 *    a nullability-sensitive CHECK into a vacuous pass — the same class of unsound
 *    folding the caller's constraint-stripped-clone swap exists to prevent.
 *  - **`defaultValue` and the generated-column attributes.** A reshape never moves
 *    them, so previewing them could only introduce drift.
 *
 * Physical-PK columns need no special handling: `describePhysicalPkChange` refuses
 * a reshape whose key column changes type or collation, so a previewed attribute
 * can never desynchronize the key encoding `assertRefreshRowsAreSet` or the host's
 * keyed diff rely on.
 *
 * NOTE: the scan sees the rebuilt values in their PRE-conversion physical form but
 * under the POST-conversion declared type. These agree in practice — the target
 * attribute is derived FROM the body's own output type, so the body already emits
 * values of the new type. A retype whose conversion genuinely rewrites the value
 * (a text → date canonicalization turning '2024-06-05T00:00:00Z' into '2024-06-05')
 * would have the CHECK see the un-normalized spelling. Not chased; revisit if a
 * value-rewriting conversion is ever added to the reshape's op set.
 *
 * NOTE: with the preview in place, a body emitting a value that does not conform to
 * its own declared output type now trips the physical-representation checker
 * (`QUEREUS_REPR_STRICT`) at this scan rather than sliding through. That is a
 * genuine defect surfacing at the earliest honest point, not a regression.
 *
 * NOTE: this RE-DERIVES the attribute shift from live-vs-shape rather than reading
 * `ReshapePlan.postReconcileOps`, which is the authoritative list of the `retype` /
 * `recollate` ops that will actually run. The two agree today because the
 * pre-reconcile structural ops preserve attributes exactly ({@link backingColumnDef}
 * carries type + collation through a rename, and an `add` lands the shape column's
 * own attributes), so every live-vs-shape shift has a queued op and vice versa. If a
 * structural op ever stops preserving an attribute, this would preview an attribute
 * no op lands and the scan would reject rows the finished reshape accepts — build the
 * preview from `postReconcileOps` then.
 */
function previewReshapedColumns(live: TableSchema, shape: BackingShape): readonly ColumnSchema[] | undefined {
	const byName = new Map(shape.columns.map(c => [c.name.toLowerCase(), c]));
	let shifted = false;
	const preview = live.columns.map(col => {
		const target = byName.get(col.name.toLowerCase());
		if (!target) return col;
		if (backingTypeMatches(col, target) && backingCollationMatches(col, target)) return col;
		shifted = true;
		return { ...col, logicalType: target.logicalType, collation: target.collation };
	});
	return shifted ? Object.freeze(preview) : undefined;
}

/**
 * The sited error a refresh raises when the re-derived body shape cannot be
 * reconciled onto the live maintained table in place — an interleaving column
 * reorder or a physical-PK definition change (or a host module without
 * `alterTable`). The table and its rows are left **untouched** and the derivation
 * stays `stale`, recoverable exactly as the message says. Replaces the former
 * silent drop+recreate: a maintained table's PK / positional identity is its
 * replicated row identity, so an incompatible reshape is an actionable error, not
 * a new incarnation.
 */
function inexpressibleReshapeError(schemaName: string, name: string, reason: string): QuereusError {
	return new QuereusError(
		`the derivation's output shape changed incompatibly with table '${schemaName}.${name}' (${reason}); `
			+ `alter the table to the new shape and re-attach, or drop and recreate`,
		StatusCode.ERROR,
	);
}

/**
 * Identity-preserving reshape of a maintained table whose re-derived body shape
 * shifted — the refresh path's replacement for the former drop+recreate. Classify
 * the column delta; an inexpressible delta (interleave / PK-definition change)
 * raises the sited error with the table untouched, an expressible one reshapes in
 * place. The shape-match fast path (`backingShapeMatches` ⇒ data-only
 * `rebuildBacking`) is the caller's and is untouched.
 */
export async function reshapeBacking(
	db: Database,
	mv: MaintainedTableSchema,
	shape: BackingShape,
): Promise<MaintainedTableSchema> {
	const classification = classifyBackingReshape(mv, shape);
	if (!classification.expressible) {
		throw inexpressibleReshapeError(mv.schemaName, mv.name, classification.reason);
	}
	return reshapeBackingInPlace(db, mv, shape, classification.plan);
}

/**
 * Executes an expressible in-place reshape in two phases around the data reconcile:
 *
 *   1. apply the **pre-reconcile** structural ops (renames/adds/loosens/drops) →
 *   2. re-register the reshaped (structural) schema + (shape-updated) derivation →
 *   3. data-reconcile via the shared {@link rebuildBacking} (re-run the body, swap
 *      contents) → 4. apply the **post-reconcile** data-validating ops
 *      (retype/recollate/tighten-NOT-NULL) → 5. re-register the final schema →
 *   6. fire one `table_modified`.
 *
 * The **same table incarnation throughout** — the backing-host instance stays
 * owned, no `table_removed`/`table_added` — so a replicated basis table's row
 * metadata survives; consumer maintained tables go stale via the single
 * `table_modified` and recover by their own refresh, exactly as for any source
 * alter. Returns the reshaped maintained table for the caller to re-register
 * maintenance on.
 *
 * **Why the data-validating ops defer.** A retype (physical convert), a recollate
 * (re-key + unique re-validate), and a NOT NULL tighten each scan the rows and
 * throw on a violation — but the pre-reconcile rows are about to be discarded by
 * step 3. Running them pre-reconcile would validate the stale backing (which may
 * still hold pre-narrowing values, e.g. an MV gone stale on an unrelated source
 * change whose data-fix was never maintained in) and spuriously throw a
 * MISMATCH/CONSTRAINT on a reshape the fresh body satisfies. Deferring them past
 * the reconcile validates the re-derived body rows instead. This is sound because
 * the reconcile's insert paths do NOT validate values against the column schema
 * (`MemoryTable.replaceBaseLayer` PK-extracts + inserts raw; the store backing-host
 * `replaceContents` puts serialized rows by keyed diff), so a body value conforming
 * to the NEW attribute enters the still-OLD-typed column unvalidated, and the
 * post-reconcile op then converts/re-keys/asserts the clean body data successfully.
 * The added-NULLABLE / deferred-tighten behavior for new NOT NULL columns is the
 * same mechanism (a non-empty backing never trips "ADD NOT NULL without a default").
 *
 * **Recoverability.** Only the data-lossless structural ops run before step 2's
 * `schema.addTable`, so the window in which the catalog schema and the module's
 * live schema could diverge on a partial failure no longer arises in practice. A
 * genuine post-reconcile throw (a body the new attribute still cannot satisfy)
 * happens AFTER the catalog is consistently re-registered with the reconciled body,
 * so the caller leaves the MV `stale` over a coherent, re-runnable table that
 * converges once the underlying data is fixed.
 */
async function reshapeBackingInPlace(
	db: Database,
	mv: MaintainedTableSchema,
	shape: BackingShape,
	plan: ReshapePlan,
): Promise<MaintainedTableSchema> {
	const sm = db.schemaManager;
	const schema = sm.getSchemaOrFail(mv.schemaName);
	const backing = schema.getTable(mv.name);
	if (!backing) {
		throw new QuereusError(
			`Internal error: maintained table '${mv.name}' not found during reshape`,
			StatusCode.INTERNAL,
		);
	}
	const module = requireVtabModule(backing);
	if (!module.alterTable) {
		throw inexpressibleReshapeError(mv.schemaName, mv.name,
			`its backing module '${backing.vtabModuleName}' does not support in-place ALTER`);
	}

	// Pre-reconcile structural ops (renames/adds/loosens/drops — none throw on data).
	// Each addresses its column by name, so the fresh schema each call returns need
	// not be threaded by index; track only the latest.
	let current: TableSchema = backing;
	for (const op of plan.preReconcileOps) {
		current = await module.alterTable(db, mv.schemaName, mv.name, reshapeOpToChange(op));
	}

	// Re-register the reshaped schema with the (shape-updated) derivation BEFORE the
	// reconcile, so `rebuildBacking` resolves the reshaped table from the catalog.
	// alterTable returns a fresh derivation-less TableSchema; carry the derivation.
	mv.derivation.logicalKey = shape.primaryKey;
	mv.derivation.coarsenedKey = shape.coarsenedKey;
	mv.derivation.ordering = shape.ordering;
	mv.derivation.sourceTables = shape.sourceTables;
	let live: MaintainedTableSchema = graftReshapedRecord(current, mv);
	schema.addTable(live);

	// Data reconcile: re-run the body and swap contents (the identity-preserving
	// data-only path — same host, same incarnation). The column preview lets that
	// path's declared-constraint scan resolve against the type/collation the
	// post-reconcile ops below will land, not the ones they replace.
	await rebuildBacking(db, live, previewReshapedColumns(live, shape));

	// Post-reconcile data-validating ops (retype / recollate / tighten NOT NULL): the
	// reconciled body rows satisfy the new attribute where the discarded backing
	// might not, so each validates the fresh data, not the stale rows. Re-register
	// the catalog after EACH op (not once after the loop): a data-validating op can
	// throw, and unlike the pre-reconcile batch the module schema mutates per op, so
	// a single post-loop register would leave the catalog behind the module — the
	// very catalog/module divergence this two-phase split exists to avoid — on a
	// partial throw. Per-op registration keeps the catalog tracking the module so a
	// mid-batch failure leaves a coherent, re-runnable table.
	//
	// These ops still run after step 3's rebuildBacking has validated + committed,
	// but the declared-CHECK/FK scan inside that step is no longer blind to them:
	// the `previewReshapedColumns` argument above hands it the type/collation each
	// `retype` / `recollate` here is about to land, so a constraint whose truth
	// flips under the new attribute (`v <> 'abc'` recollated BINARY → NOCASE over
	// 'ABC'; `v < '9'` retyped TEXT → INTEGER over '10') is rejected there, before
	// the commit, with nothing written. A tighten-NOT-NULL is deliberately NOT
	// previewed and keeps validating right here — see previewReshapedColumns.
	for (const op of plan.postReconcileOps) {
		current = await module.alterTable(db, mv.schemaName, mv.name, reshapeOpToChange(op));
		live = graftReshapedRecord(current, mv);
		schema.addTable(live);
	}

	// One engine-level event for the whole reshape: invalidate cached plans scanning
	// the table directly and cascade staleness to consumer MVs — table_modified, NOT
	// table_removed/added, since the incarnation is preserved.
	sm.getChangeNotifier().notifyChange({
		type: 'table_modified',
		schemaName: mv.schemaName,
		objectName: mv.name,
		oldObject: backing,
		newObject: live,
	});
	return live;
}

/**
 * Resolves the {@link BackingHost} for a materialized view's backing table via
 * the owning module's backing-host capability (`vtab/backing-host.ts`). INTERNAL
 * when the module lacks the capability or does not know the table — a backing
 * table is engine-created on a capability-checked module, so either is a bug.
 */
export function resolveBackingHost(db: Database, backingSchema: TableSchema): BackingHost {
	const module = requireVtabModule(backingSchema);
	if (!module.getBackingHost) {
		throw new QuereusError(
			`materialized view backing table '${backingSchema.name}' is owned by module `
				+ `'${backingSchema.vtabModuleName}', which does not implement the backing-host capability`,
			StatusCode.INTERNAL,
		);
	}
	const host = module.getBackingHost(db, backingSchema.schemaName, backingSchema.name);
	if (!host) {
		throw new QuereusError(
			`backing host not found for '${backingSchema.schemaName}.${backingSchema.name}'`,
			StatusCode.INTERNAL,
		);
	}
	return host;
}

/**
 * Lenient counterpart of {@link resolveBackingHost}: returns the backing host, or
 * `undefined` when the owning module cannot (yet) resolve one — instead of
 * throwing. Used at maintenance-PLAN-BUILD time (the create-time gate registration),
 * where the only use of the host is the host-conditional, default-inert
 * `requiresReplicableDerivations` gate. A module that materializes its durable
 * backing LATE in the attach flow (e.g. lamina's `ensureBackingForAttach`, which
 * runs after the gate registration) has no host yet at plan-build time; the host is
 * resolved for real at the reconcile, and the steady-state maintenance arms
 * re-resolve it per use. Skipping the replicable gate when the host is absent is
 * sound: a host that sets `requiresReplicableDerivations` (the synced-store flavor)
 * always exists by plan-build time, so the gate still binds it — the
 * eager-resolution invariant on {@link BackingHost.requiresReplicableDerivations}.
 *
 * That soundness rests on the invariant being honored, not on prose: a host that
 * BOTH demands replicable derivations AND defers its host to the late seam would
 * skip the gate here unnoticed. The attach core's defensive guard
 * ({@link attachMaintainedDerivation}) re-checks once the late host is in hand and
 * raises a loud INTERNAL error in exactly that case, so this lenient skip can never
 * silently let a non-replicable body through.
 */
export function tryResolveBackingHost(db: Database, backingSchema: TableSchema): BackingHost | undefined {
	const module = requireVtabModule(backingSchema);
	return module.getBackingHost?.(db, backingSchema.schemaName, backingSchema.name);
}

/**
 * Eagerly records the constraint↔structure link when this MV covers a UNIQUE
 * constraint on one of its single source tables. Runs the coverage prover
 * (`coverage-prover.ts`) over the optimized body and, on the first match, stamps
 * the MV's `origin`/`covers` reverse link and the constraint's
 * `coveringStructureName` forward pointer (the source of truth). Informational
 * in this ticket — nothing enforces through the MV's backing table yet.
 *
 * Best-effort and side-effect-bounded: the body has already planned (during
 * shape derivation), so re-planning here is cheap and safe; a non-covering MV
 * simply records nothing.
 */
export function linkCoveredUniqueConstraints(db: Database, mv: MaintainedTableSchema, bodySql: string): void {
	// The coverage prover reasons over the body's SOURCE table; suppress the
	// read-side rewrite so the body is not re-pointed at this MV's own backing.
	// Home-schema path: the body's unqualified names resolve next to the MV.
	const root = db.schemaManager.withSuppressedMaterializedViewRewrite(
		() => db.getPlan(bodySql, db._homeSchemaPath(mv.schemaName)).getRelations()[0],
	);
	if (!root) return;
	const sm = db.schemaManager;
	for (const qualified of mv.derivation.sourceTables) {
		const dot = qualified.indexOf('.');
		const schemaName = dot >= 0 ? qualified.slice(0, dot) : 'main';
		const tableName = dot >= 0 ? qualified.slice(dot + 1) : qualified;
		const table = sm.getTable(schemaName, tableName);
		if (!table || !table.uniqueConstraints) continue;
		for (const uc of table.uniqueConstraints) {
			const result = proveCoverage(root, mv, uc, table);
			if (result.covers) {
				mv.derivation.covers = { schemaName: table.schemaName, tableName: table.name, constraintName: uc.name };
				// Forward pointer is the source of truth (see docs/schema.md).
				uc.coveringStructureName = mv.name;
				return; // singular back-pointer: link the first covered constraint.
			}
		}
	}
}

/**
 * Clears the constraint↔structure link a covering MV established (drop path).
 * Matches on the forward pointer (`coveringStructureName === mv.name`) so it
 * works for unnamed constraints too; no enforcement demotion — physical schemas
 * still enforce via the implicit auto-index.
 */
export function unlinkCoveredUniqueConstraints(db: Database, mv: MaintainedTableSchema): void {
	if (!mv.derivation.covers) return;
	const table = db.schemaManager.getTable(mv.derivation.covers.schemaName, mv.derivation.covers.tableName);
	if (!table?.uniqueConstraints) return;
	for (const uc of table.uniqueConstraints) {
		if (uc.coveringStructureName === mv.name) uc.coveringStructureName = undefined;
	}
}

/** Re-validates a stale MV's body against the current source schemas. Throws the
 *  staleness diagnostic when the body no longer plans. Returns the optimized
 *  relational root on success. */
export function revalidateBody(db: Database, schemaName: string, mvName: string, bodySql: string): RelationalPlanNode {
	let root: RelationalPlanNode | undefined;
	try {
		// Re-validate the body against the SOURCE schemas; suppress the read-side
		// rewrite so it is not re-pointed at this MV's own backing. Home-schema
		// path: unqualified names resolve next to the MV, not the session path.
		root = db.schemaManager.withSuppressedMaterializedViewRewrite(
			() => db.getPlan(bodySql, db._homeSchemaPath(schemaName)).getRelations()[0],
		);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		throw new QuereusError(
			`materialized view '${mvName}' is stale; a source changed in an incompatible way — drop and recreate (${message})`,
			StatusCode.ERROR,
			e instanceof Error ? e : undefined,
		);
	}
	if (!root) {
		throw new QuereusError(
			`materialized view '${mvName}' is stale; a source changed in an incompatible way — drop and recreate`,
			StatusCode.ERROR,
		);
	}
	return root;
}

/* ──────────────── ALTER … RENAME propagation into MV bodies ──────────────── */

/**
 * Lowercased `schema.name` keys of every MV that is stale *right now*. The rename
 * emitters snapshot this BEFORE the statement's first schema-change notify, so the
 * propagation pass can distinguish "stale from this very rename statement" (safe to
 * clear after a successful in-place rewrite — no DML can interleave within the
 * statement) from "stale from an earlier un-refreshed change" (the backing may
 * already be behind — writes during staleness are not maintained — so only a
 * successful REFRESH may clear it).
 */
export function snapshotStaleMaterializedViews(db: Database): ReadonlySet<string> {
	const out = new Set<string>();
	for (const mv of db.schemaManager.getAllMaintainedTables()) {
		if (mv.derivation.stale) out.add(mvStaleKey(mv));
	}
	return out;
}

function mvStaleKey(mv: Pick<MaintainedTableSchema, 'schemaName' | 'name'>): string {
	return `${mv.schemaName}.${mv.name}`.toLowerCase();
}

/** All maintained tables registered in `schema`, snapshotted (the propagation
 *  loops re-register tables mid-iteration). */
function maintainedTablesOf(schema: Schema): MaintainedTableSchema[] {
	return Array.from(schema.getAllTables()).filter(isMaintainedTable);
}

/**
 * Rewrites every dependent materialized view in `schema` after a source TABLE
 * RENAME — the MV mirror of the plain-view loop in `propagateTableRenameInSchema`
 * ("MV ≡ faster view"): the caller calls this once per schema in the catalog with
 * `target` bound to THAT schema's home path, and the body `selectAst` is mutated
 * in place by the same `renameTableInAst` walker. An MV is
 * processed when its body AST changed, its `insert defaults` clause changed (an
 * expr subquery can name the renamed table even when the body doesn't), OR its
 * `sourceTables` carries the old base — the latter catches a body that reads the
 * renamed table *through a plain view* (the view's AST was rewritten by the view
 * loop, but this MV's own AST never names the table while its row-time plan is
 * still keyed under the old base).
 *
 * Per processed MV the derived fields are recomputed on a shallow clone
 * (`sourceTables` re-keyed old→new, `bodyHash`, regenerated `sql`, the `covers`
 * reverse link), then {@link applyMaterializedViewRewrite} re-registers row-time
 * maintenance / preserves pre-existing staleness and fires
 * `materialized_view_modified`. Failures mark the MV stale and propagation
 * continues — best-effort, like the rest of the rename propagation.
 */
export async function propagateTableRenameToMaterializedViews(
	db: Database,
	schema: Schema,
	preStale: ReadonlySet<string>,
	target: TableRenameTarget,
): Promise<void> {
	const { oldName, newName } = target;
	const schemaLower = target.schemaName.toLowerCase();
	const oldBase = `${schemaLower}.${oldName.toLowerCase()}`;
	const newBase = `${schemaLower}.${newName.toLowerCase()}`;
	for (const mv of maintainedTablesOf(schema)) {
		try {
			const d = mv.derivation;
			// The body walk also descends the trailing `with defaults (…)` clause
			// (now on `selectAst.defaults`), so a defaults-expr subquery naming the
			// renamed table flips `bodyChanged` even when the body never names it.
			const bodyChanged = renameTableInAst(d.selectAst, target);
			if (!bodyChanged && !d.sourceTables.includes(oldBase)) continue;
			const covers = d.covers
				&& d.covers.schemaName.toLowerCase() === schemaLower
				&& d.covers.tableName.toLowerCase() === oldName.toLowerCase()
				? { ...d.covers, tableName: newName }
				: d.covers;
			await applyMaterializedViewRewrite(db, schema, mv, {
				sourceTables: d.sourceTables.map(s => (s === oldBase ? newBase : s)),
				covers,
			}, preStale, /*renamedColumns*/ false);
		} catch (e) {
			failMaterializedViewRenamePropagation(db, schema, mv, e);
		}
	}
}

/**
 * Rewrites every dependent materialized view in `schema` after a source COLUMN
 * RENAME — the MV mirror of the plain-view loop in `propagateColumnRenameInSchema`
 * (called once per schema PER CASCADE ROUND — the target may be the renamed table
 * or a view/MV whose published names a prior round shifted, see
 * `column-rename-cascade.ts` — with that schema's resolver, same in-place
 * `renameColumnInAst` walk).
 * The body walk also descends the trailing `with defaults (…)` clause (now on
 * `selectAst.defaults`): the clause target is typically a projected-away NOT NULL
 * column the body never mentions, so its rewrite still flips `bodyChanged` and
 * forces the re-hash / regenerate-DDL / fire-event path. An MV the walk does not
 * touch that the schema-change listener marked stale (an unreferenced-column
 * rename, a `select *` body) is restored by the
 * {@link restoreUnaffectedMaterializedViews} pass the ALTER emitter runs after
 * all per-schema loops. A changed BODY can shift the MV's *exposed output names*
 * (a bare passthrough projection of the renamed column — plain-view parity),
 * which {@link applyMaterializedViewRewrite} carries onto the live backing table.
 */
export async function propagateColumnRenameToMaterializedViews(
	db: Database,
	schema: Schema,
	tableName: string,
	oldCol: string,
	newCol: string,
	preStale: ReadonlySet<string>,
	resolve: ResolveObjectRef,
	targetKey: string,
	resolveColumnInSource: ResolveColumnInSource,
): Promise<void> {
	for (const mv of maintainedTablesOf(schema)) {
		try {
			const d = mv.derivation;
			// `resolveColumnInSource` keeps the body walk scope-aware for a defaults-expr
			// subquery referencing a like-named column on its own FROM — plain-view /
			// differ-reconcile parity (see `renameColumnInAst`).
			const bodyChanged = renameColumnInAst(d.selectAst, tableName, oldCol, newCol, resolve, targetKey, 'none', resolveColumnInSource);
			if (!bodyChanged) continue;
			await applyMaterializedViewRewrite(db, schema, mv, {}, preStale, /*renamedColumns*/ true);
		} catch (e) {
			failMaterializedViewRenamePropagation(db, schema, mv, e);
		}
	}
}

/**
 * The per-MV core both rename propagations share. `mv.selectAst` — including its
 * trailing `with defaults (…)` clause — has already been rewritten in place;
 * `overrides` carries the recomputed catalog fields — `sourceTables` / `covers`
 * (table rename). The remaining derived fields are recomputed on a shallow clone
 * (mirroring the tag setters — `oldObject` in the event shares the rewritten AST,
 * only the derived fields differ) and swapped into the catalog. The `bodyHash`
 * and regenerated `sql` both read the rewritten body (defaults included), so they
 * agree with each other and with what the differ recomputes from the post-rename
 * declared form; the `materialized_view_modified` → store re-persist path
 * round-trips the new name.
 *
 * Staleness discipline: `stale` means the row-time plan was released and the
 * backing may already be BEHIND, so a flag that predates this statement is never
 * cleared — the body/sql/hash/sources are still rewritten (a later REFRESH then
 * resolves the new name; today it cannot), but maintenance is NOT re-registered
 * and the backing columns are NOT renamed (refresh's shape-mismatch rebuild owns
 * that). An MV that was live before the statement is fully restored: backing
 * column names follow the body's output names (column rename only), row-time
 * maintenance re-plans against the already-renamed catalog (re-keying the
 * source-base index, recomputing `sourceScope`), and the staleness this very
 * statement's events set is cleared — no DML can interleave within the statement,
 * so the backing cannot be behind.
 */
async function applyMaterializedViewRewrite(
	db: Database,
	schema: Schema,
	mv: MaintainedTableSchema,
	overrides: Partial<Pick<TableDerivation, 'sourceTables' | 'covers'>>,
	preStale: ReadonlySet<string>,
	renamedColumns: boolean,
): Promise<void> {
	const wasPreStale = preStale.has(mvStaleKey(mv));
	const d = mv.derivation;
	const bodySql = astToString(d.selectAst);
	if (overrides.sourceTables) d.sourceTables = overrides.sourceTables;
	if ('covers' in overrides) d.covers = overrides.covers;
	// Canonical-definition hash (columns + body — the body string carries the
	// rewritten `with defaults (…)` clause) — must match the formula stamped at
	// create / recomputed by the differ, or every post-rename diff would churn a
	// spurious rebuild. `bodySql` also feeds renameShiftedBackingColumns below. The
	// DDL itself is rendered on demand from the unified record, so no stored `sql`.
	d.bodyHash = computeBodyHash(viewDefinitionToCanonicalString(d.columns, d.selectAst));

	if (!wasPreStale) {
		// Only a changed BODY can shift output names; a table rename / clause-only
		// change skips the backing-name pass (no re-plan needed).
		await restoreMaterializedViewLive(db, schema, mv, renamedColumns ? { bodySql } : undefined);
	}
	// Fired for still-stale MVs too: the rewritten body must re-persist so a
	// post-reopen REFRESH resolves the new name. The registered table object is
	// re-fetched — the backing-name pass may have swapped it.
	const live = schema.getTable(mv.name) ?? mv;
	db.schemaManager.getChangeNotifier().notifyChange({
		type: 'materialized_view_modified',
		schemaName: mv.schemaName,
		objectName: mv.name,
		oldObject: mv,
		newObject: live,
	});
}

/**
 * The shared restore tail both per-MV restore paths run — the changed-AST rewrite
 * ({@link applyMaterializedViewRewrite}) and the provably-unaffected restoration
 * pass ({@link restoreUnaffectedMaterializedViews}) — so the restore discipline
 * cannot drift between them: carry any body output-name shift onto the live
 * backing (`backingNames` present), re-register row-time maintenance, and only
 * then clear `stale`.
 *
 * `backingNames` is absent when the body's output names provably did not move (a
 * table rename / clause-only change), skipping the backing-name pass and its body
 * re-plan; when present, `shape` short-circuits the re-derivation for a caller
 * that already planned the body.
 */
async function restoreMaterializedViewLive(
	db: Database,
	schema: Schema,
	mv: MaintainedTableSchema,
	backingNames?: { bodySql: string; shape?: BackingShape },
): Promise<void> {
	if (backingNames) {
		await renameShiftedBackingColumns(db, schema, mv, backingNames.bodySql, backingNames.shape);
	}
	// Re-register BEFORE clearing `stale`: if registration throws, the caller's
	// failure path leaves the MV stale rather than serving an unmaintained backing.
	// Register the LIVE registered table (the backing-name pass may have swapped
	// the catalog object); the shared derivation rides either way.
	const live = schema.getTable(mv.name);
	db.registerMaterializedView(isMaintainedTable(live) ? live : mv);
	mv.derivation.stale = false;
}

/**
 * Restores every dependent MV that THIS rename statement marked stale but the
 * rename provably did not affect. Runs once at the end of the table-/column-rename
 * propagation, after all per-schema loops — so every body rewrite, backing-column
 * rename, and cascade event has already fired and the catalog is fully renamed.
 *
 * The schema-change listener marks **every** MV whose `sourceTables` includes a
 * `table_modified` table stale (and detaches its row-time plan), but the rename
 * propagation only restores MVs it processes (changed AST / clause, or — table
 * rename — `sourceTables` carrying the old base). An MV the rename does not touch
 * fell through stale-but-valid: reads silently served the now-unmaintained backing
 * and writes never propagated until a manual REFRESH. Three concrete shapes: a
 * column rename the body never references; a rename whose only effect on another
 * source is a constraint rewrite (e.g. an FK `references` target) firing that
 * source's `table_modified`; and a `select *` body whose output is a pure name
 * shift (the AST is unchanged, so the body rewrite never sees it).
 *
 * Per candidate (`stale` now, not stale at the pre-statement snapshot — a
 * pre-existing flag means the backing may be BEHIND and only REFRESH may clear it):
 * re-derive the backing shape from the body against the renamed catalog; a
 * **structural** mismatch is not a rename no-op → leave stale (REFRESH's
 * shape-mismatch rebuild owns it); otherwise run the shared restore tail —
 * {@link renameShiftedBackingColumns} carries a pure name shift onto the live
 * backing (no-op when names already match; its backing `table_modified`
 * deliberately cascades staleness to chained MVs referencing the old output name),
 * then re-register row-time maintenance and clear `stale`.
 *
 * Deliberately fires NO `materialized_view_modified`: the MV record (AST, hash,
 * sql, sourceTables) is unchanged here — `stale` is runtime state, not persisted.
 * Walks all schemas (the listener marks cross-schema dependents too), in creation
 * order — topological for same-schema MV chains, so a producer restores before its
 * consumer is examined. A chained MV normally follows a producer's shifted output
 * name through the cascade driver's later rounds (`column-rename-cascade.ts`); one
 * whose body still references a renamed-away name (a mid-statement rewrite
 * failure) fails shape derivation here and stays stale.
 *
 * NOTE: the walk is schema-by-schema, then creation order WITHIN a schema, so a
 * CROSS-schema MV chain is only topological when the producer's schema is iterated
 * first. Harmless today — a consumer whose body does not itself name the renamed
 * object is skipped by the propagation entirely and only ever reaches this pass, and
 * a producer whose own NAME did not change re-plans fine either way (verified for
 * both verbs in `test/schema/rename-cross-schema.spec.ts`). If a producer's output
 * names can shift while its consumer lives in an earlier-iterated schema, this pass
 * needs a topological order (or a second round) rather than catalog order.
 *
 * Best-effort like the rest of the propagation: a per-MV failure logs, leaves that MV
 * stale, and continues.
 *
 * NOTE: firing no `materialized_view_modified` is deliberate, but
 * {@link renameShiftedBackingColumns} (run from the shared restore tail) DOES change the
 * backing column names — and those names ARE part of the persisted DDL
 * (`generateMaintainedTableDDL` renders the declared column list). So a `select *`
 * materialized view's persisted column list goes stale after any source column rename,
 * clean or not; the rename pre-flight in `schema/catalog-persistability.ts` cannot see it
 * either, because the body AST never changes. Harmless today: reopen re-derives an
 * IMPLICIT MV's shape from its body and reshapes (verified — persisted `("id","x")` with
 * body `select * from m` rehydrates as `("id","y")` with no error). If implicit MVs ever
 * stop reshaping on import, this becomes real durable drift and this pass needs an event.
 */
export async function restoreUnaffectedMaterializedViews(
	db: Database,
	preStale: ReadonlySet<string>,
): Promise<void> {
	for (const mv of db.schemaManager.getAllMaintainedTables()) {
		if (!mv.derivation.stale || preStale.has(mvStaleKey(mv))) continue;
		try {
			const schema = db.schemaManager.getSchemaOrFail(mv.schemaName);
			const d = mv.derivation;
			const bodySql = astToString(d.selectAst);
			// Throws when the body no longer plans against the renamed catalog
			// (e.g. a chained MV referencing a renamed-away output name) → catch
			// below leaves it stale.
			const shape = deriveBackingShape(db, mv.schemaName, bodySql, d.columns,
				{ moduleName: mv.vtabModuleName, moduleArgs: mv.vtabArgs, against: schema.getTable(mv.name) });
			// The retry of a failure-marked MV must not revive an inconsistent record: a
			// rewrite that threw between the in-place AST mutation and the derived-field
			// re-key leaves the OLD derivation (un-re-keyed `sourceTables`) holding the
			// rewritten body. Registering that would compute `sourceScope` (and key the
			// read-side rewrite) off the wrong bases — leave it stale instead.
			if (!sameSourceTables(d.sourceTables, shape.sourceTables)) {
				log('Leaving materialized view %s.%s stale after rename: recorded sourceTables disagree with the re-planned body — REFRESH recovers',
					mv.schemaName, mv.name);
				continue;
			}
			const backing = schema.getTable(mv.name);
			if (!backing) {
				throw new QuereusError(
					`Internal error: maintained table '${mv.name}' not found during restore`,
					StatusCode.INTERNAL,
				);
			}
			const mismatch = describeBackingShapeMismatch(backing, shape);
			if (mismatch) {
				log('Leaving materialized view %s.%s stale after rename: backing shape mismatch (%s) — REFRESH rebuilds it',
					mv.schemaName, mv.name, mismatch);
				continue;
			}
			await restoreMaterializedViewLive(db, schema, mv, { bodySql, shape });
		} catch (e) {
			log('Could not restore materialized view %s.%s after rename; leaving it stale: %s',
				mv.schemaName, mv.name, e instanceof Error ? e.message : String(e));
		}
	}
}

/** Set-equality over qualified (already-lowercased) source-table lists. Order is
 *  irrelevant — both sides come from `collectSourceTables`' Set walk. */
function sameSourceTables(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
	if (a.length !== b.length) return false;
	const set = new Set(a);
	return b.every(s => set.has(s));
}

/**
 * Carries a column-rename-induced output-name shift onto the MV's live backing
 * table. The backing's column names were derived from the body's output names at
 * create ({@link deriveBackingShape}); after the body rewrite a bare passthrough
 * projection of the renamed column exposes the NEW name, so the backing follows —
 * positionally, data-preserving, via the host module's own `alterTable` (a host
 * without `alterTable` throws UNSUPPORTED and the caller's failure path leaves
 * the MV stale). Explicit-column MVs (`mv(a, b)`) and
 * expression-aliased outputs produce no mismatch and no-op. Any structural
 * difference (count / types / PK) is NOT a rename outcome — throw so the caller's
 * failure path leaves the MV stale rather than rebuilding data here.
 *
 * The backing `table_modified` fired on a real rename deliberately cascades to
 * the manager's listener (a chained MV referencing the OLD output name is marked
 * stale), and cached plans scanning the backing directly recompile against the
 * new names. Within a RENAME COLUMN statement that staleness is transient: the
 * cascade driver (`column-rename-cascade.ts`) re-runs the propagation with this
 * MV as the target, so the chained body is rewritten and restored in a later
 * round — the staleness diagnostic remains only for a body the cascade could not
 * rewrite (a mid-statement failure).
 */
async function renameShiftedBackingColumns(
	db: Database,
	schema: Schema,
	mv: MaintainedTableSchema,
	bodySql: string,
	preDerivedShape?: BackingShape,
): Promise<void> {
	const shape = preDerivedShape ?? deriveBackingShape(db, mv.schemaName, bodySql, mv.derivation.columns,
		{ moduleName: mv.vtabModuleName, moduleArgs: mv.vtabArgs, against: schema.getTable(mv.name) });
	const backing = schema.getTable(mv.name);
	if (!backing) {
		throw new QuereusError(
			`Internal error: maintained table '${mv.name}' not found during backing-column rename`,
			StatusCode.INTERNAL,
		);
	}
	const mismatch = describeBackingShapeMismatch(backing, shape);
	if (mismatch) {
		throw new QuereusError(
			`materialized view '${mv.schemaName}.${mv.name}': source column rename shifted the body's backing shape structurally (beyond a pure name shift): ${mismatch}`,
			StatusCode.INTERNAL,
		);
	}
	const module = requireVtabModule(backing);
	let current = backing;
	for (let i = 0; i < shape.columns.length; i++) {
		const liveCol = current.columns[i];
		const newName = shape.columns[i].name;
		if (liveCol.name.toLowerCase() === newName.toLowerCase()) continue;
		if (!module.alterTable) {
			throw new QuereusError(
				`module for backing table '${backing.name}' does not support ALTER TABLE`,
				StatusCode.UNSUPPORTED,
			);
		}
		current = await module.alterTable(db, mv.schemaName, backing.name, {
			type: 'renameColumn',
			oldName: liveCol.name,
			newName,
			newColumnDefAst: backingColumnDef(liveCol, newName),
		});
	}
	if (current !== backing) {
		// The module's alterTable returns a fresh TableSchema that does NOT carry
		// the derivation or the catalog-only tags — re-graft both so the registered
		// record stays maintained and keeps its tags.
		const renamed: TableSchema = graftReshapedRecord(current, mv);
		schema.addTable(renamed);
		db.schemaManager.getChangeNotifier().notifyChange({
			type: 'table_modified',
			schemaName: mv.schemaName,
			objectName: backing.name,
			oldObject: backing,
			newObject: renamed,
		});
	}
}

/** Minimal ColumnDef AST for a backing-column rename. Backing columns carry only
 *  type / not-null / PK / collation — never defaults or generated expressions
 *  (see {@link buildBackingTableSchema}) — so the lift is total. */
function backingColumnDef(col: ColumnSchema, newName: string): AST.ColumnDef {
	const constraints: AST.ColumnDef['constraints'] = [col.notNull ? { type: 'notNull' } : { type: 'null' }];
	if (col.primaryKey) constraints.push({ type: 'primaryKey', direction: col.pkDirection });
	if (col.collation && col.collation !== 'BINARY') constraints.push({ type: 'collate', collation: col.collation });
	return { name: newName, dataType: col.logicalType.name, constraints };
}

/**
 * Failure path for one MV's rename rewrite: whatever partial state the rewrite
 * reached (AST possibly mutated, catalog record possibly swapped), the MV must not
 * keep serving its backing as if live — force-mark it stale, release its row-time
 * plan, and invalidate cached backing reads so the next reference re-hits the
 * build-time stale guard. A pre-existing stale flag is unaffected (it is never
 * cleared here). The caller continues with the remaining MVs.
 */
function failMaterializedViewRenamePropagation(
	db: Database,
	schema: Schema,
	mv: MaintainedTableSchema,
	cause: unknown,
): void {
	log('Rename propagation failed for materialized view %s.%s; leaving it stale: %s',
		mv.schemaName, mv.name, cause instanceof Error ? cause.message : String(cause));
	// A swap may or may not have landed before the throw — mark whichever object
	// the catalog currently holds (the shared derivation rides either).
	const live = schema.getTable(mv.name);
	db.markMaterializedViewStale(isMaintainedTable(live) ? live : mv);
}
