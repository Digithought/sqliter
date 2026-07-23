import { createLogger } from '../common/logger.js';
import { MisuseError, QuereusError, FailConflictError, RollbackConflictError, throwIfAborted } from '../common/errors.js';
import { StatusCode, type SqlParameters, type SqlValue, type Row, type OutputValue, type StatementOptions } from '../common/types.js';
import type { ScalarType } from '../common/datatype.js';
import type { AnyVirtualTableModule } from '../vtab/module.js';
import { Statement } from './statement.js';
import { SchemaManager } from '../schema/manager.js';
import type { TableSchema, UniqueConstraintSchema } from '../schema/table.js';
import type { MaintainedTableSchema } from '../schema/derivation.js';
import type { FunctionSchema } from '../schema/function.js';
import { BUILTIN_FUNCTIONS } from '../func/builtins/index.js';
import { createScalarFunction, createAggregateFunction } from '../func/registration.js';
import { FunctionFlags } from '../common/constants.js';
import { MemoryTableModule } from '../vtab/memory/module.js';
import type { VirtualTableConnection } from '../vtab/connection.js';
import { BINARY_COLLATION, NOCASE_COLLATION, RTRIM_COLLATION, normalizeCollationName, type CollationFunction } from '../util/comparison.js';
import { BUILTIN_NORMALIZERS } from '../util/key-serializer.js';
import { Parser } from '../parser/parser.js';
import * as AST from '../parser/ast.js';
import { buildBlock } from '../planner/building/block.js';
import { emitPlanNode } from '../runtime/emitters.js';
import { refreshMaintainedTable } from '../runtime/emit/materialized-view.js';
import { Scheduler } from '../runtime/scheduler.js';
import type { RuntimeContext } from '../runtime/types.js';
import { createStrictRowContextMap, wrapTableContextsStrict } from '../runtime/strict-fork.js';
import type { RowDescriptor } from '../planner/nodes/plan-node.js';
import { BlockNode } from '../planner/nodes/block.js';
import type { PlanningContext } from '../planner/planning-context.js';
import { BuildTimeDependencyTracker } from '../planner/planning-context.js';
import { ParameterScope } from '../planner/scopes/param.js';
import { GlobalScope } from '../planner/scopes/global.js';
import { PlanNode } from '../planner/nodes/plan-node.js';
import { registerEmitters } from '../runtime/register.js';
import { serializePlanTree, formatPlanTree } from '../planner/debug.js';
import type { DebugOptions } from '../planner/planning-context.js';
import { EmissionContext } from '../runtime/emission-context.js';
import { Optimizer, DEFAULT_TUNING } from '../planner/optimizer.js';
import type { OptimizerTuning } from '../planner/optimizer-tuning.js';
import { registerBuiltinWindowFunctions } from '../func/builtins/builtin-window-functions.js';
import { DatabaseOptionsManager } from './database-options.js';
import { MAINTENANCE_REBUILD_ROW_THRESHOLD } from '../planner/cost/index.js';
import type { InstructionTracer } from '../runtime/types.js';
import { DeclaredSchemaManager } from '../schema/declared-schema-manager.js';
import { DeferredConstraintQueue } from '../runtime/deferred-constraint-queue.js';
import { type LogicalType, type CollationResolver, type KeyNormalizer, type KeyNormalizerResolver } from '../types/logical-type.js';
import { registerType as registerTypeInRegistry } from '../types/registry.js';
import { getParameterTypes } from './param.js';
import { rowToObject } from './utils.js';
import { wrapAsyncIterator } from '../util/async-iterator.js';
import { Latches } from '../util/latches.js';
import {
	DatabaseEventEmitter,
	type DatabaseDataChangeEvent,
	type DatabaseSchemaChangeEvent,
	type MaintenanceCollisionEvent,
	type TransactionCommitBatch,
	type DataChangeSubscriptionOptions,
	type SchemaChangeSubscriptionOptions,
} from './database-events.js';
import { TransactionManager, type TransactionManagerContext } from './database-transaction.js';
import { InternalStatementCache } from './internal-statement-cache.js';
import { ingestExternalRowChangeBatch } from './database-external-changes.js';
import type { ExternalRowChange, IngestExternalChangesOptions, IngestExternalChangesResult } from './database-internal.js';
import { AssertionEvaluator, type AssertionEvaluatorContext, type AssertionViolation } from './database-assertions.js';
import { WatcherManager, type WatcherManagerContext } from './database-watchers.js';
import { MaterializedViewManager, type BackingConnectionCache, type ResidualKeyBatch } from './database-materialized-views.js';
import type { BackingRowChange } from '../vtab/backing-host.js';
import type { ChangeScope, Subscription, WatchHandler } from '../planner/analysis/change-scope.js';
import { tryGetEventEmitter } from '../vtab/events.js';
import { Table } from './table-handle.js';

const log = createLogger('core:database');
const errorLog = log.extend('error');

/** Result from _buildPlan containing both the plan tree and its schema dependencies. */
export interface BuildPlanResult {
	plan: BlockNode;
	schemaDependencies: BuildTimeDependencyTracker;
}

/** Options accepted by {@link Database.registerCollation}'s third argument. */
export interface RegisterCollationOptions {
	normalizer?: (s: string) => string;
	replicable?: boolean;
	orderPreserving?: boolean;
}

/** One entry in the per-database collation registry. */
interface CollationEntry {
	comparator: CollationFunction;
	normalizer?: (s: string) => string;
	replicable?: boolean;
	orderPreserving?: boolean;
}

/** Parse a comma-separated schema path string into an array of trimmed, non-empty names. */
function parseSchemaPath(pathString: string): string[] | undefined {
	if (!pathString) return undefined;
	const parts = pathString.split(',').map(s => s.trim()).filter(s => s.length > 0);
	return parts.length > 0 ? parts : undefined;
}

/**
 * Represents a connection to an Quereus database (in-memory in this port).
 * Manages schema, prepared statements, virtual tables, and functions.
 */
export class Database implements TransactionManagerContext, AssertionEvaluatorContext, WatcherManagerContext {
	public readonly schemaManager: SchemaManager;
	public readonly declaredSchemaManager: DeclaredSchemaManager;
	private isOpen = true;
	private statements = new Set<Statement>();
	private activeConnections = new Map<string, VirtualTableConnection>();
	public readonly optimizer: Optimizer;
	public readonly options: DatabaseOptionsManager;
	private instructionTracer: InstructionTracer | undefined;
	/** Deferred constraint evaluation queue */
	private readonly deferredConstraints = new DeferredConstraintQueue(this);
	/**
	 * Mutex for serializing statement execution.
	 * This prevents concurrent statements from interfering with each other's
	 * transaction state, matching SQLite's behavior of serializing writes.
	 */
	private execMutex: Promise<void> = Promise.resolve();
	/**
	 * Depth of currently-held exec-mutex acquisitions. >0 while a statement
	 * (`exec`/`eval`), an external-change ingest, or an MV-refresh sweep holds the
	 * mutex. Read via {@link _isExecuting} so a re-entrant caller (e.g. a module
	 * `notifyLensDeployment` listener that would itself re-enter the engine) can
	 * detect it must defer rather than deadlock on the held mutex.
	 */
	private execMutexDepth = 0;
	/** Database-level event emitter for unified reactivity */
	private readonly eventEmitter = new DatabaseEventEmitter();
	/** Transaction management */
	private readonly transactionManager: TransactionManager;
	/** Assertion evaluation */
	private readonly assertionEvaluator: AssertionEvaluator;
	/** Post-commit watcher dispatch */
	private readonly watcherManager: WatcherManager;
	/** Materialized-view schema-change staleness tracking */
	private readonly materializedViewManager: MaterializedViewManager;
	/** Per-database collation registry — comparator + optional key normalizer +
	 *  optional REPLICABLE and ORDER-PRESERVING assertions. The normalizer is required
	 *  for index participation; comparator-only collations may still be used in ORDER BY
	 *  but cannot back a compound index. `replicable` (stamped `true` on the built-ins,
	 *  opt-in for a custom collation) is consulted only by the materialized-view
	 *  replicable-collation gate when the backing host demands it
	 *  (see {@link _isCollationReplicable}). `orderPreserving` (same shape) is consulted
	 *  by persistent stores before seeking a byte range or advertising byte order as
	 *  collation order (see {@link _isCollationOrderPreserving}). */
	private readonly collations = new Map<string, CollationEntry>();
	/** Lazily-bound {@link getCollationResolver} closure — created once so callers can
	 *  compare resolver identity, while still reading the live `collations` map. */
	private collationResolver?: CollationResolver;
	/** Lazily-bound {@link getKeyNormalizerResolver} closure — same identity/liveness
	 *  contract as {@link collationResolver}. */
	private keyNormalizerResolver?: KeyNormalizerResolver;
	/**
	 * Per-database latch registry — serializes commit / collapse / consolidate /
	 * destroy / schema-change work by string key *within this database*. Scoped to
	 * the `Database` instance (not process-global) so two databases never contend
	 * on the same key. Memory-table managers reach it via `this.db.latches`.
	 */
	public readonly latches = new Latches();
	/**
	 * @internal Per-connection LRU pool of compiled internal statements for the FK
	 * and DDL enforcement paths (RESTRICT probes, cascade DML, drop-referencing
	 * check). Those sites otherwise re-`prepare` a tiny fixed-shape query per
	 * affected row, paying a full parse + plan + emit each time (the engine has no
	 * plan cache). Not a public statement-cache feature — see
	 * {@link InternalStatementCache}. Drained by {@link close}.
	 */
	public readonly _internalStatementCache: InternalStatementCache;

	constructor() {
		this.schemaManager = new SchemaManager(this);
		this.declaredSchemaManager = new DeclaredSchemaManager();
		this.options = new DatabaseOptionsManager();
		this._internalStatementCache = new InternalStatementCache(this);
		log("Database instance created.");

		// Register built-in functions
		this.registerBuiltinFunctions();

		this.schemaManager.registerModule('memory', new MemoryTableModule());

		// Register built-in collations
		this.registerDefaultCollations();

		// Register built-in window functions
		registerBuiltinWindowFunctions();

		registerEmitters();

		// Initialize optimizer with default tuning
		this.optimizer = new Optimizer(DEFAULT_TUNING);

		// Initialize transaction manager and assertion evaluator
		this.transactionManager = new TransactionManager(this);
		this.assertionEvaluator = new AssertionEvaluator(this);
		this.watcherManager = new WatcherManager(this);
		this.materializedViewManager = new MaterializedViewManager(this);

		// Set up option change listeners
		this.setupOptionListeners();
	}

	// ============================================================================
	// TransactionManagerContext Implementation
	// ============================================================================

	/** @internal */
	getEventEmitter(): DatabaseEventEmitter {
		return this.eventEmitter;
	}

	/** @internal */
	getDeferredConstraints(): DeferredConstraintQueue {
		return this.deferredConstraints;
	}

	// ============================================================================
	// AssertionEvaluatorContext Implementation
	// ============================================================================

	/** Get the set of changed base tables */
	getChangedBaseTables(): Set<string> {
		return this.transactionManager.getChangedBaseTables();
	}

	/** Get changed PK tuples for a specific base table */
	getChangedKeyTuples(base: string): SqlValue[][] {
		return this.transactionManager.getChangedKeyTuples(base);
	}

	/**
	 * Get changed value tuples projected onto `columnIndices` for a specific
	 * base table. The columns must have been registered for capture via
	 * `registerCaptureSpec` (PK columns are always captured implicitly).
	 */
	getChangedTuples(base: string, columnIndices: readonly number[], pkIndices: readonly number[]): SqlValue[][] {
		return this.transactionManager.getChangedTuples(base, columnIndices, pkIndices);
	}

	/**
	 * Register projection capture demand for a base table. Returns a dispose
	 * handle that removes the spec when called.
	 */
	registerCaptureSpec(baseTable: string, spec: { extraColumns: ReadonlySet<number> }): () => void {
		return this.transactionManager.registerCaptureSpec(baseTable, spec);
	}

	/** @internal Set up listeners for option changes */
	private setupOptionListeners(): void {
		// Register core database options with their change handlers
		this.options.registerOption('runtime_stats', {
			type: 'boolean',
			defaultValue: false,
			aliases: ['runtime_metrics'],
			description: 'Enable runtime execution statistics collection'
			// No onChange needed - consumed directly when creating RuntimeContext
		});

		this.options.registerOption('validate_plan', {
			type: 'boolean',
			defaultValue: false,
			aliases: ['plan_validation'],
			description: 'Enable plan validation before execution',
			onChange: (event) => {
				const newTuning = {
					...this.optimizer.tuning,
					debug: {
						...this.optimizer.tuning.debug,
						validatePlan: event.newValue as boolean
					}
				};
				this.updateOptimizerTuning(newTuning as OptimizerTuning);
				log('Optimizer tuning updated with validate_plan = %s', event.newValue);
			}
		});

		this.options.registerOption('default_vtab_module', {
			type: 'string',
			defaultValue: 'memory',
			description: 'Default virtual table module name',
			onChange: (event) => {
				this.schemaManager.setDefaultVTabModuleName(event.newValue as string);
			}
		});

		this.options.registerOption('default_vtab_args', {
			type: 'object',
			defaultValue: {},
			description: 'Default virtual table module arguments',
			onChange: (event) => {
				this.schemaManager.setDefaultVTabArgs(event.newValue as Record<string, SqlValue>);
			}
		});

		this.options.registerOption('default_column_nullability', {
			type: 'string',
			defaultValue: 'not_null',
			aliases: ['column_nullability_default', 'nullable_default'],
			description: 'Default nullability for columns: "nullable" (SQL standard) or "not_null" (Third Manifesto)',
			onChange: (event) => {
				const value = event.newValue as string;
				if (value !== 'nullable' && value !== 'not_null') {
					throw new QuereusError(`Invalid default_column_nullability value: ${value}. Must be "nullable" or "not_null"`, StatusCode.ERROR);
				}
				log('Default column nullability changed to: %s', value);
			}
		});

		this.options.registerOption('ddl_transaction_policy', {
			type: 'string',
			defaultValue: 'permissive',
			description: 'Whether module-dispatching DDL (CREATE/DROP TABLE/INDEX, ALTER TABLE) is allowed inside an explicit transaction: "permissive" (default; schema changes may escape the transaction, as today) or "strict" (refuse such DDL inside a transaction unless the module declares ddlTransactionality=transactional).',
			onChange: (event) => {
				const value = event.newValue as string;
				if (value !== 'permissive' && value !== 'strict') {
					throw new QuereusError(`Invalid ddl_transaction_policy value: ${value}. Must be "permissive" or "strict"`, StatusCode.ERROR);
				}
				log('DDL transaction policy changed to: %s', value);
			}
		});

		this.options.registerOption('default_collation', {
			type: 'string',
			defaultValue: 'BINARY',
			description: 'Default declared collation for columns with no explicit COLLATE (e.g. "BINARY", "NOCASE", "RTRIM", or any registered collation). Create-time authoring convenience only; the catalog stores concrete collations and persisted DDL always carries an explicit non-BINARY COLLATE.',
			onChange: (event) => {
				const value = event.newValue as string;
				const normalized = normalizeCollationName(value);
				// Validate at set time so a typo fails loudly, not at first comparison.
				// The options framework rolls the value back when onChange throws.
				if (this._getCollation(normalized) === undefined) {
					throw new QuereusError(`Unknown collation '${value}' for default_collation`, StatusCode.ERROR);
				}
				log('Default collation changed to: %s', normalized);
			}
		});

		this.options.registerOption('schema_path', {
			type: 'string',
			defaultValue: 'main',
			aliases: ['search_path'],
			description: 'Comma-separated list of schemas to search for unqualified table names',
			onChange: (event) => {
				const value = event.newValue as string;
				log('Schema search path changed to: %s', value);
			}
		});

		this.options.registerOption('trace_plan_stack', {
			type: 'boolean',
			defaultValue: false,
			description: 'Enable plan stack tracing',
		});

		this.options.registerOption('foreign_keys', {
			type: 'boolean',
			defaultValue: true,
			aliases: ['fk_enforcement'],
			description: 'Enable foreign key constraint enforcement. When omitted, ON DELETE / ON UPDATE default to RESTRICT.',
		});

		this.options.registerOption('nondeterministic_schema', {
			type: 'boolean',
			defaultValue: false,
			aliases: ['allow_nondeterministic_schema_expressions'],
			description: 'When true, permit non-deterministic expressions in DEFAULT, CHECK, and GENERATED ALWAYS AS clauses. ' +
				'Capture happens at the resolved-row frontier in vtab.update(); replay applies module-layer writes without re-evaluating constraints. ' +
				'Defaults to false (strict rejection) for backward compatibility.',
			onChange: (event) => {
				log('nondeterministic_schema changed to: %s', event.newValue);
			}
		});

		this.options.registerOption('materialized_view_rebuild_row_threshold', {
			type: 'number',
			defaultValue: MAINTENANCE_REBUILD_ROW_THRESHOLD,
			description: 'Largest source-row count for which a materialized view whose only sound maintenance ' +
				'strategy is a full body rebuild is accepted at create. A full-rebuild MV over a larger source ' +
				'is rejected (every write would re-scan the whole source). Set to 0 to disable the size reject ' +
				'(accept any size). The check uses the largest participating source for a multi-source body.',
			onChange: (event) => {
				// Validate at set time so a bad value fails loudly; the options framework
				// rolls the value back when onChange throws.
				const value = event.newValue as number;
				if (!Number.isFinite(value) || value < 0) {
					throw new QuereusError(
						`Invalid materialized_view_rebuild_row_threshold ${event.newValue}: must be a non-negative number (0 disables the size reject)`,
						StatusCode.ERROR,
					);
				}
				log('materialized_view_rebuild_row_threshold changed to: %s', value);
			}
		});
	}

	/** @internal Registers default built-in SQL functions */
	private registerBuiltinFunctions(): void {
		const mainSchema = this.schemaManager.getMainSchema();
		// Built-ins auto-qualify as REPLICABLE: Quereus implements its own collation,
		// case-folding, and numeric formatting, so a deterministic builtin is
		// bit-identical across peers' JS engines (see BaseFunctionSchema.replicable).
		// This is the single seam that *knows* a schema is a builtin, so stamping here
		// auto-qualifies all of them without editing ~100 definitions and without
		// defaulting UDFs to replicable. Non-deterministic builtins (random, now, …) are
		// stamped too — harmless, since the determinism gate rejects them first. Spread a
		// COPY so the shared exported BUILTIN_FUNCTIONS constants are never mutated.
		BUILTIN_FUNCTIONS.forEach(funcDef => {
			try {
				mainSchema.addFunction({ ...funcDef, replicable: true });
			} catch (e) {
				errorLog(`Failed to register built-in function ${funcDef.name}/${funcDef.numArgs}: %O`, e);
			}
		});
		log(`Registered ${BUILTIN_FUNCTIONS.length} built-in functions.`);
	}

	/** @internal Registers default collation sequences */
	private registerDefaultCollations(): void {
		// Register the built-in collations into per-instance registry, paired
		// with their key normalizers so they can back compound indexes. Stamped
		// `replicable: true` — the built-ins are pure JS string operations (a code-point
		// scan, locale-independent `toLowerCase()`, ASCII-space trim), so they are
		// bit-identical across peers' JS engines, exactly parallel to why built-in
		// functions auto-qualify (see registerBuiltinFunctions). This is the single
		// seam that *knows* a collation is a builtin.
		//
		// Also stamped `orderPreserving: true`: each built-in comparator orders its
		// operands' NORMALIZED forms by Unicode CODE POINT (BINARY's normalizer is the
		// identity, NOCASE's is `toLowerCase()`, RTRIM's an ASCII-space right-trim), and
		// code-point order IS the order a memcmp of those forms' UTF-8 bytes produces —
		// see {@link import('../util/comparison.js').compareCodePoints} and
		// {@link _isCollationOrderPreserving}.
		this.collations.set('BINARY', { comparator: BINARY_COLLATION, normalizer: BUILTIN_NORMALIZERS.BINARY, replicable: true, orderPreserving: true });
		this.collations.set('NOCASE', { comparator: NOCASE_COLLATION, normalizer: BUILTIN_NORMALIZERS.NOCASE, replicable: true, orderPreserving: true });
		this.collations.set('RTRIM',  { comparator: RTRIM_COLLATION,  normalizer: BUILTIN_NORMALIZERS.RTRIM,  replicable: true, orderPreserving: true });
		log("Default collations registered (BINARY, NOCASE, RTRIM)");
	}

	/**
	 * Prepares an SQL statement for execution.
	 *
	 * @param sql The SQL string to prepare.
	 * @param paramsOrTypes Optional parameter values (to infer types) or explicit type map.
	 *   - If SqlParameters: Parameter types are inferred from the values
	 *   - If Map<string|number, ScalarType>: Explicit type hints for parameters
	 *   - If undefined: Parameters default to TEXT type
	 * @returns A Statement object.
	 * @throws QuereusError on failure (e.g., syntax error).
	 *
	 * @example
	 * // Infer types from initial values
	 * const stmt = db.prepare('INSERT INTO users (id, name) VALUES (?, ?)', [1, 'Alice']);
	 *
	 * @example
	 * // Explicit param types
	 * const types = new Map([
	 *   [1, { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false }],
	 *   [2, { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false }]
	 * ]);
	 * const stmt = db.prepare('INSERT INTO users (id, name) VALUES (?, ?)', types);
	 */
	prepare(sql: string, paramsOrTypes?: SqlParameters | SqlValue[] | Map<string | number, ScalarType>): Statement {
		this.checkOpen();
		log('Preparing SQL (new runtime): %s', sql);

		// Statement constructor defers planning/compilation until first step or explicit compile()
		const stmt = new Statement(this, sql, 0, paramsOrTypes);

		this.statements.add(stmt);
		return stmt;
	}

	/**
	 * Executes a query and returns the first result row as an object.
	 * The execution is serialized through the mutex and wrapped in an implicit
	 * transaction when in autocommit mode.
	 *
	 * @param sql The SQL query string to execute.
	 * @param params Optional parameters to bind.
	 * @param options Optional execution options (e.g. an `AbortSignal` for
	 *   cooperative cancellation — checked before preparing and at the row
	 *   boundary while the first row is produced).
	 * @returns A Promise resolving to the first result row as an object, or undefined if no rows.
	 * @throws QuereusError on failure (an `AbortError` if the signal fired).
	 */
	async get(sql: string, params?: SqlParameters | SqlValue[], options?: StatementOptions): Promise<Record<string, SqlValue> | undefined> {
		this.checkOpen();
		// Pre-flight cancellation before preparing/planning.
		throwIfAborted(options?.signal);
		const stmt = this.prepare(sql, params);
		try {
			// Params were already bound (and their types inferred) by prepare();
			// don't re-pass them or stmt.get() would rebind + re-validate every value.
			return await stmt.get(undefined, options);
		} finally {
			await stmt.finalize();
		}
	}

	// ============================================================================
	// Statement Execution - Core Infrastructure
	// ============================================================================

	/**
	 * Acquires the execution mutex and returns a release function.
	 * All statement execution is serialized through this mutex to prevent
	 * concurrent transactions from interfering with each other.
	 * This matches SQLite's behavior of serializing database access.
	 * @internal
	 */
	async _acquireExecMutex(): Promise<() => void> {
		const previousMutex = this.execMutex;
		let releaseMutex: () => void;
		this.execMutex = new Promise<void>(resolve => {
			releaseMutex = resolve;
		});
		await previousMutex;
		// Mark the mutex held from acquisition until the returned release runs, so a
		// re-entrant caller can detect it (see _isExecuting). The wrapper decrements
		// at most once even if release is invoked more than once.
		this.execMutexDepth++;
		let released = false;
		return () => {
			if (!released) {
				released = true;
				this.execMutexDepth--;
			}
			releaseMutex!();
		};
	}

	/**
	 * True while the exec mutex is held — i.e. a statement (`exec`/`eval`), an
	 * external-change ingest, or an MV-refresh sweep is in flight. A caller that
	 * would re-enter the engine (acquire the mutex again) from inside such a context
	 * — e.g. a `notifyLensDeployment` module listener whose work calls
	 * `ingestExternalRowChanges` — MUST check this and defer that work to run after
	 * the current statement releases the mutex; re-entering synchronously deadlocks
	 * on the chained mutex. Deliberately part of the consumable type surface (kept out
	 * of the internal-only set) so a basis-backing host in another package can make
	 * that defer-vs-await decision.
	 */
	_isExecuting(): boolean {
		return this.execMutexDepth > 0;
	}

	/**
	 * Executes a function with the execution mutex held.
	 * The mutex serializes all database access to prevent concurrent interference.
	 * @internal
	 */
	private async _withMutex<T>(executor: () => Promise<T>): Promise<T> {
		const releaseMutex = await this._acquireExecMutex();
		try {
			return await executor();
		} finally {
			releaseMutex();
		}
	}

	// ============================================================================
	// Transaction Control - Delegated to TransactionManager
	// ============================================================================

	/**
	 * Begins a transaction on all active connections.
	 * @internal
	 */
	async _beginTransaction(source: 'explicit' | 'implicit'): Promise<void> {
		await this.transactionManager.beginTransaction(source);
	}

	/**
	 * Commits the current transaction on all connections.
	 * @internal
	 */
	async _commitTransaction(): Promise<void> {
		await this.transactionManager.commitTransaction();
	}

	/**
	 * Rolls back the current transaction on all connections.
	 * @internal
	 */
	async _rollbackTransaction(): Promise<void> {
		await this.transactionManager.rollbackTransaction();
	}

	/**
	 * Ensures we're in a transaction. If in autocommit mode, starts an implicit transaction.
	 * @internal
	 */
	async _ensureTransaction(): Promise<void> {
		await this.transactionManager.ensureTransaction();
	}

	/**
	 * Commits if we're in an implicit transaction.
	 * @internal
	 */
	async _autocommitIfNeeded(): Promise<void> {
		await this.transactionManager.autocommitIfNeeded();
	}

	/**
	 * Rolls back if we're in an implicit transaction (on error).
	 * @internal
	 */
	async _autorollbackIfNeeded(): Promise<void> {
		await this.transactionManager.autorollbackIfNeeded();
	}

	/**
	 * Checks if we're currently in an implicit transaction.
	 * @internal
	 */
	_isImplicitTransaction(): boolean {
		return this.transactionManager.isImplicitTransaction();
	}

	/**
	 * Commits or rolls back an implicit transaction based on success.
	 * No-op if no implicit transaction is active — except when `error` is a
	 * RollbackConflictError (OR ROLLBACK), in which case we unconditionally
	 * roll back the active transaction (implicit or explicit) per SQLite
	 * semantics. FailConflictError commits prior rows even though the
	 * statement aborted (per OR FAIL semantics).
	 * @internal
	 */
	async _finalizeImplicitTransaction(success: boolean, error?: unknown): Promise<void> {
		// OR ROLLBACK: roll back any active transaction (implicit or explicit).
		if (!success && error instanceof RollbackConflictError) {
			if (this.transactionManager.isInTransaction()) {
				await this._rollbackTransaction();
			}
			return;
		}

		// OR FAIL: commit prior rows even though the statement aborted.
		const effectiveSuccess = success || error instanceof FailConflictError;

		if (this.transactionManager.isImplicitTransaction()) {
			if (effectiveSuccess) {
				await this._commitTransaction();
			} else {
				await this._rollbackTransaction();
			}
		}
	}

	/**
	 * Upgrades an implicit transaction to explicit.
	 * @internal
	 */
	_upgradeToExplicitTransaction(): void {
		this.transactionManager.upgradeToExplicitTransaction();
	}

	/**
	 * @internal
	 * Executes a single AST statement. Does not manage mutex or transactions.
	 * Used as the innermost execution primitive.
	 */
	private async _executeSingleStatement(statementAst: AST.Statement, params?: SqlParameters | SqlValue[], signal?: AbortSignal): Promise<void> {
		// Pre-flight cancellation: reject before building/optimizing the plan.
		throwIfAborted(signal);

		const { plan } = this._buildPlan([statementAst], params);

		if (plan.statements.length === 0) return; // No-op for this AST

		const optimizedPlan = this.optimizer.optimize(plan, this) as BlockNode;
		const emissionContext = new EmissionContext(this);
		const rootInstruction = emitPlanNode(optimizedPlan, emissionContext);
		const scheduler = new Scheduler(rootInstruction);

		// Normalize array params to a record keyed by 1-based index, matching Statement.bindAll
		let boundArgs: Record<number | string, SqlValue> = {};
		if (Array.isArray(params)) {
			params.forEach((value, index) => { boundArgs[index + 1] = value; });
		} else if (params) {
			boundArgs = { ...params };
		}

		const runtimeCtx: RuntimeContext = {
			db: this,
			stmt: undefined,
			params: boundArgs,
			context: createStrictRowContextMap(),
			tableContexts: wrapTableContextsStrict(new Map()),
			tracer: this.instructionTracer,
			enableMetrics: this.options.getBooleanOption('runtime_stats'),
			signal,
		};

		await scheduler.run(runtimeCtx);
	}

	/**
	 * @internal
	 * Executes a batch of AST statements sequentially.
	 * Does not manage mutex or transactions - caller must handle that.
	 */
	private async _executeStatementBatch(batch: AST.Statement[], params?: SqlParameters | SqlValue[]): Promise<void> {
		for (const statementAst of batch) {
			await this._executeSingleStatement(statementAst, params);
		}
	}

	/**
	 * Parses SQL into a statement batch.
	 */
	private _parseSql(sql: string): AST.Statement[] {
		return new Parser().parseAll(sql);
	}

	// ============================================================================
	// Statement Execution - Public API
	// ============================================================================

	/**
	 * Executes one or more SQL statements directly.
	 * Statements are serialized through the execution mutex. Transactions are started
	 * lazily (just-in-time) when the first DML or DDL operation occurs. Each
	 * statement is its own implicit-transaction boundary — matching SQLite's
	 * autocommit semantics, where every statement either commits on success or
	 * rolls back on failure independently of its sibling statements in the same
	 * `exec` batch. Statements running inside an explicit transaction (user
	 * `BEGIN`) are NOT auto-committed per-statement; they remain part of the
	 * surrounding explicit transaction until the user issues `COMMIT` or
	 * `ROLLBACK`.
	 *
	 * @param sql The SQL string(s) to execute.
	 * @param params Optional parameters to bind.
	 * @param options Optional execution options (e.g. an `AbortSignal` for
	 *   cooperative cancellation — checked before each statement and at row
	 *   boundaries during execution).
	 * @returns A Promise resolving when execution completes.
	 * @throws QuereusError on failure (an `AbortError` if the signal fired).
	 */
	async exec(sql: string, params?: SqlParameters, options?: StatementOptions): Promise<void> {
		this.checkOpen();
		log('Executing SQL block: %s', sql);

		const signal = options?.signal;
		// Pre-flight cancellation before acquiring the mutex / parsing.
		throwIfAborted(signal);

		const batch = this._parseSql(sql);
		if (batch.length === 0) return;

		await this._withMutex(async () => {
			// Per-statement implicit-transaction scope: matches SQLite autocommit
			// semantics so a later statement's failure (e.g. OR ABORT) does NOT
			// roll back prior statements that already successfully committed.
			// The `isImplicitTransaction()` gate skips this for statements
			// running inside an explicit `BEGIN…COMMIT` block, including
			// statements that follow a mid-batch `BEGIN`.
			for (const statementAst of batch) {
				try {
					await this._executeSingleStatement(statementAst, params, signal);
					if (this.transactionManager.isImplicitTransaction()) {
						await this._commitTransaction();
					}
				} catch (err) {
					if (this.transactionManager.isImplicitTransaction()) {
						await this._rollbackTransaction();
					}
					throw err;
				}
			}
		});
	}

	/**
	 * Execute SQL without acquiring the mutex.
	 * Used by runtime code (e.g., APPLY SCHEMA) that needs to execute
	 * nested SQL statements while already holding the mutex.
	 * @internal
	 */
	async _execWithinTransaction(sql: string, params?: SqlParameters): Promise<void> {
		log('Executing nested SQL: %s', sql);

		const batch = this._parseSql(sql);
		if (batch.length === 0) return;

		// No mutex, no implicit transaction management - we're already inside a transaction
		await this._executeStatementBatch(batch, params);
	}

	/**
	 * Execute a function with mutex held.
	 * Transaction management is handled by the executor if needed.
	 * @internal
	 */
	async _runWithMutex<T>(executor: () => Promise<T>): Promise<T> {
		return this._withMutex(executor);
	}

	/**
	 * Registers a virtual table module.
	 * @param name The name of the module.
	 * @param module The module implementation.
	 * @param auxData Optional client data passed to create/connect.
	 */
	registerModule(name: string, module: AnyVirtualTableModule, auxData?: unknown): void {
		this.checkOpen();
		if (typeof name !== 'string' || !name) {
			throw new MisuseError('registerModule: name must be a non-empty string');
		}
		if (!module || typeof module !== 'object') {
			throw new MisuseError('registerModule: module must be an object');
		}
		if (typeof module.create !== 'function') {
			throw new MisuseError('registerModule: module.create must be a function');
		}
		if (typeof module.connect !== 'function') {
			throw new MisuseError('registerModule: module.connect must be a function');
		}
		if (typeof module.destroy !== 'function') {
			throw new MisuseError('registerModule: module.destroy must be a function');
		}
		this.schemaManager.registerModule(name, module, auxData);

		// Check if the module has a getEventEmitter method and hook it up
		this.hookModuleEvents(name, module);
	}

	/**
	 * Hook a module's event emitter to forward events to the database level.
	 * @internal
	 */
	private hookModuleEvents(name: string, module: AnyVirtualTableModule): void {
		const emitter = tryGetEventEmitter(module);
		if (emitter) {
			this.eventEmitter.hookModuleEmitter(name, emitter);
			log('Hooked event emitter for module: %s', name);
		}
	}

	// ============================================================================
	// Database-Level Events
	// ============================================================================

	/**
	 * Subscribe to data change events from all modules.
	 *
	 * Events are emitted after successful transaction commit. During a transaction,
	 * events are batched and only delivered once the transaction commits successfully.
	 * On rollback, batched events are discarded.
	 *
	 * @param listener Callback invoked for each data change event
	 * @param options Optional subscription options (reserved for future filtering)
	 * @returns Unsubscribe function
	 *
	 * @example
	 * ```typescript
	 * const unsubscribe = db.onDataChange((event) => {
	 *   console.log(`${event.type} on ${event.tableName} (module: ${event.moduleName})`);
	 *   if (event.remote) {
	 *     console.log('Change came from remote source');
	 *   }
	 * });
	 *
	 * // Later, when no longer needed:
	 * unsubscribe();
	 * ```
	 */
	onDataChange(
		listener: (event: DatabaseDataChangeEvent) => void,
		options?: DataChangeSubscriptionOptions
	): () => void {
		this.checkOpen();
		return this.eventEmitter.onDataChange(listener, options);
	}

	/**
	 * Subscribe to schema change events from all modules.
	 *
	 * Schema events are emitted when tables, indexes, or columns are created,
	 * altered, or dropped. Events are delivered after the DDL operation completes.
	 *
	 * @param listener Callback invoked for each schema change event
	 * @param options Optional subscription options (reserved for future filtering)
	 * @returns Unsubscribe function
	 *
	 * @example
	 * ```typescript
	 * const unsubscribe = db.onSchemaChange((event) => {
	 *   console.log(`${event.type} ${event.objectType}: ${event.objectName}`);
	 *   if (event.ddl) {
	 *     console.log('DDL:', event.ddl);
	 *   }
	 * });
	 * ```
	 */
	onSchemaChange(
		listener: (event: DatabaseSchemaChangeEvent) => void,
		options?: SchemaChangeSubscriptionOptions
	): () => void {
		this.checkOpen();
		return this.eventEmitter.onSchemaChange(listener, options);
	}

	/**
	 * Check if there are any data change listeners registered.
	 */
	hasDataListeners(): boolean {
		return this.eventEmitter.hasDataListeners();
	}

	/**
	 * Check if there are any schema change listeners registered.
	 */
	hasSchemaListeners(): boolean {
		return this.eventEmitter.hasSchemaListeners();
	}

	/**
	 * @internal Whether the engine must generate/collect data-change events for
	 * this statement — true when any `onDataChange` OR `onTransactionCommit`
	 * listener is registered. The DML executor's auto-event gate consults this so a
	 * consumer subscribed only to the grouped transaction-commit channel still gets
	 * data events collected.
	 */
	_needsDataEvents(): boolean {
		return this.eventEmitter.needsDataEvents();
	}

	/**
	 * @internal Whether the engine must generate/collect schema-change events —
	 * true when any `onSchemaChange` OR `onTransactionCommit` listener is
	 * registered. Companion to {@link _needsDataEvents}; consulted by the schema
	 * manager's auto-event gate.
	 */
	_needsSchemaEvents(): boolean {
		return this.eventEmitter.needsSchemaEvents();
	}

	/**
	 * Subscribe to materialized-view key-coarsening **collision** events — the
	 * operational complement to the create-time key-coarsening warning. A
	 * {@link MaintenanceCollisionEvent} fires whenever row-time maintenance
	 * LWW-merges two distinct source-key tuples under one coarsened backing key K′
	 * (`docs/materialized-views.md` § Coarsened backing keys). Events share the
	 * transaction-batching discipline of the data/schema channels — delivered after
	 * the commit that realized the merge, dropped on rollback.
	 *
	 * @param listener Callback invoked for each committed collision
	 * @returns Unsubscribe function
	 *
	 * @example
	 * ```typescript
	 * const off = db.onMaintenanceCollision((e) => {
	 *   console.warn(`coarsening collision on ${e.schemaName}.${e.tableName} ` +
	 *     `at key ${JSON.stringify(e.key)} (columns: ${e.weakenedColumns.join(', ')})`);
	 * });
	 * ```
	 */
	onMaintenanceCollision(listener: (event: MaintenanceCollisionEvent) => void): () => void {
		this.checkOpen();
		return this.eventEmitter.onMaintenanceCollision(listener);
	}

	/**
	 * Read-only snapshot of the cumulative committed key-coarsening collision
	 * counter, keyed by lowercased qualified `schema.table` of the maintained
	 * table. Reflects only collisions that committed (consistent with event
	 * delivery) and is maintained whether or not a listener was ever subscribed.
	 */
	getMaterializedViewCollisionStats(): ReadonlyMap<string, number> {
		this.checkOpen();
		return this.eventEmitter.getMaterializedViewCollisionStats();
	}

	/**
	 * Subscribe to grouped per-transaction commit batches — the authoritative
	 * "one logical transaction = one group" boundary. A
	 * {@link TransactionCommitBatch} fires **once** per committed transaction,
	 * carrying every data and schema event of that transaction across **all**
	 * tables, in flush order. Unlike the per-event {@link onDataChange} /
	 * {@link onSchemaChange} channels (which this does not replace — it is purely
	 * additive), a single subscription receives the whole transaction as one unit,
	 * which is what a consumer grouping changes by transaction (e.g. assigning one
	 * HLC per transaction) needs. Dropped on rollback; never fires for a
	 * transaction that produced no data/schema events.
	 *
	 * @param listener Callback invoked once per committed transaction
	 * @returns Unsubscribe function
	 *
	 * @example
	 * ```typescript
	 * const off = db.onTransactionCommit((batch) => {
	 *   // All changes of one transaction, across all tables, in order.
	 *   const local = batch.dataEvents.filter((e) => !e.remote);
	 *   console.log(`committed ${local.length} local row changes, ` +
	 *     `${batch.schemaEvents.length} schema changes`);
	 * });
	 * ```
	 */
	onTransactionCommit(listener: (batch: TransactionCommitBatch) => void): () => void {
		this.checkOpen();
		return this.eventEmitter.onTransactionCommit(listener);
	}

	/**
	 * Get the internal event emitter for advanced use cases.
	 * @internal
	 */
	_getEventEmitter(): DatabaseEventEmitter {
		return this.eventEmitter;
	}

	/**
	 * Begins a transaction.
	 */
	async beginTransaction(): Promise<void> {
		this.checkOpen();

		if (this.transactionManager.isInTransaction()) {
			throw new QuereusError("Transaction already active", StatusCode.ERROR);
		}

		await this.exec("BEGIN TRANSACTION");
	}

	/**
	 * Commits the current transaction.
	 */
	async commit(): Promise<void> {
		this.checkOpen();

		if (!this.transactionManager.isInTransaction()) {
			throw new QuereusError("No transaction active", StatusCode.ERROR);
		}

		await this.exec("COMMIT");
	}

	/**
	 * Rolls back the current transaction.
	 */
	async rollback(): Promise<void> {
		this.checkOpen();

		if (!this.transactionManager.isInTransaction()) {
			throw new QuereusError("No transaction active", StatusCode.ERROR);
		}

		await this.exec("ROLLBACK");
	}

	/**
	 * Closes the database connection and releases resources.
	 * @returns A promise resolving on completion.
	 */
	async close(): Promise<void> {
		if (!this.isOpen) {
			return;
		}

		log("Closing database...");
		this.isOpen = false;

		// Disconnect all active connections first
		await this.disconnectAllConnections();

		// Drain the internal FK/DDL statement pool (finalizes its cached statements,
		// which also deregisters them from `this.statements` below — double-finalize
		// is a no-op, so the subsequent sweep is harmless).
		await this._internalStatementCache.clear();

		// Finalize all prepared statements
		const finalizePromises = Array.from(this.statements).map(stmt => stmt.finalize());
		await Promise.allSettled(finalizePromises); // Wait even if some fail
		this.statements.clear();

		// Clean up assertion evaluator (unsubscribe schema change listener, clear plan cache)
		this.assertionEvaluator.dispose();

		// Clean up watcher manager (dispose all subscriptions + schema listener)
		this.watcherManager.dispose();

		// Clean up materialized-view manager (unsubscribe schema listener)
		this.materializedViewManager.dispose();

		// Clear schemas, ensuring VTabs are potentially disconnected
		// This will also call destroy on VTabs via SchemaManager.clearAll -> schema.clearTables -> schemaManager.dropTable
		this.schemaManager.clearAll();

		// Clean up event emitter
		this.eventEmitter.removeAllListeners();

		log("Database closed.");
	}

	/** @internal Called by Statement when it's finalized */
	_statementFinalized(stmt: Statement): void {
		this.statements.delete(stmt);
	}

	/**
	 * Checks if the database connection is in autocommit mode.
	 */
	getAutocommit(): boolean {
		this.checkOpen();
		return this.transactionManager.getAutocommit();
	}

	/**
	 * Programmatically defines or replaces a table in the 'main' schema.
	 * This is an alternative/supplement to using `CREATE TABLE`.
	 * @param definition The schema definition for the table.
	 */
	defineTable(definition: TableSchema): void {
		this.checkOpen();
		if (definition.schemaName !== 'main') {
			throw new MisuseError("Programmatic definition only supported for 'main' schema currently");
		}

		this.schemaManager.getMainSchema().addTable(definition);
	}

	/** Wraps function registration with consistent error logging and re-throw. */
	private registerFunctionWithErrorHandling(
		funcType: string,
		funcName: string,
		numArgs: number,
		register: () => void
	): void {
		try {
			register();
		} catch (e) {
			errorLog(`Failed to register ${funcType} function ${funcName}/${numArgs}: %O`, e);
			if (e instanceof QuereusError) throw e;
			throw new QuereusError(
				`Failed to register ${funcType} function ${funcName}/${numArgs}: ${e instanceof Error ? e.message : String(e)}`,
				StatusCode.ERROR,
				e instanceof Error ? e : undefined
			);
		}
	}

	/**
	 * Registers a user-defined scalar function.
	 *
	 * @param name The name of the SQL function.
	 * @param options Configuration: { numArgs: number, deterministic?: boolean, flags?: number }.
	 * @param func The JavaScript function implementation.
	 */
	createScalarFunction(
		name: string,
		options: {
			numArgs: number;
			deterministic?: boolean;
			replicable?: boolean;
			flags?: number;
			hidden?: boolean;
		},
		func: (...args: SqlValue[]) => SqlValue
	): void {
		this.checkOpen();

		const baseFlags = (options.deterministic ? FunctionFlags.DETERMINISTIC : 0) | FunctionFlags.UTF8;
		const flags = options.flags ?? baseFlags;

		const schema = createScalarFunction(
			{ name, numArgs: options.numArgs, flags, replicable: options.replicable, hidden: options.hidden },
			func
		);

		this.registerFunctionWithErrorHandling('scalar', name, options.numArgs, () => {
			this.schemaManager.getMainSchema().addFunction(schema);
		});
	}

	/**
	 * Registers a user-defined aggregate function.
	 *
	 * @param name The name of the SQL function.
	 * @param options Configuration: { numArgs: number, flags?: number, initialState?: unknown }.
	 * @param stepFunc The function called for each row (accumulator, ...args) => newAccumulator.
	 * @param finalFunc The function called at the end (accumulator) => finalResult.
	 */
	createAggregateFunction(
		name: string,
		options: {
			numArgs: number;
			flags?: number;
			replicable?: boolean;
			initialState?: unknown;
		},
		stepFunc: (acc: unknown, ...args: SqlValue[]) => unknown,
		finalFunc: (acc: unknown) => SqlValue
	): void {
		this.checkOpen();

		const flags = options.flags ?? FunctionFlags.UTF8;

		const schema = createAggregateFunction(
			{ name, numArgs: options.numArgs, flags, replicable: options.replicable, initialValue: options.initialState },
			stepFunc,
			finalFunc
		);

		this.registerFunctionWithErrorHandling('aggregate', name, options.numArgs, () => {
			this.schemaManager.getMainSchema().addFunction(schema);
		});
	}

	/**
	 * Registers a function using a pre-defined FunctionSchema.
	 * This is the lower-level registration method.
	 *
	 * @param schema The FunctionSchema object describing the function.
	 */
	registerFunction(schema: FunctionSchema): void {
		this.checkOpen();
		if (!schema || typeof schema !== 'object') {
			throw new MisuseError('registerFunction: schema must be an object');
		}
		if (typeof schema.name !== 'string' || !schema.name) {
			throw new MisuseError('registerFunction: schema.name must be a non-empty string');
		}
		if (!Number.isInteger(schema.numArgs) || schema.numArgs < -1) {
			throw new MisuseError('registerFunction: schema.numArgs must be an integer >= -1');
		}
		// Validate that appropriate implementation functions exist
		if ('stepFunction' in schema) {
			if (typeof schema.stepFunction !== 'function') {
				throw new MisuseError('registerFunction: aggregate schema.stepFunction must be a function');
			}
			if (!('finalizeFunction' in schema) || typeof schema.finalizeFunction !== 'function') {
				throw new MisuseError('registerFunction: aggregate schema.finalizeFunction must be a function');
			}
		} else if ('implementation' in schema) {
			if (typeof schema.implementation !== 'function') {
				throw new MisuseError('registerFunction: schema.implementation must be a function');
			}
		} else {
			throw new MisuseError('registerFunction: schema must have implementation (scalar/TVF) or stepFunction+finalizeFunction (aggregate)');
		}
		this.registerFunctionWithErrorHandling('user', schema.name, schema.numArgs, () => {
			this.schemaManager.getMainSchema().addFunction(schema);
		});
	}

	/** Sets only the name of the default module. */
	setDefaultVtabName(name: string): void {
		this.checkOpen();
		this.schemaManager.setDefaultVTabModuleName(name);
	}

	/** Sets the default args directly. */
	setDefaultVtabArgs(args: Record<string, SqlValue>): void {
		this.checkOpen();
		this.schemaManager.setDefaultVTabArgs(args);
	}

	/** @internal Sets the default args by parsing a JSON string. Should be managed by SchemaManager now. */
	setDefaultVtabArgsFromJson(argsJsonString: string): void {
		this.checkOpen();
		this.schemaManager.setDefaultVTabArgsFromJson(argsJsonString);
	}

	/**
	 * Gets the default virtual table module name and arguments.
	 * @returns An object containing the module name and arguments.
	 */
	getDefaultVtabModule(): { name: string; args: Record<string, SqlValue> } {
		this.checkOpen();
		return this.schemaManager.getDefaultVTabModule();
	}

	/**
	 * Sets the default schema search path for resolving unqualified table names.
	 * This is a convenience method equivalent to setting the 'schema_path' option.
	 *
	 * @param paths Array of schema names to search in order
	 *
	 * @example
	 * ```typescript
	 * db.setSchemaPath(['main', 'extensions', 'plugins']);
	 * // Now unqualified tables search: main → extensions → plugins
	 * ```
	 */
	setSchemaPath(paths: string[]): void {
		this.checkOpen();
		const pathString = paths.join(',');
		this.options.setOption('schema_path', pathString);
	}

	/**
	 * Gets the current schema search path.
	 *
	 * @returns Array of schema names in search order
	 *
	 * @example
	 * ```typescript
	 * const path = db.getSchemaPath();
	 * console.log(path); // ['main', 'extensions', 'plugins']
	 * ```
	 */
	getSchemaPath(): string[] {
		this.checkOpen();
		return parseSchemaPath(this.options.getStringOption('schema_path')) ?? [];
	}

	/**
	 * Set database configuration options
	 * @param option The option name
	 * @param value The option value
	 */
	setOption(option: string, value: unknown): void {
		this.checkOpen();
		this.options.setOption(option, value);
	}

	/**
	 * Get database configuration option value
	 * @param option The option name
	 * @returns The option value
	 */
	getOption(option: string): unknown {
		this.checkOpen();
		return this.options.getOption(option);
	}

	/** Update optimizer tuning in place */
	private updateOptimizerTuning(tuning: OptimizerTuning): void {
		this.optimizer.updateTuning(tuning);
	}

	/**
	 * Registers a user-defined collation sequence. `NOCASE` and `RTRIM` may be replaced;
	 * `BINARY` may not (see {@link getCollationResolver}) and throws `MisuseError`.
	 * @param name The name of the collation sequence (case-insensitive).
	 * @param func The comparison function (a, b) => number (-1, 0, 1).
	 * @param optionsOrNormalizer Either a bare key normalizer (the legacy positional
	 *   form) or an options object `{ normalizer?, replicable?, orderPreserving? }`:
	 *   - `normalizer` — a function whose output equality partitions strings into the
	 *     same equivalence classes as `func` (modulo total ordering). Required to make
	 *     this collation usable as the key for a compound index; ORDER BY / standalone
	 *     comparisons work without it.
	 *   - `replicable` — assert this collation is **bit-identical across peers,
	 *     platforms, and app versions** (not merely deterministic). Consulted only by
	 *     the materialized-view replicable-collation gate when a backing host declares
	 *     `requiresReplicableDerivations`. Defaults to `false` — the conservative
	 *     default for a custom collation (built-ins auto-qualify).
	 *   - `orderPreserving` — assert the normalizer preserves ORDER, not merely
	 *     equality: for all strings `x`, `y`,
	 *     `sign(func(x, y)) === sign(memcmp(utf8(normalizer(x)), utf8(normalizer(y))))`.
	 *     This is strictly stronger than the equality promise `normalizer` alone makes.
	 *     Persistent stores physically order rows by the normalized key bytes, so they
	 *     may only seek a byte range — or advertise byte order as collation order — for
	 *     a collation carrying this assertion; without it they fall back to a full scan
	 *     plus a comparator-accurate residual filter (correct, just slower). Defaults to
	 *     `false` — correctness over speed for a custom collation (built-ins auto-qualify).
	 *     See {@link _isCollationOrderPreserving}.
	 * @example
	 * // Example: Create a custom collation for phone numbers
	 * db.registerCollation('PHONENUMBER', (a, b) => {
	 *   const normalize = (phone) => phone.replace(/\D/g, '');
	 *   const numA = normalize(a);
	 *   const numB = normalize(b);
	 *   return numA < numB ? -1 : numA > numB ? 1 : 0;
	 * }, (s) => s.replace(/\D/g, ''));
	 *
	 * // A locale-independent custom collation a replicating backing can host:
	 * db.registerCollation('CODEPOINT', cmp, { replicable: true });
	 *
	 * // A normalizer whose byte order matches its comparator, so store range seeks stay:
	 * db.registerCollation('NOSPACE', cmp, { normalizer: s => s.replace(/ /g, ''), orderPreserving: true });
	 *
	 * // Then use it in SQL:
	 * // SELECT * FROM contacts ORDER BY phone COLLATE PHONENUMBER;
	 * // CREATE INDEX phone_idx ON contacts(phone COLLATE PHONENUMBER);
	 */
	// NOTE: registration is not retroactive. Comparators and key normalizers are
	// resolved once, at comparator-construction time (index build, plan emission), so a
	// collation registered — or re-registered with a different comparator/normalizer —
	// after a structure was built does not rebuild it. A statement emitted *after* the
	// re-registration does see the new one. Register collations before creating tables
	// and indexes that name them. If retroactive re-registration ever needs to be
	// supported, invalidate dependent indexes and cached plans here: the collation
	// dependency `EmissionContext` records only drives an existence check before
	// execution (`validateCapturedSchemaObjects`), which warns — it does not invalidate.
	//
	// NOTE: `orderPreserving` is stated against UTF-8 memcmp of the normalized forms, and the
	// built-ins hold it for every WELL-FORMED string. It is unachievable for unpaired
	// surrogates, which have no UTF-8 encoding at all (`TextEncoder` folds each to U+FFFD);
	// the persistent store therefore REFUSES to key them (`quereus-store`'s `encodeText`
	// raises), so no value a store-backed table can hold falls outside the assertion. Memory
	// tables still accept them, which is why comparators must stay total there. A custom
	// collation that compares with JS `<`/`>` orders by UTF-16 code unit and must NOT claim
	// the assertion; use {@link import('../util/comparison.js').compareCodePoints}.
	registerCollation(
		name: string,
		func: CollationFunction,
		optionsOrNormalizer?: ((s: string) => string) | RegisterCollationOptions,
	): void {
		this.checkOpen();
		if (typeof name !== 'string' || !name) {
			throw new MisuseError('registerCollation: name must be a non-empty string');
		}
		if (typeof func !== 'function') {
			throw new MisuseError('registerCollation: func must be a function');
		}
		// A function-typed third arg is the legacy normalizer-only path (existing call
		// sites unchanged, `replicable` and `orderPreserving` default to false); an object
		// reads its fields; any other non-undefined third arg is a misused legacy normalizer.
		let normalizer: ((s: string) => string) | undefined;
		let replicable = false;
		let orderPreserving = false;
		if (typeof optionsOrNormalizer === 'function') {
			normalizer = optionsOrNormalizer;
		} else if (typeof optionsOrNormalizer === 'object' && optionsOrNormalizer !== null) {
			normalizer = optionsOrNormalizer.normalizer;
			replicable = optionsOrNormalizer.replicable === true;
			orderPreserving = optionsOrNormalizer.orderPreserving === true;
		} else if (optionsOrNormalizer !== undefined) {
			throw new MisuseError('registerCollation: normalizer must be a function when supplied');
		}
		if (normalizer !== undefined && typeof normalizer !== 'function') {
			throw new MisuseError('registerCollation: normalizer must be a function when supplied');
		}
		const upperName = normalizeCollationName(name);
		if (upperName === 'BINARY') {
			// Resolvers fast-path BINARY to the built-in comparator, so an override could
			// never take effect uniformly — reject rather than silently half-apply it.
			throw new MisuseError('registerCollation: BINARY cannot be overridden');
		}
		if (this.collations.has(upperName)) {
			log('Overwriting existing collation: %s', upperName);
		}
		const entry: CollationEntry = { comparator: func };
		if (normalizer !== undefined) entry.normalizer = normalizer;
		if (replicable) entry.replicable = true;
		if (orderPreserving) entry.orderPreserving = true;
		this.collations.set(upperName, entry);
		log('Registered collation: %s%s%s%s', upperName,
			normalizer !== undefined ? ' (with normalizer)' : '',
			replicable ? ' (replicable)' : '',
			orderPreserving ? ' (order-preserving)' : '');
	}

	/**
	 * True iff `name` names a collation this connection can resolve — a built-in
	 * (BINARY/NOCASE/RTRIM) or one registered via {@link registerCollation}. The
	 * DDL-time counterpart of {@link getCollationResolver} that returns a boolean
	 * instead of throwing; used to gate an explicit column COLLATE against the
	 * connection's registry (see `validateCollationForType`). Names are normalized
	 * (trim + uppercase) here and in {@link _getCollation}, so whitespace / case
	 * variants resolve identically.
	 */
	isCollationRegistered(name: string): boolean {
		return normalizeCollationName(name) === 'BINARY' || this._getCollation(name) !== undefined;
	}

	/**
	 * Registers a custom logical type.
	 * @param name The name of the type (case-insensitive).
	 * @param definition The LogicalType implementation.
	 * @example
	 * // Example: Create a custom UUID type
	 * db.registerType('UUID', {
	 *   name: 'UUID',
	 *   physicalType: PhysicalType.TEXT,
	 *   validate: (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
	 *   parse: (v) => typeof v === 'string' ? v.toLowerCase() : v,
	 * });
	 *
	 * // Then use it in SQL:
	 * // CREATE TABLE users (id UUID PRIMARY KEY, name TEXT);
	 */
	registerType(name: string, definition: LogicalType): void {
		this.checkOpen();
		if (typeof name !== 'string' || !name) {
			throw new MisuseError('registerType: name must be a non-empty string');
		}
		if (!definition || typeof definition !== 'object') {
			throw new MisuseError('registerType: definition must be an object');
		}
		if (typeof definition.name !== 'string' || !definition.name) {
			throw new MisuseError('registerType: definition.name must be a non-empty string');
		}
		// Validate physicalType is a valid enum value (0-5)
		if (typeof definition.physicalType !== 'number' || !Number.isInteger(definition.physicalType) || definition.physicalType < 0 || definition.physicalType > 5) {
			throw new MisuseError('registerType: definition.physicalType must be a valid PhysicalType enum value (0-5)');
		}
		if (definition.name.toLowerCase() !== name.toLowerCase()) {
			throw new QuereusError(
				`Type name mismatch: registerType('${name}', ...) does not match definition.name '${definition.name}'`,
				StatusCode.ERROR
			);
		}
		try {
			registerTypeInRegistry(definition);
		} catch (e) {
			errorLog('Failed to register type %s: %O', name, e);
			if (e instanceof QuereusError) throw e;
			throw new QuereusError(
				`Failed to register type '${name}': ${e instanceof Error ? e.message : String(e)}`,
				StatusCode.ERROR,
				e instanceof Error ? e : undefined
			);
		}
		log('Registered type: %s', name);
	}

	/**
	 * Sets the instruction tracer for this database.
	 * The tracer will be used for all statement executions.
	 * @param tracer The instruction tracer to use, or null to disable tracing.
	 */
	setInstructionTracer(tracer: InstructionTracer | undefined): void {
		this.instructionTracer = tracer;
		log('Instruction tracer %s', tracer ? 'enabled' : 'disabled');
	}

	/**
	 * Gets the current instruction tracer for this database.
	 * @returns The instruction tracer, or undefined if none is set.
	 */
	getInstructionTracer(): InstructionTracer | undefined {
		return this.instructionTracer;
	}

	/**
	 * The canonical way to turn a collation name into a comparison function for this
	 * database. Every comparator-construction site should route through this rather
	 * than the deprecated process-global registry in `util/comparison.ts`, so a
	 * collation registered with {@link registerCollation} is actually honored.
	 *
	 * The returned resolver:
	 * - has stable identity across calls (bound once) and reads the live per-database
	 *   registry, so a collation registered *after* the resolver was handed out is
	 *   visible to later calls;
	 * - resolves names case-insensitively (and tolerates surrounding whitespace);
	 * - **throws** `QuereusError` (`no such collation sequence: X`) on an unknown name.
	 *   An unresolvable collation is never downgraded to BINARY: byte-order results
	 *   would be silently wrong for ORDER BY, UNIQUE, and index seeks alike;
	 * - fast-paths the exact name `BINARY`. `BINARY` cannot be overridden — this is
	 *   the fast path's correctness precondition, enforced by {@link registerCollation}
	 *   rejecting it. Any other built-in — including `NOCASE` and `RTRIM` — can be
	 *   overridden per database.
	 *
	 * It performs no `checkOpen()` check: it runs on hot comparator-construction paths,
	 * and reading the registry of a closed database is harmless.
	 */
	getCollationResolver(): CollationResolver {
		if (this.collationResolver === undefined) {
			this.collationResolver = (collationName: string): CollationFunction => {
				if (collationName === 'BINARY') return BINARY_COLLATION;
				const func = this._getCollation(collationName);
				if (!func) {
					throw new QuereusError(`no such collation sequence: ${collationName}`, StatusCode.ERROR);
				}
				return func;
			};
		}
		return this.collationResolver;
	}

	/**
	 * The canonical way to turn a collation name into a **key normalizer** for this
	 * database — the hash-keyed counterpart of {@link getCollationResolver}. Every
	 * operator that buckets rows by a text key (GROUP BY, window PARTITION BY, bloom /
	 * hash join keys, AS OF partitioning) must resolve through this, so that grouping
	 * and comparison agree on which rows are equal.
	 *
	 * Same contract as {@link getCollationResolver}: stable identity, reads the live
	 * registry, no `checkOpen()`, and **no silent fallback**.
	 *
	 * - `undefined` or the exact name `BINARY` → the identity normalizer. `BINARY`
	 *   cannot be overridden ({@link registerCollation} rejects it), which is this fast
	 *   path's correctness precondition.
	 * - A registered collation carrying a normalizer → that normalizer.
	 * - A registered collation with **no** normalizer → throws. A comparator-only
	 *   collation can order rows but cannot bucket them; guessing a normalizer would
	 *   split or merge groups the comparator disagrees with.
	 * - An unregistered name → throws `no such collation sequence: X`.
	 */
	getKeyNormalizerResolver(): KeyNormalizerResolver {
		if (this.keyNormalizerResolver === undefined) {
			this.keyNormalizerResolver = (collationName: string | undefined): KeyNormalizer => {
				if (!collationName || collationName === 'BINARY') return BUILTIN_NORMALIZERS.BINARY;
				const normalizer = this._getCollationNormalizer(collationName);
				if (normalizer) return normalizer;
				if (!this._getCollation(collationName)) {
					throw new QuereusError(`no such collation sequence: ${collationName}`, StatusCode.ERROR);
				}
				throw new QuereusError(
					`collation ${collationName} has no key normalizer; grouping and hash-join keys require one — pass { normalizer } to registerCollation`,
					StatusCode.ERROR
				);
			};
		}
		return this.keyNormalizerResolver;
	}

	/** @internal Gets a registered collation function */
	_getCollation(name: string): CollationFunction | undefined {
		return this.collations.get(normalizeCollationName(name))?.comparator;
	}

	/** @internal Gets the registered key normalizer for a collation. Returns `undefined`
	 *  both for an unregistered name and for a comparator-only collation — the two are
	 *  distinguished, and turned into errors, by {@link getKeyNormalizerResolver}.
	 *
	 *  There is deliberately no built-in fallback: an embedder that re-registers `NOCASE`
	 *  with a custom comparator and no normalizer must get a loud error, not the built-in
	 *  lowercase normalizer, which would partition strings differently from their
	 *  comparator. The built-ins are seeded *with* their normalizers in
	 *  `registerDefaultCollations()`, so a fresh database loses nothing. */
	_getCollationNormalizer(name: string): KeyNormalizer | undefined {
		return this.collations.get(normalizeCollationName(name))?.normalizer;
	}

	/** @internal True iff the named collation is asserted REPLICABLE — bit-identical
	 *  across peers/platforms/app-versions. Built-ins are stamped `replicable` at
	 *  registration; a custom collation opts in with `replicable: true`. An unknown
	 *  collation returns `false` defensively (an unknown collation in a derivation
	 *  body errors earlier at create). Consumed only by the materialized-view
	 *  replicable-collation gate when the backing host declares
	 *  `requiresReplicableDerivations`. */
	_isCollationReplicable(name: string): boolean {
		return this.collations.get(normalizeCollationName(name))?.replicable === true;
	}

	/** @internal True iff the named collation is asserted ORDER-PRESERVING: for all strings
	 *  `x`, `y`, `sign(comparator(x, y))` equals
	 *  `sign(memcmp(utf8(normalizer(x)), utf8(normalizer(y))))`. Strictly stronger than the
	 *  equality-partition promise a bare normalizer makes — a normalizer may agree with the
	 *  comparator on equality while disagreeing on order.
	 *
	 *  Built-ins are stamped `orderPreserving` at registration; a custom collation opts in
	 *  with `orderPreserving: true`. An unregistered name, or a comparator-only collation
	 *  (no normalizer, hence no key bytes at all), returns `false` defensively.
	 *
	 *  Consumed by persistent stores, which physically order rows by normalized key bytes:
	 *  a byte-range seek, or an advertisement that byte order *is* collation order, is sound
	 *  only under this assertion. Without it the store full-scans and lets its
	 *  comparator-accurate residual filter decide — slower, never wrong. */
	_isCollationOrderPreserving(name: string): boolean {
		const entry = this.collations.get(normalizeCollationName(name));
		// The assertion is *about* the normalizer, so it is vacuous without one; a
		// comparator-only collation cannot key a persisted structure anyway (the store
		// rejects it at DDL time), and answering `true` here would be a trap.
		return entry?.orderPreserving === true && entry.normalizer !== undefined;
	}

	public _queueDeferredConstraintRow(baseTable: string, constraintName: string, row: Row, descriptor: RowDescriptor, evaluator: (ctx: RuntimeContext) => OutputValue, connectionId?: string, contextRow?: Row, contextDescriptor?: RowDescriptor): void {
		this.deferredConstraints.enqueue(baseTable, constraintName, row, descriptor, evaluator, connectionId, contextRow, contextDescriptor);
	}

	public async runDeferredRowConstraints(): Promise<void> {
		await this.transactionManager.runDeferredRowConstraints();
	}

	/** @internal Check if we should skip auto-beginning transactions on newly registered connections */
	public _isEvaluatingDeferredConstraints(): boolean {
		return this.transactionManager.isEvaluatingDeferredConstraints();
	}

	/** @internal Check if we're in a coordinated commit (allows sibling layer validation) */
	public _inCoordinatedCommit(): boolean {
		return this.transactionManager.isInCoordinatedCommit();
	}

	/** Public API used by DML emitters to record changes. The full row plus
	 *  PK column indices are passed so the change capture can project the
	 *  columns that any active DeltaExecutor subscription has registered
	 *  demand for. */
	public _recordInsert(baseTable: string, newRow: Row, pkIndices: readonly number[]): void {
		this.transactionManager.recordInsert(baseTable, newRow, pkIndices);
	}

	public _recordDelete(baseTable: string, oldRow: Row, pkIndices: readonly number[]): void {
		this.transactionManager.recordDelete(baseTable, oldRow, pkIndices);
	}

	public _recordUpdate(baseTable: string, oldRow: Row, newRow: Row, pkIndices: readonly number[]): void {
		this.transactionManager.recordUpdate(baseTable, oldRow, newRow, pkIndices);
	}

	/**
	 * Create a named savepoint on the TransactionManager stack, returning
	 * its depth index. Does NOT broadcast to active connections — call sites
	 * driving real SAVEPOINT semantics (or statement/row-level placeholders)
	 * must use `_createSavepointBroadcast` instead, or per-connection
	 * savepoint stacks will silently desync.
	 */
	public _createSavepoint(name: string): number {
		return this.transactionManager.createSavepoint(name);
	}

	/**
	 * Release a named savepoint on the TransactionManager stack (merges layers
	 * down to target), returns target depth. See `_createSavepoint` —
	 * prefer `_releaseSavepointBroadcast` for any real SAVEPOINT semantics.
	 */
	public _releaseSavepoint(name: string): number {
		return this.transactionManager.releaseSavepoint(name);
	}

	/**
	 * Rollback to a named savepoint on the TransactionManager stack (discards
	 * layers down to target). See `_createSavepoint` — prefer
	 * `_rollbackToSavepointBroadcast` for any real SAVEPOINT semantics.
	 */
	public _rollbackToSavepoint(name: string): number {
		return this.transactionManager.rollbackToSavepoint(name);
	}

	/**
	 * Create a named savepoint AND broadcast it to every active connection so
	 * per-connection savepoint stacks stay in lockstep with the
	 * TransactionManager's stack. Returns the depth index.
	 *
	 * Prefer this over the bare `_createSavepoint` for any real SAVEPOINT (or
	 * statement/row-level placeholder) — `_createSavepoint` alone only
	 * advances the TxnMgr stack and silently desyncs per-connection stacks,
	 * a class of bug that has bitten multiple call sites historically.
	 * @internal
	 */
	public async _createSavepointBroadcast(name: string): Promise<number> {
		const depth = this.transactionManager.createSavepoint(name);
		for (const connection of this.getAllConnections()) {
			await connection.createSavepoint(depth);
		}
		return depth;
	}

	/**
	 * Release a named savepoint AND broadcast the release to every active
	 * connection. See `_createSavepointBroadcast` for the rationale.
	 * @internal
	 */
	public async _releaseSavepointBroadcast(name: string): Promise<number> {
		const depth = this.transactionManager.releaseSavepoint(name);
		for (const connection of this.getAllConnections()) {
			await connection.releaseSavepoint(depth);
		}
		return depth;
	}

	/**
	 * Roll back to a named savepoint AND broadcast the rollback to every
	 * active connection. See `_createSavepointBroadcast` for the rationale.
	 * @internal
	 */
	public async _rollbackToSavepointBroadcast(name: string): Promise<number> {
		const depth = this.transactionManager.rollbackToSavepoint(name);
		for (const connection of this.getAllConnections()) {
			await connection.rollbackToSavepoint(depth);
		}
		return depth;
	}

	/**
	 * Combo helper for the swallow-and-retry pattern used in DML-executor
	 * error paths: rollback-to + release, each wrapped in its own try/catch
	 * so a partial broadcast on rollback doesn't prevent release from running,
	 * and a missing-name on release doesn't escape.
	 * @internal
	 */
	public async _rollbackAndReleaseSavepointBroadcast(name: string): Promise<void> {
		try { await this._rollbackToSavepointBroadcast(name); } catch { /* swallow */ }
		try { await this._releaseSavepointBroadcast(name); } catch { /* swallow */ }
	}

	public _clearChangeLog(): void {
		this.transactionManager.clearChangeLog();
	}

	/**
	 * Prepares, binds parameters, executes, and yields result rows for a query.
	 * This is a high-level convenience method for iterating over query results.
	 * The underlying statement is automatically finalized when iteration completes
	 * or if an error occurs.
	 *
	 * Transactions are started lazily (just-in-time) when the first DML or DDL
	 * operation occurs. The mutex is held for the entire iteration.
	 *
	 * @param sql The SQL query string to execute.
	 * @param params Optional parameters to bind (array for positional, object for named).
	 * @param options Optional execution options (e.g. an `AbortSignal` for
	 *   cooperative cancellation — checked at row boundaries so iteration can be
	 *   interrupted on a request timeout).
	 * @yields Each result row as an object (`Record<string, SqlValue>`).
	 * @returns An `AsyncIterableIterator` yielding result rows.
	 * @throws MisuseError if the database is closed.
	 * @throws QuereusError on prepare/bind/execution errors (an `AbortError` if the signal fired).
	 *
	 * @example
	 * ```typescript
	 * try {
	 *   for await (const user of db.eval("SELECT * FROM users WHERE status = ?", ["active"])) {
	 *     console.log(`Active user: ${user.name}`);
	 *   }
	 * } catch (e) {
	 *   console.error("Query failed:", e);
	 * }
	 * ```
	 */
	eval(sql: string, params?: SqlParameters | SqlValue[], options?: StatementOptions): AsyncIterableIterator<Record<string, SqlValue>> {
		return wrapAsyncIterator(this._evalGenerator(sql, params, options?.signal), (commit, error) =>
			this._finalizeImplicitTransaction(commit, error)
		);
	}

	/**
	 * Internal generator for eval() that yields result rows.
	 * Transaction finalization is handled by the wrapper returned by eval().
	 * @internal
	 */
	private async *_evalGenerator(sql: string, params?: SqlParameters | SqlValue[], signal?: AbortSignal): AsyncGenerator<Record<string, SqlValue>> {
		this.checkOpen();
		// Pre-flight cancellation before acquiring the mutex / preparing.
		throwIfAborted(signal);

		const releaseMutex = await this._acquireExecMutex();
		let stmt: Statement | null = null;

		try {
			stmt = this.prepare(sql);

			if (stmt.astBatch.length === 0) {
				return;
			}

			if (stmt.astBatch.length > 1) {
				// Multi-statement batch: execute all but the last statement,
				// then yield results from the last statement
				for (let i = 0; i < stmt.astBatch.length - 1; i++) {
					await this._executeSingleStatement(stmt.astBatch[i], params, signal);
				}

				const lastStmt = new Statement(this, [stmt.astBatch[stmt.astBatch.length - 1]]);
				this.statements.add(lastStmt);
				try {
					const names = lastStmt.getColumnNames();
					for await (const row of lastStmt._iterateRowsRaw(params, signal)) {
						yield rowToObject(row, names);
					}
				} finally {
					await lastStmt.finalize();
				}
			} else {
				const names = stmt.getColumnNames();
				for await (const row of stmt._iterateRowsRaw(params, signal)) {
					yield rowToObject(row, names);
				}
			}
		} finally {
			if (stmt) { await stmt.finalize(); }
			releaseMutex();
		}
	}

	getPlan(sqlOrAst: string | AST.AstNode): PlanNode {
		this.checkOpen();

		let ast: AST.AstNode;
		let originalSqlString: string | undefined = undefined;

		if (typeof sqlOrAst === 'string') {
			originalSqlString = sqlOrAst;
			const parser = new Parser();
			try {
				ast = parser.parse(originalSqlString);
			} catch (err) {
				const error = err instanceof QuereusError ? err : new QuereusError(String(err), StatusCode.ERROR, err instanceof Error ? err : undefined);
				errorLog("Failed to parse SQL for query plan: %O", error);
				throw error;
			}
		} else {
			ast = sqlOrAst;
		}

		const { plan } = this._buildPlan([ast as AST.Statement]);

		if (plan.statements.length === 0) return plan; // No-op for this AST

		return this.optimizer.optimize(plan, this) as BlockNode;
	}

	/**
	 * Gets a detailed representation of the query plan for debugging.
	 * @param sql The SQL statement to plan.
	 * @param options Optional formatting options. If not provided, uses concise tree format.
	 * @returns String containing the formatted plan tree.
	 */
	getDebugPlan(sql: string, options?: { verbose?: boolean; expandNodes?: string[]; maxDepth?: number }): string {
		this.checkOpen();
		const plan = this.getPlan(sql);

		if (options?.verbose) {
			// Use the original detailed JSON format
			return serializePlanTree(plan);
		} else {
			// Use the new concise tree format
			return formatPlanTree(plan, {
				concise: true,
				expandNodes: options?.expandNodes || [],
				maxDepth: options?.maxDepth,
				showPhysical: true
			});
		}
	}

	/**
	 * Prepares a statement with debug options enabled.
	 * @param sql The SQL statement to prepare.
	 * @param debug Debug options to enable.
	 * @returns A Statement with debug capabilities.
	 */
	prepareDebug(sql: string, debug: DebugOptions): Statement {
		this.checkOpen();
		log('Preparing SQL with debug options: %s', sql);

		const stmt = new Statement(this, sql);
		stmt._debugOptions = debug;

		this.statements.add(stmt);
		return stmt;
	}

	/** @internal */
	_getVtabModule(name: string): { module: AnyVirtualTableModule, auxData?: unknown } | undefined {
		// Delegate to SchemaManager
		return this.schemaManager.getModule(name);
		// return this.registeredVTabs.get(name.toLowerCase()); // Old implementation
	}

	/** @internal */
	_findTable(tableName: string, dbName?: string): TableSchema | undefined {
		return this.schemaManager.findTable(tableName, dbName);
	}

	/**
	 * Returns a public handle to a table for inspection and per-table event
	 * subscription. Returns `undefined` if the table does not exist or its
	 * owning module is not registered.
	 *
	 * The returned {@link Table} is a snapshot: its `schema` reference is
	 * frozen at acquisition time. If the table is dropped or recreated, the
	 * handle keeps the original schema, but no further events for that name
	 * will arrive. Re-acquire after schema changes if you need fresh state.
	 *
	 * After {@link Database.close}, the handle's event emitter reference
	 * remains valid (the module instance outlives the database) but the
	 * database-level aggregator is unhooked, so local subscriptions on the
	 * module emitter still fire only as long as the module itself remains
	 * active.
	 *
	 * @param schemaName The schema name ('main', 'temp', or an attached
	 *   schema). Pass `undefined` to use the current default schema.
	 * @param tableName  The table name (case-insensitive resolution).
	 *
	 * @example
	 * ```typescript
	 * const table = db.getTable('main', 'users');
	 * const tableEmitter = table?.getEventEmitter();
	 * const off = tableEmitter?.onDataChange?.((event) => {
	 *   if (event.tableName === 'users') console.log(event);
	 * });
	 * ```
	 */
	getTable(schemaName: string | undefined, tableName: string): Table | undefined {
		this.checkOpen();
		const tableSchema = this.schemaManager.getTable(schemaName, tableName);
		if (!tableSchema) return undefined;
		const moduleName = tableSchema.vtabModuleName;
		if (!moduleName) return undefined;
		const moduleInfo = this.schemaManager.getModule(moduleName);
		if (!moduleInfo) return undefined;
		return new Table(tableSchema, moduleName, moduleInfo.module);
	}

	/** @internal */
	_findFunction(funcName: string, nArg: number): FunctionSchema | undefined {
		return this.schemaManager.findFunction(funcName, nArg);
	}

	/**
	 * @internal Build a fresh top-level {@link PlanningContext} (global → parameter scope,
	 * default schema path, an empty dependency tracker). The shared seam {@link _buildPlan}
	 * builds its planning context from, and a throwaway context the static updateability
	 * surfaces (`func/builtins/schema.ts`) use to plan a view body / run an insertability
	 * probe — whose `schemaDependencies` are discarded (the read TVF already discards the body
	 * plan's), so a fresh tracker per call is correct.
	 */
	_buildProbeContext(paramsOrTypes?: SqlParameters | SqlValue[] | Map<string | number, ScalarType>): PlanningContext {
		const globalScope = new GlobalScope(this.schemaManager);

		// If we received parameter values, infer their types
		// If we received explicit parameter types, use them as-is
		const parameterTypes = paramsOrTypes instanceof Map
			? paramsOrTypes
			: getParameterTypes(paramsOrTypes);

		// This ParameterScope is for the entire batch. It has globalScope as its parent.
		const parameterScope = new ParameterScope(globalScope, parameterTypes);

		// Get default schema path from options
		const schemaPath = parseSchemaPath(this.options.getStringOption('schema_path'));

		return {
			db: this,
			schemaManager: this.schemaManager,
			parameters: paramsOrTypes instanceof Map ? {} : (paramsOrTypes ?? {}),
			scope: parameterScope,
			cteNodes: new Map(),
			schemaDependencies: new BuildTimeDependencyTracker(),
			schemaCache: new Map(),
			cteReferenceCache: new Map(),
			outputScopes: new Map(),
			schemaPath
		};
	}

	/** @internal */
	_buildPlan(statements: AST.Statement[], paramsOrTypes?: SqlParameters | SqlValue[] | Map<string | number, ScalarType>): BuildPlanResult {
		const ctx = this._buildProbeContext(paramsOrTypes);
		const plan = buildBlock(ctx, statements);
		return { plan, schemaDependencies: ctx.schemaDependencies };
	}

	/**
	 * @internal Registers an active VirtualTable connection for transaction management.
	 * @param connection The connection to register
	 */
	async registerConnection(connection: VirtualTableConnection): Promise<void> {
		this.activeConnections.set(connection.connectionId, connection);
		log(`Registered connection ${connection.connectionId} for table ${connection.tableName}`);

		// If we're already in a transaction (implicit or explicit),
		// start a transaction on this new connection UNLESS we're evaluating deferred constraints
		// (during which subqueries should read committed state without creating new transaction layers)
		if (this.transactionManager.isInTransaction() && !this.transactionManager.isEvaluatingDeferredConstraints()) {
			try {
				await connection.begin();
				log(`Started transaction on newly registered connection ${connection.connectionId}`);
			} catch (error) {
				errorLog(`Error starting transaction on newly registered connection ${connection.connectionId}: %O`, error);
				// Don't throw here - just log the error to avoid breaking connection registration
			}

			// Replay the active savepoint stack onto this connection so subsequent
			// release/rollback-to broadcasts targeting earlier depths are in-range.
			// Without this, modules that register connections lazily (memory, isolation,
			// any vtab whose connection appears on first read/write) see an empty stack
			// while the DB broadcasts depths > 0 — silently no-op'ing on a real depth.
			const activeDepth = this.transactionManager.getActiveSavepointDepth();
			for (let depth = 0; depth < activeDepth; depth++) {
				try {
					await connection.createSavepoint(depth);
				} catch (error) {
					errorLog(`Error replaying savepoint depth ${depth} on newly registered connection ${connection.connectionId}: %O`, error);
					// Continue replaying remaining depths — see comment above on registration robustness.
				}
			}
		} else if (this.transactionManager.isEvaluatingDeferredConstraints()) {
			log(`Skipped transaction begin on connection ${connection.connectionId} (evaluating deferred constraints)`);
		}
	}

	/**
	 * @internal Unregisters an active VirtualTable connection.
	 * @param connectionId The ID of the connection to unregister
	 */
	unregisterConnection(connectionId: string): void {
		const connection = this.activeConnections.get(connectionId);
		if (connection) {
			// Don't disconnect during implicit transactions - let the transaction coordinate
			if (this.transactionManager.isImplicitTransaction()) {
				log(`Deferring disconnect of connection ${connectionId} until implicit transaction completes`);
				return;
			}

			this.activeConnections.delete(connectionId);
			log(`Unregistered connection ${connectionId} for table ${connection.tableName}`);
		}
	}

	/**
	 * @internal Gets an active connection by ID.
	 * @param connectionId The connection ID to look up
	 * @returns The connection if found, undefined otherwise
	 */
	getConnection(connectionId: string): VirtualTableConnection | undefined {
		return this.activeConnections.get(connectionId);
	}

	/**
	 * @internal Removes all active connections for a specific table.
	 * Unlike unregisterConnection, this bypasses the implicit transaction deferral
	 * because the table is being dropped and its connections are definitively stale.
	 */
	removeConnectionsForTable(schemaName: string, tableName: string): void {
		const qualifiedName = `${schemaName}.${tableName}`.toLowerCase();
		for (const [id, conn] of this.activeConnections) {
			if (conn.tableName.toLowerCase() === qualifiedName) {
				this.activeConnections.delete(id);
				log(`Removed stale connection ${id} for dropped table ${qualifiedName}`);
			}
		}
	}

	/**
	 * @internal Force-removes one connection by id.
	 * Unlike unregisterConnection, this bypasses the implicit transaction deferral —
	 * the caller has established that this specific connection is definitively stale.
	 */
	removeConnection(connectionId: string): void {
		const connection = this.activeConnections.get(connectionId);
		if (connection) {
			this.activeConnections.delete(connectionId);
			log(`Removed stale connection ${connectionId} for table ${connection.tableName}`);
		}
	}

	/**
	 * @internal Gets all active connections for a specific table.
	 * @param tableName The name of the table
	 * @returns Array of connections for the table
	 */
	getConnectionsForTable(tableName: string): VirtualTableConnection[] {
		const normalized = tableName.toLowerCase();
		const simpleName = normalized.includes('.') ? normalized.substring(normalized.lastIndexOf('.') + 1) : normalized;
		return Array.from(this.activeConnections.values())
			.filter(conn => {
				const connName = conn.tableName.toLowerCase();
				return connName === normalized || connName === simpleName;
			});
	}

	/**
	 * @internal Gets all active connections.
	 * @returns Array of all active connections
	 */
	getAllConnections(): VirtualTableConnection[] {
		return Array.from(this.activeConnections.values());
	}

	/**
	 * Disconnects and removes all active connections.
	 * Called during database close.
	 */
	private async disconnectAllConnections(): Promise<void> {
		const connections = Array.from(this.activeConnections.values());
		log(`Disconnecting ${connections.length} active connections`);

		const disconnectPromises = connections.map(async (conn) => {
			try {
				await conn.disconnect();
			} catch (error) {
				errorLog(`Error disconnecting connection ${conn.connectionId}: %O`, error);
			}
		});

		await Promise.allSettled(disconnectPromises);
		this.activeConnections.clear();
	}

	private checkOpen(): void {
		if (!this.isOpen) throw new MisuseError("Database is closed");
	}

	public async runGlobalAssertions(sink?: AssertionViolation[]): Promise<void> {
		await this.assertionEvaluator.runGlobalAssertions(sink);
	}

	/** @internal Install (or clear, with `null`) the report-mode sink the next
	 *  commit's global-assertion pass collects into instead of throwing. Used by
	 *  the external-row ingestion seam around its implicit commit; see
	 *  {@link ingestExternalRowChanges} and `database-transaction.ts`. */
	public _setPendingCommitAssertionSink(sink: AssertionViolation[] | null): void {
		this.transactionManager.setPendingCommitAssertionSink(sink);
	}

	/** @internal Apply-mode RESTRICT suppression flag — see {@link _setFkRestrictSuppressed}. */
	private _fkRestrictSuppressed = false;

	/** @internal Apply-mode RESTRICT suppression. While set, the parent-side FK
	 *  RESTRICT pre-checks ({@link assertTransitiveRestrictsForParentMutation} and its
	 *  callees) early-return — the trust-the-origin external-row apply path: the origin
	 *  already enforced RESTRICT at its own commit, so re-enforcing it on the receiver
	 *  would wedge the sync stream. Cascade / set-null / set-default propagation is
	 *  unaffected. Set for the duration of an apply batch (mutex held, so no concurrent
	 *  statement observes it) and honored by every nested cascade DML and MV-maintenance
	 *  FK pass. Returns the prior value so the caller restores it in a `finally`
	 *  (supports nesting). */
	public _setFkRestrictSuppressed(value: boolean): boolean {
		const prior = this._fkRestrictSuppressed;
		this._fkRestrictSuppressed = value;
		return prior;
	}

	/** @internal Whether apply-mode RESTRICT suppression is active — see
	 *  {@link _setFkRestrictSuppressed}. */
	public _isFkRestrictSuppressed(): boolean {
		return this._fkRestrictSuppressed;
	}

	/** @internal FK cascade re-entry flag — see {@link _setFkCascadeReentry}. */
	private _fkCascadeReentry = false;

	/** @internal Marks that the DML currently re-entering the executor is one of
	 *  Quereus's own FK cascade child writes (cascade DELETE / UPDATE, SET NULL,
	 *  SET DEFAULT — physical or lens), not a direct user DML on the child table.
	 *  Set only for the duration of each cascade child write by
	 *  `withFkCascadeReentry` in `runtime/foreign-key-actions.ts`, so a host vtab
	 *  module can distinguish a cascade re-entry from a user write on the same
	 *  child and suppress redundant child-side FK re-validation only for the
	 *  former. Independent of {@link _setFkRestrictSuppressed} (a cascade path may
	 *  legitimately have both semantics in play). Returns the prior value so the
	 *  caller restores it in a `finally` — nesting-safe: an inner cascade restores
	 *  to the outer's `true`, the outermost to `false`, and a thrown cascade cannot
	 *  latch the flag on. Nothing inside Quereus reads it; it exposes the signal the
	 *  host consumes. */
	public _setFkCascadeReentry(value: boolean): boolean {
		const prior = this._fkCascadeReentry;
		this._fkCascadeReentry = value;
		return prior;
	}

	/** @internal Whether the current DML re-entry is a Quereus FK cascade child
	 *  write — see {@link _setFkCascadeReentry}. */
	public _isFkCascadeReentry(): boolean {
		return this._fkCascadeReentry;
	}

	/**
	 * Subscribe to changes described by a {@link ChangeScope}.
	 *
	 * The watcher fires its handler **after** a transaction commits (mirrors
	 * assertion COMMIT eval), once per commit, with all matching watches in
	 * a single {@link WatchEvent}. Handler errors are caught and logged —
	 * they do not roll the commit back (assertions own that contract).
	 *
	 * Validation is synchronous:
	 * - Throws if `scope.unboundParameters` is non-empty (caller must
	 *   `bindParameters(scope, params)` first).
	 * - Throws if any referenced table or column does not exist in the
	 *   current schema.
	 *
	 * If the table or any column the scope mentions is later dropped or
	 * altered, the subscription is **invalidated and disposed**; re-subscribe
	 * to continue watching.
	 *
	 * @returns A {@link Subscription} handle whose `unsubscribe()` is
	 *   idempotent and releases capture-spec demand.
	 */
	watch(scope: ChangeScope, handler: WatchHandler): Subscription {
		this.checkOpen();
		return this.watcherManager.watch(scope, handler);
	}

	/** @internal Invoked by the TransactionManager after a successful commit
	 *  and before the change log is cleared. */
	public async runPostCommitWatchers(): Promise<void> {
		await this.watcherManager.runPostCommit();
	}

	/**
	 * Fire all active watchers whose scope includes `schema.table`, as if the
	 * whole table changed, **without** a local commit. For hosts whose tables
	 * are backed by an external/replicated store (e.g. the optimystic vtab) that
	 * learns of remote writes out-of-band, so the change never touches this
	 * `Database`'s commit change-log and the post-commit watcher path would
	 * otherwise never fire.
	 *
	 * Coarse by design: handlers receive a global (whole-table) {@link WatchEvent}
	 * — `full` watches fire with empty `hits`; `rows`/`rowsByGroup` watches
	 * surface all their registered literal values as possibly-changed; `groups`
	 * fire with empty hits. Over-firing only costs the consumer an extra
	 * re-query; it never misses a change. A no-op when no subscription matches.
	 * Async to mirror the post-commit watcher path (handlers may be async).
	 *
	 * When the host has the actual row images, prefer the precise,
	 * in-transaction {@link ingestExternalRowChanges} seam instead: row-granular
	 * watch hits at commit, plus MV maintenance, assertion evaluation, and
	 * opt-in FK actions.
	 *
	 * @param tableName  The table whose watchers to fire.
	 * @param schemaName Defaults to the current schema
	 *   (`schemaManager.getCurrentSchemaName()`).
	 */
	public async notifyExternalChange(tableName: string, schemaName?: string): Promise<void> {
		this.checkOpen();
		const schema = schemaName ?? this.schemaManager.getCurrentSchemaName();
		const fqName = `${schema}.${tableName}`.toLowerCase();
		await this.watcherManager.notifyExternalTableChange(fqName);
	}

	/**
	 * Batch ingestion seam for externally-applied row changes: drives the
	 * post-write pipeline — change capture (`Database.watch` post-commit
	 * dispatch + commit-time global assertions), batch-amortized row-time
	 * materialized-view maintenance, and opt-in parent-side FK actions — for
	 * writes the caller has already applied directly to module storage,
	 * bypassing the DML executor. The precise, in-transaction alternative to
	 * the coarse whole-table {@link notifyExternalChange}.
	 *
	 * `changes` is a flat ordered array; same-row changes must appear in event
	 * order (each change's `oldRow` must be the true before-image of *that*
	 * change — the prior change's `newRow`). The FK-actions facet re-reads
	 * post-write merged storage and is order-independent for realistic batch
	 * shapes (see `docs/sync.md` § Transactional Integrity During Sync for the
	 * (E)/(F) exotic-topology caveats). The seam
	 * trusts the origin — it re-validates NOTHING (no CHECK / NOT NULL /
	 * UNIQUE / child-side FK existence), and it does NOT emit module data
	 * events (the external writer owns those, including the `remote` flag).
	 *
	 * Transaction contract: runs inside the caller's active transaction when
	 * one exists (the reported rows must already be visible to a vtab read
	 * within it — the residual/full-rebuild maintenance arms re-read the
	 * source); otherwise begins an implicit transaction it commits at batch
	 * end. The batch's DERIVED effects are atomic via a batch savepoint; a
	 * mid-batch error unwinds them all (the externally-applied storage rows
	 * are NOT unwound by Quereus). Serialized via the exec mutex — do NOT call
	 * from within statement execution or vtab callbacks (deadlock); the
	 * two-arg `_maintainRowTimeCoveringStructures` is the seam for that
	 * context. See `docs/mv-ingestion.md` § External row-change
	 * ingestion for the full contract.
	 *
	 * Returns the collected commit-time global-assertion violations. With the
	 * default `assertionFailureMode: 'throw'` a violation throws (and rolls the
	 * batch's derived effects back) so the returned list is always empty; with
	 * `'report'` — honored only for the seam-owned implicit transaction with
	 * capture on — a violation is collected and the batch still commits (derived
	 * effects land, watch dispatches), so the returned list names every violated
	 * assertion. Empty in every other case.
	 */
	public async ingestExternalRowChanges(
		changes: readonly ExternalRowChange[],
		options?: IngestExternalChangesOptions,
	): Promise<IngestExternalChangesResult> {
		this.checkOpen();
		return ingestExternalRowChangeBatch(this, changes, options);
	}

	/** @internal Compile + register an MV for row-time write-through maintenance.
	 *  Throws on a body that is not row-time maintainable (the mandatory create-time gate). */
	public registerMaterializedView(mv: MaintainedTableSchema): void {
		this.materializedViewManager.registerMaterializedView(mv);
	}

	/** @internal Detach an MV's row-time maintenance plan (DROP path). */
	public unregisterMaterializedView(schemaName: string, name: string): void {
		this.materializedViewManager.unregisterMaterializedView(schemaName, name);
	}

	/** @internal Force-mark an MV stale: detach its row-time plan and invalidate cached
	 *  backing reads so the next reference re-hits the build-time stale guard
	 *  (ALTER … RENAME propagation failure path). */
	public markMaterializedViewStale(mv: MaintainedTableSchema): void {
		this.materializedViewManager.markMaterializedViewStale(mv);
	}

	/**
	 * Refresh every maintained table (materialized view) in source-dependency
	 * order, bringing each backing current with its sources. The convergence
	 * point after a wholesale external load (e.g. a sync snapshot bootstrap) that
	 * deferred row-time maintenance. Each MV is refreshed through the same
	 * full-rebuild path as `refresh materialized view` (stale revalidation, shape
	 * re-derivation/reshape, row-time re-registration, `stale` clear), so a
	 * bounded-delta MV is full-rebuilt here too — convergence does not depend on
	 * delta replay, and the full rebuild re-reads the complete source through the
	 * vtab regardless of how its rows arrived (out-of-band direct-storage writes
	 * included). MV-over-MV chains converge base-first: refresh is commit-first per
	 * MV, so a base MV's backing is committed before a dependent's body re-reads it.
	 *
	 * NOT atomic across the sweep — the whole sweep is deliberately NOT wrapped in
	 * one explicit transaction (refresh is commit-first per MV, so an enclosing
	 * transaction would not make it atomic anyway). Each MV ensures/commits its own
	 * implicit transaction exactly as the single-MV `refresh` does, so a failure
	 * partway leaves earlier MVs converged; the caller (snapshot bootstrap) retries
	 * the whole load idempotently.
	 *
	 * Serialized via the exec mutex like any statement — do NOT call from within
	 * statement execution or a vtab callback (deadlock; same constraint as
	 * `refresh materialized view` itself). Returns the refreshed MV identifiers
	 * (for coarse watch notification); `[]` (no mutex, no transaction) when there
	 * are no maintained tables. See `docs/mv-ingestion.md` § Converging all
	 * materialized views.
	 */
	public async refreshAllMaterializedViews(): Promise<Array<{ schemaName: string; name: string }>> {
		this.checkOpen();
		// Build the order BEFORE the mutex: it only reads catalog/plan state, and an
		// empty catalog must take no mutex and start no transaction.
		const order = this.materializedViewManager.materializedViewRefreshOrder();
		if (order.length === 0) return [];

		const refreshed: Array<{ schemaName: string; name: string }> = [];
		await this._withMutex(async () => {
			// Per-MV implicit-transaction scope mirrors `exec`'s per-statement boundary:
			// each refresh commits independently (commit-first), so a mid-sweep failure
			// leaves the already-refreshed MVs converged rather than rolling them back.
			for (const mv of order) {
				try {
					await this._ensureTransaction();
					const live = await refreshMaintainedTable(this, mv);
					if (this._isImplicitTransaction()) {
						await this._commitTransaction();
					}
					refreshed.push({ schemaName: live.schemaName, name: live.name });
				} catch (err) {
					if (this._isImplicitTransaction()) {
						await this._rollbackTransaction();
					}
					throw err;
				}
			}
		});
		return refreshed;
	}

	/** @internal Cheap synchronous guard for the per-row DML maintenance hook: true
	 *  iff a `row-time` covering structure reads `sourceBase` (lowercased or raw
	 *  `schema.table`). Lets a hot write path skip the maintenance call entirely when
	 *  no row-time MV depends on the written table. */
	public _hasRowTimeCoveringStructures(sourceBase: string): boolean {
		return this.materializedViewManager.hasRowTimePlanFor(sourceBase);
	}

	/** @internal Synchronously maintain every `row-time` covering structure on
	 *  `sourceBase` for one source row-write, before the writing statement observes
	 *  its own effects. Drives a per-row backing delta through the backing table's
	 *  coordinated transactional connection (reads-own-writes within the txn;
	 *  committed/rolled-back in lockstep with the source write). See
	 *  `database-materialized-views.ts` § row-time write-through.
	 *
	 *  `cache` is the optional per-statement {@link BackingConnectionCache} the DML
	 *  generator threads in so the backing-connection resolution is amortized over the
	 *  whole statement (one scan per backing, not one per source row). The cold
	 *  eviction callers (memory `checkUniqueViaMaterializedView`, store-table.ts) omit
	 *  it and re-resolve the same connection deterministically — the `DatabaseInternal`
	 *  surface deliberately exposes only the two-arg form (a host reporting writes from
	 *  OUTSIDE a statement uses the batch-amortized {@link ingestExternalRowChanges}
	 *  seam instead).
	 *
	 *  `deferred` is the optional per-statement deferred-rebuild set (a `'full-rebuild'`
	 *  plan is marked dirty in it, no per-row apply) and `residualBatch` the optional
	 *  per-statement residual key batch (the residual arms accumulate their deduped
	 *  affected binding keys into it, no per-row recompute); both drain once at the
	 *  end-of-statement {@link _flushDeferredMaintenance}. The DML generator owns them;
	 *  cold callers omit them (and only ever name inverse-projection MVs — the one
	 *  per-row-immediate arm — so the inline per-change fallback is at worst a safe,
	 *  unamortized apply). */
	public async _maintainRowTimeCoveringStructures(
		sourceBase: string,
		change: BackingRowChange,
		cache?: BackingConnectionCache,
		deferred?: Set<string>,
		residualBatch?: ResidualKeyBatch,
	): Promise<void> {
		await this.materializedViewManager.maintainRowTime(sourceBase, change, cache, deferred, residualBatch);
	}

	/** @internal Drain the per-statement deferred maintenance at the end-of-statement
	 *  boundary: recompute every accumulated residual key once per distinct key, rebuild
	 *  every dirtied full-rebuild covering MV exactly once, and cascade each delta onward
	 *  (MV-over-MV). The DML generator calls this after the row loop and before releasing
	 *  the statement-atomicity savepoint, so a failed recompute/rebuild rolls the whole
	 *  statement back. `cache` is the same per-statement {@link BackingConnectionCache}
	 *  the row loop used. See `database-materialized-views.ts` § flushDeferredMaintenance. */
	public async _flushDeferredMaintenance(
		deferred: Set<string>,
		residualBatch: ResidualKeyBatch,
		cache?: BackingConnectionCache,
	): Promise<void> {
		await this.materializedViewManager.flushDeferredMaintenance(deferred, residualBatch, cache);
	}

	/** @internal Resolve the linked, `row-time`, enforcement-ready covering MV for a
	 *  UNIQUE constraint on `schema.table`, or `undefined`. Synchronous (a map lookup
	 *  plus name/staleness checks) with an O(1) negative fast path, so the UNIQUE-check
	 *  path can consult it without async overhead. When it returns an MV, conflict
	 *  resolution routes through the covering MV's backing table (in preference to the
	 *  auto-index) — see `docs/mv-constraints.md` § Covering structures. */
	public _findRowTimeCoveringStructure(
		schemaName: string,
		tableName: string,
		uc: UniqueConstraintSchema,
	): MaintainedTableSchema | undefined {
		return this.materializedViewManager.findRowTimeCoveringStructure(schemaName, tableName, uc);
	}

	/** @internal Point-look up a row-time covering MV's backing table for rows whose
	 *  backing columns equal `newRow`'s UNIQUE values, returning the conflicting
	 *  **source** PK(s) (excluding `newSourcePk`, the row being written). Reads-own-writes
	 *  through the backing table's coordinated connection. The caller validates each
	 *  candidate against its live source row and applies IGNORE/ABORT/REPLACE. */
	public async _lookupCoveringConflicts(
		mv: MaintainedTableSchema,
		uc: UniqueConstraintSchema,
		newRow: Row,
		newSourcePk: readonly SqlValue[],
	): Promise<Array<{ pk: SqlValue[]; row?: Row }>> {
		return this.materializedViewManager.lookupCoveringConflicts(mv, uc, newRow, newSourcePk);
	}

	/** @internal Invalidate cached assertion plan (called on DROP ASSERTION) */
	public invalidateAssertionCache(name: string): void {
		this.assertionEvaluator.invalidateAssertion(name);
	}
}

