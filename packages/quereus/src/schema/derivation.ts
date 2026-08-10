import type * as AST from '../parser/ast.js';
import type { ChangeScope } from '../planner/analysis/change-scope.js';
import type { CoarsenedKeyInfo } from './view.js';
import type { TableSchema } from './table.js';

/**
 * The optional maintenance contract attached to a {@link TableSchema}: a table
 * carrying a derivation is a **maintained table** — what `create materialized
 * view` produces. One `TableSchema`, one catalog name, one physical incarnation;
 * the derivation records how the table's contents are derived from its sources
 * and is kept consistent by the row-time maintenance manager
 * (`core/database-materialized-views.ts`).
 *
 * Identity (name/schema), storage (module/args), tags, and the physical primary
 * key all live on the owning `TableSchema`; the canonical
 * `create materialized view` DDL is rendered on demand from the unified record
 * (`generateMaintainedTableDDL`). The derivation object is shared by reference
 * across catalog swaps of the owning table (tag updates, index appends), so its
 * runtime state (`stale`, `sourceScope`) survives those swaps.
 */
export interface TableDerivation {
	/** The parsed body AST — any relation-producing QueryExpr (SELECT / VALUES / compound). */
	selectAst: AST.QueryExpr;
	/**
	 * Explicit output-column rename list from the MV-sugar form (`mv(a, b)`).
	 * Retained verbatim for bodyHash parity and DDL round-trip; the table's own
	 * columns are the authoritative output names.
	 */
	columns?: ReadonlyArray<string>;
	/**
	 * `computeBodyHash(viewDefinitionToCanonicalString(columns, selectAst))` — the
	 * canonical DEFINITION hash the declarative differ compares to detect
	 * "definition changed → rebuild". The body string carries any trailing
	 * `with defaults (…)` clause, so a defaults-only edit drifts the hash.
	 */
	bodyHash: string;
	/**
	 * The body's logical key, derived from `keysOf` on the optimized body
	 * (formerly `MaterializedViewSchema.primaryKey`). The table's own
	 * `primaryKeyDefinition` stays the physical (order-by-seeded) key.
	 */
	logicalKey: ReadonlyArray<{ index: number; desc: boolean }>;
	/** Body ordering captured from the optimized body (for the materialized-index path). */
	ordering?: ReadonlyArray<{ index: number; desc: boolean }>;
	/**
	 * Present when the table's key is a collation-coarsened lineage key
	 * ({@link CoarsenedKeyInfo}) — colliding source rows last-write-win until
	 * merged. Informational; recomputed wherever the backing shape is re-derived,
	 * never serialized.
	 */
	coarsenedKey?: CoarsenedKeyInfo;
	/** Qualified (lowercased `schema.table`) names of the source tables the body reads. */
	sourceTables: ReadonlyArray<string>;
	/**
	 * Staleness flag set by the schema-change subscription when a source table is
	 * modified/removed in a way that may break the body. Runtime state, never
	 * serialized.
	 */
	stale?: boolean;
	/**
	 * Cached source-union change-scope, computed at registration
	 * (`MaterializedViewManager.registerMaterializedView`). A `select` from this
	 * table substitutes this scope so a `Database.watch` fires on a *source*
	 * mutation (the table is maintained off the user change log). Runtime state,
	 * never serialized.
	 */
	sourceScope?: ChangeScope;
	/**
	 * Back-pointer to the UNIQUE constraint this covering structure realizes,
	 * recorded eagerly when the coverage prover recognizes coverage. The
	 * authoritative link is the constraint's `coveringStructureName` forward
	 * pointer (see `docs/schema.md`); this is the convenience reverse link.
	 */
	covers?: { schemaName: string; tableName: string; constraintName?: string };
}

/** A {@link TableSchema} that carries a derivation — a maintained table. */
export type MaintainedTableSchema = TableSchema & { derivation: TableDerivation };

/** Narrowing guard: true iff `table` is a maintained table (carries a derivation). */
export function isMaintainedTable(table: TableSchema | undefined): table is MaintainedTableSchema {
	return table?.derivation !== undefined;
}

/**
 * The {@link import('../planner/mutation/propagate.js').MutableViewLike}
 * structural shape for a maintained table, so DML naming it routes through the
 * same view-mutation rewrite a plain view uses (write-through to the body's
 * source). The rewrite reads only name / schemaName / selectAst / columns /
 * tags — any omitted-insert defaults ride inside `selectAst.defaults`.
 */
export function maintainedTableViewLike(table: MaintainedTableSchema): {
	readonly name: string;
	readonly schemaName: string;
	readonly selectAst: AST.QueryExpr;
	readonly columns?: ReadonlyArray<string>;
	readonly tags?: TableSchema['tags'];
	readonly noun?: string;
} {
	return {
		name: table.name,
		schemaName: table.schemaName,
		selectAst: table.derivation.selectAst,
		columns: table.derivation.columns,
		tags: table.tags,
		// Body-shape rejection diagnostics name the target by its kind (see
		// MutableViewLike.noun) so an unsupported-body MV reject reads
		// "materialized view 'm'", not "view 'm'".
		noun: 'materialized view',
	};
}
