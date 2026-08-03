import type * as AST from '../parser/ast.js';
import type { SqlValue } from '../common/types.js';
import type { TableSchema } from './table.js';
import { fnv1aHash, toBase64Url } from '../util/hash.js';

/**
 * Represents the schema definition of a database view.
 * Views are stored SELECT statements that act like virtual tables.
 */
export interface ViewSchema {
	/** The name of the view */
	name: string;
	/** The name of the schema this view belongs to (e.g., 'main') */
	schemaName: string;
	/** The original SQL text used to create the view */
	sql: string;
	/**
	 * The parsed body AST that defines the view's logic. Any relation-producing
	 * QueryExpr (SELECT / VALUES). DML bodies (INSERT/UPDATE/DELETE with
	 * RETURNING) are rejected at view-creation time because a view body
	 * re-evaluates on every reference — replaying a write per read is incoherent
	 * with view semantics.
	 */
	selectAst: AST.QueryExpr;
	/** Columns explicitly defined in CREATE VIEW (e.g., CREATE VIEW v(a,b) AS...) */
	columns?: ReadonlyArray<string>; // Optional list of explicitly named columns
	/** Arbitrary metadata tags (informational only, does not affect behavior or hashing) */
	tags?: Readonly<Record<string, SqlValue>>;
}

/**
 * Narrowing guard: true iff `item` is a view (not a table / maintained table).
 * A view carries a top-level `selectAst`; a `TableSchema` does not — a
 * maintained table's body hangs off `derivation.selectAst` instead.
 *
 * NOTE: structural, not a tagged union. If `TableSchema` ever gains a top-level
 * `selectAst`, every caller silently misclassifies tables as views — add a
 * discriminant field to both schemas then rather than picking another key.
 */
export function isViewSchema(item: TableSchema | ViewSchema | undefined): item is ViewSchema {
	return item !== undefined && 'selectAst' in item;
}

/**
 * Read the trailing `with defaults (col = expr, …)` clause off a view /
 * derivation body — per-column omitted-insert defaults for write-through, now
 * stored inside the body select AST ({@link AST.SelectStmt.defaults}). Only a
 * SELECT body carries it; a VALUES (or other) body has none. Consumed by the
 * insert write-through rewrite (step 5 of the insert-defaulting precedence chain
 * — docs/vu-inverses.md § View defaults) and by `view_info`'s
 * insertability derivation.
 */
export function bodyDefaults(body: AST.QueryExpr): ReadonlyArray<AST.ViewInsertDefault> | undefined {
	return body.type === 'select' ? body.defaults : undefined;
}

/**
 * Describes a materialized view whose backing key is **collation-coarser** than
 * the source primary key it derives from — the parallel-migration-table shape
 * (`docs/migration.md` § Convergence hazards): the body has no provable unique
 * key, so the backing was keyed on the coarsened lineage key K' (see
 * `planner/analysis/coarsened-key.ts`), and colliding source rows
 * last-write-win until they are merged. Stamped alongside the create-time
 * key-coarsening warning; purely informational (recomputed at create / import /
 * refresh shape-rebuild from the body — never serialized into DDL).
 */
export interface CoarsenedKeyInfo {
	/** Backing/output column names forming the coarsened key, in key order. */
	readonly columns: readonly string[];
	/** The columns whose collation weakened, with the source → output collations. */
	readonly weakened: ReadonlyArray<{
		readonly column: string;
		readonly sourceCollation: string;
		readonly outputCollation: string;
	}>;
}

// NOTE: the former `MaterializedViewSchema` dual-registration record is gone.
// A materialized view is now a single `TableSchema` (named as the user named
// it) carrying an optional maintenance contract — see `schema/derivation.ts`
// (`TableDerivation` / `MaintainedTableSchema`). Every maintained table is
// **row-time maintained**: kept consistent synchronously with each source
// row-write (see `core/database-materialized-views.ts`).

/**
 * Normalized backing-module identity for a materialized view's
 * `using <module>(...)` clause. `moduleName` is the name to RESOLVE (default
 * applied, `mem` aliased, lowercased); `storedModuleName`/`storedModuleArgs`
 * are what the schema RECORDS — absent for the memory default with no args,
 * so an explicit `using memory()` and an omitted clause produce one identical
 * schema record, identical generated DDL, and no differ churn between the two
 * spellings. Explicit `using memory(...)` with non-empty args is the one case
 * that still records (and round-trips) the clause.
 */
export interface NormalizedBackingModule {
	moduleName: string;
	storedModuleName?: string;
	storedModuleArgs?: Readonly<Record<string, SqlValue>>;
}

/** Normalizes a declared backing-module name: absent ⇒ `'memory'`; `mem` is an
 *  alias for `memory`; lowercased (module registration is case-insensitive). */
export function normalizeBackingModuleName(name: string | undefined): string {
	const lower = (name ?? 'memory').toLowerCase();
	return lower === 'mem' ? 'memory' : lower;
}

/** Applies the backing-module normalization decision — single source of truth
 *  shared by the create builder and the catalog-import path. */
export function normalizeBackingModule(
	moduleName: string | undefined,
	moduleArgs: Readonly<Record<string, SqlValue>> | undefined,
): NormalizedBackingModule {
	const name = normalizeBackingModuleName(moduleName);
	const args = moduleArgs && Object.keys(moduleArgs).length > 0 ? Object.freeze({ ...moduleArgs }) : undefined;
	if (name === 'memory' && !args) return { moduleName: name };
	return { moduleName: name, storedModuleName: name, storedModuleArgs: args };
}

/**
 * Stable (sorted-key) canonical render of a backing-module args record — the
 * comparison key for the args half of the backing-module identity. The
 * declarative differ compares this separately from `bodyHash` (the module is
 * deliberately NOT folded into the hash formula, which would spuriously
 * rebuild every already-persisted MV). Empty/absent renders ''.
 */
export function canonicalBackingModuleArgs(args: Readonly<Record<string, SqlValue>> | undefined): string {
	if (!args) return '';
	return Object.keys(args).sort().map(k => `${k}=${renderBackingArgValue(args[k])}`).join(',');
}

function renderBackingArgValue(v: SqlValue): string {
	if (v === null || v === undefined) return 'null';
	if (typeof v === 'string') return JSON.stringify(v);
	if (v instanceof Uint8Array) return `x'${Array.from(v, b => b.toString(16).padStart(2, '0')).join('')}'`;
	return String(v); // number | bigint | boolean — distinct from the quoted string render
}

/**
 * Canonical definition hash for a materialized view:
 * `toBase64Url(fnv1aHash(...))` over the canonical DEFINITION string supplied
 * by the caller — `viewDefinitionToCanonicalString(columns, selectAst)`, i.e.
 * the explicit column list + the body's canonical SQL (which itself carries any
 * trailing `with defaults (…)` clause — NOT a plan-structure serialization,
 * which embeds unstable node ids). Stable per definition; changes when any
 * definitional part changes, including a defaults-only edit.
 *
 * Single source of truth shared by MV creation / the rename-propagation
 * rewrite (which stamp `TableDerivation.bodyHash`) and the declarative-schema
 * differ (which recomputes it from a declared MV to detect "definition changed
 * → rebuild"). All sides MUST hash the same canonical form, so they call this
 * one function over that one renderer.
 */
export function computeBodyHash(canonicalDefinition: string): string {
	return toBase64Url(fnv1aHash(canonicalDefinition));
}
