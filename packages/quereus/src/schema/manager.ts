import { Schema, type SchemaKind } from './schema.js';
import { normalizeCollationName } from '../util/comparison.js';
import type { IntegrityAssertionSchema } from './assertion.js';
import type { Database } from '../core/database.js';
import type { TableSchema, RowConstraintSchema, IndexSchema, IndexColumnSchema, MutationContextDefinition, ForeignKeyConstraintSchema, UniqueConstraintSchema } from './table.js';
import type { FunctionSchema } from './function.js';
import { quereusError, QuereusError, RelationNotFoundError } from '../common/errors.js';
import { StatusCode, type SqlValue } from '../common/types.js';
import type { AnyVirtualTableModule, BaseModuleConfig } from '../vtab/module.js';
import type { VirtualTable } from '../vtab/table.js';
import type { ColumnSchema } from './column.js';
import { buildColumnIndexMap, columnDefToSchema, findPKDefinition, opsToMask, mutationContextVarToSchema, extractGeneratedColumnDependencies, topoSortGeneratedColumns, requireVtabModule, resolveNamedConstraintClass, appendIndexToTableSchema, collectDeclaredConstraintNames, disambiguateAutoConstraintName } from './table.js';
import { buildUniqueConstraintSchema, buildForeignKeyConstraintSchema, validateForeignKeyCollations } from './constraint-builder.js';
import type { ViewSchema } from './view.js';
import { normalizeBackingModule } from './view.js';
import { isMaintainedTable, type MaintainedTableSchema, type TableDerivation } from './derivation.js';
import { isHiddenImplicitIndex, isImplicitCoveringIndex, findExposedImplicitConstraintIndex, assertNoDuplicateUniqueConstraints, assertNoDuplicateConstraintNames } from './catalog.js';
import { assertCatalogObjectPersistable } from './catalog-persistability.js';
import { buildLensBasisFkGate } from './lens-fk-discovery.js';
import { createLogger } from '../common/logger.js';
import type * as AST from '../parser/ast.js';
import { Parser } from '../parser/parser.js';
import { traverseAst } from '../parser/visitor.js';
import { FunctionFlags } from '../common/constants.js';
import { SchemaChangeNotifier } from './change-events.js';
import { checkDeterministic } from '../planner/validation/determinism-validator.js';
import { buildExpression } from '../planner/building/expression.js';
import type { PlanningContext } from '../planner/planning-context.js';
import { BuildTimeDependencyTracker } from '../planner/planning-context.js';
import { GlobalScope } from '../planner/scopes/global.js';
import { ParameterScope } from '../planner/scopes/param.js';
import type { ScalarPlanNode } from '../planner/nodes/plan-node.js';
import { hasNativeEventSupport } from '../util/event-support.js';
import type { VTableSchemaChangeEvent } from '../vtab/events.js';
import { quoteIdentifier, createViewToString, astToString } from '../emit/ast-stringify.js';
import { materializeView, adoptMaterializedView, deriveBackingShape, backingShapeMatches, assertDeclaredColumnArity, type MaterializeViewDefinition, type BackingShape } from '../runtime/emit/materialized-view-helpers.js';

const log = createLogger('schema:manager');
const warnLog = log.extend('warn');
const errorLog = log.extend('error');

/**
 * One FK that references some parent table, paired with its declaring child
 * table. Entries in the reverse FK index ({@link SchemaManager.getReferencingForeignKeys});
 * `fk` is the same object reference held in `childTable.foreignKeys` (identity
 * preserved).
 */
export interface ReferencingForeignKey {
	readonly childTable: TableSchema;
	readonly fk: ForeignKeyConstraintSchema;
}

/**
 * Shared frozen empty result for the reverse-FK lookup miss (the O(1)
 * unreferenced-table gate), so the hot path allocates nothing per call.
 */
const EMPTY_REFERENCING_FKS: readonly ReferencingForeignKey[] = Object.freeze([]);

/**
 * How much of a schema's index namespace a by-name owner lookup
 * ({@link SchemaManager.findIndexOwner}) should consider.
 */
export type IndexLookupScope =
	/**
	 * Only indexes a user may create, drop or rename. An implicit covering
	 * structure — the auto-built secondary BTree backing a declared `UNIQUE`
	 * constraint — is excluded whether hidden or exposed: its lifecycle belongs to
	 * the constraint, so removing it means `ALTER TABLE … DROP CONSTRAINT`. Default.
	 */
	| 'user-indexes'
	/**
	 * Additionally admits an *exposed* implicit covering structure (constraint
	 * tagged `quereus.expose_implicit_index`), which IS addressable by
	 * `ALTER INDEX … TAGS`. Hidden ones stay excluded.
	 */
	| 'tag-addressable';

/** The table owning a by-name index match, paired with the matched index. */
export interface IndexOwnerMatch {
	readonly table: TableSchema;
	readonly index: IndexSchema;
}

/**
 * Generic options passed to VTab modules during CREATE TABLE.
 * Modules are responsible for interpreting these.
 */
export interface GenericModuleCallOptions extends BaseModuleConfig {
	moduleArgs?: readonly string[];
	statementColumns?: readonly AST.ColumnDef[];
	statementConstraints?: readonly AST.TableConstraint[];
}

/**
 * Options for {@link SchemaManager.importCatalog}, controlling the
 * materialized-view adopt-without-refill fast path. Both default off: a plain
 * `importCatalog(ddl)` always drops and refills a pre-existing same-module
 * backing — the always-correct posture.
 */
export interface ImportCatalogOptions {
	/**
	 * Caller-attested trust in pre-existing durable backings (adopt gate 5):
	 * the caller asserts the store has NOT crashed since those backings were
	 * last written — e.g. the store module sets this from its consumed
	 * clean-shutdown catalog marker. Without that attestation, a crash between
	 * two durable modules' commit acknowledgements could have left source and
	 * backing divergent on disk (coordinated commit is not 2PC), and the
	 * DDL-level adopt gates cannot see content divergence — so adopt is never
	 * taken and any divergence self-heals through the refill.
	 */
	trustBackings?: boolean;
	/**
	 * Shared adopt ledger for one rehydration session: lowercased qualified
	 * names (`schema.<table>`) of every maintained table adopted so far,
	 * appended on each successful adopt. A maintained table whose body reads
	 * another maintained table may only adopt when that upstream is IN this
	 * set — an upstream that was refilled this session may hold new content, so
	 * its dependents must refill too; an upstream that adopted is unchanged, so
	 * trust composes. Pass one Set across all `importCatalog` calls of the
	 * session (the store's MV fixpoint rounds compose through it). Omitting it
	 * means no maintained-table-sourced MV can adopt.
	 */
	adoptedBackings?: Set<string>;
	/**
	 * Lowercased qualified names (`schema.<table>`) of maintained tables whose
	 * `create materialized view` catalog entries have NOT yet imported this
	 * rehydration session. An entry whose body reads any of these is deferred
	 * (throws, to be retried in a later fixpoint round): its source table
	 * already exists as a *plain* pre-rehydrated table, so without this gate
	 * the dependent would adopt/refill against content its upstream's own
	 * import may be about to replace. (Pre-unification this ordering fell out
	 * of the body failing to plan until the upstream MV record existed.)
	 */
	pendingDerivations?: ReadonlySet<string>;
}

/**
 * The normalized input to {@link SchemaManager.importMaterializedView}, built from
 * EITHER the `create materialized view …` sugar OR the canonical
 * `create table … maintained as …` table form (the unified-model persistence /
 * export form). Both authoring surfaces re-materialize through the one import core.
 */
interface MaintainedTableImportSpec {
	/** Raw schema from the identifier (canonicalized inside the importer). */
	schemaName: string | undefined;
	/** The maintained table's (and MV's) name. */
	name: string;
	/** Derivation body — any relation-producing QueryExpr. */
	select: AST.QueryExpr;
	/**
	 * Explicit output-column rename list (`mv(a, b)` sugar, or the table form's
	 * `maintained (a, b)` clause). Present ⇒ arity-locked (a source widening is a
	 * sited error); absent ⇒ implicit, the body reshapes to follow its source.
	 */
	columns: ReadonlyArray<string> | undefined;
	/** Backing-host module from a `using <module>(...)` clause; absent ⇒ memory default. */
	moduleName?: string;
	moduleArgs?: Record<string, SqlValue>;
	tags?: Record<string, SqlValue>;
}

/** Build the import spec from the `create materialized view` sugar form. */
function maintainedImportFromMvStmt(stmt: AST.CreateMaterializedViewStmt): MaintainedTableImportSpec {
	return {
		schemaName: stmt.view.schema,
		name: stmt.view.name,
		select: stmt.select,
		columns: stmt.columns,
		moduleName: stmt.moduleName,
		moduleArgs: stmt.moduleArgs,
		tags: stmt.tags,
	};
}

/**
 * Build the import spec from the canonical `create table … maintained as …` form
 * (the unified-model persistence / export form). The rename list is read from the
 * `maintained [(columns)]` clause, NOT the declared column list: its presence is
 * the lossless flag that distinguishes an explicit MV-sugar rename (arity-locks —
 * a widened source is a sited error) from an implicit `select *` body (reshapes to
 * follow its source on reopen). `generateMaintainedTableDDL` emits the clause iff
 * the derivation carries a rename, so this restores `derivation.columns` faithfully.
 */
function maintainedImportFromTableStmt(stmt: AST.CreateTableStmt): MaintainedTableImportSpec {
	const maintained = stmt.maintained!;
	return {
		schemaName: stmt.table.schema,
		name: stmt.table.name,
		select: maintained.select,
		columns: maintained.columns,
		moduleName: stmt.moduleName,
		moduleArgs: stmt.moduleArgs,
		tags: stmt.tags,
	};
}

/**
 * A per-key tag mutation descriptor consumed by {@link SchemaManager.mutateTagRecord}:
 * `merge` overlays keys onto the current set, `drop` removes listed keys (atomically).
 */
type TagMutation =
	| { op: 'merge'; tags: Record<string, SqlValue> }
	| { op: 'drop'; keys: readonly string[] };

/**
 * Computes the next (frozen) tag record from the current one. Used to share the
 * per-site read-modify-write across the replace / merge / drop tag setters.
 */
type TagCompute = (current: Readonly<Record<string, SqlValue>> | undefined) => Readonly<Record<string, SqlValue>> | undefined;

/**
 * Manages all schemas associated with a database connection (main, temp, attached).
 * Handles lookup resolution according to SQLite's rules.
 */
export class SchemaManager {
	private schemas: Map<string, Schema> = new Map();
	private currentSchemaName: string = 'main';
	private modules: Map<string, { module: AnyVirtualTableModule, auxData?: unknown }> = new Map();
	private defaultVTabModuleName: string = 'memory';
	private defaultVTabModuleArgs: Record<string, SqlValue> = {};
	private db: Database;
	private changeNotifier = new SchemaChangeNotifier();
	/**
	 * Re-entrancy guard: when truthy, optimizer-side assertion hoisting is
	 * suppressed. Set by `AssertionEvaluator` while compiling an assertion's
	 * own violation query — without this guard, the hoist would make the
	 * violation query plan to empty (the optimizer would trust the assertion
	 * to prove its own non-violation), defeating commit-time enforcement.
	 * See `assertion-hoist-cache.ts` and `core/database-assertions.ts`.
	 */
	private assertionHoistSuppressed: number = 0;
	/**
	 * Re-entrancy guard: when truthy, the read-side materialized-view query-rewrite
	 * rule (`rule-materialized-view-rewrite.ts`) is suppressed. Set while planning a
	 * materialized view's own body for the purpose of (re)computing or maintaining
	 * its backing table (create / refresh / row-time-maintenance compile). Without
	 * it, the rewrite rule would recognize the MV's body as "answered from" the MV
	 * itself and rewrite it to scan the backing table being populated — reading a
	 * stale/empty snapshot instead of recomputing from the source.
	 */
	private mvRewriteSuppressed: number = 0;

	/**
	 * Catalog-level reverse foreign-key index: referenced `schema.table`
	 * (lowercased) → the FKs that reference it. `null` ⇒ needs a (re)build from
	 * the live catalog on next access — a pure derived cache, nulled on every
	 * mutation that can add/drop/retarget an FK or add/remove a schema (see
	 * {@link invalidateReverseFkIndex}). See `getReferencingForeignKeys`.
	 */
	private reverseFkIndex: Map<string, ReferencingForeignKey[]> | null = null;

	/**
	 * Lens basis-FK gate: the set of basis `schema.table` keys (lowercased) that
	 * back ≥1 logical parent slot referenced by ≥1 logical FK — the logical-FK
	 * analogue of {@link reverseFkIndex}. `null` ⇒ rebuild from the live catalog on
	 * next access. A pure derived cache (built by {@link buildLensBasisFkGate}),
	 * nulled on every event that can change the underlying slot scan: lens deploy
	 * (no `SchemaChangeEvent` fires — `lens-compiler` calls
	 * {@link invalidateLensFkGate} directly), any `table_added`/`_modified`/`_removed`
	 * (basis-table catalog change, via the constructor listener), and schema
	 * attach/detach/reset (no event — invalidated directly).
	 *
	 * Soundness invariant (load-bearing): a stale gate that **under-reports** would
	 * silently drop logical FK enforcement (cascade not propagated / RESTRICT not
	 * enforced / divergent basis action not suppressed) — the fatal direction — so
	 * invalidation must be exhaustive. Built from, and reset alongside, the same
	 * catalog state the three lens FK paths scan, it never under-reports for the
	 * current catalog; over-reporting (a stray key ⇒ an on-hit scan that finds
	 * nothing) is harmless. See {@link basisTableBacksLogicalParentFk}.
	 */
	private lensFkGate: Set<string> | null = null;

	/**
	 * Creates a new schema manager
	 *
	 * @param db Reference to the parent Database instance
	 */
	constructor(db: Database) {
		this.db = db;
		// Ensure 'main' and 'temp' schemas always exist
		this.schemas.set('main', new Schema('main'));
		this.schemas.set('temp', new Schema('temp'));
		// Self-subscribe so any table FK-lifecycle event invalidates the reverse FK
		// index. An FK is declared on a table, and a table enters/leaves/changes the
		// catalog ONLY through one of these events: `create table … references`
		// (table_added), `alter table add/drop constraint` and FK retargets from a
		// parent/column rename (table_modified), and `drop table` (table_removed) —
		// so this is exhaustive. The body just nulls the cache (rebuild happens on
		// next access, never inside the listener), so subscribing to our own notifier
		// is order-independent and safe. Schema ATTACH/DETACH fire no event, so those
		// invalidate directly in addSchema/getOrCreateSchema/removeSchema. The
		// listener lifetime is the SchemaManager's (no disposal path to unsubscribe).
		// The same table events also change basis-table resolution for the lens
		// basis-FK gate (a basis table created after the gate was built is the
		// under-report vector; a drop / column-rename can change which slot resolves
		// to which basis), so reset it on the same events. Lens-slot lifecycle fires
		// no event — `lens-compiler.deployLogicalSchema` invalidates the gate directly.
		this.changeNotifier.addListener(event => {
			if (event.type === 'table_added' || event.type === 'table_modified' || event.type === 'table_removed') {
				this.invalidateReverseFkIndex();
				this.invalidateLensFkGate();
			}
		});
	}

	/**
	 * Sets the current default schema for unqualified names
	 *
	 * @param name Schema name to set as current
	 */
	setCurrentSchema(name: string): void {
		if (this.schemas.has(name.toLowerCase())) {
			this.currentSchemaName = name.toLowerCase();
		} else {
			warnLog(`Attempted to set current schema to non-existent schema: %s`, name);
		}
	}

	/**
	 * Gets the name of the current default schema
	 *
	 * @returns Current schema name
	 */
	getCurrentSchemaName(): string {
		return this.currentSchemaName;
	}

	/**
	 * Registers a virtual table module
	 *
	 * @param name Module name
	 * @param module Module implementation
	 * @param auxData Optional client data associated with the module registration
	 */
	registerModule(name: string, module: AnyVirtualTableModule, auxData?: unknown): void {
		const lowerName = name.toLowerCase();
		if (this.modules.has(lowerName)) {
			warnLog(`Replacing existing virtual table module: %s`, lowerName);
		}
		this.modules.set(lowerName, { module, auxData });
		log(`Registered VTab module: %s`, lowerName);
	}

	/**
	 * Retrieves a registered virtual table module by name
	 *
	 * @param name Module name to look up
	 * @returns The module and its auxData, or undefined if not found
	 */
	getModule(name: string): { module: AnyVirtualTableModule, auxData?: unknown } | undefined {
		return this.modules.get(name.toLowerCase());
	}

	/**
	 * Iterates registered virtual table modules in registration order.
	 * Each entry yields the registered (lowercased) name, the module, and
	 * any auxData supplied at registration time.
	 */
	*allModules(): IterableIterator<{ name: string; module: AnyVirtualTableModule; auxData?: unknown }> {
		for (const [name, reg] of this.modules) {
			yield { name, module: reg.module, auxData: reg.auxData };
		}
	}

	/**
	 * Sets the default virtual table module to use when USING is omitted
	 *
	 * @param name Module name. Must be a registered module.
	 * @throws QuereusError if the module name is not registered
	 */
	setDefaultVTabModuleName(name: string): void {
		const lowerName = name.toLowerCase();
		if (this.modules.has(lowerName)) {
			this.defaultVTabModuleName = lowerName;
			log(`Default VTab module name set to: %s`, lowerName);
		} else {
			warnLog(`Setting default VTab module to '${lowerName}', which is not currently registered in SchemaManager. Ensure it gets registered.`);
			this.defaultVTabModuleName = lowerName;
		}
	}

	/**
	 * Gets the currently configured default virtual table module name
	 *
	 * @returns The default module name
	 */
	getDefaultVTabModuleName(): string {
		return this.defaultVTabModuleName;
	}

	/** @internal Sets the default VTab args directly */
	setDefaultVTabArgs(args: Record<string, SqlValue>): void {
		this.defaultVTabModuleArgs = args;
		log('Default VTab module args set to: %o', args);
	}

	/** @internal Sets the default VTab args by parsing a JSON string */
	setDefaultVTabArgsFromJson(argsJsonString: string): void {
		try {
			const parsedArgs = JSON.parse(argsJsonString);
			if (typeof parsedArgs !== 'object') {
				quereusError("JSON value must be an object.", StatusCode.MISUSE);
			}
			this.setDefaultVTabArgs(parsedArgs);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			quereusError(`Invalid JSON for default_vtab_args: ${msg}`, StatusCode.ERROR);
		}
	}

	/**
	 * Gets the default virtual table module arguments.
	 * @returns A copy of the default arguments array.
	 */
	getDefaultVTabArgs(): Record<string, SqlValue> {
		return { ...this.defaultVTabModuleArgs };
	}

	/**
	 * Gets the default virtual table module name and arguments.
	 * @returns An object containing the module name and arguments.
	 */
	getDefaultVTabModule(): { name: string; args: Record<string, SqlValue> } {
		return {
			name: this.defaultVTabModuleName,
			args: this.defaultVTabModuleArgs,
		};
	}

	/**
	 * Gets a specific schema by name
	 *
	 * @param name Schema name to retrieve
	 * @returns The schema or undefined if not found
	 */
	getSchema(name: string): Schema | undefined {
		return this.schemas.get(name.toLowerCase());
	}

	/**
	 * Gets the 'main' schema
	 *
	 * @returns The main schema
	 */
	getMainSchema(): Schema {
		return this.schemas.get('main')!;
	}

	/**
	 * Gets the 'temp' schema
	 *
	 * @returns The temp schema
	 */
	getTempSchema(): Schema {
		return this.schemas.get('temp')!;
	}

	/**
	 * @internal Returns iterator over all managed schemas
	 */
	_getAllSchemas(): IterableIterator<Schema> {
		return this.schemas.values();
	}

	/**
	 * Returns all assertions across all schemas
	 */
	getAllAssertions(): IntegrityAssertionSchema[] {
		const result: IntegrityAssertionSchema[] = [];
		for (const schema of this._getAllSchemas()) {
			for (const a of schema.getAllAssertions()) {
				result.push(a);
			}
		}
		return result;
	}

	/**
	 * Adds (or replaces) an assertion in the named schema, firing
	 * `assertion_added` or `assertion_modified` events as appropriate.
	 * The Schema object itself does not hold a notifier; this wrapper exists
	 * so optimizer caches (e.g. assertion-hoist) can invalidate on change.
	 */
	addAssertion(schemaName: string, assertion: IntegrityAssertionSchema): void {
		const schema = this.schemas.get(schemaName.toLowerCase());
		if (!schema) {
			throw new QuereusError(`Schema not found: ${schemaName}`, StatusCode.ERROR);
		}
		const existing = schema.getAssertion(assertion.name);
		schema.addAssertion(assertion);
		if (existing) {
			this.changeNotifier.notifyChange({
				type: 'assertion_modified',
				schemaName: schema.name,
				objectName: assertion.name,
				oldObject: existing,
				newObject: assertion,
			});
		} else {
			this.changeNotifier.notifyChange({
				type: 'assertion_added',
				schemaName: schema.name,
				objectName: assertion.name,
				newObject: assertion,
			});
		}
	}

	/**
	 * Removes an assertion from the named schema, firing `assertion_removed`
	 * on success. Returns true iff the assertion existed and was removed.
	 */
	removeAssertion(schemaName: string, name: string): boolean {
		const schema = this.schemas.get(schemaName.toLowerCase());
		if (!schema) return false;
		const existing = schema.getAssertion(name);
		if (!existing) return false;
		const removed = schema.removeAssertion(name);
		if (removed) {
			this.changeNotifier.notifyChange({
				type: 'assertion_removed',
				schemaName: schema.name,
				objectName: name,
				oldObject: existing,
			});
		}
		return removed;
	}

	/**
	 * Gets the schema change notifier for listening to schema changes
	 */
	getChangeNotifier(): SchemaChangeNotifier {
		return this.changeNotifier;
	}

	/**
	 * True when assertion-hoisting must be suppressed (the caller is currently
	 * planning an assertion's own violation query). Read by
	 * `getAssertionHoistedConstraints`.
	 */
	isAssertionHoistSuppressed(): boolean {
		return this.assertionHoistSuppressed > 0;
	}

	/**
	 * Run `fn` with assertion-hoisting suppressed. Re-entrant via a depth
	 * counter so nested suppressions compose. Always restores the previous
	 * state, even when `fn` throws.
	 */
	withSuppressedAssertionHoist<T>(fn: () => T): T {
		this.assertionHoistSuppressed++;
		try {
			return fn();
		} finally {
			this.assertionHoistSuppressed--;
		}
	}

	/**
	 * True when the read-side materialized-view query-rewrite rule must be
	 * suppressed (the caller is currently planning an MV's own body to recompute or
	 * maintain its backing). Read by `rule-materialized-view-rewrite.ts`.
	 */
	isMaterializedViewRewriteSuppressed(): boolean {
		return this.mvRewriteSuppressed > 0;
	}

	/**
	 * Run a synchronous `fn` with the materialized-view query-rewrite rule
	 * suppressed. Re-entrant via a depth counter; always restores state, even on
	 * throw. Wrap every place that plans an MV body to (re)compute its backing.
	 */
	withSuppressedMaterializedViewRewrite<T>(fn: () => T): T {
		this.mvRewriteSuppressed++;
		try {
			return fn();
		} finally {
			this.mvRewriteSuppressed--;
		}
	}

	/** Async counterpart of {@link withSuppressedMaterializedViewRewrite}. */
	async withSuppressedMaterializedViewRewriteAsync<T>(fn: () => Promise<T>): Promise<T> {
		this.mvRewriteSuppressed++;
		try {
			return await fn();
		} finally {
			this.mvRewriteSuppressed--;
		}
	}

	/**
	 * Adds a new schema (e.g., for ATTACH)
	 *
	 * @param name Name of the schema to add
	 * @param kind Whether the schema is module-backed (`physical`, default) or
	 *   design-only (`logical`). See `docs/lens.md` § Schema Kinds.
	 * @returns The newly created schema
	 * @throws QuereusError if the name conflicts with an existing schema
	 */
	addSchema(name: string, kind: SchemaKind = 'physical'): Schema {
		const lowerName = name.toLowerCase();
		if (this.schemas.has(lowerName)) {
			throw new QuereusError(`Schema '${name}' already exists`, StatusCode.ERROR);
		}
		const schema = new Schema(lowerName, kind);
		this.schemas.set(lowerName, schema);
		// ATTACH can bring (or, via later import, an attached schema can hold) a
		// cross-schema FK target; this method fires no change event, so reset directly.
		// A logical-schema ATTACH likewise brings lens slots, so reset the lens gate too.
		this.invalidateReverseFkIndex();
		this.invalidateLensFkGate();
		log(`Added schema '%s' (kind=%s)`, lowerName, kind);
		return schema;
	}

	/**
	 * Returns the named schema, lazily creating an empty (physical) one if absent.
	 * Used by the catalog-import paths ({@link importTable}/{@link importView}) so an
	 * object can rehydrate into a schema that holds no tables yet — making import
	 * order-independent. Unlike {@link addSchema} this never throws on an existing
	 * schema.
	 */
	private getOrCreateSchema(name: string): Schema {
		const lowerName = name.toLowerCase();
		let schema = this.schemas.get(lowerName);
		if (!schema) {
			schema = new Schema(lowerName);
			this.schemas.set(lowerName, schema);
			// Fires no change event; a cross-schema FK can land in/under this schema, and
			// a lens slot can later resolve a basis under it — reset both derived caches.
			this.invalidateReverseFkIndex();
			this.invalidateLensFkGate();
		}
		return schema;
	}

	/**
	 * Removes a schema (e.g., for DETACH)
	 *
	 * @param name Name of the schema to remove
	 * @returns true if found and removed, false otherwise
	 * @throws QuereusError if attempting to remove 'main' or 'temp'
	 */
	removeSchema(name: string): boolean {
		const lowerName = name.toLowerCase();
		if (lowerName === 'main' || lowerName === 'temp') {
			throw new QuereusError(`Cannot detach schema '${name}'`, StatusCode.ERROR);
		}
		const schema = this.schemas.get(lowerName);
		if (schema) {
			schema.clearFunctions();
			schema.clearTables();
			schema.clearViews();
			schema.clearAssertions();
			schema.clearLensSlots();
			this.schemas.delete(lowerName);
			// DETACH fires no change event, yet a cross-schema FK may have keyed
			// under (or referenced from) this schema; reset directly. The schema's lens
			// slots (cleared above) also leave the gate stale — a basis re-attach after a
			// stale-but-non-null gate could under-report — so reset it too.
			this.invalidateReverseFkIndex();
			this.invalidateLensFkGate();
			log(`Removed schema '%s'`, name);
			return true;
		}
		return false;
	}

	/**
	 * @internal Finds a table or virtual table by name across schemas
	 *
	 * @param tableName Name of the table to find
	 * @param dbName Optional specific schema name to search (overrides search path)
	 * @param schemaPath Optional ordered list of schemas to search (overrides default search order)
	 * @returns The TableSchema if found, undefined otherwise
	 */
	_findTable(tableName: string, dbName?: string, schemaPath?: string[]): TableSchema | undefined {
		const lowerTableName = tableName.toLowerCase();

		if (dbName) {
			// Search specific schema (qualified name)
			const schema = this.schemas.get(dbName.toLowerCase());
			return schema?.getTable(lowerTableName);
		} else if (schemaPath && schemaPath.length > 0) {
			// Search through provided schema path in order
			for (const schemaName of schemaPath) {
				const schema = this.schemas.get(schemaName.toLowerCase());
				const table = schema?.getTable(lowerTableName);
				if (table) return table;
			}
			return undefined;
		} else {
			// Default search order: main, then temp (and attached later)
			const mainSchema = this.schemas.get('main');
			let table = mainSchema?.getTable(lowerTableName);
			if (table) return table;

			const tempSchema = this.schemas.get('temp');
			table = tempSchema?.getTable(lowerTableName);
			return table;
		}
	}

	/**
	 * Finds a table by name, searching schemas according to SQLite rules
	 *
	 * @param tableName Name of the table
	 * @param dbName Optional specific schema name to search
	 * @param schemaPath Optional ordered list of schemas to search
	 * @returns The TableSchema or undefined if not found
	 */
	findTable(tableName: string, dbName?: string, schemaPath?: string[]): TableSchema | undefined {
		return this._findTable(tableName, dbName, schemaPath);
	}

	/**
	 * Finds all schemas holding a relation (table OR view) with the given name.
	 * Useful for generating helpful "did you mean" error messages — an
	 * unqualified name resolves through the path across both kinds
	 * ({@link findSchemaItem}), so the hint must span both too.
	 *
	 * @param itemName Name of the relation to search for
	 * @returns Array of schema names that hold a relation of that name
	 */
	findSchemasContainingRelation(itemName: string): string[] {
		const lowerItemName = itemName.toLowerCase();
		const schemaNames: string[] = [];

		for (const [schemaName, schema] of this.schemas) {
			if (schema.getTable(lowerItemName) || schema.getView(lowerItemName)) {
				schemaNames.push(schemaName);
			}
		}

		return schemaNames;
	}

	/**
	 * Finds a function by name and arg count, searching schemas
	 *
	 * @param funcName Name of the function
	 * @param nArg Number of arguments
	 * @returns The FunctionSchema or undefined if not found
	 */
	findFunction(funcName: string, nArg: number): FunctionSchema | undefined {
		return this.getMainSchema().getFunction(funcName, nArg);
	}

	/**
	 * Retrieves a view schema definition
	 *
	 * @param schemaName The name of the schema ('main', 'temp', etc.). Defaults to current schema
	 * @param viewName The name of the view
	 * @returns The ViewSchema or undefined if not found
	 */
	getView(schemaName: string | null, viewName: string): ViewSchema | undefined {
		const targetSchemaName = (schemaName ?? this.currentSchemaName).toLowerCase();
		const schema = this.schemas.get(targetSchemaName);
		return schema?.getView(viewName);
	}

	/**
	 * Retrieves a maintained table (a table carrying a derivation — what
	 * `create materialized view` produces) by name.
	 *
	 * @param schemaName The schema name ('main', etc.). Defaults to current schema
	 * @param name The maintained table's name
	 */
	getMaintainedTable(schemaName: string | null | undefined, name: string): MaintainedTableSchema | undefined {
		const table = this.getTable(schemaName ?? undefined, name);
		return isMaintainedTable(table) ? table : undefined;
	}

	/**
	 * Returns all maintained tables (derivation-bearing tables) across all schemas.
	 */
	getAllMaintainedTables(): MaintainedTableSchema[] {
		const result: MaintainedTableSchema[] = [];
		for (const schema of this.schemas.values()) {
			for (const table of schema.getAllTables()) {
				if (isMaintainedTable(table)) result.push(table);
			}
		}
		return result;
	}

	/**
	 * Attaches (or replaces) a derivation on an already-registered table,
	 * swapping the registered record for `{...table, derivation}`. Fires no
	 * event — callers own the event discipline (create fires
	 * `materialized_view_added`; import stays silent). Returns the swapped
	 * maintained table.
	 *
	 * @throws QuereusError if the table is not registered.
	 */
	attachDerivation(schemaName: string, tableName: string, derivation: TableDerivation): MaintainedTableSchema {
		const schema = this.getSchemaOrFail(schemaName);
		const table = schema.getTable(tableName);
		if (!table) {
			throw new QuereusError(`Cannot attach derivation: table '${schemaName}.${tableName}' not found`, StatusCode.INTERNAL);
		}
		const maintained: MaintainedTableSchema = { ...table, derivation };
		schema.addTable(maintained);
		return maintained;
	}

	/**
	 * Retrieves any schema item (table or view) by name. Checks views first
	 *
	 * @param schemaName The name of the schema ('main', 'temp', etc.). Defaults to current schema
	 * @param itemName The name of the table or view
	 * @returns The TableSchema or ViewSchema, or undefined if not found
	 */
	getSchemaItem(schemaName: string | null, itemName: string): TableSchema | ViewSchema | undefined {
		const targetSchemaName = (schemaName ?? this.currentSchemaName).toLowerCase();
		const schema = this.schemas.get(targetSchemaName);
		if (!schema) return undefined;

		// Prioritize views over tables if names conflict
		const view = schema.getView(itemName);
		if (view) return view;
		return schema.getTable(itemName);
	}

	/**
	 * Resolves a table-or-view name the way an unqualified name resolves: one
	 * search-path entry at a time, checking that schema's tables AND views
	 * together before moving to the next entry. Tables and views share one
	 * namespace within a schema, so at most one of the two can match per entry.
	 *
	 * @param itemName Name of the table or view
	 * @param dbName Optional explicit schema (a qualified name searches only it)
	 * @param schemaPath Optional ordered search path (default: main, then temp)
	 * @returns The TableSchema or ViewSchema, or undefined if not found
	 */
	findSchemaItem(itemName: string, dbName?: string, schemaPath?: string[]): TableSchema | ViewSchema | undefined {
		if (dbName) return this.getSchemaItem(dbName, itemName);
		// NOTE: the no-path fallback restates `_findTable`'s default order. The
		// session `schema_path` option always yields a path in practice, so this
		// branch is effectively dead — but if the default order ever changes,
		// change it in both or the two resolvers disagree.
		const path = schemaPath && schemaPath.length > 0 ? schemaPath : ['main', 'temp'];
		for (const schemaName of path) {
			const item = this.getSchemaItem(schemaName, itemName);
			if (item) return item;
		}
		return undefined;
	}

	/**
	 * Gets metadata tags for a table.
	 *
	 * @param tableName The table name
	 * @param schemaName Optional schema name (defaults to current schema)
	 * @returns The tags record or undefined if no tags are set
	 */
	getTableTags(tableName: string, schemaName?: string): Readonly<Record<string, SqlValue>> | undefined {
		const targetSchemaName = schemaName ?? this.getCurrentSchemaName();
		const tableSchema = this.getTable(targetSchemaName, tableName);
		return tableSchema?.tags;
	}

	/**
	 * Freezes a whole-set tag replacement: an empty record stores `undefined`
	 * (so `tags IS NULL` and the differ's "no tags" both hold), a non-empty one a
	 * frozen copy. Shared by the three catalog-only tag setters.
	 */
	private freezeTags(tags: Record<string, SqlValue>): Readonly<Record<string, SqlValue>> | undefined {
		return Object.keys(tags).length > 0 ? Object.freeze({ ...tags }) : undefined;
	}

	/**
	 * Computes the next frozen tag record from the current one plus a per-key
	 * mutation, reusing {@link freezeTags} for the empty→`undefined` collapse.
	 *
	 *  - `merge`: shallow-overlay the new keys onto the current set (overwrite on
	 *    collision), keeping the rest. A merge of a non-empty payload can never empty
	 *    the set; an empty merge of an empty set collapses to `undefined`.
	 *  - `drop`: every listed key must currently be present (atomic). Any missing key
	 *    raises `NOTFOUND` naming the offenders and mutates nothing; otherwise the keys
	 *    are deleted and dropping the last key collapses to `undefined`. Key matching
	 *    is verbatim (case-sensitive), matching how `parseTags` stores keys.
	 */
	private mutateTagRecord(
		current: Readonly<Record<string, SqlValue>> | undefined,
		mutation: TagMutation,
	): Readonly<Record<string, SqlValue>> | undefined {
		if (mutation.op === 'merge') {
			return this.freezeTags({ ...(current ?? {}), ...mutation.tags });
		}
		const next: Record<string, SqlValue> = { ...(current ?? {}) };
		const missing = mutation.keys.filter(k => !(k in next));
		if (missing.length > 0) {
			throw new QuereusError(`Tag key(s) not found: ${missing.join(', ')}`, StatusCode.NOTFOUND);
		}
		for (const k of mutation.keys) delete next[k];
		return this.freezeTags(next);
	}

	/**
	 * Re-registers a tag-only schema swap and fires `table_modified` so optimizer
	 * caches invalidate. Tags are excluded from the schema hash, so a tag-only swap
	 * is a structural no-op except for the metadata itself.
	 */
	private commitTagUpdate(targetSchemaName: string, oldSchema: TableSchema, newSchema: TableSchema): void {
		const schema = this.getSchemaOrFail(targetSchemaName);
		schema.addTable(newSchema);
		this.changeNotifier.notifyChange({
			type: 'table_modified',
			// Stored names of the swapped object, not the raw ALTER args — see
			// canonicalSchemaName for the emitter/stored-name invariant. A raw
			// `targetSchemaName` here (e.g. `alter index MAIN.idx set tags`) would
			// miss the table dep's stored `'main'`.
			schemaName: newSchema.schemaName,
			objectName: newSchema.name,
			oldObject: oldSchema,
			newObject: newSchema,
		});
	}

	/**
	 * Shared table-tag read-modify-write: fetches the live table (NOTFOUND if
	 * absent), computes the next tag record from its current `tags` via `compute`,
	 * and commits the swap (firing `table_modified`). `compute` decides
	 * replace / merge / drop; it may throw before any mutation (e.g. drop-of-absent
	 * NOTFOUND), leaving the catalog untouched. Reads the *live* schema each call so
	 * back-to-back ALTERs and prepared-statement reuse see the prior result.
	 */
	private updateTableTags(tableName: string, compute: TagCompute, schemaName?: string): void {
		const targetSchemaName = schemaName ?? this.getCurrentSchemaName();
		const tableSchema = this.getTable(targetSchemaName, tableName);
		if (!tableSchema) {
			throw new QuereusError(`Table '${tableName}' not found in schema '${targetSchemaName}'`, StatusCode.NOTFOUND);
		}
		const updatedSchema: TableSchema = {
			...tableSchema,
			tags: compute(tableSchema.tags),
		};
		this.commitTagUpdate(targetSchemaName, tableSchema, updatedSchema);
	}

	/**
	 * Sets metadata tags on an existing table, replacing any existing tags.
	 *
	 * @param tableName The table name
	 * @param tags The tags to set (pass empty object to clear)
	 * @param schemaName Optional schema name (defaults to current schema)
	 */
	setTableTags(tableName: string, tags: Record<string, SqlValue>, schemaName?: string): void {
		this.updateTableTags(tableName, () => this.freezeTags(tags), schemaName);
	}

	/**
	 * Merges `tags` into an existing table's tags — set/overwrite the listed keys,
	 * keep the rest (the `ALTER TABLE … ADD TAGS` primitive). An empty `tags` is a
	 * no-op (it does NOT clear). Reads the table's live tags at call time.
	 */
	mergeTableTags(tableName: string, tags: Record<string, SqlValue>, schemaName?: string): void {
		this.updateTableTags(tableName, current => this.mutateTagRecord(current, { op: 'merge', tags }), schemaName);
	}

	/**
	 * Drops the listed keys from an existing table's tags (the `ALTER TABLE …
	 * DROP TAGS` primitive). Atomic: every key must be present, else `NOTFOUND`
	 * names the missing key(s) and nothing is dropped. Dropping the last key(s)
	 * leaves `tags` undefined. An empty `keys` is a no-op.
	 */
	dropTableTags(tableName: string, keys: readonly string[], schemaName?: string): void {
		this.updateTableTags(tableName, current => this.mutateTagRecord(current, { op: 'drop', keys }), schemaName);
	}

	/**
	 * Shared column-tag read-modify-write: resolves the table and column (NOTFOUND
	 * on either miss), computes the column's next tag record from its current `tags`
	 * via `compute`, and commits the swap. Only the column's `tags` field changes;
	 * nullability / type / default / PK membership are untouched. `compute` may throw
	 * before any mutation (drop-of-absent NOTFOUND), leaving the catalog untouched.
	 */
	private updateColumnTags(tableName: string, columnName: string, compute: TagCompute, schemaName?: string): void {
		const targetSchemaName = schemaName ?? this.getCurrentSchemaName();
		const tableSchema = this.getTable(targetSchemaName, tableName);
		if (!tableSchema) {
			throw new QuereusError(`Table '${tableName}' not found in schema '${targetSchemaName}'`, StatusCode.NOTFOUND);
		}
		const colIndex = tableSchema.columnIndexMap.get(columnName.toLowerCase());
		if (colIndex === undefined) {
			throw new QuereusError(`Column '${columnName}' not found in table '${tableName}'`, StatusCode.NOTFOUND);
		}
		// Compute before building the new column array so a drop-of-absent NOTFOUND
		// aborts before any swap.
		const nextTags = compute(tableSchema.columns[colIndex].tags);
		const newColumns = tableSchema.columns.map((c, i) => (i === colIndex ? { ...c, tags: nextTags } : c));
		const updatedSchema: TableSchema = {
			...tableSchema,
			columns: Object.freeze(newColumns),
		};
		this.commitTagUpdate(targetSchemaName, tableSchema, updatedSchema);
	}

	/**
	 * Sets metadata tags on a column of an existing table, replacing any existing
	 * tags on that column (empty record clears). Catalog-only — only the column's
	 * `tags` field changes; nullability / type / default / PK membership are
	 * untouched.
	 *
	 * @throws QuereusError(NOTFOUND) if the table or column does not exist.
	 */
	setColumnTags(tableName: string, columnName: string, tags: Record<string, SqlValue>, schemaName?: string): void {
		this.updateColumnTags(tableName, columnName, () => this.freezeTags(tags), schemaName);
	}

	/**
	 * Merges `tags` into a column's existing tags — set/overwrite the listed keys,
	 * keep the rest (`ALTER TABLE … ALTER COLUMN … ADD TAGS`). Empty `tags` is a
	 * no-op (does NOT clear).
	 *
	 * @throws QuereusError(NOTFOUND) if the table or column does not exist.
	 */
	mergeColumnTags(tableName: string, columnName: string, tags: Record<string, SqlValue>, schemaName?: string): void {
		this.updateColumnTags(tableName, columnName, current => this.mutateTagRecord(current, { op: 'merge', tags }), schemaName);
	}

	/**
	 * Drops the listed keys from a column's tags (`ALTER TABLE … ALTER COLUMN …
	 * DROP TAGS`). Atomic: every key must be present, else `NOTFOUND` names the
	 * missing key(s) and nothing is dropped. Empty `keys` is a no-op.
	 *
	 * @throws QuereusError(NOTFOUND) if the table or column does not exist, or any
	 *   listed key is absent.
	 */
	dropColumnTags(tableName: string, columnName: string, keys: readonly string[], schemaName?: string): void {
		this.updateColumnTags(tableName, columnName, current => this.mutateTagRecord(current, { op: 'drop', keys }), schemaName);
	}

	/**
	 * Shared named-constraint-tag read-modify-write: resolves the table (NOTFOUND if
	 * absent) and the single matching constraint class (check → unique → fk;
	 * NOTFOUND / ambiguous via {@link resolveNamedConstraintClass}), computes the
	 * matching constraint's next tag record from its current `tags` via `compute`,
	 * and commits. `compute` may throw before any mutation (drop-of-absent NOTFOUND);
	 * since it runs inside the array rebuild prior to `commitTagUpdate`, a throw
	 * leaves the catalog untouched.
	 */
	private updateConstraintTags(tableName: string, constraintName: string, compute: TagCompute, schemaName?: string): void {
		const targetSchemaName = schemaName ?? this.getCurrentSchemaName();
		const tableSchema = this.getTable(targetSchemaName, tableName);
		if (!tableSchema) {
			throw new QuereusError(`Table '${tableName}' not found in schema '${targetSchemaName}'`, StatusCode.NOTFOUND);
		}
		const lower = constraintName.toLowerCase();
		// Resolve to exactly one class (check → unique → fk), or throw NOTFOUND/ambiguous.
		const constraintClass = resolveNamedConstraintClass(tableSchema, constraintName);
		const updatedSchema: TableSchema = { ...tableSchema };
		if (constraintClass === 'check') {
			updatedSchema.checkConstraints = Object.freeze(
				tableSchema.checkConstraints.map(c => (c.name?.toLowerCase() === lower ? { ...c, tags: compute(c.tags) } : c)),
			);
		} else if (constraintClass === 'unique') {
			updatedSchema.uniqueConstraints = Object.freeze(
				tableSchema.uniqueConstraints!.map(c => (c.name?.toLowerCase() === lower ? { ...c, tags: compute(c.tags) } : c)),
			);
		} else {
			updatedSchema.foreignKeys = Object.freeze(
				tableSchema.foreignKeys!.map(c => (c.name?.toLowerCase() === lower ? { ...c, tags: compute(c.tags) } : c)),
			);
		}
		this.commitTagUpdate(targetSchemaName, tableSchema, updatedSchema);
	}

	/**
	 * Sets metadata tags on a NAMED table-level constraint (CHECK / UNIQUE /
	 * FOREIGN KEY), replacing any existing tags (empty record clears). Lookup order
	 * is checks → unique → foreign keys; a name present in more than one class is
	 * rejected as ambiguous. Unnamed constraints are not addressable.
	 *
	 * @throws QuereusError(NOTFOUND) if no named constraint matches.
	 * @throws QuereusError(ERROR) if the name is ambiguous across constraint classes.
	 */
	setConstraintTags(tableName: string, constraintName: string, tags: Record<string, SqlValue>, schemaName?: string): void {
		this.updateConstraintTags(tableName, constraintName, () => this.freezeTags(tags), schemaName);
	}

	/**
	 * Merges `tags` into a named constraint's existing tags — set/overwrite the
	 * listed keys, keep the rest (`ALTER TABLE … ALTER CONSTRAINT … ADD TAGS`).
	 * Empty `tags` is a no-op (does NOT clear).
	 *
	 * @throws QuereusError(NOTFOUND) if no named constraint matches.
	 * @throws QuereusError(ERROR) if the name is ambiguous across constraint classes.
	 */
	mergeConstraintTags(tableName: string, constraintName: string, tags: Record<string, SqlValue>, schemaName?: string): void {
		this.updateConstraintTags(tableName, constraintName, current => this.mutateTagRecord(current, { op: 'merge', tags }), schemaName);
	}

	/**
	 * Drops the listed keys from a named constraint's tags (`ALTER TABLE … ALTER
	 * CONSTRAINT … DROP TAGS`). Atomic: every key must be present, else `NOTFOUND`
	 * names the missing key(s) and nothing is dropped. Empty `keys` is a no-op.
	 *
	 * @throws QuereusError(NOTFOUND) if no named constraint matches, or any listed
	 *   key is absent.
	 * @throws QuereusError(ERROR) if the name is ambiguous across constraint classes.
	 */
	dropConstraintTags(tableName: string, constraintName: string, keys: readonly string[], schemaName?: string): void {
		this.updateConstraintTags(tableName, constraintName, current => this.mutateTagRecord(current, { op: 'drop', keys }), schemaName);
	}

	/**
	 * Shared view-tag read-modify-write: fetches the live view (NOTFOUND if
	 * absent), computes its next tag record from its current `tags` via `compute`,
	 * re-registers the swapped {@link ViewSchema}, and fires `view_modified` so a
	 * cached write-through plan that recorded a `view` dependency (every
	 * view-/MV-mediated write does — see `buildViewMutation`) is invalidated when
	 * the view's tags change (tag validation re-runs at plan time, so a
	 * newly-invalid tag must surface on the next run). This event is distinct
	 * from the (non-existent) plain-view create event, so it triggers no maintenance
	 * re-registration. `compute` decides replace / merge / drop and may throw before
	 * any mutation (drop-of-absent NOTFOUND), leaving the catalog untouched.
	 */
	private updateViewTags(viewName: string, compute: TagCompute, schemaName?: string): void {
		const targetSchemaName = schemaName ?? this.getCurrentSchemaName();
		const schema = this.getSchemaOrFail(targetSchemaName);
		const view = schema.getView(viewName);
		if (!view) {
			throw new QuereusError(`View '${viewName}' not found in schema '${targetSchemaName}'`, StatusCode.NOTFOUND);
		}
		const updated: ViewSchema = { ...view, tags: compute(view.tags) };
		// A tag key/value is persisted verbatim into the view's DDL text, so it can
		// carry something a module cannot durably encode. Veto before the swap — the
		// re-persist that follows the event is fire-and-forget and could not report it.
		assertCatalogObjectPersistable(this.db, 'view', updated);
		schema.addView(updated);
		this.changeNotifier.notifyChange({
			type: 'view_modified',
			// Stored names of the swapped object, not the raw ALTER args — see
			// canonicalSchemaName for the emitter/stored-name invariant. A
			// case-differing ALTER (e.g. `alter view MAIN.MYVIEW` on
			// `create view MyView` in `main`) would otherwise miss on either field.
			schemaName: schema.name,
			objectName: updated.name,
			oldObject: view,
			newObject: updated,
		});
	}

	/**
	 * Sets metadata tags on an existing view, replacing any existing tags (empty
	 * record clears).
	 *
	 * @throws QuereusError(NOTFOUND) if the view does not exist.
	 */
	setViewTags(viewName: string, tags: Record<string, SqlValue>, schemaName?: string): void {
		this.updateViewTags(viewName, () => this.freezeTags(tags), schemaName);
	}

	/**
	 * Merges `tags` into an existing view's tags — set/overwrite the listed keys,
	 * keep the rest (`ALTER VIEW … ADD TAGS`). Empty `tags` is a no-op (does NOT
	 * clear). Reads the view's live tags at call time.
	 *
	 * @throws QuereusError(NOTFOUND) if the view does not exist.
	 */
	mergeViewTags(viewName: string, tags: Record<string, SqlValue>, schemaName?: string): void {
		this.updateViewTags(viewName, current => this.mutateTagRecord(current, { op: 'merge', tags }), schemaName);
	}

	/**
	 * Drops the listed keys from an existing view's tags (`ALTER VIEW … DROP TAGS`).
	 * Atomic: every key must be present, else `NOTFOUND` names the missing key(s)
	 * and nothing is dropped. Dropping the last key(s) leaves `tags` undefined. An
	 * empty `keys` is a no-op.
	 *
	 * @throws QuereusError(NOTFOUND) if the view does not exist, or any listed key
	 *   is absent.
	 */
	dropViewTags(viewName: string, keys: readonly string[], schemaName?: string): void {
		this.updateViewTags(viewName, current => this.mutateTagRecord(current, { op: 'drop', keys }), schemaName);
	}

	/**
	 * Shared materialized-view-tag read-modify-write: fetches the live maintained
	 * table (NOTFOUND if absent or derivation-less), computes its next tag record
	 * via `compute`, re-registers the swapped table (the shared `derivation`
	 * object rides the spread), and fires `materialized_view_modified`. The
	 * table's contents and the row-time maintenance plan are untouched (tags do
	 * not affect maintenance), so this never re-materializes — `_modified` is
	 * deliberately distinct from `materialized_view_added` (what create emits):
	 * the MV maintenance manager re-registers on `_added` but ignores
	 * `_modified`. The event invalidates a cached write-through plan that
	 * recorded a `view` dependency when the MV's tags change (tag validation
	 * re-runs at plan time). `compute` may throw before any mutation
	 * (drop-of-absent NOTFOUND), leaving the catalog untouched.
	 */
	private updateMaterializedViewTags(name: string, compute: TagCompute, schemaName?: string): void {
		const targetSchemaName = schemaName ?? this.getCurrentSchemaName();
		const schema = this.getSchemaOrFail(targetSchemaName);
		const table = schema.getTable(name);
		if (!isMaintainedTable(table)) {
			throw new QuereusError(`Materialized view '${name}' not found in schema '${targetSchemaName}'`, StatusCode.NOTFOUND);
		}
		const updated: MaintainedTableSchema = { ...table, tags: compute(table.tags) };
		// See updateViewTags: tags ride the persisted DDL, so veto before the swap.
		assertCatalogObjectPersistable(this.db, 'materializedView', updated);
		schema.addTable(updated);
		this.changeNotifier.notifyChange({
			type: 'materialized_view_modified',
			// Stored names of the swapped object, not the raw ALTER args — see
			// canonicalSchemaName for the emitter/stored-name invariant.
			schemaName: schema.name,
			objectName: updated.name,
			oldObject: table,
			newObject: updated,
		});
	}

	/**
	 * Sets metadata tags on an existing materialized view, replacing any existing
	 * tags (empty record clears). Catalog-only — never re-materializes.
	 *
	 * @throws QuereusError(NOTFOUND) if the materialized view does not exist.
	 */
	setMaterializedViewTags(name: string, tags: Record<string, SqlValue>, schemaName?: string): void {
		this.updateMaterializedViewTags(name, () => this.freezeTags(tags), schemaName);
	}

	/**
	 * Merges `tags` into an existing materialized view's tags — set/overwrite the
	 * listed keys, keep the rest (`ALTER MATERIALIZED VIEW … ADD TAGS`). Empty
	 * `tags` is a no-op (does NOT clear). Catalog-only — never re-materializes.
	 *
	 * @throws QuereusError(NOTFOUND) if the materialized view does not exist.
	 */
	mergeMaterializedViewTags(name: string, tags: Record<string, SqlValue>, schemaName?: string): void {
		this.updateMaterializedViewTags(name, current => this.mutateTagRecord(current, { op: 'merge', tags }), schemaName);
	}

	/**
	 * Drops the listed keys from an existing materialized view's tags (`ALTER
	 * MATERIALIZED VIEW … DROP TAGS`). Atomic: every key must be present, else
	 * `NOTFOUND` names the missing key(s) and nothing is dropped. Empty `keys` is a
	 * no-op. Catalog-only — never re-materializes.
	 *
	 * @throws QuereusError(NOTFOUND) if the materialized view does not exist, or any
	 *   listed key is absent.
	 */
	dropMaterializedViewTags(name: string, keys: readonly string[], schemaName?: string): void {
		this.updateMaterializedViewTags(name, current => this.mutateTagRecord(current, { op: 'drop', keys }), schemaName);
	}

	/**
	 * Shared index-tag read-modify-write. Indexes live on their owning
	 * {@link TableSchema}, so this resolves the owner by index name, computes the
	 * matching {@link IndexSchema}'s next tag record from its current `tags` via
	 * `compute`, swaps it, re-registers the table, and fires `table_modified`
	 * (mirroring create/drop index) so optimizer caches invalidate.
	 *
	 * Hidden implicit covering structures (the auto-built BTree backing a UNIQUE
	 * constraint, not opted into catalog visibility) are not user-addressable and
	 * surface as NOTFOUND — their tags live on the originating constraint. `compute`
	 * runs before the index array is rebuilt, so a drop-of-absent NOTFOUND aborts
	 * before any swap.
	 */
	private updateIndexTags(indexName: string, compute: TagCompute, schemaName?: string): void {
		const targetSchemaName = schemaName ?? this.getCurrentSchemaName();
		const { oldSchema, newSchema } = this.resolveIndexTagSwap(targetSchemaName, indexName, compute);
		this.commitTagUpdate(targetSchemaName, oldSchema, newSchema);
	}

	/**
	 * Resolve-and-swap core shared by {@link updateIndexTags} (live ALTER — commits
	 * via {@link commitTagUpdate}, firing `table_modified`) and the catalog-import
	 * path ({@link applyImportedIndexTags} — commits silently). Resolves `indexName`
	 * within `targetSchemaName` and returns the owning table plus its swapped
	 * replacement with the computed tags applied; mutates nothing itself.
	 */
	private resolveIndexTagSwap(
		targetSchemaName: string,
		indexName: string,
		compute: TagCompute,
	): { oldSchema: TableSchema; newSchema: TableSchema } {
		const schema = this.getSchemaOrFail(targetSchemaName);
		const lower = indexName.toLowerCase();

		// Primary path: a materialized IndexSchema — every real index, plus the
		// memory backend's materialized implicit covering index. Tags live on the
		// matched IndexSchema. A *hidden* implicit index is not user-addressable and
		// is skipped by the `tag-addressable` scope; it then fails the
		// exposed-constraint fallback below (its name is materialized, so it is not
		// "exposed and unmaterialized") and surfaces as NOTFOUND — preserving
		// Phase 22/37 behavior.
		const match = this.findIndexOwner(targetSchemaName, indexName, { scope: 'tag-addressable' });
		if (match) {
			const { table, index: matched } = match;
			// Compute before rebuilding the index array so a drop-of-absent NOTFOUND
			// aborts before any swap.
			const nextTags = compute(matched.tags);
			const updatedIndexes = table.indexes!.map(idx => (idx.name.toLowerCase() === lower ? { ...idx, tags: nextTags } : idx));
			return { oldSchema: table, newSchema: { ...table, indexes: Object.freeze(updatedIndexes) } };
		}

		// Fallback (store mode): the exposed implicit covering index is not
		// materialized as an IndexSchema. Route its tags onto the originating UNIQUE
		// constraint's `exposedIndexTags` — kept separate from `uc.tags`, which holds
		// the exposure flag, so the flag never leaks into the surfaced index tags.
		// `findExposedImplicitConstraintIndex` returns -1 for hidden/materialized
		// implicit indexes, so they fall through to NOTFOUND.
		for (const table of schema.getAllTables()) {
			const ucIndex = findExposedImplicitConstraintIndex(table, indexName);
			if (ucIndex < 0) continue;
			const constraints = table.uniqueConstraints!;
			// Compute before swapping so a drop-of-absent NOTFOUND aborts untouched.
			const nextTags = compute(constraints[ucIndex].exposedIndexTags);
			const updatedConstraints = constraints.map((uc, i) => {
				if (i !== ucIndex) return uc;
				const next = { ...uc };
				if (nextTags) next.exposedIndexTags = nextTags;
				else delete next.exposedIndexTags;
				return next;
			});
			return { oldSchema: table, newSchema: { ...table, uniqueConstraints: Object.freeze(updatedConstraints) } };
		}

		throw new QuereusError(`Index '${indexName}' not found in schema '${targetSchemaName}'`, StatusCode.NOTFOUND);
	}

	/**
	 * Sets metadata tags on an existing index, replacing any existing tags (empty
	 * record clears).
	 *
	 * @throws QuereusError(NOTFOUND) if no user-visible index matches.
	 */
	setIndexTags(indexName: string, tags: Record<string, SqlValue>, schemaName?: string): void {
		this.updateIndexTags(indexName, () => this.freezeTags(tags), schemaName);
	}

	/**
	 * Merges `tags` into an existing index's tags — set/overwrite the listed keys,
	 * keep the rest (`ALTER INDEX … ADD TAGS`). Empty `tags` is a no-op (does NOT
	 * clear).
	 *
	 * @throws QuereusError(NOTFOUND) if no user-visible index matches.
	 */
	mergeIndexTags(indexName: string, tags: Record<string, SqlValue>, schemaName?: string): void {
		this.updateIndexTags(indexName, current => this.mutateTagRecord(current, { op: 'merge', tags }), schemaName);
	}

	/**
	 * Drops the listed keys from an existing index's tags (`ALTER INDEX … DROP
	 * TAGS`). Atomic: every key must be present, else `NOTFOUND` names the missing
	 * key(s) and nothing is dropped. Empty `keys` is a no-op.
	 *
	 * @throws QuereusError(NOTFOUND) if no user-visible index matches, or any listed
	 *   key is absent.
	 */
	dropIndexTags(indexName: string, keys: readonly string[], schemaName?: string): void {
		this.updateIndexTags(indexName, current => this.mutateTagRecord(current, { op: 'drop', keys }), schemaName);
	}

	/**
	 * Nulls the reverse FK index so it rebuilds from the live catalog on next
	 * access. Pure derived-cache reset — order-independent, called both from the
	 * self-subscribed change listener and from the schema attach/detach methods.
	 */
	private invalidateReverseFkIndex(): void {
		this.reverseFkIndex = null;
	}

	/**
	 * Builds the reverse FK index from the live catalog, bucketing every FK under
	 * its resolved referenced `schema.table` key (cross-schema FKs key under their
	 * `referencedSchema`). Preserves schema-insertion → table → FK-declaration
	 * order within each bucket so the first-surviving-child RESTRICT pre-check and
	 * any error-message golden tests keep naming the same child.
	 */
	private buildReverseFkIndex(): Map<string, ReferencingForeignKey[]> {
		const index = new Map<string, ReferencingForeignKey[]>();
		for (const schema of this._getAllSchemas()) {
			for (const childTable of schema.getAllTables()) {
				if (!childTable.foreignKeys) continue;
				for (const fk of childTable.foreignKeys) {
					const refSchema = (fk.referencedSchema ?? childTable.schemaName).toLowerCase();
					const key = `${refSchema}.${fk.referencedTable.toLowerCase()}`;
					let bucket = index.get(key);
					if (!bucket) {
						bucket = [];
						index.set(key, bucket);
					}
					bucket.push({ childTable, fk });
				}
			}
		}
		return index;
	}

	/**
	 * Returns the FKs that reference `parentSchemaName.parentTableName`
	 * (case-insensitive), the shared primitive every parent-side referential scan
	 * uses to short-circuit. Returns a shared frozen empty array — the O(1) gate —
	 * when nothing references the table; otherwise exactly its referencing FKs.
	 * Lazily (re)builds the whole index from the live catalog on the first access
	 * after any schema mutation; a pure derived cache (over-reporting a since-dropped
	 * FK is harmless — each consumer re-checks arity/target in its per-FK body).
	 *
	 * The returned `fk` objects are the same references held in
	 * `childTable.foreignKeys` (identity preserved).
	 */
	getReferencingForeignKeys(parentSchemaName: string, parentTableName: string): readonly ReferencingForeignKey[] {
		if (this.reverseFkIndex === null) {
			this.reverseFkIndex = this.buildReverseFkIndex();
		}
		const key = `${parentSchemaName.toLowerCase()}.${parentTableName.toLowerCase()}`;
		return this.reverseFkIndex.get(key) ?? EMPTY_REFERENCING_FKS;
	}

	/**
	 * Nulls the lens basis-FK gate so it rebuilds from the live catalog on next
	 * access. Pure derived-cache reset — order-independent (rebuild happens on next
	 * access, never inside a listener). Public because `lens-compiler` calls it after
	 * a lens (re)deploy, which mutates the slot set without firing a `SchemaChangeEvent`.
	 */
	invalidateLensFkGate(): void {
		this.lensFkGate = null;
	}

	/**
	 * O(1) gate for the three basis-keyed lens FK paths: does `schemaName.tableName`
	 * (case-insensitive) back ≥1 logical parent slot referenced by ≥1 logical FK?
	 * When `false`, `executeLensForeignKeyActions`,
	 * `assertLensRestrictsForParentMutation`, and `basisFksOverriddenByDivergentLensFk`
	 * early-return — the reverse-map slot scan they would run finds nothing. Lazily
	 * (re)builds {@link lensFkGate} on the first access after any invalidation, then
	 * does a single `Set.has`. See {@link buildLensBasisFkGate} for the build, and the
	 * {@link lensFkGate} doc-comment for the never-under-report soundness invariant.
	 */
	basisTableBacksLogicalParentFk(schemaName: string, tableName: string): boolean {
		if (this.lensFkGate === null) {
			this.lensFkGate = buildLensBasisFkGate(this);
		}
		return this.lensFkGate.has(`${schemaName.toLowerCase()}.${tableName.toLowerCase()}`);
	}

	/**
	 * Asserts that no other table has FK rows referencing the table being dropped.
	 * Self-referential FKs are skipped — those rows go away with the table.
	 * No-op when foreign_keys is off.
	 */
	private async assertNoReferencingChildrenForDrop(parentSchemaName: string, parentTableName: string): Promise<void> {
		if (!this.db.options.getBooleanOption('foreign_keys')) return;

		const parentSchemaLower = parentSchemaName.toLowerCase();
		const parentTableLower = parentTableName.toLowerCase();

		// The reverse FK index already keyed on the referenced schema.table, so the
		// two discovery filters (referencedTable / targetSchema match) are satisfied
		// by the lookup and drop out; every other line below is unchanged.
		for (const { childTable, fk } of this.getReferencingForeignKeys(parentSchemaName, parentTableName)) {
			// Skip the table being dropped itself — self-FK rows are going away with it.
			if (childTable.schemaName.toLowerCase() === parentSchemaLower &&
				childTable.name.toLowerCase() === parentTableLower) continue;

			// MATCH SIMPLE: row is referencing iff every FK column is non-NULL.
			const childColNames = fk.columns.map(idx => quoteIdentifier(childTable.columns[idx].name));
			const whereClause = childColNames.map(c => `${c} IS NOT NULL`).join(' AND ');
			const schemaPrefix = childTable.schemaName.toLowerCase() !== 'main'
				? `${quoteIdentifier(childTable.schemaName)}.`
				: '';
			const sql = `select 1 from ${schemaPrefix}${quoteIdentifier(childTable.name)} where ${whereClause} limit 1`;

			// Cached internal statement (compiled once per shape) rather than a fresh
			// per-drop prepare/finalize — see InternalStatementCache.
			if (await this.db._internalStatementCache.probe(sql)) {
				throw new QuereusError(
					`FOREIGN KEY constraint failed: cannot drop table '${parentTableName}' because table '${childTable.name}' still has rows referencing it`,
					StatusCode.CONSTRAINT,
				);
			}
		}
	}

	/**
	 * Drops a table from the specified schema
	 *
	 * @param schemaName The name of the schema
	 * @param tableName The name of the table to drop
	 * @param ifExists If true, do not throw an error if the table does not exist.
	 * @returns True if the table was found and dropped, false otherwise.
	 */
	async dropTable(schemaName: string, tableName: string, ifExists: boolean = false): Promise<boolean> {
		const schema = this.schemas.get(schemaName.toLowerCase()); // Ensure schemaName is lowercased for lookup
		if (!schema) {
			if (ifExists) return false; // Schema not found, but IF EXISTS specified
			throw new QuereusError(`Schema not found: ${schemaName}`, StatusCode.ERROR);
		}

		const tableSchema = schema.getTable(tableName); // getTable should handle case-insensitivity

		if (!tableSchema) {
			if (ifExists) {
				log(`Table %s.%s not found, but IF EXISTS was specified.`, schemaName, tableName);
				return false; // Not found, but IF EXISTS means no error, not dropped.
			}
			throw new QuereusError(`Table ${tableName} not found in schema ${schemaName}`, StatusCode.NOTFOUND);
		}

		// FK guard: when foreign_keys is on, refuse to drop a parent that still has
		// non-NULL FK rows in any child table (excluding self-FK; those rows go away
		// with the table). MATCH SIMPLE: a row is "referencing" iff every FK column
		// is non-NULL.
		await this.assertNoReferencingChildrenForDrop(schemaName, tableName);

		// Call destroy on the module FIRST, awaiting it and PROPAGATING any rejection,
		// BEFORE any engine-side teardown. A module may veto the drop (e.g. a
		// schema-level inbound-FK guard that an emptied child cannot satisfy); by
		// awaiting destroy before mutating connection/schema state we make the veto
		// abort the statement atomically — on rejection the table stays in our schema
		// map AND in the module's own catalogue, since neither has been touched yet.
		// Awaiting here (rather than after removeTable, as before) also preserves the
		// original "subsequent DDL/DML sees a clean slate" intent: destroy still
		// completes before dropTable returns, just without swallowing its error.
		if (tableSchema.vtabModuleName) { // tableSchema is guaranteed to be defined here
			const moduleRegistration = this.getModule(tableSchema.vtabModuleName);
			if (moduleRegistration && moduleRegistration.module && moduleRegistration.module.destroy) {
				log(`Calling destroy for VTab %s.%s via module %s`, schemaName, tableName, tableSchema.vtabModuleName);
				// Module-facing stored-name contract (see canonicalSchemaName): hand the
				// resolved table's canonical schemaName and stored display casing, never
				// the raw `drop table T` spelling — so a module keying by the arg finds the
				// create-time key, and the store's own `drop` schema-change event (which
				// emits objectName: tableName) fires the stored name.
				await moduleRegistration.module.destroy(
					this.db,
					moduleRegistration.auxData,
					tableSchema.vtabModuleName,
					tableSchema.schemaName,
					tableSchema.name
				);
				log(`destroy completed for VTab %s.%s`, schemaName, tableName);
			} else {
				warnLog(`VTab module %s (for table %s.%s) or its destroy method not found during dropTable.`, tableSchema.vtabModuleName, schemaName, tableName);
			}
		}

		// destroy succeeded (or the module had none) — now tear down engine-side state.
		// Remove any active connections for this table before removing it from the
		// schema map. Connections become stale once the table is dropped and must not
		// be reused if the table is later recreated with the same name.
		this.db.removeConnectionsForTable(schemaName, tableName);

		// Remove from schema map
		const removed = schema.removeTable(tableName);
		if (!removed && !ifExists) {
			// This should ideally not be reached if tableSchema was found above.
			// But as a safeguard if removeTable could fail for other reasons.
			throw new QuereusError(`Failed to remove table ${tableName} from schema ${schemaName}, though it was initially found.`, StatusCode.INTERNAL);
		}

		// Notify schema change listeners if table was removed. Stored names of the
		// dropped object, not the raw drop args — see canonicalSchemaName for the
		// emitter/stored-name invariant.
		if (removed) {
			this.changeNotifier.notifyChange({
				type: 'table_removed',
				schemaName: tableSchema.schemaName,
				objectName: tableSchema.name,
				oldObject: tableSchema
			});

			this.emitAutoSchemaEventIfNeeded(tableSchema.vtabModuleName, {
				type: 'drop',
				objectType: 'table',
				schemaName: tableSchema.schemaName,
				objectName: tableSchema.name,
			});
		}

		return removed; // True if removed from schema, false if not found and ifExists was true.
	}

	/**
	 * Drops a view from the specified schema
	 *
	 * @param schemaName The name of the schema
	 * @param viewName The name of the view to drop
	 * @returns True if the view was found and dropped, false otherwise
	 */
	dropView(schemaName: string, viewName: string): boolean {
		const schema = this.schemas.get(schemaName.toLowerCase());
		if (!schema) return false;
		return schema.removeView(viewName);
	}

	/**
	 * Clears all schema items (tables, functions, views)
	 */
	clearAll(): void {
		this.schemas.forEach(schema => {
			schema.clearTables();
			schema.clearFunctions();
			schema.clearViews();
			schema.clearAssertions();
			schema.clearLensSlots();
		});
		// Wiping every table + lens slot leaves both derived FK caches stale (this
		// path fires no change event); reset so the next access rebuilds them empty.
		this.invalidateReverseFkIndex();
		this.invalidateLensFkGate();
		log("Cleared all schemas.");
	}

	/**
	 * Retrieves a schema object, throwing if it doesn't exist
	 *
	 * @param name Schema name ('main', 'temp', or custom). Case-insensitive
	 * @returns The Schema object
	 * @throws QuereusError if the schema does not exist
	 */
	getSchemaOrFail(name: string): Schema {
		const schema = this.schemas.get(name.toLowerCase());
		if (!schema) {
			throw new QuereusError(`Schema not found: ${name}`);
		}
		return schema;
	}

	/**
	 * Canonical form of a raw (statement-supplied) schema qualifier.
	 *
	 * The invalidation contract this anchors: stored `schemaName` on
	 * tables/views/MVs is canonical, and every schema-change emitter fires the
	 * *stored* names of the object it swapped. `Statement.compile()` compares
	 * recorded dependencies against events exactly, so a raw-cased name on
	 * either side silently misses cached-plan invalidation.
	 *
	 * `Schema.name` is invariantly lowercase (every construction site
	 * lowercases), so an existing schema canonicalizes through its Schema
	 * object; an absent one (a plan-time reference that may resolve by run
	 * time, a catalog import into a not-yet-created schema) folds the way the
	 * Schema constructor would. Existence is NOT validated here — lookup sites
	 * keep their own missing-schema handling.
	 */
	canonicalSchemaName(raw: string): string {
		return this.schemas.get(raw.toLowerCase())?.name ?? raw.toLowerCase();
	}

	/**
	 * Retrieves a table from the specified schema
	 *
	 * @param schemaName The name of the schema ('main', 'temp', etc.). Defaults to current schema
	 * @param tableName The name of the table
	 * @returns The TableSchema or undefined if not found
	 */
	getTable(schemaName: string | undefined, tableName: string): TableSchema | undefined {
		const targetSchemaName = (schemaName ?? this.currentSchemaName).toLowerCase();
		const schema = this.schemas.get(targetSchemaName);
		return schema?.getTable(tableName);
	}

	/**
	 * Resolves the VTab module name and args from a CREATE TABLE statement,
	 * falling back to configured defaults when USING is omitted.
	 */
	private resolveModuleInfo(stmt: AST.CreateTableStmt): {
		moduleName: string;
		effectiveModuleArgs: Readonly<Record<string, SqlValue>>;
		moduleInfo: { module: AnyVirtualTableModule; auxData?: unknown };
	} {
		let moduleName: string;
		let effectiveModuleArgs: Readonly<Record<string, SqlValue>>;

		if (stmt.moduleName) {
			moduleName = stmt.moduleName;
			effectiveModuleArgs = Object.freeze(stmt.moduleArgs || {});
		} else {
			const defaultVtab = this.getDefaultVTabModule();
			moduleName = defaultVtab.name;
			effectiveModuleArgs = Object.freeze(defaultVtab.args || {});
		}

		const moduleInfo = this.getModule(moduleName);
		if (!moduleInfo || !moduleInfo.module) {
			throw new QuereusError(`No virtual table module named '${moduleName}'`, StatusCode.ERROR, undefined, stmt.loc?.start.line, stmt.loc?.start.column);
		}

		return { moduleName, effectiveModuleArgs, moduleInfo };
	}

	/**
	 * Builds column schemas from AST column/constraint definitions,
	 * resolving PK membership and nullability.
	 */
	private buildColumnSchemas(
		astColumns: readonly AST.ColumnDef[],
		astConstraints: readonly AST.TableConstraint[] | undefined,
		defaultNotNull: boolean,
		defaultCollation: string = 'BINARY'
	): {
		columns: ColumnSchema[];
		pkDefinition: ReadonlyArray<import('./table.js').PrimaryKeyColumnDefinition>;
		pkDefaultConflict: import('../common/constants.js').ConflictResolution | undefined;
	} {
		// Gate an explicit column COLLATE against this connection's collation registry
		// (accepts a registered custom collation; rejects an unregistered name for every
		// type). Shared by fresh CREATE and catalog rehydrate (importTable), so a
		// persisted custom-collation column re-validates on reopen — see docs/schema.md.
		const isCollationRegistered = (name: string): boolean => this.db.isCollationRegistered(name);
		const preliminaryColumnSchemas: ColumnSchema[] = astColumns.map(colDef => columnDefToSchema(colDef, defaultNotNull, defaultCollation, isCollationRegistered));
		const { pkDef: pkDefinition, defaultConflict: pkDefaultConflict, synthesized } = findPKDefinition(preliminaryColumnSchemas, astConstraints);

		const columns = preliminaryColumnSchemas.map((col, idx) => {
			const isPkColumn = pkDefinition.some(pkCol => pkCol.index === idx);
			const pkOrder = isPkColumn
				? pkDefinition.findIndex(pkC => pkC.index === idx) + 1
				: 0;
			// Only an explicitly-declared PK forces NOT NULL. A synthesized
			// all-columns key (the no-PK fallback) leaves each column's declared
			// nullability intact — see findPKDefinition.
			return {
				...col,
				primaryKey: isPkColumn,
				pkOrder,
				notNull: (isPkColumn && !synthesized) ? true : col.notNull,
			};
		});

		return { columns, pkDefinition, pkDefaultConflict };
	}

	/**
	 * Extracts CHECK constraints from AST column and table constraint definitions.
	 *
	 * An unnamed column-level CHECK is minted `_check_<col>`; two on one column are
	 * legal, so the mint disambiguates through the statement-wide `takenNames` set
	 * (`_check_b`, then `_check_b_2`) — see `disambiguateAutoConstraintName`. An
	 * unnamed table-level CHECK keeps no name at all (unchanged), so it cannot
	 * collide.
	 */
	private extractCheckConstraints(
		astColumns: readonly AST.ColumnDef[],
		astConstraints: readonly AST.TableConstraint[] | undefined,
		takenNames: Set<string>,
	): RowConstraintSchema[] {
		const result: RowConstraintSchema[] = [];

		for (const colDef of astColumns) {
			for (const con of colDef.constraints ?? []) {
				if (con.type === 'check' && con.expr) {
					result.push({
						name: con.name ?? disambiguateAutoConstraintName(`_check_${colDef.name}`, takenNames),
						expr: con.expr,
						operations: opsToMask(con.operations),
						defaultConflict: con.onConflict,
						tags: con.tags && Object.keys(con.tags).length > 0 ? Object.freeze({ ...con.tags }) : undefined,
					});
				}
			}
		}

		for (const con of astConstraints ?? []) {
			if (con.type === 'check' && con.expr) {
				result.push({
					name: con.name,
					expr: con.expr,
					operations: opsToMask(con.operations),
					defaultConflict: con.onConflict,
					tags: con.tags && Object.keys(con.tags).length > 0 ? Object.freeze({ ...con.tags }) : undefined,
				});
			}
		}

		return result;
	}

	/**
	 * Extracts FOREIGN KEY constraints from AST column and table constraint definitions.
	 * Resolves column indices in the child table. Parent table resolution is deferred
	 * to enforcement time (the parent table may not exist yet during declarative schema setup).
	 */
	private extractForeignKeys(
		astColumns: readonly AST.ColumnDef[],
		astConstraints: readonly AST.TableConstraint[] | undefined,
		columnIndexMap: ReadonlyMap<string, number>,
		tableName: string,
		schemaName: string,
		takenNames: Set<string>,
	): ForeignKeyConstraintSchema[] {
		const result: ForeignKeyConstraintSchema[] = [];

		// Column-level foreign keys
		for (const colDef of astColumns) {
			for (const con of colDef.constraints ?? []) {
				if (con.type === 'foreignKey' && con.foreignKey) {
					const fk = con.foreignKey;
					const childColIndex = columnIndexMap.get(colDef.name.toLowerCase());
					if (childColIndex === undefined) {
						throw new QuereusError(`FK column '${colDef.name}' not found in table '${tableName}'`, StatusCode.ERROR);
					}

					// Parent column resolution is deferred — store names for now
					// We need the parent table schema to resolve indices, but it may not exist yet
					if (fk.columns && fk.columns.length !== 1) {
						throw new QuereusError(
							`FK constraint '${con.name ?? `_fk_${tableName}_${colDef.name}`}' on table '${tableName}': child column count (1) does not match parent column count (${fk.columns.length})`,
							StatusCode.ERROR,
						);
					}
					result.push({
						// Two FKs on one child column (different parents) are legal SQL,
						// so a colliding mint disambiguates (`_fk_C_x`, then `_fk_C_x_2`)
						// rather than rejecting — see `disambiguateAutoConstraintName`.
						name: con.name ?? disambiguateAutoConstraintName(`_fk_${tableName}_${colDef.name}`, takenNames),
						columns: Object.freeze([childColIndex]),
						referencedTable: fk.table,
						referencedSchema: fk.schema ?? schemaName,
						referencedColumns: Object.freeze([]), // resolved at enforcement time
						referencedColumnNames: fk.columns, // deferred resolution via resolveReferencedColumns
						onDelete: fk.onDelete ?? 'restrict',
						onUpdate: fk.onUpdate ?? 'restrict',
						deferred: fk.initiallyDeferred ?? false,
						tags: con.tags && Object.keys(con.tags).length > 0 ? Object.freeze({ ...con.tags }) : undefined,
					});
				}
			}
		}

		// Table-level foreign keys — delegate to the shared builder so the module
		// `ADD CONSTRAINT` path and CREATE TABLE produce byte-identical schemas.
		for (const con of astConstraints ?? []) {
			if (con.type === 'foreignKey' && con.foreignKey && con.columns) {
				result.push(buildForeignKeyConstraintSchema(con, columnIndexMap, tableName, schemaName, takenNames));
			}
		}

		return result;
	}

	/**
	 * Extracts UNIQUE constraints from AST column and table constraint definitions.
	 * Resolves column names to indices.
	 */
	private extractUniqueConstraints(
		astColumns: readonly AST.ColumnDef[],
		astConstraints: readonly AST.TableConstraint[] | undefined,
		columnIndexMap: ReadonlyMap<string, number>,
	): UniqueConstraintSchema[] {
		const result: UniqueConstraintSchema[] = [];

		// Column-level unique constraints
		for (const colDef of astColumns) {
			for (const con of colDef.constraints ?? []) {
				if (con.type === 'unique') {
					const colIndex = columnIndexMap.get(colDef.name.toLowerCase());
					if (colIndex !== undefined) {
						result.push({
							name: con.name,
							columns: Object.freeze([colIndex]),
							defaultConflict: con.onConflict,
							tags: con.tags && Object.keys(con.tags).length > 0 ? Object.freeze({ ...con.tags }) : undefined,
						});
					}
				}
			}
		}

		// Table-level unique constraints — delegate to the shared builder (DRY with
		// the module `ADD CONSTRAINT` path).
		for (const con of astConstraints ?? []) {
			if (con.type === 'unique' && con.columns && con.columns.length > 0) {
				result.push(buildUniqueConstraintSchema(con, columnIndexMap));
			}
		}

		return result;
	}

	/**
	 * Builds a base TableSchema from an AST CREATE TABLE statement.
	 * Shared by both createTable (new storage) and importTable (existing storage).
	 */
	private buildTableSchemaFromAST(
		stmt: AST.CreateTableStmt,
		moduleName: string,
		effectiveModuleArgs: Readonly<Record<string, SqlValue>>,
		moduleInfo: { module: AnyVirtualTableModule; auxData?: unknown },
		/**
		 * Session `default_collation` for columns with no explicit COLLATE. The
		 * caller decides: `createTable` passes the live session option (user-authored
		 * CREATE), `importTable` passes `'BINARY'` (persisted DDL already made any
		 * non-BINARY collation explicit, so an omitted COLLATE is canonical BINARY).
		 */
		defaultCollation: string = 'BINARY'
	): TableSchema {
		// Stored schemaName is canonical (see canonicalSchemaName); the table name
		// keeps its declared display casing.
		const targetSchemaName = stmt.table.schema
			? this.canonicalSchemaName(stmt.table.schema)
			: this.getCurrentSchemaName();
		const tableName = stmt.table.name;

		const defaultNullability = this.db.options.getStringOption('default_column_nullability');
		const defaultNotNull = defaultNullability === 'not_null';

		const astColumns = stmt.columns || [];
		const { columns, pkDefinition, pkDefaultConflict } = this.buildColumnSchemas(astColumns, stmt.constraints, defaultNotNull, defaultCollation);
		// Statement-wide taken-set the CHECK / FK mint sites disambiguate against:
		// seeded with every user-written constraint name up front, then accumulating
		// each mint, so a colliding auto-name gets a `_<N>` suffix instead of
		// producing two constraints one name addresses. Shared across the extractors
		// — one name space, not three.
		const takenConstraintNames = collectDeclaredConstraintNames(astColumns, stmt.constraints);
		const checkConstraints = this.extractCheckConstraints(astColumns, stmt.constraints, takenConstraintNames);
		const columnIndexMap = buildColumnIndexMap(columns);
		const foreignKeys = this.extractForeignKeys(astColumns, stmt.constraints, columnIndexMap, tableName, targetSchemaName, takenConstraintNames);
		const uniqueConstraints = this.extractUniqueConstraints(astColumns, stmt.constraints, columnIndexMap);

		const mutationContextSchemas: MutationContextDefinition[] | undefined = stmt.contextDefinitions
			? stmt.contextDefinitions.map(varDef => mutationContextVarToSchema(varDef, defaultNotNull))
			: undefined;

		// Extract generated-column dependencies and validate that they form a DAG.
		// Cycle detection runs before module.create so an invalid schema never
		// reaches storage.
		const rawGenDeps = extractGeneratedColumnDependencies(columns, tableName);
		const genTopoOrder = rawGenDeps.size > 0
			? topoSortGeneratedColumns(columns, rawGenDeps)
			: undefined;
		const generatedColumnDependencies = rawGenDeps.size > 0
			? Object.freeze(new Map(
				Array.from(rawGenDeps.entries()).map(
					([k, v]) => [k, Object.freeze(v)] as const,
				),
			))
			: undefined;

		return {
			name: tableName,
			schemaName: targetSchemaName,
			columns: Object.freeze(columns),
			columnIndexMap,
			primaryKeyDefinition: pkDefinition,
			primaryKeyDefaultConflict: pkDefaultConflict,
			checkConstraints: Object.freeze(checkConstraints),
			foreignKeys: foreignKeys.length > 0 ? Object.freeze(foreignKeys) : undefined,
			uniqueConstraints: uniqueConstraints.length > 0 ? Object.freeze(uniqueConstraints) : undefined,
			isView: false,
			vtabModuleName: moduleName,
			vtabArgs: effectiveModuleArgs,
			vtabModule: moduleInfo.module,
			vtabAuxData: moduleInfo.auxData,
			estimatedRows: 0,
			mutationContext: mutationContextSchemas ? Object.freeze(mutationContextSchemas) : undefined,
			generatedColumnDependencies,
			generatedColumnTopoOrder: genTopoOrder ? Object.freeze(genTopoOrder) : undefined,
			tags: stmt.tags && Object.keys(stmt.tags).length > 0 ? Object.freeze({ ...stmt.tags }) : undefined,
		};
	}

	/**
	 * Builds a **logical** TableSchema spec from a declared CREATE TABLE AST,
	 * for use as the `logicalTable` of a lens slot (see `schema/lens.ts`).
	 *
	 * Reuses the same column / PK / constraint extraction as a physical table
	 * (so the spec is a faithful design), but carries **no** `vtabModule`
	 * (`vtabModuleName: ''`, `isLogical: true`) — a logical table is never
	 * registered or executed; its compiled effective body is registered as a
	 * `ViewSchema`. Module association / indexes / storage are rejected upstream
	 * by the lens compiler before this is called.
	 */
	buildLogicalTableSchema(stmt: AST.CreateTableStmt, schemaName: string): TableSchema {
		const tableName = stmt.table.name;
		const defaultNullability = this.db.options.getStringOption('default_column_nullability');
		const defaultNotNull = defaultNullability === 'not_null';
		// User-authored declaration shares the CREATE surface, so honor the session default.
		const defaultCollation = normalizeCollationName(this.db.options.getStringOption('default_collation'));

		const astColumns = stmt.columns || [];
		const { columns, pkDefinition, pkDefaultConflict } = this.buildColumnSchemas(astColumns, stmt.constraints, defaultNotNull, defaultCollation);
		// Same statement-wide mint disambiguation as buildTableSchemaFromAST, so a
		// logical spec and the physical table it describes mint identical names.
		const takenConstraintNames = collectDeclaredConstraintNames(astColumns, stmt.constraints);
		const checkConstraints = this.extractCheckConstraints(astColumns, stmt.constraints, takenConstraintNames);
		const columnIndexMap = buildColumnIndexMap(columns);
		const foreignKeys = this.extractForeignKeys(astColumns, stmt.constraints, columnIndexMap, tableName, schemaName, takenConstraintNames);
		const uniqueConstraints = this.extractUniqueConstraints(astColumns, stmt.constraints, columnIndexMap);

		return {
			name: tableName,
			schemaName,
			columns: Object.freeze(columns),
			columnIndexMap,
			primaryKeyDefinition: pkDefinition,
			primaryKeyDefaultConflict: pkDefaultConflict,
			checkConstraints: Object.freeze(checkConstraints),
			foreignKeys: foreignKeys.length > 0 ? Object.freeze(foreignKeys) : undefined,
			uniqueConstraints: uniqueConstraints.length > 0 ? Object.freeze(uniqueConstraints) : undefined,
			isView: false,
			isLogical: true,
			// Logical tables carry no module — they are a design, not storage.
			vtabModule: undefined,
			vtabModuleName: '',
			estimatedRows: 0,
			tags: stmt.tags && Object.keys(stmt.tags).length > 0 ? Object.freeze({ ...stmt.tags }) : undefined,
		};
	}

	/**
	 * Walks an expression AST and rejects bind-parameter and (optionally)
	 * column-reference nodes. Used by DDL-time DEFAULT/CHECK validators where
	 * such references are illegal even though they may otherwise build cleanly.
	 *
	 * Throws a QuereusError on the first offending node, with a message
	 * produced by the supplied formatters.
	 */
	private rejectIllegalReferences(
		expr: AST.AstNode,
		options: {
			rejectColumns: boolean;
			formatParamError: () => string;
			formatColumnError?: () => string;
		}
	): void {
		let offendingType: 'parameter' | 'column' | undefined;
		// A column reference nested inside a subquery is scoped to that subquery's own
		// FROM, not the row being inserted, so it is not an illegal sibling-row
		// reference — only top-level (depth-0) columns are. This is what lets a DEFAULT
		// author a self-referencing allocator like
		// `coalesce((select max(rid) from t), 0) + mutation_ordinal()` (the
		// shared-key-via-default surrogate recipe — docs/vu-mutation-context.md
		// § Mutation Context). Parameters stay rejected at any depth.
		let subqueryDepth = 0;
		const isQueryBoundary = (node: AST.AstNode): boolean =>
			node.type === 'select' || node.type === 'subquery' || node.type === 'exists';
		traverseAst(expr, {
			enterNode: (node: AST.AstNode) => {
				if (offendingType) return false;
				if (node.type === 'parameter') {
					offendingType = 'parameter';
					return false;
				}
				if (options.rejectColumns && node.type === 'column' && subqueryDepth === 0) {
					// `new.<column>` is an explicit, legal read of a value the INSERT
					// supplies for a sibling column (resolved against the row scope at
					// INSERT time); only a bare (unqualified) column is the illegal
					// sibling reference rejected here.
					if ((node as AST.ColumnExpr).table?.toLowerCase() !== 'new') {
						offendingType = 'column';
						return false;
					}
				}
				if (isQueryBoundary(node)) subqueryDepth += 1;
			},
			exitNode: (node: AST.AstNode) => {
				if (isQueryBoundary(node)) subqueryDepth -= 1;
			},
		});
		if (offendingType === 'parameter') {
			throw new QuereusError(options.formatParamError(), StatusCode.ERROR);
		}
		if (offendingType === 'column') {
			throw new QuereusError(options.formatColumnError!(), StatusCode.ERROR);
		}
	}

	/**
	 * Validates that all DEFAULT expressions in the column schemas are
	 * deterministic and free of bind parameters or (when no mutation
	 * context is defined) column references. Bind parameters and column
	 * references are rejected up-front via an AST pre-walk so the error
	 * messages stay specific (rather than degrading into "column not
	 * found" during expression building).
	 *
	 * When `hasMutationContext` is true, column-style identifiers are
	 * preserved because they may resolve to mutation-context variables at
	 * INSERT time (the AST cannot distinguish a real column from a
	 * context variable, and the build attempt is permitted to fail —
	 * scope resolution is deferred to row-time).
	 */
	/** True when a DEFAULT expression embeds a subquery (scalar subquery / EXISTS / SELECT). */
	private defaultEmbedsSubquery(expr: AST.AstNode): boolean {
		let found = false;
		traverseAst(expr, {
			enterNode: (node: AST.AstNode) => {
				if (node.type === 'select' || node.type === 'subquery' || node.type === 'exists') {
					found = true;
					return false;
				}
			},
		});
		return found;
	}

	/** True when a DEFAULT expression reads the row being written via `new.<column>`. */
	private defaultReferencesNewRow(expr: AST.AstNode): boolean {
		let found = false;
		traverseAst(expr, {
			enterNode: (node: AST.AstNode) => {
				if (found) return false;
				if (node.type === 'column' && (node as AST.ColumnExpr).table?.toLowerCase() === 'new') {
					found = true;
					return false;
				}
			},
		});
		return found;
	}

	/**
	 * Build the throwaway planning context (global + parameter scope, no table/row
	 * scope) used to compile a DEFAULT expression for DDL-time validation. The table's
	 * columns are intentionally absent so a bare-column reference fails to build —
	 * which the bare-column pre-walk has already rejected for the strict case, and
	 * which the deferral path tolerates for `new.`/subquery/mutation-context defaults.
	 */
	private makeDdlValidationContext(): PlanningContext {
		const globalScope = new GlobalScope(this.db.schemaManager);
		const parameterScope = new ParameterScope(globalScope);
		return {
			db: this.db,
			schemaManager: this.db.schemaManager,
			parameters: {},
			scope: parameterScope,
			cteNodes: new Map(),
			schemaDependencies: new BuildTimeDependencyTracker(),
			schemaCache: new Map(),
			cteReferenceCache: new Map(),
			outputScopes: new Map()
		};
	}

	/**
	 * Validate a single DEFAULT expression — the per-default core of
	 * {@link validateDefaultDeterminism}, factored out so the ALTER COLUMN SET DEFAULT
	 * path ({@link validateAlterColumnDefault}) routes through the identical checks:
	 * bind parameters and (absent a mutation context) bare columns rejected up front,
	 * non-determinism rejected unless `allowNonDeterministic`, and a `new.<column>` /
	 * subquery / mutation-context default deferred to INSERT time (it cannot build
	 * here without the row/table scope; determinism is re-checked when the row scope
	 * is established).
	 */
	private validateOneDefault(
		planningCtx: PlanningContext,
		defaultValue: AST.Expression,
		columnName: string,
		tableName: string,
		hasMutationContext: boolean,
		allowNonDeterministic: boolean,
		ddlPhase: string,
	): void {
		this.rejectIllegalReferences(defaultValue as AST.AstNode, {
			rejectColumns: !hasMutationContext,
			formatParamError: () =>
				`DEFAULT for column '${columnName}' in table '${tableName}' may not reference bind parameters.`,
			formatColumnError: () =>
				`DEFAULT for column '${columnName}' in table '${tableName}' may not reference a bare column; use 'new.<column>' to read a value supplied by the INSERT, or a generated column instead.`,
		});

		let defaultExpr: ScalarPlanNode | undefined;
		// A DEFAULT that embeds a subquery may forward-reference the table being
		// created (a self-referencing allocator — `select max(rid) from t` on `t`):
		// the table is not yet registered here, so the build legitimately fails.
		// A DEFAULT that reads `new.<column>` resolves only against the row scope
		// established at INSERT time, so it likewise cannot build here. Either way
		// determinism is re-checked at INSERT time (both the single-source insert
		// expansion and the shared-key envelope re-validate the compiled default),
		// so defer rather than reject. Other build failures (a typo'd function /
		// bare column) stay strict.
		const defaultEmbedsSubquery = this.defaultEmbedsSubquery(defaultValue as AST.AstNode);
		const defaultReferencesNewRow = this.defaultReferencesNewRow(defaultValue as AST.AstNode);
		try {
			defaultExpr = buildExpression(planningCtx, defaultValue) as ScalarPlanNode;
		} catch (e) {
			if (hasMutationContext || defaultEmbedsSubquery || defaultReferencesNewRow) {
				// Column-style identifiers in DEFAULT may resolve to mutation
				// context variables at INSERT time; a subquery may forward-reference
				// the table being created; `new.<column>` resolves against the INSERT
				// row scope. The row/table scope isn't available here, so a build
				// failure isn't necessarily a bug. Determinism is re-checked at
				// INSERT time.
				log('Skipping determinism validation for default on column %s.%s at %s time (deferred to INSERT%s): %s',
					tableName, columnName, ddlPhase,
					hasMutationContext ? ', mutation context present' : defaultEmbedsSubquery ? ', embeds subquery' : ', references new row',
					(e as Error).message);
			} else {
				const message = e instanceof Error ? e.message : String(e);
				const code = e instanceof QuereusError ? e.code : StatusCode.ERROR;
				throw new QuereusError(
					`DEFAULT for column '${columnName}' in table '${tableName}' is invalid: ${message}`,
					code,
					e instanceof Error ? e : undefined
				);
			}
		}

		if (!defaultExpr) return;

		if (allowNonDeterministic) return;

		const result = checkDeterministic(defaultExpr);
		if (!result.valid) {
			throw new QuereusError(
				`Non-deterministic expression not allowed in DEFAULT for column '${columnName}' in table '${tableName}'. ` +
				`Expression: ${result.expression}. ` +
				`Use mutation context to pass non-deterministic values (e.g., WITH CONTEXT (timestamp = datetime('now'))).`,
				StatusCode.ERROR
			);
		}
	}

	private validateDefaultDeterminism(
		columns: ReadonlyArray<ColumnSchema>,
		tableName: string,
		hasMutationContext: boolean,
		allowNonDeterministic: boolean = false
	): void {
		const planningCtx = this.makeDdlValidationContext();

		for (const col of columns) {
			if (!col.defaultValue || typeof col.defaultValue !== 'object' || col.defaultValue === null || !('type' in col.defaultValue)) {
				continue;
			}
			this.validateOneDefault(
				planningCtx,
				col.defaultValue as AST.Expression,
				col.name,
				tableName,
				hasMutationContext,
				allowNonDeterministic,
				'CREATE TABLE',
			);
		}
	}

	/**
	 * Validate a DEFAULT expression supplied by an `ALTER COLUMN … SET DEFAULT`,
	 * routing it through the same checks CREATE TABLE applies so the stored default is
	 * consistent with what INSERT will accept: bind parameters and (absent a mutation
	 * context) bare columns are rejected, non-determinism is rejected unless the
	 * `nondeterministic_schema` option is set, and a `new.<column>` default is accepted
	 * with the build/determinism check deferred to INSERT time. DROP DEFAULT (a null
	 * expression) never reaches here. Called from the ALTER TABLE runtime emitter.
	 */
	validateAlterColumnDefault(
		defaultExpr: AST.Expression,
		columnName: string,
		tableName: string,
		hasMutationContext: boolean,
	): void {
		this.validateDdlDefault(defaultExpr, columnName, tableName, hasMutationContext, 'ALTER COLUMN SET DEFAULT');
	}

	/**
	 * Validate a DEFAULT supplied by `ALTER TABLE ADD COLUMN`, routing it through the
	 * same checks CREATE TABLE / ALTER COLUMN apply so the stored default is consistent
	 * with what INSERT (and the per-row backfill) will accept: bind parameters and
	 * (absent a mutation context) bare columns are rejected, non-determinism is rejected
	 * unless `nondeterministic_schema` is set, and a `new.<column>` default is accepted
	 * with its build deferred — it reads the existing row's sibling during backfill and
	 * the INSERT-supplied sibling for future inserts. Called from the ALTER TABLE
	 * statement builder (`buildAlterTableStmt`) at plan-build time.
	 */
	validateAddColumnDefault(
		defaultExpr: AST.Expression,
		columnName: string,
		tableName: string,
		hasMutationContext: boolean,
	): void {
		this.validateDdlDefault(defaultExpr, columnName, tableName, hasMutationContext, 'ALTER TABLE ADD COLUMN');
	}

	/** Shared body for the ALTER-time DEFAULT validators (ALTER COLUMN SET DEFAULT / ADD COLUMN). */
	private validateDdlDefault(
		defaultExpr: AST.Expression,
		columnName: string,
		tableName: string,
		hasMutationContext: boolean,
		ddlPhase: string,
	): void {
		const allowNonDet = this.db.options.getBooleanOption('nondeterministic_schema');
		this.validateOneDefault(
			this.makeDdlValidationContext(),
			defaultExpr,
			columnName,
			tableName,
			hasMutationContext,
			allowNonDet,
			ddlPhase,
		);
	}

	/**
	 * Validates that CHECK constraint expressions don't call non-deterministic
	 * functions and don't reference bind parameters. Walks the AST and looks
	 * up each function call against the registry; raises if any function
	 * lacks the DETERMINISTIC flag. Avoids the full planning pipeline because
	 * CHECK expressions reference table columns whose scope is not yet
	 * established at CREATE TABLE time.
	 */
	private validateCheckConstraintDeterminism(
		checkConstraints: ReadonlyArray<RowConstraintSchema>,
		tableName: string,
		allowNonDeterministic: boolean = false
	): void {
		for (const cc of checkConstraints) {
			const constraintName = cc.name ?? `_check_${tableName}`;

			this.rejectIllegalReferences(cc.expr as AST.AstNode, {
				rejectColumns: false,
				formatParamError: () =>
					`CHECK constraint '${constraintName}' on table '${tableName}' may not reference bind parameters.`,
			});

			if (allowNonDeterministic) continue;

			let offendingExpr: AST.FunctionExpr | undefined;
			traverseAst(cc.expr as AST.AstNode, {
				enterNode: (node: AST.AstNode) => {
					if (offendingExpr) return false;
					if (node.type !== 'function') return;
					const fnNode = node as AST.FunctionExpr;
					const argCount = fnNode.args?.length ?? 0;
					const funcSchema = this.findFunction(fnNode.name, argCount)
						?? this.findFunction(fnNode.name, -1);
					if (funcSchema && (funcSchema.flags & FunctionFlags.DETERMINISTIC) === 0) {
						offendingExpr = fnNode;
						return false;
					}
				},
			});
			if (offendingExpr) {
				throw new QuereusError(
					`Non-deterministic expression not allowed in CHECK constraint '${constraintName}' on table '${tableName}'. ` +
					`Function '${offendingExpr.name}' is not deterministic. ` +
					`Use mutation context to pass non-deterministic values (e.g., WITH CONTEXT (timestamp = datetime('now'))).`,
					StatusCode.ERROR
				);
			}
		}
	}

	/**
	 * Registers a table schema after module.create() returns, correcting
	 * name/schema if the module returned different values.
	 */
	private finalizeCreatedTableSchema(
		tableInstance: VirtualTable,
		tableName: string,
		targetSchemaName: string,
		moduleName: string,
		effectiveModuleArgs: Readonly<Record<string, SqlValue>>,
		moduleInfo: { module: AnyVirtualTableModule; auxData?: unknown }
	): TableSchema {
		const finalRegisteredSchema = tableInstance.tableSchema;
		if (!finalRegisteredSchema) {
			throw new QuereusError(`Module '${moduleName}' create did not provide a tableSchema for '${tableName}'.`, StatusCode.INTERNAL);
		}

		let correctedSchema = finalRegisteredSchema;
		if (finalRegisteredSchema.name.toLowerCase() !== tableName.toLowerCase() ||
			finalRegisteredSchema.schemaName.toLowerCase() !== targetSchemaName.toLowerCase()) {
			warnLog(`Module ${moduleName} returned schema for ${finalRegisteredSchema.schemaName}.${finalRegisteredSchema.name} but expected ${targetSchemaName}.${tableName}. Correcting name/schemaName.`);
			correctedSchema = {
				...finalRegisteredSchema,
				name: tableName,
				schemaName: targetSchemaName,
			};
		}

		return {
			...correctedSchema,
			vtabModuleName: moduleName,
			vtabArgs: effectiveModuleArgs,
			vtabModule: moduleInfo.module,
			vtabAuxData: moduleInfo.auxData,
			estimatedRows: correctedSchema.estimatedRows ?? 0,
		};
	}

	/**
	 * Creates a new index on an existing table based on an AST.CreateIndexStmt.
	 *
	 * @param stmt The AST node for the CREATE INDEX statement.
	 * @throws QuereusError on errors (e.g., table not found, column not found, createIndex fails).
	 */
	async createIndex(stmt: AST.CreateIndexStmt): Promise<void> {
		const targetSchemaName = stmt.table.schema || this.getCurrentSchemaName();
		const tableName = stmt.table.name;
		const indexName = stmt.index.name;

		const tableSchema = this.getTable(targetSchemaName, tableName);
		if (!tableSchema) {
			throw new RelationNotFoundError(`no such table: ${tableName}`, undefined, stmt.table.loc?.start.line, stmt.table.loc?.start.column);
		}

		const vtabModule = requireVtabModule(tableSchema);
		if (!vtabModule.createIndex) {
			throw new QuereusError(`Virtual table module '${tableSchema.vtabModuleName}' for table '${tableName}' does not support CREATE INDEX.`, StatusCode.ERROR, undefined, stmt.table.loc?.start.line, stmt.table.loc?.start.column);
		}

		const existingIndex = tableSchema.indexes?.find(idx => idx.name.toLowerCase() === indexName.toLowerCase());
		// The implicit-covering term is what makes this refusal backend-independent.
		// Memory materializes a constraint's backing structure as a real `IndexSchema`
		// entry (so `existingIndex` alone catches it); the store keeps it out of the
		// engine-facing `indexes` list entirely, and without this term `create index
		// uq_email` would land on the *same* physical key-value store as the
		// constraint's backing structure (`buildIndexStoreName` is a pure function of
		// schema + table + index name). `isImplicitCoveringIndex` reads only
		// `uniqueConstraints`, which both backends carry, so one term covers both.
		const shadowsConstraintStructure = isImplicitCoveringIndex(tableSchema, indexName);
		if (existingIndex || shadowsConstraintStructure) {
			if (stmt.ifNotExists) {
				log(`Skipping CREATE INDEX: Index %s.%s already exists (IF NOT EXISTS).`, targetSchemaName, indexName);
				return;
			}
			throw new QuereusError(`Index ${indexName} already exists on table ${tableName}`, StatusCode.CONSTRAINT, undefined, stmt.index.loc?.start.line, stmt.index.loc?.start.column);
		}

		// Index names are unique per schema, not per table (docs/sql-ddl.md §6.3).
		// Every by-name index resolver — `dropIndex`, `updateIndexTags`, sync's
		// `findIndexOwner` — locates the owning table by first-match scan over the
		// schema's tables, and "first" is registration order, which is not stable
		// across devices. Rejecting the collision here is what makes all of them
		// unambiguous by construction. Deliberately NOT suppressed by IF NOT EXISTS:
		// an index of that name on a *different* table is a different object, so
		// silently skipping would leave the requested index absent with no signal.
		const collidingOwner = this.findIndexNameOwnerElsewhere(targetSchemaName, tableSchema.name, indexName);
		if (collidingOwner) {
			throw new QuereusError(
				`Index '${indexName}' already exists in schema '${targetSchemaName}' on table '${collidingOwner.name}'`,
				StatusCode.CONSTRAINT, undefined, stmt.index.loc?.start.line, stmt.index.loc?.start.column,
			);
		}

		const indexSchema = this.buildIndexSchema(stmt, tableSchema, tableName, indexName);

		try {
			// Module-facing stored-name contract (see canonicalSchemaName): hand the
			// module the resolved table's canonical schemaName and stored display
			// casing, never the raw `create index … on T` spelling — a module may key
			// storage/registries by these args verbatim. `indexSchema.name` is the
			// *new* index's own name (the future stored name), left as-spelled.
			await vtabModule.createIndex(this.db, tableSchema.schemaName, tableSchema.name, indexSchema);
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : String(e);
			const code = e instanceof QuereusError ? e.code : StatusCode.ERROR;
			throw new QuereusError(`createIndex failed for index '${indexName}' on table '${tableName}': ${message}`, code, e instanceof Error ? e : undefined, stmt.loc?.start.line, stmt.loc?.start.column);
		}

		const updatedTableSchema = appendIndexToTableSchema(tableSchema, indexSchema);
		const schema = this.getSchemaOrFail(targetSchemaName);
		schema.addTable(updatedTableSchema);

		this.changeNotifier.notifyChange({
			type: 'table_modified',
			// Stored names of the swapped table, not the raw statement spelling — see
			// canonicalSchemaName for the emitter/stored-name invariant. A raw
			// `create index … on T` (stored `t`) or an unqualified CREATE INDEX against
			// a `MAIN.`-created table would otherwise miss the cached plan's table dep.
			schemaName: updatedTableSchema.schemaName,
			objectName: updatedTableSchema.name,
			oldObject: tableSchema,
			newObject: updatedTableSchema
		});

		this.emitAutoSchemaEventIfNeeded(tableSchema.vtabModuleName, {
			type: 'create',
			objectType: 'index',
			schemaName: updatedTableSchema.schemaName,
			objectName: indexName,
		});

		log(`Successfully created index %s on table %s.%s`, indexName, targetSchemaName, tableName);
	}

	/**
	 * Builds an IndexSchema from AST column definitions, validating against the table schema.
	 */
	private buildIndexSchema(
		stmt: AST.CreateIndexStmt,
		tableSchema: TableSchema,
		tableName: string,
		indexName: string
	): IndexSchema {
		const indexColumns = stmt.columns.map((indexedCol: AST.IndexedColumn) => {
			// The parser folds `col COLLATE x` into a collate expression over a bare
			// column reference; resolveImportedIndexColumn unwraps that form to a
			// { name, collation } pair, mirroring importIndex. A genuine expression
			// index (non-column operand) resolves to an unset name and is rejected.
			const { name: colName, collation } = resolveImportedIndexColumn(indexedCol);
			if (!colName) {
				throw new QuereusError(`Indices on expressions are not supported yet.`, StatusCode.ERROR, undefined, indexedCol.expr?.loc?.start.line, indexedCol.expr?.loc?.start.column);
			}
			const tableColIndex = tableSchema.columnIndexMap.get(colName.toLowerCase());
			if (tableColIndex === undefined) {
				throw new QuereusError(`Column '${colName}' not found in table '${tableName}'`, StatusCode.ERROR, undefined, stmt.loc?.start.line, stmt.loc?.start.column);
			}
			const tableColSchema = tableSchema.columns[tableColIndex];
			return {
				index: tableColIndex,
				desc: indexedCol.direction === 'desc',
				collation: normalizeCollationName(collation || tableColSchema.collation || 'BINARY')
			};
		});

		return {
			name: indexName,
			columns: Object.freeze(indexColumns),
			unique: stmt.isUnique || undefined,
			predicate: stmt.where,
			tags: stmt.tags && Object.keys(stmt.tags).length > 0 ? Object.freeze({ ...stmt.tags }) : undefined,
		};
	}

	/**
	 * The table in `schemaName` owning the index named `indexName`, paired with the
	 * matched {@link IndexSchema} — or `undefined` when nothing in scope carries the
	 * name. The one by-name index-owner resolver: `DROP INDEX` ({@link dropIndex} and
	 * the strict-DDL-policy gate in `runtime/emit/drop-index.ts`),
	 * `ALTER INDEX … TAGS` ({@link resolveIndexTagSwap}), `CREATE INDEX`'s
	 * schema-wide name-uniqueness check ({@link findIndexNameOwnerElsewhere}) and
	 * `@quereus/sync`'s replicated index DDL all funnel here.
	 *
	 * Index names are unique per schema, not per table (docs/sql-ddl.md §6.3), and
	 * {@link createIndex} rejects a name already taken elsewhere in the schema, so
	 * first-match is unambiguous by construction. That invariant is what makes
	 * replication safe: a replicated `drop index "main"."idx"` carries no table name
	 * (the DROP INDEX grammar has no slot for one), so without it each receiver would
	 * resolve the owner by its own table-registration order and two devices could drop
	 * different indexes while both believing they converged.
	 *
	 * An out-of-scope match is **skipped and the scan continues** — never stopped at.
	 * That is what lets one table's constraint-backed `uq_email` coexist with another
	 * table's real index of the same name (constraint names are unique per *table*, so
	 * two tables may each declare `constraint uq_email unique (email)`). Both scope
	 * predicates read only `uniqueConstraints`, which every backend carries, so the
	 * filter behaves the same on the store as in memory.
	 *
	 * Case-insensitive on both `indexName` and `options.excludeTable`, like every
	 * other index-name comparison in the engine. An unknown `schemaName` yields
	 * `undefined` rather than throwing — callers that must distinguish a missing
	 * schema from a missing index check for it themselves first.
	 *
	 * @param options.scope Which part of the namespace to consider; defaults to
	 *   `'user-indexes'` (see {@link IndexLookupScope}).
	 * @param options.excludeTable Skip this table entirely — used by the
	 *   name-uniqueness check, which asks about *other* tables only.
	 */
	findIndexOwner(
		schemaName: string,
		indexName: string,
		options?: { scope?: IndexLookupScope; excludeTable?: string },
	): IndexOwnerMatch | undefined {
		const schema = this.getSchema(schemaName);
		if (!schema) return undefined;

		const outOfScope = options?.scope === 'tag-addressable' ? isHiddenImplicitIndex : isImplicitCoveringIndex;
		const lowerIndexName = indexName.toLowerCase();
		const lowerExcluded = options?.excludeTable?.toLowerCase();
		for (const table of schema.getAllTables()) {
			if (lowerExcluded !== undefined && table.name.toLowerCase() === lowerExcluded) continue;
			const index = table.indexes?.find(idx => idx.name.toLowerCase() === lowerIndexName);
			if (!index || outOfScope(table, index.name)) continue;
			return { table, index };
		}
		return undefined;
	}

	/**
	 * The table in `targetSchemaName` — other than `ownerTableName` — that already
	 * carries a **user** index named `indexName`, or `undefined` when the name is
	 * free. Backs the schema-wide index-name uniqueness rule enforced by
	 * {@link createIndex} and warned about by {@link importIndex}.
	 *
	 * Implicit covering structures are skipped (the default
	 * {@link findIndexOwner} scope): counting them would reject a valid schema in
	 * which two tables each declare `constraint uq_email unique (email)`.
	 *
	 * NOTE: an *exposed* implicit covering index (constraint tagged
	 * `quereus.expose_implicit_index`) IS user-addressable by `ALTER INDEX`, so two
	 * tables exposing the same implicit name leave a residual first-match ambiguity
	 * there. It cannot be closed here — that collision is created by `create table`,
	 * not `create index` — and closing it would mean making constraint names unique
	 * per schema.
	 */
	private findIndexNameOwnerElsewhere(
		targetSchemaName: string,
		ownerTableName: string,
		indexName: string,
	): TableSchema | undefined {
		return this.findIndexOwner(targetSchemaName, indexName, { excludeTable: ownerTableName })?.table;
	}

	/**
	 * Drops a secondary index from the table that owns it.
	 * Searches all tables in the target schema to find the owning table.
	 *
	 * An implicit covering structure — the auto-built secondary BTree backing a
	 * declared `UNIQUE` constraint, named after that constraint (or `_uc_<cols>`) —
	 * is NOT droppable this way, exposed or not: its lifecycle belongs to the
	 * constraint, so removing it means `ALTER TABLE … DROP CONSTRAINT`. The owner
	 * scan therefore *skips and keeps scanning* past such a match rather than
	 * stopping at it, so a real user index of the same name on another table is
	 * still found (constraint names are unique per table, not per schema — see
	 * {@link findIndexNameOwnerElsewhere}). With no owner found this falls through
	 * to the `IF EXISTS` / `no such index` handling below, matching what
	 * `ALTER INDEX … SET TAGS` already does with the same name.
	 *
	 * @param schemaName The schema to search in (e.g., "main")
	 * @param indexName The name of the index to drop
	 * @param ifExists If true, silently return if the index is not found
	 */
	async dropIndex(schemaName: string, indexName: string, ifExists: boolean = false): Promise<void> {
		const schema = this.getSchema(schemaName);
		if (!schema) {
			if (ifExists) return;
			throw new QuereusError(`Schema not found: ${schemaName}`, StatusCode.ERROR);
		}

		// Find which table owns this index.
		// NOTE: a table may hold a UNIQUE constraint whose name equals an unrelated
		// user index's name on that same table (`create index foo on t (b); alter
		// table t add constraint foo unique (a);` — both succeed today). There the
		// out-of-scope predicate is true and this refuses the drop even though a real
		// index also carries the name. That state is already broken in worse ways
		// (memory materializes two entries literally named `foo`) and is tracked as
		// bug-unique-constraint-name-collides-with-index-name; refusing is the
		// conservative outcome — do not shape-match around it here.
		const lowerIndexName = indexName.toLowerCase();
		const ownerMatch = this.findIndexOwner(schemaName, indexName);

		if (!ownerMatch) {
			if (ifExists) {
				log(`Index %s.%s not found, but IF EXISTS specified`, schemaName, indexName);
				return;
			}
			throw new QuereusError(`no such index: ${indexName}`, StatusCode.ERROR);
		}

		const ownerTable = ownerMatch.table;
		// Stored display casing of the dropped index — the raw `indexName` arg may
		// differ in case. Taken from the matched IndexSchema, i.e. *before* the module
		// call, so module.dropIndex receives the stored name (the module-facing
		// stored-name contract; see canonicalSchemaName), keeping a case-divergent
		// `DROP INDEX iDx` from missing a module handle/registry keyed by the stored
		// `idx` (e.g. the store's StoreTable.indexStores cache). Also reused by the
		// events below.
		const storedIndexName = ownerMatch.index.name;

		// Call module.dropIndex if the module supports it
		const moduleReg = ownerTable.vtabModuleName ? this.getModule(ownerTable.vtabModuleName) : undefined;
		if (moduleReg?.module?.dropIndex) {
			try {
				await moduleReg.module.dropIndex(this.db, ownerTable.schemaName, ownerTable.name, storedIndexName);
			} catch (e: unknown) {
				const message = e instanceof Error ? e.message : String(e);
				const code = e instanceof QuereusError ? e.code : StatusCode.ERROR;
				throw new QuereusError(
					`dropIndex failed for index '${indexName}' on table '${ownerTable.name}': ${message}`,
					code, e instanceof Error ? e : undefined
				);
			}
		}

		// Remove the index from the table schema, along with any uniqueConstraint
		// that was synthesized from this index (see appendIndexToTableSchema).
		const updatedIndexes = (ownerTable.indexes || []).filter(
			idx => idx.name.toLowerCase() !== lowerIndexName
		);
		const updatedUniqueConstraints = (ownerTable.uniqueConstraints ?? []).filter(
			uc => uc.derivedFromIndex?.toLowerCase() !== lowerIndexName
		);
		const updatedTableSchema: TableSchema = {
			...ownerTable,
			indexes: Object.freeze(updatedIndexes),
			uniqueConstraints: updatedUniqueConstraints.length > 0
				? Object.freeze(updatedUniqueConstraints)
				: undefined,
		};
		schema.addTable(updatedTableSchema);

		this.changeNotifier.notifyChange({
			type: 'table_modified',
			// Stored names of the swapped table, not the raw drop args — see
			// canonicalSchemaName for the emitter/stored-name invariant.
			schemaName: ownerTable.schemaName,
			objectName: ownerTable.name,
			oldObject: ownerTable,
			newObject: updatedTableSchema
		});

		this.emitAutoSchemaEventIfNeeded(ownerTable.vtabModuleName, {
			type: 'drop',
			objectType: 'index',
			schemaName: ownerTable.schemaName,
			objectName: storedIndexName,
		});

		log(`Successfully dropped index %s from table %s.%s`, indexName, schemaName, ownerTable.name);
	}

	/**
	 * Emits an auto schema event for modules that don't have native event support,
	 * if the engine needs schema events — i.e. any `onSchemaChange` or
	 * `onTransactionCommit` listener is registered (see `Database._needsSchemaEvents`).
	 *
	 * NOTE: the auto events raised from THIS class (create/drop table, create/drop
	 * index) carry no `ddl` — the callers have only the (schema, object) names here,
	 * not the object schema each generator needs. Fine today: the only consumer that
	 * reads `ddl` is sync replication, which runs over the store module, and that
	 * module has native event support so this fallback never fires for it. If a
	 * module without native events ever needs to replicate creates/drops, thread the
	 * object schema in and call the `schema/ddl-generator.ts` generators here the way
	 * the store and memory modules do at their own emit sites. The ALTER TABLE arms
	 * are the exception: they pass through this same gate WITH `ddl` (the statement's
	 * plan-build rendering — see `runtime/emit/alter-schema-event.ts`), so an ALTER's
	 * auto event announces the same text an emitter-backed module does.
	 *
	 * Public because the `ALTER TABLE` arms live outside this class
	 * (`runtime/emit/alter-table.ts`, `runtime/emit/add-constraint.ts`) and must reach the
	 * SAME gate. Re-deciding "no listener / module has its own emitter" at a second site is
	 * exactly what produced the data-channel double-emit the store package's
	 * `database-events.spec.ts` guards against — keep one gate.
	 */
	emitAutoSchemaEventIfNeeded(
		moduleName: string | undefined,
		event: VTableSchemaChangeEvent
	): void {
		const moduleReg = moduleName ? this.getModule(moduleName) : undefined;
		if (this.db._needsSchemaEvents() && !hasNativeEventSupport(moduleReg?.module)) {
			this.db._getEventEmitter().emitAutoSchemaEvent(moduleName ?? 'memory', event);
		}
	}

	/**
	 * Defines a new table in the schema based on an AST.CreateTableStmt.
	 * Interacts with VTab modules (create) and registers the new table schema.
	 *
	 * @param stmt The AST node for the CREATE TABLE statement.
	 * @returns A Promise that resolves to the created TableSchema.
	 * @throws QuereusError on errors (e.g., module not found, create fails, table exists).
	 */
	/**
	 * Builds the {@link TableSchema} a CREATE TABLE statement WOULD register,
	 * without touching the module or the catalog. Resolution matches
	 * {@link createTable} exactly (same module-info resolution, same live-session
	 * default collation), so the result is byte-for-byte what registration would
	 * produce. Used by the maintained-table create path
	 * (`createMaintainedTable`) to verify the declared shape against the
	 * derivation body BEFORE any catalog registration — the all-or-nothing
	 * posture of `create table … maintained as`.
	 */
	buildDeclaredTableSchema(stmt: AST.CreateTableStmt): TableSchema {
		const { moduleName, effectiveModuleArgs, moduleInfo } = this.resolveModuleInfo(stmt);
		const defaultCollation = normalizeCollationName(this.db.options.getStringOption('default_collation'));
		return this.buildTableSchemaFromAST(stmt, moduleName, effectiveModuleArgs, moduleInfo, defaultCollation);
	}

	/**
	 * `preferBacking` routes the module instantiation through the durable backing
	 * seam — `createBacking?() ?? create()`, the SAME preference
	 * {@link createBackingTable} uses — instead of `module.create` directly. It is
	 * set ONLY by the maintained-table create path (`createMaintainedTable`), so a
	 * durable-backing module (e.g. lamina) builds the basis `RowStore` that
	 * `getBackingHost` later resolves for row-time maintenance; without it the table
	 * is an ordinary relational collection with no basis store, and the maintained
	 * fill throws `backing host not found`. An ordinary user CREATE leaves it false
	 * and stays byte-for-byte on `module.create`. A module without `createBacking`
	 * (e.g. memory) falls through to `create` regardless, so the flag is a no-op
	 * there. Every gate above (determinism, FK-collation) runs identically in both
	 * modes — the flag only selects the factory method.
	 */
	async createTable(stmt: AST.CreateTableStmt, preferBacking = false): Promise<TableSchema> {
		const targetSchemaName = stmt.table.schema || this.getCurrentSchemaName();
		const tableName = stmt.table.name;

		const schema = this.getSchema(targetSchemaName);
		if (!schema) {
			throw new QuereusError(`Internal error: Schema '${targetSchemaName}' not found.`, StatusCode.INTERNAL);
		}

		const seenColumnNames = new Set<string>();
		for (const col of stmt.columns) {
			const lower = col.name.toLowerCase();
			if (seenColumnNames.has(lower)) {
				throw new QuereusError(`Duplicate column name: ${col.name}`, StatusCode.ERROR, undefined, stmt.table.loc?.start.line, stmt.table.loc?.start.column);
			}
			seenColumnNames.add(lower);
		}

		const existingTable = schema.getTable(tableName);
		const existingView = schema.getView(tableName);

		if (existingTable || existingView) {
			if (stmt.ifNotExists) {
				log(`Skipping CREATE TABLE: Item %s.%s already exists (IF NOT EXISTS).`, targetSchemaName, tableName);
				if (existingTable) return existingTable;
				throw new QuereusError(`Cannot CREATE TABLE ${targetSchemaName}.${tableName}: a VIEW with the same name already exists.`, StatusCode.CONSTRAINT, undefined, stmt.table.loc?.start.line, stmt.table.loc?.start.column);
			}
			const itemType = existingTable ? 'Table' : 'View';
			throw new QuereusError(`${itemType} ${targetSchemaName}.${tableName} already exists`, StatusCode.CONSTRAINT, undefined, stmt.table.loc?.start.line, stmt.table.loc?.start.column);
		}

		const { moduleName, effectiveModuleArgs, moduleInfo } = this.resolveModuleInfo(stmt);
		// User-authored CREATE: omitted-COLLATE columns resolve under the live session default.
		const defaultCollation = normalizeCollationName(this.db.options.getStringOption('default_collation'));
		const baseTableSchema = this.buildTableSchemaFromAST(stmt, moduleName, effectiveModuleArgs, moduleInfo, defaultCollation);

		const hasMutationContext = !!baseTableSchema.mutationContext && baseTableSchema.mutationContext.length > 0;
		// `nondeterministic_schema = true` lifts the strict-rejection gate at CREATE TABLE.
		// The captured artifact at the vtab.update() frontier is fully resolved per row, so
		// defaults / CHECKs / generated columns containing non-determinism remain replay-safe
		// (see docs/architecture.md § Constraints and docs/module-authoring.md § Mutation Statements).
		// The bind-parameter / column-reference pre-walks inside the validators still run
		// in both modes — those are scope checks, not determinism checks.
		const allowNonDet = this.db.options.getBooleanOption('nondeterministic_schema');
		this.validateDefaultDeterminism(baseTableSchema.columns, tableName, hasMutationContext, allowNonDet);
		this.validateCheckConstraintDeterminism(baseTableSchema.checkConstraints, tableName, allowNonDet);

		// Refuse a CREATE TABLE carrying two user-written constraint names that collide —
		// one case-folded name space across CHECK / UNIQUE / FK, so the same-class shape
		// (DROP removes both) and the cross-class shape (permanently un-droppable as
		// ambiguous) are both refused at birth. Same rule every ALTER path enforces via
		// `assertConstraintNameFree`; reads the raw declaration, so engine-minted names
		// (two unnamed CHECKs on one column — legal) are not compared. Placement shares
		// the duplicate-UNIQUE guard's rationale below.
		assertNoDuplicateConstraintNames(stmt.columns ?? [], stmt.constraints, `create table '${tableName}'`);

		// Refuse a CREATE TABLE that declares the same plain UNIQUE twice — the same rule
		// `ALTER TABLE ADD CONSTRAINT` / `ADD COLUMN … unique` apply, so a duplicate is
		// refused identically wherever it is written. Before `module.create`, so the
		// statement leaves no storage behind. Deliberately here rather than in
		// `buildTableSchemaFromAST`: the import/rehydrate path shares that builder and must
		// still open a catalog written before this guard existed (same placement rationale
		// as the FK-collation check below).
		assertNoDuplicateUniqueConstraints(
			baseTableSchema.uniqueConstraints ?? [],
			baseTableSchema.columns,
			`create table '${tableName}'`,
		);

		let tableInstance: VirtualTable;
		try {
			// `preferBacking` (set only by the maintained-table create path) routes
			// through the durable backing seam — the SAME `createBacking?() ?? create()`
			// preference {@link createBackingTable} uses — so a durable-backing module
			// builds the basis `RowStore` that `getBackingHost` later resolves for
			// row-time maintenance. An ordinary user CREATE leaves it false and stays
			// byte-for-byte on `module.create`; a module without `createBacking` (memory)
			// falls through to `create` regardless.
			const create = preferBacking
				? (moduleInfo.module.createBacking?.bind(moduleInfo.module) ?? moduleInfo.module.create.bind(moduleInfo.module))
				: moduleInfo.module.create.bind(moduleInfo.module);
			tableInstance = await create(this.db, baseTableSchema);
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : String(e);
			const code = e instanceof QuereusError ? e.code : StatusCode.ERROR;
			throw new QuereusError(`Module '${moduleName}' create failed for table '${tableName}': ${message}`, code, e instanceof Error ? e : undefined, stmt.loc?.start.line, stmt.loc?.start.column);
		}

		const completeTableSchema = this.finalizeCreatedTableSchema(
			tableInstance, tableName, targetSchemaName, moduleName, effectiveModuleArgs, moduleInfo
		);

		// Reject a FK whose child/parent column collations declare a same-rank conflict
		// — the same conflict FK enforcement raises at first DML, surfaced here at CREATE.
		// `completeTableSchema` is post-reconcile (the store's `reconcilePkCollations` ran
		// inside `module.create`), so an implicit-default text PK reconciled to the store's
		// NOCASE keeps `collationExplicit` unset → contributes the engine floor, never a
		// false conflict. Done BEFORE `addTable` so a conflicting FK leaves the catalog
		// clean (a self-ref FK resolves against `completeTableSchema` itself). Deliberately
		// only here — never in `buildTableSchemaFromAST` or the import/rehydrate path, so a
		// legacy persisted conflicting FK reloads fine and still surfaces at DML.
		for (const fk of completeTableSchema.foreignKeys ?? []) {
			validateForeignKeyCollations(this.db, completeTableSchema, fk);
		}

		schema.addTable(completeTableSchema);
		log(`Successfully created table %s.%s using module %s`, targetSchemaName, tableName, moduleName);

		this.changeNotifier.notifyChange({
			type: 'table_added',
			// Stored names of the registered table — see canonicalSchemaName for the
			// emitter/stored-name invariant.
			schemaName: completeTableSchema.schemaName,
			objectName: completeTableSchema.name,
			newObject: completeTableSchema
		});

		this.emitAutoSchemaEventIfNeeded(moduleName, {
			type: 'create',
			objectType: 'table',
			schemaName: completeTableSchema.schemaName,
			objectName: completeTableSchema.name,
		});

		return completeTableSchema;
	}

	/**
	 * Creates a backing table from a pre-built `TableSchema` rather than a
	 * CREATE TABLE AST. Used by materialized views, whose backing-table columns
	 * and primary key are derived from the optimized body relation (carrying
	 * full {@link import('../common/datatype.js').ScalarType} fidelity that a
	 * round-trip through SQL type strings would lose).
	 *
	 * Reuses the same internal sequence as {@link createTable} —
	 * `finalizeCreatedTableSchema` → `addTable` → `table_added` notify — so the
	 * backing table behaves like any other table, except the instance is built via
	 * the module's optional `createBacking` when present (`createBacking?() ??
	 * create()`): a durable-backing module routes the backing into its durable
	 * store there; modules without it fall through to `create` (today's behavior).
	 * The supplied schema must carry `vtabModule`/`vtabModuleName` (typically
	 * `memory`).
	 */
	async createBackingTable(tableSchema: TableSchema): Promise<TableSchema> {
		const targetSchemaName = tableSchema.schemaName;
		const tableName = tableSchema.name;

		const schema = this.getSchema(targetSchemaName);
		if (!schema) {
			throw new QuereusError(`Internal error: Schema '${targetSchemaName}' not found.`, StatusCode.INTERNAL);
		}

		if (schema.getTable(tableName) || schema.getView(tableName)) {
			throw new QuereusError(`Backing table ${targetSchemaName}.${tableName} already exists`, StatusCode.CONSTRAINT);
		}

		const moduleName = tableSchema.vtabModuleName;
		const moduleInfo = this.getModule(moduleName);
		if (!moduleInfo || !moduleInfo.module) {
			throw new QuereusError(`No virtual table module named '${moduleName}'`, StatusCode.ERROR);
		}

		let tableInstance: VirtualTable;
		try {
			const create = moduleInfo.module.createBacking?.bind(moduleInfo.module)
				?? moduleInfo.module.create.bind(moduleInfo.module);
			tableInstance = await create(this.db, tableSchema);
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : String(e);
			const code = e instanceof QuereusError ? e.code : StatusCode.ERROR;
			throw new QuereusError(`Module '${moduleName}' backing create failed for '${tableName}': ${message}`, code, e instanceof Error ? e : undefined);
		}

		const completeTableSchema = this.finalizeCreatedTableSchema(
			tableInstance, tableName, targetSchemaName, moduleName, tableSchema.vtabArgs ?? {}, moduleInfo
		);

		schema.addTable(completeTableSchema);
		log(`Successfully created backing table %s.%s using module %s`, targetSchemaName, tableName, moduleName);

		this.changeNotifier.notifyChange({
			type: 'table_added',
			schemaName: targetSchemaName,
			objectName: tableName,
			newObject: completeTableSchema
		});

		this.emitAutoSchemaEventIfNeeded(moduleName, {
			type: 'create',
			objectType: 'table',
			schemaName: targetSchemaName,
			objectName: tableName,
		});

		return completeTableSchema;
	}

	/**
	 * Import catalog objects from DDL statements without triggering storage creation.
	 * Used when connecting to existing storage that already contains data.
	 *
	 * Options enable the materialized-view **adopt-without-refill fast path**
	 * (see {@link importMaterializedView}); omitted, every MV refills — the
	 * always-correct default.
	 *
	 * This method:
	 * 1. Parses each DDL statement
	 * 2. Registers the schema objects (tables, indexes, views, materialized views)
	 * 3. Calls module.connect() instead of module.create() for tables (a
	 *    materialized view's memory backing is re-materialized instead — see
	 *    {@link importMaterializedView})
	 * 4. Skips schema change hooks (since these are existing objects)
	 *
	 * Each DDL string may hold **one or more** statements: a catalog entry can
	 * bundle a `CREATE TABLE` immediately followed by the `CREATE INDEX`es that
	 * belong to it. Statements within an entry are imported in document order, so
	 * a table always precedes the indexes that reference it. (Because every
	 * table's indexes are co-located with it in one entry, no global
	 * table-before-index ordering across entries is required.)
	 *
	 * @param ddlStatements Array of DDL strings (each one or more CREATE TABLE / CREATE INDEX, etc.)
	 * @param options Adopt-fast-path options for materialized views — see {@link ImportCatalogOptions}
	 * @returns Array of imported object names
	 */
	async importCatalog(ddlStatements: string[], options?: ImportCatalogOptions): Promise<{ tables: string[]; indexes: string[]; views: string[]; materializedViews: string[] }> {
		const imported = { tables: [] as string[], indexes: [] as string[], views: [] as string[], materializedViews: [] as string[] };

		for (const ddl of ddlStatements) {
			try {
				for (const result of await this.importDDL(ddl, options)) {
					if (result.type === 'table') {
						imported.tables.push(result.name);
					} else if (result.type === 'index') {
						imported.indexes.push(result.name);
					} else if (result.type === 'view') {
						imported.views.push(result.name);
					} else {
						imported.materializedViews.push(result.name);
					}
				}
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				errorLog('Failed to import DDL: %s - Error: %s', ddl.substring(0, 100), message);
				throw e;
			}
		}

		log('Imported catalog: %d tables, %d indexes, %d views, %d materialized views',
			imported.tables.length, imported.indexes.length, imported.views.length, imported.materializedViews.length);
		return imported;
	}

	/**
	 * Import every statement in a DDL string without creating storage, in document
	 * order. A single string may carry several statements (a table bundled with
	 * its indexes); single-statement entries remain valid. An `alter index … tags`
	 * statement (the store bundle's vehicle for exposed-implicit-index user tags)
	 * applies silently against the just-imported table and contributes no result
	 * entry — it modifies an existing object rather than importing one. Any other
	 * unsupported statement type throws — `rehydrateCatalog` relies on this
	 * fail-loud contract to record import errors rather than silently dropping
	 * objects.
	 */
	private async importDDL(ddl: string, options?: ImportCatalogOptions): Promise<Array<{ type: 'table' | 'index' | 'view' | 'materializedView'; name: string }>> {
		const parser = new Parser();
		const statements = parser.parseAll(ddl);

		const results: Array<{ type: 'table' | 'index' | 'view' | 'materializedView'; name: string }> = [];
		for (const stmt of statements) {
			if (stmt.type === 'createTable') {
				const createTable = stmt as AST.CreateTableStmt;
				// Unified model: a maintained table persists/exports as the canonical
				// `create table … maintained as <body>` form (see generateMaintainedTableDDL).
				// That re-parses as a createTable carrying a `maintained` clause, so route
				// it through the same re-materialize/adopt path as the MV sugar — the plain
				// `importTable` connect path would try (and fail) to reconnect an ephemeral
				// backing that was never persisted.
				if (createTable.maintained) {
					results.push(await this.importMaterializedView(maintainedImportFromTableStmt(createTable), options));
				} else {
					results.push(await this.importTable(createTable));
				}
			} else if (stmt.type === 'createIndex') {
				results.push(await this.importIndex(stmt as AST.CreateIndexStmt));
			} else if (stmt.type === 'createView') {
				// Plain views import silently (body planning deferred to first reference).
				results.push(this.importView(stmt as AST.CreateViewStmt));
			} else if (stmt.type === 'createMaterializedView') {
				// Materialized views re-materialize (backing rebuilt from current source
				// data, row-time maintenance re-registered) — silent like the other arms.
				// Under `options.trustBackings` a pre-existing durable backing that
				// passes every adopt gate is adopted without the refill.
				results.push(await this.importMaterializedView(maintainedImportFromMvStmt(stmt as AST.CreateMaterializedViewStmt), options));
			} else if (stmt.type === 'alterIndex') {
				// Tag re-application on an already-imported object — no result entry.
				this.applyImportedIndexTags(stmt as AST.AlterIndexStmt);
			} else {
				throw new QuereusError(`importCatalog does not support statement type: ${stmt.type}`, StatusCode.ERROR);
			}
		}
		return results;
	}

	/**
	 * Apply an `alter index … {set|add|drop} tags` statement during catalog import,
	 * **silently** — no `notifyChange`, mirroring {@link importTable}/{@link importIndex}
	 * (a store rehydrating its own catalog must not re-emit persistence events).
	 * Shares {@link resolveIndexTagSwap} with the live {@link updateIndexTags} path,
	 * so the bundle's statement resolves exactly as a user-issued ALTER would —
	 * materialized `IndexSchema` first, then the exposed-implicit-constraint
	 * fallback (the store-bundle case: the `alter index` line follows its
	 * `CREATE TABLE` in the same entry, so the constraint is already registered).
	 * All three action forms map through the shared `freezeTags`/`mutateTagRecord`
	 * helpers, though the bundle generator only emits the whole-set replace form.
	 * An unresolvable target throws NOTFOUND — the bundle and its alter line come
	 * from one `TableSchema` snapshot, so a miss indicates real corruption, which
	 * `rehydrateCatalog` records per-entry.
	 */
	private applyImportedIndexTags(stmt: AST.AlterIndexStmt): void {
		const targetSchemaName = stmt.name.schema ?? this.getCurrentSchemaName();
		const action = stmt.action;
		let compute: TagCompute;
		if (action.type === 'dropTags') {
			compute = current => this.mutateTagRecord(current, { op: 'drop', keys: action.keys });
		} else if (action.mode === 'merge') {
			compute = current => this.mutateTagRecord(current, { op: 'merge', tags: action.tags });
		} else {
			compute = () => this.freezeTags(action.tags);
		}
		const { newSchema } = this.resolveIndexTagSwap(targetSchemaName, stmt.name.name, compute);
		this.getSchemaOrFail(targetSchemaName).addTable(newSchema);
		log(`Applied imported index tags for %s in schema %s`, stmt.name.name, targetSchemaName);
	}

	/**
	 * Import a plain view from its parsed DDL **without planning the body**.
	 * Registration is silent — no `notifyChange` fires, mirroring
	 * {@link importTable}/{@link importIndex} (a store rehydrating its own catalog
	 * must not re-emit persistence events). Body validation is deferred to first
	 * reference, exactly as {@link importTable} defers create-time work via
	 * `connect`: this makes view rehydration order-independent — a view over
	 * another view, a materialized view, or a not-yet-imported relation registers
	 * regardless of phase order, and a broken body surfaces only when queried.
	 *
	 * The stored `sql` is the canonical {@link createViewToString} rendering (not
	 * the raw entry text, which may bundle several statements). Synchronous: unlike
	 * table/index import there is no module storage to bind, so there is nothing to
	 * await.
	 */
	private importView(stmt: AST.CreateViewStmt): { type: 'view'; name: string } {
		// Create the schema if absent (mirrors importTable) so a view rehydrates
		// even into a schema that holds no tables; its `.name` is the canonical
		// stored schemaName (see canonicalSchemaName).
		const schema = this.getOrCreateSchema(stmt.view.schema || this.getCurrentSchemaName());
		const targetSchemaName = schema.name;
		const viewName = stmt.view.name;

		const viewSchema: ViewSchema = {
			name: viewName,
			schemaName: targetSchemaName,
			sql: createViewToString(stmt),
			// Any `with defaults (…)` rides inside stmt.select (→ selectAst).
			selectAst: stmt.select,
			columns: stmt.columns ? Object.freeze([...stmt.columns]) : undefined,
			tags: stmt.tags && Object.keys(stmt.tags).length > 0 ? Object.freeze({ ...stmt.tags }) : undefined,
		};

		schema.addView(viewSchema);
		log(`Imported view %s.%s`, targetSchemaName, viewName);

		return { type: 'view', name: `${targetSchemaName}.${viewName}` };
	}

	/**
	 * Import a materialized view from its parsed DDL by re-materializing it
	 * through the shared {@link materializeView} core: the body is re-planned
	 * against the current (already-imported) sources, the memory backing table is
	 * rebuilt and filled, and row-time maintenance is re-registered — the same
	 * work the create emitter does, minus the `materialized_view_added` event (a
	 * store rehydrating its own catalog must not re-emit persistence events;
	 * `table_added` still fires for the backing table, exactly as on create).
	 *
	 * Unlike {@link importView}, the body plans EAGERLY (the backing cannot be
	 * filled without running it), so MV import is order-dependent: the body's
	 * sources — including another MV's backing for MV-over-MV — must already be
	 * registered. The store's `rehydrateCatalog` orders MVs after tables/views
	 * and resolves MV-over-MV chains by fixpoint retry. A body that cannot plan,
	 * fills with duplicate keys, or fails the row-time eligibility gate in
	 * `registerMaterializedView` throws (after {@link materializeView} rolls the
	 * half-built backing back), and the caller records it as a per-entry
	 * rehydration error.
	 *
	 * **Adopt fast path.** A pre-existing table at the backing name in the MV's
	 * own backing module (a durable host's phase-1 rehydration of its backing)
	 * is ADOPTED — registered as-is, no body re-execution — iff ALL gates pass
	 * (see {@link tryAdoptPreExistingBacking}); otherwise it is dropped and the
	 * MV refills through {@link materializeView}. Only import ever adopts —
	 * create and refresh are unchanged.
	 */
	private async importMaterializedView(spec: MaintainedTableImportSpec, options?: ImportCatalogOptions): Promise<{ type: 'materializedView'; name: string }> {
		// Canonical stored schemaName (see canonicalSchemaName) — the schema itself
		// is created below, after the DML-body gate.
		const targetSchemaName = this.canonicalSchemaName(spec.schemaName || this.getCurrentSchemaName());
		const viewName = spec.name;

		// A DML body (insert/update/delete … returning) parses but is un-creatable —
		// `planViewBody` rejects it at build time. Reject it here too, BEFORE
		// materializing: a corrupt or hand-edited catalog entry would otherwise
		// EXECUTE the mutation against live source tables during rehydrate.
		if (spec.select.type === 'insert' || spec.select.type === 'update' || spec.select.type === 'delete') {
			throw new QuereusError(
				`${spec.select.type.toUpperCase()} cannot be used as a materialized view body`,
				StatusCode.ERROR,
			);
		}

		// Create the schema if absent (mirrors importTable/importView) so an MV
		// rehydrates even into a schema that holds no tables.
		this.getOrCreateSchema(targetSchemaName);

		// Honor the re-parsed `using <module>(...)` clause (the generator emits it
		// only when non-default). An unknown or capability-less module throws from
		// buildBackingTableSchema inside materializeView — the caller records it
		// as a per-entry rehydration error.
		const backing = normalizeBackingModule(spec.moduleName, spec.moduleArgs);

		const def: MaterializeViewDefinition = {
			schemaName: targetSchemaName,
			viewName,
			// Any `with defaults (…)` rides inside spec.select (→ selectAst).
			selectAst: spec.select,
			bodySql: astToString(spec.select),
			columns: spec.columns,
			tags: spec.tags ? Object.freeze({ ...spec.tags }) : undefined,
			backingModuleName: backing.storedModuleName,
			backingModuleArgs: backing.storedModuleArgs,
		};

		// Derive the backing shape ONCE for the whole import (ordering gate, adopt
		// gates, and the refill all read it). Throws when the body cannot plan —
		// deliberately BEFORE any drop, so a not-yet-resolvable body (the store's
		// MV-over-MV fixpoint: a dependent fails until its upstream's round lands)
		// errors per-entry with any pre-existing backing preserved — data-safe.
		const shape: BackingShape = deriveBackingShape(this.db, def.schemaName, def.bodySql, def.columns);
		// Declared-column arity mismatch: the entry can NEVER materialize, so throw
		// with the backing preserved rather than dropping durable rows for nothing.
		assertDeclaredColumnArity(def, shape);

		// Ordering gate: a body source that is itself a pending maintained-table
		// entry (its own `create materialized view` not yet imported this session)
		// already pre-exists as a *plain* table, so the body PLANS — but its content
		// may be about to be replaced by the upstream's own import. Defer this entry
		// to a later fixpoint round (per-entry error; the store retries).
		for (const src of shape.sourceTables) {
			if (options?.pendingDerivations?.has(src)) {
				throw new QuereusError(
					`cannot import materialized view '${targetSchemaName}.${viewName}' yet: source '${src}' is a maintained table whose own catalog entry has not imported this session`,
					StatusCode.ERROR,
				);
			}
		}

		// A durable backing-host module may have rehydrated the maintained table
		// itself (phase 1: a plain `create table` bundle under the same name)
		// before this MV catalog entry imports (phase 3). A pre-existing
		// derivation-less table owned by the MV's own backing module IS that
		// rehydrated backing: adopt it when every gate passes, else drop it and
		// re-materialize from the body. A table in a DIFFERENT module is not
		// ours — fail the entry rather than dropping user data. The create
		// emitter keeps the plain collision error.
		const preExisting = this.getTable(targetSchemaName, viewName);
		if (preExisting) {
			if (isMaintainedTable(preExisting)) {
				throw new QuereusError(
					`cannot import materialized view '${targetSchemaName}.${viewName}': a maintained table with the same name already exists`,
					StatusCode.CONSTRAINT,
				);
			}
			if ((preExisting.vtabModuleName ?? '').toLowerCase() === backing.moduleName) {
				if (options?.trustBackings && await this.tryAdoptPreExistingBacking(def, preExisting, backing.moduleName, options.adoptedBackings, shape)) {
					log(`Adopted materialized view %s.%s (durable backing trusted; refill skipped)`, targetSchemaName, viewName);
					return { type: 'materializedView', name: `${targetSchemaName}.${viewName}` };
				}
				await this.dropTable(targetSchemaName, viewName, /*ifExists*/ true);
			} else {
				throw new QuereusError(
					`cannot import materialized view '${targetSchemaName}.${viewName}': table '${viewName}' already exists in module '${preExisting.vtabModuleName}', not the MV's backing module '${backing.moduleName}'`,
					StatusCode.CONSTRAINT,
				);
			}
		}

		await materializeView(this.db, def, shape);
		log(`Imported materialized view %s.%s`, targetSchemaName, viewName);

		return { type: 'materializedView', name: `${targetSchemaName}.${viewName}` };
	}

	/**
	 * The adopt-without-refill gate check + adopt for a pre-existing same-module
	 * backing during MV import. Returns true when the backing was adopted; false
	 * means "fall back to drop+refill". `shape` is the caller's pre-derived
	 * backing shape (derived before any drop — see {@link importMaterializedView}).
	 * Gates, of five (the caller already verified gate 1, same-module, and
	 * gate 5, `trustBackings`):
	 *
	 * 2. **Shape** — `backingShapeMatches(preExisting, shape)`: the persisted
	 *    backing is column-for-column what the re-planned body would build
	 *    (names, logical types, not-null, collation, physical PK).
	 * 3. **bodyHash** — automatic by construction: the catalog persists DDL and
	 *    import re-parses it, recomputing `computeBodyHash` from the same
	 *    canonical definition — there is no independently persisted hash that
	 *    could diverge, so no runtime check is possible or needed.
	 * 4. **Sources** — every table the body reads lives in the SAME module as
	 *    the backing (one storage substrate ⇒ the divergence window is the
	 *    documented crash window the marker attests against; a cross-module
	 *    source — e.g. memory — was itself just recomputed, so persisted backing
	 *    rows may be stale relative to it), AND every source that is itself a
	 *    maintained table was ADOPTED this session (`adoptedBackings`) — a
	 *    refilled upstream may hold new content its dependents must reflect.
	 *    (The caller's pending-derivations gate guarantees every maintained
	 *    source's own entry has already imported, so derivation presence is
	 *    decidable here.)
	 *
	 * A throw from `adoptMaterializedView` itself (the row-time eligibility gate
	 * in registration) propagates — per-entry error, backing left registered as
	 * a plain (derivation-less) table.
	 */
	private async tryAdoptPreExistingBacking(
		def: MaterializeViewDefinition,
		preExisting: TableSchema,
		backingModuleName: string,
		adoptedBackings: Set<string> | undefined,
		shape: BackingShape,
	): Promise<boolean> {
		if (!backingShapeMatches(preExisting, shape)) return false;

		for (const qualified of shape.sourceTables) {
			const dot = qualified.indexOf('.');
			const sourceSchema = dot >= 0 ? qualified.slice(0, dot) : this.getCurrentSchemaName();
			const sourceName = dot >= 0 ? qualified.slice(dot + 1) : qualified;
			const source = this.getTable(sourceSchema, sourceName);
			if (!source) return false;
			if ((source.vtabModuleName ?? '').toLowerCase() !== backingModuleName) return false;
			// A maintained-table source is another MV's backing; require it was
			// adopted, not refilled, this session.
			if (isMaintainedTable(source) && !adoptedBackings?.has(qualified)) return false;
		}

		await adoptMaterializedView(this.db, def, preExisting, shape);
		adoptedBackings?.add(`${def.schemaName}.${def.viewName}`.toLowerCase());
		return true;
	}

	/**
	 * Import a table schema without calling module.create().
	 * Uses module.connect() to bind to existing storage.
	 */
	private async importTable(stmt: AST.CreateTableStmt): Promise<{ type: 'table'; name: string }> {
		const targetSchemaName = stmt.table.schema || this.getCurrentSchemaName();
		const tableName = stmt.table.name;

		const { moduleName, effectiveModuleArgs, moduleInfo } = this.resolveModuleInfo(stmt);
		// Rehydrate path: persisted DDL already made any non-BINARY collation explicit,
		// so an omitted COLLATE is canonical BINARY regardless of the live session default.
		const tableSchema = this.buildTableSchemaFromAST(stmt, moduleName, effectiveModuleArgs, moduleInfo, 'BINARY');

		try {
			// Module-facing stored-name contract (see canonicalSchemaName): the
			// rehydrated connect receives `tableSchema`'s canonical schemaName and
			// stored display casing, never the raw persisted-DDL spelling — a module
			// keying storage by the args addresses the same physical store it created.
			await moduleInfo.module.connect(
				this.db,
				moduleInfo.auxData,
				moduleName,
				tableSchema.schemaName,
				tableSchema.name,
				effectiveModuleArgs,
				tableSchema
			);
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : String(e);
			throw new QuereusError(`Module '${moduleName}' connect failed during import for table '${tableName}': ${message}`, StatusCode.ERROR);
		}

		const schema = this.getOrCreateSchema(tableSchema.schemaName);

		schema.addTable(tableSchema);
		// Catalog rehydration registers FK-bearing tables silently (no `table_added`
		// fires) and via `getOrCreateSchema`, which only resets when it *creates* a
		// schema — so importing a child into an existing schema (e.g. `main`) would
		// otherwise leave a stale reverse FK index. Cold reopen masks this (the index
		// is built lazily only after rehydration completes), but a re-import onto a
		// live, already-built index would under-report — the fatal direction. Reset
		// directly so the silent-import path upholds the same invariant as the events.
		// The lens basis-FK gate shares this vector: a basis table imported silently
		// after the gate was built would otherwise leave it under-reporting too.
		this.invalidateReverseFkIndex();
		this.invalidateLensFkGate();
		log(`Imported table %s.%s using module %s`, targetSchemaName, tableName, moduleName);

		return { type: 'table', name: `${tableSchema.schemaName}.${tableSchema.name}` };
	}

	/**
	 * Import an index schema without calling module.createIndex().
	 *
	 * Reconstructs the index with full fidelity from the re-parsed DDL so a
	 * `CREATE [UNIQUE] INDEX ... (col [COLLATE x]) [WHERE ...]` survives a
	 * catalog round-trip: per-column collation, the UNIQUE flag, the partial
	 * predicate, and (for a unique index) the synthesized `derivedFromIndex`
	 * UNIQUE constraint — mirroring the live `buildIndexSchema` + the shared
	 * {@link appendIndexToTableSchema} that {@link createIndex} uses.
	 */
	private async importIndex(stmt: AST.CreateIndexStmt): Promise<{ type: 'index'; name: string }> {
		const targetSchemaName = stmt.table.schema || this.getCurrentSchemaName();
		const tableName = stmt.table.name;
		const indexName = stmt.index.name;

		// Find the table
		const tableSchema = this.findTable(tableName, targetSchemaName);
		if (!tableSchema) {
			throw new QuereusError(`Cannot import index '${indexName}': table '${tableName}' not found`, StatusCode.ERROR);
		}

		// Build index columns schema. Mirrors buildIndexSchema's collation resolution
		// (per-column COLLATE → table column collation → BINARY).
		const indexColumns: IndexColumnSchema[] = stmt.columns.map(col => {
			const { name: colName, collation } = resolveImportedIndexColumn(col);
			if (!colName) {
				throw new QuereusError(`Expression-based index columns are not supported during import`, StatusCode.ERROR);
			}
			const colIdx = tableSchema.columnIndexMap.get(colName.toLowerCase());
			if (colIdx === undefined) {
				throw new QuereusError(`Column '${colName}' not found in table '${tableName}'`, StatusCode.ERROR);
			}
			const tableColSchema = tableSchema.columns[colIdx];
			return {
				index: colIdx,
				desc: col.direction === 'desc',
				collation: normalizeCollationName(collation || tableColSchema.collation || 'BINARY'),
			};
		});

		const indexSchema: IndexSchema = {
			name: indexName,
			columns: Object.freeze(indexColumns),
			unique: stmt.isUnique || undefined,
			predicate: stmt.where,
			tags: stmt.tags && Object.keys(stmt.tags).length > 0 ? Object.freeze({ ...stmt.tags }) : undefined,
		};

		// Rehydration must not brick an open. A database written before `createIndex`
		// enforced schema-wide index-name uniqueness can legitimately contain a
		// collision; refusing to import would strand the data. Warn (naming both
		// owners) and import anyway — by-name resolution of that index stays
		// first-match until an operator renames one of them.
		//
		// NOTE: unlike `createIndex` (one statement, one scan), rehydration runs this
		// once per imported index, so a cold open costs O(indexes × tables). Fine at
		// present schema sizes; if opening a large catalog ever shows up as slow, build
		// one name→owner map for the whole import instead of re-scanning per index.
		//
		// NOTE: this path deliberately does NOT consult `isImplicitCoveringIndex`, so a
		// catalog written before the write paths refused a name held by that table's own
		// UNIQUE constraint still imports its shadowing index — after which the name
		// resolves to a real index that `dropIndex` then refuses to drop. Only reachable
		// by opening such a pre-existing database; it warns (below) and proceeds rather
		// than bricking the open. If that ever needs stronger handling, reject or rename
		// the shadowing index here rather than loosening the write-path guards.
		const collidingOwner = this.findIndexNameOwnerElsewhere(targetSchemaName, tableSchema.name, indexName);
		if (collidingOwner) {
			warnLog(
				`Imported index '%s' on table '%s' collides with an existing index of the same name on table '%s' in schema '%s'; `
					+ `index names are expected to be unique per schema — DROP/ALTER INDEX by this name resolves to whichever table registered first`,
				indexName, tableSchema.name, collidingOwner.name, targetSchemaName,
			);
		}

		// Same warn-and-proceed treatment for the same-table variant: the name is already
		// the implicit backing structure of one of this table's own UNIQUE constraints.
		// Both write paths now refuse this (`createIndex` from the index side,
		// `assertUniqueConstraintIndexNameFree` from the constraint side), so a catalog
		// carrying it was written before those guards existed. `importDDL` imports the
		// CREATE TABLE (constraints included) ahead of every CREATE INDEX, so the
		// constraint is always the one already present when the collision is seen.
		//
		// NOTE: the resulting state is worse than "shadowed and undroppable". Measured on
		// the memory backend (test/index-ddl-roundtrip.spec.ts), the table ends up with two
		// index entries under the one name, `index_info()` reports NEITHER, `DROP INDEX`
		// answers `no such index`, and a predicate over the imported index's column stops
		// filtering — `where b = 'q'` returns every row. No write path can produce such a
		// catalog any more, so this is only reachable by opening a database written before
		// the guards (backwards compatibility is waived project-wide) or by handing
		// `importCatalog` a collided bundle directly. If either becomes real, reject or
		// rename the shadowing index HERE rather than loosening the write-path guards.
		if (isImplicitCoveringIndex(tableSchema, indexName)) {
			warnLog(
				`Imported index '%s' on table '%s' collides with the implicit backing index of a UNIQUE constraint of the same name `
					+ `on that table; the index shadows the constraint's structure, DROP INDEX will refuse to drop it, and predicates `
					+ `over its columns stop filtering — rename either the index or the constraint`,
				indexName, tableSchema.name,
			);
		}

		// Append the index (and synthesize the derived UNIQUE constraint when
		// unique) without calling module.createIndex() — the storage already exists.
		const updatedTableSchema = appendIndexToTableSchema(tableSchema, indexSchema);

		const schema = this.getSchemaOrFail(targetSchemaName);
		schema.addTable(updatedTableSchema);
		log(`Imported index %s on table %s.%s`, indexName, targetSchemaName, tableName);

		return { type: 'index', name: `${targetSchemaName}.${tableName}.${indexName}` };
	}
}

/**
 * Resolves an indexed-column AST node to its underlying column name and optional
 * collation, for catalog import.
 *
 * The parser folds `col COLLATE x` into a `collate` expression wrapping a bare
 * column reference (see `indexedColumn()` in parser.ts), leaving `col.name`
 * unset. Since `generateIndexDDL` always emits an explicit `COLLATE <c>` per
 * column, *every* generated index DDL re-parses into this collate-wrapped form —
 * so unwrapping it is required for the common case, not just non-BINARY
 * collations. A genuine expression index (non-column operand) returns an unset
 * name and is rejected by the caller.
 */
function resolveImportedIndexColumn(col: AST.IndexedColumn): { name: string | undefined; collation: string | undefined } {
	// Bare column reference (`col [ASC|DESC]`) — name set directly by the parser.
	if (col.name) {
		return { name: col.name, collation: col.collation };
	}
	// Collate-wrapped column (`col COLLATE x`) — unwrap to the column + collation.
	const expr = col.expr;
	if (expr?.type === 'collate' && expr.expr.type === 'column' && !expr.expr.table && !expr.expr.schema) {
		return { name: expr.expr.name, collation: expr.collation };
	}
	// Anything else is a genuine expression index — unsupported on import.
	return { name: undefined, collation: undefined };
}
